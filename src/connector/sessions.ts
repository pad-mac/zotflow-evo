/**
 * ZotFlow Evo: one save from the browser connector, from the items to the
 * files that follow them and the changes made in the Connector's popup
 * (another collection or library, tags, a note), and an open-access file
 * looked for when the browser found none. Written with Zotero's web API,
 * through `ConnectorApi`, which also stores what Zotero returned in
 * ZotFlow at once. See FORK.md, "Browser connector".
 */
import { doiOf, hasFileResolvers, type FoundFile } from "connector/find-file";
import {
    fileNameFromURL,
    itemsToWrite,
    namePartsOf,
    parseTags,
    parseTargetId,
    type ApiItem,
    type ConnectorTarget,
    type TranslatorItem,
} from "connector/protocol";

/** What the sessions need from ZotFlow (the web API, the sync, settings). */
export interface ConnectorApi {
    /** Create items under the keys they carry (or new ones); each one's key and version. */
    writeItems(
        libraryID: number,
        items: ApiItem[],
    ): Promise<{ key: string | null; version?: number; message?: string }[]>;
    /** Change some fields of an item; `version` when known. */
    patchItem(
        libraryID: number,
        key: string,
        patch: Record<string, unknown>,
        version?: number,
    ): Promise<void>;
    deleteItems(libraryID: number, keys: string[]): Promise<void>;
    /** A stored file under `parentKey` (from `url`, as Zotero saves files from the web); its attachment's key. */
    attachFile(
        target: { libraryID: number; key: string },
        file: ConnectorFile,
        nameParts: ReturnType<typeof namePartsOf>,
        options: AttachFileOptions,
    ): Promise<string>;
    /** An open-access file for this DOI (Zotero's resolvers), or null. */
    findFile(doi: string): Promise<FoundFile | null>;
    /** A stored file on its own, in a collection or not; its key. */
    standaloneFile(
        target: ConnectorTarget,
        file: ConnectorFile,
    ): Promise<string>;
    /** Whether files can be saved to this library from here. */
    filesEditable(libraryID: number): boolean;
    /** Sync this library soon (a later call or `delaySync` moves it on). */
    syncSoon(libraryID: number): void;
    /** Where a save goes when the popup has not said. */
    defaultTarget(): ConnectorTarget | null;
    /** The popup chose this target: it becomes the default. */
    rememberTarget(target: ConnectorTarget): void;
}

/** As Zotero makes the attachment: its title, where the file came from, its name when not from the template. */
export interface AttachFileOptions {
    title: string;
    url: string;
    filename?: string;
    charset?: string;
}

export interface ConnectorFile {
    bytes: Uint8Array;
    contentType: string;
    extension: string;
    title: string;
    url: string;
}

/** A failure the Connector is told about, with the status its server would answer. */
export class ConnectorError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
    }
}

interface SavedFile {
    /** The translator item it belongs to (none: a file on its own). */
    parent: string | null;
    file: ConnectorFile;
    /** For a file under an item. */
    options?: AttachFileOptions;
    /** Its attachment, once written. */
    key: string | null;
}

interface Session {
    id: string;
    target: ConnectorTarget;
    /** What was written, to write it again elsewhere. */
    items: TranslatorItem[];
    apiItems: ApiItem[][];
    /** Translator item id → its key. */
    keys: Map<string, string>;
    /** The top-level items (the files on their own too), with their versions when known. */
    top: { key: string; version?: number; tags: { tag: string; type?: number }[] }[];
    /** Everything written in the target library (to take back when it moves). */
    written: string[];
    files: SavedFile[];
    tags: string[];
    note: string;
    /** The note added under each top-level item: item key → note key. */
    notes: Map<string, string>;
    /** One change after the other. */
    queue: Promise<unknown>;
    touched: number;
}

/** Sessions are forgotten this long after their last use. */
const SESSION_TTL_MS = 30 * 60 * 1000;

export class ConnectorSessions {
    private readonly sessions = new Map<string, Session>();

    constructor(
        private readonly api: ConnectorApi,
        private readonly now: () => number = () => Date.now(),
    ) {}

