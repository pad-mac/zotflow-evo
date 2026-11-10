/**
 * ZotFlow Evo (fork): numbered footnotes in the editor
 * (utils/evo-footnotes.ts has the rules).
 *
 * - Kept in order: an edit that touches a footnote marker or a heading is
 *   followed, in the same transaction (one undo), by the changes that
 *   number the footnotes 1, 2, … and put each part's definitions at its
 *   end. Not while a marker is being written (the cursor in `[^…`), nor
 *   during an IME composition (a dead key `^`): then when the cursor has
 *   left it. When the editor loses focus, the note is put in order too.
 *   Undo, redo and the note being reloaded from disk are left alone.
 * - Shown (Live Preview): references as a superscript [n] (the source where
 *   the cursor is); definitions as a block of notes, a number before each,
 *   a citation cluster as its formatted note.
 * - Copy keeps the definitions of what was copied, so pasting it into a
 *   note brings them along (preparePaste()).
 * - Commands: insert a footnote, renumber; a citation footnote from the
 *   picker (citation-helper.ts).
 */
import {
    Annotation,
    EditorState,
    Prec,
    StateEffect,
    StateField,
    type Extension,
    type Range,
    type TransactionSpec,
} from "@codemirror/state";
import {
    Decoration,
    EditorView,
    ViewPlugin,
    WidgetType,
    type DecorationSet,
    type ViewUpdate,
} from "@codemirror/view";
import {
    HoverPopover,
    MarkdownRenderer,
    TFile,
    editorInfoField,
    editorLivePreviewField,
    sanitizeHTMLToDom,
    type Editor,
    type HoverParent,
    type MarkdownFileInfo,
    type MarkdownView,
    type Plugin,
} from "obsidian";

import { workerBridge } from "bridge";
import { services } from "services/services";
import {
    definitionsFor,
    editingMarker,
    normalizeFootnotes,
    parseCluster,
    preparePaste,
    scanFootnotes,
    type ClusterItem,
    type FootnoteScan,
    type TextChange,
} from "utils/evo-footnotes";

/* ------------------------------ keeping order ---------------------------- */

/** A transaction that puts the footnotes in order whatever the cursor. */
const forceOrder = Annotation.define<boolean>();

interface Pending {
    /** Something was left to put in order (a marker was being written). */
    pending: boolean;
    /** Labels whose references were deleted meanwhile. */
    deleted: string[];
}

const setPending = StateEffect.define<Pending>();

const pendingField = StateField.define<Pending>({
    create: () => ({ pending: false, deleted: [] }),
    update(value, tr) {
        for (const e of tr.effects) if (e.is(setPending)) return e.value;
        return value;
    },
});

/**
 * Whether the note was edited here since it was last put in order (only
 * such a note is put in order when the editor loses focus: a note just
 * looked at stays as it is).
 */
const editedField = StateField.define<boolean>({
    create: () => false,
    update(value, tr) {
        if (tr.annotation(forceOrder)) return false;
        if (tr.docChanged && !tr.isUserEvent("set")) return true;
        return value;
    },
});

function enabled(): boolean {
    return !!services.settings?.evoFootnotes;
}

function level(): number {
    const l = Number(services.settings?.evoFootnoteLevel);
    return Number.isInteger(l) && l >= 1 && l <= 6 ? l : 3;
}

/** A ZotFlow source note (zotflow-locked): generated, not ours to change. */
function locked(state: EditorState): boolean {
    if (state.doc.sliceString(0, 3) !== "---") return false;
    return /^---\s*[\s\S]*?zotflow-locked:\s*true/m.test(state.doc.sliceString(0, 4000));
}

/** Whether a change touched what footnotes hang on: a marker or a heading. */
function touchesFootnotes(del: string, ins: string, lineNow: string): boolean {
    return (
        /[[\]^]/.test(del) ||
        /[[\]^]/.test(ins) ||
        /(^|\n)#/.test(del) ||
        /(^|\n)#/.test(ins) ||
        /^#{1,6}[ \t]/.test(lineNow)
    );
}

