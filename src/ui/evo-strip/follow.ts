/**
 * ZotFlow Evo (fork): the annotation strip tab follows the line being
 * written. When the cursor rests on a line of a note (any editor of Obsidian
 * in its own windows, so not the strip's own comment editors), the first
 * link on that line to a source note (`zotero-key` and `library-id` in its
 * frontmatter) names the item shown. A line without one leaves the strip as
 * it is, unless the note itself is a source note: then its item is shown.
 *
 * Nothing runs while no strip tab is open. See FORK.md, "Annotation strip
 * tab".
 */
import { EditorView } from "@codemirror/view";
import { MarkdownView, TFile, editorInfoField } from "obsidian";

import { services } from "services/services";
import { EVO_STRIP_VIEW_TYPE, EvoStripView } from "ui/evo-strip/strip-view";
import { linkPathsOnLine } from "utils/evo-line-links";

import type { App, Plugin } from "obsidian";
import type { StripSubject } from "ui/evo-strip/strip-view";

/** Pause after the cursor moved before the strip follows. */
const FOLLOW_DELAY_MS = 150;

/** The item a source note is about, if `file` is one. */
function subjectOfNote(app: App, file: TFile | null): StripSubject | null {
    if (!file || file.extension !== "md") return null;
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    const key: unknown = fm?.["zotero-key"];
    const libraryID: unknown = fm?.["library-id"];
    if (typeof key === "string" && key && typeof libraryID === "number")
        return { libraryID, key };
    return null;
}

/**
 * The item for a line of `sourcePath`: the first link to a source note on
 * it, else the note itself if it is a source note, else null.
 */
export function subjectOfLine(
    app: App,
    line: string,
    sourcePath: string,
): StripSubject | null {
    for (const path of linkPathsOnLine(line)) {
        const file = app.metadataCache.getFirstLinkpathDest(path, sourcePath);
        const subject = subjectOfNote(app, file instanceof TFile ? file : null);
        if (subject) return subject;
    }
    const own = app.vault.getAbstractFileByPath(sourcePath);
    return subjectOfNote(app, own instanceof TFile ? own : null);
}

function stripViews(app: App): EvoStripView[] {
    return app.workspace
        .getLeavesOfType(EVO_STRIP_VIEW_TYPE)
        .map((leaf) => leaf.view)
        .filter((v): v is EvoStripView => v instanceof EvoStripView);
}

export function registerStripFollow(plugin: Plugin) {
    const { app } = plugin;
    let timer: number | undefined;
    let pending: { line: string; path: string } | null = null;

    const follow = () => {
        timer = undefined;
        const at = pending;
        pending = null;
        if (!at) return;
        const views = stripViews(app);
        if (!views.length) return;
        let subject: StripSubject | null = null;
        try {
            subject = subjectOfLine(app, at.line, at.path);
        } catch (e) {
            services.logService.warn(
                "Could not read the links on the line",
                "EvoStrip",
                e,
            );
        }
        if (!subject) return;
        for (const view of views) void view.follow(subject);
    };

    const schedule = (line: string, path: string) => {
        pending = { line, path };
        if (timer !== undefined) window.clearTimeout(timer);
        timer = window.setTimeout(follow, FOLLOW_DELAY_MS);
    };
    plugin.register(() => {
        if (timer !== undefined) window.clearTimeout(timer);
    });

    plugin.registerEditorExtension(
        EditorView.updateListener.of((update) => {
            if (
                !update.selectionSet &&
                !update.docChanged &&
                !update.focusChanged
            )
                return;
            const view = update.view;
            if (!view.hasFocus) return;
            // An editor inside a frame: the note strip's own comment editors.
            if (view.dom.ownerDocument.defaultView?.frameElement) return;
            // Cheap first: nothing to follow for.
            if (!app.workspace.getLeavesOfType(EVO_STRIP_VIEW_TYPE).length)
                return;
            const file = update.state.field(editorInfoField, false)?.file;
            if (!file) return;
            const state = update.state;
            const line = state.doc.lineAt(state.selection.main.head).text;
            schedule(line, file.path);
        }),
    );

    // Another note brought forward: its line (or the note) at once.
    plugin.registerEvent(
        app.workspace.on("active-leaf-change", (leaf) => {
            const view = leaf?.view;
            if (!(view instanceof MarkdownView) || !view.file) return;
            if (!app.workspace.getLeavesOfType(EVO_STRIP_VIEW_TYPE).length)
                return;
            const editor = view.editor;
            const line =
                view.getMode() === "source"
                    ? editor.getLine(editor.getCursor().line)
                    : "";
            schedule(line, view.file.path);
        }),
    );
}

/** Open an annotation strip tab beside the active pane (or show the one open). */
export async function openStripTab(app: App): Promise<void> {
    const existing = app.workspace.getLeavesOfType(EVO_STRIP_VIEW_TYPE)[0];
    if (existing) {
        await app.workspace.revealLeaf(existing);
        return;
    }
    // The note being written, before the split takes the focus.
    const md = app.workspace.getActiveViewOfType(MarkdownView);
    const leaf = app.workspace.getLeaf("split", "vertical");
    await leaf.setViewState({ type: EVO_STRIP_VIEW_TYPE, active: false });
    await app.workspace.revealLeaf(leaf);
    if (md) app.workspace.setActiveLeaf(md.leaf, { focus: true });
    // Show at once what that note's line points at.
    if (md?.file) {
        const line =
            md.getMode() === "source"
                ? md.editor.getLine(md.editor.getCursor().line)
                : "";
        const subject = subjectOfLine(app, line, md.file.path);
        if (subject && leaf.view instanceof EvoStripView)
            await leaf.view.follow(subject);
    }
}

/** The annotation strip tab: its view, its command, and the following. */
export function registerEvoStrip(plugin: Plugin) {
    plugin.registerView(EVO_STRIP_VIEW_TYPE, (leaf) => new EvoStripView(leaf));
    plugin.addCommand({
        id: "open-annotation-strip",
        name: "Open annotation strip (follows the line being written)",
        callback: () => void openStripTab(plugin.app),
    });
    registerStripFollow(plugin);
}
