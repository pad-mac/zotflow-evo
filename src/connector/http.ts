/**
 * ZotFlow Evo: the browser connector's requests from Node's HTTP server to
 * the handler and back. No Obsidian here (tested with a real server).
 */
import { CONNECTOR_SERVER_VERSION } from "connector/protocol";
import { MAX_BODY_BYTES, type ConnectorHandler } from "connector/handler";

type IncomingMessage = import("http").IncomingMessage;
type ServerResponse = import("http").ServerResponse;
type Server = import("http").Server;

function readBody(req: IncomingMessage): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
        const chunks: Uint8Array[] = [];
        let size = 0;
        req.on("data", (chunk: Uint8Array) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new Error("The request is too large."));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            const out = new Uint8Array(size);
            let at = 0;
            for (const c of chunks) {
                out.set(c, at);
                at += c.length;
            }
            resolve(out);
        });
        req.on("error", reject);
    });
}

async function serve(
    handler: ConnectorHandler,
    req: IncomingMessage,
    res: ServerResponse,
    onError: (e: unknown) => void,
): Promise<void> {
    try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const body = await readBody(req);
        const out = await handler.handle({
            method: req.method ?? "GET",
            path: url.pathname,
            query: url.searchParams,
            headers: req.headers,
            body,
        });
        res.writeHead(out.status, out.headers);
        res.end(out.body ?? "");
    } catch (e) {
        onError(e);
        if (!res.headersSent)
            res.writeHead(500, { "X-Zotero-Version": CONNECTOR_SERVER_VERSION });
        res.end();
    }
}

/** A server answering the Connector with `handler` (not listening yet). */
export function createConnectorServer(
    http: typeof import("http"),
    handler: ConnectorHandler,
    onError: (e: unknown) => void,
): Server {
    return http.createServer((req, res) => void serve(handler, req, res, onError));
}
