# Writing and updating the UI guide

The guide explains dsh-layerfs's UI page by page: what each page is for, what
every component on it shows, what each interaction does, and which LayerFS CLI
call runs behind it. This file is the template and the rules every page follows.

## Files

```
docs/guide/
  README.md          the guide's landing page: the map
  <page>.md          one page of the UI (home, store, project, machine, …)
  components.md      parts used on more than one page, explained once
  cli-map.md         every interaction → host route → LayerFS call
  cli-routes.md      generated: every host route → LayerFS calls
  img/<page>-<what>.png
tools/guide/
  shoot.mjs          the screenshot runner
  shots/<page>.mjs   one shot module per page
  cli-map.mjs        generates cli-routes.md
  calls.mjs          runs host operations on a dev server (fixtures)
  fixture-session.mjs  one project conversation with a few LayerFS writes
```

## Words

- Use the UI's own words, exactly as the English locale has them (`src/client/**/locale.ts`).
  Buttons and menu items in **bold**, page and tab names as they appear.
- Write places as paths: `LayerFS › Store › demo-starter › Backups`. Menus: `⋯ › Back up to…`.
  DSH has no URLs, so a path is how a reader finds a place.
- Center's first page is called **Home** in the UI. The guide's own landing page is the
  README, never "home".
- Explain the UX, not the code: what the reader sees, why it is there, what happens
  when they press it, what the states mean, what to do when something is disabled.
  Source files go only in each page's last section.

## A page

```markdown
# <Page name>

> **Where:** `LayerFS › …` · **Opens from:** … · **Source:** see the end

One or two sentences: what this page is for and when you come here.

![<Page>, numbered](img/<page>-overview.png)

| # | Component | What it is |
|---|---|---|
| 1 | Nav bar | [Components › Nav bar](components.md#nav-bar) |
| 2 | … | … |

## Layout
Header, tab bar, body: one short paragraph.

## <Tab name>            (one section per tab; a page without tabs has one "Body" section)
![…](img/<page>-<tab>.png)

What the tab answers, in a sentence or two.

| Component | What it shows | Interaction → result | LayerFS call | States |
|---|---|---|---|---|
| Store card | … | **Open** → the Store page | `store list` (read) | loading, broken, needs you |
| | | **⋯ › Compact** → confirm → a job card | `store compact` | disabled while a job runs |

## Variants
SQLite vs PostgreSQL, the macOS host machine vs Docker/Lima, tabs that only show sometimes: what changes and why.

## Modals opened here
| Modal | Opened by | What it does | LayerFS call | Undo |
|---|---|---|---|---|

## States and signals
What a disabled control, a notice or a badge on this page means, and what to do.

## Where next
Links to the pages this one leads to.

## Source
`src/client/…` files this page describes.
```

## The LayerFS call column

- Write the call short: `store move`. Use the full form (`layerfs store move <store> <machine>`)
  only in prose where a reader may type it.
- **Several calls:** say so (`machine stop` then `machine start`; `store move` ×2 through the host machine).
- **Reads:** mark what a view reads to draw itself with "(read)". Writes have no mark.
- **No call:** `—` with why (host memory, local view state, a remembered tab).
- **Secrets:** passwords and bucket keys go to LayerFS on stdin; never show one in an example.
- Find a call by following the client's `api.call(method, path)` or `api.op(name)` to the
  host route (`src/host/routes/router.ts`, `cli-routes.md`) or operation (`src/host/**`),
  and the handler to its `lfs.<family>.<call>(` calls. The Logs page lists the calls a
  click actually ran, tagged with its session: use it to check.
- Every interaction also goes in [cli-map.md](cli-map.md).

## Screenshots

- Take them with `tools/guide/shoot.mjs` on a dev server, never by hand and never on 3080:
  ```bash
  DSH_LAYERFS_DEV_DIR=$PWD/.dev-guide node tools/guide/shoot.mjs tools/guide/shots/store.mjs
  ```
- 1440×900 at 2× unless a shot needs another size. Crop to a component with `clip` when
  the whole page adds nothing. Callouts are numbered in the order of the page's key table.
- A page whose phone layout differs gets a phone shot too: 390×844 at 2×. When the words
  are updated before the phone pass, the guide describes the phone behaviour in prose;
  the shot comes later and no other page's image needs re-shooting for it.
- Name images `<page>-<what>.png`. Delete `img/_failed-*.png` once a shot passes.
- The fixture: the Starter preset Store `demo-starter` (project `bookshelf`, Sandbox
  `guide-box` on the Docker machine), the Store `guide-notes` on `macos-host` (project
  `handbook`, a project conversation from `fixture-session.mjs`), and the bucket
  `guide-backups` (a local MinIO) holding one backup of `guide-notes`.
- Screenshots never show a secret, a token or the authenticated URL.

## Rebuilding the fixture

The shots expect the fixture described above, on a private dev server with the keyless
scripted model. To build it from nothing:

1. Start a side server with its own home (port 3097 here; never 3080):
   ```bash
   DSH_LAYERFS_DEV_DIR=$PWD/.dev-guide DSH_LAYERFS_DEV_OVERLAY=<a copy of dev/fake-llm.overlay.yml naming this checkout's dev/fake-llm/index.js> node scripts/dev.mjs --port 3097
   ```
2. Build the Starter preset from the Presets dialog (Home › Try a preset › Starter), or read
   its plan with `GET /api/demo-presets/quickstart/build-plan` and post it to
   `/api/demo-presets/quickstart/environment-reset` through `tools/guide/calls.mjs`.
3. Through `tools/guide/calls.mjs`:
   - make the Sandbox `guide-box` (`POST /api/projects/demo-starter%2Fbookshelf/sandboxes`);
   - make the Store `guide-notes` (`POST /api/stores`) and its project `handbook` (`POST /api/projects` with a `source` folder);
   - connect a local MinIO bucket as `guide-backups` (`POST /api/buckets`, test keys you generate);
   - back up `guide-notes` to it (`POST /api/stores/guide-notes/backup`).
4. `node tools/guide/fixture-session.mjs guide-notes/handbook` makes the project
   conversation. Put the session id it prints into the shot modules that name one
   (`readme.mjs`, `conversation.mjs`).
5. Mount a Workspace `guide-ws` in `guide-box` on a side Branch from the Sandbox page's
   **New workspace** form, and run a read-only command in it.

When you're done, stop the dev home's Docker machine (`layerfs machine stop docker` with that
home's `LAYERFS_HOME` and `LAYERFS_BUNDLE`), the MinIO container and the side server.

## Updating

When the UI changes: rerun the page's shot module, update its tables, regenerate
`cli-routes.md` (`node tools/guide/cli-map.mjs`), and check `cli-map.md`.
