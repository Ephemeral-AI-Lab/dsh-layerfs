# Quarry v2 monitor log

- Run start: 2026-11-13 07:35:47Z (handoff sent)
- Root session (SID): `session-939f81ff-c316-46d8-914d-f60a5d3c2c79`; session Sandbox `dsh-939f81ffc31646d8914d`; dsh's Workspace `dsh-939f81ffc31646d8914d:main`; Branch `dsh.939f81ffc31646d8914df60a5d3c2c79`
- Project `qv2-store/qv2-strata` (sqlite, docker); scratch `/Users/yifanxu/Ephemeral-AI-Lab/qv2-scratch` (ledger `quarry-v2/PROGRESS.md`)
- Model: deepseek-account / deepseek-flash (DeepSeek-V4.1-Flash), effort max; preset `layerfs`; access Workspace Write
- Worker container `lfs-0c9dc9c9-docker` (data volume `lfs-0c9dc9c9-docker-data`, 116 GB free); Sandbox root `sha256:1d91885de27a…` (bundle image)
- 3080 pid 9491 (restarted 15:18:23 local by "Layerfs sidebar navigation"); pinned runtime `2.0.0-814768197b73`
- DSH `maxActiveSubagents` 8 → 8 workers
- Script: `node demo/quarry-v2/monitor/check.mjs --sid <SID> --state <scratchpad>/qv2-monitor-state.json`

## Watch list

| id | Bug | Probe | State | Streak |
| --- | --- | --- | --- | --- |
| W1 | Store write contention (issue 01): docker residual `Failed Os NotFound` | script: W1 count vs writes | open (baseline 1.4 %) | 0 |
| W2 | Checkpoints counted 0 files when only `file` writes moved the Branch | `session.state` checkpoints | watch | 0 |
| W3 | `/api/machines` stalls behind an unresponsive Lima worker | `GET /api/machines` time | watch | 0 |
| W4 | Slow host `store.status` / `project.get` | script: slow non-exec | watch | 0 |
| W5 | Docker Sandbox env missing Rust PATH (F01) | agents' exec outputs: `command not found` for cargo/rustc | fixed (skill) | 0 |
| W6 | `/tmp` tmpfs fills (F02) | `df /tmp` in agents' outputs / ledger | watch | 0 |
| V1 | polling storms | script: storms | watch | 0 |
| V2 | agent closed a Sandbox | `sandbox close` in call log | watch | 0 |
| V3 | dsh restarts end live turns | 3080 pid; aborted turns | hit 08:03 (operator restart for F08, approved; root turn 3 + helper cut, continue sent) → pid 34450; 08:16 → 37000 and 08:27 → 39536 in idle windows (F10) | 0 |
| V4 | `invalid record` on merge/commit | `Failed` on merge/commit | watch | 0 |
| V5 | Commit `Failed` "invalid record: captured inode creation binding" after an unresolved Conflict (issue 03) | `Failed` + "invalid record" on workspace commit in outputs | watch (way out: `unmount --discard`) | 0 |
| V6 | merge truncates `Cargo.lock` | agents' `cargo metadata` after merges | watch | 0 |
| V8 | Workspaces left mounted | `sandbox get` vs ledger | watch | 0 |
| W7 | Docker guest data disk fills (committed per-Workspace `target/` trees in the Store) | `docker exec lfs-0c9dc9c9-docker df -BG /layerfs/data`; host `df -g /` | measurement only (user: never remove what is installed in the Store); attribute by source each check: run machine volume (`docker exec lfs-0c9dc9c9-docker du -sx /layerfs/data/store /layerfs/data/machine/native/run`), other sessions' volumes, images: 116 GB free at R0 → 90 GB at 09:29 with 8 Workspaces mounted → 115 GB at 09:42 after most workers unmounted, so the space is transient (mounted Workspaces' trees, freed on unmount), not the Store (1.0 GB) and not a leak. Per-mount footprint: int 1.3 GB with the F17 rebuild, w-t1 0.1 GB after the fix. Floor: report to the starting session with a breakdown before 20 GiB; delete nothing | 0 |
| U4 | Root's Sandbox tab empty during the run (F14) | open root → Sandbox: within 10 s the toolbar shows "N agents · M branches" with M > 1, the timeline is not 0:00, and over 20 s the gap from playhead to end stays ≤ 5 s | fixed 09:1x (client, starting session); probe each check | 0 |

## Check #0 · 07:38Z · preflight · verdict: CLEAN

Host 262 GB free; docker data 116 GB free; Docker 8 CPU / 8 GiB. Probe: Rust OK with env, sqlite3 builds, crates.io/sqlite.org reachable, `/tmp` shared tmpfs 3.9 GB. Issue 01 rerun on docker: 2/140 refused (`Failed NotFound`, before effect). Run started; main agent in preflight (skill loaded, SPEC read, ledger started, `int` mount/exec/commit/unmount clean). 106 calls, 1 refusal (`sandbox.get NoSuchSandbox` before its Sandbox existed).

## Check #1 · 07:49Z (due 07:48Z, +1 min) · verdict: WARN (F07 fixed by steer; F08 restart pending)

Watch list: 12 rows probed · W1 0 of 94 writes · V1 no storms · V3 pid 9491 unchanged · W5 no `command not found` (agent uses `scripts/env.sh`) · others n/a yet (no merges, one Sandbox).

| Group | Pass | Warn | Fail | Notes |
| --- | --- | --- | --- | --- |
| Harness | H1 H2 H4 H6 H8 | H7 (fixed) | — | preset layerfs; deepseek-flash max; skill loaded; one Workspace per bash call (mount int → exec → commit → unmount ×3); F07 local drafting stopped by steer at 07:41 |
| Backend | B1 B8 B10 | — | — | $SB only `main` between calls; docker data 116 GB free; host 262 GB; 3080 pid 9491 |
| Run | R2 R3 | — | — | R0 skeleton on `skel`: 37 `file write`, 43 `file mkdir`, 8 `file edit`, 2 `file apply`, 3 Workspace Commits (sqlite3 build + cargo fetch + build); no workers yet |
| UI | U1 U11 | — | — | conversation renders; model DeepSeek-V4.1-Flash · Max; queued/steer works (first queued item stayed "next-turn" after a Steer click, resent) |

Calls since last: 291 (agents 107 · host 184) · refused 1 (`file.edit AmbiguousMatch`)

| op | n | p50 | p90 | max |
| --- | ---: | ---: | ---: | ---: |
| file.mkdir | 43 | 49 ms | 58 ms | 63 ms |
| file.write | 37 | 57 ms | 78 ms | 115 ms |
| workspace.exec | 3 | 16.5 s | 29.5 s | 29.5 s |
| workspace.commit | 3 | 1.9 s | 10.4 s | 10.4 s |

