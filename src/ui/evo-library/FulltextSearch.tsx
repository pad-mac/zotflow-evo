/**
 * ZotFlow Evo (fork): full-text search over chosen collections. The index
 * is Zotero's own (fulltext-engine.ts); the documents it finds are checked
 * in their text (case, whole words) and shown as snippets, grouped and
 * ordered like the annotation browser. A click opens the document with the
 * reader's search set to the query. See FORK.md, "Full-text search".
 */
import { FuzzySuggestModal } from "obsidian";
import React, {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react";

import { workerBridge } from "bridge";
import { services } from "services/services";
import { fulltextEngine } from "ui/evo-library/fulltext-engine";
import { Icon, Title } from "ui/evo-library/parts";
import {
    DEFAULT_FULLTEXT_LAYOUT,
    groupHits,
    hitLabel,
    orderHits,
} from "utils/evo-fulltext";
import { openAttachment } from "utils/viewer";

import type { App } from "obsidian";
import type {
    FulltextGroupBy,
    FulltextHit,
    FulltextItem,
    FulltextLayout,
    FulltextOrder,
    FulltextSpec,
    Snippet,
} from "utils/evo-fulltext";
import type {
    EvoCollectionNode,
    EvoLibraryNode,
} from "worker/services/evo-library";

/** A library (collectionKey null) or collection searched in. */
export interface FulltextScope {
    libraryID: number;
    collectionKey: string | null;
}

/** At most this many documents are checked and listed (best first). */
const MAX_DOCUMENTS = 1000;
/** Documents checked at once. */
const PARALLEL = 6;
/** Snippets shown per document before "more". */
const SNIPPETS_SHOWN = 3;
/** Groups rendered at first, and added each time the end comes into view. */
const PAGE = 40;

const GROUP_LABELS: Record<FulltextGroupBy, string> = {
    item: "Item",
    tag: "Tag",
    none: "None",
};
const ORDER_LABELS: Record<FulltextOrder, string> = {
    relevance: "Relevance",
    title: "Title",
    dateAdded: "Date added",
    year: "Year",
};

function saveSettings() {
    void services
        .saveSettings()
        .catch((e: unknown) =>
            services.logService.error(
                "Failed to save the full-text search settings",
                "EvoFulltext",
                e,
            ),
        );
}

const scopeId = (s: FulltextScope) => `${s.libraryID}:${s.collectionKey ?? ""}`;

interface Choice extends FulltextScope {
    path: string;
}

/** Every library and collection, as "My Library / Media theory / Kittler". */
function choices(libraries: EvoLibraryNode[]): Choice[] {
    const out: Choice[] = [];
    for (const lib of libraries) {
        out.push({
            libraryID: lib.libraryID,
            collectionKey: null,
            path: lib.name,
        });
        const walk = (nodes: EvoCollectionNode[], prefix: string) => {
            for (const n of nodes) {
                const path = `${prefix} / ${n.name}`;
                out.push({
                    libraryID: n.libraryID,
                    collectionKey: n.key,
                    path,
                });
                walk(n.children, path);
            }
        };
        walk(lib.collections, lib.name);
    }
    return out;
}

class ScopeModal extends FuzzySuggestModal<Choice> {
    constructor(
        app: App,
        private readonly items: Choice[],
        private readonly onChoose: (choice: Choice) => void,
    ) {
        super(app);
        this.setPlaceholder("Add a library or collection to search in");
    }
    getItems() {
        return this.items;
    }
    getItemText(item: Choice) {
        return item.path;
    }
    onChooseItem(item: Choice) {
        this.onChoose(item);
    }
}

/** Where a document's checking stands. */
type Checked =
    | { state: "pending" }
    | { state: "none" }
    | { state: "found"; total: number; snippets: Snippet[] }
    | { state: "notext" };

function Select<T extends string>({
    label,
    value,
    options,
    onChange,
}: {
    label: string;
    value: T;
    options: Record<T, string>;
    onChange: (value: T) => void;
}) {
    return (
        <label className="zotflow-evo-select">
            <span className="zotflow-evo-select-label">{label}</span>
            <select
                className="dropdown"
                value={value}
                onChange={(e) => onChange(e.target.value as T)}
            >
                {(Object.keys(options) as T[]).map((k) => (
                    <option key={k} value={k}>
                        {options[k]}
                    </option>
                ))}
            </select>
        </label>
    );
}

function SnippetView({
    snippet,
    label,
    onOpen,
}: {
    snippet: Snippet;
    label?: string;
    onOpen: () => void;
}) {
    // The lines around the first match in view: it stands in the middle,
    // whole lines above and below it.
    const textRef = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        const box = textRef.current;
        const mark = box?.querySelector("mark");
        if (!box || !mark) return;
        const line = parseFloat(getComputedStyle(box).lineHeight) || 20;
        const centred =
            mark.offsetTop - (box.clientHeight - mark.offsetHeight) / 2;
        box.scrollTop = Math.max(0, Math.round(centred / line) * line);
    }, [snippet]);
    return (
        <div className="zotflow-evo-fts-snippet" onClick={onOpen}>
            {(label || snippet.pageIndex !== null) && (
                <div className="zotflow-evo-fts-label">
                    <span className="zotflow-evo-fts-label-text">{label}</span>
                    {snippet.pageIndex !== null && (
                        <span className="zotflow-evo-fts-page">
                            p. {snippet.pageIndex + 1}
                        </span>
                    )}
                </div>
            )}
            <div className="zotflow-evo-fts-text" ref={textRef}>
                {snippet.parts.map((part, i) =>
                    part.hit ? (
                        <mark key={i} className="zotflow-evo-fts-hit">
                            {part.text}
                        </mark>
                    ) : (
                        <React.Fragment key={i}>{part.text}</React.Fragment>
                    ),
                )}
            </div>
        </div>
    );
}