const orderFilter = EditorState.transactionFilter.of((tr) => {
    if (!enabled()) return tr;
    const force = tr.annotation(forceOrder) === true;
    if (
        !force &&
        (tr.isUserEvent("undo") || tr.isUserEvent("redo") || tr.isUserEvent("set"))
    )
        return tr;
    const before = tr.startState.field(pendingField, false) ?? {
        pending: false,
        deleted: [],
    };
    let touched = force || before.pending;
    let removed = false;
    if (tr.docChanged) {
        tr.changes.iterChanges((fromA, toA, fromB, _toB, inserted) => {
            const del = tr.startState.doc.sliceString(fromA, toA);
            const ins = inserted.toString();
            const line = tr.newDoc.lineAt(fromB).text;
            if (touchesFootnotes(del, ins, line)) {
                touched = true;
                if (toA > fromA) removed = true;
            }
        });
    }
    if (!touched) return tr;
    if (locked(tr.state)) return tr;
    const text = tr.newDoc.toString();
    const stillThere = new Set(scanFootnotes(text).refs.map((r) => r.label));
    // References gone with this edit (whole, or a character of them: deleted
    // with Backspace one by one) — their definitions go when it is done.
    const deleted = new Set(before.deleted);
    if (removed) {
        for (const r of scanFootnotes(tr.startState.doc.toString()).refs)
            if (!stillThere.has(r.label)) deleted.add(r.label);
    }
    if (!text.includes("[^")) {
        return before.pending
            ? [tr, { effects: setPending.of({ pending: false, deleted: [] }) }]
            : tr;
    }
    // Still referenced after all (moved, or typed again): not deleted.
    for (const l of [...deleted]) if (stillThere.has(l)) deleted.delete(l);

    const head = tr.newSelection.main.head;
    const line = tr.newDoc.lineAt(head);
    const writing =
        !force &&
        (tr.isUserEvent("input.type.compose") ||
            editingMarker(line.text.slice(0, head - line.from)));
    if (writing) {
        return [
            tr,
            { effects: setPending.of({ pending: true, deleted: [...deleted] }) },
        ];
    }
    const changes = normalizeFootnotes(text, { level: level(), deleted });
    const spec: TransactionSpec = {
        effects: setPending.of({ pending: false, deleted: [] }),
        sequential: true,
    };
    if (changes.length) spec.changes = changes;
    return [tr, spec];
});

/* ----------------------------- citation notes ---------------------------- */

/**
 * Rendered notes (the HTML; null: cites a key not found here), by
 * Cluster.key: a note's form (full or short) depends on the notes before it.
 */
const rendered = new Map<string, string | null>();
const renderedOrder: string[] = [];
const inFlight = new Map<string, Promise<boolean>>();
let requestTimer: number | null = null;
const waiting = new Map<EditorView, FootnoteScan>();

const notesUpdated = StateEffect.define<null>();

interface Cluster {
    label: string;
    body: string;
    items: ClusterItem[];
    /** The style, this note and every citation note before it. */
    key: string;
}

/** A 53-bit string hash (cyrb53), as text. */
function hash(text: string): string {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < text.length; i++) {
        const ch = text.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function style(): string {
    return services.settings?.evoFootnoteStyle || "chicago-notes-bibliography";
}

function remember(key: string, html: string | null) {
    if (!rendered.has(key)) renderedOrder.push(key);
    rendered.set(key, html);
    while (renderedOrder.length > 2000) rendered.delete(renderedOrder.shift()!);
}

/** The citation notes of a note, by number. */
function clustersOf(scan: FootnoteScan): Cluster[] {
    const out: Cluster[] = [];
    const seen = new Set<string>();
    for (const d of scan.defs) {
        if (!/^\d+$/.test(d.label) || seen.has(d.label)) continue;
        seen.add(d.label);
        const items = parseCluster(d.body);
        if (items) out.push({ label: d.label, body: d.body, items, key: "" });
    }
    out.sort((a, b) => Number(a.label) - Number(b.label));
    let chain = style();
    for (const c of out) {
        chain = hash(`${chain}\u0000${c.label}|${c.body.trim()}`);
        c.key = chain;
    }
    return out;
}

/**
 * Render a note's citation notes (all of them, in order: a work is full the
 * first time, short after), and remember them. Resolves to whether anything
 * new came. A key not found is asked for again next time (synced meanwhile).
 */
export function renderClusters(clusters: Cluster[]): Promise<boolean> {
    if (!clusters.length || clusters.every((c) => typeof rendered.get(c.key) === "string"))
        return Promise.resolve(false);
    const id = clusters[clusters.length - 1]!.key;
    const running = inFlight.get(id);
    if (running) return running;
    const request = (async () => {
        const result = await workerBridge.libraryTemplate.evoRenderNotes(
            clusters.map((c) => ({ noteIndex: Number(c.label), items: c.items })),
            { styleId: style() },
        );
        let changed = false;
        clusters.forEach((c, i) => {
            const html = result.notes[i] ?? null;
            if (rendered.get(c.key) !== html) changed = true;
            remember(c.key, html);
        });
        return changed;
    })().finally(() => inFlight.delete(id));
    inFlight.set(id, request);
    return request;
}

function scheduleRender(view: EditorView, scan: FootnoteScan) {
    waiting.set(view, scan);
    if (requestTimer !== null) window.clearTimeout(requestTimer);
    requestTimer = window.setTimeout(() => {
        requestTimer = null;
        const views = [...waiting];
        waiting.clear();
        for (const [v, sc] of views) {
            renderClusters(clustersOf(sc))
                .then((changed) => {
                    if (!changed) return;
                    try {
                        v.dispatch({ effects: notesUpdated.of(null) });
                    } catch {
                        // Closed meanwhile.
                    }
                })
                .catch((e) =>
                    services.logService.warn(
                        "Could not render the citation footnotes",
                        "EvoFootnotes",
                        e,
                    ),
                );
        }
    }, 300);
}

/* -------------------------------- display -------------------------------- */

/** Where a footnote's definition or (first) reference is, now. */
function find(view: EditorView, label: string, what: "def" | "ref"): number | null {
    const scan = scanFootnotes(view.state.doc.toString());
    if (what === "def") {
        const d = scan.defs.find((x) => x.label === label);
        return d ? d.to : null;
    }
    const r = scan.refs.find((x) => x.label === label);
    return r ? r.to : null;
}

function jump(view: EditorView, pos: number | null) {
    if (pos === null) return;
    view.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: "center" }),
    });
    view.focus();
}

