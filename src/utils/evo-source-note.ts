/**
 * ZotFlow Evo (fork): the source note as a lasting copy of what was
 * annotated (the default template since beta.15). Pure; the template
 * service gathers the data (`evo` in the template's scope).
 *
 * - Properties: every field of the item that has a value, under Zotero's
 *   own names; creators by role (`authors`, `editors`, `bookAuthors`, …),
 *   each a link to a person's note, without repeats; the year, the
 *   collections, the tags, the number of annotations, a link that opens the
 *   PDF in ZotFlow and one that shows the item in Zotero.
 * - "# Annotations": a list, one item per annotation, tagged by kind and
 *   colour (#hl/yellow, #ul/red, #note/…, #img/…, #ink/…) for List
 *   Callouts Improved's tag callouts and for search; the highlighted text,
 *   the page and the annotation's block ID on the first line, the comment
 *   below as nested items (lists in it keep their nesting). The PDF's
 *   outline as headings between them (only parts that have annotations).
 * - An annotation that is gone from Zotero stays, struck through, with the
 *   day it went: an update never takes anything out of the note.
 * - A hidden `%% zotflow-data %%` block at the end holds what a restore
 *   needs, one line of JSON per annotation (with its position on the page
 *   and Zotero's own text and comment), and the outlines read, so a device
 *   without the PDF writes the same headings.
 */

import { interleaveOutline, placementOf } from "utils/evo-outline-list";
import { naturalName } from "utils/evo-names";

import type { OutlineHeading } from "utils/evo-outline-list";

/** An annotation as the note keeps it. */
export interface NoteAnnotation {
    key: string;
    /** Its attachment's key. */
    attachment: string;
    type: string;
    color: string;
    pageLabel: string;
    sortIndex: string;
    position: unknown;
    /** Zotero's own values (the comment may be HTML). */
    text: string;
    comment: string;
    tags: string[];
    dateAdded: string;
    dateModified: string;
    /** The day it was found gone from Zotero (YYYY-MM-DD). */
    removed?: string;
}

/** An attachment's outline as read once: null when its PDF has none. */
export interface NoteOutline {
    attachment: string;
    md5: string;
    headings: OutlineHeading[] | null;
}

export interface NoteData {
    outlines: NoteOutline[];
    annotations: NoteAnnotation[];
}

const DATA_OPEN = "%% zotflow-data";
const DATA_HEAD = `${DATA_OPEN} — what a restore needs, one annotation per line; generated, do not edit`;

/** Zotero's eight colours, with the names their tags get. */
export const DEFAULT_TAG_NAMES: Record<string, string> = {
    ffd400: "yellow",
    ff6666: "red",
    "5fb236": "green",
    "2ea8e5": "blue",
    a28ae5: "purple",
    e56eee: "magenta",
    f19837: "orange",
    aaaaaa: "gray",
};

const TYPE_TAGS: Record<string, string> = {
    highlight: "hl",
    underline: "ul",
    note: "note",
    image: "img",
    ink: "ink",
    text: "text",
};

