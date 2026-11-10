/**
 * ZotFlow Evo: `services/evo-api.ts` — collection changes passed on to other
 * plugins (kanban-evo), as a workspace event and through `plugin.api`.
 */
import { describe, expect, it, vi } from "vitest";

import { EventHub } from "services/event-hub";

const hub = vi.hoisted((): { current: unknown } => ({ current: null }));
const cslCalls = vi.hoisted((): string[][] => []);

vi.mock("services/services", () => ({
    services: {
        get eventHub() {
            return hub.current;
        },
        logService: { warn: vi.fn() },
        settings: { cslStylesFolder: "Styles/CSL" },
    },
}));

vi.mock("bridge", () => ({
    workerBridge: {
        libraryTemplate: {
            getCslItemsByCitekey: async (keys: string[]) => {
                cslCalls.push(keys);
                return { items: [{ id: "doe2020", type: "book" }], missing: ["nope"] };
            },
        },
    },
}));

import { COLLECTIONS_CHANGED_EVENT, registerEvoApi } from "services/evo-api";

import type { Plugin } from "obsidian";
import type { CollectionChange } from "services/event-hub";
import type { ZotFlowEvoApi } from "services/evo-api";

describe("the hook for other plugins", () => {
    it("a change reaches the workspace event and api listeners; unload takes both away", () => {
        const eventHub = new EventHub();
        hub.current = eventHub;
        const triggered: unknown[][] = [];
        const cleanups: (() => void)[] = [];
        const plugin = {
            app: { workspace: { trigger: (...args: unknown[]) => triggered.push(args) } },
            register: (cb: () => void) => cleanups.push(cb),
        } as unknown as Plugin & { api?: ZotFlowEvoApi };
        registerEvoApi(plugin);
        expect(plugin.api?.version).toBe(1);
        const heard: CollectionChange[][] = [];
        const off = plugin.api!.onCollectionsChanged((c) => heard.push(c));
        plugin.api!.onCollectionsChanged(() => {
            throw new Error("a listener that fails does not stop the others");
        });
        const change: CollectionChange = { libraryID: 1, collectionKey: "TOP00001", added: ["BOOK0001"], removed: [], collectionChanged: false };
        eventHub.collectionsChanged.emit([change]);
        expect(triggered).toEqual([[COLLECTIONS_CHANGED_EVENT, [change]]]);
        expect(heard).toEqual([[change]]);
        off();
        eventHub.collectionsChanged.emit([change]);
        expect(heard).toHaveLength(1);
        for (const c of cleanups) c();
        expect(plugin.api).toBeUndefined();
        eventHub.collectionsChanged.emit([change]);
        // The second emit (before unload) went out; the third (after) did not.
        expect(triggered).toHaveLength(2);
    });
});

describe("citation data for Typeset Vitro", () => {
    function setup() {
        const eventHub = new EventHub();
        hub.current = eventHub;
        const plugin = {
            app: { workspace: { trigger: () => {} } },
            register: () => {},
        } as unknown as Plugin & { api?: ZotFlowEvoApi };
        registerEvoApi(plugin);
        return { api: plugin.api!, eventHub };
    }

    it("getCslItems asks the worker for exactly the citekeys given", async () => {
        const { api } = setup();
        const out = await api.getCslItems(["doe2020", "nope"]);
        expect(cslCalls.at(-1)).toEqual(["doe2020", "nope"]);
        expect(out).toEqual({ items: [{ id: "doe2020", type: "book" }], missing: ["nope"] });
    });

    it("cslStylesFolder reports the setting", () => {
        expect(setup().api.cslStylesFolder()).toBe("Styles/CSL");
    });

    it("onSyncFinished fires after a sync until stopped, and a failing listener stops no one", () => {
        const { api, eventHub } = setup();
        let heard = 0;
        const off = api.onSyncFinished(() => heard++);
        api.onSyncFinished(() => {
            throw new Error("fails");
        });
        const task = {} as Parameters<typeof eventHub.syncFinished.emit>[0];
        eventHub.syncFinished.emit(task);
        expect(heard).toBe(1);
        off();
        eventHub.syncFinished.emit(task);
        expect(heard).toBe(1);
    });
});
