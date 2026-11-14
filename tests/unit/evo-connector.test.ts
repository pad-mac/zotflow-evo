/**
 * ZotFlow Evo: the browser connector's side in ZotFlow — the Zot Vitro
 * Connector's requests, as it sends them (taken from a save in a browser
 * with the built extension), answered over real HTTP; the web API faked.
 */
import * as http from "http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
    buildTargets,
    decodeRfc2047,
    extensionFor,
    itemsToWrite,
    namePartsOf,
    parseTags,
    parseTargetId,
    refusal,
    targetId,
} from "connector/protocol";
import { ConnectorSessions, type ConnectorApi } from "connector/sessions";
import { ConnectorHandler } from "connector/handler";
import { createConnectorServer } from "connector/http";

import type { AddressInfo } from "net";
import type { ApiItem } from "connector/protocol";

const LIBRARIES = [
    {
        libraryID: 1,
        name: "My Library",
        collections: [
            {
                libraryID: 1,
                key: "CYB22222",
                name: "Cybernetics",
                children: [{ libraryID: 1, key: "SUB33333", name: "Macy", children: [] }],
            },
            { libraryID: 1, key: "PIN44444", name: "Reading now", children: [] },
        ],
    },
    { libraryID: 2, name: "Group", collections: [] },
    { libraryID: 9, name: "Read-only group", collections: [] },
];

/** What saveItems carries for one article (as the extension sent it). */
function article(key = "YT2E79TT") {
    return {
        sessionID: "S1",
        uri: "http://localhost:8089/article.html",
        items: [
            {
                id: "it1",
                itemType: "journalArticle",
                title: "Kybernetik und Gesellschaft: Über Rückkopplung",
                attachments: [
                    { id: "a1", url: "http://localhost:8089/paper.pdf", mimeType: "application/pdf", title: "Full Text PDF" },
                    { id: "a2", url: "https://doi.org/10.1/x", mimeType: "text/html", title: "DOI page", snapshot: false },
                ],
            },
        ],
        zotflow: {
            version: 1,
            apiItems: [
                [
                    {
                        key,
                        version: 0,
                        itemType: "journalArticle",
                        title: "Kybernetik und Gesellschaft: Über Rückkopplung",
                        shortTitle: "Kybernetik und Gesellschaft",
                        creators: [{ firstName: "Norbert", lastName: "Wiener", creatorType: "author" }],
                        date: "1950/03/01",
                        tags: [{ tag: "cybernetics", type: 1 }],
                    },
                    { itemType: "note", parentItem: key, note: "<p>abstract</p>" },
                ],
            ],
        },
    };
}

/** A web API that keeps what it was asked to do. */
function fakeApi() {
    const calls: [string, unknown][] = [];
    let n = 0;
    let target = { libraryID: 1, collectionKey: "CYB22222" as string | null };
    const api: ConnectorApi & { calls: typeof calls; refuse?: boolean; noFile?: boolean } = {
        calls,
        writeItems: (libraryID, items) => {
            calls.push(["write", { libraryID, items }]);
            return Promise.resolve(
                items.map((it, i) =>
                    api.refuse && i === 0
                        ? { key: null, message: "Invalid property 'bogus'" }
                        : { key: (it.key as string) ?? `N${String(++n).padStart(7, "0")}`, version: 7 },
                ),
            );
        },
        patchItem: (libraryID, key, patch, version) => {
            calls.push(["patch", { libraryID, key, patch, version }]);
            return Promise.resolve();
        },
        deleteItems: (libraryID, keys) => {
            calls.push(["delete", { libraryID, keys }]);
            return Promise.resolve();
        },
        attachFile: (t, file, parts, options) => {
            calls.push(["attach", { t, type: file.contentType, ext: file.extension, title: file.title, size: file.bytes.length, parts, options }]);
            return Promise.resolve(`F${String(++n).padStart(7, "0")}`);
        },
        findFile: (doi) => {
            calls.push(["find", doi]);
            return Promise.resolve(
                api.noFile
                    ? null
                    : { bytes: new Uint8Array([37, 80, 68, 70, 45]), contentType: "application/pdf", url: "https://repo.example/oa.pdf", title: "Accepted Version" },
            );
        },
        standaloneFile: (t, file) => {
            calls.push(["standalone", { t, type: file.contentType, title: file.title }]);
            return Promise.resolve(`F${String(++n).padStart(7, "0")}`);
        },
        filesEditable: (id) => id !== 2,
        syncSoon: (id) => void calls.push(["sync", id]),
        defaultTarget: () => target,
        rememberTarget: (t) => {
            target = t;
            calls.push(["remember", targetId(t)]);
        },
    };
    return api;
}

