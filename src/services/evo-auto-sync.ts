/**
 * ZotFlow Evo (fork): automatic sync, both ways, through Zotero's web API.
 *
 * - Pull: Zotero's streaming service (the WebSocket Zotero itself listens
 *   on) says which library changed; that library is synced. After every
 *   (re)connect one sync of everything catches up on what was missed.
 * - Push: a few seconds after the last change made here, the library it was
 *   made in is synced; at once when a reader is closed.
 *
 * Automatic syncs are quiet: only a failure is reported. A change Zotero
 * announces that this device already has — its own upload coming back — is
 * recognised by its version and not synced again.
 *
 * `EvoAutoSync` holds the logic and knows nothing of Obsidian; everything it
 * touches comes in through `AutoSyncDeps`, so the tests drive it with fakes.
 * `startEvoAutoSync()` wires it to the plugin. See FORK.md.
 */
import { workerBridge } from "bridge";
import { services } from "services/services";
import { startSync } from "ui/start-sync";
import { fireAndForgetIn } from "utils/fire-and-forget";

import type { Plugin } from "obsidian";
import type { ITaskInfo } from "types/tasks";

const ff = fireAndForgetIn("EvoAutoSync");

/** Zotero's streaming service. */
export const STREAM_URL = "wss://stream.zotero.org/";

/** Pause after the last change made here before it is uploaded. */
export const PUSH_DELAY_MS = 5000;
/** Pause after the last change Zotero announced, to take a burst of them in one sync. */
export const PULL_DELAY_MS = 1500;
/** Pause before the sync that catches up after a (re)connect. */
export const CATCH_UP_DELAY_MS = 1000;

/** Waits between reconnection attempts, in seconds: Zotero's own schedule, capped at an hour. */
const RECONNECT_DELAYS_S = [
    2, 5, 10, 15, 30, 60, 60, 60, 60, 120, 120, 120, 120, 300, 300, 600, 1200,
    1800, 1800, 3600,
];

/** A sync not reported as ended after this long is no longer waited for. */
const STALE_SYNC_MS = 30 * 60 * 1000;

/** Everything or one library. */
type Scope = number | "all";

/** The open connection to the streaming service, as the logic sees it. */
export interface StreamSocket {
    send(data: string): void;
    close(code?: number): void;
}

/** What a connection reports back. */
export interface StreamHandlers {
    message(data: string): void;
    close(code: number): void;
}

/** Everything `EvoAutoSync` needs from the outside. */
export interface AutoSyncDeps {
    settings(): {
        zoteroapikey: string;
        autoSyncPull: boolean;
        autoSyncPush: boolean;
    };
    /** Whether this library is left out of syncing. */
    isIgnored(libraryID: number): boolean;
    /** Whether changes made here are uploaded for this library. */
    isBidirectional(libraryID: number): boolean;
    /** The library version this device has synced up to. */
    libraryVersion(libraryID: number): Promise<number>;
    /** Start a quiet sync of one library, or of all; resolves to the task id. */
    startSync(libraryID: number | undefined): Promise<string>;
    /** Called with every sync task that ends, whoever started it. Returns an unsubscribe. */
    onSyncFinished(listener: (task: ITaskInfo) => void): () => void;
    connect(url: string, handlers: StreamHandlers): StreamSocket;
    isOnline(): boolean;
    now(): number;
    setTimer(run: () => void, ms: number): number;
    clearTimer(id: number): void;
    log(level: "debug" | "info" | "warn", message: string, details?: unknown): void;
}

interface StreamMessage {
    event?: string;
    topic?: string;
    version?: number;
    errors?: unknown[];
}

/** The library a streaming topic names: `/users/123` or `/groups/456`. */
export function topicLibraryID(topic: string | undefined): number | null {
    const match = /^\/(?:users|groups)\/(\d+)$/.exec(topic ?? "");
    return match?.[1] ? Number.parseInt(match[1], 10) : null;
}

