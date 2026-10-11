/**
 * ZotFlow Evo (fork): the library tree opened as a tab in the main area
 * ("library browser"). There
 *  - a click selects an item (Ctrl/Cmd and Shift select several),
 *  - a double click opens it: its PDF, EPUB or snapshot,
 *  - dragged items are dropped as links to their source notes.
 * The command that opens the tab is in `ui/evo-workspace.ts`; what a dropped
 * link becomes is in `ui/editor/evo-link-drop.ts`. See FORK.md.
 */
import { workerBridge } from "bridge";
import { services } from "services/services";
import { ZOTFLOW_SOURCE_LINKS_MIME } from "ui/editor/evo-link-drop";
import { AttachmentSelectModal } from "ui/modals/attachment-suggest";
import { openAttachment } from "utils/viewer";

import type { App } from "obsidian";
import type { IDBZoteroItem } from "types/db-schema";
import type { AttachmentData } from "types/zotero-item";
import type { SourceLinksPayload } from "ui/editor/evo-link-drop";

/** What the reader can show. */
const READER_CONTENT_TYPES = new Set([
    "application/pdf",
    "application/epub+zip",
    "text/html",
]);

/** The part of a tree node (react-arborist's `NodeApi`) this module uses. */
export interface BrowserNode {
    data: {
        nodeType: string;
        itemType?: string;
        libraryID: number;
        key: string;
    };
    isSelected: boolean;
    select(): void;
    selectMulti(): void;
    selectContiguous(): void;
    deselect(): void;
    tree: { selectedNodes: BrowserNode[] };
}

/**
 * True for an element of the library tree when that tree is a tab in the
 * main area (or a pop-out window), not in a sidebar.
 */
export function isLibraryBrowserTab(el: Element | null): boolean {
    if (!el?.closest(".workspace-leaf")) return false;
    return !el.closest(
        ".mod-left-split, .mod-right-split, .workspace-drawer, .workspace-sidedock",
    );
}

/**
 * A click in the library browser: select the item; with Ctrl/Cmd add it to
 * or take it out of the selection, with Shift select up to it.
 */
export function selectBrowserNode(
    node: BrowserNode,
    event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
): void {
    if (event.ctrlKey || event.metaKey) {
        if (node.isSelected) node.deselect();
        else node.selectMulti();
    } else if (event.shiftKey) {
        node.selectContiguous();
    } else {
        node.select();
    }
}

/** Whether a node is a regular Zotero item: one that has a source note. */
function hasSourceNote(node: BrowserNode): boolean {
    return (
        node.data.nodeType === "item" &&
        node.data.itemType !== "attachment" &&
        node.data.itemType !== "note"
    );
}

/**
 * The items a drag from the library browser carries: every selected item if
 * the dragged one is among them, else the dragged one alone. Attachments
 * and notes have no source note and are left out.
 */
export function draggedItems(
    node: BrowserNode,
): SourceLinksPayload["items"] {
    const selected = node.tree.selectedNodes;
    const nodes =
        node.isSelected && selected.length > 1 ? selected : [node];
    return nodes
        .filter(hasSourceNote)
        .map((n) => ({ libraryID: n.data.libraryID, key: n.data.key }));
}

/**
 * Mark a drag that starts in the library browser so that it drops links to
 * the items' source notes. Returns how many links it carries (0: none, the
 * drag stays what it was).
 */
export function setSourceLinkDrag(
    dataTransfer: DataTransfer,
    node: BrowserNode,
): number {
    const items = draggedItems(node);
    if (!items.length) return 0;
    const payload: SourceLinksPayload = { type: "zotflow-source-links", items };
    dataTransfer.setData(ZOTFLOW_SOURCE_LINKS_MIME, JSON.stringify(payload));
    return items.length;
}

/**
 * Open what an item stands for: its PDF, EPUB or web snapshot. With several
 * of them, ask which. Resolves to whether there was something to open;
 * `quiet` leaves out the notice when there was not.
 */
export async function openItemPrimaryAttachment(
    libraryID: number,
    key: string,
    app: App,
    { quiet = false }: { quiet?: boolean } = {},
): Promise<boolean> {
    const readable = (a: IDBZoteroItem<AttachmentData>) =>
        READER_CONTENT_TYPES.has(a.raw?.data?.contentType ?? "");
    const attachments = (
        (await workerBridge.dbHelper.getAttachments(
            libraryID,
            key,
        )) as IDBZoteroItem<AttachmentData>[]
    ).filter(readable);

    const only = attachments[0];
    if (attachments.length === 1 && only) {
        await openAttachment(only.libraryID, only.key, app);
        return true;
    }

    const item = await workerBridge.dbHelper.getItem(libraryID, key);
    if (attachments.length === 0) {
        // The item may itself be the file (a PDF without a parent item).
        if (item?.itemType === "attachment" && readable(item)) {
            await openAttachment(libraryID, key, app);
            return true;
        }
        if (!quiet) {
            services.notificationService.notify(
                "warning",
                "This item has no PDF, EPUB or web snapshot.",
            );
        }
        return false;
    }
    if (!item) {
        if (!quiet) {
            services.notificationService.notify(
                "warning",
                "Item not found in the local database.",
            );
        }
        return false;
    }
    new AttachmentSelectModal(app, item, attachments).open();
    return true;
}
