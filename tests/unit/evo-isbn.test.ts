/**
 * ZotFlow Evo: `utils/evo-isbn.ts` — ISBNs found on a page, and book
 * metadata from Open Library and Google Books.
 */
import { describe, expect, it } from "vitest";

import {
    findIsbns,
    fromGoogleBooks,
    fromOpenLibrary,
    isValidIsbn,
    splitName,
    toIsbn13,
    yearOfDate,
} from "utils/evo-isbn";

describe("ISBNs", () => {
    it("check digits", () => {
        expect(isValidIsbn("9783518294444")).toBe(true);
        expect(isValidIsbn("9783518294445")).toBe(false);
        expect(isValidIsbn("3518294444")).toBe(false);
        expect(isValidIsbn("0262517795")).toBe(true);
        expect(isValidIsbn("080442957X")).toBe(true);
    });

    it("ISBN-10 to ISBN-13", () => {
        expect(toIsbn13("0262517795")).toBe("9780262517799");
        expect(toIsbn13("9780262517799")).toBe("9780262517799");
    });

    it("found in a page's text: valid ones, as ISBN-13, each once, in order", () => {
        const text = `Lebendige Kräfte
            ISBN-13 978-3-518-29444-4 · ISBN-10 0262517795
            Size 4.2MB · md5 0123456789abcdef0123456789abcdef · 1234567890123
            again: 9783518294444; 0-262-51779-5`;
        expect(findIsbns(text)).toEqual(["9783518294444", "9780262517799"]);
        expect(findIsbns("no numbers here 12345")).toEqual([]);
    });
});

describe("book metadata", () => {
    it("names", () => {
        expect(splitName("Henning Schmidgen")).toEqual({
            creatorType: "author",
            firstName: "Henning",
            lastName: "Schmidgen",
        });
        expect(splitName("Schmidgen, Henning")).toEqual({
            creatorType: "author",
            firstName: "Henning",
            lastName: "Schmidgen",
        });
        expect(splitName("Plato").lastName).toBe("Plato");
    });

    it("from Open Library", () => {
        const json = {
            "ISBN:9780262517799": {
                title: "Grammophon, Film, Typewriter",
                subtitle: "A Study",
                authors: [{ name: "Friedrich A. Kittler" }],
                publishers: [{ name: "Stanford University Press" }],
                publish_places: [{ name: "Stanford" }],
                publish_date: "1999",
                number_of_pages: 315,
            },
        };
        expect(fromOpenLibrary(json, "9780262517799")).toEqual({
            title: "Grammophon, Film, Typewriter: A Study",
            creators: [
                {
                    creatorType: "author",
                    firstName: "Friedrich A.",
                    lastName: "Kittler",
                },
            ],
            date: "1999",
            publisher: "Stanford University Press",
            place: "Stanford",
            numPages: "315",
            language: "",
            ISBN: "9780262517799",
        });
        expect(fromOpenLibrary({}, "9780262517799")).toBeNull();
    });

    it("from Google Books", () => {
        const json = {
            items: [
                {
                    volumeInfo: {
                        title: "Lebendige Kräfte",
                        authors: ["Henning Schmidgen"],
                        publisher: "Merve",
                        publishedDate: "2005-03",
                        pageCount: 120,
                        language: "de",
                    },
                },
            ],
        };
        const book = fromGoogleBooks(json, "9783518294444");
        expect(book?.creators[0]?.lastName).toBe("Schmidgen");
        expect(book?.numPages).toBe("120");
        expect(book?.language).toBe("de");
        expect(fromGoogleBooks({ totalItems: 0 }, "x")).toBeNull();
        expect(yearOfDate(book!.date)).toBe("2005");
        expect(yearOfDate("March 1999")).toBe("1999");
    });
});