export class EvoAutoSync {
    private socket: StreamSocket | null = null;
    /** The API key the open connection subscribed with. */
    private socketKey = "";
    /** A key Zotero turned away; not tried again until the settings change. */
    private refusedKey = "";
    private reconnectAttempt = 0;
    private reconnectTimer: number | null = null;
    /** Highest version Zotero announced per library and this device has not caught up with. */
    private readonly announced = new Map<number, number>();
    /** Libraries with a change made here that is not uploaded yet. */
    private readonly pushWanted = new Set<number>();
    private readonly pullTimers = new Map<Scope, number>();
    private readonly pushTimers = new Map<number, number>();
    /** Syncs this object started (or joined), by task id. */
    private readonly running = new Map<string, { scope: Scope; since: number }>();
    /**
     * Task ids that ended before `startSync` had returned them (a sync that
     * fails at once can report its end first).
     */
    private readonly endedEarly = new Set<string>();
    /** Scopes asked for while a sync covering them ran; looked at again when it ends. */
    private readonly deferred = new Set<Scope>();
    private unsubscribe: (() => void) | null = null;
    private stopped = true;

    constructor(private readonly deps: AutoSyncDeps) {}

    start(): void {
        if (!this.stopped) return;
        this.stopped = false;
        this.unsubscribe = this.deps.onSyncFinished((task) =>
            this.handleSyncFinished(task),
        );
        this.refresh();
    }

    stop(): void {
        this.stopped = true;
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.disconnect();
        for (const id of this.pullTimers.values()) this.deps.clearTimer(id);
        for (const id of this.pushTimers.values()) this.deps.clearTimer(id);
        this.pullTimers.clear();
        this.pushTimers.clear();
        this.announced.clear();
        this.pushWanted.clear();
        this.deferred.clear();
        this.running.clear();
        this.endedEarly.clear();
    }

    /** The settings may have changed: connect, disconnect or reconnect to match. */
    refresh(): void {
        if (this.stopped) return;
        const { zoteroapikey, autoSyncPull } = this.deps.settings();
        if (!autoSyncPull || !zoteroapikey) {
            this.refusedKey = "";
            this.disconnect();
            return;
        }
        if (this.refusedKey === zoteroapikey) return;
        this.refusedKey = "";
        if (this.socket && this.socketKey === zoteroapikey) return;
        if (this.reconnectTimer !== null && this.socketKey === zoteroapikey) {
            return; // already waiting to reconnect with this key
        }
        this.disconnect();
        this.connect();
    }