Breaches: `workspace.commit` 10.4 s (first commit after `cargo fetch` + sqlite3 build: large new bytes; not a regression) · Storms: none · Stalls: none
New findings: F07 (agent drafting locally, steered), F08 (sandbox policy for agent-created Sandboxes, restart pending). Sandbox correction still queued for the next turn.

## Check #2 · 08:00Z (due 07:58Z, +2 min) · verdict: WARN (F08 confirmed, restart deferred)

Watch list: W1 0 of 62 writes · V1: no agent storm; host session-view polls 85–89 per call per 10 min (F09) · V3 pid 9491 · W5 none · V8 $SB has no Workspaces between calls (main + helper unmount each time; one `unmount Dirty` then commit+unmount by the agent).

| Group | Pass | Warn | Fail | Notes |
| --- | --- | --- | --- | --- |
| Harness | H1 H2 H4 H6 H7 H8 | — | — | helper subagent loaded the skill; mounts by name int ×11, w-t2 ×2; no exec on dsh main; no mount paths in exec |
| Backend | B1 B8 B10 | B5 (F09 volume) | — | docker data 116 GB free; commits 4.4 s p50 / 13.6 s max (target/ + .cargo-home committed) |
| Run | R1 R2 R3 | — | — | R0: gates green (fmt, clippy, 24 tests); sqlite3 3.40.1 in `.tools`; corpus helper (w-t2 on skel) writing ≥ 700 records; `sandbox create` ×3 refused PermissionDenied (F08) → all lanes in $SB |
| UI | U1 | — | — | conversation renders |

Calls since last: 858 (agent ~650 incl. host-session polls ~520 · host '-' 204) · refused 9 (1.0%): sandbox.create Failed×3 (F08), NoSuchPath×4, NoMatch×1, unmount Dirty×1

| op | n | p50 | p90 | max |
| --- | ---: | ---: | ---: | ---: |
| workspace.exec | 16 | 14.1 s | 35.7 s | 38.5 s |
| workspace.commit | 12 | 4.4 s | 12.4 s | 13.6 s |
| file.write | 29 | 84 ms | 94 ms | 98 ms |
| machine.get | 86 | 115 ms | 152 ms | 256 ms |

Breaches: workspace.commit 11.7–13.6 s ×3 (int commits with target/; judged by size, not a regression) · Stalls: none
New findings: F09 (host polling volume)

## Check #3 · 08:30Z (due 08:10Z, +20 min: operator busy with F08/F10 restarts) · verdict: ALARM → recovered

Watch list: V3 three operator restarts (08:03 cut turn 3; 08:16 and 08:27 in idle windows); W1 0 refusals; V8 no leftovers seen by the agent's recovery.

| Group | Pass | Warn | Fail | Notes |
| --- | --- | --- | --- | --- |
| Harness | H2 (new prompt block live) | — | H3/H5 08:16–08:27: every bash refused by DSH (F10, self-inflicted) | fixed 08:27 |
| Backend | B8 B10 | — | — | pid 39536; docker data 116 GB |
| Run | R0 done | — | — | skel published to main (Layer `32580b31…`), verify-r0 green, corpus 1,010 records / 28 files (190 errors), slt 0/1010 (stubs); R1 lane Branches forked (`front-r1` … `tools-r1`, warm targets copied); agent told to start 8 workers in $SB |
| UI | U1 | — | — | page reconnects after each restart without the token |

New findings: F10 (home lock; file roots refused by DSH). Decision asked: grant the whole LayerFS home to bound sessions so agents can create Sandboxes.

## Check #4 · 08:44Z · verdict: OK

Watch list: W1 0 store-contention refusals in window (4 read refusals 08:31–08:39, noted); V3 no restart since R3 (08:27:46, pid 39536); V8 mounts all `w-*`/`int`/`verify`, no exec on dsh main, no mount paths in execs.

| Group | Pass | Warn | Fail | Notes |
| --- | --- | --- | --- | --- |
| Harness | H2 H3 H5 | — | — | 8 workers + root; every worker loaded the skill; 0 step errors |
| Backend | B8 B10 | F12 host calls tagged with sessions (storms on root are host polls, F09) | — | docker CPU 144% / 727 MiB; data 116 GB |
| Run | R1 running (since ~08:30) | — | — | 115 landed commits since start; root turn 10 ended "integration starts with the first lane whose two workers report" (reports splice in, no nudge needed); w-v2 reported a contract gap (`AggStep`/`AggFinal` lack a function name) |
| UI | U1 | — | — | — |

Calls in window (08:40–08:43, 3 min): 1,105 (host-attributed polls ~900) · refused 4 (NotMounted, NoMatch, InvalidInput, unmount Dirty) · commits UpToDate×4 Committed×8 p90 3.4 s · exec p90 16.3 s.
New findings: F11 (`file cp` of target ~63 s each), F12 (attribution leak).

## Check #5 · 08:58Z · verdict: OK

Watch list: W1 1 store-contention refusal of 297 writes; V3 no restart since R3 (F13 queued for the next window); V8 every mount is a worker's fixed name (w-f1…w-t2 ~10 each), no exec on dsh main, no mount paths.

| Group | Pass | Warn | Fail | Notes |
| --- | --- | --- | --- | --- |
| Harness | H2 H3 H5 | — | — | 8 worker turns live, 0 step errors; root waiting for reports |
| Backend | B8 B10 | commit p90 13.2 s, max 21.2 s (8 builds + target/ commits) | — | docker CPU 468% / 1.8 GiB of 7.75 |
| Run | R1 at ~28 min | — | — | 284 landed commits since start; lanes front 19 / vm 10 / store 31 / tools 21 at the agent's 16:57 review; contract change 4 (`AggOpen { agg, name }`) approved; `__pycache__` cleaned and ignored |
| UI | — | — | — | not checked this round (no sibling reload reported) |

Calls 08:43–08:55: 2,816 (host polls tagged root ~2,270, F09/F12) · exec p50 25 s p90 48 s · commits Committed×65 UpToDate×5.

## Check #6 · 09:07Z · verdict: OK

Watch list: W1 3 of 160 writes; V3 no restart (F13 queued); V8 mounts all fixed names (one empty `--name` mount refused `InvalidInput`), no exec on dsh main.

| Group | Pass | Warn | Fail | Notes |
| --- | --- | --- | --- | --- |
| Harness | H2 H3 H5 | — | — | root turn 12 live; w-s2 done; t1/t2/f1 on turn 2 (follow-ups) |
| Backend | B8 B10 | exec `Unknown`×3 misread (F13) | — | commit p90 12.3 s; docker 244% / 1.6 GiB |
| Run | R1 integration 1: tools lane → `int-r1.1` (ff), check = 0 | store lane waits for S1 | — | T1 80 commits / 117 tests; T2 46 commits, corpus 1,586 records (273 errors), A01–A04; S2 pager 39 + wal 34 tests |
| UI | — | — | — | — |