/** What a reference's hover shows: the rendered note, or the note's text. */
interface RefNote {
    html: string | null;
    markdown: string;
}

/** Popovers without a note view to belong to (a file in no view). */
const looseHoverParent: HoverParent = { hoverPopover: null };
let hovering: { target: HTMLElement; popover: HoverPopover } | null = null;

/**
 * The note in a popover above its reference, as Obsidian's own footnote
 * preview (which hovers Obsidian's text of the marker, not shown here): a
 * citation as its rendered note, a note of one's own as Markdown.
 */
function showNote(view: EditorView, target: HTMLElement, note: RefNote) {
    // Shown for this marker already (the pointer back on it): it stays.
    if (hovering?.target === target && hovering.popover.hoverEl.isConnected) return;
    const info = view.state.field(editorInfoField, false);
    const popover = new HoverPopover(info ?? looseHoverParent, target, 250);
    const current = { target, popover };
    hovering = current;
    popover.register(() => {
        if (hovering === current) hovering = null;
    });
    popover.hoverEl.addClass("zotflow-fn-popover");
    const body = popover.hoverEl.createDiv({ cls: "markdown-rendered zotflow-fn-popover-body" });
    if (note.html !== null) {
        body.appendChild(sanitizeHTMLToDom(note.html));
    } else {
        void MarkdownRenderer.render(
            services.app,
            note.markdown,
            body,
            info?.file?.path ?? "",
            popover,
        );
    }
}

/**
 * A reference: one element of its own, so Obsidian's styling of the pieces
 * of `[^1]` (`[^`, `1`, `]`) does not reach it. A word joiner first, and
 * CodeMirror's image before it hidden (styles.css): the marker stays on the
 * line of the word before it.
 */
class RefWidget extends WidgetType {
    constructor(
        readonly label: string,
        readonly note: RefNote | null,
    ) {
        super();
    }
    eq(other: RefWidget) {
        return (
            other.label === this.label &&
            other.note?.html === this.note?.html &&
            other.note?.markdown === this.note?.markdown
        );
    }
    toDOM(view: EditorView) {
        const sup = activeWindow.createEl("sup", {
            cls: this.note ? "zotflow-fn-ref" : "zotflow-fn-ref is-missing",
            // A word joiner first: no line break before the marker.
            text: `\u2060[${this.label}]`,
        });
        const note = this.note;
        if (note && (note.html || note.markdown.trim())) {
            sup.addEventListener("mouseenter", () => showNote(view, sup, note));
        }
        sup.addEventListener("mousedown", (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            // To the note (its text, to read or write).
            jump(view, find(view, this.label, "def"));
        });
        return sup;
    }
    ignoreEvent() {
        return true;
    }
}

