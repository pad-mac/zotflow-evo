/**
 * ZotFlow Evo (fork): carries out what the PDF editing menu asked for (the
 * reader's `pdfEditRequest`). The file is rewritten here (pdf-lib, see
 * utils/evo-pdf-rewrite.ts), uploaded to Zotero's storage in place of the
 * old one (Zotero's file upload, `If-Match` the md5 this device knows), its
 * annotations moved with their pages, and the reader opened again once a
 * sync has brought the new file's md5. Extracted pages become a new PDF
 * (a standalone attachment) in the chosen collection.
 *
 * The steps, each a pass of its own: split; straighten (each page's tilt
 * measured after the split, so the halves of a spread get their own);
 * OCR (evo-ocr.ts, on the finished pages); then page numbers, outline and
 * the page filter. Before the new file is uploaded, the old one is kept as
 * a copy in Zotero's trash with how the pages moved (evo-pdf-backup.ts),
 * which "Revert" puts back, moving the annotations back too.
 *
 * Only PDFs stored in Zotero (not linked files) in libraries ZotFlow may
 * write to and whose files are in Zotero's storage (not WebDAV).
 */
import { workerBridge } from "bridge";
import { services } from "services/services";
import { noteLocalEdit } from "services/evo-auto-sync";
import { PDFDocument } from "pdf-lib";

import {
    attachRefusal,
    createAttachmentWithFile,
    createStandaloneAttachment,
    uploadFileBytes,
} from "ui/evo-library/attach-file";
import { measureSkew } from "ui/reader/evo-pdf-measure";
import { startSync } from "ui/start-sync";
import { OcrCancelled, recognizePages } from "ui/reader/evo-ocr";
import { isOcrLanguageCode } from "ui/reader/evo-ocr-languages";
import { BACKUP_TAG, backupNote } from "utils/evo-pdf-backup";
import { invertPlans, plansMove } from "utils/evo-pdf-geometry";
import { readPageLabels } from "utils/evo-pdf-labels";
import { extractPages, ocrCandidates, rewritePdf } from "utils/evo-pdf-rewrite";
import { openAttachment } from "utils/viewer";

import type { App } from "obsidian";
import type { AttachmentData } from "types/zotero-item";
import type { IDBZoteroItem } from "types/db-schema";
import type { PdfEditRequest } from "types/zotero-reader";
import type { PagePlan } from "utils/evo-pdf-geometry";

/** How long to wait for the sync that brings the new file's md5. */
const SYNC_WAIT_MS = 90_000;

export interface PdfEditHost {
    app: App;
    attachment: IDBZoteroItem<AttachmentData>;
    /** Open the attachment again (its new file). */
    reload: () => Promise<void>;
}

/** Attachments being edited now (one edit at a time each). */
const busy = new Set<string>();

function refusalFor(item: IDBZoteroItem<AttachmentData>): string | null {
    const data = item.raw.data;
    if (data.contentType !== "application/pdf")
        return "Only PDFs can be edited.";
    if (data.linkMode !== "imported_file" && data.linkMode !== "imported_url")
        return "Only PDFs stored in Zotero can be edited here (this is a linked file).";
    return attachRefusal(item.libraryID);
}

function pageRangeText(indexes: number[]): string {
    const sorted = [...new Set(indexes)].sort((a, b) => a - b);
    const parts: string[] = [];
    for (let i = 0; i < sorted.length; i++) {
        let j = i;
        while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
        parts.push(
            j > i
                ? `${sorted[i]! + 1}-${sorted[j]! + 1}`
                : String(sorted[i]! + 1),
        );
        i = j;
    }
    return parts.join(", ");
}

