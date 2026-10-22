/**
 * ZotFlow Evo (fork): the annotation strip tab — the reader's note strip on
 * its own, for the item of the line being written in another pane
 * (`follow.ts`). It is a reader view (`ZoteroReaderView`) whose reader shows
 * only the strip: the same entries, editing, colours and drags as beside a
 * PDF; in its head only the colour filters and the highlights button. The
 * document stays loaded, out of sight. See FORK.md, "Annotation strip tab".
 */
import { Menu } from "obsidian";

import { workerBridge } from "bridge";
import { services } from "services/services";
import { revealInLibrary } from "ui/evo-library/actions";
import { connectStripOnly, showMenuOverFrame } from "ui/reader/chrome";
import { ZoteroReaderView } from "ui/reader/view";
import {
    attachmentKind,
    choosePrimaryAttachment,
} from "utils/evo-library-model";
import { openAttachment, openSourceNote } from "utils/viewer";

import type { WorkspaceLeaf } from "obsidian";
import type { AttachmentData, ZoteroItemData } from "types/zotero-item";
import type { IDBZoteroItem } from "types/db-schema";
import type { IframeReaderBridge } from "ui/reader/bridge";

export const EVO_STRIP_VIEW_TYPE = "zotflow-evo-strip";

/** What the strip is about: an item (not its attachment). */
export interface StripSubject {
    libraryID: number;
    key: string;
}

type Attachment = IDBZoteroItem<AttachmentData>;

const kindOf = (a: Attachment) =>
    attachmentKind({
        contentType: a.raw?.data?.contentType,
        linkMode: a.raw?.data?.linkMode,
    });

/**
 * The attachment whose annotations the strip shows: the one a double click
 * opens, else the first of the best kind; the item itself if it is the
 * file. Null with the reason when there is none the strip can show.
 */
async function stripAttachment(
    subject: StripSubject,
): Promise<{ attachment: Attachment | null; why: string; title: string }> {
    const item = (await workerBridge.dbHelper.getItem(
        subject.libraryID,
        subject.key,
    )) as IDBZoteroItem<ZoteroItemData> | null | undefined;
    const title =
        (item?.raw?.data as { title?: string } | undefined)?.title ||
        item?.title ||
        "this item";
    if (!item) return { attachment: null, why: "The item is not here.", title };
    let attachment: Attachment | null = null;
    if (item.itemType === "attachment") {
        attachment = item as unknown as Attachment;
    } else {
        const attachments = (await workerBridge.dbHelper.getAttachments(
            subject.libraryID,
            subject.key,
        )) as Attachment[];
        const { primary, choices } = choosePrimaryAttachment(
            attachments,
            kindOf,
        );
        attachment =
            primary ??
            choices[0] ??
            // Only a linked file: say so (below), not "No file".
            attachments.find((a) => kindOf(a) === "linked") ??
            null;
    }
    if (!attachment) return { attachment: null, why: "No file.", title };
    const kind = kindOf(attachment);
    if (kind === "linked")
        return {
            attachment: null,
            why: "A linked file, stored outside Zotero's storage: ZotFlow can't open it yet. Open it in Zotero.",
            title,
        };
    if (kind !== "pdf" && kind !== "snapshot")
        return {
            attachment: null,
            why: "The strip is for PDFs and snapshots; this item's file is not one.",
            title,
        };
    return { attachment, why: "", title };
}

export class EvoStripView extends ZoteroReaderView {
    /** The item shown (or being opened), whatever its attachment. */
    private subject: StripSubject | null = null;
    private subjectTitle = "";
    /** Bumped with every new subject, so a slow lookup does not overwrite a later one. */
    private run = 0;
    private offStrip?: () => void;

    constructor(leaf: WorkspaceLeaf) {
        super(leaf);
    }

    protected override evoStripOnly(): boolean {
        return true;
    }

    override getViewType() {
        return EVO_STRIP_VIEW_TYPE;
    }

