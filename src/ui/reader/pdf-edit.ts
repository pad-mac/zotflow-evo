/**
 * ZotFlow Evo (fork): carries out what the PDF editing menu asked for (the
 * reader's `pdfEditRequest`). The file is rewritten here (pdf-lib, see
 * utils/evo-pdf-rewrite.ts), uploaded to Zotero's storage in place of the
 * old one (Zotero's file upload, `If-Match` the md5 this device knows), its
 * annotations moved with their pages, and the reader opened again once a
 * sync has brought the new file's md5. Extracted pages become a new PDF
 * (a standalone attachment) in the chosen collection. OCR comes first
 * (evo-ocr.ts), so the extracted pages have the recognized text too.
 *
 * Only PDFs stored in Zotero (not linked files) in libraries ZotFlow may
 * write to and whose files are in Zotero's storage (not WebDAV).
 */
import { workerBridge } from "bridge";
import { services } from "services/services";
import { noteLocalEdit } from "services/evo-auto-sync";
import {
    attachRefusal,
    createStandaloneAttachment,
    uploadFileBytes,
} from "ui/evo-library/attach-file";
import { startSync } from "ui/start-sync";
import { OcrCancelled, recognizePages } from "ui/reader/evo-ocr";
import { isOcrLanguageCode } from "ui/reader/evo-ocr-languages";
import { extractPages, ocrCandidates, rewritePdf } from "utils/evo-pdf-rewrite";
import { openAttachment } from "utils/viewer";

import type { App } from "obsidian";
import type { AttachmentData } from "types/zotero-item";
import type { IDBZoteroItem } from "types/db-schema";
import type { PdfEditRequest } from "types/zotero-reader";

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
        notify.notify("info", "Editing the PDF…");
        const { blob } = await workerBridge.downloadAttachment(item);
        const original = new Uint8Array(await blob.arrayBuffer());
        const filter = request.pageFilter;

        // OCR: the pages without drawn text, before anything else.
        let source: Uint8Array = original;
        const doneFirst: string[] = [];
        if (request.ocr) {
            const languages = request.ocr.languages.filter(isOcrLanguageCode);
            if (languages.length) {
                services.settings.evoOcrLanguages = languages;
                void services.saveSettings().catch(() => undefined);
            }
            const { pages, withText } = await ocrCandidates(original);
            if (!pages.length) {
                notify.notify(
                    "warning",
                    "Every page already has text; there was nothing to recognize.",
                );
            } else {
                const controller = new AbortController();
                const status = (done: number) =>
                    `Recognizing text: ${done} of ${pages.length} ${pages.length === 1 ? "page" : "pages"}…`;
                const progress = notify.progress(status(0), () =>
                    controller.abort(),
                );
                try {
                    const { texts, failed } = await recognizePages(
                        original,
                        pages,
                        languages,
                        {
                            signal: controller.signal,
                            onProgress: (p) => progress.update(status(p.done)),
                        },
                    );
                    const result = await rewritePdf(original, { ocr: texts });
                    source = result.bytes;
                    doneFirst.push(...result.done);
                    if (withText.length)
                        doneFirst.push(
                            `left ${withText.length} ${withText.length === 1 ? "page" : "pages"} that had text`,
                        );
                    if (failed.length)
                        doneFirst.push(
                            `could not read ${failed.length} ${failed.length === 1 ? "page" : "pages"}`,
                        );
                } finally {
                    progress.close();
                }
            }
        }

        // Extracted pages: a new PDF, taken from the file as it was.
        let extractedKey: string | null = null;
        if (request.extract?.pages.length) {
            const range = pageRangeText(request.extract.pages);
            const stem = (item.raw.data.filename || "document.pdf").replace(
                /\.pdf$/i,
                "",
            );
            const filename = `${stem}_pp${range.replace(/, /g, "_")}.pdf`;
            const title = `${item.raw.data.title || stem} (pp. ${range})`;
            const bytes = await extractPages(source, request.extract.pages, {
                title,
                pageFilter: filter,
            });
            extractedKey = await createStandaloneAttachment(
                item.libraryID,
                request.extract.collectionKey,
                bytes,
                filename,
                title,
            );
            notify.notify(
                "success",
                `Extracted pages ${range} into “${filename}”.`,
            );
        }

        // The file itself.
        const rewrite =
            source !== original ||
            !!request.split ||
            !!request.removeOutline ||
            Object.keys(request.straighten ?? {}).length > 0 ||
            !!request.saveFilter;
        if (rewrite) {
            const result = await rewritePdf(source, {
                split: request.split,
                straighten: request.straighten,
                removeOutline: request.removeOutline,
                pageFilter: filter,
            });
            const filename = item.raw.data.filename || "document.pdf";
            const md5 = await uploadFileBytes(
                { libraryID: item.libraryID, key: item.key },
                result.bytes,
                filename,
                item.raw.data.md5 || null,
            );
            const buffer = result.bytes.buffer.slice(
                result.bytes.byteOffset,
                result.bytes.byteOffset + result.bytes.byteLength,
            ) as ArrayBuffer;
            await workerBridge.attachment.putEditedFile(
                item.libraryID,
                item.key,
                buffer,
                md5,
                filename,
            );
            // The annotations go with their pages.
            const moved = result.plans.some((p) => p.turn || p.split);
            if (moved) {
                const r = await workerBridge.evoLibrary.remapAnnotations(
                    item.libraryID,
                    item.key,
                    result.plans,
                    !!request.split,
                );
                if (r.changed) noteLocalEdit(item.libraryID);
            }
            const done = [...doneFirst, ...result.done];
            const what = done.length
                ? done.join(", ")
                : "saved the page filter in it";
            notify.notify(
                "info",
                `PDF uploaded (${what}); opening it again after the sync…`,
            );
            if (await waitForMd5(item.libraryID, item.key, md5)) {
                await host.reload();
                notify.notify("success", `Edited the PDF: ${what}.`);
            } else {
                notify.notify(
                    "warning",
                    "The PDF was edited and uploaded, but this device has not synced it yet. Close and open it again after the next sync.",
                );
            }
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
