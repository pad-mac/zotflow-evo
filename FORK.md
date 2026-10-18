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
| Library browser, beta.7: editing. Delete on the selection asks at its line ("Remove … from the collection?"; in a whole library: "Move … to the trash?"), Shift+Delete always asks to trash; Enter confirms, Escape leaves it. The same from the row's right-click menu. Rows dropped on a collection in the left pane (from any library tab, also across split panes; several at once) are added to it | `useRowEditing()` in `src/ui/evo-library/useItems.ts`, the question in `ItemTable.tsx`, `addItemsToCollection()` / `removeItemsFromCollection()` / `trashItems()` in `actions.ts`, the drop in `CollectionPane.tsx`; in the worker `addToCollection()`, `removeFromCollection()`, `trashItems()` of `src/worker/services/evo-library.ts` (through `mutateItems()`, so the edit is pushed by the sync; `noteLocalEdit()` schedules the push) | Requested. Only in libraries ZotFlow syncs both ways and the key may write to (`assertWritable()`); notes only with notes access. Removing takes an item out of this collection only, not out of the ones inside it. A drag of rows carries `application/x-zotflow-evo-items` (`{ libraryID, keys }`) and a type naming the library, so a collection of another library refuses the drop while it is dragged over. Trash is Zotero's (`deleted`), restorable there. |
| Library browser, beta.7: collections. No folder icons. Right-click → "Pin to the top": the collection, with everything inside it, stands above the libraries, out of its parent. Collections are ordered by dragging them among their siblings (pinned ones among the pinned); the order is kept. Settings `evoPinnedCollections` (`"libraryID:key"`), `evoCollectionOrder` (`"libraryID:parentKey"` → keys) | `CollectionPane.tsx`; `splitPinned()`, `orderTree()`, `orderSiblings()`, `moveKey()` in `src/utils/evo-library-model.ts` (tested) | Requested. Collections not in a stored order (new ones) follow it by name. |
| Library browser, beta.7: the table and the item pane. Dragging the title column's edge moves the border between it and the next column (the title takes the rest, so its own width cannot be set); listened for on the document, not the 6 px handle. Linked files are marked in the attachment column (`file-symlink`) and opening one says it is not supported instead of a failed download. Titles with `<i>`/`<em>` are drawn in italics (table, item pane, annotation headings, the strip's head); other markup is left out and the filter ignores it. Item pane: the head (title, authors, year on its own line in tabular figures, publication, files) stays put; a long abstract scrolls in a section of its own (up to 35 %); the annotations scroll below. A toolbar button shows and hides the pane (`evoLibraryDetailsShown`). New icon for "annotations of this collection" (`message-square-quote`, else `quote`) | `resizeColumns()` in `evo-library-model.ts`, `ItemTable.tsx`; `attachmentKind()` (`linked`), `notifyLinkedFile()` and a check in `openAttachment()` of `src/utils/viewer.ts`, `openItemPrimaryAttachment()` in `evo-browser.ts`; `titleRuns()` / `plainTitle()` and `Title` in `parts.tsx`; `ItemDetails.tsx`; `iconOr()` in `parts.tsx` | Requested. The "user" fix of the resize: the drag worked for other columns, but most drags are of the title's edge. Linked files: ZotFlow cannot reach files outside Zotero's storage; supporting them is left for later. |
| The selected item in a pane of its own: command "Open the selected Zotero item in a pane" opens it beside the active pane; it follows the item focused last in any library or collection tab | `DetailsTab` in `ItemDetails.tsx`, `EvoDetailsView` in `views.tsx`, `src/ui/evo-library/selection.ts` (the last selection, published by both tables) | Requested. |
| Obsidian's header (title, back/forward, more options) is hidden above the library browser, collection tabs, the annotation browser and the item pane; their own toolbars hold what is needed. On a phone it stays | class `zotflow-evo-headerless` on the view's `containerEl` (`views.tsx`), rule in `styles.css` | Requested. |
| Commands "Filter the Zotero table" (Ctrl/Cmd+F, only in a library or collection tab: the cursor goes to the filter field) and "Search My Library" (Ctrl/Cmd+Alt+F: opens the library browser on the first library, cursor in the filter field). Arrow down or Enter in the filter goes to the table | `src/ui/evo-workspace.ts`; `BrowserControl` in `LibraryBrowser.tsx`, `focusFilter()` / `goTo()` of the views | Requested, with these defaults; they can be changed under Hotkeys. Obsidian's own Ctrl/Cmd+F needs an editor, so it does not compete in these tabs (the first command's check passes only there). Default hotkeys are discouraged by Obsidian's guidelines; lint warns. |
| Save a file from the web viewer to the selected item, in Zotero's storage: a paperclip button in every web viewer pane's header (a menu names the target: the item focused last in a library tab, else the one a search was opened for), "Save link to …" in Obsidian's link menu where the web viewer offers it, and a command. The file is got, in this order: with an Anna's Archive key (setting, kept in secret storage), the member API (`/dyn/api/fast_download.json?md5=…&key=…`) for the MD5 in the address; the PDF Anna's viewer has loaded (pdf.js `getData()` in the page); the address itself or a file address in it; inside the page with its login. It is uploaded with Zotero's file upload protocol (attachment item, authorisation, upload, register) and a sync brings it here. Its name: the template `evoAttachFilename` (default `lastname_year_shorttitle`, lower case) over `lastName`, `year`, `shortTitle` (else the title), made safe for file systems. The search pane opens 640 px wide | `src/ui/evo-library/attach-file.ts` (new); `sniffFile()`, `md5FromUrl()`, `embeddedUrls()`, `sanitizeFilename()` in `evo-library-model.ts`; `attachFilename()` in the worker service; `setPaneWidth()` and `noteSearchTarget()` in `actions.ts`; key `evoAnnasKey` in `src/utils/credentials.ts`; settings in `evo-section.ts`; `registerAttachFromWebViewer()` in `src/main.ts` | Requested: both ways (with and without the key) are in, to see which works and drop the other. Only libraries on Zotero's storage (groups, or the personal library without WebDAV) whose key may write. The web viewer is reached through its `<webview>` element (`executeJavaScript`, `getURL`), its header through `addAction`, the pane width through `setDimension` of the tab group (else `flex-grow`): none of it is public API. Only PDF, EPUB and DjVu files are accepted (by their first bytes). |
| The reader view's header is hidden while the note strip is shown (PDF, snapshot); its buttons appear, smaller, in the strip's head | `applyHeader()`, `headerActions()`, `listenForActions()` in `src/ui/reader/chrome.ts`; type `NoteStripAction`, field `actions` of `ReaderNoteStrip` and the `noteStripAction` event in `src/types/zotero-reader.d.ts` | Requested. The buttons are read from the header itself (any button, also ones other code adds; their icons as Obsidian drew them) and a click in the strip clicks the real one, at the place clicked (menus open there). Hiding the strip from there brings the header back. On a phone the header stays. |
| Full-text search (beta.8): a tab (button in the library browser's and collection tabs' toolbars, command "Search the full text of Zotero documents") that searches the text of the documents in chosen libraries and collections (the one it was opened from preselected; more added from a searchable list, removed by their ×; sub-collections switch), with "match case" and "whole words". Results are snippets (five lines, the match in grey in the middle, the lines around fading), grouped by item, tag or not at all and ordered by relevance, title, date added or year, either way; outside item grouping each snippet is labelled "Lastname - year - shorttitle". A click opens the document with the reader's find bar set to the query (on its page when the text has page breaks). Settings `evoZoteroDataDir`, `evoFulltextLayout`, `evoFulltextMatchCase`, `evoFulltextWholeWords` | `src/ui/evo-library/FulltextSearch.tsx`, `fulltext-engine.ts`, `EvoFulltextView` in `views.tsx`, `openFulltextSearch()` in `actions.ts`; `src/fulltext/worker.ts` (its own worker); `src/utils/evo-fulltext.ts` (the rules, tested); the `fulltextWorkerPlugin` in `esbuild.config.mjs`; dependency `@sqlite.org/sqlite-wasm` (exact version); `personalLibraryID()` in `src/services/library-cache.ts`; `shortTitle`/`firstLastName` on the table rows (worker) | Requested. See "Full-text search" below for how it reads Zotero's files. Desktop only. |
| Library browser, beta.8: collections renamed (right-click → Rename…, a field in place; Enter, Escape) and moved by dragging: onto the middle of a collection into it, onto the upper or lower edge of one beside it (at that level, at that place), onto a library to its top level; not into itself or another library | `src/ui/evo-library/collection-edits.ts` (new), `CollectionPane.tsx`; `collectionInfo()` and `collectionWritten()` in the worker service; `collectionParents()`, `isInside()` in `evo-library-model.ts` | Requested. ZotFlow's sync only downloads collections, so these edits are sent to Zotero's web API (PATCH with `If-Unmodified-Since-Version`), written into the local row at once, and a quiet sync follows; a 412 (changed elsewhere) starts a sync and asks to try again. |
| Library browser, beta.8: first-level collections start where their library does, sub-levels one step in; setting `evoCollectionIndent` (off: no indenting). A sort button in the toolbars (any column, also hidden ones, either way). In the item pane: each author's name opens their note (`openLinkText`, as `[[Name]]` would; Ctrl/Cmd: new tab), and the item's collections are listed (library icon) under the publication — a click shows the collection with the item selected. The annotation browser orders items either way (`descending` in `evoAnnotationLayout`) | `CollectionPane.tsx`, `showSortMenu()` in `menus.ts`, `setSort()`/`selectKey()` in `useItems.ts`, `PersonLink` and the collections in `ItemDetails.tsx` (item `collections` from `itemDetails()`), `reveal()` of the browser (`BrowserControl`, `revealInLibrary()` in `actions.ts`), `groupAnnotations()` | Requested. |
| Saving files from the web viewer, beta.8: the web viewer pane is sized after it is laid out (it had no width yet when beta.7 tried); a file name template that fails or renders nothing says so (the default is used); new default `lastname_year_two-words`, stored old default replaced (`PREVIOUS_ATTACH_FILENAMES`, `evo-upgrade.ts`). New: "New item from this page's ISBN, in …": the ISBNs on the page (valid check digit, whole words), looked up at Open Library, else Google Books, a book item created in the library or collection shown last in a library tab, the page's file saved to it | `setPaneWidth()` in `actions.ts`; `attachFilenameFor()` in the worker service; `src/utils/evo-isbn.ts` (new, tested); `saveAsNewItem()`, `lookupIsbn()`, `createBookItem()` in `attach-file.ts`; `publishScope()`/`lastScope()` in `selection.ts` | Requested. The ISBN lookup calls Open Library and Google Books: unlike the rest of ZotFlow (AGENTS.md: network only for Zotero and WebDAV), and only when this menu entry is used. The file is got before the item is created, so a failed download creates nothing. |
| Reader, beta.8: the strip's button row shows only the fork's three toggles (not Obsidian's own buttons — more options, bookmark — nor "Open source note"); a right-click on the strip's title gives a menu with "Open source note" and "Open in library"; the authors' names open their notes; the page filter (below) is kept for every reader (`readerPdfFilter`) | `showTitleMenu()` and the `data-zf-evo-chrome` mark in `src/ui/reader/chrome.ts`; `authorList` of the banner (`itemBanner()`); `pdfFilter` in `ReaderNoteStrip` | Requested. |
| Opening a document at a search: a navigation with `evoFind` (`{ query, caseSensitive, entireWord }`) opens the reader's find bar with it, also when the document was closed | `finishPendingNavigation()` in `src/ui/reader/view.ts`; the reader's adapter (below) | For the full-text search. |
| Quiet syncs: an optional `quiet` flag from `startSync()` down to `SyncService.startSync()` suppresses the "Sync completed successfully!" notice | `src/ui/start-sync.ts`, `src/bridge/index.ts`, `src/worker/worker.ts`, `src/worker/tasks/manager.ts`, `src/worker/tasks/impl/sync-task.ts`, `src/worker/services/sync.ts` (one parameter each) | Automatic syncs run often; only their failures are reported. |

| Hooks for other plugins (beta.9): every change to what a collection holds — items added or taken out (top-level, not trashed; a trash counts as taken out), the collection itself created, renamed, moved, trashed or deleted — is told to other plugins (kanban-evo) as the workspace event `zotflow-evo:collections-changed` and through `app.plugins.plugins["zotflow-evo"].api.onCollectionsChanged()`. See "Hooks for other plugins" | `src/worker/services/evo-collection-watch.ts` (new: Dexie hooks on `items` and `collections`, gathered for 250 ms); started in `src/worker/worker.ts`; the `collectionsChanged` event and `CollectionChange` in `src/services/event-hub.ts`; `src/services/evo-api.ts` (new); `registerEvoApi()` in `src/main.ts` | Requested for kanban-evo's per-board collection inbox. On the database itself, so sync, edits here and collection writes all count. |
| Annotation strip tab (beta.9): the reader's note strip alone in a tab (command "Open annotation strip"), for the item of the line the cursor is on in another pane: the first link on that line to a source note, else the note itself if it is a source note; a line without one leaves it as it is. It shows the annotations of the item's first attachment (the one a double click opens, else the first of the best kind), PDF or snapshot. Same entries, editing, colours, drags and notes under an entry as beside a PDF; in the head only the colour filters and the highlights button. The page number (or Ctrl/Cmd+click) opens the place in a reader; the title's right-click menu opens the source note, the reader, the item in the library. See "Annotation strip tab" | `src/ui/evo-strip/strip-view.ts` (new: `EvoStripView`, a `ZoteroReaderView` with `evoStripOnly()`), `src/ui/evo-strip/follow.ts` (new: an editor update listener and `active-leaf-change`), `src/utils/evo-line-links.ts` (new). Hooks in `src/ui/reader/view.ts`: `evoStripOnly()`, `evoReaderOpened()`, `evoCloseDocument()`, no single-instance guard, no reading position saved, no source note refresh for it; `stripOnlyChromeOptions()`, `connectStripOnly()`, `showMenuOverFrame()` in `chrome.ts`; `stripOnly` and `noteStripOpen` in `src/types/zotero-reader.d.ts`; `registerEvoStrip()` in `src/main.ts` | Requested. The reader's own strip is reused, so its features need not be built twice; the document is loaded but out of sight. |
| Annotation edits reach the other views of the same attachment (beta.9): a reader or the strip tab that saves or deletes an annotation raises `annotationChanged`; the other views of that attachment read it again | `evoTellOthers()` in `src/ui/reader/view.ts` | So a reader and the strip tab showing the same file stay in step. |
| Library browser, beta.9: new collections (right-click on a library → "New collection…", on a collection → "New sub-collection…": a field in place, Enter creates it and shows it, Escape gives up), "Move collection to trash" (with the collections inside it, as Zotero does; its items stay), a Trash under each library (its trashed items, right-click → "Restore to library"; Delete does nothing there; opened, its trashed collections, right-click → "Restore to library", which brings back what is inside and what it is in). A collection inside a trashed one is not listed. Shift+drop of items on a collection moves them there from the collection shown | `createCollection()`, `trashCollection()`, `restoreCollection()` (Zotero's multi-object write) in `collection-edits.ts`; `collectionsWritten()`, `collectionFamily()`, `restoreItems()`, the trash scope (`EvoScope.trash`) and `trashedCollections` in `src/worker/services/evo-library.ts`; `moveItemsToCollection()`, `restoreItems()`, `DraggedItems.fromCollection` in `actions.ts`; `CollectionPane.tsx`, `LibraryBrowser.tsx`, `menus.ts` | Requested ("what else?" 1, 2, 3, 6). Permanent deletion is left out. |
| Library browser, beta.9: sorting by the attachment column puts items without a file first when descending (not always last); toggles that are on (match case, whole words, sub-collections, item pane) have a held-down background and a ring, not only a colour | `sortRows()` in `src/utils/evo-library-model.ts`; `.zotflow-evo-tool.is-on` in `styles.css` | Requested. |
| Item pane, beta.9: right-click on a PDF or EPUB → "Rename file from template": its `filename` becomes the file name template's result (extension kept; the title too where it was the old file name), as Zotero renames a file; every Zotero client renames its copy when it syncs the new name. Only files stored in Zotero | `renameAttachmentFile()` and `attachmentRename()` (`src/worker/services/evo-library.ts`, `src/utils/evo-library-model.ts`); `renameAttachmentFile()` in `actions.ts`; the menu in `ItemDetails.tsx` | Requested ("what else?" 9). Zotero's sync renames the local file when `filename` changes (`syncLocal.js`), and a WebDAV ZIP with one file is renamed on unpacking (`storageLocal.js`). |
| Full-text search, beta.9: no fading at the snippets' edges (the match's lines are scrolled to by whole lines); "N more in this document" is a row of its own in the accent colour | `SnippetView`, `HitView` in `FulltextSearch.tsx`; `styles.css` | Requested. |
| Reader, beta.9: the strip mirrors only the fork's toggles at last (beta.8 marked them but did not filter: the bookmark, more options and "Open source note" buttons were still in the strip); the title's menu closes on the first click outside it, also in the reader (a cover under the menu takes that click) | `headerActions()`, `showMenuOverFrame()` in `chrome.ts`; `.zotflow-evo-menu-cover` in `styles.css` | Fixes. |
| Groundwork, beta.9: the schema generator also writes the fields and creator types of each item type and Zotero's CSL-JSON mapping, for making an item from a DOI later. Nothing uses it yet | `scripts/generate-zotero-item-schema.js`; `src/types/zotero-csl-schema.ts` (generated) | Adding items by DOI, ISBN or URL was set aside: Zotero's own tools do it. |
| The full-text worker is stopped when the plugin unloads (beta.8 imported the stop but did not register it) | `registerEvoLibrary()` in `views.tsx` | Fix. |

Known limits and open checks of these (as of 1.7.1-beta.9):

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
- Saving a file to an item (beta.7) was checked against stand-ins for
  Zotero's and Anna's servers (`tests/unit/evo-attach-file.test.ts`); it
  has not run against them. Whether the web viewer fires Obsidian's link
  menu (`url-menu`) for links inside the page, whether a fast download link
  needs the page's login, and what address Anna's viewer has are not known
  here; the route that worked is named in the notice.
- Ctrl/Cmd+Alt+F on macOS is also Obsidian's "search and replace" in an
  editor; which of the two runs there is up to Obsidian.
- Full-text search was checked against copies of a real `fulltext.sqlite`
  and `zotero.sqlite` (Zotero 7.1/8) in Chromium, the view in the browser
  rig. Not checked here: the form of `.zotero-ft-cache` (whether pages are
  separated by form feeds, which gives the snippets their page), and the
  worker inside Obsidian. Without whole words a query also finds words
  that start with it, not words that contain it elsewhere (the index knows
  word starts only). Whatever Zotero still keeps in `zotero.sqlite-wal` is
  not in the copy until Zotero writes it into the database (items added
  minutes ago may be missing from the mapping).
- Renaming and moving collections, and the new item from an ISBN, were
  checked against stand-ins for Zotero's API, Open Library and Google
  Books.
- Creating, trashing and restoring collections (beta.9) were checked
  against a stand-in for Zotero's API; that the API takes `deleted: false`
  for a collection to restore it is from Zotero's data model, not from a
  run against it. Renaming a file sends only the new `filename` with the
  next sync; not checked against Zotero's servers or a second client.
- The annotation strip tab follows editors whose update listener Obsidian
  runs. Whether Kanban's card editors are among them is not known; if not,
  kanban-evo has to say which card is being edited. Reading view has no
  cursor: there only the note itself (a source note) is followed. The
  strip tab loads the whole document for each item it shows (hidden); a
  move to another item opens it anew. An EPUB has no strip.

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
| Note strip, beta.8: the head's buttons fade (out 140 ms, in 90 ms); no + button; a page filter button (PDF) opens sliders under the buttons — white threshold, contrast, saturation — which close when the pointer leaves the strip; a right-click on the title asks the plugin for its menu, a click on an author's name for their note (`noteStripAction` ids `title-menu`, `person:<name>`) | `StripHead`, `FilterPanel`, `HeadBanner`/`Byline` (`authorList`) in `note-strip.js`; the `hover` event of `strip-host.js`; styles in `_evo.scss` | Requested. |
| Colour filter over PDF pages, KOReader-like: saturation (an `feColorMatrix`), then one tone curve (an `feComponentTransfer` table): a white point (`whiteThreshold`: everything that close to white becomes white) and a gamma (`contrast`: above 1 text darker, white and black stay). On each page's canvas only (text layer, annotations untouched), also with the strip hidden | `applyPdfFilterTo()`, `applyPdfFilter()`, `pdfToneTable()` in `obsidian-evo.js`; called from `applyNoteStrip()` and an effect in `EvoNoteStrip` (views drawn again) | Requested ("white threshold, contrast and saturation"). Brightness is left out: a white point lifts the light greys of a scan without moving black, which is what makes faint scans readable. |
| Opening at a search: `navigate()` of the reader's adapter takes `evoFind` and opens the find bar with it (`startFind()`), after going to the place given with it | `navigate()` in `src/index.obsidian.reader.js`; `startFind()` in `obsidian-evo.js` | For the plugin's full-text search. |
| Note strip, beta.7: the head's buttons and colour filters show only while the pointer is over the strip (head or comments; a short linger covers the crossing); hidden they keep their room. The Obsidian view's header buttons stand first in that row (`actions`), then highlights and +; the filters move to a second line when the strip is narrow. New highlights icon (Lucide's highlighter: struck through when off, inked and accented when on); + is Lucide's plus | `_trackHover()` and `toTopPoint()` in `strip-host.js`; `StripHead`, `ViewAction`, `IconHighlights` in `note-strip.js`; `reportNoteStripAction()` in `obsidian-evo.js` (event `noteStripAction` with the click's place in the reader's document); styles in `_evo.scss` | Requested. The hover class is on the body of both documents (the root's classes are the reader document's). |
| Note strip, beta.7: anchored, with no comment in view, a small arrow at the top and/or the bottom with the page of the nearest comment that way | `arrowTargets()` in `strip-layout.mjs` (tested); `setArrows()` and the arrows' styles in `strip-host-pdf.js`; an effect in `Strip` | Requested. The arrows are in the PDF view's document, over the strip, and take no clicks (that document is the PDF view's). |
| Note strip, beta.7: a list whose comments are all folded away no longer says "No comments yet"; the head's title draws `<i>` in italics | `any` of the model in `Strip`; `titleRuns()` in `strip-layout.mjs` | Fixes. |

| The strip alone (beta.9, the plugin's annotation strip tab): `stripOnly` in the strip settings puts `zf-evo-strip-only` on the reader's body, the PDF view's root and the strip's documents: no toolbar or sidebar, the pages (or the snapshot) hidden, the strip across the whole reader as a list, no resize handle, no page filter. The page number opens the place, as does Ctrl/Cmd+click on an entry (`noteStripOpen` to the plugin); headings too. A click under an entry still starts a note after it; a click with nothing above does nothing (the place being read is not in sight) | `applyNoteStrip()`, `reportNoteStripOpen()`, `STRIP_ONLY_CLASS` in `obsidian-evo.js`; `setStripOnly()` in `strip-host.js`, `_applyStripOnly()` in `strip-host-pdf.js`; `stripOnly` in `Strip`, `StripHead`, `Card` (`onOpen`), `EvoNoteStrip` in `note-strip.js`; `_evo.scss` | Requested. |

Known limits of these: with the toolbar hidden, Tab still cycles through
the hidden toolbar's focus groups (`focus-manager.js` is untouched), and the
appearance and read-aloud popups keep their 41px offset.

### Full-text search

- **Whose index.** Zotero 7.1 and later keep their full-text index in
  `fulltext.sqlite` in the data folder: SQLite FTS5 tables without the
  text itself (`content=''`), the row id being Zotero's local item id. The
  text Zotero extracted is in `storage/<attachment key>/.zotero-ft-cache`.
  ZotFlow uses both and indexes nothing itself.
- **Never touching Zotero's files.** The plugin reads the bytes of
  `fulltext.sqlite` and `zotero.sqlite` (Node `fs`, desktop only) and hands
  them to a worker of its own, which opens them as in-memory, read-only
  databases (`sqlite3_deserialize`). `zotero.sqlite` is in WAL mode;
  only in the copy are bytes 18–19 of the header set to rollback mode so it
  opens. Copies are taken again when either file (or the -wal) changed,
  checked before each search. `zotero.sqlite` is read once per copy for
  the attachments (local id → key, parent key, library) and closed.
- **Only while used.** The worker (with SQLite's WebAssembly build, from
  `@sqlite.org/sqlite-wasm`, which has FTS5; sql.js has not) is bundled
  gzipped and started when a search view opens; it stops a minute after the
  last one closed, and with the plugin. Nothing runs otherwise.
- **Searching.** The query's words as one FTS5 phrase (a prefix on the last
  word unless "whole words") finds the documents, best first (`rank`), in
  the content table and the CJK table. They are kept to the items of the
  chosen collections (read from ZotFlow's database), at most 1000. Then
  each document's text is read and checked, six at a time: case and
  whole words as asked, accents ignored unless "match case" (as the index
  does). Documents without a match are dropped; ones whose text is not on
  this computer are listed as such.
- **Libraries.** Zotero's local library 1 is ZotFlow's personal library;
  groups are matched by group id. Items of libraries ZotFlow does not sync
  are not listed (they are not in any chosen collection).

### Hooks for other plugins

For kanban-evo (and other evo plugins), ZotFlow Evo tells when what a
collection holds has changed. Two ways to listen, whichever loads first:

```ts
// a workspace event (works before or after ZotFlow Evo loads)
this.registerEvent(app.workspace.on("zotflow-evo:collections-changed", (changes) => …));
// or the plugin's API (returns the function that stops it)
const off = app.plugins.plugins["zotflow-evo"]?.api?.onCollectionsChanged((changes) => …);
```

`changes` is a list of `{ libraryID, collectionKey, added, removed,
collectionChanged }`: `added` and `removed` are item keys that came into or
left the collection (top-level items only; moving an item to the trash
counts as leaving, restoring as coming back); `collectionChanged` says the
collection itself was created, renamed, moved, trashed or deleted. Only the
collection an item is directly in is named: a board that includes
sub-collections works out the parents itself. `api.version` is 1.

The news comes from the database (Dexie hooks in the worker), gathered for
250 ms, so a sync of many items is a few events. It is a hint to read again,
not a log: changes made while a listener was not there are not repeated, so
a board reads the collection when it opens. ZotFlow's database is the
IndexedDB database `zotflow-dev` (tables `items`, `collections`; see
AGENTS.md, "Database").

### Annotation strip tab

A tab with the note strip alone ("Open annotation strip"), beside the note
being written. When the cursor rests (150 ms) on a line of a note, the
first link on that line (`[[…]]`, `![[…]]`, `[…](…)`) to a source note
(`zotero-key` and `library-id` in its frontmatter) names the item; a line
without one leaves the strip as it is, unless the note is itself a source
note. Editors inside frames (the strip's own comment editors) are not
followed, nor the strip tab. Nothing runs while no strip tab is open.

The tab is a reader view (`EvoStripView extends ZoteroReaderView`) whose
reader is told `stripOnly`: the document is loaded and kept out of sight,
and the reader's own strip shows its annotations. So everything the strip
does beside a PDF it does here; what needs the page in sight (a note "for
what is being read", the page filter, going to an entry on the page) is
left out or opens a reader instead. Its scroll position is not kept as the
attachment's reading position, and it does not count as the attachment's
reader (a reader of the same file can be open beside it; edits in either
reach the other).

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
  when they do not fit; then the full title, bold, same size and colour
  (`<i>` in italics). Under them a row of buttons — the reader view's
  header toggles while that header is hidden, then highlights and (PDF)
  the page filter — and the colour filters (on a second line when
  narrow). The row fades in only while the pointer is over the strip;
  hidden, it keeps its room. A right-click on the title gives the
  plugin's menu (source note, open in library); authors open their notes.
- **Arrows (anchored).** With no comment in view, a small arrow at the top
  and/or bottom names the page of the nearest comment that way. They are
  drawn in the PDF view's document over the strip and take no clicks.
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
  the last one). With nothing above the click (an empty list) it goes
  after the last thing listed on the page being read — beside a snapshot:
  on screen (until beta.7 also the + button). Only with nothing there
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
