/**
 * ZotFlow Evo (fork): a PDF's outline for the item pane, read with
 * Obsidian's own pdf.js from the file as it is on this device (no download
 * for it: see `localFile()` in worker/services/attachment.ts). Kept per
 * file and md5, so moving through a table reads each PDF once. See
 * utils/evo-outline-list.ts for how it goes between the annotations.
 */
import { loadPdfJs } from "obsidian";

import { workerBridge } from "bridge";
import { services } from "services/services";

import type { OutlineHeading } from "utils/evo-outline-list";

/** What is used of pdf.js. */
interface PdfJsLib {
    getDocument(o: { data: Uint8Array }): {
        promise: Promise<PdfDoc>;
        destroy?: () => Promise<void> | void;
    };
}

interface PdfOutlineNode {
    title?: string;
    dest?: unknown;
    items?: PdfOutlineNode[];
}

interface PdfDoc {
    getOutline(): Promise<PdfOutlineNode[] | null>;
    getDestination(name: string): Promise<unknown[] | null>;
    getPageIndex(ref: unknown): Promise<number>;
    destroy(): Promise<void>;
}

/** What came of reading: the headings, or why there are none. */
export type ItemOutline =
    | { state: "ok"; headings: OutlineHeading[] }
    | { state: "none" }
    | { state: "not-here" };

const cache = new Map<string, Promise<ItemOutline>>();
/** Files kept (each is small: a list of headings). */
const CACHE_SIZE = 64;

/** Where an explicit destination points on its page: the top for /XYZ, /FitH, /FitBH. */
function destTop(dest: unknown[]): number | null {
    const mode = (dest[1] as { name?: string } | undefined)?.name;
    const value =
        mode === "XYZ" ? dest[3] : mode === "FitH" || mode === "FitBH" ? dest[2] : null;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The outline of a PDF, flattened with levels (entries pointing nowhere skipped, their children kept). */
export async function readPdfOutline(doc: PdfDoc): Promise<OutlineHeading[]> {
    const out: OutlineHeading[] = [];
    let outline: PdfOutlineNode[] | null = null;
    try {
        outline = await doc.getOutline();
    } catch {
        return out;
    }
    const place = async (
        dest: unknown,
    ): Promise<{ page: number; top: number | null } | null> => {
        try {
            const explicit =
                typeof dest === "string"
                    ? await doc.getDestination(dest)
                    : (dest as unknown[] | null);
            if (!Array.isArray(explicit)) return null;
            const ref = explicit[0];
            if (ref === null || ref === undefined) return null;
            const page = Number.isInteger(ref)
                ? (ref as number)
                : await doc.getPageIndex(ref);
            return { page, top: destTop(explicit) };
        } catch {
            return null;
        }
    };
    const walk = async (items: PdfOutlineNode[] | undefined, level: number) => {
        for (const item of items ?? []) {
            const at = await place(item.dest);
            if (at) {
                out.push({
                    title: (item.title ?? "").trim() || "Untitled",
                    level,
                    ...at,
                });
            }
            await walk(item.items, at ? level + 1 : level);
        }
    };
    await walk(outline ?? undefined, 0);
    return out;
}

async function read(libraryID: number, key: string): Promise<ItemOutline> {
    const buffer = await workerBridge.attachment.localFile(libraryID, key);
    if (!buffer) return { state: "not-here" };
    const pdfjs = (await loadPdfJs()) as PdfJsLib;
    const task = pdfjs.getDocument({ data: new Uint8Array(buffer) });
    const doc = await task.promise;
    try {
        const headings = await readPdfOutline(doc);
        return headings.length ? { state: "ok", headings } : { state: "none" };
    } finally {
        void doc.destroy();
    }
}

/** The outline of a PDF attachment as it is on this device. */
export function itemOutline(
    libraryID: number,
    key: string,
    md5: string | undefined,
): Promise<ItemOutline> {
    const id = `${libraryID}:${key}:${md5 ?? ""}`;
    let found = cache.get(id);
    if (!found) {
        found = read(libraryID, key).catch((e: unknown) => {
            services.logService.error(
                "Could not read the PDF's outline",
                "EvoLibrary",
                e,
            );
            cache.delete(id);
            const none: ItemOutline = { state: "none" };
            return none;
        });
        cache.set(id, found);
        // A file that was not here may be soon (opened, synced): ask again next time.
        void found.then((r) => {
            if (r.state === "not-here") cache.delete(id);
        });
        // The oldest go first (a Map keeps the order things were put in).
        for (const old of cache.keys()) {
            if (cache.size <= CACHE_SIZE) break;
            cache.delete(old);
        }
    }
    return found;
}