const of = (api: ReturnType<typeof fakeApi>, kind: string) =>
    api.calls.filter(([k]) => k === kind).map(([, v]) => v as Record<string, unknown>);

describe("the protocol's pure parts", () => {
    it("targets: libraries that can be written, collections under them, pinned ones and the last marked", () => {
        const rows = buildTargets(LIBRARIES, {
            writable: (id) => id !== 9,
            filesEditable: (id) => id !== 2,
            pinned: ["1:PIN44444"],
            last: "L2",
        });
        expect(rows.map((r) => [r.id, r.name, r.level, r.filesEditable, !!r.recent])).toEqual([
            ["L1", "My Library", 0, true, false],
            ["C1:CYB22222", "Cybernetics", 1, true, false],
            ["C1:SUB33333", "Macy", 2, true, false],
            ["C1:PIN44444", "Reading now", 1, true, true],
            ["L2", "Group", 0, false, true],
        ]);
        expect(parseTargetId("C1:SUB33333")).toEqual({ libraryID: 1, collectionKey: "SUB33333" });
        expect(parseTargetId("L12")).toEqual({ libraryID: 12, collectionKey: null });
        expect(parseTargetId("C123")).toBeNull();
    });

    it("titles in RFC 2047, tags as a string, extensions, file name parts", () => {
        expect(decodeRfc2047("=?UTF-8?Q?K=C3=BCnstliche_Intelligenz=3F?=")).toBe("Künstliche Intelligenz?");
        expect(decodeRfc2047("Plain")).toBe("Plain");
        expect(parseTags("macy, to read,, macy")).toEqual(["macy", "to read"]);
        expect(parseTags(["a", " b "])).toEqual(["a", "b"]);
        expect(extensionFor("application/pdf")).toBe("pdf");
        expect(extensionFor("application/octet-stream", "https://x.org/a/book.EPUB?x=1")).toBe("epub");
        expect(namePartsOf(article().zotflow.apiItems[0]![0] as ApiItem)).toEqual({
            lastName: "Wiener",
            year: "1950",
            shortTitle: "Kybernetik und Gesellschaft",
            title: "Kybernetik und Gesellschaft: Über Rückkopplung",
            itemType: "journalArticle",
        });
    });

    it("what is written: the item in the collection, its note, its linked page; not the PDF (it follows)", () => {
        const a = article();
        const { write, keys, top } = itemsToWrite(a.items, a.zotflow.apiItems, "CYB22222");
        expect(write.map((w) => [w.itemType, w.parentItem ?? null, w.linkMode ?? null])).toEqual([
            ["journalArticle", null, null],
            ["note", "YT2E79TT", null],
            ["attachment", "YT2E79TT", "linked_url"],
        ]);
        expect(write[0]!.collections).toEqual(["CYB22222"]);
        expect(keys.get("it1")).toBe("YT2E79TT");
        expect(top).toEqual(["YT2E79TT"]);
        expect(() => itemsToWrite(a.items, [], null)).toThrow(/update it/);
    });

    it("only the Connector: no web page's origin, the API header on every POST", () => {
        const ext = { origin: "moz-extension://1234", "x-zotero-connector-api-version": "3" };
        expect(refusal("POST", ext)).toBeNull();
        expect(refusal("GET", {})).toBeNull();
        expect(refusal("POST", { ...ext, origin: "https://evil.example" })).toBe(403);
        expect(refusal("POST", { origin: "moz-extension://1234" })).toBe(403);
        expect(refusal("OPTIONS", {})).toBe(403);
        expect(refusal("DELETE", ext)).toBe(405);
    });
});

