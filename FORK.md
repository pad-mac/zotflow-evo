# ZotFlow Evo — fork notes

This is a personal fork of [duanxianpi/zotflow](https://github.com/duanxianpi/zotflow).
Read this file before changing or updating anything: it lists every
difference from upstream, where it lives and why, so a later merge or repair
does not have to rediscover them.

`AGENTS.md` is upstream's guide and still applies. Where it says the plugin id
is `zotflow`, read `zotflow-evo`.

## Repositories

| Repo | Upstream | Working branch |
| --- | --- | --- |
| `pad-mac/zotflow-evo` (this one, the plugin) | `duanxianpi/zotflow` | `dev` |
| `pad-mac/obsidian-zotero-reader-evo` (the reader, submodule at `reader/reader`) | `duanxianpi/obsidian-zotero-reader`, branch `zotflow` | `zotflow` |

The reader fork's `master` is the plain Zotero reader and is not used. All
Obsidian-specific reader code is on `zotflow`.

The plugin repo holds no reader files. `reader/reader` is a pointer: the URL
in `.gitmodules` plus one pinned reader commit. After a reader change, push
the reader commit first, then commit the moved pointer here. A plugin tag
whose pinned reader commit is not pushed cannot be built.

## Differences from upstream

Keep this list complete. One entry per change, newest last.

### Plugin (`pad-mac/zotflow-evo`)

| Change | Where | Why |
| --- | --- | --- |
| Submodule URL points at the reader fork | `.gitmodules` | Reader changes are made in our fork. |
| Plugin id `zotflow-evo`, name "ZotFlow Evo" | `manifest.json` | With the original id, Obsidian offers to "update" to the official release and overwrites this build. |
| Removed the "Request Enhancement Pack beta" step and its line in the release notes | `.github/workflows/beta-release.yml` | It calls the upstream author's repo with a secret this fork does not have. |
| Removed the notify workflow | `.github/workflows/notify-enhancement-pack.yml` (deleted) | Same reason. |
| Beta builds also start from a version file or a manual run; the workflow then creates the tag itself | `.github/workflows/beta-release.yml`, `.github/beta-version` (new) | The environment this fork is maintained from can push branches but not tags. |
| Reader toolbar toggle and comment popup toggle: two header buttons per reader view, two commands, two settings (`readerToolbarHidden`, `readerCommentPopupSuppressed`) | `src/ui/reader/chrome.ts` (new, all the logic). Hooks: `attachReaderChromeControls()` in the constructors and `...readerChromeOptions()` in the `initReader` options of `src/ui/reader/view.ts` and `local-view.ts`; `setToolbarHidden()` / `setAnnotationPopupSuppressed()` in `src/ui/reader/bridge.ts`; `registerReaderChromeCommands()` in `src/main.ts`; the two keys in `src/settings/types.ts`; the option and child-API types in `src/types/zotero-reader.d.ts` | Requested: hide the reader toolbar from the view header; no comment popup (the note strip will replace it). The settings have no entry in the settings tab; the buttons and commands are their interface. |
| Reader theme refresh on every `css-change`, not only on a light/dark flip | `requestReaderThemeRefresh()` in `src/ui/reader/chrome.ts`; one `else if` in the `css-change` handler of `view.ts` and `local-view.ts` | A theme, snippet or Style Settings change keeps the scheme but changes the colours. |
| Header toggle buttons no longer get `is-active` | `render()` in `src/ui/reader/chrome.ts` | `is-active` drew them as held down; the icon alone shows the state. |
| Note strip beside PDFs: two more header buttons (strip on/off, list mode), two commands, settings `readerNoteStripVisible`, `readerNoteStripCollapsed`, `readerNoteStripWidth`, `readerNoteStripBanner` | `src/ui/reader/chrome.ts` (all the logic; `readerChromeOptions()` now also returns `noteStrip`). Hooks: third argument of `attachReaderChromeControls()` (what the view shows) and `sendNoteStripBanner()` after `initReader` in `view.ts` and `local-view.ts`; `setNoteStrip()` in `bridge.ts`; types `ReaderNoteStrip`, `noteStrip` option and `setNoteStrip` child API in `src/types/zotero-reader.d.ts` | The strip itself is in the reader (below). The banner is a LiquidJS template rendered in the worker with the item's metadata, so it is sent after the reader is open rather than awaited while the view sets up. |
| `DisplayTitleService.renderTemplate()`: render any one-off template for an item | `src/worker/services/display-title.ts` | Used for the strip banner and the highlight drop template; reuses the display-title variables (`item.…`). |
| Fork settings page "ZotFlow Evo" | `src/settings/sections/evo-section.ts` (new); one page entry in `src/settings/settings.ts`; two classes at the end of `styles.css` | Note strip, drop templates, automatic sync. |
| Drops from the reader into a note: a comment dragged from the strip is dropped as text with per-colour text before/after and a linked page number; a highlight or selected text is dropped through a LiquidJS template. Settings `evoCommentDrop`, `evoHighlightDropTemplate` | `src/ui/editor/evo-drop.ts` (new, all the logic). Hooks: `handleReaderDrop()` call and the `evoSource` field in `src/ui/editor/citation-helper.ts`; fourth argument `extra` and `evoSource` in `handleSetDataTransferAnnotations` of `bridge.ts`; type `ReaderDragExtra` | Requested. A drop with Shift, Ctrl/Cmd or Alt held, and a highlight drop with an empty template, go to upstream's citation formats as before. `evo-drop.ts` imports the worker bridge lazily because `citation-helper.ts` is also loaded by unit tests that have no bridge. |
| A reader opens in a new tab in a pane at least 500 px wide: the current pane if it is, else the most recently used one that is | `src/utils/evo-reader-leaf.ts` (new); one line in `openAttachment()` in `src/utils/viewer.ts` | Requested. Uses `leaf.activeTime` (not in the public typings) for "most recently used", and the `.workspace-tabs` element for the width. Skipped on mobile. |
| Library tree as a tab in the main area: command `open-library-browser-tab`; there a click on an item opens its PDF, EPUB or snapshot, asking when there are several | `src/ui/evo-workspace.ts` (command), `src/ui/tree-view/evo-browser.ts` (click behaviour), both new. Hooks: `registerEvoWorkspaceCommands()` in `src/main.ts`; the start of `handleOnClick` and of `handleDoubleClick` in `src/ui/tree-view/Node.tsx` | Requested. Whether a tree is "in a tab" is read from the DOM (not inside `.mod-left-split` / `.mod-right-split` / a drawer), so the sidebar tree behaves as upstream. |
| Automatic sync both ways. Pull: Zotero's streaming service (`wss://stream.zotero.org/`) names the changed library, which is synced; one catch-up sync after every (re)connect. Push: 5 s after the last local change, at once when a reader is closed. Settings `autoSyncPull`, `autoSyncPush` (both on) | `src/services/evo-auto-sync.ts` (new: the logic in `EvoAutoSync`, the wiring in `startEvoAutoSync()`). Hooks: `startEvoAutoSync()` in the `onLayoutReady` callback and `refreshEvoAutoSync()` in `saveSettings()` / `onExternalSettingsChange()` of `src/main.ts`; `noteLocalEdit()` in `handleAnnotationsSaved` / `handleAnnotationsDeleted` of `view.ts`; `KeyService.getLibraryVersion()` in `src/worker/services/key.ts` | Requested. Zotero announces this device's own upload too; it is recognised by comparing the announced version with the local one, as Zotero's own client does (`xpcom/streamer.js`). Upstream's unused `autoSync` / `syncInterval` settings are left alone. |
| Quiet syncs: an optional `quiet` flag from `startSync()` down to `SyncService.startSync()` suppresses the "Sync completed successfully!" notice | `src/ui/start-sync.ts`, `src/bridge/index.ts`, `src/worker/worker.ts`, `src/worker/tasks/manager.ts`, `src/worker/tasks/impl/sync-task.ts`, `src/worker/services/sync.ts` (one parameter each) | Automatic syncs run often; only their failures are reported. |

Known limits and open checks of these (as of 1.7.1-beta.3):

- Automatic sync was written against Zotero's own streaming client and is
  covered by unit tests with a fake stream; it had not yet been run against
  `stream.zotero.org` when it was released for testing.
- Every completed sync, automatic ones included, makes upstream refresh
  open readers and (with "auto update source notes" on) rewrite the source
  notes of changed items.
- The pane rule for new reader tabs activates a tab in the target pane
  before asking Obsidian for a new tab; it relies on Obsidian adding the
  new tab to the active pane.
- Two library trees at once (sidebar and tab) are two independent copies
  of upstream's tree view.

### Reader (`pad-mac/obsidian-zotero-reader-evo`)

All fork logic is in `src/obsidian-evo.js`, `src/evo/` and
`src/common/stylesheets/components/_evo.scss` (all new). Upstream files
only call into them; every such line is marked `ZotFlow Evo`.

| Change | Where | Why |
| --- | --- | --- |
| Obsidian's variables are read from the computed style of the element hosting the reader and written into the reader document and each view iframe | `refreshResolvedObsidianVariables()` / `applyResolvedObsidianVariables()` in `obsidian-evo.js`. Hooks in `src/index.obsidian.reader.js`: start of `createReader()`, start of `applyColorSchemeForAll()`, first line of `adoptObsidianStyles()` | Upstream only copies variables from rules whose selector is exactly `body`, `:root`, `.theme-light` or `.theme-dark`; anything a theme, snippet or Style Settings sets elsewhere was missed and the reader showed the default palette. Variables a reader document declares itself are never overwritten, and `--page-border` is never copied (same as upstream's filter). |
| Toolbar and the area around the page use `--background-primary` | `_evo.scss` overrides `--color-toolbar`; `main.scss` imports `components/evo` last | Requested. Upstream maps `--color-toolbar` to `--file-header-background`. |
| Toolbar can be hidden | `applyToolbarHidden()` sets `body.zf-evo-toolbar-hidden`; layout in `_evo.scss`. Child API `setToolbarHidden` in `src/index.obsidian.js`, option `toolbarHidden` read in `createReader()` | Requested. |
| Comment popup can be turned off | `applyAnnotationPopupSuppressed()` sets the reader state key `zfEvoSuppressAnnotationPopup`; one extra condition where `src/common/components/reader-ui.js` renders `AnnotationPopup`. Child API `setAnnotationPopupSuppressed`, option `annotationPopupSuppressed` | Requested. Same mechanism upstream uses while the annotations sidebar is open. |
| Note strip beside the PDF | `src/evo/note-strip.js` (React: the comments), `src/evo/strip-host.js` (its place in the PDF view), `src/evo/strip-layout.mjs` (where each comment goes; tests in `test/evo/`, added to `npm test` in `package.json`), strip styles in `_evo.scss`. Hooks: import, `<EvoNoteStrip>` and one more popup condition in `reader-ui.js`; option `noteStrip`, `setNoteStrip()` and `syncThemeFollowers()` in `src/index.obsidian.reader.js`; child API `setNoteStrip` in `src/index.obsidian.js`; reader state key `zfEvoStrip` | Requested; see "How the note strip works" below. |
| Icon of a note on the page's right edge is not drawn while the strip is open | `isNoteShownInStrip()` in `obsidian-evo.js`; three lines in `_pushNote()` of `src/pdf/page.js` | A note written in the strip is stored as a Zotero note annotation against the right-hand edge of its page; the strip shows it. With the strip closed the icon is drawn as usual. |
| A refresh of the annotations from the plugin leaves alone what was written in the reader a moment ago | `noteLocalAnnotationWrites()` / `annotationsNewerHere()` in `obsidian-evo.js`; hooks in `onSaveAnnotations`, `onDeleteAnnotations` and `refreshAnnotations()` of `src/index.obsidian.reader.js` | The plugin refreshes the reader from its database after every sync. With automatic sync that can land while a comment is being typed, and the database copy read a moment earlier would take back the last words (or bring back a deleted annotation, or drop a new one). Protected: annotations still waiting to be saved, and for 4 s after they were handed over. |

