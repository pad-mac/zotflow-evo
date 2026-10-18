/**
 * ZotFlow Evo (fork): the colour filter over PDF pages, set in the note
 * strip's head (the reader applies it; see FORK.md). Neutral values change
 * nothing.
 */
export interface PdfFilter {
    /** 0 … 0.5: everything this close to white becomes white (a white point). */
    whiteThreshold: number;
    /** 0.5 … 3: darkens (above 1) or lightens text, white and black stay (a gamma). */
    contrast: number;
    /** 0 … 2: 0 grey, 1 as it is. */
    saturation: number;
}

export const DEFAULT_PDF_FILTER: PdfFilter = {
    whiteThreshold: 0,
    contrast: 1,
    saturation: 1,
};

/** Values within range, missing ones neutral. */
export function sanitizePdfFilter(value: Partial<PdfFilter> | undefined): PdfFilter {
    const clamp = (n: unknown, lo: number, hi: number, fallback: number) =>
        typeof n === "number" && Number.isFinite(n)
            ? Math.max(lo, Math.min(hi, n))
            : fallback;
    return {
        whiteThreshold: clamp(value?.whiteThreshold, 0, 0.5, 0),
        contrast: clamp(value?.contrast, 0.5, 3, 1),
        saturation: clamp(value?.saturation, 0, 2, 1),
    };
}
