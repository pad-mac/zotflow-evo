/**
 * ZotFlow Evo (fork): what the library browser, the collection tabs and the
 * annotation browser do — open tabs, items, source notes, searches — and
 * what a drag out of them carries. See FORK.md.
 */
import { Platform } from "obsidian";

import { workerBridge } from "bridge";
import { services } from "services/services";
import { ZOTFLOW_CITATION_MIME } from "ui/editor/citation-helper";
import { ZOTFLOW_SOURCE_LINKS_MIME } from "ui/editor/evo-link-drop";
import { openItemPrimaryAttachment } from "ui/tree-view/evo-browser";
import { bookSearchUrl } from "utils/evo-library-model";
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

function inSidebar(app: App, leaf: WorkspaceLeaf): boolean {
    const root = leaf.getRoot();
    return (
        root === app.workspace.leftSplit || root === app.workspace.rightSplit
    );
}

/** Open the library browser in a tab, or show the one already open. */
export async function openLibraryBrowser(app: App): Promise<void> {
    const { workspace } = app;
    const existing = workspace
        .getLeavesOfType(LIBRARY_VIEW_TYPE)
        .find((leaf) => !inSidebar(app, leaf));
    if (existing) {
        await workspace.revealLeaf(existing);
        workspace.setActiveLeaf(existing, { focus: true });
        return;
    }
    const leaf = workspace.getLeaf("tab");
    await leaf.setViewState({ type: LIBRARY_VIEW_TYPE, active: true });
    await workspace.revealLeaf(leaf);
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
    item: { title: string; firstCreator: string; year: string },
): Promise<void> {
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
}

/* ------------------------------------------------------------------ */
/*  Drags                                                             */
/* ------------------------------------------------------------------ */

/** Items that have a source note: regular items, not standalone files or notes. */
function hasSourceNote(itemType: string): boolean {
    return itemType !== "attachment" && itemType !== "note";
}

/**
 * A drag of items out of a table: dropped into a note as links to their
 * source notes (ui/editor/evo-link-drop.ts). Returns how many it carries.
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
    const linked = items.filter((i) => hasSourceNote(i.itemType));
    if (!linked.length) return 0;
    const payload: SourceLinksPayload = {
        type: "zotflow-source-links",
        items: linked.map((i) => ({ libraryID: i.libraryID, key: i.key })),
    };
    dataTransfer.effectAllowed = "copy";
    dataTransfer.setData(ZOTFLOW_SOURCE_LINKS_MIME, JSON.stringify(payload));
    dataTransfer.setData("text/plain", linked.map((i) => i.title).join("\n"));
    return linked.length;
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