class NumberWidget extends WidgetType {
    constructor(readonly label: string) {
        super();
    }
    eq(other: NumberWidget) {
        return other.label === this.label;
    }
    toDOM(view: EditorView) {
        const span = activeWindow.createSpan({ cls: "zotflow-fn-num", text: this.label });
        span.setAttribute("aria-label", "Back to the text");
        span.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            jump(view, find(view, this.label, "ref"));
        });
        return span;
    }
    ignoreEvent() {
        return true;
    }
}

class NoteWidget extends WidgetType {
    constructor(readonly html: string) {
        super();
    }
    eq(other: NoteWidget) {
        return other.html === this.html;
    }
    toDOM() {
        const span = activeWindow.createSpan({ cls: "zotflow-fn-note" });
        span.appendChild(sanitizeHTMLToDom(this.html));
        return span;
    }
    ignoreEvent() {
        // A click puts the cursor in: the source shows, to edit.
        return false;
    }
}

const defLine = Decoration.line({ class: "zotflow-fn-def" });
const defLineFirst = Decoration.line({ class: "zotflow-fn-def is-first" });
const missingMark = Decoration.mark({ class: "zotflow-fn-unknown" });

function touches(state: EditorState, from: number, to: number): boolean {
    return state.selection.ranges.some((r) => r.from <= to && r.to >= from);
}

class FootnoteView {
    decorations: DecorationSet = Decoration.none;
    private scan: FootnoteScan | null = null;
    private scannedDoc: unknown = null;
    /** Each citation note's key in `rendered`, by number. */
    private keys = new Map<string, string>();

    constructor(private readonly view: EditorView) {
        this.build();
    }

    update(u: ViewUpdate) {
        const refreshed = u.transactions.some((t) => t.effects.some((e) => e.is(notesUpdated)));
        const modeChanged =
            u.startState.field(editorLivePreviewField, false) !==
            u.state.field(editorLivePreviewField, false);
        if (u.docChanged || u.selectionSet || u.viewportChanged || refreshed || modeChanged)
            this.build();
    }

    private build() {
        const state = this.view.state;
        if (!enabled() || !state.field(editorLivePreviewField, false)) {
            this.decorations = Decoration.none;
            return;
        }
        if (this.scannedDoc !== state.doc) {
            const text = state.doc.toString();
            this.scan = text.includes("[^") ? scanFootnotes(text) : null;
            this.scannedDoc = state.doc;
            this.keys = new Map(this.scan ? clustersOf(this.scan).map((c) => [c.label, c.key]) : []);
            if (this.keys.size) scheduleRender(this.view, this.scan!);
        }
        const scan = this.scan;
        if (!scan) {
            this.decorations = Decoration.none;
            return;
        }
        const firstDef = new Map<string, (typeof scan.defs)[number]>();
        for (const d of scan.defs) if (!firstDef.has(d.label)) firstDef.set(d.label, d);
        const noteOf = (d: (typeof scan.defs)[number]) => {
            const key = this.keys.get(d.label);
            return firstDef.get(d.label) === d && key !== undefined ? rendered.get(key) : undefined;
        };
        const noteFor = (label: string): RefNote | null => {
            const d = firstDef.get(label);
            if (!d) return null;
            return { html: noteOf(d) ?? null, markdown: d.body.trim() };
        };

        const ranges: Range<Decoration>[] = [];
        const visible = this.view.visibleRanges;
        const inView = (from: number, to: number) =>
            visible.some((v) => to >= v.from && from <= v.to);

        for (const r of scan.refs) {
            if (!inView(r.from, r.to) || touches(state, r.from, r.to)) continue;
            ranges.push(
                Decoration.replace({ widget: new RefWidget(r.label, noteFor(r.label)) }).range(
                    r.from,
                    r.to,
                ),
            );
        }
        const doc = state.doc;
        for (const d of scan.defs) {
            if (!inView(d.from, d.to)) continue;
            const firstLine = doc.lineAt(d.from);
            const prev = firstLine.number > 1 ? doc.line(firstLine.number - 1).text : "";
            const first =
                !/^ {0,3}\[\^[^\]\s^]+\]:/.test(prev) && !/^(?: {2,}|\t)\S/.test(prev);
            const lastLine = doc.lineAt(d.to);
            for (let n = firstLine.number; n <= lastLine.number; n++) {
                const line = doc.line(n);
                ranges.push(
                    (n === firstLine.number && first ? defLineFirst : defLine).range(line.from),
                );
            }
            // Being edited: the source.
            if (touches(state, d.from, d.to)) continue;
            ranges.push(
                Decoration.replace({ widget: new NumberWidget(d.label) }).range(
                    d.from,
                    d.bodyFrom,
                ),
            );
            if (!parseCluster(d.body)) continue;
            const html = noteOf(d);
            if (html) {
                ranges.push(
                    Decoration.replace({ widget: new NoteWidget(html) }).range(d.bodyFrom, d.to),
                );
            } else if (html === null && d.to > d.bodyFrom) {
                // Cites a key not found here: the source, marked.
                ranges.push(missingMark.range(d.bodyFrom, d.to));
            }
        }
        this.decorations = Decoration.set(ranges, true);
    }
}

