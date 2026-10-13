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
| Reader toolbar toggle: a header button per reader view, a command, a setting (`readerToolbarHidden`) | `src/ui/reader/chrome.ts` (new, all the logic). Hooks: `attachReaderChromeControls()` in the constructors and `...readerChromeOptions()` in the `initReader` options of `src/ui/reader/view.ts` and `local-view.ts`; `setToolbarHidden()` in `src/ui/reader/bridge.ts`; `registerReaderChromeCommands()` in `src/main.ts`; the key in `src/settings/types.ts`; the option and child-API types in `src/types/zotero-reader.d.ts` | Requested: hide the reader toolbar from the view header. (A comment popup switch existed from beta.2 to beta.3; removed, because the note strip keeps the popup away for PDFs by itself.) |
| Reader theme refresh on every `css-change`, not only on a light/dark flip | `requestReaderThemeRefresh()` in `src/ui/reader/chrome.ts`; one `else if` in the `css-change` handler of `view.ts` and `local-view.ts` | A theme, snippet or Style Settings change keeps the scheme but changes the colours. |
| Header toggle buttons no longer get `is-active` | `render()` in `src/ui/reader/chrome.ts` | `is-active` drew them as held down; the icon alone shows the state. |
| Note strip beside PDFs and snapshots: two more header buttons (strip on/off, list or beside the page), three commands, settings `readerNoteStripVisible`, `readerNoteStripList`, `readerNoteStripHighlights`, `readerNoteStripWidth` | `src/ui/reader/chrome.ts` (all the logic; `readerChromeOptions()` also returns `noteStrip`). Hooks: third argument of `attachReaderChromeControls()` (what the view shows) and `connectNoteStrip()` after `initReader` in `view.ts` and `local-view.ts`; `setNoteStrip()` and the `documentType` getter in `bridge.ts`; types `ReaderNoteStrip`, the `noteStrip` option, the `setNoteStrip` child API and the `noteStripChanged` event in `src/types/zotero-reader.d.ts` | The strip itself is in the reader (below). Its head (`banner`: the item's main creators with full names, year, title; `itemBanner()` in `worker/services/evo-library.ts`) is read in the worker, so it is sent after the reader is open rather than awaited while the view sets up; a local file shows its name. Until beta.5 the head was one line from a LiquidJS template (`readerNoteStripBanner`, no longer read or offered). The "highlights" switch and the width (dragging the strip's edge) are changed in the strip itself; the reader reports them (`noteStripChanged`) and `connectNoteStrip()` saves them and passes them on to the other open readers. `readerNoteStripList` replaced `readerNoteStripCollapsed` in beta.4 so that the list became the default for existing installs too. Once a document is open the header shows only the buttons that do something for its kind (`render()`; told by `connectNoteStrip()` through `readerOpened`): no strip button for an EPUB, no "beside the page" button for a snapshot. |
| `DisplayTitleService.renderTemplate()`: render any one-off template for an item, with the shortcuts `author`, `year`, `shortTitle`, `title` beside `item` | `src/worker/services/display-title.ts` (the method and `referenceShortcuts()`) | Used for the reference after a dropped highlight or comment. The shortcuts are ready to be a markdown link's text (square brackets become round) and are undefined when missing, so `{% if author %}` works. |
| Fork settings page "ZotFlow Evo" | `src/settings/sections/evo-section.ts` (new); one page entry in `src/settings/settings.ts`; two classes at the end of `styles.css` | Note strip, drop templates, automatic sync. |
| Drops from the reader into a note: `before + body + reference + after`. Body: a highlight's text in quotation marks, or the comment. Reference: one LiquidJS template for both (`evoDropLinkTemplate`). Before/after: per annotation colour, one table for highlights (`evoHighlightDrop`) and one for comments (`evoCommentDrop`) | `src/ui/editor/evo-drop.ts` (new, all the logic). Hooks: `handleReaderDrop()` call and the `evoSource` field in `src/ui/editor/citation-helper.ts`; fourth argument `extra` and `evoSource` in `handleSetDataTransferAnnotations` of `bridge.ts`; type `ReaderDragExtra` | Requested. A drop with Shift, Ctrl/Cmd or Alt held goes to upstream's citation formats as before. `evo-drop.ts` imports the worker bridge lazily because `citation-helper.ts` is also loaded by unit tests that have no bridge. The default reference leaves the page out where there is none (a snapshot): the template gets no `page` then, and `{% if page %}` is false. A stored template equal to an earlier default is replaced by the current one when the settings load (`src/settings/evo-upgrade.ts`, called in `loadSettings()` of `src/main.ts`; earlier defaults are listed in `PREVIOUS_DROP_LINK_TEMPLATES`). |
| A reader opens in a new tab in a pane at least 500 px wide: the current pane if it is, else the most recently used one that is | `src/utils/evo-reader-leaf.ts` (new); one line in `openAttachment()` in `src/utils/viewer.ts` | Requested. Uses `leaf.activeTime` (not in the public typings) for "most recently used", and the `.workspace-tabs` element for the width. Skipped on mobile. |
| Library browser: a tab laid out like Zotero's window — libraries and nested collections on the left, a table of the items in the middle (columns chosen by right-clicking the header, sorted by clicking it, resized by dragging its edges; a filter; optionally the items of sub-collections too), the focused item on the right (title; first two authors' full names and year; publication; abstract; below a line the annotations of the file it opens, as cards like the reader's note strip). Command `open-library-browser-tab` ("Open Zotero library in a tab") now opens it. A click selects (Ctrl/Cmd, Shift, arrows), a double click or Enter opens the item, dragged rows drop links to their source notes, a right-click offers open / source note / search / show in Zotero. An item without a PDF, EPUB or snapshot has a search button in the attachment column: Anna's Archive (setting `evoBookSearchUrl`) for "title first-author year" in Obsidian's web viewer, in a pane beside the browser (in the system browser when the web viewer core plugin is off or on mobile). Settings `evoLibraryColumns`, `evoCollectionColumns`, `evoColumnWidths`, `evoLibrarySort`, `evoLibrarySubcollections`, `evoLibraryPanes`, `evoBookSearchUrl` | `src/ui/evo-library/` (all new: `views.tsx` the three Obsidian views and their registration, `LibraryBrowser.tsx`, `CollectionPane.tsx`, `ItemTable.tsx` (only the rows on screen are drawn), `ItemDetails.tsx`, `parts.tsx` (icon, markdown, annotation card, change hook), `useItems.ts`, `menus.ts`, `actions.ts`); `src/utils/evo-library-model.ts` (the rules, tested); `src/worker/services/evo-library.ts` (the data). Hooks: `registerEvoLibrary()` in `src/main.ts`; the `evoLibrary` service in `src/worker/worker.ts` (type, instance, getter, `updateSettings`) and `src/bridge/index.ts`; the keys in `src/settings/types.ts`; styles at the end of `styles.css` | Requested. Data is read in the worker per scope (the collection tree; the rows of a library or collection with attachment and annotation counts; one item's details), never the whole tree, and read again after a sync or an edit (`treeChanged`, `syncFinished`, `annotationChanged`). The view's fields are named `evoScope`/`evoTarget`: `scope` would shadow Obsidian's keymap scope of the view. Anna's Archive changes its domain now and then; hence the setting. |
| A collection in a tab of its own (for a narrow pane): its name on top, its own table columns, a filter, the sub-collections switch and a button for its annotations. Opened from the library browser and from the sidebar tree by a middle click (a three-finger tap) or Ctrl/Cmd+right-click on a collection, or from its right-click menu ("Open in new tab") | `src/ui/evo-library/CollectionTab.tsx`, `views.tsx` (`EvoCollectionView`), `tree-hooks.ts` (the sidebar tree). Hooks in `src/ui/tree-view/Node.tsx`: start of `handleContextMenu` (`openCollectionFromTree`, `addCollectionMenuItems`) and an `onAuxClick` on the node | Requested. On macOS Ctrl+click is a right-click with Ctrl held, so it opens the tab too. |
| Annotation browser: every highlight and comment of a collection (or a library), grouped by item, colour or tag, then ordered by item (title or date added) or colour, then page; a colour filter; the item named after each annotation where the heading is not the item. Cards open the document at the annotation and drag into notes like the strip's. Setting `evoAnnotationLayout` | `src/ui/evo-library/AnnotationBrowser.tsx`, `views.tsx` (`EvoAnnotationsView`), `groupAnnotations()` in `utils/evo-library-model.ts`, `collectionAnnotations()` in the worker service | Requested. Tags are the annotations' own tags; one with several tags is listed under each, untagged ones under "No tag". All attachments of an item count, not only the primary one. |
| What "open an item" opens: a PDF before an EPUB before a web snapshot; a link (Google Books) or other file never counts; only several of the best kind (two PDFs; two EPUBs and no PDF; two snapshots and neither) ask which | `choosePrimaryAttachment()` in `src/utils/evo-library-model.ts`, used by `openItemPrimaryAttachment()` in `src/ui/tree-view/evo-browser.ts` (double click in the browser, source-note links) and by the details pane | Requested. Until beta.5 any two of PDF/EPUB/snapshot asked. |
| The old library tree as a tab (beta.3–beta.5): a click selects, a double click opens, drags drop source-note links | `src/ui/tree-view/evo-browser.ts`; hooks at the start of `handleOnClick`, `handleDoubleClick`, `handleDragStart` in `Node.tsx`; `disableMultiSelection={false}` in `TreeView.tsx`; `handleSourceLinkDrop()` in `citation-helper.ts`; the drop in `src/ui/editor/evo-link-drop.ts` | Superseded by the library browser; the command no longer opens it, but a tree tab restored from an older workspace still behaves so. The drop of source-note links is shared with the browser. |
| A click on a link to a source note opens the item's PDF, EPUB or snapshot instead of the note. Setting `evoSourceLinksOpenAttachment` (on) | `src/ui/evo-source-links.ts` (new): wraps `workspace.openLinkText` with monkey-around. Hook: `registerSourceNoteLinks()` in `src/main.ts` | Requested. Only a plain click on a plain link: a modifier click (Obsidian's "new tab / split / window"), a link to a heading or block, a call without a source path (quick switcher) and an item with nothing to open all open the note as before. Source notes are recognised by their frontmatter (`zotero-key` + `library-id`, or `zotflow-local-attachment`). |
| A link into a document that is not open yet lands on its target | `pendingNavigation` and `finishPendingNavigation()` in `view.ts` and `local-view.ts`; `readerNavigate()` keeps the target while the reader is not ready and it is passed as Zotero's `location` option to `initReader`; the option's type in `src/types/zotero-reader.d.ts` | Upstream's `readerNavigate()` returned when the bridge did not exist yet, which is always the case right after the view is created, so a page or annotation link opened the PDF at the last reading position. |
| Automatic sync both ways. Pull: Zotero's streaming service (`wss://stream.zotero.org/`) names the changed library, which is synced; one catch-up sync after every (re)connect. Push: 5 s after the last local change, at once when a reader is closed. Settings `autoSyncPull`, `autoSyncPush` (both on) | `src/services/evo-auto-sync.ts` (new: the logic in `EvoAutoSync`, the wiring in `startEvoAutoSync()`). Hooks: `startEvoAutoSync()` in the `onLayoutReady` callback and `refreshEvoAutoSync()` in `saveSettings()` / `onExternalSettingsChange()` of `src/main.ts`; `noteLocalEdit()` in `handleAnnotationsSaved` / `handleAnnotationsDeleted` of `view.ts`; `KeyService.getLibraryVersion()` in `src/worker/services/key.ts` | Requested. Zotero announces this device's own upload too; it is recognised by comparing the announced version with the local one, as Zotero's own client does (`xpcom/streamer.js`). Upstream's unused `autoSync` / `syncInterval` settings are left alone. |
| Quiet syncs: an optional `quiet` flag from `startSync()` down to `SyncService.startSync()` suppresses the "Sync completed successfully!" notice | `src/ui/start-sync.ts`, `src/bridge/index.ts`, `src/worker/worker.ts`, `src/worker/tasks/manager.ts`, `src/worker/tasks/impl/sync-task.ts`, `src/worker/services/sync.ts` (one parameter each) | Automatic syncs run often; only their failures are reported. |

