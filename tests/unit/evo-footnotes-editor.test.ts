/**
 * ZotFlow Evo: `ui/editor/evo-footnotes.ts` — footnotes kept in order in
 * the editor: in the same transaction as the edit (one undo), not while a
 * marker is being written or composed, not on undo, redo or a reload from
 * disk; source notes left alone. CodeMirror's state only (no view).
 */
import { EditorSelection, EditorState, StateField, type TransactionSpec } from "@codemirror/state";
import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({
    evoFootnotes: true,
    evoFootnoteLevel: 3,
    evoFootnoteStyle: "chicago-notes-bibliography",
}));

vi.mock("obsidian", () => ({
    editorLivePreviewField: StateField.define<boolean>({
        create: () => true,
        update: (v: boolean) => v,
    }),
    sanitizeHTMLToDom: () => null,
    TFile: class {},
    setTooltip: () => {},
}));
vi.mock("bridge", () => ({ workerBridge: {} }));
vi.mock("services/services", () => ({
    services: {
        get settings() {
            return settings;
        },
        logService: { warn: () => {} },
    },
}));

import { evoFootnotesExtension } from "ui/editor/evo-footnotes";

let state: EditorState;
const make = (doc: string, cursor = doc.length) => {
    state = EditorState.create({
        doc,
        selection: EditorSelection.cursor(cursor),
        extensions: evoFootnotesExtension(),
    });
};
/** One transaction, as the editor would dispatch it. */
const edit = (spec: TransactionSpec) => {
    const tr = state.update(spec);
    state = tr.state;
    return tr;
};
const typeAt = (pos: number, text: string) => {
    for (const ch of text) {
        edit({
            changes: { from: pos, insert: ch },
            selection: EditorSelection.cursor(pos + 1),
            userEvent: "input.type",
        });
        pos++;
    }
    return pos;
};
const doc = () => state.doc.toString();

beforeEach(() => {
    settings.evoFootnotes = true;
    settings.evoFootnoteLevel = 3;
});

describe("kept in order as one writes", () => {
    it("a footnote inserted with its definition: numbered and placed in the same step", () => {
        make("One[^1] two.\n\n[^1]: A\n", 3);
        const tr = edit({
            changes: [
                { from: 0, insert: "Zero[^zfc1] " },
                { from: 22, insert: "\n\n[^zfc1]: @heims1991\n" },
            ],
            userEvent: "input",
        });
        expect(doc()).toBe("Zero[^1] One[^2] two.\n\n[^1]: @heims1991\n[^2]: A\n");
        // One transaction: undoing it takes back the renumbering too.
        expect(tr.startState.doc.toString()).toBe("One[^1] two.\n\n[^1]: A\n");
    });

    it("typing a marker by hand: nothing moves until it is closed and the cursor left it", () => {
        make("Text[^1] here.\n\n[^1]: A\n", 0);
        // "[^" … typed at the start, before the existing footnote.
        let pos = typeAt(0, "Pre[^x");
        expect(doc()).toBe("Pre[^xText[^1] here.\n\n[^1]: A\n");
        pos = typeAt(pos, "]");
        // Closed, cursor after it: numbered, the old one becomes 2.
        expect(doc()).toBe("Pre[^1]Text[^2] here.\n\n[^1]: \n[^2]: A\n");
        expect(pos).toBe(7);
    });

    it("a reference deleted: its definition goes in the same step", () => {
        make("A[^1] B[^2] C[^3].\n\n[^1]: one\n[^2]: two\n[^3]: three\n");
        edit({ changes: { from: 1, to: 5 }, userEvent: "delete.backward" });
        expect(doc()).toBe("A B[^1] C[^2].\n\n[^1]: two\n[^2]: three\n");
    });

    it("a reference deleted with Backspace, character by character: its definition goes too", () => {
        make("A[^1] B[^2] C[^3].\n\n[^1]: one\n[^2]: two\n[^3]: three\n");
        // The cursor after "[^1]", then four times Backspace.
        for (let pos = 5; pos > 1; pos--) {
            edit({
                changes: { from: pos - 1, to: pos },
                selection: EditorSelection.cursor(pos - 1),
                userEvent: "delete.backward",
            });
        }
        expect(doc()).toBe("A B[^1] C[^2].\n\n[^1]: two\n[^2]: three\n");
    });

    it("a marker being changed (its number deleted, then typed again) loses nothing", () => {
        make("A[^1] B[^2].\n\n[^1]: one\n[^2]: two\n");
        // Backspace the "1" in [^1]: the cursor is in "[^" — wait.
        edit({ changes: { from: 3, to: 4 }, selection: EditorSelection.cursor(3), userEvent: "delete.backward" });
        expect(doc()).toBe("A[^] B[^2].\n\n[^1]: one\n[^2]: two\n");
        // Typed again: in order, nothing lost.
        typeAt(3, "1");
        edit({ selection: EditorSelection.cursor(0) });
        expect(doc()).toBe("A[^1] B[^2].\n\n[^1]: one\n[^2]: two\n");
    });

    it("a cut paragraph pasted elsewhere (definitions along): placed by the new spot", () => {
        make("### One\n\nFirst[^1].\n\n[^1]: A\n\n### Two\n\nSecond.\n");
        // Cut "First[^1]." and paste it in part two with its definition
        // (what the paste handler does).
        edit({ changes: { from: 9, to: 20 }, userEvent: "delete.cut" });
        const at = doc().indexOf("Second.");
        edit({
            changes: [
                { from: at, insert: "First[^zfp1].\n\n" },
                { from: doc().length, insert: "\n\n[^zfp1]: A\n" },
            ],
            userEvent: "input.paste",
        });
        expect(doc()).toBe("### One\n\n### Two\n\nFirst[^1].\n\nSecond.\n\n[^1]: A\n");
    });
});

describe("left alone", () => {
    it("undo, redo, a reload from disk and IME composition", () => {
        for (const userEvent of ["undo", "redo", "set"]) {
            make("B[^2] A[^1]\n\n[^1]: a\n[^2]: b\n");
            edit({ changes: { from: 0, insert: "[^x] " }, userEvent });
            expect(doc().startsWith("[^x] B[^2]")).toBe(true);
        }
        make("Text\n\n", 4);
        edit({ changes: { from: 4, insert: "[^" }, selection: EditorSelection.cursor(6), userEvent: "input.type.compose" });
        expect(doc()).toBe("Text[^\n\n");
    });

    it("ZotFlow's source notes, and with the setting off", () => {
        make("---\nzotflow-locked: true\n---\nB[^2] A[^1]\n\n[^1]: a\n[^2]: b\n");
        edit({ changes: { from: state.doc.length, insert: "x[^3]" }, userEvent: "input" });
        expect(doc()).toContain("B[^2] A[^1]");
        settings.evoFootnotes = false;
        make("B[^2] A[^1]\n\n[^1]: a\n[^2]: b\n");
        edit({ changes: { from: 0, insert: "[^x] " }, userEvent: "input" });
        expect(doc()).toBe("[^x] B[^2] A[^1]\n\n[^1]: a\n[^2]: b\n");
    });

    it("plain typing does not move anything", () => {
        make("Text[^1].\n\n[^1]: A\n\nMore", 22);
        typeAt(state.doc.length, " words");
        expect(doc()).toBe("Text[^1].\n\n[^1]: A\n\nMore words");
    });
});
