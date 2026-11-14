/**
 * ZotFlow Evo: a browser connector save shown at once — what Zotero answered
 * to the write, stored as a download stores it (`applyWrittenObjects`), and
 * removals likewise (`applyWrittenDeletions`); the sync after it then finds
 * nothing new and no conflict. The real SyncService on the fake server.
 */
import { afterEach, describe, expect, test } from "vitest";

import { db } from "../fakes/db";
import { API_KEY, createSyncHarness, USER_ID } from "../fakes/sync-harness";

import type { SyncHarness } from "../fakes/sync-harness";
import type { AnyZoteroItem } from "types/zotero";

let h: SyncHarness;
afterEach(() => h?.dispose());

/** A write as the connector sends it (keys made by the client), Zotero's answer. */
async function write(items: Record<string, unknown>[]): Promise<AnyZoteroItem[]> {
    const res = await fetch(`https://api.zotero.org/users/${USER_ID}/items`, {
        method: "POST",
        headers: {
            "Zotero-API-Key": API_KEY,
            "Zotero-API-Version": "3",
            "Content-Type": "application/json",
        },
        body: JSON.stringify(items),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { successful: Record<string, AnyZoteroItem> };
    return Object.values(json.successful);
}

describe("a connector save shown before the sync", () => {
    test("stored at once as synced; the sync then changes nothing", async () => {
        h = await createSyncHarness();
        await h.sync.startSync();
        const objects = await write([
            { key: "CONN2222", version: 0, itemType: "book", title: "Kybernetik", collections: [], tags: [], relations: {} },
            // (The fake server wants a key or version on every write; the real API takes keyless creates.)
            { key: "NOTE2222", version: 0, itemType: "note", parentItem: "CONN2222", note: "<p>abstract</p>", tags: [], relations: {} },
        ]);
        // The note first: the parent is stored first all the same.
        expect(await h.sync.applyWrittenObjects(USER_ID, [...objects].reverse())).toBe(2);
        const row = await db.items.get([USER_ID, "CONN2222"]);
        expect(row).toMatchObject({ title: "Kybernetik", syncStatus: "synced", synced: 1 });
        expect(await db.items.get([USER_ID, "NOTE2222"])).toMatchObject({ parentItem: "CONN2222", syncStatus: "synced" });
        expect(h.host.events.some((e) => e.name === "treeChanged")).toBe(true);

        const before = await db.items.toArray();
        const result = await h.sync.startSync();
        expect(result.failCount).toBe(0);
        expect(await db.syncConflicts.count()).toBe(0);
        const after = await db.items.toArray();
        expect(after.map((r) => [r.key, r.version, r.syncStatus]).sort()).toEqual(
            before.map((r) => [r.key, r.version, r.syncStatus]).sort(),
        );
        // Stored again (the same version) is ignored.
        expect(await h.sync.applyWrittenObjects(USER_ID, objects)).toBe(0);
    });

    test("a newer answer (after a change in the popup) replaces the row", async () => {
        h = await createSyncHarness();
        await h.sync.startSync();
        const [first] = await write([{ key: "CONN3333", version: 0, itemType: "book", title: "A", collections: [], tags: [], relations: {} }]);
        await h.sync.applyWrittenObjects(USER_ID, [first!]);
        const changed = h.server.library(USER_ID).updateItem("CONN3333", { tags: [{ tag: "macy" }] });
        await h.sync.applyWrittenObjects(USER_ID, [changed as unknown as AnyZoteroItem]);
        expect((await db.items.get([USER_ID, "CONN3333"]))!.searchTags).toEqual(["macy"]);
    });

    test("removed (a save moved to another library): gone here, and the sync agrees", async () => {
        h = await createSyncHarness();
        await h.sync.startSync();
        const objects = await write([{ key: "CONN4444", version: 0, itemType: "book", title: "B", collections: [], tags: [], relations: {} }]);
        await h.sync.applyWrittenObjects(USER_ID, objects);
        h.server.library(USER_ID).deleteItem("CONN4444");
        await h.sync.applyWrittenDeletions(USER_ID, ["CONN4444"]);
        expect(await db.items.get([USER_ID, "CONN4444"])).toBeUndefined();
        const result = await h.sync.startSync();
        expect(result.failCount).toBe(0);
        expect(await db.syncConflicts.count()).toBe(0);
        expect(await db.syncDeleteLog.count()).toBe(0);
        expect(await db.items.get([USER_ID, "CONN4444"])).toBeUndefined();
    });

    test("a library ZotFlow does not sync is left alone", async () => {
        h = await createSyncHarness();
        const objects = await write([{ key: "CONN5555", version: 0, itemType: "book", title: "C", collections: [], tags: [], relations: {} }]);
        expect(await h.sync.applyWrittenObjects(999, objects)).toBe(0);
        expect(await db.items.count()).toBe(0);
    });
});
