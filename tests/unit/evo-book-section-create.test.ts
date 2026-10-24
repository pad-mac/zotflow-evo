/**
 * ZotFlow Evo: `ui/evo-library/book-section.ts` — making a book section:
 * the PDF of its pages (with their labels), the item, its PDF, the
 * annotations copied to it and taken off the book's PDF (or not, the
 * setting). Zotero's API and the worker are stood in for.
 */
import { PDFDocument } from "pdf-lib";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { readPageLabels, writeLabelRuns } from "utils/evo-pdf-labels";

const state = vi.hoisted(() => ({
    pdf: new Uint8Array(new ArrayBuffer(0)),
    settings: { evoBookSectionRemoveAnnotations: true },
    created: [] as Record<string, unknown>[][],
    refuse: new Set<number>(),
    uploads: [] as { key: string; bytes: ArrayBuffer; parts: unknown }[],
    deleted: [] as string[][],
    notices: [] as [string, string][],
    emitted: 0,
    synced: 0,
}));

vi.mock("bridge", () => ({
    workerBridge: {
        dbHelper: {
            getAttachmentItem: async () => ({
                libraryID: 1,
                key: "BOOKPDF1",
                parentItem: "BOOK0001",
                raw: { data: { contentType: "application/pdf", filename: "kittler.pdf" } },
            }),
            getItem: async () => ({
                key: "BOOK0001",
                raw: {
                    data: {
                        itemType: "book",
                        title: "Grammophon Film Typewriter",
                        date: "1986",
                        creators: [
                            { creatorType: "author", firstName: "Friedrich", lastName: "Kittler" },
                        ],
                        collections: ["MEDIA001"],
                        tags: [],
                    },
                },
            }),
        },
        downloadAttachment: async () => ({ blob: new Blob([state.pdf.slice()]) }),
        evoLibrary: {
            sectionAnnotations: async (_l: number, _k: string, first: number, last: number) =>
                [3, 4, 9]
                    .filter((p) => p >= first && p <= last)
                    .map((p) => ({
                        key: `ANNO000${p}`,
                        data: { itemType: "annotation", annotationType: "highlight", p: p - first },
                    })),
        },
        annotation: {
            deleteAnnotations: async (_item: unknown, keys: string[]) => {
                state.deleted.push(keys);
            },
        },
    },
}));

vi.mock("services/services", () => ({
    services: {
        get settings() {
            return state.settings;
        },
        logService: { error: vi.fn(), warn: vi.fn() },
        notificationService: {
            notify: (type: string, message: string) => state.notices.push([type, message]),
        },
        eventHub: {
            annotationChanged: {
                emit: () => {
                    state.emitted++;
                },
            },
        },
    },
}));

vi.mock("services/evo-auto-sync", () => ({ noteLocalEdit: () => {} }));
vi.mock("ui/start-sync", () => ({
    startSync: async () => {
        state.synced++;
    },
}));
vi.mock("ui/reader/chrome", () => ({ showMenuOverFrame: () => {} }));
vi.mock("ui/evo-library/attach-file", () => ({
    attachRefusal: () => null,
    createItems: async (_l: number, items: Record<string, unknown>[]) => {
        state.created.push(items);
        const call = state.created.length;
        return items.map((_, i) =>
            state.refuse.has(i) && call > 1
                ? { key: null, message: "refused" }
                : { key: call === 1 ? "SECTION1" : `NEWANNO${i}` },
        );
    },
    uploadAttachmentWithKey: async (
        target: { key: string },
        file: { bytes: ArrayBuffer },
        parts: unknown,
    ) => {
        state.uploads.push({ key: target.key, bytes: file.bytes, parts });
        return { filename: "kittler_1986.pdf", key: "SECTPDF1" };
    },
}));

import { createBookSection } from "ui/evo-library/book-section";

const source = {
    libraryID: 1,
    attachmentKey: "BOOKPDF1",
    context: { headings: [], index: null, pageLabels: [], pageCount: 12 },
};

beforeEach(async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 12; i++) doc.addPage([100 + i, 200]);
    // Front matter i–ii, then 1, 2, …
    writeLabelRuns(doc, [
        { start: 0, style: "r", first: 1, prefix: "" },
        { start: 2, style: "D", first: 1, prefix: "" },
    ]);
    state.pdf = new Uint8Array(await doc.save());
    state.created = [];
    state.uploads = [];
    state.deleted = [];
    state.notices = [];
    state.refuse = new Set();
    state.emitted = 0;
    state.settings.evoBookSectionRemoveAnnotations = true;
});

describe("making a book section", () => {
    it("its pages as a PDF with their labels, the item, the annotations moved", async () => {
        await createBookSection(source, {
            title: "Film",
            authors: "Friedrich Kittler",
            first: 3,
            last: 6,
            pages: "2-5",
        });
        // The item: the book's data, the given title and pages.
        expect(state.created[0]).toEqual([
            expect.objectContaining({
                itemType: "bookSection",
                title: "Film",
                bookTitle: "Grammophon Film Typewriter",
                pages: "2-5",
                date: "1986",
                collections: ["MEDIA001"],
            }),
        ]);
        // Its PDF: the four pages, labelled as in the book.
        expect(state.uploads).toHaveLength(1);
        expect(state.uploads[0]!.key).toBe("SECTION1");
        expect(state.uploads[0]!.parts).toMatchObject({
            lastName: "Kittler",
            year: "1986",
            title: "Film",
            itemType: "bookSection",
        });
        const pdf = await PDFDocument.load(state.uploads[0]!.bytes);
        expect(pdf.getPageCount()).toBe(4);
        expect(pdf.getPages().map((p) => p.getWidth())).toEqual([103, 104, 105, 106]);
        expect(readPageLabels(pdf)).toEqual(["2", "3", "4", "5"]);
        // The annotations on those pages, under the new PDF; off the book's.
        expect(state.created[1]).toEqual([
            expect.objectContaining({ parentItem: "SECTPDF1", p: 0 }),
            expect.objectContaining({ parentItem: "SECTPDF1", p: 1 }),
        ]);
        expect(state.deleted).toEqual([["ANNO0003", "ANNO0004"]]);
        expect(state.emitted).toBe(1);
        expect(state.notices.at(-1)).toEqual([
            "success",
            "Book section “Film” (pp. 2-5) made; 2 annotations moved to it. It shows here after the sync.",
        ]);
    });

    it("with the setting off the book keeps its annotations", async () => {
        state.settings.evoBookSectionRemoveAnnotations = false;
        await createBookSection(source, {
            title: "Film",
            authors: "",
            first: 3,
            last: 9,
            pages: "2-8",
        });
        expect(state.created[1]).toHaveLength(3);
        expect(state.deleted).toEqual([]);
        expect(state.notices.at(-1)?.[1]).toContain("3 annotations copied to it");
    });

    it("an annotation Zotero refused stays in the book's PDF", async () => {
        state.refuse = new Set([1]);
        await createBookSection(source, {
            title: "Film",
            authors: "Friedrich Kittler",
            first: 3,
            last: 9,
            pages: "2-8",
        });
        expect(state.deleted).toEqual([["ANNO0003", "ANNO0009"]]);
        expect(state.notices.some(([t, m]) => t === "warning" && m.startsWith("1 annotation could not"))).toBe(true);
    });
});
