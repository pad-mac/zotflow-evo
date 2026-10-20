/**
 * ZotFlow Evo (fork): the rules of the library browser and the annotation
 * browser, without any UI or database: which attachment an item opens,
 * what a table column shows and how it sorts, how annotations are grouped.
 * Used by the worker (`worker/services/evo-library.ts`) and the views
 * (`ui/evo-library/`). See FORK.md.
 */
import { extractYear } from "utils/date";
import { itemTypeLabel } from "types/zotero-item-type-labels";

/* ------------------------------------------------------------------ */
/*  Attachments                                                       */
/* ------------------------------------------------------------------ */

/**
 * What an attachment is, as far as opening it goes. "linked": a file that
 * lives outside Zotero's storage (a linked file), which ZotFlow does not
 * open; "link": a link to a web page.
 */
export type AttachmentKind =
    "pdf" | "epub" | "snapshot" | "linked" | "link" | "other";

/** The fields of an attachment's data this module reads. */
export interface AttachmentFacts {
    contentType?: string;
    linkMode?: string;
}

export function attachmentKind(data: AttachmentFacts): AttachmentKind {
    // A link to a web page (Google Books, say) is never something to open.
    if (data.linkMode === "linked_url") return "link";
    // Nor, for now, a file outside Zotero's storage.
    if (data.linkMode === "linked_file") return "linked";
    switch (data.contentType) {
        case "application/pdf":
            return "pdf";
        case "application/epub+zip":
            return "epub";
        case "text/html":
            return "snapshot";
        default:
            return "other";
    }
}

/** Kinds the reader opens, best first. */
const OPENABLE: readonly AttachmentKind[] = ["pdf", "epub", "snapshot"];

/**
 * Which attachment a double click opens: a PDF before an EPUB before a web
 * snapshot; links and other files never count. With one of the best kind
 * present, that one (`primary`). With several of the best kind (two PDFs;
 * two EPUBs and no PDF; two snapshots and neither), the user picks among
 * those (`choices`). With nothing openable, neither.
 */
export function choosePrimaryAttachment<T>(
    attachments: readonly T[],
    kindOf: (attachment: T) => AttachmentKind,
): { primary: T | null; choices: T[] } {
    for (const kind of OPENABLE) {
        const ofKind = attachments.filter((a) => kindOf(a) === kind);
        if (ofKind.length === 1) return { primary: ofKind[0]!, choices: [] };
        if (ofKind.length > 1) return { primary: null, choices: ofKind };
    }
    return { primary: null, choices: [] };
}

/** Kinds shown in the attachment column, best first. */
const SHOWN: readonly AttachmentKind[] = [...OPENABLE, "linked"];

/**
 * The best kind an item has, for the indicator in the table: what it
 * opens, else a linked file (marked, not opened), else nothing.
 */
export function bestKind(
    kinds: readonly AttachmentKind[],
): AttachmentKind | null {
    for (const kind of SHOWN) if (kinds.includes(kind)) return kind;
    return null;
}

/* ------------------------------------------------------------------ */
/*  Titles                                                            */
/* ------------------------------------------------------------------ */

/** A run of a title: plain or italic. */
export interface TitleRun {
    text: string;
    italic: boolean;
}

const TAG = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;

/**
 * A title as Zotero stores it, which may carry rich-text markup
 * (`<i>…</i>`, `<b>`, `<sup>`, `<span class="nocase">`): italic is kept,
 * every other tag dropped.
 */
export function titleRuns(raw: string): TitleRun[] {
    const runs: TitleRun[] = [];
    let depth = 0;
    let last = 0;
    const push = (text: string) => {
        if (!text) return;
        const italic = depth > 0;
        const prev = runs[runs.length - 1];
        if (prev && prev.italic === italic) prev.text += text;
        else runs.push({ text, italic });
    };
    for (const m of raw.matchAll(TAG)) {
        push(raw.slice(last, m.index));
        last = (m.index ?? 0) + m[0].length;
        const name = m[1]!.toLowerCase();
        if (name !== "i" && name !== "em") continue;
        if (m[0].startsWith("</")) depth = Math.max(0, depth - 1);
        else depth++;
    }
    push(raw.slice(last));
    return runs;
}

