/**
 * ZotFlow Evo (fork): what the library browser, the collection tabs and the
 * annotation browser show, read from the database in the worker. The rules
 * (which attachment is primary, how names are written) are in
 * `utils/evo-library-model.ts`; the views in `ui/evo-library/`. See FORK.md.
 */
import { Liquid } from "liquidjs";

import { db, getCombinations } from "db/db";
import { getAnnotationJson } from "db/annotation";
import { deleteLocalItems, mutateItems } from "db/mutate";
import { BACKUP_TAG, parseBackupNote } from "utils/evo-pdf-backup";
import { remapPosition, sortIndexOnPage } from "utils/evo-pdf-geometry";
import { normalizeCollection } from "db/normalize";
import { ZotFlowError, ZotFlowErrorCode } from "utils/error";
import {
    DEFAULT_ATTACH_FILENAME,
    attachmentKind,
    attachmentRename,
    bestKind,
    choosePrimaryAttachment,
    creatorSummary,
    fullName,
    lastName,
    mainCreators,
    plainTitle,
    publicationLine,
    sanitizeFilename,
} from "utils/evo-library-model";
import { extractYear } from "utils/date";
import { getField } from "utils/zotero-fields";
import { Zotero_Item_Types } from "types/zotero-item-const";
import { ITEM_TYPE_CREATORS, ITEM_TYPE_FIELDS } from "types/zotero-csl-schema";
import { makeCitationKey, uniqueCitationKey } from "utils/evo-citekey";
import { sharedFolderFor } from "utils/evo-shared-folder";

import type { LibraryService } from "./library";
import type { IParentProxy } from "bridge/types";
import type { ZotFlowSettings } from "settings/types";
import type { AnyIDBZoteroItem, IDBZoteroCollection } from "types/db-schema";
import type { PagePlan, PdfPosition } from "utils/evo-pdf-geometry";
import type { PdfBackupInfo } from "utils/evo-pdf-backup";
import type { ZoteroCollection } from "types/zotero";
import type { AnnotationJSON } from "types/zotero-reader";
import type {
    AttachmentFileFacts,
    AttachmentKind,
    CreatorFacts,
    EvoAnnotatedItem,
    EvoCollectionAnnotation,
    EvoItemRow,
} from "utils/evo-library-model";

/** A collection and the ones inside it. */
export interface EvoCollectionNode {
    libraryID: number;
    key: string;
    name: string;
    children: EvoCollectionNode[];
}

/** A library with its collections, as the browser's left pane lists them. */
export interface EvoLibraryNode {
    libraryID: number;
    name: string;
    collections: EvoCollectionNode[];
    /** Collections in the trash whose parent is not: what the trash lists. */
    trashedCollections: EvoCollectionNode[];
}

/** What the table lists: a whole library, or one collection (with or without the ones inside it). */
export interface EvoScope {
    libraryID: number;
    /** null: the whole library. */
    collectionKey: string | null;
    subcollections: boolean;
    /** The library's trash (its trashed items); `collectionKey` is then null. */
    trash?: boolean;
    /**
     * ZotFlow Evo (beta.15): the items a person is a creator of, in any
     * role and in every library, by name as Zotero shows it ("Urs
     * Stäheli"; case and accents' encoding do not matter). `libraryID` and
     * `collectionKey` are then not used.
     */
    creator?: string;
}

/** An attachment as the details pane lists it. */
export interface EvoAttachmentInfo {
    key: string;
    title: string;
    kind: AttachmentKind;
    /** A linked file (outside Zotero's storage; opens on desktop only). */
    linked?: boolean;
    /** The file's md5 as Zotero has it (none before its first upload). */
    md5?: string;
}

/** What the details pane shows of an item. */
export interface EvoItemDetails {
    libraryID: number;
    key: string;
    itemType: string;
    title: string;
    /** Full names of the first two main creators. */
    authors: string[];
    /** More main creators than those two. */
    moreAuthors: boolean;
    firstCreator: string;
    year: string;
    publication: string;
    abstract: string;
    attachments: EvoAttachmentInfo[];
    /** The collections it is in, by name. */
    collections: { key: string; name: string }[];
    /** The attachment a double click opens, if one is (see choosePrimaryAttachment()). */
    primaryKey: string | null;
    /** Annotations of the primary attachment, or of each candidate when there is none. */
    annotations: (AnnotationJSON & { attachmentKey: string })[];
}

/** The annotations of a collection and the items they belong to. */
export interface EvoCollectionAnnotations {
    name: string;
    items: EvoAnnotatedItem[];
    annotations: EvoCollectionAnnotation[];
}

const collator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
});

function creatorsOf(item: AnyIDBZoteroItem): CreatorFacts[] {
    const creators = (item.raw?.data as { creators?: unknown } | undefined)
        ?.creators;
    return Array.isArray(creators) ? (creators as CreatorFacts[]) : [];
}

function field(item: AnyIDBZoteroItem, name: string): string {
    const data = item.raw?.data;
    if (!data) return "";
    return getField({ ...data, itemType: item.itemType }, name) ?? "";
}

