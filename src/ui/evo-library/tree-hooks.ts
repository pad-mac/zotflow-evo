/**
 * ZotFlow Evo (fork): what the sidebar's library tree (upstream's
 * `ui/tree-view/Node.tsx`) does with a collection: a middle click or
 * Ctrl+right-click opens it in a tab of its own, and its right-click menu
 * offers that and its annotations. See FORK.md.
 */
import { services } from "services/services";
import { openAnnotationsTab, openCollectionTab } from "ui/evo-library/actions";

import type { Menu } from "obsidian";
import type { EvoScope } from "worker/services/evo-library";

/** The part of a tree node this module reads. */
interface TreeNodeLike {
    data: { nodeType: string; libraryID: number; key: string };
}

function scopeOf(node: TreeNodeLike): EvoScope | null {
    const { nodeType, libraryID, key } = node.data;
    if (nodeType === "collection") {
        return {
            libraryID,
            collectionKey: key,
            subcollections: services.settings.evoLibrarySubcollections,
        };
    }
    if (nodeType === "library") {
        return { libraryID, collectionKey: null, subcollections: false };
    }
    return null;
}

/**
 * A middle click, or a right-click with Ctrl/Cmd, on a collection: open it
 * in a tab. Returns whether it did (the caller then does nothing else).
 */
export function openCollectionFromTree(
    node: TreeNodeLike,
    event: { button: number; ctrlKey: boolean; metaKey: boolean; type: string },
): boolean {
    const scope = scopeOf(node);
    if (!scope || scope.collectionKey === null) return false;
    const middle = event.type === "auxclick" && event.button === 1;
    const modRight =
        event.type === "contextmenu" && (event.ctrlKey || event.metaKey);
    if (!middle && !modRight) return false;
    void openCollectionTab(services.app, scope);
    return true;
}

/** The fork's entries in a collection's (or library's) right-click menu. */
export function addCollectionMenuItems(menu: Menu, node: TreeNodeLike): void {
    const scope = scopeOf(node);
    if (!scope) return;
    if (scope.collectionKey !== null) {
        menu.addItem((item) =>
            item
                .setTitle("Open in new tab")
                .setIcon("panel-right-open")
                .onClick(() => void openCollectionTab(services.app, scope)),
        );
    }
    menu.addItem((item) =>
        item
            .setTitle("Show annotations")
            .setIcon("highlighter")
            .onClick(() => void openAnnotationsTab(services.app, scope)),
    );
    menu.addSeparator();
}
