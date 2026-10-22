/**
 * ZotFlow Evo, round 10: where an item's file is on disk (for showing it
 * in the file manager), and the PDF's outline among the item pane's
 * annotations.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("services/services", () => ({ services: {} }));
vi.mock("bridge", () => ({ workerBridge: {} }));

import { attachmentPathCandidates } from "ui/evo-library/reveal-file";
import { readPdfOutline } from "ui/evo-library/item-outline";
import { interleaveOutline, placementOf } from "utils/evo-outline-list";

import type { OutlineHeading } from "utils/evo-outline-list";

const tools = { join: (...p: string[]) => p.join("/").replace(/\/+/g, "/"), home: "/home/p" };
const none = { linkedAttachmentBaseDir: "", zoteroStoragePath: "", evoZoteroDataDir: "" };

describe("an attachment's place on disk", () => {
    it("a linked file: its path; relative to the base folder with attachments:", () => {
        expect(attachmentPathCandidates({ linkMode: "linked_file", path: "/data/a.pdf" }, "K", none, tools)).toEqual(["/data/a.pdf"]);
        expect(attachmentPathCandidates({ linkMode: "linked_file", path: "attachments:x/a.pdf" }, "K", none, tools)).toEqual([]);
        expect(
            attachmentPathCandidates({ linkMode: "linked_file", path: "attachments:x/a.pdf" }, "K", { ...none, linkedAttachmentBaseDir: "~/HU-Box" }, tools),
        ).toEqual(["/home/p/HU-Box/x/a.pdf"]);
    });
    it("a stored file: the storage folder set, then Zotero's data folder", () => {
        expect(attachmentPathCandidates({ linkMode: "imported_file", filename: "a.pdf" }, "ABCD1234", none, tools)).toEqual([
            "/home/p/Zotero/storage/ABCD1234/a.pdf",
        ]);
        expect(
            attachmentPathCandidates(
                { linkMode: "imported_url", filename: "a.html" },
                "ABCD1234",
                { ...none, zoteroStoragePath: "/z/storage", evoZoteroDataDir: "/z" },
                tools,
            ),
        ).toEqual(["/z/storage/ABCD1234/a.html"]);
    });
    it("nothing for a link, or names that would leave the folder", () => {
        expect(attachmentPathCandidates({ linkMode: "linked_url" }, "K", none, tools)).toEqual([]);
        expect(attachmentPathCandidates({ linkMode: "imported_file", filename: "../x.pdf" }, "K", none, tools)).toEqual([]);
        expect(attachmentPathCandidates({ linkMode: "imported_file", filename: "a.pdf" }, "..", none, tools)).toEqual([]);
    });
});

describe("the outline among the annotations", () => {
    const h = (title: string, level: number, page: number, top: number | null = null): OutlineHeading => ({ title, level, page, top });
    const a = (id: string, page: number, top: number | null) => ({ id, page, top });
    const order = (entries: ReturnType<typeof interleaveOutline<{ id: string; page: number; top: number | null }>>) =>
        entries.map((e) => (e.kind === "heading" ? `# ${e.heading.title}` : e.annotation.id));

    it("a heading before the first annotation at or below it; empty parts left out", () => {
        const headings = [h("1", 0, 0), h("1.1", 1, 1, 500), h("1.2", 1, 3), h("2", 0, 5), h("3", 0, 9)];
        const notes = [a("x", 0, 700), a("y", 1, 600), a("z", 1, 400), a("w", 6, 100)];
        expect(order(interleaveOutline(notes, headings, (n) => n))).toEqual(["# 1", "x", "y", "# 1.1", "z", "# 2", "w"]);
    });
    it("a sub-heading's annotation brings its parents", () => {
        const headings = [h("1", 0, 0), h("1.1", 1, 2), h("1.1.1", 2, 4)];
        expect(order(interleaveOutline([a("x", 5, 300)], headings, (n) => n))).toEqual(["# 1", "# 1.1", "# 1.1.1", "x"]);
    });
    it("an outline out of page order is put in order; annotations without a place keep theirs", () => {
        const headings = [h("B", 0, 4), h("A", 0, 1)];
        const notes = [a("x", 2, 10), { id: "epub", page: -1, top: null }, a("y", 5, 10)];
        const place = (n: { id: string; page: number; top: number | null }) => (n.page < 0 ? null : n);
        expect(order(interleaveOutline(notes, headings, place))).toEqual(["# A", "x", "epub", "# B", "y"]);
    });
    it("where an annotation is: its page and the top of its first rect", () => {
        expect(placementOf({ pageIndex: 3, rects: [[10, 100, 50, 112], [10, 80, 50, 92]] })).toEqual({ page: 3, top: 112 });
        expect(placementOf({ pageIndex: 0, paths: [[1, 5, 2, 9]] })).toEqual({ page: 0, top: 9 });
        expect(placementOf({ value: "#x" })).toBeNull();
    });
});

describe("reading a PDF's outline", () => {
    it("levels, named and explicit destinations, the top of /XYZ and /FitH", async () => {
        const ref = { num: 7, gen: 0 };
        const doc = {
            getOutline: async () => [
                { title: "Intro", dest: [ref, { name: "XYZ" }, 0, 700, null], items: [{ title: "Part", dest: "named" }] },
                { title: "Nowhere", dest: null, items: [{ title: "Child", dest: [2, { name: "FitH" }, 300] }] },
                { title: "  ", dest: [3, { name: "Fit" }] },
            ],
            getDestination: async (name: string) => (name === "named" ? [1, { name: "XYZ" }, null, null, null] : null),
            getPageIndex: async (r: unknown) => (r === ref ? 0 : -1),
            destroy: async () => {},
        };
        expect(await readPdfOutline(doc)).toEqual([
            { title: "Intro", level: 0, page: 0, top: 700 },
            { title: "Part", level: 1, page: 1, top: null },
            { title: "Child", level: 0, page: 2, top: 300 },
            { title: "Untitled", level: 0, page: 3, top: null },
        ]);
    });
});
