/**
 * ZotFlow Evo (fork): what the library browser, the collection tabs and the
 * annotation browser do — open tabs, items, source notes, searches — and
 * what a drag out of them carries. See FORK.md.
 */
import { Platform } from "obsidian";

import { workerBridge } from "bridge";
import { noteLocalEdit } from "services/evo-auto-sync";
import { services } from "services/services";
import { ZOTFLOW_CITATION_MIME } from "ui/editor/citation-helper";
import { ZOTFLOW_SOURCE_LINKS_MIME } from "ui/editor/evo-link-drop";
import { openItemPrimaryAttachment } from "ui/tree-view/evo-browser";
import { noteSearchTarget } from "ui/evo-library/attach-file";
import { selectionLabel } from "ui/evo-library/selection";
import { bookSearchUrl, plainTitle } from "utils/evo-library-model";
import { openAttachment } from "utils/viewer";
import { zoteroLibraryPrefix, zoteroSelectItemUri } from "utils/zotero-uri";

import type { App, WorkspaceLeaf } from "obsidian";
import type { SourceLinksPayload } from "ui/editor/evo-link-drop";
import type { ZotFlowCitationPayload } from "ui/editor/citation-helper";
import type { AnnotationJSON } from "types/zotero-reader";
import type { EvoScope } from "worker/services/evo-library";

export const LIBRARY_VIEW_TYPE = "zotflow-evo-library";
export const COLLECTION_VIEW_TYPE = "zotflow-evo-collection";
export const ANNOTATIONS_VIEW_TYPE = "zotflow-evo-annotations";
export const DETAILS_VIEW_TYPE = "zotflow-evo-details";
export const FULLTEXT_VIEW_TYPE = "zotflow-evo-fulltext";

/** Open the full-text search in a tab, searching in `scopes` (a library: collectionKey null). */
export async function openFulltextSearch(
    app: App,
    scopes: { libraryID: number; collectionKey: string | null }[],
): Promise<void> {
    if (!Platform.isDesktopApp) {
        services.notificationService.notify(
            "info",
            "Full-text search needs the desktop app (it reads Zotero's own index).",
        );
        return;
    }
    const leaf = app.workspace.getLeaf("tab");
    await leaf.setViewState({
        type: FULLTEXT_VIEW_TYPE,
        active: true,
        state: { scopes, query: "" },
    });
    await app.workspace.revealLeaf(leaf);
}

function inSidebar(app: App, leaf: WorkspaceLeaf): boolean {
    const root = leaf.getRoot();
    return (
        root === app.workspace.leftSplit || root === app.workspace.rightSplit
    );
}

/** Open the library browser in a tab, or show the one already open. */
export async function openLibraryBrowser(app: App): Promise<WorkspaceLeaf> {
    const { workspace } = app;
    const existing = workspace
        .getLeavesOfType(LIBRARY_VIEW_TYPE)
        .find((leaf) => !inSidebar(app, leaf));
    if (existing) {
        await workspace.revealLeaf(existing);
        workspace.setActiveLeaf(existing, { focus: true });
        return existing;
    }
    const leaf = workspace.getLeaf("tab");
    await leaf.setViewState({ type: LIBRARY_VIEW_TYPE, active: true });
    await workspace.revealLeaf(leaf);
    return leaf;
}

/**
 * Show an item in the library browser: in a collection (null: the whole
 * library), selected.
 */
export async function revealInLibrary(
    app: App,
    libraryID: number,
    collectionKey: string | null,
    itemKey: string,
): Promise<void> {
    const leaf = await openLibraryBrowser(app);
    const view = leaf.view as unknown as {
        reveal?: (
            libraryID: number,
            collectionKey: string | null,
            itemKey: string,
        ) => void;
    };
    view.reveal?.(libraryID, collectionKey, itemKey);
}

/** Open one collection in a tab of its own: its name and its items. */
export async function openCollectionTab(
    app: App,
    scope: EvoScope,
): Promise<void> {
    const leaf = app.workspace.getLeaf("tab");
    await leaf.setViewState({
        type: COLLECTION_VIEW_TYPE,
        active: true,
        state: { ...scope },
    });
    await app.workspace.revealLeaf(leaf);
}

/** Open the annotations of a collection (or a library) in a tab. */
export async function openAnnotationsTab(
    app: App,
    scope: EvoScope,
): Promise<void> {
    const leaf = app.workspace.getLeaf("tab");
    await leaf.setViewState({
        type: ANNOTATIONS_VIEW_TYPE,
        active: true,
        state: { ...scope },
    });
    await app.workspace.revealLeaf(leaf);
}

