/**
 * ZotFlow Evo (fork): the copy of a PDF kept before an edit (PDF editing
 * menu), so the edit can be reverted on any device: a stored-file
 * attachment in Zotero's trash beside the PDF, tagged BACKUP_TAG, its note
 * saying what was done and holding, as JSON, how the pages moved (the
 * stages of page plans), so a revert can move the annotations back. Zotero
 * empties its trash after 30 days by default. Pure: used by the plugin and
 * its worker.
 */
import type { PagePlan } from "utils/evo-pdf-geometry";

export const BACKUP_TAG = "zotflow-evo-backup";

export interface PdfBackupInfo {
    /** The attachment it is a copy of. */
    of: string;
    /** When the edit was made (ISO). */
    at: string;
    /** What the edit did ("split 120 pages", …). */
    done: string[];
    /** How the pages moved, stage by stage (empty: they did not). */
    stages: PagePlan[][];
}

const MARK = "zf-evo-backup:";

const escape = (text: string) =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unescape = (text: string) =>
    text
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&");

/** The note of a backup attachment. */
export function backupNote(info: PdfBackupInfo): string {
    const when = new Date(info.at).toLocaleString();
    const what = info.done.length ? info.done.join(", ") : "an edit";
    return (
        `<p>ZotFlow Evo: this PDF as it was before ${escape(what)} (${escape(when)}). ` +
        `Revert to it from the PDF editing menu in Obsidian, or restore it from the trash here.</p>` +
        `<pre>${MARK}${escape(JSON.stringify(info))}</pre>`
    );
}

/** What a backup's note holds; null when it is no backup's. */
export function parseBackupNote(
    note: string | undefined,
): PdfBackupInfo | null {
    if (!note) return null;
    const at = note.indexOf(MARK);
    if (at < 0) return null;
    const end = note.indexOf("</pre>", at);
    const raw = unescape(
        note.slice(at + MARK.length, end < 0 ? undefined : end),
    );
    try {
        const info = JSON.parse(raw) as Partial<PdfBackupInfo>;
        if (typeof info.of !== "string" || typeof info.at !== "string")
            return null;
        return {
            of: info.of,
            at: info.at,
            done: Array.isArray(info.done)
                ? info.done.filter((d) => typeof d === "string")
                : [],
            stages: Array.isArray(info.stages) ? info.stages : [],
        };
    } catch {
        return null;
    }
}