## Check #7 · 09:20Z · verdict: OK (U4 warn)

Watch list: W1 1 of 170 writes; V3 no restart (F13 queued); V8 fixed names only; U4 probe: branches > 1 only after about 30 s (at 10 s: "1 branch", every agent drawn on the session Branch), timeline not 0:00 (53:47), live gap ≤ 3 s → WARN (slow first read, interim branch attribution wrong).

| Group | Pass | Warn | Fail | Notes |
| --- | --- | --- | --- | --- |
| Harness | H2 H3 H5 | — | — | 5 live turns; root waits for V2 and S1 |
| Backend | B8 B10 | commit max 52.6 s | — | docker 109% / 1.45 GiB |
| Run | R1: 5 of 8 workers done; tools lane integrated (`int-r1.1`) | — | — | V1 codegen covers SELECT/INSERT/UPDATE/DELETE/DDL subsets; missing GROUP BY etc. (later rounds) |
| UI | U4 timeline + live lag | U4 first load > 10 s, interim "1 branch" | — | Sandbox tab, root, 3080 |

## Check #8 · 09:30Z · verdict: OK (W7 new)

Watch list: W1 0 of 70 writes; W7 docker data 90 GB free (−26 GB since R0); V3 no restart; V8 fixed names only.

| Group | Pass | Warn | Fail | Notes |
| --- | --- | --- | --- | --- |
| Harness | H2 H3 H5 | — | — | 4 live turns (root, f1, t1, t2) |
| Backend | B8 B10 | W7 disk trend; commit max 1.0 min | — | docker 232% / 2.8 GiB; host 215 GB |
| Run | **R1 integrated** → `int-r1.4`, `cargo check` clean | — | — | S1 133 commits (index b-trees, rebalance, freelist, integrity_check left for R2); V2 notes schema-row ops and savepoints need a Database trait change |
| UI | — | — | — | U4 probed at #7 |

## Check #9 · 09:43Z · verdict: OK (holding for the restart window)

Watch list: W1 1 of 37 writes; W7 guest 115 GB (transient mounts freed); V3 restart pending (F13 + F15) for the window: root holding, only T1 live; V8 no leftovers reported.

| Group | Pass | Warn | Fail | Notes |
| --- | --- | --- | --- | --- |
| Harness | H2 H3 H5 | — | — | root obeys the hold and the no-removal correction |
| Backend | B8 | B10 3080 at 70–80% CPU, page loads slow (F15 queued) | — | — |
| Run | R1 integrated (`int-r1.4`); 7 of 8 workers stopped cleanly | — | — | corpus 2,116 / 2,500 |
| UI | — | U1 slow full reload (~50 s, starting session) | — | U4 re-probe after the restart |

## Check #10 · 09:58Z · verdict: OK

Watch list: W1 0 of 27 writes; W7 112 GB free (per-mount ~0.1 GB after F17); V3 R4 restart 09:45 in a clean window, nothing cut; V5 no "invalid record"; V8 fixed names only.

| Group | Pass | Warn | Fail | Notes |
| --- | --- | --- | --- | --- |
| Harness | H2 H3 H5 | — | — | root obeys the no-rm and RUSTFLAGS corrections |
| Backend | B8 B10 (3080 5.8% CPU, endpoints ~35 ms) | — | — | F13/F15 live |
| Run | R1 close-out: int-r1.6, R2 plan drafted | waiting for T1 (facade on the real pager) | — | branch.merge Conflict ×2 handled |
| UI | U1 page reload instant | — | — | Sandbox "10 agents · 10 branches" at once after R4 |

## Check #11 · 10:10Z · verdict: OK (F17 partial)

Watch list: W1 0 of 31 writes; W7 109 GB free; V5 none; V8 fixed names only.

| Group | Pass | Warn | Fail | Notes |
| --- | --- | --- | --- | --- |
| Harness | H2 H3 H5 | — | — | 2 live turns earlier (root, T1); T1 reported |
| Backend | B8 B10 | F17: rebuilds gone, but commit p50 4.1 s after no-compile execs | — | — |
| Run | R1 close-out (pager/b-tree fix, facade on real pager) | 3 facade tests blocked (VM↔cursor positioning) | — | — |
| UI | — | — | — | — |

## Check #12 · 10:21Z · verdict: OK

Watch list: W1 0 of 31 writes; W7 107 GB free; V5 none; V8 only `int` mounts.

| Group | Pass | Warn | Fail | Notes |
| --- | --- | --- | --- | --- |
| Harness | H2 H3 H5 | — | — | root obeys F17/F19 steers |
| Backend | B8 B10 | — | — | — |
| Run | R1 close-out (root only) | R1 is ~110 min against the 90 min budget (restart hold + fixes) | — | R2 plan drafted |
| UI | — | — | — | — |

## Check #13 · 10:33Z · verdict: OK (slow R1 close-out)

Watch list: W1 0 of 5 writes; W7 110 GB free; V8 `int` only.

| Group | Pass | Warn | Fail | Notes |
| --- | --- | --- | --- | --- |
| Harness | H2 H3 H5 | — | — | — |
| Backend | B8 B10 | int rebuild after `debug = 0`: exec 2.1–2.3 min, commit 16–24 s (one-time) | — | — |
| Run | F19 profile on 6 Branches | R1 ~2 h (budget 90 min); root alone on close-out fixes | — | R2 fan-out pending |
| UI | — | — | — | — |

## PAUSE · 10:51Z · R2 paused for the runtime switch

All turns stopped (root holding with "waiting for operator"); no pending tool calls. R2 landed: front-r2 8, vm-r2 41, store-r2 4, tools-r2 43 R2-tagged commits. Left mounted: `w-f1` (front-r2, dirty 837/103) and `int` (int-r1.7, dirty 4,086/794) in `dsh-939f81ffc31646d8914d`. Open Sandbox: `dsh-939f81ffc31646d8914d` (docker). Resume only on the starting session's hand-back.

## SWITCH · 11:01Z · runtime 2.0.0-68efc1719472 (de1d77e130), docker restarted 11:00:54Z

Interrupted Workspaces committed by the starting session: `w-f1` → front-r2 `12f4783b605f`, `int` → int-r1.7 `12d488843a76`. Session Sandbox closed (recreated on the next turn). Bench: file calls ~58–63 ms → ~23–25 ms. Watch: "another build" refusals, bash wrapper (`agent-bin/layerfs` starts `#!/bin/bash`), native call log for the monitor.

## Check #14 · 11:26Z · verdict: OK (R2 on the new runtime)

Watch list: W1 4 of 600 writes; W7 113 GB; V3 runtime switch + 3080 restart by the starting session (10:56) and docker restart (11:00:54), R2 resumed 11:03; V5 none; V8 fixed names only; "another build" 0.

