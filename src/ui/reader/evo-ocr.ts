/**
 * ZotFlow Evo (fork): recognizing the text of PDF pages (OCR) for the
 * editing menu. Tesseract.js 7 — its worker, its WebAssembly core and the
 * English, German and French models are in the plugin itself
 * (`virtual:ocr-resources`, esbuild.config.mjs); more languages are
 * downloaded from the settings into the plugin's folder (`ocr/`). Pages
 * are drawn with Obsidian's own pdf.js at 300 dpi, in grey, and handed to
 * a few Tesseract workers; each page comes back as Tesseract's text-only
 * PDF page, which `rewritePdf` lays over the page (evo-pdf-ocr-layer.ts).
 *
 * Tesseract.js 7 cannot take a model's bytes directly (it uses them as the
 * language's name), so each worker gets a small script in front that
 * answers its model downloads from blob URLs.
 */
import { gunzipSync } from "fflate";
import { createWorker } from "tesseract.js";
import ocrResource from "virtual:ocr-resources";

import { services } from "services/services";
import { openPdf } from "ui/reader/evo-pdf-render";
import type { OpenedPdf } from "ui/reader/evo-pdf-render";
import { BUNDLED_OCR_LANGUAGES, ocrFolder } from "ui/reader/evo-ocr-languages";

import type { ImageLike, Worker as TesseractWorker } from "tesseract.js";
import type { OcrPageText } from "utils/evo-pdf-rewrite";

/** A URL the workers' downloads are answered for (never fetched). */
const FAKE_LANG_PATH = "https://tessdata.zotflow-evo.invalid";

/** Pages are drawn at this resolution, smaller where they would get huge. */
const DPI = 300;
const MAX_PIXELS = 30_000_000;
const MAX_SIDE = 7000;

