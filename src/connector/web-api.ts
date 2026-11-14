/**
 * ZotFlow Evo: what the browser connector's saves are written with — Zotero's
 * web API (as the rest of ZotFlow writes), the file name template and the
 * sync. See FORK.md, "Browser connector".
 */
import { requestUrl } from "obsidian";

import { services } from "services/services";
import { startSync } from "ui/start-sync";
import {
    attachRefusal,
    createAttachmentWithFile,
    uploadAttachmentWithKey,
} from "ui/evo-library/attach-file";
import { sharedFolderOf } from "ui/evo-library/shared-folder";
import { lastScope, publishScope } from "ui/evo-library/selection";
import { parseTargetId, targetId } from "connector/protocol";

import type { RequestUrlResponse } from "obsidian";
import type { ApiItem, ConnectorTarget } from "connector/protocol";
import type { ConnectorApi, ConnectorFile } from "connector/sessions";

/** A save is synced this long after its last change (more files may follow). */
const SYNC_DELAY_MS = 1500;
/** delaySync: the popup is open; hold the sync this long. */
const SYNC_HOLD_MS = 10_000;

function apiBase(libraryID: number): string {
    return services.libraryCache.isGroup(libraryID)
        ? `https://api.zotero.org/groups/${libraryID}`
        : `https://api.zotero.org/users/${libraryID}`;
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
        "Zotero-API-Key": services.settings.zoteroapikey,
        "Zotero-API-Version": "3",
        ...extra,
    };
}

function writeToken(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function jsonOf<T>(res: RequestUrlResponse): T | null {
    try {
        return res.json as T;
    } catch {
        return null;
    }
}

function versionOf(res: RequestUrlResponse): number | undefined {
    const v = Number(res.headers["last-modified-version"] ?? res.headers["Last-Modified-Version"]);
    return Number.isFinite(v) && v > 0 ? v : undefined;
}

/** A file name from a title: what the file system and Zotero take. */
function fileNameOf(title: string, extension: string): string {
    const base = title
        // eslint-disable-next-line no-control-regex -- control characters are what is taken out
        .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120);
    return `${base || "file"}.${extension}`;
}

export class WebApiConnector implements ConnectorApi {
    private readonly syncTimers = new Map<number, number>();
    private holdUntil = 0;
    /** Names of the targets last listed, for the scope a chosen one becomes. */
    targetNames = new Map<string, string>();

    async writeItems(libraryID: number, items: ApiItem[]) {
        const out: { key: string | null; version?: number; message?: string }[] = [];
        for (let at = 0; at < items.length; at += 50) {
            const batch = items.slice(at, at + 50);
            const res = await requestUrl({
                url: `${apiBase(libraryID)}/items`,
                method: "POST",
                headers: headers({ "Zotero-Write-Token": writeToken() }),
                contentType: "application/json",
                body: JSON.stringify(batch),
                throw: false,
            });
            const json = jsonOf<{
                successful?: Record<string, { key?: string; version?: number }>;
                failed?: Record<string, { message?: string }>;
            }>(res);
            if (res.status >= 300 || !json)
                throw new Error(`Zotero refused the new items (${res.status}).`);
            batch.forEach((_, i) => {
                const ok = json.successful?.[String(i)];
                out.push(
                    ok?.key
                        ? { key: ok.key, version: ok.version }
                        : { key: null, message: json.failed?.[String(i)]?.message ?? "refused" },
                );
            });
        }
        return out;
    }

    async patchItem(
        libraryID: number,
        key: string,
        patch: Record<string, unknown>,
        version?: number,
    ): Promise<void> {
        let v = version ?? (await this.itemVersion(libraryID, key));
        for (let attempt = 0; attempt < 2; attempt++) {
            const res = await requestUrl({
                url: `${apiBase(libraryID)}/items/${key}`,
                method: "PATCH",
                headers: headers({ "If-Unmodified-Since-Version": String(v) }),
                contentType: "application/json",
                body: JSON.stringify(patch),
                throw: false,
            });
            if (res.status < 300) return;
            // Changed since (a file was added, a sync): once more, with its version now.
            if (res.status === 412 && attempt === 0) {
                v = await this.itemVersion(libraryID, key);
                continue;
            }
            throw new Error(`Zotero refused the change (${res.status}).`);
        }
    }

