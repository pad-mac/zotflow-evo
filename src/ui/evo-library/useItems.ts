/**
 * ZotFlow Evo (fork): the rows of a table — loaded from the worker for a
 * scope, filtered, sorted — and which of them are selected. Shared by the
 * library browser and the collection tabs. See FORK.md.
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
import { removeItemsFromCollection, trashItems } from "ui/evo-library/actions";
import { useLibraryChanges } from "ui/evo-library/parts";
import {
    COLUMNS,
    DEFAULT_COLLECTION_COLUMNS,
    DEFAULT_LIBRARY_COLUMNS,
    filterRows,
    rangeOf,
    sanitizeColumns,
    sortRows,
} from "utils/evo-library-model";

import type { RowPrompt } from "ui/evo-library/ItemTable";
import type { ColumnId, EvoItemRow, SortSpec } from "utils/evo-library-model";
import type { EvoScope } from "worker/services/evo-library";

function saveSettings() {
    void services.saveSettings().catch((e: unknown) => {
        services.logService.error(
            "Failed to save the library browser settings",
            "EvoLibrary",
            e,
        );
    });
}

/** The table's settings: columns (for the library or for collection tabs), widths, sort. */
export function useTableSettings(which: "library" | "collection") {
    const key =
        which === "library" ? "evoLibraryColumns" : "evoCollectionColumns";
    const fallback =
        which === "library"
            ? DEFAULT_LIBRARY_COLUMNS
            : DEFAULT_COLLECTION_COLUMNS;
    const [columns, setColumnsState] = useState<ColumnId[]>(() =>
        sanitizeColumns(services.settings[key], fallback),
    );
    const [widths, setWidths] = useState<Record<string, number>>(() => ({
        ...services.settings.evoColumnWidths,
    }));
    const [sort, setSortState] = useState<SortSpec>(() => {
        const stored = services.settings.evoLibrarySort;
        const known = COLUMNS.some((c) => c.id === stored?.column);
        return {
            column: known ? (stored.column as ColumnId) : "title",
            descending: !!stored?.descending,
        };
    });

    const setColumns = useCallback(
        (next: ColumnId[]) => {
            setColumnsState(next);
            services.settings[key] = [...next];
            saveSettings();
        },
        [key],
    );
    const changeWidths = useCallback(
        (change: Partial<Record<ColumnId, number>>) => {
            setWidths((current) => {
                const next = { ...current, ...change } as Record<
                    string,
                    number
                >;
                services.settings.evoColumnWidths = next;
                saveSettings();
                return next;
            });
        },
        [],
    );
    const setSort = useCallback((next: SortSpec) => {
        setSortState(next);
        services.settings.evoLibrarySort = { ...next };
        saveSettings();
    }, []);
    const toggleSort = useCallback((column: ColumnId) => {
        setSortState((current) => {
            const next =
                current.column === column
                    ? { column, descending: !current.descending }
                    : { column, descending: false };
            services.settings.evoLibrarySort = { ...next };
            saveSettings();
            return next;
        });
    }, []);

    return {
        columns,
        setColumns,
        widths,
        setWidths: changeWidths,
        sort,
        setSort,
        toggleSort,
    };
}

/** The items of a scope, kept up to date with the library. */
export function useScopeRows(scope: EvoScope | null) {
    const [rows, setRows] = useState<EvoItemRow[]>([]);
    const [loading, setLoading] = useState(false);
    const run = useRef(0);

    const load = useCallback(() => {
        if (!scope) {
            setRows([]);
            return;
        }
        const id = ++run.current;
        setLoading(true);
        workerBridge.evoLibrary
            .listItems(scope)
            .then((list) => {
                if (id === run.current) setRows(list);
            })
            .catch((e: unknown) => {
                services.logService.error(
                    "Failed to list the items",
                    "EvoLibrary",
                    e,
                );
            })
            .finally(() => {
                if (id === run.current) setLoading(false);
            });
    }, [scope]);

    useEffect(load, [load]);
    useLibraryChanges(load);
    return { rows, loading, reload: load };
}