/** Wait until this device's copy of the item has `md5` (a sync brought it). */
async function waitForMd5(
    libraryID: number,
    key: string,
    md5: string,
): Promise<boolean> {
    const started = Date.now();
    void startSync(libraryID, true).catch(() => {});
    let nextSync = Date.now() + 15_000;
    while (Date.now() - started < SYNC_WAIT_MS) {
        const item = await workerBridge.dbHelper.getAttachmentItem(
            libraryID,
            key,
        );
        if (item?.raw.data.md5 === md5) return true;
        if (Date.now() > nextSync) {
            void startSync(libraryID, true).catch(() => {});
            nextSync = Date.now() + 15_000;
        }
        await new Promise((r) => window.setTimeout(r, 1000));
    }
    return false;
}

/** Wait until a newly created item has synced to this device. */
async function waitForItem(libraryID: number, key: string): Promise<boolean> {
    const started = Date.now();
    void startSync(libraryID, true).catch(() => {});
    let nextSync = Date.now() + 15_000;
    while (Date.now() - started < SYNC_WAIT_MS) {
        const item = await workerBridge.dbHelper.getAttachmentItem(
            libraryID,
            key,
        );
        if (item?.raw.data.md5) return true;
        if (Date.now() > nextSync) {
            void startSync(libraryID, true).catch(() => {});
            nextSync = Date.now() + 15_000;
        }
        await new Promise((r) => window.setTimeout(r, 1000));
    }
    return false;
}

/** Where an original page (0-based) went after the plans of a split: its pages now. */
function pagesAfter(plans: readonly PagePlan[], index: number): number[] {
    const plan = plans[index];
    if (!plan) return [];
    return plan.split ? [plan.newIndex, plan.newIndex + 1] : [plan.newIndex];
}

/** The labels of a PDF's pages. */
async function labelsOf(bytes: Uint8Array): Promise<string[]> {
    return readPageLabels(
        await PDFDocument.load(bytes, { updateMetadata: false }),
    );
}

/** Put a file in place of the attachment's: upload, this device's copy. */
async function replaceFile(
    item: IDBZoteroItem<AttachmentData>,
    bytes: Uint8Array,
): Promise<string> {
    const filename = item.raw.data.filename || "document.pdf";
    const md5 = await uploadFileBytes(
        { libraryID: item.libraryID, key: item.key },
        bytes,
        filename,
        item.raw.data.md5 || null,
    );
    const buffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    await workerBridge.attachment.putEditedFile(
        item.libraryID,
        item.key,
        buffer,
        md5,
        filename,
    );
    return md5;
}

/** After the file was replaced: open it again once this device has it. */
async function reopen(
    host: PdfEditHost,
    md5: string,
    done: string,
): Promise<void> {
    const notify = services.notificationService;
    const item = host.attachment;
    notify.notify("info", `PDF uploaded (${done}); opening it again after the sync…`);
    if (await waitForMd5(item.libraryID, item.key, md5)) {
        await host.reload();
        notify.notify("success", `${done[0]!.toUpperCase()}${done.slice(1)}.`);
    } else {
        notify.notify(
            "warning",
            "The PDF was changed and uploaded, but this device has not synced it yet. Close and open it again after the next sync.",
        );
    }
}

/** Revert to a copy kept before an edit (and before every edit after it). */
async function revert(host: PdfEditHost, backupKey: string): Promise<void> {
    const item = host.attachment;
    const notify = services.notificationService;
    const backups = await workerBridge.evoLibrary.pdfBackups(
        item.libraryID,
        item.key,
    );
    const at = backups.findIndex((b) => b.key === backupKey);
    const chosen = backups[at];
    if (!chosen) throw new Error("That copy is no longer in the trash.");
    if (!chosen.synced)
        throw new Error("That copy has not synced to this device yet; try again after a sync.");
    const copy = await workerBridge.dbHelper.getAttachmentItem(
        item.libraryID,
        chosen.key,
    );
    if (!copy) throw new Error("That copy is not on this device.");
    notify.notify("info", "Reverting the PDF…");
    const { blob } = await workerBridge.downloadAttachment(copy);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    // Every edit from the newest back to the chosen one, undone in turn.
    const undone = backups.slice(0, at + 1);
    const stages = undone.flatMap((b) =>
        [...b.stages].reverse().map((plans) => invertPlans(plans)),
    );
    const md5 = await replaceFile(item, bytes);
    const r = await workerBridge.evoLibrary.remapAnnotations(
        item.libraryID,
        item.key,
        stages,
        await labelsOf(bytes),
    );
    // The copies used up: the file is as it was before them.
    await workerBridge.evoLibrary.deleteForever(
        item.libraryID,
        undone.map((b) => b.key),
    );
    noteLocalEdit(item.libraryID);
    const when = new Date(chosen.at).toLocaleString();
    await reopen(
        host,
        md5,
        `reverted to the PDF of ${when}${r.changed ? `, ${r.changed} annotations moved back` : ""}`,
    );
}