    /** saveItems: write the items (and their linked attachments) to the default target. */
    async saveItems(payload: {
        sessionID?: unknown;
        items?: unknown;
        zotflow?: { apiItems?: unknown };
    }): Promise<void> {
        const id = this.newSessionId(payload.sessionID);
        const items = Array.isArray(payload.items)
            ? (payload.items as TranslatorItem[])
            : [];
        const apiItems = payload.zotflow?.apiItems;
        if (!Array.isArray(apiItems))
            throw new ConnectorError(
                400,
                "This connector does not send items ZotFlow can save; use the Zot Vitro Connector.",
            );
        const session = this.open(id, items, apiItems as ApiItem[][]);
        await this.run(session, () => this.write(session));
    }

    /** saveSnapshot: a web page item for a page no translator reads. */
    async saveSnapshot(payload: {
        sessionID?: unknown;
        url?: unknown;
        title?: unknown;
    }): Promise<void> {
        const id = this.newSessionId(payload.sessionID);
        const url = typeof payload.url === "string" ? payload.url : "";
        const title =
            typeof payload.title === "string" && payload.title.trim()
                ? payload.title.trim()
                : url;
        const key = randomKey();
        const item: ApiItem = {
            key,
            version: 0,
            itemType: "webpage",
            title,
            url,
            accessDate: new Date(this.now()).toISOString().replace(/\.\d+Z$/, "Z"),
        };
        const session = this.open(id, [{ id: "1", attachments: [] }], [[item]]);
        await this.run(session, () => this.write(session));
    }

    /** saveAttachment: a file of an item saved before, fetched by the browser. */
    async saveAttachment(
        sessionID: string,
        meta: { parentItemID?: unknown },
        file: ConnectorFile,
    ): Promise<void> {
        const session = this.get(sessionID);
        const parent =
            typeof meta.parentItemID === "string" || typeof meta.parentItemID === "number"
                ? String(meta.parentItemID)
                : "";
        if (!session.keys.has(parent))
            throw new ConnectorError(400, "The file's item is not in this save.");
        // Zotero: importFromNetworkStream() with the title and address the Connector sent.
        const saved: SavedFile = {
            parent,
            file,
            options: { title: file.title || "Attachment", url: file.url },
            key: null,
        };
        session.files.push(saved);
        await this.run(session, () => this.writeFile(session, saved));
    }

    /**
     * hasAttachmentResolvers: whether Zotero would look for an open-access
     * file for this item (`getFileResolvers(item, ['oa', 'custom'], true)`:
     * it has a DOI).
     */
    hasResolvers(sessionID: string, itemID: unknown): boolean {
        const session = this.get(sessionID);
        return hasFileResolvers(this.apiItemOf(session, itemID));
    }

    /**
     * saveAttachmentFromResolver: the first open-access file Zotero's
     * resolvers give, saved under the item (`addFileFromURLs()`); its title.
     */
    async saveFromResolver(sessionID: string, itemID: unknown): Promise<string> {
        const session = this.get(sessionID);
        const parent = this.parentId(session, itemID);
        const doi = doiOf(this.apiItemOf(session, itemID));
        if (!doi) throw new ConnectorError(500, "Failed to save an attachment");
        const found = await this.api.findFile(doi);
        if (!found) throw new ConnectorError(500, "Failed to save an attachment");
        const extension = found.contentType === "application/epub+zip" ? "epub" : "pdf";
        const saved: SavedFile = {
            parent,
            file: { bytes: found.bytes, contentType: found.contentType, extension, title: found.title, url: found.url },
            options: { title: found.title, url: found.url },
            key: null,
        };
        session.files.push(saved);
        await this.run(session, () => this.writeFile(session, saved));
        return found.title;
    }

    /** saveSingleFile: the page as an HTML snapshot, under the save's first item. */
    async saveSnapshotFile(
        sessionID: string,
        html: string,
        title: string,
        url: string,
    ): Promise<void> {
        const session = this.get(sessionID);
        const parent = [...session.keys.keys()][0];
        if (parent === undefined)
            throw new ConnectorError(400, "Nothing in this save takes a snapshot.");
        const file: ConnectorFile = {
            bytes: new TextEncoder().encode(html),
            contentType: "text/html",
            extension: "html",
            title: title || "Snapshot",
            url,
        };
        // Zotero: importFromSnapshotContent() — named from the address, in UTF-8.
        const saved: SavedFile = {
            parent,
            file,
            options: {
                title: file.title,
                url,
                filename: fileNameFromURL(url, "html"),
                charset: "utf-8",
            },
            key: null,
        };
        session.files.push(saved);
        await this.run(session, () => this.writeFile(session, saved));
    }

