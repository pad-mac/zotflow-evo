import type { EditorView } from "@codemirror/view";
import type { Editor, EditorPosition } from "obsidian";

/**
 * ZotFlow Evo: where a drop lands in a note — the place under the pointer.
 * Obsidian fires `editor-drop` before it moves the cursor there, and does
 * not move it at all once a handler has claimed the drop (app.js: the
 * selection is set from `posAtCoords` after the event, only when not
 * prevented), so the cursor is still where it last was. It is moved to the
 * drop now, as Obsidian would, so a later look at the cursor (a drop that
 * resolves its text first) finds the drop too.
 */
export function takeDropPosition(evt: DragEvent, editor: Editor): EditorPosition {
    // The note's CodeMirror view (Obsidian's Editor keeps it as `cm`).
    const cm = (editor as Editor & { cm?: EditorView }).cm;
    const offset =
        cm && Number.isFinite(evt.clientX) && Number.isFinite(evt.clientY)
            ? cm.posAtCoords({ x: evt.clientX, y: evt.clientY }, false)
            : null;
    if (offset === null || offset === undefined) return editor.getCursor();
    const pos = editor.offsetToPos(offset);
    editor.setCursor(pos);
    return pos;
}
