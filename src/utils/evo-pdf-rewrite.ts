/**
 * ZotFlow Evo (fork): rewriting a PDF for the editing menu (pdf-lib), and
 * copying pages into a new one. What changes in the file:
 *
 * - straighten: the page's content turned around the centre of what is
 *   shown (one `cm` before it, nothing re-drawn, nothing stretched);
 * - split: the page keeps the left part (by narrowing what is shown of it)
 *   and a second page, sharing its content, shows the right part — the
 *   content is not copied, so a scan does not double the file. Page labels
 *   are removed (they would name the wrong pages);
 * - remove outline: the bookmarks;
 * - the page filter: written into the Info dictionary (PDF_INFO_FILTER_KEY,
 *   JSON in KOReader's units).
 *
 * Main thread, no Obsidian here. Returns what became of each page, for the
 * annotations (evo-pdf-geometry.ts).
 */
import {
    PDFDict,
    PDFDocument,
    PDFName,
    PDFPage,
    PDFString,
    concatTransformationMatrix,
    popGraphicsState,
    pushGraphicsState,
} from "pdf-lib";

import { PDF_INFO_FILTER_KEY } from "utils/evo-pdf-filter";
import { rotationMatrix, splitBoxes } from "utils/evo-pdf-geometry";

import type { PdfFilter } from "utils/evo-pdf-filter";
import type { Box, PagePlan } from "utils/evo-pdf-geometry";

export interface RewriteRequest {
    split?: { shared: number; pages: Record<string, number> };
    straighten?: Record<string, number>;
    removeOutline?: boolean;
    pageFilter?: PdfFilter;
}

export interface RewriteResult {
    bytes: Uint8Array;
    plans: PagePlan[];
    /** What was done, for the notice ("split 12 pages", …). */
    done: string[];
}

function visibleBox(page: PDFPage): Box {
    const b = page.getCropBox();
    return [b.x, b.y, b.x + b.width, b.y + b.height];
}

function setBoxes(page: PDFPage, box: Box) {
    const [x0, y0, x1, y1] = box;
    page.setMediaBox(x0, y0, x1 - x0, y1 - y0);
    page.setCropBox(x0, y0, x1 - x0, y1 - y0);
    for (const name of ["TrimBox", "BleedBox", "ArtBox"])
        page.node.delete(PDFName.of(name));
}

/** The document's Info dictionary, made if there is none. */
function infoDict(doc: PDFDocument): PDFDict {
    const ctx = doc.context;
    const existing = ctx.trailerInfo.Info
        ? ctx.lookupMaybe(ctx.trailerInfo.Info, PDFDict)
        : undefined;
    if (existing) return existing;
    const dict = ctx.obj({});
    ctx.trailerInfo.Info = ctx.register(dict);
    return dict;
}

/** Write the page filter into the PDF's Info dictionary. */
export function writeFilterInfo(doc: PDFDocument, filter: PdfFilter) {
    infoDict(doc).set(
        PDFName.of(PDF_INFO_FILTER_KEY),
        PDFString.of(JSON.stringify(filter)),
    );
}

/** Inherited attributes set on the page itself, so a copy of its dictionary stands alone. */
function materialize(page: PDFPage) {
    const resources = page.node.Resources();
    if (resources) page.node.set(PDFName.of("Resources"), resources);
    const media = page.getMediaBox();
    page.setMediaBox(media.x, media.y, media.width, media.height);
    page.setRotation(page.getRotation());
}

