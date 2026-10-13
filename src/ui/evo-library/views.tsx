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
    LIBRARY_VIEW_TYPE,
} from "ui/evo-library/actions";
import { AnnotationBrowser } from "ui/evo-library/AnnotationBrowser";
import { CollectionTab } from "ui/evo-library/CollectionTab";
import { LibraryBrowser } from "ui/evo-library/LibraryBrowser";

import type { Plugin, ViewStateResult, WorkspaceLeaf } from "obsidian";
import type { Root } from "react-dom/client";
import type { BrowserTarget } from "ui/evo-library/LibraryBrowser";
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

/** The library browser: collections, table, details. */
export class EvoLibraryView extends ItemView {
    private root: Root | null = null;
    private evoTarget: BrowserTarget | null = null;

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
            />,
        );
    }

    async onOpen() {
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
export class EvoCollectionView extends ScopeView {
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
        return "highlighter";
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
}
