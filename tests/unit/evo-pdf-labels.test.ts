/**
 * ZotFlow Evo: page labels and outline (`utils/evo-pdf-labels.ts`), and
 * plans turned back for a revert (`invertPlans`).
 */
import {
    PDFArray,
    PDFDict,
    PDFDocument,
    PDFName,
    PDFNumber,
    PDFHexString,
} from "pdf-lib";
import { describe, expect, it } from "vitest";

import { invertPlans, remapPosition } from "utils/evo-pdf-geometry";
import {
    labelsFromRanges,
    readPageLabels,
    toRoman,
    writeOutline,
    writePageLabels,
} from "utils/evo-pdf-labels";

import type { PagePlan } from "utils/evo-pdf-geometry";

async function blank(n: number) {
    const doc = await PDFDocument.create();
    for (let i = 0; i < n; i++) doc.addPage([100, 100]);
    return doc;
}

describe("page labels", () => {
    it("roman numerals", () => {
        expect([1, 4, 9, 14, 40, 90, 400, 1994].map(toRoman)).toEqual([
            "i",
            "iv",
            "ix",
            "xiv",
            "xl",
            "xc",
            "cd",
            "mcmxciv",
        ]);
    });

    it("from ranges; pages before the first range keep plain numbers", () => {
        expect(
            labelsFromRanges(
                [
                    { start: 2, style: "r" },
                    { start: 4, style: "D", first: 245 },
                ],
                6,
            ),
        ).toEqual(["1", "2", "i", "ii", "245", "246"]);
    });

    it("written and read back; an empty list removes them", async () => {
        const doc = await blank(6);
        writePageLabels(doc, [
            { start: 0, style: "r" },
            { start: 3, style: "D" },
        ]);
        const again = await PDFDocument.load(await doc.save());
        expect(readPageLabels(again)).toEqual([
            "i",
            "ii",
            "iii",
            "1",
            "2",
            "3",
        ]);
        writePageLabels(again, []);
        expect(readPageLabels(again)).toEqual(["1", "2", "3", "4", "5", "6"]);
    });

    it("read from a number tree with kids, prefixes and other styles", async () => {
        const doc = await blank(5);
        const ctx = doc.context;
        const kid = ctx.obj({
            Nums: [
                0,
                ctx.obj({ S: PDFName.of("A") }),
                2,
                ctx.obj({
                    S: PDFName.of("D"),
                    P: PDFHexString.fromText("S-"),
                    St: 10,
                }),
            ],
        });
        doc.catalog.set(
            PDFName.of("PageLabels"),
            ctx.obj({ Kids: [ctx.register(kid)] }),
        );
        expect(readPageLabels(doc)).toEqual(["A", "B", "S-10", "S-11", "S-12"]);
    });
});

describe("outline", () => {
    it("levels, siblings, counts; a level too deep is taken as one more", async () => {
        const doc = await blank(4);
        writeOutline(doc, [
            { title: "One", page: 0, level: 0 },
            { title: "One.a", page: 1, level: 3 },
            { title: "Two", page: 2, level: 0 },
            { title: "", page: 3, level: 0 },
        ]);
        const root = doc.catalog.lookup(PDFName.of("Outlines"), PDFDict);
        expect((root.lookup(PDFName.of("Count")) as PDFNumber).asNumber()).toBe(
            3,
        );
        const first = root.lookup(PDFName.of("First"), PDFDict);
        const last = root.lookup(PDFName.of("Last"), PDFDict);
        expect(
            (first.lookup(PDFName.of("Title")) as PDFHexString).decodeText(),
        ).toBe("One");
        expect(
            (last.lookup(PDFName.of("Title")) as PDFHexString).decodeText(),
        ).toBe("Two");
        const child = first.lookup(PDFName.of("First"), PDFDict);
        expect(
            (child.lookup(PDFName.of("Title")) as PDFHexString).decodeText(),
        ).toBe("One.a");
        const dest = child.lookup(PDFName.of("Dest"), PDFArray);
        expect(dest.get(0)).toBe(doc.getPage(1).ref);
        writeOutline(doc, []);
        expect(doc.catalog.has(PDFName.of("Outlines"))).toBe(false);
    });
});

describe("plans turned back (revert)", () => {
    it("a split and a turn undone: the annotation where it was", () => {
        const plans: PagePlan[] = [
            { newIndex: 0 },
            {
                newIndex: 1,
                split: { left: [0, 0, 50, 100], right: [50, 0, 100, 100] },
                turn: { degrees: 3, center: [50, 50] },
            },
        ];
        const position = { pageIndex: 1, rects: [[60, 40, 80, 50]] };
        const there = remapPosition(position, plans)!;
        expect(there.pageIndex).toBe(2);
        const back = remapPosition(there, invertPlans(plans))!;
        expect(back.pageIndex).toBe(1);
        expect(back.rects).toHaveLength(1);
        back.rects![0]!.forEach((v, j) =>
            expect(v).toBeCloseTo(position.rects[0]![j]!, 2),
        );
    });
});
