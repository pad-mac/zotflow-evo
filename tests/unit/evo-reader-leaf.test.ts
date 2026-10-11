/**
 * ZotFlow Evo: `utils/evo-reader-leaf.ts` — which pane a new reader tab joins.
 *
 * Only the rule is tested here (`pickReaderPane`); reading the panes out of
 * Obsidian's workspace needs the app and is checked by hand.
 */
import { describe, expect, it, vi } from "vitest";

import { MIN_READER_PANE_WIDTH, pickReaderPane } from "utils/evo-reader-leaf";

vi.mock("services/services", () => ({ services: {} }));

const pane = (name: string, width: number, lastActive: number) => ({
    pane: name,
    width,
    lastActive,
});

describe("pickReaderPane", () => {
    it("stays in the current pane when it is wide enough", () => {
        const current = pane("current", MIN_READER_PANE_WIDTH, 5);
        expect(pickReaderPane(current, [current, pane("wide", 1200, 9)])).toBe("current");
    });

    it("moves from a narrow pane to the most recently used wide one", () => {
        const current = pane("narrow", 320, 9);
        const others = [
            current,
            pane("old-wide", 900, 2),
            pane("recent-wide", 700, 6),
            pane("recent-narrow", 499, 8),
        ];
        expect(pickReaderPane(current, others)).toBe("recent-wide");
    });

    it("stays in the narrow pane when no pane is wide enough", () => {
        const current = pane("narrow", 300, 1);
        expect(pickReaderPane(current, [current, pane("also-narrow", 450, 9)])).toBe("narrow");
    });

    it("has no answer without a current pane", () => {
        expect(pickReaderPane(null, [pane("wide", 900, 1)])).toBeNull();
    });

    it("takes the width limit it is given", () => {
        const current = pane("current", 600, 1);
        expect(pickReaderPane(current, [current, pane("wide", 900, 0)], 800)).toBe("wide");
    });
});
