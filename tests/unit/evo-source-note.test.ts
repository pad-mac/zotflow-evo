/**
 * ZotFlow Evo: the source note as a lasting copy (utils/evo-source-note.ts).
 */
import { describe, expect, it } from "vitest";

import {
    annotationItem,
    commentLines,
    mergeRemoved,
    noteProperties,
    parseNoteData,
    propertiesYaml,
    renderAnnotations,
    serializeNoteData,
    tagFor,
} from "utils/evo-source-note";

import type { NoteAnnotation } from "utils/evo-source-note";

const ann = (key: string, page: number, top: number, over: Partial<NoteAnnotation> = {}): NoteAnnotation => ({
    key,
    attachment: "PDF00001",
    type: "highlight",
    color: "#ffd400",
    pageLabel: String(page + 1),
    sortIndex: `${String(page).padStart(5, "0")}|${String(1000 - top).padStart(6, "0")}|00000`,
    position: { pageIndex: page, rects: [[72, top - 12, 300, top]] },
    text: `text ${key}`,
    comment: "",
    tags: [],
    dateAdded: "2026-10-01T00:00:00Z",
    dateModified: "2026-10-01T00:00:00Z",
    ...over,
});

describe("tags", () => {
    it("kind and colour; renamed colours; others by hex", () => {
        expect(tagFor("highlight", "#ffd400")).toBe("#hl/yellow");
        expect(tagFor("underline", "#FF6666")).toBe("#ul/red");
        expect(tagFor("image", "#f19837")).toBe("#img/orange");
        expect(tagFor("highlight", "#ffd400", { ffd400: "definition" })).toBe("#hl/definition");
        expect(tagFor("note", "#123456")).toBe("#note/c123456");
    });
});

describe("an annotation as a list item", () => {
    it("tag, quoted text, page, block ID; the comment nested, lists kept", () => {
        const lines = annotationItem(
            ann("ANNOT001", 44, 500, { comment: "First paragraph.\n\nSecond one\nwith a break.\n\n- ! a point\n\t- deeper", tags: ["to read"] }),
        );
        expect(lines).toEqual([
            "- #hl/yellow “text ANNOT001” · p. 45 ^ANNOT001",
            "\t- First paragraph. #to_read",
            "\t- Second one",
            "\t  with a break.",
            "\t- ! a point",
            "\t\t- deeper",
        ]);
    });
    it("a removed one struck through, with the day it went", () => {
        const lines = annotationItem(ann("ANNOT002", 0, 500, { comment: "why", removed: "2026-10-21" }));
        expect(lines).toEqual(["- #hl/yellow ~~“text ANNOT002”~~ · p. 1 · *removed 2026-10-21* ^ANNOT002", "\t- ~~why~~"]);
    });
    it("a # in the text does not become a tag; notes and images", () => {
        expect(annotationItem(ann("A", 0, 1, { text: "see #methods and 3#" }))[0]).toContain("“see \\#methods and 3#”");
        expect(annotationItem(ann("B", 0, 1, { type: "note", comment: "A sticky note.\n\nMore." }))).toEqual([
            "- #note/yellow A sticky note. · p. 1 ^B",
            "\t- More.",
        ]);
        expect(annotationItem(ann("C", 0, 1, { type: "image" }), { imageFolder: "img" })[0]).toBe("- #img/yellow ![[img/C.png]] · p. 1 ^C");
        expect(commentLines("", { tags: ["x"] })).toEqual(["\t- #x"]);
    });
});

describe("removed annotations stay", () => {
    it("merged in place by sort index; the first day kept", () => {
        const prev = [ann("A", 0, 900), ann("B", 1, 900), ann("C", 2, 900, { removed: "2026-10-01" })];
        const now = [ann("A", 0, 900), ann("D", 3, 900)];
        const merged = mergeRemoved(prev, now, "2026-10-24");
        expect(merged.map((a) => `${a.key}:${a.removed ?? ""}`)).toEqual(["A:", "B:2026-10-24", "C:2026-10-01", "D:"]);
        // Back in Zotero: no longer struck.
        expect(mergeRemoved(merged, [ann("B", 1, 900)], "2026-10-25").find((a) => a.key === "B")?.removed).toBeUndefined();
    });
});