/** What an edit from the library browser changed. */
export interface EvoEditResult {
    /** Items written. */
    changed: number;
    /** Items left as they were (already so, gone, or not top-level). */
    skipped: number;
}

export class EvoLibraryService {
    constructor(
        private settings: ZotFlowSettings,
        private library: LibraryService,
        private parentHost?: IParentProxy,
    ) {}

    /**
     * Whether items of this library may be changed from here: it syncs both
     * ways and the API key may write to it.
     */
    private async assertWritable(libraryID: number): Promise<void> {
        if (
            !this.library.isBidirectional(libraryID) ||
            !(await this.library.canWrite(libraryID))
        ) {
            throw new ZotFlowError(
                ZotFlowErrorCode.AUTH_INVALID,
                "EvoLibraryService",
                "This library is read-only in ZotFlow.",
            );
        }
    }

    /** Edit the item data of top-level items; `edit` returns whether it changed anything. */
    private async editItems(
        libraryID: number,
        keys: string[],
        edit: (data: Record<string, unknown>) => boolean,
    ): Promise<EvoEditResult> {
        await this.assertWritable(libraryID);
        const notes = await this.library.hasNotesAccess(libraryID);
        const rows = await db.items.bulkGet(
            keys.map((k): [number, string] => [libraryID, k]),
        );
        const eligible = rows.filter(
            (r): r is AnyIDBZoteroItem =>
                !!r &&
                !r.parentItem &&
                r.itemType !== "annotation" &&
                (notes || r.itemType !== "note"),
        );
        const edits = eligible.map((r) => ({
            key: r.key,
            edit: (data: object) => {
                edit(data as Record<string, unknown>);
            },
        }));
        // What would change, decided on the rows as they are; the edit
        // itself runs again inside the write.
        const willChange = eligible.filter((r) =>
            edit(
                structuredClone(r.raw.data) as unknown as Record<
                    string,
                    unknown
                >,
            ),
        );
        const written = await mutateItems(
            libraryID,
            edits.filter((e) => willChange.some((r) => r.key === e.key)),
        );
        const changed = written.filter(Boolean).length;
        if (changed) this.parentHost?.emit("treeChanged");
        return { changed, skipped: keys.length - changed };
    }

    /** Put items into a collection (they stay in the others they are in). */
    async addToCollection(
        libraryID: number,
        keys: string[],
        collectionKey: string,
    ): Promise<EvoEditResult> {
        return this.editItems(libraryID, keys, (data) => {
            const list = Array.isArray(data.collections)
                ? (data.collections as string[])
                : [];
            if (list.includes(collectionKey)) return false;
            data.collections = [...list, collectionKey];
            return true;
        });
    }

    /** Take items out of one collection (not out of the ones inside it). */
    async removeFromCollection(
        libraryID: number,
        keys: string[],
        collectionKey: string,
    ): Promise<EvoEditResult> {
        return this.editItems(libraryID, keys, (data) => {
            const list = Array.isArray(data.collections)
                ? (data.collections as string[])
                : [];
            if (!list.includes(collectionKey)) return false;
            data.collections = list.filter((k) => k !== collectionKey);
            return true;
        });
    }

    /** Move items to the trash, as Zotero does: `deleted` is set; they can be restored there. */
    async trashItems(
        libraryID: number,
        keys: string[],
    ): Promise<EvoEditResult> {
        return this.editItems(libraryID, keys, (data) => {
            if (data.deleted) return false;
            data.deleted = 1;
            return true;
        });
    }

    /** What the name of a file saved to an item is made of. */
    async filenameParts(
        libraryID: number,
        key: string,
    ): Promise<{
        lastName: string;
        year: string;
        shortTitle: string;
        title: string;
        itemType: string;
    } | null> {
        const item = await db.items.get([libraryID, key]);
        if (!item) return null;
        const main = mainCreators(creatorsOf(item));
        const clean = (s: string) => plainTitle(s).replace(/\s+/g, " ").trim();
        const title = clean(item.title || field(item, "title"));
        return {
            lastName: main[0] ? lastName(main[0]) : "",
            year: extractYear(field(item, "date")),
            shortTitle: clean(field(item, "shortTitle")) || title,
            title,
            itemType: item.itemType,
        };
    }

    /** What a collection edit needs to know (the edit itself goes to Zotero's API). */
    async collectionInfo(
        libraryID: number,
        key: string,
    ): Promise<{
        version: number;
        name: string;
        parentCollection: string;
    } | null> {
        const c = await db.collections.get([libraryID, key]);
        if (!c) return null;
        return {
            version: c.version,
            name: c.name,
            parentCollection: c.parentCollection,
        };
    }

