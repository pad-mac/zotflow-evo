/**
 * ZotFlow Evo (fork): a PDF's page labels (the page numbers it shows, such
 * as "iv" or "245") and its outline (bookmarks), read and written with
 * pdf-lib for the editing menu's page numbers and outline editors.
 *
 * Page labels are the catalog's /PageLabels number tree: from a page on
 * (0-based), a style (/S: D decimal, r/R roman, a/A letters), a prefix
 * (/P) and the first number (/St, 1 if missing).
 */
import {
    PDFArray,
    PDFDict,
    PDFDocument,
    PDFHexString,
    PDFName,
    PDFNumber,
    PDFRef,
    PDFString,
} from "pdf-lib";

/** One range of page labels as the editor sets it. */
export interface PageLabelRange {
    /** The page (0-based) the range starts on. */
    start: number;
    /** "D": 1, 2, 3; "r": i, ii, iii. */
    style: "D" | "r";
    /** The number of its first page (1 if not given). */
    first?: number;
}

/** One outline entry as the editor sets it. */
export interface OutlineEntry {
    title: string;
    /** The page (0-based) it goes to. */
    page: number;
    /** 0: top level; 1: under the entry before at level 0; … */
    level: number;
}

export function toRoman(n: number): string {
    if (!Number.isInteger(n) || n <= 0 || n >= 4000) return String(n);
    const table: [number, string][] = [
        [1000, "m"],
        [900, "cm"],
        [500, "d"],
        [400, "cd"],
        [100, "c"],
        [90, "xc"],
        [50, "l"],
        [40, "xl"],
        [10, "x"],
        [9, "ix"],
        [5, "v"],
        [4, "iv"],
        [1, "i"],
    ];
    let out = "";
    for (const [value, letters] of table) {
        while (n >= value) {
            out += letters;
            n -= value;
        }
    }
    return out;
}

function toLetters(n: number): string {
    // PDF: a…z, then aa…zz, aaa…
    if (n <= 0) return "";
    const letter = String.fromCharCode(97 + ((n - 1) % 26));
    return letter.repeat(Math.floor((n - 1) / 26) + 1);
}

function labelOf(style: string | null, prefix: string, n: number): string {
    switch (style) {
        case "D":
            return prefix + String(n);
        case "r":
            return prefix + toRoman(n);
        case "R":
            return prefix + toRoman(n).toUpperCase();
        case "a":
            return prefix + toLetters(n);
        case "A":
            return prefix + toLetters(n).toUpperCase();
        default:
            return prefix;
    }
}

/** The labels of `count` pages from ranges as the editor sets them ("1", "2"… where none). */
export function labelsFromRanges(
    ranges: readonly PageLabelRange[],
    count: number,
): string[] {
    const sorted = [...ranges]
        .filter(
            (r) => Number.isInteger(r.start) && r.start >= 0 && r.start < count,
        )
        .sort((a, b) => a.start - b.start);
    const labels: string[] = [];
    for (let i = 0; i < count; i++) {
        let range: PageLabelRange | undefined;
        for (const r of sorted) if (r.start <= i) range = r;
        labels.push(
            range
                ? labelOf(range.style, "", (range.first ?? 1) + i - range.start)
                : String(i + 1),
        );
    }
    return labels;
}

function textOf(value: unknown): string {
    if (value instanceof PDFString || value instanceof PDFHexString)
        return value.decodeText();
    return "";
}

/** The page labels the PDF shows ("1", "2"… for a PDF without any). */
export function readPageLabels(doc: PDFDocument): string[] {
    const count = doc.getPageCount();
    const plain = Array.from({ length: count }, (_, i) => String(i + 1));
    const root = doc.catalog.lookupMaybe(PDFName.of("PageLabels"), PDFDict);
    if (!root) return plain;
    const entries: { start: number; dict: PDFDict }[] = [];
    const walk = (node: PDFDict, depth: number) => {
        if (depth > 32) return;
        const nums = node.lookupMaybe(PDFName.of("Nums"), PDFArray);
        if (nums) {
            for (let i = 0; i + 1 < nums.size(); i += 2) {
                const start = nums.lookup(i);
                const dict = nums.lookup(i + 1);
                if (start instanceof PDFNumber && dict instanceof PDFDict)
                    entries.push({ start: start.asNumber(), dict });
            }
        }
        const kids = node.lookupMaybe(PDFName.of("Kids"), PDFArray);
        if (kids) {
            for (let i = 0; i < kids.size(); i++) {
                const kid = kids.lookup(i);
                if (kid instanceof PDFDict) walk(kid, depth + 1);
            }
        }
    };
    walk(root, 0);
    if (!entries.length) return plain;
    entries.sort((a, b) => a.start - b.start);
    const labels: string[] = [];
    for (let i = 0; i < count; i++) {
        let entry: { start: number; dict: PDFDict } | undefined;
        for (const e of entries) if (e.start <= i) entry = e;
        if (!entry) {
            labels.push(String(i + 1));
            continue;
        }
        const s = entry.dict.get(PDFName.of("S"));
        const style = s instanceof PDFName ? s.asString().slice(1) : null;
        const prefix = textOf(entry.dict.lookup(PDFName.of("P")));
        const st = entry.dict.lookup(PDFName.of("St"));
        const first = st instanceof PDFNumber ? st.asNumber() : 1;
        labels.push(labelOf(style, prefix, first + i - entry.start));
    }
    return labels;
}