Known limits and open checks of these (as of 1.7.1-beta.6):

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
- Wrapping `workspace.openLinkText` changes what a click on a source note
  link does everywhere in Obsidian, including in notes that other plugins
  render. It can be switched off in the settings.
- `readerCommentPopupSuppressed`, `readerNoteStripCollapsed` and
  `evoHighlightDropTemplate` may still sit in a `data.json` written by
  beta.2 or beta.3, and `readerNoteStripBanner` stays in it. Nothing reads
  them.
- The library browser, the collection tabs and the annotation browser were
  checked in a browser rig with stand-ins for Obsidian (icons, menus,
  markdown) and the worker; Obsidian's real icons, menus, styles and web
  viewer have to be looked at in Obsidian. The web viewer is opened with
  view type `webviewer` and state `{ url, navigate }`, which is not in the
  public API.

### Reader (`pad-mac/obsidian-zotero-reader-evo`)

All fork logic is in `src/obsidian-evo.js`, `src/evo/` and
`src/common/stylesheets/components/_evo.scss` (all new). Upstream files
only call into them; every such line is marked `ZotFlow Evo`.

| Change | Where | Why |
| --- | --- | --- |
| Obsidian's variables are read from the computed style of the element hosting the reader and written into the reader document and each view iframe | `refreshResolvedObsidianVariables()` / `applyResolvedObsidianVariables()` in `obsidian-evo.js`. Hooks in `src/index.obsidian.reader.js`: start of `createReader()`, start of `applyColorSchemeForAll()`, first line of `adoptObsidianStyles()` | Upstream only copies variables from rules whose selector is exactly `body`, `:root`, `.theme-light` or `.theme-dark`; anything a theme, snippet or Style Settings sets elsewhere was missed and the reader showed the default palette. Variables a reader document declares itself are never overwritten, and `--page-border` is never copied (same as upstream's filter). |
| Toolbar and the area around the page use `--background-primary` | `_evo.scss` overrides `--color-toolbar`; `main.scss` imports `components/evo` last | Requested. Upstream maps `--color-toolbar` to `--file-header-background`. |
| Toolbar can be hidden | `applyToolbarHidden()` sets `body.zf-evo-toolbar-hidden`; layout in `_evo.scss`. Child API `setToolbarHidden` in `src/index.obsidian.js`, option `toolbarHidden` read in `createReader()` | Requested. |
| Note strip beside a PDF or a snapshot | `src/evo/note-strip.js` (React: the head and the entries), `src/evo/strip-host.js` (the strip's frames and what is the same everywhere), `src/evo/strip-host-pdf.js` (their place in the PDF view), `src/evo/strip-host-dom.js` (their place beside a snapshot), `src/evo/strip-layout.mjs` (what is listed, in what order, and where; tests in `test/evo/`, added to `npm test` in `package.json`), strip styles in `_evo.scss`. Hooks: import, `<EvoNoteStrip>` and one more popup condition (`hasNoteStrip()`) in `reader-ui.js`; option `noteStrip`, `setNoteStrip()` and `syncThemeFollowers()` in `src/index.obsidian.reader.js`; child API `setNoteStrip` in `src/index.obsidian.js`; reader state key `zfEvoStrip`; event `noteStripChanged` to the plugin (`reportNoteStrip()` in `obsidian-evo.js`) | Requested; see "How the note strip works" below. Which kinds of document have a strip is decided in one place, `hasNoteStrip()` in `obsidian-evo.js` (and its twin in the plugin's `chrome.ts`). |
| Icon of a note on the page's right edge is not drawn while the strip is open | `isNoteShownInStrip()` in `obsidian-evo.js`; three lines in `_pushNote()` of `src/pdf/page.js` | A note written in the strip is stored as a Zotero note annotation against the right-hand edge of its page; the strip shows it. With the strip closed the icon is drawn as usual. |
| A refresh of the annotations from the plugin leaves alone what was written in the reader a moment ago | `noteLocalAnnotationWrites()` / `annotationsNewerHere()` in `obsidian-evo.js`; hooks in `onSaveAnnotations`, `onDeleteAnnotations` and `refreshAnnotations()` of `src/index.obsidian.reader.js` | The plugin refreshes the reader from its database after every sync. With automatic sync that can land while a comment is being typed, and the database copy read a moment earlier would take back the last words (or bring back a deleted annotation, or drop a new one). Protected: annotations still waiting to be saved, and for 4 s after they were handed over. |
| A note made in a snapshot gets the sort index of its own paragraph | Six lines in `getAnnotationFromRange()` of `src/dom/snapshot/snapshot-view.ts` | Upstream counts a note's sort index to the start of the *parent* of the paragraph it stands on (the range it is given starts there), plus the paragraph's number among its siblings. In any list by sort index, the strip and Zotero's own sidebar alike, the note then stands at the top of its article instead of at its paragraph. Notes stored that way earlier are not rewritten; the strip orders them by their paragraph (`withPlaces()` in `strip-host-dom.js`). |

