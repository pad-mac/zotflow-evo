/**
 * ZotFlow Evo: the item picker's "Open" group — the attachments in Zotero
 * reader tabs (the one in front first), then the works recently viewed
 * without them; the collections' names from the worker's paths.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    open: [] as { libraryID: number; key: string }[],
    cited: [] as unknown[],
    recent: [] as unknown[],
    asked: [] as unknown[],
    citedFails: false,
}));

vi.mock("services/services", () => ({
    services: {
        app: {},
        logService: { error: () => {} },
        libraryCache: { hasNotesAccess: () => true },
    },
}));
vi.mock("bridge", () => ({
    workerBridge: {
        dbHelper: {
            getCitedItems: (refs: unknown) => {
                state.asked.push(refs);
                return state.citedFails ? Promise.reject(new Error("worker gone")) : Promise.resolve(state.cited);
            },
            getItemPaths: () => Promise.resolve({}),
        },
        displayTitle: { getTitles: () => Promise.resolve({}) },
        search: {
            getRecentItems: () => Promise.resolve(state.recent),
            getRecentlyAddedItems: () => Promise.resolve([]),
            searchItems: () => Promise.resolve(state.recent),
        },
    },
}));
vi.mock("ui/modals/open-readers", async (orig) => ({
    ...(await orig<typeof import("ui/modals/open-readers")>()),
    openReaderRefs: () => state.open,
}));

import { ZoteroItemSuggest } from "ui/modals/zotero-item-suggest";
import { ZOTERO_READER_VIEW_TYPE } from "ui/reader/view-type";

const item = (key: string) => ({ libraryID: 1, key, itemType: "book", title: key, searchCreators: [], raw: { data: {} } });
const labels = (s: ZoteroItemSuggest, rows: unknown[]) =>
    rows.map((r) => (s as unknown as { groupLabels: WeakMap<object, string> }).groupLabels.get(r as object) ?? "");

beforeEach(() => {
    state.open = [];
    state.cited = [];
    state.recent = [];
    state.asked = [];
    state.citedFails = false;
});

describe("the open readers, the one in front first", () => {
    const leaf = (key: string, shown: boolean, activeTime: number) => ({
        activeTime,
        view: { containerEl: { isShown: () => shown } },
        getViewState: () => ({ type: ZOTERO_READER_VIEW_TYPE, state: { libraryID: 1, itemKey: key } }),
    });
    it("tabs shown before tabs behind others, each by when last active; each once", async () => {
        const { openReaderRefs: realOpenReaderRefs } =
            await vi.importActual<typeof import("ui/modals/open-readers")>("ui/modals/open-readers");
        const app = {
            workspace: {
                getLeavesOfType: (type: string) =>
                    type === ZOTERO_READER_VIEW_TYPE
                        ? [leaf("BEHIND01", false, 900), leaf("SHOWN001", true, 100), leaf("SHOWN002", true, 500), leaf("SHOWN002", false, 50)]
                        : [],
            },
        };
        expect(realOpenReaderRefs(app as never).map((r) => r.key)).toEqual(["SHOWN002", "SHOWN001", "BEHIND01"]);
    });
});

describe("the picker's groups with nothing typed", () => {
    it("Open first, then Recently viewed without the open ones", async () => {
        state.open = [{ libraryID: 1, key: "PDF00001" }];
        state.cited = [item("HEIMS001")];
        state.recent = [item("HEIMS001"), item("HAYLES01"), item("GILL0001")];
        const s = new ZoteroItemSuggest();
        const rows = await s.getSuggestions("", 20);
        expect(state.asked).toEqual([[{ libraryID: 1, key: "PDF00001" }]]);
        expect(rows.map((r) => (r as { key: string }).key)).toEqual(["HEIMS001", "HAYLES01", "GILL0001"]);
        expect(labels(s, rows)).toEqual(["Open", "Recently viewed", ""]);
    });

    it("the open readers not to be had: the list as before", async () => {
        state.recent = [item("HAYLES01")];
        state.open = [{ libraryID: 1, key: "PDF00001" }];
        state.citedFails = true;
        const s = new ZoteroItemSuggest();
        const rows = await s.getSuggestions("", 20);
        expect(rows.map((r) => (r as { key: string }).key)).toEqual(["HAYLES01"]);
        expect(labels(s, rows)).toEqual(["Recently viewed"]);
    });

    it("nothing open: Recently viewed alone; something typed: no Open", async () => {
        state.recent = [item("HAYLES01")];
        const s = new ZoteroItemSuggest();
        expect(labels(s, await s.getSuggestions("", 20))).toEqual(["Recently viewed"]);
        state.open = [{ libraryID: 1, key: "PDF00001" }];
        state.cited = [item("HEIMS001")];
        const found = await s.getSuggestions("hay", 20);
        expect(found.map((r) => (r as { key: string }).key)).toEqual(["HAYLES01"]);
        expect(labels(s, found)).toEqual(["Best match"]);
    });
});
