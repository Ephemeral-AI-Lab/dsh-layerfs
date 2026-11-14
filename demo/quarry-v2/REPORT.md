# Quarry v2: Strata on LayerFS v2

Eight DeepSeek Harness (DSH) agents and one main agent built Strata, a SQLite-compatible
database in Rust, in one LayerFS project (`qv2-store/qv2-strata`). They worked through
dsh-layerfs on the user's DSH at 127.0.0.1:3080. This report is the operator's account of
the run: the result, the numbers, every incident, and what the model could not do alone.
The build itself is described in the project's own `/docs/BUILD-REPORT.md` on main.

| Run | Time | History | Store |
|---|---|---|---|
| Quarry v2, Strata (SQLite-compatible database in Rust) | 13 h 22 min, 1 main agent + 8 workers (17 subagent sessions) | 4,330 landed Commits, 93 Branches, 39 publishes to main | 4.93 GB Store file; final tree 8,007 files, ≥ 11.4 GB logical |

## Result

**Terminal pass (SPEC §9), checked by the operator on 2026-11-13 at 21:05Z.**

- The final main Layer is `3216799e…`, a report-only publish. Its diff against code
  Layer `3298bd9e…` touches only `/docs/BUILD-REPORT.md`.
- **Fresh forks:**
  - `final-verify-2` (code Layer) and `final-verify-3` (published tree).
  - fmt and clippy (`-D warnings`) exit 0.
  - `cargo test --workspace --no-fail-fast`: exit 0, **1,567 passed, 0 failed**, no FAILED binary.
  - Every crate has 4 to 30 integration test files.
  - `oracle.py --check` is up to date (28 files, 3,166 records, 475 error records).
  - Release build, then `strata-slt tests/slt` **3,166 / 3,166**.
- **`strata-accept` A01–A16: all sixteen PASS.**
  - A13: 49.1 s total, every query under 10 s, run under a 3 GiB address-space cap.
  - A15: VACUUM leaves 5.3 % of the file (7,626,752 → 401,408 B; sqlite3 385,024 B).
  - No `._*` files.
  - All subagents idle and all Workspaces unmounted at the end.
- **Operator checks beyond the agent's own evidence:**
  - **Corpus integrity:** compared with the first Layer that had a corpus (32f9d197,
    14:30Z), no existing record was changed or removed; 128 were added. `/scripts` is
    unchanged since then.
  - **Oracle independence:** `scripts/oracle.py` computes every expected value with
    Python's SQLite 3.40.1 and cross-checks with the pinned sqlite3 CLI. It never runs
    Strata.
  - **Harness changes reviewed:**
    - A11: Strata now gets the same `;`-terminated step text sqlite3 always got.
    - A15: rewritten to the SPEC criterion, described below.
    - Neither weakens a comparison.
  - **New tests sampled** (codegen error paths, btree free/reuse): real behavioural
    assertions, not padding.

**The operator rejected the terminal claim twice before accepting it:**

1. **20:27Z.** All 16 checks passed, but:
   - A15 had never tested SPEC's "VACUUM shrinks the file ≥ 70 %". From the first Layer
     it accepted Strata's size up to 1.3 × sqlite3's *un-vacuumed* file, and it measured
     a 66.7 % shrink.
   - The test total was 1,132, under the 1,500 SPEC requires, and nobody had counted it.
2. **20:54Z.** A15 was fixed and 435 tests were added, but the evidence only summed
   "N passed" lines. It never showed cargo's exit status or a failed count.
3. **21:00Z.** One `--no-fail-fast` run showed exit 0 / 1,567 / 0 failed. Accepted.

**Disclosures:** design choices that are legitimate but should be known.

- **A13** passes partly because the root added TPC-H secondary indexes to `strata-gen`'s
  schema. Both engines load the identical schema, and SPEC doesn't fix the index set.
  V2's row-decode cache did the rest.
