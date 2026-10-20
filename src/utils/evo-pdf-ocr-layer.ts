/**
 * ZotFlow Evo (fork): a page's text layer, for OCR (pdf-lib). Which pages
 * already have text that is drawn (born-digital pages: left as they are),
 * taking out an earlier OCR layer (invisible text, in the page or in the
 * form XObjects it draws — OCRmyPDF puts its layer in one), and laying
 * Tesseract's text-only page over the page as a form XObject (OCRmyPDF's
 * "sandwich": the text is Tesseract's own, with its glyphless font and
 * Unicode map). See FORK.md.
 */
import {
    PDFArray,
    PDFContentStream,
    PDFDict,
    PDFDocument,
    PDFName,
    PDFRawStream,
    PDFRef,
    PDFStream,
    concatTransformationMatrix,
    decodePDFRawStream,
    drawObject,
    popGraphicsState,
    pushGraphicsState,
} from "pdf-lib";

import { stripInvisibleText, summarizeText } from "utils/evo-pdf-content";

import type { PDFPage } from "pdf-lib";

/** A 2D transformation [a b c d e f], PDF's order. */
export type Matrix = [number, number, number, number, number, number];

/** Pages with at least this many drawn characters are not recognized again. */
export const VISIBLE_TEXT_LIMIT = 40;

/** How deep form XObjects inside form XObjects are followed. */
const FORM_DEPTH = 3;

/** `m1` then `m2`. */
export function compose(m1: Matrix, m2: Matrix): Matrix {
    const [a1, b1, c1, d1, e1, f1] = m1;
    const [a2, b2, c2, d2, e2, f2] = m2;
    return [
        a1 * a2 + b1 * c2,
        a1 * b2 + b1 * d2,
        c1 * a2 + d1 * c2,
        c1 * b2 + d1 * d2,
        e1 * a2 + f1 * c2 + e2,
        e1 * b2 + f1 * d2 + f2,
    ];
}

export function invert(m: Matrix): Matrix {
    const [a, b, c, d, e, f] = m;
    const det = a * d - b * c;
    if (!det) throw new Error("A matrix that cannot be inverted.");
    return [
        d / det,
        -b / det,
        -c / det,
        a / det,
        (c * f - d * e) / det,
        (b * e - a * f) / det,
    ];
}

function streamBytes(stream: PDFStream): Uint8Array {
    if (stream instanceof PDFRawStream)
        return decodePDFRawStream(stream).decode();
    if (stream instanceof PDFContentStream)
        return stream.getUnencodedContents();
    return stream.getContents();
}

/** The page's content streams, decoded and joined. */
function pageContent(doc: PDFDocument, page: PDFPage): Uint8Array {
    const contents = page.node.Contents();
    const streams: PDFStream[] = [];
    if (contents instanceof PDFStream) streams.push(contents);
    else if (contents instanceof PDFArray) {
        for (let i = 0; i < contents.size(); i++) {
            const s = doc.context.lookup(contents.get(i));
            if (s instanceof PDFStream) streams.push(s);
        }
    }
    const parts = streams.map(streamBytes);
    const total = parts.reduce((n, p) => n + p.length + 1, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
        out.set(p, at);
        out[at + p.length] = 10;
        at += p.length + 1;
    }
    return out;
}

/** The form XObjects a content stream with these resources draws, by name. */
function forms(
    doc: PDFDocument,
    resources: PDFDict | undefined,
): Map<string, { ref: PDFRef | null; stream: PDFStream }> {
    const out = new Map<string, { ref: PDFRef | null; stream: PDFStream }>();
    const xobjects = resources?.lookupMaybe(PDFName.of("XObject"), PDFDict);
    if (!xobjects) return out;
    for (const [key, value] of xobjects.entries()) {
        const stream = doc.context.lookup(value);
        if (!(stream instanceof PDFStream)) continue;
        const subtype = stream.dict.get(PDFName.of("Subtype"));
        if (!(subtype instanceof PDFName) || subtype.asString() !== "/Form")
            continue;
        out.set(key.asString().slice(1), {
            ref: value instanceof PDFRef ? value : null,
            stream,
        });
    }
    return out;
}

function pageResources(page: PDFPage): PDFDict | undefined {
    return page.node.Resources();
}

