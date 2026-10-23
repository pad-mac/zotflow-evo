/**
 * ZotFlow Evo (fork): a group library's files in a shared folder instead of
 * Zotero's storage — the Zotero plugin "Group Linked Files" (pad-mac), done
 * here so the same files open in Obsidian. The group's attachments are
 * ordinary stored files whose file name is the link: `<folder>/<filename>`,
 * in a folder on this computer (synced by HU-Box, say) or on a WebDAV
 * server. Nothing in the folder is ever renamed, moved, deleted or
 * overwritten; a new file is written only under a name that is free.
 *
 * Pure: the parts the worker (reading) and the main thread (writing new
 * files, the settings) share. The names follow the Zotero plugin exactly,
 * so a file added here gets the name it would get there.
 */

export interface SharedFolderNaming {
    template: string;
    authorSeparator: string;
    etAl: string;
    maxAuthors: number;
    noYear: string;
    noAuthor: string;
    transliterate: boolean;
    lowercase: boolean;
}

export const DEFAULT_SHARED_NAMING: SharedFolderNaming = {
    template: "{authors}_{year}",
    authorSeparator: "-",
    etAl: "ua",
    maxAuthors: 2,
    noYear: "oJ",
    noAuthor: "oA",
    transliterate: true,
    lowercase: true,
};

export const DEFAULT_WEBDAV_SERVER = "https://box.hu-berlin.de/huboxdav/";

/** One group's shared folder, as kept in the settings. */
export interface SharedFolderConfig {
    /** Lowercase letters and digits: the password's ID in SecretStorage. */
    id: string;
    /** The group's library ID (Zotero's group ID). */
    libraryID: number;
    mode: "folder" | "webdav";
    /** "folder": the folder on this computer. */
    folder: string;
    /** "webdav": the server's address and the folder on it. */
    webdavServer: string;
    webdavPath: string;
    webdavUser: string;
    /** Kept in SecretStorage, not data.json (utils/credentials.ts). */
    password?: string;
    naming: SharedFolderNaming;
}

export function newSharedFolderId(): string {
    return Math.random().toString(36).slice(2, 10).replace(/[^a-z0-9]/g, "x");
}

/** A config as read from the settings, its gaps filled. */
export function normalizeSharedFolder(raw: unknown): SharedFolderConfig | null {
    if (!raw || typeof raw !== "object") return null;
    const c = raw as Partial<SharedFolderConfig> & { naming?: Partial<SharedFolderNaming> };
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    const libraryID = Number(c.libraryID);
    if (!Number.isInteger(libraryID) || libraryID <= 0) return null;
    const naming = { ...DEFAULT_SHARED_NAMING, ...(c.naming ?? {}) };
    naming.maxAuthors = Math.max(1, Math.floor(Number(naming.maxAuthors)) || DEFAULT_SHARED_NAMING.maxAuthors);
    return {
        id: /^[a-z0-9]+$/.test(str(c.id)) ? str(c.id) : newSharedFolderId(),
        libraryID,
        mode: c.mode === "webdav" ? "webdav" : "folder",
        folder: str(c.folder),
        webdavServer: c.webdavServer === undefined ? DEFAULT_WEBDAV_SERVER : str(c.webdavServer),
        webdavPath: str(c.webdavPath),
        webdavUser: str(c.webdavUser),
        password: typeof c.password === "string" ? c.password : undefined,
        naming,
    };
}

/** The shared folder of a library, if it has one set up. */
export function sharedFolderFor(
    configs: unknown,
    libraryID: number,
): SharedFolderConfig | null {
    if (!Array.isArray(configs)) return null;
    for (const raw of configs) {
        const c = normalizeSharedFolder(raw);
        if (c && c.libraryID === libraryID && hasLocation(c)) return c;
    }
    return null;
}

export function hasLocation(c: SharedFolderConfig): boolean {
    return c.mode === "webdav" ? !!webdavFolderURL(c) : !!c.folder.trim();
}

/** The WebDAV folder's address with a trailing slash, or null. */
export function webdavFolderURL(c: Pick<SharedFolderConfig, "webdavServer" | "webdavPath">): string | null {
    let server = c.webdavServer.trim();
    if (!/^https?:\/\/[^/]+/i.test(server)) return null;
    if (!server.endsWith("/")) server += "/";
    const segments = c.webdavPath
        .split("/")
        .map((s) => s.trim())
        .filter(Boolean);
    return (
        server +
        segments.map((s) => encodeURIComponent(s)).join("/") +
        (segments.length ? "/" : "")
    );
}

/** `Authorization` for a WebDAV request. */
export function basicAuth(user: string, password: string): string {
    const bytes = new TextEncoder().encode(`${user}:${password}`);
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return "Basic " + btoa(binary);
}

/** A file name that may stand in the folder (not a path, not Zotero's own). */
export function isValidSharedFilename(name: unknown): name is string {
    return (
        typeof name === "string" &&
        name.length > 0 &&
        name !== "." &&
        name !== ".." &&
        !/[/\\]/.test(name) &&
        !name.startsWith(".zotero")
    );
}

/**
 * The same name in both Unicode forms ("ü" as one character on Windows,
 * "u" and a combining mark as macOS often writes it).
 */
export function nameVariants(name: string): string[] {
    return [...new Set([name, name.normalize("NFC"), name.normalize("NFD")])];
}

/** For comparing names: case, Unicode form and ü/ue do not matter; no spaces. */
export function matchKey(s: string): string {
    return s
        .normalize("NFC")
        .toLowerCase()
        .replace(/ä/g, "ae")
        .replace(/ö/g, "oe")
        .replace(/ü/g, "ue")
        .replace(/ß/g, "ss")
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/\s+/g, "");
}

