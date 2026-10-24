/**
 * ZotFlow Evo (fork): a book section made from a PDF's outline heading —
 * from its right-click menu in the item pane and in the reader's note
 * strip, or the reader's command. A small panel at the heading (it stays
 * while the rest is clicked and scrolled) takes the title (the heading's),
 * the authors (the book's) and the pages (as the PDF numbers them: from the
 * heading's page to the page before the next heading of its level).
 *
 * Made: the pages as a PDF of their own; a book section item with the
 * book's data (utils/evo-book-section.ts) and that PDF; the annotations on
 * those pages copied to it, and — the setting "Remove the annotations from
 * the book's PDF", on by default — taken off the book's PDF. The item, the
 * PDF and the annotations are made with Zotero's web API; a sync brings
 * them here. See FORK.md, "Book sections".
 */
import { Menu } from "obsidian";
import { PDFDocument } from "pdf-lib";

import { workerBridge } from "bridge";
import { noteLocalEdit } from "services/evo-auto-sync";
import { services } from "services/services";
import {
    attachRefusal,
    createItems,
    uploadAttachmentWithKey,
} from "ui/evo-library/attach-file";
import { showMenuOverFrame } from "ui/reader/chrome";
import { startSync } from "ui/start-sync";
import {
    defaultAuthors,
    labelRuns,
    pageLabelOf,
    pageOfLabel,
    pagesField,
    parseAuthors,
    sectionItem,
    sectionPages,
} from "utils/evo-book-section";
import { extractYear } from "utils/date";
import { readPageLabels, writeLabelRuns } from "utils/evo-pdf-labels";
import { extractPages } from "utils/evo-pdf-rewrite";

import type { SectionContext } from "utils/evo-book-section";

/** The PDF a section is cut from, and its outline. */
export interface BookSectionSource {
    libraryID: number;
    /** The book's PDF (an attachment of the book). */
    attachmentKey: string;
    context: SectionContext;
}

/** Where on the screen (client coordinates of `doc`'s window). */
export interface ScreenPoint {
    x: number;
    y: number;
}

/**
 * The right-click menu of an outline heading. `overFrame`: at a point of
 * the reader's frame (see showMenuOverFrame()).
 */
export function showHeadingMenu(
    source: BookSectionSource,
    at: ScreenPoint,
    doc: Document = activeDocument,
    overFrame = false,
): void {
    const menu = new Menu();
    menu.addItem((item) =>
        item
            .setTitle("Create book section…")
            .setIcon("book-plus")
            .onClick(() => openBookSectionPanel(source, at, doc)),
    );
    if (overFrame) showMenuOverFrame(menu, at, doc);
    else menu.showAtPosition(at, doc);
}

/** The one panel open (a new one takes its place). */
let current: BookSectionPanel | null = null;

/** Open the panel for a heading's section (or, without one, for the pages given). */
export function openBookSectionPanel(
    source: BookSectionSource,
    at: ScreenPoint,
    doc: Document = activeDocument,
    pages?: { first: number; last: number },
): void {
    current?.close();
    current = new BookSectionPanel(source, at, doc, pages);
}

/** Sections being made (one at a time per PDF). */
const busy = new Set<string>();

class BookSectionPanel {
    private readonly el: HTMLElement;
    private readonly title: HTMLInputElement;
    private readonly authors: HTMLInputElement;
    private readonly from: HTMLInputElement;
    private readonly to: HTMLInputElement;
    private readonly info: HTMLElement;
    private readonly create: HTMLButtonElement;
    private infoTimer: number | null = null;
    private infoRun = 0;
    private closed = false;

