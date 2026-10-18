/**
 * ZotFlow Evo, round 07: the links on a line (annotation strip tab), a
 * file renamed from the template, the attachment column's order.
 */
import { describe, expect, it } from "vitest";

import { linkPathsOnLine } from "utils/evo-line-links";
import { attachmentRename, sortRows } from "utils/evo-library-model";

import type { EvoItemRow } from "utils/evo-library-model";

describe("links on a line", () => {
    it("wikilinks, embeds and markdown links, in order, without heading, block or alias", () => {
        expect(
            linkPathsOnLine(
                "See [[@schmidgen2005#Kapitel 2|Schmidgen]] and ![[@kittler1986]], also [Siegert](Sources/@siegert2003.md#^abc) and [[@schmidgen2005]].",
            ),
        ).toEqual(["@schmidgen2005", "@kittler1986", "Sources/@siegert2003.md"]);
    });

    it("angle brackets and encoded spaces; web and obsidian links are not notes", () => {
        expect(linkPathsOnLine("[a](<My Notes/@x 1.md>) [b](My%20Notes/@y.md) [c](https://doi.org/10.1/x) [d](obsidian://zotflow?x=1)")).toEqual([
            "My Notes/@x 1.md",
            "My Notes/@y.md",
        ]);
        expect(linkPathsOnLine("no links here")).toEqual([]);
    });
});

describe("renaming a file from the template", () => {
    it("a stored PDF: the extension kept; the title only when it was the old name", () => {
        expect(attachmentRename({ linkMode: "imported_file", contentType: "application/pdf", filename: "old.PDF", title: "old" }, "new_2005")).toEqual({
            filename: "new_2005.PDF",
            title: "new_2005.PDF",
        });
        expect(attachmentRename({ linkMode: "imported_url", contentType: "application/pdf", filename: "x.pdf", title: "Full Text PDF" }, "new")).toEqual({ filename: "new.pdf" });
        expect(attachmentRename({ linkMode: "imported_file", contentType: "application/epub+zip", filename: "" }, "b")).toEqual({ filename: "b.epub" });
        expect(attachmentRename({ linkMode: "imported_file", contentType: "application/pdf", filename: "same.pdf" }, "same")).toBeNull();
    });

    it("not a linked file, a snapshot, or an empty name", () => {
        expect(attachmentRename({ linkMode: "linked_file", contentType: "application/pdf" }, "x")).toHaveProperty("refused");
        expect(attachmentRename({ linkMode: "imported_url", contentType: "text/html" }, "x")).toHaveProperty("refused");
        expect(attachmentRename({ linkMode: "imported_file", contentType: "application/pdf" }, "  ")).toHaveProperty("refused");
    });
});

describe("the attachment column's order", () => {
    const row = (key: string, attachment: EvoItemRow["attachment"]) =>
        ({ key, attachment, title: key, creatorSort: "", annotationCount: 0 }) as unknown as EvoItemRow;
    const rows = [row("none", null), row("snap", "snapshot"), row("pdf", "pdf"), row("epub", "epub")];
    it("best kind first; descending, items without a file first", () => {
        expect(sortRows(rows, { column: "attachment", descending: false }).map((r) => r.key)).toEqual(["pdf", "epub", "snap", "none"]);
        expect(sortRows(rows, { column: "attachment", descending: true }).map((r) => r.key)).toEqual(["none", "snap", "epub", "pdf"]);
    });
});