    /**
     * Zotero took an edit of a collection (renamed, moved): show it here at
     * once. The next sync brings the same from the server.
     */
    async collectionWritten(
        libraryID: number,
        key: string,
        patch: { name?: string; parentCollection?: string | false },
        version: number,
    ): Promise<void> {
        const c = await db.collections.get([libraryID, key]);
        if (!c) return;
        const data = { ...c.raw.data } as Record<string, unknown>;
        if (patch.name !== undefined) data.name = patch.name;
        if (patch.parentCollection !== undefined)
            data.parentCollection = patch.parentCollection;
        await db.collections.put({
            ...c,
            name: patch.name ?? c.name,
            parentCollection:
                patch.parentCollection === undefined
                    ? c.parentCollection
                    : patch.parentCollection || "",
            version: version || c.version,
            raw: {
                ...c.raw,
                version: version || c.raw.version,
                data: data as typeof c.raw.data,
            },
        });
        this.parentHost?.emit("treeChanged");
    }

    /**
     * Collections Zotero took a write of (created, trashed, restored): kept
     * here as Zotero answered, at once. The next sync brings the same.
     */
    async collectionsWritten(
        libraryID: number,
        written: ZoteroCollection[],
    ): Promise<void> {
        if (!written.length) return;
        await db.collections.bulkPut(
            written.map((c) => normalizeCollection(c, libraryID)),
        );
        this.parentHost?.emit("treeChanged");
    }

    /**
     * A collection, every collection inside it, and the collections it is
     * in (nearest first), each with its version and whether it is in the
     * trash: what trashing or restoring it writes.
     */
    async collectionFamily(
        libraryID: number,
        key: string,
    ): Promise<{
        self: { key: string; name: string; version: number; trashed: boolean };
        descendants: { key: string; version: number; trashed: boolean }[];
        ancestors: { key: string; version: number; trashed: boolean }[];
    } | null> {
        const all = await db.collections
            .where(["libraryID", "trashed"])
            .anyOf([
                [libraryID, 0],
                [libraryID, 1],
            ])
            .toArray();
        const byKey = new Map(all.map((c) => [c.key, c]));
        const self = byKey.get(key);
        if (!self) return null;
        const brief = (c: IDBZoteroCollection) => ({
            key: c.key,
            version: c.version,
            trashed: !!c.trashed,
        });
        const children = new Map<string, IDBZoteroCollection[]>();
        for (const c of all) {
            if (!c.parentCollection) continue;
            const list = children.get(c.parentCollection) ?? [];
            list.push(c);
            children.set(c.parentCollection, list);
        }
        const descendants: IDBZoteroCollection[] = [];
        const seen = new Set([key]);
        const walk = (k: string) => {
            for (const c of children.get(k) ?? []) {
                if (seen.has(c.key)) continue;
                seen.add(c.key);
                descendants.push(c);
                walk(c.key);
            }
        };
        walk(key);
        const ancestors: IDBZoteroCollection[] = [];
        for (
            let p = byKey.get(self.parentCollection);
            p && !seen.has(p.key);
            p = byKey.get(p.parentCollection)
        ) {
            seen.add(p.key);
            ancestors.push(p);
        }
        return {
            self: { ...brief(self), name: self.name },
            descendants: descendants.map(brief),
            ancestors: ancestors.map(brief),
        };
    }

    /**
     * Rename an attachment's file from the file name template (as for a file
     * saved to its item), as Zotero renames one: its `filename` changes, and
     * every Zotero client renames its copy when it syncs that.
     */
    async renameAttachmentFile(
        libraryID: number,
        key: string,
    ): Promise<{ status: "renamed" | "same"; name: string; problem?: string }> {
        await this.assertWritable(libraryID);
        const attachment = await db.items.get([libraryID, key]);
        if (!attachment || attachment.itemType !== "attachment")
            throw new ZotFlowError(
                ZotFlowErrorCode.UNKNOWN,
                "EvoLibraryService",
                "The attachment is not here (any more).",
            );
        // ZotFlow Evo: the file name is the link into a group's shared folder.
        if (sharedFolderFor(this.settings.evoGroupFolders, libraryID))
            throw new ZotFlowError(
                ZotFlowErrorCode.UNKNOWN,
                "EvoLibraryService",
                "This group keeps its files in a shared folder, where the name is what links them; it is not changed.",
            );
        const parentKey = attachment.parentItem || attachment.key;
        const { name, problem } = await this.attachFilename(
            libraryID,
            parentKey,
        );
        const data = attachment.raw.data as AttachmentFileFacts;
        const change = attachmentRename(data, name);
        if (change === null)
            return { status: "same", name: data.filename ?? name, problem };
        if ("refused" in change)
            throw new ZotFlowError(
                ZotFlowErrorCode.UNKNOWN,
                "EvoLibraryService",
                change.refused,
            );
        const [written] = await mutateItems(libraryID, [
            {
                key,
                edit: (d: object) => {
                    const fields = d as Record<string, unknown>;
                    fields.filename = change.filename;
                    if (change.title !== undefined) fields.title = change.title;
                },
            },
        ]);
        if (!written)
            throw new ZotFlowError(
                ZotFlowErrorCode.UNKNOWN,
                "EvoLibraryService",
                "The attachment is not here (any more).",
            );
        // The copy kept here goes by the new name too (bookkeeping only).
        await db.files
            .update([libraryID, key], { fileName: change.filename })
            .catch(() => 0);
        this.parentHost?.emit("treeChanged");
        return { status: "renamed", name: change.filename, problem };
    }

