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
    uploadAttachmentWithKey: () => Promise.resolve({ key: "FILEKEY2", filename: "x.pdf" }),
}));
vi.mock("ui/evo-library/shared-folder", () => ({ sharedFolderOf: () => null }));

import { WebApiConnector } from "connector/web-api";
import { lastScope, publishScope } from "ui/evo-library/selection";

beforeEach(() => {
    state.calls = [];
    state.routes = [];
    state.settings.evoConnectorTarget = "";
    state.writable = new Set([1, 2]);
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
        expect(state.calls.map((c) => [c.method ?? "GET", c.headers?.["If-Unmodified-Since-Version"] ?? null])).toEqual([
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
        expect(state.calls.map((c) => `${c.method ?? "GET"} ${c.headers?.["If-Unmodified-Since-Version"] ?? "-"}`)).toEqual([
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
