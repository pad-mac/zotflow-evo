/**
 * ZotFlow Evo (fork): a book section made from a PDF's outline heading —
 * its pages, the new item's data from the book it is part of, and its
 * annotations moved along with the pages. Pure; the work is in
 * ui/evo-library/book-section.ts. See FORK.md, "Book sections".
 */
import { ITEM_TYPE_CREATORS, ITEM_TYPE_FIELDS } from "types/zotero-csl-schema";
import { editableName, naturalName, parseCreatorName } from "utils/evo-names";
import { sortIndexOnPage } from "utils/evo-pdf-geometry";
import { getField } from "utils/zotero-fields";

import type { CreatorName } from "utils/evo-names";

/** An outline heading, as far as a section goes. */
export interface SectionHeading {
    title: string;
    /** 0: top level. */
    level: number;
    /** The page it goes to (0-based). */
    page: number;
}

/** A heading's outline and the PDF's pages, as the panel starts from. */
export interface SectionContext {
    headings: SectionHeading[];
    /** The heading the section is of; null: none (the panel starts empty). */
    index: number | null;
    /** The labels of all pages ("iv", "245"); shorter or empty: page numbers. */
    pageLabels: string[];
    pageCount: number;
}

/**
 * The pages of a heading's part: from its page to the page before the next
 * heading of its level or higher (its own page when that one starts on the
 * same page), else to the end of the PDF. 0-based, both included.
 */
export function sectionPages(
    headings: readonly SectionHeading[],
    index: number,
    pageCount: number,
): { first: number; last: number } {
    const lastPage = Math.max(0, pageCount - 1);
    const heading = headings[index];
    if (!heading) return { first: 0, last: lastPage };
    const first = Math.max(0, Math.min(lastPage, heading.page));
    for (let j = index + 1; j < headings.length; j++) {
        const next = headings[j]!;
        if (next.level <= heading.level) {
            return { first, last: Math.max(first, Math.min(lastPage, next.page - 1)) };
        }
    }
    return { first, last: lastPage };
}

/** A page as the PDF numbers it (its label, else its number). */
export function pageLabelOf(page: number, labels: readonly string[]): string {
    const label = labels[page];
    return label ? String(label) : String(page + 1);
}

/**
 * The page (0-based) a label typed in stands for: the page with that label
 * (case aside), the one nearest `near` when several have it; a number when
 * no page has it as a label and the PDF has none. Null: no such page.
 */
export function pageOfLabel(
    input: string,
    labels: readonly string[],
    pageCount: number,
    near = 0,
): number | null {
    const wanted = input.trim().toLowerCase();
    if (!wanted) return null;
    let best: number | null = null;
    for (let i = 0; i < pageCount; i++) {
        if (pageLabelOf(i, labels).toLowerCase() !== wanted) continue;
        if (best === null || Math.abs(i - near) < Math.abs(best - near)) best = i;
    }
    return best;
}

/** The section's `pages` field: "45-78", or "45" for one page. */
export function pagesField(first: string, last: string): string {
    return first === last ? first : `${first}-${last}`;
}

/** Authors as typed: names separated by ";" or new lines. */
export function parseAuthors(input: string): CreatorName[] {
    return input
        .split(/\s*;\s*|\n/)
        .map((s) => parseCreatorName(s))
        .filter((c): c is CreatorName => c !== null);
}

interface Creator {
    creatorType?: string;
    firstName?: string;
    lastName?: string;
    name?: string;
}

const nameOf = (c: Creator): CreatorName =>
    typeof c.name === "string" && c.name
        ? { name: c.name }
        : { firstName: c.firstName ?? "", lastName: c.lastName ?? "" };

/** The authors the panel starts with: the book's (a section's: its own), as they can be edited. */
export function defaultAuthors(parent: { creators?: unknown }): string {
    const creators = Array.isArray(parent.creators)
        ? (parent.creators as Creator[])
        : [];
    return creators
        .filter((c) => c.creatorType === "author")
        .map((c) => editableName(nameOf(c)))
        .filter(Boolean)
        .join("; ");
}

/**
 * The section's creators: the authors given, then the book's people in the
 * roles a book section has — the book's authors as its book authors (left
 * out when they are the authors given: a chapter of a monograph), editors,
 * translators and the rest as they were.
 */
