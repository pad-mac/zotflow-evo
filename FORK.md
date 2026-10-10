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

### Reader (`pad-mac/obsidian-zotero-reader-evo`)

All fork logic is in `src/obsidian-evo.js` and
`src/common/stylesheets/components/_evo.scss` (both new). Upstream files
only call into them; every such line is marked `ZotFlow Evo`.

| Change | Where | Why |
| --- | --- | --- |
| Obsidian's variables are read from the computed style of the element hosting the reader and written into the reader document and each view iframe | `refreshResolvedObsidianVariables()` / `applyResolvedObsidianVariables()` in `obsidian-evo.js`. Hooks in `src/index.obsidian.reader.js`: start of `createReader()`, start of `applyColorSchemeForAll()`, first line of `adoptObsidianStyles()` | Upstream only copies variables from rules whose selector is exactly `body`, `:root`, `.theme-light` or `.theme-dark`; anything a theme, snippet or Style Settings sets elsewhere was missed and the reader showed the default palette. Variables a reader document declares itself are never overwritten, and `--page-border` is never copied (same as upstream's filter). |
| Toolbar and the area around the page use `--background-primary` | `_evo.scss` overrides `--color-toolbar`; `main.scss` imports `components/evo` last | Requested. Upstream maps `--color-toolbar` to `--file-header-background`. |
| Toolbar can be hidden | `applyToolbarHidden()` sets `body.zf-evo-toolbar-hidden`; layout in `_evo.scss`. Child API `setToolbarHidden` in `src/index.obsidian.js`, option `toolbarHidden` read in `createReader()` | Requested. |
| Comment popup can be turned off | `applyAnnotationPopupSuppressed()` sets the reader state key `zfEvoSuppressAnnotationPopup`; one extra condition where `src/common/components/reader-ui.js` renders `AnnotationPopup`. Child API `setAnnotationPopupSuppressed`, option `annotationPopupSuppressed` | Requested. Same mechanism upstream uses while the annotations sidebar is open. |

Known limits of these: with the toolbar hidden, Tab still cycles through
the hidden toolbar's focus groups (`focus-manager.js` is untouched), and the
appearance and read-aloud popups keep their 41px offset. With the comment
popup off, comments are edited in the annotations sidebar until the note
strip exists.

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
