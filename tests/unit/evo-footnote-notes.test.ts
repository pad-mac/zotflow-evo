/**
 * ZotFlow Evo: citation footnotes rendered with the Chicago notes style that
 * comes with the plugin — a work in full in its first note, short after;
 * several works in one note; pages. The CSL core with the bundled styles
 * seeded into an in-memory cache (no network).
 */
import { describe, expect, it, vi } from "vitest";

import { mainTitle } from "utils/evo-footnotes";
import { BUNDLED_STYLES } from "worker/csl/assets/bundled-styles";
import { CslRenderService, MemoryKVStore } from "worker/csl";

import type { CSLItem, ResourceFetcher } from "worker/csl";

vi.setConfig({ testTimeout: 30_000 });

const offline: ResourceFetcher = {
    fetchText: (url: string) => Promise.reject(new Error(`offline: ${url}`)),
};

const heims: CSLItem = {
    id: "1/HEIMS001",
    type: "book",
    title: "The Cybernetics Group",
    author: [{ family: "Heims", given: "Steve J." }],
    publisher: "MIT Press",
    "publisher-place": "Cambridge, MA",
    issued: { "date-parts": [[1991]] },
};
const hayles: CSLItem = {
    id: "1/HAYLES01",
    type: "book",
    title: "How We Became Posthuman: Virtual Bodies in Cybernetics, Literature, and Informatics",
    // As ZotFlow passes it when Zotero's Short Title is empty (mainTitle).
    "title-short": "How We Became Posthuman",
    author: [{ family: "Hayles", given: "N. Katherine" }],
    publisher: "University of Chicago Press",
    "publisher-place": "Chicago",
    issued: { "date-parts": [[1999]] },
};

describe("citation footnotes in Chicago notes and bibliography", () => {
    it("full the first time, short after; several works in one note; pages", async () => {
        const service = new CslRenderService({ fetcher: offline, store: new MemoryKVStore() });
        for (const [id, xml] of Object.entries(BUNDLED_STYLES))
            expect(await service.seedStyle(id, xml)).toBe(true);
        // Seeded once only.
        expect(await service.seedStyle("chicago-notes-bibliography", "x")).toBe(false);
        const notes = await service.renderNotes(
            [heims, hayles],
            [
                { noteIndex: 1, items: [{ id: heims.id, locator: "23", label: "page" }] },
                { noteIndex: 2, items: [{ id: hayles.id }] },
                {
                    noteIndex: 3,
                    items: [
                        { id: heims.id, locator: "45", label: "page" },
                        { id: hayles.id, locator: "7", label: "page" },
                    ],
                },
            ],
            { styleId: "chicago-notes-bibliography", format: "text" },
        );
        // First: in full, with the page.
        expect(notes[0]).toBe("Steve J. Heims, The Cybernetics Group (MIT Press, 1991), 23.");
        expect(notes[1]).toContain("N. Katherine Hayles, How We Became Posthuman");
        // After: short (author's surname, short title, page).
        expect(notes[2]).toBe("Heims, The Cybernetics Group, 45; Hayles, How We Became Posthuman, 7.");
    });

    it("a short title when Zotero has none: the main title, before its subtitle", () => {
        expect(mainTitle(hayles.title as string)).toBe("How We Became Posthuman");
        expect(mainTitle("Was ist Aufklärung? Thesen und Definitionen")).toBe("Was ist Aufklärung?");
        expect(mainTitle("The Cybernetics Group")).toBeNull();
        expect(mainTitle("Ratio 1:2 in Practice")).toBeNull();
    });

    it("Chicago author-date, the default style, comes with the plugin too", async () => {
        const service = new CslRenderService({ fetcher: offline, store: new MemoryKVStore() });
        await service.seedStyle("chicago-author-date", BUNDLED_STYLES["chicago-author-date"]!);
        expect((await service.ensureStyle("chicago-author-date")).status).toBe("ready");
        expect(
            await service.renderCitation([heims], { styleId: "chicago-author-date", format: "text" }),
        ).toBe("(Heims 1991)");
    });
});