/** "#hl/yellow": the annotation's kind and colour. */
export function tagFor(
    type: string,
    color: string,
    names: Record<string, string> = {},
): string {
    const hex = color.replace(/^#/, "").toLowerCase();
    const name = names[hex] || DEFAULT_TAG_NAMES[hex] || (hex ? `c${hex}` : "none");
    return `#${TYPE_TAGS[type] ?? "hl"}/${name}`;
}

/** A Zotero tag as an Obsidian tag (no spaces, no characters tags cannot have). */
export function obsidianTag(tag: string): string {
    return tag
        .trim()
        .replace(/\s+/g, "_")
        .replace(/[^\p{L}\p{N}_/-]/gu, "");
}

/** Characters `%` hidden in the data's JSON, so `%%` in a comment cannot end the block. */
function dataLine(value: unknown): string {
    return JSON.stringify(value).replace(/%/g, "\\u0025");
}

/** The data block of a note's text; empty when it has none (an older note). */
export function parseNoteData(text: string | null | undefined): NoteData {
    const out: NoteData = { outlines: [], annotations: [] };
    if (!text) return out;
    const start = text.lastIndexOf(DATA_OPEN);
    if (start < 0) return out;
    const end = text.indexOf("%%", start + DATA_OPEN.length);
    const body = text.slice(text.indexOf("\n", start) + 1, end < 0 ? undefined : end);
    for (const raw of body.split("\n")) {
        const line = raw.trim();
        if (!line.startsWith("{")) continue;
        let value: unknown;
        try {
            value = JSON.parse(line);
        } catch {
            continue;
        }
        if (!value || typeof value !== "object") continue;
        const v = value as Record<string, unknown>;
        if ("outline" in v && typeof v.attachment === "string") {
            out.outlines.push({
                attachment: v.attachment,
                md5: typeof v.md5 === "string" ? v.md5 : "",
                headings: Array.isArray(v.outline) ? (v.outline as OutlineHeading[]) : null,
            });
        } else if (typeof v.key === "string") {
            out.annotations.push({
                key: v.key,
                attachment: typeof v.attachment === "string" ? v.attachment : "",
                type: typeof v.type === "string" ? v.type : "highlight",
                color: typeof v.color === "string" ? v.color : "",
                pageLabel: typeof v.pageLabel === "string" ? v.pageLabel : "",
                sortIndex: typeof v.sortIndex === "string" ? v.sortIndex : "",
                position: v.position,
                text: typeof v.text === "string" ? v.text : "",
                comment: typeof v.comment === "string" ? v.comment : "",
                tags: Array.isArray(v.tags) ? v.tags.filter((t): t is string => typeof t === "string") : [],
                dateAdded: typeof v.dateAdded === "string" ? v.dateAdded : "",
                dateModified: typeof v.dateModified === "string" ? v.dateModified : "",
                removed: typeof v.removed === "string" ? v.removed : undefined,
            });
        }
    }
    return out;
}

export function serializeNoteData(data: NoteData): string {
    const lines = [DATA_HEAD];
    for (const o of data.outlines)
        lines.push(dataLine({ attachment: o.attachment, md5: o.md5, outline: o.headings }));
    for (const a of data.annotations) {
        const { removed, ...rest } = a;
        lines.push(dataLine(removed ? { ...rest, removed } : rest));
    }
    lines.push("%%");
    return lines.join("\n");
}

const bySortIndex = (a: NoteAnnotation, b: NoteAnnotation) =>
    a.sortIndex < b.sortIndex ? -1 : a.sortIndex > b.sortIndex ? 1 : a.key < b.key ? -1 : 1;

/**
 * The annotations now, and those the note had that Zotero no longer has
 * (struck through from `today` on, or since the day they first went).
 */
export function mergeRemoved(
    previous: NoteAnnotation[],
    current: NoteAnnotation[],
    today: string,
): NoteAnnotation[] {
    const now = new Set(current.map((a) => a.key));
    const gone = previous
        .filter((a) => !now.has(a.key))
        .map((a) => ({ ...a, removed: a.removed ?? today }));
    return [...current.map((a) => ({ ...a, removed: undefined })), ...gone].sort(bySortIndex);
}

/** Highlighted text on one line, quoted; a "#" that would make a tag escaped. */
function quoteText(text: string): string {
    const one = text.replace(/\s+/g, " ").trim().replace(/(^|\s)#(?=[\p{L}\p{N}_/-])/gu, "$1\\#");
    return `“${one}”`;
}

/** A line struck through (after a list marker, if it has one). */
function strike(line: string): string {
    const m = /^(\s*(?:[-*+]|\d+[.)])\s+(?:\[.\]\s+)?)(.*)$/.exec(line);
    if (m) return m[2]!.trim() ? `${m[1]}~~${m[2]}~~` : line;
    return line.trim() ? `~~${line}~~` : line;
}

/**
 * A comment as nested list items: each paragraph one item, lists in it
 * kept (one level deeper), Zotero's tags at the end of the first line.
 */
export function commentLines(comment: string, opts: { struck?: boolean; tags?: string[] } = {}): string[] {
    const out: string[] = [];
    const blocks = comment
        .replace(/\r\n?/g, "\n")
        .split(/\n\s*\n/)
        .map((b) => b.replace(/^\n+|\n+$/g, ""))
        .filter((b) => b.trim());
    const isList = (line: string) => /^\s*(?:[-*+]|\d+[.)])\s/.test(line);
    for (const block of blocks) {
        const lines = block.split("\n");
        if (isList(lines[0]!)) {
            for (const line of lines) {
                const text = isList(line) ? line : `  ${line.trimStart()}`;
                out.push("\t" + (opts.struck ? strike(text) : text));
            }
        } else {
            lines.forEach((line, i) => {
                const text = opts.struck ? strike(line.trim()) : line.trim();
                out.push(i === 0 ? `\t- ${text}` : `\t  ${text}`);
            });
        }
    }
    const tags = (opts.tags ?? []).map(obsidianTag).filter(Boolean);
    if (tags.length) {
        const mark = tags.map((t) => `#${t}`).join(" ");
        if (out.length) out[0] = `${out[0]} ${mark}`;
        else out.push(`\t- ${mark}`);
    }
    return out;
}

