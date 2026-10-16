/**
 * ZotFlow Evo (fork): the library browser, laid out like Zotero's main
 * window — collections on the left, the items in a table in the middle, the
 * selected item on the right (which a button in the toolbar shows and
 * hides). See FORK.md.
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
    addItemsToCollection,
    openAnnotationsTab,
    openBookSearch,
    openCollectionTab,
    openItem,
    setItemsDrag,
} from "ui/evo-library/actions";
import { CollectionPane } from "ui/evo-library/CollectionPane";
import { ItemDetails, useItemDetails } from "ui/evo-library/ItemDetails";
import { ItemTable } from "ui/evo-library/ItemTable";
import { showCollectionMenu, showItemMenu } from "ui/evo-library/menus";
import {
    ANNOTATIONS_ICON,
    ANNOTATIONS_ICON_FALLBACK,
    Icon,
    useLibraryChanges,
} from "ui/evo-library/parts";
import { publishSelection, selectionLabel } from "ui/evo-library/selection";
import {
    useRowEditing,
    useScopeRows,
    useSelection,
    useTableSettings,
} from "ui/evo-library/useItems";
import { PINNED_SIBLINGS, collectionId } from "utils/evo-library-model";

import type { App, WorkspaceLeaf } from "obsidian";
import type { CollectionTarget } from "ui/evo-library/CollectionPane";
import type { EvoItemRow } from "utils/evo-library-model";
import type {
    EvoCollectionNode,
    EvoLibraryNode,
    EvoScope,
} from "worker/services/evo-library";

export type BrowserTarget = CollectionTarget;

/** What the view asks of the browser (commands). */
export interface BrowserControl {
    /** Show a library or collection; null: the first library (My Library). */
    goTo(target: BrowserTarget | null): void;
    /** Put the cursor in the filter field. */
    focusFilter(): void;
}

function findName(
    libraries: EvoLibraryNode[],
    target: BrowserTarget | null,
): string {
    if (!target) return "";
    const lib = libraries.find((l) => l.libraryID === target.libraryID);
    if (!lib) return "";
    if (target.collectionKey === null) return lib.name;
    const walk = (nodes: EvoCollectionNode[]): string | null => {
        for (const n of nodes) {
            if (n.key === target.collectionKey) return n.name;
            const inner = walk(n.children);
            if (inner) return inner;
        }
        return null;
    };
    return walk(lib.collections) ?? "";
}

function saveSettings() {
    void services.saveSettings().catch((e: unknown) => {
        services.logService.error(
            "Failed to save the library browser settings",
            "EvoLibrary",
            e,
        );
    });
}

/** Drag a pane's edge: `onWidth` gets the new width, `onDone` it once more at the end. */
function startPaneResize(
    event: React.PointerEvent,
    start: number,
    sign: 1 | -1,
    onWidth: (width: number) => void,
    onDone: (width: number) => void,
) {
    if (event.button !== 0) return;
    event.preventDefault();
    const doc = (event.currentTarget as HTMLElement).ownerDocument;
    const startX = event.clientX;
    let width = start;
    const move = (ev: PointerEvent) => {
        width = Math.max(
            140,
            Math.min(900, Math.round(start + sign * (ev.clientX - startX))),
        );
        onWidth(width);
    };
    const up = () => {
        doc.removeEventListener("pointermove", move, true);
        doc.removeEventListener("pointerup", up, true);
        doc.removeEventListener("pointercancel", up, true);
        onDone(width);
    };
    doc.addEventListener("pointermove", move, true);
    doc.addEventListener("pointerup", up, true);
    doc.addEventListener("pointercancel", up, true);
}

export interface LibraryBrowserProps {
    app: App;
    leaf: WorkspaceLeaf;
    initial: BrowserTarget | null;
    onTarget: (target: BrowserTarget) => void;
    control?: React.Ref<BrowserControl>;
}