/** Set the page labels (an empty list removes them). */
export function writePageLabels(
    doc: PDFDocument,
    ranges: readonly PageLabelRange[],
): void {
    const count = doc.getPageCount();
    const sorted = [...ranges]
        .filter(
            (r) => Number.isInteger(r.start) && r.start >= 0 && r.start < count,
        )
        .sort((a, b) => a.start - b.start);
    if (!sorted.length) {
        doc.catalog.delete(PDFName.of("PageLabels"));
        return;
    }
    const ctx = doc.context;
    const nums: unknown[] = [];
    // Pages before the first range keep plain numbers.
    if (sorted[0]!.start > 0) nums.push(0, ctx.obj({ S: PDFName.of("D") }));
    for (const r of sorted) {
        const dict: Record<string, unknown> = { S: PDFName.of(r.style) };
        if ((r.first ?? 1) !== 1)
            dict.St = Math.max(1, Math.round(r.first ?? 1));
        nums.push(r.start, ctx.obj(dict as never));
    }
    doc.catalog.set(
        PDFName.of("PageLabels"),
        ctx.register(ctx.obj({ Nums: nums as never })),
    );
}

/**
 * Set the outline (bookmarks). Levels deeper than one more than the entry
 * before are taken as one more. An empty list removes the outline.
 */
export function writeOutline(
    doc: PDFDocument,
    entries: readonly OutlineEntry[],
): void {
    const ctx = doc.context;
    const pages = doc.getPages();
    doc.catalog.delete(PDFName.of("Outlines"));
    const mode = doc.catalog.get(PDFName.of("PageMode"));
    const valid = entries.filter(
        (e) => e.title.trim() && Number.isInteger(e.page) && pages[e.page],
    );
    if (!valid.length) {
        if (mode instanceof PDFName && mode.asString() === "/UseOutlines")
            doc.catalog.set(PDFName.of("PageMode"), PDFName.of("UseNone"));
        return;
    }
    interface Node {
        dict: PDFDict;
        ref: PDFRef;
        children: Node[];
    }
    const root: Node = {
        dict: ctx.obj({ Type: PDFName.of("Outlines") }),
        ref: null as unknown as PDFRef,
        children: [],
    };
    root.ref = ctx.register(root.dict);
    const stack: Node[] = [root];
    for (const e of valid) {
        const level = Math.max(0, Math.min(e.level, stack.length - 1));
        stack.length = level + 1;
        const parent = stack[level]!;
        const dict = ctx.obj({});
        dict.set(PDFName.of("Title"), PDFHexString.fromText(e.title.trim()));
        dict.set(PDFName.of("Parent"), parent.ref);
        dict.set(
            PDFName.of("Dest"),
            ctx.obj([pages[e.page]!.ref, PDFName.of("XYZ"), null, null, null]),
        );
        const node: Node = { dict, ref: ctx.register(dict), children: [] };
        parent.children.push(node);
        stack.push(node);
    }
    // Links between siblings, first and last, and the open counts.
    const link = (node: Node): number => {
        const kids = node.children;
        let visible = 0;
        kids.forEach((kid, i) => {
            if (i > 0) kid.dict.set(PDFName.of("Prev"), kids[i - 1]!.ref);
            if (i < kids.length - 1)
                kid.dict.set(PDFName.of("Next"), kids[i + 1]!.ref);
            visible += 1 + link(kid);
        });
        if (kids.length) {
            node.dict.set(PDFName.of("First"), kids[0]!.ref);
            node.dict.set(PDFName.of("Last"), kids[kids.length - 1]!.ref);
            node.dict.set(PDFName.of("Count"), PDFNumber.of(visible));
        }
        return visible;
    };
    link(root);
    doc.catalog.set(PDFName.of("Outlines"), root.ref);
}