Known limits of these: with the toolbar hidden, Tab still cycles through
the hidden toolbar's focus groups (`focus-manager.js` is untouched), and the
appearance and read-aloud popups keep their 41px offset.

### How the note strip works

- **Two modes.** As a list (the default) the strip is a column of its own,
  like the reader's annotations sidebar, and scrolls by itself. Anchored,
  every entry sits beside its place on the page and the strip moves with
  the pages. The same entries are drawn in both. Beside a snapshot there
  is only the list (`canAnchor` of the host).
- **Where it lives.** Two iframes: a pinned head (authors and year, title,
  buttons, colour filters) and the strip (`strip-host.js`). Beside a PDF they are
  inside the PDF view's own document, beside the scrolling area
  (`#viewerContainer`), which is made narrower (`strip-host-pdf.js`). In
  that document because only there can the browser move the anchored strip
  exactly with the pages (a CSS scroll-driven animation bound to
  `#viewerContainer`; moved by a scroll listener where that is
  unsupported). Iframes because the PDF view listens on its window for
  keys, pointer events, drags and copies and would treat the strip as part
  of the PDF.
- **Beside a snapshot** (`strip-host-dom.js`) the column is in the reader's
  own document at the far side, and `#split-view` gives up that width
  (`body.zf-evo-side-strip` in `_evo.scss`) — the way the reader's sidebar
  does it at the near side. Not inside the view: a snapshot view sizes its
  iframe and the page's `<html>` to the whole of its container. With a
  split view the strip stands beside both panes.
