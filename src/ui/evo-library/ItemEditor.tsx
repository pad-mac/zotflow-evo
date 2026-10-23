/**
 * ZotFlow Evo (fork): editing an item's data, in the item pane (under its
 * edit button) and in the reader's note strip (mounted into the strip's
 * frame by the bridge, `evoMountItemEditor`). A table: the citation key,
 * the item type, then every field that has a value; "+" adds one of the
 * type's other fields. A field is saved when it is left (or Enter);
 * Escape takes the change back. The abstract has an editor of its own
 * (`AbstractEditor`), shown here in the strip.
 *
 * Fields are written as local edits (they sync like any other); a new item
 * type goes to Zotero first (item-edits.ts). Creators are one field each,
 * read with the name rules in utils/evo-names.ts; the citation key has a
 * button that makes it again from the data (utils/evo-citekey.ts).
 * The styles are injected into the document the editor is in, so it looks
 * the same inside the reader's frames.
 */
import React, {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";

import { workerBridge } from "bridge";
import { services } from "services/services";
import { noteLocalEdit } from "services/evo-auto-sync";
import { previewTypeChange, setItemType } from "ui/evo-library/item-edits";
import { useLibraryChanges } from "ui/evo-library/parts";
import { ITEM_TYPE_CREATORS, ITEM_TYPE_FIELDS } from "types/zotero-csl-schema";
import { editableName, parseCreatorName } from "utils/evo-names";
import { ITEM_TYPE_LABELS, itemTypeLabel } from "types/zotero-item-type-labels";

/** Names of fields as the editor shows them (others: their name, spaced). */
const FIELD_LABELS: Record<string, string> = {
    title: "Title",
    abstractNote: "Abstract",
    publicationTitle: "Publication",
    bookTitle: "Book title",
    proceedingsTitle: "Proceedings",
    blogTitle: "Blog",
    websiteTitle: "Website",
    forumTitle: "Forum",
    encyclopediaTitle: "Encyclopedia",
    dictionaryTitle: "Dictionary",
    seriesTitle: "Series title",
    seriesText: "Series text",
    seriesNumber: "Series number",
    numberOfVolumes: "# of volumes",
    numPages: "# of pages",
    journalAbbreviation: "Journal abbr.",
    shortTitle: "Short title",
    accessDate: "Accessed",
    libraryCatalog: "Library catalog",
    callNumber: "Call number",
    archiveLocation: "Loc. in archive",
    citationKey: "Citation key",
    url: "URL",
    DOI: "DOI",
    ISBN: "ISBN",
    ISSN: "ISSN",
    PMID: "PMID",
    PMCID: "PMCID",
    extra: "Extra",
    date: "Date",
    place: "Place",
    publisher: "Publisher",
    volume: "Volume",
    issue: "Issue",
    pages: "Pages",
    edition: "Edition",
    series: "Series",
    language: "Language",
    rights: "Rights",
    university: "University",
    thesisType: "Type",
    institution: "Institution",
    reportNumber: "Report number",
    reportType: "Report type",
};

export function fieldLabel(field: string): string {
    if (FIELD_LABELS[field]) return FIELD_LABELS[field];
    const spaced = field.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Item types an item can become (not notes, attachments, annotations). */
const TYPES = Object.keys(ITEM_TYPE_LABELS)
    .filter((t) => !["note", "attachment", "annotation"].includes(t))
    .sort((a, b) => itemTypeLabel(a).localeCompare(itemTypeLabel(b)));

const CSS = `
.zotflow-evo-editor { display: flex; flex-direction: column; gap: 2px; padding: 4px 12px 8px; font-size: var(--font-ui-small, 13px); }
.zotflow-evo-editor-row { display: grid; grid-template-columns: minmax(84px, 32%) 1fr; align-items: start; gap: 8px; }
.zotflow-evo-editor-label { padding-top: 4px; color: var(--text-muted, #666); font-size: var(--font-ui-smaller, 12px); text-align: end; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.zotflow-evo-editor-input, .zotflow-evo-editor select, .zotflow-evo-editor-abstract {
  width: 100%; min-width: 0; box-sizing: border-box; padding: 3px 6px; border: 1px solid transparent; border-radius: 4px;
  background: transparent; color: var(--text-normal, #222); font: inherit; font-size: var(--font-ui-small, 13px); box-shadow: none;
}
.zotflow-evo-editor-input:hover, .zotflow-evo-editor select:hover, .zotflow-evo-editor-abstract:hover { border-color: var(--background-modifier-border, rgba(128,128,128,.3)); }
.zotflow-evo-editor-input:focus, .zotflow-evo-editor select:focus, .zotflow-evo-editor-abstract:focus { border-color: var(--interactive-accent, #7b6cd9); outline: none; background: var(--background-primary, #fff); }
textarea.zotflow-evo-editor-input { resize: vertical; min-height: 44px; }
.zotflow-evo-editor-abstract { display: block; min-height: 90px; resize: vertical; line-height: 1.5; }
.zotflow-evo-editor-add { justify-self: start; color: var(--text-faint, #999); }
.zotflow-evo-editor-add select { width: auto; color: var(--text-muted, #666); }
.zotflow-evo-editor-confirm { grid-column: 1 / -1; padding: 6px 8px; border-radius: 4px; background: var(--background-modifier-hover, rgba(128,128,128,.12)); font-size: var(--font-ui-smaller, 12px); line-height: 1.45; }
.zotflow-evo-editor-confirm button { margin: 6px 6px 0 0; }
.zotflow-evo-editor-saving { opacity: .55; }
.zotflow-evo-editor-row select.zotflow-evo-editor-role { padding: 3px 2px; color: var(--text-muted, #666); font-size: var(--font-ui-smaller, 12px); text-align: end; text-align-last: end; }
.zotflow-evo-editor-with-tool { display: flex; align-items: center; gap: 2px; min-width: 0; }
.zotflow-evo-editor-with-tool > input { flex: 1 1 auto; }
.zotflow-evo-editor-tool { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 4px; background: transparent; box-shadow: none; color: var(--text-faint, #999); cursor: pointer; opacity: .6; transition: opacity 120ms ease-out, color 120ms ease-out; }
.zotflow-evo-editor-row:hover .zotflow-evo-editor-tool, .zotflow-evo-editor-tool:focus-visible { opacity: 1; }
.zotflow-evo-editor-tool:hover { color: var(--text-normal, #222); background: var(--background-modifier-hover, rgba(128,128,128,.12)); }
.zotflow-evo-editor-tool svg { width: 14px; height: 14px; }
.zotflow-evo-editor-tool.is-busy svg { animation: zotflow-evo-spin 700ms linear infinite; }
@keyframes zotflow-evo-spin { to { transform: rotate(360deg); } }
.zotflow-evo-editor-add-creator { justify-self: start; padding: 2px 6px; border: 0; background: transparent; box-shadow: none; color: var(--text-faint, #999); font-size: var(--font-ui-smaller, 12px); cursor: pointer; }
.zotflow-evo-editor-add-creator:hover { color: var(--text-normal, #222); }
`;

/** The documents the styles were given to. */
const styled = new WeakSet<Document>();

function ensureStyles(doc: Document) {
    if (styled.has(doc)) return;
    // A sheet made by the document's own window (the reader's frames have
    // none of Obsidian's DOM helpers, and a sheet adopts only into its own).
    const win = doc.defaultView;
    if (!win) return;
    const sheet = new win.CSSStyleSheet();
    sheet.replaceSync(CSS);
    doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
    styled.add(doc);
}

/** A creator as Zotero keeps it. */
interface Creator {
    creatorType: string;
    firstName?: string;
    lastName?: string;
    name?: string;
}

interface ItemData {
    itemType: string;
    fields: Record<string, string>;
    creators: Creator[];
}

async function readItem(
    libraryID: number,
    key: string,
): Promise<ItemData | null> {
    const item = (await workerBridge.dbHelper.getItem(
        libraryID,
        key,
    )) as unknown as {
        itemType?: string;
        raw?: { data?: Record<string, unknown> };
    } | null;
    const data = item?.raw?.data;
    if (!item || !data) return null;
    const itemType =
        typeof data.itemType === "string"
            ? data.itemType
            : (item.itemType ?? "");
    const fields: Record<string, string> = {};
    for (const name of ITEM_TYPE_FIELDS[itemType] ?? []) {
        const v = data[name];
        if (typeof v === "string" && v !== "") fields[name] = v;
    }
    const creators = Array.isArray(data.creators)
        ? (data.creators as Creator[]).filter(
              (c) => c && typeof c.creatorType === "string",
          )
        : [];
    return { itemType, fields, creators };
}

/** The item's data, read again whenever the library changes. */
function useItemData(libraryID: number, key: string) {
    const [data, setData] = useState<ItemData | null>(null);
    const run = useRef(0);
    const load = useCallback(() => {
        const id = ++run.current;
        readItem(libraryID, key)
            .then((d) => {
                if (id === run.current) setData(d);
            })
            .catch((e: unknown) =>
                services.logService.error(
                    "Failed to read the item",
                    "EvoLibrary",
                    e,
                ),
            );
    }, [libraryID, key]);
    useEffect(load, [load]);
    useLibraryChanges(load);
    return { data, reload: load };
}

async function saveField(
    libraryID: number,
    key: string,
    field: string,
    value: string,
) {
    try {
        const changed = await workerBridge.evoLibrary.setItemFields(
            libraryID,
            key,
            { [field]: value },
        );
        if (changed) noteLocalEdit(libraryID);
    } catch (e) {
        services.logService.error("Failed to save a field", "EvoLibrary", e);
        services.notificationService.notify(
            "error",
            `Couldn't save ${fieldLabel(field)}. ${e instanceof Error ? e.message : ""}`,
        );
    }
}

async function saveCreators(
    libraryID: number,
    key: string,
    creators: Creator[],
): Promise<void> {
    try {
        const changed = await workerBridge.evoLibrary.setItemCreators(
            libraryID,
            key,
            creators,
        );
        if (changed) noteLocalEdit(libraryID);
    } catch (e) {
        services.logService.error("Failed to save the creators", "EvoLibrary", e);
        services.notificationService.notify(
            "error",
            `Couldn't save the creators. ${e instanceof Error ? e.message : ""}`,
        );
    }
}

/** A creator's name for the name rules. */
const nameOf = (c: Creator) =>
    c.name !== undefined
        ? { name: c.name }
        : { firstName: c.firstName ?? "", lastName: c.lastName ?? "" };

/** A role's name: "bookAuthor" → "Book author". */
function roleLabel(type: string): string {
    const spaced = type.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Lucide's refresh-cw, drawn here (the reader's frames have no icon helper). */
function RefreshIcon() {
    return (
        <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
            <path d="M21 3v5h-5" />
            <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
            <path d="M8 16H3v5" />
        </svg>
    );
}

/** Lucide's x. */
function RemoveIcon() {
    return (
        <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
        </svg>
    );
}

/** A field's input: saved when left or on Enter; Escape takes the change back. */
function FieldInput({
    value,
    multiline,
    autoFocus,
    onCommit,
    placeholder,
    className,
}: {
    value: string;
    multiline?: boolean;
    autoFocus?: boolean;
    onCommit: (value: string) => void;
    placeholder?: string;
    className?: string;
}) {
    const [draft, setDraft] = useState(value);
    const editing = useRef(false);
    useEffect(() => {
        // Not while it is being typed in: a sync must not take words back.
        if (!editing.current) setDraft(value);
    }, [value]);
    const commit = () => {
        editing.current = false;
        if (draft !== value) onCommit(draft);
    };
    const common = {
        className: className ?? "zotflow-evo-editor-input",
        value: draft,
        placeholder,
        autoFocus,
        onFocus: () => {
            editing.current = true;
        },
        onBlur: commit,
        onChange: (
            e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
        ) => setDraft(e.target.value),
        onKeyDown: (
            e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
        ) => {
            e.stopPropagation();
            if (e.key === "Escape") {
                setDraft(value);
                editing.current = false;
                (e.target as HTMLElement).blur();
            } else if (e.key === "Enter" && !multiline) {
                (e.target as HTMLElement).blur();
            }
        },
    };
    return multiline ? (
        <textarea {...common} rows={3} />
    ) : (
        <input type="text" {...common} />
    );
}

/** The abstract, editable. */
export function AbstractEditor({
    libraryID,
    itemKey,
    value,
}: {
    libraryID: number;
    itemKey: string;
    value: string;
}) {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (ref.current) ensureStyles(ref.current.ownerDocument);
    }, []);
    return (
        <div ref={ref} className="zotflow-evo-editor-abstract-host">
            <FieldInput
                value={value}
                multiline
                className="zotflow-evo-editor-abstract"
                placeholder="Abstract"
                onCommit={(v) =>
                    void saveField(libraryID, itemKey, "abstractNote", v)
                }
            />
        </div>
    );
}

