/**
 * ZotFlow Evo (fork): save a file found in Obsidian's web viewer (Anna's
 * Archive) to the selected Zotero item, as a stored file in Zotero's
 * storage, named by the "file name" template. See FORK.md, "Saving a file
 * to an item".
 *
 * Getting the file, in this order, until one works:
 * 1. With an Anna's Archive key (settings): the member API gives a download
 *    link for the book's MD5 (taken from the address).
 * 2. Anna's viewer: the PDF it has loaded, read from the page.
 * 3. The address itself (a fast download that landed on a partner server),
 *    or a file address inside it, fetched directly.
 * 4. Inside the page, with the page's login: the address, or on a book
 *    page its first fast download link.
 *
 * Uploading: the attachment item is created with the Zotero web API, the
 * file goes to Zotero's storage (the file upload protocol of the API), and
 * a sync brings the new attachment here.
 */
import { Menu, Platform, requestUrl } from "obsidian";
import SparkMD5 from "spark-md5";

import { workerBridge } from "bridge";
import { services } from "services/services";
import { startSync } from "ui/start-sync";
import { lastScope, lastSelection } from "ui/evo-library/selection";
import {
    findIsbns,
    fromGoogleBooks,
    fromOpenLibrary,
    yearOfDate,
} from "utils/evo-isbn";
import {
    DEFAULT_BOOK_SEARCH_URL,
    embeddedUrls,
    md5FromUrl,
    sniffFile,
} from "utils/evo-library-model";

import type { App, Plugin, RequestUrlResponse, WorkspaceLeaf } from "obsidian";
import type { SelectedItem } from "ui/evo-library/selection";
import type { BookMetadata } from "utils/evo-isbn";

/* ------------------------------------------------------------------ */
/*  Files                                                             */
/* ------------------------------------------------------------------ */

export interface FetchedFile {
    bytes: ArrayBuffer;
    contentType: string;
    extension: string;
    /** How it was got, for the notice. */
    route: string;
}

/** Where Anna's Archive is: the page's own site, else the search address's. */
export function annasBase(pageUrl: string): string {
    try {
        const page = new URL(pageUrl);
        if (/annas-archive/i.test(page.hostname)) return page.origin;
    } catch {
        // The setting.
    }
    try {
        return new URL(
            services.settings.evoBookSearchUrl || DEFAULT_BOOK_SEARCH_URL,
        ).origin;
    } catch {
        return new URL(DEFAULT_BOOK_SEARCH_URL).origin;
    }
}

/** A response's JSON, or null when it is none. */
function jsonOf<T>(res: RequestUrlResponse): T | null {
    try {
        return res.json as T;
    } catch {
        return null;
    }
}

function base64ToBuffer(data: string): ArrayBuffer {
    const binary = atob(data);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out.buffer;
}

/** Electron's <webview> as Obsidian's web viewer has it. */
interface WebviewLike {
    getURL(): string;
    executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
}

/** The web page in a web viewer leaf. */
export function webviewOf(leaf: WorkspaceLeaf | null): WebviewLike | null {
    if (!leaf || leaf.view?.getViewType() !== "webviewer") return null;
    const el = leaf.view.containerEl.querySelector(
        "webview",
    ) as unknown as WebviewLike | null;
    return el && typeof el.executeJavaScript === "function" ? el : null;
}

/** In-page code: bytes as base64, in chunks (a book can be large). */
const IN_PAGE_BASE64 = `const zfB64 = (buf) => { const b = new Uint8Array(buf); let s = ""; for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode.apply(null, b.subarray(i, i + 32768)); return btoa(s); };`;

async function viaMemberKey(md5: string, base: string): Promise<FetchedFile> {
    const key = services.settings.evoAnnasKey;
    const api = await requestUrl({
        url: `${base}/dyn/api/fast_download.json?md5=${md5}&key=${encodeURIComponent(key ?? "")}`,
        throw: false,
    });
    const json = jsonOf<{ download_url?: string; error?: string }>(api);
    if (!json?.download_url)
        throw new Error(json?.error || `member API answered ${api.status}`);
    return await direct(json.download_url, "member key");
}

