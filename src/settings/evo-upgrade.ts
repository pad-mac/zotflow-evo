/**
 * ZotFlow Evo (fork): settings stored by an earlier build of the fork, brought
 * up to date when they are loaded. See FORK.md.
 */
import {
    DEFAULT_DROP_LINK_TEMPLATE,
    PREVIOUS_DROP_LINK_TEMPLATES,
} from "settings/types";

import {
    DEFAULT_ATTACH_FILENAME,
    DEFAULT_COLLECTION_COLUMNS,
    PREVIOUS_ATTACH_FILENAMES,
} from "utils/evo-library-model";

/** The collection tab's columns until beta.9 (no annotation count). */
const PREVIOUS_COLLECTION_COLUMNS = ["title", "creator", "year", "attachment"];

import type { ZotFlowSettings } from "settings/types";

/**
 * Change `settings` in place where an earlier default was stored. Settings
 * are saved whole, so a default that was never touched is in data.json like
 * any other value; it is recognised by being exactly an earlier default.
 */
export function upgradeEvoSettings(settings: ZotFlowSettings): void {
    if (PREVIOUS_DROP_LINK_TEMPLATES.includes(settings.evoDropLinkTemplate)) {
        settings.evoDropLinkTemplate = DEFAULT_DROP_LINK_TEMPLATE;
    }
    if (PREVIOUS_ATTACH_FILENAMES.includes(settings.evoAttachFilename)) {
        settings.evoAttachFilename = DEFAULT_ATTACH_FILENAME;
    }
    const columns = settings.evoCollectionColumns;
    if (
        Array.isArray(columns) &&
        columns.join() === PREVIOUS_COLLECTION_COLUMNS.join()
    ) {
        settings.evoCollectionColumns = [...DEFAULT_COLLECTION_COLUMNS];
    }
    // Until beta.9 one page filter for all PDFs; now one per PDF.
    delete (settings as unknown as Record<string, unknown>).readerPdfFilter;
}
