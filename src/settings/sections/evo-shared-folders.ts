/**
 * ZotFlow Evo (fork): the settings of the groups whose files are in a
 * shared folder (utils/evo-shared-folder.ts): one block per group under the
 * "Group shared folders" setting — where the files are (a folder on this
 * computer or a WebDAV server), the WebDAV login (the password in
 * SecretStorage), the file name scheme with a preview, and a test.
 */
import { Platform, Setting } from "obsidian";

import { workerBridge } from "bridge";
import { services } from "services/services";
import {
    DEFAULT_SHARED_NAMING,
    DEFAULT_WEBDAV_SERVER,
    formatBaseName,
    newSharedFolderId,
    normalizeSharedFolder,
} from "utils/evo-shared-folder";

import type ZotFlow from "main";
import type { SharedFolderConfig } from "utils/evo-shared-folder";

const PREVIEWS = [
    { lastNames: ["Müller"], year: "1987", title: "" },
    { lastNames: ["Müller", "Schmidt"], year: "1990", title: "" },
    { lastNames: ["Weber", "Braun", "Klein"], year: "2004", title: "" },
    { lastNames: ["Fischer"], year: "", title: "" },
];

function configs(plugin: ZotFlow): SharedFolderConfig[] {
    const list = plugin.settings.evoGroupFolders;
    return Array.isArray(list)
        ? list.map(normalizeSharedFolder).filter((c): c is SharedFolderConfig => !!c)
        : [];
}

async function store(plugin: ZotFlow, list: SharedFolderConfig[]) {
    plugin.settings.evoGroupFolders = list;
    await plugin.saveSettings();
}

/** Group libraries by ID, with their names. */
async function groupLibraries(): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    try {
        for (const lib of await workerBridge.evoLibrary.getCollectionTree()) {
            if (services.libraryCache.isGroup(lib.libraryID)) out.set(lib.libraryID, lib.name);
        }
    } catch (e) {
        services.logService.error("Failed to read the libraries", "Settings", e);
    }
    return out;
}

