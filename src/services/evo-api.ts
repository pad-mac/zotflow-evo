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
 */
import { services } from "services/services";

import type { Plugin } from "obsidian";
import type { CollectionChange } from "services/event-hub";

export const COLLECTIONS_CHANGED_EVENT = "zotflow-evo:collections-changed";

export interface ZotFlowEvoApi {
    /** Raised when what the API offers changes in a way callers must notice. */
    readonly version: 1;
    onCollectionsChanged(
        callback: (changes: CollectionChange[]) => void,
    ): () => void;
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
