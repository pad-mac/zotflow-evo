/**
 * ZotFlow Evo: library browser rules added with 1.7.1-beta.7 — titles with
 * markup, collection order and pins, linked files, column resizing, and the
 * helpers of "save a file to the selected item".
 */
import { describe, expect, it } from "vitest";

import {
    attachmentKind,
    bestKind,
    choosePrimaryAttachment,
    embeddedUrls,
    filterRows,
    md5FromUrl,
    moveKey,
    orderSiblings,
    orderTree,
    plainTitle,
    resizeColumns,
    sanitizeFilename,
    siblingsId,
    sniffFile,
    splitPinned,
    titleRuns,
} from "utils/evo-library-model";

import type { EvoItemRow } from "utils/evo-library-model";

interface TreeNode {
    libraryID: number;
    key: string;
    name: string;
    children: TreeNode[];
}

const node = (
    key: string,
    name: string,
    children: TreeNode[] = [],
): TreeNode => ({
    libraryID: 1,
    key,
    name,
    children,
});

describe("titles with markup", () => {
    it("keeps <i> and <em> as italics and leaves other tags out", () => {
        expect(titleRuns("Die <i>Ordnung</i> der <b>Dinge</b>")).toEqual([
            { text: "Die ", italic: false },
            { text: "Ordnung", italic: true },
            { text: " der Dinge", italic: false },
        ]);
        expect(titleRuns("<em>Kant</em> and <sup>x</sup>")).toEqual([
            { text: "Kant", italic: true },
            { text: " and x", italic: false },
        ]);
        expect(
            plainTitle("Die <i>Ordnung</i> der <span class='x'>Dinge</span>"),
        ).toBe("Die Ordnung der Dinge");
    });

    it("a lone < or an unclosed <i> does no harm", () => {
        expect(plainTitle("a < b")).toBe("a < b");
        expect(titleRuns("<i>open")).toEqual([{ text: "open", italic: true }]);
    });

    it("the filter matches the title without its markup", () => {
        const row = {
            key: "A",
            title: "Die <i>Ordnung</i> der Dinge",
            creator: "",
            year: "",
            publication: "",
            publisher: "",
            citationKey: "",
            tags: [],
        } as unknown as EvoItemRow;
        expect(filterRows([row], "ordnung der")).toHaveLength(1);
        expect(filterRows([row], "i>")).toHaveLength(0);
    });
});

describe("linked files", () => {
    it("are their own kind: shown, never opened", () => {
        const linked = attachmentKind({
            contentType: "application/pdf",
            linkMode: "linked_file",
        });
        expect(linked).toBe("linked");
        expect(bestKind(["link", "linked"])).toBe("linked");
        expect(bestKind(["linked", "pdf"])).toBe("pdf");
        const { primary, choices } = choosePrimaryAttachment(
            [{ k: "linked" as const }],
            (a) => a.k,
        );
        expect(primary).toBeNull();
        expect(choices).toEqual([]);
    });
});

describe("collection order and pins", () => {
    const tree = [
        node("B", "Beta"),
        node("A", "Alpha", [node("A2", "Two"), node("A1", "One")]),
        node("C", "Gamma"),
    ];

    it("stored order first, the rest by name", () => {
        expect(orderSiblings(tree, ["C"]).map((n) => n.key)).toEqual([
            "C",
            "A",
            "B",
        ]);
        expect(orderSiblings(tree, undefined).map((n) => n.key)).toEqual([
            "A",
            "B",
            "C",
        ]);
    });

    it("every level keeps its own order", () => {
        const ordered = orderTree(
            tree,
            { [siblingsId(1, "A")]: ["A2"] },
            1,
            null,
        );
        expect(ordered[0]!.children.map((n) => n.key)).toEqual(["A2", "A1"]);
    });

    it("moving puts one before or after another", () => {
        expect(moveKey(["A", "B", "C"], "C", "A", false)).toEqual([
            "C",
            "A",
            "B",
        ]);
        expect(moveKey(["A", "B", "C"], "A", "B", true)).toEqual([
            "B",
            "A",
            "C",
        ]);
        expect(moveKey(["A", "B"], "X", "A", true)).toEqual(["A", "B"]);
    });

    it("a pinned collection leaves its parent, with everything inside it", () => {
        const { pinned, trees } = splitPinned(
            [{ libraryID: 1, collections: tree }],
            ["1:A", "1:GONE", "1:C"],
        );
        expect(pinned.map((n) => n.key)).toEqual(["A", "C"]);
        expect(pinned[0]!.children).toHaveLength(2);
        expect(trees[0]!.map((n) => n.key)).toEqual(["B"]);
    });

    it("a pinned sub-collection leaves its parent", () => {
        const { pinned, trees } = splitPinned(
            [{ libraryID: 1, collections: tree }],
            ["1:A1"],
        );
        expect(pinned.map((n) => n.key)).toEqual(["A1"]);
        expect(trees[0]![1]!.children.map((n) => n.key)).toEqual(["A2"]);
    });
});

