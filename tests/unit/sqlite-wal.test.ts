/**
 * ZotFlow Evo: `utils/sqlite-wal.ts` — a database file brought up to date
 * with its write-ahead log. Real WAL files, written by Node's own SQLite
 * while the database stays open (as Zotero keeps it), read back from copies.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyWal } from "utils/sqlite-wal";

interface Statement {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): Record<string, unknown> | undefined;
    all(...args: unknown[]): Record<string, unknown>[];
}
interface DatabaseSync {
    exec(sql: string): void;
    prepare(sql: string): Statement;
    close(): void;
}
type DatabaseCtor = new (
    path: string,
    options?: { readOnly?: boolean },
) => DatabaseSync;

let DatabaseSync: DatabaseCtor | null = null;
try {
    // node:sqlite exists from Node 22.5 (experimental there).
    DatabaseSync = (
        createRequire(import.meta.url)("node:sqlite") as {
            DatabaseSync: DatabaseCtor;
        }
    ).DatabaseSync;
} catch {
    DatabaseSync = null;
}

const suite = DatabaseSync ? describe : describe.skip;

suite("a database and its write-ahead log", () => {
    let dir = "";
    let db: DatabaseSync;
    const file = () => join(dir, "zotero.sqlite");

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "zf-wal-"));
        db = new DatabaseSync!(file());
        db.exec("PRAGMA journal_mode=WAL");
        // Only what the test asks for reaches the file.
        db.exec("PRAGMA wal_autocheckpoint=0");
        db.exec("CREATE TABLE items (itemID INTEGER PRIMARY KEY, key TEXT)");
    });

    afterEach(() => {
        try {
            db.close();
        } catch {
            // Closed by the test.
        }
        rmSync(dir, { recursive: true, force: true });
    });

    const insert = (from: number, to: number) => {
        db.exec("BEGIN");
        const st = db.prepare("INSERT INTO items (itemID, key) VALUES (?, ?)");
        for (let i = from; i < to; i++)
            st.run(i, `K${String(i).padStart(7, "0")}`);
        db.exec("COMMIT");
    };

    /** What a reader of the copies sees: the file with the log written in, opened on its own. */
    const readCopies = (
        transform: (wal: Uint8Array) => Uint8Array | null = (w) => w,
    ) => {
        const database = new Uint8Array(readFileSync(file()));
        let wal: Uint8Array | null = null;
        try {
            wal = new Uint8Array(readFileSync(file() + "-wal"));
        } catch {
            wal = null;
        }
        const result = applyWal(database, wal ? transform(wal) : null);
        const bytes = result.database;
        if (bytes[18] === 2) bytes[18] = 1;
        if (bytes[19] === 2) bytes[19] = 1;
        const out = join(dir, `copy-${Math.random()}.sqlite`);
        writeFileSync(out, bytes);
        const copy = new DatabaseSync!(out, { readOnly: true });
        try {
            const count = Number(
                copy.prepare("SELECT count(*) AS n FROM items").get()?.n,
            );
            const check = String(
                copy.prepare("PRAGMA integrity_check").get()?.integrity_check,
            );
            return { count, check, pages: result.pages };
        } finally {
            copy.close();
        }
    };

    it("the file alone misses what is still in the log; with it, nothing", () => {
        insert(0, 50);
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        insert(50, 2000);
        const fileOnly = readCopies(() => null);
        expect(fileOnly.count).toBe(50);
        const both = readCopies();
        expect(both.count).toBe(2000);
        expect(both.check).toBe("ok");
        expect(both.pages).toBeGreaterThan(0);
    });

    it("a log begun anew after a checkpoint: the frames left from before do not count", () => {
        insert(0, 3000);
        // Copied into the file; the next write starts the log again from
        // its beginning with new salts, over the old frames.
        db.exec("PRAGMA wal_checkpoint(PASSIVE)");
        insert(3000, 3010);
        const both = readCopies();
        expect(both.count).toBe(3010);
        expect(both.check).toBe("ok");
    });

    it("an unfinished last transaction (cut off) is left out, the ones before it kept", () => {
        insert(0, 10);
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        insert(10, 20);
        const sizeAfterFirst = readFileSync(file() + "-wal").byteLength;
        insert(20, 2000);
        const cut = readCopies((wal) => wal.subarray(0, wal.byteLength - 100));
        expect(cut.count).toBe(20);
        expect(cut.check).toBe("ok");
        const firstOnly = readCopies((wal) => wal.subarray(0, sizeAfterFirst));
        expect(firstOnly.count).toBe(20);
    });

    it("a damaged frame ends the log there", () => {
        insert(0, 10);
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        insert(10, 20);
        const good = readFileSync(file() + "-wal").byteLength;
        insert(20, 30);
        const damaged = readCopies((wal) => {
            const copy = wal.slice();
            copy[good + 24 + 100] = (copy[good + 24 + 100] ?? 0) ^ 0xff;
            return copy;
        });
        expect(damaged.count).toBe(20);
    });

    it("an empty or foreign log adds nothing", () => {
        insert(0, 10);
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        expect(readCopies().count).toBe(10);
        const database = new Uint8Array(readFileSync(file()));
        const junk = new Uint8Array(4096).fill(7);
        expect(applyWal(database, junk).pages).toBe(0);
        expect(applyWal(database, null).database).toBe(database);
    });

    it("an FTS5 index in WAL mode: rows indexed since the checkpoint are found", () => {
        db.exec(
            "CREATE VIRTUAL TABLE fulltextContent USING fts5(text, tokenize='unicode61', content='', contentless_delete=1)",
        );
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        const st = db.prepare(
            "INSERT INTO fulltextContent (rowid, text) VALUES (?, ?)",
        );
        st.run(1, "die individuation technischer objekte");
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        st.run(2, "medien und technische objekte");
        const database = new Uint8Array(readFileSync(file()));
        const wal = new Uint8Array(readFileSync(file() + "-wal"));
        const run = (bytes: Uint8Array) => {
            if (bytes[18] === 2) bytes[18] = 1;
            if (bytes[19] === 2) bytes[19] = 1;
            const out = join(dir, `fts-${Math.random()}.sqlite`);
            writeFileSync(out, bytes);
            const copy = new DatabaseSync!(out, { readOnly: true });
            try {
                return copy
                    .prepare(
                        "SELECT rowid FROM fulltextContent WHERE fulltextContent MATCH ? ORDER BY rowid",
                    )
                    .all('"objekte"*')
                    .map((r) => Number(r.rowid));
            } finally {
                copy.close();
            }
        };
        expect(run(database.slice())).toEqual([1]);
        expect(run(applyWal(database.slice(), wal).database)).toEqual([1, 2]);
    });
});
