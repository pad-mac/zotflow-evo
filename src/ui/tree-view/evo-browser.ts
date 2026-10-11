/**
 * ZotFlow Evo (fork): the library tree opened as a tab in the main area
 * ("library browser"). There a click on an item opens its attachment.
 * The command that opens the tab is in `ui/evo-workspace.ts`. See FORK.md.
 */
import { workerBridge } from "bridge";
import { services } from "services/services";
import { AttachmentSelectModal } from "ui/modals/attachment-suggest";
import { openAttachment } from "utils/viewer";

import type { App } from "obsidian";
import type { IDBZoteroItem } from "types/db-schema";
import type { AttachmentData } from "types/zotero-item";

/** What the reader can show. */
const READER_CONTENT_TYPES = new Set([
    "application/pdf",
    "application/epub+zip",
    "text/html",
]);

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
 * Open what a click on an item in the library browser stands for: its PDF,
 * EPUB or web snapshot. With several of them, ask which.
 */
export async function openItemPrimaryAttachment(
    libraryID: number,
    key: string,
    app: App,
): Promise<void> {
    const attachments = (
        (await workerBridge.dbHelper.getAttachments(
            libraryID,
            key,
        )) as IDBZoteroItem<AttachmentData>[]
    ).filter((a) => READER_CONTENT_TYPES.has(a.raw?.data?.contentType ?? ""));

    if (attachments.length === 0) {
        services.notificationService.notify(
            "warning",
            "This item has no PDF, EPUB or web snapshot.",
        );
        return;
    }
    const only = attachments[0];
    if (attachments.length === 1 && only) {
        await openAttachment(only.libraryID, only.key, app);
        return;
    }
    const parent = await workerBridge.dbHelper.getItem(libraryID, key);
    if (!parent) {
        services.notificationService.notify(
            "warning",
            "Item not found in the local database.",
        );
        return;
    }
    new AttachmentSelectModal(app, parent, attachments).open();
}