const displayPlugin = ViewPlugin.fromClass(FootnoteView, {
    decorations: (v) => v.decorations,
});

/* ------------------------------- copy, paste ----------------------------- */

/** What was last copied in a note, with the definitions of its footnotes. */
let lastCopy: { text: string; defs: Map<string, string> } | null = null;

function rememberCopy(view: EditorView) {
    if (!enabled()) return;
    const state = view.state;
    const ranges = state.selection.ranges;
    let text: string;
    let from: number;
    let to: number;
    if (ranges.every((r) => r.empty)) {
        // Copied without a selection: the whole lines.
        const lines = ranges.map((r) => state.doc.lineAt(r.head));
        text = lines.map((l) => l.text).join(state.lineBreak) + state.lineBreak;
        from = lines[0]!.from;
        to = lines[lines.length - 1]!.to;
    } else {
        const used = ranges.filter((r) => !r.empty);
        text = used.map((r) => state.sliceDoc(r.from, r.to)).join(state.lineBreak);
        from = Math.min(...used.map((r) => r.from));
        to = Math.max(...used.map((r) => r.to));
    }
    if (!text.includes("[^")) {
        lastCopy = null;
        return;
    }
    lastCopy = { text, defs: definitionsFor(state.doc.toString(), from, to) };
}

const clipboard = EditorView.domEventHandlers({
    copy: (_e, view) => {
        rememberCopy(view);
        return false;
    },
    cut: (_e, view) => {
        rememberCopy(view);
        return false;
    },
    blur: (_e, view) => {
        // Leaving a note edited here: in order, wherever the cursor was.
        if (!enabled() || !view.state.field(editedField, false)) return false;
        if (!view.state.doc.toString().includes("[^")) return false;
        window.setTimeout(() => {
            try {
                view.dispatch({ annotations: forceOrder.of(true) });
            } catch {
                // Closed meanwhile.
            }
        }, 0);
        return false;
    },
});

const sameText = (a: string, b: string) => a.replace(/\r\n/g, "\n") === b.replace(/\r\n/g, "\n");

/**
 * Obsidian's `editor-paste`: pasted text with footnotes gets labels of its
 * own and its definitions (written in it, or copied along in Obsidian) at
 * the end; the next step numbers and places them.
 */
export function handleFootnotePaste(
    evt: ClipboardEvent,
    editor: Editor,
    _info: MarkdownView | MarkdownFileInfo,
): void {
    if (!enabled() || evt.defaultPrevented) return;
    const text = evt.clipboardData?.getData("text/plain");
    if (!text || !text.includes("[^")) return;
    if (/^---\s*[\s\S]*?zotflow-locked:\s*true/m.test(editor.getValue().slice(0, 4000))) return;
    const copied = lastCopy && sameText(lastCopy.text, text) ? lastCopy.defs : new Map<string, string>();
    const { body, defs } = preparePaste(text, copied);
    evt.preventDefault();
    const from = editor.getCursor("from");
    const to = editor.getCursor("to");
    const startOffset = editor.posToOffset(from);
    const endOfDoc = editor.offsetToPos(editor.getValue().length);
    const changes: { from: { line: number; ch: number }; to?: { line: number; ch: number }; text: string }[] = [
        { from, to, text: body },
    ];
    if (defs.length) changes.push({ from: endOfDoc, text: `\n\n${defs.join("\n")}\n` });
    editor.transaction({ changes });
    // After what was pasted (its labels are numbers now).
    const end = findEndOfPaste(editor.getValue(), startOffset, body);
    editor.setCursor(editor.offsetToPos(end));
}

/** Where pasted text ends now that its labels were renumbered. */
function findEndOfPaste(text: string, start: number, body: string): number {
    // The body with any label, matched from where it went in.
    const pattern = body
        .split(/\[\^[^\]\s^]+\]/)
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("\\[\\^[^\\]\\s^]+\\]");
    const re = new RegExp(pattern, "y");
    re.lastIndex = start;
    const m = re.exec(text);
    return m ? start + m[0].length : Math.min(text.length, start + body.length);
}

