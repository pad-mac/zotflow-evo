/**
 * ZotFlow Evo (fork): the links on one line of a note, in the order they
 * stand, as link paths (no heading or block, no alias). For the annotation
 * strip tab, which follows the line the cursor is on. No Obsidian here.
 */

/** `[[path#sub|alias]]`, `![[…]]`, `[text](path "title")`, `[text](<path with spaces>)`. */
const LINK =
    /!?\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]|!?\[(?:[^\]\\]|\\.)*\]\(\s*(?:<([^>]*)>|([^\s)]+))(?:\s+"[^"]*")?\s*\)/g;

/** Not a note in the vault: a web address, an `obsidian://` link, a mail. */
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function stripSubpath(target: string): string {
    const at = target.search(/[#^]/);
    return (at < 0 ? target : target.slice(0, at)).trim();
}

/** The link paths on `line`, left to right; duplicates kept once. */
export function linkPathsOnLine(line: string): string[] {
    const out: string[] = [];
    for (const m of line.matchAll(LINK)) {
        let target: string;
        if (m[1] !== undefined) {
            target = m[1];
        } else {
            const raw = m[2] ?? m[3] ?? "";
            if (SCHEME.test(raw)) continue;
            try {
                target = decodeURI(raw);
            } catch {
                target = raw;
            }
        }
        const path = stripSubpath(target);
        if (path && !out.includes(path)) out.push(path);
    }
    return out;
}
