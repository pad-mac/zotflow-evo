/**
 * ZotFlow Evo: the text layer for OCR — reading content streams for drawn
 * and invisible text (`utils/evo-pdf-content.ts`), taking an earlier OCR
 * layer out and laying Tesseract's text page over a page
 * (`utils/evo-pdf-ocr-layer.ts`, `rewritePdf`'s `ocr`).
 */
import {
    PDFDocument,
    PDFName,
    PDFRawStream,
    StandardFonts,
    decodePDFRawStream,
} from "pdf-lib";
import { describe, expect, it } from "vitest";

import { stripInvisibleText, summarizeText } from "utils/evo-pdf-content";
import { compose, invert, pageText } from "utils/evo-pdf-ocr-layer";
import { ocrCandidates, rewritePdf } from "utils/evo-pdf-rewrite";

import type { Matrix } from "utils/evo-pdf-ocr-layer";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder("latin1").decode(b);

describe("reading content streams", () => {
    it("drawn and invisible text; q/Q keep the render mode", () => {
        const s = summarizeText(
            enc(
                "BT /F1 12 Tf (Hello) Tj ET q BT 3 Tr (abc) Tj [(de) -50 (f)] TJ ET Q BT (xy) Tj ET",
            ),
        );
        expect(s).toMatchObject({ visible: 7, invisible: 6 });
    });

    it("hex strings, escapes, nested parentheses; an inline image's data is not read", () => {
        const s = summarizeText(
            enc(
                "BT <48656c6c6f> Tj (a\\)b(c)) Tj ET BI /W 2 /H 1 /BPC 8 /CS /G ID \x00(xx) Tj\x01 EI Q",
            ),
        );
        expect(s.visible).toBe(5 + 6);
    });

    it("text in render mode 7 (clip only) is invisible but stays", () => {
        const bytes = enc("BT 7 Tr (clip) Tj ET");
        expect(summarizeText(bytes)).toMatchObject({
            visible: 0,
            invisible: 4,
        });
        expect(stripInvisibleText(bytes)).toBeNull();
    });

    it("strips invisible text only; ' and \" keep their line moves", () => {
        const bytes = enc(
            "BT /F1 9 Tf 3 Tr (gone) Tj (two) ' 1 2 (three) \" 0 Tr (stays) Tj ET",
        );
        const out = dec(stripInvisibleText(bytes)!);
        expect(out).not.toMatch(/gone|two|three/);
        expect(out).toContain("T*");
        expect(out).toContain("1 Tw 2 Tc T*");
        expect(out).toContain("(stays) Tj");
        expect(summarizeText(enc(out))).toMatchObject({
            visible: 5,
            invisible: 0,
        });
    });

    it("names the XObjects drawn, with the render mode then", () => {
        expect(summarizeText(enc("q 3 Tr /Fm1 Do Q /Im0 Do")).xobjects).toEqual(
            [
                { name: "Fm1", mode: 3 },
                { name: "Im0", mode: 0 },
            ],
        );
    });
});

/** A PDF: a born-digital page, and a "scan" with an old OCR layer in the page and in a form. */
async function sample() {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const digital = doc.addPage([600, 800]);
    digital.drawText(
        "A born-digital page with more than forty characters of text.",
        { x: 40, y: 700, size: 12, font },
    );
    const scan = doc.addPage([600, 800]);
    scan.drawRectangle({ x: 0, y: 0, width: 600, height: 800 }); // stands in for the scan's image
    const formStream = doc.context.flateStream(
        enc("BT /F1 10 Tf 3 Tr 10 10 Td (old form layer) Tj ET"),
        {
            Type: "XObject",
            Subtype: "Form",
            BBox: [0, 0, 600, 800],
            Resources: { Font: { F1: font.ref } },
        },
    );
    const formRef = doc.context.register(formStream);
    const name = scan.node.newXObject("Fm", formRef);
    const fontName = scan.node.newFontDictionary("F", font.ref);
    const old = doc.context.register(
        doc.context.flateStream(
            enc(
                `BT ${fontName.asString()} 10 Tf 3 Tr 50 50 Td (old page layer) Tj ET q ${name.asString()} Do Q`,
            ),
        ),
    );
    scan.node.addContentStream(old);
    return { bytes: await doc.save(), formRef };
}

