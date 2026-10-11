/**
 * ZotFlow Evo: `ui/editor/evo-drop.ts` — what a comment or a highlight
 * dragged out of the reader becomes in a note.
 *
 * The text ends up in the user's note, so the cases pin the exact output:
 * where the page link goes, what the colour table does, and which drops are
 * left to the citation formats.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
    affixesForColor,
    formatCommentDrop,
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
    evoHighlightDropTemplate: string;
    rendered: { libraryID: number; key: string; source: string; extra: Record<string, unknown> }[];
    renderRejects: boolean;
    notices: string[];
    errors: string[];
}

const state = vi.hoisted(() => ({
    evoCommentDrop: {},
    evoHighlightDropTemplate: "{{ text }} ({{ page }})",
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
                evoHighlightDropTemplate: state.evoHighlightDropTemplate,
            };
        },
        logService: { error: (m: string) => state.errors.push(m) },
        notificationService: {
            notify: (_type: string, m: string) => state.notices.push(m),
        },
    },
}));

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
                    : Promise.resolve(`<${String(extra.text)}|${String(extra.page)}>`);
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

const ANNOTATION_LINK =
    "obsidian://zotflow?type=open-annotation&libraryID=7&key=ANNO0001";

beforeEach(() => {
    state.evoCommentDrop = {};
    state.evoHighlightDropTemplate = "{{ text }} ({{ page }})";
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
});

describe("formatCommentDrop", () => {
    it("puts the linked page number after the comment by default", () => {
        expect(formatCommentDrop(annotation(), {})).toBe(
            `my comment [p. 12](${ANNOTATION_LINK})`,
        );
    });

    it("wraps the comment in the text set for its colour", () => {
        const table = { "#ffd400": { before: "- & ", after: " #idea" } };
        expect(formatCommentDrop(annotation(), table)).toBe(
            `- & my comment [p. 12](${ANNOTATION_LINK}) #idea`,
        );
    });

    it("finds the colour whatever its letter case, and leaves other colours bare", () => {
        const table = { "#ffd400": { before: "> ", after: "" } };
        expect(formatCommentDrop(annotation({ color: "#FFD400" }), table)).toMatch(/^> my comment/);
        expect(formatCommentDrop(annotation({ color: "#ff6666" }), table)).toMatch(/^my comment/);
    });

    it("leaves the link to an affix that places it itself", () => {
        const table = { "#ffd400": { before: "", after: " ([{{page}}]({{ link }}))" } };
        expect(formatCommentDrop(annotation(), table)).toBe(
            `my comment ([12](${ANNOTATION_LINK}))`,
        );
    });

    it("fills the highlighted text and the colour too", () => {
        const table = { "#ffd400": { before: "“{{text}}” {{color}}: ", after: "" } };
        expect(formatCommentDrop(annotation(), table)).toMatch(
            /^“the highlighted words” #ffd400: my comment \[p\. 12\]/,
        );
    });

    it("trims the comment and tolerates a missing colour entry field", () => {
        const table = { "#ffd400": { before: "* " } as EvoDropAffixes };
        expect(formatCommentDrop(annotation({ comment: "  spaced  " }), table)).toBe(
            `* spaced [p. 12](${ANNOTATION_LINK})`,
        );
        expect(affixesForColor(undefined, undefined)).toEqual({ before: "", after: "" });
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
        }
    });

    it("leaves a highlight to the citation formats when the template is empty", () => {
        state.evoHighlightDropTemplate = "  ";
        const e = fakeEditor();
        expect(handleReaderDrop(drop(), e.editor, payload({ evoSource: "highlight" }))).toBe(false);
    });

    it("inserts dropped comments at the cursor, one per line, and moves the cursor behind them", async () => {
        state.evoCommentDrop = { "#ff6666": { before: "! ", after: "" } };
        const e = fakeEditor("ab", 1);
        const handled = handleReaderDrop(
            drop(),
            e.editor,
            payload({
                annotations: [
                    annotation(),
                    annotation({ id: "ANNO0002", color: "#ff6666", comment: "second", pageLabel: "3" }),
                    annotation({ id: "ANNO0003", comment: "" }),
                ],
            }),
        );
        expect(handled).toBe(true);
        await vi.waitFor(() => expect(e.doc).not.toBe("ab"));
        const inserted =
            `my comment [p. 12](${ANNOTATION_LINK})\n` +
            "! second [p. 3](obsidian://zotflow?type=open-annotation&libraryID=7&key=ANNO0002)";
        expect(e.doc).toBe("a" + inserted + "b");
        expect(e.cursor).toBe(1 + inserted.length);
    });

    it("renders a highlight through the template, with the item's key and the annotation's values", async () => {
        const e = fakeEditor("");
        handleReaderDrop(drop(), e.editor, payload({ evoSource: "highlight" }));
        await vi.waitFor(() => expect(e.doc).toBe("<the highlighted words|12>"));
        expect(state.rendered).toHaveLength(1);
        const call = state.rendered[0]!;
        expect([call.libraryID, call.key, call.source]).toEqual([7, "PARENT01", "{{ text }} ({{ page }})"]);
        expect(call.extra).toMatchObject({
            text: "the highlighted words",
            comment: "my comment",
            page: "12",
            link: ANNOTATION_LINK,
            color: "#ffd400",
        });
    });

    it("inserts at the cursor's new place if the note changed while the template rendered", async () => {
        const e = fakeEditor("start");
        handleReaderDrop(drop(), e.editor, payload({ evoSource: "highlight" }));
        e.type(" more");
        await vi.waitFor(() => expect(e.doc).toContain("<"));
        expect(e.doc).toBe("start more<the highlighted words|12>");
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
