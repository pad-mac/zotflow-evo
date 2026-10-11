/**
 * ZotFlow Evo (fork): a click on a link to a source note opens the item's
 * PDF (or EPUB, or snapshot) instead of the note.
 *
 * Only a plain click on a plain link does: a link to a heading or block of
 * the note, a click with a modifier (which asks Obsidian for a new tab,
 * split or window) and anything that is not a click on a link in a note
 * (the quick switcher, the file explorer) open the note as always. So does
 * an item that has nothing to open. See FORK.md.
 */
import { around } from "monkey-around";
import { parseLinktext, TFile } from "obsidian";

import { services } from "services/services";
import { LOCAL_ZOTERO_READER_VIEW_TYPE } from "ui/reader/local-view";
import { openItemPrimaryAttachment } from "ui/tree-view/evo-browser";
import { newReaderLeaf } from "utils/evo-reader-leaf";

import type { App, Plugin, Workspace } from "obsidian";

type OpenLinkText = Workspace["openLinkText"];

/** What a link's target is, as far as opening an attachment goes. */
export type SourceNoteTarget =
    | { kind: "library"; libraryID: number; key: string }
    | { kind: "local"; file: TFile; link: string }
    | null;

/**
 * The source note a link points at, if a click on it should open an
 * attachment. Reads only what Obsidian has already indexed.
 */
export function sourceNoteTarget(
    app: App,
    linktext: string,
    sourcePath: string,
    newLeaf: unknown,
): SourceNoteTarget {
    // Not a link in a note, or the user asked where to open it.
    if (!sourcePath || newLeaf) return null;
    const { path, subpath } = parseLinktext(linktext);
    if (subpath) return null;
    const file = app.metadataCache.getFirstLinkpathDest(path, sourcePath);
    if (!(file instanceof TFile) || file.extension !== "md") return null;
    // A link within the note itself.
    if (file.path === sourcePath) return null;

    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    const key: unknown = fm?.["zotero-key"];
    const libraryID: unknown = fm?.["library-id"];
    if (typeof key === "string" && typeof libraryID === "number") {
        return { kind: "library", libraryID, key };
    }
    const local: unknown = fm?.["zotflow-local-attachment"];
    if (typeof local === "string") return { kind: "local", file, link: local };
    return null;
}

/** Open the vault file a local source note is about. */
async function openLocalAttachment(
    app: App,
    note: TFile,
    link: string,
): Promise<boolean> {
    const linkPath = link.replace(/\[\[|\]\]/g, "").split("|")[0]?.trim() ?? "";
    const dest = app.metadataCache.getFirstLinkpathDest(linkPath, note.path);
    if (!dest) return false;
    const existing = app.workspace
        .getLeavesOfType(LOCAL_ZOTERO_READER_VIEW_TYPE)
        .find(
            (leaf) =>
                (leaf.view.getState() as { file?: string } | undefined)
                    ?.file === dest.path,
        );
    const leaf = existing ?? newReaderLeaf(app);
    if (!existing) await leaf.openFile(dest);
    await app.workspace.revealLeaf(leaf);
    app.workspace.setActiveLeaf(leaf, { focus: true });
    return true;
}

/** Open the attachment behind a source note. False: open the note after all. */
async function openTarget(app: App, target: SourceNoteTarget): Promise<boolean> {
    if (!target) return false;
    if (target.kind === "library") {
        return openItemPrimaryAttachment(target.libraryID, target.key, app, {
            quiet: true,
        });
    }
    return openLocalAttachment(app, target.file, target.link);
}

/** Make clicks on links to source notes open the attachment (see above). */
export function registerSourceNoteLinks(plugin: Plugin): void {
    const { app } = plugin;
    plugin.register(
        around(app.workspace, {
            openLinkText(next: OpenLinkText): OpenLinkText {
                return async function (
                    this: Workspace,
                    linktext,
                    sourcePath,
                    newLeaf,
                    openViewState,
                ) {
                    try {
                        if (services.settings.evoSourceLinksOpenAttachment) {
                            const target = sourceNoteTarget(
                                app,
                                linktext,
                                sourcePath,
                                newLeaf,
                            );
                            if (await openTarget(app, target)) return;
                        }
                    } catch (error) {
                        services.logService.error(
                            "Failed to open the attachment behind a source note link; opening the note",
                            "EvoSourceLinks",
                            error,
                        );
                    }
                    return next.call(
                        this,
                        linktext,
                        sourcePath,
                        newLeaf,
                        openViewState,
                    );
                };
            },
        }),
    );
}
