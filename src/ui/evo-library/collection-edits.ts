/**
 * ZotFlow Evo (fork): renaming and moving collections. ZotFlow's sync only
 * downloads collections, so these edits go straight to Zotero's web API
 * (as Zotero's own client sends them), are shown here at once, and a quiet
 * sync follows. See FORK.md.
 */
import { requestUrl } from "obsidian";

import { workerBridge } from "bridge";
import { services } from "services/services";
import { startSync } from "ui/start-sync";

type Patch = { name?: string; parentCollection?: string | false };

function refusal(libraryID: number): string | null {
    if (!services.settings.zoteroapikey) return "No Zotero API key is set.";
    if (!services.libraryCache.canWrite(libraryID))
        return "The API key may not write to this library.";
    return null;
}

async function patchCollection(
    libraryID: number,
    key: string,
    patch: Patch,
    what: string,
): Promise<boolean> {
    const notify = services.notificationService;
    const refused = refusal(libraryID);
    if (refused) {
        notify.notify("error", `Couldn't ${what}. ${refused}`);
        return false;
    }
    try {
        const info = await workerBridge.evoLibrary.collectionInfo(
            libraryID,
            key,
        );
        if (!info) throw new Error("The collection is not here (any more).");
        const prefix = services.libraryCache.isGroup(libraryID)
            ? `groups/${libraryID}`
            : `users/${libraryID}`;
        const res = await requestUrl({
            url: `https://api.zotero.org/${prefix}/collections/${key}`,
            method: "PATCH",
            headers: {
                "Zotero-API-Key": services.settings.zoteroapikey,
                "Zotero-API-Version": "3",
                "If-Unmodified-Since-Version": String(info.version),
            },
            contentType: "application/json",
            body: JSON.stringify(patch),
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
        const version = Number(
            res.headers["last-modified-version"] ??
                res.headers["Last-Modified-Version"] ??
                0,
        );
        await workerBridge.evoLibrary.collectionWritten(
            libraryID,
            key,
            patch,
            version,
        );
        void startSync(libraryID, true).catch(() => {});
        return true;
    } catch (e) {
        services.logService.error(`Failed to ${what}`, "EvoLibrary", e);
        notify.notify(
            "error",
            `Couldn't ${what}. ${e instanceof Error ? e.message : ""}`,
        );
        return false;
    }
}

export function renameCollection(
    libraryID: number,
    key: string,
    name: string,
): Promise<boolean> {
    return patchCollection(libraryID, key, { name }, "rename the collection");
}

/** Into another collection (`parentKey`), or to the top of its library (null). */
export function moveCollection(
    libraryID: number,
    key: string,
    parentKey: string | null,
): Promise<boolean> {
    return patchCollection(
        libraryID,
        key,
        { parentCollection: parentKey ?? false },
        "move the collection",
    );
}
