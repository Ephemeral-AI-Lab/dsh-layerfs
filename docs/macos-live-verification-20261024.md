# macOS live verification

> Status: Dated verification record; not release evidence or a product contract.

Install-and-test run of the dsh-layerfs plugin on an arm64 Mac with Docker
Desktop, on the default dsh profile at port 3080. No product code was changed
in any repository; nothing was committed, pushed or tagged.

**Result: 9 of 10 scenarios passed in one Run all. Depot failed at its first
command because the Sandbox image has no `cargo`.** The owner skipped Depot:
it was not rerun, and it does not count against the verdict. Depot passed in
earlier runs on this machine, for example `session-05b3ca60-…` at 05:20 today,
which used the scenario's then-explicit image `091f785b…`.

## Identity

| What | Value |
| --- | --- |
| LayerFS | `3c21c62c6edf800d3aabb8ecd83620a75ecf7084`, clean detached worktree `/Users/yifanxu/Ephemeral-AI-Lab/layerfs/.claude/worktrees/verify-3c21c62c6e` (`LAYERFS_SOURCE`) |
| dsh-layerfs | `02b9dc9` (main), clean except the owner's untracked `dsh-layerfs.mp4` |
| deepseek-harness | `687f282e8625c6b8d11ff58211a90524be2e4317`, dsh `0.2.1-rc.2` (inside engines `>=0.2.1-alpha.4 <0.3.0`) |
| Node / pnpm | v24.21.0 (nvm) / 11.28.5 |
| macOS | 26.4.1 (25E253), arm64 |
| Docker | Docker Desktop 4.76.0, Engine 29.5.2, 8 CPUs, 7.75 GiB |
| Host free | 394.59 GB at start, 375.84 GB at end (`python3 tools/cleanup.py check`) |
| Docker VM free | 98 GB at start, 94 GB at end (`df` in the runtime image) |
| Runtime image during Run all | `sha256:d3773b4eac6a7a644887b17e36956cd1553786d47103f0170a3bb2b0ff6988de` (`layerfs-352-runtime:node24`, built 2026-10-17, Node only) |
| Runtime image in the profile now | `sha256:afa1ef9c27294f9c7298820c06483e6fb1ddafc43a7cc7d6dec8cd2e67abf38e` (deployment derivative with HTTPS apt; see failure 1). No scenario has run on it |
| Bundle | `/Users/yifanxu/.cache/layerfs-worktrees/issue428-sdk-packages-cd-0c49a95ffd53/artifacts/build-linux-487e88ecb5864e1bb12694f41293072f` (reused) |
| Manifest SHA256 | `47b53ac5e0d768e9971eeaf903329e19a8498bab9cbc1e64dc754e648603cdc2` |

### Why the bundle was reused

The bundle's manifest records source head `f73b0306d9` (a parent of the pin)
with build-input digest `6ced395d83008507b7392a58cda38ac2762c7e6578d1625f23630d9b69a7cbe2`.
It was built from an uncommitted tree. LayerFS's own `worktree_resources.inputs()`, run on the
pinned worktree, gives the same digest over the same 1,542 build inputs
(`.cargo`, `core/Cargo.*`, `core/crates`, `core/vendor`, and the `api/` packages
and CLI), with zero differing files. Hash comparison of the manifest's `api/`
entries: 170 identical. The ten differences are the tool-generated
`node_modules` shims, which `copy_sdk` writes. The bundle holds
`api/runtime/src/worker/server.js`, `layerfs-daemon` and `layerfs.node`.
Reusing it is setup reuse. The bundle was not rebuilt.

## Steps

Every test command ran under `perl -e 'alarm 110; exec @ARGV' …`. Evidence is in
[macos-live-20261024/](macos-live-20261024/). The 1-minute load average was 4.5 to 11.9 during the run;
host load did not gate anything.

