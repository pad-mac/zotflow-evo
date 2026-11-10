/**
 * ZotFlow Evo: `utils/evo-footnotes.ts` — numbered footnotes: numbering by
 * first reference, definitions at the end of their part (before the next
 * heading of a level or higher), orphans, code left alone; citation
 * clusters; copy and paste. A random search checks that a normalized note
 * stays as it is and loses no text.
 */
import { describe, expect, it } from "vitest";

import {
    applyChanges,
    editingMarker,
    formatCluster,
    normalizeFootnotes,
    pandocCitationChanges,
    parseCluster,
    parseLocator,
    preparePaste,
    refLabels,
    scanFootnotes,
} from "utils/evo-footnotes";

const norm = (text: string, level = 3, deleted?: string[]) =>
    applyChanges(
        text,
        normalizeFootnotes(text, { level, deleted: deleted ? new Set(deleted) : undefined }),
    );

describe("numbering and placing", () => {
    it("numbers by first reference; the part's definitions after it, in order", () => {
        expect(norm("a[^x] b[^y] c[^x]\n\n[^y]: Y\n[^x]: X\n")).toBe(
            "a[^1] b[^2] c[^1]\n\n[^1]: X\n[^2]: Y\n",
        );
    });

    it("each part's definitions before the next heading of level 3 or higher", () => {
        const text = [
            "# Title",
            "",
            "One[^a].",
            "",
            "#### Deeper",
            "",
            "Two[^b].",
            "",
            "### Next",
            "",
            "Three[^c].",
            "",
            "[^c]: C",
            "[^b]: B",
            "[^a]: A",
            "",
        ].join("\n");
        expect(norm(text)).toBe(
            [
                "# Title",
                "",
                "One[^1].",
                "",
                "#### Deeper",
                "",
                "Two[^2].",
                "",
                "[^1]: A",
                "[^2]: B",
                "",
                "### Next",
                "",
                "Three[^3].",
                "",
                "[^3]: C",
                "",
            ].join("\n"),
        );
        // Level 4: the deeper heading ends a part too.
        expect(norm(text, 4)).toContain("One[^1].\n\n[^1]: A\n\n#### Deeper");
    });

    it("in order already: nothing to change", () => {
        const text = "Text[^1] more[^2].\n\n[^1]: A\n[^2]: @heims1991, 45\n\n## Next\n\nX[^3]\n\n[^3]: C\n";
        expect(normalizeFootnotes(text, { level: 3 })).toEqual([]);
    });

    it("a new reference between: the ones after move up, their definitions with them", () => {
        const text = "A[^1] new[^zfc-1] B[^2]\n\n[^1]: one\n[^2]: two\n[^zfc-1]: @key\n";
        expect(norm(text)).toBe("A[^1] new[^2] B[^3]\n\n[^1]: one\n[^2]: @key\n[^3]: two\n");
    });

    it("a reference without a definition gets an empty one to fill", () => {
        expect(norm("Text[^x] here.\n")).toBe("Text[^1] here.\n\n[^1]: \n");
    });

    it("a reference moved to another part takes its definition along", () => {
        const text = "Intro.\n\n### One\n\nNow here[^1].\n\n### Two\n\nWas here.\n\n[^1]: A\n";
        expect(norm(text)).toBe(
            "Intro.\n\n### One\n\nNow here[^1].\n\n[^1]: A\n\n### Two\n\nWas here.\n",
        );
    });

    it("definitions over several lines keep them", () => {
        const text = "A[^b] B[^a]\n\n[^a]: first\n    second line\n[^b]: other\n";
        expect(norm(text)).toBe("A[^1] B[^2]\n\n[^1]: other\n[^2]: first\n    second line\n");
    });

    it("a definition written elsewhere is taken to the end of its part", () => {
        const text = "Para[^1].\n\n[^1]: A\n\nMore text.\n";
        expect(norm(text)).toBe("Para[^1].\n\nMore text.\n\n[^1]: A\n");
    });
});