    /** The network is back: do not wait out the reconnection delay. */
    networkBack(): void {
        if (this.stopped || this.socket) return;
        this.reconnectAttempt = 0;
        if (this.reconnectTimer !== null) {
            this.deps.clearTimer(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.refresh();
    }

    /** Something in this library was changed here. */
    noteLocalEdit(libraryID: number): void {
        if (this.stopped || !this.deps.settings().autoSyncPush) return;
        if (!this.deps.isBidirectional(libraryID)) return;
        this.pushWanted.add(libraryID);
        const pending = this.pushTimers.get(libraryID);
        if (pending !== undefined) this.deps.clearTimer(pending);
        this.pushTimers.set(
            libraryID,
            this.deps.setTimer(() => {
                this.pushTimers.delete(libraryID);
                this.run(libraryID);
            }, PUSH_DELAY_MS),
        );
    }

    /** Upload what waits now (a reader was closed). */
    flushPush(): void {
        for (const [libraryID, timer] of [...this.pushTimers]) {
            this.deps.clearTimer(timer);
            this.pushTimers.delete(libraryID);
            this.run(libraryID);
        }
    }

    /* ---------------------------- stream ---------------------------- */

    private connect(): void {
        const key = this.deps.settings().zoteroapikey;
        this.socketKey = key;
        let socket: StreamSocket | null = null;
        const isCurrent = () => socket !== null && this.socket === socket;
        try {
            socket = this.deps.connect(STREAM_URL, {
                message: (data) => {
                    if (isCurrent()) this.handleMessage(data, key);
                },
                close: (code) => {
                    if (isCurrent()) this.handleClose(code);
                },
            });
            this.socket = socket;
        } catch (e) {
            this.deps.log("warn", "Could not open the Zotero stream", e);
            this.socket = null;
            this.scheduleReconnect();
        }
    }

    private disconnect(): void {
        if (this.reconnectTimer !== null) {
            this.deps.clearTimer(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        const socket = this.socket;
        this.socket = null;
        this.socketKey = "";
        if (socket) {
            try {
                socket.close(1000);
            } catch {
                // Already closed.
            }
        }
    }

    private scheduleReconnect(): void {
        if (this.stopped || this.reconnectTimer !== null) return;
        const seconds =
            RECONNECT_DELAYS_S[
                Math.min(this.reconnectAttempt, RECONNECT_DELAYS_S.length - 1)
            ] ?? 3600;
        this.reconnectAttempt += 1;
        this.reconnectTimer = this.deps.setTimer(() => {
            this.reconnectTimer = null;
            // `refresh()` reconnects unless the settings say otherwise by now.
            this.socketKey = "";
            this.refresh();
        }, seconds * 1000);
    }

    private handleClose(code: number): void {
        this.socket = null;
        if (this.stopped) return;
        // A client error (a rejected key, say) will not get better by retrying;
        // 4429 is "too many connections", which will.
        if (code >= 4400 && code < 4500 && code !== 4429) {
            this.refusedKey = this.socketKey;
            this.deps.log(
                "warn",
                `Zotero closed the stream (code ${code}); automatic sync from Zotero is off until the settings change`,
            );
            return;
        }
        this.deps.log("debug", `Zotero stream closed (code ${code}); reconnecting`);
        this.scheduleReconnect();
    }

    private handleMessage(raw: string, key: string): void {
        let message: StreamMessage;
        try {
            message = JSON.parse(raw) as StreamMessage;
        } catch {
            return;
        }
        switch (message.event) {
            case "connected":
                this.reconnectAttempt = 0;
                // No topics: everything this key can read.
                this.socket?.send(
                    JSON.stringify({
                        action: "createSubscriptions",
                        subscriptions: [{ apiKey: key }],
                    }),
                );
                break;
            case "subscriptionsCreated":
                if (message.errors?.length) {
                    this.deps.log(
                        "warn",
                        "Zotero refused the stream subscription",
                        message.errors,
                    );
                    break;
                }
                this.deps.log("info", "Listening to Zotero for changes");
                // Whatever changed while nobody was listening.
                this.requestPull("all", CATCH_UP_DELAY_MS);
                break;
            case "topicUpdated": {
                const libraryID = topicLibraryID(message.topic);
                if (libraryID === null || this.deps.isIgnored(libraryID)) break;
                // Without a version there is nothing to compare: sync.
                const version = message.version ?? Number.MAX_SAFE_INTEGER;
                this.announced.set(
                    libraryID,
                    Math.max(version, this.announced.get(libraryID) ?? 0),
                );
                this.requestPull(libraryID, PULL_DELAY_MS);
                break;
            }
            case "topicAdded":
            case "topicRemoved":
                this.deps.log(
                    "info",
                    `Zotero reports a library ${message.event === "topicAdded" ? "added" : "removed"} (${message.topic ?? "?"}); verify the API key in the settings to update the list`,
                );
                break;
            default:
                break;
        }
    }

    /* ----------------------------- syncs ----------------------------- */

    private requestPull(scope: Scope, delay: number): void {
        const pending = this.pullTimers.get(scope);
        if (pending !== undefined) this.deps.clearTimer(pending);
        this.pullTimers.set(
            scope,
            this.deps.setTimer(() => {
                this.pullTimers.delete(scope);
                this.run(scope);
            }, delay),
        );
    }

    private covered(scope: Scope): boolean {
        const now = this.deps.now();
        for (const [id, running] of this.running) {
            // A sync whose end was never reported must not hold things up for good.
            if (now - running.since > STALE_SYNC_MS) {
                this.running.delete(id);
                continue;
            }
            if (running.scope === "all" || running.scope === scope) return true;
        }
        return false;
    }

    private run(scope: Scope): void {
        ff(this.runNow(scope), "Automatic sync failed to start");
    }

    private async runNow(scope: Scope): Promise<void> {
        if (this.stopped) return;
        if (!this.deps.isOnline()) {
            // The sync after the reconnect covers it.
            this.deps.log("debug", "Offline; automatic sync skipped");
            return;
        }
        if (this.covered(scope)) {
            this.deferred.add(scope);
            return;
        }

        if (scope !== "all") {
            const push = this.pushWanted.has(scope);
            if (!push) {
                const version = this.announced.get(scope);
                if (version === undefined) return;
                const local = await this.deps.libraryVersion(scope);
                if (this.stopped) return;
                if (version <= local) {
                    // This device's own upload coming back, or already fetched.
                    if (this.announced.get(scope) === version) {
                        this.announced.delete(scope);
                    }
                    return;
                }
                // A sync may have started while the version was read.
                if (this.covered(scope)) {
                    this.deferred.add(scope);
                    return;
                }
            }
            this.pushWanted.delete(scope);
            this.announced.delete(scope);
        } else {
            this.pushWanted.clear();
            this.announced.clear();
        }

        // Held under a placeholder until the task id is known, so a request
        // arriving meanwhile is deferred rather than started a second time.
        const placeholder = `starting:${String(scope)}`;
        this.running.set(placeholder, { scope, since: this.deps.now() });
        let taskID: string | undefined;
        try {
            taskID = await this.deps.startSync(
                scope === "all" ? undefined : scope,
            );
        } finally {
            this.running.delete(placeholder);
        }
        if (this.stopped) return;
        if (this.endedEarly.delete(taskID)) {
            this.runDeferred();
            return;
        }
        this.running.set(taskID, { scope, since: this.deps.now() });
    }

    private handleSyncFinished(task: ITaskInfo): void {
        if (!this.running.delete(task.id)) {
            // Perhaps one whose id `startSync` has yet to hand back.
            if (this.endedEarly.size > 20) this.endedEarly.clear();
            this.endedEarly.add(task.id);
            return;
        }
        this.runDeferred();
    }

    /** Look again at what was asked for while a sync was running. */
    private runDeferred(): void {
        if (!this.deferred.size) return;
        const again = [...this.deferred];
        this.deferred.clear();
        for (const scope of again) this.run(scope);
    }
}

/* ------------------------------------------------------------------ *
 * Wiring to the plugin
 * ------------------------------------------------------------------ */

let instance: EvoAutoSync | null = null;

/** The settings were saved: let automatic sync follow them. */
export function refreshEvoAutoSync(): void {
    instance?.refresh();
}

/** Something in this library was changed here (an annotation, a comment, a note). */
export function noteLocalEdit(libraryID: number): void {
    instance?.noteLocalEdit(libraryID);
}

/**
 * Start automatic sync for the plugin's lifetime. Call once the worker is
 * running and the workspace is laid out.
 */
export function startEvoAutoSync(
    plugin: Plugin,
    readerViewTypes: readonly string[],
): void {
    if (instance) return;
    const auto = new EvoAutoSync({
        settings: () => services.settings,
        isIgnored: (id) => services.libraryCache.isIgnored(id),
        isBidirectional: (id) => services.libraryCache.isBidirectional(id),
        libraryVersion: (id) => workerBridge.key.getLibraryVersion(id),
        startSync: (id) => startSync(id, true),
        onSyncFinished: (listener) =>
            services.eventHub.syncFinished.subscribe(listener),
        connect: (url, handlers) => {
            const socket = new WebSocket(url);
            socket.onmessage = (event: MessageEvent) => {
                if (typeof event.data === "string") handlers.message(event.data);
            };
            socket.onclose = (event: CloseEvent) => handlers.close(event.code);
            return {
                send: (data) => socket.send(data),
                close: (code) => socket.close(code),
            };
        },
        isOnline: () => navigator.onLine,
        now: () => Date.now(),
        setTimer: (run, ms) => window.setTimeout(run, ms),
        clearTimer: (id) => window.clearTimeout(id),
        log: (level, message, details) =>
            services.logService[level](message, "EvoAutoSync", details),
    });
    instance = auto;

    // Changes made outside the reader: a comment edited in a source note, a child note.
    const hub = services.eventHub;
    plugin.register(hub.annotationChanged.subscribe((id) => auto.noteLocalEdit(id)));
    plugin.register(hub.noteChangedByEditor.subscribe((id) => auto.noteLocalEdit(id)));
    plugin.register(hub.noteChangedByNoteView.subscribe((id) => auto.noteLocalEdit(id)));

    // A reader was closed: upload now rather than when the pause is over.
    const countReaders = () =>
        readerViewTypes.reduce(
            (count, type) =>
                count + plugin.app.workspace.getLeavesOfType(type).length,
            0,
        );
    let readers = countReaders();
    plugin.registerEvent(
        plugin.app.workspace.on("layout-change", () => {
            const now = countReaders();
            if (now < readers) auto.flushPush();
            readers = now;
        }),
    );

    plugin.registerDomEvent(window, "online", () => auto.networkBack());
    plugin.register(() => {
        auto.stop();
        if (instance === auto) instance = null;
    });
    auto.start();
}
