/**
 * ZotFlow Evo (fork): writing into a group's shared folder (see
 * utils/evo-shared-folder.ts): a file saved to an item of such a group gets
 * the group's file name scheme and goes into the folder — on this computer
 * or on the WebDAV server — instead of Zotero's storage. Never over another
 * file: a name in use (in the folder, or by an attachment of the group) gets
 * the next letter. Main thread.
 */
import { Platform, requestUrl } from "obsidian";

import { workerBridge } from "bridge";
import { services } from "services/services";
import { ITEM_TYPE_CREATORS } from "types/zotero-csl-schema";
import {
    basicAuth,
    formatBaseName,
    matchKey,
    namePartsOf,
    nextFreeName,
    sharedFolderFor,
    webdavFolderURL,
} from "utils/evo-shared-folder";

import type { NameParts, SharedFolderConfig } from "utils/evo-shared-folder";

/** The group's shared folder, if its files are kept in one. */
export function sharedFolderOf(libraryID: number): SharedFolderConfig | null {
    return sharedFolderFor(services.settings.evoGroupFolders, libraryID);
}

/** What a file's name is made of, read from the item. */
export async function namePartsOfItem(
    libraryID: number,
    key: string,
): Promise<NameParts> {
    const item = (await workerBridge.dbHelper.getItem(libraryID, key)) as unknown as {
        itemType?: string;
        raw?: { data?: Record<string, unknown> };
    } | null;
    const data = item?.raw?.data ?? {};
    const itemType = typeof data.itemType === "string" ? data.itemType : (item?.itemType ?? "");
    return namePartsOf(data, ITEM_TYPE_CREATORS[itemType]?.[0] ?? "author");
}

/** The names in the folder now. */
async function folderNames(config: SharedFolderConfig): Promise<string[]> {
    return (await workerBridge.attachment.listSharedFolder(config)).map((e) => e.name);
}

/** A new file in a folder on this computer; false when the name is taken. */
async function writeLocalNew(
    folder: string,
    name: string,
    bytes: Uint8Array,
): Promise<boolean> {
    if (!Platform.isDesktop) {
        throw new Error("This group's folder is on a computer.");
    }
    if (!Platform.isDesktopApp) {
        throw new Error("This group's folder is on a computer.");
    }
    // `require`, not `import()`: see readExternalBinaryFile() in bridge/parent-host.ts.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Node builtins, desktop only (checked above)
    const { promises: fs } = require("fs") as typeof import("fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- as above
    const path = require("path") as typeof import("path");
    try {
        // "wx": never over a file that is there.
        await fs.writeFile(path.join(folder, name), bytes, { flag: "wx" });
        return true;
    } catch (e) {
        if ((e as { code?: string }).code === "EEXIST") return false;
        throw e;
    }
}

/** Write a new file; false when the name was taken meanwhile. */
async function writeNew(
    config: SharedFolderConfig,
    name: string,
    bytes: Uint8Array,
): Promise<boolean> {
    if (config.mode === "folder")
        return writeLocalNew(config.folder.trim(), name, bytes);
    const url = webdavFolderURL(config);
    if (!url) throw new Error("The WebDAV address of this group's folder is not complete.");
    if (!config.webdavUser || !config.password)
        throw new Error("The WebDAV user name or password of this group's folder is not set.");
    const sent = await requestUrl({
        url: url + encodeURIComponent(name),
        method: "PUT",
        headers: {
            Authorization: basicAuth(config.webdavUser, config.password),
            // Never over a file that is there.
            "If-None-Match": "*",
        },
        contentType: "application/octet-stream",
        body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        throw: false,
    });
    if (sent.status === 412) return false;
    if (sent.status === 401 || sent.status === 403)
        throw new Error("The WebDAV server refused the user name or password.");
    if (sent.status >= 300) throw new Error(`The WebDAV server answered ${sent.status}.`);
    return true;
}

/**
 * Put a file into the group's shared folder under the scheme's name for
 * `parts` (the item it belongs to), the first one free. Returns the name.
 */
export async function putSharedFile(
    config: SharedFolderConfig,
    parts: NameParts,
    extension: string,
    bytes: Uint8Array,
): Promise<string> {
    const ext = extension ? (extension.startsWith(".") ? extension : `.${extension}`) : "";
    const taken = new Set<string>();
    for (const name of await folderNames(config)) taken.add(matchKey(name));
    for (const name of await workerBridge.evoLibrary.attachmentFilenames(config.libraryID))
        taken.add(matchKey(name));
    const base = formatBaseName(parts, config.naming);
    for (let tries = 0; tries < 30; tries++) {
        const name = nextFreeName(base, ext, taken);
        if (await writeNew(config, name, bytes)) {
            services.logService.info(`Saved ${name} into the group's shared folder`, "EvoSharedFolder");
            return name;
        }
        taken.add(matchKey(name));
    }
    throw new Error("No free file name in the shared folder.");
}
