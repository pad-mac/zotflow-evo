/**
 * ZotFlow Evo (fork): the library browser's right pane — the item's title,
 * its first two authors and year, where it was published, its abstract,
 * and below a line the annotations of the file it opens. See FORK.md.
 */
import React from "react";

import { AnnotationCard, Icon } from "ui/evo-library/parts";

import type { CardAnnotation } from "ui/evo-library/parts";
import type { EvoItemDetails } from "worker/services/evo-library";

const KIND_LABEL: Record<string, string> = {
    pdf: "PDF",
    epub: "EPUB",
    snapshot: "Web snapshot",
    link: "Link",
    other: "File",
};

const KIND_ICON: Record<string, string> = {
    pdf: "file-text",
    epub: "book-open",
    snapshot: "globe",
    link: "link",
    other: "file",
};

export interface ItemDetailsProps {
    details: EvoItemDetails | null;
    /** How many items are selected (the pane shows the focused one). */
    count: number;
    onOpenAttachment: (attachmentKey: string) => void;
    onOpenAnnotation: (annotation: CardAnnotation) => void;
    onSearch: () => void;
}

export function ItemDetails({
    details,
    count,
    onOpenAttachment,
    onOpenAnnotation,
    onSearch,
}: ItemDetailsProps) {
    if (!details) {
        return (
            <div className="zotflow-evo-details is-empty">
                {count > 1 ? `${count} items selected` : "No item selected"}
            </div>
        );
    }
    const byline = [
        details.authors.join(", ") + (details.moreAuthors ? " et al." : ""),
        details.year ? `(${details.year})` : "",
    ]
        .filter((s) => s.trim())
        .join(" ");
    const openable = details.attachments.filter(
        (a) => a.kind === "pdf" || a.kind === "epub" || a.kind === "snapshot",
    );
    const regular =
        details.itemType !== "attachment" && details.itemType !== "note";
    const cards: CardAnnotation[] = details.annotations.map((a) => ({
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
    return (
        <div className="zotflow-evo-details">
            <div className="zotflow-evo-details-head">
                <div className="zotflow-evo-details-title">{details.title}</div>
                {byline && (
                    <div className="zotflow-evo-details-byline">{byline}</div>
                )}
                {details.publication && (
                    <div className="zotflow-evo-details-pub">
                        {details.publication}
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
                                        : "")
                                }
                                title={`${KIND_LABEL[a.kind]}: ${a.title}`}
                                onClick={() => onOpenAttachment(a.key)}
                            >
                                <Icon name={KIND_ICON[a.kind] ?? "file"} />
                                <span className="zotflow-evo-details-file-name">
                                    {a.title}
                                </span>
                            </span>
                        ))}
                        {regular && openable.length === 0 && (
                            <span
                                className="zotflow-evo-details-file is-search"
                                title="Search for the file"
                                onClick={onSearch}
                            >
                                <Icon name="search" />
                                <span className="zotflow-evo-details-file-name">
                                    Search for the file
                                </span>
                            </span>
                        )}
                    </div>
                )}
                {details.abstract && (
                    <div className="zotflow-evo-details-abstract">
                        {details.abstract}
                    </div>
                )}
            </div>
            {cards.length > 0 && (
                <div className="zotflow-evo-details-annotations">
                    {cards.map((card) => (
                        <AnnotationCard
                            key={card.id}
                            annotation={card}
                            onOpen={onOpenAnnotation}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}
