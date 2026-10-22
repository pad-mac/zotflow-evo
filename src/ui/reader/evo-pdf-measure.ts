/**
 * ZotFlow Evo (fork): how tilted each page of a PDF is (straighten in the
 * editing menu), measured after the pages were split, so each half of a
 * spread gets its own angle. Pages are drawn at most 1600 px on their long
 * side; see utils/evo-deskew.ts for the method and its guard rails.
 */
import { openPdf } from "ui/reader/evo-pdf-render";
import { estimateSkew } from "utils/evo-deskew";

/** `{ pageIndex: degrees }` for the pages worth straightening. */
export async function measureSkew(
    bytes: Uint8Array,
    {
        onProgress,
        signal,
    }: {
        onProgress?: (done: number, total: number) => void;
        signal?: AbortSignal;
    } = {},
): Promise<Record<string, number>> {
    const pdf = await openPdf(bytes);
    const angles: Record<string, number> = {};
    try {
        for (let i = 0; i < pdf.count; i++) {
            if (signal?.aborted) break;
            const page = await pdf.draw(i, { scale: 3, maxSide: 1600 });
            const { angle } = estimateSkew(page.gray, page.width, page.height);
            if (angle !== null) angles[String(i)] = angle;
            onProgress?.(i + 1, pdf.count);
        }
    } finally {
        pdf.close();
    }
    return angles;
}
