/**
 * ZotFlow Evo (fork): the table of items in the library browser and the
 * collection tabs. Columns can be chosen (right-click the header), sorted
 * (click a header) and resized (drag the border between two headers; the
 * title column takes up what is left, so dragging its border resizes the
 * column next to it). Only the rows on screen are drawn. Delete and
 * Shift+Delete ask, at the selected line, before anything is changed.
 * See FORK.md.
 */
import { Menu } from "obsidian";
import React, {
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
} from "react";

import {
    COLUMNS,
    cellText,
    columnDef,
    resizeColumns,
    widthOf,
} from "utils/evo-library-model";
import { Icon, Title } from "ui/evo-library/parts";

import type { ColumnId, EvoItemRow, SortSpec } from "utils/evo-library-model";

/** Height of one row in pixels; `--zotflow-evo-row` in styles.css says the same. */
const ROW_HEIGHT = 26;
const OVERSCAN = 12;

const KIND_ICON: Record<
    string,
    { icon: string; fallback?: string; label: string }
> = {
    pdf: { icon: "file-text", label: "Open PDF" },
    epub: { icon: "book-open", label: "Open EPUB" },
    snapshot: { icon: "globe", label: "Open web snapshot" },
    linked: {
        icon: "file-symlink",
        fallback: "link",
        label: "Linked file (outside Zotero's storage)",
    },
};

/** A question asked at the selected line before an edit (Delete, Shift+Delete). */
export interface RowPrompt {
    /** The row it is shown at. */
    key: string;
    text: string;
    confirmLabel: string;
}

export interface ItemTableProps {
    rows: EvoItemRow[];
    columns: ColumnId[];
    widths: Record<string, number>;
    sort: SortSpec;
    selected: ReadonlySet<string>;
    focusKey: string | null;
    emptyText: string;
    prompt?: RowPrompt | null;
    onSort: (column: ColumnId) => void;
    onColumns: (columns: ColumnId[]) => void;
    onWidths: (widths: Partial<Record<ColumnId, number>>) => void;
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
    /** Delete (`trash` false) or Shift+Delete (`trash` true) on the selection. */
    onDeleteKey?: (trash: boolean) => void;
    onPromptConfirm?: () => void;
    onPromptCancel?: () => void;
    /** The table's keyboard focus, for the view to give it back. */
    bodyRef?: React.RefObject<HTMLDivElement>;
}

export function ItemTable(props: ItemTableProps) {
    const { rows, columns, widths, sort, selected, focusKey, prompt } = props;
    const ownRef = useRef<HTMLDivElement>(null);
    const scrollRef = props.bodyRef ?? ownRef;
    const tableRef = useRef<HTMLDivElement>(null);
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
    }, [scrollRef]);

    // Keep the focused row (or the question) in view when it moves.
    const shownKey = prompt?.key ?? focusKey;
    useEffect(() => {
        const el = scrollRef.current;
        if (!el || !shownKey) return;
        const index = rows.findIndex((r) => r.key === shownKey);
        if (index < 0) return;
        const top = index * ROW_HEIGHT;
        if (top < el.scrollTop) el.scrollTop = top;
        else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight)
            el.scrollTop = top + ROW_HEIGHT - el.clientHeight;
    }, [shownKey, rows, scrollRef]);

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
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        const handle = event.currentTarget as HTMLElement;
        const doc = handle.ownerDocument;
        const table = tableRef.current;
        const startX = event.clientX;
        let change: Partial<Record<ColumnId, number>> = {};
        handle.classList.add("is-dragging");
        doc.body.classList.add("zotflow-evo-col-resizing");
        // Listened for on the document: the pointer soon leaves the 6 px
        // handle, and a captured pointer is not certain to stay captured.
        const move = (ev: PointerEvent) => {
            change = resizeColumns(
                columns,
                widths,
                column,
                ev.clientX - startX,
            );
            for (const [id, width] of Object.entries(change)) {
                table?.style.setProperty(
                    `--zotflow-evo-col-${id}`,
                    width + "px",
                );
            }
        };
        const up = () => {
            doc.removeEventListener("pointermove", move, true);
            doc.removeEventListener("pointerup", up, true);
            doc.removeEventListener("pointercancel", up, true);
            handle.classList.remove("is-dragging");
            doc.body.classList.remove("zotflow-evo-col-resizing");
            if (Object.keys(change).length) props.onWidths(change);
        };
        doc.addEventListener("pointermove", move, true);
        doc.addEventListener("pointerup", up, true);
        doc.addEventListener("pointercancel", up, true);
    }

    function handleKeyDown(event: React.KeyboardEvent) {
        if (prompt) {
            if (event.key === "Enter") {
                event.preventDefault();
                props.onPromptConfirm?.();
            } else if (event.key === "Escape") {
                event.preventDefault();
                props.onPromptCancel?.();
            }
            return;
        }
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
        } else if (
            (event.key === "Delete" || event.key === "Backspace") &&
            props.onDeleteKey &&
            selected.size > 0
        ) {
            event.preventDefault();
            props.onDeleteKey(event.shiftKey);
        }
    }

    // Column widths as variables on the table, so a drag changes one place.
    const vars: Record<string, string> = {};
    for (const column of columns)
        vars[`--zotflow-evo-col-${column}`] = widthOf(column, widths) + "px";

    function cell(row: EvoItemRow, column: ColumnId) {
        if (column === "title") return <Title text={row.title} />;
        if (column === "attachment") {
            const kind = row.attachment ? KIND_ICON[row.attachment] : undefined;
            if (kind) {
                return (
                    <span
                        className={
                            "zotflow-evo-attachment" +
                            (row.attachment === "linked" ? " is-linked" : "")
                        }
                        title={kind.label}
                        onClick={(e) => {
                            e.stopPropagation();
                            props.onOpen(row);
                        }}
                    >
                        <Icon name={kind.icon} fallback={kind.fallback} />
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

    const promptIndex = prompt
        ? rows.findIndex((r) => r.key === prompt.key)
        : -1;

    return (
        <div className="zotflow-evo-table" style={vars} ref={tableRef}>
            <div className="zotflow-evo-thead" onContextMenu={columnMenu}>
                {columns.map((column, index) => {
                    const def = columnDef(column);
                    const sorted = sort.column === column;
                    // The last column's right edge is the table's.
                    const resizable = index < columns.length - 1;
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
                            {resizable && (
                                <span
                                    className="zotflow-evo-th-resize"
                                    onPointerDown={(e) =>
                                        startResize(column, e)
                                    }
                                    onClick={(e) => e.stopPropagation()}
                                />
                            )}
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
                        {prompt && promptIndex >= 0 && (
                            <div
                                className="zotflow-evo-prompt"
                                style={{ top: promptIndex * ROW_HEIGHT }}
                                role="alertdialog"
                                aria-label={prompt.text}
                                onClick={(e) => e.stopPropagation()}
                            >
                                <span className="zotflow-evo-prompt-text">
                                    {prompt.text}
                                </span>
                                <button
                                    className="mod-warning"
                                    onClick={() => props.onPromptConfirm?.()}
                                >
                                    {prompt.confirmLabel}
                                    <kbd>⏎</kbd>
                                </button>
                                <button
                                    onClick={() => props.onPromptCancel?.()}
                                >
                                    Cancel
                                    <kbd>Esc</kbd>
                                </button>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