    /** saveStandaloneAttachment: a file shown in the browser (a PDF), on its own. */
    async saveStandalone(sessionID: unknown, file: ConnectorFile): Promise<void> {
        const id = this.newSessionId(sessionID);
        const session = this.open(id, [], []);
        const saved: SavedFile = { parent: null, file, key: null };
        session.files.push(saved);
        await this.run(session, () => this.writeFile(session, saved));
    }

    /** updateSession: the popup changed the target, the tags or the note. */
    async update(payload: {
        sessionID?: unknown;
        target?: unknown;
        tags?: unknown;
        note?: unknown;
    }): Promise<void> {
        const session = this.get(
            typeof payload.sessionID === "string" ? payload.sessionID : "",
        );
        await this.run(session, async () => {
            const target = parseTargetId(payload.target);
            if (target) this.api.rememberTarget(target);
            if (target && target.libraryID !== session.target.libraryID) {
                await this.moveToLibrary(session, target);
            } else if (target && target.collectionKey !== session.target.collectionKey) {
                session.target = target;
                await this.patchTop(session, () => ({
                    collections: target.collectionKey ? [target.collectionKey] : [],
                }));
            }
            if (payload.tags !== undefined) {
                const tags = parseTags(payload.tags);
                if (tags.join("\n") !== session.tags.join("\n")) {
                    session.tags = tags;
                    await this.patchTop(session, (top) => ({
                        tags: [
                            ...top.tags,
                            ...tags.map((tag) => ({ tag })),
                        ],
                    }));
                }
            }
            if (typeof payload.note === "string" && payload.note !== session.note) {
                session.note = payload.note;
                await this.writeNotes(session);
            }
            this.api.syncSoon(session.target.libraryID);
        });
    }

    has(sessionID: string): boolean {
        return this.sessions.has(sessionID);
    }

    private parentId(session: Session, itemID: unknown): string {
        const id = typeof itemID === "string" || typeof itemID === "number" ? String(itemID) : "";
        if (!session.keys.has(id)) throw new ConnectorError(400, "The item is not in this save.");
        return id;
    }

    /** The item as written (Zotero's web API form), by the Connector's id for it. */
    private apiItemOf(session: Session, itemID: unknown): ApiItem | undefined {
        const id = this.parentId(session, itemID);
        const i = session.items.findIndex((it) => String(it.id) === id);
        return session.apiItems[i]?.[0];
    }

    /* -------------------------------------------------------------- */

    private newSessionId(sessionID: unknown): string {
        this.expire();
        const id =
            typeof sessionID === "string" && sessionID ? sessionID : randomKey();
        if (this.sessions.has(id))
            throw new ConnectorError(409, "SESSION_EXISTS");
        return id;
    }

    private open(id: string, items: TranslatorItem[], apiItems: ApiItem[][]): Session {
        const target = this.api.defaultTarget();
        if (!target)
            throw new ConnectorError(
                500,
                "ZotFlow has no library it may save to (an API key that can write is needed).",
            );
        const session: Session = {
            id,
            target,
            items,
            apiItems,
            keys: new Map(),
            top: [],
            written: [],
            files: [],
            tags: [],
            note: "",
            notes: new Map(),
            queue: Promise.resolve(),
            touched: this.now(),
        };
        this.sessions.set(id, session);
        return session;
    }

    private get(sessionID: string): Session {
        const session = this.sessions.get(sessionID);
        if (!session) throw new ConnectorError(400, "Unknown save session.");
        session.touched = this.now();
        return session;
    }

    private expire(): void {
        const now = this.now();
        for (const [id, s] of this.sessions)
            if (now - s.touched > SESSION_TTL_MS) this.sessions.delete(id);
    }

    /** One change at a time; a failure does not stop the ones after it. */
    private run<T>(session: Session, task: () => Promise<T>): Promise<T> {
        const next = session.queue.then(task, task);
        session.queue = next.catch(() => undefined);
        return next;
    }