describe("a save, then the popup's changes", () => {
    let api: ReturnType<typeof fakeApi>;
    let sessions: ConnectorSessions;
    beforeEach(() => {
        api = fakeApi();
        sessions = new ConnectorSessions(api);
    });

    it("the item goes to the target; the PDF under it, named from it", async () => {
        await sessions.saveItems(article());
        const [w] = of(api, "write");
        expect(w!.libraryID).toBe(1);
        expect((w!.items as ApiItem[])[0]!.collections).toEqual(["CYB22222"]);
        await sessions.saveAttachment("S1", { parentItemID: "it1" }, {
            bytes: new Uint8Array([37, 80, 68, 70]),
            contentType: "application/pdf",
            extension: "pdf",
            title: "Full Text PDF",
            url: "http://localhost:8089/paper.pdf",
        });
        const [att] = of(api, "attach");
        expect(att!.t).toEqual({ libraryID: 1, key: "YT2E79TT" });
        expect((att!.parts as { lastName: string }).lastName).toBe("Wiener");
        await expect(
            sessions.saveAttachment("S1", { parentItemID: "nope" }, {} as never),
        ).rejects.toMatchObject({ status: 400 });
    });

    it("another collection, tags (the translator's kept), a note changed and taken away", async () => {
        await sessions.saveItems(article());
        await sessions.update({ sessionID: "S1", target: "C1:SUB33333", tags: "macy, to read", note: "Read this" });
        const patches = of(api, "patch");
        expect(patches[0]).toMatchObject({ key: "YT2E79TT", patch: { collections: ["SUB33333"] }, version: 7 });
        expect(patches[1]).toMatchObject({
            key: "YT2E79TT",
            patch: { tags: [{ tag: "cybernetics", type: 1 }, { tag: "macy" }, { tag: "to read" }] },
            version: undefined,
        });
        const note = of(api, "write")[1]!.items as ApiItem[];
        expect(note).toEqual([expect.objectContaining({ itemType: "note", parentItem: "YT2E79TT", note: "Read this" })]);
        expect(api.calls).toContainEqual(["remember", "C1:SUB33333"]);
        // The same again: nothing to change.
        const before = api.calls.length;
        await sessions.update({ sessionID: "S1", target: "C1:SUB33333", tags: "macy, to read", note: "Read this" });
        expect(api.calls.slice(before).filter(([k]) => k === "patch" || k === "write")).toEqual([]);
        await sessions.update({ sessionID: "S1", note: "Read that" });
        expect(of(api, "patch").at(-1)).toMatchObject({ patch: { note: "Read that" } });
        await sessions.update({ sessionID: "S1", note: "" });
        expect(of(api, "delete").at(-1)).toMatchObject({ libraryID: 1, keys: ["N0000003"] });
    });

    it("another library: taken out of the first, written again (same keys), files again where they can go", async () => {
        await sessions.saveItems(article());
        await sessions.saveAttachment("S1", { parentItemID: "it1" }, {
            bytes: new Uint8Array(4), contentType: "application/pdf", extension: "pdf", title: "PDF", url: "",
        });
        await sessions.update({ sessionID: "S1", target: "L2" });
        expect(of(api, "delete")[0]).toEqual({ libraryID: 1, keys: ["YT2E79TT", "N0000001", "N0000002", "F0000003"] });
        const rewrite = of(api, "write")[1]!;
        expect(rewrite.libraryID).toBe(2);
        expect((rewrite.items as ApiItem[])[0]).toMatchObject({ key: "YT2E79TT", collections: [] });
        // The group takes no files from here: the PDF is not saved again.
        expect(of(api, "attach")).toHaveLength(1);
        await sessions.update({ sessionID: "S1", target: "L1" });
        expect(of(api, "attach")).toHaveLength(2);
        expect(of(api, "attach")[1]!.t).toEqual({ libraryID: 1, key: "YT2E79TT" });
    });

    it("files as Zotero makes them: the PDF from its address with its title; the snapshot named from the page", async () => {
        await sessions.saveItems(article());
        await sessions.saveAttachment("S1", { parentItemID: "it1" }, {
            bytes: new Uint8Array(4), contentType: "application/pdf", extension: "pdf", title: "Full Text PDF", url: "http://localhost:8089/paper.pdf",
        });
        expect(of(api, "attach")[0]!.options).toEqual({ title: "Full Text PDF", url: "http://localhost:8089/paper.pdf" });
        await sessions.saveSnapshotFile("S1", "<html>…</html>", "Snapshot", "https://journal.example/articles/kybernetik-und-gesellschaft?x=1");
        expect(of(api, "attach")[1]).toMatchObject({
            type: "text/html",
            ext: "html",
            options: { title: "Snapshot", url: "https://journal.example/articles/kybernetik-und-gesellschaft?x=1", filename: "kybernetik-und-gesellschaft.html", charset: "utf-8" },
        });
    });

    it("no file from the page: an open-access one by the DOI (Zotero's resolvers), with its version as title", async () => {
        const a = article();
        (a.zotflow.apiItems[0]![0] as Record<string, unknown>).DOI = "https://doi.org/10.1371/journal.pone.0115253";
        await sessions.saveItems(a);
        expect(sessions.hasResolvers("S1", "it1")).toBe(true);
        expect(await sessions.saveFromResolver("S1", "it1")).toBe("Accepted Version");
        expect(api.calls).toContainEqual(["find", "10.1371/journal.pone.0115253"]);
        expect(of(api, "attach")[0]).toMatchObject({
            t: { libraryID: 1, key: "YT2E79TT" },
            ext: "pdf",
            options: { title: "Accepted Version", url: "https://repo.example/oa.pdf" },
        });
        api.noFile = true;
        await expect(sessions.saveFromResolver("S1", "it1")).rejects.toMatchObject({ status: 500 });
        // No DOI (not in Extra either): nothing to look for.
        await sessions.saveItems({ ...article("ZZZZ3333"), sessionID: "S9" });
        expect(sessions.hasResolvers("S9", "it1")).toBe(false);
        await expect(sessions.saveFromResolver("S9", "nope")).rejects.toMatchObject({ status: 400 });
    });

    it("a session saved twice; an item Zotero refuses: nothing kept", async () => {
        await sessions.saveItems(article());
        await expect(sessions.saveItems(article())).rejects.toMatchObject({ status: 409, message: "SESSION_EXISTS" });
        api.refuse = true;
        await expect(sessions.saveItems({ ...article(), sessionID: "S2" })).rejects.toMatchObject({
            status: 500,
            message: expect.stringContaining("Invalid property"),
        });
        expect(of(api, "delete").at(-1)).toMatchObject({ keys: ["N0000003", "N0000004"] });
        await expect(sessions.saveItems({ sessionID: "S3", items: [] })).rejects.toMatchObject({ status: 400 });
    });
});

