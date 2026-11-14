/**
 * ZotFlow Evo: what the browser connector's saves send to Zotero's web API
 * (`connector/web-api.ts`): versions on changes and deletions, a retry when
 * Zotero says the item changed since, where a save goes. Zotero's server is
 * stood in for by a fake `requestUrl`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Call {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
}

const state = vi.hoisted(() => ({
    calls: [] as Call[],
    routes: [] as { match: RegExp; status: number; json?: unknown; headers?: Record<string, string>; once?: boolean }[],
    settings: { zoteroapikey: "k", evoConnectorTarget: "" },
    writable: new Set([1, 2]),
    saved: 0,
    shown: [] as [string, number, unknown][],
}));

vi.mock("obsidian", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    requestUrl: (req: Call) => {
        state.calls.push(req);
        const i = state.routes.findIndex((r) => r.match.test(`${req.method ?? "GET"} ${req.url}`));
        const route = state.routes[i];
        if (route?.once) state.routes.splice(i, 1);
        return Promise.resolve({
            status: route?.status ?? 404,
            headers: route?.headers ?? {},
            get json() {
                if (route?.json === undefined) throw new Error("not JSON");
                return route.json;
            },
        });
    },
}));
vi.mock("services/services", () => ({
    services: {
        get settings() {
            return state.settings;
        },
        libraryCache: {
            isGroup: (id: number) => id === 2,
            canWrite: (id: number) => state.writable.has(id),
            personalLibraryID: () => 1,
        },
        saveSettings: () => {
            state.saved++;
            return Promise.resolve();
        },
    },
}));
vi.mock("ui/start-sync", () => ({ startSync: () => Promise.resolve("") }));
vi.mock("ui/evo-library/attach-file", () => ({
    attachRefusal: () => null,
    createAttachmentWithFile: () => Promise.resolve("NEWKEY22"),
    uploadAttachmentWithKey: (_t: unknown, _f: unknown, _p: unknown, options: unknown) => {
        state.shown.push(["upload", 0, options]);
        return Promise.resolve({ key: "FILEKEY2", filename: "Wiener - 1950 - Kybernetik.pdf", md5: "abc123" });
    },
}));
vi.mock("bridge", () => ({
    workerBridge: {
        sync: {
            applyWrittenObjects: (libraryID: number, objects: unknown[]) => {
                state.shown.push(["objects", libraryID, objects]);
                return Promise.resolve(objects.length);
            },
            applyWrittenDeletions: (libraryID: number, keys: string[]) => {
                state.shown.push(["deleted", libraryID, keys]);
                return Promise.resolve();
            },
        },
        attachment: {
            putEditedFile: (...args: unknown[]) => {
                state.shown.push(["file", args[0] as number, args.slice(1)]);
                return Promise.resolve();
            },
        },
    },
}));
vi.mock("ui/evo-library/shared-folder", () => ({ sharedFolderOf: () => null }));

import { WebApiConnector } from "connector/web-api";

/** The requests but the ones that fetch an item again to show it. */
const writes = () => state.calls.filter((c) => !c.url.includes("include=data,csljson"));
import { lastScope, publishScope } from "ui/evo-library/selection";

beforeEach(() => {
    state.shown = [];
    state.calls = [];
    state.routes = [];
    state.settings.evoConnectorTarget = "";
    state.writable = new Set([1, 2]);
});

describe("shown in ZotFlow at once", () => {
    it("new items: Zotero's answer stored as a sync stores it", async () => {
        const answer = { key: "AAAA2222", version: 12, data: { key: "AAAA2222", version: 12, itemType: "book", title: "K" } };
        state.routes.push({ match: /^POST .*\/items$/, status: 200, json: { successful: { "0": answer } } });
        await new WebApiConnector().writeItems(1, [{ key: "AAAA2222", itemType: "book" }]);
        expect(state.shown).toEqual([["objects", 1, [answer]]]);
    });

    it("a change, a deletion: the item as Zotero has it now (with its CSL-JSON); the deletion here too", async () => {
        const now = [{ key: "AAAA2222", version: 13, data: { key: "AAAA2222" }, csljson: { title: "K" } }];
        state.routes.push(
            { match: /^PATCH /, status: 204 },
            { match: /^GET .*\/users\/1\/items\?itemKey=AAAA2222&include=data,csljson&includeTrashed=1$/, status: 200, json: now },
            { match: /^GET .*\/items\/top/, status: 200, headers: { "last-modified-version": "40" } },
            { match: /^DELETE /, status: 204 },
        );
        const api = new WebApiConnector();
        await api.patchItem(1, "AAAA2222", { tags: [] }, 12);
        expect(state.shown).toEqual([["objects", 1, now]]);
        await api.deleteItems(1, ["AAAA2222"]);
        expect(state.shown.at(-1)).toEqual(["deleted", 1, ["AAAA2222"]]);
    });

    it("a file: made as Zotero makes it (title, address), its bytes kept here under its md5, the attachment shown", async () => {
        state.routes.push({ match: /^GET .*itemKey=FILEKEY2/, status: 200, json: [{ key: "FILEKEY2", version: 3, data: {} }] });
        await new WebApiConnector().attachFile(
            { libraryID: 1, key: "AAAA2222" },
            { bytes: new Uint8Array([37, 80, 68, 70]), contentType: "application/pdf", extension: "pdf", title: "Full Text PDF", url: "https://x/a.pdf" },
            { lastName: "Wiener", year: "1950", shortTitle: "", title: "Kybernetik", itemType: "book" },
            { title: "Full Text PDF", url: "https://x/a.pdf" },
        );
        expect(state.shown[0]).toEqual(["upload", 0, { sync: false, title: "Full Text PDF", url: "https://x/a.pdf", filename: undefined, charset: undefined }]);
        expect(state.shown[1]![0]).toBe("file");
        expect(state.shown[1]![1]).toBe(1);
        expect((state.shown[1]![2] as unknown[]).slice(0, 1)).toEqual(["FILEKEY2"]);
        expect((state.shown[1]![2] as unknown[]).slice(2)).toEqual(["abc123", "Wiener - 1950 - Kybernetik.pdf", "application/pdf"]);
        expect(state.shown[2]).toEqual(["objects", 1, [{ key: "FILEKEY2", version: 3, data: {} }]]);
    });
});

