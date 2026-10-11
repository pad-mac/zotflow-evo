/**
 * ZotFlow Evo: `services/evo-auto-sync.ts` — automatic sync both ways.
 *
 * `EvoAutoSync` is driven here with a fake stream, a fake clock and a fake
 * sync starter. What matters: the right library is synced at the right
 * time, this device's own upload coming back is not synced again, nothing
 * is started twice, and nothing asked for while a sync runs is lost.
 *
 * Not covered: the real connection to stream.zotero.org and the wiring to
 * the plugin (`startEvoAutoSync`), which need the network and Obsidian.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
    CATCH_UP_DELAY_MS,
    EvoAutoSync,
    PULL_DELAY_MS,
    PUSH_DELAY_MS,
    STREAM_URL,
    topicLibraryID,
} from "services/evo-auto-sync";

import type { AutoSyncDeps, StreamHandlers } from "services/evo-auto-sync";
import type { ITaskInfo } from "types/tasks";

vi.mock("bridge", () => ({ workerBridge: {} }));
vi.mock("services/services", () => ({ services: {} }));
vi.mock("ui/start-sync", () => ({ startSync: vi.fn() }));

const USER = 100;
const GROUP = 200;
const READ_ONLY = 300;
const IGNORED = 400;

interface FakeSocket {
    url: string;
    handlers: StreamHandlers;
    sent: unknown[];
    closedWith: number | null;
}

function world() {
    let now = 0;
    let nextTimer = 1;
    const timers = new Map<number, { at: number; run: () => void }>();
    const sockets: FakeSocket[] = [];
    const started: (number | undefined)[] = [];
    /** Task ids count on when a test empties `started`. */
    let taskCount = 0;
    const finishedListeners = new Set<(task: ITaskInfo) => void>();
    const logs: { level: string; message: string }[] = [];
    const state = {
        settings: { zoteroapikey: "KEY", autoSyncPull: true, autoSyncPush: true },
        versions: new Map<number, number>([
            [USER, 10],
            [GROUP, 10],
        ]),
        online: true,
        /** When set, `startSync` waits for it (a slow worker). */
        startGate: null as Promise<void> | null,
        connectThrows: false,
    };

    const deps: AutoSyncDeps = {
        settings: () => state.settings,
        isIgnored: (id) => id === IGNORED,
        isBidirectional: (id) => id === USER || id === GROUP,
        libraryVersion: (id) => Promise.resolve(state.versions.get(id) ?? 0),
        startSync: async (id) => {
            if (state.startGate) await state.startGate;
            started.push(id);
            return `task-${++taskCount}`;
        },
        onSyncFinished: (listener) => {
            finishedListeners.add(listener);
            return () => finishedListeners.delete(listener);
        },
        connect: (url, handlers) => {
            if (state.connectThrows) throw new Error("no socket");
            const socket: FakeSocket = { url, handlers, sent: [], closedWith: null };
            sockets.push(socket);
            return {
                send: (data) => socket.sent.push(JSON.parse(data)),
                close: (code) => {
                    socket.closedWith = code ?? 1005;
                },
            };
        },
        isOnline: () => state.online,
        now: () => now,
        setTimer: (run, ms) => {
            const id = nextTimer++;
            timers.set(id, { at: now + ms, run });
            return id;
        },
        clearTimer: (id) => {
            timers.delete(id);
        },
        log: (level, message) => logs.push({ level, message }),
    };

    const auto = new EvoAutoSync(deps);

    /** Let promise chains settle. */
    const settle = async () => {
        for (let i = 0; i < 10; i++) await Promise.resolve();
    };
    /** Move the clock on, running the timers that come due, in order. */
    const advance = async (ms: number) => {
        const until = now + ms;
        for (;;) {
            const due = [...timers.entries()]
                .filter(([, t]) => t.at <= until)
                .sort((a, b) => a[1].at - b[1].at)[0];
            if (!due) break;
            timers.delete(due[0]);
            now = due[1].at;
            due[1].run();
            await settle();
        }
        now = until;
        await settle();
    };
    const socket = () => sockets[sockets.length - 1]!;
    const receive = (message: Record<string, unknown>) =>
        socket().handlers.message(JSON.stringify(message));
    /** Open the stream and get past the catch-up sync. */
    const listening = async () => {
        auto.start();
        receive({ event: "connected", retry: 10000 });
        receive({ event: "subscriptionsCreated", subscriptions: [], errors: [] });
        await advance(CATCH_UP_DELAY_MS);
        finish("task-1");
        await settle();
        started.length = 0;
    };
    const finish = (id: string, input?: Record<string, number>) => {
        const task = { id, type: "sync", status: "completed", input } as unknown as ITaskInfo;
        for (const listener of [...finishedListeners]) listener(task);
    };

    return { auto, state, sockets, started, timers, logs, settle, advance, socket, receive, listening, finish };
}

