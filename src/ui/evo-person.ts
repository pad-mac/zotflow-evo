/**
 * ZotFlow Evo (fork): a person's note, opened from an author's name (the
 * item pane, the note strip's head). An existing note of that name is
 * opened wherever it is. A new one goes into the folder set in the
 * settings (Library, Authors) with the template set there, else where
 * Obsidian puts new notes, empty. The template's {{title}}, {{date}} and
 * {{time}} (with an optional format, {{date:YYYY-MM-DD}}) are filled in as
 * Obsidian's Templates plugin does; other syntax (Templater's) is left for
 * that plugin.
 */
import { Keymap, TFile, moment, normalizePath } from "obsidian";

import { services } from "services/services";

import type { App } from "obsidian";

/** A name as a file name: characters Obsidian does not allow removed. */
export function personFileName(name: string): string {
    return name
        .replace(/[\\/:*?"<>|#^[\]]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

/** A template's {{title}}, {{date}} and {{time}} filled in. */
export function fillPersonTemplate(
    text: string,
    name: string,
    now = moment(),
): string {
    return text.replace(
        /{{\s*(title|date|time)\s*(?::([^}]*))?}}/gi,
        (_m, what: string, format?: string) => {
            const kind = what.toLowerCase();
            if (kind === "title") return name;
            return now.format(
                format?.trim() || (kind === "date" ? "YYYY-MM-DD" : "HH:mm"),
            );
        },
    );
}

export async function openPersonNote(
    app: App,
    name: string,
    event?: MouseEvent | KeyboardEvent,
): Promise<void> {
    const newLeaf = event ? Keymap.isModEvent(event) : false;
    const existing = app.metadataCache.getFirstLinkpathDest(name, "");
    const folder = services.settings.evoAuthorFolder?.trim();
    if (existing || !folder) {
        await app.workspace.openLinkText(name, "", newLeaf);
        return;
    }
    const fileName = personFileName(name);
    if (!fileName) return;
    try {
        const dir = normalizePath(folder);
        if (!app.vault.getAbstractFileByPath(dir))
            await app.vault.createFolder(dir);
        let content = "";
        const templatePath = services.settings.evoAuthorTemplate?.trim();
        if (templatePath) {
            const template = app.vault.getAbstractFileByPath(
                normalizePath(
                    templatePath.endsWith(".md")
                        ? templatePath
                        : `${templatePath}.md`,
                ),
            );
            if (template instanceof TFile)
                content = fillPersonTemplate(
                    await app.vault.read(template),
                    name,
                );
            else
                services.notificationService.notify(
                    "warning",
                    `The template for author notes (${templatePath}) was not found; the note was made empty.`,
                );
        }
        const path = normalizePath(`${dir}/${fileName}.md`);
        const file =
            (app.vault.getAbstractFileByPath(path) as TFile | null) ??
            (await app.vault.create(path, content));
        await app.workspace.getLeaf(newLeaf ? "tab" : false).openFile(file);
    } catch (e) {
        services.logService.error(
            "Failed to make the author's note",
            "EvoLibrary",
            e,
        );
        services.notificationService.notify(
            "error",
            `Couldn't make a note for ${name}. ${e instanceof Error ? e.message : ""}`,
        );
    }
}