function HitView({
    hit,
    checked,
    label,
    onOpen,
}: {
    hit: FulltextHit;
    checked: Checked | undefined;
    label?: string;
    onOpen: (hit: FulltextHit, snippet: Snippet | null) => void;
}) {
    const [all, setAll] = useState(false);
    if (!checked || checked.state === "pending" || checked.state === "none")
        return null;
    if (checked.state === "notext") {
        return (
            <div
                className="zotflow-evo-fts-snippet is-notext"
                onClick={() => onOpen(hit, null)}
            >
                {label && <div className="zotflow-evo-fts-label">{label}</div>}
                <div className="zotflow-evo-fts-text">
                    In Zotero's index; its text is not on this computer.
                </div>
            </div>
        );
    }
    const shown = all
        ? checked.snippets
        : checked.snippets.slice(0, SNIPPETS_SHOWN);
    const more =
        checked.total -
        shown.reduce((n, s) => n + s.parts.filter((p) => p.hit).length, 0);
    return (
        <>
            {shown.map((snippet, i) => (
                <SnippetView
                    key={i}
                    snippet={snippet}
                    label={i === 0 ? label : undefined}
                    onOpen={() => onOpen(hit, snippet)}
                />
            ))}
            {!all && more > 0 && (
                <div
                    className="zotflow-evo-fts-more"
                    onClick={() => setAll(true)}
                >
                    <Icon name="chevrons-down" />
                    <span>{more} more in this document</span>
                </div>
            )}
        </>
    );
}

export interface FulltextSearchProps {
    app: App;
    initialScopes: FulltextScope[];
    initialQuery: string;
    onState: (state: { scopes: FulltextScope[]; query: string }) => void;
}

