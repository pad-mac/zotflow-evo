/**
 * ZotFlow Evo: finding an open-access file for an item the browser connector
 * saved without one — Zotero's own way (zotero/zotero,
 * chrome/content/zotero/xpcom/attachments.js: `getFileResolvers(item,
 * ['oa', 'custom'], true)` and `downloadFirstAvailableFile()`; the lookup is
 * Zotero's open-access service, `getOpenAccessPDFURLs()` in
 * utilities_internal.js), ported from Zotero's code. Licensed under the AGPL
 * like Zotero.
 *
 * Differences, because Obsidian is not a browser with Zotero's translators:
 * a landing page (`pageURL`) is searched for its `citation_pdf_url` (what
 * Zotero's Embedded Metadata translator reads there) instead of being run
 * through the translators; redirects are followed by Obsidian's request
 * (not one by one); no custom resolvers (Zotero's hidden
 * `findPDFs.resolvers` setting); no captcha window.
 */

/** Zotero's `ZOTERO_CONFIG.SERVICES_URL`. */
const SERVICES_URL = "https://services.zotero.org/";

/** `Zotero.Attachments.FIND_AVAILABLE_FILE_TYPES`. */
export const FIND_AVAILABLE_FILE_TYPES = ["application/pdf", "application/epub+zip"];

/** At most this many addresses from one resolver (Zotero: Unpaywall rows with hundreds by mistake). */
const MAX_URLS = 6;

export interface FetchResult {
    status: number;
    /** Lower-case header names. */
    headers: Record<string, string>;
    bytes: Uint8Array;
}

