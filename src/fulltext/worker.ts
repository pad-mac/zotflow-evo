/**
 * ZotFlow Evo (fork): the full-text search's own worker. Started only while
 * a search view is open (ui/evo-library/fulltext-engine.ts), so the plugin
 * pays nothing for it otherwise.
 *
 * It holds in-memory copies of Zotero's `fulltext.sqlite` (the FTS5 index)
 * and, while loading, of `zotero.sqlite` (to turn Zotero's local item ids
 * into keys), each brought up to date with its write-ahead log (Zotero
 * keeps recent changes there while it runs; utils/sqlite-wal.ts). The
 * files themselves are never opened: the plugin reads their bytes and
 * hands them over. SQLite is the official WebAssembly build, which has
 * FTS5. See FORK.md, "Full-text search".
 */
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import * as Comlink from "comlink";
import wasmBinary from "virtual:sqlite-wasm-binary";

import { findMatches, makeSnippets } from "utils/evo-fulltext";
import { applyWal } from "utils/sqlite-wal";

import type { FulltextHit, FulltextSpec, Snippet } from "utils/evo-fulltext";

type Sqlite3 = Awaited<ReturnType<typeof sqlite3InitModule>>;
type Database = InstanceType<Sqlite3["oo1"]["DB"]>;

interface Attachment {
    libraryID: number;
    key: string;
    parentKey: string | null;
    contentType: string;
}

let sqlite: Sqlite3 | null = null;

async function engine(): Promise<Sqlite3> {
    // The typings declare no options; Emscripten's module options are
    // passed through (the binary is given, so nothing is fetched).
    const init = sqlite3InitModule as unknown as (options: {
        wasmBinary: Uint8Array;
        locateFile: (file: string) => string;
        print: () => void;
        printErr: () => void;
    }) => Promise<Sqlite3>;
    sqlite ??= await init({
        wasmBinary,
        locateFile: (file) => file,
        print: () => {},
        printErr: () => {},
    });
    return sqlite;
}

/**
 * An in-memory, read-only database from a file's bytes and its log's (the
 * `-wal` file; null when there is none).
 */
function openCopy(
    s: Sqlite3,
    buffer: ArrayBuffer,
    wal: ArrayBuffer | null,
): Database {
    const bytes = applyWal(
        new Uint8Array(buffer),
        wal ? new Uint8Array(wal) : null,
    ).database;
    // A database in WAL mode cannot be opened from memory as such: say it
    // is in rollback mode (bytes 18 and 19 of the header). Only this copy
    // is changed; the log is already in it.
    if (bytes[18] === 2) bytes[18] = 1;
    if (bytes[19] === 2) bytes[19] = 1;
    const db = new s.oo1.DB();
    const pointer = s.wasm.allocFromTypedArray(bytes);
    const rc = s.capi.sqlite3_deserialize(
        db.pointer!,
        "main",
        pointer,
        bytes.byteLength,
        bytes.byteLength,
        s.capi.SQLITE_DESERIALIZE_FREEONCLOSE |
            s.capi.SQLITE_DESERIALIZE_READONLY,
    );
    db.checkRc(rc);
    return db;
}

/** Files whose text Zotero indexes (what a document without an entry is counted among). */
const INDEXED_TYPES = new Set([
    "application/pdf",
    "application/epub+zip",
    "text/html",
    "text/plain",
]);

class FulltextWorker {
    private index: Database | null = null;
    private attachments = new Map<number, Attachment>();
    /** Attachments the index has an entry for. */
    private indexed = new Set<number>();