export interface RenderOptions {
    /** The colour → tag name table of the settings. */
    tagNames?: Record<string, string>;
    /** Where annotation images are (none: they are not imported). */
    imageFolder?: string | null;
    /** Each annotation's text and comment as Markdown (Zotero's may be HTML), by key. */
    markdown?: Map<string, { text: string; comment: string }>;
}

/** One annotation as a list item (with its comment under it). */
export function annotationItem(a: NoteAnnotation, opts: RenderOptions = {}): string[] {
    const md = opts.markdown?.get(a.key) ?? { text: a.text, comment: a.comment };
    const struck = !!a.removed;
    let body: string;
    let comment = md.comment;
    if (a.type === "image" || a.type === "ink") {
        body = opts.imageFolder ? `![[${opts.imageFolder}/${a.key}.png]]` : "(image)";
    } else if (a.type === "note" || a.type === "text") {
        // A note's comment is its text: its first paragraph on the line.
        const [first, ...rest] = comment.replace(/\r\n?/g, "\n").split(/\n\s*\n/);
        body = (first ?? "").replace(/\s+/g, " ").trim();
        comment = rest.join("\n\n");
    } else {
        body = quoteText(md.text);
    }
    if (struck && body && !body.startsWith("![[")) body = `~~${body}~~`;
    const parts = [`- ${tagFor(a.type, a.color, opts.tagNames)}`];
    if (body) parts.push(body);
    let tail = a.pageLabel ? ` · p. ${a.pageLabel}` : "";
    if (struck) tail += ` · *removed ${a.removed}*`;
    const first = `${parts.join(" ")}${tail} ^${a.key}`;
    return [first, ...commentLines(comment, { struck, tags: a.tags })];
}

export interface RenderFile {
    key: string;
    /** Shown as a heading when the annotations are of several files. */
    title: string;
    headings: OutlineHeading[] | null;
}

/**
 * "# Annotations" and everything under it; empty when there is nothing.
 * Files in the order given; annotations of files not given (gone) last.
 */
export function renderAnnotations(
    files: RenderFile[],
    annotations: NoteAnnotation[],
    opts: RenderOptions = {},
): string {
    if (!annotations.length) return "";
    const known = new Set(files.map((f) => f.key));
    const groups: { file: RenderFile; list: NoteAnnotation[] }[] = [];
    for (const file of files) {
        const list = annotations.filter((a) => a.attachment === file.key);
        if (list.length) groups.push({ file, list });
    }
    const orphans = annotations.filter((a) => !known.has(a.attachment));
    if (orphans.length)
        groups.push({ file: { key: "", title: "A file no longer in Zotero", headings: null }, list: orphans });
    const several = groups.length > 1;
    const out: string[] = ["# Annotations"];
    for (const { file, list } of groups) {
        if (several) out.push("", `## ${file.title}`);
        const base = several ? 3 : 2;
        const entries = file.headings
            ? interleaveOutline(list, file.headings, (a) => placementOf(a.position))
            : list.map((annotation) => ({ kind: "annotation" as const, annotation }));
        let inList = false;
        for (const entry of entries) {
            if (entry.kind === "heading") {
                out.push("", `${"#".repeat(Math.min(6, base + entry.heading.level))} ${entry.heading.title}`);
                inList = false;
            } else {
                if (!inList) out.push("");
                inList = true;
                out.push(...annotationItem(entry.annotation, opts));
            }
        }
    }
    return out.join("\n");
}