- **TEMP tables:**
  - A shortcut first: in R11, TEMP tables were made ordinary tables ("the corpus has
    only one TEMP statement").
  - At the end, the facade holds TEMP schema rows in memory: corpus-correct, but no
    separate temp database file. BUILD-REPORT lists this under known limitations.
- **A14's check** was changed during the run to sample sorter temp files while the
  queries run; it used to count them after cleanup. The SPEC wording is "temp files were
  used". Plausible, but not reviewed by the operator.
- **Memory caps on test runs:** every `strata-slt` / `strata-accept` run runs under
  `prlimit`/`ulimit -v` (2–3 GiB), and A13 also runs inside that cap. This was added
  after nine OOM kills (F24).

## Timeline (UTC, 2026-11-13)

| Time | Event |
|---|---|
| 07:35 | Run start (root session `session-939f81ff…`) |
| 08:00 | Skeleton Layer on main |
| 08:30–10:30 | R1: 8 workers in 4 lanes; four 3080 restarts for host fixes (F08, F10, F13/F15, F18) |
| 10:35 | Pacing steer: workers had been idle ~50 min while the root integrated alone |
| 11:0x | Runtime switch (F19: the pinned Linux bundle was a debug build) |
| 13:10 | F20: a settings save in the app reloaded the plugin and disposed the run |
| 13:22 | Runtime switch 2 (LayerFS PR #680 unmount fix, c5e58735bb); V9 truncated-read slip repaired |
| 14:18 | Nudge to publish: main was still the skeleton after 6.5 h |
| 14:31 | First publish (int-r3.3) |
| 15:55–16:27 | F21/F22/F23: polling spike, readiness timeout, execution lost; fixed and 3080 restarted |
| 16:50 | Root ended its turn at 8/16, calling the run complete; prompted to continue per §9 ("Keep hardening", user) |
| 17:57 | Restart R5 (F22 host half) in a controlled pause |
| 18:11 / 18:25 / 19:17 | 13/16, 14/16, 15/16 published |
| 19:23 / 19:31 | OOM kills #8 and #9: a runaway recursive CTE in F2's lane (F24, F25) |
| 20:19 | Corpus 3,166 / 3,166 on vm-r18 |
| 20:27 | First terminal claim; rejected (A15 criterion, test total) |
| 20:54 | Second claim; one item (test exit status) unproven |
| 20:57 | Final report-only Layer `3216799e`; accepted 21:05 |

## Calls (whole run, from the LayerFS call log)

59,331 LayerFS calls, 14,703 of them made by the host (UI polling, untagged). 5,312 were
writes and 4,330 landed a Commit. 726 were refused (1.2 %). Refusals because the Store
was busy: **35 of 5,312 writes (0.66 %)**. Before 11:01Z, durations were measured by the
stand-in wrapper as wall time; after that, they are the native in-process times.

| Family | Calls | p50 | p90 | Max | Notable refusals |
|---|---:|---:|---:|---:|---|
| workspace.status | 12,370 | 4 ms | 15 ms | 17.2 s | NotMounted ×243 |
| file.read | 10,025 | 6 ms | 32 ms | 23.4 s | IsDirectory ×24, NoSuchPath ×14 |
| branch.list | 6,034 | 13 ms | 42 ms | 42.1 s | Unavailable ×8 |
| project.get | 4,737 | 7 ms | 27 ms | 27.1 s | |
| file.list | 3,897 | 15 ms | 44 ms | 5.0 s | |
| machine.get | 3,130 | 113 ms | 201 ms | 10.0 s | |
| store.status | 3,011 | 9 ms | 24 ms | 1.1 s | |
| workspace.unmount | 1,915 | 18 ms | 236 ms | 26.6 s | NotMounted ×67, Busy ×23, Dirty ×13 |
| workspace.exec | 1,899 | 10.2 s | 49.8 s | 9.8 min | Unknown ×9 (F13) |
| file.edit | 1,876 | 16 ms | 98 ms | 3.7 s | NoMatch ×65, AmbiguousMatch ×16 |
| workspace.mount | 1,850 | 10 ms | 39 ms | 1.4 s | Exists ×34 |
| workspace.commit | 1,831 | 283 ms | 4.2 s | 1.5 min | Busy ×3 (1,194 Committed, 623 UpToDate) |
| branch.commits | 1,529 | 6 ms | 36 ms | 3.7 s | |
| file.grep | 1,286 | 11 ms | 68 ms | 11.1 s | |
| file.write | 634 | 83 ms | 158 ms | 583 ms | |
| file.apply | 557 | 28 ms | 190 ms | 22.8 s | NoMatch ×18 |
| branch.fork | 134 | 6 ms | 17 ms | 902 ms | NameTaken ×4 |
| branch.merge | 113 | 287 ms | 1.0 s | 10.3 s | Conflict ×25 (resolved) |
| branch.publish | 41 | 7 ms | 11 ms | 20 ms | NoCommit ×1 |
| file.cp | 16 | 1.0 min | 1.1 min | 3.4 min | Exists ×8 (F11) |

**Slow calls:**
- Non-exec calls over 10 s came in three episodes: the F15 host stall, the F21/F22
  polling spike, and the OOM stall of 19:20–19:28. In each, `branch list` took up to
  42 s and machine reads hit the 10 s cap.
- Commits took 10–90 s while the runtime was the debug bundle (F19) and before the
  unmount fix.
- After 18:03 (R5) the host made about 100–250 calls per 10 min (1,223 before F22).

## Incidents and fixes

25 numbered findings. F05 is a configuration note, not a bug, and is left out of the
count: **24 bugs or incidents**. Of these:
- 14 are dsh-layerfs host, client or wrapper bugs: 11 fixed during the run; F04, F06 and
  F12 still open.
- 6 are LayerFS or environment issues (F01, F02, F03, F11, F19, F25; issue drafts in
  `issues/`).
- 2 are harness or agent-behaviour issues (F07, F17).
- 2 are run incidents (F20, F24).

| ID | Area | What happened | Status |
|---|---|---|---|
| F01 | Environment | docker Sandbox ignored the image `ENV`; no Rust on PATH | Worked around (`scripts/env.sh`, skill rules); issue 02 |
| F02 | Environment | No `sqlite3` CLI in the Sandbox; `/tmp` a 3.9 GB shared tmpfs | Worked around (build 3.40.1 into `.tools/bin`, data under `$HOME/tmp`) |
| F03 | LayerFS | Concurrent writes to the docker Store refused `Failed Os NotFound` | Retry rule in the skill; issue 01 |
| F04 | dsh-layerfs UI | New-project dialog flips to "Store exists" during creation | Open (cosmetic) |
| F06 | dsh-layerfs UI | Conversation header shows the old folder after a scratch change | Open (cosmetic) |
| F07 | Agent | Root drafted the skeleton in the local folder and planned host builds | Steered; skill intro changed |
| F08 | dsh-layerfs host | Sandbox policy made `~/.layerfs/sandbox/` read-only for sessions | Fixed (`sandbox-policy.ts`), restart |
| F09 | dsh-layerfs host | An open project conversation polled ~50 CLI calls/min | Resolved by F15's kept reads |
| F10 | dsh-layerfs host | Granting the home lock file broke every bash call | Reverted; directories only; restart |
| F11 | LayerFS | `file cp` of a warm `target/` takes ~1 min per copy | Open; candidate issue |
| F12 | dsh-layerfs host | Host polls tagged with a worker's session (attribution leak) | Open (after-run host change) |
| F13 | dsh-layerfs wrapper | Non-zero streamed exec logged `Unknown` (exit 2 not logged) | Fixed in the wrapper |
| F14 | dsh-layerfs client | Root's Sandbox tab showed "Nothing has run here yet" | Fixed |
| F15 | dsh-layerfs host | 3080 event loop blocked (call-log re-parse, uncached polls) | Fixed: CPU ~80 % → <15 %, `/api/machines` 6.8 s → 33 ms |
| F16 | dsh-layerfs client | Trajectory tab froze the page 1.7–2.6 s per redraw | Fixed (`thinLane`) |
| F17 | Harness | Every cargo build was a full rebuild (mount path in RUSTFLAGS) | Fixed in env.sh and the skill; steered |
| F18 | dsh-layerfs host | Finished subagent's Trajectory "log not loaded" | Fixed (persistence-row fallback) |
| F19 | LayerFS build | Docker Workspace I/O ~9× slow: the pinned Linux bundle was a debug build | Resolved by the runtime switch; issue 04 |
| F20 | Run incident | A settings save rewrote `cordis.patch.yml` and disposed the live run | Recovered from Branches; no work lost |
| F21 | dsh-layerfs host | A readiness timeout under load interrupted the bound execution | Fixed (keep execution while the Workspace answers) |
| F22 | dsh-layerfs client + host | 15 s archive Store walks per open project caused 10–43 s stalls | Fixed in both halves; host calls −80 % |
| F23 | dsh-layerfs host | Re-activation over a still-mounted Workspace left `ws` unset | Fixed; restart |
| F24 | Run incident | 9 OOM kills in the 8 GiB docker guest (7 × A13 bulk load, 2 × runaway recursive CTE) | Mitigated with memory caps; root causes fixed (decode cache, LIMIT in recursive Materialize) |
| F25 | LayerFS | Stopping a DSH turn leaves its Sandbox exec running while status says Idle | Open; issue 06 |

Not numbered:
- **Issue 03:** a Commit after an unresolved Conflict fails with `invalid record`.
- **Issue 05:** unmount right after a large Commit took seconds; fixed upstream by
  LayerFS PR #680 and adopted mid-run.
- **V9 (agent slip):** a worker rewrote `common.rs` from a 48 KiB-truncated `file read`.
  Traced and restored by diff; the skill's read-before-write rule was steered.
- **3 bare `layerfs` calls:** they hit an old host CLI and were refused; nothing reached
  the Store.

## What the model could not do on its own

The team built a 16/16 SQLite-compatible engine with 1,567 tests and a 100 % oracle
corpus. Without operator steering it would not have got there, for these reasons:

1. **Publishing.** For 6.5 hours the root folded every round forward into its integration
   chain and published nothing. Main was still the skeleton until a direct nudge at 14:18.
   It also published two Layers that regressed passing checks (A09, A10) until the §4
   no-regression gate was steered in.
2. **Knowing when it was done.**
   - At 16:50 it ended its turn at 8/16 and called the run complete.
   - Its two later terminal claims each overlooked a §9 requirement it had never measured:
     - A15's criterion was weaker than SPEC from day one, and the shrink was 66.7 %.
     - The test total was 1,132.
     - A test run's exit status wasn't checked.
   - The evidence it wrote down matched its own checks, not the SPEC text.
3. **Resource discipline.**
   - Nine OOM kills. A13 was run repeatedly at 6–7 GiB in an 8 GiB VM, and a
     non-terminating recursive CTE was run twice, the second time after it had been
     told about it.
   - Caps came from the operator.
   - Stopping the turn didn't stop the process (F25), so only the caps protect the VM.
4. **Keeping the team busy.** Twice the eight workers sat idle for 25–50 minutes while the
   root integrated alone (10:35 and 12:12 pacing steers).
5. **Tool hygiene.** A truncated read was written back as a whole file (V9). Three jobs
   called a bare `layerfs`. Drafting in the local folder (F07) and full rebuilds on every
   mount (F17) were fixed only by steering.

What it did well: clean lane ownership with contract Commits; 113 merges with 25
Conflicts, all resolved; diagnosing harness asymmetries rather than bending the engine
(A06, A11); keeping the corpus honest (128 records added, none edited); and fixing the
real root causes once a problem was named.

## Files

- `demo/quarry-v2/monitor/MONITOR-LOG.md`: 60 operator checks, 10–15 min apart.
- `demo/quarry-v2/FIX-LOG.md`: every finding, steer, restart and decision.
- `demo/quarry-v2/issues/01–06`: LayerFS issue drafts.
- The project's `/docs/BUILD-REPORT.md` on main: the agents' own build report.
- The agents' ledger: `qv2-scratch/quarry-v2/PROGRESS.md`.
