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
    return { calls, written, syncs, status: 204, canWrite: true };
});

vi.mock("obsidian", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    requestUrl: async (req: Call) => {
        state.calls.push(req);
        return {
            status: state.status,
            headers: { "last-modified-version": "77" },
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
    moveCollection,
    renameCollection,
} from "ui/evo-library/collection-edits";

beforeEach(() => {
    state.calls.length = 0;
    state.written.length = 0;
    state.syncs.length = 0;
    state.status = 204;
    state.canWrite = true;
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