/* ------------------------------------------------------------------ */
/*  Properties                                                        */
/* ------------------------------------------------------------------ */

/** A name as a note's name: characters Obsidian does not allow removed (as ui/evo-person.ts). */
export function personFileName(name: string): string {
    return name
        .replace(/[\\/:*?"<>|#^[\]]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

/** Fields not written as they are (each has its own property, or none). */
const SKIPPED = new Set([
    "key",
    "version",
    "itemType",
    "title",
    "creators",
    "tags",
    "collections",
    "relations",
    "dateAdded",
    "dateModified",
    "deleted",
    "parentItem",
    "note",
    "inPublications",
]);

/** Properties the old default template wrote, which the list format does not. */
export const LEGACY_KEYS = ["creators", "publication", "doi"];

export interface PropertyInput {
    data: Record<string, unknown>;
    itemType: string;
    year: string;
    collections: string[];
    annotationCount: number;
    pdfLink: string;
    zoteroLink: string;
}

/** `role` + "s": author → authors, bookAuthor → bookAuthors. */
const roleKey = (role: string) => `${role}s`;

/** The properties, in order: [key, value]. Values are strings, numbers or lists of strings. */
export function noteProperties(p: PropertyInput): [string, string | number | string[]][] {
    const out: [string, string | number | string[]][] = [];
    out.push(["itemType", p.itemType]);
    const title = p.data.title;
    if (typeof title === "string" && title) out.push(["title", title]);
    const roles = new Map<string, string[]>();
    const creators = Array.isArray(p.data.creators)
        ? (p.data.creators as { creatorType?: string; firstName?: string; lastName?: string; name?: string }[])
        : [];
    for (const c of creators) {
        const role = c.creatorType || "author";
        const name = personFileName(
            naturalName(
                c.name !== undefined
                    ? { name: c.name }
                    : { firstName: c.firstName ?? "", lastName: c.lastName ?? "" },
            ),
        );
        if (!name) continue;
        const list = roles.get(role) ?? [];
        const link = `[[${name}]]`;
        if (!list.includes(link)) list.push(link);
        roles.set(role, list);
    }
    for (const [role, list] of roles) out.push([roleKey(role), list]);
    for (const [key, value] of Object.entries(p.data)) {
        if (SKIPPED.has(key)) continue;
        if (typeof value === "string" && value.trim()) out.push([key, value]);
        else if (typeof value === "number") out.push([key, value]);
    }
    if (/^\d{4}$/.test(p.year)) out.push(["year", Number(p.year)]);
    if (p.collections.length) out.push(["collections", p.collections]);
    const tags = Array.isArray(p.data.tags)
        ? (p.data.tags as { tag?: string }[])
              .map((t) => obsidianTag(t.tag ?? ""))
              .filter(Boolean)
        : [];
    out.push(["tags", tags]);
    out.push(["annotations", p.annotationCount]);
    if (p.pdfLink) out.push(["pdf", p.pdfLink]);
    out.push(["zotero", p.zoteroLink]);
    for (const key of ["dateAdded", "dateModified"]) {
        const v = p.data[key];
        if (typeof v === "string" && v) out.push([key, v]);
    }
    return out;
}

/** The keys `noteProperties` may write (to drop ones an item no longer has). */
export function isManagedProperty(
    key: string,
    fieldNames: ReadonlySet<string>,
    roles: ReadonlySet<string>,
): boolean {
    if (LEGACY_KEYS.includes(key)) return true;
    if (fieldNames.has(key)) return true;
    if (key.endsWith("s") && roles.has(key.slice(0, -1))) return true;
    return ["itemType", "title", "year", "collections", "tags", "annotations", "pdf", "zotero", "dateAdded", "dateModified"].includes(key);
}

/** The properties as YAML lines (values in JSON's notation, which YAML reads). */
export function propertiesYaml(props: [string, string | number | string[]][]): string {
    return props.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n");
}
