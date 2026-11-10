/**
 * Stub for the `obsidian` module.
 *
 * The worker layer under test imports Obsidian only for types, which erase at
 * compile time. This exists so that any transitive runtime import resolves to
 * something inert instead of failing to resolve — and fails loudly if a test
 * ever actually depends on Obsidian behaviour.
 */

function notAvailable(name: string): never {
    throw new Error(
        `obsidian.${name} was called in a test. The module under test reaches ` +
            `into the Obsidian runtime — inject a fake instead of relying on this stub.`,
    );
}

export class Notice {
    constructor() {
        notAvailable("Notice");
    }
}

export class Modal {
    constructor() {
        notAvailable("Modal");
    }
}

export function requestUrl(): never {
    return notAvailable("requestUrl");
}

export function normalizePath(path: string): string {
    return path.replace(/\\/g, "/").replace(/\/+/g, "/");
}

export const Platform = {
    isDesktopApp: false,
    isMobileApp: false,
    isAndroidApp: false,
};

/* ------------------------------------------------------------------ */
/*  Main-thread additions                                             */
/*                                                                    */
/*  `src/ui/reader/*` and `src/utils/file.ts` import these as VALUES, */
/*  not just types — an `instanceof TFile` check or a `new Component()`*/
/*  has to work for the module to even load. Kept to the minimum       */
/*  surface the code under test actually touches.                     */
/* ------------------------------------------------------------------ */

/** `App` is an interface in the real API; exported only so value imports resolve. */
export const App = undefined as unknown as never;

export class TAbstractFile {
    path = "";
    name = "";
}

export class TFile extends TAbstractFile {
    extension = "";
    basename = "";
}

export class TFolder extends TAbstractFile {
    children: TAbstractFile[] = [];
}

/**
 * Minimal `Component` — real lifecycle semantics (load/unload, child
 * registration) because the reader bridge relies on unload actually running.
 */
export class Component {
    loaded = false;
    private children: Component[] = [];
    private onUnloadCallbacks: Array<() => unknown> = [];

    load() {
        this.loaded = true;
        for (const child of this.children) child.load();
        this.onload();
    }
    onload() {}
    unload() {
        this.loaded = false;
        while (this.children.length) this.children.pop()!.unload();
        while (this.onUnloadCallbacks.length) this.onUnloadCallbacks.pop()!();
        this.onunload();
    }
    onunload() {}
    addChild<T extends Component>(child: T): T {
        this.children.push(child);
        if (this.loaded) child.load();
        return child;
    }
    removeChild<T extends Component>(child: T): T {
        const i = this.children.indexOf(child);
        if (i !== -1) this.children.splice(i, 1);
        child.unload();
        return child;
    }
    register(cb: () => unknown) {
        this.onUnloadCallbacks.push(cb);
    }
}

export class Scope {
    register() {
        return {};
    }
    unregister() {}
}

/**
 * Records what was asked to be rendered instead of running Obsidian's
 * markdown pipeline. Tests read `MarkdownRenderer.calls`.
 */
export const MarkdownRenderer = {
    calls: [] as Array<{ markdown: string; sourcePath: string }>,
    render(
        _app: unknown,
        markdown: string,
        _el: unknown,
        sourcePath: string,
        _component: unknown,
    ): Promise<void> {
        MarkdownRenderer.calls.push({ markdown, sourcePath });
        return Promise.resolve();
    },
    reset() {
        MarkdownRenderer.calls.length = 0;
    },
};

/** ZotFlow Evo: Obsidian's `parseLinktext`, enough for links without aliases. */
export function parseLinktext(linktext: string): { path: string; subpath: string } {
    const at = linktext.indexOf("#");
    return at === -1
        ? { path: linktext, subpath: "" }
        : { path: linktext.slice(0, at), subpath: linktext.slice(at) };
}

/** ZotFlow Evo: `setIcon` — nothing drawn. */
export function setIcon(): void {}

/** ZotFlow Evo: a markdown view — only a type to look for. */
export class MarkdownView {}

/**
 * ZotFlow Evo: Obsidian's `EditorSuggest`, as far as a picker test needs:
 * `trigger()` as Obsidian's own (app.js: no trigger with a selection; the
 * context from `onTrigger`; suggestions fetched when open or forced),
 * `isOpen`, and what was shown (`shown`).
 */
type StubPos = { line: number; ch: number };
type StubEditor = { getCursor(which?: string): StubPos };
export class EditorSuggest<T> {
    context: { editor: StubEditor; file: unknown; start: StubPos; end: StubPos; query: string } | null = null;
    limit = 0;
    isOpen = false;
    shown: T[] = [];
    constructor(public app: unknown) {}
    onTrigger(_c: StubPos, _e: StubEditor, _f: unknown): { start: StubPos; end: StubPos; query: string } | null {
        return null;
    }
    getSuggestions(_c: unknown): T[] | Promise<T[]> {
        return [];
    }
    setInstructions(): void {}
    trigger(editor: StubEditor, file: unknown, open: boolean): boolean | Promise<boolean> {
        const from = editor.getCursor("from");
        const to = editor.getCursor("to");
        if (from.line !== to.line || from.ch !== to.ch) {
            this.context = null;
            return false;
        }
        const info = this.onTrigger(from, editor, file);
        if (!info) {
            this.context = null;
            return false;
        }
        const context = (this.context = { editor, file, ...info });
        if (open || this.isOpen) {
            return Promise.resolve(this.getSuggestions(context)).then((list) => {
                this.shown = list;
                this.isOpen = list.length > 0;
                return true;
            });
        }
        return true;
    }
    close(): void {
        this.isOpen = false;
    }
}
