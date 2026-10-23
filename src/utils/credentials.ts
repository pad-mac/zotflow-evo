import type { SecretStorage } from "obsidian";

// ZotFlow Evo: "evoAnnasKey", the Anna's Archive member key.
const CREDENTIAL_KEYS = ["webdavpassword", "zoteroapikey", "evoAnnasKey"] as const;

type CredentialKey = (typeof CREDENTIAL_KEYS)[number];

/**
 * ZotFlow Evo: the ID each credential is kept under. Obsidian takes only
 * lowercase letters, digits and dashes and throws on anything else, so the
 * Anna's key, first stored as "evoAnnasKey", lives under "evo-annas-key".
 * A throw there used to stop every settings save before data.json.
 */
const SECRET_ID: Record<CredentialKey, string> = {
    webdavpassword: "webdavpassword",
    zoteroapikey: "zoteroapikey",
    evoAnnasKey: "evo-annas-key",
};

/** IDs a credential was kept under before, read once to move it. */
const LEGACY_IDS: Partial<Record<CredentialKey, string[]>> = {
    evoAnnasKey: ["evoAnnasKey"],
};

/** Minimal shape: settings object must have the credential keys as optional strings. */
type HasCredentials = { [K in CredentialKey]?: string } & {
    /** ZotFlow Evo: shared folders of groups, each with its WebDAV password. */
    evoGroupFolders?: { id?: string; password?: string }[];
};

/** ZotFlow Evo: the ID a shared folder's WebDAV password is kept under. */
const folderSecretId = (id: string) => `evo-folder-${id}`;
const FOLDER_ID = /^[a-z0-9]+$/;

function readSecret(storage: SecretStorage, id: string): string | null {
    try {
        return storage.getSecret(id);
    } catch {
        return null;
    }
}

/** Store one secret; a refused one must not stop the others (or the save). */
function writeSecret(storage: SecretStorage, id: string, value: string): void {
    try {
        storage.setSecret(id, value);
    } catch (e) {
        console.warn(`[ZotFlow] Could not store the secret "${id}":`, e);
    }
}

/**
 * Persist sensitive credentials to SecretStorage.
 */
export function saveCredentials<T extends HasCredentials>(
    settings: T,
    storage: SecretStorage,
): void {
    for (const key of CREDENTIAL_KEYS) {
        const value = settings[key];
        if (typeof value === "string" && value.length > 0) {
            writeSecret(storage, SECRET_ID[key], value);
        } else {
            // Remove stale secret if field was cleared
            writeSecret(storage, SECRET_ID[key], "");
        }
    }
    // ZotFlow Evo: each shared folder's password; those of folders no
    // longer set up are cleared.
    const kept = new Set<string>();
    for (const folder of settings.evoGroupFolders ?? []) {
        if (!folder.id || !FOLDER_ID.test(folder.id)) continue;
        const id = folderSecretId(folder.id);
        kept.add(id);
        writeSecret(storage, id, folder.password ?? "");
    }
    let listed: string[] = [];
    try {
        listed = storage.listSecrets();
    } catch {
        listed = [];
    }
    for (const id of listed) {
        if (id.startsWith("evo-folder-") && !kept.has(id) && readSecret(storage, id))
            writeSecret(storage, id, "");
    }
}

/**
 * Merge sensitive credentials from SecretStorage back into settings.
 *
 * Also handles one-time migration: if the value already exists in
 * settings (loaded from data.json) but not yet in SecretStorage,
 * it is copied to SecretStorage so that the next `stripCredentials`
 * call removes it from data.json. A value kept under an older ID is
 * moved to the current one.
 */
export function loadCredentials<T extends HasCredentials>(
    settings: T,
    storage: SecretStorage,
): void {
    for (const key of CREDENTIAL_KEYS) {
        const id = SECRET_ID[key];
        let storedValue = readSecret(storage, id);
        if (!storedValue) {
            for (const legacy of LEGACY_IDS[key] ?? []) {
                const old = readSecret(storage, legacy);
                if (old) {
                    storedValue = old;
                    writeSecret(storage, id, old);
                    break;
                }
            }
        }

        if (settings[key] && typeof settings[key] === "string") {
            // Migrate: value in data.json but not yet in SecretStorage
            if (!storedValue) {
                writeSecret(storage, id, settings[key]);
            }
        } else if (storedValue) {
            // Normal path: restore from SecretStorage
            settings[key] = storedValue;
        }
    }
    for (const folder of settings.evoGroupFolders ?? []) {
        if (!folder.id || !FOLDER_ID.test(folder.id)) continue;
        const stored = readSecret(storage, folderSecretId(folder.id));
        if (folder.password) {
            if (!stored) writeSecret(storage, folderSecretId(folder.id), folder.password);
        } else if (stored) folder.password = stored;
    }
}

/**
 * Return a shallow copy of settings with all credential fields removed.
 * Use this before persisting to data.json.
 */
export function stripCredentials<T extends HasCredentials>(settings: T): T {
    const copy = { ...settings };
    for (const key of CREDENTIAL_KEYS) {
        delete copy[key];
    }
    if (Array.isArray(copy.evoGroupFolders)) {
        copy.evoGroupFolders = copy.evoGroupFolders.map((folder) => {
            const { password: _password, ...rest } = folder;
            return rest;
        });
    }
    return copy;
}

/**
 * Remove all stored credentials from SecretStorage.
 */
export function clearCredentials(storage: SecretStorage): void {
    for (const key of CREDENTIAL_KEYS) {
        writeSecret(storage, SECRET_ID[key], "");
    }
}