export interface ItemEditorProps {
    libraryID: number;
    itemKey: string;
    /** Show the abstract's editor first (the note strip has no abstract of its own). */
    withAbstract?: boolean;
}

export function ItemEditor({
    libraryID,
    itemKey,
    withAbstract,
}: ItemEditorProps) {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (ref.current) ensureStyles(ref.current.ownerDocument);
    }, []);
    const { data, reload } = useItemData(libraryID, itemKey);
    // Fields added with "+" and not filled yet, by item.
    const [added, setAdded] = useState<string[]>([]);
    const [confirm, setConfirm] = useState<{
        type: string;
        dropped: { field: string; value: string }[];
    } | null>(null);
    const [saving, setSaving] = useState(false);
    // A creator row added with "+" and not named yet.
    const [newCreator, setNewCreator] = useState<string | null>(null);
    const [keyBusy, setKeyBusy] = useState(false);
    useEffect(() => {
        setAdded([]);
        setConfirm(null);
        setNewCreator(null);
    }, [libraryID, itemKey]);

    const allowed = useMemo(
        () => (data ? (ITEM_TYPE_FIELDS[data.itemType] ?? []) : []),
        [data],
    );
    if (!data) return <div ref={ref} className="zotflow-evo-editor" />;

    const shown = allowed.filter(
        (f) =>
            f !== "citationKey" &&
            f !== "abstractNote" &&
            (data.fields[f] !== undefined || added.includes(f)),
    );
    const addable = allowed.filter(
        (f) =>
            f !== "citationKey" && f !== "abstractNote" && !shown.includes(f),
    );

    const changeType = async (type: string) => {
        if (type === data.itemType) return;
        const preview = await previewTypeChange(libraryID, itemKey, type);
        if (preview?.dropped.length) {
            setConfirm({ type, dropped: preview.dropped });
            return;
        }
        await doChangeType(type);
    };
    const doChangeType = async (type: string) => {
        setConfirm(null);
        setSaving(true);
        const ok = await setItemType(libraryID, itemKey, type);
        setSaving(false);
        if (ok)
            services.notificationService.notify(
                "info",
                `Changed to ${itemTypeLabel(type)}; it shows here after the sync.`,
            );
        reload();
    };

    const commit = (field: string) => (value: string) => {
        if (!value) setAdded((list) => list.filter((f) => f !== field));
        void saveField(libraryID, itemKey, field, value);
    };

    const roles = ITEM_TYPE_CREATORS[data.itemType] ?? ["author"];
    const creators = data.creators;
    const writeCreators = (next: Creator[]) =>
        void saveCreators(libraryID, itemKey, next).then(reload);
    const renameCreator = (index: number) => (text: string) => {
        const old = creators[index];
        if (!old) return;
        const parsed = parseCreatorName(text, {
            singleField: old.name !== undefined,
        });
        const next = [...creators];
        if (!parsed) next.splice(index, 1);
        else next[index] = { creatorType: old.creatorType, ...parsed };
        writeCreators(next);
    };
    const addCreator = (text: string) => {
        const type = newCreator ?? roles[0] ?? "author";
        setNewCreator(null);
        const parsed = parseCreatorName(text);
        if (parsed) writeCreators([...creators, { creatorType: type, ...parsed }]);
    };
    const regenerateKey = async () => {
        setKeyBusy(true);
        try {
            const key = await workerBridge.evoLibrary.suggestCitationKey(
                libraryID,
                itemKey,
            );
            if (key && key !== (data.fields.citationKey ?? "")) {
                await saveField(libraryID, itemKey, "citationKey", key);
                reload();
            }
        } finally {
            setKeyBusy(false);
        }
    };

    return (
        <div
            ref={ref}
            className={
                "zotflow-evo-editor" +
                (saving ? " zotflow-evo-editor-saving" : "")
            }
        >
            {withAbstract && (
                <FieldInput
                    key={`${itemKey}:abstractNote`}
                    value={data.fields.abstractNote ?? ""}
                    multiline
                    className="zotflow-evo-editor-abstract"
                    placeholder="Abstract"
                    onCommit={commit("abstractNote")}
                />
            )}
            {allowed.includes("citationKey") && (
                <div className="zotflow-evo-editor-row">
                    <span className="zotflow-evo-editor-label">
                        Citation key
                    </span>
                    <span className="zotflow-evo-editor-with-tool">
                        <FieldInput
                            key={`${itemKey}:citationKey`}
                            value={data.fields.citationKey ?? ""}
                            placeholder="—"
                            onCommit={commit("citationKey")}
                        />
                        <button
                            type="button"
                            className={
                                "zotflow-evo-editor-tool zotflow-evo-editor-rekey" +
                                (keyBusy ? " is-busy" : "")
                            }
                            title="Make the citation key again from the creators, title and year"
                            aria-label="Make the citation key again"
                            disabled={keyBusy}
                            // Before the click: a field being typed in is saved on blur first.
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => {
                                const active = ref.current?.ownerDocument
                                    .activeElement as HTMLElement | null;
                                active?.blur();
                                // After the blur's save has gone out.
                                window.setTimeout(
                                    () => void regenerateKey(),
                                    60,
                                );
                            }}
                        >
                            <RefreshIcon />
                        </button>
                    </span>
                </div>
            )}
            <div className="zotflow-evo-editor-row">
                <span className="zotflow-evo-editor-label">Item type</span>
                <select
                    value={data.itemType}
                    disabled={saving}
                    onChange={(e) => void changeType(e.target.value)}
                    onKeyDown={(e) => e.stopPropagation()}
                >
                    {TYPES.map((t) => (
                        <option key={t} value={t}>
                            {itemTypeLabel(t)}
                        </option>
                    ))}
                </select>
                {confirm && (
                    <div className="zotflow-evo-editor-confirm">
                        As {itemTypeLabel(confirm.type)}, these would be lost:{" "}
                        {confirm.dropped
                            .map(
                                (d) =>
                                    `${fieldLabel(d.field)} (${d.value.length > 40 ? d.value.slice(0, 40) + "…" : d.value})`,
                            )
                            .join(", ")}
                        .
                        <div>
                            <button
                                type="button"
                                className="mod-warning"
                                onClick={() => void doChangeType(confirm.type)}
                            >
                                Change anyway
                            </button>
                            <button
                                type="button"
                                onClick={() => setConfirm(null)}
                            >
                                Keep {itemTypeLabel(data.itemType)}
                            </button>
                        </div>
                    </div>
                )}
            </div>
            {creators.map((c, i) => (
                <div
                    key={`${itemKey}:creator:${i}:${editableName(nameOf(c))}`}
                    className="zotflow-evo-editor-row zotflow-evo-editor-creator"
                >
                    <select
                        className="zotflow-evo-editor-role"
                        value={c.creatorType}
                        aria-label="Role"
                        onChange={(e) => {
                            const next = [...creators];
                            next[i] = { ...c, creatorType: e.target.value };
                            writeCreators(next);
                        }}
                        onKeyDown={(e) => e.stopPropagation()}
                    >
                        {(roles.includes(c.creatorType)
                            ? roles
                            : [c.creatorType, ...roles]
                        ).map((r) => (
                            <option key={r} value={r}>
                                {roleLabel(r)}
                            </option>
                        ))}
                    </select>
                    <span className="zotflow-evo-editor-with-tool">
                        <FieldInput
                            value={editableName(nameOf(c))}
                            placeholder="First Last"
                            onCommit={renameCreator(i)}
                        />
                        <button
                            type="button"
                            className="zotflow-evo-editor-tool"
                            title="Remove"
                            aria-label="Remove this creator"
                            onClick={() =>
                                writeCreators(creators.filter((_, j) => j !== i))
                            }
                        >
                            <RemoveIcon />
                        </button>
                    </span>
                </div>
            ))}
            {newCreator !== null ? (
                <div className="zotflow-evo-editor-row zotflow-evo-editor-creator">
                    <select
                        className="zotflow-evo-editor-role"
                        value={newCreator}
                        aria-label="Role"
                        onChange={(e) => setNewCreator(e.target.value)}
                        onKeyDown={(e) => e.stopPropagation()}
                    >
                        {roles.map((r) => (
                            <option key={r} value={r}>
                                {roleLabel(r)}
                            </option>
                        ))}
                    </select>
                    <FieldInput
                        value=""
                        autoFocus
                        placeholder="First Last, or Last, First"
                        onCommit={addCreator}
                    />
                </div>
            ) : (
                <div className="zotflow-evo-editor-row">
                    <span />
                    <button
                        type="button"
                        className="zotflow-evo-editor-add-creator"
                        onClick={() => setNewCreator(roles[0] ?? "author")}
                    >
                        + Add a creator
                    </button>
                </div>
            )}
            {shown.map((field) => (
                <div
                    key={`${itemKey}:${field}`}
                    className="zotflow-evo-editor-row"
                >
                    <span className="zotflow-evo-editor-label" title={field}>
                        {fieldLabel(field)}
                    </span>
                    <FieldInput
                        value={data.fields[field] ?? ""}
                        multiline={field === "extra"}
                        autoFocus={
                            added.includes(field) &&
                            data.fields[field] === undefined
                        }
                        onCommit={commit(field)}
                    />
                </div>
            ))}
            {addable.length > 0 && (
                <div className="zotflow-evo-editor-row">
                    <span className="zotflow-evo-editor-label">+</span>
                    <span className="zotflow-evo-editor-add">
                        <select
                            value=""
                            aria-label="Add a field"
                            onChange={(e) => {
                                const f = e.target.value;
                                if (f) setAdded((list) => [...list, f]);
                            }}
                            onKeyDown={(e) => e.stopPropagation()}
                        >
                            <option value="">Add a field…</option>
                            {addable.map((f) => (
                                <option key={f} value={f}>
                                    {fieldLabel(f)}
                                </option>
                            ))}
                        </select>
                    </span>
                </div>
            )}
        </div>
    );
}
