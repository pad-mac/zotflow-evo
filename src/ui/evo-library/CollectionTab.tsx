/**
 * ZotFlow Evo (fork): one collection in a tab of its own — its name on top
 * and a table of its items, for a narrow pane. Opened from the library
 * browser (Ctrl+right-click or middle click on a collection). See FORK.md.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";

import { workerBridge } from "bridge";
import { services } from "services/services";
import {
    openAnnotationsTab,
    openBookSearch,
    openItem,
    setItemsDrag,
} from "ui/evo-library/actions";
import { ItemTable } from "ui/evo-library/ItemTable";
import { showItemMenu } from "ui/evo-library/menus";
import { Icon, useLibraryChanges } from "ui/evo-library/parts";
import {
    useScopeRows,
    useSelection,
    useTableSettings,
} from "ui/evo-library/useItems";

import type { App, WorkspaceLeaf } from "obsidian";
import type { EvoItemRow } from "utils/evo-library-model";
import type { EvoCollectionNode, EvoScope } from "worker/services/evo-library";

export interface CollectionTabProps {
    app: App;
    leaf: WorkspaceLeaf;
    scope: EvoScope;
    onName: (name: string) => void;
    onSubcollections: (on: boolean) => void;
}

export function CollectionTab({
    app,
    leaf,
    scope,
    onName,
    onSubcollections,
}: CollectionTabProps) {
    const [name, setName] = useState("");
    const [filter, setFilter] = useState("");

    const loadName = useCallback(() => {
        workerBridge.evoLibrary
            .getCollectionTree()
            .then((libraries) => {
                const lib = libraries.find(
                    (l) => l.libraryID === scope.libraryID,
                );
                let found =
                    scope.collectionKey === null ? (lib?.name ?? "") : "";
                const walk = (nodes: EvoCollectionNode[]) => {
                    for (const n of nodes) {
                        if (n.key === scope.collectionKey) found = n.name;
                        walk(n.children);
                    }
                };
                if (lib) walk(lib.collections);
                setName(found || "Collection");
            })
            .catch((e: unknown) =>
                services.logService.error(
                    "Failed to read the collection",
                    "EvoLibrary",
                    e,
                ),
            );
    }, [scope]);
    useEffect(loadName, [loadName]);
    useLibraryChanges(loadName);
    useEffect(() => {
        if (name) onName(name);
    }, [name, onName]);

    const stableScope = useMemo(() => scope, [scope]);
    const { rows, loading } = useScopeRows(stableScope);
    const table = useTableSettings("collection");
    const sel = useSelection(rows, filter, table.sort);

    const dragRows = (row: EvoItemRow, event: React.DragEvent) => {
        const items =
            sel.selected.has(row.key) && sel.selectedRows.length > 1
                ? sel.selectedRows
                : [row];
        if (!setItemsDrag(event.dataTransfer, items)) event.preventDefault();
    };

    return (
        <div className="zotflow-evo-colltab">
            <div className="zotflow-evo-colltab-title" title={name}>
                {name}
            </div>
            <div className="zotflow-evo-toolbar">
                <input
                    className="zotflow-evo-filter"
                    type="search"
                    placeholder="Filter"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                />
                <span className="zotflow-evo-toolbar-count">
                    {loading ? "…" : sel.shown.length}
                </span>
                <span
                    className={
                        "zotflow-evo-tool" +
                        (scope.subcollections ? " is-on" : "")
                    }
                    title="Show items from sub-collections"
                    aria-pressed={scope.subcollections}
                    onClick={() => onSubcollections(!scope.subcollections)}
                >
                    <Icon name="folder-tree" />
                </span>
                <span
                    className="zotflow-evo-tool"
                    title="Show the annotations of this collection"
                    onClick={() => void openAnnotationsTab(app, scope)}
                >
                    <Icon name="highlighter" />
                </span>
            </div>
            <ItemTable
                rows={sel.shown}
                columns={table.columns}
                widths={table.widths}
                sort={table.sort}
                selected={sel.selected}
                focusKey={sel.focusKey}
                emptyText={
                    loading
                        ? "Loading…"
                        : filter
                          ? "Nothing matches the filter."
                          : "No items."
                }
                onSort={table.toggleSort}
                onColumns={table.setColumns}
                onWidth={table.setWidth}
                onSelect={sel.select}
                onSelectAll={sel.selectAll}
                onMove={sel.move}
                onOpen={(row) => openItem(app, row.libraryID, row.key)}
                onMenu={(row, e) => {
                    if (!sel.selected.has(row.key))
                        sel.select(row, {
                            ctrlKey: false,
                            metaKey: false,
                            shiftKey: false,
                        });
                    showItemMenu(app, leaf, row, e.nativeEvent);
                }}
                onDragRows={dragRows}
                onSearch={(row) => void openBookSearch(app, leaf, row)}
            />
        </div>
    );
}
