/**
 * ZotFlow Evo: `ui/editor/evo-drop.ts` — what a comment or a highlight
 * dragged out of the reader becomes in a note.
 *
 * The text ends up in the user's note, so the cases pin the exact output:
 * the quotation marks, where the reference goes, what the colour tables do,
 * and which drops are left to the citation formats.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
    affixesForColor,
    composeDrop,
    handleReaderDrop,
    plainCommentDrop,
    readerLink,
} from "ui/editor/evo-drop";

import type { Editor } from "obsidian";
import type { EvoDropAffixes } from "settings/types";
import type { AnnotationJSON } from "types/zotero-reader";
import type { ZotFlowCitationPayload } from "ui/editor/citation-helper";

interface MockState {
    evoCommentDrop: Record<string, EvoDropAffixes>;
    evoHighlightDrop: Record<string, EvoDropAffixes>;
    evoDropLinkTemplate: string;
    rendered: { libraryID: number; key: string; source: string; extra: Record<string, unknown> }[];
    renderRejects: boolean;
    notices: string[];
    errors: string[];
}

const state = vi.hoisted(() => ({
    evoCommentDrop: {},
    evoHighlightDrop: {},
    evoDropLinkTemplate: "TEMPLATE",
    rendered: [],
    renderRejects: false,
    notices: [],
    errors: [],
})) as unknown as MockState;

vi.mock("services/services", () => ({
    services: {
        get settings() {
            return {
                evoCommentDrop: state.evoCommentDrop,
                evoHighlightDrop: state.evoHighlightDrop,
                evoDropLinkTemplate: state.evoDropLinkTemplate,
            };
        },
        logService: { error: (m: string) => state.errors.push(m) },
        notificationService: {
            notify: (_type: string, m: string) => state.notices.push(m),
        },
    },
}));

// The worker renders the reference; here it is "(ref p. <page>)".
vi.mock("bridge", () => ({
    workerBridge: {
        displayTitle: {
            renderTemplate: (
                libraryID: number,
                key: string,
                source: string,
                extra: Record<string, unknown>,
            ) => {
                state.rendered.push({ libraryID, key, source, extra });
                return state.renderRejects
                    ? Promise.reject(new Error("template blew up"))
                    : Promise.resolve(`  (ref p. ${String(extra.page)})\n`);
            },
        },
    },
}));

function annotation(patch: Partial<AnnotationJSON> = {}): AnnotationJSON {
    return {
        id: "ANNO0001",
        libraryID: 7,
        parentItem: "ATTACH01",
        type: "highlight",
        text: "the highlighted words",
        comment: "my comment",
        color: "#ffd400",
        pageLabel: "12",
        position: { pageIndex: 11, rects: [] },
        ...patch,
    } as AnnotationJSON;
}

/** An editor over a plain string, enough for the position calls the module makes. */
function fakeEditor(initial = "", cursor = initial.length) {
    let doc = initial;
    let cur = cursor;
    const editor = {
        getValue: () => doc,
        getCursor: () => ({ line: 0, ch: cur }),
        posToOffset: (pos: { ch: number }) => pos.ch,
        offsetToPos: (offset: number) => ({ line: 0, ch: offset }),
        replaceRange: (text: string, pos: { ch: number }) => {
            doc = doc.slice(0, pos.ch) + text + doc.slice(pos.ch);
        },
        setCursor: (pos: { ch: number }) => {
            cur = pos.ch;
        },
    };
    return {
        editor: editor as unknown as Editor,
        get doc() {
            return doc;
        },
        get cursor() {
            return cur;
        },
        type(text: string) {
            doc += text;
            cur = doc.length;
        },
    };
}

const drop = (mods: Partial<Record<"shiftKey" | "ctrlKey" | "metaKey" | "altKey", boolean>> = {}) =>
    ({ shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...mods }) as DragEvent;

const payload = (patch: Partial<ZotFlowCitationPayload> = {}): ZotFlowCitationPayload => ({
    type: "zotflow-citation",
    libraryID: 7,
    key: "PARENT01",
    annotations: [annotation()],
    evoSource: "comment",
    ...patch,
});

const NONE: EvoDropAffixes = { before: "", after: "" };
const ANNOTATION_LINK =
    "obsidian://zotflow?type=open-annotation&libraryID=7&key=ANNO0001";