async function direct(url: string, route: string): Promise<FetchedFile> {
    const res = await requestUrl({ url, throw: false });
    if (res.status >= 400) throw new Error(`${route}: HTTP ${res.status}`);
    const kind = sniffFile(res.arrayBuffer);
    if (!kind) throw new Error(`${route}: not a PDF, EPUB or DjVu`);
    return { bytes: res.arrayBuffer, ...kind, route };
}

async function fromViewer(webview: WebviewLike): Promise<FetchedFile> {
    const data = (await webview.executeJavaScript(
        `(async () => { ${IN_PAGE_BASE64}
            const app = window.PDFViewerApplication;
            if (!app || !app.pdfDocument) return null;
            return zfB64(await app.pdfDocument.getData());
        })()`,
    )) as string | null;
    if (!data) throw new Error("no PDF viewer on the page");
    const bytes = base64ToBuffer(data);
    const kind = sniffFile(bytes);
    if (!kind) throw new Error("the viewer's file is not a PDF");
    return { bytes, ...kind, route: "Anna's viewer" };
}

async function inPage(webview: WebviewLike, url: string): Promise<FetchedFile> {
    const result = (await webview.executeJavaScript(
        `(async () => { ${IN_PAGE_BASE64}
            let target = ${JSON.stringify(url)};
            if (target === location.href) {
                const link = document.querySelector('a[href*="/fast_download/"]');
                if (link) target = link.href;
            }
            try {
                const r = await fetch(target, { credentials: "include" });
                const type = r.headers.get("content-type") || "";
                if (!r.ok) return { error: "HTTP " + r.status };
                if (/html/i.test(type)) return { error: "got a web page, not a file" };
                return { data: zfB64(await r.arrayBuffer()) };
            } catch (e) {
                return { error: String(e && e.message || e) };
            }
        })()`,
    )) as { data?: string; error?: string } | null;
    if (!result?.data) throw new Error(result?.error || "nothing came back");
    const bytes = base64ToBuffer(result.data);
    const kind = sniffFile(bytes);
    if (!kind) throw new Error("not a PDF, EPUB or DjVu");
    return { bytes, ...kind, route: "the page's login" };
}

/**
 * The file behind an address (a link, or the page shown in `webview`),
 * trying the ways in the order at the top of this file.
 */
export async function obtainFile(
    url: string,
    webview: WebviewLike | null,
): Promise<FetchedFile> {
    const failures: string[] = [];
    const attempt = async (
        label: string,
        run: () => Promise<FetchedFile>,
    ): Promise<FetchedFile | null> => {
        try {
            return await run();
        } catch (e) {
            failures.push(
                `${label}: ${e instanceof Error ? e.message : String(e)}`,
            );
            return null;
        }
    };
    const md5 = md5FromUrl(url);
    const base = annasBase(url);
    const onPage = !!webview && webview.getURL() === url;

    let file: FetchedFile | null = null;
    if (md5 && services.settings.evoAnnasKey)
        file = await attempt("member key", () => viaMemberKey(md5, base));
    if (!file && onPage && webview)
        file = await attempt("viewer", () => fromViewer(webview));
    if (!file) file = await attempt("address", () => direct(url, "address"));
    for (const inner of embeddedUrls(url)) {
        if (file) break;
        file = await attempt("file address", () =>
            direct(inner, "file address"),
        );
    }
    if (!file && webview)
        file = await attempt("page login", () => inPage(webview, url));
    if (file) return file;
    services.logService.warn(
        `No file at ${url}: ${failures.join("; ")}`,
        "EvoAttach",
    );
    throw new Error(
        md5 && !services.settings.evoAnnasKey
            ? "Couldn't get the file. Open the fast download (or Anna's viewer) in this pane and save again, or set your Anna's Archive key in the settings."
            : "Couldn't get the file. Open the file itself (a fast download, or Anna's viewer) in this pane and save again.",
    );
}

