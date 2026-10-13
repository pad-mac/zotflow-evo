/**
 * ZotFlow Evo: `utils/evo-library-model.ts` — the rules of the library
 * browser and the annotation browser.
 */
import { describe, expect, it } from "vitest";

import {
    annotationColors,
    attachmentKind,
    bestKind,
    bookSearchUrl,
    cellText,
    choosePrimaryAttachment,
    creatorSummary,
    filterRows,
    groupAnnotations,
    itemReference,
    mainCreators,
    rangeOf,
    sanitizeColumns,
    sortRows,
} from "utils/evo-library-model";

import type {
    AttachmentKind,
    EvoAnnotatedItem,
    EvoCollectionAnnotation,
    EvoItemRow,
} from "utils/evo-library-model";

describe("which attachment opens", () => {
    const pick = (kinds: AttachmentKind[]) => {
        const list = kinds.map((kind, i) => ({ id: `${kind}${i}`, kind }));
        const r = choosePrimaryAttachment(list, (a) => a.kind);
        return { primary: r.primary?.id ?? null, choices: r.choices.map((c) => c.id) };
    };

    it("recognises PDFs, EPUBs, snapshots and links", () => {
        expect(attachmentKind({ contentType: "application/pdf", linkMode: "imported_file" })).toBe("pdf");
        expect(attachmentKind({ contentType: "application/epub+zip" })).toBe("epub");
        expect(attachmentKind({ contentType: "text/html", linkMode: "imported_url" })).toBe("snapshot");
        expect(attachmentKind({ contentType: "text/html", linkMode: "linked_url" })).toBe("link");
        expect(attachmentKind({ contentType: "application/zip" })).toBe("other");
    });

    it("a PDF before an EPUB before a snapshot; links and other files never count", () => {
        expect(pick(["snapshot", "epub", "pdf", "link"])).toEqual({ primary: "pdf2", choices: [] });
        expect(pick(["snapshot", "epub", "link"])).toEqual({ primary: "epub1", choices: [] });
        expect(pick(["link", "snapshot", "other"])).toEqual({ primary: "snapshot1", choices: [] });
        expect(pick(["link", "other"])).toEqual({ primary: null, choices: [] });
        expect(pick([])).toEqual({ primary: null, choices: [] });
    });

    it("asks only when the best kind is there more than once", () => {
        expect(pick(["pdf", "epub", "pdf"])).toEqual({ primary: null, choices: ["pdf0", "pdf2"] });
        expect(pick(["epub", "epub", "snapshot"])).toEqual({ primary: null, choices: ["epub0", "epub1"] });
        expect(pick(["snapshot", "snapshot", "link"])).toEqual({ primary: null, choices: ["snapshot0", "snapshot1"] });
        expect(pick(["pdf", "epub", "epub"])).toEqual({ primary: "pdf0", choices: [] });
    });

    it("the indicator shows the best kind", () => {
        expect(bestKind(["link", "snapshot", "epub"])).toBe("epub");
        expect(bestKind(["link"])).toBeNull();
    });
});

describe("names", () => {
    const a = (lastName: string, creatorType = "author") => ({ creatorType, firstName: "X", lastName });
    it("main creators: the authors, else the first role", () => {
        expect(mainCreators([a("Ed", "editor"), a("Au")]).map((c) => c.lastName)).toEqual(["Au"]);
        expect(mainCreators([a("Ed1", "editor"), a("Tr", "translator"), a("Ed2", "editor")]).map((c) => c.lastName)).toEqual(["Ed1", "Ed2"]);
    });
    it("summary as Zotero's creator column", () => {
        expect(creatorSummary([a("Schmidgen")])).toBe("Schmidgen");
        expect(creatorSummary([a("Schmidgen"), a("Siegert")])).toBe("Schmidgen and Siegert");
        expect(creatorSummary([a("Schmidgen"), a("Siegert"), a("Ofak")])).toBe("Schmidgen et al.");
        expect(creatorSummary([{ creatorType: "author", name: "ACME Corp" }])).toBe("ACME Corp");
        expect(creatorSummary([])).toBe("");
    });
});