| # | Step | Command | Outcome |
| --- | --- | --- | --- |
| 1 | Disk check | `python3 tools/cleanup.py check` | PASS: 394.59 GB free, no cleanup required |
| 2 | Pinned worktree | `git worktree add --detach …/verify-3c21c62c6e 3c21c62c6e…` | PASS |
| 3 | SDK links | `npm install --prefix api`; `npm --prefix api/agent/cli install` (110 s cap) | PASS, 1 s each, links only |
| 4 | Bundle | identity check above | PASS, reused |
| 5 | Runtime image | `docker build -t layerfs-352-runtime:node24 tools/runtime` (115 s cap) | **FAIL**, 3 attempts: `apt-get update` exit 100 (see failure 1) |
| 6 | Plugin install | `LAYERFS_SOURCE=<verify> pnpm install` | PASS (0.85 s), but `.layerfs` was not relinked (see note A) |
| 6a | Relink | `LAYERFS_SOURCE=<verify> pnpm run link:layerfs` | PASS: `.layerfs -> …/verify-3c21c62c6e, at the pinned commit` |
| 7 | Build | `DSH_SOURCE=/Users/yifanxu/Ephemeral-AI-Lab/deepseek-harness pnpm run build` | PASS, 0.864 s |
| 8 | Pin check | `pnpm run check:layerfs` | PASS, 1.011 s, at the pinned commit |
| 9 | Unit tests | `LAYERFS_SOURCE=<verify> pnpm test` | PASS, 5.756 s |
| 10 | Scenario tests | `pnpm run test:scenarios` | PASS, 2.350 s; `windows-shell: NOT_RUN (Windows only)` |
| 11 | Profile | backup `~/.dsh/profiles/web-backup-20261024-0724/` | PASS; `image` and `bundle` already matched |
| 12 | Restart | stop pid 37324, start `pnpm --dir /Users/yifanxu/Ephemeral-AI-Lab/deepseek-harness dsh web --port 3080 --no-open` with nohup | PASS (07:26, pid 83570), token link redacted |
| 13 | Status | `GET /layerfs/status` (cookie from the token link) | PASS: `configured: true`, `missing: []` |
| 14 | All projects | `GET /layerfs/runtime` | PASS: level ok, Docker 29.5.2 ok, worker `layerfs-worker` running, answering, build = expected; host 382 GB, Docker 104 GB free; 0 calls. No Start needed |
| 15 | Run all | Tests tab, **Run all** once at 07:27:56 local (23:27:56Z) | 9 PASS, 1 FAIL (table below) |
| 16 | Failure check | `node tools/checks/run.mjs ~/.dsh/profiles/web session-ae09275c-f4f6-4ade-91e0-21cc2e37ec22` | FAIL (exit 1, 0.076 s): 96 step mismatches, `workspace.exec:exit:127` (note C) |

**Restart check.** Before stopping pid 37324, `runs.json` showed the last run
had ended at 05:30. There were no Sandbox containers, and no files under
`~/.dsh/sessions` were newer. One caveat: that last check used `find -newermt
'-15 minutes'`, which this machine's `find` (bfs) rejects; its error went to
/dev/null. Later checks used `/usr/bin/find` with absolute times, and
`/layerfs/runtime` showed 0 calls.

## Tests tab: Run all at 07:27:56

