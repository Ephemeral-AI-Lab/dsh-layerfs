# Backend end-to-end tests: performance, caches, lazy loading, issue detection

> **Status:** Build order items 1–4 are implemented (2026-11-13): cache and
> call-table tests, `ui.perf`, the crawl and `host.perf`; `e2e-lazy`,
> `e2e-fault` and tier L are not built. Written from a
> read-only review of the host routes, the CLI SDK and the session ops against
> the pinned CLI (2.0.0 @ ba87a425, an ancestor of `layerfs_v2_0_0`). No new
> dependencies: `playwright-core` is installed; `axe-core` is not. What exists
> and how to run it: §6; what the suites found: §8.

## 1. Goal

Catch, before they reach 3080:

- **Performance regressions** in what a page or action costs: CLI processes
  spawned, CLI call durations, Remote round-trips, time to first content.
- **N+1 fan-out**: a page whose CLI calls grow with the number of projects,
  branches, commits or files.
- **Cache bugs**: a repeated read that spawns again, a write the next read does
  not show, a staleness window longer than designed.
- **Lazy-loading bugs**: data fetched before a folder, tab or row is opened;
  more than one page fetched per "More".
- **UI and LayerFS issues**: console and page errors, failed host requests,
  layout overflow, unnamed controls, leaked Sandboxes, Workspaces and mounts,
  new doctor findings, daemon errors.
- **Fault handling**: a slow, failing, refusing, truncating or hanging CLI must
  end in a visible error state, never an endless spinner or a blocked host.

Every suite runs on a private home and a side server (`scripts/dev.mjs` with
`DSH_LAYERFS_DEV_DIR`), never on `~/.layerfs` or port 3080 (AGENTS.md).

## 2. Signals and where they come from

| Signal | Source | Deterministic? |
|---|---|---|
| CLI spawns per action | count shim (§3.1) | yes: the primary budget |
| CLI call durations, outcome | call log `{at, ms, argv, outcome, tag}` (`src/host/layerfs/call-log.ts`), read through the `logs.list` op (`since`, `outcome`, `tag` prefix `dsh:-:` for host calls) | durations no; counts and outcomes yes |
| Host requests from the page | wrap `window.__dshLayerfs.call` and `.op` (`src/client/index.tsx`, enabled by the `dsh-layerfs:debug` flag `tools/e2e-lib.mjs` sets); `call` uses `op` internally (`src/client/api.ts`), so wrap both | yes (count, status, transport) |
| Long tasks, TTFC | `PerformanceObserver('longtask')` via `addInitScript`; panel click → content selector | no: trend only |
| LayerFS state | `layerfs sandbox list`, `store list`, `doctor`, `mount`, the native daemon log under the private home | yes |

Note: discovery (`help --json`, `--version --json`) is not written to the call
log; only the count shim sees it.

### Action windows

Measure one action at a time: note the call-log offset and the count-file
size, run the action, wait until no host request is in flight and no new log
line has appeared for 750 ms, then diff. Background polling (machines every
5 s, project lists every 15 s, project storage and terminals every 1.5 s) is
noise: install `page.clock` before `goto` and advance time explicitly, or
force `document.visibilityState = 'hidden'` for pollers that check it.

## 3. Harness pieces

### 3.1 Count shim — `test/fixtures/cli-count.sh`

```sh
#!/bin/sh
printf '%s %s %s\n' "$$" "$(date +%s%N)" "$*" >> "$LFS_COUNT_FILE"
exec "$LFS_REAL_CLI" "$@"
```

Point `DSH_LAYERFS_CLI` at it in a **fresh** dev dir: a pin saved in Settings
(`runtime.json`) or the config wins over the environment
(`src/host/service.ts` pin order).

### 3.2 Fault shim — `test/fixtures/cli-fault.mjs`

A node script with an absolute `#!` (as `test/machine-image-cache.test.mjs`
does). `--version --json` and `help --json` always pass through (discovery
needs them). Every other call reads `$LFS_FAULT/mode.json`
`{ match: "store.status", mode, ms }` so a test switches modes without a
restart. Modes:

| mode | behaviour | expected host classification |
|---|---|---|
| `delay` | sleep `ms`, then pass through | ok, slow |
| `fail` | exit 1 | transport-unknown |
| `refuse` | stderr `{"code":"Busy",…}`, exit 125 | refusal → 409 |
| `truncate` | half of stdout | malformed → transport-unknown |
| `garbage` | non-JSON stdout | malformed |
| `hang` | never exits | must time out (see finding T1) |