/**
 * Open the item details in a pane of their own, beside the active one; they
 * follow the item selected last in a library browser or collection tab.
 */
export async function openDetailsTab(app: App): Promise<void> {
    const { workspace } = app;
    const existing = workspace.getLeavesOfType(DETAILS_VIEW_TYPE)[0];
    if (existing) {
        await workspace.revealLeaf(existing);
        return;
    }
    const leaf = workspace.getLeaf("split", "vertical");
    await leaf.setViewState({ type: DETAILS_VIEW_TYPE, active: true });
    await workspace.revealLeaf(leaf);
}

/** Open what an item stands for: its PDF, else EPUB, else snapshot (see evo-browser.ts). */
export function openItem(app: App, libraryID: number, key: string): void {
    void openItemPrimaryAttachment(libraryID, key, app).catch((e: unknown) => {
        services.logService.error("Failed to open the item", "EvoLibrary", e);
    });
}

/** Open (creating it if needed) the item's source note. */
export function openSourceNote(libraryID: number, key: string): void {
    void workerBridge.libraryNote
        .openNote(libraryID, key, {
            forceUpdateContent: true,
            forceUpdateImages: false,
        })
        .catch((e: unknown) => {
            services.logService.error(
                "Failed to open the source note",
                "EvoLibrary",
                e,
            );
            services.notificationService.notify(
                "error",
                "Failed to open source note.",
            );
        });
}

/** Select the item in the Zotero app. */
export function showInZotero(libraryID: number, key: string): void {
    const prefix = zoteroLibraryPrefix(
        services.libraryCache.isGroup(libraryID),
        libraryID,
    );
    window.open(
        zoteroSelectItemUri(prefix, key),
        "_blank",
        "noopener,noreferrer",
    );
}

/** Open the document at an annotation. */
export function openAnnotation(
    app: App,
    libraryID: number,
    attachmentKey: string,
    annotationKey: string,
): void {
    void openAttachment(
        libraryID,
        attachmentKey,
        app,
        JSON.stringify({ annotationID: annotationKey }),
    ).catch((e: unknown) => {
        services.logService.error(
            "Failed to open the annotation",
            "EvoLibrary",
            e,
        );
    });
}

/* ------------------------------------------------------------------ */
/*  Searching for a file                                              */
/* ------------------------------------------------------------------ */

/** The leaf the last search was shown in, to show the next one there too. */
let searchLeaf: WorkspaceLeaf | null = null;

interface InternalPlugins {
    getEnabledPluginById?(id: string): unknown;
}

function webViewerEnabled(app: App): boolean {
    const internal = (app as unknown as { internalPlugins?: InternalPlugins })
        .internalPlugins;
    return !!internal?.getEnabledPluginById?.("webviewer");
}

/**
 * Search for an item's file (Anna's Archive by default) in Obsidian's web
 * viewer, in a pane beside `from`. Without the web viewer (turned off, or
 * on mobile) the search opens in the browser.
 */
export async function openBookSearch(
    app: App,
    from: WorkspaceLeaf,
    item: {
        title: string;
        firstCreator: string;
        year: string;
        libraryID?: number;
        key?: string;
    },
): Promise<void> {
    // "Save to the selected item" falls back to the item searched for.
    if (item.libraryID !== undefined && item.key)
        noteSearchTarget({
            libraryID: item.libraryID,
            key: item.key,
            label: selectionLabel(item),
        });
    const url = bookSearchUrl(services.settings.evoBookSearchUrl, item);
    if (!Platform.isDesktopApp || !webViewerEnabled(app)) {
        services.notificationService.notify(
            "info",
            "Opened in your browser. Turn on the Web viewer core plugin to search inside Obsidian.",
        );
        window.open(url, "_blank", "noopener,noreferrer");
        return;
    }
    const alive =
        searchLeaf &&
        searchLeaf.view?.getViewType() === "webviewer" &&
        app.workspace.getLeavesOfType("webviewer").includes(searchLeaf);
    const leaf = alive
        ? searchLeaf!
        : app.workspace.createLeafBySplit(from, "vertical");
    searchLeaf = leaf;
    await leaf.setViewState({
        type: "webviewer",
        active: true,
        state: { url, navigate: true },
    });
    await app.workspace.revealLeaf(leaf);
    if (!alive) setPaneWidth(leaf, SEARCH_PANE_WIDTH);
}

/** How wide the web viewer opens beside the browser, in pixels. */
const SEARCH_PANE_WIDTH = 640;

/** Obsidian's layout items as far as sizing goes (not in the public typings). */
interface SizedItem {
    parent?: SizedItem;
    children?: SizedItem[];
    containerEl?: HTMLElement;
    dimension?: number | null;
    setDimension?: (dimension: number | null) => void;
}