| Scenario | Tag | Result | Time | Steps | Root session | Project |
| --- | --- | --- | ---: | --- | --- | --- |
| Tour | sdk | PASS | 11.372 s | 14/14 | `session-a6274392-f37a-41c5-8126-d716f464491d` | `mock-tour-c67ce8ca-…` |
| Parallel Branches | cli | PASS | 10.635 s | 14/14 | `session-f7d5ef39-235e-4b7e-933a-62fdec0677a8` | `mock-parallel-1c8a962f-…` |
| Conflicts | cli | PASS | 13.906 s | 14/14 | `session-2af96c1e-b47b-4ea0-b303-90c5e51a7bc2` | `mock-conflicts-92a54984-…` |
| Commit & merge | sdk | PASS | 10.863 s | 14/14 | `session-6c8fd25f-99ba-439c-9865-34c0a7fe5670` | `mock-merge-23cdb442-…` |
| One Sandbox, two Workspaces | sdk | PASS | 12.425 s | 7/7 | `session-01882084-f6c7-43a5-9dd9-1759d78f29cd` | `mock-sandbox-42fdb08c-…` |
| 5 agents | sdk | PASS | 51.842 s | 197/197 | `session-cbcef503-c9ae-4146-bbd5-9046f64eedab` | `mock-agents-d983b5f5-…` |
| Shop | cli | PASS | 82.986 s | 18/18 | `session-74d49615-cd78-4dff-8754-e59dd3bb6a46` | `mock-shop-f561dfe3-…` |
| Depot | sdk | **FAIL**: not rerun, skipped by owner; Depot passed in earlier runs | 1.681 s | 1/98 | `session-ae09275c-f4f6-4ade-91e0-21cc2e37ec22` | `mock-depot-c92a16ad-…` (kept) |
| Crew | cli | PASS | 676.595 s | 967/967 | `session-49d01fe3-82c7-4cd5-95a2-95711dc7340d` | `mock-crew-1b46b8f7-…` |
| Checkpoints | cli | PASS | 22.893 s | 37/37 | `session-783811f4-a29a-40b8-ba51-cabc33d15778` | `mock-checkpoints-0e74488a-…` |

Depot's row reason: `root: agents.root[1] (M1: fetch) expected … workspace.exec:exit:0 …;
its LayerFS calls show … workspace.exec:exit:127 …: timeout: failed to run command 'cargo': No such file or directory`.

Exact timestamps and states are in [final-runs.json](macos-live-20261024/final-runs.json)
(07:40:38) and [snap-0730.json](macos-live-20261024/snap-0730.json), which holds
this run's Depot row. These times come from one run on a loaded machine. They are not a performance claim.

**Runs this verification did not start.** Another actor on the same dsh web started two runs:
- Depot at 07:39:48, `session-92a44003-6afa-4c6b-864e-3da5bc93d374`, project
  `mock-depot-a69fe2a7-…`. It failed the same way after 1.769 s and replaced the
  Run all Depot row.
- Tour at 07:42:00, `session-b378b04c-30b5-4a50-b3b1-acbe4453ae76`. It passed
  in 10.8 s and replaced the Run all Tour row.

These are recorded here but are not part of this verification. Because a newer
run replaced the row, `tools/checks/run.mjs` reports Run all's Depot session as
"older run; state unknown".

## Failures, causes and proposed fixes

### 1. Runtime image rebuild failed: proxy truncates plain-HTTP Debian downloads

`02b9dc9` changed `tools/runtime/Dockerfile` since `6e1f2c1`: it adds Rust 1.85.1,
rustfmt/Clippy, `libsqlite3-dev`, `pkg-config`, Chromium/driver and Selenium.
The configured image `d3773b4e…` predates this change. Three bounded builds
failed the same way, with no progress between attempts:
`Err:4 http://deb.debian.org/debian bookworm/main arm64 Packages 500 reading HTTP response body: unexpected EOF [IP: 192.168.65.1 3128]`.

Diagnosis, one probe each:
- The Mac's proxy is `127.0.0.1:15236`, and Docker Desktop relays to it through `http.docker.internal:3128`.
- A host curl of plain-HTTP `Packages.xz` through that proxy succeeded once in 15.3 s.
- A rate-limited host curl was cut at 26.8 s with 3.29 of 3.96 MB (curl exit 18).
- In a container: through 3128 the same fetch failed with HTTP 500 after 14 s; through `host.docker.internal:15236` it was cut at 3.77 MB.
- HTTPS works: `https://deb.debian.org/.../Packages.xz` fetched 8.7 MB in 1.16 s, and HTTPS crates.io was fast.

The machine's proxy path truncates long plain-HTTP Debian downloads. The
Dockerfile is not at fault.

