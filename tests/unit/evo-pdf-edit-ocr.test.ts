/**
 * ZotFlow Evo: `ui/reader/pdf-edit.ts` with OCR — what is uploaded, what
 * the notices say, and that a cancelled OCR changes nothing. Tesseract and
 * Zotero are stood in for.
 */
import { PDFDocument, StandardFonts } from "pdf-lib";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
    const pdf: Uint8Array = new Uint8Array();
    const settings: Record<string, unknown> = { evoOcrLanguages: ["eng"] };
    return {
        pdf,
        uploads: [] as Uint8Array[],
        notices: [] as [string, string][],
        progress: [] as string[],
        recognized: [] as number[][],
        cancel: false,
        settings,
    };
});

vi.mock("bridge", () => ({
    workerBridge: {
        downloadAttachment: async () => ({
            blob: new Blob([state.pdf.slice()]),
        }),
        attachment: { putEditedFile: vi.fn(async () => undefined) },
        dbHelper: {
            getAttachmentItem: async () => ({
                raw: { data: { md5: "NEWMD5" } },
            }),
        },
        evoLibrary: {
            remapAnnotations: vi.fn(async () => ({ changed: 0, skipped: 0 })),
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
    uploadFileBytes: async (_t: unknown, bytes: Uint8Array) => {
        state.uploads.push(bytes);
        return "NEWMD5";
    },
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
