/**
 * ZotFlow Evo: the browser connector's requests, answered as Zotero's
 * connector server answers them (`/connector/<method>`). Without the HTTP
 * server around it, so it can be tested. See FORK.md, "Browser connector".
 */
import {
    CONNECTOR_SERVER_VERSION,
    buildTargets,
    decodeRfc2047,
    extensionFor,
    pingPrefs,
    refusal,
    selectedCollection,
    type TargetRow,
} from "connector/protocol";
import { ConnectorError, type ConnectorSessions } from "connector/sessions";

export interface ConnectorRequest {
    method: string;
    /** The path without the query: "/connector/ping". */
    path: string;
    query: URLSearchParams;
    /** Lower-case names. */
    headers: Record<string, string | string[] | undefined>;
    body: Uint8Array;
}

export interface ConnectorResponse {
    status: number;
    headers: Record<string, string>;
    body?: string;
}

/** What answers need from ZotFlow besides the sessions. */
export interface ConnectorContext {
    libraries(): Promise<Parameters<typeof buildTargets>[0]>;
    writable(libraryID: number): boolean;
    filesEditable(libraryID: number): boolean;
    pinned(): readonly string[];
    lastTarget(): string | null;
    defaultTarget(): { libraryID: number; collectionKey: string | null } | null;
    /** The targets listed, by id: their names. */
    listed(rows: TargetRow[]): void;
    holdSync(): void;
    /** Zotero's "attach associated files" and "take snapshots" preferences, as ZotFlow's settings have them. */
    prefs(): { files: boolean; snapshots: boolean };
    /** A save failed: tell the person in Obsidian too. */
    failed(message: string): void;
}

/** Larger request bodies are refused (a file of this size is not a paper). */
export const MAX_BODY_BYTES = 512 * 1024 * 1024;

export class ConnectorHandler {
    constructor(
        private readonly sessions: ConnectorSessions,
        private readonly ctx: ConnectorContext,
    ) {}

    async handle(req: ConnectorRequest): Promise<ConnectorResponse> {
        const refused = refusal(req.method, req.headers);
        if (refused) return reply(refused, "text/plain", "Only the Zot Vitro Connector may talk to ZotFlow here.");
        const m = /^\/connector\/([A-Za-z]+)$/.exec(req.path);
        if (!m) return reply(404, "text/plain", "No such endpoint.");
        try {
            return await this.route(m[1]!, req);
        } catch (e) {
            const status = e instanceof ConnectorError ? e.status : 500;
            const message = e instanceof Error ? e.message : String(e);
            if (status >= 500) this.ctx.failed(message);
            return reply(status, "text/plain", message);
        }
    }

    private async route(method: string, req: ConnectorRequest): Promise<ConnectorResponse> {
        const post = req.method === "POST";
        switch (method) {
            case "ping":
                return post
                    ? json(200, { prefs: pingPrefs(this.ctx.prefs()) })
                    : reply(200, "text/html", "<!DOCTYPE html><html><body>ZotFlow is listening for the Zot Vitro Connector.</body></html>");
            case "getSelectedCollection":
                return json(200, await this.selected());
            case "saveItems":
                await this.sessions.saveItems(this.body(req));
                return reply(201);
            case "saveSnapshot":
                await this.sessions.saveSnapshot(this.body(req));
                return json(201, {});
            case "saveAttachment": {
                const meta = this.metadata(req);
                await this.sessions.saveAttachment(
                    req.query.get("sessionID") ?? "",
                    meta,
                    this.file(req, meta),
                );
                return reply(201);
            }
            case "saveStandaloneAttachment": {
                const meta = this.metadata(req);
                await this.sessions.saveStandalone(req.query.get("sessionID"), this.file(req, meta));
                return json(201, { canRecognize: false });
            }
            case "saveSingleFile": {
                const data = this.body(req) as {
                    sessionID?: string;
                    snapshotContent?: unknown;
                    title?: string;
                    url?: string;
                };
                if (typeof data.snapshotContent !== "string")
                    throw new ConnectorError(400, "No snapshot came.");
                await this.sessions.saveSnapshotFile(
                    String(data.sessionID ?? ""),
                    data.snapshotContent,
                    data.title ?? "",
                    data.url ?? "",
                );
                return reply(201);
            }
            case "updateSession":
                await this.sessions.update(this.body(req));
                return json(200, {});
            case "delaySync":
                this.ctx.holdSync();
                return reply(204);
            case "hasAttachmentResolvers": {
                const data = this.body(req);
                return json(200, this.sessions.hasResolvers(text(data.sessionID), data.itemID));
            }
            case "saveAttachmentFromResolver": {
                const data = this.body(req);
                const title = await this.sessions.saveFromResolver(text(data.sessionID), data.itemID);
                return reply(201, "text/plain", title);
            }
            case "getClientHostnames":
            case "proxies":
                return json(200, []);
            case "getRecognizedItem":
                return reply(204);
            default:
                return reply(404, "text/plain", `ZotFlow does not do "${method}".`);
        }
    }

    private async selected(): Promise<Record<string, unknown>> {
        const rows = buildTargets(await this.ctx.libraries(), {
            writable: (id) => this.ctx.writable(id),
            filesEditable: (id) => this.ctx.filesEditable(id),
            pinned: this.ctx.pinned(),
            last: this.ctx.lastTarget(),
        });
        this.ctx.listed(rows);
        const target = this.ctx.defaultTarget();
        const found = target
            ? selectedCollection(rows, target) ??
              selectedCollection(rows, { libraryID: target.libraryID, collectionKey: null })
            : null;
        if (found) return found;
        // Nothing to save to: what Zotero answers for a library that cannot be written.
        const first = rows[0];
        return {
            libraryID: 0,
            libraryName: first?.name ?? "",
            libraryEditable: false,
            filesEditable: false,
            editable: false,
            id: null,
            name: "",
            targets: rows,
            tags: {},
        };
    }

    private body(req: ConnectorRequest): Record<string, unknown> {
        try {
            const value: unknown = JSON.parse(new TextDecoder().decode(req.body) || "{}");
            return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
        } catch {
            throw new ConnectorError(400, "The request is not JSON.");
        }
    }

    private metadata(req: ConnectorRequest): Record<string, unknown> {
        const raw = req.headers["x-metadata"];
        try {
            const value: unknown = JSON.parse(typeof raw === "string" ? raw : "{}");
            return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
        } catch {
            throw new ConnectorError(400, "The file came without its description.");
        }
    }

    private file(req: ConnectorRequest, meta: Record<string, unknown>) {
        const header = req.headers["content-type"];
        const contentType =
            (typeof meta.contentType === "string" && meta.contentType) ||
            (typeof header === "string" ? header.split(";")[0]!.trim() : "") ||
            "application/octet-stream";
        const url = typeof meta.url === "string" ? meta.url : "";
        return {
            bytes: req.body,
            contentType,
            extension: extensionFor(contentType, url),
            title: typeof meta.title === "string" ? decodeRfc2047(meta.title) : "",
            url,
        };
    }
}

function text(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function reply(status: number, contentType?: string, body?: string): ConnectorResponse {
    const headers: Record<string, string> = { "X-Zotero-Version": CONNECTOR_SERVER_VERSION };
    if (contentType) headers["Content-Type"] = `${contentType}; charset=utf-8`;
    return { status, headers, body };
}

function json(status: number, value: unknown): ConnectorResponse {
    return reply(status, "application/json", JSON.stringify(value));
}
