import {
    Editor,
    EditorSuggest,
    MarkdownView,
    TFile,
    type EditorPosition,
    type EditorSuggestContext,
    type EditorSuggestTriggerInfo,
} from "obsidian";
import { services } from "services/services";
import { workerBridge } from "bridge";
import type { AnyIDBZoteroItem } from "types/db-schema";
import type { CitationFormat } from "settings/types";
import {
    ZoteroItemSuggest,
    type SuggestionItem,
} from "ui/modals/zotero-item-suggest";
import { insertCitationResult } from "ui/editor/citation-helper";
import { takesPlace, type CitationPlace } from "services/citation-service";
import { locatorTerm, parseLocator } from "utils/evo-footnotes";
import { LatestOnly } from "utils/latest-only";

const DEFAULT_TRIGGER = "@@";

/**
 * ZotFlow Evo: the picker's second step — the work chosen, the page (or
 * range, or nothing) typed after the trigger; Enter inserts it.
 */
interface PlaceRow {
    isPlace: true;
    item: AnyIDBZoteroItem;
}

type PickerRow = SuggestionItem | PlaceRow;

/** What is typed in the page step, read as Pandoc reads a locator. */
export function placeFromQuery(query: string): CitationPlace {
    return query.trim()
        ? parseLocator(query, { asked: true })
        : { locator: null, suffix: "" };
}

/** The page step's preview of a place ("p. 23", "pp. 23–25, emphasis added"). */
export function describePlace(place: CitationPlace): string {
    const loc = place.locator
        ? `${locatorTerm(place.locator.label, place.locator.locator)} ${place.locator.locator}`
        : "";
    return `${loc}${place.suffix}`.replace(/^,\s*/, "");
}

/**
 * Inline EditorSuggest for inserting Zotero citations.
 * Auto-triggers when the user types the configured trigger (default `@@`) in the editor.
 * Also triggered via the "Insert Citation" command.
 *
 * ZotFlow Evo: one way in — Enter picks a work, then (for a format that
 * takes one) the page: typed after the trigger, Enter again inserts it, or
 * inserts without one when nothing is typed. The format is the default
 * one (settings).
 */
export class CitationSuggest extends EditorSuggest<PickerRow> {
    private manualTriggerStart: EditorPosition | null = null;
    private readonly suggest = new ZoteroItemSuggest();
    private readonly latest = new LatestOnly();
    /** The page step: the work chosen, where its trigger starts. */
    private picked: { item: AnyIDBZoteroItem; at: EditorPosition } | null = null;

    private resolveInsertionAnchor(
        editor: Editor,
        preferredPos: EditorPosition,
        baselineDoc: string,
    ): EditorPosition {
        return editor.getValue() === baselineDoc
            ? preferredPos
            : editor.getCursor();
    }

    private get triggerPrefix(): string {
        return services.settings.citationTrigger || DEFAULT_TRIGGER;
    }

    constructor() {
        super(services.app);
        this.limit = 20;
    }

    /** Called from the "Insert Citation" command to open the suggest popup. */
    triggerManually(): void {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return;
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) return;

