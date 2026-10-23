/**
 * ZotFlow Evo: credentials in Obsidian's SecretStorage. Obsidian takes only
 * lowercase letters, digits and dashes as an ID and throws on others; the
 * Anna's key was kept as "evoAnnasKey", which made every settings save
 * throw before data.json was written.
 */
import { describe, expect, it } from "vitest";

import { loadCredentials, saveCredentials } from "utils/credentials";

import type { SecretStorage } from "obsidian";

/** A SecretStorage that checks IDs as Obsidian does (and can hold an old, invalid one). */
function storage(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial));
    const check = (id: string) => {
        if (!/^[a-z0-9-]+$/.test(id)) throw new Error("Secret ID is invalid");
    };
    const s = {
        data,
        setSecret(id: string, value: string) {
            check(id);
            data.set(id, value);
        },
        getSecret(id: string) {
            check(id);
            return data.get(id) ?? null;
        },
        listSecrets: () => [...data.keys()],
    };
    return s as typeof s & SecretStorage;
}

describe("credentials", () => {
    it("saving does not throw, and every key goes under a valid ID", () => {
        const s = storage();
        expect(() =>
            saveCredentials({ zoteroapikey: "Z", webdavpassword: "", evoAnnasKey: "A" }, s),
        ).not.toThrow();
        expect(s.data.get("zoteroapikey")).toBe("Z");
        expect(s.data.get("evo-annas-key")).toBe("A");
    });

    it("loading reads them back", () => {
        const s = storage({ zoteroapikey: "Z", "evo-annas-key": "A" });
        const settings: { zoteroapikey?: string; evoAnnasKey?: string } = {};
        loadCredentials(settings, s);
        expect(settings).toEqual({ zoteroapikey: "Z", evoAnnasKey: "A" });
    });

    it("a refused ID costs only its own secret", () => {
        const s = storage();
        const refusing = { ...s, setSecret: (id: string, v: string) => (id === "zoteroapikey" ? (() => { throw new Error("no"); })() : s.setSecret(id, v)) } as unknown as SecretStorage;
        expect(() => saveCredentials({ zoteroapikey: "Z", evoAnnasKey: "A" }, refusing)).not.toThrow();
        expect(s.data.get("evo-annas-key")).toBe("A");
    });
});