describe("definitions without a reference", () => {
    it("removed when their reference was just deleted", () => {
        expect(norm("A B[^2]\n\n[^1]: one\n[^2]: two\n", 3, ["1"])).toBe("A B[^1]\n\n[^1]: two\n");
    });

    it("else kept, numbered out of the way (a broken reference does not take another's text)", () => {
        expect(norm("A[^1 B[^2]\n\n[^1]: one\n[^2]: two\n")).toBe("A[^1 B[^1]\n\n[^1]: two\n[^2]: one\n");
    });

    it("a label of its own (not a number) stays as it is", () => {
        expect(norm("A[^2]\n\n[^old]: kept\n[^2]: two\n")).toBe("A[^1]\n\n[^1]: two\n[^old]: kept\n");
    });
});

describe("what is not text", () => {
    it("code, inline code, comments and the frontmatter are left alone", () => {
        const text = [
            "---",
            "note: \"[^9]\"",
            "---",
            "A[^b] `[^c]` %%[^d]%%",
            "",
            "```",
            "[^e] [^f]: no",
            "```",
            "",
            "[^b]: B",
            "",
        ].join("\n");
        const out = norm(text);
        expect(out).toContain('note: "[^9]"');
        expect(out).toContain("A[^1] `[^c]` %%[^d]%%");
        expect(out).toContain("[^e] [^f]: no");
        expect(out.endsWith("[^1]: B\n")).toBe(true);
        expect(scanFootnotes(text).refs.map((r) => r.label)).toEqual(["b"]);
    });

    it("a reference inside a definition does not count", () => {
        expect(scanFootnotes("A[^1]\n\n[^1]: see [^2]\n").refs.map((r) => r.label)).toEqual(["1"]);
    });
});

describe("citation clusters: Pandoc's citations", () => {
    const show = (body: string) => {
        const c = parseCluster(body);
        return c ? formatCluster(c) : null;
    };

    it("works separated by semicolons, with locators, words before and after", () => {
        expect(parseCluster("[see @heims1991, pp. 23–25; also @hayles1999, chap. 2]")).toEqual([
            { citekey: "heims1991", locator: "23–25", label: "page", prefix: "see", suffix: "" },
            { citekey: "hayles1999", locator: "2", label: "chapter", prefix: "also", suffix: "" },
        ]);
        expect(parseCluster("[@a, p. 33, emphasis added]")).toEqual([
            { citekey: "a", locator: "33", label: "page", prefix: "", suffix: ", emphasis added" },
        ]);
        expect(parseCluster("[-@smith04, p. 44]")![0]).toMatchObject({ citekey: "smith04", suppressAuthor: true });
        // As written: unchanged.
        for (const b of [
            "[@heims1991, p. 23]",
            "[@a; @b]",
            "[see @heims1991, pp. 23–25; also @hayles1999, chap. 2]",
            "[@doe99, pp. 33-35, 38-39 and *passim*]",
            "[@a, p. 33, emphasis added]",
            "[-@smith04, p. 44]",
            '[@a, s.v. "Engel"]',
            "[@a, emphasis added]",
        ])
            expect(show(b)).toBe(b);
    });

    it("written with Pandoc's terms: p. for a page, pp. for more; other terms and German read too", () => {
        expect(show("[@a, 23]")).toBe("[@a, p. 23]");
        expect(show("[@a, 23-25]")).toBe("[@a, pp. 23-25]");
        expect(show("[@a, Page 5]")).toBe("[@a, p. 5]");
        expect(show("[@a, S. 12]")).toBe("[@a, p. 12]");
        expect(show("[@a, Kap. 3]")).toBe("[@a, chap. 3]");
        expect(show("[@a, 23ff.]")).toBe("[@a, pp. 23ff.]");
        expect(show("[@a, §§ 4–6]")).toBe("[@a, secs. 4–6]");
    });

    it("the bare form of beta.17 to 20 read too, and rewritten in Pandoc's", () => {
        expect(show("@heims1991")).toBe("[@heims1991]");
        expect(show("see @heims1991, 23–25; @gerhards:2004, p. 7.")).toBe(
            "[see @heims1991, pp. 23–25; @gerhards:2004, p. 7]",
        );
        expect(show("@Müller_2020, S. 12")).toBe("[@Müller_2020, p. 12]");
        const note = "A[^1] B[^2]\n\n[^1]: @heims1991, 23\n[^2]: [@hayles1999, page 7]\n";
        // Only the bare one: Pandoc's are left as written.
        expect(applyChanges(note, pandocCitationChanges(note))).toBe(
            "A[^1] B[^2]\n\n[^1]: [@heims1991, p. 23]\n[^2]: [@hayles1999, page 7]\n",
        );
    });

    it("anything else is a footnote of one's own", () => {
        expect(parseCluster("My own remark about @heims1991 and more")).toBeNull();
        expect(parseCluster("See [@a, p. 2] for details.")).toBeNull();
        expect(parseCluster("A plain remark.")).toBeNull();
        expect(parseCluster("[@a, p. 2]\n[@b]")).toBeNull();
    });

    it("a page typed in the picker", () => {
        expect(parseLocator("23", { asked: true })).toEqual({ locator: { label: "page", locator: "23" }, suffix: "" });
        expect(parseLocator("pp. 23–25", { asked: true }).locator).toEqual({ label: "page", locator: "23–25" });
        expect(parseLocator("chap. 3", { asked: true }).locator).toEqual({ label: "chapter", locator: "3" });
        expect(parseLocator("xiv", { asked: true }).locator).toEqual({ label: "page", locator: "xiv" });
        expect(parseLocator("12, Anm. 3", { asked: true })).toEqual({
            locator: { label: "page", locator: "12" },
            suffix: ", Anm. 3",
        });
        // In a footnote a word is a suffix, not a page (as Pandoc reads it).
        expect(parseLocator("xiv")).toEqual({ locator: null, suffix: ", xiv" });
    });
});