    /**
     * The annotations of a PDF that was rewritten (PDF editing): each moved
     * to its page in the new file and turned with it (`plans`, from
     * evo-pdf-geometry). With `relabel`, page labels become page numbers
     * (the file's page labels were removed). Local edits, synced as usual.
     */
    /**
     * ZotFlow Evo: the annotations of a PDF after its file was rewritten
     * (PDF editing, or a revert): their places through each stage of page
     * plans in turn, and their page labels from `labels` (the new file's,
     * by page index) when given.
     */
    async remapAnnotations(
        libraryID: number,
        attachmentKey: string,
        stages: PagePlan[][],
        labels: string[] | null,
    ): Promise<EvoEditResult> {
        await this.assertWritable(libraryID);
        const annotations = await db.items
            .where(["libraryID", "parentItem", "itemType", "trashed"])
            .anyOf(
                getCombinations([
                    [libraryID],
                    [attachmentKey],
                    ["annotation"],
                    [0, 1],
                ]),
            )
            .toArray();
        const edits: { key: string; edit: (data: object) => void }[] = [];
        for (const item of annotations) {
            const data = item.raw.data as {
                annotationPosition?: string;
                annotationSortIndex?: string;
                annotationPageLabel?: string;
            };
            let position: PdfPosition;
            try {
                position = JSON.parse(
                    data.annotationPosition ?? "",
                ) as PdfPosition;
            } catch {
                continue;
            }
            let moved: PdfPosition | null = position;
            for (const plans of stages) {
                if (!moved) break;
                moved = remapPosition(moved, plans);
            }
            if (!moved) continue;
            const label = labels?.[moved.pageIndex];
            if (
                JSON.stringify(moved) === JSON.stringify(position) &&
                (label === undefined || label === data.annotationPageLabel)
            )
                continue;
            const at = moved;
            edits.push({
                key: item.key,
                edit: (d) => {
                    const fields = d as typeof data;
                    fields.annotationPosition = JSON.stringify(at);
                    fields.annotationSortIndex = sortIndexOnPage(
                        fields.annotationSortIndex ?? "",
                        at.pageIndex,
                    );
                    if (label !== undefined) fields.annotationPageLabel = label;
                },
            });
        }
        if (!edits.length) return { changed: 0, skipped: 0 };
        const written = await mutateItems(libraryID, edits);
        const changed = written.filter(Boolean).length;
        return { changed, skipped: edits.length - changed };
    }

    /**
     * ZotFlow Evo: the copies kept before edits of a PDF (in the trash,
     * beside it), newest first, with whether each has its file here yet.
     */
    async pdfBackups(
        libraryID: number,
        attachmentKey: string,
    ): Promise<(PdfBackupInfo & { key: string; synced: boolean })[]> {
        const original = await db.items.get([libraryID, attachmentKey]);
        if (!original) return [];
        const parent = original.parentItem || null;
        const trashed = parent
            ? await db.items
                  .where(["libraryID", "parentItem", "itemType", "trashed"])
                  .equals([libraryID, parent, "attachment", 1])
                  .toArray()
            : (
                  await db.items
                      .where(["libraryID", "itemType", "trashed"])
                      .equals([libraryID, "attachment", 1])
                      .toArray()
              ).filter((item) => !item.parentItem);
        const out: (PdfBackupInfo & { key: string; synced: boolean })[] = [];
        for (const item of trashed) {
            const data = item.raw.data as {
                note?: string;
                md5?: string | null;
                tags?: { tag: string }[];
            };
            if (!data.tags?.some((t) => t.tag === BACKUP_TAG)) continue;
            const info = parseBackupNote(data.note);
            if (!info || info.of !== attachmentKey) continue;
            out.push({ ...info, key: item.key, synced: !!data.md5 });
        }
        return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    }

    /** ZotFlow Evo: delete items for good (copies a revert used up). */
    async deleteForever(libraryID: number, keys: string[]): Promise<number> {
        await this.assertWritable(libraryID);
        const result = await deleteLocalItems(libraryID, keys);
        return result.removed.length + result.trashed.length;
    }

    /**
     * ZotFlow Evo: set fields of an item (the item pane's editor). Only
     * fields its type has; "" empties one. Returns whether it changed.
     */
    async setItemFields(
        libraryID: number,
        key: string,
        fields: Record<string, string>,
    ): Promise<boolean> {
        const item = await db.items.get([libraryID, key]);
        if (!item) throw new ZotFlowError(ZotFlowErrorCode.UNKNOWN, "EvoLibrary", "The item is not here.");
        const allowed = new Set(ITEM_TYPE_FIELDS[item.itemType] ?? []);
        const patch = Object.entries(fields).filter(([name]) => allowed.has(name));
        if (!patch.length) return false;
        const result = await this.editItems(libraryID, [key], (data) => {
            let changed = false;
            for (const [name, value] of patch) {
                if ((data[name] ?? "") === value) continue;
                data[name] = value;
                changed = true;
            }
            return changed;
        });
        return result.changed > 0;
    }

