/**
 * ZotFlow Evo (fork): a library table inside a note — the middle table of
 * the collection browser, in a `zotflow-items` code block:
 *
 *     ```zotflow-items
 *     collection: 12345/ABCD1234
 *     subcollections: true
 *     ```
 *
 *     ```zotflow-items
 *     author:
 *     ```
 *
 * `collection: <libraryID>/<collectionKey>` (or `<libraryID>` alone for the
 * whole library), what the "Insert library table: collection" command
 * writes (with the collection's path after a `#`, for reading). `author:`
 * lists the items a person is a creator of, in any role and in every
 * library: the name given, or with none the note's own name — for a
 * template of person notes. The table works as in a collection tab:
 * select, Shift/Ctrl+click, arrows, double click opens, right-click menu,
 * Delete asks to remove or trash, columns and sorting (shared with the
 * collection tabs), drag rows into notes or collections. See FORK.md.
 */
import { FuzzySuggestModal, MarkdownRenderChild, MarkdownView } from "obsidian";
import React, { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { workerBridge } from "bridge";
import { services } from "services/services";
import {
    openBookSearch,
    openItem,
    setItemsDrag,
} from "ui/evo-library/actions";
import { ItemTable } from "ui/evo-library/ItemTable";
import { showItemMenu } from "ui/evo-library/menus";
import {
    useRowEditing,
    useScopeRows,
    useSelection,
    useTableSettings,
} from "ui/evo-library/useItems";

import type { App, MarkdownPostProcessorContext, Plugin } from "obsidian";
import type { Root } from "react-dom/client";
import type { EvoItemRow } from "utils/evo-library-model";
import type {
    EvoCollectionNode,
    EvoLibraryNode,
    EvoScope,
} from "worker/services/evo-library";

export const ITEMS_BLOCK = "zotflow-items";

/** What a block asks for. */
export type ItemsBlockSpec =
    | {
          kind: "collection";
          libraryID: number;
          collectionKey: string | null;
          subcollections: boolean;
      }
    | { kind: "author"; name: string | null };

/** A block's text → what it shows; a message for what cannot be read. */
export function parseItemsBlock(
    source: string,
): ItemsBlockSpec | { error: string } {
    const lines = new Map<string, string>();
    for (const raw of source.split(/\r?\n/)) {
        const line = raw.replace(/\s+#.*$/, "").trim();
        if (!line || line.startsWith("#")) continue;
        const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
        if (m) lines.set(m[1]!.toLowerCase(), m[2]!.trim());
    }
    if (lines.has("author")) {
        const name = lines.get("author") ?? "";
        return { kind: "author", name: name || null };
    }
    const target = lines.get("collection");
    if (target !== undefined) {
        const m = /^(\d+)(?:\/([A-Z0-9]{8}))?$/.exec(target);
        if (!m)
            return {
                error: `"collection: ${target}" is not a library and collection (12345/ABCD1234).`,
            };
        const sub = (lines.get("subcollections") ?? "").toLowerCase();
        return {
            kind: "collection",
            libraryID: Number(m[1]),
            collectionKey: m[2] ?? null,
            subcollections: sub === "true" || sub === "yes",
        };
    }
    return {
        error: "This block needs “collection: <library>/<collection>” or “author:”.",
    };
}

/** The scope a block lists, with the note's name for an author block without one. */
function scopeOf(spec: ItemsBlockSpec, noteName: string): EvoScope {
    if (spec.kind === "author")
        return {
            libraryID: 0,
            collectionKey: null,
            subcollections: false,
            creator: spec.name ?? noteName,
        };
    return {
        libraryID: spec.libraryID,
        collectionKey: spec.collectionKey,
        subcollections: spec.subcollections,
    };
}

/** Tallest the table gets before it scrolls, in pixels. */
const MAX_HEIGHT = 420;
const ROW = 26;

export function EmbeddedItems({
    app,
    scope,
    label,
}: {
    app: App;
    scope: EvoScope;
    label: string;
}) {
    const [filter, setFilter] = useState("");
    const bodyRef = useRef<HTMLDivElement>(null);
    const stableScope = useMemo(() => scope, [scope]);
    const { rows, loading } = useScopeRows(stableScope);
    const table = useTableSettings("collection");
    const sel = useSelection(rows, filter, table.sort);
    const editing = useRowEditing(stableScope, sel, bodyRef);
    const leaf = () =>
        app.workspace.getActiveViewOfType(MarkdownView)?.leaf ??
        app.workspace.getLeaf(false);

    const dragRows = (row: EvoItemRow, event: React.DragEvent) => {
        const items =
            sel.selected.has(row.key) && sel.selectedRows.length > 1
                ? sel.selectedRows
                : [row];
        if (!setItemsDrag(event.dataTransfer, items)) event.preventDefault();
    };
    // As tall as its rows (the header and one row at least), up to MAX_HEIGHT.
    const height = Math.min(
        MAX_HEIGHT,
        ROW * (Math.max(1, sel.shown.length) + 1) + 4,
    );

    return (
        <div className="zotflow-evo-view zotflow-evo-items-block">
            <div className="zotflow-evo-toolbar">
                <span className="zotflow-evo-items-block-label" title={label}>
                    {label}
                </span>
                <input
                    className="zotflow-evo-filter"
                    type="search"
                    placeholder="Filter"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    onKeyDown={(e) => {
                        e.stopPropagation();
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
            </div>
            <div
                className="zotflow-evo-items-block-table"
                style={{ height }}
                // Keys stay in the table, not the editor around it.
                onKeyDown={(e) => e.stopPropagation()}
            >
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
                        showItemMenu(app, leaf(), row, e.nativeEvent, {
                            onRemove:
                                scope.creator === undefined &&
                                scope.collectionKey !== null
                                    ? () => editing.ask(false)
                                    : undefined,
                            onTrash: () => editing.ask(true),
                        });
                    }}
                    onDragRows={dragRows}
                    onSearch={(row) => void openBookSearch(app, leaf(), row)}
                    onDeleteKey={editing.ask}
                    onPromptConfirm={editing.confirm}
                    onPromptCancel={editing.cancel}
                />
            </div>
        </div>
    );
}

/** A collection's path ("My Library / Media theory / Kittler") by library and key. */
async function collectionPath(
    libraryID: number,
    collectionKey: string | null,
): Promise<string> {
    const libraries = await workerBridge.evoLibrary.getCollectionTree();
    const lib = libraries.find((l) => l.libraryID === libraryID);
    if (!lib) return "A library that is not here";
    if (!collectionKey) return lib.name;
    let found = "";
    const walk = (nodes: EvoCollectionNode[], prefix: string) => {
        for (const n of nodes) {
            const path = `${prefix} / ${n.name}`;
            if (n.key === collectionKey) found = path;
            walk(n.children, path);
        }
    };
    walk(lib.collections, lib.name);
    return found || "A collection that is not here";
}

class ItemsBlockChild extends MarkdownRenderChild {
    private root: Root | null = null;

    constructor(
        containerEl: HTMLElement,
        private readonly app: App,
        private readonly source: string,
        private readonly sourcePath: string,
    ) {
        super(containerEl);
    }

    onload() {
        const spec = parseItemsBlock(this.source);
        if ("error" in spec) {
            this.containerEl.createDiv({
                cls: "zotflow-evo-items-block-error",
                text: spec.error,
            });
            return;
        }
        const noteName =
            this.sourcePath.split("/").pop()?.replace(/\.md$/i, "") ?? "";
        const scope = scopeOf(spec, noteName);
        this.root = createRoot(this.containerEl);
        const render = (label: string) =>
            this.root?.render(
                <EmbeddedItems app={this.app} scope={scope} label={label} />,
            );
        if (spec.kind === "author") {
            render(`By ${scope.creator ?? ""}`);
        } else {
            render("");
            void collectionPath(spec.libraryID, spec.collectionKey)
                .then((path) =>
                    render(spec.subcollections ? `${path} (with sub-collections)` : path),
                )
                .catch(() => render(""));
        }
    }

    onunload() {
        this.root?.unmount();
        this.root = null;
    }
}

interface CollectionChoice {
    libraryID: number;
    collectionKey: string | null;
    path: string;
}

function collectionChoices(libraries: EvoLibraryNode[]): CollectionChoice[] {
    const out: CollectionChoice[] = [];
    for (const lib of libraries) {
        out.push({ libraryID: lib.libraryID, collectionKey: null, path: lib.name });
        const walk = (nodes: EvoCollectionNode[], prefix: string) => {
            for (const n of nodes) {
                const path = `${prefix} / ${n.name}`;
                out.push({ libraryID: n.libraryID, collectionKey: n.key, path });
                walk(n.children, path);
            }
        };
        walk(lib.collections, lib.name);
    }
    return out;
}

class CollectionPickModal extends FuzzySuggestModal<CollectionChoice> {
    constructor(
        app: App,
        private readonly items: CollectionChoice[],
        private readonly onChoose: (choice: CollectionChoice) => void,
    ) {
        super(app);
        this.setPlaceholder("A library or collection to show in this note");
    }
    getItems() {
        return this.items;
    }
    getItemText(item: CollectionChoice) {
        return item.path;
    }
    onChooseItem(item: CollectionChoice) {
        this.onChoose(item);
    }
}

/** The block for a collection, as the insert command writes it. */
export function collectionBlock(choice: CollectionChoice): string {
    const target =
        choice.collectionKey === null
            ? String(choice.libraryID)
            : `${choice.libraryID}/${choice.collectionKey}`;
    return [
        "```" + ITEMS_BLOCK,
        `collection: ${target}  # ${choice.path.replace(/\n/g, " ")}`,
        "subcollections: false",
        "```",
        "",
    ].join("\n");
}

export const AUTHOR_BLOCK = ["```" + ITEMS_BLOCK, "author:", "```", ""].join("\n");

export function registerItemsBlock(plugin: Plugin) {
    plugin.registerMarkdownCodeBlockProcessor(
        ITEMS_BLOCK,
        (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
            ctx.addChild(
                new ItemsBlockChild(el, plugin.app, source, ctx.sourcePath),
            );
        },
    );
    plugin.addCommand({
        id: "evo-insert-collection-table",
        name: "Insert library table: a collection",
        editorCallback: (editor) => {
            void workerBridge.evoLibrary
                .getCollectionTree()
                .then((libraries) => {
                    new CollectionPickModal(
                        plugin.app,
                        collectionChoices(libraries),
                        (choice) => editor.replaceSelection(collectionBlock(choice)),
                    ).open();
                })
                .catch((e: unknown) => {
                    services.logService.error(
                        "Failed to read the collections",
                        "EvoLibrary",
                        e,
                    );
                    services.notificationService.notify(
                        "error",
                        "Couldn't read the collections.",
                    );
                });
        },
    });
    plugin.addCommand({
        id: "evo-insert-author-table",
        name: "Insert library table: this person's items (note name)",
        editorCallback: (editor) => editor.replaceSelection(AUTHOR_BLOCK),
    });
}