- **Who draws it.** The reader's React tree, through portals into the two
  documents. Each gets a copy of the reader's stylesheets (including the
  scoped copy of Obsidian's `app.css`) and follows the reader's theme and
  text direction (`followTheme()` in `obsidian-evo.js`; the build writes
  asymmetric paddings as `html[dir=…]` rules, so without `dir` they do not
  apply). The strip's document also loads Obsidian's `enhance.js`, as the
  reader's document does, so Obsidian's editor and markdown renderer find
  their DOM helpers there.
- **What it shows.** What Zotero stores, nothing of its own. Comments — of
  a highlight, underline, image or ink annotation, and note annotations —
  with two bars in the annotation's colour. With "highlights" on, also
  what was marked on the page (full text), with one bar; a highlight
  without a comment is otherwise listed only while it is open. The
  document's outline as headings between them, indented by their depth
  (for a snapshot: its HTML headings, as the reader's outline tab lists
  them). As a list a heading with something under it can be folded (its
  arrow; with Alt all headings of its depth); folded, it hides everything
  up to the next heading of its depth or above (`foldEntries()`). Folding
  is per document and not kept. Markdown is stored as the plain text of
  the comment.
- **The head.** Two lines: all main creators (full names) with the year
  at the right end in tabular figures, the authors fading out before it
  when they do not fit; then the full title, bold, same size and colour.
