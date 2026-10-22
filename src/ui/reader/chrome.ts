/**
 * ZotFlow Evo (fork): reader chrome the user toggles from Obsidian — the
 * reader toolbar and the note strip beside a PDF or a snapshot — and the
 * theme refresh.
 *
 * The fork's reader-view logic lives here so the upstream view files only
 * gain a few calls into this module. See FORK.md.
 */
import { Menu, Platform, setIcon } from "obsidian";

import { workerBridge } from "bridge";
import { EventBus } from "services/event-bus";
import { services } from "services/services";
import { revealInLibrary } from "ui/evo-library/actions";
import { openPersonNote } from "ui/evo-person";
import { fireAndForgetIn } from "utils/fire-and-forget";
import { isNeutralPdfFilter, sanitizePdfFilter } from "utils/evo-pdf-filter";

import type { ItemView, Plugin } from "obsidian";
import type {
    ColorScheme,
    CreateReaderOptions,
    NoteStripAction,
    NoteStripBanner,
    ReaderNoteStrip,
} from "types/zotero-reader";
import type { IframeReaderBridge } from "ui/reader/bridge";

const ff = fireAndForgetIn("ReaderChrome");

/** Pause after the last `css-change` before the reader re-reads the theme. */
const THEME_REFRESH_DEBOUNCE_MS = 200;

type ChromeSetting =
    | "readerToolbarHidden"
    | "readerNoteStripVisible"
    | "readerNoteStripList"
    | "readerNoteStripHighlights";

/**
 * What the line above a reader's note strip is about: a Zotero item, whose
 * metadata fills the banner template, or just a name (a local file).
 */
export type NoteStripSubject =
    { libraryID: number; key: string; fallback: string } | { text: string };

/** Fires after a reader chrome setting changed; every open reader follows. */
const chromeChanged = new EventBus<[]>();

/** Fires when a reader has opened a document; its view's buttons follow. */
const readerOpened = new EventBus<[IframeReaderBridge]>();

/** Documents the note strip exists for; beside a snapshot it is a list only. */
function hasNoteStrip(type: string | undefined): boolean {
    return type === "pdf" || type === "snapshot";
}

function canAnchorNoteStrip(type: string | undefined): boolean {
    return type === "pdf";
}

/**
 * The chrome settings in the shape `initReader` takes. The note strip comes
 * without its banner, which needs the item's metadata from the worker; the
 * views send it with `connectNoteStrip()` once the reader is open.
 */
export function readerChromeOptions(
    filterKey?: string,
): Pick<CreateReaderOptions, "toolbarHidden" | "noteStrip"> {
    return {
        toolbarHidden: services.settings.readerToolbarHidden,
        noteStrip: {
            ...noteStripSettings(),
            pdfFilter: pdfFilterFor(filterKey),
        },
    };
}

/**
 * This PDF's page filter, or null when none is kept for it (the reader then
 * takes one written into the PDF, if there is one).
 */
function pdfFilterFor(filterKey: string | undefined) {
    if (!filterKey) return null;
    return sanitizePdfFilter(services.settings.readerPdfFilters?.[filterKey]);
}

/** Keep (or, neutral, forget) a PDF's page filter. */
export function setPdfFilter(filterKey: string, value: unknown) {
    const filters = { ...(services.settings.readerPdfFilters ?? {}) };
    const filter = sanitizePdfFilter(value);
    if (!filter || isNeutralPdfFilter(filter)) delete filters[filterKey];
    else filters[filterKey] = filter;
    services.settings.readerPdfFilters = filters;
    ff(services.saveSettings(), "Failed to save the page filter");
}

function setChromeSetting(setting: ChromeSetting, value: boolean) {
    if (services.settings[setting] === value) return;
    services.settings[setting] = value;
    // Readers follow at once; the write to data.json may take a moment.
    chromeChanged.emit();
    ff(services.saveSettings(), "Failed to save the reader chrome setting");
}