let w: ReturnType<typeof world>;
beforeEach(() => {
    w = world();
});

describe("topicLibraryID", () => {
    it("reads user and group libraries and nothing else", () => {
        expect(topicLibraryID("/users/123")).toBe(123);
        expect(topicLibraryID("/groups/456")).toBe(456);
        expect(topicLibraryID("/users/123/publications")).toBeNull();
        expect(topicLibraryID("styles")).toBeNull();
        expect(topicLibraryID(undefined)).toBeNull();
    });
});

describe("connecting", () => {
    it("subscribes with the API key once Zotero says it is connected, then catches up once", async () => {
        w.auto.start();
        expect(w.sockets).toHaveLength(1);
        expect(w.socket().url).toBe(STREAM_URL);
        expect(w.socket().sent).toEqual([]);

        w.receive({ event: "connected", retry: 10000 });
        expect(w.socket().sent).toEqual([
            { action: "createSubscriptions", subscriptions: [{ apiKey: "KEY" }] },
        ]);

        w.receive({ event: "subscriptionsCreated", subscriptions: [], errors: [] });
        expect(w.started).toEqual([]);
        await w.advance(CATCH_UP_DELAY_MS);
        expect(w.started).toEqual([undefined]); // everything, quietly
    });

    it("does not connect without a key or with the switch off", () => {
        w.state.settings.zoteroapikey = "";
        w.auto.start();
        expect(w.sockets).toHaveLength(0);

        w.state.settings.zoteroapikey = "KEY";
        w.state.settings.autoSyncPull = false;
        w.auto.refresh();
        expect(w.sockets).toHaveLength(0);

        w.state.settings.autoSyncPull = true;
        w.auto.refresh();
        expect(w.sockets).toHaveLength(1);
    });

    it("keeps one connection across settings saves and reconnects for a new key", async () => {
        await w.listening();
        w.auto.refresh();
        w.auto.refresh();
        expect(w.sockets).toHaveLength(1);

        w.state.settings.zoteroapikey = "OTHER";
        w.auto.refresh();
        expect(w.sockets).toHaveLength(2);
        expect(w.sockets[0]!.closedWith).toBe(1000);
        w.receive({ event: "connected" });
        expect(w.socket().sent).toEqual([
            { action: "createSubscriptions", subscriptions: [{ apiKey: "OTHER" }] },
        ]);
    });

    it("disconnects when the switch is turned off", async () => {
        await w.listening();
        w.state.settings.autoSyncPull = false;
        w.auto.refresh();
        expect(w.socket().closedWith).toBe(1000);
        // A late message from the closed connection is ignored.
        w.receive({ event: "topicUpdated", topic: `/users/${USER}`, version: 99 });
        await w.advance(60_000);
        expect(w.started).toEqual([]);
    });

    it("reconnects after the connection drops, waiting longer each time, and catches up", async () => {
        await w.listening();
        w.socket().handlers.close(1006);
        await w.advance(1999);
        expect(w.sockets).toHaveLength(1);
        await w.advance(1);
        expect(w.sockets).toHaveLength(2);

        w.socket().handlers.close(1006);
        await w.advance(4999);
        expect(w.sockets).toHaveLength(2);
        await w.advance(1);
        expect(w.sockets).toHaveLength(3);

        w.receive({ event: "connected" });
        w.receive({ event: "subscriptionsCreated", subscriptions: [], errors: [] });
        await w.advance(CATCH_UP_DELAY_MS);
        expect(w.started).toEqual([undefined]);

        // Connected again: the next drop starts from the short wait.
        w.socket().handlers.close(1006);
        await w.advance(2000);
        expect(w.sockets).toHaveLength(4);
    });

    it("reconnects at once when the network is back", async () => {
        await w.listening();
        w.socket().handlers.close(1006);
        w.socket().handlers.close(1006); // a second report changes nothing
        await w.advance(500);
        w.auto.networkBack();
        expect(w.sockets).toHaveLength(2);
        await w.advance(10_000);
        expect(w.sockets).toHaveLength(2); // the old timer is gone
    });

    it("gives up on a key Zotero turns away until the settings change", async () => {
        await w.listening();
        w.socket().handlers.close(4403);
        await w.advance(3_600_000);
        w.auto.refresh();
        w.auto.networkBack();
        expect(w.sockets).toHaveLength(1);
        expect(w.logs.some((l) => l.level === "warn")).toBe(true);

        w.state.settings.zoteroapikey = "FIXED";
        w.auto.refresh();
        expect(w.sockets).toHaveLength(2);
    });

    it("does retry when Zotero says there are too many connections", async () => {
        await w.listening();
        w.socket().handlers.close(4429);
        await w.advance(2000);
        expect(w.sockets).toHaveLength(2);
    });

    it("does not catch up when the subscription is refused", async () => {
        w.auto.start();
        w.receive({ event: "connected" });
        w.receive({ event: "subscriptionsCreated", subscriptions: [], errors: [{ error: "Invalid API key" }] });
        await w.advance(60_000);
        expect(w.started).toEqual([]);
    });

    it("retries when the socket cannot even be opened", async () => {
        w.state.connectThrows = true;
        w.auto.start();
        expect(w.sockets).toHaveLength(0);
        w.state.connectThrows = false;
        await w.advance(2000);
        expect(w.sockets).toHaveLength(1);
    });
});