    constructor(
        private readonly source: BookSectionSource,
        at: ScreenPoint,
        private readonly doc: Document,
        pages?: { first: number; last: number },
    ) {
        const { context } = source;
        const heading =
            context.index !== null ? context.headings[context.index] : undefined;
        const range =
            pages ??
            (context.index !== null && heading
                ? sectionPages(context.headings, context.index, context.pageCount)
                : { first: 0, last: 0 });

        const el = doc.body.createDiv({ cls: "zotflow-evo-section-panel" });
        el.setAttribute("role", "dialog");
        el.setAttribute("aria-label", "New book section");
        this.el = el;
        const head = el.createDiv({ cls: "zotflow-evo-section-panel-head" });
        head.createSpan({
            cls: "zotflow-evo-section-panel-heading",
            text: "New book section",
        });
        const close = head.createSpan({
            cls: "zotflow-evo-section-panel-close clickable-icon",
            attr: { "aria-label": "Close", role: "button" },
        });
        close.setText("×");
        close.addEventListener("click", () => this.close());

        const field = (label: string) => {
            const row = el.createDiv({ cls: "zotflow-evo-section-panel-row" });
            row.createDiv({ cls: "zotflow-evo-section-panel-label", text: label });
            return row;
        };
        this.title = field("Title").createEl("input", {
            type: "text",
            cls: "zotflow-evo-section-panel-input",
            value: heading?.title ?? "",
        });
        this.authors = field("Authors").createEl("input", {
            type: "text",
            cls: "zotflow-evo-section-panel-input",
            attr: { placeholder: "First Last; First Last" },
        });
        const pagesRow = field("Pages").createDiv({
            cls: "zotflow-evo-section-panel-pages",
        });
        this.from = pagesRow.createEl("input", {
            type: "text",
            cls: "zotflow-evo-section-panel-page",
            value: pageLabelOf(range.first, context.pageLabels),
        });
        pagesRow.createSpan({ text: "–" });
        this.to = pagesRow.createEl("input", {
            type: "text",
            cls: "zotflow-evo-section-panel-page",
            value: pageLabelOf(range.last, context.pageLabels),
        });
        this.info = el.createDiv({ cls: "zotflow-evo-section-panel-info" });
        const buttons = el.createDiv({ cls: "zotflow-evo-section-panel-buttons" });
        const cancel = buttons.createEl("button", { text: "Cancel" });
        cancel.addEventListener("click", () => this.close());
        this.create = buttons.createEl("button", {
            text: "Create",
            cls: "mod-cta",
        });
        this.create.addEventListener("click", () => void this.submit());

        for (const input of [this.from, this.to])
            input.addEventListener("input", () => this.scheduleInfo());
        el.addEventListener("keydown", (e) => {
            if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                this.close();
            } else if (
                e.key === "Enter" &&
                e.target instanceof HTMLInputElement
            ) {
                e.preventDefault();
                void this.submit();
            }
        });
        this.draggable(head);

