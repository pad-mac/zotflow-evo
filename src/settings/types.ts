import {
    DEFAULT_ANNOTATION_LAYOUT,
    DEFAULT_ATTACH_FILENAME,
    DEFAULT_BOOK_SEARCH_URL,
    DEFAULT_COLLECTION_COLUMNS,
    DEFAULT_LIBRARY_COLUMNS,
} from "utils/evo-library-model";

import { DEFAULT_FULLTEXT_LAYOUT } from "utils/evo-fulltext";

import type { CustomReaderTheme } from "types/zotero-reader";
import type { AnnotationLayout } from "utils/evo-library-model";
import type { FulltextLayout } from "utils/evo-fulltext";
import type { PdfFilter } from "utils/evo-pdf-filter";
import type { OutputFormat as CslOutputFormat } from "worker/csl";

/** Per-library sync mode. */
export type LibrarySyncMode = "bidirectional" | "readonly" | "ignored";

/** Reader color scheme mode. */
export type ReaderColorScheme =
    "light" | "dark" | "obsidian" | "obsidian-theme";

/** Sort order for collections in the tree view. */
export type CollectionSortOrder = "name-asc" | "name-desc";

/** Sort order for items in the tree view. */
export type ItemSortOrder =
    | "title-asc"
    | "title-desc"
    | "modified-new"
    | "modified-old"
    | "added-new"
    | "added-old";

/** Citation insertion format. */
export type CitationFormat = "pandoc" | "footnote" | "wikilink" | "citekey";

/** Auto-copy mode applied when a new annotation is created in the reader. */
export type AutoCopyAnnotationMode = "off" | "embed" | "text" | "citation";

/** Per-library sync configuration. */
export interface LibraryConfig {
    mode: LibrarySyncMode;
}