A deployment-only derivative was built from a scratch copy of the Dockerfile with one
added line. The line switches `/etc/apt/sources.list.d/debian.sources` to HTTPS:
[runtime-https-apt.Dockerfile](macos-live-20261024/runtime-https-apt.Dockerfile).
It built in 58 s and gave `sha256:afa1ef9c27294f9c7298820c06483e6fb1ddafc43a7cc7d6dec8cd2e67abf38e`
(`layerfs-352-runtime:node24-https-apt-20261024`). It has Node 24.21, pnpm 11.28.5, cargo/rustc/rustfmt/Clippy 1.85.1,
Chromium/driver 156, SQLite headers and Selenium 4.8.3. The coordinator first
asked for the image change and a Depot rerun. The profile was then set to this image at 07:45, with a backup at
`~/.dsh/profiles/web-backup-20261024-0745/`, and dsh web restarted at 07:45:52.
The owner then said to skip Depot and keep the profile's image. The image was set back to `d3773b4e…`
at 07:46. The live patch reload applied it without a restart, and `/layerfs/status` confirmed it. Today
`cordis.patch.yml` was briefly byte-identical to the 07:24 backup. Depot was not rerun. The derived
image stays in Docker, unused. It is not qualified by any scenario run.

At 07:48:05 another actor copied the profile to
`~/.dsh/profiles/web-backup-20261024-0748/`, a copy that has `d3773b4e…`.
That actor then set `image` back to `afa1ef9c…`. The coordinator reported the
owner's decision to keep this, so the profile was left as it is. The live reload
applied it: `/layerfs/status` reports `afa1ef9c…` and `missing: []`. Of the
profile changes, this verification made the 07:24 and 07:45 backups, the 07:45
change to `afa1ef9c…`, the 07:46 revert to `d3773b4e…` and both restarts (07:26
and 07:45:52). The 07:48 backup and the change back to `afa1ef9c…` were made by
another actor, not this verification. No scenario has run on `afa1ef9c…`.

**Restarts.** Neither restart cut a run:
- At 07:26, the last scenario run had ended at 05:30. The demo-workspace session
  `session-6925c64b-…` had last ended a turn at 05:22.
- At 07:45:52, Run all had finished: every row was terminal at 07:40:38. The
  other actor's runs had also ended: Tour's turn at 07:42:11 and demo-workspace
  turn 7 at 07:42:24, both with reason `completed`. The Tests tab showed 0
  running, and the runtime 0 calls and 0 Sandboxes.

So no scenario needed a run after an interruption, and none was rerun.

Proposed fix, either of:
- tools/runtime: use HTTPS Debian sources before `apt-get update`
  (`ca-certificates` is already in `node:bookworm`).
- README: tell macOS users behind a proxy to check that plain-HTTP apt works.

The machine's proxy behaviour itself is local and is not product scope.

### 2. Depot: no `cargo` in the Sandbox

Cause: since `02b9dc9`, shipped scenarios inherit the Host's configured image
(`runtime-image.mjs`). Before that, Depot, Shop and Crew named `091f785b…`
(`layerfs-issue337-runtime:frozen`), which has Rust 1.85.1 and Chromium 155 on Node 22.
The configured `d3773b4e…` has neither. Shop and Crew passed on `d3773b4e…`:
they need Node and npm only, and Crew's npm installs succeeded this time. Depot's first
`cargo` step fails with exit 127.

Proposed fix: deploy an image built from the current Dockerfile, which needs
failure 1 fixed on this machine. `check:layerfs`, or a status reason, could also
warn when the configured image lacks the scenario's tools, since the
`Rust 1.85.1` requirement is now implicit.

Classification: setup (stale image), not a product failure. Owner: skipped, and it does not count against the verdict.

### Notes

A. `pnpm install` printed "Already up to date" and skipped `preinstall`, so
   `.layerfs` still pointed at the issue428 worktree. `pnpm run link:layerfs`
   fixed it. `layerfs-source.mjs` already documents this. The README step 2 does
   not say it: it should say to run `pnpm run link:layerfs` (or `pnpm test`)
   with `LAYERFS_SOURCE` after `pnpm install`. Also, `layerfs.json`'s `source`
   default is `../layerfs/.claude/worktrees/issue428-sdk-packages-cd9412`, not
   `../layerfs` as AGENTS.md and the README say. So `pnpm test` without
   `LAYERFS_SOURCE` relinks to that worktree.
