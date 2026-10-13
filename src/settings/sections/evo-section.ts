/**
 * ZotFlow Evo (fork): settings for what the fork adds — the note strip beside
 * a PDF or a snapshot, dragging comments and highlights into notes, the
 * library browser, automatic sync.
 * See FORK.md.
 */
import { notifyReaderChromeChanged } from "ui/reader/chrome";
import { ANNOTATION_COLORS } from "ui/editor/evo-drop";
import { DEFAULT_DROP_LINK_TEMPLATE } from "settings/types";
import { DEFAULT_BOOK_SEARCH_URL } from "utils/evo-library-model";

import type ZotFlow from "main";
import type {
    Setting,
    SettingDefinitionItem,
    SettingGroupItem,
} from "obsidian";
import type { EvoDropAffixes, SettingKey } from "settings/types";

/** The note strip switches, which the reader's header buttons change as well. */
type StripToggleKey =
    | "readerNoteStripVisible"
    | "readerNoteStripList"
    | "readerNoteStripHighlights";

/** The two per-colour tables of text around a drop. */
type DropTableKey = "evoHighlightDrop" | "evoCommentDrop";

/** Narrowest and widest note strip the reader accepts, in pixels. */
const STRIP_WIDTH_MIN = 160;
const STRIP_WIDTH_MAX = 900;

/** Declarative settings for the fork's additions. */
export class EvoSection {
    constructor(private readonly plugin: ZotFlow) {}

    getDefinitions(): SettingDefinitionItem<SettingKey>[] {
        return [
            {
                type: "group",
                heading: "Note strip",
                items: [
                    {
                        name: "Show the note strip",
                        desc: "A strip beside a PDF or a web snapshot for the comments of its highlights and for notes of your own. Also a button in the reader's header and a command.",
                        render: (setting) =>
                            this.readerToggle(
                                setting,
                                "readerNoteStripVisible",
                            ),
                    },
                    {
                        name: "As a list",
                        desc: "The strip is a list of its own, like the reader's annotations sidebar. Off, every entry sits beside its place on the page and the strip scrolls with the pages (PDFs only; beside a snapshot it is always a list). Also a button in the reader's header and a command.",
                        render: (setting) =>
                            this.readerToggle(setting, "readerNoteStripList"),
                    },
                    {
                        name: "Show highlights",
                        desc: "List the highlights themselves, with their full text, not only comments and notes. Also a button at the top of the strip and a command.",
                        render: (setting) =>
                            this.readerToggle(
                                setting,
                                "readerNoteStripHighlights",
                            ),
                    },
                    {
                        name: "Width",
                        desc: `Width of the note strip in pixels (${STRIP_WIDTH_MIN} to ${STRIP_WIDTH_MAX}). Also set by dragging the strip's edge in the reader.`,
                        render: (setting) => {
                            setting.addText((text) => {
                                text.setValue(
                                    String(
                                        this.plugin.settings
                                            .readerNoteStripWidth,
                                    ),
                                ).onChange(async (value) => {
                                    const width = Number.parseInt(value, 10);
                                    if (
                                        !/^\d+$/.test(value) ||
                                        width < STRIP_WIDTH_MIN ||
                                        width > STRIP_WIDTH_MAX
                                    ) {
                                        return;
                                    }
                                    this.plugin.settings.readerNoteStripWidth =
                                        width;
                                    notifyReaderChromeChanged();
                                    await this.plugin.saveSettings();
                                });
                            });
                        },
                    },
                ],
            },
            {
                type: "group",
                heading: "Dragging into notes",
                items: [
                    {
                        name: "Reference",
                        desc: "LiquidJS template for the reference that follows a highlight or comment dragged from a PDF or a snapshot into a note. Variables: author, year, shortTitle, title, page (missing for a snapshot: {% if page %}…{% endif %}), link (opens the document at that place), text, comment, color, and item as in the display title template. Leave empty for no reference. Holding Shift, Ctrl/Cmd or Alt while dropping gives a citation format instead.",
                        render: (setting) => {
                            setting.addTextArea((area) => {
                                area.setPlaceholder(DEFAULT_DROP_LINK_TEMPLATE)
                                    .setValue(
                                        this.plugin.settings
                                            .evoDropLinkTemplate,
                                    )
                                    .onChange(async (value) => {
                                        this.plugin.settings.evoDropLinkTemplate =
                                            value;
                                        await this.plugin.saveSettings();
                                    });
                                area.inputEl.rows = 3;
                                area.inputEl.addClass("zotflow-evo-wide-input");
                            });
                        },
                    },
                ],
            },
            this.dropTable(
                "Highlights dropped into a note, by colour",
                "Text put before and after a highlight (or selected text) dragged from the page. The highlighted text comes in quotation marks, the reference after it. To place the reference yourself write {{cite}} in either field; {{page}}, {{link}}, {{text}}, {{comment}} and {{color}} are filled in too.",
                "evoHighlightDrop",
            ),
            this.dropTable(
                "Comments dropped into a note, by colour",
                "The same for a comment dragged from the note strip.",
                "evoCommentDrop",
            ),
            {
                type: "group",
                heading: "Library browser",
                items: [
                    {
                        name: "Search for a missing file",
                        desc: `Where the search button of an item without a PDF, EPUB or snapshot goes; the title, first author and year are appended. Default: ${DEFAULT_BOOK_SEARCH_URL}`,
                        render: (setting) => {
                            setting.addText((text) => {
                                text.setPlaceholder(DEFAULT_BOOK_SEARCH_URL)
                                    .setValue(
                                        this.plugin.settings.evoBookSearchUrl,
                                    )
                                    .onChange(async (value) => {
                                        this.plugin.settings.evoBookSearchUrl =
                                            value.trim() ||
                                            DEFAULT_BOOK_SEARCH_URL;
                                        await this.plugin.saveSettings();
                                    });
                                text.inputEl.addClass("zotflow-evo-wide-input");
                            });
                        },
                    },
                ],
            },
            {
                type: "group",
                heading: "Links to source notes",
                items: [
                    {
                        name: "Open the PDF instead of the note",
                        desc: "A click on a link to a source note opens the item's PDF, EPUB or snapshot (asking when there are several). Ctrl/Cmd-click opens the note itself, as do links to a heading or block of it and items that have nothing to open.",
                        control: {
                            type: "toggle",
                            key: "evoSourceLinksOpenAttachment",
                        },
                    },
                ],
            },
            {
                type: "group",
                heading: "Automatic sync",
                items: [
                    {
                        name: "Sync when Zotero changes",
                        desc: "Listen to Zotero's servers and sync a library as soon as something in it changed elsewhere: an item added with the browser connector, an edit in Zotero. Needs the API key; uses the same connection Zotero itself listens on.",
                        control: { type: "toggle", key: "autoSyncPull" },
                    },
                    {
                        name: "Sync after changes made here",
                        desc: "Sync a few seconds after an annotation, comment or note was changed in Obsidian, and when a reader is closed.",
                        control: { type: "toggle", key: "autoSyncPush" },
                    },
                ],
            },
        ];
    }

