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