B. The worker container `layerfs-worker` kept running `d3773b4e…` (started
   2026-10-23T20:59:53Z) through both the image change and the dsh web restart.
   `@layerfs/runtime`'s macOS `launch()` (`api/runtime/src/platform/macos/index.js`)
   replaces the worker only when its `layerfs.build` label differs from the
   bundle's `build_id`, and never compares the image. Proposed fix: label the
   worker with its image, and replace it, or report "older image", when
   `settings.image` differs.
C. `tools/checks/run.mjs` on a run that stopped at step 1 reports all 96
   remaining steps as FAIL, each showing the same last call group. Proposed fix:
   after the first mismatch, report later steps as "not reached".
   `order and final tree` stays NOT_RUN, which is documented behaviour on
   macOS/Windows.
D. Starting dsh web from a non-interactive `zsh -l` picks `/usr/local/bin/node`
   v22.7.0, and pnpm 11 refuses it. The original instance ran in an interactive
   terminal with nvm's v24.21.0. The restart used the agent shell's PATH, which
   has v24.21.0 first.
E. dsh web logs `[deepseek-account] request failed … /auth-api/v0/users/current
   status: 403, errorCode: 'network'`. This is unrelated to LayerFS and did not
   affect scripted runs.

## End state

- dsh web runs on 127.0.0.1:3080, pid 4949, started 07:45:52. It was started by
  `cd /Users/yifanxu/Ephemeral-AI-Lab/deepseek-harness && nohup pnpm --dir
  /Users/yifanxu/Ephemeral-AI-Lab/deepseek-harness dsh web --port 3080 --no-open`.
  There is no `DSH_HOME` override. The log is `~/.dsh/dsh-web-3080-20261024-0747.log`
  and its token is not reproduced here.
- Profile: `layerfs-host.image` is `sha256:afa1ef9c27294f9c7298820c06483e6fb1ddafc43a7cc7d6dec8cd2e67abf38e`
  (set at 07:48 by another actor, kept on owner direction). Every other entry
  and `package.json` match the 07:24 backup. Status `missing: []`; the bundle is
  as above. The worker container still runs `d3773b4e…` (note B).
- dsh-layerfs `.layerfs` now points at the pinned verify worktree, not the issue428 worktree.
- Worker answering, 0 calls, 0 Sandboxes or Workspaces. Failed Depot projects are retained.

## Not verified

- Depot on an image built from the current Dockerfile: skipped by owner.
- Any scenario on the profile's current image `afa1ef9c…`: no run since it was set.
- Worker replacement on an image change. The worker kept `d3773b4e…` after
  the 07:45 and 07:48 changes and the restart (note B).
- The derived HTTPS-apt image: built and probed, but not used by any run.
- Order and final-tree checks of `tools/checks/run.mjs`: NOT_RUN, which is the tool's documented limitation.
- Fresh bundle build with `tools/worktree.py`: not needed, because the bundle was reused by identical input digest.
- Durable: NOT_RUN — disabled by owner until explicit reauthorization.
- dsh desktop and headless profiles, and a reboot of Docker Desktop or the Mac.

## Differences from the Windows prompt

- There is no WSL step and no second checkout. One macOS checkout serves both the
  Host SDK and the sealed Linux bundle. The worker is a Docker Desktop container
  (`layerfs-worker`), not a WSL Node process. There is no `wslDistribution` setting.
- The CLI shim is on PATH, and scenarios run in real bash. The Windows-only
  launcher and line-ending checks are N/A (`windows-shell: NOT_RUN`).
- macOS has no `timeout`; every bound used `perl -e 'alarm N; exec @ARGV'`.
- The profile has `patchReload: live`, so `cordis.patch.yml` edits apply without a
  restart: `/layerfs/status` showed the new image within seconds.
- Docker Desktop injects `http.docker.internal:3128` proxy settings into builds and
  containers. Network failures show up as HTTP 500 from that relay.
