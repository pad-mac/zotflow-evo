/**
 * ZotFlow Evo (fork): the libraries and their collections, nested, in the
 * library browser's left pane. A click shows a collection's items;
 * Ctrl+right-click, a middle click (a three-finger tap) opens it in a tab
 * of its own; a right-click offers the rest. See FORK.md.
 */
import React, { useState } from "react";

import { Icon } from "ui/evo-library/parts";

import type {
    EvoCollectionNode,
    EvoLibraryNode,
    EvoScope,
} from "worker/services/evo-library";

export interface CollectionPaneProps {
    libraries: EvoLibraryNode[];
    scope: EvoScope | null;
    onSelect: (scope: {
        libraryID: number;
        collectionKey: string | null;
    }) => void;
    onOpenTab: (scope: {
        libraryID: number;
        collectionKey: string | null;
    }) => void;
    onMenu: (
        scope: { libraryID: number; collectionKey: string | null },
        event: React.MouseEvent,
    ) => void;
}

const id = (libraryID: number, key: string | null) =>
    `${libraryID}:${key ?? ""}`;

export function CollectionPane({
    libraries,
    scope,
    onSelect,
    onOpenTab,
    onMenu,
}: CollectionPaneProps) {
    // Collapsed libraries and expanded collections (collections start closed).
    const [open, setOpen] = useState<Set<string>>(() => new Set());
    const [closedLibraries, setClosedLibraries] = useState<Set<number>>(
        () => new Set(),
    );

    const toggle = (key: string) =>
        setOpen((current) => {
            const next = new Set(current);
            if (!next.delete(key)) next.add(key);
            return next;
        });

    function handlers(target: {
        libraryID: number;
        collectionKey: string | null;
    }) {
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

    const isCurrent = (libraryID: number, key: string | null) =>
        !!scope && scope.libraryID === libraryID && scope.collectionKey === key;

    function renderCollection(
        node: EvoCollectionNode,
        depth: number,
    ): React.ReactNode {
        const key = id(node.libraryID, node.key);
        const expanded = open.has(key);
        return (
            <React.Fragment key={key}>
                <div
                    className={
                        "zotflow-evo-coll" +
                        (isCurrent(node.libraryID, node.key)
                            ? " is-current"
                            : "")
                    }
                    style={
                        { "--zotflow-evo-depth": depth } as React.CSSProperties
                    }
                    title={node.name}
                    {...handlers({
                        libraryID: node.libraryID,
                        collectionKey: node.key,
                    })}
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
                    <Icon
                        name={expanded ? "folder-open" : "folder"}
                        className="zotflow-evo-coll-icon"
                    />
                    <span className="zotflow-evo-coll-name">{node.name}</span>
                </div>
                {expanded &&
                    node.children.map((child) =>
                        renderCollection(child, depth + 1),
                    )}
            </React.Fragment>
        );
    }

    return (
        <div className="zotflow-evo-colls" role="tree">
            {libraries.map((lib) => {
                const closed = closedLibraries.has(lib.libraryID);
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
                                    (lib.collections.length ? "" : " is-empty")
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
                                {lib.collections.length > 0 && (
                                    <Icon
                                        name={
                                            closed
                                                ? "chevron-right"
                                                : "chevron-down"
                                        }
                                    />
                                )}
                            </span>
                            <Icon
                                name="library"
                                className="zotflow-evo-coll-icon"
                            />
                            <span className="zotflow-evo-coll-name">
                                {lib.name}
                            </span>
                        </div>
                        {!closed &&
                            lib.collections.map((c) => renderCollection(c, 1))}
                    </div>
                );
            })}
        </div>
    );
}