describe("copy and paste", () => {
    it("pasted references get labels of their own; definitions in the text or copied along come out", () => {
        const { body, defs } = preparePaste("Moved[^3] text[^4].\n\n[^4]: four\n", new Map([["3", "[@heims1991]"]]));
        const labels = refLabels(body);
        expect(labels).toHaveLength(2);
        expect(labels.every((l) => l.startsWith("zfp"))).toBe(true);
        expect(body.startsWith(`Moved[^${labels[0]}] text[^${labels[1]}].`)).toBe(true);
        expect(defs).toEqual([`[^${labels[0]}]: [@heims1991]`, `[^${labels[1]}]: four`]);
        // Into a note with footnotes of its own: they stay apart.
        const note = `Before[^1] ${body}\n\n[^1]: mine\n${defs.join("\n")}\n`;
        expect(norm(note)).toBe("Before[^1] Moved[^2] text[^3].\n\n[^1]: mine\n[^2]: [@heims1991]\n[^3]: four\n");
    });

    it("writing a marker: wait", () => {
        expect(editingMarker("Text [^")).toBe(true);
        expect(editingMarker("Text [^12")).toBe(true);
        expect(editingMarker("[^3]")).toBe(true);
        expect(editingMarker("Text [^3]")).toBe(false);
        expect(editingMarker("[^3]: body")).toBe(false);
    });
});

