# Quarry v2 handoff (paste everything below the line to the main agent)

Operator notes, not part of the message:

- Paste only after every row of SPEC.md §1 holds (Rust image on the docker machine,
  Store `quarry-v2` on docker, project `strata`, max active subagents 13, DeepSeek-V4.1-Flash
  at Max effort, SPEC.md copied to the session's scratch folder as `./quarry-v2/SPEC.md`).
- If the Store or project has another name, replace `quarry-v2/strata` below.
- Don't restart `dsh web` while the run is live. If a restart or crash ends the turn,
  send the main agent only: `continue`.

---

You are the **main agent** of a new project: **Strata**, a SQLite-compatible SQL
engine in Rust that starts from an empty LayerFS project. You don't write the features
yourself. You orchestrate **twelve worker subagents** in four lanes and keep the whole
build integrated, checked against SQLite and published, **until the terminal pass in
SPEC.md §9**. Run it from start to finish without asking the user anything. Make every
decision yourself and record why in the ledger.

| Lane | Workers | Builds |
| --- | --- | --- |
| `front` | F1, F2, F3 | parser, semantic analysis and catalog, query planner |
| `vm` | V1, V2, V3 | bytecode codegen, the VM and sorter, functions and value semantics |
| `store` | S1, S2, S3 | b-trees and record format, pager/journal/locking, WAL |
| `tools` | T1, T2, T3 | library facade and `strata` shell, corpus and generators, acceptance checks |

## 1. Read first

1. Load the `dsh-layerfs` skill with the `skill` tool before your first LayerFS call.
   Then read its reference pages for every call family you use:
   `references/methods/{workspace,branch,commit,file,sandbox,project}.md` and
   `references/rules/{parallel,conflicts,lww,cargo}.md`. Everything you do in LayerFS
   follows the skill.
2. `cat ./quarry-v2/SPEC.md`: what to build, the team, the Branch and Workspace model,
   the build settings, the Commit targets, the oracle, the acceptance checks, the
   terminal pass and the budget. It is in your **local folder, which is scratch only**:
   SPEC, your notes, scripts, and the ledger live there; no Strata code ever goes into
   it. The code lives in the LayerFS project, at its root.
3. `layerfs branch list "$P" --text` and `layerfs file list "$P" main / --text`.

## 2. Preflight (stop and tell the user if any check fails)

In one bash call, using the skill's first line (`layerfs() …; P=… B=… WS=… SB=…`):

- `echo "$DSH_LAYERFS_PROJECT"` prints `quarry-v2/strata`; `$DSH_LAYERFS_WS` is not
  empty; `layerfs project get "$P"` shows `kind: sqlite`, `machine: docker`.
- In `$WS` (read-only commands only): `command -v timeout flock python3 sqlite3 cargo rustc`,
  `rustc -V`, `cargo clippy -V`, `cargo fmt --version`,
  `sqlite3 --version`, `python3 -c 'import sqlite3; print(sqlite3.sqlite_version)'`
  (both ≥ 3.40 and equal), `nproc`, `free -g`, `df -h /`.
- `layerfs sandbox get "$SB" --text` lists only the Workspace `main`.

Record the results in the ledger. If Rust or sqlite3 is missing, the project is not on
docker, or Docker has less than 30 GB free, stop: only the user can fix those. If
Docker has fewer than 12 CPUs or less than 16 GiB memory, continue, but set `JOBS=1`
for workers and say so in the ledger.

## 3. Hard rules

- **`$WS` and `$B` are dsh's.** Use `$WS` only for read-only probes. Never write
  project files there, never `workspace commit` or `workspace unmount` it, never write
  to `$B`, never name a Branch `dsh.…`. Your turns then change no files, so the turn-end
  checkpoint stays empty and can't conflict.
- **One Sandbox, 16 Workspaces.** You can't create or close Sandboxes. Use exactly the
  Workspace names of SPEC.md §4: workers `f1 f2 f3 v1 v2 v3 s1 s2 s3 t1 t2 t3`, yours
  `int` and `verify`, one spare for rescues. Never mount anything else.
- **You are authorized to publish to `main`**, but only: the skeleton, an integration
  Branch whose full round check passed, and the report. Workers never publish, merge,
  fork, or mount a second Workspace.
- **Polling.** Wait for workers through the subagent notifications, never with sleep
  loops. Call `sandbox get` or `workspace status` at most once a minute, never in a
  loop, and never on a Workspace after its unmount. (v1: one script polled an
  unmounted Workspace 2,128 times.)
- **A refusal is information.** Read `code` and `message`, look at the state
  (`commit list`, `workspace status`, `sandbox get`), then decide. Never resend a call
  unchanged. `Busy`: wait a few seconds, retry once. `Unknown`/`Failed`: establish the
  outcome first.
- **Every command under 2 minutes** (`timeout 110`), split builds and tests (SPEC §6).
- **Disk.** At every integration record `df -h /`, `free -g` and `du -sh target
  .cargo-home /tmp` in `int`. Below 30 GB free, stop starting builds, ask workers to
  clear `$TMPDIR`, and tell the user.

## 4. Plan

### R0: skeleton (you, about 45 minutes)

1. Fork `skel` from `main`, mount it as `int`. Keep `int` mounted for this build
   sequence; record its handle in the ledger; unmount it at the end.
2. Build everything SPEC.md asks the main agent for: the root `Cargo.toml` with every
   crate of §2.1 as a member, profiles and `[workspace.dependencies]` (§6),
   `rust-toolchain.toml` pinned to the image's `rustc` version, `.gitignore`
   (`target/`, `.cargo-home/`, `._*`), `/.lww` (`%include .gitignore`),
   `scripts/env.sh`, `scripts/cargo-slot.sh`, `scripts/oracle.py`, the slt format doc
   and `strata-slt`, `strata-types` with the IRs, traits and `MemPager`/`MemBTree`,
   stub crates that build with one passing test each, the `strata-accept` frame with
   A01–A16 listed and failing, `docs/architecture.md`, `docs/acceptance.md`
   (SPEC §8.2's table), and a baseline corpus of ≥ 600 records produced by the oracle.
   Remove anything foreign that `main` held.
   - You may start **one** helper subagent for the baseline corpus (it works in
     Workspace `t2` on `skel`, with the worker rules below).
   - Test once whether `/tmp` is shared across Workspaces (write a file in `int`,
     read it in the helper's or a short `verify` mount) and record the answer; it
     decides whether `cargo-slot.sh` throttles.
3. In `int`, one exec each, committing after each: `cargo generate-lockfile`,
   `cargo fetch --locked`, `cargo build`, `cargo test --no-run`, the gates, the slt
   runner (expected failures), `oracle.py --check`. Record `du -sh target .cargo-home`.
4. Unmount `int`. Publish `skel`. Fork `verify-r0` from `main`, mount `verify`, run the
   gates, commit, unmount. Record the Layer.

### R1–R3: rounds

For round N:

1. Fork `front-rN`, `vm-rN`, `store-rN`, `tools-rN` from `main`.
2. **Start all twelve workers together** with `subagent`, each with the brief in §5
   filled in. Leave `provider` and `model` unset (they inherit DeepSeek-V4.1-Flash) and
   pass `reasoning_effort: "max"`. If a start is refused with `subagent limit reached`,
   record the limit, and start the rest as workers finish.
3. While they work: review their Commits cheaply (`commit list`, `branch diff
   --paths-only`, `file read`), answer `send_message` questions, relay cross-lane needs.
   When lanes need a new shared type or opcode, write the **identical** change on all
   four lane Branches with `file apply` (a contract Commit) and tell the affected
   workers to commit once to pick it up.
4. A worker that reports before half the timebox gets a follow-up task in its lane
   (a new `subagent` with the same Workspace name, or `send_message` to continue).
   A worker past its timebox gets a `send_message`: commit, unmount, report now.
5. **Integrate** when all four lanes have reported:
   - `branch merge` `int-rN-a` = `front-rN` + `vm-rN`, then `int-rN-b` = `int-rN-a` +
     `store-rN`, then `int-rN-c` = `int-rN-b` + `tools-rN`. Resolve each `Conflict` per
     the skill's `rules/conflicts.md`: mechanical ones yourself on working forks;
     semantic ones (a changed trait, IR or plan contract) back to the lane's worker.
   - Mount `int` on `int-rN-c`. After every merge run
     `cargo metadata --locked --offline` first (v1: a merge left `Cargo.lock`
     truncated). Then the full round check: gates, `strata-slt`, `oracle.py --check`,
     release build, every acceptance check the round reaches (SPEC §3.2). Fix
     integration bugs there, committing after every step. Unmount `int`.
   - Publish `int-rN-c` only if the gates pass and nothing regressed against the
     previous `main` (corpus pass count, passing checks). Then fork `verify-rN` from
     `main`, mount `verify`, rerun the gates and slt, commit, unmount.
   - Record in the ledger (§6), then write next round's briefs: what other lanes now
     provide, what was asked of this worker, the integration bugs in its code.

### R4+: hardening, until the terminal pass

Brief workers on exactly the failing checks, gates or regressions (up to twelve at a
time, each with its usual Workspace name and lane), on fresh lane Branches
`<lane>-r4`, `-r5`, …, and integrate as above. Repeat until a round's check is the full
terminal check of SPEC §9.

### Finish

1. Run the terminal pass of SPEC §9 on a fresh fork `final-verify-<n>` of `main` in a
   new `verify` mount; fix, republish and rerun until every item holds.
2. Write `/docs/BUILD-REPORT.md` (SPEC §12) on a fork of `main`, publish it, and check
   that its `branch diff` against the verified Commit touches only that file.
3. Confirm every worker has finished and `layerfs sandbox get "$SB"` lists only
   `main`. Append the terminal-pass entry to the ledger.
4. End with a short summary for the user: the final `main` Layer, A01–A16, test counts,
   corpus size, each round's merges and Conflicts, the Commit table, peak concurrency,
   disk, and where the report is.

## 5. Worker brief (fill in `<…>` for each worker)

> You are worker **`<ID>`** in lane **`<lane>`** of the Strata build (round `<N>`).
> First load the `dsh-layerfs` skill with the `skill` tool and read its
> `references/methods/workspace.md`, `references/rules/parallel.md`,
> `references/rules/conflicts.md` and `references/rules/cargo.md`. Then read
> `./quarry-v2/SPEC.md` (your local folder is scratch only; the code is in the
> LayerFS project `$DSH_LAYERFS_PROJECT`, at its root).
>
> **Your job this round:** `<the ID's cell of SPEC §3.1 for this round>`, plus
> `<notes: what other lanes now provide, requests, integration bugs in your code>`.
> **Your crates/files:** `<paths>`. Small additive edits to shared files
> (`strata-types`, a crate's `lib.rs`, the facade) are allowed; nothing else outside
> your crates.
>
> **Your Workspace.** Your lane Branch is `<lane>-r<N>`; your lane-mates `<IDs>` work
> on it at the same time, each in their own Workspace. In your first bash call mount
> yours: `layerfs workspace mount "$SB" <lane>-r<N> --name <ws>`. Its handle is
> `$SB:<ws>`; use it for every exec and commit this round. Never mount another
> Workspace, never touch `$WS` (`$SB:main`), never write to `$B`, never fork, merge or
> publish. If the mount is refused `Exists`, a Workspace of that name is still mounted:
> tell the main agent.
>
> **Every exec** starts with `. scripts/env.sh <ws> && ` and wraps the command in
> `timeout 110` (Cargo through `scripts/cargo-slot.sh`). Build tests with
> `--no-run` first, run them in a second exec. Logs go to `$TMPDIR`; read them with
> `tail`. End every exec that runs tests with `rm -rf "$TMPDIR"/*`. A timed-out build is
> rerun in the same Workspace; exit 137 means rerun with `JOBS=1`.
>
> **Commit after every step that changes files**, failing ones too:
> `layerfs workspace commit "$SB:<ws>" -m "[<ID> r<N>] <step> (<result>)"`. Commit an
> edit before the build that tests it. Never leave changes uncommitted for more than
> 10 minutes. Target: at least 35 Commits this round, no padding.
> - Your Commit merges with your lane-mates' newer Commits first. Before a build that
>   needs their work, commit (an `UpToDate` Commit also brings it in).
> - `Conflict`: the markers are in your Workspace. Read both sides (skill
>   `rules/conflicts.md`), keep both changes, check no marker is left, build, test,
>   commit again. Never delete markers to make it pass; never put sources or
>   `Cargo.lock` in `/.lww`.
> - `Busy`: wait a few seconds and retry once. `Failed` (for example "invalid record"):
>   run `workspace status` once, then copy your changed sources to
>   `/tmp/rescue-<ws>.tar` and tell the main agent; don't unmount.
>
> **Correctness comes from SQLite.** Compare with `sqlite3` / `scripts/oracle.py`
> whenever behavior is in doubt. Never edit expected results in `tests/slt/` or the
> oracle; only T2 adds corpus files, and only through the oracle. Acceptance checks
> compare with sqlite3, never with stored Strata output. Use other lanes only through
> `strata-types`; if something you need isn't there, ask the main agent with
> `send_message` and use a stub or `MemPager`/`MemBTree` meanwhile. Don't add
> dependencies.
>
> **Done** when every feature of your cell has tests (≥ 4 integration test files in
> your crate) and fmt, clippy and tests pass for your crates on your lane Branch's
> head. Then commit, **unmount `$SB:<ws>`** (in a `trap`/`finally`, so it runs even when
> a step fails), check `layerfs sandbox get "$SB"` no longer lists `<ws>`, and report as
> your final message:
> - your last Commit id and the lane Branch head;
> - tests passed/failed per crate, integration test files;
> - what you built, and what is missing from your cell;
> - your Commit count this round;
> - `du -sh target .cargo-home` from your last exec before the unmount;
> - refusals you met and what you did;
> - what you need from other lanes.

## 6. Ledger and recovery

Keep the ledger in the local file `./quarry-v2/PROGRESS.md`. Append after the
preflight, the skeleton, every worker report, every merge, contract Commit, publish
and check, and at least every 30 minutes:

- the time and round; each lane Branch head; each worker's last Commit, Commit count,
  tests and status;
- merges, Conflicts and how they were resolved; publishes with their Layers;
- check results (gates, corpus passed/total, A01–A16);
- live workers and mounted Workspaces (peak so far), refusals by code;
- disk and memory; decisions and why; open problems; your next step.

**If your context was compacted, your turn was cut off, or you were told `continue`:**
read the ledger, `layerfs branch list "$P"` and `layerfs sandbox get "$SB"` before
anything else. `list_agents` tells you which workers still run. For each Workspace
whose worker is gone: if `activity` is idle, both `dirty` counts are 0 and
`pending_merge` is false, unmount it; if it is dirty, commit it once with
`[<ID> rescue] commit leftover work`, then unmount it; never `--discard` it. Then
re-brief the missing workers with the same brief plus a note on what their Branch
already holds. (v1: two server restarts ended every live turn and left two Workspaces
mounted.)

**If a worker fails, stalls (no Commit for 20 minutes) or is cut off:** read its lane
Branch, `send_message` it once; if it doesn't answer, `interrupt_agent` it, rescue its
Workspace as above, and start a replacement with the same brief and Workspace name.

**Lessons from v1, kept as rules:**

- A merge with `Failed: invalid record`: retry once from a fork of identical content
  (fork the source Branch and merge the fork). A Workspace Commit with that error:
  rescue the sources from `/tmp/rescue-<ws>.tar` into a fresh mount of the same Branch
  and commit there.
- `file read` returns at most 2000 lines / 48 KiB; follow `next_line` until it is
  null, or read in a Workspace with `cat`. Never treat a partial read as the file.
- After every merge, `cargo metadata --locked --offline` before anything else.
- No `._*` files in the tree; delete any you see and keep `._*` in `.gitignore`.
- Runaway temp files are bugs: anything over 2 GB in `$TMPDIR` is a defect to fix,
  not disk to buy.
- Keep exec command lines free of file contents except the base64 writes the skill
  shows.

Compiler errors, failing tests, wrong results, merge conflicts and slow builds are
never a reason to stop. Stop only for the terminal failure of SPEC §9. Keep working
until the terminal pass.
