import type { App } from "obsidian";
import { workerBridge } from "bridge";
import { services } from "services/services";
import type { ZotFlowSettings } from "settings/types";

/**
 * Public API for other plugins, reached as
 * `app.plugins.plugins["zotflow-evo"].api`.
 *
 * Versioned: `version` only goes up, and members are only ever added, so a
 * caller can check `api.version >= n` before using what version n introduced.
 *
 * v1 (used by Typeset Vitro):
 * - `getCslItems(citekeys)` → CSL-JSON for Pandoc citekeys
 *   (`citationKey`, else Zotero item key), `id` set to the citekey
 * - `cslStylesFolder()` → the vault folder ZotFlow scans for .csl styles ("" if none)
 * - `onSyncFinished(cb)` → called after every sync; returns an unsubscribe function
 */
export interface ZotFlowPublicApi {
    readonly version: 1;
    getCslItems(
        citekeys: string[],
    ): Promise<{ items: Record<string, unknown>[]; missing: string[] }>;
    cslStylesFolder(): string;
    onSyncFinished(callback: () => void): () => void;
}

export function createPublicApi(
    _app: App,
    getSettings: () => ZotFlowSettings,
): ZotFlowPublicApi {
    return {
        version: 1,
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
        cslStylesFolder: () => getSettings().cslStylesFolder ?? "",
        onSyncFinished: (callback) =>
            services.eventHub.syncFinished.subscribe(() => callback()),
    };
}
