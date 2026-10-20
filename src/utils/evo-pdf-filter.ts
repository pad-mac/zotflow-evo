/**
 * ZotFlow Evo (fork): the page filter for PDFs, set in the note strip's head
 * (the reader applies it before its theme; see FORK.md), kept per PDF. The
 * units are KOReader's, so the values can be written into the PDF and read
 * by other readers as they are:
 *
 * - contrast: a gamma, 0.8 … 50 (1 = as it is; above 1 darker);
 * - whiteThreshold: 16 … 255 (255 = off): grey values at or above it white;
 * - saturation: 0 … 2 (1 = as it is).
 *
 * Must match `src/evo/page-filter.mjs` in the reader.
 */
export interface PdfFilter {
    contrast: number;
    whiteThreshold: number;
    saturation: number;
}

export const NEUTRAL_PDF_FILTER: PdfFilter = {
    contrast: 1,
    whiteThreshold: 255,
    saturation: 1,
};

/** The key in a PDF's Info dictionary that holds the filter (as JSON). */
export const PDF_INFO_FILTER_KEY = "ZotFlowEvoPageFilter";

const clamp = (n: unknown, lo: number, hi: number, fallback: number) =>
    typeof n === "number" && Number.isFinite(n)
        ? Math.max(lo, Math.min(hi, n))
        : fallback;

/** Values within range, missing ones neutral; null for something that is no filter. */
export function sanitizePdfFilter(value: unknown): PdfFilter | null {
    if (!value || typeof value !== "object") return null;
    const v = value as Partial<PdfFilter>;
    let white = v.whiteThreshold;
    // Until beta.9 the threshold was a fraction of another curve.
    if (typeof white === "number" && white < 1) white = 255;
    return {
        contrast: Math.round(clamp(v.contrast, 0.8, 50, 1) * 100) / 100,
        whiteThreshold: Math.round(clamp(white, 16, 255, 255)),
        saturation: Math.round(clamp(v.saturation, 0, 2, 1) * 100) / 100,
    };
}

export function isNeutralPdfFilter(value: unknown): boolean {
    const f = sanitizePdfFilter(value);
    return (
        !f ||
        (f.contrast === 1 && f.whiteThreshold === 255 && f.saturation === 1)
    );
}

/** How a PDF is named in `readerPdfFilters`: a Zotero attachment, or a file in the vault. */
export function pdfFilterKey(
    target: { libraryID: number; key: string } | { path: string },
): string {
    return "path" in target
        ? `vault:${target.path}`
        : `${target.libraryID}:${target.key}`;
}
