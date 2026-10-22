/**
 * ZotFlow Evo: `ui/reader/pdf-edit.ts` — what is uploaded, what the notices
 * say, the copy kept in the trash before an edit and a revert to it, and
 * that a cancelled OCR changes nothing. Tesseract, pdf.js (the tilt
 * measure) and Zotero are stood in for.
 */
import { PDFDocument, StandardFonts } from "pdf-lib";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
    const pdf: Uint8Array = new Uint8Array();
    const files = new Map<string, Uint8Array>();
    const settings: Record<string, unknown> = { evoOcrLanguages: ["eng"] };
    return {
        pdf,
        uploads: [] as Uint8Array[],
        notices: [] as [string, string][],
        progress: [] as string[],
        recognized: [] as number[][],
        cancel: false,
        settings,
        backups: [] as {
            fields: Record<string, unknown>;
            bytes: Uint8Array;
        }[],
        remaps: [] as { stages: unknown[][]; labels: string[] | null }[],
        deleted: [] as string[][],
        trash: [] as Record<string, unknown>[],
        files,
        angles: {},
    };
});

vi.mock("bridge", () => ({
    workerBridge: {
        downloadAttachment: async (item: { key?: string }) => ({
            blob: new Blob([
                ((item.key && state.files.get(item.key)) || state.pdf).slice(),
            ]),
        }),
        attachment: { putEditedFile: vi.fn(async () => undefined) },
        dbHelper: {
            getAttachmentItem: async (_l: number, key: string) => ({
                key,
                raw: { data: { md5: "NEWMD5" } },
            }),
        },
        evoLibrary: {
            remapAnnotations: vi.fn(
                async (
                    _l: number,
                    _k: string,
                    stages: unknown[][],
                    labels: string[] | null,
                ) => {
                    state.remaps.push({ stages, labels });
                    return { changed: 1, skipped: 0 };
                },
            ),
            pdfBackups: async () => state.trash,
            deleteForever: async (_l: number, keys: string[]) => {
                state.deleted.push(keys);
                return keys.length;
            },
        },
    },
}));

vi.mock("services/services", () => ({
    services: {
        get settings() {
            return state.settings;
        },
        saveSettings: async () => undefined,
        logService: { error: vi.fn(), warn: vi.fn() },
        notificationService: {
            notify: (type: string, message: string) =>
                state.notices.push([type, message]),
            progress: (message: string) => {
                state.progress.push(message);
                return {
                    update: (m: string) => state.progress.push(m),
                    close: () => undefined,
                };
            },
        },
    },
}));

vi.mock("services/evo-auto-sync", () => ({ noteLocalEdit: vi.fn() }));
vi.mock("ui/start-sync", () => ({ startSync: async () => "task" }));
vi.mock("utils/viewer", () => ({ openAttachment: vi.fn() }));
vi.mock("ui/evo-library/attach-file", () => ({
    attachRefusal: () => null,
    createStandaloneAttachment: vi.fn(),
    createAttachmentWithFile: async (
        _l: number,
        fields: Record<string, unknown>,
        bytes: Uint8Array,
    ) => {
        state.backups.push({ fields, bytes });
        return "BACKUP01";
    },
    uploadFileBytes: async (_t: unknown, bytes: Uint8Array) => {
        state.uploads.push(bytes);
        return "NEWMD5";
    },
}));

vi.mock("ui/reader/evo-pdf-measure", () => ({
    measureSkew: async () => state.angles,
}));

vi.mock("ui/reader/evo-ocr", async () => {
    class OcrCancelled extends Error {}
    // A text-only page as Tesseract gives it (here: invisible Helvetica).
    const textPage = async () => {
        const doc = await PDFDocument.create();
        const font = await doc.embedFont(StandardFonts.Helvetica);
        const page = doc.addPage([100, 100]);
        const f = page.node.newFontDictionary("F", font.ref);
        page.node.addContentStream(
            doc.context.register(
                doc.context.flateStream(
                    `BT ${f.asString()} 10 Tf 3 Tr 10 10 Td (Scanned) Tj ET`,
                ),
            ),
        );
        return doc.save();
    };
    return {
        OcrCancelled,
        recognizePages: async (
            _bytes: Uint8Array,
            pages: number[],
            _langs: string[],
            o: { onProgress?: (p: { done: number; total: number }) => void },
        ) => {
            state.recognized.push(pages);
            if (state.cancel) throw new OcrCancelled();
            const texts = [];
            for (const [i, pageIndex] of pages.entries()) {
                o.onProgress?.({ done: i + 1, total: pages.length });
                texts.push({
                    pageIndex,
                    pdf: await textPage(),
                    width: 100,
                    height: 100,
                    toUser: [1, 0, 0, -1, 0, 100],
                });
            }
            return { texts, failed: [] };
        },
    };
});

