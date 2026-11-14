/**
 * ZotFlow Evo: the browser connector's server — listens on 127.0.0.1 (desktop
 * only) for the Zot Vitro Connector, a fork of the Zotero Connector that
 * saves to ZotFlow instead of the Zotero app. On while the "Browser
 * connector" setting is. See FORK.md, "Browser connector".
 */
import { Platform } from "obsidian";

import { workerBridge } from "bridge";
import { services } from "services/services";
import { CONNECTOR_PORT } from "connector/protocol";
import { ConnectorHandler } from "connector/handler";
import { createConnectorServer } from "connector/http";
import { ConnectorSessions } from "connector/sessions";
import { WebApiConnector } from "connector/web-api";

type Server = ReturnType<typeof createConnectorServer>;

let server: Server | null = null;
let starting = false;

function makeHandler(): ConnectorHandler {
    const api = new WebApiConnector();
    const sessions = new ConnectorSessions(api);
    return new ConnectorHandler(sessions, {
        libraries: () => workerBridge.evoLibrary.getCollectionTree(),
        writable: (id) => api.writable(id),
        filesEditable: (id) => api.filesEditable(id),
        pinned: () => services.settings.evoPinnedCollections ?? [],
        lastTarget: () => services.settings.evoConnectorTarget || null,
        defaultTarget: () => api.defaultTarget(),
        listed: (rows) => {
            api.targetNames = new Map(rows.map((r) => [r.id, r.name]));
        },
        holdSync: () => api.holdSync(),
        failed: (message) =>
            services.notificationService.notify("error", `Browser connector: ${message}`),
    });
}

/** Start listening (if the setting is on and this is the desktop app). */
export function startConnector(): void {
    if (!Platform.isDesktopApp || server || starting) return;
    if (!services.settings.evoConnector) return;
    starting = true;
    // `require`, not `import()`: see readExternalBinaryFile() in bridge/parent-host.ts.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Node builtin, desktop only (checked above)
    const http = require("http") as typeof import("http");
    const s = createConnectorServer(
        http,
        makeHandler(),
        (e) => services.logService.error("Browser connector request failed", "Connector", e),
    );
    s.on("error", (e: NodeJS.ErrnoException) => {
        starting = false;
        server = null;
        services.notificationService.notify(
            "warning",
            e.code === "EADDRINUSE"
                ? `Browser connector: port ${CONNECTOR_PORT} is taken (another Obsidian window with ZotFlow?). It is off here.`
                : `Browser connector: could not listen (${e.message}).`,
        );
    });
    s.listen(CONNECTOR_PORT, "127.0.0.1", () => {
        starting = false;
        server = s;
    });
}

export function stopConnector(): void {
    const s = server;
    server = null;
    if (!s) return;
    s.close();
    // Firefox keeps connections open; they must not keep the port.
    s.closeAllConnections?.();
}

/** The setting changed (or settings were saved): start or stop. */
export function refreshConnector(): void {
    if (services.settings.evoConnector) startConnector();
    else stopConnector();
}

export function connectorListening(): boolean {
    return server !== null;
}
