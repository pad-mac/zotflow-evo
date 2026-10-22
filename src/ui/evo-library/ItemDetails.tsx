/**
 * ZotFlow Evo (fork): the selected item — in the library browser's right
 * pane, or in a tab of its own (DetailsTab). On top, always in view: the
 * title, the first two authors, the year on its own line, where it was
 * published, its files. Under it the abstract, which scrolls on its own
 * when long, and below a line the annotations of the file it opens, which
 * scroll on their own too. See FORK.md.
 */
import { Menu } from "obsidian";
import React, {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";

import { workerBridge } from "bridge";
import { services } from "services/services";
import {
    openAnnotation,
    openBookSearch,
    renameAttachmentFile,
    revealInLibrary,
} from "ui/evo-library/actions";
import { onSelection, lastSelection } from "ui/evo-library/selection";
import {
    AnnotationCard,
    ColorSwatches,
    Icon,
    Title,
    useColorFilter,
    useLibraryChanges,
} from "ui/evo-library/parts";
import { AbstractEditor, ItemEditor } from "ui/evo-library/ItemEditor";
import {
    canRevealFiles,
    revealFileTitle,
    revealItemFile,
} from "ui/evo-library/reveal-file";
import { openPersonNote } from "ui/evo-person";
import { itemOutline } from "ui/evo-library/item-outline";
import { annotationColors } from "utils/evo-library-model";
import { interleaveOutline, placementOf } from "utils/evo-outline-list";
import { notifyLinkedFile, openAttachment } from "utils/viewer";

import type { App, WorkspaceLeaf } from "obsidian";
import type { CardAnnotation } from "ui/evo-library/parts";
import type { ItemOutline } from "ui/evo-library/item-outline";
import type { OutlineListEntry } from "utils/evo-outline-list";
import type {
    EvoAttachmentInfo,
    EvoItemDetails,
} from "worker/services/evo-library";

const KIND_LABEL: Record<string, string> = {
    pdf: "PDF",
    epub: "EPUB",
    snapshot: "Web snapshot",
    linked: "Linked file",
    link: "Link",
    other: "File",
};

const KIND_ICON: Record<string, string> = {
    pdf: "file-text",
    epub: "book-open",
    snapshot: "globe",
    linked: "file-symlink",
    link: "link",
    other: "file",
};

/**
 * Right-click on a file in the item pane: open it, and (a PDF or EPUB)
 * rename it from the file name template.
 */
function showAttachmentMenu(
    event: MouseEvent,
    libraryID: number,
    attachment: EvoAttachmentInfo,
    open: () => void,
) {
    const menu = new Menu();
    menu.addItem((item) =>
        item.setTitle("Open").setIcon("book-open").onClick(open),
    );
    if (canRevealFiles() && attachment.kind !== "link") {
        menu.addItem((item) =>
            item
                .setTitle(revealFileTitle())
                .setIcon("folder-open")
                .onClick(() => void revealItemFile(libraryID, attachment.key)),
        );
    }
    if (attachment.kind === "pdf" || attachment.kind === "epub") {
        menu.addItem((item) =>
            item
                .setTitle("Rename file from template")
                .setIcon("text-cursor-input")
                .onClick(
                    () => void renameAttachmentFile(libraryID, attachment.key),
                ),
        );
    }
    menu.showAtMouseEvent(event);
}

export interface ItemDetailsProps {
    app: App;
    leaf: WorkspaceLeaf;
    details: EvoItemDetails | null;
    /** A collection of the item was clicked: show it there. */
    onShowInCollection?: (
        libraryID: number,
        collectionKey: string,
        itemKey: string,
    ) => void;
    /** How many items are selected (the pane shows the focused one). */
    count: number;
    /** What to say with nothing to show. */
    emptyText?: string;
}

/**
 * A person's name as a link to their note, as `[[Name]]` would be: a
 * click opens it (Ctrl/Cmd: in a new tab); Obsidian creates it if missing.
 */
function PersonLink({ app, name }: { app: App; name: string }) {
    return (
        <span
            className="zotflow-evo-person"
            onClick={(e) => {
                e.stopPropagation();
                void openPersonNote(app, name, e.nativeEvent);
            }}
        >
            {name}
        </span>
    );
}

/** Every item pane follows the outline button (it is one setting). */
const outlineListeners = new Set<(on: boolean) => void>();

function useOutlineShown(): [boolean, () => void] {
    const [on, setOn] = useState(
        () => services.settings.evoItemPaneOutline === true,
    );
    useEffect(() => {
        outlineListeners.add(setOn);
        return () => {
            outlineListeners.delete(setOn);
        };
    }, []);
    const toggle = useCallback(() => {
        const next = services.settings.evoItemPaneOutline !== true;
        services.settings.evoItemPaneOutline = next;
        for (const listener of outlineListeners) listener(next);
        void services
            .saveSettings()
            .catch((e: unknown) =>
                services.logService.error(
                    "Failed to save the item pane settings",
                    "EvoLibrary",
                    e,
                ),
            );
    }, []);
    return [on, toggle];
}

/** The outline of the PDF whose annotations are shown, while the button is on. */
function useItemOutline(
    on: boolean,
    libraryID: number | undefined,
    pdf: EvoAttachmentInfo | null,
): ItemOutline | null {
    const [outline, setOutline] = useState<ItemOutline | null>(null);
    const key = pdf?.key;
    const md5 = pdf?.md5;
    useEffect(() => {
        setOutline(null);
        if (!on || libraryID === undefined || !key) return;
        let live = true;
        void itemOutline(libraryID, key, md5).then((o) => {
            if (live) setOutline(o);
        });
        return () => {
            live = false;
        };
    }, [on, libraryID, key, md5]);
    return outline;
}

export function ItemDetails({
    app,
    leaf,
    details,
    onShowInCollection,
    count,
    emptyText,
}: ItemDetailsProps) {
    // The colour filter stays while the selection moves (colours the item
    // does not use are left out of it).
    const filter = useColorFilter();
    // Editing stays on while the selection moves, until the button again.
    const [editing, setEditing] = useState(false);
    const [outlineOn, toggleOutline] = useOutlineShown();
    const annotations = details?.annotations;
    // The outline is that of the one PDF the annotations are of.
    const outlinePdf = useMemo(() => {
        if (!details?.primaryKey) return null;
        const a = details.attachments.find((x) => x.key === details.primaryKey);
        return a?.kind === "pdf" ? a : null;
    }, [details]);
    const outline = useItemOutline(outlineOn, details?.libraryID, outlinePdf);
    const palette = useMemo(
        () => annotationColors(annotations ?? []),
        [annotations],
    );
    if (!details) {
        return (
            <div className="zotflow-evo-details is-empty">
                {count > 1
                    ? `${count} items selected`
                    : (emptyText ?? "No item selected")}
            </div>
        );
    }
    const hasAuthors = details.authors.some((a) => a.trim());
    const openable = details.attachments.filter(
        (a) => a.kind === "pdf" || a.kind === "epub" || a.kind === "snapshot",
    );
    const regular =
        details.itemType !== "attachment" && details.itemType !== "note";
    const picked = palette.filter((hex) => filter.colors.has(hex));
    const shown = picked.length
        ? details.annotations.filter((a) =>
              picked.includes((a.color ?? "").toLowerCase()),
          )
        : details.annotations;
    const cards: CardAnnotation[] = shown.map((a) => ({
        id: a.id,
        libraryID: details.libraryID,
        attachmentKey: a.attachmentKey,
        itemKey: details.key,
        type: a.type,
        text: a.text ?? undefined,
        comment: a.comment,
        color: a.color,
        pageLabel: a.pageLabel,
    }));
    const placements = new Map(
        details.annotations.map((a) => [a.id, placementOf(a.position)]),
    );
    const entries: OutlineListEntry<CardAnnotation>[] =
        outlineOn && outline?.state === "ok"
            ? interleaveOutline(
                  cards,
                  outline.headings,
                  (c) => placements.get(c.id) ?? null,
              )
            : cards.map((annotation) => ({ kind: "annotation", annotation }));
    const linked = details.attachments.filter((a) => a.kind === "linked");
    const open = (a: EvoAttachmentInfo) => {
        if (a.kind === "linked") {
            notifyLinkedFile();
            return;
        }
        void openAttachment(details.libraryID, a.key, app);
    };
    return (
        <div className="zotflow-evo-details">
            <div className="zotflow-evo-details-head">
                <div className="zotflow-evo-details-title">
                    <Title text={details.title} />
                </div>
                {hasAuthors && (
                    <div className="zotflow-evo-details-authors">
                        {details.authors.map((name, i) => (
                            <React.Fragment key={i}>
                                {i > 0 && ", "}
                                <PersonLink app={app} name={name} />
                            </React.Fragment>
                        ))}
                        {details.moreAuthors && " et al."}
                    </div>
                )}
                {details.year ? (
                    <div className="zotflow-evo-details-year">
                        {details.year}
                    </div>
                ) : (
                    regular && (
                        <div className="zotflow-evo-details-year is-missing">
                            no year
                        </div>
                    )
                )}
                {details.publication && (
                    <div className="zotflow-evo-details-pub">
                        {details.publication}
                    </div>
                )}
                {details.collections.length > 0 && (
                    <div className="zotflow-evo-details-colls">
                        <Icon
                            name="library"
                            className="zotflow-evo-details-colls-icon"
                        />
                        {details.collections.map((c) => (
                            <span
                                key={c.key}
                                className="zotflow-evo-details-coll"
                                title={`Show in “${c.name}”`}
                                onClick={() =>
                                    onShowInCollection?.(
                                        details.libraryID,
                                        c.key,
                                        details.key,
                                    )
                                }
                            >
                                {c.name}
                            </span>
                        ))}
                    </div>
                )}
                {(details.attachments.length > 0 || regular) && (
                    <div className="zotflow-evo-details-files">
                        {details.attachments.map((a) => (
                            <span
                                key={a.key}
                                className={
                                    "zotflow-evo-details-file" +
                                    (a.key === details.primaryKey
                                        ? " is-primary"
                                        : "") +
                                    (a.kind === "linked" ? " is-linked" : "")
                                }
                                title={`${KIND_LABEL[a.kind]}: ${a.title}`}
                                onClick={() => open(a)}
                                onContextMenu={(e) => {
                                    e.preventDefault();
                                    showAttachmentMenu(
                                        e.nativeEvent,
                                        details.libraryID,
                                        a,
                                        () => open(a),
                                    );
                                }}
                            >
                                <Icon
                                    name={KIND_ICON[a.kind] ?? "file"}
                                    fallback="file"
                                />
                                <span className="zotflow-evo-details-file-name">
                                    {a.title}
                                </span>
                            </span>
                        ))}
                        {regular && openable.length === 0 && (
                            <span
                                className="zotflow-evo-details-file is-search"
                                title="Search for the file"
                                onClick={() =>
                                    void openBookSearch(app, leaf, details)
                                }
                            >
                                <Icon name="search" />
                                <span className="zotflow-evo-details-file-name">
                                    Search for the file
                                </span>
                            </span>
                        )}
                    </div>
                )}
                {linked.length > 0 && (
                    <div className="zotflow-evo-details-warning">
                        <Icon name="alert-triangle" />
                        <span>
                            {linked.length === details.attachments.length
                                ? "A linked file: "
                                : `Linked file${linked.length > 1 ? "s" : ""} (${linked.map((a) => a.title).join(", ")}): `}
                            stored outside Zotero&rsquo;s storage, so ZotFlow
                            can&rsquo;t open it yet. Open it in Zotero.
                        </span>
                    </div>
                )}
            </div>
            {editing ? (
                <div className="zotflow-evo-details-abstract is-editing">
                    <AbstractEditor
                        key={`${details.libraryID}:${details.key}`}
                        libraryID={details.libraryID}
                        itemKey={details.key}
                        value={details.abstract}
                    />
                </div>
            ) : (
                details.abstract && (
                    <div className="zotflow-evo-details-abstract">
                        {details.abstract}
                    </div>
                )
            )}
            <div className="zotflow-evo-details-actions">
                {details.itemType !== "note" && (
                    <span
                        className={
                            "zotflow-evo-tool zotflow-evo-details-edit" +
                            (editing ? " is-on" : "")
                        }
                        role="button"
                        tabIndex={0}
                        title={editing ? "Done editing" : "Edit the item's data"}
                        aria-pressed={editing}
                        onClick={() => setEditing((on) => !on)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                setEditing((on) => !on);
                            }
                        }}
                    >
                        <Icon name="pencil" />
                    </span>
                )}
                {outlinePdf && details.annotations.length > 0 && (
                    <span
                        className={
                            "zotflow-evo-tool zotflow-evo-details-outline-toggle" +
                            (outlineOn ? " is-on" : "")
                        }
                        role="button"
                        tabIndex={0}
                        title={
                            outlineOn
                                ? "Hide the PDF's outline among the annotations"
                                : "Show the PDF's outline among the annotations"
                        }
                        aria-pressed={outlineOn}
                        onClick={toggleOutline}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                toggleOutline();
                            }
                        }}
                    >
                        <Icon name="list-tree" fallback="list" />
                    </span>
                )}
            </div>
            {editing && details.itemType !== "note" && (
                <div className="zotflow-evo-details-editor">
                    <ItemEditor
                        libraryID={details.libraryID}
                        itemKey={details.key}
                    />
                </div>
            )}
            {details.annotations.length > 0 && (
                <div className="zotflow-evo-details-annotations">
                    {palette.length > 1 && (
                        <div className="zotflow-evo-details-annohead">
                            <span className="zotflow-evo-details-annocount">
                                {picked.length
                                    ? `${cards.length} of ${details.annotations.length}`
                                    : details.annotations.length}
                            </span>
                            <ColorSwatches
                                palette={palette}
                                current={filter.colors}
                                onToggle={filter.toggle}
                                onClear={filter.clear}
                            />
                        </div>
                    )}
                    {outlineOn && outlinePdf && outline && outline.state !== "ok" && (
                        <div className="zotflow-evo-details-outline-note">
                            {outline.state === "none"
                                ? "This PDF has no outline."
                                : "The outline shows once the PDF is on this device (opened once, or in Zotero's storage folder)."}
                        </div>
                    )}
                    {entries.map((entry, i) =>
                        entry.kind === "heading" ? (
                            <div
                                key={`h${i}`}
                                className="zotflow-evo-details-heading"
                                data-level={Math.min(entry.heading.level, 4)}
                                title={`Open at this page (${entry.heading.page + 1})`}
                                onClick={() => {
                                    if (!outlinePdf) return;
                                    void openAttachment(
                                        details.libraryID,
                                        outlinePdf.key,
                                        app,
                                        JSON.stringify({
                                            pageIndex: entry.heading.page,
                                        }),
                                    );
                                }}
                            >
                                {entry.heading.title}
                            </div>
                        ) : (
                            <AnnotationCard
                                key={entry.annotation.id}
                                annotation={entry.annotation}
                                onOpen={(c) =>
                                    openAnnotation(
                                        app,
                                        c.libraryID,
                                        c.attachmentKey,
                                        c.id,
                                    )
                                }
                            />
                        ),
                    )}
                </div>
            )}
        </div>
    );
}