export function sectionCreators(
    authors: readonly CreatorName[],
    parent: { itemType?: string; creators?: unknown },
): Record<string, string>[] {
    const roles = new Set(ITEM_TYPE_CREATORS.bookSection ?? []);
    const key = (c: CreatorName) => naturalName(c).toLowerCase();
    const given = new Set(authors.map(key));
    const out: Record<string, string>[] = authors.map((c) => ({
        creatorType: "author",
        ...c,
    }));
    const creators = Array.isArray(parent.creators)
        ? (parent.creators as Creator[])
        : [];
    const bookAuthors = creators.filter((c) => c.creatorType === "author");
    const sameAuthors =
        bookAuthors.length > 0 &&
        bookAuthors.length === given.size &&
        bookAuthors.every((c) => given.has(key(nameOf(c))));
    for (const c of creators) {
        let role = c.creatorType ?? "";
        if (role === "author") {
            // A section of a section: its authors are its own, not the book's.
            if (parent.itemType === "bookSection" || sameAuthors) continue;
            role = "bookAuthor";
        }
        if (!roles.has(role)) continue;
        out.push({ creatorType: role, ...nameOf(c) });
    }
    return out;
}

/** Fields of the book a section does not take (its own, or the book's alone). */
const NOT_TAKEN = new Set([
    "title",
    "bookTitle",
    "pages",
    "abstractNote",
    "shortTitle",
    "DOI",
    "citationKey",
    "extra",
]);

/**
 * The new book section's data for Zotero's API (`POST /items`): the title,
 * authors and pages given, the book's title as its book title, and every
 * other field a book section has from the book (publisher, place, date,
 * ISBN, series, …; not its DOI, citation key, abstract or Extra, which are
 * the book's own). Its tags and collections are the book's too.
 */
export function sectionItem(
    parent: Record<string, unknown> & { itemType: string },
    input: { title: string; authors: readonly CreatorName[]; pages: string },
): Record<string, unknown> {
    const bookTitle =
        (parent.itemType === "bookSection"
            ? getField(parent, "bookTitle")
            : getField(parent, "title")) ?? "";
    const item: Record<string, unknown> = {
        itemType: "bookSection",
        title: input.title.trim(),
        creators: sectionCreators(input.authors, parent),
        bookTitle,
        pages: input.pages,
    };
    for (const field of ITEM_TYPE_FIELDS.bookSection ?? []) {
        if (NOT_TAKEN.has(field) || field in item) continue;
        const value = getField(parent, field);
        if (value) item[field] = value;
    }
    const tags = Array.isArray(parent.tags) ? (parent.tags as unknown[]) : [];
    item.tags = tags
        .filter(
            (t): t is { tag: string; type?: number } =>
                !!t && typeof (t as { tag?: unknown }).tag === "string",
        )
        .map((t) => (t.type ? { tag: t.tag, type: t.type } : { tag: t.tag }));
    item.collections = Array.isArray(parent.collections)
        ? (parent.collections as unknown[]).filter(
              (c): c is string => typeof c === "string",
          )
        : [];
    item.relations = {};
    return item;
}

interface PdfPosition {
    pageIndex: number;
    rects?: number[][];
    paths?: number[][];
    nextPageRects?: number[][];
    [key: string]: unknown;
}

/**
 * An annotation of the book's PDF as one of the section's (`POST /items`,
 * without its parent): on its page in the new PDF (`first` is the new
 * PDF's first page), with what it has. Null when it is not on the pages
 * (or has no PDF position). Part of a highlight on the page after the last
 * is left out.
 */