    /** A toggle whose change every open reader follows at once. */
    private readerToggle(setting: Setting, key: StripToggleKey) {
        setting.addToggle((toggle) => {
            toggle
                .setValue(this.plugin.settings[key])
                .onChange(async (value) => {
                    this.plugin.settings[key] = value;
                    notifyReaderChromeChanged();
                    await this.plugin.saveSettings();
                });
        });
    }

    /** A group with one row per annotation colour: text before and after a drop. */
    private dropTable(
        heading: string,
        desc: string,
        key: DropTableKey,
    ): SettingDefinitionItem<SettingKey> {
        return {
            type: "group",
            heading,
            items: [
                { name: "Text before and after", desc },
                ...ANNOTATION_COLORS.map(
                    ({ name, hex }): SettingGroupItem<SettingKey> => ({
                        name,
                        render: (setting) => this.colorRow(setting, key, hex),
                    }),
                ),
            ],
        };
    }

    /** One colour of a drop table: a swatch, "before" and "after". */
    private colorRow(setting: Setting, key: DropTableKey, hex: string) {
        const swatch = createSpan({ cls: "zotflow-evo-swatch" });
        swatch.setCssProps({ "--zotflow-evo-swatch": hex });
        setting.nameEl.prepend(swatch);

        const read = (): EvoDropAffixes =>
            this.plugin.settings[key]?.[hex] ?? {
                before: "",
                after: "",
            };
        const write = async (patch: Partial<EvoDropAffixes>) => {
            const next: EvoDropAffixes = { ...read(), ...patch };
            const table = { ...this.plugin.settings[key] };
            if (next.before || next.after) table[hex] = next;
            else delete table[hex];
            this.plugin.settings[key] = table;
            await this.plugin.saveSettings();
        };

        setting.addText((text) => {
            text.setPlaceholder("Before")
                .setValue(read().before)
                .onChange((value) => write({ before: value }));
            text.inputEl.setAttribute("aria-label", "Text before");
        });
        setting.addText((text) => {
            text.setPlaceholder("After")
                .setValue(read().after)
                .onChange((value) => write({ after: value }));
            text.inputEl.setAttribute("aria-label", "Text after");
        });
    }
}