    /**
     * Take copies of the two files. `personalLibraryID`: ZotFlow's id of
     * the personal library (Zotero's local library 1); groups are known by
     * their group id in both.
     */
    async load(
        fulltext: ArrayBuffer,
        zotero: ArrayBuffer,
        personalLibraryID: number,
        logs: { fulltext: ArrayBuffer | null; zotero: ArrayBuffer | null } = {
            fulltext: null,
            zotero: null,
        },
    ): Promise<{ documents: number; attachments: number }> {
        const s = await engine();
        this.close();
        const z = openCopy(s, zotero, logs.zotero);
        try {
            const libraries = new Map<number, number>();
            for (const row of z.selectObjects(
                "select libraryID, type from libraries",
            ) as { libraryID: number; type: string }[]) {
                if (row.type === "user")
                    libraries.set(row.libraryID, personalLibraryID);
            }
            for (const row of z.selectObjects(
                "select libraryID, groupID from groups",
            ) as { libraryID: number; groupID: number }[]) {
                libraries.set(row.libraryID, row.groupID);
            }
            const rows = z.selectObjects(
                `select i.itemID as itemID, i.key as key, i.libraryID as libraryID,
                        p.key as parentKey, ia.contentType as contentType
                 from itemAttachments ia
                 join items i on i.itemID = ia.itemID
                 left join items p on p.itemID = ia.parentItemID`,
            ) as {
                itemID: number;
                key: string;
                libraryID: number;
                parentKey: string | null;
                contentType: string | null;
            }[];
            this.attachments = new Map();
            for (const row of rows) {
                const libraryID = libraries.get(row.libraryID);
                if (libraryID === undefined) continue;
                this.attachments.set(row.itemID, {
                    libraryID,
                    key: row.key,
                    parentKey: row.parentKey,
                    contentType: row.contentType ?? "",
                });
            }
        } finally {
            z.close();
        }
        this.index = openCopy(s, fulltext, logs.fulltext);
        this.indexed = new Set(
            (
                this.index.selectArrays(
                    "select itemID from fulltextIndexState",
                ) as [number][]
            ).map(([id]) => id),
        );
        return {
            documents: this.indexed.size,
            attachments: this.attachments.size,
        };
    }

    /**
     * Of the documents of some items (`libraryID:key`), how many there are
     * and how many the index has no entry for (not indexed yet, no text, or
     * the file is not on that computer).
     */
    coverage(itemIds: string[]): { documents: number; unindexed: number } {
        const wanted = new Set(itemIds);
        let documents = 0;
        let unindexed = 0;
        for (const [itemID, a] of this.attachments) {
            if (!INDEXED_TYPES.has(a.contentType)) continue;
            if (!wanted.has(`${a.libraryID}:${a.parentKey ?? a.key}`)) continue;
            documents++;
            if (!this.indexed.has(itemID)) unindexed++;
        }
        return { documents, unindexed };
    }

    /** The documents that match an FTS5 expression, best first. */
    candidates(match: string, limit = 5000): FulltextHit[] {
        if (!this.index) throw new Error("The index is not loaded");
        const out = new Map<number, FulltextHit>();
        for (const table of ["fulltextContent", "fulltextContentCJK"]) {
            let rows: [number, number][];
            try {
                rows = this.index.selectArrays(
                    `select rowid, rank from ${table} where ${table} match ? order by rank limit ?`,
                    [match, limit],
                ) as [number, number][];
            } catch {
                continue;
            }
            for (const [itemID, rank] of rows) {
                const a = this.attachments.get(itemID);
                if (!a || out.has(itemID)) continue;
                out.set(itemID, {
                    itemID,
                    libraryID: a.libraryID,
                    attachmentKey: a.key,
                    itemKey: a.parentKey ?? a.key,
                    contentType: a.contentType,
                    rank,
                });
            }
        }
        return [...out.values()].sort((a, b) => a.rank - b.rank);
    }

    /** Where the query is in one document's text (UTF-8 bytes), as snippets. */
    snippets(
        text: ArrayBuffer,
        spec: FulltextSpec,
        max: number,
    ): { total: number; snippets: Snippet[] } {
        const decoded = new TextDecoder().decode(text);
        const matches = findMatches(decoded, spec, 2000);
        return {
            total: matches.length,
            snippets: makeSnippets(decoded, matches, { max }),
        };
    }

    close(): void {
        this.index?.close();
        this.index = null;
        this.indexed = new Set();
    }
}

export type FulltextWorkerApi = FulltextWorker;

Comlink.expose(new FulltextWorker());
