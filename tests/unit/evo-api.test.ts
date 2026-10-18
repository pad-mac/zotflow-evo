/**
 * ZotFlow Evo: `services/evo-api.ts` — collection changes passed on to other
 * plugins (kanban-evo), as a workspace event and through `plugin.api`.
 */
import { describe, expect, it, vi } from "vitest";

import { EventHub } from "services/event-hub";

const hub = vi.hoisted((): { current: unknown } => ({ current: null }));

vi.mock("services/services", () => ({
    services: {
        get eventHub() {
            return hub.current;
        },
        logService: { warn: vi.fn() },
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
