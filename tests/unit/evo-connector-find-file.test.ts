/**
 * ZotFlow Evo: the browser connector's open-access file search, ported from
 * Zotero (`getFileResolvers(item, ['oa', 'custom'], true)`,
 * `downloadFirstAvailableFile()`): Zotero's open-access service, addresses
 * tried once each, a landing page's file. The network is a fake `fetch`.
 */
import { describe, expect, it } from "vitest";

import {
    cleanDOI,
    doiOf,
    fileURLFromPage,
    findOpenAccessFile,
    metaRefreshURL,
    sniffFileType,
    titleFromVersion,
    type Fetch,
    type FetchResult,
} from "connector/find-file";
import { fileNameFromURL } from "connector/protocol";

const PDF = new TextEncoder().encode("%PDF-1.7\n…");
const HTML = (body: string) => new TextEncoder().encode(body);

function fakeWeb(routes: Record<string, { status?: number; type: string; body: Uint8Array }>) {
    const calls: string[] = [];
    const fetch: Fetch = (url, init) => {
        calls.push(`${init?.method ?? "GET"} ${url}${init?.headers?.Referer ? ` <- ${init.headers.Referer}` : ""}`);
        const r = routes[url];
        const result: FetchResult = r
            ? { status: r.status ?? 200, headers: { "content-type": r.type }, bytes: r.body }
            : { status: 404, headers: {}, bytes: new Uint8Array() };
        return Promise.resolve(result);
    };
    return { fetch, calls };
}

const OA = "https://services.zotero.org/oa/search";
const oa = (list: unknown) => ({ type: "application/json", body: HTML(JSON.stringify(list)) });

describe("Zotero's helpers, as ported", () => {
    it("cleanDOI, the DOI field or Extra", () => {
        expect(cleanDOI("https://doi.org/10.1371%2Fjournal.pone.0115253")).toBe("10.1371/journal.pone.0115253");
        expect(cleanDOI("see (10.1000/xyz123)")).toBe("10.1000/xyz123");
        expect(cleanDOI("10.1000/a(b)")).toBe("10.1000/a(b)");
        expect(cleanDOI("no doi")).toBeNull();
        expect(doiOf({ DOI: "10.1000/x." })).toBe("10.1000/x");
        expect(doiOf({ extra: "Original date: 1950\nDOI: 10.1000/fromextra" })).toBe("10.1000/fromextra");
        expect(doiOf({ title: "x" })).toBeNull();
    });

    it("file types by their bytes; titles by version; names from addresses", () => {
        expect(sniffFileType(PDF)).toBe("application/pdf");
        const epub = new Uint8Array(80);
        epub.set(new TextEncoder().encode("PK\u0003\u0004"), 0);
        epub.set(new TextEncoder().encode("mimetypeapplication/epub+zip"), 30);
        expect(sniffFileType(epub)).toBe("application/epub+zip");
        expect(sniffFileType(HTML("<!DOCTYPE html>"))).toBeNull();
        expect(titleFromVersion("acceptedVersion")).toBe("Accepted Version");
        expect(titleFromVersion("submittedVersion")).toBe("Submitted Version");
        expect(titleFromVersion("publishedVersion")).toBe("Full Text");
        expect(fileNameFromURL("https://x.org/a/b/article.php?id=1", "html")).toBe("article.html");
        expect(fileNameFromURL("https://x.org/a/b%C3%BCcher/", "html")).toBe("bücher.html");
        expect(fileNameFromURL("https://x.org/", "html")).toBe("x.org.html");
        expect(fileNameFromURL("https://x.org/" + "a".repeat(200), "html")).toHaveLength(100);
    });

    it("a landing page: its meta refresh, its citation_pdf_url", () => {
        expect(metaRefreshURL('<meta http-equiv="refresh" content="0; URL=\'/next\'">', "https://a.org/p")).toBe("https://a.org/next");
        expect(fileURLFromPage('<meta content="files/x.pdf?a=1&amp;b=2" name="citation_pdf_url">', "https://a.org/p/")).toBe("https://a.org/p/files/x.pdf?a=1&b=2");
        expect(fileURLFromPage("<p>none</p>", "https://a.org")).toBeNull();
    });
});

describe("findOpenAccessFile", () => {
    it("the first address that is a PDF; one that is not is passed by", async () => {
        const web = fakeWeb({
            [OA]: oa([
                { url: "http://pub.example/fake.pdf", version: "publishedVersion" },
                { url: "https://repo.example/real.pdf", pageURL: "https://repo.example/page", version: "acceptedVersion" },
            ]),
            "https://pub.example/fake.pdf": { type: "text/html", body: HTML("<html>login</html>") },
            "https://repo.example/real.pdf": { type: "application/pdf", body: PDF },
        });
        const found = await findOpenAccessFile("10.1/x", web.fetch);
        expect(found).toMatchObject({ contentType: "application/pdf", url: "https://repo.example/real.pdf", title: "Accepted Version" });
        // Forced to https (as Zotero does), the search sent as JSON.
        expect(web.calls).toEqual(["POST " + OA, "GET https://pub.example/fake.pdf", "GET https://repo.example/real.pdf"]);
    });

    it("no file address: the landing page, a refresh, then the file it names (with the page as referrer)", async () => {
        const web = fakeWeb({
            [OA]: oa([{ pageURL: "https://pmc.example/articles/1/", version: "publishedVersion" }]),
            "https://pmc.example/articles/1/": { type: "text/html; charset=utf-8", body: HTML('<meta http-equiv="refresh" content="0;url=/articles/1/full">') },
            "https://pmc.example/articles/1/full": { type: "text/html", body: HTML('<meta name="citation_pdf_url" content="/pdf/1.pdf">') },
            "https://pmc.example/pdf/1.pdf": { type: "application/pdf", body: PDF },
        });
        const found = await findOpenAccessFile("10.1/x", web.fetch);
        expect(found).toMatchObject({ url: "https://pmc.example/pdf/1.pdf", title: "Full Text" });
        expect(web.calls.at(-1)).toBe("GET https://pmc.example/pdf/1.pdf <- https://pmc.example/articles/1/full");
    });

    it("a landing page that is the PDF; the same address is tried once; at most six", async () => {
        const many = Array.from({ length: 9 }, (_, i) => ({ url: `https://m.example/${i}.pdf?token=${i}` }));
        const web = fakeWeb({ [OA]: oa([{ url: "https://same.example/a.pdf?x=1" }, { url: "https://same.example/a.pdf?x=2" }, ...many]) });
        expect(await findOpenAccessFile("10.1/x", web.fetch)).toBeNull();
        // ?x=1 and ?x=2 are one address; six of the list are tried.
        expect(web.calls.filter((c) => c.includes("same.example"))).toHaveLength(1);
        expect(web.calls).toHaveLength(1 + 1 + 4);

        const direct = fakeWeb({
            [OA]: oa([{ pageURL: "https://doi.org/10.1/x" }]),
            "https://doi.org/10.1/x": { type: "application/pdf", body: PDF },
        });
        expect(await findOpenAccessFile("10.1/x", direct.fetch)).toMatchObject({ url: "https://doi.org/10.1/x" });
    });

    it("the search failing: nothing found, no error", async () => {
        const web = fakeWeb({ [OA]: { status: 500, type: "text/plain", body: HTML("x") } });
        expect(await findOpenAccessFile("10.1/x", web.fetch)).toBeNull();
    });
});