/**
 * Make a pane `px` wide: its tab group gets that share of the split it is
 * in, the others the rest in their proportions. Obsidian keeps the shares
 * (`dimension`) as flex weights; without `setDimension` (another Obsidian)
 * the weights go on the elements directly. Measured once the new pane is
 * laid out (right after the split it still has no width).
 */
export function setPaneWidth(
    leaf: WorkspaceLeaf,
    px: number,
    tries = 12,
): void {
    const attempt = () => {
        try {
            const tabs = (leaf as unknown as SizedItem).parent;
            const split = tabs?.parent;
            const total =
                split?.containerEl?.getBoundingClientRect().width ?? 0;
            if (!tabs || !split?.children) return;
            if (total < px + 200) {
                // Not laid out yet, or too narrow to give that much.
                if (total === 0 && tries > 0)
                    window.setTimeout(
                        () => setPaneWidth(leaf, px, tries - 1),
                        50,
                    );
                return;
            }
            const share = (px / total) * 100;
            const others = split.children.filter((c) => c !== tabs);
            const weights = others.map((c) => c.dimension || 1);
            const sum = weights.reduce((a, b) => a + b, 0) || 1;
            const assign = (item: SizedItem, value: number) => {
                if (typeof item.setDimension === "function")
                    item.setDimension(value);
                else if (item.containerEl)
                    item.containerEl.style.flexGrow = String(value);
            };
            others.forEach((c, i) =>
                assign(c, ((weights[i] ?? 1) / sum) * (100 - share)),
            );
            assign(tabs, share);
            leaf.view?.app?.workspace.requestSaveLayout();
            // If this Obsidian's setDimension() does not size the element,
            // set the weights on the elements as well.
            window.requestAnimationFrame(() => {
                const width =
                    tabs.containerEl?.getBoundingClientRect().width ?? px;
                if (Math.abs(width - px) < 40) return;
                others.forEach((c, i) => {
                    if (c.containerEl)
                        c.containerEl.style.flexGrow = String(
                            ((weights[i] ?? 1) / sum) * (100 - share),
                        );
                });
                if (tabs.containerEl)
                    tabs.containerEl.style.flexGrow = String(share);
            });
        } catch (e) {
            services.logService.warn(
                "Could not size the web viewer pane",
                "EvoLibrary",
                e,
            );
        }
    };
    window.requestAnimationFrame(() => window.requestAnimationFrame(attempt));
}

/* ------------------------------------------------------------------ */
/*  Drags                                                             */
/* ------------------------------------------------------------------ */

/** Items that have a source note: regular items, not standalone files or notes. */
function hasSourceNote(itemType: string): boolean {
    return itemType !== "attachment" && itemType !== "note";
}

/** A drag of items between tables and onto collections: `{ libraryID, keys }`. */
export const EVO_ITEMS_MIME = "application/x-zotflow-evo-items";
/** Marks the library a drag of items comes from (readable while dragging). */
const EVO_LIBRARY_MIME = "application/x-zotflow-evo-library-";

export interface DraggedItems {
    libraryID: number;
    keys: string[];
}

/**
 * A drag of items out of a table: dropped on a collection, they are added
 * to it (CollectionPane); dropped into a note, links to their source notes
 * (ui/editor/evo-link-drop.ts). Returns how many it carries.
 */
export function setItemsDrag(
    dataTransfer: DataTransfer,
    items: {
        libraryID: number;
        key: string;
        itemType: string;
        title: string;
    }[],
): number {
    if (!items.length) return 0;
    const libraryID = items[0]!.libraryID;
    const own = items.filter((i) => i.libraryID === libraryID);
    const carried: DraggedItems = { libraryID, keys: own.map((i) => i.key) };
    dataTransfer.effectAllowed = "copy";
    dataTransfer.setData(EVO_ITEMS_MIME, JSON.stringify(carried));
    dataTransfer.setData(EVO_LIBRARY_MIME + libraryID, "");
    const linked = items.filter((i) => hasSourceNote(i.itemType));
    if (linked.length) {
        const payload: SourceLinksPayload = {
            type: "zotflow-source-links",
            items: linked.map((i) => ({ libraryID: i.libraryID, key: i.key })),
        };
        dataTransfer.setData(
            ZOTFLOW_SOURCE_LINKS_MIME,
            JSON.stringify(payload),
        );
    }
    dataTransfer.setData(
        "text/plain",
        items.map((i) => plainTitle(i.title)).join("\n"),
    );
    return items.length;
}