function toggleChromeSetting(setting: ChromeSetting) {
    setChromeSetting(setting, !services.settings[setting]);
}

/** Show or hide the reader toolbar in every open reader. */
export function toggleReaderToolbar() {
    toggleChromeSetting("readerToolbarHidden");
}

/** Show or hide the note strip in every open reader. */
export function toggleReaderNoteStrip() {
    toggleChromeSetting("readerNoteStripVisible");
}

/**
 * Switch the note strip between a list of its own and entries beside their
 * place on the page. Asked for while the strip is hidden, it shows the strip.
 */
export function toggleReaderNoteStripList() {
    if (!services.settings.readerNoteStripVisible) {
        toggleChromeSetting("readerNoteStripVisible");
        return;
    }
    toggleChromeSetting("readerNoteStripList");
}

/** Tell every open reader that a chrome setting was changed elsewhere (the settings tab). */
export function notifyReaderChromeChanged() {
    chromeChanged.emit();
}

/**
 * The annotation strip tab (ui/evo-strip): the strip alone, always shown,
 * as a list; the reader's toolbar off.
 */
function stripOnlySettings(): ReaderNoteStrip {
    return {
        ...noteStripSettings(),
        // The pages are not shown: no filter to draw them with.
        pdfFilter: null,
        visible: true,
        collapsed: true,
        stripOnly: true,
        actions: [],
    };
}

/** `readerChromeOptions()` for the annotation strip tab. */
export function stripOnlyChromeOptions(): Pick<
    CreateReaderOptions,
    "toolbarHidden" | "noteStrip"
> {
    return { toolbarHidden: true, noteStrip: stripOnlySettings() };
}

/**
 * The annotation strip tab's reader is open: it follows the shared strip
 * settings (the highlights button) like every reader, and what is asked of
 * its head (an author, the title's menu) and its entries (open a place)
 * comes to `handlers`.
 */
export function connectStripOnly(
    view: ItemView,
    bridge: IframeReaderBridge,
    handlers: {
        onOpen: (location: Record<string, unknown>) => void;
        onTitleMenu: (at: { x: number; y: number }) => void;
    },
): () => void {
    const offChrome = chromeChanged.subscribe(() => {
        if (bridge.state !== "reader-ready") return;
        ff(
            bridge.setNoteStrip(stripOnlySettings()),
            "Failed to update the strip",
        );
    });
    bridge.onEventType("noteStripOpen", (event) => {
        if (event.location && typeof event.location === "object")
            handlers.onOpen(event.location);
    });
    bridge.onEventType("noteStripAction", (event) => {
        const frame = view.containerEl.querySelector("iframe");
        const box = frame?.getBoundingClientRect();
        const at = {
            x: (box?.left ?? 0) + event.x,
            y: (box?.top ?? 0) + event.y,
        };
        if (event.id === "title-menu") handlers.onTitleMenu(at);
        else if (event.id.startsWith("person:"))
            void openPersonNote(view.app, event.id.slice("person:".length));
    });
    return offChrome;
}

/**
 * A menu opened at a point of a reader frame: a click in the frame stays in
 * it, where the menu does not see it, so while the menu is open a cover
 * under it takes the click.
 */
export function showMenuOverFrame(
    menu: Menu,
    at: { x: number; y: number },
    doc: Document,
) {
    const cover = doc.body.createDiv({ cls: "zotflow-evo-menu-cover" });
    const close = (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        menu.hide();
    };
    cover.addEventListener("pointerdown", close);
    cover.addEventListener("contextmenu", close);
    menu.onHide(() => cover.remove());
    menu.showAtPosition(at, doc);
}