export function renderSharedFolders(plugin: ZotFlow, setting: Setting): void {
    const blocks: HTMLElement[] = [];
    let groups = new Map<number, string>();

    const draw = () => {
        for (const b of blocks.splice(0)) b.remove();
        let anchor: HTMLElement = setting.settingEl;
        const list = configs(plugin);
        list.forEach((config, index) => {
            const block = createDiv({ cls: "zotflow-evo-shared-folder" });
            anchor.insertAdjacentElement("afterend", block);
            anchor = block;
            blocks.push(block);
            drawOne(block, config, index);
        });
    };

    const update = async (index: number, patch: Partial<SharedFolderConfig>, redraw = false) => {
        const list = configs(plugin);
        const current = list[index];
        if (!current) return;
        list[index] = {
            ...current,
            ...patch,
            naming: { ...current.naming, ...(patch.naming ?? {}) },
        };
        await store(plugin, list);
        if (redraw) draw();
    };
    // Saved as typed, as the other settings are.
    const later = (index: number, patch: Partial<SharedFolderConfig>) =>
        void update(index, patch);

    const drawOne = (block: HTMLElement, config: SharedFolderConfig, index: number) => {
        const head = new Setting(block)
            .setName(groups.get(config.libraryID) ?? `Group ${config.libraryID}`)
            .setDesc("Its files are in this folder, not in Zotero's storage. Files saved to its items from here go there, named with the scheme below; nothing in the folder is ever renamed, moved, overwritten or deleted.")
            .setHeading();
        head.addButton((b) =>
            b
                .setButtonText("Test")
                .onClick(async () => {
                    const status = head.descEl;
                    status.setText("Looking…");
                    try {
                        const files = await workerBridge.attachment.listSharedFolder(configs(plugin)[index] ?? config);
                        status.setText(`${files.length} file${files.length === 1 ? "" : "s"} found in the folder.`);
                    } catch (e) {
                        status.setText(`Not reached: ${e instanceof Error ? e.message : String(e)}`);
                    }
                }),
        );
        head.addExtraButton((b) =>
            b
                .setIcon("trash-2")
                .setTooltip("Remove (the group's files stay where they are)")
                .onClick(async () => {
                    const list = configs(plugin);
                    list.splice(index, 1);
                    await store(plugin, list);
                    draw();
                }),
        );

        new Setting(block)
            .setName("Where the files are")
            .addDropdown((d) =>
                d
                    .addOption("folder", "A folder on this computer")
                    .addOption("webdav", "A WebDAV server")
                    .setValue(config.mode)
                    .onChange((v) => void update(index, { mode: v === "webdav" ? "webdav" : "folder" }, true)),
            );
        if (config.mode === "folder") {
            new Setting(block)
                .setName("Folder")
                .setDesc(
                    Platform.isDesktopApp
                        ? "The folder's full path on this computer (the one HU-Box or another client syncs). Desktop only: on a phone or tablet use WebDAV."
                        : "A folder on a computer cannot be read here; use WebDAV on this device.",
                )
                .addText((t) => {
                    t.setPlaceholder("/Users/me/HU-Box/Project/PDFs")
                        .setValue(config.folder)
                        .onChange((v) => later(index, { folder: v.trim() }));
                    t.inputEl.addClass("zotflow-evo-wide-input");
                });
        } else {
            new Setting(block).setName("Server").addText((t) => {
                t.setPlaceholder(DEFAULT_WEBDAV_SERVER)
                    .setValue(config.webdavServer)
                    .onChange((v) => later(index, { webdavServer: v.trim() }));
                t.inputEl.addClass("zotflow-evo-wide-input");
            });
            new Setting(block)
                .setName("Folder on the server")
                .setDesc("For HU-Box: the library's name, then its folders, separated by /.")
                .addText((t) => {
                    t.setPlaceholder("Project/PDFs")
                        .setValue(config.webdavPath)
                        .onChange((v) => later(index, { webdavPath: v.trim() }));
                    t.inputEl.addClass("zotflow-evo-wide-input");
                });
            new Setting(block).setName("User name").addText((t) =>
                t.setValue(config.webdavUser).onChange((v) => later(index, { webdavUser: v.trim() })),
            );
            new Setting(block)
                .setName("Password")
                .setDesc("The WebDAV password (HU-Box: set once in its web interface, Settings → WebDAV). Kept in Obsidian's secret storage, not in the plugin's settings file.")
                .addText((t) => {
                    t.inputEl.type = "password";
                    t.setValue(config.password ?? "").onChange((v) => later(index, { password: v }));
                });
        }

        const preview = () => {
            const naming = configs(plugin)[index]?.naming ?? config.naming;
            return PREVIEWS.map((p) => `${formatBaseName(p, naming)}.pdf`).join(", ");
        };
        const scheme = new Setting(block)
            .setName("File names for new files")
            .setDesc(preview())
            .addText((t) =>
                t
                    .setPlaceholder(DEFAULT_SHARED_NAMING.template)
                    .setValue(config.naming.template)
                    .onChange(async (v) => {
                        await update(index, { naming: { ...config.naming, template: v.trim() || DEFAULT_SHARED_NAMING.template } });
                        scheme.setDesc(preview());
                    }),
            );
        const naming = new Setting(block)
            .setName("Separator, et al., authors before et al., no year, no author")
            .setDesc("{authors}, {year} and {title} in the scheme; a name already in the folder gets a, b, …");
        const small = (
            key: "authorSeparator" | "etAl" | "noYear" | "noAuthor",
            label: string,
        ) =>
            naming.addText((t) => {
                t.setValue(config.naming[key])
                    .setPlaceholder(label)
                    .onChange(async (v) => {
                        const current = configs(plugin)[index]?.naming ?? config.naming;
                        await update(index, { naming: { ...current, [key]: v } });
                        scheme.setDesc(preview());
                    });
                t.inputEl.addClass("zotflow-evo-narrow-input");
            });
        small("authorSeparator", "-");
        small("etAl", "ua");
        naming.addText((t) => {
            t.setValue(String(config.naming.maxAuthors)).onChange(async (v) => {
                const n = Math.max(1, Math.floor(Number(v)) || 1);
                const current = configs(plugin)[index]?.naming ?? config.naming;
                await update(index, { naming: { ...current, maxAuthors: n } });
                scheme.setDesc(preview());
            });
            t.inputEl.addClass("zotflow-evo-narrow-input");
        });
        small("noYear", "oJ");
        small("noAuthor", "oA");
        new Setting(block)
            .setName("Lowercase; umlauts as ae, oe, ue, ss")
            .addToggle((t) =>
                t.setValue(config.naming.lowercase).onChange(async (v) => {
                    const current = configs(plugin)[index]?.naming ?? config.naming;
                    await update(index, { naming: { ...current, lowercase: v } });
                    scheme.setDesc(preview());
                }),
            )
            .addToggle((t) =>
                t.setValue(config.naming.transliterate).onChange(async (v) => {
                    const current = configs(plugin)[index]?.naming ?? config.naming;
                    await update(index, { naming: { ...current, transliterate: v } });
                    scheme.setDesc(preview());
                }),
            );
    };

    // "Add a group": the groups not set up yet.
    setting.addDropdown((d) => {
        d.addOption("", "Add a group…");
        void groupLibraries().then((found) => {
            groups = found;
            const used = new Set(configs(plugin).map((c) => c.libraryID));
            for (const [id, name] of found) if (!used.has(id)) d.addOption(String(id), name);
            draw();
        });
        d.onChange(async (value) => {
            const libraryID = Number(value);
            if (!libraryID) return;
            const list = configs(plugin);
            list.push({
                id: newSharedFolderId(),
                libraryID,
                mode: Platform.isDesktopApp ? "folder" : "webdav",
                folder: "",
                webdavServer: DEFAULT_WEBDAV_SERVER,
                webdavPath: "",
                webdavUser: "",
                naming: { ...DEFAULT_SHARED_NAMING },
            });
            await store(plugin, list);
            d.selectEl.remove(d.selectEl.selectedIndex);
            d.setValue("");
            draw();
        });
    });
    draw();
}