describe("pulling", () => {
    it("syncs the library Zotero says has changed, after the burst is over", async () => {
        await w.listening();
        w.receive({ event: "topicUpdated", topic: `/users/${USER}`, version: 11 });
        await w.advance(PULL_DELAY_MS - 1);
        w.receive({ event: "topicUpdated", topic: `/users/${USER}`, version: 12 });
        await w.advance(PULL_DELAY_MS - 1);
        expect(w.started).toEqual([]);
        await w.advance(1);
        expect(w.started).toEqual([USER]);
    });

    it("does not sync again for a version this device already has (its own upload coming back)", async () => {
        await w.listening();
        w.receive({ event: "topicUpdated", topic: `/users/${USER}`, version: 10 });
        await w.advance(PULL_DELAY_MS);
        expect(w.started).toEqual([]);

        w.receive({ event: "topicUpdated", topic: `/users/${USER}`, version: 9 });
        await w.advance(PULL_DELAY_MS);
        expect(w.started).toEqual([]);
    });

    it("syncs each changed library on its own, and leaves ignored and unknown topics alone", async () => {
        await w.listening();
        w.receive({ event: "topicUpdated", topic: `/groups/${GROUP}`, version: 11 });
        w.receive({ event: "topicUpdated", topic: `/users/${USER}`, version: 11 });
        w.receive({ event: "topicUpdated", topic: `/groups/${IGNORED}`, version: 5 });
        w.receive({ event: "topicUpdated", topic: "styles" });
        w.socket().handlers.message("not json");
        await w.advance(PULL_DELAY_MS);
        expect(w.started.sort()).toEqual([USER, GROUP]);
    });

    it("syncs when Zotero gives no version to compare", async () => {
        await w.listening();
        w.receive({ event: "topicUpdated", topic: `/users/${USER}` });
        await w.advance(PULL_DELAY_MS);
        expect(w.started).toEqual([USER]);
    });

    it("holds a change announced during a sync until it ends, then checks the version again", async () => {
        await w.listening();
        w.receive({ event: "topicUpdated", topic: `/users/${USER}`, version: 11 });
        await w.advance(PULL_DELAY_MS);
        expect(w.started).toEqual([USER]); // task-2

        // Our own upload announced while the sync still runs…
        w.receive({ event: "topicUpdated", topic: `/users/${USER}`, version: 12 });
        await w.advance(PULL_DELAY_MS);
        expect(w.started).toEqual([USER]);

        // …and the sync ends having reached that version: nothing more to do.
        w.state.versions.set(USER, 12);
        w.finish("task-2");
        await w.settle();
        expect(w.started).toEqual([USER]);
    });

    it("syncs again after a running sync if someone else changed the library meanwhile", async () => {
        await w.listening();
        w.receive({ event: "topicUpdated", topic: `/users/${USER}`, version: 11 });
        await w.advance(PULL_DELAY_MS);
        w.receive({ event: "topicUpdated", topic: `/users/${USER}`, version: 13 });
        await w.advance(PULL_DELAY_MS);
        w.state.versions.set(USER, 11);
        w.finish("task-2");
        await w.settle();
        expect(w.started).toEqual([USER, USER]);
    });

    it("skips while offline", async () => {
        await w.listening();
        w.state.online = false;
        w.receive({ event: "topicUpdated", topic: `/users/${USER}`, version: 11 });
        await w.advance(PULL_DELAY_MS);
        expect(w.started).toEqual([]);
    });
});

