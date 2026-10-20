/**
 * ZotFlow Evo: `utils/evo-pdf-rewrite.ts` and `utils/evo-pdf-geometry.ts` —
 * the PDF editing menu's changes to the file and to annotation places.
 */
import {
    PDFDict,
    PDFDocument,
    PDFName,
    PDFNumber,
    PDFString,
    StandardFonts,
} from "pdf-lib";
import { describe, expect, it } from "vitest";

import { PDF_INFO_FILTER_KEY } from "utils/evo-pdf-filter";
import {
    remapPosition,
    rotationMatrix,
    applyMatrix,
    sortIndexOnPage,
    splitBoxes,
} from "utils/evo-pdf-geometry";
import { extractPages, pdfHasOutline, rewritePdf } from "utils/evo-pdf-rewrite";

async function sample(pages = 3, { rotate = 0, outline = true } = {}) {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < pages; i++) {
        const page = doc.addPage([600, 800]);
        page.drawText(`Page ${i + 1}`, { x: 50, y: 700, size: 20, font });
        if (rotate)
            page.setRotation({ type: "degrees", angle: rotate } as never);
    }
    doc.catalog.set(
        PDFName.of("PageLabels"),
        doc.context.obj({ Nums: [0, doc.context.obj({ S: PDFName.of("r") })] }),
    );
    if (outline) {
        const item = doc.context.obj({ Title: PDFString.of("Chapter") });
        const itemRef = doc.context.register(item);
        const root = doc.context.obj({
            Type: PDFName.of("Outlines"),
            First: itemRef,
            Last: itemRef,
            Count: PDFNumber.of(1),
        });
        const rootRef = doc.context.register(root);
        item.set(PDFName.of("Parent"), rootRef);
        doc.catalog.set(PDFName.of("Outlines"), rootRef);
        doc.catalog.set(PDFName.of("PageMode"), PDFName.of("UseOutlines"));
    }
    return doc.save();
}

const boxOf = (doc: PDFDocument, i: number) => {
    const b = doc.getPage(i).getCropBox();
    return [b.x, b.y, b.x + b.width, b.y + b.height].map((v) => Math.round(v));
};

describe("split", () => {
    it("each page becomes two, showing the left and right part; the content is shared, not copied", async () => {
        const input = await sample(3);
        const before = input.byteLength;
        const { bytes, plans, done } = await rewritePdf(input, {
            split: { shared: 0.5, pages: { "1": 0.3 } },
        });
        const doc = await PDFDocument.load(bytes);
        expect(doc.getPageCount()).toBe(6);
        expect(boxOf(doc, 0)).toEqual([0, 0, 300, 800]);
        expect(boxOf(doc, 1)).toEqual([300, 0, 600, 800]);
        expect(boxOf(doc, 2)).toEqual([0, 0, 180, 800]);
        expect(boxOf(doc, 3)).toEqual([180, 0, 600, 800]);
        expect(plans.map((p) => p.newIndex)).toEqual([0, 2, 4]);
        expect(doc.catalog.has(PDFName.of("PageLabels"))).toBe(false);
        expect(bytes.byteLength).toBeLessThan(before * 1.6);
        expect(done).toEqual(["split 3 pages"]);
        // Both halves draw the same content stream.
        const c0 = doc.getPage(0).node.get(PDFName.of("Contents"));
        const c1 = doc.getPage(1).node.get(PDFName.of("Contents"));
        expect(String(c0)).toBe(String(c1));
    });

    it("a page turned by /Rotate is cut across what is shown", () => {
        expect(splitBoxes([0, 0, 600, 800], 90, 0.25)).toEqual({
            left: [0, 0, 600, 200],
            right: [0, 200, 600, 800],
        });
        expect(splitBoxes([0, 0, 600, 800], 180, 0.25)).toEqual({
            left: [450, 0, 600, 800],
            right: [0, 0, 450, 800],
        });
        expect(splitBoxes([0, 0, 600, 800], 270, 0.25)).toEqual({
            left: [0, 600, 600, 800],
            right: [0, 0, 600, 600],
        });
    });
});