### 3.3 Data tiers — `tools/perf-fixture.mjs`

Built with plain CLI calls on a native SQLite Store (no Docker or Lima), cached
under `.dev-perf-<tier>/` with a manifest of the CLI commit and fixture
version. History comes from the preset recipe's plain argv steps
(`projectHistorySteps` in `src/host/presets/recipe/recipe.js`: branch fork,
file write, merge, publish) and initial trees from `sourceFiles`.

| tier | Stores | projects | history | tree |
|---|---|---|---|---|
| S | 1 | 2 | ~30 commits | tens of files |
| M | 3 | 12 | ~1.7k commits | 2k files |
| L | 6 | 40 | ~8k commits, ~190 branches, +500 forks | 20k files, 1k folders |

L takes 5–10 minutes once and is reused.

### 3.4 Libraries

- `tools/perf-lib.mjs`: `instrument(page)`, `actionWindow(page, fn)`,
  `quiesce`, `spawns()`, `callLines(since)`, percentiles.
- `tools/lfs-check.mjs`: before/after snapshot of doctor findings, Sandboxes,
  Workspaces, Stores, mounts under the private home, daemon log errors,
  non-`ok` call-log outcomes.
- `tools/perf-report.mjs`: diff a result against `test/perf/baseline.json`;
  `--update-baseline` rewrites it.

## 4. Suites

### 4.1 `test/cache.test.mjs` (in process, fake clock, ~10 s; runs with `node --test`)

Builds route groups with `test/routes-helper.mjs` (`loadRoutes`, `testHost`)
over an `lfs` wrapped in a counting Proxy and a fake LayerFS of N projects and
M Stores. Uses `t.mock.timers` (pattern: `test/project-reads.test.mjs`) or the
injected `now` of `project-storage.ts` / `storage-observations.ts`.

- **Hits**: two `GET /api/projects` within 15 s → one `store.list` (storeJoin);
  two `GET /api/platforms` within 30 s → one `machine.platforms`; two parallel
  `GET /api/sandboxes/x` → one `sandbox.get`; discovery once per CLI path;
  repeated `branch-commits` → no extra `commit.diff`.
- **Invalidation**: a write route (`POST /api/stores`, mount, unmount, commit,
  close) followed by the read that should show it. Sandbox observations must
  be invalidated by Sandbox writes (finding H6).
- **TTL bounds**: at TTL − 1 ms the read is cached; at TTL it spawns. A cached
  `Busy` re-asks after 30 s.
- **No writes on reads**: every `GET` route and every listing op runs against
  a Proxy that fails on any mutating family/call (`branch.fork`, `file.apply`,
  …). This would have caught finding C1.

### 4.2 `test/perf/host.perf.mjs` (in process, real CLI, tiers S and M, ~1 min)

`handle()` against the real pinned CLI on a fixture home (the live pattern in
`test/routes.test.mjs`). Per route: spawn count and p50/p95 duration. Scaling
rule: `spawns(M) − spawns(S)` must be within a declared allowance per route
(`GET /api/storage`: one `store.status` per Store; `GET /api/machines`: one
`machine.status` per non-native machine); anything else that grows fails as
N+1.

### 4.3 `test/perf/ui.perf.mjs` (side server with the count shim, tier M/L)