/** Full plugin settings shape persisted to `data.json`. */
export interface ZotFlowSettings {
    zoteroapikey: string;
    librariesConfig: Record<string, LibraryConfig>;
    syncInterval: number; // in minutes
    autoSync: boolean;
    useWebDav: boolean;
    webDavUrl?: string;
    webDavUser?: string;
    webdavpassword?: string;
    useCache: boolean;
    maxCacheSizeMB: number;
    librarySourceNoteTemplatePath: string;
    localSourceNoteTemplatePath: string;
    localSourceNoteFolder: string;
    localSidecarFolder: string;
    sourceNoteFolder: string;
    librarySourceNotePathTemplate: string;
    localSourceNotePathTemplate: string;
    autoImportAnnotationImages: boolean;
    annotationImageFolder: string;
    overwriteViewer: boolean;
    readerColorScheme: ReaderColorScheme;
    defaultLightTheme: string;
    defaultDarkTheme: string;
    treeCollectionSort: CollectionSortOrder;
    treeItemSort: ItemSortOrder;
    treeSingleClickOpen: boolean;
    /** LiquidJS template for item titles in the tree and search; "" shows the Zotero title. */
    itemDisplayTitleTemplate: string;
    convertNoteLinks: boolean;
    linkedAttachmentBaseDir: string;
    useZoteroStorage: boolean;
    zoteroStoragePath: string;
    defaultEditableRegionLocked: boolean;
    hideEditableRegionMarkers: boolean;
    alwaysOpenChildNoteInEditor: boolean;
    defaultCitationFormat: CitationFormat;
    citationTrigger: string;
    citationPandocTemplate: string;
    citationFootnoteRefTemplate: string;
    citationFootnoteTemplate: string;
    citationWikilinkTemplate: string;
    autoCopyAnnotation: AutoCopyAnnotationMode;
    autoUpdateSourceNotesAfterSync: boolean;
    autoPurgeTrashedSourceNotes: boolean;
    autoDisableNoteImageTextTools: boolean;
    epubFontFamily: string;
    /** ZotFlow Evo: reader toolbar hidden (toggled from the view header). */
    readerToolbarHidden: boolean;
    /** ZotFlow Evo: note strip beside PDFs shown (toggled from the view header). */
    readerNoteStripVisible: boolean;
    /**
     * ZotFlow Evo: note strip as a list (a column of its own); off, every
     * entry sits beside its place on the page and the strip scrolls with it.
     */
    readerNoteStripList: boolean;
    /** ZotFlow Evo: the note strip also lists the highlights themselves, not only comments. */
    readerNoteStripHighlights: boolean;
    /** ZotFlow Evo: width of the note strip in pixels. */
    readerNoteStripWidth: number;
    /**
     * ZotFlow Evo: LiquidJS template for the line pinned above the note strip.
     * Unused since 1.7.1-beta.6 (the head shows authors, year and title).
     */
    readerNoteStripBanner: string;
    /**
     * ZotFlow Evo: text put before and after a comment dragged from the note
     * strip into a note, per annotation colour (lower-case hex, e.g. "#ffd400").
     */
    evoCommentDrop: Record<string, EvoDropAffixes>;
    /** ZotFlow Evo: the same for a highlight (or selected text) dragged from the reader. */
    evoHighlightDrop: Record<string, EvoDropAffixes>;
    /**
     * ZotFlow Evo: LiquidJS template for the linked reference that follows a
     * dropped highlight or comment.
     */
    evoDropLinkTemplate: string;
    /** ZotFlow Evo: a click on a link to a source note opens the item's PDF instead of the note. */
    evoSourceLinksOpenAttachment: boolean;
    /** ZotFlow Evo: sync a library as soon as Zotero reports a change to it. */
    autoSyncPull: boolean;
    /** ZotFlow Evo: sync shortly after something was changed here. */
    autoSyncPush: boolean;
    /** ZotFlow Evo: columns of the library browser's table, in order. */
    evoLibraryColumns: string[];
    /** ZotFlow Evo: columns of a collection tab's table, in order. */
    evoCollectionColumns: string[];
    /** ZotFlow Evo: column widths in pixels, by column id (both tables). */
    evoColumnWidths: Record<string, number>;
    /** ZotFlow Evo: the tables' sort order. */
    evoLibrarySort: { column: string; descending: boolean };
    /** ZotFlow Evo: a collection lists the items of the collections inside it too. */
    evoLibrarySubcollections: boolean;
    /** ZotFlow Evo: widths of the library browser's side panes in pixels. */
    evoLibraryPanes: { collections: number; details: number };
    /** ZotFlow Evo: how the annotation browser groups and orders. */
    evoAnnotationLayout: AnnotationLayout;
    /** ZotFlow Evo: the search an item without a file opens; the query is appended. */
    evoBookSearchUrl: string;
    /** ZotFlow Evo: collections pinned to the top of the library browser ("libraryID:key"), in order. */
    evoPinnedCollections: string[];
    /** ZotFlow Evo: the order of collections set by dragging them, by parent ("libraryID:parentKey", or "pinned"). */
    evoCollectionOrder: Record<string, string[]>;
    /** ZotFlow Evo: the library browser shows the selected item on the right. */
    evoLibraryDetailsShown: boolean;
    /** ZotFlow Evo: a collection tab shows the selected item (beside the table, or under it when narrow). */
    evoCollectionDetailsShown: boolean;
    /** ZotFlow Evo: LiquidJS template for the name of a file saved to an item (without extension). */
    evoAttachFilename: string;
    /** ZotFlow Evo: Anna's Archive member key for its download API (kept in SecretStorage, not data.json). */
    evoAnnasKey?: string;
    /** ZotFlow Evo: Zotero's data folder (full-text search); empty: ~/Zotero. */
    evoZoteroDataDir: string;
    /** ZotFlow Evo: how the full-text search groups and orders, and its switches. */
    evoFulltextLayout: FulltextLayout;
    evoFulltextMatchCase: boolean;
    evoFulltextWholeWords: boolean;
    /** ZotFlow Evo: sub-collections are indented under their parents in the library browser. */
    evoCollectionIndent: boolean;
    /**
     * ZotFlow Evo: the page filter of each PDF (KOReader units), by
     * `pdfFilterKey()` ("libraryID:key", or "vault:path").
     */
    readerPdfFilters: Record<string, PdfFilter>;
    /**
     * ZotFlow Evo: what the annotation strip tab shows: the reader's note
     * strip (editable), or the library's item pane (read only, faster).
     */
    evoStripTabMode: "reader" | "item-pane";
    /** ZotFlow Evo: where a new note for an author (clicked in the item pane or the strip) goes; empty: Obsidian's place for new notes. */
    evoAuthorFolder: string;
    /** ZotFlow Evo: the template file a new author note starts from; empty: none. */
    evoAuthorTemplate: string;
    /** ZotFlow Evo: quotation marks round the text of highlights in the note strip. */
    readerNoteStripQuotes: boolean;
    /** ZotFlow Evo: opacity of the text of highlights in the note strip (comments stay at 1). */
    readerNoteStripHighlightOpacity: number;
    /** ZotFlow Evo: room between the entries of the note strip, in pixels. */
    readerNoteStripSpacing: number;
    /** ZotFlow Evo: the highlight / underline switch in the reader's colour bubble (hidden by default). */
    readerSelectionToolToggle: boolean;
    /** ZotFlow Evo: the item pane shows the PDF's outline among its annotations. */
    evoItemPaneOutline: boolean;
    /** ZotFlow Evo: the languages OCR reads (Tesseract codes), as last chosen in the PDF editing menu. */
    evoOcrLanguages: string[];
    /** CSL renderer: default style id (slug or custom style key). */
    cslDefaultStyleId: string;
    /** CSL renderer: default output format. */
    cslDefaultFormat: CslOutputFormat;
    /** Vault-relative folder scanned for custom .csl styles; "" disables. */
    cslStylesFolder: string;
}

