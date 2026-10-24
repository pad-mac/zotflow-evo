/**
 * ZotFlow Evo (fork): the reader's command for a book section of the part
 * being read (ui/evo-library/book-section.ts). See FORK.md.
 */
import { ZoteroReaderView } from "ui/reader/view";

import type { Plugin } from "obsidian";

export function registerBookSectionCommand(plugin: Plugin): void {
    plugin.addCommand({
        id: "evo-create-book-section",
        name: "Create book section from the chapter being read",
        checkCallback: (checking) => {
            const view =
                plugin.app.workspace.getActiveViewOfType(ZoteroReaderView);
            if (!view) return false;
            if (!checking) void view.evoBookSection();
            return true;
        },
    });
}