export function sectionAnnotation(
    data: Record<string, unknown>,
    first: number,
    last: number,
): Record<string, unknown> | null {
    const text = (v: unknown) => (typeof v === "string" ? v : "");
    let position: PdfPosition;
    try {
        position = JSON.parse(text(data.annotationPosition)) as PdfPosition;
    } catch {
        return null;
    }
    if (!position || !Number.isInteger(position.pageIndex)) return null;
    if (position.pageIndex < first || position.pageIndex > last) return null;
    const moved: PdfPosition = {
        ...position,
        pageIndex: position.pageIndex - first,
    };
    if (moved.nextPageRects && position.pageIndex + 1 > last)
        delete moved.nextPageRects;
    const out: Record<string, unknown> = {
        itemType: "annotation",
        annotationType: data.annotationType,
        annotationComment: data.annotationComment ?? "",
        annotationColor: data.annotationColor ?? "",
        annotationPageLabel: data.annotationPageLabel ?? "",
        annotationSortIndex: sortIndexOnPage(
            text(data.annotationSortIndex),
            moved.pageIndex,
        ),
        annotationPosition: JSON.stringify(moved),
        tags: Array.isArray(data.tags) ? data.tags : [],
        relations: {},
    };
    // Zotero takes a text only on highlights and underlines.
    if (
        typeof data.annotationText === "string" &&
        (data.annotationType === "highlight" || data.annotationType === "underline")
    )
        out.annotationText = data.annotationText;
    if (typeof data.annotationAuthorName === "string" && data.annotationAuthorName)
        out.annotationAuthorName = data.annotationAuthorName;
    return out;
}

/** One run of page labels as a PDF /PageLabels entry has it. */
export interface LabelRun {
    /** Its first page (0-based). */
    start: number;
    /** D: 1, 2, 3; r/R: roman; null: the prefix alone. */
    style: "D" | "r" | "R" | null;
    /** The number of its first page. */
    first: number;
    prefix: string;
}

const ROMAN: [number, string][] = [
    [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
    [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
];

function roman(n: number): string {
    let out = "";
    for (const [value, letters] of ROMAN) {
        while (n >= value) {
            out += letters;
            n -= value;
        }
    }
    return out;
}

function fromRoman(s: string): number | null {
    if (!/^[ivxlcdm]+$/.test(s)) return null;
    const value: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
    let n = 0;
    for (let i = 0; i < s.length; i++) {
        const v = value[s[i]!]!;
        const next = value[s[i + 1] ?? ""] ?? 0;
        n += v < next ? -v : v;
    }
    return n > 0 && roman(n) === s ? n : null;
}

function classify(label: string): { style: LabelRun["style"]; n: number } {
    if (/^[1-9]\d*$/.test(label)) return { style: "D", n: Number(label) };
    const lower = fromRoman(label);
    if (lower !== null) return { style: "r", n: lower };
    const upper = label === label.toUpperCase() ? fromRoman(label.toLowerCase()) : null;
    if (upper !== null) return { style: "R", n: upper };
    return { style: null, n: 0 };
}

/**
 * Labels as runs for a PDF's /PageLabels: numbers that go on by one (in
 * figures or roman) make one run; any other label is a run of its own (a
 * prefix only). So the pages of a section keep the book's labels.
 */
export function labelRuns(labels: readonly string[]): LabelRun[] {
    const runs: LabelRun[] = [];
    let prev: { style: LabelRun["style"]; n: number } | null = null;
    labels.forEach((raw, i) => {
        const label = String(raw);
        const c = classify(label);
        const last = runs[runs.length - 1];
        if (
            c.style &&
            last &&
            prev &&
            prev.style === c.style &&
            c.n === prev.n + 1
        ) {
            prev = c;
            return;
        }
        runs.push(
            c.style
                ? { start: i, style: c.style, first: c.n, prefix: "" }
                : { start: i, style: null, first: 1, prefix: label },
        );
        prev = c.style ? c : null;
    });
    return runs;
}

/**
 * For the reader's command: the heading the page being read belongs to —
 * among the headings of the shallowest level that has more than one (a
 * book's chapters, not its title), the last one at or before the page.
 * Null when the outline has none.
 */
export function headingAtPage(
    headings: readonly { level: number; page: number }[],
    page: number,
): number | null {
    if (!headings.length) return null;
    const counts = new Map<number, number>();
    for (const h of headings) counts.set(h.level, (counts.get(h.level) ?? 0) + 1);
    const levels = [...counts.keys()].sort((a, b) => a - b);
    const level = levels.find((l) => (counts.get(l) ?? 0) > 1) ?? levels[0]!;
    let found: number | null = null;
    headings.forEach((h, i) => {
        if (h.level === level && h.page <= page) found = i;
    });
    if (found !== null) return found;
    const firstAt = headings.findIndex((h) => h.level === level);
    return firstAt >= 0 ? firstAt : null;
}