/** The note strip settings in the shape the reader takes, without the banner. */
function noteStripSettings(): ReaderNoteStrip {
    const settings = services.settings;
    return {
        visible: settings.readerNoteStripVisible,
        collapsed: settings.readerNoteStripList,
        width: settings.readerNoteStripWidth,
        highlights: settings.readerNoteStripHighlights,
        appearance: {
            quotes: settings.readerNoteStripQuotes,
            highlightOpacity: settings.readerNoteStripHighlightOpacity,
            spacing: settings.readerNoteStripSpacing,
            toolToggle: settings.readerSelectionToolToggle,
        },
    };
}

/**
 * The two lines above the note strip for `subject`: the item's authors (full
 * names) and year, and its title. A local file shows its name as the title.
 */
async function renderNoteStripBanner(
    subject: NoteStripSubject | undefined,
): Promise<NoteStripBanner> {
    if (!subject) return "";
    if ("text" in subject) return { title: subject.text };
    try {
        const banner = await workerBridge.evoLibrary.itemBanner(
            subject.libraryID,
            subject.key,
        );
        return banner ?? { title: subject.fallback };
    } catch (e) {
        services.logService.warn(
            "Could not read the item for the note strip's head; showing the title",
            "ReaderChrome",
            e,
        );
        return { title: subject.fallback };
    }
}

/** Counts banner renders per reader, so a slow one does not overwrite a later one. */
const bannerRuns = new WeakMap<IframeReaderBridge, number>();
/** Readers whose strip already reports its own changes to this module. */
const listening = new WeakSet<IframeReaderBridge>();
/** The PDF each reader shows, for its page filter (`pdfFilterKey()`). */
const filterKeys = new WeakMap<IframeReaderBridge, string>();

/**
 * Render the line above the note strip for `subject` and send it to the
 * reader. Returns at once; the banner follows when the template has rendered.
 */
function sendNoteStripBanner(
    bridge: IframeReaderBridge,
    subject: NoteStripSubject | undefined,
) {
    const run = (bannerRuns.get(bridge) ?? 0) + 1;
    bannerRuns.set(bridge, run);
    ff(
        renderNoteStripBanner(subject).then(async (banner) => {
            if (bannerRuns.get(bridge) !== run) return;
            if (bridge.state !== "reader-ready") return;
            await bridge.setNoteStrip({ banner });
        }),
        "Failed to update the reader note strip banner",
    );
}

/**
 * Call once the reader is open: sends the line above the note strip, takes
 * up what is changed in the strip itself (its "highlights" button), so that
 * it is kept and the other open readers follow, and has the view's header
 * buttons match the kind of document that was opened.
 */
export function connectNoteStrip(
    bridge: IframeReaderBridge | undefined,
    subject: NoteStripSubject | undefined,
    filterKey?: string,
) {
    if (!bridge) return;
    if (filterKey) filterKeys.set(bridge, filterKey);
    if (!listening.has(bridge)) {
        listening.add(bridge);
        bridge.onEventType("noteStripChanged", (event) => {
            const { highlights, width, pdfFilter } = event.settings;
            if (typeof highlights === "boolean") {
                setChromeSetting("readerNoteStripHighlights", highlights);
            }
            // The page filter is this PDF's: kept for it alone.
            const key = filterKeys.get(bridge);
            if (pdfFilter && key) setPdfFilter(key, pdfFilter);
            // Dragged wider or narrower in the reader: every reader follows.
            if (
                typeof width === "number" &&
                Number.isFinite(width) &&
                width !== services.settings.readerNoteStripWidth
            ) {
                services.settings.readerNoteStripWidth = Math.round(width);
                chromeChanged.emit();
                ff(
                    services.saveSettings(),
                    "Failed to save the note strip width",
                );
            }
        });
    }
    sendNoteStripBanner(bridge, subject);
    readerOpened.emit(bridge);
}

