/**
 * ZotFlow Evo (fork): the libraries and their collections, nested, in the
 * library browser's left pane. A click shows a collection's items;
 * Ctrl+right-click, a middle click (a three-finger tap) opens it in a tab
 * of its own; a right-click offers the rest (pin to the top among them).
 * Collections are dragged up and down among their siblings to order them;
 * items dropped on a collection are added to it. See FORK.md.
 */
import React, { useEffect, useRef, useState } from "react";

import { draggedItemsLibrary, readDraggedItems } from "ui/evo-library/actions";
import { Icon } from "ui/evo-library/parts";
import {
    PINNED_SIBLINGS,
    collectionId,
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
    onDropItems: (
        items: DraggedItems,
        collection: { libraryID: number; key: string; name: string },
    ) => void;
}

const MIME_COLLECTION = "application/x-zotflow-evo-collection";

/** The collection being dragged in this window (drag data cannot be read before the drop). */
let dragging: { siblings: string; id: string } | null = null;

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
}: CollectionPaneProps) {
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
     * Dragging a collection among its siblings, and dropping items on it.
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
        return {
            draggable: true,
            onDragStart: (e: React.DragEvent) => {
                e.stopPropagation();
                dragging = { siblings, id };
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
                    // Only among its own siblings.
                    if (!dragging || dragging.siblings !== siblings) return;
                    if (dragging.id === id) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    const box = e.currentTarget.getBoundingClientRect();
                    const where =
                        e.clientY > box.top + box.height / 2
                            ? "after"
                            : "before";
                    if (mark?.row !== row || mark.where !== where)
                        setMark({ row, where });
                    return;
                }
                const library = draggedItemsLibrary(e.dataTransfer);
                if (library === null || library !== node.libraryID) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
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
                    const from = dragging;
                    dragging = null;
                    if (!from || from.siblings !== siblings) return;
                    const box = e.currentTarget.getBoundingClientRect();
                    const after = e.clientY > box.top + box.height / 2;
                    const next = moveKey(order, from.id, id, after);
                    if (next.join() !== order.join()) onReorder(siblings, next);
                    return;
                }
                const items = readDraggedItems(e.dataTransfer);
                if (!items || items.libraryID !== node.libraryID) return;
                onDropItems(items, {
                    libraryID: node.libraryID,
                    key: node.key,
                    name: node.name,
                });
            },
        };
    }

    const isCurrent = (libraryID: number, key: string | null) =>
        !!scope && scope.libraryID === libraryID && scope.collectionKey === key;

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
                        { "--zotflow-evo-depth": depth } as React.CSSProperties
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
                            (node.children.length ? "" : " is-empty")
                        }
                        onClick={(e) => {
                            e.stopPropagation();
                            if (node.children.length) toggle(key);
                        }}
                    >
                        {node.children.length > 0 && (
                            <Icon
                                name={
                                    expanded ? "chevron-down" : "chevron-right"
                                }
                            />
                        )}
                    </span>
                    <span className="zotflow-evo-coll-name">{node.name}</span>
                </div>
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
                            top.map((c) =>
                                renderCollection(
                                    c,
                                    1,
                                    topSiblings,
                                    c.key,
                                    topOrder,
                                ),
                            )}
                    </div>
                );
            })}
        </div>
    );
}