- **Order.** Zotero's sort index, as in Zotero's own sidebar. For a PDF
  that is page, offset in the page's text, height on the page, so
  two-column pages read in the right order; for a snapshot the number of
  characters before the place. An outline heading gets a sort index from
  its destination (`headingSortIndex()`; for a PDF once the page's text is
  read, for a snapshot all headings in one walk through the text,
  `prepareHeadings()`); a chapter that starts at the top of a page stands
  before the notes written for that page. Things with the same sort index:
  what was marked first, then notes in the order they were written
  (`compareEntries()`).
- **Writing.** A click on a highlight (in the document or in the list)
  opens a comment line for it. A note starts as a draft and becomes a
  Zotero note annotation with its first character; left empty it is
  deleted again. Alt+1 … Alt+8 set the colour of the open entry.
  Shift+Enter starts a new note right under the open entry (under a
  highlight's comment: a note of its own after the highlight). Delete or
  Backspace in the empty comment of an annotation deletes the annotation,
  as long as nothing was typed since it was opened (so emptying a comment
  with Backspace never deletes the highlight).
- **Selecting text.** A plain press on an entry's text drags it (into a
  note); with Alt held it selects the text instead, and a click that ends
  a selection does not open the entry.
- **Width.** The edge towards the document is a handle; dragging it moves
  only the strip while dragging and fits the document once at the end.
  The width is kept for every reader (`noteStripChanged`).