    override getIcon() {
        return "highlighter";
    }

    override getDisplayText() {
        return this.subjectTitle
            ? `Annotations: ${this.subjectTitle}`
            : "Annotations";
    }

    override async onOpen() {
        if (!this.evoAttachment) this.showMessage();
    }

    override async onClose() {
        this.offStrip?.();
        this.offStrip = undefined;
        await super.onClose();
    }

    /** The item this strip shows, if any. */
    get shown(): StripSubject | null {
        return this.subject;
    }

    /**
     * Show the annotations of `subject` (an item: its attachment is found
     * here). The same item again does nothing.
     */
    async follow(subject: StripSubject): Promise<void> {
        if (
            this.subject?.libraryID === subject.libraryID &&
            this.subject.key === subject.key
        )
            return;
        this.subject = subject;
        const run = ++this.run;
        try {
            const { attachment, why, title } = await stripAttachment(subject);
            if (run !== this.run) return;
            this.subjectTitle = title.replace(/<[^>]+>/g, "");
            this.updateTitle();
            if (!attachment) {
                await this.evoCloseDocument();
                if (run === this.run) this.showMessage(why);
                return;
            }
            const current = this.evoAttachment;
            if (
                current?.libraryID === attachment.libraryID &&
                current.key === attachment.key
            )
                return;
            await this.setState(
                { libraryID: attachment.libraryID, itemKey: attachment.key },
                { history: false },
            );
            // The reader view names its tab after the file; this one after the item.
            this.updateTitle();
            this.app.workspace.requestSaveLayout();
        } catch (e) {
            services.logService.error(
                "The annotation strip could not show the item",
                "EvoStrip",
                e,
            );
            if (run === this.run) this.showMessage("Could not show the item.");
        }
    }

    private updateTitle() {
        const title = this.getDisplayText();
        this.containerEl
            .getElementsByClassName("view-header-title")[0]
            ?.setText(title);
        (
            this.leaf as WorkspaceLeaf & { updateHeader?: () => void }
        ).updateHeader?.();
    }

    private showMessage(text?: string) {
        const el = this.contentEl;
        el.empty();
        const box = el.createDiv({ cls: "zotflow-evo-strip-empty" });
        box.createDiv({
            text:
                text ??
                "Put the cursor on a line with a link to a source note: its annotations show here.",
        });
    }

    protected override evoReaderOpened(bridge: IframeReaderBridge): void {
        this.offStrip?.();
        this.offStrip = connectStripOnly(this, bridge, {
            onOpen: (location) => {
                const a = this.evoAttachment;
                if (!a) return;
                void openAttachment(
                    a.libraryID,
                    a.key,
                    this.app,
                    JSON.stringify(location),
                );
            },
            onTitleMenu: (at) => this.showTitleMenu(at),
        });
    }

    /** Right-click on the strip's title: the source note, the item in the library, the file. */
    private showTitleMenu(at: { x: number; y: number }) {
        const a = this.evoAttachment;
        if (!a) return;
        const itemKey = a.parentItem || a.key;
        const menu = new Menu();
        const note = services.indexService.getFileByKey(itemKey);
        if (note) {
            menu.addItem((item) =>
                item
                    .setTitle("Open source note")
                    .setIcon("notebook-text")
                    .onClick(() => void openSourceNote(note, this.app)),
            );
        }
        menu.addItem((item) =>
            item
                .setTitle("Open in reader")
                .setIcon("book-open")
                .onClick(
                    () => void openAttachment(a.libraryID, a.key, this.app),
                ),
        );
        menu.addItem((item) =>
            item
                .setTitle("Open in library")
                .setIcon("library-big")
                .onClick(
                    () =>
                        void revealInLibrary(
                            this.app,
                            a.libraryID,
                            null,
                            itemKey,
                        ),
                ),
        );
        showMenuOverFrame(menu, at, this.containerEl.ownerDocument);
    }
}
