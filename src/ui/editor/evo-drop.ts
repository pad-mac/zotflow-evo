/**
 * ZotFlow Evo (fork): what a comment or a highlight dragged out of the
 * reader becomes when it is dropped into a note.
 *
 *   before + body + " " + reference + after
 *
 * - `body` is the highlighted text in quotation marks (a highlight or
 *   selected text dragged from the page) or the comment (dragged from the
 *   note strip).
 * - `reference` is one template for both (settings): by default author,
 *   year, short title and page in brackets, linked to the place in the
 *   document (a PDF or a snapshot; a snapshot has no page).
 * - `before` and `after` are set per annotation colour, in one table for
 *   highlights and one for comments.
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

/** Opening and closing mark around dropped highlight text. */
const QUOTE_OPEN = "“";
const QUOTE_CLOSE = "”";

const EMPTY_AFFIXES: EvoDropAffixes = { before: "", after: "" };

/** What an affix can refer to. */
const AFFIX_FIELDS = ["cite", "page", "link", "text", "comment", "color"] as const;
type AffixField = (typeof AFFIX_FIELDS)[number];
const AFFIX_PATTERN = new RegExp(
    `\\{\\{\\s*(${AFFIX_FIELDS.join("|")})\\s*\\}\\}`,
    "g",
);
/** An affix that places the reference (or the bare link) itself. */
const PLACES_REFERENCE = /\{\{\s*(?:cite|link)\s*\}\}/;

/** The text the settings put around a drop of this colour. */
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
 * The link that opens the document at an annotation, or — for selected text
 * that is not an annotation — at its place: the page of a PDF, the passage
 * of a snapshot.
 */
export function readerLink(annotation: AnnotationJSON): string {
    const libraryID = annotation.libraryID;
    if (annotation.id) {
        return `obsidian://zotflow?type=open-annotation&libraryID=${libraryID}&key=${annotation.id}`;
    }
    // A place in a PDF has a page; in a snapshot it is a selector, which the
    // reader takes as it is.
    const position: unknown = annotation.position;
    const pageIndex = (position as { pageIndex?: unknown } | undefined)
        ?.pageIndex;
    const place =
        typeof pageIndex === "number" || !position
            ? { pageIndex: typeof pageIndex === "number" ? pageIndex : 0 }
            : { position };
    const navigation = encodeURIComponent(JSON.stringify(place));
    return `obsidian://zotflow?type=open-attachment&libraryID=${libraryID}&key=${annotation.parentItem ?? ""}&navigation=${navigation}`;
}

/**
 * One drop, put together.
 *
 * @param source What was dragged: the highlight itself, or its comment.
 * @param reference The rendered reference template.
 * @param affixes The text set for the annotation's colour. `{{cite}}`,
 *   `{{page}}`, `{{link}}`, `{{text}}`, `{{comment}}` and `{{color}}` are
 *   filled in; an affix that places `{{cite}}` or `{{link}}` itself keeps the
 *   reference from being added after the body.
 */
export function composeDrop(
    source: "highlight" | "comment",
    annotation: AnnotationJSON,
    reference: string,
    affixes: EvoDropAffixes,
): string {
    const text = (annotation.text ?? "").trim();
    const comment = (annotation.comment ?? "").trim();
    const values: Record<AffixField, string> = {
        cite: reference,
        page: annotation.pageLabel ?? "",
        link: readerLink(annotation),
        text,
        comment,
        color: annotation.color ?? "",
    };
    const fill = (affix: string) =>
        affix.replace(AFFIX_PATTERN, (_match, name: AffixField) => values[name]);

    let body = comment;
    if (source === "highlight") {
        // An image or ink annotation has no text to quote.
        body = text ? QUOTE_OPEN + text + QUOTE_CLOSE : "";
    }
    const placesReference = PLACES_REFERENCE.test(
        affixes.before + affixes.after,
    );
    const parts = [body];
    if (!placesReference && reference) parts.push(reference);
    return (
        fill(affixes.before) +
        parts.filter(Boolean).join(" ") +
        fill(affixes.after)
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

async function renderReference(
    payload: ZotFlowCitationPayload,
    annotation: AnnotationJSON,
    template: string,
): Promise<string> {
    if (!template.trim()) return "";
    // Imported late: `citation-helper.ts`, which calls into this module, is
    // also loaded where the worker bridge is not (its unit tests).
    const { workerBridge } = await import("bridge");
    const out = await workerBridge.displayTitle.renderTemplate(
        payload.libraryID,
        payload.key,
        template,
        {
            text: (annotation.text ?? "").trim(),
            comment: (annotation.comment ?? "").trim(),
            // Left out when there is none (a snapshot has no pages), so that
            // a template can test for it: to Liquid an empty text is true.
            page: annotation.pageLabel || undefined,
            link: readerLink(annotation),
            color: annotation.color ?? "",
            annotation,
        },
    );
    return out.trim();
}

async function resolveReaderDrop(
    payload: ZotFlowCitationPayload,
): Promise<string> {
    const source = payload.evoSource === "comment" ? "comment" : "highlight";
    const settings = services.settings;
    const table =
        source === "comment"
            ? settings.evoCommentDrop
            : settings.evoHighlightDrop;
    const lines: string[] = [];
    for (const annotation of payload.annotations ?? []) {
        // A comment drag of an annotation without a comment drops nothing.
        if (source === "comment" && !(annotation.comment ?? "").trim()) {
            continue;
        }
        const reference = await renderReference(
            payload,
            annotation,
            settings.evoDropLinkTemplate,
        );
        lines.push(
            composeDrop(
                source,
                annotation,
                reference,
                affixesForColor(table, annotation.color),
            ),
        );
    }
    return lines.filter(Boolean).join("\n");
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

    const pos = editor.getCursor();
    const baselineDoc = editor.getValue();
    resolveReaderDrop(payload)
        .then((text) => {
            if (!text) return;
            // The reference rendered in the worker; if the note changed in
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
                "Could not insert the dropped text. Check the reference template in the settings.",
            );
        });
    return true;
}
