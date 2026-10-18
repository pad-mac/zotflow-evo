/**
 * ZotFlow Evo (fork): the full-text search on the plugin's side. Starts the
 * search worker (src/fulltext/worker.ts) when the first search view opens
 * and stops it a minute after the last one closed, so nothing of it runs
 * otherwise.
 *
 * Zotero's files are only ever read: their bytes are copied into memory
 * and the worker opens those copies. The copies are taken again when the
 * files have changed (checked before each search). The text of a document
 * comes from the `.zotero-ft-cache` file Zotero writes next to it in its
 * storage folder. Desktop only. See FORK.md, "Full-text search".
 */
import * as Comlink from "comlink";
import { gunzipSync } from "fflate";
import { Platform } from "obsidian";
import fulltextWorkerCode from "virtual:fulltext-worker";

import { services } from "services/services";
import { ftsQuery } from "utils/evo-fulltext";

import type { FulltextWorkerApi } from "fulltext/worker";
import type { FulltextHit, FulltextSpec, Snippet } from "utils/evo-fulltext";

/** How long the worker stays after the last search view closed. */
const STOP_DELAY_MS = 60_000;

type NodeFs = typeof import("fs");
type NodePath = typeof import("path");
type NodeOs = typeof import("os");

function node(): { fs: NodeFs; path: NodePath; os: NodeOs } {
    if (!Platform.isDesktopApp) {
        throw new Error("Full-text search needs the desktop app.");
    }
    // `require`, not `import()`: see readExternalBinaryFile() in
    // bridge/parent-host.ts.
    return {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- Node builtins, desktop only (checked above)
        fs: require("fs") as NodeFs,
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- as above
        path: require("path") as NodePath,
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- as above
        os: require("os") as NodeOs,
    };
}

/** Zotero's data folder: the setting, else ~/Zotero. */
export function zoteroDataDir(): string {
    const { path, os } = node();
    const set = services.settings.evoZoteroDataDir?.trim();
    if (!set) return path.join(os.homedir(), "Zotero");
    return set.startsWith("~") ? path.join(os.homedir(), set.slice(1)) : set;
}

export interface IndexInfo {
    documents: number;
    attachments: number;
    /** When the copies were taken. */
    loadedAt: number;
}

class FulltextEngine {
    private worker: Worker | null = null;
    private api: Comlink.Remote<FulltextWorkerApi> | null = null;
    private users = 0;
    private stopTimer: number | null = null;
    private loaded: { dir: string; stamp: string; info: IndexInfo } | null =
        null;
    private loading: Promise<IndexInfo> | null = null;

    /** A search view opened. */
    acquire(): void {
        this.users++;
        if (this.stopTimer !== null) {
            window.clearTimeout(this.stopTimer);
            this.stopTimer = null;
        }
    }

    /** A search view closed: the worker goes a while after the last one. */
    release(): void {
        this.users = Math.max(0, this.users - 1);
        if (this.users > 0 || this.stopTimer !== null) return;
        this.stopTimer = window.setTimeout(() => {
            this.stopTimer = null;
            if (this.users === 0) this.stop();
        }, STOP_DELAY_MS);
    }

    stop(): void {
        this.api?.[Comlink.releaseProxy]();
        this.worker?.terminate();
        this.api = null;
        this.worker = null;
        this.loaded = null;
        this.loading = null;
    }

    private start(): Comlink.Remote<FulltextWorkerApi> {
        if (this.api) return this.api;
        const code = new TextDecoder().decode(
            gunzipSync(
                Uint8Array.from(atob(fulltextWorkerCode), (c) =>
                    c.charCodeAt(0),
                ),
            ),
        );
        const url = URL.createObjectURL(
            new Blob([code], { type: "text/javascript" }),
        );
        try {
            this.worker = new Worker(url, { name: "zotflow-evo-fulltext" });
        } finally {
            URL.revokeObjectURL(url);
        }
        this.api = Comlink.wrap<FulltextWorkerApi>(this.worker);
        return this.api;
    }

    /** The two files, and a stamp that changes when either does. */
    private async files(dir: string) {
        const { fs, path } = node();
        const fulltext = path.join(dir, "fulltext.sqlite");
        const zotero = path.join(dir, "zotero.sqlite");
        const stamps = await Promise.all(
            [fulltext, zotero, zotero + "-wal"].map(async (file) => {
                try {
                    const s = await fs.promises.stat(file);
                    return `${s.size}:${s.mtimeMs}`;
                } catch {
                    return "-";
                }
            }),
        );
        if (stamps[0] === "-")
            throw new Error(
                `No fulltext.sqlite in ${dir}. Set Zotero's data folder in the ZotFlow Evo settings (Zotero 7.1 or later keeps this index).`,
            );
        if (stamps[1] === "-") throw new Error(`No zotero.sqlite in ${dir}.`);
        return { fulltext, zotero, stamp: stamps.join("|") };
    }

    /** The index, copied anew if Zotero changed it since. */
    async ensureLoaded(): Promise<IndexInfo> {
        const dir = zoteroDataDir();
        const { fulltext, zotero, stamp } = await this.files(dir);
        if (
            this.loaded &&
            this.loaded.dir === dir &&
            this.loaded.stamp === stamp
        )
            return this.loaded.info;
        if (this.loading) return this.loading;
        this.loading = (async () => {
            try {
                const { fs } = node();
                const read = async (file: string) => {
                    const b = await fs.promises.readFile(file);
                    return b.buffer.slice(
                        b.byteOffset,
                        b.byteOffset + b.byteLength,
                    );
                };
                const [ft, z] = await Promise.all([
                    read(fulltext),
                    read(zotero),
                ]);
                const result = await this.start().load(
                    Comlink.transfer(ft, [ft]),
                    Comlink.transfer(z, [z]),
                    personalLibraryID(),
                );
                const info = { ...result, loadedAt: Date.now() };
                this.loaded = { dir, stamp, info };
                return info;
            } finally {
                this.loading = null;
            }
        })();
        return this.loading;
    }

    /** The documents that match, best first. */
    async search(spec: FulltextSpec): Promise<FulltextHit[]> {
        const match = ftsQuery(spec);
        if (!match) return [];
        await this.ensureLoaded();
        return this.start().candidates(match);
    }

    /** The snippets of one document, from the text Zotero extracted. Null: no text here. */
    async snippets(
        attachmentKey: string,
        spec: FulltextSpec,
        max: number,
    ): Promise<{ total: number; snippets: Snippet[] } | null> {
        const { fs, path } = node();
        const file = path.join(
            zoteroDataDir(),
            "storage",
            attachmentKey,
            ".zotero-ft-cache",
        );
        let buffer: ArrayBuffer;
        try {
            const b = await fs.promises.readFile(file);
            buffer = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
        } catch {
            return null;
        }
        return this.start().snippets(
            Comlink.transfer(buffer, [buffer]),
            spec,
            max,
        );
    }
}

/** ZotFlow's id of the personal library (Zotero's local library 1). */
function personalLibraryID(): number {
    return services.libraryCache.personalLibraryID() ?? 0;
}

export const fulltextEngine = new FulltextEngine();
