/**
 * ZotFlow Evo (fork): workspace commands. "Open Zotero library in a tab"
 * opens the library browser (ui/evo-library/). See FORK.md.
 */
import { openLibraryBrowser } from "ui/evo-library/actions";
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
}
