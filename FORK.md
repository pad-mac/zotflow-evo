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

### Reader (`pad-mac/obsidian-zotero-reader-evo`)

None yet. `zotflow` is identical to upstream at `e6dfec28`.

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

- The tag's commit must be on `dev` (both release workflows check this).
- **Test build:** annotated tag `x.y.z-beta.N` on `dev` → published
  prerelease with `main.js`, `manifest.json`, `styles.css`. The workflow sets
  the version in the runner; version files are not committed. Never move or
  reuse a published tag.
- **Stable build:** `npm version patch|minor|major` on `dev`, push commit and
  tag → a *draft* release that has to be published by hand.
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
