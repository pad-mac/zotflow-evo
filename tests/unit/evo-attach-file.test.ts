/**
 * ZotFlow Evo: `ui/evo-library/attach-file.ts` — getting a file from the web
 * viewer and saving it to an item in Zotero's storage. The Zotero and
 * Anna's Archive servers are stood in for by a fake `requestUrl`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import SparkMD5 from "spark-md5";

interface Call {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    contentType?: string;
    body?: string | ArrayBuffer;
}

const state = vi.hoisted(() => {
    const settings: Record<string, unknown> = {};
    const calls: Call[] = [];
    const routes: {
        match: RegExp;
        status: number;
        json?: unknown;
        bytes?: ArrayBuffer;
    }[] = [];
    const syncs: number[] = [];
    return { calls, routes, settings, group: false, canWrite: true, syncs };
});

vi.mock("obsidian", async (importOriginal) => {
    const original = await importOriginal<Record<string, unknown>>();
    return {
        ...original,
        Platform: { isDesktopApp: true },
        Menu: class {},
        requestUrl: async (req: Call) => {
            state.calls.push(req);
            const route = state.routes.find((r) =>
                r.match.test(`${req.method ?? "GET"} ${req.url}`),
            );
            const status = route?.status ?? 404;
            const bytes =
                route?.bytes ??
                new TextEncoder().encode(JSON.stringify(route?.json ?? {}))
                    .buffer;
            return {
                status,
                arrayBuffer: bytes,
                get json() {
                    if (route?.json === undefined) throw new Error("not JSON");
                    return route.json;
                },
            };
        },
    };
});

vi.mock("bridge", () => ({
    workerBridge: {
        evoLibrary: {
            attachFilename: async () => ({
                name: "schmidgen_2005_lebendige-kräfte",
            }),
            attachFilenameFor: async (parts: {
                lastName: string;
                year: string;
                shortTitle: string;
            }) => ({
                name: `${parts.lastName.toLowerCase()}_${parts.year}_${parts.shortTitle.toLowerCase().split(" ").slice(0, 2).join("-")}`,
            }),
        },
    },
}));

vi.mock("services/services", () => ({
    services: {
        get settings() {
            return state.settings;
        },
        libraryCache: {
            isGroup: () => state.group,
            canWrite: () => state.canWrite,
        },
        notificationService: { notify: vi.fn() },
        logService: { error: vi.fn(), warn: vi.fn() },
    },
}));

vi.mock("ui/start-sync", () => ({
    startSync: async (id: number) => {
        state.syncs.push(id);
        return "task";
    },
}));

import {
    attachRefusal,
    obtainFile,
    saveAsNewItem,
    uploadAttachment,
    uploadFileBytes,
} from "ui/evo-library/attach-file";
import { publishScope } from "ui/evo-library/selection";

const pdf = new TextEncoder().encode("%PDF-1.7\nhello").buffer;
const md5 = "0123456789abcdef0123456789abcdef";

beforeEach(() => {
    state.calls = [];
    state.routes = [];
    state.syncs = [];
    state.group = false;
    state.canWrite = true;
    state.settings = {
        zoteroapikey: "KEY",
        useWebDav: false,
        evoBookSearchUrl: "https://annas-archive.gl/search?q=",
    };
});

describe("getting the file", () => {
    it("with a member key: the API's download link", async () => {
        state.settings.evoAnnasKey = "SECRET";
        state.routes = [
            {
                match: /fast_download\.json\?md5=0123.*&key=SECRET/,
                status: 200,
                json: { download_url: "https://partner.example/file" },
            },
            { match: /partner\.example\/file/, status: 200, bytes: pdf },
        ];
        const file = await obtainFile(
            `https://annas-archive.gl/md5/${md5}`,
            null,
        );
        expect(file).toMatchObject({
            contentType: "application/pdf",
            extension: "pdf",
            route: "member key",
        });
    });

    it("without a key: the address itself, when it is the file", async () => {
        state.routes = [
            { match: /partner\.example\/dl/, status: 200, bytes: pdf },
        ];
        const file = await obtainFile("https://partner.example/dl/abc", null);
        expect(file.route).toBe("address");
    });

    it("without a key: Anna's viewer's PDF, read from the page", async () => {
        const webview = {
            getURL: () => `https://annas-archive.gl/view/${md5}`,
            executeJavaScript: async (code: string) =>
                code.includes("PDFViewerApplication")
                    ? btoa("%PDF-1.5 viewer")
                    : null,
        };
        const file = await obtainFile(webview.getURL(), webview);
        expect(file.route).toBe("Anna's viewer");
        expect(state.calls).toHaveLength(0);
    });

    it("a web page is no file: tells what to do", async () => {
        state.routes = [
            {
                match: /annas-archive/,
                status: 200,
                bytes: new TextEncoder().encode("<html>").buffer,
            },
        ];
        await expect(
            obtainFile(`https://annas-archive.gl/md5/${md5}`, null),
        ).rejects.toThrow(/Anna's Archive key/);
    });
});

describe("saving it to the item", () => {
    function zoteroRoutes() {
        state.routes = [
            {
                match: /^POST https:\/\/api\.zotero\.org\/users\/7\/items$/,
                status: 200,
                json: { successful: { "0": { key: "NEWATT01" } } },
            },
            {
                match: /^POST .*\/items\/NEWATT01\/file$/,
                status: 200,
                json: {
                    url: "https://s3.example/up",
                    contentType: "multipart/form-data; boundary=X",
                    prefix: "PRE",
                    suffix: "SUF",
                    uploadKey: "UPK",
                },
            },
            { match: /^POST https:\/\/s3\.example\/up$/, status: 201 },
        ];
    }

    it("creates the attachment, uploads, registers, then syncs", async () => {
        zoteroRoutes();
        // The register call answers 204 (same address as the authorisation).
        let fileCalls = 0;
        const routes = state.routes;
        state.routes = routes.map((r) =>
            /NEWATT01/.test(r.match.source)
                ? {
                      ...r,
                      get status() {
                          return fileCalls++ === 0 ? 200 : 204;
                      },
                  }
                : r,
        );
        const name = await uploadAttachment(
            { libraryID: 7, key: "PARENT01" },
            {
                bytes: pdf,
                contentType: "application/pdf",
                extension: "pdf",
                route: "address",
            },
        );
        expect(name).toBe("schmidgen_2005_lebendige-kräfte.pdf");
        const [create, auth, upload, register] = state.calls;
        const item = JSON.parse(create!.body as string)[0];
        expect(item).toMatchObject({
            itemType: "attachment",
            parentItem: "PARENT01",
            linkMode: "imported_file",
            contentType: "application/pdf",
            filename: name,
            title: name,
        });
        expect(create!.headers?.["Zotero-Write-Token"]).toMatch(
            /^[0-9a-f]{32}$/,
        );
        expect(auth!.headers?.["If-None-Match"]).toBe("*");
        const form = new URLSearchParams(auth!.body as string);
        expect(form.get("md5")).toBe(SparkMD5.ArrayBuffer.hash(pdf));
        expect(form.get("filename")).toBe(name);
        expect(form.get("filesize")).toBe(String(pdf.byteLength));
        expect(new TextDecoder().decode(upload!.body as ArrayBuffer)).toBe(
            "PRE%PDF-1.7\nhelloSUF",
        );
        expect(upload!.contentType).toBe("multipart/form-data; boundary=X");
        expect(register!.body).toBe("upload=UPK");
        expect(state.syncs).toEqual([7]);
    });

    it("a file Zotero already has is not uploaded again", async () => {
        state.routes = [
            {
                match: /\/items$/,
                status: 200,
                json: { successful: { "0": { key: "NEWATT01" } } },
            },
            { match: /\/file$/, status: 200, json: { exists: 1 } },
        ];
        await uploadAttachment(
            { libraryID: 7, key: "P" },
            {
                bytes: pdf,
                contentType: "application/pdf",
                extension: "pdf",
                route: "x",
            },
        );
        expect(state.calls).toHaveLength(2);
    });

    it("group libraries go to /groups/", async () => {
        state.group = true;
        state.routes = [
            {
                match: /groups\/9\/items$/,
                status: 200,
                json: { successful: { "0": { key: "K" } } },
            },
            { match: /\/file$/, status: 200, json: { exists: 1 } },
        ];
        await uploadAttachment(
            { libraryID: 9, key: "P" },
            {
                bytes: pdf,
                contentType: "application/pdf",
                extension: "pdf",
                route: "x",
            },
        );
        expect(state.calls[0]!.url).toBe(
            "https://api.zotero.org/groups/9/items",
        );
    });

    it("refuses where it cannot save", async () => {
        state.canWrite = false;
        expect(attachRefusal(7)).toMatch(/may not write/);
        state.canWrite = true;
        state.settings.useWebDav = true;
        expect(attachRefusal(7)).toMatch(/WebDAV/);
        state.group = true;
        expect(attachRefusal(9)).toBeNull();
        state.settings.zoteroapikey = "";
        expect(attachRefusal(9)).toMatch(/API key/);
    });

    it("a refused item creation stops before any upload", async () => {
        state.routes = [
            {
                match: /\/items$/,
                status: 400,
                json: { failed: { "0": { message: "Parent item not found" } } },
            },
        ];
        await expect(
            uploadAttachment(
                { libraryID: 7, key: "P" },
                {
                    bytes: pdf,
                    contentType: "application/pdf",
                    extension: "pdf",
                    route: "x",
                },
            ),
        ).rejects.toThrow(/Parent item not found/);
        expect(state.calls).toHaveLength(1);
    });
});

describe("a new item from the ISBN on the page", () => {
    it("looks the ISBN up, gets the file, creates the book in the collection shown, saves the file to it", async () => {
        publishScope({
            libraryID: 7,
            collectionKey: "COLL0001",
            label: "Media theory",
        });
        state.routes = [
            {
                match: /openlibrary\.org\/api\/books\?bibkeys=ISBN:9783518294444/,
                status: 200,
                json: {
                    "ISBN:9783518294444": {
                        title: "Lebendige Kräfte",
                        subtitle: "Helmholtz und die Nerven",
                        authors: [{ name: "Henning Schmidgen" }],
                        publish_date: "2005",
                    },
                },
            },
            {
                match: /^POST https:\/\/api\.zotero\.org\/users\/7\/items$/,
                status: 200,
                json: { successful: { "0": { key: "NEWBOOK1" } } },
            },
            { match: /\/file$/, status: 200, json: { exists: 1 } },
        ];
        const webview = {
            getURL: () => `https://annas-archive.gl/view/${md5}`,
            executeJavaScript: async (code: string) =>
                code.includes("innerText")
                    ? "Lebendige Kräfte\nISBN-13 978-3-518-29444-4"
                    : code.includes("PDFViewerApplication")
                      ? btoa("%PDF-1.5 book")
                      : null,
        };
        await saveAsNewItem(webview);
        const book = state.calls.find(
            (c) =>
                c.url.endsWith("/items") &&
                c.method === "POST" &&
                (typeof c.body === "string" ? c.body : "").includes('"book"'),
        );
        expect(JSON.parse(book!.body as string)[0]).toMatchObject({
            itemType: "book",
            title: "Lebendige Kräfte: Helmholtz und die Nerven",
            ISBN: "9783518294444",
            date: "2005",
            collections: ["COLL0001"],
            creators: [
                {
                    creatorType: "author",
                    firstName: "Henning",
                    lastName: "Schmidgen",
                },
            ],
        });
        const attachment = state.calls.find((c) =>
            (typeof c.body === "string" ? c.body : "").includes('"attachment"'),
        );
        expect(JSON.parse(attachment!.body as string)[0]).toMatchObject({
            parentItem: "NEWBOOK1",
            filename: "schmidgen_2005_lebendige-kräfte.pdf",
        });
    });

    it("no ISBN on the page: nothing is created", async () => {
        publishScope({
            libraryID: 7,
            collectionKey: null,
            label: "My Library",
        });
        const webview = {
            getURL: () => "https://example.org/",
            executeJavaScript: async () => "no isbn",
        };
        await saveAsNewItem(webview);
        expect(state.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    });
});

describe("replacing a stored file (PDF editing)", () => {
    it("asks with If-Match the md5 this device knows; returns the new md5", async () => {
        let fileCalls = 0;
        state.routes = [
            {
                match: /^POST .*\/users\/7\/items\/ATT00001\/file$/,
                get status() {
                    return fileCalls++ === 0 ? 200 : 204;
                },
                json: {
                    url: "https://s3.example/up",
                    contentType: "multipart/form-data; boundary=X",
                    prefix: "P",
                    suffix: "S",
                    uploadKey: "UPK",
                },
            },
            { match: /^POST https:\/\/s3\.example\/up$/, status: 201 },
        ];
        const bytes = new TextEncoder().encode("%PDF-1.7\nedited");
        const md5New = await uploadFileBytes(
            { libraryID: 7, key: "ATT00001" },
            bytes,
            "x.pdf",
            md5,
        );
        expect(md5New).toBe(SparkMD5.ArrayBuffer.hash(bytes.buffer));
        const [auth] = state.calls;
        expect(auth!.headers?.["If-Match"]).toBe(md5);
        expect(auth!.headers?.["If-None-Match"]).toBeUndefined();
        expect(state.calls).toHaveLength(3);
    });

    it("the file changed in Zotero meanwhile (412): says to sync first", async () => {
        state.routes = [{ match: /\/file$/, status: 412 }];
        await expect(
            uploadFileBytes(
                { libraryID: 7, key: "ATT00001" },
                new Uint8Array([1]),
                "x.pdf",
                md5,
            ),
        ).rejects.toThrow(/sync/);
        expect(state.calls).toHaveLength(1);
    });
});