/** Commands for the toggles, so they can be bound to hotkeys. */
export function registerReaderChromeCommands(plugin: Plugin) {
    plugin.addCommand({
        id: "toggle-reader-note-strip",
        name: "Toggle reader note strip",
        callback: toggleReaderNoteStrip,
    });
    plugin.addCommand({
        id: "toggle-reader-note-strip-list",
        name: "Toggle reader note strip list mode",
        callback: toggleReaderNoteStripList,
    });
    plugin.addCommand({
        id: "toggle-reader-note-strip-highlights",
        name: "Toggle highlights in the reader note strip",
        callback: () => toggleChromeSetting("readerNoteStripHighlights"),
    });
    plugin.addCommand({
        id: "toggle-reader-toolbar",
        name: "Toggle reader toolbar",
        callback: toggleReaderToolbar,
    });
}

/** Set a header button's icon, with a fallback for an Obsidian that lacks it. */
function setActionIcon(el: HTMLElement, icon: string, fallback: string) {
    setIcon(el, icon);
    if (!el.firstElementChild) setIcon(el, fallback);
}

/**
 * The toggle buttons in a reader view's header, next to "Open source note".
 * The buttons change the shared settings; this object keeps its own view's
 * buttons and reader in step with them.
 */
/** Hides an Obsidian view's header (styles.css; on a phone it stays). */
const HEADERLESS_CLASS = "zotflow-evo-headerless";

/** Numbers the header buttons mirrored into note strips. */
let actionCount = 0;

class ReaderChromeControls {
    private readonly toolbarAction: HTMLElement;
    private readonly stripAction: HTMLElement;
    private readonly stripListAction: HTMLElement;
    /**
     * The page being read, in the view's header (shown with the header,
     * i.e. while the note strip is hidden; beside the strip the reader shows
     * it itself).
     */
    private readonly pageInfoEl: HTMLElement;
    /** What was last sent to the strip, to send only changes. */
    private sentActions = "";
    private readonly withActionListener = new WeakSet<IframeReaderBridge>();

    constructor(
        private readonly view: ItemView,
        private readonly getBridge: () => IframeReaderBridge | undefined,
        private readonly getSubject: () => NoteStripSubject | undefined,
    ) {
        // Obsidian places each new action before the earlier ones.
        this.stripListAction = view.addAction(
            "list",
            "Show notes beside the page",
            toggleReaderNoteStripList,
        );
        this.stripAction = view.addAction(
            "panel-right",
            "Hide note strip",
            toggleReaderNoteStrip,
        );
        this.toolbarAction = view.addAction(
            "panel-top",
            "Hide reader toolbar",
            toggleReaderToolbar,
        );
        // Only these are shown in the strip's head (not Obsidian's own
        // buttons, nor "Open source note", which is in the title's menu).
        for (const el of [
            this.stripListAction,
            this.stripAction,
            this.toolbarAction,
        ])
            el.dataset.zfEvoChrome = "1";
        this.pageInfoEl = createDiv({ cls: "zotflow-evo-header-page" });
        const actions = view.containerEl.querySelector(".view-actions");
        if (actions) actions.before(this.pageInfoEl);
        else
            view.containerEl
                .querySelector(".view-header")
                ?.appendChild(this.pageInfoEl);
        view.register(() => this.pageInfoEl.remove());
        view.register(chromeChanged.subscribe(() => this.apply()));
        view.register(
            readerOpened.subscribe((bridge) => {
                if (bridge !== this.getBridge()) return;
                this.listenForActions(bridge);
                this.sentActions = "";
                this.render();
            }),
        );
        view.register(() => view.containerEl.removeClass(HEADERLESS_CLASS));
        this.render();
    }

    /**
     * Whether the view's header is hidden: while the note strip is shown
     * beside a document that has one (its head shows the header's buttons).
     * Not on a phone, where the header holds the way back.
     */
    private headerless(): boolean {
        const type = this.getBridge()?.documentType;
        return (
            !Platform.isMobile &&
            !!type &&
            hasNoteStrip(type) &&
            services.settings.readerNoteStripVisible
        );
    }

