/**
 * ZotFlow Evo, round 09: the journal line in the item pane, an item turned
 * into another type, author notes from a template, the backup's note.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("services/services", () => ({ services: {} }));

import { fillPersonTemplate, personFileName } from "ui/evo-person";
import { backupNote, parseBackupNote } from "utils/evo-pdf-backup";
import { changeItemType } from "utils/evo-item-type";
import { publicationLine } from "utils/evo-library-model";

describe("the journal line (Chicago author-date)", () => {
    it("volume, issue, pages after the journal; en dash in page ranges", () => {
        const p = { publication: "Grey Room", volume: "29", issue: "4", pages: "6-21" };
        expect(publicationLine("journalArticle", p)).toBe("Grey Room 29 (4): 6–21");
        expect(publicationLine("journalArticle", { ...p, issue: "" })).toBe("Grey Room 29: 6–21");
        expect(publicationLine("journalArticle", { ...p, volume: "" })).toBe("Grey Room, no. 4: 6–21");
        expect(publicationLine("journalArticle", { publication: "Grey Room" })).toBe("Grey Room");
    });
    it("other types: the publication alone", () => {
        expect(publicationLine("bookSection", { publication: "Handbook", volume: "2", pages: "1-9" })).toBe("Handbook");
        expect(publicationLine("journalArticle", { publication: "", volume: "2" })).toBe("");
    });
});

describe("changing the item type", () => {
    const article = {
        key: "K", version: 3, itemType: "journalArticle", title: "T", publicationTitle: "J", volume: "1", issue: "2", pages: "3-4", date: "2005",
        creators: [{ creatorType: "author", lastName: "A" }, { creatorType: "reviewedAuthor", lastName: "R" }], tags: [], collections: [], relations: {},
    };
    it("fields go to the new type's field for the same base field; the rest are named", () => {
        const { data, dropped } = changeItemType(article, "bookSection");
        expect(data).toMatchObject({ itemType: "bookSection", title: "T", bookTitle: "J", volume: "1", pages: "3-4", date: "2005", key: "K", version: 3 });
        expect(data).not.toHaveProperty("publicationTitle");
        expect(dropped).toEqual([{ field: "issue", value: "2" }]);
    });
    it("creators of a type the new one does not take: main creator type, or contributor", () => {
        const { data } = changeItemType(article, "book");
        expect((data.creators as { creatorType: string }[]).map((c) => c.creatorType)).toEqual(["author", "contributor"]);
    });
});

describe("author notes", () => {
    it("a name as a file name", () => {
        expect(personFileName('Kittler, Friedrich A.: "Medien"/Schrift')).toBe("Kittler, Friedrich A. MedienSchrift");
    });
    it("{{title}}, {{date}}, {{time}} with formats; other syntax left", () => {
        const now = { format: (f: string) => `<${f}>` } as never;
        expect(fillPersonTemplate("# {{title}}\ncreated {{date}} {{ time }} {{date:DD.MM.YYYY}} <% tp.file.title %>", "Kittler", now)).toBe(
            "# Kittler\ncreated <YYYY-MM-DD> <HH:mm> <DD.MM.YYYY> <% tp.file.title %>",
        );
    });
});

describe("the backup's note", () => {
    it("says what was done and holds the page plans, read back the same", () => {
        const info = { of: "ATT1", at: "2026-10-22T10:00:00.000Z", done: ["split 3 pages", "a <b> & c"], stages: [[{ newIndex: 0, split: { left: [0, 0, 1, 1] as [number, number, number, number], right: [1, 0, 2, 1] as [number, number, number, number] } }]] };
        const note = backupNote(info);
        expect(note).toMatch(/before split 3 pages, a &lt;b&gt; &amp; c/);
        expect(parseBackupNote(note)).toEqual(info);
        expect(parseBackupNote("<p>an ordinary note</p>")).toBeNull();
    });
});
