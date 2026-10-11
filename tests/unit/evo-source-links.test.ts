/**
 * ZotFlow Evo: `ui/evo-source-links.ts` — a click on a link to a source
 * note opens the item's PDF. The cases that matter are the ones that must
 * still open the note.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";

import { registerSourceNoteLinks, sourceNoteTarget } from "ui/evo-source-links";

import type { App, Plugin } from "obsidian";

interface MockState {
    enabled: boolean;
    attachmentOpens: boolean;
    opened: { libraryID: number; key: string; quiet: boolean | undefined }[];
    openThrows: boolean;
    errors: string[];
}

const state = vi.hoisted(() => ({
    enabled: true,
    attachmentOpens: true,
    opened: [],
    openThrows: false,
    errors: [],
})) as unknown as MockState;

vi.mock("services/services", () => ({
    services: {
        get settings() {
            return { evoSourceLinksOpenAttachment: state.enabled };
        },
        logService: { error: (m: string) => state.errors.push(m) },
    },
}));
vi.mock("ui/reader/local-view", () => ({ LOCAL_ZOTERO_READER_VIEW_TYPE: "local-reader" }));
vi.mock("utils/evo-reader-leaf", () => ({ newReaderLeaf: vi.fn() }));
vi.mock("ui/tree-view/evo-browser", () => ({
    openItemPrimaryAttachment: (libraryID: number, key: string, _app: unknown, options?: { quiet?: boolean }) => {
        if (state.openThrows) return Promise.reject(new Error("worker gone"));
        state.opened.push({ libraryID, key, quiet: options?.quiet });
        return Promise.resolve(state.attachmentOpens);
    },
}));

/** Files by path, each with the frontmatter Obsidian has indexed for it. */
const FILES: Record<string, Record<string, unknown> | undefined> = {
    "Source/@doe2024.md": { "zotero-key": "DOE12345", "library-id": 7 },
    "Source/Local/@scan.md": { "zotflow-local-attachment": "[[Scans/scan.pdf]]" },
    "Notes/Plain.md": { tags: ["x"] },
    "Notes/NoFrontmatter.md": undefined,
    "Scans/scan.pdf": undefined,
    "Source/@broken.md": { "zotero-key": "KEYONLY1" },
};

function fakeApp() {
    const file = (path: string) => {
        const f = new TFile();
        f.path = path;
        f.extension = path.split(".").pop() ?? "";
        return f;
    };
    const originalCalls: unknown[][] = [];
    const workspace = {
        openLinkText: (...args: unknown[]) => {
            originalCalls.push(args);
            return Promise.resolve();
        },
        getLeavesOfType: () => [],
    };
    const app = {
        workspace,
        metadataCache: {
            // Resolves a link by file name, as Obsidian's shortest-path links do.
            getFirstLinkpathDest: (linkpath: string) => {
                const hit = Object.keys(FILES).find(
                    (p) => p === linkpath || p === `${linkpath}.md` || p.endsWith(`/${linkpath}.md`) || p.endsWith(`/${linkpath}`),
                );
                return hit ? file(hit) : null;
            },
            getFileCache: (f: TFile) => ({ frontmatter: FILES[f.path] }),
        },
    } as unknown as App;
    return { app, workspace, originalCalls };
}

const FROM = "Notes/Reading.md";

beforeEach(() => {
    state.enabled = true;
    state.attachmentOpens = true;
    state.opened = [];
    state.openThrows = false;
    state.errors = [];
});

describe("sourceNoteTarget", () => {
    const { app } = fakeApp();

    it("a plain click on a link to a library source note names the item", () => {
        expect(sourceNoteTarget(app, "@doe2024", FROM, false)).toEqual({
            kind: "library",
            libraryID: 7,
            key: "DOE12345",
        });
        expect(sourceNoteTarget(app, "Source/@doe2024", FROM, undefined)).toMatchObject({ key: "DOE12345" });
    });

    it("a local source note names its file", () => {
        expect(sourceNoteTarget(app, "@scan", FROM, false)).toMatchObject({
            kind: "local",
            link: "[[Scans/scan.pdf]]",
        });
    });

    it("the note is opened as always for: a modifier click, a heading or block link, no source file", () => {
        expect(sourceNoteTarget(app, "@doe2024", FROM, "tab")).toBeNull();
        expect(sourceNoteTarget(app, "@doe2024", FROM, true)).toBeNull();
        expect(sourceNoteTarget(app, "@doe2024#Annotations", FROM, false)).toBeNull();
        expect(sourceNoteTarget(app, "@doe2024#^ABCD1234", FROM, false)).toBeNull();
        // The quick switcher and the like pass no source path.
        expect(sourceNoteTarget(app, "Source/@doe2024.md", "", false)).toBeNull();
    });

    it("other notes, other files, missing files and the note's links to itself are left alone", () => {
        expect(sourceNoteTarget(app, "Plain", FROM, false)).toBeNull();
        expect(sourceNoteTarget(app, "NoFrontmatter", FROM, false)).toBeNull();
        expect(sourceNoteTarget(app, "Scans/scan.pdf", FROM, false)).toBeNull();
        expect(sourceNoteTarget(app, "Nowhere", FROM, false)).toBeNull();
        expect(sourceNoteTarget(app, "@doe2024", "Source/@doe2024.md", false)).toBeNull();
        // A key without a library id is not a source note this plugin can open.
        expect(sourceNoteTarget(app, "@broken", FROM, false)).toBeNull();
    });
});

describe("registerSourceNoteLinks", () => {
    function install() {
        const fake = fakeApp();
        const undo: (() => void)[] = [];
        registerSourceNoteLinks({ app: fake.app, register: (cb: () => void) => undo.push(cb) } as unknown as Plugin);
        const open = (linktext: string, sourcePath = FROM, newLeaf: unknown = false) =>
            (fake.workspace.openLinkText)(linktext, sourcePath, newLeaf, { active: true });
        return { ...fake, open, undo };
    }

    it("opens the item's attachment instead of the note", async () => {
        const h = install();
        await h.open("@doe2024");
        expect(state.opened).toEqual([{ libraryID: 7, key: "DOE12345", quiet: true }]);
        expect(h.originalCalls).toEqual([]);
    });

    it("opens the note when the item has nothing to open", async () => {
        state.attachmentOpens = false;
        const h = install();
        await h.open("@doe2024");
        expect(h.originalCalls).toEqual([["@doe2024", FROM, false, { active: true }]]);
    });

    it("opens the note for everything that is not a plain click on a source note link", async () => {
        const h = install();
        await h.open("@doe2024", FROM, "tab");
        await h.open("Plain");
        await h.open("@doe2024#Annotations");
        expect(state.opened).toEqual([]);
        expect(h.originalCalls).toHaveLength(3);
    });

    it("does nothing of its own when switched off", async () => {
        state.enabled = false;
        const h = install();
        await h.open("@doe2024");
        expect(state.opened).toEqual([]);
        expect(h.originalCalls).toHaveLength(1);
    });

    it("opens the note, and logs, if opening the attachment fails", async () => {
        state.openThrows = true;
        const h = install();
        await h.open("@doe2024");
        expect(h.originalCalls).toHaveLength(1);
        expect(state.errors).toHaveLength(1);
    });

    it("is undone when the plugin unloads", async () => {
        const h = install();
        for (const undo of h.undo) undo();
        await h.open("@doe2024");
        expect(state.opened).toEqual([]);
        expect(h.originalCalls).toHaveLength(1);
    });
});
