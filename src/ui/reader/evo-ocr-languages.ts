/**
 * ZotFlow Evo (fork): the languages OCR can read (evo-ocr.ts). English,
 * German and French are in the plugin; others are downloaded from the
 * settings (Tesseract.js's "best int" models, from jsDelivr) into the
 * plugin's folder, `ocr/<code>.traineddata.gz`.
 */
import { normalizePath, requestUrl } from "obsidian";

import { services } from "services/services";

/** The languages in the plugin itself. */
export const BUNDLED_OCR_LANGUAGES = ["eng", "deu", "fra"];

/** Names of Tesseract's language codes (the common ones; others show their code). */
export const OCR_LANGUAGE_NAMES: Record<string, string> = {
    eng: "English",
    deu: "German",
    fra: "French",
    ita: "Italian",
    spa: "Spanish",
    por: "Portuguese",
    nld: "Dutch",
    lat: "Latin",
    grc: "Ancient Greek",
    ell: "Greek",
    rus: "Russian",
    pol: "Polish",
    ces: "Czech",
    dan: "Danish",
    swe: "Swedish",
    nor: "Norwegian",
    fin: "Finnish",
    hun: "Hungarian",
    tur: "Turkish",
    ukr: "Ukrainian",
    heb: "Hebrew",
    ara: "Arabic",
    chi_sim: "Chinese (simplified)",
    chi_tra: "Chinese (traditional)",
    jpn: "Japanese",
    kor: "Korean",
    frk: "Fraktur",
};

/** Where downloaded models go. */
const MODEL_SOURCE = (code: string) =>
    `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${code}@1.0.0/4.0.0_best_int/${code}.traineddata.gz`;

export const isOcrLanguageCode = (code: string) =>
    /^[a-z]{3}(_[a-z]{3,4})?$/.test(code);

export function ocrFolder(): string {
    const plugin = services.plugin;
    return normalizePath(
        `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}/ocr`,
    );
}

/** The languages that can be used here: the bundled ones and those downloaded. */
export async function installedOcrLanguages(): Promise<string[]> {
    const extra: string[] = [];
    const adapter = services.app.vault.adapter;
    try {
        if (await adapter.exists(ocrFolder())) {
            const { files } = await adapter.list(ocrFolder());
            for (const file of files) {
                const m = /([a-z_]+)\.traineddata\.gz$/.exec(file);
                if (m && !BUNDLED_OCR_LANGUAGES.includes(m[1]!))
                    extra.push(m[1]!);
            }
        }
    } catch (e) {
        services.logService.warn(
            "Could not list the OCR languages",
            "EvoOcr",
            e,
        );
    }
    return [...BUNDLED_OCR_LANGUAGES, ...extra.sort()];
}

/** Download a language's model (Tesseract's "best int" models, as Tesseract.js uses). */
export async function installOcrLanguage(code: string): Promise<void> {
    if (!isOcrLanguageCode(code))
        throw new Error(`“${code}” is no Tesseract language code.`);
    if (BUNDLED_OCR_LANGUAGES.includes(code)) return;
    const response = await requestUrl({
        url: MODEL_SOURCE(code),
        throw: false,
    });
    if (response.status === 404)
        throw new Error(`Tesseract has no language “${code}”.`);
    if (response.status >= 300)
        throw new Error(`The download failed (${response.status}).`);
    const bytes = new Uint8Array(response.arrayBuffer);
    if (bytes.length < 50_000 || bytes[0] !== 0x1f || bytes[1] !== 0x8b)
        throw new Error("The download is not a Tesseract model.");
    const adapter = services.app.vault.adapter;
    if (!(await adapter.exists(ocrFolder()))) await adapter.mkdir(ocrFolder());
    await adapter.writeBinary(
        `${ocrFolder()}/${code}.traineddata.gz`,
        response.arrayBuffer,
    );
}

export async function removeOcrLanguage(code: string): Promise<void> {
    if (BUNDLED_OCR_LANGUAGES.includes(code) || !isOcrLanguageCode(code))
        return;
    const path = `${ocrFolder()}/${code}.traineddata.gz`;
    const adapter = services.app.vault.adapter;
    if (await adapter.exists(path)) await adapter.remove(path);
}
