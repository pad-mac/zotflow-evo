/**
 * ZotFlow Evo: `ui/editor/evo-link-drop.ts` — items dragged out of the
 * library browser, dropped into a note as links to their source notes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";

import {
    handleSourceLinkDrop,
    parseSourceLinksPayload,
    planLinkDrop,
    ZOTFLOW_SOURCE_LINKS_MIME,
} from "ui/editor/evo-link-drop";

import type { Editor, MarkdownView } from "obsidian";

interface MockState {
    /** Source notes the index knows, by item key. */
    indexed: Record<string, string>;
    /** Paths the vault holds as files. */
    inVault: Set<string>;
    ensured: string[];
    ensureFails: Set<string>;
    notices: string[];
}

const state = vi.hoisted(() => ({
    indexed: {},
    inVault: new Set<string>(),
    ensured: [],
    ensureFails: new Set<string>(),
    notices: [],
})) as unknown as MockState;

vi.mock("services/services", () => ({
    services: {
        indexService: {
            getFileByKey: (key: string) =>
                state.indexed[key] ? { path: state.indexed[key] } : undefined,
        },
        app: {
            vault: {
                getAbstractFileByPath: (path: string) => {
                    if (!state.inVault.has(path)) return null;
                    const file = new TFile();
                    file.path = path;
                    return file;
                },
            },
            fileManager: {
                generateMarkdownLink: (file: TFile, sourcePath: string) =>
                    `[[${file.path.replace(/\.md$/, "")}|from ${sourcePath}]]`,
            },
        },
        logService: { error: () => undefined },
        notificationService: {
            notify: (_type: string, m: string) => state.notices.push(m),
        },
    },
}));

vi.mock("bridge", () => ({
    workerBridge: {
        libraryNote: {
            ensureNotePath: (_libraryID: number, key: string) => {
                state.ensured.push(key);
                return state.ensureFails.has(key)
                    ? Promise.reject(new Error("no source note for this item"))
                    : Promise.resolve(`Source/@${key}.md`);
            },
        },
    },
}));

/** A multi-line editor over an array of lines. */
function fakeEditor(text: string, cursor: { line: number; ch: number }) {
    let lines = text.split("\n");
    let cur = { ...cursor };
    const offsetOf = (pos: { line: number; ch: number }) =>
        lines.slice(0, pos.line).reduce((n, l) => n + l.length + 1, 0) + pos.ch;
    const posOf = (offset: number) => {
        let line = 0;
        while (line < lines.length - 1 && offset > lines[line]!.length) {
            offset -= lines[line]!.length + 1;
            line += 1;
        }
        return { line, ch: offset };
    };
    const editor = {
        getValue: () => lines.join("\n"),
        getCursor: () => ({ ...cur }),
        getLine: (n: number) => lines[n] ?? "",
        posToOffset: offsetOf,
        offsetToPos: posOf,
        replaceRange: (insert: string, pos: { line: number; ch: number }) => {
            const doc = lines.join("\n");
            const at = offsetOf(pos);
            lines = (doc.slice(0, at) + insert + doc.slice(at)).split("\n");
        },
        setCursor: (pos: { line: number; ch: number }) => {
            cur = { ...pos };
        },
    };
    return {
        editor: editor as unknown as Editor,
        get doc() {
            return lines.join("\n");
        },
        get cursor() {
            return cur;
        },
    };
}

const dropOf = (items: unknown, mods: Record<string, boolean> = {}) => {
    let prevented = false;
    return {
        shiftKey: false,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        ...mods,
        get defaultPrevented() {
            return prevented;
        },
        preventDefault: () => {
            prevented = true;
        },
        dataTransfer: {
            getData: (type: string) =>
                type === ZOTFLOW_SOURCE_LINKS_MIME && items !== undefined
                    ? JSON.stringify({ type: "zotflow-source-links", items })
                    : "",
        },
    } as unknown as DragEvent;
};

const info = { file: { path: "Notes/Reading.md" } } as unknown as MarkdownView;
const item = (key: string) => ({ libraryID: 1, key });

beforeEach(() => {
    state.indexed = { AAAA: "Source/@doe2024.md", BBBB: "Source/@roe2021.md", CCCC: "Source/@poe1845.md" };
    state.inVault = new Set(Object.values(state.indexed));
    state.ensured = [];
    state.ensureFails = new Set();
    state.notices = [];
});

describe("planLinkDrop", () => {
    it("one link goes where the drop is and nowhere else", () => {
        expect(planLinkDrop("- item", ["[[a]]"])).toEqual({ atCursor: "[[a]]", afterLine: "" });
    });

    it("in plain text the further links each get a line", () => {
        expect(planLinkDrop("some text", ["[[a]]", "[[b]]", "[[c]]"])).toEqual({
            atCursor: "[[a]]",
            afterLine: "\n[[b]]\n[[c]]",
        });
    });

    it("in a list they each get a list line, with the same marker and indent", () => {
        expect(planLinkDrop("  * first", ["[[a]]", "[[b]]"]).afterLine).toBe("\n  * [[b]]");
        expect(planLinkDrop("- ", ["[[a]]", "[[b]]", "[[c]]"]).afterLine).toBe("\n- [[b]]\n- [[c]]");
        expect(planLinkDrop("\t+ x", ["[[a]]", "[[b]]"]).afterLine).toBe("\n\t+ [[b]]");
    });

    it("a numbered list counts on", () => {
        expect(planLinkDrop("3. third", ["[[a]]", "[[b]]", "[[c]]"]).afterLine).toBe("\n4. [[b]]\n5. [[c]]");
        expect(planLinkDrop("  9) x", ["[[a]]", "[[b]]"]).afterLine).toBe("\n  10) [[b]]");
    });

    it("a task list gets open tasks", () => {
        expect(planLinkDrop("- [x] done", ["[[a]]", "[[b]]"]).afterLine).toBe("\n- [ ] [[b]]");
    });

    it("quote markers carry over, with or without a list in them", () => {
        expect(planLinkDrop("> quoted", ["[[a]]", "[[b]]"]).afterLine).toBe("\n> [[b]]");
        expect(planLinkDrop("> - quoted item", ["[[a]]", "[[b]]"]).afterLine).toBe("\n> - [[b]]");
    });

    it("only real list markers start a list (a number with a full stop is one)", () => {
        expect(planLinkDrop("-not a list", ["[[a]]", "[[b]]"]).afterLine).toBe("\n[[b]]");
        expect(planLinkDrop("2024. A year", ["[[a]]", "[[b]]"]).afterLine).toBe("\n2025. [[b]]");
    });
});

