/**
 * ZotFlow Evo (fork): what other plugins (kanban-evo) can listen to. See
 * FORK.md, "Hooks for other plugins".
 *
 * Two ways to get the same news, whichever loads first:
 *
 * - the workspace event `zotflow-evo:collections-changed`, with a
 *   `CollectionChange[]`:
 *   `app.workspace.on("zotflow-evo:collections-changed", (changes) => …)`
 * - `app.plugins.plugins["zotflow-evo"].api.onCollectionsChanged(cb)`,
 *   which returns the function that stops it.
 *
 * A change is a hint to read again, not a log: changes made while a
 * listener was not there are not repeated.
 *
 * For Typeset Vitro (citations without a Better BibTeX export):
 *
 * - `api.getCslItems(citekeys)` → CSL-JSON for Pandoc citekeys
 *   (`citationKey`, else the Zotero item key), each `id` set to the citekey
 * - `api.cslStylesFolder()` → vault folder ZotFlow scans for .csl styles
 * - `api.onSyncFinished(cb)` → after every sync; returns the function that stops it
 */
import { services } from "services/services";
import { workerBridge } from "bridge";

import type { Plugin } from "obsidian";
import type { CollectionChange } from "services/event-hub";

export const COLLECTIONS_CHANGED_EVENT = "zotflow-evo:collections-changed";

export interface ZotFlowEvoApi {
    /** Raised when what the API offers changes in a way callers must notice. */
    readonly version: 1;
    onCollectionsChanged(
        callback: (changes: CollectionChange[]) => void,
    ): () => void;
    getCslItems(
        citekeys: string[],
    ): Promise<{ items: Record<string, unknown>[]; missing: string[] }>;
    cslStylesFolder(): string;
    onSyncFinished(callback: () => void): () => void;
}

export function registerEvoApi(plugin: Plugin) {
    const api: ZotFlowEvoApi = {
        version: 1,
        onCollectionsChanged: (callback) =>
            services.eventHub.collectionsChanged.subscribe((changes) => {
                try {
                    callback(changes);
                } catch (e) {
                    services.logService.warn(
                        "A listener for collection changes failed",
                        "EvoApi",
                        e,
                    );
                }
            }),
        getCslItems: async (citekeys) => {
            const result =
                await workerBridge.libraryTemplate.getCslItemsByCitekey(
                    citekeys,
                );
            return {
                items: result.items as unknown as Record<string, unknown>[],
                missing: result.missing,
            };
        },
        cslStylesFolder: () => services.settings.cslStylesFolder ?? "",
        onSyncFinished: (callback) =>
            services.eventHub.syncFinished.subscribe(() => {
                try {
                    callback();
                } catch (e) {
                    services.logService.warn(
                        "A listener for finished syncs failed",
                        "EvoApi",
                        e,
                    );
                }
            }),
    };
    (plugin as Plugin & { api?: ZotFlowEvoApi }).api = api;
    plugin.register(
        services.eventHub.collectionsChanged.subscribe((changes) =>
            plugin.app.workspace.trigger(COLLECTIONS_CHANGED_EVENT, changes),
        ),
    );
    plugin.register(() => {
        delete (plugin as Plugin & { api?: ZotFlowEvoApi }).api;
    });
}