    /**
     * ZotFlow Evo: an item's creators replaced (the item editor). Each is
     * `{ creatorType, firstName, lastName }` or `{ creatorType, name }`;
     * roles the item type does not take are refused.
     */
    async setItemCreators(
        libraryID: number,
        key: string,
        creators: {
            creatorType: string;
            firstName?: string;
            lastName?: string;
            name?: string;
        }[],
    ): Promise<boolean> {
        const item = await db.items.get([libraryID, key]);
        if (!item) throw new ZotFlowError(ZotFlowErrorCode.UNKNOWN, "EvoLibrary", "The item is not here.");
        const takes = new Set(ITEM_TYPE_CREATORS[item.itemType] ?? []);
        const clean = creators
            .filter((c) => takes.has(c.creatorType))
            .map((c) =>
                c.name !== undefined
                    ? { creatorType: c.creatorType, name: c.name.trim() }
                    : {
                          creatorType: c.creatorType,
                          firstName: (c.firstName ?? "").trim(),
                          lastName: (c.lastName ?? "").trim(),
                      },
            )
            .filter((c) =>
                "name" in c ? !!c.name : !!(c.lastName || c.firstName),
            );
        const result = await this.editItems(libraryID, [key], (data) => {
            const before = JSON.stringify(data.creators ?? []);
            if (before === JSON.stringify(clean)) return false;
            data.creators = structuredClone(clean);
            return true;
        });
        return result.changed > 0;
    }

    /**
     * ZotFlow Evo: a citation key for the item from its data as it is now
     * (Better BibTeX's default: auth.lower + shorttitle(3,3) + year), with
     * a, b, … when another item of the library has it.
     */
    async suggestCitationKey(libraryID: number, key: string): Promise<string> {
        const item = await db.items.get([libraryID, key]);
        if (!item) return "";
        const data = item.raw?.data as unknown as Record<string, unknown> | undefined;
        const base = makeCitationKey({
            title: field(item, "title"),
            date: field(item, "date"),
            creators: Array.isArray(data?.creators)
                ? (data.creators as { creatorType?: string; firstName?: string; lastName?: string; name?: string }[])
                : [],
            primaryCreatorType: ITEM_TYPE_CREATORS[item.itemType]?.[0],
        });
        if (!base) return "";
        const rows = await db.items
            .where("[libraryID+itemType+trashed]")
            .between([libraryID, "", 0], [libraryID, "\uffff", 1])
            .toArray();
        const taken = new Set<string>();
        for (const r of rows) {
            if (r.key === key) continue;
            const k = field(r, "citationKey");
            if (k) taken.add(k);
        }
        return uniqueCitationKey(base, taken);
    }

    /**
     * ZotFlow Evo: the file names of a library's stored-file attachments
     * (in the trash too): names a new file in a group's shared folder may
     * not take.
     */
    async attachmentFilenames(libraryID: number): Promise<string[]> {
        const rows = await db.items
            .where(["libraryID", "itemType", "trashed"])
            .anyOf(getCombinations([[libraryID], ["attachment"], [0, 1]]))
            .toArray();
        const out: string[] = [];
        for (const r of rows) {
            const name = (r.raw?.data as { filename?: unknown } | undefined)?.filename;
            if (typeof name === "string" && name) out.push(name);
        }
        return out;
    }

    /** Bring items back from the trash. */
    async restoreItems(
        libraryID: number,
        keys: string[],
    ): Promise<EvoEditResult> {
        return this.editItems(libraryID, keys, (data) => {
            if (!data.deleted) return false;
            delete data.deleted;
            return true;
        });
    }

    private readonly filenameEngine = new Liquid({ greedy: false });

    /**
     * The name (without extension) a file saved to this item gets: the
     * "file name" template (`evoAttachFilename`) over `filenameParts()`,
     * made safe for file systems. The default template where the user's
     * fails or renders nothing.
     */
    async attachFilename(
        libraryID: number,
        key: string,
    ): Promise<{ name: string; problem?: string }> {
        const parts = await this.filenameParts(libraryID, key);
        if (!parts) return { name: "" };
        return this.attachFilenameFor(parts);
    }

    /** The same for an item not here yet (one being created), from its parts. */
    async attachFilenameFor(parts: {
        lastName: string;
        year: string;
        shortTitle: string;
        title: string;
        itemType: string;
    }): Promise<{ name: string; problem?: string }> {
        const render = async (template: string) =>
            sanitizeFilename(
                String(
                    await this.filenameEngine.parseAndRender(template, parts),
                ),
            ).replace(/^[_ -]+|[_ -]+$/g, "");
        const template =
            this.settings.evoAttachFilename || DEFAULT_ATTACH_FILENAME;
        try {
            const name = await render(template);
            if (name && name !== "file") return { name };
            if (template !== DEFAULT_ATTACH_FILENAME)
                return {
                    name: (await render(DEFAULT_ATTACH_FILENAME)) || "file",
                    problem:
                        "The file name template gave nothing; the default was used.",
                };
            return { name: name || "file" };
        } catch (e) {
            return {
                name: (await render(DEFAULT_ATTACH_FILENAME)) || "file",
                problem: `The file name template failed (${e instanceof Error ? e.message.split("\n")[0] : String(e)}); the default was used.`,
            };
        }
    }

