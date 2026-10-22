/**
 * ZotFlow Evo (fork): a PDF's outline among its annotations, for the item
 * pane (its outline button). A heading goes before the first annotation at
 * or below where it points (its page, and on the page its height when the
 * outline gives one). Only headings with annotations in their part are
 * shown — the part runs to the next heading of the same or a higher level —
 * so the list stays the annotations, ordered under their chapters.
 */

/** One outline entry and where it points. */
export interface OutlineHeading {
    title: string;
    /** 0: top level. */
    level: number;
    /** The page (0-based). */
    page: number;
    /** Its height on the page in PDF points (from the bottom), when the outline gives it. */
    top: number | null;
}

/** Where an annotation is, the same way. */
export interface Placement {
    page: number;
    top: number | null;
}

export type OutlineListEntry<T> =
    | { kind: "heading"; heading: OutlineHeading }
    | { kind: "annotation"; annotation: T };

/** Before (negative) or after: by page, then from the top of the page down. */
function compare(a: Placement, b: Placement): number {
    if (a.page !== b.page) return a.page - b.page;
    const ta = a.top ?? Infinity;
    const tb = b.top ?? Infinity;
    return tb - ta;
}

/**
 * Where a PDF annotation is: its page and the top of its first rect. Null
 * for one without a PDF position (an EPUB's, a snapshot's).
 */
export function placementOf(position: unknown): Placement | null {
    const p = position as
        | { pageIndex?: unknown; rects?: unknown; paths?: unknown }
        | null
        | undefined;
    if (!p || typeof p.pageIndex !== "number") return null;
    let top: number | null = null;
    const rects = Array.isArray(p.rects) ? (p.rects as unknown[]) : [];
    const first = rects[0];
    if (Array.isArray(first) && typeof first[3] === "number") {
        top = Math.max(first[1] as number, first[3]);
    } else if (Array.isArray(p.paths) && Array.isArray(p.paths[0])) {
        const ys = (p.paths[0] as number[]).filter((_, i) => i % 2 === 1);
        if (ys.length) top = Math.max(...ys);
    }
    return { page: p.pageIndex, top };
}

/**
 * The annotations (in their order) with the headings between them; the
 * annotations without a place keep theirs and take no heading.
 */
export function interleaveOutline<T>(
    annotations: T[],
    headings: OutlineHeading[],
    placeOf: (a: T) => Placement | null,
): OutlineListEntry<T>[] {
    // In the order of the pages (an outline may jump back), stable.
    const sorted = headings
        .map((heading, i) => ({ heading, i }))
        .sort((a, b) => compare(a.heading, b.heading) || a.i - b.i)
        .map((x) => x.heading);
    // Each annotation's heading index (the last at or before it).
    const out: OutlineListEntry<T>[] = [];
    const used = new Set<number>();
    const placed: { index: number; entry: OutlineListEntry<T> }[] = [];
    let next = 0;
    for (const annotation of annotations) {
        const place = placeOf(annotation);
        if (place) {
            while (next < sorted.length && compare(sorted[next]!, place) <= 0) {
                placed.push({ index: next, entry: { kind: "heading", heading: sorted[next]! } });
                next++;
            }
            if (next > 0) used.add(next - 1);
        }
        placed.push({ index: -1, entry: { kind: "annotation", annotation } });
    }
    // A heading is shown when its part has annotations: itself, or a
    // heading after it, before one of its level or higher, has.
    const shown = new Set<number>();
    for (const u of used) {
        shown.add(u);
        let level = sorted[u]!.level;
        for (let j = u - 1; j >= 0 && level > 0; j--) {
            if (sorted[j]!.level < level) {
                shown.add(j);
                level = sorted[j]!.level;
            }
        }
    }
    for (const { index, entry } of placed) {
        if (entry.kind === "annotation" || shown.has(index)) out.push(entry);
    }
    return out;
}