/** Characters a page draws and shows invisibly, its forms included. */
export function pageText(
    doc: PDFDocument,
    page: PDFPage,
): { visible: number; invisible: number } {
    const total = { visible: 0, invisible: 0 };
    const seen = new Set<PDFStream>();
    const visit = (
        bytes: Uint8Array,
        resources: PDFDict | undefined,
        mode: number,
        depth: number,
    ) => {
        const summary = summarizeText(bytes, mode);
        total.visible += summary.visible;
        total.invisible += summary.invisible;
        if (depth >= FORM_DEPTH) return;
        const named = forms(doc, resources);
        for (const call of summary.xobjects) {
            const form = named.get(call.name);
            if (!form || seen.has(form.stream)) continue;
            seen.add(form.stream);
            const own = form.stream.dict.lookupMaybe(
                PDFName.of("Resources"),
                PDFDict,
            );
            visit(
                streamBytes(form.stream),
                own ?? resources,
                call.mode,
                depth + 1,
            );
        }
    };
    visit(pageContent(doc, page), pageResources(page), 0, 0);
    return total;
}

/** A stream like `old` (its dictionary) with new, compressed contents. */
function restream(
    doc: PDFDocument,
    old: PDFStream,
    bytes: Uint8Array,
): PDFRawStream {
    const dict: Record<string, unknown> = {};
    for (const [key, value] of old.dict.entries()) {
        const k = key.asString().slice(1);
        if (k === "Length" || k === "Filter" || k === "DecodeParms") continue;
        dict[k] = value;
    }
    return doc.context.flateStream(bytes, dict as never);
}

/**
 * Take out the invisible text of a page and of the forms it draws.
 * Returns whether anything was taken out.
 */
export function removeInvisibleText(doc: PDFDocument, page: PDFPage): boolean {
    let changed = false;
    const seen = new Set<PDFStream>();
    const visitForms = (
        bytes: Uint8Array,
        resources: PDFDict | undefined,
        mode: number,
        depth: number,
    ) => {
        if (depth >= FORM_DEPTH) return;
        const named = forms(doc, resources);
        for (const call of summarizeText(bytes, mode).xobjects) {
            const form = named.get(call.name);
            if (!form || seen.has(form.stream)) continue;
            seen.add(form.stream);
            const own = form.stream.dict.lookupMaybe(
                PDFName.of("Resources"),
                PDFDict,
            );
            const formBytes = streamBytes(form.stream);
            visitForms(formBytes, own ?? resources, call.mode, depth + 1);
            const stripped = stripInvisibleText(formBytes, call.mode);
            if (stripped && form.ref) {
                doc.context.assign(
                    form.ref,
                    restream(doc, form.stream, stripped),
                );
                changed = true;
            }
        }
    };
    const content = pageContent(doc, page);
    visitForms(content, pageResources(page), 0, 0);
    const stripped = stripInvisibleText(content, 0);
    if (stripped) {
        const stream = doc.context.flateStream(stripped);
        page.node.set(PDFName.of("Contents"), doc.context.register(stream));
        changed = true;
    }
    return changed;
}

/**
 * Lay a text-only page (Tesseract's PDF output for this page's image) over
 * the page. `toUser` takes the image's pixels to the page's user space
 * (the renderer's viewport, inverted); `width`/`height` are the image's.
 * The page's own content is put in q/Q first, so a state it leaves behind
 * does not move the text.
 */
export async function overlayTextPage(
    doc: PDFDocument,
    page: PDFPage,
    textPdf: Uint8Array,
    image: { width: number; height: number; toUser: Matrix },
): Promise<void> {
    const [form] = await doc.embedPdf(textPdf, [0]);
    if (!form) throw new Error("Tesseract gave no page.");
    // Form space (points, y up, the text page's size) → image pixels (y down).
    const toPixels: Matrix = [
        image.width / form.width,
        0,
        0,
        -image.height / form.height,
        0,
        image.height,
    ];
    const m = compose(toPixels, image.toUser);
    const ctx = doc.context;
    const start = ctx.register(ctx.contentStream([pushGraphicsState()]));
    const end = ctx.register(ctx.contentStream([popGraphicsState()]));
    page.node.wrapContentStreams(start, end);
    const name = page.node.newXObject("OCR", form.ref);
    const ops = ctx.register(
        ctx.contentStream([
            pushGraphicsState(),
            concatTransformationMatrix(...m),
            drawObject(name),
            popGraphicsState(),
        ]),
    );
    page.node.addContentStream(ops);
}

/** Inherited attributes set on the page itself (resources above all). */
export function materializeResources(page: PDFPage) {
    const resources = page.node.Resources();
    if (resources) page.node.set(PDFName.of("Resources"), resources);
}