/** Tesseract's text-only page stands in: invisible text on a page of the image's size at 72 dpi. */
async function textPage(width: number, height: number) {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([width, height]);
    const f = page.node.newFontDictionary("F", font.ref);
    page.node.addContentStream(
        doc.context.register(doc.context.contentStream([] as never)),
    );
    page.pushOperators();
    const ops = doc.context.register(
        doc.context.flateStream(
            enc(`BT ${f.asString()} 20 Tf 3 Tr 100 100 Td (Recognized) Tj ET`),
        ),
    );
    page.node.addContentStream(ops);
    return doc.save();
}

describe("the text layer of a page", () => {
    it("born-digital pages are left; scans (even with an old layer) are recognized", async () => {
        const { bytes } = await sample();
        expect(await ocrCandidates(bytes)).toEqual({
            pages: [1],
            withText: [0],
        });
        const doc = await PDFDocument.load(bytes);
        expect(pageText(doc, doc.getPage(1))).toEqual({
            visible: 0,
            invisible: 14 + 14,
        });
    });

    it("the old layer goes, in the page and in its form; the new text is laid over, where the image was", async () => {
        const { bytes, formRef } = await sample();
        // The page was rendered at 2× (1200×1600 px), y down: pixels → user space.
        const viewport: Matrix = [2, 0, 0, -2, 0, 1600];
        const { bytes: out, done } = await rewritePdf(bytes, {
            ocr: [
                {
                    pageIndex: 1,
                    pdf: await textPage(1200, 1600),
                    width: 1200,
                    height: 1600,
                    toUser: invert(viewport),
                },
            ],
        });
        expect(done[0]).toBe("recognized the text of 1 page");
        const doc = await PDFDocument.load(out);
        const page = doc.getPage(1);
        // Old text gone; the new layer's 10 characters, invisible.
        expect(pageText(doc, page)).toEqual({ visible: 0, invisible: 10 });
        const form = doc.context.lookup(formRef) as PDFRawStream;
        expect(dec(decodePDFRawStream(form).decode())).not.toContain(
            "old form layer",
        );
        // The overlay: q … Q around the old content, then the form at the right scale.
        const contents = page.node.Contents()!;
        const all = (contents as unknown as { asArray(): unknown[] })
            .asArray()
            .map((r) => {
                const s = doc.context.lookup(r as never);
                return s instanceof PDFRawStream
                    ? dec(decodePDFRawStream(s).decode())
                    : dec(
                          (
                              s as unknown as { getContents(): Uint8Array }
                          ).getContents(),
                      );
            });
        const last = all[all.length - 1]!;
        expect(all[0]!.trim()).toBe("q");
        expect(last).toMatch(/^q\n?0\.5 0 0 0\.5 0 0 cm\n?\/OCR-?\d+ Do\n?Q/);
        // The first page is untouched.
        expect(pageText(doc, doc.getPage(0)).visible).toBeGreaterThanOrEqual(
            40,
        );
    });

    it("turned with the page when it is straightened too", async () => {
        const { bytes } = await sample();
        const { bytes: out } = await rewritePdf(bytes, {
            ocr: [
                {
                    pageIndex: 1,
                    pdf: await textPage(600, 800),
                    width: 600,
                    height: 800,
                    toUser: invert([1, 0, 0, -1, 0, 800]),
                },
            ],
            straighten: { "1": 2 },
        });
        const doc = await PDFDocument.load(out);
        const contents = doc.getPage(1).node.Contents() as unknown as {
            asArray(): unknown[];
        };
        const first = doc.context.lookup(
            contents.asArray()[0] as never,
        ) as unknown as {
            getContents(): Uint8Array;
        };
        // The straightening's q … cm comes first, around everything, the text included.
        const head =
            first instanceof PDFRawStream
                ? dec(decodePDFRawStream(first).decode())
                : dec(first.getContents());
        expect(head).toMatch(/^q\n?0\.99939/);
    });

    it("matrices: compose and invert", () => {
        const m: Matrix = [2, 0.5, -0.5, 2, 10, 20];
        const id = compose(m, invert(m)).map((v) => Math.round(v * 1e9) / 1e9);
        expect(id).toEqual([1, 0, 0, 1, 0, 0]);
        expect(PDFName.of("OCR").asString()).toBe("/OCR");
    });
});
