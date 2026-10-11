/**
 * ZotFlow Evo (fork): where a reader opens.
 *
 * A reader always opens in a new tab. If the pane that tab would join is
 * narrower than 500 px, it opens in the most recently used pane that is wide
 * enough instead. See FORK.md.
 */
import { Platform, View } from "obsidian";

import { services } from "services/services";

import type { App, WorkspaceLeaf } from "obsidian";

/** A reader is not opened in a pane narrower than this, in pixels. */
export const MIN_READER_PANE_WIDTH = 500;

/** A pane (tab group) of the main area or of a pop-out window, as the rule below sees it. */
export interface PaneCandidate<T> {
    pane: T;
    width: number;
    /** When a tab of this pane was last active; larger is more recent. */
    lastActive: number;
}

/**
 * The pane a new reader tab goes to: the current one if it is wide enough,
 * otherwise the most recently used pane that is, otherwise the current one
 * after all (there is nowhere better).
 */
export function pickReaderPane<T>(
    current: PaneCandidate<T> | null,
    others: PaneCandidate<T>[],
    minWidth = MIN_READER_PANE_WIDTH,
): T | null {
    if (!current) return null;
    if (current.width >= minWidth) return current.pane;
    const wide = others
        .filter((c) => c.pane !== current.pane && c.width >= minWidth)
        .sort((a, b) => b.lastActive - a.lastActive);
    return wide[0]?.pane ?? current.pane;
}

function inSidebar(app: App, leaf: WorkspaceLeaf): boolean {
    const root = leaf.getRoot();
    return root === app.workspace.leftSplit || root === app.workspace.rightSplit;
}

/** The element of the tab group a leaf sits in. */
function paneEl(leaf: WorkspaceLeaf): HTMLElement | null {
    return leaf.view.containerEl.closest<HTMLElement>(".workspace-tabs");
}

function lastActive(leaf: WorkspaceLeaf): number {
    // Not in the public typings; Obsidian keeps it on every leaf.
    return (leaf as { activeTime?: number }).activeTime ?? 0;
}

/**
 * A new tab for a reader, following the rule at the top of this file. Any
 * failure to work the panes out gives Obsidian's ordinary new tab.
 */
export function newReaderLeaf(app: App): WorkspaceLeaf {
    const { workspace } = app;
    if (Platform.isMobile) return workspace.getLeaf("tab");
    try {
        const active = workspace.getActiveViewOfType(View)?.leaf ?? null;
        const currentLeaf =
            active && !inSidebar(app, active)
                ? active
                : workspace.getMostRecentLeaf();
        const currentEl = currentLeaf && paneEl(currentLeaf);
        if (!currentLeaf || !currentEl) return workspace.getLeaf("tab");

        // One candidate per pane: its most recently used tab.
        const panes = new Map<HTMLElement, PaneCandidate<WorkspaceLeaf>>();
        workspace.iterateAllLeaves((leaf) => {
            if (inSidebar(app, leaf)) return;
            const el = paneEl(leaf);
            if (!el) return;
            const known = panes.get(el);
            const at = lastActive(leaf);
            if (!known || at > known.lastActive) {
                panes.set(el, {
                    pane: leaf,
                    width: el.getBoundingClientRect().width,
                    lastActive: at,
                });
            }
        });
        const current = panes.get(currentEl) ?? {
            pane: currentLeaf,
            width: currentEl.getBoundingClientRect().width,
            lastActive: lastActive(currentLeaf),
        };
        const target = pickReaderPane(current, [...panes.values()]);
        if (target && paneEl(target) !== currentEl) {
            // A new tab joins the pane of the active leaf.
            workspace.setActiveLeaf(target, { focus: false });
        }
    } catch (e) {
        services.logService.warn(
            "Could not choose a pane for the reader; opening an ordinary new tab",
            "EvoWorkspace",
            e,
        );
    }
    return workspace.getLeaf("tab");
}

