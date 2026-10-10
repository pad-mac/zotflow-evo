/**
 * ZotFlow Evo (fork): reader chrome the user toggles from Obsidian — the
 * reader toolbar and the comment popup — and the theme refresh.
 *
 * The fork's reader-view logic lives here so the upstream view files only
 * gain a few calls into this module. See FORK.md.
 */
import { setIcon } from "obsidian";

import { EventBus } from "services/event-bus";
import { services } from "services/services";
import { fireAndForgetIn } from "utils/fire-and-forget";

import type { ItemView, Plugin } from "obsidian";
import type { ColorScheme, CreateReaderOptions } from "types/zotero-reader";
import type { IframeReaderBridge } from "ui/reader/bridge";

const ff = fireAndForgetIn("ReaderChrome");

/** Pause after the last `css-change` before the reader re-reads the theme. */
const THEME_REFRESH_DEBOUNCE_MS = 200;

type ChromeSetting = "readerToolbarHidden" | "readerCommentPopupSuppressed";

/** Fires after a reader chrome setting changed; every open reader follows. */
const chromeChanged = new EventBus<[]>();

/** The chrome settings in the shape `initReader` takes. */
export function readerChromeOptions(): Pick<
    CreateReaderOptions,
    "toolbarHidden" | "annotationPopupSuppressed"
> {
    return {
        toolbarHidden: services.settings.readerToolbarHidden,
        annotationPopupSuppressed:
            services.settings.readerCommentPopupSuppressed,
    };
}

function toggleChromeSetting(setting: ChromeSetting) {
    services.settings[setting] = !services.settings[setting];
    // Readers follow at once; the write to data.json may take a moment.
    chromeChanged.emit();
    ff(services.saveSettings(), "Failed to save the reader chrome setting");
}

/** Show or hide the reader toolbar in every open reader. */
export function toggleReaderToolbar() {
    toggleChromeSetting("readerToolbarHidden");
}

/** Turn the comment popup next to annotations on or off in every open reader. */
export function toggleReaderCommentPopup() {
    toggleChromeSetting("readerCommentPopupSuppressed");
}

/** Commands for the two toggles, so they can be bound to hotkeys. */
export function registerReaderChromeCommands(plugin: Plugin) {
    plugin.addCommand({
        id: "toggle-reader-toolbar",
        name: "Toggle reader toolbar",
        callback: toggleReaderToolbar,
    });
    plugin.addCommand({
        id: "toggle-reader-comment-popup",
        name: "Toggle reader comment popup",
        callback: toggleReaderCommentPopup,
    });
}

/** Set a header button's icon, with a fallback for an Obsidian that lacks it. */
function setActionIcon(el: HTMLElement, icon: string, fallback: string) {
    setIcon(el, icon);
    if (!el.firstElementChild) setIcon(el, fallback);
}

/**
 * The two toggle buttons in a reader view's header, next to "Open source
 * note". The buttons change the shared settings; this object keeps its own
 * view's buttons and reader in step with them.
 */
class ReaderChromeControls {
    private readonly toolbarAction: HTMLElement;
    private readonly popupAction: HTMLElement;

    constructor(
        view: ItemView,
        private readonly getBridge: () => IframeReaderBridge | undefined,
    ) {
        // Obsidian places each new action before the earlier ones.
        this.popupAction = view.addAction(
            "message-square",
            "Turn off comment popup",
            toggleReaderCommentPopup,
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
        const { toolbarHidden, annotationPopupSuppressed } =
            readerChromeOptions();
        ff(
            bridge.setToolbarHidden(toolbarHidden ?? false),
            "Failed to toggle the reader toolbar",
        );
        ff(
            bridge.setAnnotationPopupSuppressed(
                annotationPopupSuppressed ?? false,
            ),
            "Failed to toggle the reader comment popup",
        );
    }

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
        this.toolbarAction.toggleClass("is-active", toolbarHidden);

        const popupOff = services.settings.readerCommentPopupSuppressed;
        setActionIcon(
            this.popupAction,
            popupOff ? "message-square-off" : "message-square",
            "message-square",
        );
        this.popupAction.setAttribute(
            "aria-label",
            popupOff ? "Turn on comment popup" : "Turn off comment popup",
        );
        this.popupAction.toggleClass("is-active", popupOff);
    }
}

/** Add the toggle buttons to a reader view's header. */
export function attachReaderChromeControls(
    view: ItemView,
    getBridge: () => IframeReaderBridge | undefined,
): void {
    new ReaderChromeControls(view, getBridge);
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
