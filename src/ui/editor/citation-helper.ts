import { services } from "services/services";
import { takeDropPosition } from "ui/editor/drop-position";
import { formatCluster, parseCluster, scanFootnotes } from "utils/evo-footnotes";
import { handleReaderDrop } from "ui/editor/evo-drop";
import { handleSourceLinkDrop } from "ui/editor/evo-link-drop";

import type {
    Editor,
    EditorPosition,
    MarkdownView,
    MarkdownFileInfo,
} from "obsidian";
import type { CitationFormat } from "settings/types";
import type { CitationResult } from "services/citation-service";
import type { AnnotationJSON } from "types/zotero-reader";

/** Custom MIME type used in dataTransfer for ZotFlow citation payloads. */
export const ZOTFLOW_CITATION_MIME = "application/zotflow-citation";

/** Structured payload carried via dataTransfer for citation drag-drop. */
export interface ZotFlowCitationPayload {
    type: "zotflow-citation";
    libraryID: number;
    key: string;
    /** Stripped annotations — only template-relevant fields, no binary/position data. */
    annotations?: AnnotationJSON[];
    /**
     * ZotFlow Evo: set on drags that start in the reader — a comment from the
     * note strip, or a highlight or text selection from the page.
     */
    evoSource?: "comment" | "highlight";
}

function resolveInsertionAnchor(
    editor: Editor,
    preferredPos: EditorPosition,
    baselineDoc: string,
): EditorPosition {
    return editor.getValue() === baselineDoc
        ? preferredPos
        : editor.getCursor();
}

function setCursorAfterInsertedText(
    editor: Editor,
    insertOffset: number,
    insertedText: string,
): void {
    const endOffset = insertOffset + insertedText.length;
    editor.setCursor(editor.offsetToPos(endOffset));
}

/**
 * Strip an AnnotationJSON down to the fields needed by citation templates.
 * Removes heavy/non-serializable data (image, position, sortIndex, etc.)
 * so the result is safe for dataTransfer / clipboard payloads.
 */
export function stripAnnotationForPayload(
    annotation: AnnotationJSON,
): AnnotationJSON {
    return {
        id: annotation.id,
        libraryID: annotation.libraryID,
        parentItem: annotation.parentItem,
        type: annotation.type,
        text: annotation.text,
        comment: annotation.comment,
        color: annotation.color,
        pageLabel: annotation.pageLabel,
        authorName: annotation.authorName,
        tags: annotation.tags,
        dateAdded: annotation.dateAdded,
        dateModified: annotation.dateModified,
        // Provide a minimal position to satisfy the required field
        position: { pageIndex: annotation.position.pageIndex, rects: [] },
    };
}

/**
 * Safely parse and validate a raw string as a ZotFlowCitationPayload.
 * Returns `null` if the string is not valid JSON or doesn't match the expected shape.
 */
export function parseZotFlowCitationPayload(
    raw: string,
): ZotFlowCitationPayload | null {
    try {
        const parsed: unknown = JSON.parse(raw);
        if (
            typeof parsed === "object" &&
            parsed !== null &&
            "type" in parsed &&
            (parsed as Record<string, unknown>).type === "zotflow-citation" &&
            "libraryID" in parsed &&
            typeof (parsed as Record<string, unknown>).libraryID === "number" &&
            "key" in parsed &&
            typeof (parsed as Record<string, unknown>).key === "string"
        ) {
            const obj = parsed as ZotFlowCitationPayload;
            return {
                type: obj.type,
                libraryID: obj.libraryID,
                key: obj.key,
                annotations: obj.annotations,
                evoSource:
                    obj.evoSource === "comment" || obj.evoSource === "highlight"
                        ? obj.evoSource
                        : undefined,
            };
        }
    } catch {
        // Invalid JSON — fall through
    }
    return null;
}

/**
 * The citation format of a drop (a highlight or comment from the reader, an
 * item from the library) from the keys held:
 * - Ctrl/Cmd + Shift → citekey
 * - Shift            → footnote (ZotFlow Evo: a numbered footnote at the
 *                      drop, Pandoc's citation with the page as its text)
 * - Alt              → wikilink (ZotFlow Evo: Shift's before)
 * - Ctrl/Cmd         → footnote
 * - (none)           → settings default
 */
export function resolveFormatFromModifiers(event: {
    shiftKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
}): CitationFormat {
    if ((event.ctrlKey || event.metaKey) && event.shiftKey) return "citekey";
    if (event.shiftKey) return "footnote";
    if (event.altKey) return "wikilink";
    if (event.ctrlKey || event.metaKey) return "footnote";
    return services.settings.defaultCitationFormat;
}

/**
 * Split a rendered footnote-definition block into individual definitions.
 * Each definition starts at a line beginning with `[^marker]:` and runs until
 * the next such line (or end of string), so multi-line definition bodies are
 * preserved. Returns `[{ marker: "", text }]` when no marker is found.
 */
function parseFootnoteDefinitions(
    footnoteDef: string,
): { marker: string; text: string }[] {
    const re = /^\[\^([^\]]+)\]:/gm;
    const starts: { marker: string; index: number }[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(footnoteDef)) !== null) {
        starts.push({ marker: m[1] ?? "", index: m.index });
    }
    if (starts.length === 0) {
        return [{ marker: "", text: footnoteDef.trimEnd() }];
    }
    const defs: { marker: string; text: string }[] = [];
    for (let i = 0; i < starts.length; i++) {
        const cur = starts[i];
        if (!cur) continue;
        const next = starts[i + 1];
        const end = next ? next.index : footnoteDef.length;
        defs.push({
            marker: cur.marker,
            text: footnoteDef.slice(cur.index, end).trimEnd(),
        });
    }
    return defs;
}

