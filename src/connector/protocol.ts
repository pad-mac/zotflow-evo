/**
 * ZotFlow Evo: the browser connector's side in ZotFlow — what the Zot Vitro
 * Connector (a fork of the Zotero Connector, github.com/pad-mac/zot-vitro-connector)
 * sends, and what it gets back, as Zotero's own connector server answers
 * it. The pure parts: no Obsidian, no network. See FORK.md, "Browser
 * connector".
 */

/** Zotero listens on 23119; ZotFlow next to it, so both can run. */
export const CONNECTOR_PORT = 23121;

/**
 * What ZotFlow sends as `X-Zotero-Version`. Not a number on purpose: the
 * Connector hands files it recognizes (RIS, BibTeX) to a client of version
 * 5 or later for import, which ZotFlow does not do.
 */
export const CONNECTOR_SERVER_VERSION = "ZotFlow";

/** A library ("L1") or a collection in it ("C1:ABCD1234"), as the Connector names save targets. */
export interface ConnectorTarget {
    libraryID: number;
    collectionKey: string | null;
}

export function targetId(target: ConnectorTarget): string {
    return target.collectionKey
        ? `C${target.libraryID}:${target.collectionKey}`
        : `L${target.libraryID}`;
}

export function parseTargetId(id: unknown): ConnectorTarget | null {
    if (typeof id !== "string") return null;
    const lib = /^L(\d+)$/.exec(id);
    if (lib) return { libraryID: Number(lib[1]), collectionKey: null };
    const coll = /^C(\d+):([A-Z0-9]{8})$/.exec(id);
    if (coll) return { libraryID: Number(coll[1]), collectionKey: coll[2]! };
    return null;
}

/** One entry of the Connector's "save to" list. */
export interface TargetRow {
    id: string;
    name: string;
    level: number;
    filesEditable: boolean;
    /** Listed again on top: the pinned collections, the last target. */
    recent?: true;
}

interface TreeCollection {
    libraryID: number;
    key: string;
    name: string;
    children: TreeCollection[];
}

interface TreeLibrary {
    libraryID: number;
    name: string;
    collections: TreeCollection[];
}

/**
 * The "save to" list: every library ZotFlow may write to, each followed by
 * its collections (as the library browser orders them). The collections
 * pinned in the library browser and the target used last are marked
 * `recent`, which the Connector lists above the rest.
 */
export function buildTargets(
    libraries: readonly TreeLibrary[],
    options: {
        writable: (libraryID: number) => boolean;
        filesEditable: (libraryID: number) => boolean;
        /** "libraryID:key", as the library browser keeps them. */
        pinned: readonly string[];
        last: string | null;
    },
): TargetRow[] {
    const pinned = new Set(
        options.pinned.map((p) => {
            const [lib, key] = p.split(":");
            return `C${lib}:${key}`;
        }),
    );
    const rows: TargetRow[] = [];
    const mark = (row: TargetRow): TargetRow =>
        pinned.has(row.id) || row.id === options.last
            ? { ...row, recent: true }
            : row;
    const walk = (cs: readonly TreeCollection[], level: number, files: boolean) => {
        for (const c of cs) {
            rows.push(
                mark({
                    id: targetId({ libraryID: c.libraryID, collectionKey: c.key }),
                    name: c.name,
                    level,
                    filesEditable: files,
                }),
            );
            walk(c.children, level + 1, files);
        }
    };
    for (const lib of libraries) {
        if (!options.writable(lib.libraryID)) continue;
        const files = options.filesEditable(lib.libraryID);
        rows.push(
            mark({
                id: targetId({ libraryID: lib.libraryID, collectionKey: null }),
                name: lib.name,
                level: 0,
                filesEditable: files,
            }),
        );
        walk(lib.collections, 1, files);
    }
    return rows;
}

/** A row's library and name, for the answer to getSelectedCollection. */
export function selectedCollection(
    rows: readonly TargetRow[],
    target: ConnectorTarget,
): Record<string, unknown> | null {
    const row = rows.find((r) => r.id === targetId(target));
    const lib = rows.find(
        (r) => r.id === targetId({ libraryID: target.libraryID, collectionKey: null }),
    );
    if (!row || !lib) return null;
    return {
        libraryID: target.libraryID,
        libraryName: lib.name,
        libraryEditable: true,
        filesEditable: lib.filesEditable,
        editable: true,
        id: target.collectionKey ? row.id : null,
        name: row.name,
        targets: rows,
        tags: {},
    };
}

/** The tags typed in the Connector's popup: a list, or one string with commas. */
export function parseTags(tags: unknown): string[] {
    const list = Array.isArray(tags)
        ? tags.map(String)
        : typeof tags === "string"
          ? tags.split(",")
          : [];
    return [...new Set(list.map((t) => t.trim()).filter(Boolean))];
}

/** A header value in RFC 2047's "Q" encoding (=?UTF-8?Q?...?=), as the Connector sends titles. */
export function decodeRfc2047(value: string): string {
    const m = /^=\?UTF-8\?Q\?(.*)\?=$/i.exec(value);
    if (!m) return value;
    const bytes: number[] = [];
    const s = m[1]!;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i]!;
        if (ch === "_") bytes.push(32);
        else if (ch === "=" && /^[0-9A-F]{2}$/i.test(s.slice(i + 1, i + 3))) {
            bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
            i += 2;
        } else bytes.push(ch.charCodeAt(0));
    }
    return new TextDecoder().decode(new Uint8Array(bytes));
}

