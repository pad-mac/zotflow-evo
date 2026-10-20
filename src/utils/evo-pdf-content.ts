/**
 * ZotFlow Evo (fork): reading a PDF content stream far enough to tell its
 * text apart — text that is drawn (born-digital pages) from text that is
 * invisible (render mode 3: a text layer from OCR) — and to take the
 * invisible text out, for OCR (see evo-pdf-ocr-layer.ts). Pure: bytes in,
 * bytes out. Not a full content stream parser: operators and their
 * operands, strings, names, arrays, dictionaries, inline images.
 */

/** Text render modes that draw nothing (3: invisible; 7: clip only). */
const INVISIBLE_MODES = new Set([3, 7]);

interface Token {
    /** "op": an operator; else an operand. */
    kind: "op" | "operand";
    start: number;
    end: number;
    /** The operator, or the operand's text (strings: their bytes as given). */
    text: string;
}

const WHITE = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);

function latin1(bytes: Uint8Array): string {
    let out = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK)
        out += String.fromCharCode(
            ...bytes.subarray(i, Math.min(bytes.length, i + CHUNK)),
        );
    return out;
}

function fromLatin1(text: string): Uint8Array {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
    return out;
}

/** The tokens of a content stream (as a Latin-1 string). */
function tokenize(s: string): Token[] {
    const tokens: Token[] = [];
    const n = s.length;
    let i = 0;
    while (i < n) {
        const c = s.charCodeAt(i);
        if (WHITE.has(c)) {
            i++;
            continue;
        }
        const start = i;
        if (c === 37) {
            // % comment
            while (i < n && s[i] !== "\n" && s[i] !== "\r") i++;
            continue;
        }
        if (c === 40) {
            // ( literal string ), nested, with escapes
            let depth = 1;
            i++;
            while (i < n && depth > 0) {
                const ch = s[i];
                if (ch === "\\") i += 2;
                else {
                    if (ch === "(") depth++;
                    else if (ch === ")") depth--;
                    i++;
                }
            }
            tokens.push({
                kind: "operand",
                start,
                end: i,
                text: s.slice(start, i),
            });
            continue;
        }
        if (c === 60) {
            if (s[i + 1] === "<") {
                tokens.push({ kind: "operand", start, end: i + 2, text: "<<" });
                i += 2;
                continue;
            }
            const close = s.indexOf(">", i);
            i = close < 0 ? n : close + 1;
            tokens.push({
                kind: "operand",
                start,
                end: i,
                text: s.slice(start, i),
            });
            continue;
        }
        if (c === 62) {
            i += s[i + 1] === ">" ? 2 : 1;
            tokens.push({ kind: "operand", start, end: i, text: ">>" });
            continue;
        }
        if (c === 91 || c === 93 || c === 123 || c === 125) {
            i++;
            tokens.push({ kind: "operand", start, end: i, text: s[start]! });
            continue;
        }
        if (c === 41) {
            // A stray ")": skip it.
            i++;
            continue;
        }
        if (c === 47) {
            i++;
            while (
                i < n &&
                !WHITE.has(s.charCodeAt(i)) &&
                !DELIM.has(s.charCodeAt(i))
            )
                i++;
            tokens.push({
                kind: "operand",
                start,
                end: i,
                text: s.slice(start, i),
            });
            continue;
        }
        while (
            i < n &&
            !WHITE.has(s.charCodeAt(i)) &&
            !DELIM.has(s.charCodeAt(i))
        )
            i++;
        const word = s.slice(start, i);
        if (
            /^[+-]?(\d+\.?\d*|\.\d+)$/.test(word) ||
            word === "true" ||
            word === "false" ||
            word === "null"
        ) {
            tokens.push({ kind: "operand", start, end: i, text: word });
            continue;
        }
        if (word === "BI") {
            // An inline image: its dictionary, ID, its data, EI.
            const id = s.slice(i).search(/\sID[\s]/);
            if (id < 0) {
                i = n;
            } else {
                const dataStart = i + id + 4;
                const ei = s.slice(dataStart).search(/\sEI(?=[\s]|$)/);
                i = ei < 0 ? n : dataStart + ei + 3;
            }
            tokens.push({ kind: "op", start, end: i, text: "BI" });
            continue;
        }
        tokens.push({ kind: "op", start, end: i, text: word });
    }
    return tokens;
}