describe("the connector's web API", () => {
    it("new items: each one's key and version, or why Zotero refused it", async () => {
        state.routes.push({
            match: /^POST https:\/\/api\.zotero\.org\/users\/1\/items$/,
            status: 200,
            json: { successful: { "0": { key: "AAAA2222", version: 12 } }, failed: { "1": { message: "Invalid" } } },
        });
        const out = await new WebApiConnector().writeItems(1, [
            { key: "AAAA2222", itemType: "book" },
            { itemType: "note" },
        ]);
        expect(out).toEqual([{ key: "AAAA2222", version: 12 }, { key: null, message: "Invalid" }]);
        expect(state.calls[0]!.headers).toMatchObject({ "Zotero-API-Version": "3", "Zotero-API-Key": "k" });
        expect(state.calls[0]!.headers!["Zotero-Write-Token"]).toMatch(/^[0-9a-f]{32}$/);
    });

    it("a change: with the version known; changed since (412): once more with its version now", async () => {
        state.routes.push(
            { match: /^PATCH .*\/groups\/2\/items\/AAAA2222$/, status: 412, once: true },
            { match: /^GET .*\/groups\/2\/items\/AAAA2222$/, status: 200, json: { version: 15 } },
            { match: /^PATCH .*\/groups\/2\/items\/AAAA2222$/, status: 204 },
        );
        await new WebApiConnector().patchItem(2, "AAAA2222", { collections: ["CCCC3333"] }, 12);
        expect(writes().map((c) => [c.method ?? "GET", c.headers?.["If-Unmodified-Since-Version"] ?? null])).toEqual([
            ["PATCH", "12"],
            ["GET", null],
            ["PATCH", "15"],
        ]);
        expect(JSON.parse(state.calls[2]!.body!)).toEqual({ collections: ["CCCC3333"] });
    });

    it("a change without a version: asked for first; deleting: with the library's version", async () => {
        state.routes.push(
            { match: /^GET .*\/users\/1\/items\/AAAA2222$/, status: 200, json: { version: 3 } },
            { match: /^PATCH /, status: 204 },
            { match: /^GET .*\/users\/1\/items\/top\?limit=1&format=keys$/, status: 200, headers: { "last-modified-version": "40" } },
            { match: /^DELETE .*\/users\/1\/items\?itemKey=AAAA2222,BBBB2222$/, status: 204 },
        );
        const api = new WebApiConnector();
        await api.patchItem(1, "AAAA2222", { note: "x" });
        await api.deleteItems(1, ["AAAA2222", "BBBB2222"]);
        expect(writes().map((c) => `${c.method ?? "GET"} ${c.headers?.["If-Unmodified-Since-Version"] ?? "-"}`)).toEqual([
            "GET -",
            "PATCH 3",
            "GET -",
            "DELETE 40",
        ]);
    });

    it("a refusal is an error", async () => {
        state.routes.push({ match: /^PATCH /, status: 403 });
        await expect(new WebApiConnector().patchItem(1, "AAAA2222", {}, 1)).rejects.toThrow(/403/);
    });

    it("where a save goes: the scope shown, else the one chosen last, else the personal library", () => {
        const api = new WebApiConnector();
        expect(lastScope()).toBeNull();
        expect(api.defaultTarget()).toEqual({ libraryID: 1, collectionKey: null });
        state.settings.evoConnectorTarget = "C2:GGGG2222";
        expect(api.defaultTarget()).toEqual({ libraryID: 2, collectionKey: "GGGG2222" });
        state.writable.delete(2);
        expect(api.defaultTarget()).toEqual({ libraryID: 1, collectionKey: null });
        publishScope({ libraryID: 1, collectionKey: "SHOW2222", label: "Shown" });
        expect(api.defaultTarget()).toEqual({ libraryID: 1, collectionKey: "SHOW2222" });
        // Chosen in the popup: it becomes the scope, and is kept.
        api.targetNames = new Map([["C1:PICK2222", "Picked"]]);
        api.rememberTarget({ libraryID: 1, collectionKey: "PICK2222" });
        expect(lastScope()).toEqual({ libraryID: 1, collectionKey: "PICK2222", label: "Picked" });
        expect(state.settings.evoConnectorTarget).toBe("C1:PICK2222");
        expect(state.saved).toBeGreaterThan(0);
    });
});