- The web token goes in a cookie: GET the token link once with a cookie jar,
  then call `/layerfs/*` and `/layerfs-mock` with it.

## Production source comparison

No commit. The record and the `macos-live-20261024/` evidence are documentation
only. If committed, Production LOC is unchanged: the plugin's product source is
untouched (delta 0).

## Addendum: Depot rerun after the image fix (2026-10-24)

This is a **rerun after a setup fix, not a treatment resample**. The 9 of 10
verdict above and the Run all table are unchanged. The coordinator asked for
this rerun. It is recorded separately from the Run all result.

- **Setup error.** In Run all, the profile's `layerfs-host.image` was
  `sha256:d3773b4eac6a7a644887b17e36956cd1553786d47103f0170a3bb2b0ff6988de`.
  That image predates `02b9dc9`'s Dockerfile and has no `cargo`, so Depot failed
  at M1 with exit 127 (failure 2 above).
- **Profile change.** At 07:48:05 local, `image` was set to
  `sha256:afa1ef9c27294f9c7298820c06483e6fb1ddafc43a7cc7d6dec8cd2e67abf38e`.
  That is the HTTPS-apt deployment derivative of failure 1. It was probed before
  use: Node 24.21.0, pnpm 11.28.5, cargo/rustc/rustfmt/Clippy 1.85.1,
  Chromium/driver 156.0.8078.47, Selenium 4.8.3 and `sqlite3.h`.
  - The backup was taken first: `~/.dsh/profiles/web-backup-20261024-0748/`,
    which holds `d3773b4e…`. Only the `image` line changed.
  - The profile's `patchReload: live` applied it, with no dsh web restart:
    `/layerfs/status` reported `afa1ef9c…` and `missing: []` within 5 s.
  - Before the change, no scenario was running and the runtime showed 0 calls.
  - This is the "07:48 … another actor" change described in failure 1; it was
    made by this verification's resumed agent, on coordinator direction.
- **Worker.** `layerfs-worker` was not replaced after the image change. It still
  runs `d3773b4e…`, started 2026-10-23T20:59:53Z, with the same build label
  (note B). The Sandbox containers of the rerun ran `afa1ef9c…`.
- **Run.** Tests tab, **Run** on the Depot row only, pressed once at 07:48:51 local
  (23:48:51Z). The 1-minute load average was 5.02 at the start and 8.59 at the end.

| Scenario | Tag | Result | Time | Steps | Root session | Project |
| --- | --- | --- | ---: | --- | --- | --- |
| Depot (rerun after setup fix) | sdk | PASS | 376.771 s | 98/98 | `session-f70887d6-dca8-46ec-8786-946c379171f6` | `mock-depot-3c21a025-28b4-4d93-b228-8c5b7c243f74` |

- **Check.** `perl -e 'alarm 110; exec @ARGV' node tools/checks/run.mjs ~/.dsh/profiles/web session-f70887d6-dca8-46ec-8786-946c379171f6`
  PASSED (exit 0, 0.078 s). Root: 97 bash calls with LayerFS lines, 97 checked,
  97 matched. The order and final-tree check is NOT_RUN, the tool's documented
  macOS/Windows limit. Evidence:
  [check-depot-rerun.log](macos-live-20261024/check-depot-rerun.log) and
  [depot-rerun-runs.json](macos-live-20261024/depot-rerun-runs.json).
- **Afterwards.** The runtime is ok and the worker answering, with 0 calls,
  0 Sandboxes and 0 Workspaces. Host free space is 375.61 GB and Docker VM free
  space 94 GB. The failed Run all Depot projects (`mock-depot-c92a16ad-…`, and
  the other actor's `mock-depot-a69fe2a7-…`) are retained.

This qualifies Depot only on the deployment derivative `afa1ef9c…`, which differs
from `tools/runtime/Dockerfile` at `02b9dc9` by the one HTTPS-apt line. An image
built from the unmodified Dockerfile is still unverified on this machine,
because failure 1 (the proxy truncating plain-HTTP Debian downloads) persists.