describe("parseSourceLinksPayload", () => {
    it("accepts the browser's payload and drops malformed items", () => {
        expect(
            parseSourceLinksPayload(
                JSON.stringify({ type: "zotflow-source-links", items: [item("AAAA"), { key: 5 }, null] }),
            ),
        ).toEqual({ type: "zotflow-source-links", items: [item("AAAA")] });
    });

    it("rejects anything else", () => {
        expect(parseSourceLinksPayload("not json")).toBeNull();
        expect(parseSourceLinksPayload(JSON.stringify({ type: "zotflow-citation", items: [item("AAAA")] }))).toBeNull();
        expect(parseSourceLinksPayload(JSON.stringify({ type: "zotflow-source-links", items: [] }))).toBeNull();
        expect(parseSourceLinksPayload(JSON.stringify({ type: "zotflow-source-links" }))).toBeNull();
        expect(parseSourceLinksPayload("null")).toBeNull();
    });
});

describe("handleSourceLinkDrop", () => {
    it("leaves other drops, and drops with a modifier key, alone", () => {
        const e = fakeEditor("x", { line: 0, ch: 1 });
        expect(handleSourceLinkDrop(dropOf(undefined), e.editor, info)).toBe(false);
        for (const mod of ["shiftKey", "ctrlKey", "metaKey", "altKey"]) {
            const evt = dropOf([item("AAAA")], { [mod]: true });
            expect(handleSourceLinkDrop(evt, e.editor, info)).toBe(false);
            expect(evt.defaultPrevented).toBe(false);
        }
        expect(e.doc).toBe("x");
    });

    it("inserts one link at the cursor, written the way the vault writes links", async () => {
        const e = fakeEditor("see  here", { line: 0, ch: 4 });
        const evt = dropOf([item("AAAA")]);
        expect(handleSourceLinkDrop(evt, e.editor, info)).toBe(true);
        expect(evt.defaultPrevented).toBe(true);
        await vi.waitFor(() => expect(e.doc).not.toBe("see  here"));
        expect(e.doc).toBe("see [[Source/@doe2024|from Notes/Reading.md]] here");
        expect(state.ensured).toEqual([]);
    });

    it("several items in a list: each on a list line of its own, below the line dropped into", async () => {
        const e = fakeEditor("intro\n- \n- after", { line: 1, ch: 2 });
        handleSourceLinkDrop(dropOf([item("AAAA"), item("BBBB"), item("CCCC")]), e.editor, info);
        await vi.waitFor(() => expect(e.doc).toContain("poe1845"));
        expect(e.doc).toBe(
            [
                "intro",
                "- [[Source/@doe2024|from Notes/Reading.md]]",
                "- [[Source/@roe2021|from Notes/Reading.md]]",
                "- [[Source/@poe1845|from Notes/Reading.md]]",
                "- after",
            ].join("\n"),
        );
        // The cursor ends up behind the last link.
        expect(e.cursor).toEqual({ line: 3, ch: "- [[Source/@poe1845|from Notes/Reading.md]]".length });
    });

    it("dropped into the middle of a line: the first link there, the rest after the whole line", async () => {
        const e = fakeEditor("left right", { line: 0, ch: 5 });
        handleSourceLinkDrop(dropOf([item("AAAA"), item("BBBB")]), e.editor, info);
        await vi.waitFor(() => expect(e.doc).toContain("roe2021"));
        expect(e.doc).toBe(
            "left [[Source/@doe2024|from Notes/Reading.md]]right\n[[Source/@roe2021|from Notes/Reading.md]]",
        );
    });

    it("gives an item without a source note one, and links it by path until the vault knows the file", async () => {
        const e = fakeEditor("", { line: 0, ch: 0 });
        handleSourceLinkDrop(dropOf([item("NEW1")]), e.editor, info);
        await vi.waitFor(() => expect(e.doc).not.toBe(""));
        expect(state.ensured).toEqual(["NEW1"]);
        expect(e.doc).toBe("[[Source/@NEW1]]");
    });

    it("links what it can and says how many it could not", async () => {
        state.ensureFails = new Set(["BAD1", "BAD2"]);
        const e = fakeEditor("", { line: 0, ch: 0 });
        handleSourceLinkDrop(dropOf([item("BAD1"), item("AAAA"), item("BAD2")]), e.editor, info);
        await vi.waitFor(() => expect(state.notices).toHaveLength(1));
        await vi.waitFor(() => expect(e.doc).not.toBe(""));
        expect(e.doc).toBe("[[Source/@doe2024|from Notes/Reading.md]]");
        expect(state.notices[0]).toMatch(/^2 items/);
    });
});