/* --------------------------------- commands ------------------------------ */

let insertCounter = 0;

/** Insert a footnote of one's own at the cursor; the cursor goes to its text. */
export function insertFootnote(editor: Editor): void {
    const label = `zfn${Date.now().toString(36)}${++insertCounter}`;
    const cursor = editor.getCursor("to");
    const at = editor.posToOffset(cursor);
    const endOfDoc = editor.offsetToPos(editor.getValue().length);
    editor.transaction({
        changes: [
            { from: cursor, text: `[^${label}]` },
            { from: endOfDoc, text: `\n\n[^${label}]: ` },
        ],
    });
    const text = editor.getValue();
    const ref = /^\[\^([^\]\s^]+)\]/.exec(text.slice(at));
    const n = ref?.[1] ?? label;
    const def = scanFootnotes(text).defs.find((d) => d.label === n);
    if (def) {
        editor.setCursor(editor.offsetToPos(def.to));
        editor.scrollIntoView({ from: editor.offsetToPos(def.from), to: editor.offsetToPos(def.to) }, true);
    } else {
        editor.setCursor(editor.offsetToPos(at + (ref?.[0].length ?? 0)));
    }
}

/** Put a note's footnotes in order now. */
export function renumberFootnotes(editor: Editor): void {
    const changes = normalizeFootnotes(editor.getValue(), { level: level() });
    applyTextChanges(editor, changes);
}

export function applyTextChanges(editor: Editor, changes: TextChange[]): void {
    if (!changes.length) return;
    editor.transaction({
        changes: changes.map((c) => ({
            from: editor.offsetToPos(c.from),
            to: editor.offsetToPos(c.to),
            text: c.insert,
        })),
    });
}

/* ------------------------------- registration ---------------------------- */

export function evoFootnotesExtension(): Extension {
    // The display before Obsidian's own: its hiding and styling of footnote
    // syntax does not take the numbers' place.
    return [pendingField, editedField, orderFilter, Prec.highest(displayPlugin), clipboard];
}

/**
 * Reading view: Obsidian shows the footnotes at the note's end (numbered as
 * here); a citation footnote's text is shown as its formatted note.
 */
async function formatReadingFootnotes(
    plugin: Plugin,
    el: HTMLElement,
    sourcePath: string,
): Promise<void> {
    if (!enabled()) return;
    const items = Array.from(
        el.querySelectorAll<HTMLElement>(
            "section.footnotes li, li.footnote-item, li[data-footnote-id]",
        ),
    );
    if (!items.length) return;
    const file = plugin.app.vault.getAbstractFileByPath(sourcePath);
    if (!(file instanceof TFile)) return;
    const clusters = clustersOf(scanFootnotes(await plugin.app.vault.cachedRead(file)));
    if (!clusters.length) return;
    await renderClusters(clusters);
    items.forEach((li, i) => {
        const id = li.getAttribute("data-footnote-id") ?? li.id ?? "";
        const n = /fn-?(\d+)/.exec(id)?.[1] ?? String(i + 1);
        const c = clusters.find((x) => x.label === n);
        const html = c ? rendered.get(c.key) : null;
        if (!html) return;
        const p = li.querySelector("p") ?? li;
        const back = p.querySelector("a.footnote-backref");
        p.empty();
        p.appendChild(sanitizeHTMLToDom(html));
        if (back) {
            p.appendText(" ");
            p.appendChild(back);
        }
    });
}

export function registerEvoFootnotes(plugin: Plugin): void {
    plugin.registerEditorExtension(evoFootnotesExtension());
    plugin.registerMarkdownPostProcessor((el, ctx) =>
        formatReadingFootnotes(plugin, el, ctx.sourcePath).catch(() => {
            // Left as written.
        }),
    );
    plugin.registerEvent(plugin.app.workspace.on("editor-paste", handleFootnotePaste));
    plugin.addCommand({
        id: "evo-insert-footnote",
        name: "Insert footnote",
        editorCheckCallback: (checking, editor) => {
            if (!enabled()) return false;
            if (!checking) insertFootnote(editor);
            return true;
        },
    });
    plugin.addCommand({
        id: "evo-renumber-footnotes",
        name: "Renumber footnotes",
        editorCheckCallback: (checking, editor) => {
            if (!enabled()) return false;
            if (!checking) renumberFootnotes(editor);
            return true;
        },
    });
}
