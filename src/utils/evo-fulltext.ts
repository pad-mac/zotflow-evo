/**
 * ZotFlow Evo (fork): the rules of the full-text search — what is asked of
 * Zotero's full-text index (`fulltext.sqlite`, SQLite FTS5 with the
 * `unicode61` tokenizer), how a match is checked in the text Zotero
 * extracted (`.zotero-ft-cache`), and the snippets shown. No I/O here.
 * See FORK.md, "Full-text search".
 */

export interface FulltextSpec {
    query: string;
    matchCase: boolean;
    wholeWords: boolean;
}

/** Letters, digits and combining marks: what `unicode61` keeps as a word. */
const WORD = /[\p{L}\p{N}\p{M}]+/gu;
const WORD_CHAR = "[\\p{L}\\p{N}\\p{M}]";

/** The words of a query, as the index splits text into words. */
export function queryWords(query: string): string[] {
    return query.match(WORD) ?? [];
}

/**
 * The FTS5 expression that finds the candidate documents, or null when the
 * query has no words. The words as one phrase (in a row, whatever stands
 * between them); without "whole words" the last one may go on (a prefix).
 * The index ignores case and accents; the text is checked after.
 */
export function ftsQuery(spec: FulltextSpec): string | null {
    const words = queryWords(spec.query);
    if (!words.length) return null;
    const phrase = `"${words.map((w) => w.replace(/"/g, '""')).join(" ")}"`;
    return spec.wholeWords ? phrase : `${phrase}*`;
}

/** Text without case and accents, and where each of its characters came from. */
export function foldText(text: string): { folded: string; from: number[] } {
    const parts: string[] = [];
    const from: number[] = [];
    let i = 0;
    while (i < text.length) {
        const cp = text.codePointAt(i)!;
        const ch = String.fromCodePoint(cp);
        const f = ch.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
        parts.push(f);
        for (let k = 0; k < f.length; k++) from.push(i);
        i += ch.length;
    }
    from.push(text.length);
    return { folded: parts.join(""), from };
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A matcher for the query: its words in a row, separated by anything that is not a word. */
export function matcher(spec: FulltextSpec): RegExp | null {
    const words = queryWords(spec.query).map((w) =>
        spec.matchCase ? w : foldText(w).folded,
    );
    if (!words.length) return null;
    let body = words.map(escapeRegExp).join(`(?:(?!${WORD_CHAR})[\\s\\S])+`);
    if (spec.wholeWords) body = `(?<!${WORD_CHAR})${body}(?!${WORD_CHAR})`;
    return new RegExp(body, "gu");
}

/** Where the query is in `text`: start and end offsets, in order. */
export function findMatches(
    text: string,
    spec: FulltextSpec,
    limit = Infinity,
): { start: number; end: number }[] {
    const re = matcher(spec);
    if (!re) return [];
    const out: { start: number; end: number }[] = [];
    if (spec.matchCase) {
        for (const m of text.matchAll(re)) {
            out.push({ start: m.index, end: m.index + m[0].length });
            if (out.length >= limit) break;
        }
        return out;
    }
    const { folded, from } = foldText(text);
    for (const m of folded.matchAll(re)) {
        const start = from[m.index]!;
        const endIndex = m.index + m[0].length;
        // The end of the last original character matched.
        let end = from[endIndex]!;
        if (end === start) end = start + 1;
        out.push({ start, end });
        if (out.length >= limit) break;
    }
    return out;
}

/** A piece of a snippet: text, or the query found. */
export interface SnippetPart {
    text: string;
    hit: boolean;
}

export interface Snippet {
    parts: SnippetPart[];
    /** Offset of the first match in the text. */
    offset: number;
    /** Page (0-based) where the text has page breaks (form feeds), else null. */
    pageIndex: number | null;
}

const collapse = (s: string) => s.replace(/\s+/g, " ");

/**
 * Snippets around the matches: `context` characters before and after, cut
 * at a space, whitespace folded. Matches close together share a snippet.
 */
export function makeSnippets(
    text: string,
    matches: readonly { start: number; end: number }[],
    { context = 220, max = Infinity }: { context?: number; max?: number } = {},
): Snippet[] {
    const breaks: number[] = [];
    for (let i = text.indexOf("\f"); i >= 0; i = text.indexOf("\f", i + 1))
        breaks.push(i);
    const pageOf = (offset: number): number | null => {
        if (!breaks.length) return null;
        let lo = 0;
        let hi = breaks.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (breaks[mid]! < offset) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };
    const out: Snippet[] = [];
    let i = 0;
    while (i < matches.length && out.length < max) {
        const group = [matches[i]!];
        while (
            i + 1 < matches.length &&
            matches[i + 1]!.start - group[group.length - 1]!.end < context
        ) {
            group.push(matches[++i]!);
        }
        i++;
        const first = group[0]!;
        const last = group[group.length - 1]!;
        let from = Math.max(0, first.start - context);
        let to = Math.min(text.length, last.end + context);
        if (from > 0) {
            const space = text.slice(from, first.start).search(/\s/);
            if (space >= 0) from += space + 1;
        }
        if (to < text.length) {
            const tail = text.slice(last.end, to);
            const space = Math.max(
                tail.lastIndexOf(" "),
                tail.lastIndexOf("\n"),
            );
            if (space >= 0) to = last.end + space;
        }
        const parts: SnippetPart[] = [];
        let at = from;
        for (const m of group) {
            if (m.start > at)
                parts.push({
                    text: collapse(text.slice(at, m.start)),
                    hit: false,
                });
            parts.push({
                text: collapse(text.slice(m.start, m.end)),
                hit: true,
            });
            at = m.end;
        }
        if (to > at)
            parts.push({ text: collapse(text.slice(at, to)), hit: false });
        if (parts[0] && !parts[0].hit)
            parts[0].text = (from > 0 ? "…" : "") + parts[0].text.trimStart();
        const tail = parts[parts.length - 1];
        if (tail && !tail.hit)
            tail.text = tail.text.trimEnd() + (to < text.length ? "…" : "");
        out.push({
            parts,
            offset: first.start,
            pageIndex: pageOf(first.start),
        });
    }
    return out;
}

/* ------------------------------------------------------------------ */
/*  Results                                                           */
/* ------------------------------------------------------------------ */

/** A document found, as the search view lists it. */
export interface FulltextHit {
    /** Zotero's local id of the attachment (the index's row). */
    itemID: number;
    /** ZotFlow's library id. */
    libraryID: number;
    attachmentKey: string;
    /** The item it belongs to (itself for a file without a parent). */
    itemKey: string;
    contentType: string;
    /** FTS5 rank: lower is better. */
    rank: number;
}

/** What the view knows of an item, to order, group and label. */
export interface FulltextItem {
    title: string;
    shortTitle: string;
    lastName: string;
    year: string;
    dateAdded: string;
    tags: readonly string[];
}

export type FulltextGroupBy = "item" | "tag" | "none";
export type FulltextOrder = "relevance" | "title" | "dateAdded" | "year";

export interface FulltextLayout {
    groupBy: FulltextGroupBy;
    order: FulltextOrder;
    descending: boolean;
}

export const DEFAULT_FULLTEXT_LAYOUT: FulltextLayout = {
    groupBy: "item",
    order: "relevance",
    descending: false,
};

const collator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
});