    updateSettings(settings: ZotFlowSettings) {
        this.settings = settings;
    }

    /** The libraries shown in ZotFlow, with their collections nested and sorted by name. */
    async getCollectionTree(): Promise<EvoLibraryNode[]> {
        const ids = await this.library.getActiveLibraryIDs();
        const [libraries, collections, trashed] = await Promise.all([
            db.libraries.where("id").anyOf(ids).toArray(),
            db.collections
                .where(["libraryID", "trashed"])
                .anyOf(getCombinations([ids, [0]]))
                .toArray(),
            db.collections
                .where(["libraryID", "trashed"])
                .anyOf(getCombinations([ids, [1]]))
                .toArray(),
        ]);
        const out: EvoLibraryNode[] = [];
        for (const id of ids) {
            const lib = libraries.find((l) => l.id === id);
            const own = collections.filter((c) => c.libraryID === id);
            const nodes = new Map<string, EvoCollectionNode>();
            for (const c of own) {
                nodes.set(c.key, {
                    libraryID: id,
                    key: c.key,
                    name: c.name,
                    children: [],
                });
            }
            const roots: EvoCollectionNode[] = [];
            // Inside a trashed collection: in the trash with it (not shown).
            const inTrash = new Set(
                trashed.filter((c) => c.libraryID === id).map((c) => c.key),
            );
            for (const c of own) {
                const node = nodes.get(c.key)!;
                const parent = c.parentCollection
                    ? nodes.get(c.parentCollection)
                    : undefined;
                if (parent) parent.children.push(node);
                else if (!inTrash.has(c.parentCollection)) roots.push(node);
            }
            const sort = (list: EvoCollectionNode[]) => {
                list.sort((a, b) => collator.compare(a.name, b.name));
                list.forEach((n) => sort(n.children));
            };
            sort(roots);
            const ownTrashed = trashed.filter((c) => c.libraryID === id);
            const trashedKeys = new Set(ownTrashed.map((c) => c.key));
            const trashedTop = ownTrashed
                .filter((c) => !trashedKeys.has(c.parentCollection))
                .map((c): EvoCollectionNode => ({
                    libraryID: id,
                    key: c.key,
                    name: c.name,
                    children: [],
                }));
            sort(trashedTop);
            out.push({
                libraryID: id,
                trashedCollections: trashedTop,
                name:
                    lib?.type === "user"
                        ? "My Library"
                        : lib?.name || `Library ${id}`,
                collections: roots,
            });
        }
        // The personal library first, then the groups by name.
        const user = (n: EvoLibraryNode) =>
            libraries.find((l) => l.id === n.libraryID)?.type === "user";
        return out.sort(
            (a, b) =>
                Number(user(b)) - Number(user(a)) ||
                collator.compare(a.name, b.name),
        );
    }

    /** The collection and every collection inside it. */
    private async collectionKeys(
        libraryID: number,
        key: string,
        deep: boolean,
    ): Promise<string[]> {
        if (!deep) return [key];
        const all = await db.collections
            .where(["libraryID", "trashed"])
            .equals([libraryID, 0])
            .toArray();
        const children = new Map<string, IDBZoteroCollection[]>();
        for (const c of all) {
            if (!c.parentCollection) continue;
            const list = children.get(c.parentCollection) ?? [];
            list.push(c);
            children.set(c.parentCollection, list);
        }
        const out: string[] = [];
        const walk = (k: string) => {
            if (out.includes(k)) return;
            out.push(k);
            for (const c of children.get(k) ?? []) walk(c.key);
        };
        walk(key);
        return out;
    }

    /** The top-level items (not attachments or notes under an item) of a scope. */
    private async topLevelItems(scope: EvoScope): Promise<AnyIDBZoteroItem[]> {
        const { libraryID } = scope;
        const notesAccess = await this.library.hasNotesAccess(libraryID);
        if (scope.trash) {
            const types = Zotero_Item_Types.filter((t) => t !== "annotation");
            return (
                await db.items
                    .where(["libraryID", "itemType", "trashed"])
                    .anyOf(getCombinations([[libraryID], types, [1]]))
                    .toArray()
            ).filter(
                (i) => !i.parentItem && (notesAccess || i.itemType !== "note"),
            );
        }
        let items: AnyIDBZoteroItem[];
        if (scope.collectionKey === null) {
            const types = Zotero_Item_Types.filter((t) => t !== "annotation");
            items = await db.items
                .where(["libraryID", "itemType", "trashed"])
                .anyOf(getCombinations([[libraryID], types, [0]]))
                .filter((i) => !i.parentItem)
                .toArray();
        } else {
            const keys = await this.collectionKeys(
                libraryID,
                scope.collectionKey,
                scope.subcollections,
            );
            const found = await db.items
                .where("collections")
                .anyOf(keys)
                .toArray();
            const seen = new Set<string>();
            items = found.filter((i) => {
                if (i.libraryID !== libraryID || seen.has(i.key)) return false;
                seen.add(i.key);
                return true;
            });
        }
        return items.filter(
            (i) =>
                i.trashed === 0 &&
                !i.parentItem &&
                i.itemType !== "annotation" &&
                (notesAccess || i.itemType !== "note"),
        );
    }

