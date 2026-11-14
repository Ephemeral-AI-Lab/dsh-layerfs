# Real case: Quarry v2, Strata on LayerFS v2

On 2026-11-13, nine DeepSeek Harness (DSH) agents built **Strata**, a SQLite-compatible
database in Rust. All of their files lived in one LayerFS project,
`qv2-store/qv2-strata`, through dsh-layerfs on DSH at 127.0.0.1:3080. The run reached
SPEC §9's terminal pass at 21:05Z, 13 h 22 min after it started.

This page covers the task, what was built, storage and speed efficiency, and the bugs
found and fixed. [report.html](report.html) is the same content as a styled page, in
English and Chinese (the switch is at the top).

| Run | Agents | History | Store |
|---|---|---|---|
| 07:35Z → 21:05Z, 13 h 22 min | 1 main agent + 8 workers in 4 lanes | 4,354 Commit records, 39 publishes to main | 4.93 GB SQLite Store on the Docker machine |

Runtime `2.0.0-8134bc02b50f`: LayerFS commit c5e58735bb on `layerfs_v2_0_0`, release
build. The dsh-layerfs fixes made during the run are in commit 6a39cb1 on `layerfs_v2_0_0`.

## The task

Build a SQLite 3.40-compatible engine as a team. Every bash call runs in a LayerFS
Workspace (mount, exec, commit, unmount). Each lane works on its own Branch, and the main
agent merges lanes on an integration chain and publishes to main. The run is done only
when SPEC §9 holds on a fresh fork of main:

- fmt, clippy with `-D warnings` and `cargo test` all exit 0, with at least 1,500 tests.
- Every corpus record matches what SQLite 3.40.1 itself returns.
- All 16 acceptance checks (A01–A16) pass against the reference `sqlite3`.

An operator session checked the run every 10–15 minutes (60 checks) and steered it when
it stalled. The full brief is in [SPEC.md](../../../demo/quarry-v2/SPEC.md) and
[RUNBOOK.md](../../../demo/quarry-v2/RUNBOOK.md).

## What was built

Strata has 15 crates and about 87,000 lines of Rust, including tests.

| Area | Crates | Lane | What it does |
|---|---|---|---|
| Contracts | `strata-types` | main | Values, AST, plan IR, opcodes, store traits and in-memory implementations |
| Front end | `parser`, `sema`, `planner` | F1, F2 | Full SQLite 3.40 grammar with exact error text; catalog rebuilt from `sqlite_schema`; cost planner using `sqlite_stat1` |
| Execution | `codegen`, `vm`, `func` | V1, V2 | Bytecode for every statement, windows and upsert, a sorter that spills to disk, byte-faithful JSON1 |
| Storage | `btree`, `pager`, `wal` | S1, S2 | SQLite page format, a bulk loader 55× faster than row inserts, rollback journal and WAL, POSIX locks, recovery after kill -9 |
| Tools | `strata`, `cli`, `gen`, `slt`, `accept` | T1, T2 | Connection API with a statement cache, the shell, a TPC-H generator, the corpus runner and the 16 acceptance checks |

Final result on main Layer `3216799e…`:

- `cargo test --workspace --no-fail-fast` exits 0: **1,567 passed, 0 failed**.
- The corpus passes **3,166 / 3,166**. Every expected value comes from SQLite 3.40.1 through
  `scripts/oracle.py`, which never runs Strata.
- **All 16 acceptance checks pass:**
  - A12: an index is 81× faster than a full scan on 1M rows.
  - A13: all 8 TPC-H-style queries take under 10 s.
  - A15: VACUUM leaves 5.3 % of the file.
  - A16: 10 shell modes are byte-identical to `sqlite3`.

The operator rejected two earlier "done" claims before accepting this one: A15 didn't test
SPEC's criterion, and the test total was under 1,500 and unproven.

The run report also discloses a few design choices:

- A13 is helped by secondary indexes the team added to its own TPC-H schema.
- TEMP tables are held in memory.
- Every test run now has a memory cap.

## Storage efficiency

Every Commit records the whole project tree, which is about 9 GB including `target/`.
LayerFS keeps each distinct piece of content once, then compresses it and delta-encodes
it. The whole run's history ended up smaller than a single checkout of the final tree.