describe("over HTTP, as the extension sends it", () => {
    let api: ReturnType<typeof fakeApi>;
    let server: http.Server;
    let base: string;
    const failures: string[] = [];
    beforeAll(async () => {
        api = fakeApi();
        const handler = new ConnectorHandler(new ConnectorSessions(api), {
            libraries: () => Promise.resolve(LIBRARIES),
            writable: (id) => id !== 9,
            filesEditable: (id) => id !== 2,
            pinned: () => ["1:PIN44444"],
            lastTarget: () => null,
            defaultTarget: () => api.defaultTarget(),
            listed: () => {},
            holdSync: () => void api.calls.push(["hold", null]),
            prefs: () => ({ files: true, snapshots: false }),
            failed: (m) => void failures.push(m),
        });
        server = createConnectorServer(http, handler, () => {});
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/connector/`;
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));

    const ext = {
        "Content-Type": "application/json",
        "X-Zotero-Version": "5.0.900",
        "X-Zotero-Connector-API-Version": "3",
    };
    const post = (method: string, body: unknown, headers: Record<string, string> = ext, query = "") =>
        fetch(`${base}${method}${query}`, {
            method: "POST",
            headers,
            body: body instanceof Uint8Array ? new Blob([body as Uint8Array<ArrayBuffer>]) : JSON.stringify(body),
        });

    it("ping, the targets, a save with its PDF, the popup, delaySync", async () => {
        const ping = await post("ping", {});
        expect(ping.status).toBe(200);
        expect(ping.headers.get("x-zotero-version")).toBe("ZotFlow");
        expect((await ping.json()) as unknown).toMatchObject({
            prefs: { supportsAttachmentUpload: true, downloadAssociatedFiles: true, automaticSnapshots: false },
        });
        expect(((await ping.json().catch(() => ({}))) as { prefs?: { translatorsHash?: string } }).prefs?.translatorsHash).toBeUndefined();

        const sel = (await (await post("getSelectedCollection", {})).json()) as Record<string, unknown>;
        expect(sel).toMatchObject({ libraryID: 1, libraryName: "My Library", id: "C1:CYB22222", name: "Cybernetics", filesEditable: true });
        expect((sel.targets as { id: string; recent?: boolean }[]).filter((t) => t.recent).map((t) => t.id)).toEqual(["C1:PIN44444"]);

        expect((await post("saveItems", article())).status).toBe(201);
        const pdf = new Uint8Array([37, 80, 68, 70, 45, 49]);
        const res = await post("saveAttachment", pdf, {
            "Content-Type": "application/pdf",
            "X-Zotero-Connector-API-Version": "3",
            "X-Metadata": JSON.stringify({
                id: "a1",
                url: "http://localhost:8089/paper.pdf",
                contentType: "application/pdf",
                parentItemID: "it1",
                title: "=?UTF-8?Q?Volltext_=C3=BCber?=",
            }),
        }, "?sessionID=S1");
        expect(res.status).toBe(201);
        expect(of(api, "attach")[0]).toMatchObject({ type: "application/pdf", ext: "pdf", title: "Volltext über", size: 6 });

        expect((await post("updateSession", { sessionID: "S1", target: "C1:PIN44444", tags: "x", note: "" })).status).toBe(200);
        expect(of(api, "patch")[0]).toMatchObject({ patch: { collections: ["PIN44444"] } });
        expect((await post("hasAttachmentResolvers", { sessionID: "S1", itemID: "it1" })).status).toBe(200);
        expect((await post("delaySync", {})).status).toBe(204);
        expect(api.calls).toContainEqual(["hold", null]);
        expect((await post("saveItems", article())).status).toBe(409);
        expect((await post("installStyle", {})).status).toBe(404);
    });

    it("a web page cannot save: its origin, or no API header, is refused", async () => {
        const before = api.calls.length;
        expect((await post("saveItems", { ...article(), sessionID: "W1" }, { ...ext, Origin: "https://evil.example" })).status).toBe(403);
        expect((await post("saveItems", { ...article(), sessionID: "W2" }, { "Content-Type": "text/plain" })).status).toBe(403);
        expect((await fetch(`${base}saveItems`, { method: "OPTIONS" })).status).toBe(403);
        expect(api.calls.length).toBe(before);
    });

    it("a failure is answered with its message and shown in Obsidian", async () => {
        api.refuse = true;
        const res = await post("saveItems", { ...article("ZZZZ2222"), sessionID: "F1" });
        api.refuse = false;
        expect(res.status).toBe(500);
        expect(res.headers.get("x-zotero-version")).toBe("ZotFlow");
        expect(await res.text()).toMatch(/Invalid property/);
        expect(failures.at(-1)).toMatch(/Invalid property/);
    });
});
