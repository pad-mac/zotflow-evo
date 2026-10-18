/**
 * ZotFlow Evo, round 07: collection changes for other plugins (the database
 * watch), the trash, restoring, trashed collections, and renaming a file
 * from the template.
 */
import { beforeEach, describe, expect, test } from "vitest";

import { EvoLibraryService } from "worker/services/evo-library";
import {
    flushCollectionChanges,
    watchCollections,
} from "worker/services/evo-collection-watch";
import { mutateItems } from "db/mutate";
import { db, seedCollection, seedItem } from "../fakes/db";
import { createFakeParentHost } from "../fakes/parent-host";
import { createServiceHarness, USER_ID } from "../fakes/services";

import type { AnyIDBZoteroItem } from "types/db-schema";
import type { ZoteroCollection } from "types/zotero";
import type { CollectionChange } from "services/event-hub";
import type { FakeParentHost } from "../fakes/parent-host";
import type { ServiceHarness } from "../fakes/services";

function raw(key: string, data: Record<string, unknown>) {
    return {
        key,
        version: 1,
        library: { type: "user", id: USER_ID, name: "L" },
        meta: { createdByUser: { id: USER_ID } },
        data: { key, version: 1, tags: [], relations: {}, collections: [], ...data },
    } as unknown as AnyIDBZoteroItem["raw"];
}

type Seed = Partial<AnyIDBZoteroItem> & { libraryID: number; key: string };

async function book(key: string, collections: string[] = [], over: Partial<AnyIDBZoteroItem> = {}, data: Record<string, unknown> = {}) {
    await seedItem({
        libraryID: USER_ID,
        key,
        itemType: "book",
        title: `Book ${key}`,
        collections,
        raw: raw(key, {
            itemType: "book",
            title: `Book ${key}`,
            shortTitle: "Lebendige Kräfte",
            creators: [{ creatorType: "author", firstName: "Henning", lastName: "Schmidgen" }],
            date: "2005",
            collections,
            ...data,
        }),
        ...over,
    } as Seed);
}

async function attachment(key: string, parentItem: string, data: Record<string, unknown>) {
    await seedItem({
        libraryID: USER_ID,
        key,
        itemType: "attachment",
        parentItem,
        title: typeof data.title === "string" ? data.title : "Full Text PDF",
        raw: raw(key, { itemType: "attachment", parentItem, title: "Full Text PDF", ...data }),
    } as Seed);
}

let h: ServiceHarness;
let service: EvoLibraryService;
let host: FakeParentHost;

beforeEach(async () => {
    h = await createServiceHarness();
    host = createFakeParentHost();
    service = new EvoLibraryService(h.settings, h.library, host);
    await seedCollection({ libraryID: USER_ID, key: "TOP00001", name: "Media" });
    await seedCollection({ libraryID: USER_ID, key: "SUB00001", name: "Kittler", parentCollection: "TOP00001" });
    await seedCollection({ libraryID: USER_ID, key: "DEEP0001", name: "Grammophon", parentCollection: "SUB00001" });
});

