/**
 * ZotFlow Evo (fork): the geometry of the PDF editing tools — where a page
 * is cut in two, how it is turned level — and what that does to the places
 * of its annotations. Pure: shared by the PDF rewrite (pdf-edit.ts) and the
 * annotation update (worker). Coordinates are PDF user space (y up).
 */

/** A rectangle [x0, y0, x1, y1] (x0 < x1, y0 < y1). */
export type Box = [number, number, number, number];

/** The page rotation (/Rotate), normalized to 0, 90, 180 or 270. */
export function normalizeRotation(rotation: number): 0 | 90 | 180 | 270 {
    const r = (((Math.round(rotation / 90) * 90) % 360) + 360) % 360;
    return r as 0 | 90 | 180 | 270;
}

/**
 * Where a page is cut in two, from a fraction of its width as shown: the
 * part shown on the left and the part shown on the right, in user space.
 */
export function splitBoxes(
    visible: Box,
    rotation: number,
    fraction: number,
): { left: Box; right: Box } {
    const [x0, y0, x1, y1] = visible;
    const s = Math.min(0.95, Math.max(0.05, fraction));
    switch (normalizeRotation(rotation)) {
        case 90: {
            // Shown turned clockwise: user y runs left to right.
            const yc = y0 + s * (y1 - y0);
            return { left: [x0, y0, x1, yc], right: [x0, yc, x1, y1] };
        }
        case 180: {
            const xc = x1 - s * (x1 - x0);
            return { left: [xc, y0, x1, y1], right: [x0, y0, xc, y1] };
        }
        case 270: {
            const yc = y1 - s * (y1 - y0);
            return { left: [x0, yc, x1, y1], right: [x0, y0, x1, yc] };
        }
        default: {
            const xc = x0 + s * (x1 - x0);
            return { left: [x0, y0, xc, y1], right: [xc, y0, x1, y1] };
        }
    }
}

/** Whether a point lies in a box (the cut line counts to the right part). */
export function inBox(box: Box, x: number, y: number): boolean {
    return x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3];
}

/**
 * The transformation (PDF `cm` operands) that turns a page's content by
 * `degrees` counter-clockwise around (cx, cy). A line that goes down to the
 * right by α as seen is made level by α (whatever the page's /Rotate:
 * rotations commute).
 */
export function rotationMatrix(
    degrees: number,
    cx: number,
    cy: number,
): [number, number, number, number, number, number] {
    const a = (degrees * Math.PI) / 180;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    return [
        cos,
        sin,
        -sin,
        cos,
        cx - cx * cos + cy * sin,
        cy - cx * sin - cy * cos,
    ];
}

export function applyMatrix(
    m: [number, number, number, number, number, number],
    x: number,
    y: number,
): [number, number] {
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/* ------------------------------------------------------------------ */
/*  What a rewrite did to the pages                                   */
/* ------------------------------------------------------------------ */

/** One page of the original file and what became of it. */
export interface PagePlan {
    /** Turned level by this many degrees, around `center`. */
    turn?: { degrees: number; center: [number, number] };
    /** Cut in two: the boxes (user space) of the two new pages. */
    split?: { left: Box; right: Box };
    /** Its index in the new file (the left part's, when cut). */
    newIndex: number;
}

/** A Zotero PDF annotation position. */
export interface PdfPosition {
    pageIndex: number;
    rects?: number[][];
    paths?: number[][];
    nextPageRects?: number[][];
    [key: string]: unknown;
}

function centerOf(position: PdfPosition): [number, number] | null {
    const r = position.rects?.[0];
    if (r && r.length >= 4) return [(r[0]! + r[2]!) / 2, (r[1]! + r[3]!) / 2];
    const p = position.paths?.[0];
    if (p && p.length >= 2) {
        let sx = 0;
        let sy = 0;
        let n = 0;
        for (let i = 0; i + 1 < p.length; i += 2) {
            sx += p[i]!;
            sy += p[i + 1]!;
            n++;
        }
        return [sx / n, sy / n];
    }
    return null;
}

/**
 * Where an annotation is after the rewrite: its page in the new file and
 * its points turned with the page; null when it is not on a page the plan
 * knows (left as it is).
 */
export function remapPosition(
    position: PdfPosition,
    plans: readonly PagePlan[],
): PdfPosition | null {
    const plan = plans[position.pageIndex];
    if (!plan) return null;
    const out: PdfPosition = structuredClone(position);
    if (plan.turn) {
        const m = rotationMatrix(
            plan.turn.degrees,
            plan.turn.center[0],
            plan.turn.center[1],
        );
        const turnRect = (r: number[]) => {
            const pts = [
                applyMatrix(m, r[0]!, r[1]!),
                applyMatrix(m, r[2]!, r[1]!),
                applyMatrix(m, r[0]!, r[3]!),
                applyMatrix(m, r[2]!, r[3]!),
            ];
            const xs = pts.map((p) => p[0]);
            const ys = pts.map((p) => p[1]);
            const round = (v: number) => Math.round(v * 1000) / 1000;
            return [
                round(Math.min(...xs)),
                round(Math.min(...ys)),
                round(Math.max(...xs)),
                round(Math.max(...ys)),
            ];
        };
        if (out.rects) out.rects = out.rects.map(turnRect);
        if (out.nextPageRects) out.nextPageRects = undefined;
        if (out.paths)
            out.paths = out.paths.map((path) => {
                const next: number[] = [];
                for (let i = 0; i + 1 < path.length; i += 2) {
                    const [x, y] = applyMatrix(m, path[i]!, path[i + 1]!);
                    next.push(
                        Math.round(x * 1000) / 1000,
                        Math.round(y * 1000) / 1000,
                    );
                }
                return next;
            });
    }
    out.pageIndex = plan.newIndex;
    if (plan.split) {
        const c = centerOf(out);
        if (c && !inBox(plan.split.left, c[0], c[1]))
            out.pageIndex = plan.newIndex + 1;
    }
    if (out.nextPageRects === undefined) delete out.nextPageRects;
    return out;
}

/** A Zotero PDF sort index ("PPPPP|OOOOOO|TTTTT") on another page. */
export function sortIndexOnPage(sortIndex: string, pageIndex: number): string {
    const parts = String(sortIndex || "").split("|");
    if (parts.length !== 3) return sortIndex;
    parts[0] = String(pageIndex).padStart(5, "0");
    return parts.join("|");
}
