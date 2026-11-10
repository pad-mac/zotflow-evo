/**
 * ZotFlow Evo (fork): numbered footnotes. Every footnote of a note is a
 * Markdown footnote `[^n]`, numbered by where its first reference stands;
 * the definitions of a part of the note stand together at its end, before
 * the next heading of a chosen level or higher (or at the end of the note).
 * A definition that is a citation cluster (`@key, 45; @other`) is shown as
 * the formatted note. Pure: the editor applies the changes
 * (ui/editor/evo-footnotes.ts). See FORK.md, "Numbered footnotes".
 */

/** A reference `[^label]` in the text. */
export interface FootnoteRef {
    label: string;
    /** The whole `[^label]`. */
    from: number;
    to: number;
}

/** A definition `[^label]: body` with its continuation lines. */
export interface FootnoteDef {
    label: string;
    /** Start of its line, end of its last line (before the line break). */
    from: number;
    to: number;
    /** The `[^label]` at its start. */
    labelFrom: number;
    labelTo: number;
    /** Where the body starts (after `]: `). */
    bodyFrom: number;
    /** The body, continuation lines included. */
    body: string;
}

/** A heading that ends a part (its line start and level). */
export interface FootnoteHeading {
    from: number;
    level: number;
}

export interface FootnoteScan {
    refs: FootnoteRef[];
    defs: FootnoteDef[];
    headings: FootnoteHeading[];
    /** Where the note's text starts (after the frontmatter). */
    start: number;
}