/** "Schmidgen - 2005 - Lebendige Kräfte": an item named beside a snippet. */
export function hitLabel(item: FulltextItem | undefined): string {
    if (!item) return "";
    const title = (item.shortTitle || item.title).replace(/<[^>]+>/g, "");
    return [item.lastName, item.year, title].filter(Boolean).join(" - ");
}

/** Hits in the order of `layout` (several attachments of an item stay together). */
export function orderHits(
    hits: readonly FulltextHit[],
    items: ReadonlyMap<string, FulltextItem>,
    layout: FulltextLayout,
): FulltextHit[] {
    const key = (h: FulltextHit) => `${h.libraryID}:${h.itemKey}`;
    // An item ranks by its best attachment.
    const best = new Map<string, number>();
    for (const h of hits) {
        const k = key(h);
        best.set(k, Math.min(best.get(k) ?? Infinity, h.rank));
    }
    const sign = layout.descending ? -1 : 1;
    const compareItems = (a: FulltextHit, b: FulltextHit): number => {
        const ia = items.get(key(a));
        const ib = items.get(key(b));
        let c = 0;
        if (layout.order === "relevance")
            c = best.get(key(a))! - best.get(key(b))!;
        else if (layout.order === "dateAdded")
            c = (ia?.dateAdded ?? "").localeCompare(ib?.dateAdded ?? "");
        else if (layout.order === "year")
            c = collator.compare(ia?.year ?? "", ib?.year ?? "");
        // Ties, and the "title" order: by title.
        if (!c) c = collator.compare(ia?.title ?? "", ib?.title ?? "");
        return c * sign || key(a).localeCompare(key(b));
    };
    return [...hits].sort((a, b) => compareItems(a, b) || a.rank - b.rank);
}

export interface FulltextGroup {
    id: string;
    /** An item's title, or a tag. */
    label: string;
    /** Under an item heading: creator and year. */
    detail?: string;
    /** Under a heading that is not the item: each hit names its item. */
    showsItem: boolean;
    hits: FulltextHit[];
}

/** The headings of the result list: per item, per tag, or one list. */
export function groupHits(
    ordered: readonly FulltextHit[],
    items: ReadonlyMap<string, FulltextItem>,
    groupBy: FulltextGroupBy,
): FulltextGroup[] {
    if (groupBy === "none")
        return [{ id: "all", label: "", showsItem: true, hits: [...ordered] }];
    const groups = new Map<string, FulltextGroup>();
    const add = (
        id: string,
        make: () => Omit<FulltextGroup, "hits">,
        hit: FulltextHit,
    ) => {
        let g = groups.get(id);
        if (!g) {
            g = { ...make(), hits: [] };
            groups.set(id, g);
        }
        g.hits.push(hit);
    };
    for (const hit of ordered) {
        const k = `${hit.libraryID}:${hit.itemKey}`;
        const item = items.get(k);
        if (groupBy === "item") {
            add(
                "item:" + k,
                () => ({
                    id: "item:" + k,
                    label: item?.title || "Untitled",
                    detail: [item?.lastName, item?.year]
                        .filter(Boolean)
                        .join(" "),
                    showsItem: false,
                }),
                hit,
            );
        } else {
            const tags = item?.tags.length ? item.tags : [""];
            for (const tag of tags)
                add(
                    "tag:" + tag,
                    () => ({
                        id: "tag:" + tag,
                        label: tag || "No tag",
                        showsItem: true,
                    }),
                    hit,
                );
        }
    }
    const out = [...groups.values()];
    if (groupBy === "tag")
        out.sort((a, b) =>
            a.id === "tag:"
                ? 1
                : b.id === "tag:"
                  ? -1
                  : collator.compare(a.label, b.label),
        );
    return out;
}
