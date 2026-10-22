import { App, PluginSettingTab } from "obsidian";

import { CacheSection } from "settings/sections/cache-section";
import { CitationSection } from "settings/sections/citation-section";
import { CslSection } from "settings/sections/csl-section";
import { EvoSection } from "settings/sections/evo-section";
import { GeneralSection } from "settings/sections/general-section";
import { SyncSection } from "settings/sections/sync-section";
import { WebDavSection } from "settings/sections/webdav-section";
import { DEFAULT_SETTINGS } from "settings/types";

import type ZotFlow from "main";
import type { SettingDefinitionItem } from "obsidian";
import type { SettingKey } from "settings/types";

/** Obsidian 1.13 declarative settings tab. */
export class ZotFlowSettingTab extends PluginSettingTab {
    plugin: ZotFlow;

    private readonly syncSection: SyncSection;
    private readonly webDavSection: WebDavSection;
    private readonly cacheSection: CacheSection;

    constructor(app: App, plugin: ZotFlow) {
        super(app, plugin);
        this.plugin = plugin;
        this.icon = "zotero-icon";

        const requestUpdate = () => this.update();
        this.syncSection = new SyncSection(plugin, requestUpdate);
        this.webDavSection = new WebDavSection(plugin, requestUpdate);
        this.cacheSection = new CacheSection(plugin, requestUpdate);
    }

    /**
     * The pages. ZotFlow Evo (beta.12): the fork's settings are no longer a
     * page of their own; each group sits with upstream's on the same thing
     * (the note strip with the reader, automatic sync with sync, the library
     * browser and authors on a Library page, dragging into notes and links
     * with source notes).
     */
    getSettingDefinitions(): SettingDefinitionItem<SettingKey>[] {
        const evo = new EvoSection(this.plugin).groups();
        const pick = (...headings: string[]) =>
            headings
                .map((h) => evo.get(h))
                .filter((g): g is SettingDefinitionItem<SettingKey> => !!g);
        // Upstream's "General" held the source notes and reader pages and
        // the item display group; they stand on their own now.
        const general = new GeneralSection(this.plugin).getDefinitions();
        const page = (name: string) =>
            general.find((g) => (g as { name?: string }).name === name) as
                | { items?: SettingDefinitionItem<SettingKey>[] }
                | undefined;
        const itemDisplay = general.filter(
            (g) => (g as { heading?: string }).heading === "Item Display",
        );
        const dropTables = this.dropTables(evo);
        return [
            {
                type: "page",
                name: "Sync",
                items: [
                    ...this.syncSection.getDefinitions(),
                    ...pick("Automatic sync"),
                ],
            },
            {
                type: "page",
                name: "WebDAV",
                items: this.webDavSection.getDefinitions(),
            },
            {
                type: "page",
                name: "Source Notes",
                desc: "Templates, paths, editable regions, annotation assets; links to source notes; dragging into notes.",
                items: [
                    ...(page("Source Notes")?.items ?? []),
                    ...pick("Links to source notes", "Dragging into notes"),
                    ...dropTables,
                ],
            },
            {
                type: "page",
                name: "Reader",
                desc: "Reader integration, annotation tools, fonts, color themes; the note strip; popups; OCR.",
                items: [
                    ...(page("Reader")?.items ?? []),
                    ...pick(
                        "Note strip",
                        "Note strip appearance",
                        "Reader popups",
                        "OCR",
                    ),
                ],
            },
            {
                type: "page",
                name: "Library",
                desc: "The library browser, how items are titled, notes for authors.",
                items: [
                    ...pick("Library browser"),
                    ...itemDisplay,
                    ...pick("Authors"),
                ],
            },
            {
                type: "page",
                name: "Citation",
                items: new CitationSection(this.plugin).getDefinitions(),
            },
            {
                type: "page",
                name: "CSL Render",
                items: new CslSection(this.plugin).getDefinitions(),
            },
            {
                type: "page",
                name: "Cache",
                items: this.cacheSection.getDefinitions(),
            },
        ];
    }

    /** The two tables of text around dropped highlights and comments. */
    private dropTables(
        evo: Map<string, SettingDefinitionItem<SettingKey>>,
    ): SettingDefinitionItem<SettingKey>[] {
        return [...evo.entries()]
            .filter(([heading]) => heading.includes("dropped into a note"))
            .map(([, group]) => group);
    }

    getControlValue(key: string): unknown {
        if (!this.isSettingKey(key)) return undefined;
        return this.plugin.settings[key];
    }

    async setControlValue(key: string, value: unknown): Promise<void> {
        if (!this.isSettingKey(key)) {
            throw new Error(`Unknown ZotFlow setting: ${key}`);
        }

        Reflect.set(this.plugin.settings, key, value);
        await this.plugin.saveSettings();
    }

    refreshFromSettings(): void {
        this.syncSection.reset();
        this.webDavSection.reset();
        this.cacheSection.reset();
        this.update();
    }

    private isSettingKey(key: string): key is SettingKey {
        return Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key);
    }
}