/** The file's extension, from its type, else its address. */
export function extensionFor(contentType: string, url = ""): string {
    const type = contentType.split(";")[0]!.trim().toLowerCase();
    const known: Record<string, string> = {
        "application/pdf": "pdf",
        "application/epub+zip": "epub",
        "text/html": "html",
        "application/xhtml+xml": "html",
        "text/plain": "txt",
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/gif": "gif",
        "image/webp": "webp",
    };
    if (known[type]) return known[type];
    try {
        const ext = /\.([a-z0-9]{1,5})$/i.exec(new URL(url).pathname)?.[1];
        if (ext) return ext.toLowerCase();
    } catch {
        // No address.
    }
    return "bin";
}

/**
 * A file's name from its address (Zotero's `_getFileNameFromURL()`): the
 * last part of the path without its extension, else the last folder, else
 * the host; with `extension`; made valid and at most 100 characters
 * (`importFromSnapshotContent()`).
 */
export function fileNameFromURL(url: string, extension: string): string {
    let base = "";
    try {
        const u = new URL(url);
        const last = u.pathname.split("/").pop() ?? "";
        base = last.replace(/\.[^.]*$/, "");
        if (!base) base = /\/([^/]+)\/$/.exec(u.pathname)?.[1] ?? u.hostname;
        try {
            base = decodeURIComponent(base);
        } catch {
            // As it is.
        }
    } catch {
        base = "";
    }
    // Zotero.File.getValidFileName(): no path or reserved characters, no control characters.
    // eslint-disable-next-line no-control-regex -- control characters are what is taken out
    base = base.replace(/[/\\?*:|"<>\u0000-\u001f]/g, "").replace(/^[.\s]+|[.\s]+$/g, "");
    const name = `${base || "file"}.${extension}`;
    return name.length > 100 ? `${base.slice(0, 100 - extension.length - 1)}.${extension}` : name;
}

/** An item as the Zotero web API takes it. */
export type ApiItem = Record<string, unknown> & {
    key?: string;
    itemType: string;
    parentItem?: string;
};

/** An item as a translator made it (the parts ZotFlow reads). */
export interface TranslatorItem {
    id?: string | number;
    attachments?: {
        id?: string;
        url?: string;
        title?: string;
        mimeType?: string;
        snapshot?: boolean;
    }[];
}

/**
 * The items to write for one save: each translator item converted (by the
 * Connector: `zotflow.apiItems`, one array per item — the item, then its
 * notes), put in `collectionKey`, with its linked attachments (those the
 * translator does not want downloaded). Also: which key each translator
 * item got, for the files that follow.
 */
export function itemsToWrite(
    items: readonly TranslatorItem[],
    apiItems: readonly (readonly ApiItem[])[],
    collectionKey: string | null,
): { write: ApiItem[]; keys: Map<string, string>; top: string[] } {
    if (apiItems.length !== items.length)
        throw new Error("The connector sent the items without their Zotero form; update it.");
    const write: ApiItem[] = [];
    const keys = new Map<string, string>();
    const top: string[] = [];
    items.forEach((item, i) => {
        const group = apiItems[i]!;
        const main = group[0];
        if (!main?.key || typeof main.key !== "string")
            throw new Error("An item came without its key.");
        if (item.id !== undefined) keys.set(String(item.id), main.key);
        top.push(main.key);
        write.push({
            ...main,
            collections: collectionKey ? [collectionKey] : [],
            relations: {},
        });
        for (const child of group.slice(1)) write.push({ ...child });
        for (const att of item.attachments ?? []) {
            if (att.snapshot !== false || !att.url) continue;
            write.push({
                itemType: "attachment",
                parentItem: main.key,
                linkMode: "linked_url",
                title: att.title || att.url,
                url: att.url,
                contentType: att.mimeType ?? "",
                tags: [],
                relations: {},
            });
        }
    });
    return { write, keys, top };
}

/** What a new file's name is made of (the "file name" template), from the item it belongs to. */
export function namePartsOf(item: ApiItem | undefined): {
    lastName: string;
    year: string;
    shortTitle: string;
    title: string;
    itemType: string;
} {
    const creators = Array.isArray(item?.creators)
        ? (item.creators as { lastName?: string; name?: string }[])
        : [];
    const first = creators[0];
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    return {
        lastName: str(first?.lastName) || str(first?.name),
        year: /\b(\d{4})\b/.exec(str(item?.date))?.[1] ?? "",
        shortTitle: str(item?.shortTitle),
        title: str(item?.title),
        itemType: str(item?.itemType) || "document",
    };
}

/** The answer to a ping: what this "client" does. */
export function pingPrefs(options: { files: boolean; snapshots: boolean }): Record<string, unknown> {
    return {
        // Zotero's preferences of the same names (its defaults: both on).
        downloadAssociatedFiles: options.files,
        automaticSnapshots: options.snapshots,
        reportActiveURL: false,
        supportsAttachmentUpload: true,
        supportsTagsAutocomplete: false,
        canUserAddNote: true,
        googleDocsAddAnnotationEnabled: false,
        googleDocsCitationExplorerEnabled: false,
        // No translatorsHash: the Connector takes its translators from repo.zotero.org.
    };
}

/**
 * Why a request is refused (its status), or null. Only the Connector may
 * talk to ZotFlow: a web page in the browser can reach 127.0.0.1 too, so a
 * request from a web page's origin is refused, and every POST must carry
 * the Connector's API header — which a page cannot send to another origin
 * without a preflight, and the preflight is never allowed.
 */
export function refusal(
    method: string,
    headers: Record<string, string | string[] | undefined>,
): number | null {
    const origin = headers["origin"];
    if (typeof origin === "string" && /^https?:/i.test(origin)) return 403;
    if (method === "OPTIONS") return 403;
    if (method === "POST" && !headers["x-zotero-connector-api-version"]) return 403;
    if (method !== "POST" && method !== "GET") return 405;
    return null;
}
