/**
 * ZotFlow Evo (fork): creating, renaming, moving, trashing and restoring
 * collections. ZotFlow's sync only downloads collections, so these edits go
 * straight to Zotero's web API (as Zotero's own client sends them), are
 * shown here at once, and a quiet sync follows. See FORK.md.
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

/** A collection as Zotero's API answers a write. */
interface WrittenCollection {
    key: string;
    version: number;
    data: Record<string, unknown>;
}

function libraryPrefix(libraryID: number): string {
    return services.libraryCache.isGroup(libraryID)
        ? `groups/${libraryID}`
        : `users/${libraryID}`;
}

function writeToken(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Write several collections in one request (Zotero's multi-object write:
 * objects with a key and version are changed field by field, those without
 * are created). Returns the written collections, in the order given.
 */
async function writeCollections(
    libraryID: number,
    objects: Record<string, unknown>[],
): Promise<WrittenCollection[]> {
    const res = await requestUrl({
        url: `https://api.zotero.org/${libraryPrefix(libraryID)}/collections`,
        method: "POST",
        headers: {
            "Zotero-API-Key": services.settings.zoteroapikey,
            "Zotero-API-Version": "3",
            "Zotero-Write-Token": writeToken(),
        },
        contentType: "application/json",
        body: JSON.stringify(objects),
        throw: false,
    });
    if (res.status === 412) {
        void startSync(libraryID, true).catch(() => {});
        throw new Error(
            "It was changed elsewhere meanwhile; ZotFlow is syncing, try again in a moment.",
        );
    }
    if (res.status >= 300) throw new Error(`Zotero answered ${res.status}.`);
    interface WriteAnswer {
        successful?: Record<string, WrittenCollection>;
        failed?: Record<string, { code?: number; message?: string }>;
    }
    let json: WriteAnswer | null = null;
    try {
        json = res.json as WriteAnswer;
    } catch {
        json = null;
    }
    const failed = Object.values(json?.failed ?? {});
    if (failed.length) {
        if (failed.some((f) => f.code === 412))
            void startSync(libraryID, true).catch(() => {});
        throw new Error(
            failed[0]?.code === 412
                ? "It was changed elsewhere meanwhile; ZotFlow is syncing, try again in a moment."
                : `Zotero refused it${failed[0]?.message ? ": " + failed[0].message : "."}`,
        );
    }
    const written = objects
        .map((_, i) => json?.successful?.[String(i)])
        .filter((w): w is WrittenCollection => !!w?.key);
    if (written.length)
        await workerBridge.evoLibrary.collectionsWritten(
            libraryID,
            written as unknown as Parameters<
                typeof workerBridge.evoLibrary.collectionsWritten
            >[1],
        );
    void startSync(libraryID, true).catch(() => {});
    return written;
}

async function guarded<T>(
    libraryID: number,
    what: string,
    run: () => Promise<T>,
): Promise<T | null> {
    const notify = services.notificationService;
    const refused = refusal(libraryID);
    if (refused) {
        notify.notify("error", `Couldn't ${what}. ${refused}`);
        return null;
    }
    try {
        return await run();
    } catch (e) {
        services.logService.error(`Failed to ${what}`, "EvoLibrary", e);
        notify.notify(
            "error",
            `Couldn't ${what}. ${e instanceof Error ? e.message : ""}`,
        );
        return null;
    }
}

/** A new collection in `parentKey` (null: at the top of the library); its key. */
export function createCollection(
    libraryID: number,
    name: string,
    parentKey: string | null,
): Promise<string | null> {
    return guarded(libraryID, "create the collection", async () => {
        const [made] = await writeCollections(libraryID, [
            { name, parentCollection: parentKey ?? false },
        ]);
        if (!made) throw new Error("Zotero did not say it was created.");
        return made.key;
    });
}

/**
 * Move a collection to the trash, with the collections inside it (as
 * Zotero does). Its items stay in the library and in their other
 * collections; Restore in the trash brings it back.
 */
export async function trashCollection(
    libraryID: number,
    key: string,
): Promise<boolean> {
    const done = await guarded(
        libraryID,
        "move the collection to the trash",
        async () => {
            const family = await workerBridge.evoLibrary.collectionFamily(
                libraryID,
                key,
            );
            if (!family)
                throw new Error("The collection is not here (any more).");
            const targets = [family.self, ...family.descendants].filter(
                (c) => !c.trashed,
            );
            await writeCollections(
                libraryID,
                targets.map((c) => ({
                    key: c.key,
                    version: c.version,
                    deleted: true,
                })),
            );
            return family.self.name;
        },
    );
    if (done !== null)
        services.notificationService.notify(
            "info",
            `Moved “${done}” to the trash (Trash → Restore brings it back).`,
        );
    return done !== null;
}

/** Bring a collection back from the trash, with what is inside it and the collections it is in. */
export async function restoreCollection(
    libraryID: number,
    key: string,
): Promise<boolean> {
    const done = await guarded(
        libraryID,
        "restore the collection",
        async () => {
            const family = await workerBridge.evoLibrary.collectionFamily(
                libraryID,
                key,
            );
            if (!family)
                throw new Error("The collection is not here (any more).");
            const targets = [
                family.self,
                ...family.descendants,
                ...family.ancestors,
            ].filter((c) => c.trashed);
            if (targets.length)
                await writeCollections(
                    libraryID,
                    targets.map((c) => ({
                        key: c.key,
                        version: c.version,
                        deleted: false,
                    })),
                );
            return true;
        },
    );
    return done === true;
}
