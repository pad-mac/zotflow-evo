/**
 * ZotFlow Evo: since beta.12 the fork's settings groups sit on upstream's
 * pages (settings.ts picks them by heading). Every group must be placed:
 * one left out would vanish from the settings without an error.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("services/services", () => ({ services: {} }));
vi.mock("bridge", () => ({ workerBridge: {} }));
vi.mock("ui/evo-strip/follow", () => ({ applyStripTabMode: vi.fn() }));
vi.mock("ui/reader/chrome", () => ({ notifyReaderChromeChanged: vi.fn() }));
vi.mock("ui/editor/evo-drop", () => ({ ANNOTATION_COLORS: [{ name: "Yellow", hex: "#ffd400" }] }));
vi.mock("ui/reader/evo-ocr-languages", () => ({
    BUNDLED_OCR_LANGUAGES: [],
    OCR_LANGUAGE_NAMES: {},
    installOcrLanguage: vi.fn(),
    installedOcrLanguages: vi.fn(),
    isOcrLanguageCode: () => true,
    removeOcrLanguage: vi.fn(),
}));

import { EvoSection } from "settings/sections/evo-section";

describe("the fork's settings groups", () => {
    it("each is placed on a page", () => {
        const headings = [...new EvoSection({ settings: {} } as never).groups().keys()];
        expect(headings.length).toBeGreaterThan(8);
        const source = readFileSync(path.resolve(import.meta.dirname, "../../src/settings/settings.ts"), "utf8");
        const picked = new Set([...source.matchAll(/pick\(([^)]*)\)/g)].flatMap((m) => [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!)));
        const unplaced = headings.filter((h) => !picked.has(h) && !h.includes("dropped into a note"));
        expect(unplaced).toEqual([]);
        // And nothing picked that does not exist.
        expect([...picked].filter((h) => !headings.includes(h))).toEqual([]);
    });
});
