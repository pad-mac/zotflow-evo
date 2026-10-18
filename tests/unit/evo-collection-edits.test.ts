/**
 * ZotFlow Evo: `ui/evo-library/collection-edits.ts` — renaming and moving
 * collections through Zotero's web API (ZotFlow's sync only downloads them).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Call {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
}

const state = vi.hoisted(() => {
    const calls: Call[] = [];
    const written: unknown[][] = [];
    const syncs: number[] = [];
    const many: unknown[][] = [];
    const json: unknown = null;
    return { calls, written, many, syncs, status: 204, canWrite: true, json };
});

vi.mock("obsidian", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    requestUrl: async (req: Call) => {
        state.calls.push(req);
        return {
            status: state.status,
            headers: { "last-modified-version": "77" },
            json: state.json,
        };
    },
}));

vi.mock("bridge", () => ({
    workerBridge: {
        evoLibrary: {
            collectionInfo: async () => ({
                version: 12,
                name: "Old",
                parentCollection: "",
            }),
            collectionWritten: async (...args: unknown[]) => {
                state.written.push(args);
            },
            collectionsWritten: async (...args: unknown[]) => {
                state.many.push(args);
            },
            collectionFamily: async () => ({
                self: { key: "SUB00001", name: "Kittler", version: 4, trashed: false },
                descendants: [
                    { key: "DEEP0001", version: 5, trashed: false },
                    { key: "GONE0001", version: 6, trashed: true },
                ],
                ancestors: [{ key: "TOP00001", version: 3, trashed: true }],
            }),
        },
    },
}));

vi.mock("services/services", () => ({
    services: {
        settings: { zoteroapikey: "KEY" },
        libraryCache: {
            isGroup: (id: number) => id > 100,
            canWrite: () => state.canWrite,
        },
        notificationService: { notify: vi.fn() },
        logService: { error: vi.fn() },
    },
}));

vi.mock("ui/start-sync", () => ({
    startSync: async (id: number) => {
        state.syncs.push(id);
        return "t";
    },
}));

import {
    createCollection,
    moveCollection,
    renameCollection,
    restoreCollection,
    trashCollection,
} from "ui/evo-library/collection-edits";

beforeEach(() => {
    state.calls.length = 0;
    state.written.length = 0;
    state.syncs.length = 0;
    state.status = 204;
    state.canWrite = true;
    state.many.length = 0;
    state.json = null;
});

/** Zotero's answer to a multi-object write that took every object. */
function tookAll(objects: Record<string, unknown>[]) {
    return {
        successful: Object.fromEntries(
            objects.map((o, i) => [
                String(i),
                { key: o.key ?? "NEW00001", version: 80, data: { ...o, key: o.key ?? "NEW00001", version: 80 } },
            ]),
        ),
        failed: {},
    };
}

describe("collections created, trashed, restored", () => {
    it("create: one object without key, in its parent; kept here as answered; its key", async () => {
        state.status = 200;
        state.json = tookAll([{ name: "Fresh", parentCollection: "TOP00001" }]);
        expect(await createCollection(7, "Fresh", "TOP00001")).toBe("NEW00001");
        const [call] = state.calls;
        expect(call).toMatchObject({ url: "https://api.zotero.org/users/7/collections", method: "POST" });
        expect(JSON.parse(call!.body!)).toEqual([{ name: "Fresh", parentCollection: "TOP00001" }]);
        expect(call!.headers?.["Zotero-Write-Token"]).toMatch(/^[0-9a-f]{32}$/);
        expect(state.many).toHaveLength(1);
        expect(state.syncs).toEqual([7]);
    });

    it("trash: the collection and what is inside it (not what is in the trash already)", async () => {
        state.status = 200;
        state.json = tookAll([{ key: "SUB00001" }, { key: "DEEP0001" }]);
        expect(await trashCollection(7, "SUB00001")).toBe(true);
        expect(JSON.parse(state.calls[0]!.body!)).toEqual([
            { key: "SUB00001", version: 4, deleted: true },
            { key: "DEEP0001", version: 5, deleted: true },
        ]);
    });

    it("restore: the trashed ones of the family, the collections it is in too", async () => {
        state.status = 200;
        state.json = tookAll([{ key: "GONE0001" }, { key: "TOP00001" }]);
        expect(await restoreCollection(7, "SUB00001")).toBe(true);
        expect(JSON.parse(state.calls[0]!.body!)).toEqual([
            { key: "GONE0001", version: 6, deleted: false },
            { key: "TOP00001", version: 3, deleted: false },
        ]);
    });

    it("an object refused as changed elsewhere: an error and a sync, nothing kept", async () => {
        state.status = 200;
        state.json = { successful: {}, failed: { "0": { key: "SUB00001", code: 412, message: "changed" } } };
        expect(await trashCollection(7, "SUB00001")).toBe(false);
        expect(state.many).toEqual([]);
        expect(state.syncs).toEqual([7]);
    });
});

describe("collection edits", () => {
    it("rename: PATCH with the collection's version, shown here, then a sync", async () => {
        expect(await renameCollection(7, "COLL0001", "New")).toBe(true);
        const [call] = state.calls;
        expect(call).toMatchObject({
            url: "https://api.zotero.org/users/7/collections/COLL0001",
            method: "PATCH",
            body: JSON.stringify({ name: "New" }),
        });
        expect(call!.headers?.["If-Unmodified-Since-Version"]).toBe("12");
        expect(state.written).toEqual([[7, "COLL0001", { name: "New" }, 77]]);
        expect(state.syncs).toEqual([7]);
    });

    it("move to the top of a group library: parentCollection false", async () => {
        expect(await moveCollection(222, "COLL0001", null)).toBe(true);
        expect(state.calls[0]).toMatchObject({
            url: "https://api.zotero.org/groups/222/collections/COLL0001",
            body: JSON.stringify({ parentCollection: false }),
        });
    });

    it("changed elsewhere (412): nothing shown, a sync instead", async () => {
        state.status = 412;
        expect(await moveCollection(7, "COLL0001", "PARENT01")).toBe(false);
        expect(state.written).toEqual([]);
        expect(state.syncs).toEqual([7]);
    });

    it("a library the key may not write to: no request", async () => {
        state.canWrite = false;
        expect(await renameCollection(7, "COLL0001", "x")).toBe(false);
        expect(state.calls).toEqual([]);
    });
});