/** The library the items being dragged come from, or null when it is no drag of items. */
export function draggedItemsLibrary(dataTransfer: DataTransfer): number | null {
    if (!Array.from(dataTransfer.types).includes(EVO_ITEMS_MIME)) return null;
    for (const type of Array.from(dataTransfer.types)) {
        if (type.startsWith(EVO_LIBRARY_MIME)) {
            const id = Number(type.slice(EVO_LIBRARY_MIME.length));
            if (Number.isFinite(id)) return id;
        }
    }
    return null;
}

/** The items a drop carries, if it is a drag of items. */
export function readDraggedItems(
    dataTransfer: DataTransfer,
): DraggedItems | null {
    try {
        const raw = dataTransfer.getData(EVO_ITEMS_MIME);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<DraggedItems>;
        if (typeof parsed.libraryID !== "number" || !Array.isArray(parsed.keys))
            return null;
        return {
            libraryID: parsed.libraryID,
            keys: parsed.keys.filter((k): k is string => typeof k === "string"),
        };
    } catch {
        return null;
    }
}

/* ------------------------------------------------------------------ */
/*  Edits                                                             */
/* ------------------------------------------------------------------ */

function editFailed(what: string, e: unknown) {
    services.logService.error(`Failed to ${what}`, "EvoLibrary", e);
    const message =
        e instanceof Error && e.message
            ? e.message
            : "See the log for details.";
    services.notificationService.notify(
        "error",
        `Couldn't ${what}. ${message}`,
    );
}

const items = (n: number) => (n === 1 ? "1 item" : `${n} items`);

/** Add items to a collection (dropped on it). */
export async function addItemsToCollection(
    libraryID: number,
    keys: string[],
    collectionKey: string,
    collectionName: string,
): Promise<void> {
    try {
        const result = await workerBridge.evoLibrary.addToCollection(
            libraryID,
            keys,
            collectionKey,
        );
        if (result.changed) noteLocalEdit(libraryID);
        services.notificationService.notify(
            "info",
            result.changed
                ? `Added ${items(result.changed)} to “${collectionName}”.`
                : `Already in “${collectionName}”.`,
        );
    } catch (e) {
        editFailed("add to the collection", e);
    }
}

/** Take items out of a collection (Delete, or the item menu). */
export async function removeItemsFromCollection(
    libraryID: number,
    keys: string[],
    collectionKey: string,
): Promise<void> {
    try {
        const result = await workerBridge.evoLibrary.removeFromCollection(
            libraryID,
            keys,
            collectionKey,
        );
        if (result.changed) noteLocalEdit(libraryID);
        if (result.skipped) {
            services.notificationService.notify(
                "info",
                `${items(result.skipped)} only in sub-collections, left there.`,
            );
        }
    } catch (e) {
        editFailed("remove from the collection", e);
    }
}

/** Move items to the trash (Shift+Delete, or the item menu). */
export async function trashItems(
    libraryID: number,
    keys: string[],
): Promise<void> {
    try {
        const result = await workerBridge.evoLibrary.trashItems(
            libraryID,
            keys,
        );
        if (result.changed) noteLocalEdit(libraryID);
    } catch (e) {
        editFailed("move to the trash", e);
    }
}

/** The fields of an annotation a drop needs. */
export interface DraggedAnnotation {
    id: string;
    libraryID: number;
    attachmentKey: string;
    type: string;
    text?: string;
    comment?: string;
    color?: string;
    pageLabel?: string;
}

/**
 * A drag of a highlight (or its comment) out of a card: dropped into a note
 * as from the reader, with the drop templates (ui/editor/evo-drop.ts).
 */
export function setAnnotationDrag(
    dataTransfer: DataTransfer,
    annotation: DraggedAnnotation,
    itemKey: string,
    source: "highlight" | "comment",
): void {
    const json = {
        id: annotation.id,
        libraryID: annotation.libraryID,
        parentItem: annotation.attachmentKey,
        type: annotation.type,
        text: annotation.text,
        comment: annotation.comment,
        color: annotation.color,
        pageLabel: annotation.pageLabel,
        tags: [],
        dateAdded: "",
        dateModified: "",
        position: { pageIndex: 0, rects: [] },
    } as unknown as AnnotationJSON;
    const payload: ZotFlowCitationPayload = {
        type: "zotflow-citation",
        libraryID: annotation.libraryID,
        key: itemKey,
        evoSource: source,
        annotations: [json],
    };
    dataTransfer.effectAllowed = "copy";
    dataTransfer.setData(ZOTFLOW_CITATION_MIME, JSON.stringify(payload));
    dataTransfer.setData(
        "text/plain",
        (source === "comment" ? annotation.comment : annotation.text) ?? "",
    );
}