/** Filtered, sorted rows and a selection over them (click, Ctrl/Cmd+click, Shift+click, arrows). */
export function useSelection(
    rows: EvoItemRow[],
    filter: string,
    sort: SortSpec,
) {
    const shown = useMemo(
        () => sortRows(filterRows(rows, filter), sort),
        [rows, filter, sort],
    );
    const order = useMemo(() => shown.map((r) => r.key), [shown]);
    const [selected, setSelected] = useState<Set<string>>(() => new Set());
    const [focusKey, setFocusKey] = useState<string | null>(null);
    const anchor = useRef<string | null>(null);

    // Rows that went away (another scope, a filter) leave the selection.
    useEffect(() => {
        setSelected((current) => {
            const keep = new Set([...current].filter((k) => order.includes(k)));
            return keep.size === current.size ? current : keep;
        });
        setFocusKey((current) =>
            current && order.includes(current) ? current : null,
        );
    }, [order]);

    const select = useCallback(
        (
            row: EvoItemRow,
            event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
        ) => {
            if (event.shiftKey) {
                setSelected(new Set(rangeOf(order, anchor.current, row.key)));
            } else if (event.ctrlKey || event.metaKey) {
                setSelected((current) => {
                    const next = new Set(current);
                    if (!next.delete(row.key)) next.add(row.key);
                    return next;
                });
                anchor.current = row.key;
            } else {
                setSelected(new Set([row.key]));
                anchor.current = row.key;
            }
            setFocusKey(row.key);
        },
        [order],
    );

    const move = useCallback(
        (delta: number, extend: boolean) => {
            if (!order.length) return;
            const from = focusKey ? order.indexOf(focusKey) : -1;
            const to = Math.max(
                0,
                Math.min(order.length - 1, from < 0 ? 0 : from + delta),
            );
            const key = order[to]!;
            if (extend)
                setSelected(
                    new Set(rangeOf(order, anchor.current ?? focusKey, key)),
                );
            else {
                setSelected(new Set([key]));
                anchor.current = key;
            }
            setFocusKey(key);
        },
        [order, focusKey],
    );

    const selectAll = useCallback(() => setSelected(new Set(order)), [order]);

    /** Select one row by key; false when it is not listed. */
    const selectKey = useCallback(
        (key: string) => {
            if (!order.includes(key)) return false;
            setSelected(new Set([key]));
            anchor.current = key;
            setFocusKey(key);
            return true;
        },
        [order],
    );

    const selectedRows = useMemo(
        () => shown.filter((r) => selected.has(r.key)),
        [shown, selected],
    );
    return {
        shown,
        selected,
        selectedRows,
        focusKey,
        select,
        move,
        selectAll,
        selectKey,
    };
}

/** An edit waiting for Enter: take the selection out of the collection, or trash it. */
interface PendingEdit {
    kind: "remove" | "trash";
    libraryID: number;
    collectionKey: string | null;
    keys: string[];
    /** The row the question is shown at. */
    anchor: string;
}

/**
 * Delete and Shift+Delete on a table, and the same from the item menu: a
 * question at the selected line, confirmed with Enter. In a collection,
 * Delete takes the selection out of it; in a whole library (as in Zotero)
 * and with Shift+Delete everywhere it goes to the trash.
 */
export function useRowEditing(
    scope: EvoScope | null,
    sel: ReturnType<typeof useSelection>,
    bodyRef: React.RefObject<HTMLDivElement>,
) {
    const [pending, setPending] = useState<PendingEdit | null>(null);

    // Another selection drops the question.
    useEffect(() => setPending(null), [sel.selected]);

    // Read when asked: a menu asks with the selection its right-click made.
    const latest = useRef({ scope, sel });
    latest.current = { scope, sel };

    const ask = useCallback(
        (trash: boolean) => {
            const { scope: now, sel: current } = latest.current;
            if (!now || !current.selectedRows.length) return;
            const anchor =
                current.focusKey && current.selected.has(current.focusKey)
                    ? current.focusKey
                    : current.selectedRows[0]!.key;
            setPending({
                kind: trash || now.collectionKey === null ? "trash" : "remove",
                libraryID: now.libraryID,
                collectionKey: now.collectionKey,
                keys: current.selectedRows.map((r) => r.key),
                anchor,
            });
            bodyRef.current?.focus();
        },
        [bodyRef],
    );

    const confirm = useCallback(() => {
        const edit = pending;
        setPending(null);
        bodyRef.current?.focus();
        if (!edit) return;
        if (edit.kind === "trash") void trashItems(edit.libraryID, edit.keys);
        else if (edit.collectionKey)
            void removeItemsFromCollection(
                edit.libraryID,
                edit.keys,
                edit.collectionKey,
            );
    }, [pending, bodyRef]);

    const cancel = useCallback(() => {
        setPending(null);
        bodyRef.current?.focus();
    }, [bodyRef]);

    let prompt: RowPrompt | null = null;
    if (pending) {
        const n = pending.keys.length;
        const what = n === 1 ? "this item" : `${n} items`;
        prompt =
            pending.kind === "trash"
                ? {
                      key: pending.anchor,
                      text: `Move ${what} to the trash?`,
                      confirmLabel: "Move to trash",
                  }
                : {
                      key: pending.anchor,
                      text: `Remove ${what} from the collection?`,
                      confirmLabel: "Remove",
                  };
    }
    return { prompt, ask, confirm, cancel };
}