/**
 * Insert a resolved citation result into an editor at a given position.
 * Handles footnote definition appending when applicable.
 */
export function insertCitationResult(
    editor: Editor,
    pos: EditorPosition,
    result: CitationResult,
): void {
    // ZotFlow Evo: numbered footnotes.
    if (result.evoCite && result.footnoteDef) {
        insertNumberedCitation(editor, pos, result);
        return;
    }
    const insertOffset = editor.posToOffset(pos);
    editor.replaceRange(result.citation, pos);

    if (result.footnoteDef) {
        // A rendered definition block may contain several `[^marker]:` entries
        // (one per annotation). Append only the definitions whose marker is not
        // already present in the document, so repeated inserts don't duplicate.
        const editorContent = editor.getValue();
        const missing = parseFootnoteDefinitions(result.footnoteDef).filter(
            (def) => {
                const prefix = def.marker
                    ? `[^${def.marker}]:`
                    : `[^${result.citekey}]:`;
                return (
                    !editorContent.includes(`\n${prefix}`) &&
                    !editorContent.startsWith(prefix)
                );
            },
        );

        if (missing.length > 0) {
            const block = missing.map((def) => def.text).join("\n");
            const lastLine = editor.lastLine();
            const lastLineText = editor.getLine(lastLine);
            const prefix = lastLineText.length > 0 ? "\n" : "";
            editor.replaceRange(`${prefix}${block}\n`, {
                line: lastLine,
                ch: lastLineText.length,
            });
        }
    }

    setCursorAfterInsertedText(editor, insertOffset, result.citation);
}

/**
 * Handler for Obsidian's `editor-drop` workspace event.
 * Intercepts drops carrying a ZotFlow citation payload, resolves the citation
 * asynchronously, and inserts it at the drop position.
 */
export function handleEditorDrop(
    evt: DragEvent,
    editor: Editor,
    info: MarkdownView | MarkdownFileInfo,
): void {
    if (evt.defaultPrevented) return;

    // ZotFlow Evo: items dragged out of the library browser are dropped as
    // links to their source notes; a modifier key keeps the formats below.
    if (handleSourceLinkDrop(evt, editor, info)) return;

    const raw = evt.dataTransfer?.getData(ZOTFLOW_CITATION_MIME);
    if (!raw) return;

    const payload = parseZotFlowCitationPayload(raw);
    if (!payload) return;

    evt.preventDefault();

    // ZotFlow Evo: comments and highlights dragged out of the reader have
    // their own drop templates (settings); a modifier key keeps the formats below.
    if (handleReaderDrop(evt, editor, payload)) return;

    const pos = takeDropPosition(evt, editor);
    const baselineDoc = editor.getValue();
    const format = resolveFormatFromModifiers(evt);

    services.citationService
        .resolve(payload, format)
        .then((result) => {
            if (result) {
                const insertPos = resolveInsertionAnchor(
                    editor,
                    pos,
                    baselineDoc,
                );
                insertCitationResult(editor, insertPos, result);
            }
        })
        .catch((error) => {
            services.logService.error(
                "Failed to resolve citation on drop",
                "EditorDrop",
                error,
            );
            services.notificationService.notify(
                "error",
                "Failed to insert citation.",
            );
        });
}

/**
 * ZotFlow Evo: a citation footnote, its definition Pandoc's citation
 * (`[^n]: [@key, p. 23]`). Right after a footnote that cites (`[^3]` and
 * the cursor), the work joins it (`[@a, p. 2; @key, p. 23]`: one footnote,
 * several works); else a new footnote — reference and definition in one
 * step, numbered and placed by the editor (ui/editor/evo-footnotes.ts).
 */
function insertNumberedCitation(
    editor: Editor,
    pos: EditorPosition,
    result: CitationResult,
): void {
    const cites = result.evoCites ?? [result.evoCite!];
    const text = editor.getValue();
    const at = editor.posToOffset(pos);
    const before = /\[\^(\d+)\]$/.exec(text.slice(Math.max(0, at - 24), at));
    if (before) {
        const def = scanFootnotes(text).defs.find((d) => d.label === before[1]);
        const items = def ? parseCluster(def.body) : null;
        const fresh = items
            ? cites.filter((c) => !items.some((i) => i.citekey === c.citekey))
            : [];
        if (def && items && fresh.length) {
            // Written in Pandoc's form, the works before it too.
            const added = formatCluster([...items, ...fresh]);
            editor.transaction({
                changes: [
                    {
                        from: editor.offsetToPos(def.bodyFrom),
                        to: editor.offsetToPos(def.to),
                        text: added,
                    },
                ],
            });
            editor.setCursor(editor.offsetToPos(at));
            return;
        }
    }
    const endOfDoc = editor.offsetToPos(text.length);
    editor.transaction({
        changes: [
            { from: pos, text: result.citation },
            { from: endOfDoc, text: `\n\n${result.footnoteDef}\n` },
        ],
    });
    // After the reference (its label is a number now).
    const now = editor.getValue();
    const ref = /^\[\^[^\]\s^]+\]/.exec(now.slice(at));
    editor.setCursor(editor.offsetToPos(at + (ref ? ref[0].length : 0)));
}
