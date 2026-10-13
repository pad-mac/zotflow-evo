/**
 * ZotFlow Evo (fork): the library browser, laid out like Zotero's main
 * window — collections on the left, the items in a table in the middle, the
 * selected item on the right. See FORK.md.
 */
import React, {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";

import { workerBridge } from "bridge";
import { services } from "services/services";
import {
    openAnnotation,
    openAnnotationsTab,
    openBookSearch,
    openCollectionTab,
    openItem,
    setItemsDrag,
} from "ui/evo-library/actions";
import { CollectionPane } from "ui/evo-library/CollectionPane";
import { ItemDetails } from "ui/evo-library/ItemDetails";
import { ItemTable } from "ui/evo-library/ItemTable";
import { showCollectionMenu, showItemMenu } from "ui/evo-library/menus";
import { Icon, useLibraryChanges } from "ui/evo-library/parts";
import {
    useScopeRows,
    useSelection,
    useTableSettings,
} from "ui/evo-library/useItems";
import { openAttachment } from "utils/viewer";

import type { App, WorkspaceLeaf } from "obsidian";
import type { EvoItemRow } from "utils/evo-library-model";
import type {
    EvoCollectionNode,
    EvoItemDetails,
    EvoLibraryNode,
    EvoScope,
} from "worker/services/evo-library";

export interface BrowserTarget {
    libraryID: number;
    collectionKey: string | null;
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
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
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
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        onDone(width);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
}

export interface LibraryBrowserProps {
    app: App;
    leaf: WorkspaceLeaf;
    initial: BrowserTarget | null;
    onTarget: (target: BrowserTarget) => void;
}

export function LibraryBrowser({
    app,
    leaf,
    initial,
    onTarget,
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
    const [details, setDetails] = useState<EvoItemDetails | null>(null);

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

    // The right pane follows the focused row.
    const detailsRun = useRef(0);
    const loadDetails = useCallback(() => {
        const row = sel.shown.find((r) => r.key === sel.focusKey);
        const id = ++detailsRun.current;
        if (!row) {
            setDetails(null);
            return;
        }
        workerBridge.evoLibrary
            .itemDetails(row.libraryID, row.key)
            .then((d) => {
                if (id === detailsRun.current) setDetails(d);
            })
            .catch((e: unknown) =>
                services.logService.error(
                    "Failed to read the item",
                    "EvoLibrary",
                    e,
                ),
            );
    }, [sel.focusKey, sel.shown]);
    useEffect(() => {
        const timer = window.setTimeout(loadDetails, 80);
        return () => window.clearTimeout(timer);
    }, [loadDetails]);
    useLibraryChanges(loadDetails);

    const setSub = useCallback((on: boolean) => {
        setSubcollections(on);
        services.settings.evoLibrarySubcollections = on;
        saveSettings();
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
    const focused = sel.shown.find((r) => r.key === sel.focusKey) ?? null;

    return (
        <div
            ref={rootRef}
            className="zotflow-evo-browser"
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
                    onSelect={(t) => setTarget(t)}
                    onOpenTab={(t) =>
                        void openCollectionTab(app, { ...t, subcollections })
                    }
                    onMenu={(t, e) =>
                        showCollectionMenu(
                            app,
                            { ...t, subcollections },
                            e.nativeEvent,
                            {
                                subcollections,
                                onSubcollections: setSub,
                            },
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
                        className="zotflow-evo-filter"
                        type="search"
                        placeholder="Filter"
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
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
            <div
                className="zotflow-evo-split"
                onPointerDown={(e) => resize("details", e)}
            />
            <div className="zotflow-evo-pane is-details">
                <ItemDetails
                    details={details}
                    count={sel.selected.size}
                    onOpenAttachment={(key) =>
                        details &&
                        void openAttachment(details.libraryID, key, app)
                    }
                    onOpenAnnotation={(a) =>
                        openAnnotation(app, a.libraryID, a.attachmentKey, a.id)
                    }
                    onSearch={() =>
                        focused && void openBookSearch(app, leaf, focused)
                    }
                />
            </div>
        </div>
    );
}
