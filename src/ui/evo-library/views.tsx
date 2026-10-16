/**
 * ZotFlow Evo (fork): the Obsidian views of the library browser, a
 * collection tab and the annotation browser, and their registration. The
 * React parts are next to this file; the data comes from
 * `worker/services/evo-library.ts`. See FORK.md.
 */
import { ItemView } from "obsidian";
import React from "react";
import { createRoot } from "react-dom/client";

import {
    ANNOTATIONS_VIEW_TYPE,
    COLLECTION_VIEW_TYPE,
    DETAILS_VIEW_TYPE,
    LIBRARY_VIEW_TYPE,
} from "ui/evo-library/actions";
import { AnnotationBrowser } from "ui/evo-library/AnnotationBrowser";
import { CollectionTab } from "ui/evo-library/CollectionTab";
import { DetailsTab } from "ui/evo-library/ItemDetails";
import { LibraryBrowser } from "ui/evo-library/LibraryBrowser";
import {
    ANNOTATIONS_ICON,
    ANNOTATIONS_ICON_FALLBACK,
    iconOr,
} from "ui/evo-library/parts";

import type { Plugin, ViewStateResult, WorkspaceLeaf } from "obsidian";
import type { Root } from "react-dom/client";
import type {
    BrowserControl,
    BrowserTarget,
} from "ui/evo-library/LibraryBrowser";
import type { EvoScope } from "worker/services/evo-library";