const LABEL = "[^\\]\\s^]+";
const REF_RE = new RegExp(`\\[\\^(${LABEL})\\]`, "g");
const DEF_RE = new RegExp(`^ {0,3}\\[\\^(${LABEL})\\]:[ \\t]?`);
const HEADING_RE = /^(#{1,6})[ \t]/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

interface Line {
    from: number;
    to: number;
    text: string;
}

function linesOf(text: string): Line[] {
    const out: Line[] = [];
    let from = 0;
    for (;;) {
        const nl = text.indexOf("\n", from);
        const to = nl < 0 ? text.length : nl;
        out.push({ from, to, text: text.slice(from, to) });
        if (nl < 0) break;
        from = nl + 1;
    }
    return out;
}

/** Ranges of inline code (`…`) and comments (%%…%%) in a line, to skip. */
function skippedSpans(line: string): [number, number][] {
    const spans: [number, number][] = [];
    const re = /(`+)[\s\S]*?\1|%%[\s\S]*?(?:%%|$)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
        spans.push([m.index, m.index + m[0].length]);
        if (m[0].length === 0) re.lastIndex++;
    }
    return spans;
}

/**
 * The footnotes of a note: references, definitions (continuation lines:
 * indented lines right after), and the headings. Code blocks, inline code,
 * comments, math blocks and the frontmatter are left out; references
 * inside definitions do not count as references.
 */
export function scanFootnotes(text: string): FootnoteScan {
    const lines = linesOf(text);
    const refs: FootnoteRef[] = [];
    const defs: FootnoteDef[] = [];
    const headings: FootnoteHeading[] = [];
    let i = 0;
    let start = 0;
    // Frontmatter.
    if (lines[0]?.text === "---") {
        for (let j = 1; j < lines.length; j++) {
            if (lines[j]!.text === "---" || lines[j]!.text === "...") {
                i = j + 1;
                start = lines[j + 1]?.from ?? text.length;
                break;
            }
        }
    }
    let fence: string | null = null;
    let math = false;
    let multiComment = false;
    for (; i < lines.length; i++) {
        const line = lines[i]!;
        const t = line.text;
        if (fence) {
            if (t.trimStart().startsWith(fence)) fence = null;
            continue;
        }
        const f = FENCE_RE.exec(t);
        if (f) {
            fence = f[1]!.slice(0, 3);
            continue;
        }
        if (math) {
            if (t.trim().startsWith("$$")) math = false;
            continue;
        }
        if (t.trim() === "$$") {
            math = true;
            continue;
        }
        if (multiComment) {
            if (t.includes("%%")) multiComment = false;
            continue;
        }
        if (t.trim().startsWith("%%") && (t.match(/%%/g)?.length ?? 0) === 1) {
            multiComment = true;
            continue;
        }
        const h = HEADING_RE.exec(t);
        if (h) {
            headings.push({ from: line.from, level: h[1]!.length });
        }
        const d = DEF_RE.exec(t);
        if (d) {
            // Its continuation: indented, non-blank lines right after.
            let last = i;
            while (
                last + 1 < lines.length &&
                /^(?: {2,}|\t)\S/.test(lines[last + 1]!.text) &&
                !DEF_RE.test(lines[last + 1]!.text)
            )
                last++;
            const labelFrom = line.from + t.indexOf("[^");
            const labelTo = labelFrom + d[1]!.length + 3;
            const bodyFrom = line.from + d[0].length;
            const to = lines[last]!.to;
            defs.push({
                label: d[1]!,
                from: line.from,
                to,
                labelFrom,
                labelTo,
                bodyFrom,
                body: text.slice(bodyFrom, to),
            });
            i = last;
            continue;
        }
        const skip = skippedSpans(t);
        REF_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = REF_RE.exec(t)) !== null) {
            const at = m.index;
            if (skip.some(([a, b]) => at >= a && at < b)) continue;
            refs.push({
                label: m[1]!,
                from: line.from + at,
                to: line.from + at + m[0].length,
            });
        }
    }
    return { refs, defs, headings, start };
}

/** A change of the text (positions in the text before any change). */
export interface TextChange {
    from: number;
    to: number;
    insert: string;
}

export interface NormalizeOptions {
    /** Definitions end their part before a heading of this level or higher (1–6). */
    level: number;
    /**
     * Labels whose references were deleted just now: their definitions go
     * too (else a definition without a reference stays, out of the
     * numbering).
     */
    deleted?: ReadonlySet<string>;
}

/** Where each part of the note ends: before its heading, or at the end. */
function partEnds(scan: FootnoteScan, text: string, level: number): number[] {
    return [
        ...scan.headings.filter((h) => h.level <= level).map((h) => h.from),
        text.length,
    ];
}

function partOf(ends: number[], pos: number): number {
    for (let i = 0; i < ends.length; i++) if (pos < ends[i]!) return i;
    return ends.length - 1;
}

/**
 * The changes that put a note's footnotes in order: references numbered
 * 1, 2, … by their first appearance (a label used twice keeps one
 * number); each definition at the end of the part its reference is in,
 * the part's definitions in number order, a blank line before them and
 * before the next heading. Definitions without a reference: removed when
 * their reference was just deleted, else kept where they are and numbered
 * after the others (so they never take a number in use). Empty when all is
 * in order already.
 */
export function normalizeFootnotes(
    text: string,
    opts: NormalizeOptions,
): TextChange[] {
    const scan = scanFootnotes(text);
    if (!scan.refs.length && !scan.defs.length) return [];
    const numberOf = new Map<string, string>();
    for (const r of scan.refs) {
        if (!numberOf.has(r.label))
            numberOf.set(r.label, String(numberOf.size + 1));
    }
    // A label defined twice: the first counts, the others are like orphans.
    const defOf = new Map<string, FootnoteDef>();
    const orphans: FootnoteDef[] = [];
    for (const d of scan.defs) {
        if (numberOf.has(d.label) && !defOf.has(d.label)) defOf.set(d.label, d);
        else orphans.push(d);
    }
    let next = numberOf.size;
    const orphanLabel = new Map<FootnoteDef, string>();
    for (const d of orphans) {
        // Its reference was just deleted: it goes too.
        if (opts.deleted?.has(d.label) && !numberOf.has(d.label)) continue;
        // Numbers out of the way; other labels as they are.
        orphanLabel.set(d, /^\d+$/.test(d.label) ? String(++next) : d.label);
    }

    const changes: TextChange[] = [];
    for (const r of scan.refs) {
        const n = numberOf.get(r.label)!;
        if (n !== r.label)
            changes.push({ from: r.from + 2, to: r.to - 1, insert: n });
    }

    // The parts, and the definitions each should end with.
    const ends = partEnds(scan, text, opts.level);
    const wanted: string[][] = ends.map(() => []);
    const firstRef = new Map<string, number>();
    for (const r of scan.refs) if (!firstRef.has(r.label)) firstRef.set(r.label, r.from);
    for (const [label, pos] of firstRef) wanted[partOf(ends, pos)]!.push(label);
    for (const list of wanted)
        list.sort((a, b) => Number(numberOf.get(a)) - Number(numberOf.get(b)));

    const defText = (d: FootnoteDef, label: string) =>
        `[^${label}]: ${text.slice(d.bodyFrom, d.to)}`;
    const emptyDef = (label: string) => `[^${label}]: `;
    // Each part's area: its last lines that are definitions or blank. It is
    // written anew when it does not hold what it should.
    const inSomeArea = new Set<FootnoteDef>();
    ends.forEach((end, p) => {
        const partStart = p === 0 ? scan.start : ends[p - 1]!;
        const inPart = scan.defs
            .filter((d) => d.from >= partStart && d.to <= end)
            .sort((a, b) => a.from - b.from);
        let areaFrom = end;
        for (let k = inPart.length - 1; k >= 0; k--) {
            const d = inPart[k]!;
            if (text.slice(d.to, areaFrom).trim() !== "") break;
            areaFrom = d.from;
        }
        const areaDefs = inPart.filter((d) => d.from >= areaFrom);
        for (const d of areaDefs) inSomeArea.add(d);
        const lines = wanted[p]!.map((label) => {
            const n = numberOf.get(label)!;
            const d = defOf.get(label);
            return d ? defText(d, n) : emptyDef(n);
        });
        // Orphans standing in the area stay in it, after the others.
        for (const d of areaDefs) {
            const label = orphanLabel.get(d);
            if (label !== undefined) lines.push(defText(d, label));
        }
        const isLast = p === ends.length - 1;
        let area: string;
        if (!lines.length) {
            if (!areaDefs.length) return;
            // Emptied: the blank lines before it go too, but for one line
            // break (the note's end) or a blank line (before the heading).
            const before = text.slice(scan.start, areaFrom);
            const trailing = /\n*$/.exec(before)![0].length;
            const keep = before.length === trailing ? "" : isLast ? "\n" : "\n\n";
            changes.push({ from: areaFrom - trailing, to: end, insert: keep });
            return;
        } else {
            const before = text.slice(scan.start, areaFrom);
            const trailing = /\n*$/.exec(before)![0].length;
            const prefix =
                before.length === 0 ? "" : "\n".repeat(Math.max(0, 2 - trailing));
            area = `${prefix}${lines.join("\n")}\n${isLast ? "" : "\n"}`;
            // More than one blank line before it: one.
            const extra = before.length === trailing ? 0 : Math.max(0, trailing - 2);
            if (extra) {
                changes.push({ from: areaFrom - extra, to: end, insert: area });
                return;
            }
        }
        if (text.slice(areaFrom, end) !== area)
            changes.push({ from: areaFrom, to: end, insert: area });
    });

    // Definitions elsewhere (moved away from their reference, or written
    // there by hand): taken out, with one of two blank lines around them.
    // Orphans there stay (numbered out of the way).
    for (const d of scan.defs) {
        if (inSomeArea.has(d)) continue;
        const label = orphanLabel.get(d);
        if (label !== undefined) {
            if (label !== d.label)
                changes.push({ from: d.labelFrom + 2, to: d.labelTo - 1, insert: label });
            continue;
        }
        let from = d.from;
        let to = d.to;
        if (text[to] === "\n") to++;
        const blankBefore =
            from > 0 && (from === 1 || text.slice(from - 2, from) === "\n\n");
        if (blankBefore && text[to] === "\n") to++;
        else if (to >= text.length && from > 0 && text[from - 1] === "\n") from--;
        changes.push({ from, to, insert: "" });
    }
    return mergeChanges(changes);
}

/** Changes in order (they never overlap: areas hold no references). */
function mergeChanges(changes: TextChange[]): TextChange[] {
    return [...changes].sort((a, b) => a.from - b.from || a.to - b.to);
}

/** The text with changes applied (for tests and for checking). */
export function applyChanges(text: string, changes: TextChange[]): string {
    let out = "";
    let at = 0;
    for (const c of [...changes].sort((a, b) => a.from - b.from)) {
        out += text.slice(at, c.from) + c.insert;
        at = c.to;
    }
    return out + text.slice(at);
}

/* ---------------------------- citation notes ---------------------------- */

/** One work cited in a note. */
export interface ClusterItem {
    citekey: string;
    /** "45", "45–47"; "" for none. */
    locator: string;
    /** The locator's CSL label ("page", "chapter", …); "page" when none is written. */
    label: string;
    /** Text before it ("see", "cf."). */
    prefix: string;
    /** Text after the locator, with its separator (", emphasis added"). */
    suffix: string;
    /** `-@key`: without the author's name. */
    suppressAuthor?: boolean;
}

/** A citation of one work, without a locator: for building clusters. */
export function clusterItem(citekey: string, locator?: Locator | null): ClusterItem {
    return {
        citekey,
        locator: locator?.locator ?? "",
        label: locator?.label ?? "page",
        prefix: "",
        suffix: "",
    };
}

const CITEKEY =
    "[\\p{L}\\p{N}_](?:[\\p{L}\\p{N}_:.#$%&+?<>~/-]*[\\p{L}\\p{N}_])?";
const ITEM_RE = new RegExp(
    `^(?<prefix>[^@]*?)\\s*(?<suppress>-)?@(?<key>${CITEKEY})(?<rest>[^@]*)$`,
    "u",
);

/**
 * Pandoc's locator terms (its CSL locale's, short and long), with the CSL
 * label each stands for; the first two are the forms written (singular,
 * plural). German abbreviations are read too, and written as Pandoc's.
 */
const LOCATOR_TERMS: { label: string; write: [string, string]; read: string[] }[] = [
    { label: "page", write: ["p.", "pp."], read: ["pages", "page", "pp.", "p.", "Seiten", "Seite", "S."] },
    { label: "chapter", write: ["chap.", "chaps."], read: ["chapters", "chapter", "chaps.", "chap.", "ch.", "Kap."] },
    { label: "section", write: ["sec.", "secs."], read: ["sections", "section", "secs.", "sec.", "§§", "§"] },
    { label: "paragraph", write: ["para.", "paras."], read: ["paragraphs", "paragraph", "paras.", "para.", "¶¶", "¶", "Abs."] },
    { label: "volume", write: ["vol.", "vols."], read: ["volumes", "volume", "vols.", "vol.", "Bd."] },
    { label: "figure", write: ["fig.", "figs."], read: ["figures", "figure", "figs.", "fig.", "Abb."] },
    { label: "note", write: ["n.", "nn."], read: ["notes", "note", "nn.", "n.", "Anm."] },
    { label: "line", write: ["l.", "ll."], read: ["lines", "line", "ll.", "l.", "Z."] },
    { label: "column", write: ["col.", "cols."], read: ["columns", "column", "cols.", "col.", "Sp."] },
    { label: "folio", write: ["fol.", "fols."], read: ["folios", "folio", "fols.", "fol."] },
    { label: "number", write: ["no.", "nos."], read: ["numbers", "number", "nos.", "no.", "Nr."] },
    { label: "opus", write: ["op.", "opp."], read: ["opera", "opus", "opp.", "op."] },
    { label: "part", write: ["pt.", "pts."], read: ["parts", "part", "pts.", "pt.", "Tl."] },
    { label: "verse", write: ["v.", "vv."], read: ["verses", "verse", "vv.", "v."] },
    { label: "book", write: ["bk.", "bks."], read: ["books", "book", "bks.", "bk."] },
    { label: "sub-verbo", write: ["s.v.", "s.vv."], read: ["sub verbis", "sub verbo", "s.vv.", "s.v."] },
];

const TERM_RE = new RegExp(
    `^(?<term>${LOCATOR_TERMS.flatMap((t) => t.read)
        .sort((a, b) => b.length - a.length)
        .map((r) => r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + (/[a-z]$/i.test(r) ? "\\b" : ""))
        .join("|")})\\s*`,
    "iu",
);
const NUM = "[\\p{N}]+[a-z]?|[ivxlcdm]+\\b|[IVXLCDM]+\\b";
const LOCATOR_VALUE_RE = new RegExp(
    `^(?:${NUM})(?:\\s*[-–—]\\s*(?:${NUM}))?(?:\\s*,\\s*(?:${NUM})(?:\\s*[-–—]\\s*(?:${NUM}))?)*(?:\\s*ff?\\.)?`,
    "u",
);

/** A locator: the CSL label and what follows it ("page", "23–25"). */
export interface Locator {
    label: string;
    locator: string;
}

/**
 * A locator and what comes after it, as Pandoc reads one: a term (or none:
 * a page) and numbers ("p. 23", "pp. 23–25, 30", "chap. 3", "23ff."); the
 * rest is the suffix, with its own separator (", emphasis added", " and
 * passim"), as CSL takes it. Null locator when there is none: all of it is
 * the suffix.
 */
export function parseLocator(
    text: string,
    /** Typed where a page is asked for: a Roman numeral is a page too. */
    opts: { asked?: boolean } = {},
): { locator: Locator | null; suffix: string } {
    let rest = text.trim();
    let label = "page";
    let termed = false;
    const t = TERM_RE.exec(rest);
    if (t?.groups) {
        const term = t.groups.term!;
        const found = LOCATOR_TERMS.find((x) => x.read.some((r) => r.toLowerCase() === term.toLowerCase() && (r === "S." ? term === "S." : true)));
        if (found) {
            label = found.label;
            termed = true;
            rest = rest.slice(t[0].length);
        }
    }
    const v = LOCATOR_VALUE_RE.exec(rest);
    // Without a term only numbers make a locator ("emphasis added" is not one).
    if (!v || (!termed && !opts.asked && !/^[\p{N}]/u.test(rest))) {
        return termed
            ? { locator: { label, locator: rest.trim() }, suffix: "" }
            : { locator: null, suffix: text.trim() ? `, ${text.trim()}` : "" };
    }
    const locator = v[0].trim();
    const after = rest.slice(v[0].length);
    const tail = after.trim();
    const suffix = !tail ? "" : /^\s*,/.test(after) ? `, ${tail.replace(/^,\s*/, "")}` : ` ${tail}`;
    return { locator: { label, locator }, suffix };
}

/** The term written before a locator: Pandoc's short form ("p.", "pp."). */
export function locatorTerm(label: string, locator: string): string {
    const t = LOCATOR_TERMS.find((x) => x.label === label) ?? LOCATOR_TERMS[0]!;
    const plural = /[-–—,&]|\band\b|ff?\.$/.test(locator);
    return t.write[plural ? 1 : 0];
}

function parseItem(part: string): ClusterItem | null {
    const m = ITEM_RE.exec(part.trim());
    if (!m?.groups) return null;
    const rest = m.groups.rest!.trim();
    let locator: Locator | null = null;
    let suffix = "";
    if (rest) {
        // After the key only ", locator, suffix" (else it is a sentence).
        if (!rest.startsWith(",")) return null;
        ({ locator, suffix } = parseLocator(rest.slice(1)));
    }
    return {
        citekey: m.groups.key!,
        locator: locator?.locator ?? "",
        label: locator?.label ?? "page",
        prefix: m.groups.prefix!.trim(),
        suffix,
        ...(m.groups.suppress ? { suppressAuthor: true } : {}),
    };
}

/**
 * A definition's body as a citation cluster, in Pandoc's form —
 * `[see @heims1991, p. 23; @gerhards, pp. 7–9]` — or the bare one beta.17 to
 * beta.20 wrote (`@heims1991, 23; @gerhards`). Null when the body is
 * anything else (a footnote of one's own words).
 */
export function parseCluster(body: string): ClusterItem[] | null {
    let text = body.trim();
    if (!text.includes("@") || text.includes("\n")) return null;
    const bracketed = /^\[([^[\]]*)\]\.?$/.exec(text);
    if (bracketed) text = bracketed[1]!;
    else if (/[[\]]/.test(text)) return null;
    else text = text.replace(/\.$/, "");
    const items: ClusterItem[] = [];
    for (const part of text.split(";")) {
        const item = parseItem(part);
        if (!item) return null;
        items.push(item);
    }
    return items.length ? items : null;
}

/** One work as Pandoc writes it: `see @key, p. 23, suffix`. */
export function formatItem(i: ClusterItem): string {
    const loc = i.locator ? `, ${locatorTerm(i.label, i.locator)} ${i.locator}` : "";
    return `${i.prefix ? `${i.prefix} ` : ""}${i.suppressAuthor ? "-" : ""}@${i.citekey}${loc}${i.suffix}`;
}

/** A cluster written back as a body: Pandoc's citation, `[@a, p. 2; @b]`. */
export function formatCluster(items: readonly ClusterItem[]): string {
    return `[${items.map(formatItem).join("; ")}]`;
}

/**
 * Citation footnotes still in the bare form (`@key, 23`, beta.17 to
 * beta.20) rewritten in Pandoc's (`[@key, p. 23]`); those in brackets
 * already are left as written.
 */
export function pandocCitationChanges(text: string): TextChange[] {
    const changes: TextChange[] = [];
    for (const d of scanFootnotes(text).defs) {
        const body = text.slice(d.bodyFrom, d.to);
        if (body.trimStart().startsWith("[")) continue;
        const items = parseCluster(body);
        if (items) changes.push({ from: d.bodyFrom, to: d.to, insert: formatCluster(items) });
    }
    return changes;
}

/* ------------------------------ copy, paste ----------------------------- */

/** The definitions of the references in `[from, to)` (label → body). */
export function definitionsFor(
    text: string,
    from: number,
    to: number,
): Map<string, string> {
    const scan = scanFootnotes(text);
    const wanted = new Set(
        scan.refs.filter((r) => r.from >= from && r.to <= to).map((r) => r.label),
    );
    const out = new Map<string, string>();
    for (const d of scan.defs) {
        if (wanted.has(d.label) && !out.has(d.label)) out.set(d.label, d.body);
    }
    return out;
}

let pasteCounter = 0;

/**
 * Pasted text made ready: its references given labels of their own (they
 * never join a footnote of the note they are pasted into), its definitions
 * (those written in it, else those copied with it) taken out to be added
 * at the end. The labels are numbered by the next normalization.
 */
export function preparePaste(
    pasted: string,
    copiedDefs: ReadonlyMap<string, string> = new Map(),
): { body: string; defs: string[] } {
    const scan = scanFootnotes(pasted);
    const own = new Map<string, string>();
    const take: [number, number][] = [];
    for (const d of scan.defs) {
        if (!own.has(d.label)) own.set(d.label, d.body);
        let to = d.to;
        if (pasted[to] === "\n") to++;
        take.push([d.from, to]);
    }
    const fresh = new Map<string, string>();
    const labelFor = (label: string) => {
        let l = fresh.get(label);
        if (!l) {
            l = `zfp${++pasteCounter}`;
            fresh.set(label, l);
        }
        return l;
    };
    const changes: TextChange[] = [];
    for (const r of scan.refs)
        changes.push({ from: r.from + 2, to: r.to - 1, insert: labelFor(r.label) });
    for (const [from, to] of take) changes.push({ from, to, insert: "" });
    const body = applyChanges(pasted, changes).replace(/\n+$/, (m) =>
        pasted.endsWith(m) ? m : "",
    );
    const defs: string[] = [];
    for (const [label, l] of fresh) {
        const b = own.get(label) ?? copiedDefs.get(label);
        if (b !== undefined) defs.push(`[^${l}]: ${b}`);
    }
    return { body: body.replace(/\n{3,}$/, "\n\n"), defs };
}

/** Whether a line is being written as a footnote marker (`[^…` or a definition's start). */
export function editingMarker(lineBeforeCursor: string): boolean {
    return (
        /\[\^[^\]\s]*$/.test(lineBeforeCursor) ||
        /^ {0,3}\[\^[^\]\s]+\]$/.test(lineBeforeCursor)
    );
}

/** Labels of whole references in some text (deleted text, say). */
export function refLabels(text: string): string[] {
    const out: string[] = [];
    REF_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = REF_RE.exec(text)) !== null) out.push(m[1]!);
    return out;
}

/**
 * A short title for later notes when the item has none (Zotero's "Short
 * Title" field, CSL `title-short`): the main title, before its subtitle
 * (`Title: Subtitle`, `Question? Subtitle`). Null when there is no
 * subtitle to drop — the style then repeats the title.
 */
export function mainTitle(title: string): string | null {
    const m = /^(.+?)(?::|([?!]))\s+\S/.exec(title);
    if (!m) return null;
    const main = (m[1]! + (m[2] ?? "")).trim();
    return main && main.length < title.trim().length ? main : null;
}
