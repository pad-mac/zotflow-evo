/**
 * ZotFlow Evo (fork): the rows of a table — loaded from the worker for a
 * scope, filtered, sorted — and which of them are selected. Shared by the
 * library browser and the collection tabs. See FORK.md.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { workerBridge } from "bridge";
import { services } from "services/services";
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
    const setWidth = useCallback((column: ColumnId, width: number) => {
        setWidths((current) => {
            const next = { ...current, [column]: width };
            services.settings.evoColumnWidths = next;
            saveSettings();
            return next;
        });
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

    return { columns, setColumns, widths, setWidth, sort, toggleSort };
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

    const selectedRows = useMemo(
        () => shown.filter((r) => selected.has(r.key)),
        [shown, selected],
    );
    return { shown, selected, selectedRows, focusKey, select, move, selectAll };
}