/** ZotFlow Evo: text around a comment dropped into a note. */
export interface EvoDropAffixes {
    before: string;
    after: string;
}

/** ZotFlow Evo: default line above the note strip — author, year, title, publication, book. */
export const DEFAULT_NOTE_STRIP_BANNER =
    "{{ item.creatorSummary | default: item.creators[0].lastName | default: item.creators[0].name }}{% if item.year %} {{ item.year }}{% endif %} · {{ item.title }}{% if item.publicationTitle %} · {{ item.publicationTitle }}{% endif %}{% if item.bookTitle %} · {{ item.bookTitle }}{% endif %}";

/**
 * ZotFlow Evo: default reference after a dropped highlight or comment —
 * author, year, short title and page in brackets, linked to the place in the
 * document. `author`, `year`, `shortTitle` and `title` are shortcuts the
 * template gets next to `item`; a missing author or year leaves no stray
 * separator, and neither does a missing page (a snapshot has none).
 */
export const DEFAULT_DROP_LINK_TEMPLATE =
    "([{% if author %}{{ author }} - {% endif %}{% if year %}{{ year }} - {% endif %}{{ shortTitle }}{% if page %}, p. {{ page }}{% endif %}]({{ link }}))";

/**
 * ZotFlow Evo: earlier defaults of the reference template. A stored
 * template equal to one of these was never changed by the user and is
 * replaced by the current default (settings/evo-upgrade.ts).
 */
export const PREVIOUS_DROP_LINK_TEMPLATES: readonly string[] = [
    // 1.7.1-beta.4: printed ", p. " for a snapshot, which has no pages.
    "([{% if author %}{{ author }} - {% endif %}{% if year %}{{ year }} - {% endif %}{{ shortTitle }}, p. {{ page }}]({{ link }}))",
];

/** Top-level key addressable by Obsidian's declarative settings controls. */
export type SettingKey = Extract<keyof ZotFlowSettings, string>;

/** Re-exported so main-thread settings UI can reference the format union. */
export type { CslOutputFormat };

/** Persisted reader view state for a single attachment (local or zotero). */
export interface ViewStateEntry {
    primaryViewState?: Record<string, unknown>;
    secondaryViewState?: Record<string, unknown>;
    lightTheme?: string;
    darkTheme?: string;
}

/**
 * Full shape of data.json.
 * Settings and non-settings data are stored as separate top-level keys.
 *
 * `viewStates` is keyed by file path (local) or `"libraryID:itemKey"` (zotero).
 */
export interface ZotFlowPluginData {
    settings: ZotFlowSettings;
    customThemes: CustomReaderTheme[];
    viewStates: Record<string, ViewStateEntry>;
}

