/**
 * ZotFlow Evo (fork): workspace commands. "Open Zotero library in a tab"
 * opens the library browser (ui/evo-library/). See FORK.md.
 */
import {
    openDetailsTab,
    openFulltextSearch,
    openLibraryBrowser,
} from "ui/evo-library/actions";
import { EvoCollectionView, EvoLibraryView } from "ui/evo-library/views";
import { fireAndForgetIn } from "utils/fire-and-forget";

import type { Plugin } from "obsidian";

const ff = fireAndForgetIn("EvoWorkspace");

/** The fork's workspace commands. */
export function registerEvoWorkspaceCommands(plugin: Plugin) {
    plugin.addCommand({
        id: "open-library-browser-tab",
        name: "Open Zotero library in a tab",
        callback: () => {
            ff(
                openLibraryBrowser(plugin.app),
                "Failed to open the library browser",
            );
        },
    });

    // Ctrl/Cmd+F in a library tab: the filter field (Obsidian's own Ctrl+F
    // needs an editor, so it does not compete here).
    plugin.addCommand({
        id: "filter-library-table",
        name: "Filter the Zotero table",
        // The user asked for these defaults; they can be changed in Hotkeys.
        hotkeys: [{ modifiers: ["Mod"], key: "F" }],
        checkCallback: (checking) => {
            const { workspace } = plugin.app;
            const view =
                workspace.getActiveViewOfType(EvoLibraryView) ??
                workspace.getActiveViewOfType(EvoCollectionView);
            if (!view) return false;
            if (!checking) view.focusFilter();
            return true;
        },
    });

    plugin.addCommand({
        id: "search-my-library",
        name: "Search My Library",
        hotkeys: [{ modifiers: ["Mod", "Alt"], key: "F" }],
        callback: () => {
            ff(
                (async () => {
                    const leaf = await openLibraryBrowser(plugin.app);
                    const view = leaf.view;
                    if (!(view instanceof EvoLibraryView)) return;
                    // After a fresh tab has drawn.
                    await new Promise((r) => window.setTimeout(r, 60));
                    view.goTo(null);
                    view.focusFilter();
                })(),
                "Failed to open the library browser",
            );
        },
    });

    plugin.addCommand({
        id: "open-item-details",
        name: "Open the selected Zotero item in a pane",
        callback: () => {
            ff(openDetailsTab(plugin.app), "Failed to open the item pane");
        },
    });

    plugin.addCommand({
        id: "fulltext-search",
        name: "Search the full text of Zotero documents",
        callback: () => {
            const { workspace } = plugin.app;
            const view =
                workspace.getActiveViewOfType(EvoLibraryView) ??
                workspace.getActiveViewOfType(EvoCollectionView);
            const target = view?.currentTarget();
            ff(
                openFulltextSearch(plugin.app, target ? [target] : []),
                "Failed to open the full-text search",
            );
        },
    });
}
