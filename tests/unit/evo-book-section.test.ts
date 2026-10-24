/**
 * ZotFlow Evo: `utils/evo-book-section.ts` — a book section's pages from an
 * outline heading, its item data from the book, its annotations on the new
 * PDF, and the page labels it keeps; `foldOutline` (the item pane's folded
 * headings).
 */
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import {
    defaultAuthors,
    headingAtPage,
    labelRuns,
    pageLabelOf,
    pageOfLabel,
    pagesField,
    parseAuthors,
    sectionAnnotation,
    sectionCreators,
    sectionItem,
    sectionPages,
} from "utils/evo-book-section";
import { readPageLabels, writeLabelRuns } from "utils/evo-pdf-labels";
import { foldableHeadings, foldOutline } from "utils/evo-outline-list";

import type { OutlineListEntry } from "utils/evo-outline-list";

const H = (title: string, level: number, page: number) => ({ title, level, page });

describe("the pages of a heading's section", () => {
    const outline = [
        H("Book", 0, 0),
        H("1 Media", 1, 4),
        H("1.1 Film", 2, 6),
        H("1.2 Radio", 2, 9),
        H("2 Machines", 1, 20),
        H("2.1 Typewriter", 2, 20),
        H("Index", 1, 40),
    ];

    it("to the page before the next heading of its level or higher", () => {
        expect(sectionPages(outline, 1, 50)).toEqual({ first: 4, last: 19 });
        expect(sectionPages(outline, 2, 50)).toEqual({ first: 6, last: 8 });
        // 1.2 ends where chapter 2 (a higher level) begins.
        expect(sectionPages(outline, 3, 50)).toEqual({ first: 9, last: 19 });
    });

    it("to the end without a next one; its own page when the next starts there", () => {
        expect(sectionPages(outline, 6, 50)).toEqual({ first: 40, last: 49 });
        expect(sectionPages(outline, 0, 50)).toEqual({ first: 0, last: 49 });
        expect(sectionPages([H("a", 0, 3), H("b", 0, 3)], 0, 10)).toEqual({
            first: 3,
            last: 3,
        });
    });

    it("the command's heading: the chapters' level, the one the page is in", () => {
        expect(headingAtPage(outline, 12)).toBe(1);
        expect(headingAtPage(outline, 25)).toBe(4);
        expect(headingAtPage(outline, 2)).toBe(1);
        expect(headingAtPage([], 2)).toBeNull();
        expect(headingAtPage([H("Only", 0, 5)], 9)).toBe(0);
    });
});

describe("page labels", () => {
    const labels = ["i", "ii", "iii", "1", "2", "3", "", "5"];

    it("a page as the PDF numbers it, and back", () => {
        expect(pageLabelOf(0, labels)).toBe("i");
        expect(pageLabelOf(6, labels)).toBe("7");
        expect(pageOfLabel("2", labels, labels.length)).toBe(4);
        expect(pageOfLabel(" II ", labels, labels.length)).toBe(1);
        expect(pageOfLabel("9", labels, labels.length)).toBeNull();
        // Without labels the numbers are the pages.
        expect(pageOfLabel("3", [], 10)).toBe(2);
        // The same label twice: the one nearest.
        expect(pageOfLabel("1", ["1", "2", "1", "2"], 4, 3)).toBe(2);
        expect(pagesField("45", "78")).toBe("45-78");
        expect(pagesField("xi", "xi")).toBe("xi");
    });

    it("the labels a section's pages had are written into its PDF", async () => {
        const kept = ["x", "xi", "xii", "1", "2", "3", "Plate 1", "4", "A-1"];
        expect(labelRuns(kept)).toEqual([
            { start: 0, style: "r", first: 10, prefix: "" },
            { start: 3, style: "D", first: 1, prefix: "" },
            { start: 6, style: null, first: 1, prefix: "Plate 1" },
            { start: 7, style: "D", first: 4, prefix: "" },
            { start: 8, style: null, first: 1, prefix: "A-1" },
        ]);
        const doc = await PDFDocument.create();
        for (let i = 0; i < kept.length; i++) doc.addPage([200, 200]);
        writeLabelRuns(doc, labelRuns(kept));
        const back = await PDFDocument.load(await doc.save());
        expect(readPageLabels(back)).toEqual(kept);
    });
});

