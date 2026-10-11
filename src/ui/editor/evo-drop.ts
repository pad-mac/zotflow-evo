/**
 * ZotFlow Evo (fork): what a comment or a highlight dragged out of the
 * reader becomes when it is dropped into a note.
 *
 * - A comment dragged from the note strip is dropped as its text, with the
 *   text the settings give for the annotation's colour before and after it,
 *   and a page number linked to the place in the PDF.
 * - A highlight (or selected text) dragged from the page is dropped through
 *   the highlight drop template: by default its text, then author, year,
 *   title and page in brackets, linked the same way.
 *
 * A drop with a modifier key held is left to the citation formats of
 * `citation-helper.ts`. See FORK.md.
 */
import { services } from "services/services";

import type { Editor } from "obsidian";
import type { EvoDropAffixes } from "settings/types";
import type { AnnotationJSON } from "types/zotero-reader";
import type { ZotFlowCitationPayload } from "ui/editor/citation-helper";

/** The eight annotation colours of the Zotero reader, in its order. */
export const ANNOTATION_COLORS: readonly { name: string; hex: string }[] = [
    { name: "Yellow", hex: "#ffd400" },
    { name: "Red", hex: "#ff6666" },
    { name: "Green", hex: "#5fb236" },
    { name: "Blue", hex: "#2ea8e5" },
    { name: "Purple", hex: "#a28ae5" },
    { name: "Magenta", hex: "#e56eee" },
    { name: "Orange", hex: "#f19837" },
    { name: "Gray", hex: "#aaaaaa" },
];

/** Added after a comment when neither affix places the link itself. */
const DEFAULT_PAGE_LINK = " [p. {{page}}]({{link}})";

const EMPTY_AFFIXES: EvoDropAffixes = { before: "", after: "" };

/** The text the settings put around a comment of this colour. */
export function affixesForColor(
    table: Record<string, EvoDropAffixes> | undefined,
    color: string | undefined,
): EvoDropAffixes {
    const entry = table?.[(color ?? "").toLowerCase()];
    return {
        before: entry?.before ?? EMPTY_AFFIXES.before,
        after: entry?.after ?? EMPTY_AFFIXES.after,
    };
}

/**
 * The link that opens the PDF at an annotation, or — for selected text that
 * is not an annotation — at its page.
 */
export function readerLink(annotation: AnnotationJSON): string {
    const libraryID = annotation.libraryID;
    if (annotation.id) {
        return `obsidian://zotflow?type=open-annotation&libraryID=${libraryID}&key=${annotation.id}`;
    }
    const navigation = encodeURIComponent(
        JSON.stringify({ pageIndex: annotation.position?.pageIndex ?? 0 }),
    );
    return `obsidian://zotflow?type=open-attachment&libraryID=${libraryID}&key=${annotation.parentItem ?? ""}&navigation=${navigation}`;
}

/** Fill `{{page}}`, `{{link}}`, `{{text}}` and `{{color}}` in an affix. */
function fillAffix(affix: string, annotation: AnnotationJSON): string {
    const values: Record<string, string> = {
        page: annotation.pageLabel ?? "",
        link: readerLink(annotation),
        text: annotation.text ?? "",
        color: annotation.color ?? "",
    };
    return affix.replace(
        /\{\{\s*(page|link|text|color)\s*\}\}/g,
        (_match, name: string) => values[name] ?? "",
    );
}

/**
 * One comment as it is dropped into a note. The linked page number follows
 * the comment unless an affix places `{{link}}` itself.
 */
export function formatCommentDrop(
    annotation: AnnotationJSON,
    table: Record<string, EvoDropAffixes> | undefined,
): string {
    const { before, after } = affixesForColor(table, annotation.color);
    const placesLink = /\{\{\s*link\s*\}\}/.test(before + after);
    const comment = (annotation.comment ?? "").trim();
    return (
        fillAffix(before, annotation) +
        comment +
        (placesLink ? "" : fillAffix(DEFAULT_PAGE_LINK, annotation)) +
        fillAffix(after, annotation)
    );
}

/**
 * Comments as plain text, for a drop that is not into a markdown editor of
 * this vault (and for the local reader, whose files have no Zotero link).
 */
export function plainCommentDrop(annotations: AnnotationJSON[]): string {
    return annotations
        .map((annotation) => (annotation.comment ?? "").trim())
        .filter(Boolean)
        .join("\n");
}

async function formatHighlightDrop(
    payload: ZotFlowCitationPayload,
    annotation: AnnotationJSON,
    template: string,
): Promise<string> {
    // Imported late: `citation-helper.ts`, which calls into this module, is
    // also loaded where the worker bridge is not (its unit tests).
    const { workerBridge } = await import("bridge");
    return workerBridge.displayTitle.renderTemplate(
        payload.libraryID,
        payload.key,
        template,
        {
            text: (annotation.text ?? "").trim(),
            comment: (annotation.comment ?? "").trim(),
            page: annotation.pageLabel ?? "",
            link: readerLink(annotation),
            color: annotation.color ?? "",
            annotation,
        },
    );
}

async function resolveReaderDrop(
    payload: ZotFlowCitationPayload,
): Promise<string> {
    const annotations = payload.annotations ?? [];
    if (payload.evoSource === "comment") {
        const table = services.settings.evoCommentDrop;
        return annotations
            .filter((annotation) => (annotation.comment ?? "").trim())
            .map((annotation) => formatCommentDrop(annotation, table))
            .join("\n");
    }
    const template = services.settings.evoHighlightDropTemplate;
    const parts: string[] = [];
    for (const annotation of annotations) {
        parts.push(await formatHighlightDrop(payload, annotation, template));
    }
    return parts.join("\n");
}

/**
 * Handle the drop of a comment or highlight dragged out of the reader.
 * Returns false when the drop is not one of these (or a modifier key asks
 * for a citation format), so the caller carries on as before.
 */
export function handleReaderDrop(
    evt: DragEvent,
    editor: Editor,
    payload: ZotFlowCitationPayload,
): boolean {
    if (!payload.evoSource || !payload.annotations?.length) return false;
    if (evt.shiftKey || evt.ctrlKey || evt.metaKey || evt.altKey) return false;
    if (
        payload.evoSource === "highlight" &&
        !services.settings.evoHighlightDropTemplate.trim()
    ) {
        return false;
    }

    const pos = editor.getCursor();
    const baselineDoc = editor.getValue();
    resolveReaderDrop(payload)
        .then((text) => {
            if (!text) return;
            // The template rendered in the worker; if the note changed in
            // the meantime, insert where the cursor is now.
            const at = editor.getValue() === baselineDoc ? pos : editor.getCursor();
            const offset = editor.posToOffset(at);
            editor.replaceRange(text, at);
            editor.setCursor(editor.offsetToPos(offset + text.length));
        })
        .catch((error) => {
            services.logService.error(
                "Failed to insert a comment or highlight dropped from the reader",
                "EvoDrop",
                error,
            );
            services.notificationService.notify(
                "error",
                "Could not insert the dropped text. Check the drop template in the settings.",
            );
        });
    return true;
}
