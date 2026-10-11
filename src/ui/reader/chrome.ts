/**
 * ZotFlow Evo (fork): reader chrome the user toggles from Obsidian — the
 * reader toolbar and the note strip beside a PDF — and the theme refresh.
 *
 * The fork's reader-view logic lives here so the upstream view files only
 * gain a few calls into this module. See FORK.md.
 */
import { setIcon } from "obsidian";

import { workerBridge } from "bridge";
import { EventBus } from "services/event-bus";
import { services } from "services/services";
import { fireAndForgetIn } from "utils/fire-and-forget";

import type { ItemView, Plugin } from "obsidian";
import type {
    ColorScheme,
    CreateReaderOptions,
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
    | { libraryID: number; key: string; fallback: string }
    | { text: string };

/** Fires after a reader chrome setting changed; every open reader follows. */
const chromeChanged = new EventBus<[]>();

/**
 * The chrome settings in the shape `initReader` takes. The note strip comes
 * without its banner, which needs the item's metadata from the worker; the
 * views send it with `connectNoteStrip()` once the reader is open.
 */
export function readerChromeOptions(): Pick<
    CreateReaderOptions,
    "toolbarHidden" | "noteStrip"
> {
    return {
        toolbarHidden: services.settings.readerToolbarHidden,
        noteStrip: noteStripSettings(),
    };
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

/** Show or hide the note strip beside PDFs in every open reader. */
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

/** The note strip settings in the shape the reader takes, without the banner. */
function noteStripSettings(): ReaderNoteStrip {
    const settings = services.settings;
    return {
        visible: settings.readerNoteStripVisible,
        collapsed: settings.readerNoteStripList,
        width: settings.readerNoteStripWidth,
        highlights: settings.readerNoteStripHighlights,
    };
}

/** The line above the note strip for `subject`: the banner template, rendered. */
async function renderNoteStripBanner(
    subject: NoteStripSubject | undefined,
): Promise<string> {
    const template = services.settings.readerNoteStripBanner.trim();
    if (!template || !subject) return "";
    if ("text" in subject) return subject.text;
    try {
        const out = await workerBridge.displayTitle.renderTemplate(
            subject.libraryID,
            subject.key,
            template,
        );
        // One line; an item without authors leaves no stray separator in front.
        const line = out
            .replace(/\s+/g, " ")
            .trim()
            .replace(/^[·,\-–|\s]+/, "");
        return line || subject.fallback;
    } catch (e) {
        services.logService.warn(
            "Note strip banner template failed to render; showing the title",
            "ReaderChrome",
            e,
        );
        return subject.fallback;
    }
}

/** Counts banner renders per reader, so a slow one does not overwrite a later one. */
const bannerRuns = new WeakMap<IframeReaderBridge, number>();
/** Readers whose strip already reports its own changes to this module. */
const listening = new WeakSet<IframeReaderBridge>();

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
 * Call once the reader is open: sends the line above the note strip, and
 * takes up what is changed in the strip itself (its "highlights" button), so
 * that it is kept and the other open readers follow.
 */
export function connectNoteStrip(
    bridge: IframeReaderBridge | undefined,
    subject: NoteStripSubject | undefined,
) {
    if (!bridge) return;
    if (!listening.has(bridge)) {
        listening.add(bridge);
        bridge.onEventType("noteStripChanged", (event) => {
            const { highlights } = event.settings;
            if (typeof highlights === "boolean") {
                setChromeSetting("readerNoteStripHighlights", highlights);
            }
        });
    }
    sendNoteStripBanner(bridge, subject);
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
class ReaderChromeControls {
    private readonly toolbarAction: HTMLElement;
    private readonly stripAction: HTMLElement;
    private readonly stripListAction: HTMLElement;

    constructor(
        view: ItemView,
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
        view.register(chromeChanged.subscribe(() => this.apply()));
        this.render();
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
            bridge.setToolbarHidden(
                services.settings.readerToolbarHidden,
            ),
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
     */
    private render() {
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