export async function runPdfEdit(
    host: PdfEditHost,
    request: PdfEditRequest,
): Promise<void> {
    const notify = services.notificationService;
    const item = host.attachment;
    const id = `${item.libraryID}:${item.key}`;
    const refused = refusalFor(item);
    if (refused) {
        notify.notify("error", `Couldn't edit the PDF. ${refused}`);
        return;
    }
    if (busy.has(id)) {
        notify.notify("warning", "This PDF is being edited already.");
        return;
    }
    busy.add(id);
    try {
        if (request.revert) {
            await revert(host, request.revert);
            return;
        }
        notify.notify("info", "Editing the PDF…");
        const { blob } = await workerBridge.downloadAttachment(item);
        const original = new Uint8Array(await blob.arrayBuffer());
        const filter = request.pageFilter;
        let bytes: Uint8Array = original;
        const stages: PagePlan[][] = [];
        const done: string[] = [];
        let splitPlans: PagePlan[] | null = null;

        // 1. Split.
        if (request.split) {
            const r = await rewritePdf(bytes, { split: request.split });
            bytes = r.bytes;
            splitPlans = r.plans;
            stages.push(r.plans);
            done.push(...r.done);
        }

        // 2. Straighten, measured on the pages as they are now.
        if (request.straighten) {
            const given =
                typeof request.straighten === "object" && !splitPlans
                    ? request.straighten
                    : null;
            const angles = given ?? (await measureSkew(bytes));
            if (Object.keys(angles).length) {
                const r = await rewritePdf(bytes, { straighten: angles });
                bytes = r.bytes;
                stages.push(r.plans);
                done.push(...r.done);
            } else {
                done.push("no page tilted enough to straighten");
            }
        }

        // 3. OCR, on the finished pages.
        if (request.ocr) {
            const languages = request.ocr.languages.filter(isOcrLanguageCode);
            if (languages.length) {
                services.settings.evoOcrLanguages = languages;
                void services.saveSettings().catch(() => undefined);
            }
            const { pages, withText } = await ocrCandidates(bytes);
            if (!pages.length) {
                notify.notify(
                    "warning",
                    "Every page already has text; there was nothing to recognize.",
                );
            } else {
                const controller = new AbortController();
                const status = (n: number) =>
                    `Recognizing text: ${n} of ${pages.length} ${pages.length === 1 ? "page" : "pages"}…`;
                const progress = notify.progress(status(0), () =>
                    controller.abort(),
                );
                try {
                    const { texts, failed } = await recognizePages(
                        bytes,
                        pages,
                        languages,
                        {
                            signal: controller.signal,
                            onProgress: (p) => progress.update(status(p.done)),
                        },
                    );
                    const r = await rewritePdf(bytes, { ocr: texts });
                    bytes = r.bytes;
                    done.push(...r.done);
                    if (withText.length)
                        done.push(
                            `left ${withText.length} ${withText.length === 1 ? "page" : "pages"} that had text`,
                        );
                    if (failed.length)
                        done.push(
                            `could not read ${failed.length} ${failed.length === 1 ? "page" : "pages"}`,
                        );
                } finally {
                    progress.close();
                }
            }
        }

        // 4. Page numbers, outline, page filter (on the pages as they are
        // now: what was given for the pages before a split is moved).
        const toNow = (index: number) =>
            splitPlans ? (pagesAfter(splitPlans, index)[0] ?? -1) : index;
        const pageLabels = request.pageLabels?.map((r) => ({
            ...r,
            start: toNow(r.start),
        }));
        const outline = request.outline?.map((e) => ({
            ...e,
            page: toNow(e.page),
        }));
        const last =
            !!pageLabels ||
            !!outline ||
            !!request.removeOutline ||
            !!request.saveFilter ||
            (bytes !== original && !!filter);
        if (last) {
            const r = await rewritePdf(bytes, {
                pageLabels,
                outline,
                removeOutline: request.removeOutline,
                pageFilter: filter,
            });
            bytes = r.bytes;
            done.push(...r.done);
        }

        // Extracted pages: a new PDF, from the finished pages.
        let extractedKey: string | null = null;
        if (request.extract?.pages.length) {
            const range = pageRangeText(request.extract.pages);
            const stem = (item.raw.data.filename || "document.pdf").replace(
                /\.pdf$/i,
                "",
            );
            const filename = `${stem}_pp${range.replace(/, /g, "_")}.pdf`;
            const title = `${item.raw.data.title || stem} (pp. ${range})`;
            const indexes = splitPlans
                ? request.extract.pages.flatMap((i) =>
                      pagesAfter(splitPlans, i),
                  )
                : request.extract.pages;
            const extracted = await extractPages(bytes, indexes, {
                title,
                pageFilter: filter,
            });
            extractedKey = await createStandaloneAttachment(
                item.libraryID,
                request.extract.collectionKey,
                extracted,
                filename,
                title,
            );
            notify.notify(
                "success",
                `Extracted pages ${range} into “${filename}”.`,
            );
        }

        // The file itself: the old one kept in the trash first (not when
        // only the page filter was written into it).
        if (bytes !== original) {
            const onlyFilter =
                !stages.length &&
                !request.ocr &&
                !pageLabels &&
                !outline &&
                !request.removeOutline;
            if (!onlyFilter) {
                const info = {
                    of: item.key,
                    at: new Date().toISOString(),
                    done,
                    stages,
                };
                const name = item.raw.data.filename || "document.pdf";
                await createAttachmentWithFile(
                    item.libraryID,
                    {
                        parentItem: item.parentItem || null,
                        title: `${item.raw.data.title || name} (before edit, ${new Date().toLocaleString()})`,
                        filename: name,
                        note: backupNote(info),
                        tags: [BACKUP_TAG],
                        deleted: true,
                    },
                    original,
                );
            }
            const md5 = await replaceFile(item, bytes);
            // The annotations go with their pages, and get the new labels.
            const moves = stages.some((plans) => plansMove(plans));
            const relabel = !!pageLabels || !!request.split;
            if (moves || relabel) {
                const r = await workerBridge.evoLibrary.remapAnnotations(
                    item.libraryID,
                    item.key,
                    stages,
                    relabel ? await labelsOf(bytes) : null,
                );
                if (r.changed) noteLocalEdit(item.libraryID);
            }
            await reopen(
                host,
                md5,
                `edited the PDF: ${done.length ? done.join(", ") : "saved the page filter in it"}`,
            );
        }

        if (extractedKey && request.extract?.open) {
            if (await waitForItem(item.libraryID, extractedKey))
                await openAttachment(item.libraryID, extractedKey, host.app);
            else
                notify.notify(
                    "warning",
                    "The new PDF is in Zotero; it opens here after the next sync.",
                );
        }
    } catch (e) {
        if (e instanceof OcrCancelled) {
            notify.notify("info", "OCR cancelled; the PDF was left as it was.");
            return;
        }
        services.logService.error("PDF editing failed", "PdfEdit", e);
        notify.notify(
            "error",
            `Couldn't edit the PDF. ${e instanceof Error ? e.message : ""}`,
        );
    } finally {
        busy.delete(id);
    }
}