beforeEach(() => {
    state.evoCommentDrop = {};
    state.evoHighlightDrop = {};
    state.evoDropLinkTemplate = "TEMPLATE";
    state.rendered = [];
    state.renderRejects = false;
    state.notices = [];
    state.errors = [];
});

describe("readerLink", () => {
    it("opens the annotation when there is one", () => {
        expect(readerLink(annotation())).toBe(ANNOTATION_LINK);
    });

    it("opens the attachment at the page for selected text, which has no annotation", () => {
        const link = readerLink(annotation({ id: undefined as unknown as string }));
        expect(link).toBe(
            "obsidian://zotflow?type=open-attachment&libraryID=7&key=ATTACH01&navigation=" +
                encodeURIComponent(JSON.stringify({ pageIndex: 11 })),
        );
    });

    it("opens a snapshot at the passage for selected text: its place is a selector, not a page", () => {
        const selector = {
            type: "CssSelector",
            value: "#p3",
            refinedBy: { type: "TextPositionSelector", start: 5, end: 30 },
        };
        const link = readerLink(
            annotation({
                id: undefined as unknown as string,
                position: selector as unknown as AnnotationJSON["position"],
            }),
        );
        expect(link).toBe(
            "obsidian://zotflow?type=open-attachment&libraryID=7&key=ATTACH01&navigation=" +
                encodeURIComponent(JSON.stringify({ position: selector })),
        );
    });
});

describe("composeDrop", () => {
    it("puts a highlight's text in quotation marks, the reference after it", () => {
        expect(composeDrop("highlight", annotation(), "(ref)", NONE)).toBe(
            "“the highlighted words” (ref)",
        );
    });

    it("drops a comment as it is, the reference after it", () => {
        expect(composeDrop("comment", annotation({ comment: "  spaced  " }), "(ref)", NONE)).toBe(
            "spaced (ref)",
        );
    });

    it("wraps either in the text set for the colour", () => {
        const affixes = { before: "- & ", after: " #idea" };
        expect(composeDrop("highlight", annotation(), "(ref)", affixes)).toBe(
            "- & “the highlighted words” (ref) #idea",
        );
        expect(composeDrop("comment", annotation(), "(ref)", affixes)).toBe(
            "- & my comment (ref) #idea",
        );
    });

    it("leaves the reference to an affix that places it, or the bare link, itself", () => {
        expect(
            composeDrop("comment", annotation(), "(ref)", { before: "{{ cite }}: ", after: "" }),
        ).toBe("(ref): my comment");
        expect(
            composeDrop("highlight", annotation(), "(ref)", { before: "", after: " [{{page}}]({{link}})" }),
        ).toBe(`“the highlighted words” [12](${ANNOTATION_LINK})`);
    });

    it("fills the other fields into the affixes", () => {
        expect(
            composeDrop("comment", annotation(), "(ref)", {
                before: "{{color}} “{{text}}” — ",
                after: " <{{comment}}>",
            }),
        ).toBe("#ffd400 “the highlighted words” — my comment (ref) <my comment>");
    });

    it("drops only the reference for a highlight without text (an image)", () => {
        expect(composeDrop("highlight", annotation({ text: "" }), "(ref)", NONE)).toBe("(ref)");
    });

    it("drops no stray space when there is no reference", () => {
        expect(composeDrop("highlight", annotation(), "", NONE)).toBe("“the highlighted words”");
    });
});

describe("affixesForColor", () => {
    it("finds the colour whatever its letter case; other colours get nothing", () => {
        const table = { "#ffd400": { before: "> ", after: "!" } };
        expect(affixesForColor(table, "#FFD400")).toEqual({ before: "> ", after: "!" });
        expect(affixesForColor(table, "#ff6666")).toEqual(NONE);
        expect(affixesForColor(undefined, undefined)).toEqual(NONE);
        expect(affixesForColor({ "#ffd400": { before: "* " } as EvoDropAffixes }, "#ffd400")).toEqual({
            before: "* ",
            after: "",
        });
    });
});

describe("plainCommentDrop", () => {
    it("joins the comments, skipping empty ones", () => {
        expect(
            plainCommentDrop([
                annotation({ comment: " one " }),
                annotation({ comment: "" }),
                annotation({ comment: "two" }),
            ]),
        ).toBe("one\ntwo");
    });
});