describe("collection changes for other plugins", () => {
    function changes(): CollectionChange[] {
        flushCollectionChanges();
        const out = host.events
            .filter((e) => e.name === "collectionsChanged")
            .flatMap((e) => e.args[0] as CollectionChange[]);
        host.clearRecordings();
        return out;
    }

    beforeEach(() => {
        watchCollections(host);
        changes();
    });

    test("an item put into, moved between and taken out of collections", async () => {
        await book("BOOK0001", ["TOP00001"]);
        expect(changes()).toEqual([
            { libraryID: USER_ID, collectionKey: "TOP00001", added: ["BOOK0001"], removed: [], collectionChanged: false },
        ]);
        await service.addToCollection(USER_ID, ["BOOK0001"], "SUB00001");
        await service.removeFromCollection(USER_ID, ["BOOK0001"], "TOP00001");
        const moved = changes();
        expect(moved).toContainEqual({ libraryID: USER_ID, collectionKey: "SUB00001", added: ["BOOK0001"], removed: [], collectionChanged: false });
        expect(moved).toContainEqual({ libraryID: USER_ID, collectionKey: "TOP00001", added: [], removed: ["BOOK0001"], collectionChanged: false });
    });

    test("trashed and restored: out of its collections and back", async () => {
        await book("BOOK0001", ["TOP00001"]);
        changes();
        await service.trashItems(USER_ID, ["BOOK0001"]);
        expect(changes()).toEqual([
            { libraryID: USER_ID, collectionKey: "TOP00001", added: [], removed: ["BOOK0001"], collectionChanged: false },
        ]);
        await service.restoreItems(USER_ID, ["BOOK0001"]);
        expect(changes()).toEqual([
            { libraryID: USER_ID, collectionKey: "TOP00001", added: ["BOOK0001"], removed: [], collectionChanged: false },
        ]);
    });

    test("other edits of an item say nothing; added and taken out again within a moment says nothing", async () => {
        await book("BOOK0001", ["TOP00001"]);
        changes();
        await mutateItems(USER_ID, [{ key: "BOOK0001", edit: (d: object) => void ((d as { title: string }).title = "New") }]);
        expect(changes()).toEqual([]);
        await service.addToCollection(USER_ID, ["BOOK0001"], "SUB00001");
        await service.removeFromCollection(USER_ID, ["BOOK0001"], "SUB00001");
        expect(changes()).toEqual([]);
    });

    test("a child (attachment) is not counted; a collection renamed or deleted is", async () => {
        await attachment("PDF00001", "BOOK0001", { contentType: "application/pdf", linkMode: "imported_file", collections: ["TOP00001"] });
        expect(changes()).toEqual([]);
        await service.collectionWritten(USER_ID, "SUB00001", { name: "Renamed" }, 5);
        await db.collections.delete([USER_ID, "DEEP0001"]);
        const c = changes();
        expect(c).toContainEqual({ libraryID: USER_ID, collectionKey: "SUB00001", added: [], removed: [], collectionChanged: true });
        expect(c).toContainEqual({ libraryID: USER_ID, collectionKey: "DEEP0001", added: [], removed: [], collectionChanged: true });
    });
});

describe("the trash", () => {
    test("lists the library's trashed top-level items; restoring brings them back", async () => {
        await book("BOOK0001", ["TOP00001"]);
        await book("BOOK0002", [], { trashed: 1 }, { deleted: 1 });
        await attachment("PDF00001", "BOOK0001", { contentType: "application/pdf", linkMode: "imported_file", deleted: 1 });
        const trash = await service.listItems({ libraryID: USER_ID, collectionKey: null, subcollections: false, trash: true });
        expect(trash.map((r) => r.key)).toEqual(["BOOK0002"]);
        expect(await service.restoreItems(USER_ID, ["BOOK0002", "BOOK0001"])).toEqual({ changed: 1, skipped: 1 });
        const row = (await db.items.get([USER_ID, "BOOK0002"]))!;
        expect(row.trashed).toBe(0);
        expect("deleted" in (row.raw.data as object)).toBe(false);
        expect(await service.listItems({ libraryID: USER_ID, collectionKey: null, subcollections: false, trash: true })).toEqual([]);
    });

    test("trashed collections: only the top-most of a trashed branch is listed", async () => {
        await seedCollection({ libraryID: USER_ID, key: "OLD00001", name: "Old", trashed: 1 });
        await seedCollection({ libraryID: USER_ID, key: "OLD00002", name: "Older", parentCollection: "OLD00001", trashed: 1 });
        await seedCollection({ libraryID: USER_ID, key: "SUB00001", name: "Kittler", parentCollection: "TOP00001", trashed: 1 });
        const [lib] = await service.getCollectionTree();
        expect(lib!.trashedCollections.map((c) => c.key)).toEqual(["SUB00001", "OLD00001"]);
        expect(lib!.collections.map((c) => c.key)).toEqual(["TOP00001"]);
        expect(lib!.collections[0]!.children).toEqual([]);
    });

    test("a collection's family: itself, what is inside it, what it is in", async () => {
        await seedCollection({ libraryID: USER_ID, key: "TOP00001", name: "Media", version: 3, trashed: 1 });
        const family = await service.collectionFamily(USER_ID, "SUB00001");
        expect(family).toEqual({
            self: { key: "SUB00001", name: "Kittler", version: 1, trashed: false },
            descendants: [{ key: "DEEP0001", version: 1, trashed: false }],
            ancestors: [{ key: "TOP00001", version: 3, trashed: true }],
        });
        expect(await service.collectionFamily(USER_ID, "MISSING1")).toBeNull();
    });

    test("collections Zotero answered a write with are kept as answered", async () => {
        await service.collectionsWritten(USER_ID, [
            { key: "NEW00001", version: 9, library: { type: "user", id: USER_ID, name: "L" }, data: { key: "NEW00001", version: 9, name: "Fresh", parentCollection: "TOP00001" } },
            { key: "SUB00001", version: 10, library: { type: "user", id: USER_ID, name: "L" }, data: { key: "SUB00001", version: 10, name: "Kittler", parentCollection: "TOP00001", deleted: true } },
        ] as unknown as ZoteroCollection[]);
        expect(await db.collections.get([USER_ID, "NEW00001"])).toMatchObject({ name: "Fresh", parentCollection: "TOP00001", version: 9, trashed: 0 });
        expect(await db.collections.get([USER_ID, "SUB00001"])).toMatchObject({ version: 10, trashed: 1 });
        expect(host.events.some((e) => e.name === "treeChanged")).toBe(true);
    });
});