/** How many characters a string operand shows (bytes; two per hex pair). */
function stringLength(text: string): number {
    if (text.startsWith("(")) {
        let count = 0;
        for (let i = 1; i < text.length - 1; i++) {
            if (text[i] === "\\") i++;
            count++;
        }
        return count;
    }
    if (text.startsWith("<"))
        return Math.floor(text.replace(/[^0-9a-fA-F]/g, "").length / 2);
    return 0;
}

export interface TextSummary {
    /** Characters drawn (any visible render mode). */
    visible: number;
    /** Characters shown invisibly (render mode 3 or 7). */
    invisible: number;
    /** XObjects drawn (`Do`), with the render mode at that point. */
    xobjects: { name: string; mode: number }[];
}

interface Walk {
    tokens: Token[];
    /** Per operator token index: the render mode in force, and its operands' first token. */
    shows: {
        index: number;
        operandsFrom: number;
        mode: number;
        chars: number;
    }[];
    summary: TextSummary;
}

function walk(s: string, initialMode = 0): Walk {
    const tokens = tokenize(s);
    const summary: TextSummary = { visible: 0, invisible: 0, xobjects: [] };
    const shows: Walk["shows"] = [];
    const stack: number[] = [];
    let mode = initialMode;
    let operandsFrom = 0;
    for (let t = 0; t < tokens.length; t++) {
        const token = tokens[t]!;
        if (token.kind === "operand") continue;
        const operands = tokens.slice(operandsFrom, t);
        switch (token.text) {
            case "q":
                stack.push(mode);
                break;
            case "Q":
                if (stack.length) mode = stack.pop()!;
                break;
            case "Tr": {
                const v = Number(operands[operands.length - 1]?.text);
                if (Number.isFinite(v)) mode = v;
                break;
            }
            case "Tj":
            case "'":
            case '"':
            case "TJ": {
                const chars = operands.reduce(
                    (n, o) => n + stringLength(o.text),
                    0,
                );
                if (INVISIBLE_MODES.has(mode)) summary.invisible += chars;
                else summary.visible += chars;
                shows.push({ index: t, operandsFrom, mode, chars });
                break;
            }
            case "Do": {
                const name = operands[operands.length - 1]?.text;
                if (name?.startsWith("/"))
                    summary.xobjects.push({ name: name.slice(1), mode });
                break;
            }
        }
        operandsFrom = t + 1;
    }
    return { tokens, shows, summary };
}

/** What text a content stream shows, and which XObjects it draws. */
export function summarizeText(bytes: Uint8Array, initialMode = 0): TextSummary {
    return walk(latin1(bytes), initialMode).summary;
}

/**
 * The content stream without its invisible text (render mode 3; clip-only
 * text, mode 7, is left: it may clip what is drawn). The text state stays
 * as it was (`'` and `"` become the line moves they include); null when
 * there was none.
 */
export function stripInvisibleText(
    bytes: Uint8Array,
    initialMode = 0,
): Uint8Array | null {
    const s = latin1(bytes);
    const { tokens, shows } = walk(s, initialMode);
    const cut = shows.filter((sh) => sh.mode === 3);
    if (!cut.length) return null;
    let out = "";
    let at = 0;
    for (const sh of cut) {
        const op = tokens[sh.index]!;
        const first = tokens[sh.operandsFrom] ?? op;
        out += s.slice(at, first.start);
        if (op.text === "'") out += "T*";
        else if (op.text === '"') {
            const operands = tokens.slice(sh.operandsFrom, sh.index);
            const aw = operands[0]?.text ?? "0";
            const ac = operands[1]?.text ?? "0";
            out += `${aw} Tw ${ac} Tc T*`;
        }
        at = op.end;
    }
    out += s.slice(at);
    return fromLatin1(out);
}
