/**
 * ZotFlow Evo: `worker/services/evo-library.ts` — what the library browser,
 * the collection tabs and the annotation browser read from the database.
 */
import { beforeEach, describe, expect, test } from "vitest";

import { EvoLibraryService } from "worker/services/evo-library";
import { db, seedCollection, seedItem } from "../fakes/db";
import { createServiceHarness, USER_ID } from "../fakes/services";

import type { AnyIDBZoteroItem } from "types/db-schema";
import type { ServiceHarness } from "../fakes/services";

const GROUP = 77;

function raw(key: string, data: Record<string, unknown>, libraryID = USER_ID) {
    return {
        key,
        version: 1,
        library: { type: libraryID === USER_ID ? "user" : "group", id: libraryID, name: "L" },
        meta: { createdByUser: { id: USER_ID } },
        data: { key, version: 1, tags: [], relations: {}, collections: [], ...data },
    } as unknown as AnyIDBZoteroItem["raw"];
}

async function book(key: string, over: Partial<AnyIDBZoteroItem> = {}, data: Record<string, unknown> = {}) {
    await seedItem({
        libraryID: USER_ID,
        key,
        itemType: "book",
        title: `Book ${key}`,
        raw: raw(key, {
            itemType: "book",
            title: `Book ${key}`,
            creators: [
                { creatorType: "editor", firstName: "Ed", lastName: "Itor" },
                { creatorType: "author", firstName: "Henning", lastName: "Schmidgen" },
                { creatorType: "author", firstName: "Bernhard", lastName: "Siegert" },
                { creatorType: "author", firstName: "Ana", lastName: "Ofak" },
            ],
            date: "2005-03-01",
            ...data,
        }),
        ...over,
    } as Partial<AnyIDBZoteroItem> & { libraryID: number; key: string });
}

async function attachment(key: string, parentItem: string, contentType: string, linkMode = "imported_file") {
    await seedItem({
        libraryID: USER_ID,
        key,
        itemType: "attachment",
        parentItem,
        title: `${key}.file`,
        raw: raw(key, { itemType: "attachment", parentItem, contentType, linkMode, title: `${key}.file` }),
    } as Partial<AnyIDBZoteroItem> & { libraryID: number; key: string });
}

async function annotation(key: string, parentItem: string, data: Record<string, unknown>) {
    await seedItem({
        libraryID: USER_ID,
        key,
        itemType: "annotation",
        parentItem,
        title: "",
        raw: raw(key, {
            itemType: "annotation",
            parentItem,
            annotationType: "highlight",
            annotationText: `text ${key}`,
            annotationComment: "",
            annotationColor: "#ffd400",
            annotationPageLabel: "1",
            annotationSortIndex: "00000|000000|00000",
            annotationPosition: JSON.stringify({ pageIndex: 0, rects: [] }),
            ...data,
        }),
    } as Partial<AnyIDBZoteroItem> & { libraryID: number; key: string });
}

let h: ServiceHarness;
let service: EvoLibraryService;

beforeEach(async () => {
    h = await createServiceHarness({ libraries: [{ id: USER_ID, name: "Mine" }, { id: GROUP, name: "Team" }] });
    service = new EvoLibraryService(h.settings, h.library);
    await seedCollection({ libraryID: USER_ID, key: "TOP00001", name: "Media" });
    await seedCollection({ libraryID: USER_ID, key: "SUB00001", name: "Kittler", parentCollection: "TOP00001" });
    await seedCollection({ libraryID: USER_ID, key: "DEEP0001", name: "Grammophon", parentCollection: "SUB00001" });
    await seedCollection({ libraryID: USER_ID, key: "ALPHA001", name: "Archive" });
    await seedCollection({ libraryID: GROUP, key: "GRP00001", name: "Shared" });
});

