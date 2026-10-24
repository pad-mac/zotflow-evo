/**
 * ZotFlow Evo (fork): a PDF's outline among its annotations, for the item
 * pane (its outline button). A heading goes before the first annotation at
 * or below where it points (its page, and on the page its height when the
 * outline gives one). Only headings with annotations in their part are
 * shown — the part runs to the next heading of the same or a higher level —
 * so the list stays the annotations, ordered under their chapters — or,
 * with `all` (the item pane), every heading, those without annotations
 * and those after the last one too.
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
    /** The page's label as the PDF shows it ("iv", "245"), if it has labels. */
    label?: string;
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
    opts: { all?: boolean } = {},
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
    if (opts.all) {
        for (; next < sorted.length; next++)
            placed.push({ index: next, entry: { kind: "heading", heading: sorted[next]! } });
        return placed.map((p) => p.entry);
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

/** An entry as listed with folded headings: a heading's number among the headings, and whether it has a part to fold. */
export interface ShownOutlineEntry<T> {
    entry: OutlineListEntry<T>;
    /** The heading's number (in order); -1 for an annotation. */
    heading: number;
    /** A heading with something in its part (annotations, deeper headings). */
    foldable: boolean;
    folded: boolean;
}

/**
 * The entries with the parts of folded headings left out; a part runs to
 * the next heading of the same or a higher level. `folded` holds heading
 * numbers (see ShownOutlineEntry).
 */
export function foldOutline<T>(
    entries: OutlineListEntry<T>[],
    folded: ReadonlySet<number>,
): ShownOutlineEntry<T>[] {
    const out: ShownOutlineEntry<T>[] = [];
    let number = 0;
    let hideBelow: number | null = null;
    entries.forEach((entry, i) => {
        if (entry.kind === "heading") {
            const n = number++;
            const level = entry.heading.level;
            if (hideBelow !== null && level <= hideBelow) hideBelow = null;
            if (hideBelow !== null) return;
            const next = entries[i + 1];
            const foldable =
                !!next &&
                (next.kind === "annotation" || next.heading.level > level);
            const isFolded = foldable && folded.has(n);
            out.push({ entry, heading: n, foldable, folded: isFolded });
            if (isFolded) hideBelow = level;
            return;
        }
        if (hideBelow !== null) return;
        out.push({ entry, heading: -1, foldable: false, folded: false });
    });
    return out;
}

/** The numbers of the headings that have a part to fold (to fold them all). */
export function foldableHeadings<T>(entries: OutlineListEntry<T>[]): Set<number> {
    return new Set(
        foldOutline(entries, new Set())
            .filter((e) => e.foldable)
            .map((e) => e.heading),
    );
}
