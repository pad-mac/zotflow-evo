/**
 * ZotFlow Evo (fork): the libraries and their collections, nested, in the
 * library browser's left pane. A click shows a collection's items;
 * Ctrl+right-click, a middle click (a three-finger tap) opens it in a tab
 * of its own; a right-click offers the rest (pin, rename). A collection
 * dragged onto the upper or lower edge of another goes before or after it
 * (ordering siblings, or moving it to that level), onto its middle into it,
 * onto a library to its top level. Items dropped on a collection are added
 * to it (with Shift held, moved there from the collection shown). Under each
 * library its trash: the trashed items, and the trashed collections to
 * restore. See FORK.md.
 */
import React, { useEffect, useRef, useState } from "react";

import { draggedItemsLibrary, readDraggedItems } from "ui/evo-library/actions";
import { Icon } from "ui/evo-library/parts";
import {
    PINNED_SIBLINGS,
    collectionId,
    collectionParents,
    isInside,
    moveKey,
    orderTree,
    siblingsId,
    splitPinned,
} from "utils/evo-library-model";

import type { DraggedItems } from "ui/evo-library/actions";
import type {
    EvoCollectionNode,
    EvoLibraryNode,
    EvoScope,
} from "worker/services/evo-library";

export interface CollectionTarget {
    libraryID: number;
    collectionKey: string | null;
    /** The library's trash (`collectionKey` null). */
    trash?: boolean;
    /** A collection that is in the trash. */
    trashed?: boolean;
}

export interface CollectionPaneProps {
    libraries: EvoLibraryNode[];
    scope: EvoScope | null;
    /** Pinned collections, as `collectionId()`, in their order. */
    pinned: readonly string[];
    /** The order of siblings, by `siblingsId()` (or `PINNED_SIBLINGS`). */
    orders: Readonly<Record<string, string[]>>;
    onSelect: (target: CollectionTarget) => void;
    onOpenTab: (target: CollectionTarget) => void;
    onMenu: (target: CollectionTarget, event: React.MouseEvent) => void;
    /** Siblings in a new order: keys, or for the pinned ones collection ids. */
    onReorder: (siblings: string, order: string[]) => void;
    /** `move`: Shift was held (out of the collection they came from). */
    onDropItems: (
        items: DraggedItems,
        collection: { libraryID: number; key: string; name: string },
        move: boolean,
    ) => void;
    /**
     * A collection dragged elsewhere: into `parentKey` (null: the top of
     * its library), and where it was dropped there (`siblings` and their new
     * order), if it was dropped beside one.
     */
    onMove: (
        collection: { libraryID: number; key: string },
        parentKey: string | null,
        placed: { siblings: string; order: string[] } | null,
    ) => void;
    /** The collection being renamed (`collectionId()`), if one is. */
    renaming: string | null;
    /** The new name, or null when renaming was given up. */
    onRenamed: (
        collection: { libraryID: number; key: string; name: string },
        name: string | null,
    ) => void;
    /** Sub-collections indented under their parents (setting). */
    indent: boolean;
    /** A collection being created: where (its name is typed in its row). */
    creating: { libraryID: number; parentKey: string | null } | null;
    /** The new collection's name, or null when it was given up. */
    onCreated: (name: string | null) => void;
}

const MIME_COLLECTION = "application/x-zotflow-evo-collection";

/** The collection being dragged in this window (drag data cannot be read before the drop). */
let dragging: {
    siblings: string;
    id: string;
    libraryID: number;
    key: string;
} | null = null;

/** Where on a row a collection is dropped: the upper and lower quarter are its edges. */
function zoneOf(event: React.DragEvent): "before" | "after" | "into" {
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const y = event.clientY - box.top;
    if (y < box.height / 4) return "before";
    if (y > (box.height * 3) / 4) return "after";
    return "into";
}

/** `keys` with `key` put before or after `target` (taken out where it was). */
function placeKey(
    keys: readonly string[],
    key: string,
    target: string,
    after: boolean,
): string[] {
    const rest = keys.filter((k) => k !== key);
    const at = rest.indexOf(target);
    if (at < 0) return [...rest, key];
    rest.splice(at + (after ? 1 : 0), 0, key);
    return rest;
}