| Measure | Bytes | Source |
|---|---:|---|
| All saved trees together (sum of each Commit's tree size) | 30.2 TB | `history_logical` |
| Distinct content, after deduplication | 25.6 GB | `canonical` |
| Final tree on main, one checkout (8,007 files) | 11.4 GB | `project stats` |
| Store file on disk (SQLite, no free pages) | 4.93 GB | `file` |
| Content as stored, after compression and delta encoding | 4.75 GB | `stored` |

- **Deduplication:** 1,179× (30.2 TB → 25.6 GB).
- **Compression and delta encoding:** 5.4× (25.6 GB → 4.75 GB).
- **Overall:** about 6,100× from saved history to bytes on disk.

| Commit kind | Commits | Median new content | Median stored | Stored in total |
|---|---:|---:|---:|---:|
| File edits (`via: fs`: read, write, edit, apply) | 3,051 | 29 KB | 0.9 KB | 0.07 GB |
| Builds and tests (`via: exec`, mostly new `target/` files) | 1,195 | 9.8 MB | 1.3 MB | 4.68 GB |
| Merges | 67 | 188 KB | 16 KB | 0.002 GB |

Builds account for 98.5 % of the stored bytes. The median file edit costs under 1 KB on
disk, even though each one records a 9 GB tree. 232 of the file-edit Commits are DSH
session-log saves on `dsh.session.*` Branches, which hold 0.065 GB in total. There are
41 more records with no `via`, such as Publication Layers; they carry no storage counters.

## Speed

During the run, the LayerFS runtime was switched twice, and dsh-layerfs got one round of
host fixes, all while the agents kept working.

| Measure | Before | After | Change |
|---|---:|---:|---|
| Docker Workspace write, 1 MB blocks (debug → release bundle, F19) | 32.5 MB/s | 437 MB/s | 13× faster |
| 200 MB Commit (debug → release bundle) | 10.2 s | 0.38 s | 27× faster |
| Agent file call through the wrapper (Node → bash wrapper) | ~60 ms | ~24 ms | 2.5× faster |
| Unmount after a Commit of 1 s or more (LayerFS PR #680), median | 281 ms | 26 ms | 11× faster |
| Host machine list `/api/machines` (F15) | 6.8 s | 33 ms | 206× faster |
| Host CLI calls per 10 min (F22) | 1,223 | ~240 | 80 % fewer |

| Call (after both switches) | p50 | p90 | Calls |
|---|---:|---:|---:|
| `workspace mount` | 7 ms | 16 ms | 1,121 |
| `workspace commit` | 204 ms | 1.06 s | 1,186 |
| `workspace unmount` | 14 ms | 35 ms | 1,121 |
| `file read` | 6 ms | 10 ms | 4,926 |
| `file edit` | 14 ms | 25 ms | 982 |
| `branch fork` | 5 ms | 8 ms | 93 |
| `branch merge` | 263 ms | 479 ms | 67 |
| `branch publish` (an 11 GB tree, by reference) | 7 ms | 11 ms | 39 |

Over the whole run there were 59,331 LayerFS calls, and 1.2 % were refused. Only 35 of
5,312 writes (0.66 %) were refused because the Store was busy.

One thing is still slow: copying a warm `target/` with `file cp` takes about a minute
(F11).

## Bugs found and fixed

There were 24 findings: 13 fixed, 6 worked around and 5 still open. dsh-layerfs fixes were
verified on a side server, merged, and loaded into 3080 with coordinated restarts. LayerFS
fixes went upstream. Full entries are in
[FIX-LOG.md](../../../demo/quarry-v2/FIX-LOG.md), and draft LayerFS issues are in
[issues/](../../../demo/quarry-v2/issues/).

| ID | Where | What happened | Status |
|---|---|---|---|
| #680 | LayerFS | An unmount right after a Commit ran that Commit's deferred cleanup, so unmount time grew with Commit size, up to 16 s. Filed as #679 and fixed during the run. | Fixed |
| F19 | LayerFS build | Docker Workspace I/O was about 9× slow because the pinned Linux bundle was a debug build. | Fixed |
| F08 | dsh-layerfs host | The sandbox policy made `~/.layerfs/sandbox/` read-only in sessions. | Fixed |
| F09 | dsh-layerfs host | An open project session made about 50 CLI calls a minute (fixed by F15). | Fixed |
| F10 | dsh-layerfs host | Granting the LayerFS home lock as a file broke every bash call. | Fixed |
| F13 | dsh-layerfs wrapper | Streamed commands that exited non-zero were logged as Unknown, and exit code 2 wasn't logged. | Fixed |
| F14 | dsh-layerfs UI | The main agent's Sandbox tab said nothing had run. | Fixed |
| F15 | dsh-layerfs host | The 3080 event loop was blocked by call-log reparsing and uncached polling. Host CPU fell from ~80 % to under 15 %. | Fixed |
| F16 | dsh-layerfs UI | The Trajectory tab froze the page for 1.7–2.6 s on each redraw. | Fixed |
| F17 | Build scripts | Every cargo build was a full rebuild because `RUSTFLAGS` held the mount path. | Fixed |
| F18 | dsh-layerfs host | A finished subagent's Trajectory said its session log wasn't loaded. | Fixed |
| F21 | dsh-layerfs host | A readiness timeout under load ended a run whose Workspace was still responsive. | Fixed |
| F22 | dsh-layerfs UI and host | Every open page walked the session archive every 15 s, causing 10–43 s stalls. | Fixed |
| F23 | dsh-layerfs host | Reconnecting to a still-mounted Workspace dropped it, which stalled the run for 27 min. | Fixed |
| F24 | Run | 9 OOM kills in the 8 GiB Docker VM: 7 from A13's bulk load and 2 from a recursive query that never ended. Test runs are now memory-capped. | Worked around |
| F20 | Run | A settings save in the app reloaded the plugin and ended the running turn. All work was recovered from Branches. | Worked around |
| F03 | LayerFS | Concurrent writes to the Docker Store were sometimes refused with `Failed Os NotFound`. Agents retry. | Worked around |
| F01, F02 | Environment | The Docker Sandbox ignored the image's environment, and there was no `sqlite3`. Fixed with an env script and an in-workspace build. | Worked around |
| F07 | Agent | The main agent drafted in the local folder. It was steered back, and the skill was updated. | Worked around |
| F25 | LayerFS | A stopped turn's command kept running in the Sandbox while `workspace status` said Idle (draft issue 06). | Open |
| F11 | LayerFS | `file cp` of a warm `target/` takes about a minute. | Open |
| F04, F06 | dsh-layerfs UI | The New Project dialog jumps to "Store exists" mid-create, and the session title shows the old folder. | Open |
| F12 | dsh-layerfs host | Some host polls are tagged with a worker's session in the call log. | Open |

## Files here

| File | What it is |
|---|---|
| [report.html](report.html) | The styled report, in English and Chinese. Open it in a browser. |
| [strata-BUILD-REPORT.md](strata-BUILD-REPORT.md) | Strata's own `/docs/BUILD-REPORT.md`, read from main Layer `3216799e`. It was written by the agents and is kept as they left it. |
| [data/store-stats.json](data/store-stats.json) | `layerfs store stats qv2-store` after the run |
| [data/store-status.json](data/store-status.json) | `layerfs store status qv2-store` after the run |
| [data/project-stats.json](data/project-stats.json) | `layerfs project stats qv2-store/qv2-strata` on main. The file count is a lower bound: the call reports its page as incomplete. |
| [data/commits.csv](data/commits.csv) | Every distinct Commit record with its storage counters |
| [data/fetch-commits.py](data/fetch-commits.py), [data/summarize.py](data/summarize.py) | Fetch the records again, and rebuild the Commit-kind table (`python3 data/summarize.py`) |

The operator's account of the run, with the timeline, call statistics and every incident,
is in [demo/quarry-v2/REPORT.md](../../../demo/quarry-v2/REPORT.md), next to the
monitor log and fix log.

**Read Strata's build report with care.** Some of its sections weren't updated at the end:

- §3 still shows the R4 checkpoint, not the final check.
- It gives the final code Layer both as `3277f713` and as `3298bd9e`; `3298bd9e` is correct.
- There's no §8.
- It doesn't mention that the A13 indexes were added.

The final numbers on this page come from the operator's terminal-pass check.