import { runPdfEdit } from "ui/reader/pdf-edit";
import { BACKUP_TAG, parseBackupNote } from "utils/evo-pdf-backup";
import { readPageLabels } from "utils/evo-pdf-labels";
import { pageText } from "utils/evo-pdf-ocr-layer";

async function sample(scans: number) {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([100, 100]).drawText(
        "Born-digital text that is long enough to count.",
        { x: 5, y: 50, size: 4, font },
    );
    for (let i = 0; i < scans; i++)
        doc.addPage([100, 100]).drawRectangle({
            x: 0,
            y: 0,
            width: 100,
            height: 100,
        });
    return doc.save();
}

const host = () => ({
    app: {} as never,
    attachment: {
        libraryID: 1,
        key: "ATT00001",
        raw: {
            data: {
                contentType: "application/pdf",
                linkMode: "imported_file",
                filename: "scan.pdf",
                md5: "OLDMD5",
                title: "Scan",
            },
        },
    } as never,
    reload: vi.fn(async () => undefined),
});

beforeEach(() => {
    state.uploads = [];
    state.notices = [];
    state.progress = [];
    state.recognized = [];
    state.cancel = false;
    state.settings = { evoOcrLanguages: ["eng"] };
    state.backups = [];
    state.remaps = [];
    state.deleted = [];
    state.trash = [];
    state.files = new Map();
    state.angles = {};
});

describe("OCR from the editing menu", () => {
    it("recognizes the scans only, uploads the file with their text, remembers the languages", async () => {
        state.pdf = await sample(2);
        const h = host();
        await runPdfEdit(h, {
            ocr: { languages: ["deu", "fra", "bad code!"] },
        });
        expect(state.recognized).toEqual([[1, 2]]);
        expect(state.settings.evoOcrLanguages).toEqual(["deu", "fra"]);
        expect(state.progress).toEqual([
            "Recognizing text: 0 of 2 pages…",
            "Recognizing text: 1 of 2 pages…",
            "Recognizing text: 2 of 2 pages…",
        ]);
        expect(state.uploads).toHaveLength(1);
        const doc = await PDFDocument.load(state.uploads[0]!);
        expect(pageText(doc, doc.getPage(1)).invisible).toBe(7);
        expect(pageText(doc, doc.getPage(0)).invisible).toBe(0);
        expect(state.notices.at(-1)).toEqual([
            "success",
            "Edited the PDF: recognized the text of 2 pages, left 1 page that had text.",
        ]);
        expect(h.reload).toHaveBeenCalled();
    });

    it("cancelled: nothing uploaded, the PDF left as it was", async () => {
        state.pdf = await sample(1);
        state.cancel = true;
        await runPdfEdit(host(), {
            ocr: { languages: ["eng"] },
            removeOutline: true,
        });
        expect(state.uploads).toHaveLength(0);
        expect(state.notices.at(-1)).toEqual([
            "info",
            "OCR cancelled; the PDF was left as it was.",
        ]);
    });

    it("every page has text: says so, and does not rewrite the file for nothing", async () => {
        state.pdf = await sample(0);
        await runPdfEdit(host(), { ocr: { languages: ["eng"] } });
        expect(state.recognized).toEqual([]);
        expect(state.uploads).toHaveLength(0);
        expect(
            state.notices.some(
                ([t, m]) => t === "warning" && /nothing to recognize/.test(m),
            ),
        ).toBe(true);
    });
});