export async function rewritePdf(
    input: Uint8Array,
    request: RewriteRequest,
): Promise<RewriteResult> {
    const doc = await PDFDocument.load(input, { updateMetadata: false });
    const pages = doc.getPages();
    const count = pages.length;
    const plans: PagePlan[] = pages.map((_, i) => ({ newIndex: i }));
    const done: string[] = [];

    // Straighten first: the content of each tilted page turned level.
    let turned = 0;
    for (const [key, degrees] of Object.entries(request.straighten ?? {})) {
        const i = Number(key);
        const page = pages[i];
        if (!page || !Number.isFinite(degrees) || degrees === 0) continue;
        if (Math.abs(degrees) > 5) continue; // guard: never more than ±5°
        const [x0, y0, x1, y1] = visibleBox(page);
        const center: [number, number] = [(x0 + x1) / 2, (y0 + y1) / 2];
        const m = rotationMatrix(degrees, center[0], center[1]);
        const start = doc.context.register(
            doc.context.contentStream([
                pushGraphicsState(),
                concatTransformationMatrix(...m),
            ]),
        );
        const end = doc.context.register(
            doc.context.contentStream([popGraphicsState()]),
        );
        page.node.wrapContentStreams(start, end);
        plans[i]!.turn = { degrees, center };
        turned++;
    }
    if (turned)
        done.push(`straightened ${turned} ${turned === 1 ? "page" : "pages"}`);

    // Split: from the last page, so the indexes before stay put.
    if (request.split) {
        const { shared, pages: own } = request.split;
        for (let i = count - 1; i >= 0; i--) {
            const page = pages[i]!;
            const fraction = own[String(i)] ?? shared;
            const { left, right } = splitBoxes(
                visibleBox(page),
                page.getRotation().angle,
                fraction,
            );
            materialize(page);
            const leaf = page.node.clone();
            const ref = doc.context.register(leaf);
            const copy = PDFPage.of(leaf, ref, doc);
            doc.insertPage(i + 1, copy);
            setBoxes(page, left);
            setBoxes(copy, right);
            plans[i]!.split = { left, right };
        }
        let shift = 0;
        for (const plan of plans) {
            plan.newIndex += shift;
            if (plan.split) shift++;
        }
        doc.catalog.delete(PDFName.of("PageLabels"));
        done.push(`split ${count} ${count === 1 ? "page" : "pages"}`);
    }

    if (request.removeOutline && doc.catalog.has(PDFName.of("Outlines"))) {
        doc.catalog.delete(PDFName.of("Outlines"));
        const mode = doc.catalog.get(PDFName.of("PageMode"));
        if (mode instanceof PDFName && mode.asString() === "/UseOutlines")
            doc.catalog.set(PDFName.of("PageMode"), PDFName.of("UseNone"));
        done.push("removed the outline");
    } else if (request.removeOutline) {
        done.push("no outline to remove");
    }

    if (request.pageFilter) writeFilterInfo(doc, request.pageFilter);

    const bytes = await doc.save();
    return { bytes, plans, done };
}

/** Pages (0-based) of a PDF copied into a new one. */
export async function extractPages(
    input: Uint8Array,
    indexes: number[],
    { title, pageFilter }: { title?: string; pageFilter?: PdfFilter } = {},
): Promise<Uint8Array> {
    const src = await PDFDocument.load(input, { updateMetadata: false });
    const count = src.getPageCount();
    const wanted = [...new Set(indexes)]
        .filter((i) => Number.isInteger(i) && i >= 0 && i < count)
        .sort((a, b) => a - b);
    if (!wanted.length) throw new Error("No pages to extract.");
    const out = await PDFDocument.create();
    const copied = await out.copyPages(src, wanted);
    for (const page of copied) out.addPage(page);
    if (title) out.setTitle(title);
    if (pageFilter) writeFilterInfo(out, pageFilter);
    return out.save();
}

/** The pages of a PDF, for checks. */
export async function pdfPageCount(input: Uint8Array): Promise<number> {
    const doc = await PDFDocument.load(input, { updateMetadata: false });
    return doc.getPageCount();
}

/** Whether a PDF has an outline (bookmarks). */
export async function pdfHasOutline(input: Uint8Array): Promise<boolean> {
    const doc = await PDFDocument.load(input, { updateMetadata: false });
    const outlines = doc.catalog.lookupMaybe(PDFName.of("Outlines"), PDFDict);
    return !!outlines && !!outlines.get(PDFName.of("First"));
}