    /** Attachments of the given items, by parent key, and annotation counts by attachment key. */
    private async children(libraryID: number, parents: AnyIDBZoteroItem[]) {
        const attachmentsByParent = new Map<string, AnyIDBZoteroItem[]>();
        const keys = new Set(parents.map((p) => p.key));
        const attachments = await db.items
            .where(["libraryID", "itemType", "trashed"])
            .equals([libraryID, "attachment", 0])
            .filter((a) => keys.has(a.parentItem))
            .toArray();
        for (const a of attachments) {
            const list = attachmentsByParent.get(a.parentItem) ?? [];
            list.push(a);
            attachmentsByParent.set(a.parentItem, list);
        }
        const attachmentKeys = new Set([
            ...attachments.map((a) => a.key),
            ...parents
                .filter((p) => p.itemType === "attachment")
                .map((p) => p.key),
        ]);
        const annotationCount = new Map<string, number>();
        await db.items
            .where(["libraryID", "itemType", "trashed"])
            .equals([libraryID, "annotation", 0])
            .each((a) => {
                if (!attachmentKeys.has(a.parentItem)) return;
                annotationCount.set(
                    a.parentItem,
                    (annotationCount.get(a.parentItem) ?? 0) + 1,
                );
            });
        return { attachmentsByParent, annotationCount };
    }

    private kindOf(a: AnyIDBZoteroItem): AttachmentKind {
        const data = a.raw?.data as
            { contentType?: string; linkMode?: string } | undefined;
        return attachmentKind({
            contentType: data?.contentType,
            linkMode: data?.linkMode,
        });
    }

    /** The rows of the library table for a scope, unsorted. */
    async listItems(scope: EvoScope): Promise<EvoItemRow[]> {
        if (scope.creator !== undefined) {
            const items = await this.creatorItems(scope.creator);
            const byLibrary = new Map<number, AnyIDBZoteroItem[]>();
            for (const item of items) {
                const list = byLibrary.get(item.libraryID) ?? [];
                list.push(item);
                byLibrary.set(item.libraryID, list);
            }
            const rows: EvoItemRow[] = [];
            for (const [libraryID, list] of byLibrary)
                rows.push(...(await this.rowsOf(libraryID, list)));
            return rows;
        }
        return this.rowsOf(scope.libraryID, await this.topLevelItems(scope));
    }

    /**
     * The items with a creator of this name, in every library: top-level,
     * not in the trash. Matched on "First Last" (or a one-field name) as the
     * search index keeps it, ignoring case, in both Unicode forms.
     */
    private async creatorItems(name: string): Promise<AnyIDBZoteroItem[]> {
        const wanted = name.replace(/\s+/g, " ").trim();
        if (!wanted) return [];
        const forms = [...new Set([wanted, wanted.normalize("NFC"), wanted.normalize("NFD")])];
        const found = await db.items
            .where("searchCreators")
            .anyOfIgnoreCase(forms)
            .toArray();
        const seen = new Set<string>();
        return found.filter((i) => {
            const id = `${i.libraryID}:${i.key}`;
            if (seen.has(id)) return false;
            seen.add(id);
            return (
                i.trashed === 0 &&
                !i.parentItem &&
                i.itemType !== "annotation" &&
                i.itemType !== "note"
            );
        });
    }

    /** Table rows for items of one library. */
    private async rowsOf(
        libraryID: number,
        items: AnyIDBZoteroItem[],
    ): Promise<EvoItemRow[]> {
        const { attachmentsByParent, annotationCount } = await this.children(
            libraryID,
            items,
        );
        return items.map((item) => {
            // A standalone PDF is its own attachment.
            const attachments =
                item.itemType === "attachment"
                    ? [item]
                    : (attachmentsByParent.get(item.key) ?? []);
            const creators = creatorsOf(item);
            const main = mainCreators(creators);
            return {
                libraryID: item.libraryID,
                key: item.key,
                itemType: item.itemType,
                title: item.title || field(item, "title") || "Untitled",
                shortTitle: field(item, "shortTitle"),
                creator: creatorSummary(creators),
                creatorSort: main.map(lastName).join(" "),
                firstCreator: main[0] ? fullName(main[0]) : "",
                firstLastName: main[0] ? lastName(main[0]) : "",
                year: extractYear(field(item, "date")),
                date: field(item, "date"),
                publication: field(item, "publicationTitle"),
                publisher: field(item, "publisher"),
                dateAdded: item.dateAdded || "",
                dateModified: item.dateModified || "",
                citationKey: item.citationKey || "",
                attachment: bestKind(attachments.map((a) => this.kindOf(a))),
                attachmentCount: attachments.length,
                annotationCount: attachments.reduce(
                    (n, a) => n + (annotationCount.get(a.key) ?? 0),
                    0,
                ),
                tags: item.searchTags ?? [],
            };
        });
    }