describe("a copy before each edit, and reverting to it", () => {
    it("the old file goes to the trash first, beside the PDF, with how the pages moved", async () => {
        state.pdf = await sample(2);
        state.angles = { "2": 1.5 };
        await runPdfEdit(host(), {
            split: { shared: 0.5, pages: {} },
            straighten: true,
        });
        expect(state.backups).toHaveLength(1);
        const { fields, bytes } = state.backups[0]!;
        expect(fields).toMatchObject({
            filename: "scan.pdf",
            tags: [BACKUP_TAG],
            deleted: true,
        });
        expect(Buffer.from(bytes).equals(Buffer.from(state.pdf))).toBe(true);
        const info = parseBackupNote(fields.note as string)!;
        expect(info.of).toBe("ATT00001");
        // Two stages: the split, then the straightening of the halves.
        expect(info.stages).toHaveLength(2);
        expect(info.done).toEqual(
            ["straightened 1 page", "split 3 pages"].reverse(),
        );
        // The tilt was measured on the split file: page 2 there is a half.
        expect(info.stages[1]![2]!.turn?.degrees).toBe(1.5);
        // Annotations: moved through both stages, relabelled 1…6.
        expect(state.remaps.at(-1)!.stages).toHaveLength(2);
        expect(state.remaps.at(-1)!.labels).toEqual([
            "1",
            "2",
            "3",
            "4",
            "5",
            "6",
        ]);
    });

    it("writing only the page filter keeps no copy", async () => {
        state.pdf = await sample(1);
        await runPdfEdit(host(), {
            saveFilter: true,
            pageFilter: { contrast: 2, whiteThreshold: 200, saturation: 1 },
        });
        expect(state.uploads).toHaveLength(1);
        expect(state.backups).toHaveLength(0);
    });

    it("page numbers: written, and the annotations get the new labels", async () => {
        state.pdf = await sample(4);
        await runPdfEdit(host(), {
            pageLabels: [
                { start: 0, style: "r" },
                { start: 2, style: "D", first: 245 },
            ],
            outline: [
                { title: "Preface", page: 0, level: 0 },
                { title: "Chapter", page: 2, level: 0 },
                { title: "Section", page: 3, level: 1 },
            ],
        });
        const doc = await PDFDocument.load(state.uploads[0]!);
        expect(readPageLabels(doc)).toEqual(["i", "ii", "245", "246", "247"]);
        expect(state.remaps.at(-1)!.labels).toEqual([
            "i",
            "ii",
            "245",
            "246",
            "247",
        ]);
        expect(state.backups).toHaveLength(1);
    });

    it("revert: the copy's file back, annotations moved back through every later edit, copies used up removed", async () => {
        const before = await sample(1);
        state.pdf = await sample(2); // the file now (edited)
        state.files.set("COPY0001", before);
        state.trash = [
            // newest first
            {
                key: "COPY0002",
                of: "ATT00001",
                at: "2026-10-22T10:00:00Z",
                done: ["straightened 1 page"],
                synced: true,
                stages: [
                    [
                        { newIndex: 0 },
                        { newIndex: 1, turn: { degrees: 2, center: [50, 50] } },
                    ],
                ],
            },
            {
                key: "COPY0001",
                of: "ATT00001",
                at: "2026-10-21T10:00:00Z",
                done: ["split 1 page"],
                synced: true,
                stages: [
                    [
                        {
                            newIndex: 0,
                            split: {
                                left: [0, 0, 50, 100],
                                right: [50, 0, 100, 100],
                            },
                        },
                    ],
                ],
            },
        ];
        await runPdfEdit(host(), { revert: "COPY0001" });
        expect(Buffer.from(state.uploads[0]!).equals(Buffer.from(before))).toBe(
            true,
        );
        const { stages, labels } = state.remaps.at(-1)!;
        // The straightening undone first, then the split.
        expect(stages).toHaveLength(2);
        expect(
            (stages[0] as { turn?: { degrees: number } }[])[1]!.turn!.degrees,
        ).toBe(-2);
        expect(
            (stages[1] as { newIndex: number }[]).map((p) => p.newIndex),
        ).toEqual([0, 0]);
        expect(labels).toEqual(["1", "2"]);
        expect(state.deleted).toEqual([["COPY0002", "COPY0001"]]);
        expect(state.notices.at(-1)![1]).toMatch(/^Reverted to the PDF of/);
    });

    it("revert to a copy not synced here yet: says so, changes nothing", async () => {
        state.pdf = await sample(1);
        state.trash = [
            {
                key: "COPY0001",
                of: "ATT00001",
                at: "2026-10-21T10:00:00Z",
                done: [],
                synced: false,
                stages: [],
            },
        ];
        await runPdfEdit(host(), { revert: "COPY0001" });
        expect(state.uploads).toHaveLength(0);
        expect(state.notices.at(-1)).toEqual([
            "error",
            "Couldn't edit the PDF. That copy has not synced to this device yet; try again after a sync.",
        ]);
    });
});