describe("the section's item", () => {
    const book = {
        itemType: "book",
        title: "Grammophon Film Typewriter",
        creators: [
            { creatorType: "author", firstName: "Friedrich", lastName: "Kittler" },
            { creatorType: "translator", firstName: "Geoffrey", lastName: "Winthrop-Young" },
        ],
        publisher: "Brinkmann & Bose",
        place: "Berlin",
        date: "1986",
        ISBN: "978-3-922660-17-5",
        series: "Medien",
        numPages: "416",
        DOI: "10.1/book",
        extra: "Citation Key: kittler1986",
        abstractNote: "The book's abstract.",
        citationKey: "kittler1986",
        tags: [{ tag: "media" }, { tag: "auto", type: 1 }],
        collections: ["MEDIA001"],
    };

    it("the book's data, its title as the book title, its people in a section's roles", () => {
        const item = sectionItem(book, {
            title: "Film",
            authors: parseAuthors("Friedrich Kittler"),
            pages: "155-238",
        });
        expect(item).toMatchObject({
            itemType: "bookSection",
            title: "Film",
            bookTitle: "Grammophon Film Typewriter",
            pages: "155-238",
            publisher: "Brinkmann & Bose",
            place: "Berlin",
            date: "1986",
            ISBN: "978-3-922660-17-5",
            series: "Medien",
            collections: ["MEDIA001"],
            tags: [{ tag: "media" }, { tag: "auto", type: 1 }],
        });
        // Not the book's own: DOI, citation key, abstract, Extra; no
        // field a book section does not have.
        for (const f of ["DOI", "citationKey", "abstractNote", "extra", "numPages"])
            expect(item).not.toHaveProperty(f);
        // A chapter by the book's author: no book author besides.
        expect(item.creators).toEqual([
            { creatorType: "author", firstName: "Friedrich", lastName: "Kittler" },
            { creatorType: "translator", firstName: "Geoffrey", lastName: "Winthrop-Young" },
        ]);
    });

    it("another author: the book's authors become book authors", () => {
        expect(
            sectionCreators(parseAuthors("Bernhard Siegert; {Arbeitsgruppe Medien}"), book),
        ).toEqual([
            { creatorType: "author", firstName: "Bernhard", lastName: "Siegert" },
            { creatorType: "author", name: "Arbeitsgruppe Medien" },
            { creatorType: "bookAuthor", firstName: "Friedrich", lastName: "Kittler" },
            { creatorType: "translator", firstName: "Geoffrey", lastName: "Winthrop-Young" },
        ]);
        expect(defaultAuthors(book)).toBe("Friedrich Kittler");
    });

    it("an edited volume: the editors stay editors", () => {
        const volume = {
            itemType: "book",
            title: "Reader",
            creators: [{ creatorType: "editor", firstName: "Eva", lastName: "Horn" }],
        };
        expect(defaultAuthors(volume)).toBe("");
        expect(sectionCreators(parseAuthors("Erich Hörl"), volume)).toEqual([
            { creatorType: "author", firstName: "Erich", lastName: "Hörl" },
            { creatorType: "editor", firstName: "Eva", lastName: "Horn" },
        ]);
    });

    it("a section of a section: its book title and book authors, not its authors", () => {
        const section = {
            itemType: "bookSection",
            title: "Chapter",
            bookTitle: "The Book",
            creators: [
                { creatorType: "author", lastName: "A", firstName: "" },
                { creatorType: "bookAuthor", lastName: "B", firstName: "" },
            ],
        };
        const item = sectionItem(section, {
            title: "Part",
            authors: parseAuthors("C"),
            pages: "3-9",
        });
        expect(item.bookTitle).toBe("The Book");
        expect(item.creators).toEqual([
            { creatorType: "author", firstName: "", lastName: "C" },
            { creatorType: "bookAuthor", firstName: "", lastName: "B" },
        ]);
    });
});

