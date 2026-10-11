/**
 * ZotFlow Evo: `ui/tree-view/evo-browser.ts` — the library tree as a tab:
 * selecting, what a drag carries, and what "open this item" opens.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
    draggedItems,
    openItemPrimaryAttachment,
    selectBrowserNode,
    setSourceLinkDrag,
} from "ui/tree-view/evo-browser";
import { ZOTFLOW_SOURCE_LINKS_MIME } from "ui/editor/evo-link-drop";

import type { App } from "obsidian";
import type { BrowserNode } from "ui/tree-view/evo-browser";

interface MockState {
    attachments: { libraryID: number; key: string; itemType: string; raw: { data: { contentType: string } } }[];
    item: unknown;
    opened: string[];
    modals: { parent: unknown; choices: string[] }[];
    notices: string[];
}

const state = vi.hoisted(() => ({
    attachments: [],
    item: null,
    opened: [],
    modals: [],
    notices: [],
})) as unknown as MockState;

vi.mock("bridge", () => ({
    workerBridge: {
        dbHelper: {
            getAttachments: () => Promise.resolve(state.attachments),
            getItem: () => Promise.resolve(state.item),
        },
    },
}));
vi.mock("services/services", () => ({
    services: {
        notificationService: {
            notify: (_type: string, m: string) => state.notices.push(m),
        },
    },
}));
vi.mock("utils/viewer", () => ({
    openAttachment: (_libraryID: number, key: string) => {
        state.opened.push(key);
        return Promise.resolve();
    },
}));
vi.mock("ui/modals/attachment-suggest", () => ({
    AttachmentSelectModal: class {
        constructor(_app: unknown, parent: unknown, attachments: { key: string }[]) {
            state.modals.push({ parent, choices: attachments.map((a) => a.key) });
        }
        open() {}
    },
}));

const app = {} as App;
const file = (key: string, contentType: string) => ({
    libraryID: 1,
    key,
    itemType: "attachment",
    raw: { data: { contentType } },
});

/** A tree of nodes with the selection calls react-arborist offers, recorded. */
function tree(defs: { key: string; nodeType?: string; itemType?: string }[]) {
    const calls: string[] = [];
    const selected = new Set<string>();
    const nodes: BrowserNode[] = [];
    const holder = {
        get selectedNodes() {
            return nodes.filter((n) => selected.has(n.data.key));
        },
    };
    for (const def of defs) {
        const key = def.key;
        nodes.push({
            data: { nodeType: def.nodeType ?? "item", itemType: def.itemType ?? "journalArticle", libraryID: 1, key },
            get isSelected() {
                return selected.has(key);
            },
            select: () => {
                calls.push(`select ${key}`);
                selected.clear();
                selected.add(key);
            },
            selectMulti: () => {
                calls.push(`multi ${key}`);
                selected.add(key);
            },
            selectContiguous: () => {
                calls.push(`upto ${key}`);
                let inside = false;
                const anchor = [...selected][0];
                for (const n of nodes) {
                    if (n.data.key === anchor || n.data.key === key) {
                        selected.add(n.data.key);
                        if (anchor !== key) inside = !inside;
                    } else if (inside) selected.add(n.data.key);
                }
            },
            deselect: () => {
                calls.push(`deselect ${key}`);
                selected.delete(key);
            },
            tree: holder,
        });
    }
    return { nodes, calls, selected: () => holder.selectedNodes.map((n) => n.data.key) };
}

const click = (mods: Partial<Record<"ctrlKey" | "metaKey" | "shiftKey", boolean>> = {}) => ({
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...mods,
});

beforeEach(() => {
    state.attachments = [];
    state.item = null;
    state.opened = [];
    state.modals = [];
    state.notices = [];
});

describe("selectBrowserNode", () => {
    it("a click selects one item, replacing the selection", () => {
        const t = tree([{ key: "A" }, { key: "B" }]);
        selectBrowserNode(t.nodes[0]!, click());
        selectBrowserNode(t.nodes[1]!, click());
        expect(t.selected()).toEqual(["B"]);
    });

    it("Ctrl or Cmd adds an item, and takes a selected one out again", () => {
        const t = tree([{ key: "A" }, { key: "B" }, { key: "C" }]);
        selectBrowserNode(t.nodes[0]!, click());
        selectBrowserNode(t.nodes[2]!, click({ ctrlKey: true }));
        selectBrowserNode(t.nodes[1]!, click({ metaKey: true }));
        expect(t.selected()).toEqual(["A", "B", "C"]);
        selectBrowserNode(t.nodes[0]!, click({ ctrlKey: true }));
        expect(t.selected()).toEqual(["B", "C"]);
    });

    it("Shift selects up to the item", () => {
        const t = tree([{ key: "A" }, { key: "B" }, { key: "C" }, { key: "D" }]);
        selectBrowserNode(t.nodes[0]!, click());
        selectBrowserNode(t.nodes[2]!, click({ shiftKey: true }));
        expect(t.selected()).toEqual(["A", "B", "C"]);
        expect(t.calls).toEqual(["select A", "upto C"]);
    });
});