describe("the annotations under the outline", () => {
    it("headings with annotations only, levels as H2…; a heading at the top of a page goes before", () => {
        const md = renderAnnotations(
            [{ key: "PDF00001", title: "paper.pdf", headings: [
                { title: "1 Intro", level: 0, page: 0, top: null },
                { title: "2 Body", level: 0, page: 2, top: null },
                { title: "2.1 Part", level: 1, page: 3, top: 600 },
                { title: "2.2 Empty", level: 1, page: 5, top: null },
            ] }],
            [ann("A", 0, 700), ann("B", 3, 700), ann("C", 3, 500)],
        );
        expect(md.split("\n").filter((l) => l.startsWith("#") || l.startsWith("- "))).toEqual([
            "# Annotations",
            "## 1 Intro",
            "- #hl/yellow “text A” · p. 1 ^A",
            "## 2 Body",
            "- #hl/yellow “text B” · p. 4 ^B",
            "### 2.1 Part",
            "- #hl/yellow “text C” · p. 4 ^C",
        ]);
    });
    it("several files: a heading each, the outline one level down; nothing: empty", () => {
        const md = renderAnnotations(
            [{ key: "F1", title: "one.pdf", headings: [{ title: "Ch", level: 0, page: 0, top: null }] }, { key: "F2", title: "two.epub", headings: null }],
            [ann("A", 0, 500, { attachment: "F1" }), ann("B", 0, 500, { attachment: "F2" })],
        );
        expect(md).toContain("## one.pdf\n\n### Ch\n\n- #hl/yellow");
        expect(md).toContain("## two.epub\n\n- #hl/yellow");
        expect(renderAnnotations([], [])).toBe("");
    });
});

describe("the data block", () => {
    it("reads back what it wrote; a %% in a comment cannot end it", () => {
        const data = {
            outlines: [{ attachment: "PDF00001", md5: "abc", headings: [{ title: "Ch", level: 0, page: 0, top: 700 }] }, { attachment: "PDF00002", md5: "", headings: null }],
            annotations: [ann("A", 0, 500, { comment: "50%% sure\nline 2" }), ann("B", 1, 500, { removed: "2026-10-21" })],
        };
        const block = serializeNoteData(data);
        expect(block.split("\n").slice(1, -1).join("\n")).not.toContain("%%");
        expect(block.startsWith("%% zotflow-data")).toBe(true);
        expect(block.endsWith("\n%%")).toBe(true);
        const note = `---\nx: 1\n---\n# T\n\n${block}\n`;
        expect(parseNoteData(note)).toEqual(data);
        expect(parseNoteData("no block")).toEqual({ outlines: [], annotations: [] });
    });
});

describe("properties", () => {
    it("every field with a value; creators by role as links, without repeats", () => {
        const props = noteProperties({
            data: {
                itemType: "bookSection",
                title: "Entnetzt Euch!",
                creators: [
                    { creatorType: "author", firstName: "Urs", lastName: "Stäheli" },
                    { creatorType: "editor", firstName: "Anja", lastName: "Lemke" },
                    { creatorType: "bookAuthor", firstName: "Urs", lastName: "Stäheli" },
                    { creatorType: "bookAuthor", firstName: "Anja", lastName: "Lemke" },
                    { creatorType: "bookAuthor", firstName: "Anja", lastName: "Lemke" },
                    { creatorType: "bookAuthor", firstName: "Evi Ziegler", lastName: "C/O Edv Fotowerk ..." },
                    { creatorType: "author", name: "UNESCO" },
                ],
                bookTitle: "Kunst und Arbeit",
                date: "2014",
                pages: "",
                tags: [{ tag: "Netz Kultur" }],
                collections: ["X"],
                relations: {},
                dateAdded: "2024-11-03T10:12:44Z",
                key: "K", version: 3,
            },
            itemType: "bookSection",
            year: "2014",
            collections: ["Medientheorie"],
            annotationCount: 4,
            pdfLink: "obsidian://zotflow?type=open-attachment&libraryID=1&key=P",
            zoteroLink: "zotero://select/library/items/K",
        });
        const map = Object.fromEntries(props);
        expect(map.authors).toEqual(["[[Urs Stäheli]]", "[[UNESCO]]"]);
        expect(map.editors).toEqual(["[[Anja Lemke]]"]);
        expect(map.bookAuthors).toEqual(["[[Urs Stäheli]]", "[[Anja Lemke]]", "[[Evi Ziegler CO Edv Fotowerk ...]]"]);
        expect(map.bookTitle).toBe("Kunst und Arbeit");
        expect("pages" in map).toBe(false);
        expect(map.year).toBe(2014);
        expect(map.tags).toEqual(["Netz_Kultur"]);
        expect(map.collections).toEqual(["Medientheorie"]);
        expect(props[0]).toEqual(["itemType", "bookSection"]);
        expect(propertiesYaml(props)).toContain('authors: ["[[Urs Stäheli]]","[[UNESCO]]"]');
    });
});