export function LibraryBrowser({
    app,
    leaf,
    initial,
    onTarget,
    control,
}: LibraryBrowserProps) {
    const [libraries, setLibraries] = useState<EvoLibraryNode[]>([]);
    const [target, setTarget] = useState<BrowserTarget | null>(initial);
    const [subcollections, setSubcollections] = useState(
        services.settings.evoLibrarySubcollections,
    );
    const [filter, setFilter] = useState("");
    const [panes, setPanes] = useState(() => ({
        ...services.settings.evoLibraryPanes,
    }));
    const [detailsShown, setDetailsShown] = useState(
        services.settings.evoLibraryDetailsShown !== false,
    );
    const [pinned, setPinned] = useState<string[]>(() => [
        ...(services.settings.evoPinnedCollections ?? []),
    ]);
    const [orders, setOrders] = useState<Record<string, string[]>>(() => ({
        ...(services.settings.evoCollectionOrder ?? {}),
    }));
    const filterRef = useRef<HTMLInputElement>(null);
    const bodyRef = useRef<HTMLDivElement>(null);

    const loadLibraries = useCallback(() => {
        workerBridge.evoLibrary
            .getCollectionTree()
            .then((list) => {
                setLibraries(list);
                // Start in the first library, or after it went away.
                setTarget((current) => {
                    if (
                        current &&
                        list.some((l) => l.libraryID === current.libraryID)
                    )
                        return current;
                    return list[0]
                        ? { libraryID: list[0].libraryID, collectionKey: null }
                        : null;
                });
            })
            .catch((e: unknown) =>
                services.logService.error(
                    "Failed to read the collections",
                    "EvoLibrary",
                    e,
                ),
            );
    }, []);
    useEffect(loadLibraries, [loadLibraries]);
    useLibraryChanges(loadLibraries);

    useEffect(() => {
        if (target) onTarget(target);
    }, [target, onTarget]);

    useImperativeHandle(
        control,
        () => ({
            goTo(next) {
                const first = libraries[0];
                const to =
                    next ??
                    (first
                        ? { libraryID: first.libraryID, collectionKey: null }
                        : null);
                if (to) setTarget(to);
            },
            focusFilter() {
                const input = filterRef.current;
                if (!input) return;
                input.focus();
                input.select();
            },
        }),
        [libraries],
    );

    const scope = useMemo<EvoScope | null>(
        () =>
            target
                ? {
                      libraryID: target.libraryID,
                      collectionKey: target.collectionKey,
                      subcollections,
                  }
                : null,
        [target, subcollections],
    );
    const { rows, loading } = useScopeRows(scope);
    const table = useTableSettings("library");
    const sel = useSelection(rows, filter, table.sort);
    const editing = useRowEditing(scope, sel, bodyRef);

    const focused = sel.shown.find((r) => r.key === sel.focusKey) ?? null;
    const details = useItemDetails(detailsShown ? focused : null);

    // The item details tab and "save to the selected item" follow this.
    useEffect(() => {
        if (focused)
            publishSelection({
                libraryID: focused.libraryID,
                key: focused.key,
                label: selectionLabel(focused),
                itemType: focused.itemType,
            });
    }, [focused]);

    const setSub = useCallback((on: boolean) => {
        setSubcollections(on);
        services.settings.evoLibrarySubcollections = on;
        saveSettings();
    }, []);

    const toggleDetails = useCallback(() => {
        setDetailsShown((on) => {
            services.settings.evoLibraryDetailsShown = !on;
            saveSettings();
            return !on;
        });
    }, []);

    const pin = useCallback((id: string, on: boolean) => {
        setPinned((current) => {
            const next = on
                ? current.includes(id)
                    ? current
                    : [...current, id]
                : current.filter((p) => p !== id);
            services.settings.evoPinnedCollections = next;
            saveSettings();
            return next;
        });
    }, []);

    const reorder = useCallback((siblings: string, order: string[]) => {
        if (siblings === PINNED_SIBLINGS) {
            setPinned((current) => {
                // Pins not shown (their library is gone, say) keep their place at the end.
                const next = [
                    ...order,
                    ...current.filter((p) => !order.includes(p)),
                ];
                services.settings.evoPinnedCollections = next;
                saveSettings();
                return next;
            });
            return;
        }
        setOrders((current) => {
            const next = { ...current, [siblings]: order };
            services.settings.evoCollectionOrder = next;
            saveSettings();
            return next;
        });
    }, []);

    const rootRef = useRef<HTMLDivElement>(null);
    const resize = (
        which: "collections" | "details",
        event: React.PointerEvent,
    ) =>
        startPaneResize(
            event,
            panes[which],
            which === "collections" ? 1 : -1,
            (width) =>
                rootRef.current?.style.setProperty(
                    `--zotflow-evo-pane-${which}`,
                    width + "px",
                ),
            (width) => {
                setPanes((current) => {
                    const next = { ...current, [which]: width };
                    services.settings.evoLibraryPanes = next;
                    saveSettings();
                    return next;
                });
            },
        );

    const dragRows = (row: EvoItemRow, event: React.DragEvent) => {
        const items =
            sel.selected.has(row.key) && sel.selectedRows.length > 1
                ? sel.selectedRows
                : [row];
        if (!setItemsDrag(event.dataTransfer, items)) event.preventDefault();
    };

    const name = findName(libraries, target);

    return (
        <div
            ref={rootRef}
            className={
                "zotflow-evo-browser" +
                (detailsShown ? "" : " is-details-hidden")
            }
            style={
                {
                    "--zotflow-evo-pane-collections": panes.collections + "px",
                    "--zotflow-evo-pane-details": panes.details + "px",
                } as React.CSSProperties
            }
        >
            <div className="zotflow-evo-pane is-collections">
                <CollectionPane
                    libraries={libraries}
                    scope={scope}
                    pinned={pinned}
                    orders={orders}
                    onSelect={(t) => setTarget(t)}
                    onOpenTab={(t) =>
                        void openCollectionTab(app, { ...t, subcollections })
                    }
                    onMenu={(t, e) => {
                        const id =
                            t.collectionKey === null
                                ? null
                                : collectionId(t.libraryID, t.collectionKey);
                        showCollectionMenu(
                            app,
                            { ...t, subcollections },
                            e.nativeEvent,
                            {
                                subcollections,
                                onSubcollections: setSub,
                                pinned: id ? pinned.includes(id) : undefined,
                                onPin: id ? (on) => pin(id, on) : undefined,
                            },
                        );
                    }}
                    onReorder={reorder}
                    onDropItems={(items, collection) =>
                        void addItemsToCollection(
                            items.libraryID,
                            items.keys,
                            collection.key,
                            collection.name,
                        )
                    }
                />
            </div>
            <div
                className="zotflow-evo-split"
                onPointerDown={(e) => resize("collections", e)}
            />
            <div className="zotflow-evo-pane is-items">
                <div className="zotflow-evo-toolbar">
                    <span className="zotflow-evo-toolbar-title" title={name}>
                        {name}
                    </span>
                    <span className="zotflow-evo-toolbar-count">
                        {loading ? "…" : sel.shown.length}
                    </span>
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
                    <span
                        className={
                            "zotflow-evo-tool" +
                            (subcollections ? " is-on" : "")
                        }
                        title="Show items from sub-collections"
                        aria-pressed={subcollections}
                        onClick={() => setSub(!subcollections)}
                    >
                        <Icon name="folder-tree" />
                    </span>
                    <span
                        className="zotflow-evo-tool"
                        title="Show the annotations of this collection"
                        onClick={() =>
                            scope && void openAnnotationsTab(app, scope)
                        }
                    >
                        <Icon
                            name={ANNOTATIONS_ICON}
                            fallback={ANNOTATIONS_ICON_FALLBACK}
                        />
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
                                scope?.collectionKey != null
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
                <>
                    <div
                        className="zotflow-evo-split"
                        onPointerDown={(e) => resize("details", e)}
                    />
                    <div className="zotflow-evo-pane is-details">
                        <ItemDetails
                            app={app}
                            leaf={leaf}
                            details={details}
                            count={sel.selected.size}
                        />
                    </div>
                </>
            )}
        </div>
    );
}
