/**
 * ZotFlow Evo (fork): settings for what the fork adds — the note strip beside
 * a PDF, dragging comments and highlights into notes, automatic sync.
 * See FORK.md.
 */
import { notifyReaderChromeChanged } from "ui/reader/chrome";
import { ANNOTATION_COLORS } from "ui/editor/evo-drop";
import {
    DEFAULT_HIGHLIGHT_DROP_TEMPLATE,
    DEFAULT_NOTE_STRIP_BANNER,
} from "settings/types";

import type ZotFlow from "main";
import type {
    Setting,
    SettingDefinitionItem,
    SettingGroupItem,
} from "obsidian";
import type { EvoDropAffixes, SettingKey } from "settings/types";

/** The note strip switches, which the reader's header buttons change as well. */
type StripToggleKey = "readerNoteStripVisible" | "readerNoteStripCollapsed";

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
                        desc: "A strip beside each PDF page for the comments of its highlights and for notes of your own. Also a button in the reader's header and a command.",
                        render: (setting) =>
                            this.readerToggle(setting, "readerNoteStripVisible"),
                    },
                    {
                        name: "Comments as a list",
                        desc: "Show the comments one below the other instead of beside their place on the page. Also a button in the reader's header and a command.",
                        render: (setting) =>
                            this.readerToggle(
                                setting,
                                "readerNoteStripCollapsed",
                            ),
                    },
                    {
                        name: "Width",
                        desc: `Width of the note strip in pixels (${STRIP_WIDTH_MIN} to ${STRIP_WIDTH_MAX}).`,
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
                    {
                        name: "Banner",
                        desc: "LiquidJS template for the line pinned above the note strip, with the item variables of the display title template (item.creatorSummary, item.year, item.title, item.publicationTitle, item.bookTitle, …). Leave empty for no banner.",
                        render: (setting) => {
                            setting.addTextArea((area) => {
                                area.setPlaceholder(DEFAULT_NOTE_STRIP_BANNER)
                                    .setValue(
                                        this.plugin.settings
                                            .readerNoteStripBanner,
                                    )
                                    .onChange(async (value) => {
                                        this.plugin.settings.readerNoteStripBanner =
                                            value;
                                        notifyReaderChromeChanged();
                                        await this.plugin.saveSettings();
                                    });
                                area.inputEl.rows = 3;
                                area.inputEl.addClass("zotflow-evo-wide-input");
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
                        name: "Highlight drop template",
                        desc: "LiquidJS template for a highlight (or selected text) dragged from a PDF into a note. Variables: text, comment, page, link (opens the PDF at that place), color, and item as in the display title template. Leave empty to drop the default citation format instead. Holding Shift, Ctrl/Cmd or Alt while dropping always gives a citation format.",
                        render: (setting) => {
                            setting.addTextArea((area) => {
                                area.setPlaceholder(
                                    DEFAULT_HIGHLIGHT_DROP_TEMPLATE,
                                )
                                    .setValue(
                                        this.plugin.settings
                                            .evoHighlightDropTemplate,
                                    )
                                    .onChange(async (value) => {
                                        this.plugin.settings.evoHighlightDropTemplate =
                                            value;
                                        await this.plugin.saveSettings();
                                    });
                                area.inputEl.rows = 4;
                                area.inputEl.addClass("zotflow-evo-wide-input");
                            });
                        },
                    },
                    {
                        name: "Comment drop text, by colour",
                        desc: "Text put before and after a comment dragged from the note strip into a note, for each annotation colour. The page number, linked to the place in the PDF, follows the comment; to place it yourself write {{page}} and {{link}} in either field, for example  ([{{page}}]({{link}})) . {{text}} is the highlighted text.",
                    },
                    ...ANNOTATION_COLORS.map(
                        ({ name, hex }): SettingGroupItem<SettingKey> => ({
                            name,
                            render: (setting) =>
                                this.colorRow(setting, hex),
                        }),
                    ),
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

    /** One colour of the comment drop table: a swatch, "before" and "after". */
    private colorRow(setting: Setting, hex: string) {
        const swatch = createSpan({ cls: "zotflow-evo-swatch" });
        swatch.setCssProps({ "--zotflow-evo-swatch": hex });
        setting.nameEl.prepend(swatch);

        const read = (): EvoDropAffixes =>
            this.plugin.settings.evoCommentDrop[hex] ?? {
                before: "",
                after: "",
            };
        const write = async (patch: Partial<EvoDropAffixes>) => {
            const next: EvoDropAffixes = { ...read(), ...patch };
            const table = { ...this.plugin.settings.evoCommentDrop };
            if (next.before || next.after) table[hex] = next;
            else delete table[hex];
            this.plugin.settings.evoCommentDrop = table;
            await this.plugin.saveSettings();
        };

        setting.addText((text) => {
            text.setPlaceholder("Before")
                .setValue(read().before)
                .onChange((value) => write({ before: value }));
            text.inputEl.setAttribute("aria-label", "Text before the comment");
        });
        setting.addText((text) => {
            text.setPlaceholder("After")
                .setValue(read().after)
                .onChange((value) => write({ after: value }));
            text.inputEl.setAttribute("aria-label", "Text after the comment");
        });
    }
}
