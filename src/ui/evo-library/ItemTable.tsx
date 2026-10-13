/**
 * ZotFlow Evo (fork): the table of items in the library browser and the
 * collection tabs. Columns can be chosen (right-click the header), sorted
 * (click a header) and resized (drag a header's edge); only the rows on
 * screen are drawn. See FORK.md.
 */
import { Menu } from "obsidian";
import React, {
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
} from "react";

import { COLUMNS, cellText, columnDef } from "utils/evo-library-model";
import { Icon } from "ui/evo-library/parts";

import type { ColumnId, EvoItemRow, SortSpec } from "utils/evo-library-model";

/** Height of one row in pixels; `--zotflow-evo-row` in styles.css says the same. */
const ROW_HEIGHT = 26;
const OVERSCAN = 12;
const MIN_COLUMN = 30;

const KIND_ICON: Record<string, { icon: string; label: string }> = {
    pdf: { icon: "file-text", label: "PDF" },
    epub: { icon: "book-open", label: "EPUB" },
    snapshot: { icon: "globe", label: "Web snapshot" },
};

export interface ItemTableProps {
    rows: EvoItemRow[];
    columns: ColumnId[];
    widths: Record<string, number>;
    sort: SortSpec;
    selected: ReadonlySet<string>;
    focusKey: string | null;
    emptyText: string;
    onSort: (column: ColumnId) => void;
    onColumns: (columns: ColumnId[]) => void;
    onWidth: (column: ColumnId, width: number) => void;
    onSelect: (
        row: EvoItemRow,
        event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
    ) => void;
    onSelectAll: () => void;
    onMove: (delta: number, extend: boolean) => void;
    onOpen: (row: EvoItemRow) => void;
    onMenu: (row: EvoItemRow, event: React.MouseEvent) => void;
    onDragRows: (row: EvoItemRow, event: React.DragEvent) => void;
    onSearch: (row: EvoItemRow) => void;
}

function widthOf(column: ColumnId, widths: Record<string, number>): number {
    return Math.max(MIN_COLUMN, widths[column] ?? columnDef(column).width);
}

