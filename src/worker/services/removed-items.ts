import type { IParentProxy } from "bridge/types";
import type { AnyIDBZoteroItem } from "types/db-schema";

/**
 * What goes with an item row removed for good (a remote deletion applied,
 * or one accepted in a conflict) besides the row itself: the rendered image
 * of an image or ink annotation, `{folder}/{key}.png`.
 *
 * File I/O, so never call this inside a Dexie transaction.
 */
export async function deleteRemovedItemFiles(
    parentHost: IParentProxy,
    annotationImageFolder: string,
    rows: AnyIDBZoteroItem[],
    context: string,
): Promise<void> {
    // ZotFlow Evo (beta.15): kept. A source note keeps a removed annotation
    // (struck through) as a lasting copy, and its image with it.
    const images = rows.filter(hasAnnotationImage).length;
    if (images)
        parentHost.log(
            "debug",
            `Kept the images of ${images} removed annotation(s) for the source notes`,
            context,
        );
    if (KEEP_REMOVED_IMAGES) return;
    const folder = annotationImageFolder.replace(/\/$/, "");
    for (const row of rows) {
        if (!hasAnnotationImage(row)) continue;
        const path = `${folder}/${row.key}.png`;
        try {
            const exists = await parentHost.checkFile(path);
            if (exists.exists) {
                await parentHost.deleteFile(path);
                parentHost.log("debug", `Deleted orphaned annotation image: ${path}`, context);
            }
        } catch (e) {
            // Best-effort: a leftover image is harmless.
            parentHost.log("warn", `Failed to delete annotation image ${row.key}`, context, e);
        }
    }
}

/** ZotFlow Evo: the source notes keep removed annotations, so their images stay. */
const KEEP_REMOVED_IMAGES = true;

function hasAnnotationImage(row: AnyIDBZoteroItem): boolean {
    return row.itemType === "annotation" && ["image", "ink"].includes(String(row.raw?.data?.annotationType));
}