        const cursor = view.editor.getCursor();
        const t = this.triggerPrefix;
        view.editor.replaceRange(t, cursor);
        view.editor.setCursor({ line: cursor.line, ch: cursor.ch + t.length });
        this.manualTriggerStart = cursor;
        this.trigger(view.editor, activeFile, true);
    }

    onTrigger(
        cursor: EditorPosition,
        editor: Editor,
        _file: TFile | null,
    ): EditorSuggestTriggerInfo | null {
        const line = editor.getLine(cursor.line);
        const textBefore = line.substring(0, cursor.ch);
        const t = this.triggerPrefix;

        // The page step: only while the cursor stays after the chosen
        // work's trigger.
        if (this.picked) {
            const at = this.picked.at;
            if (
                cursor.line !== at.line ||
                cursor.ch < at.ch + t.length ||
                line.substring(at.ch, at.ch + t.length) !== t
            ) {
                this.picked = null;
                return null;
            }
            return {
                start: { line: at.line, ch: at.ch + t.length },
                end: cursor,
                query: textBefore.substring(at.ch + t.length),
            };
        }

        // Find the last occurrence of the trigger before the cursor
        const triggerIdx = textBefore.lastIndexOf(t);
        if (triggerIdx === -1) return null;

        const query = textBefore.substring(triggerIdx + t.length);
        return {
            start: { line: cursor.line, ch: triggerIdx + t.length },
            end: cursor,
            query,
        };
    }

    getSuggestions(context: EditorSuggestContext): Promise<PickerRow[]> {
        if (this.picked) {
            const row: PlaceRow = { isPlace: true, item: this.picked.item };
            return this.latest.run(Promise.resolve([row]));
        }
        return this.latest.run(this.suggest.getSuggestions(context.query, 20));
    }

    renderSuggestion(item: PickerRow, el: HTMLElement): void {
        if ("isPlace" in item) {
            this.renderPlace(item, el, this.context?.query ?? "");
            return;
        }
        this.suggest.renderSuggestion(item, el, this.context?.query ?? "");
    }

    /** The page step's row: the work, and the page as it will go in. */
    private renderPlace(row: PlaceRow, el: HTMLElement, query: string): void {
        const label = activeWindow.createDiv({
            cls: "zotflow-suggestion-group-label",
            text: "Page",
        });
        if (el.parentElement) el.before(label);
        else el.prepend(label);

        el.addClass("zotflow-search-item", "zotflow-place-row");
        const content = el.createDiv({ cls: "zotflow-item-content" });
        const item = row.item;
        const title =
            this.suggest.displayTitles[`${item.libraryID}:${item.key}`] ||
            item.title ||
            "Untitled";
        content
            .createDiv({ cls: "zotflow-row-top" })
            .createDiv({ cls: "zotflow-title", text: title });
        const bottom = content.createDiv({ cls: "zotflow-row-bottom" });
        const place = describePlace(placeFromQuery(query));
        if (place) {
            bottom.createDiv({ cls: "zotflow-meta zotflow-place", text: place });
        } else {
            bottom.createDiv({
                cls: "zotflow-meta zotflow-place-hint",
                text: "Page or range, then ↵ — or ↵ without one",
            });
        }
    }

    selectSuggestion(suggestion: PickerRow, _evt: MouseEvent | KeyboardEvent): void {
        if (!this.context) return;
        if ("isEmpty" in suggestion || "isValueCompletion" in suggestion) return;

        const format: CitationFormat = services.settings.defaultCitationFormat;

        // Second Enter: in with the page typed, or none.
        if ("isPlace" in suggestion) {
            const place = placeFromQuery(this.context.query);
            this.insertCitation(suggestion.item, format, place);
            return;
        }

        const item = suggestion;
        if (!takesPlace(format)) {
            this.insertCitation(item, format);
            return;
        }

        // First Enter: the work; now the page. What was typed to find it
        // goes; the trigger stays, the page is typed after it.
        const { start, end, editor, file } = this.context;
        const at: EditorPosition = { line: start.line, ch: start.ch - this.triggerPrefix.length };
        this.picked = { item, at };
        workerBridge.dbHelper.updateLastAccessed(item.libraryID, item.key).catch(() => {});
        editor.replaceRange("", start, end);
        editor.setCursor(start);
        this.trigger(editor, file, true);
    }

    close(): void {
        if (this.context) {
            const { end, editor } = this.context;
            if (this.picked) {
                // Left the page step without inserting: its trigger and the
                // page typed go (the work typed to find it went already).
                const from = this.picked.at;
                const t = this.triggerPrefix;
                if (editor.getLine(from.line).substring(from.ch, from.ch + t.length) === t)
                    editor.replaceRange("", from, end.line === from.line ? end : { line: from.line, ch: from.ch + t.length });
            } else if (this.manualTriggerStart) {
                // Manually triggered and dismissed: the trigger it put in goes.
                editor.replaceRange("", this.manualTriggerStart, end);
            }
        }
        this.picked = null;
        this.manualTriggerStart = null;
        super.close();
    }

    // --- Helpers ---

    /** Dispatch a citation insertion for the given item and format. */
    private insertCitation(
        item: AnyIDBZoteroItem,
        format: CitationFormat,
        place?: CitationPlace,
    ): void {
        // Update last accessed timestamp (fire & forget)
        workerBridge.dbHelper
            .updateLastAccessed(item.libraryID, item.key)
            .catch(() => {});

        if (!this.context) return;

        const { start, end, editor } = this.context;

        // Compute replacement range before closing (start.ch points after the trigger)
        const replaceStart: EditorPosition = {
            line: start.line,
            ch: start.ch - this.triggerPrefix.length,
        };

        // Dismiss the popup (nothing for close() to clean up: done here)
        this.manualTriggerStart = null;
        this.picked = null;
        this.close();

        // Clear the trigger text immediately, then async-resolve the citation
        editor.replaceRange("", replaceStart, end);
        const baselineDoc = editor.getValue();

        services.citationService
            .resolve({ libraryID: item.libraryID, key: item.key }, format, place)
            .then((result) => {
                if (result) {
                    const insertPos = this.resolveInsertionAnchor(
                        editor,
                        replaceStart,
                        baselineDoc,
                    );
                    insertCitationResult(editor, insertPos, result);
                }
            })
            .catch((error) => {
                services.logService.error(
                    "Failed to resolve citation",
                    "CitationSuggest",
                    error,
                );
                services.notificationService.notify(
                    "error",
                    "Failed to insert citation.",
                );
            });
    }
}