export function FulltextSearch({
    app,
    initialScopes,
    initialQuery,
    onState,
}: FulltextSearchProps) {
    const settings = services.settings;
    const [libraries, setLibraries] = useState<EvoLibraryNode[]>([]);
    const [scopes, setScopes] = useState<FulltextScope[]>(initialScopes);
    const [subcollections, setSubcollections] = useState(
        settings.evoLibrarySubcollections,
    );
    const [query, setQuery] = useState(initialQuery);
    const [matchCase, setMatchCase] = useState(settings.evoFulltextMatchCase);
    const [wholeWords, setWholeWords] = useState(
        settings.evoFulltextWholeWords,
    );
    const [layout, setLayoutState] = useState<FulltextLayout>(() => ({
        ...DEFAULT_FULLTEXT_LAYOUT,
        ...settings.evoFulltextLayout,
    }));
    const [items, setItems] = useState<Map<string, FulltextItem> | null>(null);
    const [hits, setHits] = useState<FulltextHit[]>([]);
    const [checked, setChecked] = useState<Map<number, Checked>>(new Map());
    const [status, setStatus] = useState<string>("");
    const [error, setError] = useState<string | null>(null);
    const [shownGroups, setShownGroups] = useState(PAGE);
    const run = useRef(0);
    const inputRef = useRef<HTMLInputElement>(null);

    // The engine runs while this view is open.
    useEffect(() => {
        fulltextEngine.acquire();
        return () => fulltextEngine.release();
    }, []);

    useEffect(() => {
        workerBridge.evoLibrary
            .getCollectionTree()
            .then((list) => {
                setLibraries(list);
                setScopes((current) =>
                    current.length
                        ? current
                        : list[0]
                          ? [
                                {
                                    libraryID: list[0].libraryID,
                                    collectionKey: null,
                                },
                            ]
                          : [],
                );
            })
            .catch((e: unknown) =>
                services.logService.error(
                    "Failed to read the collections",
                    "EvoFulltext",
                    e,
                ),
            );
        window.setTimeout(() => inputRef.current?.focus(), 50);
    }, []);

    useEffect(() => {
        onState({ scopes, query });
    }, [scopes, query, onState]);

    // The items of the chosen collections, to keep and to label hits.
    useEffect(() => {
        let gone = false;
        setItems(null);
        void Promise.all(
            scopes.map((s) =>
                workerBridge.evoLibrary.listItems({ ...s, subcollections }),
            ),
        )
            .then((lists) => {
                if (gone) return;
                const map = new Map<string, FulltextItem>();
                for (const rows of lists)
                    for (const r of rows)
                        map.set(`${r.libraryID}:${r.key}`, {
                            title: r.title,
                            shortTitle: r.shortTitle ?? "",
                            lastName: r.firstLastName ?? "",
                            year: r.year,
                            dateAdded: r.dateAdded,
                            tags: r.tags,
                        });
                setItems(map);
            })
            .catch((e: unknown) =>
                services.logService.error(
                    "Failed to list the items to search",
                    "EvoFulltext",
                    e,
                ),
            );
        return () => {
            gone = true;
        };
    }, [scopes, subcollections]);

    const spec = useMemo<FulltextSpec>(
        () => ({ query: query.trim(), matchCase, wholeWords }),
        [query, matchCase, wholeWords],
    );

    // Search: the index's candidates, kept to the chosen collections, then
    // each document checked in its text (best first, a few at a time).
    useEffect(() => {
        const id = ++run.current;
        setHits([]);
        setChecked(new Map());
        setError(null);
        setShownGroups(PAGE);
        if (!spec.query || !items) {
            setStatus(items ? "" : "Reading the collections…");
            return undefined;
        }
        const timer = window.setTimeout(() => {
            void (async () => {
                try {
                    setStatus("Reading Zotero's index…");
                    const all = await fulltextEngine.search(spec);
                    if (id !== run.current) return;
                    const kept = all
                        .filter((h) => items.has(`${h.libraryID}:${h.itemKey}`))
                        .slice(0, MAX_DOCUMENTS);
                    setHits(kept);
                    const results = new Map<number, Checked>();
                    for (const h of kept)
                        results.set(h.itemID, { state: "pending" });
                    setChecked(new Map(results));
                    let done = 0;
                    let next = 0;
                    const report = () =>
                        setStatus(
                            done < kept.length
                                ? `Checking ${done} of ${kept.length} documents…`
                                : "",
                        );
                    report();
                    const work = async () => {
                        while (next < kept.length) {
                            const h = kept[next++]!;
                            let result: Checked;
                            try {
                                const found = await fulltextEngine.snippets(
                                    h.attachmentKey,
                                    spec,
                                    60,
                                );
                                result = !found
                                    ? { state: "notext" }
                                    : found.total
                                      ? { state: "found", ...found }
                                      : { state: "none" };
                            } catch {
                                result = { state: "notext" };
                            }
                            if (id !== run.current) return;
                            results.set(h.itemID, result);
                            done++;
                            // Redraw now and then, not per document.
                            if (done % 8 === 0 || done === kept.length) {
                                setChecked(new Map(results));
                                report();
                            }
                        }
                    };
                    await Promise.all(
                        Array.from({ length: PARALLEL }, () => work()),
                    );
                } catch (e) {
                    if (id !== run.current) return;
                    setStatus("");
                    setError(e instanceof Error ? e.message : String(e));
                }
            })();
        }, 350);
        return () => window.clearTimeout(timer);
    }, [spec, items]);

    const setLayout = (patch: Partial<FulltextLayout>) =>
        setLayoutState((current) => {
            const next = { ...current, ...patch };
            settings.evoFulltextLayout = next;
            saveSettings();
            return next;
        });

    const toggleCase = () =>
        setMatchCase((on) => {
            settings.evoFulltextMatchCase = !on;
            saveSettings();
            return !on;
        });
    const toggleWhole = () =>
        setWholeWords((on) => {
            settings.evoFulltextWholeWords = !on;
            saveSettings();
            return !on;
        });

    const visibleHits = useMemo(
        () =>
            hits.filter((h) => {
                // Shown once checked: found, or no text here to check.
                const c = checked.get(h.itemID);
                return c?.state === "found" || c?.state === "notext";
            }),
        [hits, checked],
    );
    const groups = useMemo(
        () =>
            items
                ? groupHits(
                      orderHits(visibleHits, items, layout),
                      items,
                      layout.groupBy,
                  )
                : [],
        [visibleHits, items, layout],
    );
    const matchCount = useMemo(() => {
        let n = 0;
        for (const c of checked.values()) if (c.state === "found") n += c.total;
        return n;
    }, [checked]);
    const documentCount = useMemo(
        () =>
            new Set(visibleHits.map((h) => `${h.libraryID}:${h.itemKey}`)).size,
        [visibleHits],
    );

    const open = useCallback(
        (hit: FulltextHit, snippet: Snippet | null) => {
            const navigation: Record<string, unknown> = {
                evoFind: {
                    query: spec.query,
                    caseSensitive: spec.matchCase,
                    entireWord: spec.wholeWords,
                },
            };
            if (snippet?.pageIndex !== null && snippet?.pageIndex !== undefined)
                navigation.pageIndex = snippet.pageIndex;
            void openAttachment(
                hit.libraryID,
                hit.attachmentKey,
                app,
                JSON.stringify(navigation),
            ).catch((e: unknown) =>
                services.logService.error(
                    "Failed to open the document",
                    "EvoFulltext",
                    e,
                ),
            );
        },
        [app, spec],
    );

    // More groups as the end of the list comes into view.
    const endRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const el = endRef.current;
        if (!el) return undefined;
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((e) => e.isIntersecting))
                    setShownGroups((n) => n + PAGE);
            },
            { rootMargin: "400px 0px" },
        );
        observer.observe(el);
        return () => observer.disconnect();
    }, [groups.length]);

    const names = useMemo(() => {
        const map = new Map<string, string>();
        for (const c of choices(libraries)) map.set(scopeId(c), c.path);
        return map;
    }, [libraries]);

    const addScope = () =>
        new ScopeModal(app, choices(libraries), (choice) =>
            setScopes((current) =>
                current.some((s) => scopeId(s) === scopeId(choice))
                    ? current
                    : [
                          ...current,
                          {
                              libraryID: choice.libraryID,
                              collectionKey: choice.collectionKey,
                          },
                      ],
            ),
        ).open();

    return (
        <div className="zotflow-evo-fts">
            <div className="zotflow-evo-colltab-title">
                Full-text search
                <span className="zotflow-evo-annos-count">
                    {spec.query && items
                        ? `${documentCount} ${documentCount === 1 ? "document" : "documents"} · ${matchCount} ${matchCount === 1 ? "match" : "matches"}`
                        : ""}
                </span>
            </div>
            <div className="zotflow-evo-fts-scopes">
                {scopes.map((s) => (
                    <span key={scopeId(s)} className="zotflow-evo-chip">
                        <span className="zotflow-evo-chip-name">
                            {(names.get(scopeId(s)) ?? "…").split(" / ").pop()}
                        </span>
                        <span
                            className="zotflow-evo-chip-remove"
                            title="Remove"
                            onClick={() =>
                                setScopes((current) =>
                                    current.filter(
                                        (o) => scopeId(o) !== scopeId(s),
                                    ),
                                )
                            }
                        >
                            <Icon name="x" />
                        </span>
                    </span>
                ))}
                <span
                    className="zotflow-evo-tool"
                    title="Add a library or collection"
                    onClick={addScope}
                >
                    <Icon name="plus" />
                </span>
                <span
                    className={
                        "zotflow-evo-tool" + (subcollections ? " is-on" : "")
                    }
                    title="Include sub-collections"
                    aria-pressed={subcollections}
                    onClick={() => setSubcollections((on) => !on)}
                >
                    <Icon name="folder-tree" />
                </span>
            </div>
            <div className="zotflow-evo-toolbar">
                <input
                    ref={inputRef}
                    className="zotflow-evo-filter zotflow-evo-fts-input"
                    type="search"
                    placeholder="Search the text of the documents"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                />
                <span
                    className={"zotflow-evo-tool" + (matchCase ? " is-on" : "")}
                    title="Match case"
                    aria-pressed={matchCase}
                    onClick={toggleCase}
                >
                    <Icon name="case-sensitive" fallback="type" />
                </span>
                <span
                    className={
                        "zotflow-evo-tool" + (wholeWords ? " is-on" : "")
                    }
                    title="Whole words"
                    aria-pressed={wholeWords}
                    onClick={toggleWhole}
                >
                    <Icon name="whole-word" fallback="text-select" />
                </span>
            </div>
            <div className="zotflow-evo-toolbar is-wrapping">
                <Select
                    label="Group by"
                    value={layout.groupBy}
                    options={GROUP_LABELS}
                    onChange={(groupBy) => setLayout({ groupBy })}
                />
                <Select
                    label="Order"
                    value={layout.order}
                    options={ORDER_LABELS}
                    onChange={(order) => setLayout({ order })}
                />
                <span
                    className="zotflow-evo-tool"
                    title={layout.descending ? "Descending" : "Ascending"}
                    onClick={() =>
                        setLayout({ descending: !layout.descending })
                    }
                >
                    <Icon
                        name={
                            layout.descending
                                ? "arrow-down-wide-narrow"
                                : "arrow-up-narrow-wide"
                        }
                        fallback={layout.descending ? "arrow-down" : "arrow-up"}
                    />
                </span>
            </div>
            {(status || error) && (
                <div
                    className={
                        "zotflow-evo-fts-status" + (error ? " is-error" : "")
                    }
                >
                    {error ?? status}
                </div>
            )}
            <div className="zotflow-evo-annos-list zotflow-evo-fts-list">
                {spec.query &&
                    !status &&
                    !error &&
                    items &&
                    groups.length === 0 && (
                        <div className="zotflow-evo-table-empty">
                            Nothing found.
                        </div>
                    )}
                {groups.slice(0, shownGroups).map((group) => (
                    <section key={group.id} className="zotflow-evo-annos-group">
                        {group.label && (
                            <div className="zotflow-evo-annos-heading">
                                <span className="zotflow-evo-annos-heading-label">
                                    <Title text={group.label} />
                                </span>
                                {group.detail && (
                                    <span className="zotflow-evo-annos-heading-detail">
                                        {group.detail}
                                    </span>
                                )}
                            </div>
                        )}
                        {group.hits.map((hit) => (
                            <HitView
                                key={group.id + hit.itemID}
                                hit={hit}
                                checked={checked.get(hit.itemID)}
                                label={
                                    group.showsItem
                                        ? hitLabel(
                                              items?.get(
                                                  `${hit.libraryID}:${hit.itemKey}`,
                                              ),
                                          )
                                        : undefined
                                }
                                onOpen={open}
                            />
                        ))}
                    </section>
                ))}
                <div ref={endRef} />
            </div>
        </div>
    );
}