describe("renaming a file from the template", () => {
    test("a stored PDF: its filename (extension kept); a title that was the old name follows", async () => {
        await book("BOOK0001");
        await attachment("PDF00001", "BOOK0001", { contentType: "application/pdf", linkMode: "imported_file", filename: "Schmidgen - 2005.PDF", title: "Schmidgen - 2005" });
        await db.files.put({ libraryID: USER_ID, key: "PDF00001", buffer: new ArrayBuffer(1), mimeType: "application/pdf", fileName: "Schmidgen - 2005.PDF", md5: "x", lastAccessedAt: "", size: 1 });
        expect(await service.renameAttachmentFile(USER_ID, "PDF00001")).toEqual({ status: "renamed", name: "schmidgen_2005_lebendige-kräfte.PDF", problem: undefined });
        const row = (await db.items.get([USER_ID, "PDF00001"]))!;
        expect(row.raw.data).toMatchObject({ filename: "schmidgen_2005_lebendige-kräfte.PDF", title: "schmidgen_2005_lebendige-kräfte.PDF" });
        expect(row.syncStatus).toBe("updated");
        expect((await db.files.get([USER_ID, "PDF00001"]))!.fileName).toBe("schmidgen_2005_lebendige-kräfte.PDF");
        expect((await service.renameAttachmentFile(USER_ID, "PDF00001")).status).toBe("same");
    });

    test("a title of its own stays; a linked file or a snapshot is refused", async () => {
        await book("BOOK0001");
        await attachment("EPUB0001", "BOOK0001", { contentType: "application/epub+zip", linkMode: "imported_file", filename: "a.epub", title: "Full Text" });
        await service.renameAttachmentFile(USER_ID, "EPUB0001");
        expect((await db.items.get([USER_ID, "EPUB0001"]))!.raw.data).toMatchObject({ filename: "schmidgen_2005_lebendige-kräfte.epub", title: "Full Text" });
        await attachment("LINK0001", "BOOK0001", { contentType: "application/pdf", linkMode: "linked_file", path: "/x.pdf" });
        await expect(service.renameAttachmentFile(USER_ID, "LINK0001")).rejects.toThrow(/stored in Zotero/);
        await attachment("SNAP0001", "BOOK0001", { contentType: "text/html", linkMode: "imported_url", filename: "index.html" });
        await expect(service.renameAttachmentFile(USER_ID, "SNAP0001")).rejects.toThrow(/PDFs and EPUBs/);
    });
});