        // In view, near where it was asked for.
        const win = doc.defaultView ?? window;
        const box = el.getBoundingClientRect();
        const left = Math.max(8, Math.min(at.x, win.innerWidth - box.width - 8));
        const top = Math.max(8, Math.min(at.y, win.innerHeight - box.height - 8));
        el.setCssProps({
            "--zf-section-left": `${Math.round(left)}px`,
            "--zf-section-top": `${Math.round(top)}px`,
        });
        this.title.focus();
        this.title.select();
        this.updateInfo();
        void this.loadAuthors();
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        if (this.infoTimer !== null) window.clearTimeout(this.infoTimer);
        this.el.remove();
        if (current === this) current = null;
    }

    /** Moved by its head. */
    private draggable(handle: HTMLElement) {
        handle.addEventListener("pointerdown", (e) => {
            if (e.button !== 0 || (e.target as HTMLElement).closest("[role=button]")) return;
            const box = this.el.getBoundingClientRect();
            const dx = e.clientX - box.left;
            const dy = e.clientY - box.top;
            handle.setPointerCapture(e.pointerId);
            const move = (ev: PointerEvent) => {
                this.el.setCssProps({
                    "--zf-section-left": `${Math.round(ev.clientX - dx)}px`,
                    "--zf-section-top": `${Math.round(ev.clientY - dy)}px`,
                });
            };
            const up = () => {
                handle.removeEventListener("pointermove", move);
                handle.removeEventListener("pointerup", up);
            };
            handle.addEventListener("pointermove", move);
            handle.addEventListener("pointerup", up);
        });
    }

    /** The book's authors, once the item is read (unless typed already). */
    private async loadAuthors() {
        try {
            const book = await bookOf(this.source);
            if (this.closed || this.authors.value) return;
            this.authors.value = defaultAuthors(book.data);
        } catch {
            // Said when creating.
        }
    }

    /** The pages typed, as PDF pages; a reason when they are not pages. */
    private range(): { first: number; last: number } | string {
        const { pageLabels, pageCount } = this.source.context;
        const near = this.source.context.index !== null
            ? (this.source.context.headings[this.source.context.index]?.page ?? 0)
            : 0;
        const first = pageOfLabel(this.from.value, pageLabels, pageCount, near);
        if (first === null) return `No page is numbered “${this.from.value.trim()}”.`;
        const last = pageOfLabel(this.to.value, pageLabels, pageCount, first);
        if (last === null) return `No page is numbered “${this.to.value.trim()}”.`;
        if (last < first) return "The last page comes before the first.";
        return { first, last };
    }

    private scheduleInfo() {
        if (this.infoTimer !== null) window.clearTimeout(this.infoTimer);
        this.infoTimer = window.setTimeout(() => {
            this.infoTimer = null;
            this.updateInfo();
        }, 200);
    }

    /** Under the fields: the PDF's pages, and how many annotations go along. */
    private updateInfo() {
        const run = ++this.infoRun;
        const range = this.range();
        this.info.toggleClass("is-error", typeof range === "string");
        if (typeof range === "string") {
            this.info.setText(range);
            return;
        }
        const count = range.last - range.first + 1;
        const pdfPages =
            count === 1
                ? `PDF page ${range.first + 1}`
                : `PDF pages ${range.first + 1}–${range.last + 1} (${count})`;
        this.info.setText(pdfPages);
        void workerBridge.evoLibrary
            .sectionAnnotations(
                this.source.libraryID,
                this.source.attachmentKey,
                range.first,
                range.last,
            )
            .then((list) => {
                if (run !== this.infoRun || this.closed) return;
                const n = list.length;
                const verb = services.settings.evoBookSectionRemoveAnnotations
                    ? "move"
                    : "are copied";
                this.info.setText(
                    n
                        ? `${pdfPages} · ${n} ${n === 1 ? "annotation" : "annotations"} ${n === 1 && verb === "move" ? "moves" : verb} to it`
                        : pdfPages,
                );
            })
            .catch(() => {
                // The pages alone.
            });
    }

    private async submit() {
        if (this.create.disabled) return;
        const title = this.title.value.trim();
        if (!title) {
            this.info.addClass("is-error");
            this.info.setText("The section needs a title.");
            this.title.focus();
            return;
        }
        const range = this.range();
        if (typeof range === "string") {
            this.updateInfo();
            return;
        }
        const { pageLabels } = this.source.context;
        this.create.disabled = true;
        this.create.setText("Creating…");
        try {
            await createBookSection(this.source, {
                title,
                authors: this.authors.value,
                first: range.first,
                last: range.last,
                pages: pagesField(
                    pageLabelOf(range.first, pageLabels),
                    pageLabelOf(range.last, pageLabels),
                ),
            });
            this.close();
        } catch (e) {
            services.logService.error(
                "Could not create the book section",
                "EvoBookSection",
                e,
            );
            this.info.addClass("is-error");
            this.info.setText(
                e instanceof Error ? e.message : "Could not create the book section.",
            );
            this.create.disabled = false;
            this.create.setText("Create");
        }
    }
}

/** The PDF's attachment and the book it is part of. */
async function bookOf(source: BookSectionSource) {
    const attachment = await workerBridge.dbHelper.getAttachmentItem(
        source.libraryID,
        source.attachmentKey,
    );
    if (!attachment) throw new Error("The PDF is not on this device.");
    if (!attachment.parentItem)
        throw new Error("This PDF is not part of an item; a book section is made from the book's PDF.");
    const parent = await workerBridge.dbHelper.getItem(
        source.libraryID,
        attachment.parentItem,
    );
    if (!parent) throw new Error("The PDF's item is not on this device.");
    return {
        attachment,
        key: parent.key,
        data: parent.raw.data as unknown as Record<string, unknown> & {
            itemType: string;
            creators?: unknown;
            date?: string;
        },
    };
}

/**
 * Make the section: its PDF, its item, its annotations. Throws (with what
 * to tell) when the item cannot be made; what was made by then stays.
 */
