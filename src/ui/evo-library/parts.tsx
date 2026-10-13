/**
 * ZotFlow Evo (fork): small pieces the library browser, the collection tabs
 * and the annotation browser share — an icon, a comment rendered as
 * markdown, an annotation card (as in the reader's note strip), a hook that
 * follows changes to the library. See FORK.md.
 */
import { Component, MarkdownRenderer, setIcon } from "obsidian";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

import { services } from "services/services";
import { setAnnotationDrag } from "ui/evo-library/actions";

import type { DraggedAnnotation } from "ui/evo-library/actions";

export function Icon({
    name,
    className,
}: {
    name: string;
    className?: string;
}) {
    const ref = useRef<HTMLSpanElement>(null);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        el.empty();
        setIcon(el, name);
    }, [name]);
    return (
        <span
            ref={ref}
            className={"zotflow-evo-icon" + (className ? " " + className : "")}
            aria-hidden="true"
        />
    );
}

/**
 * A comment as Obsidian renders markdown. Rendered once it comes near the
 * screen: lists can hold thousands of them.
 */
export function Markdown({ text }: { text: string }) {
    const ref = useRef<HTMLDivElement>(null);
    const [seen, setSeen] = useState(false);

    useEffect(() => {
        if (seen) return undefined;
        const el = ref.current;
        if (!el) return undefined;
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((e) => e.isIntersecting)) setSeen(true);
            },
            { rootMargin: "600px 0px" },
        );
        observer.observe(el);
        return () => observer.disconnect();
    }, [seen]);

    useEffect(() => {
        const el = ref.current;
        if (!seen || !el) return undefined;
        const component = new Component();
        component.load();
        el.empty();
        void MarkdownRenderer.render(services.app, text, el, "", component);
        return () => component.unload();
    }, [seen, text]);

    return (
        <div ref={ref} className="zotflow-evo-md markdown-rendered">
            {seen ? null : text}
        </div>
    );
}

/** An annotation as the cards show it. */
export interface CardAnnotation extends DraggedAnnotation {
    /** The top-level item. */
    itemKey: string;
}

/**
 * One annotation, drawn as in the reader's note strip: the page number in
 * front, what was marked with one bar in its colour, the comment with two.
 * A click opens the document there; a row dragged into a note drops the
 * highlight (or the comment) as from the reader. With Alt held, a press
 * selects text instead of dragging.
 */
export function AnnotationCard({
    annotation,
    reference,
    onOpen,
}: {
    annotation: CardAnnotation;
    /** After the text: which item it is from, where the heading does not say. */
    reference?: string;
    onOpen: (annotation: CardAnnotation) => void;
}) {
    const text = (annotation.text ?? "").trim();
    const comment = (annotation.comment ?? "").trim();
    const page = annotation.pageLabel ? (
        <span className="zotflow-evo-card-page">{annotation.pageLabel}</span>
    ) : null;

    function handleClick(event: React.MouseEvent) {
        const selection = window.getSelection();
        if (
            selection &&
            !selection.isCollapsed &&
            event.currentTarget.contains(selection.anchorNode)
        )
            return;
        onOpen(annotation);
    }

    function handlePointerDown(event: React.PointerEvent) {
        if (!event.altKey || event.button !== 0) return;
        const row = (event.target as HTMLElement).closest<HTMLElement>(
            ".zotflow-evo-card-row",
        );
        if (!row) return;
        row.draggable = false;
        const restore = () => {
            document.removeEventListener("pointerup", restore, true);
            row.draggable = true;
        };
        document.addEventListener("pointerup", restore, true);
    }

    function drag(event: React.DragEvent, source: "highlight" | "comment") {
        event.stopPropagation();
        setAnnotationDrag(
            event.dataTransfer,
            annotation,
            annotation.itemKey,
            source,
        );
    }

    return (
        <div
            className="zotflow-evo-card"
            style={
                {
                    "--zotflow-evo-color": annotation.color || "#ffd400",
                } as React.CSSProperties
            }
            onClick={handleClick}
            onPointerDownCapture={handlePointerDown}
            data-annotation-id={annotation.id}
        >
            {text && (
                <div
                    className="zotflow-evo-card-row is-highlight"
                    draggable
                    onDragStart={(e) => drag(e, "highlight")}
                >
                    <span className="zotflow-evo-card-bars" aria-hidden="true">
                        <span className="zotflow-evo-card-bar" />
                    </span>
                    <div className="zotflow-evo-card-text">
                        {page}
                        {text}
                    </div>
                </div>
            )}
            {comment && (
                <div
                    className="zotflow-evo-card-row is-comment"
                    draggable
                    onDragStart={(e) => drag(e, "comment")}
                >
                    <span className="zotflow-evo-card-bars" aria-hidden="true">
                        <span className="zotflow-evo-card-bar" />
                        <span className="zotflow-evo-card-bar" />
                    </span>
                    <div className="zotflow-evo-card-text">
                        {!text && page}
                        <Markdown text={comment} />
                    </div>
                </div>
            )}
            {reference && (
                <div className="zotflow-evo-card-ref">{reference}</div>
            )}
        </div>
    );
}

/**
 * Call `refresh` after the library changed (a sync, an edit, an annotation
 * saved), at most every `delay` ms.
 */
export function useLibraryChanges(refresh: () => void, delay = 400) {
    const latest = useRef(refresh);
    latest.current = refresh;
    useEffect(() => {
        let timer: number | null = null;
        const schedule = () => {
            if (timer !== null) window.clearTimeout(timer);
            timer = window.setTimeout(() => {
                timer = null;
                latest.current();
            }, delay);
        };
        const hub = services.eventHub;
        const offs = [
            hub.treeChanged.subscribe(schedule),
            hub.syncFinished.subscribe(schedule),
            hub.annotationChanged.subscribe(schedule),
        ];
        return () => {
            if (timer !== null) window.clearTimeout(timer);
            offs.forEach((off) => off());
        };
    }, [delay]);
}
