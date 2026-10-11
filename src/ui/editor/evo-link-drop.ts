/**
 * ZotFlow Evo (fork): items dragged out of the library browser are dropped
 * into a note as links to their source notes — one link at the cursor, any
 * further ones each on a line of its own below. In a list (or a quote) the
 * further lines continue it.
 *
 * A drop with a modifier key held is left to the citation formats of
 * `citation-helper.ts`. See FORK.md.
 */
import { TFile } from "obsidian";

import { services } from "services/services";

import type { Editor, MarkdownFileInfo, MarkdownView } from "obsidian";

/** MIME type of the drag payload the library browser sets. */
export const ZOTFLOW_SOURCE_LINKS_MIME = "application/zotflow-source-links";

/** What a drag from the library browser carries. */
export interface SourceLinksPayload {
    type: "zotflow-source-links";
    items: { libraryID: number; key: string }[];
}

export function parseSourceLinksPayload(raw: string): SourceLinksPayload | null {
    try {
        const parsed = JSON.parse(raw) as Partial<SourceLinksPayload> | null;
        if (parsed?.type !== "zotflow-source-links") return null;
        if (!Array.isArray(parsed.items)) return null;
        const items = parsed.items.filter(
            (item) =>
                typeof item?.libraryID === "number" &&
                typeof item.key === "string",
        );
        return items.length ? { type: "zotflow-source-links", items } : null;
    } catch {
        return null;
    }
}

/**
 * How the line the links are dropped into goes on: its quote markers and
 * indentation, and its list marker if it is a list item.
 */
function continuation(line: string): (index: number) => string {
    const match =
        /^((?:\s*>)*\s*)(?:([-*+])|(\d+)([.)]))(\s+)(\[.\]\s+)?/.exec(line);
    if (!match) {
        // No list: only quote markers and indentation carry over.
        const lead = /^((?:\s*>)*\s*)/.exec(line)?.[1] ?? "";
        return () => lead;
    }
    const [, lead = "", bullet, number, delimiter = ".", gap = " ", task] = match;
    const box = task ? "[ ] " : "";
    if (bullet) return () => `${lead}${bullet}${gap}${box}`;
    const first = Number.parseInt(number ?? "1", 10);
    return (index) => `${lead}${first + index}${delimiter}${gap}${box}`;
}

/**
 * What to insert for `links` dropped into `line`: the first link goes where
 * the drop is, the others on new lines after that line.
 */
export function planLinkDrop(
    line: string,
    links: string[],
): { atCursor: string; afterLine: string } {
    const [first = "", ...rest] = links;
    const prefix = continuation(line);
    return {
        atCursor: first,
        afterLine: rest.map((link, i) => `\n${prefix(i + 1)}${link}`).join(""),
    };
}

/** The link to an item's source note, creating the note if it has none yet. */
async function sourceNoteLink(
    item: { libraryID: number; key: string },
    sourcePath: string,
): Promise<string | null> {
    let path = services.indexService.getFileByKey(item.key)?.path;
    if (!path) {
        const { workerBridge } = await import("bridge");
        path = await workerBridge.libraryNote.ensureNotePath(
            item.libraryID,
            item.key,
        );
    }
    if (!path) return null;
    const file = services.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
        // As the user's settings write links (wikilink or markdown, path form).
        return services.app.fileManager.generateMarkdownLink(file, sourcePath);
    }
    // Just created and not in the vault's index yet.
    return `[[${path.replace(/\.md$/i, "")}]]`;
}

/**
 * Handle the drop of items dragged out of the library browser. Returns false
 * when the drop is not one (or a modifier key asks for a citation format).
 */
export function handleSourceLinkDrop(
    evt: DragEvent,
    editor: Editor,
    info: MarkdownView | MarkdownFileInfo,
): boolean {
    if (evt.defaultPrevented) return false;
    if (evt.shiftKey || evt.ctrlKey || evt.metaKey || evt.altKey) return false;
    const raw = evt.dataTransfer?.getData(ZOTFLOW_SOURCE_LINKS_MIME);
    const payload = raw ? parseSourceLinksPayload(raw) : null;
    if (!payload) return false;

    evt.preventDefault();
    const pos = editor.getCursor();
    const baselineDoc = editor.getValue();
    const sourcePath = info.file?.path ?? "";

    (async () => {
        const links: string[] = [];
        let failed = 0;
        for (const item of payload.items) {
            try {
                const link = await sourceNoteLink(item, sourcePath);
                if (link) links.push(link);
                else failed += 1;
            } catch (error) {
                failed += 1;
                services.logService.error(
                    `Failed to link the source note of ${item.libraryID}/${item.key}`,
                    "EvoLinkDrop",
                    error,
                );
            }
        }
        if (failed) {
            services.notificationService.notify(
                "warning",
                failed === 1
                    ? "One item has no source note and could not get one."
                    : `${failed} items have no source note and could not get one.`,
            );
        }
        if (!links.length) return;

        // The notes may have been created meanwhile; if this note changed,
        // insert where the cursor is now.
        const at = editor.getValue() === baselineDoc ? pos : editor.getCursor();
        const plan = planLinkDrop(editor.getLine(at.line), links);
        editor.replaceRange(plan.atCursor, at);
        const lineEnd = { line: at.line, ch: editor.getLine(at.line).length };
        editor.replaceRange(plan.afterLine, lineEnd);
        const end = editor.posToOffset(lineEnd) + plan.afterLine.length;
        editor.setCursor(editor.offsetToPos(end));
    })().catch((error) => {
        services.logService.error(
            "Failed to insert source note links",
            "EvoLinkDrop",
            error,
        );
        services.notificationService.notify(
            "error",
            "Could not insert the links.",
        );
    });
    return true;
}
