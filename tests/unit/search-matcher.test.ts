import { describe, expect, test } from "vitest";

import {
    SearchMatcher,
    type SearchableRecord,
} from "worker/services/search-matcher";

const search = new SearchMatcher();

function record(
    id: string,
    overrides: Partial<SearchableRecord> = {},
): SearchableRecord {
    return {
        id,
        name: `Item ${id}`,
        ...overrides,
    };
}

function match(raw: string, records: SearchableRecord[]): SearchableRecord[] {
    return search.matchAndRank(search.parse(raw), records);
}

describe("SearchMatcher diacritic folding", () => {
    test("matches plain and accented free text in both directions", () => {
        const accented = record("accented", { creators: ["Lämmermann"] });
        const plain = record("plain", { creators: ["Lammermann"] });

        expect(match("Lammermann", [accented])).toEqual([accented]);
        expect(match("Lämmermann", [plain])).toEqual([plain]);
    });

    test("normalizes decomposed Unicode before folding", () => {
        const decomposed = record("decomposed", {
            creators: ["La\u0308mmermann"],
        });
        const precomposed = record("precomposed", {
            creators: ["Lämmermann"],
        });

        expect(match("Lammermann", [decomposed])).toEqual([decomposed]);
        expect(match("La\u0308mmermann", [precomposed])).toEqual([
            precomposed,
        ]);
    });

    test.each<[string, Partial<SearchableRecord>]>([
        ["creator:lammermann", { creators: ["Lämmermann"] }],
        ["tag:cafe", { tags: ["Café"] }],
        ["collection:etudes", { collections: ["Études"] }],
        ["library:universite", { libraryName: "Université" }],
    ])("folds structured filter %s", (query, overrides) => {
        const accented = record("accented", overrides);

        expect(match(query, [accented])).toEqual([accented]);
    });

    test("applies folding before evaluating a negated filter", () => {
        const accented = record("accented", { creators: ["Lämmermann"] });
        const other = record("other", { creators: ["Nakamoto"] });

        expect(match("-creator:lammermann", [accented, other])).toEqual([
            other,
        ]);
    });

    test("leaves non-Latin structured filters working", () => {
        const cjk = record("cjk", { tags: ["中文"] });

        expect(match("tag:中文", [cjk])).toEqual([cjk]);
    });
});

describe("SearchMatcher non-Latin free text", () => {
    test("matches a Chinese substring in an item title", () => {
        const cjk = record("cjk", {
            name: "国家电网湖南省电力有限公司",
        });

        expect(match("湖南", [cjk])).toEqual([cjk]);
    });

    test("requires every Chinese term across searchable fields", () => {
        const matching = record("matching", {
            name: "湖南电网工程",
            creators: ["张三"],
            tags: ["施工规范"],
        });
        const missingCreator = record("missing-creator", {
            name: "湖南电网工程",
            creators: ["李四"],
            tags: ["施工规范"],
        });

        expect(match("湖南，张三 规范", [matching, missingCreator])).toEqual([
            matching,
        ]);
    });

    test("combines Chinese filtering with Latin fuzzy matching", () => {
        const matching = record("matching", { name: "电网 Power Systems" });
        const wrongScript = record("wrong-script", {
            name: "Railway Power Systems",
        });
        const wrongLatin = record("wrong-latin", {
            name: "电网 Control Systems",
        });

        expect(
            match("电网 power", [matching, wrongScript, wrongLatin]),
        ).toEqual([matching]);
    });
});

describe("ZotFlow Evo: years", () => {
    const a = record("a", {
        name: "Lebendige Kräfte",
        creators: ["Schmidgen"],
        year: "2005",
    });
    const b = record("b", {
        name: "Die Helmholtz-Kurven",
        creators: ["Schmidgen"],
        year: "2009",
    });
    const c = record("c", {
        name: "Aufschreibesysteme",
        creators: ["Kittler"],
        year: "1985",
    });
    const d = record("d", { name: "Undated", creators: ["Schmidgen"] });

    test("a year in the query is matched exactly, with other words", () => {
        expect(match("schmidgen 2005", [a, b, c, d])).toEqual([a]);
        expect(match("2006", [a, b, c, d])).toEqual([]);
    });

    test("year: one year, or a range with open ends; negated", () => {
        expect(match("year:2009", [a, b, c, d])).toEqual([b]);
        expect(match("year:1980-2006", [a, b, c, d])).toEqual([a, c]);
        expect(match("year:2006-", [a, b, c, d])).toEqual([b]);
        expect(match("year:-1990", [a, b, c, d])).toEqual([c]);
        expect(
            match("schmidgen -year:2005", [a, b, c, d])
                .map((r) => r.id)
                .sort(),
        ).toEqual(["b", "d"]);
    });

    test("the year of a Zotero date", async () => {
        const { yearOfDate } = await import("worker/services/search-matcher");
        expect(yearOfDate("2005-03-01 2005-03-01")).toBe("2005");
        expect(yearOfDate("March 1986")).toBe("1986");
        expect(yearOfDate("ca. 1900")).toBe("1900");
        expect(yearOfDate("12345")).toBeUndefined();
        expect(yearOfDate("")).toBeUndefined();
    });
});