describe("what a drag carries", () => {
    it("the dragged item alone when it is not part of a selection", () => {
        const t = tree([{ key: "A" }, { key: "B" }, { key: "C" }]);
        selectBrowserNode(t.nodes[0]!, click());
        selectBrowserNode(t.nodes[1]!, click({ ctrlKey: true }));
        expect(draggedItems(t.nodes[2]!)).toEqual([{ libraryID: 1, key: "C" }]);
    });

    it("every selected item when the dragged one is among them, in tree order", () => {
        const t = tree([{ key: "A" }, { key: "B" }, { key: "C" }]);
        selectBrowserNode(t.nodes[2]!, click());
        selectBrowserNode(t.nodes[0]!, click({ ctrlKey: true }));
        expect(draggedItems(t.nodes[2]!)).toEqual([
            { libraryID: 1, key: "A" },
            { libraryID: 1, key: "C" },
        ]);
    });

    it("leaves out what has no source note: attachments, notes, collections", () => {
        const t = tree([
            { key: "A" },
            { key: "PDF", itemType: "attachment" },
            { key: "NOTE", itemType: "note" },
            { key: "COLL", nodeType: "collection" },
        ]);
        selectBrowserNode(t.nodes[0]!, click());
        for (const n of t.nodes.slice(1)) selectBrowserNode(n, click({ ctrlKey: true }));
        expect(draggedItems(t.nodes[0]!)).toEqual([{ libraryID: 1, key: "A" }]);
        expect(draggedItems(tree([{ key: "PDF", itemType: "attachment" }]).nodes[0]!)).toEqual([]);
    });

    it("is put on the drag as the source-links payload; nothing for an attachment", () => {
        const set = vi.fn();
        const dt = { setData: set } as unknown as DataTransfer;
        const t = tree([{ key: "A" }, { key: "B" }, { key: "PDF", itemType: "attachment" }]);
        selectBrowserNode(t.nodes[0]!, click());
        selectBrowserNode(t.nodes[1]!, click({ shiftKey: true }));

        expect(setSourceLinkDrag(dt, t.nodes[1]!)).toBe(2);
        expect(set).toHaveBeenCalledWith(
            ZOTFLOW_SOURCE_LINKS_MIME,
            JSON.stringify({
                type: "zotflow-source-links",
                items: [
                    { libraryID: 1, key: "A" },
                    { libraryID: 1, key: "B" },
                ],
            }),
        );
        set.mockClear();
        expect(setSourceLinkDrag(dt, t.nodes[2]!)).toBe(0);
        expect(set).not.toHaveBeenCalled();
    });
});

describe("openItemPrimaryAttachment", () => {
    it("opens the one PDF, EPUB or snapshot an item has, ignoring other files", async () => {
        state.attachments = [file("ZIP1", "application/zip"), file("PDF1", "application/pdf")];
        expect(await openItemPrimaryAttachment(1, "ITEM", app)).toBe(true);
        expect(state.opened).toEqual(["PDF1"]);
        expect(state.modals).toEqual([]);
    });

    it("asks when there are several", async () => {
        state.attachments = [file("PDF1", "application/pdf"), file("EPUB", "application/epub+zip"), file("HTML", "text/html")];
        state.item = { key: "ITEM" };
        expect(await openItemPrimaryAttachment(1, "ITEM", app)).toBe(true);
        expect(state.opened).toEqual([]);
        expect(state.modals).toEqual([{ parent: state.item, choices: ["PDF1", "EPUB", "HTML"] }]);
    });

    it("opens the item itself when it is a file without a parent", async () => {
        state.item = file("LONE", "application/pdf");
        expect(await openItemPrimaryAttachment(1, "LONE", app)).toBe(true);
        expect(state.opened).toEqual(["LONE"]);
    });

    it("says so when there is nothing to open — unless asked to be quiet", async () => {
        state.attachments = [file("ZIP1", "application/zip")];
        state.item = { key: "ITEM", itemType: "journalArticle" };
        expect(await openItemPrimaryAttachment(1, "ITEM", app)).toBe(false);
        expect(state.notices).toHaveLength(1);
        expect(await openItemPrimaryAttachment(1, "ITEM", app, { quiet: true })).toBe(false);
        expect(state.notices).toHaveLength(1);
        expect(state.opened).toEqual([]);
    });
});
