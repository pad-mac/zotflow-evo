/**
 * ZotFlow Evo (fork): drawing PDF pages in grey with Obsidian's own pdf.js,
 * for OCR (evo-ocr.ts) and for measuring how tilted scans are (straighten,
 * evo-pdf-measure.ts). Main thread.
 */
import { loadPdfJs } from "obsidian";

import { invert } from "utils/evo-pdf-ocr-layer";

import type { Matrix } from "utils/evo-pdf-ocr-layer";

/** What is used of Obsidian's pdf.js. */
interface PdfJsLib {
    getDocument(o: { data: Uint8Array }): {
        promise: Promise<PdfJsDocument>;
        destroy?: () => Promise<void> | void;
    };
    AnnotationMode?: { DISABLE?: number };
}

interface PdfJsDocument {
    numPages: number;
    getPage(n: number): Promise<PdfJsPage>;
}

interface PdfJsPage {
    getViewport(o: { scale: number }): {
        width: number;
        height: number;
        transform: number[];
    };
    render(o: Record<string, unknown>): { promise: Promise<void> };
    cleanup(): void;
}

/** A page drawn in grey. */
export interface GrayPage {
    gray: Uint8Array;
    width: number;
    height: number;
    /** Points → pixels. */
    scale: number;
    /** Its pixels → the page's user space. */
    toUser: Matrix;
}

export interface OpenedPdf {
    count: number;
    /**
     * Draw a page (0-based) in grey: at `scale` (pixels per point), made
     * smaller where it would have more than `maxPixels` pixels or a side
     * longer than `maxSide`.
     */
    draw(
        index: number,
        o: { scale: number; maxPixels?: number; maxSide?: number },
    ): Promise<GrayPage>;
    close(): void;
}

export async function openPdf(bytes: Uint8Array): Promise<OpenedPdf> {
    const pdfjs = (await loadPdfJs()) as PdfJsLib;
    const task = pdfjs.getDocument({ data: bytes.slice() });
    const pdf = await task.promise;
    const disable = pdfjs.AnnotationMode?.DISABLE;
    return {
        count: pdf.numPages,
        async draw(index, { scale, maxPixels = Infinity, maxSide = Infinity }) {
            const page = await pdf.getPage(index + 1);
            const unit = page.getViewport({ scale: 1 });
            let s = scale;
            const area = unit.width * unit.height * s * s;
            if (area > maxPixels) s *= Math.sqrt(maxPixels / area);
            const side = Math.max(unit.width, unit.height) * s;
            if (side > maxSide) s *= maxSide / side;
            const viewport = page.getViewport({ scale: s });
            const width = Math.max(1, Math.floor(viewport.width));
            const height = Math.max(1, Math.floor(viewport.height));
            const canvas = createEl("canvas");
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            if (!ctx) throw new Error("No canvas to draw the page on.");
            ctx.fillStyle = "#fff";
            ctx.fillRect(0, 0, width, height);
            await page.render({
                canvasContext: ctx,
                canvas,
                viewport,
                ...(disable !== undefined ? { annotationMode: disable } : {}),
            }).promise;
            const rgba = ctx.getImageData(0, 0, width, height).data;
            canvas.width = 0;
            canvas.height = 0;
            page.cleanup();
            const gray = new Uint8Array(width * height);
            for (let i = 0, j = 0; j < gray.length; i += 4, j++)
                gray[j] =
                    (rgba[i]! * 299 + rgba[i + 1]! * 587 + rgba[i + 2]! * 114) /
                    1000;
            return {
                gray,
                width,
                height,
                scale: s,
                toUser: invert(viewport.transform as Matrix),
            };
        },
        close() {
            void Promise.resolve(task.destroy?.()).catch(() => undefined);
        },
    };
}
