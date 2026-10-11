/**
 * ZotFlow Evo (fork): the library tree as a tab in the main area ("library
 * browser"). What a click does there is in `ui/tree-view/evo-browser.ts`.
 * See FORK.md.
 */
import { TREE_VIEW_TYPE } from "ui/tree-view/view";
import { fireAndForgetIn } from "utils/fire-and-forget";

import type { App, Plugin, WorkspaceLeaf } from "obsidian";

const ff = fireAndForgetIn("EvoWorkspace");

function inSidebar(app: App, leaf: WorkspaceLeaf): boolean {
    const root = leaf.getRoot();
    return root === app.workspace.leftSplit || root === app.workspace.rightSplit;
}

/** Open the library tree as a tab in the main area, or show the one already there. */
export async function openLibraryBrowserTab(app: App): Promise<void> {
    const { workspace } = app;
    const existing = workspace
        .getLeavesOfType(TREE_VIEW_TYPE)
        .find((leaf) => !inSidebar(app, leaf));
    if (existing) {
        await workspace.revealLeaf(existing);
        workspace.setActiveLeaf(existing, { focus: true });
        return;
    }
    const leaf = workspace.getLeaf("tab");
    await leaf.setViewState({ type: TREE_VIEW_TYPE, active: true });
    await workspace.revealLeaf(leaf);
}

/** The fork's workspace commands. */
export function registerEvoWorkspaceCommands(plugin: Plugin) {
    plugin.addCommand({
        id: "open-library-browser-tab",
        name: "Open Zotero library in a tab",
        callback: () => {
            ff(
                openLibraryBrowserTab(plugin.app),
                "Failed to open the library browser tab",
            );
        },
    });
}