export function ItemTable(props: ItemTableProps) {
    const { rows, columns, widths, sort, selected, focusKey } = props;
    const scrollRef = useRef<HTMLDivElement>(null);
    const [view, setView] = useState({ top: 0, height: 600 });

    useLayoutEffect(() => {
        const el = scrollRef.current;
        if (!el) return undefined;
        const update = () =>
            setView({ top: el.scrollTop, height: el.clientHeight });
        update();
        const observer = new ResizeObserver(update);
        observer.observe(el);
        el.addEventListener("scroll", update, { passive: true });
        return () => {
            observer.disconnect();
            el.removeEventListener("scroll", update);
        };
    }, []);

    // Keep the focused row in view when it moves (arrow keys, a new selection).
    useEffect(() => {
        const el = scrollRef.current;
        if (!el || !focusKey) return;
        const index = rows.findIndex((r) => r.key === focusKey);
        if (index < 0) return;
        const top = index * ROW_HEIGHT;
        if (top < el.scrollTop) el.scrollTop = top;
        else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight)
            el.scrollTop = top + ROW_HEIGHT - el.clientHeight;
    }, [focusKey, rows]);

    const first = Math.max(0, Math.floor(view.top / ROW_HEIGHT) - OVERSCAN);
    const last = Math.min(
        rows.length,
        Math.ceil((view.top + view.height) / ROW_HEIGHT) + OVERSCAN,
    );
    const shown = rows.slice(first, last);

    const columnMenu = useCallback(
        (event: React.MouseEvent) => {
            event.preventDefault();
            const menu = new Menu();
            for (const def of COLUMNS) {
                const on = columns.includes(def.id);
                menu.addItem((item) =>
                    item
                        .setTitle(def.label)
                        .setChecked(on)
                        .setDisabled(def.id === "title")
                        .onClick(() => {
                            if (on)
                                props.onColumns(
                                    columns.filter((c) => c !== def.id),
                                );
                            else {
                                // In the order of COLUMNS.
                                const order = COLUMNS.map((c) => c.id);
                                props.onColumns(
                                    [...columns, def.id].sort(
                                        (a, b) =>
                                            order.indexOf(a) - order.indexOf(b),
                                    ),
                                );
                            }
                        }),
                );
            }
            menu.showAtMouseEvent(event.nativeEvent);
        },
        [columns, props],
    );

    function startResize(column: ColumnId, event: React.PointerEvent) {
        event.preventDefault();
        event.stopPropagation();
        const handle = event.currentTarget as HTMLElement;
        handle.setPointerCapture(event.pointerId);
        const startX = event.clientX;
        const start = widthOf(column, widths);
        const header = handle.closest<HTMLElement>(".zotflow-evo-table");
        let width = start;
        const move = (ev: PointerEvent) => {
            width = Math.max(
                MIN_COLUMN,
                Math.round(start + ev.clientX - startX),
            );
            header?.style.setProperty(
                `--zotflow-evo-col-${column}`,
                width + "px",
            );
        };
        const up = () => {
            handle.removeEventListener("pointermove", move);
            handle.removeEventListener("pointerup", up);
            if (width !== start) props.onWidth(column, width);
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", up);
    }

    function handleKeyDown(event: React.KeyboardEvent) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            props.onMove(event.key === "ArrowDown" ? 1 : -1, event.shiftKey);
        } else if (event.key === "Enter") {
            const row = rows.find((r) => r.key === focusKey);
            if (row) {
                event.preventDefault();
                props.onOpen(row);
            }
        } else if (
            (event.ctrlKey || event.metaKey) &&
            event.key.toLowerCase() === "a"
        ) {
            event.preventDefault();
            props.onSelectAll();
        }
    }

    // Column widths as variables on the table, so a drag changes one place.
    const vars: Record<string, string> = {};
    for (const column of columns)
        vars[`--zotflow-evo-col-${column}`] = widthOf(column, widths) + "px";

    function cell(row: EvoItemRow, column: ColumnId) {
        if (column === "attachment") {
            if (row.attachment && KIND_ICON[row.attachment]) {
                const kind = KIND_ICON[row.attachment]!;
                return (
                    <span
                        className="zotflow-evo-attachment"
                        title={`Open ${kind.label}`}
                        onClick={(e) => {
                            e.stopPropagation();
                            props.onOpen(row);
                        }}
                    >
                        <Icon name={kind.icon} />
                    </span>
                );
            }
            if (row.itemType === "note" || row.itemType === "attachment")
                return null;
            return (
                <span
                    className="zotflow-evo-attachment is-search"
                    title="Search for the file"
                    onClick={(e) => {
                        e.stopPropagation();
                        props.onSearch(row);
                    }}
                >
                    <Icon name="search" />
                </span>
            );
        }
        return cellText(row, column);
    }

    return (
        <div className="zotflow-evo-table" style={vars}>
            <div className="zotflow-evo-thead" onContextMenu={columnMenu}>
                {columns.map((column) => {
                    const def = columnDef(column);
                    const sorted = sort.column === column;
                    return (
                        <div
                            key={column}
                            className={`zotflow-evo-th zotflow-evo-col-${column}${def.narrow ? " is-narrow" : ""}${sorted ? " is-sorted" : ""}`}
                            title={def.label}
                            onClick={() => props.onSort(column)}
                        >
                            <span className="zotflow-evo-th-label">
                                {column === "attachment" ? (
                                    <Icon name="paperclip" />
                                ) : column === "annotations" ? (
                                    <Icon name="highlighter" />
                                ) : (
                                    def.label
                                )}
                            </span>
                            {sorted && (
                                <Icon
                                    name={
                                        sort.descending
                                            ? "chevron-down"
                                            : "chevron-up"
                                    }
                                    className="zotflow-evo-th-sort"
                                />
                            )}
                            <span
                                className="zotflow-evo-th-resize"
                                onPointerDown={(e) => startResize(column, e)}
                                onClick={(e) => e.stopPropagation()}
                            />
                        </div>
                    );
                })}
            </div>
            <div
                ref={scrollRef}
                className="zotflow-evo-tbody"
                tabIndex={0}
                onKeyDown={handleKeyDown}
            >
                {rows.length === 0 ? (
                    <div className="zotflow-evo-table-empty">
                        {props.emptyText}
                    </div>
                ) : (
                    <div
                        className="zotflow-evo-tbody-inner"
                        style={{ height: rows.length * ROW_HEIGHT }}
                    >
                        {shown.map((row, i) => (
                            <div
                                key={row.key}
                                className={
                                    "zotflow-evo-tr" +
                                    (selected.has(row.key)
                                        ? " is-selected"
                                        : "") +
                                    (row.key === focusKey ? " is-focused" : "")
                                }
                                style={{ top: (first + i) * ROW_HEIGHT }}
                                draggable
                                onDragStart={(e) => props.onDragRows(row, e)}
                                onClick={(e) => props.onSelect(row, e)}
                                onDoubleClick={() => props.onOpen(row)}
                                onContextMenu={(e) => props.onMenu(row, e)}
                                data-key={row.key}
                            >
                                {columns.map((column) => (
                                    <div
                                        key={column}
                                        className={`zotflow-evo-td zotflow-evo-col-${column}${columnDef(column).narrow ? " is-narrow" : ""}`}
                                    >
                                        {cell(row, column)}
                                    </div>
                                ))}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
