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

import {
    ANNOTATIONS_ICON,
    ANNOTATIONS_ICON_FALLBACK,
    iconOr,
} from "ui/evo-library/parts";

import type { App, WorkspaceLeaf } from "obsidian";
import type { EvoItemRow } from "utils/evo-library-model";
import type { EvoScope } from "worker/services/evo-library";

/** Edits the item menu offers on the selection (the question comes at the row). */
export interface ItemMenuEdits {
    /** In a collection: take the selection out of it. */
    onRemove?: () => void;
    onTrash?: () => void;
}

/** Right-click on a row. */
export function showItemMenu(
    app: App,
    leaf: WorkspaceLeaf,
    row: EvoItemRow,
    event: MouseEvent,
    edits: ItemMenuEdits = {},
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
    if (edits.onRemove || edits.onTrash) menu.addSeparator();
    if (edits.onRemove) {
        const onRemove = edits.onRemove;
        menu.addItem((item) =>
            item
                .setTitle("Remove from collection…")
                .setIcon("folder-minus")
                .onClick(onRemove),
        );
    }
    if (edits.onTrash) {
        const onTrash = edits.onTrash;
        menu.addItem((item) =>
            item
                .setTitle("Move to trash…")
                .setIcon("trash-2")
                .setWarning(true)
                .onClick(onTrash),
        );
    }
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
        /** Whether it is pinned to the top; absent for a library. */
        pinned?: boolean;
        onPin?: (on: boolean) => void;
    },
): void {
    const menu = new Menu();
    if (scope.collectionKey !== null && options.onPin) {
        const { onPin, pinned } = options;
        menu.addItem((item) =>
            item
                .setTitle(pinned ? "Unpin" : "Pin to the top")
                .setIcon(pinned ? "pin-off" : "pin")
                .onClick(() => onPin(!pinned)),
        );
    }
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
            .setIcon(iconOr(ANNOTATIONS_ICON, ANNOTATIONS_ICON_FALLBACK))
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
