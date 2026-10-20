/**
 * ZotFlow Evo (fork): every highlight and comment in a collection, grouped
 * by item, colour or tag and ordered within (see groupAnnotations()), with a
 * colour filter. Where the heading is not the item, each annotation names
 * its item after it. See FORK.md.
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
import { openAnnotation } from "ui/evo-library/actions";
import {
    AnnotationCard,
    ColorSwatches,
    Icon,
    Title,
    useLibraryChanges,
} from "ui/evo-library/parts";
import {
    annotationColors,
    groupAnnotations,
    itemReference,
} from "utils/evo-library-model";

import type { App } from "obsidian";
import type { CardAnnotation } from "ui/evo-library/parts";
import type {
    AnnotationGroupBy,
    AnnotationItemOrder,
    AnnotationLayout,
    AnnotationThenBy,
    EvoAnnotatedItem,
} from "utils/evo-library-model";
import type {
    EvoCollectionAnnotations,
    EvoScope,
} from "worker/services/evo-library";

export interface AnnotationBrowserProps {
    app: App;
    scope: EvoScope;
    onName: (name: string) => void;
    onSubcollections: (on: boolean) => void;
}

const GROUP_LABELS: Record<AnnotationGroupBy, string> = {
    item: "Item",
    color: "Colour",
    tag: "Tag",
};
const THEN_LABELS: Record<AnnotationThenBy, string> = {
    none: "Page",
    item: "Item",
    color: "Colour",
};
const ORDER_LABELS: Record<AnnotationItemOrder, string> = {
    title: "Title",
    dateAdded: "Date added",
};

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

export function AnnotationBrowser({
    app,
    scope,
    onName,
    onSubcollections,
}: AnnotationBrowserProps) {
    const [data, setData] = useState<EvoCollectionAnnotations | null>(null);
    const [layout, setLayoutState] = useState<AnnotationLayout>(() => ({
        ...services.settings.evoAnnotationLayout,
    }));
    const [colors, setColors] = useState<Set<string>>(() => new Set());
    const run = useRef(0);

    const load = useCallback(() => {
        const id = ++run.current;
        workerBridge.evoLibrary
            .collectionAnnotations(scope)
            .then((result) => {
                if (id === run.current) setData(result);
            })
            .catch((e: unknown) =>
                services.logService.error(
                    "Failed to read the annotations",
                    "EvoLibrary",
                    e,
                ),
            );
    }, [scope]);
    useEffect(load, [load]);
    useLibraryChanges(load, 800);
    useEffect(() => {
        if (data) onName(data.name);
    }, [data, onName]);

    const setLayout = (patch: Partial<AnnotationLayout>) => {
        setLayoutState((current) => {
            const next = { ...current, ...patch };
            // Ordering by what the headings already are says nothing.
            if (next.thenBy === next.groupBy) next.thenBy = "none";
            services.settings.evoAnnotationLayout = next;
            void services.saveSettings().catch((e: unknown) => {
                services.logService.error(
                    "Failed to save the annotation browser settings",
                    "EvoLibrary",
                    e,
                );
            });
            return next;
        });
    };

    const items = useMemo(
        () =>
            new Map<string, EvoAnnotatedItem>(
                (data?.items ?? []).map((i) => [i.key, i]),
            ),
        [data],
    );
    const groups = useMemo(
        () =>
            data
                ? groupAnnotations(data.annotations, items, layout, colors)
                : [],
        [data, items, layout, colors],
    );
    const palette = useMemo(
        () => annotationColors(data?.annotations ?? []),
        [data],
    );
    const total = groups.reduce((n, g) => n + g.annotations.length, 0);

    const toggleColor = (hex: string) =>
        setColors((current) => {
            const next = new Set(current);
            if (!next.delete(hex)) next.add(hex);
            return next;
        });

    const open = (a: CardAnnotation) =>
        openAnnotation(app, a.libraryID, a.attachmentKey, a.id);

    return (
        <div className="zotflow-evo-annos">
            <div className="zotflow-evo-colltab-title" title={data?.name}>
                {data?.name ?? ""}
                <span className="zotflow-evo-annos-count">
                    {data ? total : ""}
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
                    label="then"
                    value={layout.thenBy}
                    options={THEN_LABELS}
                    onChange={(thenBy) => setLayout({ thenBy })}
                />
                <Select
                    label="Items by"
                    value={layout.itemOrder}
                    options={ORDER_LABELS}
                    onChange={(itemOrder) => setLayout({ itemOrder })}
                />
                <span
                    className="zotflow-evo-tool"
                    title={
                        layout.descending
                            ? "Descending (newest, Z first)"
                            : "Ascending (oldest, A first)"
                    }
                    aria-pressed={!!layout.descending}
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
                <span
                    className={
                        "zotflow-evo-tool" +
                        (scope.subcollections ? " is-on" : "")
                    }
                    title="Include sub-collections"
                    aria-pressed={scope.subcollections}
                    onClick={() => onSubcollections(!scope.subcollections)}
                >
                    <Icon name="folder-tree" />
                </span>
                <ColorSwatches
                    palette={palette}
                    current={colors}
                    onToggle={toggleColor}
                />
            </div>
            <div className="zotflow-evo-annos-list">
                {!data && (
                    <div className="zotflow-evo-table-empty">Loading…</div>
                )}
                {data && groups.length === 0 && (
                    <div className="zotflow-evo-table-empty">
                        {colors.size
                            ? "Nothing in this colour."
                            : "No annotations in this collection."}
                    </div>
                )}
                {groups.map((group) => (
                    <section key={group.id} className="zotflow-evo-annos-group">
                        <div className="zotflow-evo-annos-heading">
                            {group.color && (
                                <span
                                    className="zotflow-evo-dot is-static"
                                    style={
                                        {
                                            "--zotflow-evo-color": group.color,
                                        } as React.CSSProperties
                                    }
                                />
                            )}
                            <span className="zotflow-evo-annos-heading-label">
                                <Title text={group.label} />
                            </span>
                            {group.detail && (
                                <span className="zotflow-evo-annos-heading-detail">
                                    {group.detail}
                                </span>
                            )}
                            <span className="zotflow-evo-annos-heading-count">
                                {group.annotations.length}
                            </span>
                        </div>
                        {group.annotations.map((a) => (
                            <AnnotationCard
                                key={group.id + a.id}
                                annotation={a}
                                reference={
                                    group.showsItem
                                        ? itemReference(items.get(a.itemKey))
                                        : undefined
                                }
                                onOpen={open}
                            />
                        ))}
                    </section>
                ))}
            </div>
        </div>
    );
}