Known limits of these: with the toolbar hidden, Tab still cycles through
the hidden toolbar's focus groups (`focus-manager.js` is untouched), and the
appearance and read-aloud popups keep their 41px offset.

### How the note strip works

- **Where it lives.** An iframe inside the PDF view's own document, beside
  the scrolling area (`#viewerContainer`), which is made narrower. In that
  document because only there can the browser move it exactly with the
  pages (a CSS scroll-driven animation bound to `#viewerContainer`; moved
  by a scroll listener where that is unsupported). An iframe because the
  PDF view listens on its window for keys, pointer events, drags and copies
  and would treat the strip as part of the PDF.
- **Who draws it.** The reader's React tree, through a portal into the
  strip's document. That document gets a copy of the reader's stylesheets
  (including the scoped copy of Obsidian's `app.css`), follows the reader's
  theme (`followTheme()` in `obsidian-evo.js`) and loads Obsidian's
  `enhance.js`, as the reader's document does, so Obsidian's editor and
  markdown renderer find their DOM helpers there.
- **What it shows.** What Zotero stores, nothing of its own: the comment of
  a highlight, underline, image or ink annotation (one bar), and note
  annotations (two bars). A highlight without a comment appears while it is
  selected. Markdown is stored as the plain text of the comment.
- **Writing a note.** A click on an empty line starts a draft; with its
  first character it becomes a Zotero note annotation at that height on the
  page's right edge (`spotAt()` in `strip-host.js`), and it is deleted again
  if it is left empty.
- **Lines and overlaps.** Comments sit on 20 px lines counted from the top
  of each page. A comment that would run into the next one is cut to two
  lines and faded; comments on adjacent lines are pushed down
  (`strip-layout.mjs`). The open comment is shown in full over the ones
  below. `LINE_HEIGHT` there and `--zf-evo-line` in `_evo.scss` must agree.
- **Keys.** Outside a text box, keys pressed in the strip go to the
  reader's keyboard manager like keys pressed on the page. The strip cannot
  scroll by itself (in list mode it can): the wheel scrolls the pages, and
  the pages are scrolled to keep the cursor of the open comment in view.
- **Fallbacks.** If Obsidian's editor cannot be created in the strip, a
  plain text box is used; if a comment cannot be rendered as markdown, its
  text is shown. Both log a `[ZotFlow Evo]` warning to the console.

Known limits: the strip belongs to the primary view only (no strip in the
second pane of a split view, and no comment popup there either while the
strip is on); it exists for PDFs only, EPUBs and snapshots keep the popup;
Obsidian's suggestion popups (`[[`, tags) opened from the strip's editor
may appear in the wrong place, because they are positioned in Obsidian's
window from coordinates three documents deep; in list mode a click on empty
space does not start a note (there is no place on the page to give it).

### Testing the reader fork locally

`npm test` runs the layout tests. The strip was developed against a rig,
not kept in the repositories: the built reader loaded in headless Chromium
with a sample PDF and a stand-in for the plugin's side of the bridge
(a real CodeMirror editor created by the outer page inside the strip, as
Obsidian does). What a rig cannot show is Obsidian's own editor, renderer
and styles in the strip; that has to be looked at in Obsidian.

## Consequences of the id change

- The plugin installs to `.obsidian/plugins/zotflow-evo/`, with its own
  `data.json`. Settings from an official ZotFlow install do not carry over
  automatically.
- Command ids are `zotflow-evo:…`, so hotkeys set for the official plugin have
  to be set again.
- `obsidian://zotflow` links, the IndexedDB database and the Enhancement Pack
  folder (`zotflow-enhancement-pack`) are **not** derived from the id and are
  shared with the official plugin. Never enable both plugins at once.
- `tests/live/**` hard-code `zotflow` (`app.plugins.plugins.zotflow`,
  `enablePlugin("zotflow")`). Those live tests are not part of `npm test` and
  will not run against this fork without adjusting the id.
- The Enhancement Pack's compatibility is decided by
  `document-worker.lock.json`, not by the plugin id or version. Leave that
  file as upstream has it unless the pack is rebuilt as well.

## Releasing a build

Releases are built by GitHub Actions from a tag; nothing is built by hand.

- The built commit must be on `dev` (both release workflows check this).
- **Test build (the normal way):** write the next version, `x.y.z-beta.N`,
  into `.github/beta-version`, commit, push `dev`. The workflow builds that
  commit, creates the tag on it and publishes a prerelease with `main.js`,
  `manifest.json`, `styles.css`. Pushes to `dev` that do not touch the file
  build nothing.
- **Test build (fallback):** Actions → Beta Release → Run workflow, type the
  version. Builds the head of `dev`. The button only appears if the
  repository's default branch contains this workflow, i.e. the default branch
  is `dev`.
- Pushing an `x.y.z-beta.N` tag still works too, as upstream does it.
- The workflow sets the version in the runner; `manifest.json` and
  `package.json` keep the upstream version in the repo. A published beta
  number is never moved or reused: the workflow refuses a version whose tag
  exists on another commit, so always take the next number.
- **Stable build:** unchanged from upstream and still tag-only:
  `npm version patch|minor|major` on `dev`, push commit and tag → a *draft*
  release that has to be published by hand. The tag has to be pushed by
  someone who can push tags.
- Install with BRAT pointed at `pad-mac/zotflow-evo`.

## Taking upstream updates

Optional. An installed build keeps working until Zotero or Obsidian changes
underneath it.

1. Reader: merge `duanxianpi/obsidian-zotero-reader` `zotflow` into our
   `zotflow`, resolve, push.
2. Plugin: merge the upstream release tag (or `master`) into our `dev`.
   Expect conflicts in the files listed above; keep our side for those. The
   `reader/reader` pointer must end up on a commit of *our* reader fork that
   contains upstream's new pointer.
3. Tag a beta, test it in Obsidian, then update the table above if anything
   moved.

Upstream merges new Zotero reader versions into `zotflow` (it does not
rewrite history), so these are ordinary merges. `src/pdf/pdf-view.js` and
`src/common/reader.js` in the reader change most often; keep our hooks in
those two files as small as possible.