| Group | Pass | Warn | Fail | Notes |
| --- | --- | --- | --- | --- |
| Harness | H2 H3 H5 (bash wrapper live) | exec `Unknown` ×2 (native log has no F13 mapping) | — | 7 live turns |
| Backend | B8 B10 (3080 2.4% CPU) | root-tagged `workspace status main` polls ~32/min | — | native ms: commit p50 253 ms, p90 3.7 s |
| Run | R2: 537 commits since 10:32; w-f1, w-s2 done; corpus 2,615 | — | — | contract item 3 (`original_sql`) |
| UI | — | — | — | — |

## Check #15 · 11:37Z · verdict: OK

Watch list: W1 0 of 113 writes; W7 113 GB; V5 none; V8 fixed names only.

| Group | Pass | Warn | Fail | Notes |
| --- | --- | --- | --- | --- |
| Harness | H2 H3 H5 | — | — | 6 live turns; T1, F1 and S2 done |
| Backend | B8 B10 | — | — | native commit p90 522 ms, max 1.3 s |
| Run | int-r2.1 (store lane); tools lane merging | merge conflicts from the tests/it fold (root reconciling); A03 hang (T2 tracing) | — | — |
| UI | — | — | — | — |

## Check #16 · 11:48Z · verdict: OK

Watch list: W1 0 of 52 writes; W7 101 GB free (corrected: the −12 GB is other sessions' Docker volumes, not the run; the run's machine volume is 4.42 GB); V5 none; V8 fixed names only.

| Group | Pass | Warn | Fail | Notes |
| --- | --- | --- | --- | --- |
| Harness | H2 H3 H5 | — | — | 1 live worker turn (T2) |
| Backend | B8 B10 | `Capacity` on a big file diff and on page-size 500 (limits) | — | — |
| Run | R2: 7 of 8 workers done; chain int-r2.5 | tools lane needs a file-apply sync (rename vs delete conflicts) | — | — |
| UI | — | — | — | — |

## Check #17 · 11:59Z · verdict: OK (R2 integration, root alone)

Watch list: W1 0 of 7 writes; W7 run 4.5 GB (Store 1.8 + run 2.7), guest 100 GB free; V5 none; V8 none mounted by workers.

| Group | Pass | Warn | Fail | Notes |
| --- | --- | --- | --- | --- |
| Harness | H2 H3 H5 | — | — | root only |
| Backend | B8 B10 | — | — | — |
| Run | R2: all 8 workers done; chain int-r2.6 (tools synced by file apply) | workers idle during integration (pacing) | — | — |
| UI | — | — | — | — |

## Check #18 · 12:12Z · verdict: WARN (root bottleneck) → steered

