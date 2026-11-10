/**
 * ZotFlow Evo: the citation picker's one way in — Enter picks the work,
 * then the page is typed after the trigger and Enter inserts it (Enter
 * again: without a page). Obsidian's EditorSuggest from the stub (its own
 * `trigger()`), a line editor of the test's own.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    settings: {
        citationTrigger: "@@",
        defaultCitationFormat: "footnote",
        evoFootnotes: true,
    },
    resolved: [] as unknown[][],
    inserted: [] as unknown[],
}));

vi.mock("services/services", () => ({
    services: {
        get settings() {
            return state.settings;
        },
        app: { workspace: { getLeavesOfType: () => [] } },
        citationService: {
            resolve: (...args: unknown[]) => {
                state.resolved.push(args);
                return Promise.resolve({ citation: "[^zfc1]", citekey: "heims1991" });
            },
        },
        logService: { error: () => {}, warn: () => {} },
        notificationService: { notify: () => {} },
        libraryCache: { hasNotesAccess: () => true },
    },
}));
vi.mock("bridge", () => ({
    workerBridge: {
        dbHelper: {
            updateLastAccessed: () => Promise.resolve(),
            getItemPaths: () => Promise.resolve({}),
        },
        displayTitle: { getTitles: () => Promise.resolve({}) },
        search: {
            searchItems: () => Promise.resolve([HEIMS]),
            getRecentItems: () => Promise.resolve([HEIMS]),
        },
    },
}));
vi.mock("ui/editor/citation-helper", () => ({
    insertCitationResult: (...args: unknown[]) => state.inserted.push(args),
}));

const HEIMS = vi.hoisted(() => ({
    libraryID: 1,
    key: "HEIMS001",
    itemType: "book",
    title: "The Cybernetics Group",
    searchCreators: ["Steve J. Heims"],
    collections: [],
    raw: { data: { date: "1991" } },
}));

import { CitationSuggest, describePlace, placeFromQuery } from "ui/editor/citation-suggest";

/** One line of text and a cursor, as much of Obsidian's Editor as the picker uses. */
function lineEditor(text: string) {
    const e = {
        text,
        cursor: text.length,
        getLine: () => e.text,
        getCursor: () => ({ line: 0, ch: e.cursor }),
        setCursor: (p: { ch: number }) => void (e.cursor = p.ch),
        getValue: () => e.text,
        replaceRange: (insert: string, from: { ch: number }, to?: { ch: number }) => {
            const end = to?.ch ?? from.ch;
            e.text = e.text.slice(0, from.ch) + insert + e.text.slice(end);
            if (e.cursor >= end) e.cursor += insert.length - (end - from.ch);
            else if (e.cursor > from.ch) e.cursor = from.ch + insert.length;
        },
    };
    return e;
}

type Picker = CitationSuggest & { shown: unknown[]; isOpen: boolean; trigger(...a: unknown[]): Promise<boolean> };

async function typeInto(picker: Picker, editor: ReturnType<typeof lineEditor>, chars: string) {
    for (const ch of chars) {
        editor.replaceRange(ch, { ch: editor.cursor });
        await picker.trigger(editor, null, false);
    }
}

let picker: Picker;
let editor: ReturnType<typeof lineEditor>;
beforeEach(async () => {
    state.settings.defaultCitationFormat = "footnote";
    state.settings.evoFootnotes = true;
    state.resolved = [];
    state.inserted = [];
    picker = new CitationSuggest() as Picker;
    editor = lineEditor("Cybernetics began as a conversation@@cyb");
    await picker.trigger(editor, null, true);
});

const enter = async (row?: unknown) => {
    picker.selectSuggestion((row ?? picker.shown[0]) as never, {} as KeyboardEvent);
    await new Promise((r) => setTimeout(r, 0));
};

describe("the picker: the work, then the page", () => {
    it("Enter picks the work; the page typed after the trigger; Enter inserts it", async () => {
        expect(picker.shown).toEqual([HEIMS]);
        await enter();
        // What was typed to find it goes; the trigger stays, for the page.
        expect(editor.text).toBe("Cybernetics began as a conversation@@");
        expect(picker.shown).toEqual([{ isPlace: true, item: HEIMS }]);
        expect(state.resolved).toEqual([]);
        await typeInto(picker, editor, "23-25");
        expect(picker.context?.query).toBe("23-25");
        await enter();
        expect(editor.text).toBe("Cybernetics began as a conversation");
        expect(state.resolved).toEqual([
            [
                { libraryID: 1, key: "HEIMS001" },
                "footnote",
                { locator: { label: "page", locator: "23-25" }, suffix: "" },
            ],
        ]);
        expect(state.inserted).toHaveLength(1);
    });

    it("Enter twice: without a page", async () => {
        await enter();
        await enter();
        expect(editor.text).toBe("Cybernetics began as a conversation");
        expect(state.resolved[0]![2]).toEqual({ locator: null, suffix: "" });
    });

    it("Escape in the page step: nothing goes in, the trigger and the page typed go", async () => {
        await enter();
        await typeInto(picker, editor, "23");
        picker.close();
        expect(editor.text).toBe("Cybernetics began as a conversation");
        expect(state.resolved).toEqual([]);
    });

    it("the cursor leaving the step ends it", async () => {
        await enter();
        editor.cursor = 5;
        await picker.trigger(editor, null, false);
        expect(picker.context).toBeNull();
        // Back at the end: the work search again, not the page step.
        editor.cursor = editor.text.length;
        await picker.trigger(editor, null, true);
        expect(picker.shown).toEqual([HEIMS]);
    });

    it("a format without pages (a wikilink): in at the first Enter", async () => {
        state.settings.defaultCitationFormat = "wikilink";
        await enter();
        expect(editor.text).toBe("Cybernetics began as a conversation");
        expect(state.resolved).toEqual([[{ libraryID: 1, key: "HEIMS001" }, "wikilink", undefined]]);
    });

    it("what the page step shows", () => {
        expect(describePlace(placeFromQuery(""))).toBe("");
        expect(describePlace(placeFromQuery("23"))).toBe("p. 23");
        expect(describePlace(placeFromQuery("23–25"))).toBe("pp. 23–25");
        expect(describePlace(placeFromQuery("chap. 3"))).toBe("chap. 3");
        expect(describePlace(placeFromQuery("12, Anm. 3"))).toBe("p. 12, Anm. 3");
        expect(describePlace(placeFromQuery("Einleitung"))).toBe("Einleitung");
    });
});
