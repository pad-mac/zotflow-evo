/**
 * ZotFlow Evo (fork): notices every change to what a collection holds —
 * from a sync, a local edit, a rename or move — and tells the main thread,
 * which passes it on to other plugins (kanban-evo). See FORK.md, "Hooks for
 * other plugins".
 *
 * It listens to the database itself (Dexie table hooks), so no write path
 * can be missed. Changes are gathered and sent at most every
 * `FLUSH_DELAY_MS`.
 */
import { db } from "db/db";
import { workerClearTimeout, workerSetTimeout } from "worker/timers";

import type { IParentProxy } from "bridge/types";
import type { WorkerTimeout } from "worker/timers";
import type { CollectionChange } from "services/event-hub";

const FLUSH_DELAY_MS = 250;

interface ItemFacts {
    libraryID: number;
    key: string;
    parentItem?: string;
    trashed?: 0 | 1;
    collections?: string[];
}

/** Changes not yet sent, by `${libraryID}:${collectionKey}`. */
const pending = new Map<
    string,
    {
        libraryID: number;
        collectionKey: string;
        added: Set<string>;
        removed: Set<string>;
        collection: boolean;
    }
>();
let host: IParentProxy | undefined;
let timer: WorkerTimeout | undefined;
let installed = false;

function entry(libraryID: number, collectionKey: string) {
    const id = `${libraryID}:${collectionKey}`;
    let e = pending.get(id);
    if (!e) {
        e = {
            libraryID,
            collectionKey,
            added: new Set(),
            removed: new Set(),
            collection: false,
        };
        pending.set(id, e);
    }
    return e;
}

function schedule() {
    if (timer !== undefined) return;
    timer = workerSetTimeout(flush, FLUSH_DELAY_MS);
}

function flush() {
    timer = undefined;
    if (!pending.size) return;
    const changes: CollectionChange[] = [];
    for (const e of pending.values()) {
        // Added then removed again within one flush: nothing happened.
        const added = [...e.added].filter((k) => !e.removed.has(k));
        const removed = [...e.removed].filter((k) => !e.added.has(k));
        if (!added.length && !removed.length && !e.collection) continue;
        changes.push({
            libraryID: e.libraryID,
            collectionKey: e.collectionKey,
            added,
            removed,
            collectionChanged: e.collection,
        });
    }
    pending.clear();
    if (!changes.length || !host) return;
    try {
        host.emit("collectionsChanged", changes);
    } catch {
        // The main thread is gone (plugin unloading): nothing to tell.
    }
}

/** Whether an item counts as being in its collections: top-level, not in the trash. */
function counts(item: ItemFacts): boolean {
    return !item.parentItem && !item.trashed;
}

function itemChanged(
    before: ItemFacts | undefined,
    after: ItemFacts | undefined,
) {
    const was = new Set(
        before && counts(before) ? (before.collections ?? []) : [],
    );
    const now = new Set(
        after && counts(after) ? (after.collections ?? []) : [],
    );
    const item = (after ?? before)!;
    let any = false;
    for (const c of now)
        if (!was.has(c)) {
            entry(item.libraryID, c).added.add(item.key);
            any = true;
        }
    for (const c of was)
        if (!now.has(c)) {
            entry(item.libraryID, c).removed.add(item.key);
            any = true;
        }
    if (any) schedule();
}

function collectionChanged(libraryID: number, key: string) {
    entry(libraryID, key).collection = true;
    schedule();
}

/**
 * Start watching (once per worker); later calls only update where the
 * changes are sent.
 */
export function watchCollections(parentHost: IParentProxy) {
    host = parentHost;
    if (installed) return;
    installed = true;

    // A hook that throws would fail the write itself: these never do.
    const safely =
        <A extends unknown[]>(run: (...args: A) => void) =>
        (...args: A): void => {
            try {
                run(...args);
            } catch {
                // A change missed is only a later refresh for the listener.
            }
        };

    db.items.hook(
        "creating",
        safely((_key, obj: ItemFacts) => itemChanged(undefined, obj)),
    );
    db.items.hook(
        "updating",
        safely((mods: object, _key, obj: ItemFacts) => {
            const m = mods as Partial<ItemFacts>;
            if (
                !("collections" in m) &&
                !("trashed" in m) &&
                !("parentItem" in m)
            )
                return;
            itemChanged(obj, { ...obj, ...m });
        }),
    );
    db.items.hook(
        "deleting",
        safely((_key, obj: ItemFacts | undefined) => {
            if (obj) itemChanged(obj, undefined);
        }),
    );

    db.collections.hook(
        "creating",
        safely((_key, obj: { libraryID: number; key: string }) =>
            collectionChanged(obj.libraryID, obj.key),
        ),
    );
    db.collections.hook(
        "updating",
        safely(
            (mods: object, _key, obj: { libraryID: number; key: string }) => {
                const m = mods as Record<string, unknown>;
                // Name, place and trash; not sync bookkeeping alone.
                if (
                    !("name" in m) &&
                    !("parentCollection" in m) &&
                    !("trashed" in m)
                )
                    return;
                collectionChanged(obj.libraryID, obj.key);
            },
        ),
    );
    db.collections.hook(
        "deleting",
        safely((_key, obj: { libraryID: number; key: string } | undefined) => {
            if (obj) collectionChanged(obj.libraryID, obj.key);
        }),
    );
}

/** Send what is gathered now (tests). */
export function flushCollectionChanges() {
    workerClearTimeout(timer);
    flush();
}