For each page (Resources overview and its tabs, a Store, a machine, a Sandbox,
a project's Files/History/Sandboxes/Sessions/Stats, Health, Logs, Settings,
and a project session's Files/History/Sandbox/Trajectory tabs): spawns,
host requests by route, TTFC, long tasks. Results go to
`.dev-perf/results/<sha>-<tier>.json`.

**Budgets**: spawn counts are hard limits. Latency ceilings are 3× the
baseline p95 + 200 ms and fail only after three consecutive breaches.

### 4.4 `test/e2e-lazy.mjs` (tier L)

- Project page shell: no `branch.commits`, `file.*` or `sandbox.get` until a
  tab needs them.
- Files: one `fs` read for the root, then one per expanded folder; opening a
  1,000-entry folder does not stat its children.
- History: one branches page plus a bounded number of `commits` reads, even
  with 500 forks; "More" fetches exactly one page.
- Sandboxes: `sandbox.get` only when a row is expanded.
- Logs: first page only; the next only on scroll, with a cursor.

### 4.5 `test/e2e-crawl.mjs` (tier S, ~3 min)

Visits every LayerFS panel, page, tab and dialog (opened and dismissed; never
submitted) at 1280 and 900 px, light and dark, plus one fake-llm project
session's views. Fails on:

- console errors and page errors (`openDev` already collects them);
- a host request with status ≥ 500, a 4xx not on the page's allow-list, or
  `transport: 'transport-unknown'`;
- any visible element whose right edge passes the viewport outside a scroll
  container;
- from the CDP accessibility tree: buttons, links and text boxes without a
  name, dialogs without a name, duplicate ids;
- a `tools/lfs-check.mjs` delta: new doctor errors, leaked Sandboxes,
  Workspaces or `e2e*` Stores, mounts left under the private home, `ERROR` or
  `panic` in the daemon log.

Screenshots are saved for review, not compared.

### 4.6 `test/e2e-fault.mjs` (side server with the fault shim)

Each fault mode against each panel: the page ends in a visible error or empty
state within a deadline; a refusal keeps its code and maps to the documented
status; a hung read does not block unrelated reads (finding T1 fails this
today).

## 5. Regression tests for the review findings

Each confirmed finding gets a test in the suite that would have caught it:

| Finding | Test |
|---|---|
| T1: no CLI timeouts; 4 long calls (terminal `exec`, jobs) block every read | e2e-fault: 4 hung `workspace.exec` + one `GET /api/storage` must answer within its deadline |
| T2: a timeout only signals the direct child; it never escalates to SIGKILL | unit: fake CLI with a grandchild / `trap '' TERM` settles within timeout + grace |
| C1: GETs with an `unclaimed:` projectId fork `dsh.project.<uuid>` | cache.test "no writes on reads"; crawl asserts `branch list` unchanged after visiting |
| K1: turns that only edit existing files are not checkpointed | e2e-sessions: a turn that rewrites an existing file in place makes a checkpoint |
| K2: a failed first archive save makes the mirror permanently stuck | unit: fail `file.apply` once, then the next save succeeds |
| K3: restore re-forks `.rN` after a failed mount and is stuck on `Exists` | unit: fail `workspace.mount` once, restore again succeeds |
| V1: `machine stop --force`, `machine images`, `sandbox create --image_archive` are not in the tracked CLI | unit: every `lfs.*` call site and option exists in the pinned `help --json` (static scan of `src/host`) |
| L1: concurrent CLI processes on one Store fail with `Os NotFound` outside the host's lane | perf-fixture smoke: 3 concurrent `file list` through the agent wrapper |

## 6. Running

In process (every change; part of `node --test test/*.test.mjs`):

| File | What |
|---|---|
| `test/call-table.test.mjs` | every `lfs.*` call site and option against the pinned `help --json` (V1), with a `GATED` list for calls the host checks before making |
| `test/cache.test.mjs` | hits, shared in-flight reads, invalidation, TTL bounds, no writes on any GET (C1) |
| `test/cli-lanes.test.mjs` | lanes, read timeouts, process-group kill (T1, T2) |
| `test/logs-classify.test.mjs` | the Logs read/write split against every pinned CLI call |

Host scaling, in process with no browser, server or `lib/` (~45 s; exits 1 on an N+1,
a count that varies between repetitions, or a failed route):

```
node test/perf/host.perf.mjs [--tier S|M] [--reps 5] [--only <ids>] [--rebuild]
```

It bundles the routes from src (`test/routes-helper.mjs`), puts the pinned CLI
behind the count shim, and builds private homes `.dev-perf-S/home` and
`.dev-perf-M/home` with `tools/perf-fixture.mjs` (S: 2 s; M: ~20 s, 3 Stores,
12 projects, ~1.7k Commits, ~2k files, 40 branches in the measured project).
Each repetition uses new route groups, so caches start cold. Results:
`.dev-perf-host/<sha>.json`.

Side server (private home; never `~/.layerfs` or 3080). In a worktree the fake-llm
overlay must name *this* checkout's `dev/fake-llm/index.js`: naming another
checkout's makes DSH resolve `dsh-layerfs` there and serve that checkout's client.

```
# crawl: seed once, then crawl (~9 min for 2 sizes × 2 schemes; --sizes/--schemes/--only narrow it)
DSH_LAYERFS_DEV_DIR=$PWD/.dev-crawl DSH_LAYERFS_DEV_OVERLAY=<overlay> node scripts/dev.mjs --port 3117
DSH_LAYERFS_DEV_DIR=$PWD/.dev-crawl node test/e2e-sessions.mjs --keep
DSH_LAYERFS_DEV_DIR=$PWD/.dev-crawl node test/e2e-crawl.mjs --keep-going

# LayerFS state around any test
node tools/lfs-check.mjs <dev dir> --save before.json
node tools/lfs-check.mjs <dev dir> --diff before.json

# per-page spawn budgets: the server command is in test/perf/ui.perf.mjs's header (count shim, fresh dev dir)
DSH_LAYERFS_DEV_DIR=$PWD/.dev-perf node tools/perf-fixture.mjs --tier S --server
DSH_LAYERFS_DEV_DIR=$PWD/.dev-perf node test/perf/ui.perf.mjs [--update-baseline]
```

`ui.perf` measures each page cold (31 s cooldown, a fresh context, a paused page
clock) and takes ~14 min. Spawn counts repeat exactly on a fixed build, but a run
is only valid against a frozen `lib/`: a rebuild mid-run (other agents share the
checkout) changes them, and the harness fails such a run as not comparable.
Baseline: `test/perf/baseline.json` (tier S, 21 pages).

## 7. Build order

1. Done: `test/cache.test.mjs` with the "no writes on reads" Proxy, and the
   static call-table check (`test/call-table.test.mjs`).
2. Done: the count shim, `tools/perf-lib.mjs`, `tools/perf-fixture.mjs` (tier S)
   and `test/perf/ui.perf.mjs`.
3. Done: `test/e2e-crawl.mjs` with `tools/lfs-check.mjs`.
4. Done: `test/perf/host.perf.mjs` at tiers S and M.
5. Not built: the fault shim and `test/e2e-fault.mjs`; tier L fixture, lazy suite.

## 8. What the first suites found

| Found by | Issue | State |
|---|---|---|
| crawl | the project page's tab ids had no project in them: two open projects duplicated six ids | fixed (`useId`) |
| crawl | Logs "Writes only" showed `file revision` and `doctor` as writes | fixed; `logs-classify.test` checks every pinned call, and `lfs-check` uses the same rule |
| crawl | a project's Sandboxes tab said "No workspaces" (the list carries none, `unread`) | fixed: the tab reads each open Sandbox's Workspaces |
| crawl | LayerFS: the native daemon logs `ConnectionFailure … CloseFailed/UnexpectedEof` for every normal disconnect, and `doctor` then warns about every Sandbox | upstream; recorded as a crawl note |
| ui.perf | concurrent project-list and Storage reads each ran `store list` | fixed: one Storage view in flight, reread after a write |
| ui.perf | `GET /api/machines` twice per page (sidebar and machines store) | fixed: one machines view in flight; any write makes the next GET read anew |
| ui.perf, host.perf | History read each Branch twice (`branch get` + `branch commits`): `history.page` 21 → 65 spawns from S to M | fixed: the client passes each Branch's head and fork point from the Branch list (no `branch get`), skips side Branches with nothing saved since their fork, and the host keeps pages read at a head; `history.page` 12 → 34 (one `branch commits` per Branch read up front, capped by `INITIAL_BRANCHES`, is the 2.0 floor) and `history.reopen` 2 → 2 |
| ui.perf, host.perf | the first Stats visit runs one `branch commits --include-storage` per branch: `storage.first` 15 → 45 | by design, now declared: the one-time background ledger build reads ceil(saves / 25) pages per side Branch (2.0 has no call that sums the counters), is kept on disk, and `storage.steady` stays 5 → 5; reducing it further needs a LayerFS aggregate |
| ui.perf | `sandbox get` is asked with `--page-size 1000` | open (minor) |
| 3080 check | one machine whose worker does not answer (`demo-build`: Lima VM running, worker silent) makes every `machine status` wait 3 s and once 76 s; `GET /api/machines` waits for all statuses, so it took 59 s after a restart | open; a short probe budget is in progress in another session |
| L1 repro | 12 of 45 concurrent `file list` on one Store fail with `Os NotFound` | upstream |
| crawl after e2e | the project catalog listing asked `project get` for every remembered project missing from LayerFS on each listing (the sidebar lists every 15 s): 45 failed calls in one 2-minute crawl | fixed: a project answered as removed is listed as removed for 10 min without asking (`catalog.ts`, `GONE_MS`) |