describe("EvoLibraryService", () => {
    test("collections nested under their libraries, sorted by name", async () => {
        const tree = await service.getCollectionTree();
        expect(tree.map((l) => [l.libraryID, l.name])).toEqual([
            [USER_ID, "My Library"],
            [GROUP, "Team"],
        ]);
        const mine = tree[0]!.collections;
        expect(mine.map((c) => c.name)).toEqual(["Archive", "Media"]);
        expect(mine[1]!.children[0]!.name).toBe("Kittler");
        expect(mine[1]!.children[0]!.children[0]!.name).toBe("Grammophon");
    });

    test("rows: top-level items only, with creators, year, attachment and annotation counts", async () => {
        await book("BOOK0001", { collections: ["TOP00001"] });
        await attachment("PDF00001", "BOOK0001", "application/pdf");
        await attachment("LINK0001", "BOOK0001", "text/html", "linked_url");
        await annotation("ANN00001", "PDF00001", {});
        await annotation("ANN00002", "PDF00001", {});
        await book("BOOK0002", { collections: ["DEEP0001"] }, { creators: [{ creatorType: "author", name: "ACME" }], date: "" });
        await book("TRASHED1", { collections: ["TOP00001"], trashed: 1 });

        const all = await service.listItems({ libraryID: USER_ID, collectionKey: null, subcollections: false });
        expect(all.map((r) => r.key).sort()).toEqual(["BOOK0001", "BOOK0002"]);
        const b1 = all.find((r) => r.key === "BOOK0001")!;
        expect(b1).toMatchObject({
            creator: "Schmidgen et al.",
            firstCreator: "Henning Schmidgen",
            year: "2005",
            attachment: "pdf",
            attachmentCount: 2,
            annotationCount: 2,
        });

        const top = await service.listItems({ libraryID: USER_ID, collectionKey: "TOP00001", subcollections: false });
        expect(top.map((r) => r.key)).toEqual(["BOOK0001"]);
        const deep = await service.listItems({ libraryID: USER_ID, collectionKey: "TOP00001", subcollections: true });
        expect(deep.map((r) => r.key).sort()).toEqual(["BOOK0001", "BOOK0002"]);
        expect(deep.find((r) => r.key === "BOOK0002")).toMatchObject({ creator: "ACME", year: "", attachment: null });
    });

    test("details: first two authors, year, publication, abstract, and the primary file's annotations", async () => {
        await book("BOOK0001", {}, { abstractNote: "About nerves.", publisher: "Suhrkamp" });
        await attachment("EPUB0001", "BOOK0001", "application/epub+zip");
        await attachment("PDF00001", "BOOK0001", "application/pdf");
        await annotation("ANN00001", "PDF00001", { annotationComment: "a comment" });
        await annotation("ANN00002", "EPUB0001", {});

        const d = (await service.itemDetails(USER_ID, "BOOK0001"))!;
        expect(d.authors).toEqual(["Henning Schmidgen", "Bernhard Siegert"]);
        expect(d.moreAuthors).toBe(true);
        expect(d.year).toBe("2005");
        expect(d.abstract).toBe("About nerves.");
        expect(d.primaryKey).toBe("PDF00001");
        expect(d.annotations.map((a) => [a.id, a.attachmentKey, a.comment])).toEqual([["ANN00001", "PDF00001", "a comment"]]);
        expect(d.attachments.map((a) => [a.key, a.kind]).sort()).toEqual([
            ["EPUB0001", "epub"],
            ["PDF00001", "pdf"],
        ]);
    });

    test("details: two PDFs and no primary show the annotations of both", async () => {
        await book("BOOK0001");
        await attachment("PDF00001", "BOOK0001", "application/pdf");
        await attachment("PDF00002", "BOOK0001", "application/pdf");
        await annotation("ANN00001", "PDF00001", {});
        await annotation("ANN00002", "PDF00002", {});
        const d = (await service.itemDetails(USER_ID, "BOOK0001"))!;
        expect(d.primaryKey).toBeNull();
        expect(d.annotations.map((a) => a.id).sort()).toEqual(["ANN00001", "ANN00002"]);
    });

    test("publication: the field standing in for it in other item types", async () => {
        await seedItem({
            libraryID: USER_ID,
            key: "BLOG0001",
            itemType: "blogPost",
            title: "A post",
            raw: raw("BLOG0001", { itemType: "blogPost", title: "A post", blogTitle: "The Blog", creators: [] }),
        } as Partial<AnyIDBZoteroItem> & { libraryID: number; key: string });
        expect((await service.itemDetails(USER_ID, "BLOG0001"))!.publication).toBe("The Blog");
        const [row] = await service.listItems({ libraryID: USER_ID, collectionKey: null, subcollections: false });
        expect(row!.publication).toBe("The Blog");
    });

    test("the note strip's head: all main creators, year, title", async () => {
        await book("BOOK0001");
        expect(await service.itemBanner(USER_ID, "BOOK0001")).toEqual({
            authors: "Henning Schmidgen, Bernhard Siegert, Ana Ofak",
            authorList: ["Henning Schmidgen", "Bernhard Siegert", "Ana Ofak"],
            year: "2005",
            title: "Book BOOK0001",
        });
        expect(await service.itemBanner(USER_ID, "MISSING1")).toBeNull();
    });

    test("a collection's annotations, with the items they are from", async () => {
        await book("BOOK0001", { collections: ["TOP00001"] }, { shortTitle: "B1" });
        await attachment("PDF00001", "BOOK0001", "application/pdf");
        await annotation("ANN00001", "PDF00001", { annotationColor: "#ff6666", tags: [{ tag: "method" }] });
        await book("BOOK0002", { collections: ["SUB00001"] });
        await attachment("PDF00002", "BOOK0002", "application/pdf");
        await annotation("ANN00002", "PDF00002", {});
        await book("BOOK0003", { collections: ["TOP00001"] });

        const shallow = await service.collectionAnnotations({ libraryID: USER_ID, collectionKey: "TOP00001", subcollections: false });
        expect(shallow.name).toBe("Media");
        expect(shallow.annotations.map((a) => [a.id, a.itemKey, a.attachmentKey, a.color, a.tags])).toEqual([
            ["ANN00001", "BOOK0001", "PDF00001", "#ff6666", ["method"]],
        ]);
        expect(shallow.items).toEqual([
            { key: "BOOK0001", title: "Book BOOK0001", shortTitle: "B1", creator: "Schmidgen et al.", year: "2005", dateAdded: "2026-01-01T00:00:00.000Z" },
        ]);
        const deep = await service.collectionAnnotations({ libraryID: USER_ID, collectionKey: "TOP00001", subcollections: true });
        expect(deep.annotations.map((a) => a.id).sort()).toEqual(["ANN00001", "ANN00002"]);
    });
});

