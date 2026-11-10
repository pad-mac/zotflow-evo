import type { App, WorkspaceLeaf } from "obsidian";
import { ZOTERO_READER_VIEW_TYPE } from "ui/reader/view-type";

/** An attachment open in a Zotero reader tab. */
export interface OpenReaderRef {
    libraryID: number;
    key: string;
}

/**
 * ZotFlow Evo: the attachments open in Zotero reader tabs, the one in the
 * foreground first: tabs shown (the front tab of their pane) before tabs
 * behind others, each by when it was last active. A tab not loaded yet
 * (Obsidian loads background tabs when first shown) counts too: its state
 * names its attachment. Each attachment once.
 */
export function openReaderRefs(app: App): OpenReaderRef[] {
    const leaves = app.workspace.getLeavesOfType(ZOTERO_READER_VIEW_TYPE);
    const ranked = leaves.map((leaf) => ({
        leaf,
        shown: isShown(leaf),
        // Undocumented, but kept by Obsidian on every leaf: when it was last
        // made active (0 when never).
        active: (leaf as WorkspaceLeaf & { activeTime?: number }).activeTime ?? 0,
    }));
    ranked.sort((a, b) => Number(b.shown) - Number(a.shown) || b.active - a.active);
    const out: OpenReaderRef[] = [];
    const seen = new Set<string>();
    for (const { leaf } of ranked) {
        const state = leaf.getViewState().state as { libraryID?: unknown; itemKey?: unknown } | undefined;
        const libraryID = Number(state?.libraryID);
        const key = typeof state?.itemKey === "string" ? state.itemKey : "";
        if (!libraryID || !key || seen.has(`${libraryID}:${key}`)) continue;
        seen.add(`${libraryID}:${key}`);
        out.push({ libraryID, key });
    }
    return out;
}

function isShown(leaf: WorkspaceLeaf): boolean {
    const el = leaf.view?.containerEl;
    return !!el && el.isShown();
}
