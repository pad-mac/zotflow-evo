/**
 * ZotFlow Evo (fork): the full-text search's own worker. Started only while
 * a search view is open (ui/evo-library/fulltext-engine.ts), so the plugin
 * pays nothing for it otherwise.
 *
 * It holds in-memory copies of Zotero's `fulltext.sqlite` (the FTS5 index)
 * and, while loading, of `zotero.sqlite` (to turn Zotero's local item ids
 * into keys). The files themselves are never opened: the plugin reads their
 * bytes and hands them over. SQLite is the official WebAssembly build, which
 * has FTS5. See FORK.md, "Full-text search".
 */
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import * as Comlink from "comlink";
import wasmBinary from "virtual:sqlite-wasm-binary";

import { findMatches, makeSnippets } from "utils/evo-fulltext";

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

/** An in-memory, read-only database from a file's bytes. */
function openCopy(s: Sqlite3, buffer: ArrayBuffer): Database {
    const bytes = new Uint8Array(buffer);
    // A database in WAL mode (zotero.sqlite) cannot be opened from memory
    // as such: say it is in rollback mode (bytes 18 and 19 of the header).
    // Only this copy is changed. What still waits in the -wal file is not
    // in it.
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

class FulltextWorker {
    private index: Database | null = null;
    private attachments = new Map<number, Attachment>();

    /**
     * Take copies of the two files. `personalLibraryID`: ZotFlow's id of
     * the personal library (Zotero's local library 1); groups are known by
     * their group id in both.
     */
    async load(
        fulltext: ArrayBuffer,
        zotero: ArrayBuffer,
        personalLibraryID: number,
    ): Promise<{ documents: number; attachments: number }> {
        const s = await engine();
        this.close();
        const z = openCopy(s, zotero);
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
        this.index = openCopy(s, fulltext);
        const documents = Number(
            this.index.selectValue("select count(*) from fulltextIndexState") ??
                0,
        );
        return { documents, attachments: this.attachments.size };
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
    }
}

export type FulltextWorkerApi = FulltextWorker;

Comlink.expose(new FulltextWorker());