const row = (key: string, patch: Partial<EvoItemRow> = {}): EvoItemRow => ({
    libraryID: 1,
    key,
    itemType: "book",
    title: key,
    creator: "",
    creatorSort: "",
    firstCreator: "",
    year: "",
    date: "",
    publication: "",
    publisher: "",
    dateAdded: "",
    dateModified: "",
    citationKey: "",
    attachment: null,
    attachmentCount: 0,
    annotationCount: 0,
    tags: [],
    ...patch,
});

describe("the table", () => {
    it("columns: known ones in order, no repeats, always the title", () => {
        expect(sanitizeColumns(["year", "bogus", "year", "creator"], ["title"])).toEqual(["title", "year", "creator"]);
        expect(sanitizeColumns(undefined, ["title", "year"])).toEqual(["title", "year"]);
    });

    it("sorts by a column, empty values last either way, ties by title", () => {
        const rows = [row("c", { year: "2001" }), row("a", { year: "1999" }), row("b", { year: "" }), row("d", { year: "2001" })];
        expect(sortRows(rows, { column: "year", descending: false }).map((r) => r.key)).toEqual(["a", "c", "d", "b"]);
        expect(sortRows(rows, { column: "year", descending: true }).map((r) => r.key)).toEqual(["c", "d", "a", "b"]);
    });

    it("titles sort with numbers in order and leading quotes ignored", () => {
        const rows = [row("x", { title: "Part 10" }), row("y", { title: "Part 9" }), row("z", { title: '"Part 1"' })];
        expect(sortRows(rows, { column: "title", descending: false }).map((r) => r.key)).toEqual(["z", "y", "x"]);
    });

    it("sorts the attachment column best kind first, and by annotation count", () => {
        const rows = [row("none"), row("snap", { attachment: "snapshot" }), row("pdf", { attachment: "pdf" })];
        expect(sortRows(rows, { column: "attachment", descending: false }).map((r) => r.key)).toEqual(["pdf", "snap", "none"]);
        const counted = [row("a", { annotationCount: 2 }), row("b", { annotationCount: 0 }), row("c", { annotationCount: 9 })];
        expect(sortRows(counted, { column: "annotations", descending: true }).map((r) => r.key)).toEqual(["c", "a", "b"]);
    });

    it("cells", () => {
        const r = row("k", { itemType: "journalArticle", dateAdded: "2026-10-14T08:00:00Z", annotationCount: 3 });
        expect(cellText(r, "itemType")).toBe("Journal Article");
        expect(cellText(r, "dateAdded")).toBe("2026-10-14");
        expect(cellText(r, "annotations")).toBe("3");
        expect(cellText(row("n"), "annotations")).toBe("");
    });

    it("the filter wants every word, anywhere", () => {
        const rows = [
            row("a", { title: "Lebendige Kräfte", creator: "Schmidgen", year: "2005" }),
            row("b", { title: "Grammophon", creator: "Kittler", year: "1986", tags: ["Media"] }),
        ];
        expect(filterRows(rows, "schmidgen 2005").map((r) => r.key)).toEqual(["a"]);
        expect(filterRows(rows, "media kittler").map((r) => r.key)).toEqual(["b"]);
        expect(filterRows(rows, "  ").map((r) => r.key)).toEqual(["a", "b"]);
    });

    it("Shift+click selects the range between the anchor and the row", () => {
        const order = ["a", "b", "c", "d", "e"];
        expect(rangeOf(order, "b", "d")).toEqual(["b", "c", "d"]);
        expect(rangeOf(order, "d", "b")).toEqual(["b", "c", "d"]);
        expect(rangeOf(order, null, "c")).toEqual(["c"]);
        expect(rangeOf(order, "gone", "c")).toEqual(["c"]);
    });

    it("searches for a file by title, first author and year", () => {
        expect(bookSearchUrl("https://annas-archive.gl/search?q=", { title: "Lebendige Kräfte", firstCreator: "Henning Schmidgen", year: "2005" })).toBe(
            "https://annas-archive.gl/search?q=" + encodeURIComponent("Lebendige Kräfte Henning Schmidgen 2005"),
        );
        expect(bookSearchUrl("", { title: "T", firstCreator: "", year: "" })).toBe("https://annas-archive.gl/search?q=T");
    });
});

