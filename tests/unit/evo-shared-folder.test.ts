/**
 * ZotFlow Evo: a group's files in a shared folder (utils/evo-shared-folder.ts),
 * named as the Zotero plugin Group Linked Files names them.
 */
import { describe, expect, it } from "vitest";

import {
    DEFAULT_SHARED_NAMING,
    basicAuth,
    formatBaseName,
    matchKey,
    nameVariants,
    namePartsOf,
    nextFreeName,
    parseMultistatus,
    sharedFolderFor,
    webdavFolderURL,
} from "utils/evo-shared-folder";
import { loadCredentials, saveCredentials, stripCredentials } from "utils/credentials";

import type { SecretStorage } from "obsidian";

const n = DEFAULT_SHARED_NAMING;

describe("file names", () => {
    it("the plugin's examples", () => {
        expect(formatBaseName({ lastNames: ["Müller"], year: "1987", title: "" }, n)).toBe("mueller_1987");
        expect(formatBaseName({ lastNames: ["Müller", "Schmidt"], year: "1990", title: "" }, n)).toBe("mueller-schmidt_1990");
        expect(formatBaseName({ lastNames: ["Weber", "Braun", "Klein"], year: "2004", title: "" }, n)).toBe("weber-ua_2004");
        expect(formatBaseName({ lastNames: ["Groß"], year: "2001", title: "" }, n)).toBe("gross_2001");
        expect(formatBaseName({ lastNames: ["Fischer"], year: "", title: "" }, n)).toBe("fischer_oj");
        expect(formatBaseName({ lastNames: [], year: "2000", title: "" }, n)).toBe("oa_2000");
        expect(formatBaseName({ lastNames: ["Müller"], year: "1987", title: "Über Maschinen" }, { ...n, template: "{authors}_{year}_{title}", lowercase: false })).toBe("Mueller_1987_Ueber Maschinen");
    });
    it("authors, else editors, else anyone", () => {
        const data = { creators: [{ creatorType: "editor", lastName: "Lemke" }, { creatorType: "translator", lastName: "X" }], date: "2014-03" };
        expect(namePartsOf(data, "author")).toEqual({ lastNames: ["Lemke"], year: "2014", title: "" });
    });
    it("a name in use gets the next letter, then (2)", () => {
        const taken = new Set(["mueller_1987.pdf", "mueller_1987a.pdf"].map(matchKey));
        expect(nextFreeName("mueller_1987", ".pdf", taken)).toBe("mueller_1987b.pdf");
        expect(nextFreeName("x", ".pdf", new Set())).toBe("x.pdf");
        // ü and ue, either Unicode form, any case: the same name.
        expect(matchKey("Müller_1987.PDF")).toBe(matchKey("mueller_1987.pdf"));
        expect(nameVariants("Mü.pdf".normalize("NFC")).length).toBe(2);
    });
});

describe("WebDAV", () => {
    it("the folder's address; Basic login in UTF-8", () => {
        expect(webdavFolderURL({ webdavServer: "https://box.hu-berlin.de/huboxdav", webdavPath: " Projekt / PDFs und mehr " })).toBe("https://box.hu-berlin.de/huboxdav/Projekt/PDFs%20und%20mehr/");
        expect(webdavFolderURL({ webdavServer: "box.hu-berlin.de", webdavPath: "" })).toBeNull();
        expect(basicAuth("ü", "p")).toBe("Basic " + Buffer.from("ü:p").toString("base64"));
    });
    it("a PROPFIND listing (prefixes vary), the folder itself left out", () => {
        const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
<d:response><d:href>/huboxdav/Projekt/PDFs/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
<d:response><d:href>/huboxdav/Projekt/PDFs/m%C3%BCller_1987.pdf</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>1234</d:getcontentlength></d:prop></d:propstat></d:response>
<D:response xmlns:D="DAV:"><D:href>https://box.hu-berlin.de/huboxdav/Projekt/PDFs/Sub/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>
</d:multistatus>`;
        expect(parseMultistatus(xml, "https://box.hu-berlin.de/huboxdav/Projekt/PDFs/")).toEqual([
            { name: "müller_1987.pdf", isDir: false, size: 1234 },
            { name: "Sub", isDir: true, size: null },
        ]);
    });
});

describe("settings", () => {
    it("a group's folder only when it has a location", () => {
        const list = [
            { id: "abc", libraryID: 777, mode: "folder", folder: "" },
            { id: "def", libraryID: 888, mode: "webdav", webdavServer: "https://x.org/dav/", webdavPath: "a" },
        ];
        expect(sharedFolderFor(list, 777)).toBeNull();
        expect(sharedFolderFor(list, 888)?.naming).toEqual(n);
        expect(sharedFolderFor(list, 1)).toBeNull();
    });
    it("the WebDAV password goes to SecretStorage, not data.json", () => {
        const store = new Map<string, string>();
        const storage = {
            setSecret: (id: string, v: string) => {
                if (!/^[a-z0-9-]+$/.test(id)) throw new Error("invalid");
                store.set(id, v);
            },
            getSecret: (id: string) => store.get(id) ?? null,
            listSecrets: () => [...store.keys()],
        } as unknown as SecretStorage;
        const settings = { evoGroupFolders: [{ id: "abc", password: "pw" }] };
        saveCredentials(settings, storage);
        expect(store.get("evo-folder-abc")).toBe("pw");
        expect(stripCredentials(settings).evoGroupFolders).toEqual([{ id: "abc" }]);
        const loaded = { evoGroupFolders: [{ id: "abc" } as { id: string; password?: string }] };
        loadCredentials(loaded, storage);
        expect(loaded.evoGroupFolders[0]!.password).toBe("pw");
        // A folder removed: its password is cleared.
        saveCredentials({ evoGroupFolders: [] }, storage);
        expect(store.get("evo-folder-abc")).toBe("");
    });
});