describe("the annotations on the section's pages", () => {
    const annotation = (pageIndex: number, extra: Record<string, unknown> = {}) => ({
        annotationType: "highlight",
        annotationText: "text",
        annotationComment: "comment",
        annotationColor: "#ffd400",
        annotationPageLabel: String(pageIndex + 1),
        annotationSortIndex: `${String(pageIndex).padStart(5, "0")}|000123|00456`,
        annotationPosition: JSON.stringify({
            pageIndex,
            rects: [[10, 20, 30, 40]],
            ...extra,
        }),
        tags: [{ tag: "important" }],
        key: "OLDKEY01",
        version: 12,
        parentItem: "BOOKPDF1",
    });

    it("on their page of the new PDF, the rest as it was", () => {
        const out = sectionAnnotation(annotation(12), 10, 20)!;
        expect(out).toEqual({
            itemType: "annotation",
            annotationType: "highlight",
            annotationText: "text",
            annotationComment: "comment",
            annotationColor: "#ffd400",
            annotationPageLabel: "13",
            annotationSortIndex: "00002|000123|00456",
            annotationPosition: JSON.stringify({ pageIndex: 2, rects: [[10, 20, 30, 40]] }),
            tags: [{ tag: "important" }],
            relations: {},
        });
        // Not its key, version or parent: a new item under the new PDF.
        expect(out).not.toHaveProperty("key");
        expect(out).not.toHaveProperty("parentItem");
    });

    it("a note keeps no text field (Zotero takes one on highlights and underlines only)", () => {
        const note = sectionAnnotation({ ...annotation(12), annotationType: "note", annotationText: "" }, 10, 20)!;
        expect(note).not.toHaveProperty("annotationText");
        expect(sectionAnnotation({ ...annotation(12), annotationType: "underline" }, 10, 20)!.annotationText).toBe("text");
    });

    it("only those on the pages; a highlight going on past the last page loses that part", () => {
        expect(sectionAnnotation(annotation(9), 10, 20)).toBeNull();
        expect(sectionAnnotation(annotation(21), 10, 20)).toBeNull();
        expect(sectionAnnotation({ annotationPosition: "{bad" }, 0, 5)).toBeNull();
        const across = sectionAnnotation(
            annotation(20, { nextPageRects: [[1, 2, 3, 4]] }),
            10,
            20,
        )!;
        expect(JSON.parse(String(across.annotationPosition))).toEqual({
            pageIndex: 10,
            rects: [[10, 20, 30, 40]],
        });
        const inside = sectionAnnotation(
            annotation(15, { nextPageRects: [[1, 2, 3, 4]] }),
            10,
            20,
        )!;
        expect(JSON.parse(String(inside.annotationPosition)).nextPageRects).toEqual([[1, 2, 3, 4]]);
    });
});

describe("folding the item pane's outline", () => {
    const heading = (title: string, level: number): OutlineListEntry<string> => ({
        kind: "heading",
        heading: { title, level, page: 0, top: null },
    });
    const card = (id: string): OutlineListEntry<string> => ({ kind: "annotation", annotation: id });
    const entries = [
        heading("1", 0),
        card("a"),
        heading("1.1", 1),
        card("b"),
        heading("2", 0),
        heading("3", 0),
        card("c"),
    ];
    const names = (list: ReturnType<typeof foldOutline<string>>) =>
        list.map((e) => (e.entry.kind === "heading" ? e.entry.heading.title : e.entry.annotation));

    it("a folded heading hides its part, to the next of its level", () => {
        expect(names(foldOutline(entries, new Set()))).toEqual(["1", "a", "1.1", "b", "2", "3", "c"]);
        expect(names(foldOutline(entries, new Set([0])))).toEqual(["1", "2", "3", "c"]);
        expect(names(foldOutline(entries, new Set([1])))).toEqual(["1", "a", "1.1", "2", "3", "c"]);
        // A heading with nothing under it does not fold.
        expect(names(foldOutline(entries, new Set([2])))).toEqual(["1", "a", "1.1", "b", "2", "3", "c"]);
        expect([...foldableHeadings(entries)]).toEqual([0, 1, 3]);
        // All folded: the top headings only.
        expect(names(foldOutline(entries, foldableHeadings(entries)))).toEqual(["1", "2", "3"]);
    });
});