/** ä → ae, ö → oe, ü → ue, ß → ss; other accents dropped. */
export function transliterate(s: string): string {
    return s
        .normalize("NFC")
        .replace(/Ä/g, "Ae")
        .replace(/Ö/g, "Oe")
        .replace(/Ü/g, "Ue")
        .replace(/ä/g, "ae")
        .replace(/ö/g, "oe")
        .replace(/ü/g, "ue")
        .replace(/ẞ/g, "SS")
        .replace(/ß/g, "ss")
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .normalize("NFC");
}

function cleanPart(s: string): string {
    return s
        .normalize("NFC")
        // eslint-disable-next-line no-control-regex -- control characters are not allowed in file names
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

/** What a file's name is made of: last names (authors, else editors, else anyone), year, title. */
export interface NameParts {
    lastNames: string[];
    year: string;
    title: string;
}

export function namePartsOf(
    data: { creators?: unknown; date?: unknown; title?: unknown },
    primaryCreatorType: string,
): NameParts {
    const creators = Array.isArray(data.creators)
        ? (data.creators as { creatorType?: string; lastName?: string; name?: string }[])
        : [];
    let pick = creators.filter((c) => c.creatorType === primaryCreatorType);
    if (!pick.length) pick = creators.filter((c) => c.creatorType === "editor");
    if (!pick.length) pick = creators;
    const date = typeof data.date === "string" ? data.date : "";
    const year = /(?:^|\D)(\d{4})(?!\d)/.exec(date)?.[1] ?? "";
    return {
        lastNames: pick.map((c) => c.lastName || c.name || ""),
        year: year === "0000" ? "" : year,
        title: typeof data.title === "string" ? data.title : "",
    };
}

/**
 * A file name without extension, from the group's scheme. Default
 * "{authors}_{year}", umlauts replaced, lowercase: mueller_1987,
 * mueller-schmidt_1990, weber-ua_2004.
 */
export function formatBaseName(parts: NameParts, s: SharedFolderNaming): string {
    const names = parts.lastNames.map(cleanPart).filter(Boolean);
    let authors: string;
    if (!names.length) authors = s.noAuthor;
    else if (names.length <= s.maxAuthors) authors = names.join(s.authorSeparator);
    else authors = s.etAl ? names[0] + s.authorSeparator + s.etAl : names[0]!;
    const shortTitle = cleanPart(parts.title).split(" ").slice(0, 6).join(" ").slice(0, 60);
    let out = s.template
        .replace(/\{authors\}/g, authors)
        .replace(/\{year\}/g, cleanPart(parts.year) || s.noYear)
        .replace(/\{title\}/g, shortTitle);
    out = cleanPart(out).replace(/^[.\s]+|[.\s]+$/g, "").slice(0, 150) || s.noAuthor;
    if (s.transliterate) out = transliterate(out);
    if (s.lowercase) out = out.toLowerCase();
    return out;
}

/** ".pdf" of "a.pdf"; "" when there is none. */
export function extensionOf(name: string): string {
    const m = /(\.[A-Za-z0-9]{1,6})$/.exec(name);
    return m && m.index > 0 ? m[1]! : "";
}

/**
 * The first free name: "base.ext", then "basea.ext" … "basez.ext", then
 * "base (2).ext" …; free means no file in the folder and no attachment of
 * the group has it (compared by `matchKey`).
 */
export function nextFreeName(
    base: string,
    ext: string,
    taken: Set<string>,
): string {
    const stems = [base, ..."abcdefghijklmnopqrstuvwxyz".split("").map((c) => base + c)];
    for (let n = 2; n < 1000; n++) stems.push(`${base} (${n})`);
    for (const stem of stems) {
        const name = stem + ext;
        if (!taken.has(matchKey(name))) return name;
    }
    throw new Error(`No free file name for ${base}${ext}`);
}

/** One entry of a WebDAV folder listing. */
export interface WebdavEntry {
    name: string;
    isDir: boolean;
    size: number | null;
}

/** A PROPFIND reply's entries (the folder itself left out). Namespace prefixes vary by server. */
export function parseMultistatus(xml: string, requestURL: string): WebdavEntry[] {
    const tag = (name: string) => `<(?:[\\w.-]+:)?${name}\\b[^>]*>`;
    const close = (name: string) => `</(?:[\\w.-]+:)?${name}>`;
    const entities = (s: string) =>
        s
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'")
            .replace(/&#(\d+);/g, (_m, n: string) => String.fromCharCode(Number(n)))
            .replace(/&amp;/g, "&");
    const pathOf = (href: string) =>
        href
            .replace(/^https?:\/\/[^/]+/i, "")
            .split("/")
            .map((seg) => {
                try {
                    return decodeURIComponent(seg);
                } catch {
                    return seg;
                }
            })
            .join("/")
            .replace(/\/+$/, "");
    const self = pathOf(requestURL);
    const out: WebdavEntry[] = [];
    const responseRe = new RegExp(tag("response") + "([\\s\\S]*?)" + close("response"), "g");
    for (const m of xml.matchAll(responseRe)) {
        const block = m[1]!;
        const href = new RegExp(tag("href") + "([\\s\\S]*?)" + close("href")).exec(block);
        if (!href) continue;
        const path = pathOf(entities(href[1]!.trim()));
        if (path === self) continue;
        const name = path.split("/").pop();
        if (!name) continue;
        const isDir = new RegExp("<(?:[\\w.-]+:)?collection\\b").test(block);
        const len = new RegExp(tag("getcontentlength") + "\\s*(\\d+)\\s*<").exec(block);
        out.push({ name, isDir, size: len ? Number(len[1]) : null });
    }
    return out;
}

export const PROPFIND_BODY =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/><D:getcontentlength/></D:prop></D:propfind>';