    /** The header's buttons as they are now (shown ones only), for the strip. */
    private headerActions(): NoteStripAction[] {
        const bar = this.view.containerEl.querySelector(".view-actions");
        if (!bar) return [];
        const out: NoteStripAction[] = [];
        for (const el of Array.from(
            bar.querySelectorAll<HTMLElement>(".view-action"),
        )) {
            // Only the fork's toggles: not Obsidian's own buttons (bookmark,
            // more options), nor "Open source note" (in the title's menu).
            if (el.dataset.zfEvoChrome !== "1") continue;
            if (el.style.display === "none" || el.hidden) continue;
            const id = (el.dataset.zfEvoAction ??= String(++actionCount));
            out.push({
                id,
                title: el.getAttribute("aria-label") ?? "",
                icon: el.querySelector("svg")?.outerHTML ?? "",
            });
        }
        return out;
    }

    /** A mirrored button clicked in the strip: click the real one, where it was clicked. */
    private listenForActions(bridge: IframeReaderBridge) {
        if (this.withActionListener.has(bridge)) return;
        this.withActionListener.add(bridge);
        this.pageInfoEl.empty();
        bridge.onEventType("pageInfo", (event) => {
            if (bridge !== this.getBridge()) return;
            this.pageInfoEl.empty();
            this.pageInfoEl.createSpan({
                cls: "zotflow-evo-header-page-label",
                text: event.label,
            });
            this.pageInfoEl.createSpan({
                cls: "zotflow-evo-header-page-number",
                text: `${event.index + 1} / ${event.count}`,
            });
        });
        bridge.onEventType("noteStripAction", (event) => {
            const frame = this.view.containerEl.querySelector("iframe");
            const box = frame?.getBoundingClientRect();
            const at = {
                x: (box?.left ?? 0) + event.x,
                y: (box?.top ?? 0) + event.y,
            };
            if (event.id === "title-menu") {
                this.showTitleMenu(at);
                return;
            }
            if (event.id.startsWith("person:")) {
                void openPersonNote(
                    this.view.app,
                    event.id.slice("person:".length),
                );
                return;
            }
            const el = this.view.containerEl.querySelector<HTMLElement>(
                `.view-actions [data-zf-evo-action="${CSS.escape(event.id)}"]`,
            );
            if (!el) return;
            const win = el.ownerDocument.defaultView ?? window;
            el.dispatchEvent(
                new win.MouseEvent("click", {
                    bubbles: true,
                    cancelable: true,
                    clientX: at.x,
                    clientY: at.y,
                }),
            );
        });
    }

    /**
     * Right-click on the strip's title: the item's source note, and the
     * item in the library browser.
     */
    private showTitleMenu(at: { x: number; y: number }) {
        const menu = new Menu();
        const sourceNote = this.view.containerEl.querySelector<HTMLElement>(
            '.view-action[aria-label="Open source note"]',
        );
        if (sourceNote) {
            menu.addItem((item) =>
                item
                    .setTitle("Open source note")
                    .setIcon("notebook-text")
                    .onClick(() => sourceNote.click()),
            );
        }
        const subject = this.getSubject();
        if (subject && "libraryID" in subject) {
            menu.addItem((item) =>
                item
                    .setTitle("Open in library")
                    .setIcon("library-big")
                    .onClick(
                        () =>
                            void revealInLibrary(
                                this.view.app,
                                subject.libraryID,
                                null,
                                subject.key,
                            ),
                    ),
            );
        }
        showMenuOverFrame(menu, at, this.view.containerEl.ownerDocument);
    }

    /** Hide or show the header, and send the strip the buttons to show for it. */
    private applyHeader() {
        const hide = this.headerless();
        this.view.containerEl.toggleClass(HEADERLESS_CLASS, hide);
        const bridge = this.getBridge();
        if (!bridge || bridge.state !== "reader-ready") return;
        const actions = hide ? this.headerActions() : [];
        const key = JSON.stringify(actions);
        if (key === this.sentActions) return;
        this.sentActions = key;
        ff(
            bridge.setNoteStrip({ actions }),
            "Failed to show the view's buttons in the note strip",
        );
    }