- **Where a new note goes (list).** A click on empty space puts it after
  the entry above the click (under a highlight, between two entries, below
  the last one). The + button puts it after the last thing listed on the
  page being read — beside a snapshot: on screen. Only with nothing there
  does it get a place of its own: the start of the page (sort index
  `page|000000|n`, `pageStartSlot()`), or the paragraph in the middle of
  the screen. "After an entry" is a sort index (`sortIndexAfter()`): the
  entry's own place in the text, a little further on in the last part of
  the index — for a PDF the height field, which nothing else at that place
  uses (+64, or half the way to the next thing there, so a note can still
  be put between two); for a snapshot a few characters (+8 at most).
  Where it is stored: in a PDF against the right-hand edge of the entry's
  page, level with it; in a snapshot on the paragraph the entry begins in,
  like a note made with the reader's note tool, so its icon stands in the
  margin (`spotAfter()`).
- **Where a new note goes (anchored).** A click on an empty line stores it
  at that height (`spotAt()`).
- **Text under the page number.** The number stands in front of the first
  line and is not part of the text; the first line is indented by its
  width (`--zf-evo-indent`, measured per entry and again whenever the
  number's width changes — a number measured before the strip was laid out
  or its font arrived let the text run over it): `text-indent` for plain
  text and the editor's first line, a zero-height float for rendered
  markdown.
- **Anchored layout.** Entries sit on 20 px lines counted from the top of
  each page and keep their full height while they have room. One that
  would run into the next is cut where they meet and faded; if the next
  starts on the same line (or was pushed onto it), the first keeps up to
  two lines and the next moves below it (`layoutCards()`). The
  open entry is shown in full over the ones below. `LINE_HEIGHT` and
  `--zf-evo-line` in `_evo.scss` must agree.
- **Keys.** Outside a text box, keys pressed in the strip go to the
  reader's keyboard manager like keys pressed on the page. Anchored, the
  strip cannot scroll by itself: the wheel scrolls the pages, and the pages
  are scrolled to keep the cursor of the open comment in view.
- **Fallbacks.** If Obsidian's editor cannot be created in the strip, a
  plain text box is used; if a comment cannot be rendered as markdown, its
  text is shown. Both log a `[ZotFlow Evo]` warning to the console. If the
  strip cannot start at all it counts as hidden, which gives the comment
  popup back.

Known limits: the strip belongs to the primary view only (in a PDF no
strip in the second pane of a split view, and no comment popup there
either while the strip is on); it exists for PDFs and snapshots, EPUBs
keep the popup; beside a snapshot it is a list only; in a snapshot a note
put between an entry and a note that directly follows it can land behind
that note once the few characters of room are used up, and a later
highlight that starts within those few characters lists before the note;
Obsidian's suggestion popups (`[[`, tags) opened from the strip's editor
may appear in the wrong place, because they are positioned in Obsidian's
window from coordinates three documents deep; the list does not follow the
page being read; the outline is whatever the reader's own outline tab would
show, which for a PDF without bookmarks may be one Zotero derived from the
text; the colour filter is per reader and not kept.

### Testing the reader fork locally

`npm test` runs the layout tests. The strip was developed against a rig, not
kept in the repositories: the built reader loaded in headless Chromium with
a sample PDF or a sample web page and a stand-in for the plugin's side of
the bridge (a real CodeMirror editor created by the outer page inside the
strip, as Obsidian does). What a rig cannot show is Obsidian's own editor,
renderer and styles in the strip; that has to be looked at in Obsidian.

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
