# AGENTS.md

Rules for agents working in this repository: the dsh-layerfs plugin bundle.
[README.md](README.md) is the guide to install, run and develop it.

## What this repository is

- **This is the LayerFS UI.** The LayerFS UI is the dsh LayerFS plugin: the
  Work and History tabs and the LayerFS page in DeepSeek Harness (dsh) web
  (owner, 2026-10-19). LayerFS itself ships no UI and no HTTP
  ([layerfs #428](https://github.com/Ephemeral-AI-Lab/layerfs/issues/428)).
  This repository owns the `/layerfs` routes (`packages/host/src/route.js`),
  the UI reads (`trees.js`, `reads.js`, `storage.js`), the view model
  (`packages/model`), the views (`packages/view`) and the client
  (`packages/client`). Do not build or revive standalone HTML or TUI pages.
- **The demo bundle stays retired.** The `dsh-layerfs-demo` bundle is
  disabled permanently (owner, 2026-10-21): do not add it back, install it,
  or write guides that do.
- **The LayerFS scripted model ships on** (owner, 2026-10-24, replacing
  "ships off" of 2026-10-23;
  [dsh-layerfs#1](https://github.com/Ephemeral-AI-Lab/dsh-layerfs/issues/1)).
  `@dsh-layerfs/mock` is a row of the dsh-layerfs bundle, enabled, with this
  checkout's `scenarios/`; a person can turn it off from dsh's Plugins page.
  Its scenarios touch only
  projects named `mock-…`, and each run has a 15-minute limit
  (`packages/mock/src/progress.js`). Every scenario runs on LayerFS; the
  simulator (Mocked LayerFS) was removed on 2026-10-23.
- It moved here from the layerfs repository's `dsh/` folder at `cea713e767`.
  The #352 history replay harness stayed there; the demo scenarios moved
  here as the scripted model's scenarios.

## LayerFS comes from `LAYERFS_SOURCE`

- LayerFS (the JavaScript SDK, the agent skill, the Linux `layerfs-daemon`
  and `layerfs.node`, and LayerFS's own tools such as `tools/worktree.py`)
  comes only from the checkout named by `LAYERFS_SOURCE`: a path, relative to
  this repository's root or absolute. Unset, it is `../layerfs`.
- [`layerfs.json`](layerfs.json) pins the default path and the LayerFS commit
  this repository is tested at. `pnpm run check:layerfs` fails unless the
  checkout is at that commit; run it before live testing and say which
  commit you tested if it differs.
- `pnpm install`, `pnpm test` and `pnpm run link:layerfs` point the
  git-ignored `.layerfs` link at that checkout
  ([`tools/layerfs-source.mjs`](tools/layerfs-source.mjs)). Code reaches
  LayerFS only through `.layerfs` (`packages/host/src/source.js`) or the
  `@layerfs/agent`, `@layerfs/backend` and `@layerfs/runtime` packages linked
  through it. Never add a relative path into a sibling checkout
  (`../../../api`, `../layerfs/core/target`, ...), and never deep-import a
  package's files.
- Use the packages' public entry points (#428). `@layerfs/agent/internal` is
  not a public API: do not import it. Clients come from `LayerFS.open` or
  `LayerFS.init`; backend calls from `LayerFSBackend.of(client)`; the worker,
  Init, removal, status and leftovers from the Host's one `LayerFSRuntime`.
  What the packages lack is reported to the layerfs repository, not copied
  into the Host.
- Never edit, commit or branch in the LayerFS checkout from here; its only
  writes are the Linux build of README step 1, and only when asked. If a
  change needs LayerFS to change, report it for the layerfs repository.
- Store calls run only through the SDK. The macOS and Windows workers (the
  runtime's, open to the dsh adapter only) are owner-approved exceptions for this plugin only
  (layerfs `AGENTS.md`, 2026-10-20 and 2026-10-22); do not extend them.

## Calls, tests and dsh web

- **One attempt per call.** No automatic retry, busy loop, refresh or replay
  of a failed call. A lost reply is `Unknown`: show it, never resend a
  mutation. Readiness waits are not retries.
- **Every test command has a wall timeout of at most 120 s.** Give each
  invocation an explicit timeout and stop it when it expires; never leave one
  running, background it to wait it out, or wrap it in a repeat loop. A test
  that reaches the limit has failed as a hang: diagnose it from source and
  bounded output before any rerun. macOS has no `timeout`; use
  `perl -e 'alarm 120; exec @ARGV' <command>`.
- `pnpm test` stubs LayerFS (fake Docker, recorded traces) and starts no container or daemon. Live tests (a dsh web run; the
  worker's own live tests are LayerFS's) need a built LayerFS from
  `LAYERFS_SOURCE` and are run on purpose, never as part of `pnpm test`.
- **Never restart dsh web while a run is live.** A restart stops the agents'
  turns and replaces the worker under their calls. Never retire the older
  macOS Store container (`layerfs-store`) while a run may be on it.
  Change Host settings, the bundle or the worker only while no run is live.
  Do not start, stop or restart a dsh web you did not start.
- When code moves or is refactored, a test that is hard to adapt is deleted,
  not nursed; list deleted or skipped tests in the commit message. Never
  weaken a surviving test's assertion to make it pass.
