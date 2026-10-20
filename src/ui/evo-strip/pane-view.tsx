/**
 * ZotFlow Evo (fork): the annotation strip tab drawn as the library's item
 * pane (setting `evoStripTabMode: "item-pane"`) — the item of the line being
 * written (`follow.ts`), its files, abstract and annotations with the colour
 * filter. Nothing is loaded but the item from the database, so it follows
 * at once; there is no editing (a click on an annotation opens it in the
 * reader). See FORK.md, "Annotation strip tab".
 */
import { ItemView } from "obsidian";
import React from "react";
import { createRoot } from "react-dom/client";

import { revealInLibrary } from "ui/evo-library/actions";
import { ItemDetails, useItemDetails } from "ui/evo-library/ItemDetails";

import type { App, ViewStateResult, WorkspaceLeaf } from "obsidian";
import type { Root } from "react-dom/client";
import type { StripSubject } from "ui/evo-strip/strip-view";

export const EVO_STRIP_PANE_VIEW_TYPE = "zotflow-evo-strip-pane";

function StripPane({
    app,
    leaf,
    subject,
}: {
    app: App;
    leaf: WorkspaceLeaf;
    subject: StripSubject | null;
}) {
    const details = useItemDetails(subject);
    return (
        <div className="zotflow-evo-strip-pane">
            <ItemDetails
                app={app}
                leaf={leaf}
                details={subject ? details : null}
                count={subject ? 1 : 0}
                emptyText="Put the cursor on a line with a link to a source note: its item shows here."
                onShowInCollection={(libraryID, collectionKey, itemKey) =>
                    void revealInLibrary(app, libraryID, collectionKey, itemKey)
                }
            />
        </div>
    );
}

export class EvoStripPaneView extends ItemView {
    private root: Root | null = null;
    private subject: StripSubject | null = null;

    constructor(leaf: WorkspaceLeaf) {
        super(leaf);
    }

    getViewType() {
        return EVO_STRIP_PANE_VIEW_TYPE;
    }

    getDisplayText() {
        return "Annotations";
    }

    getIcon() {
        return "highlighter";
    }

    /** The item shown, if any. */
    get shown(): StripSubject | null {
        return this.subject;
    }

    getState(): Record<string, unknown> {
        return { ...super.getState(), subject: this.subject };
    }

    async setState(state: unknown, result: ViewStateResult): Promise<void> {
        const s = (state as { subject?: Partial<StripSubject> } | undefined)
            ?.subject;
        if (s && typeof s.libraryID === "number" && typeof s.key === "string")
            this.subject = { libraryID: s.libraryID, key: s.key };
        await super.setState(state, result);
        this.render();
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

    /** Show `subject` (the same item again does nothing). */
    async follow(subject: StripSubject): Promise<void> {
        if (
            this.subject?.libraryID === subject.libraryID &&
            this.subject.key === subject.key
        )
            return;
        this.subject = subject;
        this.render();
        this.app.workspace.requestSaveLayout();
    }

    private render() {
        this.root?.render(
            <StripPane
                app={this.app}
                leaf={this.leaf}
                subject={this.subject}
            />,
        );
    }
}
