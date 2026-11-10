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
    /** Text before it ("see", "cf."). */
    prefix: string;
}

const CITEKEY =
    "[\\p{L}\\p{N}_](?:[\\p{L}\\p{N}_:.#$%&+?<>~/-]*[\\p{L}\\p{N}_])?";
const ITEM_RE = new RegExp(
    `^(?:(?<prefix>[^@;]*?)\\s+)?@(?<key>${CITEKEY})(?:\\s*,\\s*(?<locator>[^;]*?))?\\s*$`,
    "u",
);

/**
 * A definition's body as a citation cluster: works separated by ";", each
 * `[prefix] @key[, locator]` ("see @heims1991, 23; @gerhards"). Null when
 * the body is anything else (a footnote of one's own words).
 */
export function parseCluster(body: string): ClusterItem[] | null {
    const text = body.trim().replace(/\.$/, "");
    if (!text.includes("@") || text.includes("\n")) return null;
    const items: ClusterItem[] = [];
    for (const part of text.split(";")) {
        const m = ITEM_RE.exec(part.trim());
        if (!m?.groups) return null;
        items.push({
            citekey: m.groups.key!,
            locator: (m.groups.locator ?? "").replace(/^(?:pp?\.|S\.)\s*/i, "").trim(),
            prefix: (m.groups.prefix ?? "").trim(),
        });
    }
    return items.length ? items : null;
}

/** A cluster written back as a body. */
export function formatCluster(items: readonly ClusterItem[]): string {
    return items
        .map(
            (i) =>
                `${i.prefix ? `${i.prefix} ` : ""}@${i.citekey}${i.locator ? `, ${i.locator}` : ""}`,
        )
        .join("; ");
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
