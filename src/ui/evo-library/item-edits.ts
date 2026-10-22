/**
 * ZotFlow Evo (fork): changing an item's type. ZotFlow's local edits may
 * not change an item's type (the sync model keeps it fixed), so this goes
 * to Zotero's web API as the whole item in its new type (PUT, only if it
 * has not changed there since this device's copy), and a quiet sync
 * brings it back. Fields are written by the worker (`setItemFields`).
 */
import { requestUrl } from "obsidian";

import { workerBridge } from "bridge";
import { services } from "services/services";
import { startSync } from "ui/start-sync";
import { changeItemType } from "utils/evo-item-type";

import type { TypeChange } from "utils/evo-item-type";

interface StoredItem {
    version?: number;
    synced?: number;
    syncStatus?: string;
    raw?: { data?: Record<string, unknown> };
}

/** What changing the type would do (null: the item is not here). */
export async function previewTypeChange(
    libraryID: number,
    key: string,
    newType: string,
): Promise<TypeChange | null> {
    const item = (await workerBridge.dbHelper.getItem(
        libraryID,
        key,
    )) as unknown as StoredItem | null;
    const data = item?.raw?.data;
    return data ? changeItemType(data, newType) : null;
}

export async function setItemType(
    libraryID: number,
    key: string,
    newType: string,
): Promise<boolean> {
    const notify = services.notificationService;
    try {
        if (!services.settings.zoteroapikey)
            throw new Error("No Zotero API key is set.");
        if (!services.libraryCache.canWrite(libraryID))
            throw new Error("The API key may not write to this library.");
        const item = (await workerBridge.dbHelper.getItem(
            libraryID,
            key,
        )) as unknown as StoredItem | null;
        const data = item?.raw?.data;
        if (!item || !data) throw new Error("The item is not here.");
        if (item.syncStatus !== "synced")
            throw new Error(
                "It has changes not synced yet; sync, then change its type.",
            );
        const { data: next } = changeItemType(data, newType);
        delete next.dateModified;
        const prefix = services.libraryCache.isGroup(libraryID)
            ? `groups/${libraryID}`
            : `users/${libraryID}`;
        const res = await requestUrl({
            url: `https://api.zotero.org/${prefix}/items/${key}`,
            method: "PUT",
            headers: {
                "Zotero-API-Key": services.settings.zoteroapikey,
                "Zotero-API-Version": "3",
                "If-Unmodified-Since-Version": String(item.version ?? 0),
            },
            contentType: "application/json",
            body: JSON.stringify(next),
            throw: false,
        });
        if (res.status === 412) {
            void startSync(libraryID, true).catch(() => {});
            throw new Error(
                "It was changed elsewhere meanwhile; ZotFlow is syncing, try again in a moment.",
            );
        }
        if (res.status >= 300)
            throw new Error(`Zotero answered ${res.status}.`);
        void startSync(libraryID, true).catch(() => {});
        return true;
    } catch (e) {
        services.logService.error(
            "Failed to change the item type",
            "EvoLibrary",
            e,
        );
        notify.notify(
            "error",
            `Couldn't change the item type. ${e instanceof Error ? e.message : ""}`,
        );
        return false;
    }
}
