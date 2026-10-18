/**
 * ZotFlow Evo: `utils/evo-fulltext.ts` — the full-text search's query for
 * Zotero's index, the check in the extracted text, snippets, order.
 */
import { describe, expect, it } from "vitest";

import {
    findMatches,
    foldText,
    ftsQuery,
    groupHits,
    hitLabel,
    makeSnippets,
    orderHits,
} from "utils/evo-fulltext";

import type { FulltextHit, FulltextItem } from "utils/evo-fulltext";

const spec = (query: string, matchCase = false, wholeWords = false) => ({
    query,
    matchCase,
    wholeWords,
});

describe("the query for the index", () => {
    it("the words as a phrase; a prefix unless whole words", () => {
        expect(ftsQuery(spec("technische Objekte"))).toBe(
            '"technische Objekte"*',
        );
        expect(ftsQuery(spec("technische Objekte", false, true))).toBe(
            '"technische Objekte"',
        );
        expect(ftsQuery(spec('a "quoted" (b) OR c*'))).toBe(
            '"a quoted b OR c"*',
        );
        expect(ftsQuery(spec(" … - "))).toBeNull();
    });
});

describe("the check in the text", () => {
    const text =
        "Die Individuation technischer Objekte. INDIVIDUATION, individuell; Krämer und Kramer.";

    it("ignores case and accents unless asked", () => {
        expect(findMatches(text, spec("individu")).length).toBe(3);
        expect(findMatches(text, spec("Individu", true)).length).toBe(1);
        expect(
            findMatches(text, spec("kramer")).map((m) =>
                text.slice(m.start, m.end),
            ),
        ).toEqual(["Krämer", "Kramer"]);
        expect(findMatches(text, spec("Krämer", true)).length).toBe(1);
    });

    it("whole words", () => {
        expect(
            findMatches(text, spec("individuation", false, true)).length,
        ).toBe(2);
        expect(findMatches(text, spec("individu", false, true)).length).toBe(0);
    });

    it("words in a row, whatever stands between them", () => {
        const t =
            "technischer\n  Objekte; technischer-Objekte, technischer Dinge";
        expect(findMatches(t, spec("technischer Objekte")).length).toBe(2);
    });

    it("offsets point into the original text, also after folded characters", () => {
        const t = "Ǆ Æsthetik İstanbul Straße";
        const [m] = findMatches(t, spec("istanbul"));
        expect(t.slice(m!.start, m!.end)).toBe("İstanbul");
        const [s] = findMatches(t, spec("straße"));
        expect(t.slice(s!.start, s!.end)).toBe("Straße");
        expect(foldText("Ä").folded).toBe("a");
    });
});

describe("snippets", () => {
    const filler = (n: number) =>
        Array.from({ length: n }, (_, i) => `w${i}`).join(" ");

    it("context before and after, cut at spaces, the match marked", () => {
        const text = `${filler(80)} Simondon ${filler(80)}`;
        const [s] = makeSnippets(text, findMatches(text, spec("simondon")), {
            context: 40,
        });
        expect(s!.parts.map((p) => p.hit)).toEqual([false, true, false]);
        expect(s!.parts[1]!.text).toBe("Simondon");
        expect(s!.parts[0]!.text.startsWith("…w")).toBe(true);
        expect(s!.parts[2]!.text.endsWith("…")).toBe(true);
        expect(s!.parts[0]!.text.length).toBeLessThanOrEqual(42);
    });

    it("matches close together share a snippet; pages from form feeds", () => {
        const text = `page one\fA Simondon and Simondon again\f${filler(200)} Simondon`;
        const snippets = makeSnippets(
            text,
            findMatches(text, spec("simondon")),
            { context: 40 },
        );
        expect(snippets).toHaveLength(2);
        expect(snippets[0]!.parts.filter((p) => p.hit)).toHaveLength(2);
        expect(snippets[0]!.pageIndex).toBe(1);
        expect(snippets[1]!.pageIndex).toBe(2);
        expect(
            makeSnippets(
                "no pages Simondon",
                findMatches("no pages Simondon", spec("simondon")),
            )[0]!.pageIndex,
        ).toBeNull();
    });
});

describe("order and groups", () => {
    const hit = (key: string, rank: number, att = key + "A"): FulltextHit => ({
        itemID: rank,
        libraryID: 1,
        attachmentKey: att,
        itemKey: key,
        contentType: "application/pdf",
        rank,
    });
    const items = new Map<string, FulltextItem>([
        [
            "1:B",
            {
                title: "Beta",
                shortTitle: "",
                lastName: "Bee",
                year: "2001",
                dateAdded: "2026-02",
                tags: ["x"],
            },
        ],
        [
            "1:A",
            {
                title: "Alpha <i>one</i>",
                shortTitle: "Alpha",
                lastName: "Ay",
                year: "1999",
                dateAdded: "2026-03",
                tags: [],
            },
        ],
        [
            "1:C",
            {
                title: "Gamma",
                shortTitle: "",
                lastName: "Cee",
                year: "2010",
                dateAdded: "2026-01",
                tags: ["x", "y"],
            },
        ],
    ]);
    const hits = [hit("A", -1), hit("B", -5), hit("C", -3), hit("B", -2, "B2")];

    it("by relevance (an item by its best file), title, date, either way", () => {
        const keys = (layout: Parameters<typeof orderHits>[2]) =>
            orderHits(hits, items, layout).map((h) => h.attachmentKey);
        expect(
            keys({ groupBy: "item", order: "relevance", descending: false }),
        ).toEqual(["BA", "B2", "CA", "AA"]);
        expect(
            keys({ groupBy: "item", order: "title", descending: false }),
        ).toEqual(["AA", "BA", "B2", "CA"]);
        expect(
            keys({ groupBy: "item", order: "dateAdded", descending: true }),
        ).toEqual(["AA", "BA", "B2", "CA"]);
        expect(
            keys({ groupBy: "item", order: "year", descending: false }),
        ).toEqual(["AA", "BA", "B2", "CA"]);
    });

    it('groups: per item, per tag ("No tag" last), or one list', () => {
        const ordered = orderHits(hits, items, {
            groupBy: "item",
            order: "title",
            descending: false,
        });
        expect(groupHits(ordered, items, "item").map((g) => g.label)).toEqual([
            "Alpha <i>one</i>",
            "Beta",
            "Gamma",
        ]);
        expect(
            groupHits(ordered, items, "tag").map((g) => [
                g.label,
                g.hits.length,
            ]),
        ).toEqual([
            ["x", 3],
            ["y", 1],
            ["No tag", 1],
        ]);
        expect(groupHits(ordered, items, "none")[0]!.hits).toHaveLength(4);
    });

    it("an item named beside a snippet: last name - year - short title", () => {
        expect(hitLabel(items.get("1:A"))).toBe("Ay - 1999 - Alpha");
        expect(hitLabel(items.get("1:B"))).toBe("Bee - 2001 - Beta");
    });
});