describe("a random search", () => {
    // Small random notes: paragraphs with references, headings, definitions
    // in random places. After normalizing: numbered 1… in order, each
    // number defined once at its part's end, no text lost, nothing more
    // to change.
    const rand = (seed: number) => () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
    };
    const pick = <T,>(r: () => number, list: T[]) => list[Math.floor(r() * list.length)]!;

    function note(r: () => number): { text: string; bodies: Map<string, string> } {
        const labels = ["a", "b", "c", "d", "1", "2", "7"];
        const bodies = new Map(labels.map((l) => [l, `body of ${l}`]));
        const lines: string[] = [];
        const n = 3 + Math.floor(r() * 10);
        for (let i = 0; i < n; i++) {
            const k = r();
            if (k < 0.2) lines.push(`${"#".repeat(1 + Math.floor(r() * 5))} Heading ${i}`, "");
            else if (k < 0.45) {
                const l = pick(r, labels);
                lines.push(`[^${l}]: ${bodies.get(l)}`);
                if (r() < 0.5) lines.push("");
            } else {
                const refs = Array.from({ length: Math.floor(r() * 3) }, () => `[^${pick(r, labels)}]`);
                lines.push(`Para ${i} ${refs.join(" words ")}.`, "");
            }
        }
        return { text: lines.join("\n") + "\n", bodies };
    }

    const plain = (t: string) =>
        t
            .split("\n")
            .filter((l) => !/^\[\^[^\]]+\]:/.test(l))
            .map((l) => l.replace(/\[\^[^\]]+\]/g, "[^]"))
            .filter((l) => l.trim() !== "");

    it("2000 notes", () => {
        for (let seed = 1; seed <= 2000; seed++) {
            const r = rand(seed);
            const { text } = note(r);
            const level = 1 + Math.floor(r() * 6);
            const once = norm(text, level);
            // Nothing more to change.
            expect(normalizeFootnotes(once, { level }), `seed ${seed}\n${text}\n---\n${once}`).toEqual([]);
            // No text lost or added, apart from footnote lines.
            expect(plain(once)).toEqual(plain(text));
            // Numbered 1… by first reference; each defined once, after it.
            const scan = scanFootnotes(once);
            const order: string[] = [];
            for (const ref of scan.refs) if (!order.includes(ref.label)) order.push(ref.label);
            expect(order).toEqual(order.map((_, i) => String(i + 1)));
            for (const label of order) {
                const defs = scan.defs.filter((d) => d.label === label);
                expect(defs, `seed ${seed} label ${label}\n${once}`).toHaveLength(1);
                const ref = scan.refs.find((x) => x.label === label)!;
                expect(defs[0]!.from).toBeGreaterThan(ref.from);
                // Same part: no heading of the level between them.
                const between = scan.headings.filter(
                    (h) => h.level <= level && h.from > ref.from && h.from < defs[0]!.from,
                );
                expect(between, `seed ${seed}\n${once}`).toEqual([]);
            }
            // References just deleted: their definitions go, nothing else.
            const s0 = scanFootnotes(text);
            const unref = [...new Set(s0.defs.map((d) => d.label))].filter(
                (l) => !s0.refs.some((x) => x.label === l),
            );
            const cleaned = norm(text, level, unref);
            expect(normalizeFootnotes(cleaned, { level }), `seed ${seed} (deleted)\n${text}\n---\n${cleaned}`).toEqual([]);
            expect(plain(cleaned)).toEqual(plain(text));
            // Left without a reference: only second definitions of a label in use.
            const referenced = new Set(s0.refs.map((x) => x.label));
            const inUse = s0.defs.filter((d) => referenced.has(d.label));
            const duplicates = inUse.length - new Set(inUse.map((d) => d.label)).size;
            const s1 = scanFootnotes(cleaned);
            const left = s1.defs.filter((d) => !s1.refs.some((x) => x.label === d.label));
            expect(left.length, `seed ${seed}\n${text}\n---\n${cleaned}`).toBe(duplicates);
            // The text of each referenced footnote kept (the first definition of its label).
            const firstBody = new Map<string, string>();
            for (const d of scanFootnotes(text).defs) if (!firstBody.has(d.label)) firstBody.set(d.label, d.body);
            const oldOrder: string[] = [];
            for (const ref of scanFootnotes(text).refs) if (!oldOrder.includes(ref.label)) oldOrder.push(ref.label);
            oldOrder.forEach((old, i) => {
                const d = scan.defs.find((x) => x.label === String(i + 1))!;
                expect(d.body).toBe(firstBody.get(old) ?? "");
            });
        }
    });
});
