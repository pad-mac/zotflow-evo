/**
 * ZotFlow Evo (fork): a book item from an ISBN found on a web page (Anna's
 * Archive): finding valid ISBNs in text, and turning Open Library's or
 * Google Books' answer into Zotero's book fields. No I/O here. See FORK.md.
 */

/** Whether a 10- or 13-digit ISBN (digits, maybe a final X) has a right check digit. */
export function isValidIsbn(isbn: string): boolean {
    if (/^\d{13}$/.test(isbn)) {
        let sum = 0;
        for (let i = 0; i < 12; i++) sum += Number(isbn[i]) * (i % 2 ? 3 : 1);
        return (10 - (sum % 10)) % 10 === Number(isbn[12]);
    }
    if (/^\d{9}[\dX]$/.test(isbn)) {
        let sum = 0;
        for (let i = 0; i < 10; i++)
            sum += (isbn[i] === "X" ? 10 : Number(isbn[i])) * (10 - i);
        return sum % 11 === 0;
    }
    return false;
}

/** The ISBN-13 of an ISBN-10 (13 digits stay as they are). */
export function toIsbn13(isbn: string): string {
    if (isbn.length === 13) return isbn;
    const body = "978" + isbn.slice(0, 9);
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(body[i]) * (i % 2 ? 3 : 1);
    return body + String((10 - (sum % 10)) % 10);
}

/**
 * The valid ISBNs in a text, as ISBN-13, in order of appearance, each once.
 * Hyphens and spaces inside are allowed.
 */
export function findIsbns(text: string): string[] {
    const out: string[] = [];
    // Whole words only: an MD5's digits can make a valid ISBN-10 too.
    const re =
        /(?<![\p{L}\p{N}_])(?:97[89][-\s]?)?\d(?:[-\s]?\d){8}[-\s]?[\dXx](?![\p{L}\p{N}_])/gu;
    for (const m of text.matchAll(re)) {
        const digits = m[0].replace(/[-\s]/g, "").toUpperCase();
        if (!isValidIsbn(digits)) continue;
        const isbn13 = toIsbn13(digits);
        if (!out.includes(isbn13)) out.push(isbn13);
    }
    return out;
}

export interface BookCreator {
    creatorType: "author" | "editor";
    firstName: string;
    lastName: string;
}

/** Zotero's book fields, as far as the lookup gives them. */
export interface BookMetadata {
    title: string;
    creators: BookCreator[];
    date: string;
    publisher: string;
    place: string;
    numPages: string;
    language: string;
    ISBN: string;
}

/** "Henning Schmidgen" or "Schmidgen, Henning" as first and last name. */
export function splitName(
    name: string,
    creatorType: BookCreator["creatorType"] = "author",
): BookCreator {
    const clean = name.replace(/\s+/g, " ").trim();
    if (clean.includes(",")) {
        const [last, first] = clean.split(",", 2).map((s) => s.trim());
        return { creatorType, firstName: first ?? "", lastName: last ?? "" };
    }
    const words = clean.split(" ");
    const lastName = words.pop() ?? "";
    return { creatorType, firstName: words.join(" "), lastName };
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Open Library's `api/books?jscmd=data` answer for one ISBN, as a book. */
export function fromOpenLibrary(
    json: unknown,
    isbn: string,
): BookMetadata | null {
    const entry = (json as Record<string, unknown> | null)?.[`ISBN:${isbn}`] as
        Record<string, unknown> | undefined;
    if (!entry || !str(entry.title)) return null;
    const names = (list: unknown) =>
        Array.isArray(list)
            ? list
                  .map((x) => str((x as { name?: unknown }).name))
                  .filter(Boolean)
            : [];
    const title = [str(entry.title), str(entry.subtitle)]
        .filter(Boolean)
        .join(": ");
    return {
        title,
        creators: names(entry.authors).map((n) => splitName(n)),
        date: str(entry.publish_date),
        publisher: names(entry.publishers)[0] ?? "",
        place: names(entry.publish_places)[0] ?? "",
        numPages:
            typeof entry.number_of_pages === "number"
                ? String(entry.number_of_pages)
                : "",
        language: "",
        ISBN: isbn,
    };
}

/** Google Books' `volumes?q=isbn:` answer, as a book. */
export function fromGoogleBooks(
    json: unknown,
    isbn: string,
): BookMetadata | null {
    const items = (json as { items?: unknown } | null)?.items;
    const info = Array.isArray(items)
        ? ((items[0] as { volumeInfo?: Record<string, unknown> } | undefined)
              ?.volumeInfo ?? null)
        : null;
    if (!info || !str(info.title)) return null;
    const title = [str(info.title), str(info.subtitle)]
        .filter(Boolean)
        .join(": ");
    return {
        title,
        creators: Array.isArray(info.authors)
            ? info.authors
                  .map((n) => splitName(str(n)))
                  .filter((c) => c.lastName)
            : [],
        date: str(info.publishedDate),
        publisher: str(info.publisher),
        place: "",
        numPages:
            typeof info.pageCount === "number" ? String(info.pageCount) : "",
        language: str(info.language),
        ISBN: isbn,
    };
}

/** The year of a date as it is written ("2005", "March 2005", "2005-03-01"). */
export function yearOfDate(date: string): string {
    return /\b(\d{4})\b/.exec(date)?.[1] ?? "";
}