/* ------------------------------------------------------------------ */
/*  Upload to Zotero's storage                                        */
/* ------------------------------------------------------------------ */

function writeToken(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function concat(...parts: (ArrayBuffer | Uint8Array)[]): ArrayBuffer {
    const arrays = parts.map((p) =>
        p instanceof Uint8Array ? p : new Uint8Array(p),
    );
    const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
    let at = 0;
    for (const a of arrays) {
        out.set(a, at);
        at += a.length;
    }
    return out.buffer;
}

/** Why this item cannot take a file from here, or null. */
export function attachRefusal(libraryID: number): string | null {
    const cache = services.libraryCache;
    if (!services.settings.zoteroapikey) return "No Zotero API key is set.";
    if (!cache.canWrite(libraryID))
        return "The API key may not write to this library.";
    if (services.settings.useWebDav && !cache.isGroup(libraryID))
        return "This library keeps its files on WebDAV; ZotFlow can only save to Zotero's storage.";
    return null;
}

/**
 * Save a file to an item: a new stored-file attachment in Zotero's storage.
 * Returns the file name it got.
 */
export async function uploadAttachment(
    target: { libraryID: number; key: string },
    file: FetchedFile,
    /** For an item not synced here yet: what its file name is made of. */
    parts?: {
        lastName: string;
        year: string;
        shortTitle: string;
        title: string;
        itemType: string;
    },
): Promise<string> {
    const refusal = attachRefusal(target.libraryID);
    if (refusal) throw new Error(refusal);
    const apiKey = services.settings.zoteroapikey;
    const prefix = services.libraryCache.isGroup(target.libraryID)
        ? `groups/${target.libraryID}`
        : `users/${target.libraryID}`;
    const api = `https://api.zotero.org/${prefix}`;
    const named = parts
        ? await workerBridge.evoLibrary.attachFilenameFor(parts)
        : await workerBridge.evoLibrary.attachFilename(
              target.libraryID,
              target.key,
          );
    if (named.problem)
        services.notificationService.notify("warning", named.problem);
    const filename = `${named.name || "file"}.${file.extension}`;

    // 1. The attachment item (Zotero's template for a stored file).
    const created = await requestUrl({
        url: `${api}/items`,
        method: "POST",
        headers: {
            "Zotero-API-Key": apiKey,
            "Zotero-API-Version": "3",
            "Zotero-Write-Token": writeToken(),
        },
        contentType: "application/json",
        body: JSON.stringify([
            {
                itemType: "attachment",
                parentItem: target.key,
                linkMode: "imported_file",
                title: filename,
                accessDate: "",
                url: "",
                note: "",
                contentType: file.contentType,
                charset: "",
                filename,
                md5: null,
                mtime: null,
                tags: [],
                relations: {},
            },
        ]),
        throw: false,
    });
    const createdJson = jsonOf<{
        successful?: Record<string, { key?: string }>;
        failed?: Record<string, { message?: string }>;
    }>(created);
    const attachmentKey = createdJson?.successful?.["0"]?.key;
    if (created.status >= 300 || !attachmentKey) {
        throw new Error(
            `Zotero refused the attachment (${created.status}${createdJson?.failed?.["0"]?.message ? ": " + createdJson.failed["0"].message : ""}).`,
        );
    }

    // 2. Permission to upload the file.
    const md5 = SparkMD5.ArrayBuffer.hash(file.bytes);
    const fileUrl = `${api}/items/${attachmentKey}/file`;
    const form = (fields: Record<string, string | number>) =>
        Object.entries(fields)
            .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
            .join("&");
    const auth = await requestUrl({
        url: fileUrl,
        method: "POST",
        headers: { "Zotero-API-Key": apiKey, "If-None-Match": "*" },
        contentType: "application/x-www-form-urlencoded",
        body: form({
            md5,
            filename,
            filesize: file.bytes.byteLength,
            mtime: Date.now(),
        }),
        throw: false,
    });
    if (auth.status >= 300)
        throw new Error(`Zotero refused the upload (${auth.status}).`);
    const authJson = jsonOf<{
        exists?: number;
        url?: string;
        contentType?: string;
        prefix?: string;
        suffix?: string;
        uploadKey?: string;
    }>(auth);
    if (!authJson)
        throw new Error("Zotero's answer to the upload was unreadable.");

    if (!authJson.exists) {
        if (!authJson.url || !authJson.uploadKey)
            throw new Error("Zotero gave no upload address.");
        // 3. The file itself.
        const enc = new TextEncoder();
        const sent = await requestUrl({
            url: authJson.url,
            method: "POST",
            contentType: authJson.contentType,
            body: concat(
                enc.encode(authJson.prefix ?? ""),
                file.bytes,
                enc.encode(authJson.suffix ?? ""),
            ),
            throw: false,
        });
        if (sent.status >= 300)
            throw new Error(`The file upload failed (${sent.status}).`);
        // 4. Done.
        const registered = await requestUrl({
            url: fileUrl,
            method: "POST",
            headers: { "Zotero-API-Key": apiKey, "If-None-Match": "*" },
            contentType: "application/x-www-form-urlencoded",
            body: form({ upload: authJson.uploadKey }),
            throw: false,
        });
        if (registered.status >= 300)
            throw new Error(
                `Zotero did not register the upload (${registered.status}).`,
            );
    }

    // Bring the new attachment here.
    void startSync(target.libraryID, true).catch(() => {
        // The next sync brings it.
    });
    return filename;
}

/* ------------------------------------------------------------------ */
/*  From the web viewer                                               */
/* ------------------------------------------------------------------ */

/** The item a search for a missing file was opened for (the fallback target). */
let searchedFor: SelectedItem | null = null;

export function noteSearchTarget(item: SelectedItem): void {
    searchedFor = item;
}

/** Where a file goes: the item selected last in a library tab, else the one searched for. */
export function attachTarget(): SelectedItem | null {
    return lastSelection() ?? searchedFor;
}

function regular(item: SelectedItem): boolean {
    return (
        !item.itemType ||
        (item.itemType !== "attachment" && item.itemType !== "note")
    );
}

/** Get the file at `url` and save it to `target`, telling how it went. */
export async function saveUrlToItem(
    url: string,
    webview: WebviewLike | null,
    target: SelectedItem,
): Promise<void> {
    const notify = services.notificationService;
    if (!regular(target)) {
        notify.notify(
            "warning",
            "Select a regular item (not a note or a file) to save the file to.",
        );
        return;
    }
    const refusal = attachRefusal(target.libraryID);
    if (refusal) {
        notify.notify("error", refusal);
        return;
    }
    notify.notify("info", `Getting the file for “${target.label}”…`);
    try {
        const file = await obtainFile(url, webview);
        const name = await uploadAttachment(target, file);
        notify.notify(
            "success",
            `Saved “${name}” to “${target.label}” (via ${file.route}).`,
        );
    } catch (e) {
        services.logService.error("Failed to save the file", "EvoAttach", e);
        notify.notify(
            "error",
            e instanceof Error ? e.message : "Couldn't save the file.",
        );
    }
}

/* ------------------------------------------------------------------ */
/*  A new item from the ISBN on the page                              */
/* ------------------------------------------------------------------ */

/** The valid ISBNs in the text of the page shown. */
async function isbnsOnPage(webview: WebviewLike): Promise<string[]> {
    const text = (await webview.executeJavaScript(
        "document.body ? document.body.innerText : ''",
    )) as string;
    return findIsbns(String(text ?? "").slice(0, 400_000));
}

/** A book's metadata for an ISBN: Open Library, else Google Books. */
export async function lookupIsbn(isbn: string): Promise<BookMetadata | null> {
    try {
        const ol = await requestUrl({
            url: `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`,
            throw: false,
        });
        const found =
            ol.status < 300 ? fromOpenLibrary(jsonOf(ol), isbn) : null;
        if (found) return found;
    } catch {
        // Google Books next.
    }
    try {
        const gb = await requestUrl({
            url: `https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`,
            throw: false,
        });
        return gb.status < 300 ? fromGoogleBooks(jsonOf(gb), isbn) : null;
    } catch {
        return null;
    }
}

/** Create a book item with Zotero's web API; returns its key. */
export async function createBookItem(
    libraryID: number,
    collectionKey: string | null,
    book: BookMetadata,
): Promise<string> {
    const prefix = services.libraryCache.isGroup(libraryID)
        ? `groups/${libraryID}`
        : `users/${libraryID}`;
    const res = await requestUrl({
        url: `https://api.zotero.org/${prefix}/items`,
        method: "POST",
        headers: {
            "Zotero-API-Key": services.settings.zoteroapikey,
            "Zotero-API-Version": "3",
            "Zotero-Write-Token": writeToken(),
        },
        contentType: "application/json",
        body: JSON.stringify([
            {
                itemType: "book",
                title: book.title,
                creators: book.creators,
                date: book.date,
                publisher: book.publisher,
                place: book.place,
                numPages: book.numPages,
                language: book.language,
                ISBN: book.ISBN,
                collections: collectionKey ? [collectionKey] : [],
                tags: [],
                relations: {},
            },
        ]),
        throw: false,
    });
    const json = jsonOf<{
        successful?: Record<string, { key?: string }>;
        failed?: Record<string, { message?: string }>;
    }>(res);
    const key = json?.successful?.["0"]?.key;
    if (res.status >= 300 || !key)
        throw new Error(
            `Zotero refused the new item (${res.status}${json?.failed?.["0"]?.message ? ": " + json.failed["0"].message : ""}).`,
        );
    return key;
}

/**
 * A new book item, from the ISBN on the page shown, in the library or
 * collection shown last in a library tab, with the page's file saved to it.
 * The file is got first: nothing is created when there is none.
 */
export async function saveAsNewItem(webview: WebviewLike): Promise<void> {
    const notify = services.notificationService;
    const scope = lastScope();
    if (!scope) {
        notify.notify(
            "warning",
            "Open the collection in a Zotero library tab first.",
        );
        return;
    }
    const refused = attachRefusal(scope.libraryID);
    if (refused) {
        notify.notify("error", refused);
        return;
    }
    try {
        const isbns = await isbnsOnPage(webview);
        if (!isbns.length)
            throw new Error(
                "No ISBN on this page. Use the book's page on Anna's Archive.",
            );
        let book: BookMetadata | null = null;
        for (const isbn of isbns.slice(0, 4)) {
            book = await lookupIsbn(isbn);
            if (book) break;
        }
        if (!book)
            throw new Error(
                `No book found for ISBN ${isbns[0]} (Open Library, Google Books).`,
            );
        notify.notify("info", `Getting the file for “${book.title}”…`);
        const file = await obtainFile(webview.getURL(), webview);
        const key = await createBookItem(
            scope.libraryID,
            scope.collectionKey,
            book,
        );
        const name = await uploadAttachment(
            { libraryID: scope.libraryID, key },
            file,
            {
                lastName: book.creators[0]?.lastName ?? "",
                year: yearOfDate(book.date),
                shortTitle: book.title.split(":")[0]!.trim(),
                title: book.title,
                itemType: "book",
            },
        );
        notify.notify(
            "success",
            `Created “${book.title}” (ISBN ${book.ISBN}) in “${scope.label}”, with “${name}” (via ${file.route}).`,
        );
    } catch (e) {
        services.logService.error("Failed to create the item", "EvoAttach", e);
        notify.notify(
            "error",
            e instanceof Error ? e.message : "Couldn't create the item.",
        );
    }
}

/** The web viewer leaf to save from: the active one, else the last one used. */
function webViewerLeaf(app: App): WorkspaceLeaf | null {
    const active = app.workspace.getMostRecentLeaf();
    if (active?.view?.getViewType() === "webviewer") return active;
    return app.workspace.getLeavesOfType("webviewer")[0] ?? null;
}

/** "Save to the selected item" from a web viewer: a menu naming where it goes. */
export function showSaveMenu(
    app: App,
    leaf: WorkspaceLeaf | null,
    event?: MouseEvent,
): void {
    const from = leaf ?? webViewerLeaf(app);
    const webview = webviewOf(from);
    if (!webview) {
        services.notificationService.notify(
            "warning",
            "Open the file in a web viewer pane first.",
        );
        return;
    }
    const selected = lastSelection();
    const targets = [selected, searchedFor].filter(
        (t, i, all): t is SelectedItem =>
            !!t &&
            all.findIndex(
                (o) => o?.libraryID === t.libraryID && o?.key === t.key,
            ) === i,
    );
    const scope = lastScope();
    if (!targets.length && !scope) {
        services.notificationService.notify(
            "warning",
            "Select the item (or open the collection) in a Zotero library tab first.",
        );
        return;
    }
    const menu = new Menu();
    for (const target of targets) {
        menu.addItem((item) =>
            item
                .setTitle(`Save this file to “${target.label}”`)
                .setIcon("paperclip")
                .onClick(
                    () => void saveUrlToItem(webview.getURL(), webview, target),
                ),
        );
    }
    if (scope) {
        if (targets.length) menu.addSeparator();
        menu.addItem((item) =>
            item
                .setTitle(`New item from this page's ISBN, in “${scope.label}”`)
                .setIcon("book-plus")
                .onClick(() => void saveAsNewItem(webview)),
        );
    }
    if (event) menu.showAtMouseEvent(event);
    else {
        const rect = from?.view.containerEl.getBoundingClientRect();
        menu.showAtPosition({
            x: (rect?.right ?? 200) - 40,
            y: (rect?.top ?? 0) + 40,
        });
    }
}

/**
 * The web viewer gets a header button, and links in it (where Obsidian
 * offers its link menu) a menu entry, both saving to the selected item.
 * Desktop only: the web viewer is.
 */
export function registerAttachFromWebViewer(plugin: Plugin): void {
    if (!Platform.isDesktopApp) return;
    const { app } = plugin;
    const withButton = new WeakSet<object>();
    const addButtons = () => {
        for (const leaf of app.workspace.getLeavesOfType("webviewer")) {
            const view = leaf.view as unknown as {
                addAction?: (
                    icon: string,
                    title: string,
                    cb: (evt: MouseEvent) => unknown,
                ) => HTMLElement;
            };
            if (withButton.has(view) || typeof view.addAction !== "function")
                continue;
            withButton.add(view);
            view.addAction(
                "paperclip",
                "Save this file to the selected Zotero item",
                (evt) => showSaveMenu(app, leaf, evt),
            );
        }
    };
    plugin.registerEvent(app.workspace.on("layout-change", addButtons));
    plugin.registerEvent(app.workspace.on("active-leaf-change", addButtons));
    app.workspace.onLayoutReady(addButtons);

    plugin.registerEvent(
        app.workspace.on("url-menu", (menu, url) => {
            const target = attachTarget();
            if (!target || !regular(target)) return;
            menu.addItem((item) =>
                item
                    .setTitle(`Save link to “${target.label}”`)
                    .setIcon("paperclip")
                    .onClick(() => {
                        const webview = webviewOf(webViewerLeaf(app));
                        void saveUrlToItem(url, webview, target);
                    }),
            );
        }),
    );

    plugin.addCommand({
        id: "save-web-file-to-item",
        name: "Save the web viewer's file to the selected Zotero item",
        checkCallback: (checking) => {
            const leaf = webViewerLeaf(app);
            if (!leaf || (!attachTarget() && !lastScope())) return false;
            if (!checking) showSaveMenu(app, leaf);
            return true;
        },
    });
}