/** The tab's title changed: Obsidian redraws the header (not in the public typings). */
function refreshHeader(leaf: WorkspaceLeaf) {
    (leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
}

function readScope(state: unknown): EvoScope | null {
    const s = state as Partial<EvoScope> | undefined;
    if (!s || typeof s.libraryID !== "number") return null;
    return {
        libraryID: s.libraryID,
        collectionKey:
            typeof s.collectionKey === "string" ? s.collectionKey : null,
        subcollections: !!s.subcollections,
    };
}

/**
 * The views have their own title and tools, so Obsidian's header above them
 * (title, back and forward, the more-options menu) is hidden — on desktop;
 * on a phone it holds the way back. See `zotflow-evo-headerless` in styles.css.
 */
const HEADERLESS = "zotflow-evo-headerless";

/** A view whose table has a filter field (the "filter" command). */
export interface FilterableView {
    focusFilter(): void;
}

/** The library browser: collections, table, details. */
export class EvoLibraryView extends ItemView implements FilterableView {
    private root: Root | null = null;
    private evoTarget: BrowserTarget | null = null;
    private control: { current: BrowserControl | null } = { current: null };

    focusFilter() {
        this.control.current?.focusFilter();
    }

    /** Show a library or collection (null: My Library). */
    goTo(target: BrowserTarget | null) {
        this.control.current?.goTo(target);
    }

    getViewType() {
        return LIBRARY_VIEW_TYPE;
    }

    getDisplayText() {
        return "Zotero library";
    }

    getIcon() {
        return "library-big";
    }

    getState(): Record<string, unknown> {
        return { ...super.getState(), ...(this.evoTarget ?? {}) };
    }

    async setState(state: unknown, result: ViewStateResult): Promise<void> {
        const s = state as Partial<BrowserTarget> | undefined;
        if (s && typeof s.libraryID === "number") {
            this.evoTarget = {
                libraryID: s.libraryID,
                collectionKey:
                    typeof s.collectionKey === "string"
                        ? s.collectionKey
                        : null,
            };
        }
        await super.setState(state, result);
        this.render();
    }

    private onTarget = (target: BrowserTarget) => {
        this.evoTarget = target;
        this.app.workspace.requestSaveLayout();
    };

    private render() {
        if (!this.root) return;
        this.root.render(
            <LibraryBrowser
                app={this.app}
                leaf={this.leaf}
                initial={this.evoTarget}
                onTarget={this.onTarget}
                control={this.control}
            />,
        );
    }

    async onOpen() {
        this.containerEl.addClass(HEADERLESS);
        this.contentEl.addClass("zotflow-evo-view");
        this.root = createRoot(this.contentEl);
        this.render();
    }

    async onClose() {
        this.root?.unmount();
        this.root = null;
    }
}

/** A view showing one scope (a collection tab, the annotation browser). */
abstract class ScopeView extends ItemView {
    protected root: Root | null = null;
    protected evoScope: EvoScope | null = null;
    protected evoName = "";

    getState(): Record<string, unknown> {
        return { ...super.getState(), ...(this.evoScope ?? {}) };
    }

    async setState(state: unknown, result: ViewStateResult): Promise<void> {
        this.evoScope = readScope(state) ?? this.evoScope;
        await super.setState(state, result);
        this.render();
    }

    protected onName = (name: string) => {
        if (name === this.evoName) return;
        this.evoName = name;
        refreshHeader(this.leaf);
    };

    protected onSubcollections = (on: boolean) => {
        if (!this.evoScope) return;
        this.evoScope = { ...this.evoScope, subcollections: on };
        this.app.workspace.requestSaveLayout();
        this.render();
    };

    protected abstract render(): void;

    async onOpen() {
        this.containerEl.addClass(HEADERLESS);
        this.contentEl.addClass("zotflow-evo-view");
        this.root = createRoot(this.contentEl);
        this.render();
    }

    async onClose() {
        this.root?.unmount();
        this.root = null;
    }
}

/** One collection in a tab of its own. */
export class EvoCollectionView extends ScopeView implements FilterableView {
    private control: { current: { focusFilter(): void } | null } = {
        current: null,
    };

    focusFilter() {
        this.control.current?.focusFilter();
    }

    getViewType() {
        return COLLECTION_VIEW_TYPE;
    }

    getDisplayText() {
        return this.evoName || "Zotero collection";
    }

    getIcon() {
        return "folder";
    }

    protected render() {
        if (!this.root || !this.evoScope) return;
        this.root.render(
            <CollectionTab
                key={`${this.evoScope.libraryID}:${this.evoScope.collectionKey}`}
                app={this.app}
                leaf={this.leaf}
                scope={this.evoScope}
                onName={this.onName}
                onSubcollections={this.onSubcollections}
                control={this.control}
            />,
        );
    }
}

/** Every annotation of a collection. */
export class EvoAnnotationsView extends ScopeView {
    getViewType() {
        return ANNOTATIONS_VIEW_TYPE;
    }

    getDisplayText() {
        return this.evoName
            ? `Annotations: ${this.evoName}`
            : "Zotero annotations";
    }

    getIcon() {
        return iconOr(ANNOTATIONS_ICON, ANNOTATIONS_ICON_FALLBACK);
    }

    protected render() {
        if (!this.root || !this.evoScope) return;
        this.root.render(
            <AnnotationBrowser
                key={`${this.evoScope.libraryID}:${this.evoScope.collectionKey}`}
                app={this.app}
                scope={this.evoScope}
                onName={this.onName}
                onSubcollections={this.onSubcollections}
            />,
        );
    }
}

/** The selected item in a pane of its own (it follows the last library tab used). */
export class EvoDetailsView extends ItemView {
    private root: Root | null = null;

    getViewType() {
        return DETAILS_VIEW_TYPE;
    }

    getDisplayText() {
        return "Zotero item";
    }

    getIcon() {
        return "panel-right";
    }

    async onOpen() {
        this.containerEl.addClass(HEADERLESS);
        this.contentEl.addClass("zotflow-evo-view");
        this.root = createRoot(this.contentEl);
        this.root.render(<DetailsTab app={this.app} leaf={this.leaf} />);
    }

    async onClose() {
        this.root?.unmount();
        this.root = null;
    }
}

/**
 * Register the views. The command that opens the library browser is the
 * fork's "Open Zotero library in a tab" (ui/evo-workspace.ts).
 */
export function registerEvoLibrary(plugin: Plugin) {
    plugin.registerView(LIBRARY_VIEW_TYPE, (leaf) => new EvoLibraryView(leaf));
    plugin.registerView(
        COLLECTION_VIEW_TYPE,
        (leaf) => new EvoCollectionView(leaf),
    );
    plugin.registerView(
        ANNOTATIONS_VIEW_TYPE,
        (leaf) => new EvoAnnotationsView(leaf),
    );
    plugin.registerView(DETAILS_VIEW_TYPE, (leaf) => new EvoDetailsView(leaf));
}
