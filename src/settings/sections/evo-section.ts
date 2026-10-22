/**
 * ZotFlow Evo (fork): settings for what the fork adds — the note strip beside
 * a PDF or a snapshot, dragging comments and highlights into notes, the
 * library browser, automatic sync.
 * See FORK.md.
 */
import { applyStripTabMode } from "ui/evo-strip/follow";
import {
    BUNDLED_OCR_LANGUAGES,
    OCR_LANGUAGE_NAMES,
    installOcrLanguage,
    installedOcrLanguages,
    isOcrLanguageCode,
    removeOcrLanguage,
} from "ui/reader/evo-ocr-languages";
import { notifyReaderChromeChanged } from "ui/reader/chrome";
import { ANNOTATION_COLORS } from "ui/editor/evo-drop";
import { DEFAULT_DROP_LINK_TEMPLATE } from "settings/types";
import {
    DEFAULT_ATTACH_FILENAME,
    DEFAULT_BOOK_SEARCH_URL,
} from "utils/evo-library-model";

import type ZotFlow from "main";
import { services } from "services/services";

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
    | "readerNoteStripHighlights"
    | "readerNoteStripQuotes"
    | "readerSelectionToolToggle";

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
                    {
                        name: "Annotation strip tab",
                        desc: "What the tab that follows the line being written shows (command “Open annotation strip”). Note strip: the reader's strip, with editing; it loads the PDF out of sight. Item pane: the library's right pane (files, abstract, annotations with the colour filter); it shows at once, without editing.",
                        render: (setting) => {
                            setting.addDropdown((dropdown) => {
                                dropdown
                                    .addOption("reader", "Note strip")
                                    .addOption("item-pane", "Item pane")
                                    .setValue(
                                        this.plugin.settings.evoStripTabMode,
                                    )
                                    .onChange(async (value) => {
                                        this.plugin.settings.evoStripTabMode =
                                            value === "item-pane"
                                                ? "item-pane"
                                                : "reader";
                                        await this.plugin.saveSettings();
                                        await applyStripTabMode(
                                            this.plugin.app,
                                        );
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
                    {
                        name: "Zotero's data folder",
                        desc: "For the full-text search, which reads copies of Zotero's own index (fulltext.sqlite, zotero.sqlite) and the text Zotero extracted (storage/…/.zotero-ft-cache). Empty: ~/Zotero. Desktop only.",
                        render: (setting) => {
                            setting.addText((text) => {
                                text.setPlaceholder("~/Zotero")
                                    .setValue(
                                        this.plugin.settings.evoZoteroDataDir,
                                    )
                                    .onChange(async (value) => {
                                        this.plugin.settings.evoZoteroDataDir =
                                            value.trim();
                                        await this.plugin.saveSettings();
                                    });
                                text.inputEl.addClass("zotflow-evo-wide-input");
                            });
                        },
                    },
                    {
                        name: "Indent sub-collections",
                        desc: "In the library browser's left pane. Off: every level starts at the same place; the arrows still show what is inside what.",
                        control: {
                            type: "toggle",
                            key: "evoCollectionIndent",
                        },
                    },
                    {
                        name: "Anna's Archive key",
                        desc: "Your member key (Account page). With it, the paperclip button of a web viewer pane gets the file of the book open there through the member API; without it, ZotFlow takes the file from the page (open the fast download or Anna's viewer first). Kept in Obsidian's secret storage, not in the plugin's settings file.",
                        render: (setting) => {
                            setting.addText((text) => {
                                text.inputEl.type = "password";
                                text.setPlaceholder("Secret key")
                                    .setValue(
                                        this.plugin.settings.evoAnnasKey ?? "",
                                    )
                                    .onChange(async (value) => {
                                        this.plugin.settings.evoAnnasKey =
                                            value.trim();
                                        await this.plugin.saveSettings();
                                    });
                            });
                        },
                    },
                    {
                        name: "Name of a saved file",
                        desc: `What a file saved to an item from the web viewer is called (Zotero's storage; the extension is added). LiquidJS with lastName, year, shortTitle (the title when there is none), title, itemType. Default: ${DEFAULT_ATTACH_FILENAME}`,
                        render: (setting) => {
                            setting.addText((text) => {
                                text.setPlaceholder(DEFAULT_ATTACH_FILENAME)
                                    .setValue(
                                        this.plugin.settings.evoAttachFilename,
                                    )
                                    .onChange(async (value) => {
                                        this.plugin.settings.evoAttachFilename =
                                            value.trim() ||
                                            DEFAULT_ATTACH_FILENAME;
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
                heading: "OCR",
                items: [
                    {
                        name: "Languages",
                        desc: "Recognizing the text of scanned PDFs (PDF editing menu in the note strip). English, German and French are part of the plugin. Others are downloaded here (Tesseract's models from jsDelivr, about 1–3 MB each) into the plugin's folder: Tesseract codes such as ita, spa, lat, grc, rus, chi_sim, separated by spaces.",
                        render: (setting) => this.ocrLanguages(setting),
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
            {
                type: "group",
                heading: "Note strip appearance",
                items: [
                    {
                        name: "Quotation marks round highlights",
                        desc: "The text of a highlight in the strip between “ and ”, so it stands apart from the comments.",
                        render: (setting) =>
                            this.readerToggle(setting, "readerNoteStripQuotes"),
                    },
                    {
                        name: "Highlight text strength",
                        desc: "How strong the text of highlights is beside comments (1: the same). Lower makes it fainter.",
                        render: (setting) =>
                            this.readerSlider(
                                setting,
                                "readerNoteStripHighlightOpacity",
                                0.3,
                                1,
                                0.05,
                            ),
                    },
                    {
                        name: "Space between entries",
                        desc: "In pixels (12 as before). In the list, and between entries beside the page.",
                        render: (setting) =>
                            this.readerSlider(
                                setting,
                                "readerNoteStripSpacing",
                                4,
                                40,
                                1,
                            ),
                    },
                ],
            },
            {
                type: "group",
                heading: "Reader popups",
                items: [
                    {
                        name: "Highlight / underline switch",
                        desc: "The switch between highlighting and underlining in the colour bubble over selected text, as in Zotero. Off, the bubble has the colours only (a selection is highlighted; underline from the toolbar).",
                        render: (setting) =>
                            this.readerToggle(
                                setting,
                                "readerSelectionToolToggle",
                            ),
                    },
                ],
            },
            {
                type: "group",
                heading: "Authors",
                items: [
                    {
                        name: "Folder for new author notes",
                        desc: "A click on an author's name (item pane, note strip) opens their note; one that does not exist yet is made in this folder. Empty: where Obsidian puts new notes.",
                        render: (setting) => {
                            setting.addText((text) => {
                                text.setPlaceholder("People")
                                    .setValue(
                                        this.plugin.settings.evoAuthorFolder,
                                    )
                                    .onChange(async (value) => {
                                        this.plugin.settings.evoAuthorFolder =
                                            value.trim();
                                        await this.plugin.saveSettings();
                                    });
                            });
                        },
                    },
                    {
                        name: "Template for new author notes",
                        desc: "The note a new author note starts from (path in the vault). {{title}} becomes the name, {{date}} and {{time}} (with a format, {{date:YYYY-MM-DD}}) as in Obsidian's Templates; Templater's syntax is left to Templater. Empty: an empty note.",
                        render: (setting) => {
                            setting.addText((text) => {
                                text.setPlaceholder("Templates/Person.md")
                                    .setValue(
                                        this.plugin.settings.evoAuthorTemplate,
                                    )
                                    .onChange(async (value) => {
                                        this.plugin.settings.evoAuthorTemplate =
                                            value.trim();
                                        await this.plugin.saveSettings();
                                    });
                                text.inputEl.addClass("zotflow-evo-wide-input");
                            });
                        },
                    },
                ],
            },
        ];
    }

    /**
     * The groups by heading, for the settings tab to place each where it
     * belongs (the fork's settings sit among upstream's since beta.12).
     */
    groups(): Map<string, SettingDefinitionItem<SettingKey>> {
        const map = new Map<string, SettingDefinitionItem<SettingKey>>();
        for (const item of this.getDefinitions()) {
            const heading = (item as { heading?: string }).heading;
            if (heading) map.set(heading, item);
        }
        return map;
    }

    /** A slider whose change every open reader follows at once. */
    private readerSlider(
        setting: Setting,
        key: "readerNoteStripHighlightOpacity" | "readerNoteStripSpacing",
        min: number,
        max: number,
        step: number,
    ) {
        setting.addSlider((slider) => {
            slider
                .setLimits(min, max, step)
                .setValue(this.plugin.settings[key])
                .onChange(async (value) => {
                    this.plugin.settings[key] = value;
                    notifyReaderChromeChanged();
                    await this.plugin.saveSettings();
                });
        });
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

    /** The OCR languages: those there are, and a field to download more. */
    private ocrLanguages(setting: Setting) {
        const list = setting.descEl.createDiv({
            cls: "zotflow-evo-ocr-languages",
        });
        const show = async () => {
            const installed = await installedOcrLanguages();
            list.empty();
            for (const code of installed) {
                const chip = list.createSpan({
                    cls: "zotflow-evo-ocr-language",
                    text: OCR_LANGUAGE_NAMES[code] ?? code,
                    attr: { title: code },
                });
                if (BUNDLED_OCR_LANGUAGES.includes(code)) continue;
                const remove = chip.createSpan({
                    cls: "zotflow-evo-ocr-language-remove",
                    text: "×",
                    attr: { "aria-label": `Remove ${code}` },
                });
                remove.addEventListener("click", () => {
                    void removeOcrLanguage(code).then(show);
                });
            }
        };
        void show();
        let codes = "";
        setting.addText((text) => {
            text.setPlaceholder("ita lat").onChange((value) => {
                codes = value;
            });
        });
        setting.addButton((button) =>
            button.setButtonText("Install").onClick(async () => {
                const wanted = codes
                    .toLowerCase()
                    .split(/[\s,;]+/)
                    .filter(Boolean);
                const bad = wanted.filter((c) => !isOcrLanguageCode(c));
                if (bad.length) {
                    services.notificationService.notify(
                        "warning",
                        `Not a Tesseract language code: ${bad.join(", ")}`,
                    );
                    return;
                }
                button.setDisabled(true);
                for (const code of wanted) {
                    try {
                        services.notificationService.notify(
                            "info",
                            `Downloading the OCR language “${code}”…`,
                        );
                        await installOcrLanguage(code);
                        services.notificationService.notify(
                            "success",
                            `OCR language “${code}” installed.`,
                        );
                    } catch (e) {
                        services.notificationService.notify(
                            "error",
                            `Could not install “${code}”: ${e instanceof Error ? e.message : String(e)}`,
                        );
                    }
                }
                button.setDisabled(false);
                await show();
            }),
        );
    }
}