describe("column resizing", () => {
    const columns = ["title", "creator", "year"] as const;

    it("the title's border moves: the next column gives or takes", () => {
        expect(resizeColumns([...columns], {}, "title", -80)).toEqual({
            creator: 240,
        });
        expect(
            resizeColumns([...columns], { creator: 100 }, "title", 90),
        ).toEqual({ creator: 30 });
    });

    it("any other column changes itself", () => {
        expect(resizeColumns([...columns], {}, "creator", 40)).toEqual({
            creator: 200,
        });
        expect(resizeColumns([...columns], {}, "year", -500)).toEqual({
            year: 30,
        });
    });

    it("a title last has nothing to move", () => {
        expect(resizeColumns(["creator", "title"], {}, "title", 50)).toEqual(
            {},
        );
    });
});

describe("saving a file to an item", () => {
    const bytes = (text: string) => new TextEncoder().encode(text).buffer;

    it("file names are safe and never empty", () => {
        expect(
            sanitizeFilename("schmidgen_2005_lebendige_kräfte:_helmholtz"),
        ).toBe("schmidgen_2005_lebendige_kräfte_helmholtz");
        expect(sanitizeFilename("a/b\\c*?<i>d</i>")).toBe("abcd");
        expect(sanitizeFilename("__x__2005__")).toBe("x_2005");
        expect(sanitizeFilename("")).toBe("file");
        expect([...sanitizeFilename("x".repeat(300))]).toHaveLength(120);
    });

    it("knows a PDF, an EPUB, a DjVu, and not a web page", () => {
        expect(sniffFile(bytes("%PDF-1.7\n..."))).toEqual({
            contentType: "application/pdf",
            extension: "pdf",
        });
        expect(sniffFile(bytes("\n\n%PDF-1.4"))?.extension).toBe("pdf");
        expect(
            sniffFile(
                bytes(
                    "PK\u0003\u0004" +
                        "x".repeat(26) +
                        "mimetypeapplication/epub+zip",
                ),
            )?.extension,
        ).toBe("epub");
        expect(sniffFile(bytes("AT&TFORM..."))?.extension).toBe("djvu");
        expect(sniffFile(bytes("<!doctype html><html>"))).toBeNull();
        expect(sniffFile(new ArrayBuffer(0))).toBeNull();
    });

    it("finds the book's MD5 in Anna's Archive addresses", () => {
        const md5 = "0123456789abcdef0123456789ABCDEF";
        expect(md5FromUrl(`https://annas-archive.gl/md5/${md5}`)).toBe(
            md5.toLowerCase(),
        );
        expect(
            md5FromUrl(`https://annas-archive.gl/fast_download/${md5}/0/1`),
        ).toBe(md5.toLowerCase());
        expect(md5FromUrl(`https://annas-archive.gl/view?md5=${md5}`)).toBe(
            md5.toLowerCase(),
        );
        expect(
            md5FromUrl("https://annas-archive.gl/search?q=kittler"),
        ).toBeNull();
    });

    it("finds file addresses inside a viewer's address", () => {
        expect(
            embeddedUrls(
                "https://viewer.example/web/viewer.html?file=https%3A%2F%2Fpartner.example%2Fa.pdf",
            ),
        ).toEqual(["https://partner.example/a.pdf"]);
        expect(
            embeddedUrls(
                "https://viewer.example/v#file=https://p.example/b.pdf",
            ),
        ).toEqual(["https://p.example/b.pdf"]);
        expect(embeddedUrls("not a url")).toEqual([]);
    });
});