describe("the annotation browser", () => {
    const items = new Map<string, EvoAnnotatedItem>([
        ["B", { key: "B", title: "Beta", shortTitle: "", creator: "Bee", year: "2001", dateAdded: "2026-01-01" }],
        ["A", { key: "A", title: "Alpha", shortTitle: "Al", creator: "Ay", year: "1999", dateAdded: "2026-05-01" }],
    ]);
    const ann = (id: string, itemKey: string, color: string, sortIndex: string, tags: string[] = []): EvoCollectionAnnotation => ({
        id,
        libraryID: 1,
        itemKey,
        attachmentKey: itemKey + "P",
        type: "highlight",
        text: id,
        color,
        sortIndex,
        tags,
        dateAdded: "",
    });
    const list = [
        ann("a2", "A", "#ff6666", "00002|000000|00000", ["method"]),
        ann("b1", "B", "#ffd400", "00001|000000|00000"),
        ann("a1", "A", "#FFD400", "00001|000000|00000", ["theory", "method"]),
        ann("b2", "B", "#5fb236", "00003|000000|00000", ["theory"]),
    ];
    const shape = (groups: ReturnType<typeof groupAnnotations>) =>
        groups.map((g) => [g.label, g.annotations.map((a) => a.id).join(",")]);

    it("by item: items by title, each in page order; the item is the heading", () => {
        const groups = groupAnnotations(list, items, { groupBy: "item", thenBy: "none", itemOrder: "title" });
        expect(shape(groups)).toEqual([["Alpha", "a1,a2"], ["Beta", "b1,b2"]]);
        expect(groups[0]!.showsItem).toBe(false);
        expect(groups[0]!.detail).toBe("Ay 1999");
    });

    it("by item, items by date added", () => {
        const groups = groupAnnotations(list, items, { groupBy: "item", thenBy: "none", itemOrder: "dateAdded" });
        expect(shape(groups).map((g) => g[0])).toEqual(["Beta", "Alpha"]);
    });

    it("by colour in the reader's order, then by item (date added), then page; each names its item", () => {
        const groups = groupAnnotations(list, items, { groupBy: "color", thenBy: "item", itemOrder: "dateAdded" });
        expect(shape(groups)).toEqual([["Yellow", "b1,a1"], ["Red", "a2"], ["Green", "b2"]]);
        expect(groups.every((g) => g.showsItem)).toBe(true);
    });

    it("by tag: under each of its tags, untagged last, then by colour", () => {
        const groups = groupAnnotations(list, items, { groupBy: "tag", thenBy: "color", itemOrder: "title" });
        expect(shape(groups)).toEqual([["method", "a1,a2"], ["theory", "a1,b2"], ["No tag", "b1"]]);
    });

    it("the colour filter, any letter case", () => {
        const groups = groupAnnotations(list, items, { groupBy: "item", thenBy: "none", itemOrder: "title" }, new Set(["#ffd400"]));
        expect(shape(groups)).toEqual([["Alpha", "a1"], ["Beta", "b1"]]);
    });

    it("the reference after an annotation, and the colours in use", () => {
        expect(itemReference(items.get("A"))).toBe("(Ay 1999, Al)");
        expect(itemReference(items.get("B"))).toBe("(Bee 2001, Beta)");
        expect(annotationColors(list)).toEqual(["#ffd400", "#ff6666", "#5fb236"]);
    });
});