export async function createBookSection(
    source: BookSectionSource,
    input: {
        title: string;
        /** As typed: names separated by ";". */
        authors: string;
        first: number;
        last: number;
        /** The `pages` field ("45-78"). */
        pages: string;
    },
): Promise<void> {
    const { libraryID } = source;
    const id = `${libraryID}:${source.attachmentKey}`;
    if (busy.has(id)) throw new Error("A section of this PDF is being made already.");
    const refusal = attachRefusal(libraryID);
    if (refusal) throw new Error(refusal);
    busy.add(id);
    const notify = services.notificationService;
    try {
        const book = await bookOf(source);
        if (book.attachment.raw.data.contentType !== "application/pdf")
            throw new Error("Book sections are made from PDFs.");

        // 1. The pages, as a PDF of their own, with the labels they had.
        const { blob } = await workerBridge.downloadAttachment(book.attachment);
        const original = new Uint8Array(await blob.arrayBuffer());
        const sourceDoc = await PDFDocument.load(original, { updateMetadata: false });
        const labels = readPageLabels(sourceDoc);
        const indexes: number[] = [];
        for (let i = input.first; i <= input.last; i++) indexes.push(i);
        const cut = await extractPages(original, indexes, { title: input.title });
        const doc = await PDFDocument.load(cut, { updateMetadata: false });
        writeLabelRuns(doc, labelRuns(labels.slice(input.first, input.last + 1)));
        const bytes = await doc.save();

        // 2. The item.
        const authors = parseAuthors(input.authors);
        const [made] = await createItems(libraryID, [
            sectionItem(book.data, {
                title: input.title,
                authors,
                pages: input.pages,
            }),
        ]);
        if (!made?.key)
            throw new Error(`Zotero refused the book section (${made?.message ?? "no answer"}).`);
        const sectionKey = made.key;

        // 3. Its PDF (named like any file attached here).
        const firstAuthor = authors.find((a) => "lastName" in a);
        const bookAuthor = (
            Array.isArray(book.data.creators)
                ? (book.data.creators as { lastName?: string; name?: string }[])
                : []
        )[0];
        let attachmentKey: string;
        try {
            const buffer = bytes.buffer.slice(
                bytes.byteOffset,
                bytes.byteOffset + bytes.byteLength,
            ) as ArrayBuffer;
            const attached = await uploadAttachmentWithKey(
                { libraryID, key: sectionKey },
                {
                    bytes: buffer,
                    contentType: "application/pdf",
                    extension: "pdf",
                    route: "book section",
                },
                {
                    lastName:
                        (firstAuthor && "lastName" in firstAuthor
                            ? firstAuthor.lastName
                            : "") ||
                        bookAuthor?.lastName ||
                        bookAuthor?.name ||
                        "",
                    year: extractYear(book.data.date ?? ""),
                    shortTitle: "",
                    title: input.title,
                    itemType: "bookSection",
                },
                { sync: false },
            );
            attachmentKey = attached.key;
        } catch (e) {
            void startSync(libraryID, true).catch(() => {});
            throw new Error(
                `The book section is in Zotero, but its PDF could not be saved: ${e instanceof Error ? e.message : String(e)}`,
            );
        }

        // 4. The annotations on its pages, on its PDF.
        const moving = await workerBridge.evoLibrary.sectionAnnotations(
            libraryID,
            source.attachmentKey,
            input.first,
            input.last,
        );
        let copied: string[] = [];
        let failed = 0;
        if (moving.length) {
            try {
                const results = await createItems(
                    libraryID,
                    moving.map((m) => ({ ...m.data, parentItem: attachmentKey })),
                );
                results.forEach((r, i) => {
                    if (r.key) copied.push(moving[i]!.key);
                    else failed++;
                });
            } catch (e) {
                services.logService.error(
                    "Could not copy the annotations to the book section",
                    "EvoBookSection",
                    e,
                );
                failed = moving.length;
                copied = [];
            }
        }

        // 5. Off the book's PDF (the setting), only those copied.
        const remove =
            services.settings.evoBookSectionRemoveAnnotations && copied.length > 0;
        if (remove) {
            await workerBridge.annotation.deleteAnnotations(book.attachment, copied);
            services.eventHub.annotationChanged.emit(
                libraryID,
                copied[0]!,
                source.attachmentKey,
            );
            noteLocalEdit(libraryID);
        }
        void startSync(libraryID, true).catch(() => {
            // The next sync brings it.
        });

        const n = copied.length;
        const what = n
            ? `; ${n} ${n === 1 ? "annotation" : "annotations"} ${remove ? "moved" : "copied"} to it`
            : "";
        notify.notify(
            "success",
            `Book section “${input.title}” (pp. ${input.pages}) made${what}. It shows here after the sync.`,
        );
        if (failed)
            notify.notify(
                "warning",
                `${failed} ${failed === 1 ? "annotation" : "annotations"} could not be copied to the section and ${failed === 1 ? "stays" : "stay"} in the book's PDF.`,
            );
    } finally {
        busy.delete(id);
    }
}