/**
 * The details of one item, loaded from the worker and kept up to date.
 * `item` null shows nothing.
 */
export function useItemDetails(
    item: { libraryID: number; key: string } | null,
): EvoItemDetails | null {
    const [details, setDetails] = useState<EvoItemDetails | null>(null);
    const run = useRef(0);
    const libraryID = item?.libraryID;
    const key = item?.key;
    const load = useCallback(() => {
        const id = ++run.current;
        if (libraryID === undefined || key === undefined) {
            setDetails(null);
            return;
        }
        workerBridge.evoLibrary
            .itemDetails(libraryID, key)
            .then((d) => {
                if (id === run.current) setDetails(d);
            })
            .catch((e: unknown) =>
                services.logService.error(
                    "Failed to read the item",
                    "EvoLibrary",
                    e,
                ),
            );
    }, [libraryID, key]);
    useEffect(() => {
        // A moment's wait: arrowing through a table loads only where it stops.
        const timer = window.setTimeout(load, 80);
        return () => window.clearTimeout(timer);
    }, [load]);
    useLibraryChanges(load);
    return details;
}

/** The details in a tab of their own, following the item selected last in any table. */
export function DetailsTab({ app, leaf }: { app: App; leaf: WorkspaceLeaf }) {
    const [item, setItem] = useState(() => lastSelection());
    useEffect(() => onSelection(setItem), []);
    const details = useItemDetails(item);
    return (
        <ItemDetails
            app={app}
            leaf={leaf}
            details={details}
            count={item ? 1 : 0}
            emptyText="Select an item in a library tab."
            onShowInCollection={(libraryID, collectionKey, itemKey) =>
                void revealInLibrary(app, libraryID, collectionKey, itemKey)
            }
        />
    );
}
