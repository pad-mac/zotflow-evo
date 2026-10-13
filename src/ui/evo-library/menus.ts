/**
 * ZotFlow Evo (fork): the context menus of the library browser and the
 * collection tabs. See FORK.md.
 */
import { Menu } from "obsidian";

import {
    openAnnotationsTab,
    openBookSearch,
    openCollectionTab,
    openItem,
    openSourceNote,
    showInZotero,
} from "ui/evo-library/actions";

import type { App, WorkspaceLeaf } from "obsidian";
import type { EvoItemRow } from "utils/evo-library-model";
import type { EvoScope } from "worker/services/evo-library";

/** Right-click on a row. */
export function showItemMenu(
    app: App,
    leaf: WorkspaceLeaf,
    row: EvoItemRow,
    event: MouseEvent,
): void {
    const menu = new Menu();
    const regular = row.itemType !== "attachment" && row.itemType !== "note";
    if (row.attachment || row.itemType === "attachment") {
        menu.addItem((item) =>
            item
                .setTitle("Open")
                .setIcon("book-open")
                .onClick(() => openItem(app, row.libraryID, row.key)),
        );
    }
    if (regular) {
        menu.addItem((item) =>
            item
                .setTitle("Open source note")
                .setIcon("file-badge")
                .onClick(() => openSourceNote(row.libraryID, row.key)),
        );
    }
    if (regular && !row.attachment) {
        menu.addItem((item) =>
            item
                .setTitle("Search for the file")
                .setIcon("search")
                .onClick(() => void openBookSearch(app, leaf, row)),
        );
    }
    menu.addItem((item) =>
        item
            .setTitle("Show in Zotero")
            .setIcon("external-link")
            .onClick(() => showInZotero(row.libraryID, row.key)),
    );
    menu.showAtMouseEvent(event);
}

/** Right-click on a collection (or a library) in the browser's left pane. */
export function showCollectionMenu(
    app: App,
    scope: EvoScope,
    event: MouseEvent,
    options: {
        subcollections: boolean;
        onSubcollections: (on: boolean) => void;
    },
): void {
    const menu = new Menu();
    if (scope.collectionKey !== null) {
        menu.addItem((item) =>
            item
                .setTitle("Open in new tab")
                .setIcon("panel-right-open")
                .onClick(() => void openCollectionTab(app, scope)),
        );
    }
    menu.addItem((item) =>
        item
            .setTitle("Show annotations")
            .setIcon("highlighter")
            .onClick(() => void openAnnotationsTab(app, scope)),
    );
    menu.addSeparator();
    menu.addItem((item) =>
        item
            .setTitle("Show items from sub-collections")
            .setChecked(options.subcollections)
            .onClick(() => options.onSubcollections(!options.subcollections)),
    );
    menu.showAtMouseEvent(event);
}
