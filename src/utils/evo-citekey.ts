/**
 * ZotFlow Evo (fork): a citation key made as Better BibTeX makes its
 * default one, `auth.lower + shorttitle(3,3) + year`: the first creator's
 * last name in lowercase ASCII (German umlauts as ae/oe/ue, ß as ss), the
 * first three words of the title that are not function words, each
 * capitalised, and the year — "staeheliEntnetztEuchPraktiken2014". A key
 * another item has gets a, b, c… Pure.
 */

const SKIP_WORDS = new Set([
    // English
    "a", "an", "the", "some", "from", "on", "in", "to", "of", "do", "with",
    "and", "or", "for", "at", "by",
    // German
    "der", "die", "das", "des", "dem", "den", "ein", "eine", "einer",
    "eines", "einem", "einen", "und", "oder", "zu", "zum", "zur", "im",
    "am", "vom", "von", "mit",
    // French, Spanish, Italian
    "le", "la", "les", "l", "un", "une", "des", "du", "de", "d", "et",
    "el", "los", "las", "al", "uno", "una", "unos", "unas", "del", "y",
    "il", "lo", "gli", "i", "e",
]);

/** ASCII, German style: "Stäheli" → "Staeheli", "Groß" → "Gross". */
export function asciiFold(text: string): string {
    return text
        .replace(/Ä/g, "Ae")
        .replace(/Ö/g, "Oe")
        .replace(/Ü/g, "Ue")
        .replace(/ä/g, "ae")
        .replace(/ö/g, "oe")
        .replace(/ü/g, "ue")
        .replace(/ß/g, "ss")
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "");
}

export interface CitekeyCreator {
    creatorType?: string;
    firstName?: string;
    lastName?: string;
    name?: string;
}

/** The creator the key is named after: the first of the item's main kind, else an editor, else any. */
function firstCreator(
    creators: CitekeyCreator[],
    primaryType: string,
): CitekeyCreator | undefined {
    return (
        creators.find((c) => (c.creatorType ?? primaryType) === primaryType) ??
        creators.find((c) => c.creatorType === "editor") ??
        creators[0]
    );
}

export function makeCitationKey(item: {
    title?: string;
    date?: string;
    creators?: CitekeyCreator[];
    primaryCreatorType?: string;
}): string {
    const creator = firstCreator(
        item.creators ?? [],
        item.primaryCreatorType ?? "author",
    );
    const last = creator ? (creator.lastName ?? creator.name ?? "") : "";
    const auth = asciiFold(last)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");
    const words = asciiFold(item.title ?? "")
        .split(/[^A-Za-z0-9]+/)
        .filter((w) => w && !SKIP_WORDS.has(w.toLowerCase()))
        .slice(0, 3)
        .map((w) => w[0]!.toUpperCase() + w.slice(1));
    const year = /(?:^|\D)(\d{4})(?!\d)/.exec(item.date ?? "")?.[1] ?? "";
    return `${auth}${words.join("")}${year}`;
}

/** `key`, or with a, b, … z, aa … when another item has it. */
export function uniqueCitationKey(key: string, taken: Set<string>): string {
    if (!taken.has(key)) return key;
    for (let n = 0; ; n++) {
        let suffix = "";
        let i = n;
        do {
            suffix = String.fromCharCode(97 + (i % 26)) + suffix;
            i = Math.floor(i / 26) - 1;
        } while (i >= 0);
        if (!taken.has(key + suffix)) return key + suffix;
    }
}
