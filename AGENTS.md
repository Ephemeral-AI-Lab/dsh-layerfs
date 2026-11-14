# dsh-layerfs — agent notes

LayerFS Connect's Machines, Storage and explicit project-owned sessions
(`sessions.choose` / `state.pending`): project files live in LayerFS, and the
selected local folder is scratch. Normal sessions belong to DSH workspaces.
Project conversations use native unpacked DSH logs with additive annotations
under `projectSessionHome` (default `$DSH_HOME/layerfs/project-sessions`; dev must override), the LayerFS session store
and trajectory checkpoints, as a DeepSeek Harness (DSH) cordis plugin bundle.
Current specs: `docs/specs/project-sessions.md`, and `docs/specs/homes.md` for
the two homes (`LAYERFS_HOME`, default `~/.layerfs`, holds LayerFS's records,
runtime and secrets; `$DSH_HOME/layerfs` holds this plugin's state). Earlier design docs:
`../layerfs-connect/docs/dsh-layerfs/`.

## Hard rules

- **Never modify DeepSeek Harness. Everything is a cordis plugin.** dsh-layerfs
  is a DSH cordis plugin bundle and nothing else: every feature, host or client,
  is a cordis plugin in this repo, loaded through the bundle and built only on
  DSH's public plugin seams — services, slots, Remote namespaces, events, client
  registration, and the bundle patch (`cordis.patch.yml`, which may only
  disable/insert/configure rows). No exceptions: not for a one-line fix, a
  temporary hack, a local-only experiment or "just to unblock a test".
  - Do not edit, fork, vendor or patch DSH source or packages anywhere: not
    `../deepseek-harness` (its code or its installed profiles'
    `node_modules`), `../deepseek-harness-source`, nor
    `node_modules/@deepseek-ai/*` here (no `patch-package`, postinstall
    rewrites, copied-and-edited DSH files, or local DSH builds swapped in).
  - Do not import DSH internals (`@deepseek-ai/<pkg>/src|lib|dist/...`) or
    monkey-patch DSH objects/prototypes at runtime; use exported entry points only.
  - Replacing a stock row is done by disabling it in `cordis.patch.yml` and
    inserting our own row (subclassing or wrapping the stock export), as
    `layerfs-session-persistence` and `layerfs-sandbox-policy` do.
  - New behaviour is a new cordis plugin (a host row inserted by
    `cordis.patch.yml`, a client plugin registered from `src/client/`), never a
    change outside this repo.
  - If a feature needs a seam DSH does not expose, stop and report it (what seam,
    why) instead of working around it; a change to DSH is the user's call, and
    until they make it the feature waits.
- Never modify `../layerfs-connect` or `../layerfs` either (read-only references).
  Never edit the user's LayerFS home (`~/.layerfs`) by hand, and never point a dev
  server or test at it: they always use a private home (`DSH_LAYERFS_HOME`). Only
  the app (3080) and the CLI change it.
- **The LayerFS build tracks the latest `layerfs_v2_0_0`.** The pinned CLI, daemon
  and Linux bundle are built from the tip of
  [`layerfs_v2_0_0`](https://github.com/Ephemeral-AI-Lab/layerfs/tree/layerfs_v2_0_0)
  (`git -C ../layerfs fetch origin layerfs_v2_0_0`, then build `origin/layerfs_v2_0_0`
  in a registered LayerFS worktree, see "LayerFS build" under Commands), not from
  `main` or an older commit. Building there is allowed; editing its sources is not.
- **Every result ends up on DSH's default port 3080.** That is the user's DeepSeek
  Harness (`dsh web --port 3080`, run from `../deepseek-harness` with
  `DSH_HOME=../deepseek-harness/state`); its `web` profile links dsh-layerfs from
  one checkout (`link:` in `state/profiles/web/package.json`, currently
  `../dsh-layerfs-integrate`). You may develop and verify in your own worktree and
  on a side server, but work is not done until it is merged into the checkout 3080
  links and checked on 3080 (see "Shared server on 3080"). Change 3080's state only
  through the app, the host API and `dsh plugin` commands, never by hand-editing
  or deleting files under `state/`.
- Node 24: `export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"`.

## Shared server on 3080 (multiple agents)

Several agents may work on this repo at the same time; each funnels its results
into the one 3080 server. That is expected; coordinate instead of competing for it.

1. **Develop and verify on the side.** Work in your own git worktree and/or on a
   private side server (`scripts/dev.mjs` with a `.dev*/` dir on a non-3080 port).
   Run the build, typecheck, unit tests and whichever e2e tests cover your change
   there (fake-llm e2e, store import and preset home resets need a private home, so
   they always run on a side server). Kill only your own side server (match its
   `.dev*/overlay.yml` path) and stop it when done.
2. **Merge into the 3080 checkout.** Once verified, merge your work into the
   checkout 3080 links (find it with
   `grep dsh-layerfs ../deepseek-harness/state/profiles/web/package.json`). Merge,
   never overwrite: other agents' work may already be there, uncommitted included,
   so keep it, resolve conflicts with both sides intact, and do not reset, stash
   or check out over it. If another agent is merging at the same moment, wait for
   it to finish.
3. **Check it on 3080.** Rebuild in that checkout (`node scripts/build.mjs`; client
   changes hot-reload for everyone) and confirm your change works on 3080 together
   with everyone else's. Host changes need a 3080 restart: first check no other
   agent is mid-test there and tell them, then restart it exactly as it was started
   (cwd `../deepseek-harness`, same `DSH_HOME`,
   `node node_modules/@deepseek-ai/dsh/lib/bin.js web --host 127.0.0.1 --port 3080 --no-open`).
   Never kill it silently and never re-link the profile to another checkout.

- Find the other agents (ListAgents / linked sessions) at the start and tell them
  what you are about to merge or restart.
- On 3080, name everything you create with a prefix unique to you (Stores,
  projects, sessions, machines), remove only your own when done, and leave the
  LayerFS home alone (no preset Reset there without the user's OK).
- The 3080 page needs its authenticated URL: pass it to `tools/shot.mjs <url>` /
  `openDev({ url })`; do not write the token into tracked files or chat.

## Layout

- `src/host/` host half (ESM, bundled to `lib/index.js`)
  - `remote.ts` the hand-written `layerfs` Remote (`call {op,args}` + `events` stream)
  - `service.ts` `ctx.layerfs` (pinned CLI/daemon, LAYERFS_HOME, events, JSON state)
  - `layerfs/cli.ts` pinned-CLI SDK (`ctx.layerfs.lfs.<family>.<call>(...)`), port of Connect `host/cli`
  - `routes/` Connect's host HTTP API served as op `http` `{method,path,body}` -> `{status,body}`
  - `sessions/` session binding (`placeOf`: existing binding, pending placement,
    durable persistence owner, subagent context, or a plain folder session), legacy anchors under
    `<root>/projects` (fallback scratch parents, not DSH workspaces), checkpoints,
    LayerFS session store (mirror, discover, import, sync)
  - `session-persistence.ts` the `layerfs-session-persistence` row (`lib/session-persistence.js`):
    owner routing over isolated stock JSONL backends, unpacked project logs,
    additive `layerfs.json`, validated migration, and imports on a local miss
  - `layerfs/tracing.ts` execution-scoped receipts: one receipt id and log tag
    (`LAYERFS_LOGS_TAG=dsh:<sessionId>:<receiptId>`) per call, SDK receipts, the managed
    `agent-bin/layerfs` wrapper (node with the stand-in; a bash script with LayerFS's native
    log, outputs teed to `trace/outputs/raw/`), receipts rebuilt from tagged call log lines (no spool);
    `workspace.exec` never gets checkpoint links
  - `layerfs/call-log.ts` the call log stand-in `<root>/trace/calls.jsonl` (LayerFS #659
    lines: render, redact, append, rotate, list, reset) while the pinned CLI has no `logs` family
  - `logs/` `logs.list` / `logs.reset` ops on the native log or the stand-in (`source.ts`),
    lines labelled with session, turn and checkpoint (`Checkpoint.receipt`), `logs` event
  - `presets/` Presets: `manager.ts` (`/api/demo-presets…` on the `http` op, admission,
    durable jobs in `<root>/presets/`), `driver.ts`, and LayerFS Connect's runner/recipe
    kept as JavaScript (`runner.js`, `build.js`, `environment-reset.js`, `recipe/` copied
    from Connect `tools/demo/`, typed through `js.ts`) so they stay diffable against Connect
  - `sandbox-policy.ts` the `layerfs-sandbox-policy` row (`lib/sandbox-policy.js`)
- `src/client/` browser half (React 18, CSS Modules, bundled to `lib/client.js` in
  DSH's `__ModuleLoader__` factory format)
  - `api.ts` `LayerfsApi` (`call(method,path,body)`, `op(name,args)`, `onEvent`)
  - `machines/`, `storage/`, `presets/`, `logs/`, `session/`, `picker/`, `hero/`, `views/` areas, each
    `register<Area>(ctx, api)`; `picker/` owns the shared `NewProjectForm` + locale,
    `hero/` puts the project choice on the New Session row (`conversation.hero.options`
    + the `session.place` op), `views/` adds the Files/History/Sandbox conversation
    tabs for project sessions (`conversation.view`, docs/specs/conversation-views.md)
    and replaces their Trajectory tab with the LayerFS trajectory while a project
    session is on screen (LayerFS mode: same id, lower priority, and the stock
    `ui-trajectory` browser entry suspended through the cordis Loader so the tab
    shows once; DSH sessions keep the stock one; tool calls → LayerFS calls →
    versions, `session.trajectory`, docs/specs/layerfs-trajectory.md),
    `session/` only marks project rows (there is no LayerFS side panel).
    Add-workspace flows are stock DSH folder picking.
- `src/shared/remote-spec.ts` Remote descriptors shared by both faces.

## Commands

- Build: `node scripts/build.mjs` (both faces). Typecheck: `npx tsc -p tsconfig.json`.
- Tests: `node --test test/*.test.mjs` (`routes.test.mjs` incl. a live pinned-CLI case;
  `sessions.test.mjs` placeOf, Scratch project, pre-step guarantee, persistence row).
- Side server (for verification before merging into 3080, see above):
  `node scripts/dev.mjs [--port N]` with `DSH_LAYERFS_DEV_DIR=<abs dir>`
  for a private DSH_HOME + LayerFS home (default `.dev/`, port 3091). It installs
  this checkout into the private `web` profile with `dsh plugin add link:` and writes
  the authenticated URL to `<dev dir>/url.txt`. Client rebuilds hot-reload; host
  changes need a server restart. Pinned CLI/daemon/bundle come from `DSH_LAYERFS_CLI`/
  `DSH_LAYERFS_DAEMON`/`DSH_LAYERFS_BUNDLE`, else the newest runtime installed in
  `~/.layerfs/runtime` (the build the app pins; read only, `scripts/runtime-pin.mjs`).
  Set the env vars to test your own build.
- LayerFS build (latest `layerfs_v2_0_0`): fetch the branch, check out
  `origin/layerfs_v2_0_0` in a LayerFS worktree registered with `tools/worktree.py`
  (`docs/general/parallel-worktrees.md` in that repo), then build the host pair with
  `python3 tools/worktree.py build --resources <R> --platform macos` (it prints the
  sealed bundle holding `layerfs` and `layerfs-daemon`; point `DSH_LAYERFS_CLI`/
  `DSH_LAYERFS_DAEMON` there) and the Linux bundle with `python3 tools/linux_bundle.py
  daemon|worker|helper|seal --resources <R>` (point `DSH_LAYERFS_BUNDLE` at
  `<cache>/layerfs/bundle/<version>/linux-<arch>/`). Record the commit you built, and
  rebuild when the branch moves.
- A git worktree of this repo needs its own `node_modules` (`cp -cR ../dsh-layerfs/node_modules .`
  clones it on APFS). A symlink makes DSH resolve `dsh-layerfs/client` by package
  self-reference from the main checkout, so the browser runs the other checkout's client.
  `dev/fake-llm.overlay.yml` names the main checkout's `dev/fake-llm/index.js`; in a
  worktree pass a copy naming the worktree's.
- Browser: `node tools/shot.mjs dev /tmp/x.png [--size 1280x820] [--steps steps.mjs]`
  (system Chrome via playwright-core; step modules `export default async (page) => {}`;
  `tools/ui.mjs` has `dismiss`/`openPanel`). `node tools/op.mjs <op> '<json>'` calls a
  host operation through a real page (`window.__dshLayerfs`, enabled by the
  `dsh-layerfs:debug` localStorage flag the tools set).

## Verification

- `node scripts/build.mjs && npx tsc -p tsconfig.json && node --test test/*.test.mjs`
- End to end with the keyless scripted model (`dev/fake-llm`): start the dev server with
  `DSH_LAYERFS_DEV_OVERLAY=$PWD/dev/fake-llm.overlay.yml node scripts/dev.mjs`, then
  `node test/e2e-sessions.mjs` (project session, checkpoints, restore, branch, store,
  persistence row, plain folder sessions, the LayerFS Projects group, the New Session
  project control, panel UI; cleans up unless `--keep`).
- Session store portability: a second server sharing the LayerFS home
  (`DSH_LAYERFS_DEV_DIR=$PWD/.dev-import DSH_LAYERFS_HOME=$PWD/.dev/layerfs-home ... --port 3096`),
  then `A_DIR=$PWD/.dev B_DIR=$PWD/.dev-import node test/e2e-store-import.mjs` (explicit
  import, open by id alone through the persistence row, folder sessions never stored).
- Presets: `test/presets.test.mjs` (admission, request-ID reconciliation, restart recovery,
  the router's exclusive guard, script paging, live reset of a private home). A real Studio
  Build needs Docker, Lima and `DSH_LAYERFS_BUNDLE` (a Linux bundle built from the same `layerfs_v2_0_0` commit as the CLI) on the
  dev server; it creates two Lima VMs (2 CPU, 4 GB) in the dev LayerFS home, so stop its
  machines from the home's Presets dialog (head card → Presets → Studio → Stop machines…)
  afterwards. A real Starter Build (`quickstart`: one SQLite Store on docker, 552 commits on
  20 branches) needs only Docker and the bundle and takes under a minute; stop the dev home's
  docker machine afterwards (`layerfs machine stop docker` with that home's
  `LAYERFS_HOME` and `LAYERFS_BUNDLE`).
- `node tools/cleanup-dev.mjs` removes leftover `e2e*`/`imp*` Stores through the host API.
- After side verification passes, merge into the 3080 checkout and check it on 3080
  (see "Shared server on 3080"); that is the last step of every task.

## UI rules (match DSH)

Follow DSH's `docs/web-styling.md` (in `../deepseek-harness-source`): CSS Modules +
`clsx`, only `--dsw-alias-*` semantic tokens (no literal colors, no Tailwind),
0.5px hairline neutral borders, elevated surfaces use `--dsw-elevation-*` shadows,
hover styles under `@media (hover: hover)`, reuse `@deepseek-ai/dsh-client-ui-primitives`
(runtime-shared module) before writing a control, all copy in locale dictionaries.

## Data loading rules (UI)

Host reads are CLI processes queued one per Store behind agent work, and during a team
run events arrive many times a second. Every view follows these:

- **Never drop a read for a refresh.** An event or tick queues one more read after the
  running one; only a change of what is shown (project, Branch, pinned version, filters)
  replaces it. Use `useQuery(load, deps, { refresh: [tick] })` (`src/client/files/use-query.ts`),
  never a `live = false` cleanup keyed on a tick.
- **Keep what is on screen.** A refresh rereads in the background; a spinner shows only
  when there is nothing to draw yet. Pass `cache: '<key>'` so a remount (a tab switch)
  draws the last answer at once, then reads again.
- **Load progressively, most useful first.** Draw as soon as one piece can be shown: History
  draws lanes from the Branch list, then main's and the session Branch's Commits, then
  the rest in batches as they land; Files draws the session Branch's folder tree at its
  tip without waiting for the Branch list.
- **Debounce and filter events.** Act only on events for the view's own session or
  project, coalesced (≥ 500 ms; heavy reads such as log scans 3 s, and only while the
  page is visible). Don't refetch a whole payload per `logs` or `layerfs-operation` event.
- **Reread only what moved.** A Branch whose head is unchanged keeps its pages; a page read
  at a named Commit never changes.
- **Host side:** polling reads go through the SDK client's kept answers (`KEPT_READS` in
  `src/host/layerfs/cli.ts`), and no request handler re-reads or re-parses a whole file
  per call (see the call log's incremental parse in `src/host/layerfs/call-log.ts`).