/** The name field of a collection being renamed. */
function RenameField({
    name,
    placeholder,
    onDone,
}: {
    name: string;
    placeholder?: string;
    onDone: (name: string | null) => void;
}) {
    const ref = useRef<HTMLInputElement>(null);
    const done = useRef(false);
    useEffect(() => {
        ref.current?.focus();
        ref.current?.select();
    }, []);
    const finish = (value: string | null) => {
        if (done.current) return;
        done.current = true;
        onDone(value);
    };
    return (
        <input
            ref={ref}
            className="zotflow-evo-coll-rename"
            defaultValue={name}
            placeholder={placeholder}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") finish(e.currentTarget.value);
                else if (e.key === "Escape") finish(null);
            }}
            onBlur={(e) => finish(e.currentTarget.value)}
        />
    );
}

type DropMark = { row: string; where: "before" | "after" | "into" } | null;

export function CollectionPane({
    libraries,
    scope,
    pinned,
    orders,
    onSelect,
    onOpenTab,
    onMenu,
    onReorder,
    onDropItems,
    onMove,
    renaming,
    onRenamed,
    indent,
    creating,
    onCreated,
}: CollectionPaneProps) {
    const parents = collectionParents(libraries);
    // Expanded collections (collections start closed) and collapsed libraries.
    const [open, setOpen] = useState<Set<string>>(() => new Set());
    const [closedLibraries, setClosedLibraries] = useState<Set<number>>(
        () => new Set(),
    );
    const [mark, setMark] = useState<DropMark>(null);
    const rootRef = useRef<HTMLDivElement>(null);

    // Any drag ending clears the mark (a drag of items ends in the table).
    useEffect(() => {
        const doc = rootRef.current?.ownerDocument;
        if (!doc) return undefined;
        const clear = () => setMark(null);
        doc.addEventListener("dragend", clear, true);
        doc.addEventListener("drop", clear, true);
        return () => {
            doc.removeEventListener("dragend", clear, true);
            doc.removeEventListener("drop", clear, true);
        };
    }, []);

    // A sub-collection being created shows under its parent: open it.
    useEffect(() => {
        if (!creating?.parentKey) return;
        const id = collectionId(creating.libraryID, creating.parentKey);
        setOpen((current) =>
            current.has(id) ? current : new Set(current).add(id),
        );
        setClosedLibraries((current) => {
            if (!current.has(creating.libraryID)) return current;
            const next = new Set(current);
            next.delete(creating.libraryID);
            return next;
        });
    }, [creating]);

    /** The row where a new collection's name is typed. */
    const draftRow = (depth: number) => (
        <div
            key="zotflow-evo-new-collection"
            className="zotflow-evo-coll is-draft"
            style={
                {
                    "--zotflow-evo-depth": indent ? depth : 0,
                } as React.CSSProperties
            }
        >
            <span className="zotflow-evo-coll-toggle is-empty" />
            <RenameField
                name=""
                placeholder="New collection"
                onDone={(name) => onCreated(name?.trim() ? name.trim() : null)}
            />
        </div>
    );

    const toggle = (key: string) =>
        setOpen((current) => {
            const next = new Set(current);
            if (!next.delete(key)) next.add(key);
            return next;
        });

    function handlers(target: CollectionTarget) {
        return {
            onClick: () => onSelect(target),
            onAuxClick: (e: React.MouseEvent) => {
                if (e.button !== 1 || target.collectionKey === null) return;
                e.preventDefault();
                onOpenTab(target);
            },
            onMouseDown: (e: React.MouseEvent) => {
                // No autoscroll on a middle click.
                if (e.button === 1) e.preventDefault();
            },
            onContextMenu: (e: React.MouseEvent) => {
                e.preventDefault();
                if ((e.ctrlKey || e.metaKey) && target.collectionKey !== null)
                    onOpenTab(target);
                else onMenu(target, e);
            },
        };
    }

    /**
     * Dragging a collection, and dropping collections or items on it.
     * `siblings` names the list it is in; `id` is how that list names it;
     * `order` is the list as shown.
     */
    function dragHandlers(
        node: EvoCollectionNode,
        siblings: string,
        id: string,
        order: string[],
    ) {
        const row = collectionId(node.libraryID, node.key);
        const parentOf = (key: string) =>
            parents.get(collectionId(node.libraryID, key)) ?? null;
        /** What a collection dropped here (at `zone`) would do, if anything. */
        const collectionDrop = (
            zone: "before" | "after" | "into",
        ): "reorder" | "into" | "beside" | null => {
            const d = dragging;
            if (!d || d.libraryID !== node.libraryID || d.key === node.key)
                return null;
            if (zone === "into")
                return isInside(parents, node.libraryID, node.key, d.key)
                    ? null
                    : "into";
            if (d.siblings === siblings) return "reorder";
            // Beside one of another level: moved to that level. Not out of
            // or into the pinned ones that way (pin or unpin for that).
            if (siblings === PINNED_SIBLINGS || d.siblings === PINNED_SIBLINGS)
                return null;
            const parent = parentOf(node.key);
            if (parent && isInside(parents, node.libraryID, parent, d.key))
                return null;
            return "beside";
        };
        return {
            draggable: renaming !== row,
            onDragStart: (e: React.DragEvent) => {
                e.stopPropagation();
                dragging = {
                    siblings,
                    id,
                    libraryID: node.libraryID,
                    key: node.key,
                };
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData(MIME_COLLECTION, row);
            },
            onDragEnd: () => {
                dragging = null;
                setMark(null);
            },
            onDragOver: (e: React.DragEvent) => {
                const types = Array.from(e.dataTransfer.types);
                if (types.includes(MIME_COLLECTION)) {
                    const zone = zoneOf(e);
                    if (!collectionDrop(zone)) {
                        if (mark?.row === row) setMark(null);
                        return;
                    }
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (mark?.row !== row || mark.where !== zone)
                        setMark({ row, where: zone });
                    return;
                }
                const library = draggedItemsLibrary(e.dataTransfer);
                if (library === null || library !== node.libraryID) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = e.shiftKey ? "move" : "copy";
                if (mark?.row !== row || mark.where !== "into")
                    setMark({ row, where: "into" });
            },
            onDragLeave: (e: React.DragEvent) => {
                const to = e.relatedTarget as Node | null;
                if (to && e.currentTarget.contains(to)) return;
                setMark((m) => (m?.row === row ? null : m));
            },
            onDrop: (e: React.DragEvent) => {
                e.preventDefault();
                e.stopPropagation();
                setMark(null);
                if (
                    Array.from(e.dataTransfer.types).includes(MIME_COLLECTION)
                ) {
                    const zone = zoneOf(e);
                    const action = collectionDrop(zone);
                    const from = dragging;
                    dragging = null;
                    if (!from || !action) return;
                    if (action === "reorder") {
                        const next = moveKey(
                            order,
                            from.id,
                            id,
                            zone === "after",
                        );
                        if (next.join() !== order.join())
                            onReorder(siblings, next);
                    } else if (action === "into") {
                        setOpen((current) => new Set(current).add(row));
                        onMove(from, node.key, null);
                    } else {
                        onMove(from, parentOf(node.key), {
                            siblings,
                            order: placeKey(
                                order,
                                from.key,
                                node.key,
                                zone === "after",
                            ),
                        });
                    }
                    return;
                }
                const items = readDraggedItems(e.dataTransfer);
                if (!items || items.libraryID !== node.libraryID) return;
                onDropItems(
                    items,
                    {
                        libraryID: node.libraryID,
                        key: node.key,
                        name: node.name,
                    },
                    e.shiftKey,
                );
            },
        };
    }

    /** A library row takes collections to its top level. */
    function libraryDropHandlers(libraryID: number) {
        const row = `${libraryID}:`;
        const accepts = () => {
            const d = dragging;
            return (
                !!d &&
                d.libraryID === libraryID &&
                parents.get(collectionId(libraryID, d.key)) !== null
            );
        };
        return {
            onDragOver: (e: React.DragEvent) => {
                if (
                    !Array.from(e.dataTransfer.types).includes(
                        MIME_COLLECTION,
                    ) ||
                    !accepts()
                )
                    return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (mark?.row !== row) setMark({ row, where: "into" });
            },
            onDragLeave: (e: React.DragEvent) => {
                const to = e.relatedTarget as Node | null;
                if (to && e.currentTarget.contains(to)) return;
                setMark((m) => (m?.row === row ? null : m));
            },
            onDrop: (e: React.DragEvent) => {
                if (!Array.from(e.dataTransfer.types).includes(MIME_COLLECTION))
                    return;
                e.preventDefault();
                setMark(null);
                const ok = accepts();
                const from = dragging;
                dragging = null;
                if (ok && from) onMove(from, null, null);
            },
        };
    }

    const isCurrent = (libraryID: number, key: string | null, trash = false) =>
        !!scope &&
        scope.libraryID === libraryID &&
        scope.collectionKey === key &&
        !!scope.trash === trash;

    function renderCollection(
        node: EvoCollectionNode,
        depth: number,
        siblings: string,
        id: string,
        order: string[],
    ): React.ReactNode {
        const key = collectionId(node.libraryID, node.key);
        const expanded = open.has(key);
        const children = orderTree(
            node.children,
            orders,
            node.libraryID,
            node.key,
        );
        const childOrder = children.map((c) => c.key);
        const childSiblings = siblingsId(node.libraryID, node.key);
        const marked = mark?.row === key ? mark.where : null;
        const draftHere =
            creating?.libraryID === node.libraryID &&
            creating.parentKey === node.key;
        return (
            <React.Fragment key={key}>
                <div
                    className={
                        "zotflow-evo-coll" +
                        (isCurrent(node.libraryID, node.key)
                            ? " is-current"
                            : "") +
                        (marked ? ` is-drop-${marked}` : "")
                    }
                    style={
                        {
                            "--zotflow-evo-depth": indent ? depth : 0,
                        } as React.CSSProperties
                    }
                    title={node.name}
                    {...handlers({
                        libraryID: node.libraryID,
                        collectionKey: node.key,
                    })}
                    {...dragHandlers(node, siblings, id, order)}
                >
                    <span
                        className={
                            "zotflow-evo-coll-toggle" +
                            (node.children.length || draftHere
                                ? ""
                                : " is-empty")
                        }
                        onClick={(e) => {
                            e.stopPropagation();
                            if (node.children.length) toggle(key);
                        }}
                    >
                        {(node.children.length > 0 || draftHere) && (
                            <Icon
                                name={
                                    expanded ? "chevron-down" : "chevron-right"
                                }
                            />
                        )}
                    </span>
                    {renaming === key ? (
                        <RenameField
                            name={node.name}
                            onDone={(name) => onRenamed(node, name)}
                        />
                    ) : (
                        <span className="zotflow-evo-coll-name">
                            {node.name}
                        </span>
                    )}
                </div>
                {expanded &&
                    creating?.libraryID === node.libraryID &&
                    creating.parentKey === node.key &&
                    draftRow(depth + 1)}
                {expanded &&
                    children.map((child) =>
                        renderCollection(
                            child,
                            depth + 1,
                            childSiblings,
                            child.key,
                            childOrder,
                        ),
                    )}
            </React.Fragment>
        );
    }

    /** The library's trash, and the collections in it (to restore). */
    function renderTrash(lib: EvoLibraryNode): React.ReactNode {
        const id = `trash:${lib.libraryID}`;
        const expanded = open.has(id);
        const trashed = lib.trashedCollections ?? [];
        return (
            <React.Fragment key={id}>
                <div
                    className={
                        "zotflow-evo-coll is-trash" +
                        (isCurrent(lib.libraryID, null, true)
                            ? " is-current"
                            : "")
                    }
                    style={{ "--zotflow-evo-depth": 0 } as React.CSSProperties}
                    title="Trash"
                    onClick={() =>
                        onSelect({
                            libraryID: lib.libraryID,
                            collectionKey: null,
                            trash: true,
                        })
                    }
                    onContextMenu={(e) => e.preventDefault()}
                >
                    <span
                        className={
                            "zotflow-evo-coll-toggle" +
                            (trashed.length ? "" : " is-empty")
                        }
                        onClick={(e) => {
                            e.stopPropagation();
                            if (trashed.length) toggle(id);
                        }}
                    >
                        {trashed.length > 0 && (
                            <Icon
                                name={
                                    expanded ? "chevron-down" : "chevron-right"
                                }
                            />
                        )}
                    </span>
                    <span className="zotflow-evo-coll-icon">
                        <Icon name="trash-2" />
                    </span>
                    <span className="zotflow-evo-coll-name">Trash</span>
                </div>
                {expanded &&
                    trashed.map((node) => {
                        const target: CollectionTarget = {
                            libraryID: node.libraryID,
                            collectionKey: node.key,
                            trashed: true,
                        };
                        return (
                            <div
                                key={"trashed:" + node.key}
                                className={
                                    "zotflow-evo-coll is-trashed" +
                                    (isCurrent(node.libraryID, node.key)
                                        ? " is-current"
                                        : "")
                                }
                                style={
                                    {
                                        "--zotflow-evo-depth": 1,
                                    } as React.CSSProperties
                                }
                                title={`${node.name} (in the trash)`}
                                onClick={() => onSelect(target)}
                                onContextMenu={(e) => {
                                    e.preventDefault();
                                    onMenu(target, e);
                                }}
                            >
                                <span className="zotflow-evo-coll-toggle is-empty" />
                                <span className="zotflow-evo-coll-name">
                                    {node.name}
                                </span>
                            </div>
                        );
                    })}
            </React.Fragment>
        );
    }

    const { pinned: pinnedNodes, trees } = splitPinned(libraries, pinned);
    const pinnedOrder = pinnedNodes.map((n) =>
        collectionId(n.libraryID, n.key),
    );

    return (
        <div className="zotflow-evo-colls" role="tree" ref={rootRef}>
            {pinnedNodes.length > 0 && (
                <div className="zotflow-evo-lib is-pinned">
                    {pinnedNodes.map((node, i) =>
                        renderCollection(
                            node,
                            0,
                            PINNED_SIBLINGS,
                            pinnedOrder[i]!,
                            pinnedOrder,
                        ),
                    )}
                </div>
            )}
            {libraries.map((lib, index) => {
                const closed = closedLibraries.has(lib.libraryID);
                const top = orderTree(
                    trees[index] ?? [],
                    orders,
                    lib.libraryID,
                    null,
                );
                const topOrder = top.map((c) => c.key);
                const topSiblings = siblingsId(lib.libraryID, null);
                return (
                    <div key={lib.libraryID} className="zotflow-evo-lib">
                        <div
                            className={
                                "zotflow-evo-coll is-library" +
                                (isCurrent(lib.libraryID, null)
                                    ? " is-current"
                                    : "") +
                                (mark?.row === `${lib.libraryID}:`
                                    ? " is-drop-into"
                                    : "")
                            }
                            style={
                                {
                                    "--zotflow-evo-depth": 0,
                                } as React.CSSProperties
                            }
                            {...handlers({
                                libraryID: lib.libraryID,
                                collectionKey: null,
                            })}
                            {...libraryDropHandlers(lib.libraryID)}
                        >
                            <span
                                className={
                                    "zotflow-evo-coll-toggle" +
                                    (top.length ? "" : " is-empty")
                                }
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setClosedLibraries((current) => {
                                        const next = new Set(current);
                                        if (!next.delete(lib.libraryID))
                                            next.add(lib.libraryID);
                                        return next;
                                    });
                                }}
                            >
                                {top.length > 0 && (
                                    <Icon
                                        name={
                                            closed
                                                ? "chevron-right"
                                                : "chevron-down"
                                        }
                                    />
                                )}
                            </span>
                            <span className="zotflow-evo-coll-name">
                                {lib.name}
                            </span>
                        </div>
                        {!closed &&
                            creating?.libraryID === lib.libraryID &&
                            creating.parentKey === null &&
                            draftRow(0)}
                        {!closed &&
                            top.map((c) =>
                                renderCollection(
                                    c,
                                    0,
                                    topSiblings,
                                    c.key,
                                    topOrder,
                                ),
                            )}
                        {!closed && renderTrash(lib)}
                    </div>
                );
            })}
        </div>
    );
}