    /** The details pane for one item. */
    async itemDetails(
        libraryID: number,
        key: string,
    ): Promise<EvoItemDetails | null> {
        const item = await db.items.get([libraryID, key]);
        if (!item) return null;
        const attachments =
            item.itemType === "attachment"
                ? [item]
                : await db.items
                      .where(["libraryID", "parentItem", "itemType", "trashed"])
                      .equals([libraryID, key, "attachment", 0])
                      .toArray();
        const { primary, choices } = choosePrimaryAttachment(attachments, (a) =>
            this.kindOf(a),
        );
        const shown = primary ? [primary] : choices;
        const annotations: EvoItemDetails["annotations"] = [];
        for (const attachment of shown) {
            const list = await getAnnotationJson(
                attachment,
                this.settings.zoteroapikey,
            );
            for (const a of list)
                annotations.push({ ...a, attachmentKey: attachment.key });
        }
        const main = mainCreators(creatorsOf(item));
        const collectionKeys = Array.isArray(
            (item.raw?.data as { collections?: unknown } | undefined)
                ?.collections,
        )
            ? (item.raw.data as { collections: string[] }).collections
            : [];
        const collections = (
            await db.collections.bulkGet(
                collectionKeys.map((k): [number, string] => [libraryID, k]),
            )
        )
            .filter((c): c is IDBZoteroCollection => !!c && !c.trashed)
            .map((c) => ({ key: c.key, name: c.name }))
            .sort((a, b) => collator.compare(a.name, b.name));
        return {
            libraryID,
            key,
            itemType: item.itemType,
            title: item.title || field(item, "title") || "Untitled",
            collections,
            authors: main.slice(0, 2).map(fullName),
            moreAuthors: main.length > 2,
            firstCreator: main[0] ? fullName(main[0]) : "",
            year: extractYear(field(item, "date")),
            publication: publicationLine(item.itemType, {
                publication: field(item, "publicationTitle"),
                volume: field(item, "volume"),
                issue: field(item, "issue"),
                pages: field(item, "pages"),
            }),
            abstract: field(item, "abstractNote"),
            attachments: attachments.map((a) => ({
                key: a.key,
                title: a.title || field(a, "title") || "Attachment",
                kind: this.kindOf(a),
                linked:
                    (a.raw?.data as { linkMode?: string } | undefined)
                        ?.linkMode === "linked_file",
                md5:
                    (a.raw?.data as { md5?: string } | undefined)?.md5 ||
                    undefined,
            })),
            primaryKey: primary?.key ?? null,
            annotations,
        };
    }

    /** One line about an item: its main creators (full names), year and title, for the note strip. */
    async itemBanner(
        libraryID: number,
        key: string,
    ): Promise<{
        authors: string;
        authorList: string[];
        year: string;
        title: string;
    } | null> {
        const item = await db.items.get([libraryID, key]);
        if (!item) return null;
        const names = mainCreators(creatorsOf(item))
            .map(fullName)
            .filter(Boolean);
        return {
            authors: names.join(", "),
            authorList: names,
            year: extractYear(field(item, "date")),
            title: item.title || field(item, "title") || "",
        };
    }

    /** Every annotation of every item in a collection, with the items. */
    async collectionAnnotations(
        scope: EvoScope,
    ): Promise<EvoCollectionAnnotations> {
        const items = await this.topLevelItems(scope);
        const { attachmentsByParent } = await this.children(
            scope.libraryID,
            items,
        );
        const name = scope.trash
            ? "Trash"
            : scope.collectionKey === null
              ? "Library"
              : ((
                    await db.collections.get([
                        scope.libraryID,
                        scope.collectionKey,
                    ])
                )?.name ?? "Collection");
        const outItems: EvoAnnotatedItem[] = [];
        const annotations: EvoCollectionAnnotation[] = [];
        for (const item of items) {
            const attachments =
                item.itemType === "attachment"
                    ? [item]
                    : (attachmentsByParent.get(item.key) ?? []);
            let any = false;
            for (const attachment of attachments) {
                const list = await getAnnotationJson(
                    attachment,
                    this.settings.zoteroapikey,
                );
                for (const a of list) {
                    if (!a.text && !a.comment) continue;
                    any = true;
                    annotations.push({
                        id: a.id,
                        libraryID: scope.libraryID,
                        itemKey: item.key,
                        attachmentKey: attachment.key,
                        type: a.type,
                        text: a.text ?? undefined,
                        comment: a.comment,
                        color: a.color,
                        pageLabel: a.pageLabel,
                        sortIndex: a.sortIndex,
                        tags: (a.tags ?? []).map((t) => t.name),
                        dateAdded: a.dateAdded,
                    });
                }
            }
            if (!any) continue;
            const creators = creatorsOf(item);
            outItems.push({
                key: item.key,
                title: item.title || field(item, "title") || "Untitled",
                shortTitle: field(item, "shortTitle"),
                creator: creatorSummary(creators),
                year: extractYear(field(item, "date")),
                dateAdded: item.dateAdded || "",
            });
        }
        return { name, items: outItems, annotations };
    }
}