describe("EvoLibraryService edits", () => {
    test("add to and remove from a collection: top-level items only, each once", async () => {
        await book("BOOK0001", { collections: ["TOP00001"] }, { collections: ["TOP00001"] });
        await book("BOOK0002");
        await attachment("PDF00001", "BOOK0001", "application/pdf");

        const added = await service.addToCollection(USER_ID, ["BOOK0001", "BOOK0002", "PDF00001", "MISSING1"], "ALPHA001");
        expect(added).toEqual({ changed: 2, skipped: 2 });
        const b1 = (await db.items.get([USER_ID, "BOOK0001"]))!;
        expect(b1.collections.sort()).toEqual(["ALPHA001", "TOP00001"]);
        expect(b1.synced).toBe(0);
        expect((b1.raw.data as { collections: string[] }).collections.sort()).toEqual(["ALPHA001", "TOP00001"]);
        expect(await service.addToCollection(USER_ID, ["BOOK0001"], "ALPHA001")).toEqual({ changed: 0, skipped: 1 });

        const listed = await service.listItems({ libraryID: USER_ID, collectionKey: "ALPHA001", subcollections: false });
        expect(listed.map((r) => r.key).sort()).toEqual(["BOOK0001", "BOOK0002"]);

        expect(await service.removeFromCollection(USER_ID, ["BOOK0001", "BOOK0002"], "TOP00001")).toEqual({ changed: 1, skipped: 1 });
        expect((await db.items.get([USER_ID, "BOOK0001"]))!.collections).toEqual(["ALPHA001"]);
    });

    test("trash: the item is marked deleted and leaves the lists", async () => {
        await book("BOOK0001", { collections: ["TOP00001"] }, { collections: ["TOP00001"] });
        expect(await service.trashItems(USER_ID, ["BOOK0001"])).toEqual({ changed: 1, skipped: 0 });
        const row = (await db.items.get([USER_ID, "BOOK0001"]))!;
        expect(row.trashed).toBe(1);
        expect((row.raw.data as { deleted?: unknown }).deleted).toBe(1);
        expect(await service.listItems({ libraryID: USER_ID, collectionKey: "TOP00001", subcollections: false })).toEqual([]);
    });

    test("a read-only library refuses edits", async () => {
        const h2 = await createServiceHarness({ libraries: [{ id: USER_ID, mode: "readonly" }] });
        const ro = new EvoLibraryService(h2.settings, h2.library);
        await book("BOOK0001");
        await expect(ro.addToCollection(USER_ID, ["BOOK0001"], "TOP00001")).rejects.toThrow(/read-only/);
    });

    test("filename parts: first main creator's last name, year, short title (else the title)", async () => {
        await book("BOOK0001", {}, { shortTitle: "Lebendige Kräfte" });
        expect(await service.filenameParts(USER_ID, "BOOK0001")).toEqual({
            lastName: "Schmidgen",
            year: "2005",
            shortTitle: "Lebendige Kräfte",
            title: "Book BOOK0001",
            itemType: "book",
        });
        await book("BOOK0002");
        expect((await service.filenameParts(USER_ID, "BOOK0002"))!.shortTitle).toBe("Book BOOK0002");
    });

    test("the name of a saved file: the template over those parts, made safe", async () => {
        await book("BOOK0001", {}, { shortTitle: "Lebendige  Kräfte: <i>Helmholtz</i> und die Nerven" });
        expect(await service.attachFilename(USER_ID, "BOOK0001")).toEqual({ name: "schmidgen_2005_lebendige-kräfte" });
        service.updateSettings({ ...h.settings, evoAttachFilename: "{{ year }} {{ lastName }}" });
        expect(await service.attachFilename(USER_ID, "BOOK0001")).toEqual({ name: "2005 Schmidgen" });
        service.updateSettings({ ...h.settings, evoAttachFilename: "{% if %}" });
        const failed = await service.attachFilename(USER_ID, "BOOK0001");
        expect(failed.name).toBe("schmidgen_2005_lebendige-kräfte");
        expect(failed.problem).toMatch(/failed/);
        service.updateSettings({ ...h.settings, evoAttachFilename: "{{ nothing }}" });
        expect((await service.attachFilename(USER_ID, "BOOK0001")).problem).toMatch(/gave nothing/);
        expect(await service.attachFilename(USER_ID, "MISSING1")).toEqual({ name: "" });
        await book("BOOK0002", {}, { shortTitle: "Grammophon" });
        service.updateSettings({ ...h.settings, evoAttachFilename: "" });
        expect((await service.attachFilename(USER_ID, "BOOK0002")).name).toBe("schmidgen_2005_grammophon");
    });

    test("collections renamed or moved in Zotero show here at once", async () => {
        await seedCollection({ libraryID: USER_ID, key: "TOP00001", name: "Top" });
        const before = await service.collectionInfo(USER_ID, "TOP00001");
        expect(before?.name).toBe("Top");
        await service.collectionWritten(USER_ID, "TOP00001", { name: "Renamed", parentCollection: "PARENT01" }, 42);
        const after = await service.collectionInfo(USER_ID, "TOP00001");
        expect(after).toEqual({ version: 42, name: "Renamed", parentCollection: "PARENT01" });
        await service.collectionWritten(USER_ID, "TOP00001", { parentCollection: false }, 43);
        expect((await service.collectionInfo(USER_ID, "TOP00001"))?.parentCollection).toBe("");
    });

    test("the item pane names the item's collections", async () => {
        await book("BOOK0001", {}, { collections: ["SUB00001", "TOP00001", "GONE0001"] });
        const details = await service.itemDetails(USER_ID, "BOOK0001");
        expect(details?.collections).toEqual([
            { key: "SUB00001", name: "Kittler" },
            { key: "TOP00001", name: "Media" },
        ]);
    });
});