/** Default values for all `ZotFlowSettings` fields. */
export const DEFAULT_SETTINGS: ZotFlowSettings = {
    zoteroapikey: "",
    librariesConfig: {},
    syncInterval: 30,
    autoSync: false,
    useWebDav: false,
    useCache: true,
    maxCacheSizeMB: 500,
    librarySourceNoteTemplatePath: "",
    sourceNoteFolder: "",
    librarySourceNotePathTemplate:
        "Source/{{libraryName}}/@{{citationKey | default: title | default: key}}",
    localSourceNoteTemplatePath: "",
    localSourceNoteFolder: "",
    localSidecarFolder: "",
    localSourceNotePathTemplate: "Source/Local/@{{basename}}",
    autoImportAnnotationImages: false,
    annotationImageFolder: "Source/Images",
    overwriteViewer: true,
    readerColorScheme: "obsidian-theme",
    defaultLightTheme: "obsidian",
    defaultDarkTheme: "obsidian",
    treeCollectionSort: "name-asc",
    treeItemSort: "title-asc",
    treeSingleClickOpen: false,
    itemDisplayTitleTemplate: "",
    convertNoteLinks: true,
    linkedAttachmentBaseDir: "",
    useZoteroStorage: false,
    zoteroStoragePath: "",
    defaultEditableRegionLocked: true,
    hideEditableRegionMarkers: false,
    alwaysOpenChildNoteInEditor: false,
    defaultCitationFormat: "footnote",
    citationTrigger: "@@",
    citationPandocTemplate: "",
    citationFootnoteRefTemplate: "",
    citationFootnoteTemplate: "",
    citationWikilinkTemplate: "",
    autoCopyAnnotation: "off",
    autoUpdateSourceNotesAfterSync: true,
    autoPurgeTrashedSourceNotes: false,
    autoDisableNoteImageTextTools: true,
    epubFontFamily: "",
    readerToolbarHidden: false,
    readerNoteStripVisible: true,
    readerNoteStripList: true,
    readerNoteStripHighlights: false,
    readerNoteStripWidth: 320,
    readerNoteStripBanner: DEFAULT_NOTE_STRIP_BANNER,
    evoCommentDrop: {},
    evoHighlightDrop: {},
    evoDropLinkTemplate: DEFAULT_DROP_LINK_TEMPLATE,
    evoSourceLinksOpenAttachment: true,
    autoSyncPull: true,
    autoSyncPush: true,
    evoLibraryColumns: [...DEFAULT_LIBRARY_COLUMNS],
    evoCollectionColumns: [...DEFAULT_COLLECTION_COLUMNS],
    evoColumnWidths: {},
    evoLibrarySort: { column: "title", descending: false },
    evoLibrarySubcollections: false,
    evoLibraryPanes: { collections: 240, details: 360 },
    evoAnnotationLayout: { ...DEFAULT_ANNOTATION_LAYOUT },
    evoBookSearchUrl: DEFAULT_BOOK_SEARCH_URL,
    evoPinnedCollections: [],
    evoCollectionOrder: {},
    evoLibraryDetailsShown: true,
    evoCollectionDetailsShown: true,
    evoAttachFilename: DEFAULT_ATTACH_FILENAME,
    evoZoteroDataDir: "",
    evoFulltextLayout: { ...DEFAULT_FULLTEXT_LAYOUT },
    evoFulltextMatchCase: false,
    evoFulltextWholeWords: false,
    evoCollectionIndent: true,
    readerPdfFilters: {},
    evoStripTabMode: "item-pane",
    evoOcrLanguages: ["deu", "eng"],
    evoAuthorFolder: "",
    evoAuthorTemplate: "",
    readerNoteStripQuotes: false,
    readerNoteStripHighlightOpacity: 1,
    readerNoteStripSpacing: 12,
    readerSelectionToolToggle: false,
    evoItemPaneOutline: false,
    cslDefaultStyleId: "apa",
    cslDefaultFormat: "markdown",
    cslStylesFolder: "",
};

/** Default shape of the full `data.json` blob (settings + view states). */
export const DEFAULT_PLUGIN_DATA: ZotFlowPluginData = {
    settings: { ...DEFAULT_SETTINGS },
    customThemes: [],
    viewStates: {},
};