describe("handleReaderDrop", () => {
    it("leaves a drop that did not start in the reader alone", () => {
        const e = fakeEditor("x");
        expect(handleReaderDrop(drop(), e.editor, payload({ evoSource: undefined }))).toBe(false);
        expect(handleReaderDrop(drop(), e.editor, payload({ annotations: [] }))).toBe(false);
        expect(e.doc).toBe("x");
    });

    it("leaves a drop with a modifier key to the citation formats", () => {
        const e = fakeEditor();
        for (const mod of ["shiftKey", "ctrlKey", "metaKey", "altKey"] as const) {
            expect(handleReaderDrop(drop({ [mod]: true }), e.editor, payload())).toBe(false);
            expect(handleReaderDrop(drop({ [mod]: true }), e.editor, payload({ evoSource: "highlight" }))).toBe(false);
        }
    });

    it("inserts a dropped highlight at the cursor and moves the cursor behind it", async () => {
        state.evoHighlightDrop = { "#ffd400": { before: "> ", after: "" } };
        state.evoCommentDrop = { "#ffd400": { before: "WRONG TABLE ", after: "" } };
        const e = fakeEditor("ab", 1);
        expect(handleReaderDrop(drop(), e.editor, payload({ evoSource: "highlight" }))).toBe(true);
        await vi.waitFor(() => expect(e.doc).not.toBe("ab"));
        const inserted = "> “the highlighted words” (ref p. 12)";
        expect(e.doc).toBe("a" + inserted + "b");
        expect(e.cursor).toBe(1 + inserted.length);
    });

    it("renders the reference with the item's key and the annotation's values", async () => {
        const e = fakeEditor("");
        handleReaderDrop(drop(), e.editor, payload({ evoSource: "highlight" }));
        await vi.waitFor(() => expect(state.rendered).toHaveLength(1));
        const call = state.rendered[0]!;
        expect([call.libraryID, call.key, call.source]).toEqual([7, "PARENT01", "TEMPLATE"]);
        expect(call.extra).toMatchObject({
            text: "the highlighted words",
            comment: "my comment",
            page: "12",
            link: ANNOTATION_LINK,
            color: "#ffd400",
        });
    });

    it("gives the template no page for an annotation without one (a snapshot), so it can leave it out", async () => {
        const e = fakeEditor("");
        handleReaderDrop(
            drop(),
            e.editor,
            payload({ evoSource: "highlight", annotations: [annotation({ pageLabel: "" })] }),
        );
        await vi.waitFor(() => expect(state.rendered).toHaveLength(1));
        const extra = state.rendered[0]!.extra;
        expect("page" in extra).toBe(true);
        expect(extra.page).toBeUndefined();
    });

    it("drops comments one per line, each with its own reference and colour text; empty ones are skipped", async () => {
        state.evoCommentDrop = { "#ff6666": { before: "! ", after: "" } };
        state.evoHighlightDrop = { "#ff6666": { before: "WRONG TABLE ", after: "" } };
        const e = fakeEditor("");
        handleReaderDrop(
            drop(),
            e.editor,
            payload({
                annotations: [
                    annotation(),
                    annotation({ id: "ANNO0002", color: "#ff6666", comment: "second", pageLabel: "3" }),
                    annotation({ id: "ANNO0003", comment: "  " }),
                ],
            }),
        );
        await vi.waitFor(() => expect(e.doc).not.toBe(""));
        expect(e.doc).toBe("my comment (ref p. 12)\n! second (ref p. 3)");
        expect(state.rendered).toHaveLength(2);
    });

    it("drops without a reference, and without asking the worker, when the template is empty", async () => {
        state.evoDropLinkTemplate = "   ";
        const e = fakeEditor("");
        handleReaderDrop(drop(), e.editor, payload({ evoSource: "highlight" }));
        await vi.waitFor(() => expect(e.doc).toBe("“the highlighted words”"));
        expect(state.rendered).toHaveLength(0);
    });

    it("inserts at the cursor's new place if the note changed while the reference rendered", async () => {
        const e = fakeEditor("start");
        handleReaderDrop(drop(), e.editor, payload());
        e.type(" more ");
        await vi.waitFor(() => expect(e.doc).toContain("(ref"));
        expect(e.doc).toBe("start more my comment (ref p. 12)");
    });

    it("says so and inserts nothing when the template fails", async () => {
        state.renderRejects = true;
        const e = fakeEditor("keep");
        expect(handleReaderDrop(drop(), e.editor, payload({ evoSource: "highlight" }))).toBe(true);
        await vi.waitFor(() => expect(state.notices).toHaveLength(1));
        expect(e.doc).toBe("keep");
        expect(state.errors).toHaveLength(1);
    });
});