describe("straighten, outline, page filter", () => {
    it("turns the content, removes the bookmarks, writes the filter", async () => {
        const input = await sample(2);
        expect(await pdfHasOutline(input)).toBe(true);
        const { bytes, plans, done } = await rewritePdf(input, {
            straighten: { "1": 2 },
            removeOutline: true,
            pageFilter: { contrast: 2, whiteThreshold: 200, saturation: 1 },
        });
        const doc = await PDFDocument.load(bytes);
        expect(await pdfHasOutline(bytes)).toBe(false);
        expect(doc.catalog.get(PDFName.of("PageMode"))).toEqual(
            PDFName.of("UseNone"),
        );
        expect(plans[1]!.turn).toEqual({ degrees: 2, center: [300, 400] });
        expect(plans[0]!.turn).toBeUndefined();
        expect(done).toEqual(["straightened 1 page", "removed the outline"]);
        const info = doc.context.lookup(doc.context.trailerInfo.Info, PDFDict);
        const filter = info.get(PDFName.of(PDF_INFO_FILTER_KEY)) as PDFString;
        expect(JSON.parse(filter.decodeText())).toEqual({
            contrast: 2,
            whiteThreshold: 200,
            saturation: 1,
        });
    });

    it("never turns by more than 5°", async () => {
        const { plans } = await rewritePdf(await sample(1), {
            straighten: { "0": 12 },
        });
        expect(plans[0]!.turn).toBeUndefined();
    });
});

describe("extract", () => {
    it("copies the chosen pages into a new PDF", async () => {
        const out = await extractPages(await sample(5), [3, 1, 3, 9], {
            title: "Part",
        });
        const doc = await PDFDocument.load(out);
        expect(doc.getPageCount()).toBe(2);
        expect(doc.getTitle()).toBe("Part");
        await expect(extractPages(await sample(2), [7])).rejects.toThrow(
            /No pages/,
        );
    });
});

describe("annotation places", () => {
    const plansSplit = [
        {
            newIndex: 0,
            split: {
                left: [0, 0, 300, 800] as [number, number, number, number],
                right: [300, 0, 600, 800] as [number, number, number, number],
            },
        },
        { newIndex: 2 },
    ];
    it("a split page: an annotation goes to the half its middle is in", () => {
        expect(
            remapPosition(
                { pageIndex: 0, rects: [[50, 700, 120, 715]] },
                plansSplit,
            )?.pageIndex,
        ).toBe(0);
        expect(
            remapPosition(
                { pageIndex: 0, rects: [[350, 700, 420, 715]] },
                plansSplit,
            )?.pageIndex,
        ).toBe(1);
        expect(
            remapPosition(
                { pageIndex: 1, rects: [[50, 700, 120, 715]] },
                plansSplit,
            )?.pageIndex,
        ).toBe(2);
        expect(
            remapPosition({ pageIndex: 5, rects: [] }, plansSplit),
        ).toBeNull();
    });
    it("a turned page: the points turn with the content", () => {
        const m = rotationMatrix(90, 300, 400);
        expect(applyMatrix(m, 400, 400).map(Math.round)).toEqual([300, 500]);
        const out = remapPosition(
            {
                pageIndex: 0,
                rects: [[290, 390, 310, 410]],
                paths: [[300, 400, 310, 400]],
            },
            [{ newIndex: 0, turn: { degrees: 90, center: [300, 400] } }],
        );
        expect(out?.rects?.[0]).toEqual([290, 390, 310, 410]);
        expect(out?.paths?.[0]?.map(Math.round)).toEqual([300, 400, 300, 410]);
    });
    it("sort index on another page", () => {
        expect(sortIndexOnPage("00003|000120|00072", 7)).toBe(
            "00007|000120|00072",
        );
        expect(sortIndexOnPage("weird", 7)).toBe("weird");
    });
});