    /** Bring this view's buttons and reader in line with the settings. */
    private apply() {
        this.render();
        const bridge = this.getBridge();
        // Before the bridge is connecting there is no reader to tell; it gets
        // the settings with `initReader`.
        if (
            !bridge ||
            (bridge.state !== "connecting" &&
                bridge.state !== "bridge-ready" &&
                bridge.state !== "reader-ready")
        ) {
            return;
        }
        ff(
            bridge.setToolbarHidden(services.settings.readerToolbarHidden),
            "Failed to toggle the reader toolbar",
        );
        // The strip follows at once; its banner when the template has rendered.
        ff(
            bridge.setNoteStrip(noteStripSettings()),
            "Failed to update the reader note strip",
        );
        sendNoteStripBanner(bridge, this.getSubject());
    }

    /**
     * The icon alone shows the state. The buttons are deliberately not
     * marked `is-active`: that draws them as held down.
     *
     * Once a document is open, only the buttons that do something for its
     * kind are shown: no strip beside an EPUB, no "beside the page" for a
     * snapshot. Before that (and in a view that never opens one) all are.
     */
    private render() {
        const type = this.getBridge()?.documentType;
        this.stripAction.toggle(!type || hasNoteStrip(type));
        this.stripListAction.toggle(!type || canAnchorNoteStrip(type));

        const toolbarHidden = services.settings.readerToolbarHidden;
        setActionIcon(
            this.toolbarAction,
            toolbarHidden ? "panel-top-open" : "panel-top-close",
            "panel-top",
        );
        this.toolbarAction.setAttribute(
            "aria-label",
            toolbarHidden ? "Show reader toolbar" : "Hide reader toolbar",
        );

        const stripShown = services.settings.readerNoteStripVisible;
        setActionIcon(
            this.stripAction,
            stripShown ? "panel-right-close" : "panel-right-open",
            "panel-right",
        );
        this.stripAction.setAttribute(
            "aria-label",
            stripShown ? "Hide note strip" : "Show note strip",
        );

        // The icon names what a click gives: spread beside the page, or
        // gathered into a list.
        const asList = services.settings.readerNoteStripList;
        setActionIcon(
            this.stripListAction,
            asList ? "unfold-vertical" : "fold-vertical",
            "list",
        );
        this.stripListAction.setAttribute(
            "aria-label",
            asList ? "Show notes beside the page" : "Show notes as a list",
        );

        this.applyHeader();
    }
}

/**
 * Add the toggle buttons to a reader view's header. `getSubject` says what
 * the view shows, for the line above the note strip.
 */
export function attachReaderChromeControls(
    view: ItemView,
    getBridge: () => IframeReaderBridge | undefined,
    getSubject: () => NoteStripSubject | undefined,
): void {
    new ReaderChromeControls(view, getBridge, getSubject);
}

const themeRefreshTimers = new WeakMap<IframeReaderBridge, number>();

/**
 * Obsidian's CSS changed (theme, snippet, accent, Style Settings) while the
 * colour scheme stayed the same: have the reader read the theme again.
 * Applying the unchanged scheme does that. Debounced, because some sources
 * fire `css-change` many times a second.
 *
 * The timer is short and checks the bridge before acting, so one that
 * outlives its view does nothing.
 */
export function requestReaderThemeRefresh(
    bridge: IframeReaderBridge | undefined,
    colorScheme: ColorScheme,
) {
    if (!bridge) return;
    const pending = themeRefreshTimers.get(bridge);
    if (pending !== undefined) window.clearTimeout(pending);
    themeRefreshTimers.set(
        bridge,
        window.setTimeout(() => {
            themeRefreshTimers.delete(bridge);
            if (bridge.state !== "reader-ready") return;
            ff(
                bridge.setColorScheme(colorScheme),
                "Failed to refresh the reader theme",
            );
        }, THEME_REFRESH_DEBOUNCE_MS),
    );
}