    async deleteItems(libraryID: number, keys: string[]): Promise<void> {
        for (let at = 0; at < keys.length; at += 50) {
            const batch = keys.slice(at, at + 50);
            for (let attempt = 0; attempt < 2; attempt++) {
                const v = await this.libraryVersion(libraryID);
                const res = await requestUrl({
                    url: `${apiBase(libraryID)}/items?itemKey=${batch.join(",")}`,
                    method: "DELETE",
                    headers: headers({ "If-Unmodified-Since-Version": String(v) }),
                    throw: false,
                });
                if (res.status < 300) break;
                if (res.status === 412 && attempt === 0) continue;
                throw new Error(`Zotero refused to delete (${res.status}).`);
            }
        }
    }

    async attachFile(
        target: { libraryID: number; key: string },
        file: ConnectorFile,
        nameParts: Parameters<ConnectorApi["attachFile"]>[2],
    ): Promise<string> {
        const bytes = file.bytes.slice().buffer;
        const { key } = await uploadAttachmentWithKey(
            target,
            { bytes, contentType: file.contentType, extension: file.extension, route: "browser connector" },
            nameParts,
            { sync: false },
        );
        return key;
    }

    async standaloneFile(target: ConnectorTarget, file: ConnectorFile): Promise<string> {
        if (sharedFolderOf(target.libraryID))
            throw new Error(
                "This group keeps its files in a shared folder; save the file to an item instead.",
            );
        return createAttachmentWithFile(
            target.libraryID,
            {
                collectionKey: target.collectionKey,
                title: file.title || fileNameOf(file.url, file.extension),
                filename: fileNameOf(file.title || "file", file.extension),
                contentType: file.contentType,
            },
            file.bytes,
        );
    }

    filesEditable(libraryID: number): boolean {
        return attachRefusal(libraryID) === null;
    }

    writable(libraryID: number): boolean {
        return !!services.settings.zoteroapikey && services.libraryCache.canWrite(libraryID);
    }

    syncSoon(libraryID: number): void {
        const old = this.syncTimers.get(libraryID);
        if (old !== undefined) window.clearTimeout(old);
        const wait = Math.max(SYNC_DELAY_MS, this.holdUntil - Date.now());
        this.syncTimers.set(
            libraryID,
            window.setTimeout(() => {
                this.syncTimers.delete(libraryID);
                void startSync(libraryID, true).catch(() => {
                    // The next sync brings it.
                });
            }, wait),
        );
    }

    /** delaySync: hold the syncs a little longer (the popup is open). */
    holdSync(): void {
        this.holdUntil = Date.now() + SYNC_HOLD_MS;
        for (const libraryID of [...this.syncTimers.keys()]) this.syncSoon(libraryID);
    }

    /**
     * Where a save goes: the library or collection shown last in a library
     * tab (as Zotero saves to the collection selected in it), else the one
     * chosen last in the Connector, else the personal library.
     */
    defaultTarget(): ConnectorTarget | null {
        const shown = lastScope();
        if (shown && this.writable(shown.libraryID))
            return { libraryID: shown.libraryID, collectionKey: shown.collectionKey };
        const last = parseTargetId(services.settings.evoConnectorTarget);
        if (last && this.writable(last.libraryID)) return last;
        const personal = services.libraryCache.personalLibraryID();
        return personal !== null && this.writable(personal)
            ? { libraryID: personal, collectionKey: null }
            : null;
    }

    /** As Zotero selects the collection saved to: the next save goes there too. */
    rememberTarget(target: ConnectorTarget): void {
        const id = targetId(target);
        publishScope({
            libraryID: target.libraryID,
            collectionKey: target.collectionKey,
            label: this.targetNames.get(id) ?? "",
        });
        if (services.settings.evoConnectorTarget !== id) {
            services.settings.evoConnectorTarget = id;
            void services.saveSettings().catch(() => {
                // Remembered for this session only.
            });
        }
    }

    private async itemVersion(libraryID: number, key: string): Promise<number> {
        const res = await requestUrl({
            url: `${apiBase(libraryID)}/items/${key}`,
            headers: headers(),
            throw: false,
        });
        const v = jsonOf<{ version?: number }>(res)?.version ?? versionOf(res);
        if (res.status >= 300 || v === undefined)
            throw new Error(`Zotero did not give the item's version (${res.status}).`);
        return v;
    }

    private async libraryVersion(libraryID: number): Promise<number> {
        const res = await requestUrl({
            url: `${apiBase(libraryID)}/items/top?limit=1&format=keys`,
            headers: headers(),
            throw: false,
        });
        const v = versionOf(res);
        if (res.status >= 300 || v === undefined)
            throw new Error(`Zotero did not give the library's version (${res.status}).`);
        return v;
    }
}