    /** The items in the session's target, with their linked attachments. */
    private async write(session: Session): Promise<void> {
        if (!session.apiItems.length) return;
        const { write, keys, top } = itemsToWrite(
            session.items,
            session.apiItems,
            session.target.collectionKey,
        );
        const result = await this.api.writeItems(session.target.libraryID, write);
        const failed = result.findIndex((r, i) => !r.key && top.includes(write[i]!.key!));
        if (failed !== -1) {
            // The items that were written are taken back: all or nothing.
            const done = result.flatMap((r) => (r.key ? [r.key] : []));
            if (done.length)
                await this.api.deleteItems(session.target.libraryID, done).catch(() => {});
            throw new ConnectorError(
                500,
                `Zotero refused the item: ${result[failed]!.message ?? "unknown reason"}`,
            );
        }
        session.keys = keys;
        session.written = result.flatMap((r) => (r.key ? [r.key] : []));
        session.top = top.map((key) => {
            const i = write.findIndex((w) => w.key === key);
            const own: unknown = write[i]?.tags;
            const tags = Array.isArray(own) ? (own as { tag: string; type?: number }[]) : [];
            return { key, version: result[i]?.version, tags };
        });
        this.api.syncSoon(session.target.libraryID);
    }

    private async writeFile(session: Session, saved: SavedFile): Promise<void> {
        const libraryID = session.target.libraryID;
        if (!this.api.filesEditable(libraryID))
            throw new ConnectorError(500, "Files cannot be saved to this library from ZotFlow.");
        if (saved.parent === null) {
            saved.key = await this.api.standaloneFile(session.target, saved.file);
            session.top.push({ key: saved.key, tags: [] });
        } else {
            const key = session.keys.get(saved.parent)!;
            const i = session.items.findIndex((it) => String(it.id) === saved.parent);
            saved.key = await this.api.attachFile(
                { libraryID, key },
                saved.file,
                namePartsOf(session.apiItems[i]?.[0]),
                saved.options ?? { title: saved.file.title, url: saved.file.url },
            );
        }
        session.written.push(saved.key);
        this.api.syncSoon(libraryID);
    }

    /** Patch every top-level item; versions are not known after the first change. */
    private async patchTop(
        session: Session,
        patch: (top: Session["top"][number]) => Record<string, unknown>,
    ): Promise<void> {
        for (const top of session.top) {
            await this.api.patchItem(
                session.target.libraryID,
                top.key,
                patch(top),
                top.version,
            );
            top.version = undefined;
        }
    }

    /** The note typed in the popup, under each top-level item (changed, or taken away). */
    private async writeNotes(session: Session): Promise<void> {
        const libraryID = session.target.libraryID;
        for (const top of session.top) {
            const noteKey = session.notes.get(top.key);
            if (noteKey && !session.note) {
                await this.api.deleteItems(libraryID, [noteKey]);
                session.notes.delete(top.key);
                session.written = session.written.filter((k) => k !== noteKey);
            } else if (noteKey) {
                await this.api.patchItem(libraryID, noteKey, { note: session.note });
            } else if (session.note) {
                const [r] = await this.api.writeItems(libraryID, [
                    { itemType: "note", parentItem: top.key, note: session.note, tags: [], relations: {} },
                ]);
                if (!r?.key) throw new ConnectorError(500, `Zotero refused the note: ${r?.message ?? ""}`);
                session.notes.set(top.key, r.key);
                session.written.push(r.key);
            }
        }
    }

    /**
     * Another library: what was written is taken out of the first and
     * written again in the second (under the same keys), files included.
     */
    private async moveToLibrary(session: Session, target: ConnectorTarget): Promise<void> {
        const from = session.target.libraryID;
        if (session.written.length) await this.api.deleteItems(from, session.written);
        this.api.syncSoon(from);
        session.target = target;
        session.written = [];
        session.top = [];
        session.notes = new Map();
        await this.write(session);
        if (session.tags.length) {
            const tags = session.tags;
            await this.patchTop(session, (top) => ({
                tags: [...top.tags, ...tags.map((tag) => ({ tag }))],
            }));
        }
        if (session.note) await this.writeNotes(session);
        for (const saved of session.files) {
            saved.key = null;
            if (this.api.filesEditable(target.libraryID))
                await this.writeFile(session, saved);
        }
    }
}

/** A Zotero object key: eight of Zotero's 32 characters. */
export function randomKey(): string {
    const chars = "23456789ABCDEFGHIJKLMNPQRSTUVWXYZ";
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}