/** A title without any markup. */
export function plainTitle(raw: string): string {
    return raw.replace(TAG, "");
}

/* ------------------------------------------------------------------ */
/*  Names                                                             */
/* ------------------------------------------------------------------ */

export interface CreatorFacts {
    creatorType?: string;
    firstName?: string;
    lastName?: string;
    name?: string;
}

/** "Henning Schmidgen", or a one-field name as it is. */
export function fullName(c: CreatorFacts): string {
    if (c.name) return c.name.trim();
    return `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim();
}

/** "Schmidgen", or a one-field name as it is. */
export function lastName(c: CreatorFacts): string {
    return (c.lastName || c.name || c.firstName || "").trim();
}

/**
 * The item's main creators: its authors, or — without any — the creators
 * of the first role it has (editors of an edited volume, say).
 */
export function mainCreators(
    creators: readonly CreatorFacts[],
): CreatorFacts[] {
    const authors = creators.filter((c) => c.creatorType === "author");
    if (authors.length) return authors;
    const first = creators[0]?.creatorType;
    return creators.filter((c) => c.creatorType === first);
}

/** "Schmidgen", "Schmidgen and Siegert", "Schmidgen et al." — as Zotero's creator column. */
export function creatorSummary(creators: readonly CreatorFacts[]): string {
    const main = mainCreators(creators);
    if (main.length === 0) return "";
    if (main.length === 1) return lastName(main[0]!);
    if (main.length === 2)
        return `${lastName(main[0]!)} and ${lastName(main[1]!)}`;
    return `${lastName(main[0]!)} et al.`;
}

/** The year in a date ("2005-03-01", "March 2005"), or "". */
export function yearOf(date: string | undefined): string {
    return extractYear(date);
}

/* ------------------------------------------------------------------ */
/*  Table rows and columns                                            */
/* ------------------------------------------------------------------ */

/** One row of the library table: a top-level item. */
export interface EvoItemRow {
    libraryID: number;
    key: string;
    itemType: string;
    title: string;
    /** Zotero's short title, if set. */
    shortTitle?: string;
    /** As Zotero's creator column. */
    creator: string;
    /** Last name of the first main creator, for sorting. */
    creatorSort: string;
    /** Full name of the first main creator. */
    firstCreator: string;
    /** Last name of the first main creator. */
    firstLastName?: string;
    year: string;
    date: string;
    publication: string;
    publisher: string;
    dateAdded: string;
    dateModified: string;
    citationKey: string;
    /** The best kind of attachment it has (PDF, EPUB, snapshot), or null. */
    attachment: AttachmentKind | null;
    attachmentCount: number;
    annotationCount: number;
    tags: string[];
}

export type ColumnId =
    | "title"
    | "creator"
    | "year"
    | "itemType"
    | "publication"
    | "publisher"
    | "dateAdded"
    | "dateModified"
    | "citationKey"
    | "attachment"
    | "annotations";

export interface ColumnDef {
    id: ColumnId;
    label: string;
    /** Width in pixels until the user changes it. */
    width: number;
    /** Narrow columns show an icon or a number, centred. */
    narrow?: boolean;
}

export const COLUMNS: readonly ColumnDef[] = [
    { id: "title", label: "Title", width: 320 },
    { id: "creator", label: "Creator", width: 160 },
    { id: "year", label: "Year", width: 56, narrow: true },
    { id: "itemType", label: "Item type", width: 120 },
    { id: "publication", label: "Publication", width: 180 },
    { id: "publisher", label: "Publisher", width: 140 },
    { id: "dateAdded", label: "Date added", width: 106 },
    { id: "dateModified", label: "Date modified", width: 106 },
    { id: "citationKey", label: "Citation key", width: 130 },
    { id: "attachment", label: "Attachment", width: 34, narrow: true },
    { id: "annotations", label: "Annotations", width: 44, narrow: true },
];

export const DEFAULT_LIBRARY_COLUMNS: ColumnId[] = [
    "title",
    "creator",
    "year",
    "dateAdded",
    "attachment",
    "annotations",
];
export const DEFAULT_COLLECTION_COLUMNS: ColumnId[] = [
    "title",
    "creator",
    "year",
    "attachment",
    "annotations",
];

export function columnDef(id: ColumnId): ColumnDef {
    return COLUMNS.find((c) => c.id === id) ?? COLUMNS[0]!;
}

/** Known column ids from a stored list, in order, without repeats; the title is always shown. */
/** Narrowest a column can be dragged, in pixels. */
const MIN_COLUMN = 30;

export function widthOf(
    column: ColumnId,
    widths: Record<string, number>,
): number {
    return Math.max(MIN_COLUMN, widths[column] ?? columnDef(column).width);
}

/**
 * What dragging the right border of `column` by `delta` pixels changes.
 * The title column is flexible (it takes what the others leave), so its
 * own width cannot be set: dragging its border moves the border between it
 * and the next column, which gets narrower or wider instead. Any other
 * column gets wider or narrower itself, and the title gives or takes the
 * difference.
 */
export function resizeColumns(
    columns: readonly ColumnId[],
    widths: Record<string, number>,
    column: ColumnId,
    delta: number,
): Partial<Record<ColumnId, number>> {
    if (column !== "title") {
        return {
            [column]: Math.max(
                MIN_COLUMN,
                Math.round(widthOf(column, widths) + delta),
            ),
        };
    }
    const next = columns[columns.indexOf(column) + 1];
    if (!next) return {};
    return {
        [next]: Math.max(MIN_COLUMN, Math.round(widthOf(next, widths) - delta)),
    };
}

export function sanitizeColumns(
    stored: readonly string[] | undefined,
    fallback: readonly ColumnId[],
): ColumnId[] {
    const known = new Set<string>(COLUMNS.map((c) => c.id));
    const out: ColumnId[] = [];
    for (const id of stored ?? fallback) {
        if (known.has(id) && !out.includes(id as ColumnId))
            out.push(id as ColumnId);
    }
    if (!out.includes("title")) out.unshift("title");
    return out;
}

/** An ISO date as the table shows it: "2026-10-14". */
export function shortDate(iso: string): string {
    return iso ? iso.slice(0, 10) : "";
}

/** What a cell shows, as text (the attachment column draws an icon instead). */
export function cellText(row: EvoItemRow, column: ColumnId): string {
    switch (column) {
        case "title":
            return plainTitle(row.title);
        case "creator":
            return row.creator;
        case "year":
            return row.year;
        case "itemType":
            return itemTypeLabel(row.itemType);
        case "publication":
            return row.publication;
        case "publisher":
            return row.publisher;
        case "dateAdded":
            return shortDate(row.dateAdded);
        case "dateModified":
            return shortDate(row.dateModified);
        case "citationKey":
            return row.citationKey;
        case "attachment":
            return row.attachment ?? "";
        case "annotations":
            return row.annotationCount ? String(row.annotationCount) : "";
    }
}

export interface SortSpec {
    column: ColumnId;
    descending: boolean;
}

const collator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
});

/** Markup and leading punctuation do not count in a sort by title, as in Zotero. */
function titleKey(title: string): string {
    return plainTitle(title).replace(/^[\s"'“‘«([{]+/, "");
}

function compareBy(column: ColumnId, a: EvoItemRow, b: EvoItemRow): number {
    switch (column) {
        case "title":
            return collator.compare(titleKey(a.title), titleKey(b.title));
        case "creator":
            return collator.compare(a.creatorSort, b.creatorSort);
        case "year":
            return (Number(a.year) || 0) - (Number(b.year) || 0);
        case "attachment": {
            const rank = (r: EvoItemRow) =>
                r.attachment ? SHOWN.indexOf(r.attachment) : SHOWN.length;
            return rank(a) - rank(b);
        }
        case "annotations":
            return a.annotationCount - b.annotationCount;
        case "dateAdded":
        case "dateModified":
            return a[column] < b[column] ? -1 : a[column] > b[column] ? 1 : 0;
        default:
            return collator.compare(cellText(a, column), cellText(b, column));
    }
}

/**
 * Rows in the order of `sort`. Empty values go last either way; ties are
 * broken by title, then creator, then key.
 */
export function sortRows(
    rows: readonly EvoItemRow[],
    sort: SortSpec,
): EvoItemRow[] {
    const dir = sort.descending ? -1 : 1;
    // Empty cells stay at the end either way; not in the attachment column,
    // where "no file" is a value of its own and comes first descending.
    const empty = (r: EvoItemRow) =>
        sort.column === "attachment"
            ? false
            : sort.column === "annotations"
              ? r.annotationCount === 0
              : !cellText(r, sort.column);
    return [...rows].sort((a, b) => {
        const ea = empty(a);
        const eb = empty(b);
        if (ea !== eb) return ea ? 1 : -1;
        return (
            dir * compareBy(sort.column, a, b) ||
            compareBy("title", a, b) ||
            compareBy("creator", a, b) ||
            (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
        );
    });
}

/**
 * Rows whose title, creator, year, publication, citation key or tags
 * contain every word of `query` (any case, any order).
 */
export function filterRows(
    rows: readonly EvoItemRow[],
    query: string,
): EvoItemRow[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [...rows];
    return rows.filter((r) => {
        const hay = [
            plainTitle(r.title),
            r.creator,
            r.firstCreator,
            r.year,
            r.publication,
            r.citationKey,
            ...r.tags,
        ]
            .join(" \u0000 ")
            .toLowerCase();
        return words.every((w) => hay.includes(w));
    });
}

/**
 * The rows from `anchor` to `target` in the shown order, for a Shift+click.
 * Without an anchor (or one no longer shown), just the target.
 */
export function rangeOf(
    order: readonly string[],
    anchor: string | null,
    target: string,
): string[] {
    const to = order.indexOf(target);
    const from = anchor === null ? -1 : order.indexOf(anchor);
    if (to < 0) return [];
    if (from < 0) return [target];
    const [lo, hi] = from <= to ? [from, to] : [to, from];
    return order.slice(lo, hi + 1);
}

/* ------------------------------------------------------------------ */
/*  Searching for a missing file                                      */
/* ------------------------------------------------------------------ */

export const DEFAULT_BOOK_SEARCH_URL = "https://annas-archive.gl/search?q=";

/** The search for an item's file: title, first author's full name, year, after `base`. */
export function bookSearchUrl(
    base: string,
    item: { title: string; firstCreator: string; year: string },
): string {
    const query = [plainTitle(item.title), item.firstCreator, item.year]
        .map((s) => s.trim())
        .filter(Boolean)
        .join(" ");
    return (base.trim() || DEFAULT_BOOK_SEARCH_URL) + encodeURIComponent(query);
}

/* ------------------------------------------------------------------ */
/*  The annotation browser                                            */
/* ------------------------------------------------------------------ */

/** An annotation with the item it belongs to. */
export interface EvoCollectionAnnotation {
    id: string;
    libraryID: number;
    /** The top-level item. */
    itemKey: string;
    /** The attachment it is on. */
    attachmentKey: string;
    type: string;
    text?: string;
    comment?: string;
    color?: string;
    pageLabel?: string;
    sortIndex?: string;
    tags: string[];
    dateAdded: string;
}

/** What the annotation browser knows of each item. */
export interface EvoAnnotatedItem {
    key: string;
    title: string;
    shortTitle: string;
    /** "Schmidgen", "Schmidgen and Siegert", "Schmidgen et al." */
    creator: string;
    year: string;
    dateAdded: string;
}

export type AnnotationGroupBy = "item" | "color" | "tag";
export type AnnotationThenBy = "none" | "item" | "color";
export type AnnotationItemOrder = "title" | "dateAdded";

export interface AnnotationLayout {
    /** What the headings are. */
    groupBy: AnnotationGroupBy;
    /** How the annotations of one heading are ordered before page order. */
    thenBy: AnnotationThenBy;
    /** The order of items, wherever items are ordered. */
    itemOrder: AnnotationItemOrder;
    /** Items the other way round (Z…A, newest first). */
    descending?: boolean;
}

export const DEFAULT_ANNOTATION_LAYOUT: AnnotationLayout = {
    groupBy: "item",
    thenBy: "none",
    itemOrder: "title",
    descending: false,
};

/** The eight colours of the Zotero reader, in its order. */
export const ANNOTATION_COLOR_ORDER: readonly { name: string; hex: string }[] =
    [
        { name: "Yellow", hex: "#ffd400" },
        { name: "Red", hex: "#ff6666" },
        { name: "Green", hex: "#5fb236" },
        { name: "Blue", hex: "#2ea8e5" },
        { name: "Purple", hex: "#a28ae5" },
        { name: "Magenta", hex: "#e56eee" },
        { name: "Orange", hex: "#f19837" },
        { name: "Gray", hex: "#aaaaaa" },
    ];

export function colorName(hex: string | undefined): string {
    const lower = (hex ?? "").toLowerCase();
    return (
        ANNOTATION_COLOR_ORDER.find((c) => c.hex === lower)?.name ??
        (lower || "No colour")
    );
}

function colorRank(hex: string | undefined): number {
    const i = ANNOTATION_COLOR_ORDER.findIndex(
        (c) => c.hex === (hex ?? "").toLowerCase(),
    );
    return i < 0 ? ANNOTATION_COLOR_ORDER.length : i;
}

/** "(Schmidgen 2005, Lebendige Kräfte)": who, when and what, after an annotation. */
export function itemReference(item: EvoAnnotatedItem | undefined): string {
    if (!item) return "";
    const who = [item.creator, item.year].filter(Boolean).join(" ");
    const what = plainTitle(item.shortTitle || item.title);
    return `(${[who, what].filter(Boolean).join(", ")})`;
}

export interface AnnotationGroup {
    id: string;
    /** The heading: an item's title, a colour's name, a tag. */
    label: string;
    /** Under an item heading: its creator and year. */
    detail?: string;
    /** For a colour heading. */
    color?: string;
    /** Under a heading that is not an item: each annotation names its item. */
    showsItem: boolean;
    annotations: EvoCollectionAnnotation[];
}

/**
 * The annotation browser's headings and their annotations.
 *
 * Within a heading the order is `thenBy` (item order or colour order), then
 * the place in the document. Items are ordered by title or by when they
 * were added (`itemOrder`). An annotation with several tags is listed under
 * each; one without any under "No tag", last.
 *
 * @param colors Lower-case colours to keep; empty keeps all.
 */
export function groupAnnotations(
    annotations: readonly EvoCollectionAnnotation[],
    items: ReadonlyMap<string, EvoAnnotatedItem>,
    layout: AnnotationLayout,
    colors: ReadonlySet<string> = new Set(),
): AnnotationGroup[] {
    const kept = colors.size
        ? annotations.filter((a) => colors.has((a.color ?? "").toLowerCase()))
        : [...annotations];

    const sign = layout.descending ? -1 : 1;
    const itemCompare = (ka: string, kb: string): number => {
        const a = items.get(ka);
        const b = items.get(kb);
        if (layout.itemOrder === "dateAdded") {
            const da = a?.dateAdded ?? "";
            const db = b?.dateAdded ?? "";
            if (da !== db) return (da < db ? -1 : 1) * sign;
        }
        return (
            collator.compare(a?.title ?? "", b?.title ?? "") * sign ||
            (ka < kb ? -1 : ka > kb ? 1 : 0)
        );
    };
    const pageCompare = (
        a: EvoCollectionAnnotation,
        b: EvoCollectionAnnotation,
    ): number =>
        (a.attachmentKey < b.attachmentKey
            ? -1
            : a.attachmentKey > b.attachmentKey
              ? 1
              : 0) ||
        ((a.sortIndex ?? "") < (b.sortIndex ?? "")
            ? -1
            : (a.sortIndex ?? "") > (b.sortIndex ?? "")
              ? 1
              : 0) ||
        (a.id < b.id ? -1 : 1);
    const within = (
        a: EvoCollectionAnnotation,
        b: EvoCollectionAnnotation,
    ): number => {
        if (layout.thenBy === "item" || layout.groupBy === "item") {
            const byItem = itemCompare(a.itemKey, b.itemKey);
            if (byItem) return byItem;
        }
        if (layout.thenBy === "color") {
            const byColor = colorRank(a.color) - colorRank(b.color);
            if (byColor) return byColor;
        }
        return pageCompare(a, b);
    };

    const groups = new Map<string, AnnotationGroup>();
    const add = (
        id: string,
        make: () => Omit<AnnotationGroup, "annotations">,
        annotation: EvoCollectionAnnotation,
    ) => {
        let group = groups.get(id);
        if (!group) {
            group = { ...make(), annotations: [] };
            groups.set(id, group);
        }
        group.annotations.push(annotation);
    };
    for (const annotation of kept) {
        if (layout.groupBy === "item") {
            add(
                "item:" + annotation.itemKey,
                () => {
                    const item = items.get(annotation.itemKey);
                    return {
                        id: "item:" + annotation.itemKey,
                        label: item?.title || "Untitled",
                        detail: [item?.creator, item?.year]
                            .filter(Boolean)
                            .join(" "),
                        showsItem: false,
                    };
                },
                annotation,
            );
        } else if (layout.groupBy === "color") {
            const hex = (annotation.color ?? "").toLowerCase();
            add(
                "color:" + hex,
                () => ({
                    id: "color:" + hex,
                    label: colorName(hex),
                    color: hex,
                    showsItem: true,
                }),
                annotation,
            );
        } else {
            const tags = annotation.tags.length ? annotation.tags : [""];
            for (const tag of tags) {
                add(
                    "tag:" + tag,
                    () => ({
                        id: "tag:" + tag,
                        label: tag || "No tag",
                        showsItem: true,
                    }),
                    annotation,
                );
            }
        }
    }

    const out = [...groups.values()];
    for (const group of out) group.annotations.sort(within);
    out.sort((a, b) => {
        if (layout.groupBy === "item") {
            return itemCompare(a.id.slice(5), b.id.slice(5));
        }
        if (layout.groupBy === "color") {
            return (
                colorRank(a.color) - colorRank(b.color) ||
                collator.compare(a.label, b.label)
            );
        }
        // Tags by name, "No tag" last.
        const ea = a.id === "tag:";
        const eb = b.id === "tag:";
        if (ea !== eb) return ea ? 1 : -1;
        return collator.compare(a.label, b.label);
    });
    return out;
}

/** The colours in use, in the reader's order (others after). */
export function annotationColors(
    annotations: readonly { color?: string | null }[],
): string[] {
    const used = new Set(
        annotations.map((a) => (a.color ?? "").toLowerCase()).filter(Boolean),
    );
    return [...used].sort(
        (a, b) => colorRank(a) - colorRank(b) || (a < b ? -1 : 1),
    );
}

/* ------------------------------------------------------------------ */
/*  The collection pane: order and pins                               */
/* ------------------------------------------------------------------ */

/** A collection as the pane orders it. */
export interface OrderedCollection {
    libraryID: number;
    key: string;
    name: string;
    children: OrderedCollection[];
}

/** Where a list of collections lives, for the remembered order: a parent, or the pinned list. */
export function siblingsId(
    libraryID: number,
    parentKey: string | null,
): string {
    return `${libraryID}:${parentKey ?? ""}`;
}

export const PINNED_SIBLINGS = "pinned";

/** "1:ABCD1234": a collection across libraries. */
export function collectionId(libraryID: number, key: string): string {
    return `${libraryID}:${key}`;
}

/**
 * Siblings in the remembered order: those named in `order` first, in that
 * order; the rest after them by name (new collections land at the end).
 */
export function orderSiblings<T extends { key: string; name: string }>(
    nodes: readonly T[],
    order: readonly string[] | undefined,
): T[] {
    const rank = new Map((order ?? []).map((key, i) => [key, i]));
    return [...nodes].sort((a, b) => {
        const ra = rank.get(a.key);
        const rb = rank.get(b.key);
        if (ra !== undefined || rb !== undefined) {
            if (ra === undefined) return 1;
            if (rb === undefined) return -1;
            return ra - rb;
        }
        return collator.compare(a.name, b.name);
    });
}

/** Every level of a tree in the remembered order. */
export function orderTree<T extends OrderedCollection>(
    nodes: readonly T[],
    orders: Readonly<Record<string, string[]>>,
    libraryID: number,
    parentKey: string | null,
): T[] {
    return orderSiblings(nodes, orders[siblingsId(libraryID, parentKey)]).map(
        (n) => ({
            ...n,
            children: orderTree(n.children as T[], orders, libraryID, n.key),
        }),
    );
}

/**
 * `keys` (the siblings as shown) with `dragged` put before or after
 * `target`. Unchanged if either is not among them.
 */
export function moveKey(
    keys: readonly string[],
    dragged: string,
    target: string,
    after: boolean,
): string[] {
    if (
        dragged === target ||
        !keys.includes(dragged) ||
        !keys.includes(target)
    ) {
        return [...keys];
    }
    const rest = keys.filter((k) => k !== dragged);
    const at = rest.indexOf(target) + (after ? 1 : 0);
    rest.splice(at, 0, dragged);
    return rest;
}

/**
 * Pinned collections taken out of their place in the tree: the pinned ones
 * (each with everything inside it) in the order of `pinned`, and the
 * trees without them. A pin whose collection is gone is skipped.
 */
export function splitPinned<T extends OrderedCollection>(
    libraries: readonly { libraryID: number; collections: T[] }[],
    pinned: readonly string[],
): { pinned: T[]; trees: T[][] } {
    const wanted = new Set(pinned);
    const found = new Map<string, T>();
    const strip = (nodes: T[]): T[] =>
        nodes.flatMap((n) => {
            const id = collectionId(n.libraryID, n.key);
            if (wanted.has(id)) {
                found.set(id, n);
                return [];
            }
            return [{ ...n, children: strip(n.children as T[]) }];
        });
    const trees = libraries.map((lib) => strip(lib.collections));
    return {
        pinned: pinned.flatMap((id) => (found.has(id) ? [found.get(id)!] : [])),
        trees,
    };
}

/* ------------------------------------------------------------------ */
/*  Files saved to an item                                            */
/* ------------------------------------------------------------------ */

/** The default name of a file saved to an item (LiquidJS; see FORK.md). */
export const DEFAULT_ATTACH_FILENAME =
    '{{ lastName | downcase }}_{{ year }}_{{ shortTitle | downcase | split: " " | slice: 0, 2 | join: "-" }}';

/** Earlier defaults: a stored one is replaced by the current (settings/evo-upgrade.ts). */
export const PREVIOUS_ATTACH_FILENAMES: readonly string[] = [
    '{{ lastName | downcase }}_{{ year }}_{{ shortTitle | downcase | replace: " ", "_" }}',
];

/**
 * A rendered name made safe as a file name: markup and characters no file
 * system takes removed, runs of spaces and underscores folded, at most
 * `max` characters, never empty. The extension is added after.
 */
export function sanitizeFilename(name: string, max = 120): string {
    const cleaned = plainTitle(name)
        // eslint-disable-next-line no-control-regex -- control characters are exactly what file names must not hold
        .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "")
        .replace(/\s+/g, " ")
        .replace(/_{2,}/g, "_")
        .replace(/^[\s._]+|[\s._]+$/g, "")
        .trim();
    const cut = [...cleaned]
        .slice(0, max)
        .join("")
        .replace(/[\s._]+$/g, "");
    return cut || "file";
}

/** What kind of file the bytes are, if one Zotero should store: PDF, EPUB, DjVu. */
export function sniffFile(
    bytes: ArrayBuffer,
): { contentType: string; extension: string } | null {
    const head = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 1024));
    const text = String.fromCharCode(...head);
    if (text.includes("%PDF-"))
        return { contentType: "application/pdf", extension: "pdf" };
    if (
        text.startsWith("PK\u0003\u0004") &&
        text.includes("mimetypeapplication/epub+zip")
    )
        return { contentType: "application/epub+zip", extension: "epub" };
    if (text.startsWith("AT&TFORM"))
        return { contentType: "image/vnd.djvu", extension: "djvu" };
    return null;
}

/** The MD5 of a book in an Anna's Archive address (/md5/…, /fast_download/…, a viewer). */
export function md5FromUrl(url: string): string | null {
    let text = url;
    try {
        text = decodeURIComponent(url);
    } catch {
        // As it is.
    }
    const m =
        /\/(?:md5|fast_download|slow_download|view|viewer)\/([a-f0-9]{32})\b/i.exec(
            text,
        ) ?? /[?&]md5=([a-f0-9]{32})\b/i.exec(text);
    return m ? m[1]!.toLowerCase() : null;
}

/** File addresses inside an address (a viewer's `?file=…`). */
export function embeddedUrls(url: string): string[] {
    try {
        const parsed = new URL(url);
        const out: string[] = [];
        parsed.searchParams.forEach((value) => {
            if (/^https?:\/\//i.test(value)) out.push(value);
        });
        // pdf.js viewers put it in the hash too: #file=…
        const hash = new URLSearchParams(parsed.hash.replace(/^#/, ""));
        hash.forEach((value) => {
            if (/^https?:\/\//i.test(value)) out.push(value);
        });
        return out;
    } catch {
        return [];
    }
}

/* ------------------------------------------------------------------ */
/*  Moving collections                                                */
/* ------------------------------------------------------------------ */

/** Each collection's parent ("libraryID:key" → parent key, null at the top). */
export function collectionParents(
    libraries: readonly {
        libraryID: number;
        collections: OrderedCollection[];
    }[],
): Map<string, string | null> {
    const out = new Map<string, string | null>();
    const walk = (nodes: OrderedCollection[], parent: string | null) => {
        for (const n of nodes) {
            out.set(collectionId(n.libraryID, n.key), parent);
            walk(n.children, n.key);
        }
    };
    for (const lib of libraries) walk(lib.collections, null);
    return out;
}

/** Whether `key` is `ancestor` or inside it (a collection cannot move into itself). */
export function isInside(
    parents: ReadonlyMap<string, string | null>,
    libraryID: number,
    key: string,
    ancestor: string,
): boolean {
    let at: string | null | undefined = key;
    const seen = new Set<string>();
    while (at && !seen.has(at)) {
        if (at === ancestor) return true;
        seen.add(at);
        at = parents.get(collectionId(libraryID, at));
    }
    return false;
}

/** The fields of an attachment a rename of its file reads. */
export interface AttachmentFileFacts {
    filename?: string;
    title?: string;
    contentType?: string;
    linkMode?: string;
}

/**
 * The new `filename` (and title) of an attachment whose file is renamed to
 * `base` (the file name template's result, without extension), as Zotero
 * renames one: the extension kept, the title changed only where it was the
 * old file name. Only a PDF or EPUB stored in Zotero (a single file, which
 * Zotero renames on every computer when it syncs the new name); a snapshot
 * is a folder of files, a linked file is on one computer. Null: the name is
 * already that.
 */
export function attachmentRename(
    current: AttachmentFileFacts,
    base: string,
): { filename: string; title?: string } | { refused: string } | null {
    if (
        current.linkMode !== "imported_file" &&
        current.linkMode !== "imported_url"
    )
        return { refused: "Only files stored in Zotero are renamed here." };
    const type = (current.contentType ?? "").toLowerCase();
    const byType =
        type === "application/pdf"
            ? "pdf"
            : type === "application/epub+zip"
              ? "epub"
              : null;
    if (!byType) return { refused: "Only PDFs and EPUBs are renamed here." };
    if (!base.trim())
        return { refused: "The file name template gave nothing." };
    const old = current.filename ?? "";
    const dot = old.lastIndexOf(".");
    const ext = dot > 0 ? old.slice(dot + 1) : byType;
    const filename = `${base.trim()}.${ext}`;
    if (filename === old) return null;
    const oldStem = dot > 0 ? old.slice(0, dot) : old;
    const title = current.title ?? "";
    return old && (title === old || title === oldStem)
        ? { filename, title: filename }
        : { filename };
}