function base64Bytes(base64: string): Uint8Array {
    const binary = atob(base64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
}

/** The blob URLs one run uses (made for it, revoked after). */
interface Assets {
    worker: string;
    core: string;
    models: Record<string, string>;
    urls: string[];
}

async function makeAssets(languages: string[]): Promise<Assets> {
    const urls: string[] = [];
    const blob = (data: Uint8Array | ArrayBuffer | string, type: string) => {
        const url = URL.createObjectURL(new Blob([data as BlobPart], { type }));
        urls.push(url);
        return url;
    };
    const embedded = (name: string) => {
        const base64 = ocrResource(name);
        if (!base64)
            throw new Error(`OCR is missing from this build (${name}).`);
        return base64Bytes(base64);
    };
    const js = "text/javascript";
    const workerScript = blob(gunzipSync(embedded("worker.min.js")), js);
    const core = blob(gunzipSync(embedded("core.wasm.js")), js);
    const models: Record<string, string> = {};
    for (const code of languages) {
        if (BUNDLED_OCR_LANGUAGES.includes(code)) {
            models[code] = blob(
                embedded(`${code}.traineddata.gz`),
                "application/gzip",
            );
        } else {
            const path = `${ocrFolder()}/${code}.traineddata.gz`;
            const adapter = services.app.vault.adapter;
            if (!(await adapter.exists(path)))
                throw new Error(
                    `The OCR language “${code}” is not installed (settings, OCR).`,
                );
            models[code] = blob(
                await adapter.readBinary(path),
                "application/gzip",
            );
        }
    }
    // The script in front of Tesseract's worker: model downloads answered from the blobs.
    const shim = [
        `const FAKE=${JSON.stringify(FAKE_LANG_PATH)};`,
        `const MODELS=${JSON.stringify(models)};`,
        "const realFetch=self.fetch.bind(self);",
        "self.fetch=(u,o)=>{const s=String(u);if(s.startsWith(FAKE)){",
        'const m=MODELS[s.slice(s.lastIndexOf("/")+1).split(".")[0]];',
        "return m?realFetch(m):Promise.resolve(new Response(null,{status:404}));}",
        "return realFetch(u,o);};",
        `importScripts(${JSON.stringify(workerScript)});`,
    ].join("\n");
    // Tesseract.js loads a core given by a path ending in "js" as it is.
    return { worker: blob(shim, js), core: core + "#core.js", models, urls };
}

/** A page drawn in grey as a PGM image (Tesseract reads it as it is). */
function toPgm(gray: Uint8Array, width: number, height: number): Uint8Array {
    const head = new TextEncoder().encode(`P5\n${width} ${height}\n255\n`);
    const pgm = new Uint8Array(head.length + gray.length);
    pgm.set(head);
    pgm.set(gray, head.length);
    return pgm;
}

export interface OcrProgress {
    done: number;
    total: number;
}

export class OcrCancelled extends Error {
    constructor() {
        super("OCR was cancelled.");
    }
}

/**
 * Recognize the text of these pages (0-based) of a PDF. Returns each page's
 * text page, and the pages that failed. `signal` stops it between pages.
 */
export async function recognizePages(
    bytes: Uint8Array,
    pages: number[],
    languages: string[],
    {
        onProgress,
        signal,
    }: { onProgress?: (p: OcrProgress) => void; signal?: AbortSignal } = {},
): Promise<{ texts: OcrPageText[]; failed: number[] }> {
    if (!pages.length) return { texts: [], failed: [] };
    const langs = languages.length ? languages : ["eng"];
    const assets = await makeAssets(langs);
    const workers: TesseractWorker[] = [];
    let pdf: OpenedPdf | null = null;
    try {
        pdf = await openPdf(bytes);
        const opened = pdf;
        const count = Math.max(
            1,
            Math.min(
                pages.length,
                Math.floor((navigator.hardwareConcurrency || 2) / 2),
                3,
            ),
        );
        for (let i = 0; i < count; i++) {
            workers.push(
                await createWorker(langs, 1, {
                    workerPath: assets.worker,
                    workerBlobURL: false,
                    corePath: assets.core,
                    langPath: FAKE_LANG_PATH,
                    cacheMethod: "none",
                    gzip: true,
                }),
            );
            if (signal?.aborted) throw new OcrCancelled();
        }
        const texts: OcrPageText[] = [];
        const failed: number[] = [];
        let next = 0;
        let done = 0;
        // Pages are drawn one at a time (the main thread), recognized in parallel.
        let drawing: Promise<unknown> = Promise.resolve();
        const run = async (worker: TesseractWorker) => {
            let dpi = 0;
            while (next < pages.length) {
                if (signal?.aborted) throw new OcrCancelled();
                const index = pages[next++]!;
                try {
                    const draw = drawing.then(() =>
                        opened.draw(index, {
                            scale: DPI / 72,
                            maxPixels: MAX_PIXELS,
                            maxSide: MAX_SIDE,
                        }),
                    );
                    drawing = draw.catch(() => undefined);
                    const image = await draw;
                    const imageDpi = Math.round(image.scale * 72);
                    if (imageDpi !== dpi) {
                        dpi = imageDpi;
                        await worker.setParameters({
                            user_defined_dpi: String(dpi),
                        });
                    }
                    const result = await worker.recognize(
                        toPgm(
                            image.gray,
                            image.width,
                            image.height,
                        ) as unknown as ImageLike,
                        { pdfTextOnly: true },
                        { text: false, blocks: false, pdf: true },
                    );
                    const out = result.data.pdf;
                    if (!out) throw new Error("Tesseract gave no page.");
                    texts.push({
                        pageIndex: index,
                        pdf:
                            out instanceof Uint8Array
                                ? out
                                : new Uint8Array(out),
                        width: image.width,
                        height: image.height,
                        toUser: image.toUser,
                    });
                } catch (e) {
                    if (e instanceof OcrCancelled) throw e;
                    services.logService.warn(
                        `OCR of page ${index + 1} failed`,
                        "EvoOcr",
                        e,
                    );
                    failed.push(index);
                }
                done++;
                onProgress?.({ done, total: pages.length });
            }
        };
        await Promise.all(workers.map(run));
        texts.sort((a, b) => a.pageIndex - b.pageIndex);
        return { texts, failed: failed.sort((a, b) => a - b) };
    } finally {
        await Promise.all(
            workers.map((w) => w.terminate().catch(() => undefined)),
        );
        pdf?.close();
        for (const url of assets.urls) URL.revokeObjectURL(url);
    }
}