describe("pushing", () => {
    it("syncs the library a pause after the last change made here", async () => {
        await w.listening();
        w.auto.noteLocalEdit(USER);
        await w.advance(PUSH_DELAY_MS - 1);
        w.auto.noteLocalEdit(USER);
        await w.advance(PUSH_DELAY_MS - 1);
        expect(w.started).toEqual([]);
        await w.advance(1);
        expect(w.started).toEqual([USER]);
    });

    it("works without the stream: the two switches are independent", async () => {
        w.state.settings.autoSyncPull = false;
        w.auto.start();
        expect(w.sockets).toHaveLength(0);
        w.auto.noteLocalEdit(GROUP);
        await w.advance(PUSH_DELAY_MS);
        expect(w.started).toEqual([GROUP]);
    });

    it("does nothing with the switch off, for a read-only library, or before start", async () => {
        w.auto.noteLocalEdit(USER); // not started
        await w.advance(PUSH_DELAY_MS);
        await w.listening();
        w.auto.noteLocalEdit(READ_ONLY);
        w.state.settings.autoSyncPush = false;
        w.auto.noteLocalEdit(USER);
        await w.advance(PUSH_DELAY_MS);
        expect(w.started).toEqual([]);
    });

    it("uploads at once when a reader is closed", async () => {
        await w.listening();
        w.auto.noteLocalEdit(USER);
        w.auto.noteLocalEdit(GROUP);
        w.auto.flushPush();
        await w.settle();
        expect(w.started.sort()).toEqual([USER, GROUP]);
        await w.advance(PUSH_DELAY_MS);
        expect(w.started).toHaveLength(2); // the timers are gone
    });

    it("uploads a change made during a sync once that sync has ended", async () => {
        await w.listening();
        w.auto.noteLocalEdit(USER);
        await w.advance(PUSH_DELAY_MS);
        expect(w.started).toEqual([USER]); // task-2
        w.auto.noteLocalEdit(USER);
        await w.advance(PUSH_DELAY_MS);
        expect(w.started).toEqual([USER]);
        w.finish("task-2");
        await w.settle();
        expect(w.started).toEqual([USER, USER]);
    });

    it("one sync serves a change made here and one announced by Zotero", async () => {
        await w.listening();
        w.auto.noteLocalEdit(USER);
        w.receive({ event: "topicUpdated", topic: `/users/${USER}`, version: 11 });
        await w.advance(PULL_DELAY_MS);
        expect(w.started).toEqual([USER]);
        // The push timer comes due while that sync runs, and has nothing left to ask for.
        await w.advance(PUSH_DELAY_MS);
        w.state.versions.set(USER, 12);
        w.finish("task-2");
        await w.settle();
        expect(w.started).toEqual([USER]);
    });
});

describe("not starting twice, not getting stuck", () => {
    it("does not start a second sync while the first is still being started", async () => {
        await w.listening();
        let open!: () => void;
        w.state.startGate = new Promise<void>((resolve) => (open = resolve));
        w.auto.noteLocalEdit(USER);
        await w.advance(PUSH_DELAY_MS);
        w.auto.noteLocalEdit(USER);
        await w.advance(PUSH_DELAY_MS);
        expect(w.started).toEqual([]);
        w.state.startGate = null;
        open();
        await w.settle();
        expect(w.started).toEqual([USER]);
        w.finish("task-2");
        await w.settle();
        expect(w.started).toEqual([USER, USER]); // the second change, afterwards
    });

    it("carries on when a sync ends before its id is known", async () => {
        await w.listening();
        let open!: () => void;
        w.state.startGate = new Promise<void>((resolve) => (open = resolve));
        w.auto.noteLocalEdit(USER);
        await w.advance(PUSH_DELAY_MS);
        w.finish("task-2"); // reported first
        w.state.startGate = null;
        open();
        await w.settle();
        expect(w.started).toEqual([USER]);

        w.auto.noteLocalEdit(USER);
        await w.advance(PUSH_DELAY_MS);
        expect(w.started).toEqual([USER, USER]); // not held up by task-2
    });

    it("stops waiting for a sync whose end is never reported", async () => {
        await w.listening();
        w.auto.noteLocalEdit(USER);
        await w.advance(PUSH_DELAY_MS);
        await w.advance(31 * 60 * 1000);
        w.auto.noteLocalEdit(USER);
        await w.advance(PUSH_DELAY_MS);
        expect(w.started).toEqual([USER, USER]);
    });

    it("a sync of everything covers every library; another's sync ending changes nothing", async () => {
        w.auto.start();
        w.receive({ event: "connected" });
        w.receive({ event: "subscriptionsCreated", subscriptions: [], errors: [] });
        await w.advance(CATCH_UP_DELAY_MS);
        expect(w.started).toEqual([undefined]); // task-1, still running
        w.auto.noteLocalEdit(USER);
        await w.advance(PUSH_DELAY_MS);
        w.finish("someone-elses-task");
        await w.settle();
        expect(w.started).toEqual([undefined]);
        w.finish("task-1");
        await w.settle();
        expect(w.started).toEqual([undefined, USER]);
    });

    it("stop() closes the connection and forgets everything pending", async () => {
        await w.listening();
        w.auto.noteLocalEdit(USER);
        w.receive({ event: "topicUpdated", topic: `/groups/${GROUP}`, version: 11 });
        w.auto.stop();
        expect(w.socket().closedWith).toBe(1000);
        expect(w.timers.size).toBe(0);
        await w.advance(60_000);
        expect(w.started).toEqual([]);
        w.auto.start();
        expect(w.sockets).toHaveLength(2);
    });
});