export type Fetch = (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<FetchResult>;

export interface FoundFile {
    bytes: Uint8Array;
    contentType: string;
    url: string;
    /** "Full Text", "Accepted Version", "Submitted Version" (Zotero's `_getTitleFromVersion`). */
    title: string;
}

interface UrlResolver {
    url?: string;
    pageURL?: string;
    articleVersion?: string;
    accessMethod?: string;
    referrer?: string;
}

/** `Zotero.Utilities.cleanDOI()`. */
export function cleanDOI(x: string): string | null {
    if (/^https?:/.test(x)) {
        try {
            x = decodeURIComponent(x);
        } catch {
            // As it is.
        }
    }
    const openingPos = x.indexOf("%3C");
    if (openingPos !== -1 && openingPos < x.indexOf("%3E")) {
        x = x.replace(/%3C/g, "<").replace(/%3E/g, ">");
    }
    const doi = /10(?:\.[0-9]{4,})?\/[^\s]*[^\s.,]/.exec(x);
    if (!doi) return null;
    let result = doi[0];
    const trailing = result.slice(-1);
    if (trailing === "]" || trailing === ")" || trailing === "}") {
        const opening = { "]": "[", ")": "(", "}": "{" }[trailing];
        const before = x.slice(0, doi.index);
        if (before.lastIndexOf(opening) > before.lastIndexOf(trailing)) result = result.slice(0, -1);
    }
    return result;
}

/** An item's DOI: its DOI field, else a "DOI:" line in Extra (`item.getField('DOI') || item.getExtraField('DOI')`). */
export function doiOf(item: Record<string, unknown> | undefined): string | null {
    const field = typeof item?.DOI === "string" ? item.DOI : "";
    const extra = typeof item?.extra === "string" ? item.extra : "";
    const fromExtra = /^DOI:\s*(.+)$/im.exec(extra)?.[1]?.trim() ?? "";
    const doi = field || fromExtra;
    return doi ? cleanDOI(doi) : null;
}

/** `Zotero.MIME.sniffForMIMEType()` for the types looked for: a PDF anywhere in the sample, an EPUB at 30. */
export function sniffFileType(bytes: Uint8Array): string | null {
    const sample = String.fromCharCode(...bytes.subarray(0, 1000));
    if (sample.includes("%PDF-")) return "application/pdf";
    if (sample.startsWith("mimetypeapplication/epub+zip", 30)) return "application/epub+zip";
    return null;
}

/** `_getTitleFromVersion()` with Zotero's English strings. */
export function titleFromVersion(version: string | undefined): string {
    switch (version) {
        case "acceptedVersion":
        case "accepted":
            return "Accepted Version";
        case "submittedVersion":
        case "submitted":
            return "Submitted Version";
        default:
            return "Full Text";
    }
}

/** Whether Zotero would look for a file for this item from the connector (`getFileResolvers(item, ['oa', 'custom'], true).length > 0`). */
export function hasFileResolvers(item: Record<string, unknown> | undefined): boolean {
    return doiOf(item) !== null;
}

/** `Zotero.Utilities.Internal.getOpenAccessPDFURLs()`. */
async function openAccessURLs(doi: string, fetch: Fetch): Promise<UrlResolver[]> {
    const res = await fetch(`${SERVICES_URL}oa/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doi }),
    });
    if (res.status >= 400) throw new Error(`Zotero's open-access search answered ${res.status}.`);
    const list: unknown = JSON.parse(new TextDecoder().decode(res.bytes));
    if (!Array.isArray(list)) return [];
    return (list as { url?: string; pageURL?: string; version?: string }[]).map((o) => ({
        url: o.url,
        pageURL: o.pageURL,
        articleVersion: o.version,
        accessMethod: "oa",
    }));
}

/** The address without its query (but `download`, for Atypon), sorted: tried once only. */
function normalizeURL(url: string): string {
    try {
        const u = new URL(url);
        for (const param of Array.from(u.searchParams.keys())) {
            if (param !== "download") u.searchParams.delete(param);
        }
        u.searchParams.sort();
        return u.toString();
    } catch {
        return url;
    }
}

function attribute(tag: string, name: string): string | null {
    const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
    return m ? (m[2] ?? m[3] ?? m[4] ?? "") : null;
}

function decodeEntities(s: string): string {
    return s
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");
}

/** A meta refresh's address (`Zotero.HTTP.getHTMLMetaRefreshURL`). */
export function metaRefreshURL(html: string, base: string): string | null {
    for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
        if ((attribute(tag, "http-equiv") ?? "").toLowerCase() !== "refresh") continue;
        const content = decodeEntities(attribute(tag, "content") ?? "");
        const url = /url\s*=\s*['"]?([^'";]+)/i.exec(content)?.[1]?.trim();
        if (!url) continue;
        try {
            return new URL(url, base).toString();
        } catch {
            return null;
        }
    }
    return null;
}

/** The file a landing page names: `citation_pdf_url` (as Zotero's Embedded Metadata translator reads it). */
export function fileURLFromPage(html: string, base: string): string | null {
    for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
        const name = (attribute(tag, "name") ?? attribute(tag, "property") ?? "").toLowerCase();
        if (name !== "citation_pdf_url") continue;
        const content = decodeEntities(attribute(tag, "content") ?? "").trim();
        if (!content) continue;
        try {
            return new URL(content, base).toString();
        } catch {
            continue;
        }
    }
    return null;
}

/**
 * Zotero's `downloadFirstAvailableFile()` for the open-access resolvers: the
 * first address that gives a PDF or EPUB, trying each address once.
 */
export async function findOpenAccessFile(
    doi: string,
    fetch: Fetch,
): Promise<FoundFile | null> {
    const schemeRE = /^(http:)?\/\//;
    const tried = new Set<string>();
    const isTried = (url: string) => tried.has(normalizeURL(url));
    const addTried = (url: string) => tried.add(normalizeURL(url));

    let resolvers: UrlResolver[];
    try {
        resolvers = (await openAccessURLs(doi, fetch)).slice(0, MAX_URLS);
    } catch {
        return null;
    }

    const download = async (url: string, referrer?: string): Promise<{ bytes: Uint8Array; type: string } | null> => {
        try {
            const res = await fetch(url, referrer ? { headers: { Referer: referrer } } : undefined);
            if (res.status >= 400) return null;
            const type = sniffFileType(res.bytes);
            return type ? { bytes: res.bytes, type } : null;
        } catch {
            return null;
        }
    };

    for (const resolver of resolvers) {
        let url = resolver.url?.replace(schemeRE, "https://") ?? null;
        let pageURL = resolver.pageURL?.replace(schemeRE, "https://") ?? null;
        if (url && isTried(url)) url = null;
        if (pageURL && isTried(pageURL)) pageURL = null;
        if (!url && !pageURL) continue;
        const title = titleFromVersion(resolver.articleVersion);

        // The file's address first.
        if (url) {
            addTried(url);
            const got = await download(url, resolver.referrer);
            if (got) return { bytes: got.bytes, contentType: got.type, url, title };
        }

        // Else the landing page: a file itself, or a page naming one.
        if (pageURL) {
            let next = pageURL;
            let html: string | null = null;
            try {
                for (let hops = 0; hops < 10; hops++) {
                    const res = await fetch(next);
                    if (res.status >= 400) break;
                    const contentType = (res.headers["content-type"] ?? "").toLowerCase();
                    if (FIND_AVAILABLE_FILE_TYPES.some((t) => contentType.startsWith(t))) {
                        const type = sniffFileType(res.bytes);
                        addTried(next);
                        if (type) return { bytes: res.bytes, contentType: type, url: next, title };
                        break;
                    }
                    if (contentType.startsWith("text/html")) {
                        const text = new TextDecoder().decode(res.bytes);
                        const refresh = metaRefreshURL(text, next);
                        if (refresh) {
                            if (isTried(refresh)) break;
                            next = refresh;
                            continue;
                        }
                        html = text;
                    }
                    addTried(next);
                    break;
                }
            } catch {
                continue;
            }
            const fileURL = html ? fileURLFromPage(html, next) : null;
            if (!fileURL || isTried(fileURL)) continue;
            addTried(fileURL);
            const got = await download(fileURL, next);
            if (got) return { bytes: got.bytes, contentType: got.type, url: fileURL, title };
        }
    }
    return null;
}
