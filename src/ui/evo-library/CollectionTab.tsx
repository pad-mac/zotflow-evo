/**
 * ZotFlow Evo (fork): one collection in a tab of its own — its name on top
 * and a table of its items, for a narrow pane. Opened from the library
 * browser (Ctrl+right-click or middle click on a collection). The selected
 * item is shown beside the table as in the library browser, or under it
 * when the tab is narrow (a button in the toolbar hides it). See FORK.md.
 */
import React, {
    useCallback,
    useEffect,
    useImperativeHandle,
    useMemo,
    useRef,
    useState,
} from "react";

import { workerBridge } from "bridge";
import { services } from "services/services";
import {
    openAnnotationsTab,
    openFulltextSearch,
    openBookSearch,
    openItem,
    revealInLibrary,
    setItemsDrag,
} from "ui/evo-library/actions";
import { ItemDetails, useItemDetails } from "ui/evo-library/ItemDetails";
import { ItemTable } from "ui/evo-library/ItemTable";
import { showItemMenu, showSortMenu } from "ui/evo-library/menus";
import {
    ANNOTATIONS_ICON,
    ANNOTATIONS_ICON_FALLBACK,
    Icon,
    useLibraryChanges,
} from "ui/evo-library/parts";
import {
    publishScope,
    publishSelection,
    selectionLabel,
} from "ui/evo-library/selection";
import {
    useRowEditing,
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
    /** Puts the cursor in the filter field (the "filter" command). */
    control?: React.Ref<{ focusFilter(): void }>;
}

export function CollectionTab({
    app,
    leaf,
    scope,
    onName,
    onSubcollections,
    control,
}: CollectionTabProps) {
    const [name, setName] = useState("");
    const [filter, setFilter] = useState("");
    const filterRef = useRef<HTMLInputElement>(null);
    const bodyRef = useRef<HTMLDivElement>(null);
    useImperativeHandle(
        control,
        () => ({
            focusFilter() {
                filterRef.current?.focus();
                filterRef.current?.select();
            },
        }),
        [],
    );

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
    useEffect(() => {
        if (name)
            publishScope({
                libraryID: scope.libraryID,
                collectionKey: scope.collectionKey,
                label: name,
            });
    }, [name, scope.libraryID, scope.collectionKey]);

    const stableScope = useMemo(() => scope, [scope]);
    const { rows, loading } = useScopeRows(stableScope);
    const table = useTableSettings("collection");
    const sel = useSelection(rows, filter, table.sort);
    const editing = useRowEditing(stableScope, sel, bodyRef);

    const focused = sel.shown.find((r) => r.key === sel.focusKey) ?? null;
    const [detailsShown, setDetailsShown] = useState(
        services.settings.evoCollectionDetailsShown !== false,
    );
    const details = useItemDetails(detailsShown ? focused : null);
    const toggleDetails = useCallback(() => {
        setDetailsShown((on) => {
            services.settings.evoCollectionDetailsShown = !on;
            void services
                .saveSettings()
                .catch((e: unknown) =>
                    services.logService.error(
                        "Failed to save the collection tab settings",
                        "EvoLibrary",
                        e,
                    ),
                );
            return !on;
        });
    }, []);
    useEffect(() => {
        if (focused)
            publishSelection({
                libraryID: focused.libraryID,
                key: focused.key,
                label: selectionLabel(focused),
                itemType: focused.itemType,
            });
    }, [focused]);

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
                    ref={filterRef}
                    className="zotflow-evo-filter"
                    type="search"
                    placeholder="Filter"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "ArrowDown" || e.key === "Enter") {
                            e.preventDefault();
                            bodyRef.current?.focus();
                            if (!sel.focusKey) sel.move(1, false);
                        } else if (e.key === "Escape" && filter) {
                            e.preventDefault();
                            setFilter("");
                        }
                    }}
                />
                <span className="zotflow-evo-toolbar-count">
                    {loading ? "…" : sel.shown.length}
                </span>
                <span
                    className="zotflow-evo-tool"
                    title="Sort by"
                    onClick={(e) =>
                        showSortMenu(e.nativeEvent, table.sort, table.setSort)
                    }
                >
                    <Icon name="arrow-up-down" fallback="arrow-down" />
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
                    <Icon
                        name={ANNOTATIONS_ICON}
                        fallback={ANNOTATIONS_ICON_FALLBACK}
                    />
                </span>
                <span
                    className="zotflow-evo-tool"
                    title="Search the full text of the documents here"
                    onClick={() =>
                        void openFulltextSearch(app, [
                            {
                                libraryID: scope.libraryID,
                                collectionKey: scope.collectionKey,
                            },
                        ])
                    }
                >
                    <Icon name="text-search" fallback="search" />
                </span>
                <span
                    className={
                        "zotflow-evo-tool" + (detailsShown ? " is-on" : "")
                    }
                    title={
                        detailsShown
                            ? "Hide the item pane"
                            : "Show the item pane"
                    }
                    aria-pressed={detailsShown}
                    onClick={toggleDetails}
                >
                    <Icon name="panel-right" />
                </span>
            </div>
            <div
                className={
                    "zotflow-evo-colltab-body" +
                    (detailsShown ? " has-details" : "")
                }
            >
                <div className="zotflow-evo-colltab-items">
                    <ItemTable
                        rows={sel.shown}
                        columns={table.columns}
                        widths={table.widths}
                        sort={table.sort}
                        selected={sel.selected}
                        focusKey={sel.focusKey}
                        prompt={editing.prompt}
                        bodyRef={bodyRef}
                        emptyText={
                            loading
                                ? "Loading…"
                                : filter
                                  ? "Nothing matches the filter."
                                  : "No items."
                        }
                        onSort={table.toggleSort}
                        onColumns={table.setColumns}
                        onWidths={table.setWidths}
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
                            showItemMenu(app, leaf, row, e.nativeEvent, {
                                onRemove:
                                    scope.collectionKey !== null
                                        ? () => editing.ask(false)
                                        : undefined,
                                onTrash: () => editing.ask(true),
                            });
                        }}
                        onDragRows={dragRows}
                        onSearch={(row) => void openBookSearch(app, leaf, row)}
                        onDeleteKey={editing.ask}
                        onPromptConfirm={editing.confirm}
                        onPromptCancel={editing.cancel}
                    />
                </div>
                {detailsShown && (
                    <div className="zotflow-evo-pane is-details">
                        <ItemDetails
                            app={app}
                            leaf={leaf}
                            details={details}
                            count={sel.selected.size}
                            onShowInCollection={(
                                libraryID,
                                collectionKey,
                                itemKey,
                            ) =>
                                void revealInLibrary(
                                    app,
                                    libraryID,
                                    collectionKey,
                                    itemKey,
                                )
                            }
                        />
                    </div>
                )}
            </div>
        </div>
    );
}