Watch list: W1 0 of 9 writes; W7 run 4.6 GB, guest 87 GB free (other sessions' volumes grew); V5 none.

| Group | Pass | Warn | Fail | Notes |
| --- | --- | --- | --- | --- |
| Harness | H2 H3 H5 | — | — | root only |
| Backend | B8 B10 | — | — | — |
| Run | corpus 1,357 / 2,116 on int-r2.4 | root alone ~25 min; its re-sync overwrote its own wiring | — | steered: delegate to T1/V1, fan out R3 |
| UI | — | — | — | — |

## Check #19 · 12:23Z · verdict: OK (R2 integrated, R3 running)

Watch list: W1 0 of 11 writes; W7 run 4.7 GB, guest 85 GB; V5 none; V8 fixed names only.

| Group | Pass | Warn | Fail | Notes |
| --- | --- | --- | --- | --- |
| Harness | H2 H3 H5 | — | — | 9 live turns |
| Backend | B8 B10 | — | — | — |
| Run | **R2 integrated** (`int-r2.6`, corpus 1,682 / 2,615); **R3 fanned out** to 8 workers | one facade pragma test (T1) | — | R2 publish after the tools lane |
| UI | — | — | — | — |

## Check #20 · 12:35Z · verdict: OK

Watch list: W1 0 of 61 writes; W7 run 4.7 GB, guest 93 GB; V5 none; V8 fixed names only.

| Group | Pass | Warn | Fail | Notes |
| --- | --- | --- | --- | --- |
| Harness | H2 H3 H5 | — | — | 8 worker turns live |
| Backend | B8 B10 | — | — | commit p90 504 ms (native) |
| Run | R3 running; acceptance failures assigned (A04/A05/A07/A08/A10/A11) | R2 publish pending T1 | — | — |
| UI | — | — | — | — |

## Check #21 · 12:47Z · verdict: OK

Watch list: W1 0 of 96 writes; W7 run 5.2 GB, guest 92 GB; V5 none; V8 fixed names only.

| Group | Pass | Warn | Fail | Notes |
| --- | --- | --- | --- | --- |
| Harness | H2 H3 H5 | — | — | 9 live turns |
| Backend | B8 B10 | — | — | commit p90 728 ms (native) |
| Run | R3 running; R2 publish candidate in progress | — | — | 87 commits / 12 min |
| UI | — | — | — | — |

## Check #22 · 12:59Z · verdict: OK

Watch list: W1 0 of 57 writes; W7 run 4.9 GB, guest 113 GB; V5 none; V8 fixed names only.

| Group | Pass | Warn | Fail | Notes |
| --- | --- | --- | --- | --- |
| Harness | H2 H3 H5 | — | — | 8 live turns |
| Backend | B8 B10 | — | — | — |
| Run | F1 R3 done; A02 PASS; R2 publish with the first R3 tools merge | — | — | — |
| UI | — | — | — | — |

## Check #23 · 13:10Z · verdict: OK

Watch list: W1 0 of 65 writes; W7 run 5.0 GB, guest 113 GB; V5 none; pending runtime switch waits for the post-R3 gap.

| Group | Pass | Warn | Fail | Notes |
| --- | --- | --- | --- | --- |
| Harness | H2 H3 H5 | — | — | 7 live turns |
| Backend | B8 B10 | — | — | commit p90 1.8 s |
| Run | S2 DONE; A02 A05 A07 PASS; F1 DONE | — | — | R2 publish waits on T1 |
| UI | — | — | — | — |

## Check #24 · 13:22Z · verdict: HOLD (F20)

Run idle since 13:10:57Z (a settings-save reload disposed the root and workers). $SB running; w-t1/w-t2 mounted dirty idle. Waiting on the starting session: switch now or resume.

## SWITCH-2 · 13:22Z → resume 13:23:28Z

Runtime 2.0.0-8134bc02b50f (unmount fix). w-t1 → 12ebc046fdaa, w-t2 → 1250d9f7559a (tools-r3 head). Root resumed (turn 36) with the publish steer; the six stopped R3 workers are to be restarted. Watch: wrapper regeneration, "another build", unmount p90.

## Check #25 · 13:33Z · verdict: OK (recovered)

Watch list: W1 2 Busy unmounts (exec running, retried); W7 not re-measured; wrapper on 8134bc02b50f ✓; "another build" 0; V9 new (truncated read → rewrite, w-v1).

| Group | Pass | Warn | Fail | Notes |
| --- | --- | --- | --- | --- |
| Harness | H2 H3 H5 | — | — | 7 live turns after resume |
| Backend | B8 B10 | V9 | — | unmount p90 31 ms |
| Run | R2 publish candidate building | — | — | publish steer taken |
| UI | — | — | — | — |

## Check #26 · 13:44Z · verdict: OK

Watch list: W1 0 of 44; W7 run 4.9 GB, guest 113 GB; unmount p90 35 ms; V9 steer delivered. main still skel; R2 candidate building.

## Check #27 · 13:55Z · verdict: OK

Watch list: W1 0 of 46; W7 run 5.6 GB, guest 112 GB; unmount p90 25 ms. R2 full gate running for publish. w-s1 empty-$ws slip (InvalidInput×3).

## Check #28 · 14:06Z · verdict: WARN (publish pending)

Watch list: W1 0 of 36; W7 run 5.4 GB, guest 113 GB; unmount p90 23 ms. R2 gate failed at 13:48; candidate now gets store-r3 fixes. main still skel; nudge at the next check if unchanged.

## Check #29 · 14:18Z · verdict: WARN → nudged

T1 and T2 DONE; A02 A05 A06 A07 A16 PASS on lane heads (not yet published). main still skel; the candidate absorbed all four R3 lanes. Nudge spliced. W1 0 of 28; W7 run 5.3 GB, guest 113 GB.

## Check #30 · 14:29Z · verdict: OK (publish in progress)

Root fixing the last red test on the chain, then publishing. S1 DONE. W1 0 of 45; guest 113 GB; unmount p90 25 ms.

## Check #31 · 14:40Z · verdict: OK · PUBLISHED int-r3.3

main 32f9d197 (from int-r3.3, 14:32Z), verified: gates green, A01 2151/3010 (71.5%), A05 A06 A16 PASS. W1 0 of 71; W7 run 5.3 GB, guest 113 GB; unmount p90 34 ms.

## Check #32 · 14:51Z · verdict: OK

Next R3 step: int-r3.4–r3.6 via -fix Branches after 7 merge Conflicts (normal integration). main = int-r3.3. W1 0 of 46; guest 113 GB.

## Check #33 · 15:02Z · verdict: OK

main +2 Layers (32c86d73 from int-r3.6, 32ba3f6a next step). R4 fixes dispatched for the red checks. W1 0 of 70; W7 run 5.4 GB, guest 113 GB; unmount p90 41 ms.

## Check #34 · 15:13Z · verdict: OK (latency up under build load)

V2 DONE. Next step merging. Commit p90 2.7 s, edit max 3.7 s (concurrent cargo builds). A06 regressed on the T2 lane; watch no-regression on publish. W1 0 of 60; guest 112 GB.

## Check #35 · 15:24Z · verdict: OK

main +1 Layer (3279b525, verified). 6 Layers total. Root waiting on R4 reports (6 live workers). Commit p90 816 ms; unmount p90 35 ms; W1 0 of 94; W7 run 5.8 GB, guest 112 GB.

## Check #36 · 15:35Z · verdict: OK

main +1 (326b73d3: A07 + cursors). Published tree: A02 A05 A07 A10 A16 green. W1 0 of 105; unmount p90 21 ms; guest 112 GB.

## Check #37 · 15:46Z · verdict: OK

main +1 (32d9577c: A06 PASS, corpus 2286/3010). Root merging T1. W1 0 of 59; W7 run 6.4 GB, guest 112 GB.

## Check #38 · 15:57Z · verdict: WARN (regression + host load)

main +1 (32a95bdb, corpus 2333/3010). A09/A10 regressed vs int-r3.9; no-regression steer spliced. Host-untagged polling spike: 681 calls, 10–43 s stalls at 15:54–15:55. W1 0 of 60; guest 111 GB.

## Check #39 · 16:09Z · verdict: FAIL → recovered (F21)

Run halted 15:56–16:00 by a host readiness timeout under polling load (F21; source F22). Binding re-activated; root prompted to continue at 16:10 (turn 40 live). main = 32a95bdb. Fixes F21/F22 queued for the next restart window.

## Check #40 · 16:22–16:28Z · verdict: FAIL → fixed (F23) · 3080 restarted

Run stuck 16:00–16:27 (bound without ws). Host fix F21+F23, 435/435 unit, restart 16:26:19 (pid 3599). Root resumed 16:27, tool calls ok. main = 32a95bdb. F22 open.

## Check #41 · 16:38Z · verdict: OK (recovered)

main +1 (32e7254f: A10 green, no-regression gate applied). Workers re-dispatched. F21 warnings 0. W1 0 of 54; guest 112 GB.

## Check #42 · 16:49Z · verdict: WARN (F22 stalls)

main +2 (3264c9a0, 32b1490b); A14 PASS. F22 host-polling stalls at 16:40 and 16:45 (agent calls 11–23 s), no interruption (F21 holding). W1 0 of 77; W7 run 6.9 GB, guest 111 GB.

## Check #43 · 17:00Z · verdict: CONTINUE (root stopped at 8/16)

main 32186181 (tree + BUILD-REPORT). 8/16 PASS; terminal pass not met. Root prompted to continue hardening (R5).

## Check #44 · 17:12Z · verdict: OK (R5)

int-r5.3 merged all four lanes; gate running. 154 commits, 0 contention. Two 45 s commits ended together at 17:05:54 (watch). Host file reads 98 per 10 min (was ~507). Guest 111 GB.

## Check #45 · 17:23Z · verdict: OK (R5)

main 32498f98; chain corpus 2466/3013; no-regression running. Host polling −65% (1,223 → 422 per 10 min). W1 0 of 56; W7 run 6.7 GB, guest 111 GB.

## Check #46 · 18:14Z · verdict: OK (R7, 13/16 published)
- Window 17:23→18:14Z, including the R5 restart window (HOLD 17:53, 3080 restarted 17:57:56Z as pid 59527, resumed 18:00–18:03Z).
- **Main:** int-r7.3 published as Layer 32be23ca. A04 PASS (ordered index cursors) and A08 PASS (nested triggers, INSTEAD OF UPDATE). Corpus 2,666/3,119 (85.5%). No-regression set of 11 checks plus gates green. **13/16.** Red: A01 (453 records), A11 (last_value frame), A13 (per-row decode and memory).
- **Agents:** root idle 2.3 min after merging and publishing; its turn ended with workers live, so their reports will wake it. Live: w-v2 (1 pending), w-f2, w-v1. w-t1 finished (A04 passes), and w-s2 finished (pager savepoint API).
- **Calls:** 3,072 calls in the window, 682 of them host-tagged. 44 refused (1.4%). W1 store-contention refusals: 3 of 405 writes. Commits p50 186 ms, p90 1.2 s, max 5.7 s; no slow non-exec calls (>10 s). The 24 NotMounted are workspace.status on unmounted worker Workspaces (ordinary).
- **Host load after R5 (F22 host half plus the catalog unclaimed cache):** last 10 min 256 host-tagged calls, 178 without workspace status. Last 5 min 93 / 64. Before: 337 per 10 min with the client half only, and 1,223 before any F22 fix. Top families: workspace status 78, store list 61, branch list qv2-strata 35. **F22 closed.**

## Check #47 · 18:25Z · verdict: OK (R7, publish pending at 14/16)
- Window 18:14→18:25Z.
- **Root:** live, 1 pending call, running the full 14-check no-regression set (A13 under the memory cap) before publishing. Chain int-r7.5 = int-r7.4 + vm-r10 plus F2's CurrentRow.
- **Progress:** corpus 2,756/3,119 (88.4%, +90).
  - A13 PASS: 74 s total, peak 439 MiB, every query under 10 s. This came from V2's row-decode cache plus TPC-H secondary indexes added to strata-gen's SCHEMA_SQL.
  - A11: the last_value frame is fixed. It now fails only on an outer aggregate over a windowed derived relation (an F2 planner item, dispatched).
  - Still red: A01 (corpus records) and A11.
- **Caveat for REPORT:** A13's speed partly comes from secondary indexes the root approved in the shared generator schema. Both engines load the identical schema, and SPEC §8.2 A13 doesn't fix the index set ("TPC-H-like … built by strata-gen, loaded by both engines"). Not a rule break, but it should be disclosed.
- **Workers:** all idle; w-v1, w-v2 and w-f2 reported in.
- **Calls:** 587 calls, 111 host-tagged (about 100 per 10 min). Refused 6 (1.0%); W1 store-contention refusals 0 of 70 writes. No slow non-exec calls. No F21 keep-warnings and no OOM kills.

## Check #48 · 18:36Z · verdict: OK (14/16 published, R9 running)
- Window 18:25→18:36Z.
- **Publishes:** int-r7.7 at 18:25:35Z (14/16, corpus 2,756) and int-r8.1 at 18:35:04Z (still 14/16, corpus 2,791 of the 3,130 records T2 now counts). Every check except A01 and A11 passes on main.
- **R9 dispatch (A01 owner buckets):**
  - F2: recursive CTE IR contract plus derived/materialised relations.
  - V1: A11 step 20, then upsert, trigger bodies, FK ON UPDATE CASCADE and row values.
  - V2: the 63-record collation bucket.
  - T1: TEMP tables.
  - T2: a fresh A01 measurement.
- **Agents:** root live with 1 pending call (publishing and merging F2's A01 batch). w-v2 live.
- **Calls:** 1,099 calls, 95 host-tagged. Refused 21 (1.9%, mostly NotMounted status probes); W1 store-contention refusals 0 of 131 writes. Commits p50 130 ms, p90 789 ms. No slow non-exec calls and no F21 keep-warnings.

## Check #49 · 18:47Z · verdict: OK (14/16, R9 merging)
- Window 18:36→18:47Z.
- **Publish:** int-r8.2 published, still 14/16. Corpus 2,812/3,130 (318 fails).
- **Biggest A01 buckets:** 13-recursive 71, 12-cte 63, 07-collation 63, 10-subqueries 26.
- **Root:** live, merging collation plus the recursive-CTE contract, planner and codegen into one chain.
- **Calls:** 822 calls, 70 host-tagged. Refused 28 (3.4%), all ordinary:
  - 11 NotMounted status probes.
  - 4 file.edit NoSuchBranch.
  - 3 branch.merge NameTaken and 2 Conflict (integration chain naming and real conflicts the root resolves).
  - W1 store-contention refusals: 0 of 127 writes.
- Commits p50 160 ms, p90 848 ms. No slow non-exec calls and no F21 keep-warnings.

## Check #50 · 18:58Z · verdict: OK (14/16, A01 at 95.5%)
- Window 18:47→18:58Z.
- **Publishes:** 2 in this window, the latest int-r8.10 = main + tools-r12.
  - T2 added 36 oracle pins (recursive CTEs, collation, compound ORDER BY, trigger nesting), so the corpus is now 3,166 records.
  - **3,024 pass / 142 fail (95.5%)**. Oracle check and crosscheck green.
  - Still red: A01 and A11. The ledger says "15/16 measured checks green", but with those two red that's 14/16; I've logged 14/16.
- **A01 R10 buckets (142):** V1 DML/upsert/FK/trigger 53; F2 planner/CTE/derived 53; V1/V2 expression/type/error text ~30; T1 pragma; V1/T1 TEMP.
- **Agents:** root idle 2.6 min with 4 workers live (w-t1, w-v2, w-f2, w-v1), so their reports will wake it.
- **Calls:** 941 calls, 78 host-tagged. Refused 31 (3.3%), all ordinary (NotMounted/Exists/Dirty unmounts, NameTaken forks). W1 store-contention refusals 0 of 112 writes. Commits p50 125 ms, p90 671 ms. No slow non-exec calls and no F21 keep-warnings.

## Check #51 · 19:09Z · verdict: OK, with a watch item (14/16)
- Window 18:58→19:09Z.
- **Root:** live, publishing int-r8.12. F2's R10 work adds +20 on its branch (compound/VALUES/CTE projections, WITH on DML, window misuse and frames) and fixes A11 step 18.
- **Watch item, A11 step 19:** a truncated statement (`… WHERE n >`). sqlite3 reports `near ";": syntax error` and Strata reports "incomplete input". F1 diagnosed this as a harness asymmetry, and the root plans to fix the A11 harness on the next chain.
  - SPEC: only the user may drop a check, and a harness change must not weaken the comparison.
  - Next check: read that harness diff and confirm both engines get byte-identical input and the expected output is unchanged.
- **Calls:** 1,057 calls, 62 host-tagged. Refused 39 (3.7%), mostly NotMounted status probes (32). W1 store-contention refusals 0 of 124 writes. Commits p90 658 ms. No slow non-exec calls and no F21 keep-warnings.

## Check #52 · 19:20Z · verdict: OK (15/16 published)
- Window 19:09→19:20Z.
- **Main:** Layer 3255bd75 (int-r8.15) published. **A11 PASS. 15/16:** every check except A01 passes (A13 under the memory cap). Corpus 3,109/3,166 (98.2%); A01 has 57 fails left (10-subqueries 12, 09-joins FULL OUTER 10, 12-cte 9, …).
- **Gate held:** int-r8.13 regressed A01 (72 → 120), so it was not published, per §4.
- **A11 harness change reviewed** (main@55bd751b `crates/strata-accept/src/checks.rs`):
  - sqlite3 side (≈line 1964): writes `"{sql.trim().trim_end_matches(';')};"` for every step, unchanged.
  - Strata side `strata_scenario` (≈line 2053): now runs the same `format!("{};", sql.trim().trim_end_matches(';'))`, commented "Give both engines the same terminated text".
  - Before the fix, Strata got the step without `;`, so the deliberately truncated step 19 compared "incomplete input" against sqlite3's `near ";": syntax error` from different input text.
  - The change only makes the input identical; the expected output and the comparison are untouched. **Legitimate**, no weakening.
- **R11:**
  - front-r15 (F2 subqueries, CTEs, recursive queries, views).
  - vm-r14 (V1 FULL OUTER, TEMP-as-ordinary, 03-update scalar subqueries; still chasing an exit-101 gate run).
  - V2 misc classes.
  - tools-r13 TEMP facade on standby.
- **Disclose in REPORT:** TEMP tables are implemented as ordinary tables ("corpus has only one TEMP statement"). This is a semantic shortcut that only matters if a check inspects sqlite_temp_schema.
- **Incident noted by the root:** w-t1 saw a transient worker/client bundle-hash mismatch (`Unavailable`) during the R5 restart; it cleared on retry and no branch changes were lost.
- **Calls:** 673 calls, 81 host-tagged. Refused 17 (2.5%; 3 merge Conflicts, the rest NotMounted). W1 store-contention refusals 0 of 71 writes. No slow non-exec calls and no F21 keep-warnings.

## Check #53 · 19:33Z · verdict: DEGRADED then recovered (OOM #8 and #9; 15/16)
- Window 19:20→19:33Z.
- **Root:** live, gating a publish at corpus **3,126/3,166 (98.7%), A01 40**. Main is still 15/16 (Layer 3255bd75).
- **OOM kills #8 (~19:23Z) and #9 (after 19:31Z):** F2's `strata-slt 13-recursive.slt` ran away to over 5 GB twice. Guest MemAvailable fell to 16 MB / 0.29 GB with swap full.
  - Daemon starvation shows in the call log, 19:20–19:28Z: 20 non-exec calls over 10 s. branch list 12–35 s, store status 18–28 s, workspace status 17 s, machine get/list/status timing out near 10 s.
  - These came from agents and the host alike, including demo Stores. All returned ok once memory came back.
  - W1 store-contention refusals: 1 of 104 writes.
- **Fixes:**
  - The all-lanes prlimit steer reached the root at 19:26Z.
  - F2 was stopped and continued with `timeout 60 prlimit --as=2G` at 19:27Z.
  - The root's A13 now runs under `ulimit -v 3145728; timeout 220`.
- **F25:** stopping the turn did NOT end the Sandbox exec (see FIX-LOG); the kernel ended it.
- **Calls:** 613 calls, 113 host-tagged. Refused 23 (3.8%; NotMounted, NoMatch and AmbiguousMatch edits). Commits p50 537 ms, p90 2.3 s, max 6.4 s, all inflated by the memory pressure. No F21 keep-warnings.

## Check #54 · 19:44Z · verdict: OK (15/16, A01 39)
- Window 19:33→19:44Z.
- **Publish:** Layer 32f35b3e (int-r9.2). Corpus 3,127/3,166 (98.8%), A01 39; the other 15 checks pass (capped A13 58.9 s).
- **Root cause of the F2 runaway:** fixed in front-r15. Joined-only Materialize ignored LIMIT, so a `LIMIT`-bounded recursive CTE never stopped.
- **Instance-identity contract** committed on int-r9.3, with front-r16 (F2) and vm-r15 (V1) forked from it.
- **Remaining A01:** 19 instance records, 8 V1, 2 T1 (foreign_key_check, now done: 22-fk 101/101), 1 real temp schema, 1 V2, 2 misc.
- **Agents:** root live (merging T1's foreign_key_check and publishing); w-f2 live.
- **Calls:** 905 calls, 93 host-tagged. Refused 30 (3.3%), all ordinary. W1 store-contention refusals 0 of 159 writes. Commits p90 695 ms. **No slow non-exec calls**, so the daemon has recovered from the OOM stall. No F21 keep-warnings.

## Check #55 · 19:55Z · verdict: OK (15/16, A01 20)
- Window 19:44→19:55Z.
- **Publish:** int-r10.0, the instance-identity halves from V1 and F2. Corpus **3,146/3,166 (99.4%), A01 20**; the other 15 checks pass (A13 capped).
- **Last 20 A01 records:** 01-ddl:314 TEMP artifact, an INSERT…SELECT with 0 rows, 03-update ×2, 04-select ×2, 10-subqueries ×6 (row-value IN, correlated counts), 12-cte:531, 13-recursive ×2, 14-aggregates ×2, 22-fk ×2, 23-triggers ×1 (INSTEAD OF DELETE).
- **Agents:** root live, merging V1's latest. Also live: w-t1 (the TEMP catalog is ready to wire once its contract lands) and w-v1.
- **Calls:** 815 calls, 56 host-tagged. Refused 16 (2.0%), all ordinary. W1 store-contention refusals 0 of 70 writes. Commits p90 532 ms. No slow non-exec calls and no F21 keep-warnings.

## Check #56 · 20:06Z · verdict: OK (15/16, A01 14, final round)
- Window 19:55→20:06Z.
- **Main:** Layer 322a2630. Corpus **3,152/3,166 (99.6%), A01 exactly 14**; the other 15 checks pass.
- **Final round dispatched:**
  - V1 vm-r18: aggregate-slot clashes, recursive materialized columns, INSERT…SELECT UNION ALL.
  - V2 vm-r19: stale subquery aggregate register, correlated count.
  - F2 front-r18: row-value IN (SELECT), aggregate view joined to a base table.
- **Root's plan:** merge, run the 15-check no-regression set, publish, then run SPEC §9 in full on a fresh fork. The root's turn has ended with w-v1, w-v2 and w-f2 live; their reports will wake it.
- **Calls:** 552 calls, 68 host-tagged. Refused 12 (2.2%; one commit InvalidInput, the rest NotMounted/Exists). W1 store-contention refusals 0 of 51 writes. No slow non-exec calls and no F21 keep-warnings.

## Check #57 · 20:17Z · verdict: OK (approaching terminal pass)
- Window 20:06→20:17Z.
- **Publish:** int-r10.6 (V2's statement-wide aggregate-slot allocator). Corpus 3,161/3,166 (99.8%), A01 5.
- **Candidate:** the root reports **corpus 3,166/3,166 (100%) on vm-r18** and is running the full SPEC §9 gate on that tree before publishing.
- **Operator plan at terminal pass:** independently verify:
  - the final-verify fork, 16 PASS lines each under 100 s, and the fmt/clippy/test/oracle exits;
  - no corpus records edited or removed: diff `tests/slt*` between Layer 322a2630 and the final Layer;
  - docs/BUILD-REPORT.md on main;
  - no live subagent.
- **Calls:** 807 calls, 63 host-tagged. Refused 27 (3.3%; 15 mount Exists). W1 store-contention refusals 0 of 100 writes. No slow non-exec calls and no F21 keep-warnings.

## Check #58 · 20:28–20:32Z · verdict: terminal pass CLAIMED, NOT ACCEPTED (2 §9 gaps)
- **Root's claim:** SPEC §9 terminal pass on final-verify-1, a fresh fork of main Layer 32d426a1 (code tree 3277f713 from vm-r18 12937ce5).
- **Operator verification:**
  - ✔ final-verify-1 was forked from main's latest Layer 32d426a1. All 16 `strata-accept` runs PASS there; A13 48.3 s total, every query under 10 s, every check under 100 s.
  - ✔ fmt, clippy and test exit 0, oracle `--check` up to date, and strata-slt 3,166/3,166, on verify-final and verify-terminal (same code tree). No `._*` files. BUILD-REPORT.md on main (14,570 B, §9 section).
  - ✔ **Corpus integrity:** first corpus Layer 32f9d197 (14:30Z; the two older Layers are the skeleton and the empty seed) → 32d426a1. 12 .slt files (plus their .sqlin sources) modified: **0 records changed or removed, 128 added.** No /scripts changes.
  - ✔ **Oracle independence:** `scripts/oracle.py` computes every expected value with Python's sqlite3 module (SQLite 3.40.1; `--crosscheck` against the pinned sqlite3 CLI) and never invokes Strata.
  - ✔ Integration test files per crate: 4–29, all ≥ 4 (folded `tests/it/` layout).
  - ✘ **A15 VACUUM criterion:** SPEC §8.2 says "VACUUM shrinks the file ≥ 70 %". checks.rs (~3480, unchanged since 32f9d197) instead accepts Strata's VACUUMed size ≤ 1.3 × sqlite3's *un-vacuumed* size. The measured result 49152 → 16384 is a 66.7 % shrink.
  - ✘ **Test total:** §9 needs `cargo test --workspace` passed ≥ 1,500. The evidence shows only exit 0, and BUILD-REPORT §3 says "~1,000 tests" (R4 numbers sum to ~970).
- **Action (20:32Z):** the root was idle, so I sent the review with Enter. Asked for: A15 asserting the SPEC criterion (after-VACUUM ≤ 30 % of before, with a fixture large enough; fix Strata if short; no relaxing); the summed test total (add real tests if under 1,500); then §9 again on final-verify-2 and an update to BUILD-REPORT §9.
- **REPORT.md not written.**

## Check #59 · 20:43Z · verdict: OK (R14 closing the §9 gaps)
- Window 20:28→20:43Z.
- **The root accepted both gaps:**
  - Measured the test total on final-verify-1 as **1,132 passed**, 368 short of 1,500.
  - A15 pre-check on the final engine: 20k rows (~4.3 MB), delete 90%, Strata's VACUUM goes 4,333,568 → 442,368 B (**post = 10.2% of pre**, 89.8% reclaimed). So only the check's assertion and its fixture need fixing, no engine change.
- **R14 branches from final main:** front-r19 (F1/F2 tests), vm-r20 (V1/V2), store-r19 (S1/S2), tools-r16 (T1/T2 tests plus the A15 check fix). Root idle, waiting on T1/T2.
- **Watch:** the new tests must be real, not trivial padding. I'll sample the test diff at integration.
- **Calls:** 1,825 calls, 281 host-tagged. Refused 71 (3.9%).
  - W1 store-contention refusals rose to **17 of 226 writes** (unmount Busy 14, commit Busy 3) with 8 lanes active again.
  - No slow non-exec calls and no OOM.

## Check #60 · 20:54–20:57Z · verdict: terminal pass CLAIMED again; one item pending
- **Root's claim:** §9 on final-verify-2 (code Layer 3298bd9e) and final-verify-3 (published main 32c85f71, report included). All 17 subagents inactive.
- **Operator verification:**
  - ✔ A15 fix in checks.rs: a 20k-row fixture with a ~100-byte payload, asserting `size_after ≤ 30 % × size_before` on the same file, plus Strata ≤ 1.3 × sqlite3's VACUUMed size. Result 7,626,752 → 401,408 B (5.3 %), sqlite3 385,024 B. No other check changed (the only other harness file touched is tests/it/compare.rs).
  - ✔ /tests and /scripts unchanged since 32d426a1, so corpus integrity holds against 32f9d197 (0 changed or removed).
  - ✔ Sampled new tests (codegen errors.rs 21 tests, btree rebalance free/reuse tests): real behavioural assertions, not padding.
  - ✔ final-verify-2: fmt and clippy 0, oracle up to date, corpus 3,166/3,166, A01–A16 PASS (A13 49.1 s), integration files per crate 4–30, no `._*`. final-verify-3 (published tree): fmt 0, corpus, A01, A15, A16 PASS, report contains the numbers.
  - ✘ **"0 failed" unproven:** the test step summed `N passed` across `test result:` lines but never printed cargo test's exit status or the failed count. 1,567 could include a FAILED binary.
- **Action (20:56Z):** asked the root (idle) to run `cargo test --workspace --no-fail-fast` once on final-verify-3 with the exit status, the passed and failed sums and the FAILED count, record them, and fix anything that fails.

## Check #61 · 21:05Z · verdict: TERMINAL PASS ACCEPTED
- **Root's evidence on final-verify-3:** `cargo test --workspace --no-fail-fast` exit 0, 1,567 passed, 0 failed, 0 FAILED binaries.
- **Final Layer:** report-only Layer 3216799e. Its diff against 32c85f71 touches only /docs/BUILD-REPORT.md (no /crates, /tests, /scripts, Cargo or toolchain changes).
- All §9 items proven, so REPORT.md is written (demo/quarry-v2/REPORT.md).
- **Run totals:** 07:35:47Z → 20:57:22Z (13 h 22 min). 59,331 calls, refused 1.2 %, contention 35/5,312 writes. 4,330 landed Commits, 39 publishes, 93 Branches. Store file 4.93 GB.
- **Cleanup:**
  - qv2 Sandbox `dsh-939f81ffc31646d8914d`: its clean, idle dsh session Workspace `main` (0 entries) unmounted, then the Sandbox closed (Closed).
  - Remaining Sandboxes are the demo-mix ones (not the run's).
  - Side servers on 3107/3108 (this checkout) and the dsh-layerfs .dev server were started on Nov 11 by other sessions; not the operator's, left running.
