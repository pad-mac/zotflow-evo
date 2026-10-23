/**
 * ZotFlow Evo: a creator's name as one string (utils/evo-names.ts) and the
 * citation key made from an item (utils/evo-citekey.ts).
 */
import { describe, expect, it } from "vitest";

import { editableName, naturalName, parseCreatorName } from "utils/evo-names";
import { asciiFold, makeCitationKey, uniqueCitationKey } from "utils/evo-citekey";

describe("one name field", () => {
    const p = (s: string, o?: { singleField?: boolean }) => parseCreatorName(s, o);
    it("the last word is the last name", () => {
        expect(p("Urs Stäheli")).toEqual({ firstName: "Urs", lastName: "Stäheli" });
        expect(p("  Johann   Wolfgang Goethe ")).toEqual({ firstName: "Johann Wolfgang", lastName: "Goethe" });
        expect(p("Homer")).toEqual({ firstName: "", lastName: "Homer" });
        expect(p("   ")).toBeNull();
    });
    it("lowercase particles go with it", () => {
        expect(p("Jan van der Berg")).toEqual({ firstName: "Jan", lastName: "van der Berg" });
        expect(p("Alexander von Humboldt")).toEqual({ firstName: "Alexander", lastName: "von Humboldt" });
        expect(p("de Gaulle")).toEqual({ firstName: "", lastName: "de Gaulle" });
        // Capitalised ones too, while a first name is left; "Al" is a first name.
        expect(p("Martin Van Buren")).toEqual({ firstName: "Martin", lastName: "Van Buren" });
        expect(p("Al Gore")).toEqual({ firstName: "Al", lastName: "Gore" });
        expect(p("Lorenzo Da Ponte")).toEqual({ firstName: "Lorenzo", lastName: "Da Ponte" });
    });
    it("a comma splits by hand; suffixes stay with the first name", () => {
        expect(p("García Márquez, Gabriel")).toEqual({ firstName: "Gabriel", lastName: "García Márquez" });
        expect(p("Martin Luther King, Jr.")).toEqual({ firstName: "Martin Luther, Jr.", lastName: "King" });
        expect(p("King, Martin Luther, Jr.")).toEqual({ firstName: "Martin Luther, Jr.", lastName: "King" });
        expect(p("Henry Ford II")).toEqual({ firstName: "Henry, II", lastName: "Ford" });
    });
    it("braces, or a name that was one field, stay one field", () => {
        expect(p("{Deutsche Bahn AG}")).toEqual({ name: "Deutsche Bahn AG" });
        expect(p("Deutsche Bahn AG", { singleField: true })).toEqual({ name: "Deutsche Bahn AG" });
    });
    it("shown in natural order when that reads back the same, else Last, First", () => {
        expect(editableName({ firstName: "Jan", lastName: "van der Berg" })).toBe("Jan van der Berg");
        expect(editableName({ firstName: "Gabriel", lastName: "García Márquez" })).toBe("García Márquez, Gabriel");
        expect(editableName({ firstName: "Martin Luther, Jr.", lastName: "King" })).toBe("Martin Luther King, Jr.");
        expect(naturalName({ name: "UNESCO" })).toBe("UNESCO");
        for (const c of [
            { firstName: "Gabriel", lastName: "García Márquez" },
            { firstName: "Martin Luther, Jr.", lastName: "King" },
            { firstName: "Jean de", lastName: "La Fontaine" },
        ]) {
            expect(parseCreatorName(editableName(c))).toEqual(c);
        }
    });
});

describe("the citation key", () => {
    it("Better BibTeX's default: auth.lower + shorttitle(3,3) + year", () => {
        expect(
            makeCitationKey({
                title: "Entnetzt Euch!: Praktiken und Ästhetiken der Anschlusslosigkeit",
                date: "2014",
                creators: [{ creatorType: "author", firstName: "Urs", lastName: "Stäheli" }],
            }),
        ).toBe("staeheliEntnetztEuchPraktiken2014");
        expect(
            makeCitationKey({
                title: "The Order of Things",
                date: "1970-05",
                creators: [{ creatorType: "editor", lastName: "Groß" }, { creatorType: "author", lastName: "Foucault" }],
            }),
        ).toBe("foucaultOrderThings1970");
    });
    it("no author: an editor; nothing: just title and year", () => {
        expect(makeCitationKey({ title: "Kunst und Arbeit", date: "2014", creators: [{ creatorType: "editor", lastName: "Lemke" }] })).toBe("lemkeKunstArbeit2014");
        expect(makeCitationKey({ title: "Über Maschinen" })).toBe("UeberMaschinen");
    });
    it("a key another item has gets a, b, …", () => {
        expect(uniqueCitationKey("x2014", new Set())).toBe("x2014");
        expect(uniqueCitationKey("x2014", new Set(["x2014"]))).toBe("x2014a");
        expect(uniqueCitationKey("x2014", new Set(["x2014", "x2014a"]))).toBe("x2014b");
        expect(asciiFold("Énergie")).toBe("Energie");
    });
});
