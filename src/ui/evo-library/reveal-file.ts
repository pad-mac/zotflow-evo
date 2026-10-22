/**
 * ZotFlow Evo (fork): an item's file shown in the system's file manager
 * (Explorer, Finder) — "Show file in …" in the library's and the item
 * pane's menus. Desktop only. A file is on this computer's disk when it is
 * a linked file, or a stored file Zotero has synced into its storage folder
 * (the "Zotero storage" setting's folder, else `storage` in Zotero's data
 * folder). One only in ZotFlow's cache is not on disk. See FORK.md.
 */
import { Platform } from "obsidian";

import { workerBridge } from "bridge";
import { services } from "services/services";
import {
    attachmentKind,
    choosePrimaryAttachment,
} from "utils/evo-library-model";

import type { AttachmentData } from "types/zotero-item";
import type { IDBZoteroItem } from "types/db-schema";

type Attachment = IDBZoteroItem<AttachmentData>;

/** What of an attachment's data its place on disk depends on. */
export interface FileFacts {
    linkMode?: string;
    path?: string;
    filename?: string;
    contentType?: string;
}

const factsOf = (a: Attachment): FileFacts => a.raw?.data ?? {};

/** What of the settings the paths depend on. */
export interface FilePathSettings {
    linkedAttachmentBaseDir: string;
    zoteroStoragePath: string;
    evoZoteroDataDir: string;
}

/** What of Node's `path` and `os` is used (passed in, for the tests). */
export interface PathTools {
    join(...parts: string[]): string;
    home: string;
}

const LINKED_PREFIX = "attachments:";

/** One segment of a path, refused when it could leave its folder. */
function segment(value: string | undefined): string | null {
    if (!value || value === "." || value === "..") return null;
    if (value.includes("/") || value.includes("\\")) return null;
    return value;
}

function expandHome(dir: string, tools: PathTools): string {
    return dir.startsWith("~") ? tools.join(tools.home, dir.slice(1)) : dir;
}

/**
 * Where an attachment's file may be on disk, most likely first. Empty when
 * it has none (a link, or a stored file without a name).
 */
export function attachmentPathCandidates(
    data: FileFacts,
    key: string,
    settings: FilePathSettings,
    tools: PathTools,
): string[] {
    if (data.linkMode === "linked_file") {
        const raw = data.path ?? "";
        if (!raw) return [];
        if (!raw.startsWith(LINKED_PREFIX)) return [raw];
        const base = settings.linkedAttachmentBaseDir.trim();
        if (!base) return [];
        return [
            tools.join(
                expandHome(base, tools),
                raw.slice(LINKED_PREFIX.length),
            ),
        ];
    }
    if (data.linkMode !== "imported_file" && data.linkMode !== "imported_url")
        return [];
    const name = segment(data.filename);
    const folder = segment(key);
    if (!name || !folder) return [];
    const storages: string[] = [];
    const storage = settings.zoteroStoragePath.trim();
    if (storage) storages.push(expandHome(storage, tools));
    const dataDir = settings.evoZoteroDataDir.trim();
    storages.push(
        tools.join(
            dataDir ? expandHome(dataDir, tools) : tools.join(tools.home, "Zotero"),
            "storage",
        ),
    );
    return [...new Set(storages)].map((dir) => tools.join(dir, folder, name));
}

/** The attachment a row stands for: itself, or the item's file (the one a double click opens, else any with a file). */
async function attachmentOf(
    libraryID: number,
    key: string,
): Promise<Attachment | null> {
    const item = (await workerBridge.dbHelper.getItem(libraryID, key)) as
        | Attachment
        | null
        | undefined;
    if (!item) return null;
    if (item.itemType === "attachment") return item;
    const attachments = (await workerBridge.dbHelper.getAttachments(
        libraryID,
        key,
    )) as Attachment[];
    const kindOf = (a: Attachment) =>
        attachmentKind({
            contentType: factsOf(a).contentType,
            linkMode: factsOf(a).linkMode,
        });
    const { primary, choices } = choosePrimaryAttachment(attachments, kindOf);
    return (
        primary ??
        choices[0] ??
        attachments.find((a) => factsOf(a).linkMode === "linked_file") ??
        attachments.find((a) =>
            ["imported_file", "imported_url"].includes(
                factsOf(a).linkMode ?? "",
            ),
        ) ??
        null
    );
}

/** The menu entry's name on this system. */
export function revealFileTitle(): string {
    if (Platform.isMacOS) return "Show file in Finder";
    if (Platform.isWin) return "Show file in Explorer";
    return "Show file in the file manager";
}

/** Whether the menus offer it here (Node and Electron exist only in the desktop app). */
export function canRevealFiles(): boolean {
    return Platform.isDesktopApp;
}

interface DesktopModules {
    fs: typeof import("fs");
    path: typeof import("path");
    os: typeof import("os");
    shell: { showItemInFolder(fullPath: string): void };
}

/** Node's and Electron's modules (the desktop app only). */
function desktopModules(): DesktopModules {
    if (!Platform.isDesktop) {
        throw new Error("Showing files needs the desktop app.");
    }
    if (!Platform.isDesktopApp) {
        throw new Error("Showing files needs the desktop app.");
    }
    // `require`, not `import()`: see readExternalBinaryFile() in
    // bridge/parent-host.ts.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Node builtins, desktop only (checked above)
    const fs = require("fs") as DesktopModules["fs"];
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- as above
    const path = require("path") as DesktopModules["path"];
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- as above
    const os = require("os") as DesktopModules["os"];
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Electron's shell, desktop only
    const electron = require("electron") as { shell: DesktopModules["shell"] };
    return { fs, path, os, shell: electron.shell };
}

/** Show the file of a row (an item or an attachment) in the system's file manager. */
export async function revealItemFile(
    libraryID: number,
    key: string,
): Promise<void> {
    const say = (text: string, kind: "info" | "warning" = "warning") =>
        services.notificationService.notify(kind, text);
    if (!Platform.isDesktopApp) {
        say("Showing files is available in the desktop app only.");
        return;
    }
    try {
        const attachment = await attachmentOf(libraryID, key);
        if (!attachment) {
            say("This item has no file.", "info");
            return;
        }
        const { fs, path, os, shell } = desktopModules();
        const data = factsOf(attachment);
        const candidates = attachmentPathCandidates(
            data,
            attachment.key,
            services.settings,
            { join: (...p) => path.join(...p), home: os.homedir() },
        );
        const found = candidates.find((p) => {
            try {
                return fs.statSync(p).isFile();
            } catch {
                return false;
            }
        });
        if (found) {
            shell.showItemInFolder(found);
            return;
        }
        if (data.linkMode === "linked_file") {
            say(
                data.path?.startsWith(LINKED_PREFIX) &&
                    !services.settings.linkedAttachmentBaseDir.trim()
                    ? "This linked file's path is relative to Zotero's base folder for linked files; set that folder in ZotFlow's settings."
                    : `The linked file is not on this computer: ${candidates[0] ?? data.path ?? ""}`,
            );
            return;
        }
        if (candidates.length === 0) {
            say("This item's file is not a file on disk (a link).");
            return;
        }
        say(
            "The file is not in Zotero's storage folder on this computer (ZotFlow keeps the files it downloads in its own cache, not as files). Zotero desktop puts it there once it has synced it.",
        );
    } catch (e) {
        services.logService.error(
            "Could not show the file",
            "EvoLibrary",
            e,
        );
        say("Could not show the file.");
    }
}
