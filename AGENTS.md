# dsh-layerfs — agent notes

LayerFS Connect's Machines, Storage, project + scratch-folder workspaces, the
LayerFS session store and trajectory checkpoints, as a DeepSeek Harness (DSH)
cordis plugin bundle. Design docs: `../layerfs-connect/docs/dsh-layerfs/`.

## Hard rules

- Never modify `../deepseek-harness`, `../deepseek-harness-source`, `../layerfs-connect`
  or `../layerfs` (read-only references). Never touch the user's `~/.layerfs` or
  `../deepseek-harness/state`. All dev state lives in `.dev*/` of this repo.
- DSH is consumed only through its public plugin seams: services, slots, Remote
  namespaces, events, the bundle patch (`cordis.patch.yml`). No forks of DSH packages.
- Node 24: `export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"`.

## Layout

- `src/host/` host half (ESM, bundled to `lib/index.js`)
  - `remote.ts` the hand-written `layerfs` Remote (`call {op,args}` + `events` stream)
  - `service.ts` `ctx.layerfs` (pinned CLI/daemon, LAYERFS_HOME, events, JSON state)
  - `layerfs/cli.ts` pinned-CLI SDK (`ctx.layerfs.lfs.<family>.<call>(...)`), port of Connect `host/cli`
  - `routes/` Connect's host HTTP API served as op `http` `{method,path,body}` -> `{status,body}`
  - `sessions/` session binding, scratch folders, checkpoints, LayerFS session store
- `src/client/` browser half (React 18, CSS Modules, bundled to `lib/client.js` in
  DSH's `__ModuleLoader__` factory format)
  - `api.ts` `LayerfsApi` (`call(method,path,body)`, `op(name,args)`, `onEvent`)
  - `machines/`, `storage/`, `session/` areas, each `register<Area>(ctx, api)`
- `src/shared/remote-spec.ts` Remote descriptors shared by both faces.

## Commands

- Build: `node scripts/build.mjs` (both faces). Typecheck: `npx tsc -p tsconfig.json`.
- Tests: `node --test test/*.test.mjs`.
- Dev server: `node scripts/dev.mjs [--port N]` with `DSH_LAYERFS_DEV_DIR=<abs dir>`
  for a private DSH_HOME + LayerFS home (default `.dev/`, port 3091). It installs
  this checkout into the private `web` profile with `dsh plugin add link:` and writes
  the authenticated URL to `<dev dir>/url.txt`. Client rebuilds hot-reload; host
  changes need a server restart. Pinned CLI/daemon come from `DSH_LAYERFS_CLI`/
  `DSH_LAYERFS_DAEMON`, else `../layerfs-connect/desktop/.env.local`.
- Browser: `node tools/shot.mjs dev /tmp/x.png [--size 1280x820] [--steps steps.mjs]`
  (system Chrome via playwright-core; step modules `export default async (page) => {}`;
  `tools/ui.mjs` has `dismiss`/`openPanel`). `node tools/op.mjs <op> '<json>'` calls a
  host operation through a real page (`window.__dshLayerfs`, enabled by the
  `dsh-layerfs:debug` localStorage flag the tools set).

## Verification

- `node scripts/build.mjs && npx tsc -p tsconfig.json && node --test test/*.test.mjs`
- End to end with the keyless scripted model (`dev/fake-llm`): start the dev server with
  `DSH_LAYERFS_DEV_OVERLAY=$PWD/dev/fake-llm.overlay.yml node scripts/dev.mjs`, then
  `node test/e2e-sessions.mjs` (project session, checkpoints, restore, branch, store, scratch,
  panel UI; cleans up unless `--keep`).
- Session store portability: a second server sharing the LayerFS home
  (`DSH_LAYERFS_DEV_DIR=$PWD/.dev-import DSH_LAYERFS_HOME=$PWD/.dev/layerfs-home ... --port 3096`),
  then `A_DIR=$PWD/.dev B_DIR=$PWD/.dev-import node test/e2e-store-import.mjs`.
- `node tools/cleanup-dev.mjs` removes leftover `e2e*`/`imp*` Stores through the host API.
- Kill only your own dev server (match its `.dev*/overlay.yml` path in the command line).

## UI rules (match DSH)

Follow DSH's `docs/web-styling.md` (in `../deepseek-harness-source`): CSS Modules +
`clsx`, only `--dsw-alias-*` semantic tokens (no literal colors, no Tailwind),
0.5px hairline neutral borders, elevated surfaces use `--dsw-elevation-*` shadows,
hover styles under `@media (hover: hover)`, reuse `@deepseek-ai/dsh-client-ui-primitives`
(runtime-shared module) before writing a control, all copy in locale dictionaries.
