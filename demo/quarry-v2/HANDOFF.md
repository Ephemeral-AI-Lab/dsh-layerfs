# Quarry v2 handoff (paste everything below the line to the main agent)

Operator notes, not part of the message:

- Paste only after every row of SPEC.md §1 holds: Store `qv2-store` on docker, project
  `qv2-strata`, DeepSeek-V4.1-Flash at Max effort, preset LayerFS, SPEC.md copied to the
  session's scratch folder as `./quarry-v2/SPEC.md`.
- Don't restart `dsh web` while the run is live. If a restart or crash ends the turn,
  send the main agent only: `continue`.

---

You are the **main agent** of a new project: **Strata**, a SQLite-compatible SQL
engine in Rust that starts from an empty LayerFS project (`qv2-store/qv2-strata`). You
don't write the features yourself. You orchestrate **eight worker subagents** in four
lanes, two per lane, and keep the whole build integrated, checked against SQLite and
published, **until the terminal pass in SPEC.md §9**. Run it from start to finish
without asking the user anything. Make every decision yourself and record why in the
ledger.

| Lane | Workers (Workspace) | Builds |
| --- | --- | --- |
| `front` | F1 (`w-f1`), F2 (`w-f2`) | parser; semantic analysis, catalog and query planner |
| `vm` | V1 (`w-v1`), V2 (`w-v2`) | bytecode codegen; the VM, sorter and all functions |
| `store` | S1 (`w-s1`), S2 (`w-s2`) | b-trees and record format; pager, journal, locking and WAL |
| `tools` | T1 (`w-t1`), T2 (`w-t2`) | library facade, `strata` shell and generators; corpus and acceptance checks |

## 1. Read first

1. Load the `dsh-layerfs` skill with the `skill` tool before your first LayerFS call.
   Then read its reference pages for every call family you use:
   `references/methods/{workspace,branch,commit,file,sandbox,project}.md` and
   `references/rules/{team,parallel,conflicts,lww,cargo}.md`. `team.md` is the playbook
   for this run. Everything you do in LayerFS follows the skill.
2. `cat ./quarry-v2/SPEC.md` (all of it, in windows if needed): what to build, the
   team, the Branch and Workspace model, the build settings, the Commit targets, the
   oracle, the acceptance checks, the terminal pass and the budget. It is in your
   **local folder, which is scratch only**: SPEC, your notes, the ledger. No Strata code
   ever goes there; the code lives in the LayerFS project, at its root.
3. `layerfs branch list "$P" --text` and `layerfs file list "$P" main / --text`.

## 2. Preflight (stop and tell the user if any check fails)

Using the skill's first line (`layerfs() …; P=… B=… SB=…`):

- `echo "$DSH_LAYERFS_PROJECT"` prints `qv2-store/qv2-strata`; `$DSH_LAYERFS_WS` is not
  empty; `layerfs project get "$P"` shows `kind: sqlite`, `machine: docker`.
- `layerfs sandbox get "$SB" --text` lists only dsh's Workspace `main`.
- Fork `preflight` from `main`, and in one bash call mount it as `int`, run, commit,
  unmount: `export RUSTUP_HOME=/usr/local/rustup PATH=/usr/local/cargo/bin:$PATH;
  command -v timeout flock python3 gcc curl cargo rustc; rustc -V; cargo clippy -V;
  cargo fmt --version; python3 -c 'import sqlite3; print(sqlite3.sqlite_version)';
  nproc; free -g; df -h / /tmp; echo $HOME`.

Record the results in the ledger. If Rust is missing, the project is not on docker, or
the disk has less than 30 GB free, stop: only the user can fix those. The machine has
8 CPUs and 8 GiB: SPEC §6's jobs and slots are sized for it. There is no `sqlite3`
CLI in the Sandbox: you build it into the project in R0 (SPEC §6).

## 3. Hard rules

- **`$WS` and `$B` are dsh's.** Never exec in, commit or unmount `$WS`, never write to
  `$B`, never name a Branch `dsh.…`. Your turns then change no files on `$B`, so the
  turn-end checkpoint stays empty and can't conflict.
- **Files change through `file` calls** (`file edit`, `file write`, `file apply`) on
  the Branch you work on, straight onto the Branch: never draft project files in the
  local folder to upload later, and never build or test on the local machine. Bash only for commands (build, test, the oracle, git-like
  tools) and for batch changes or changes that need logic (a codemod, `cargo fmt`, a
  generator). The same rule goes into every worker brief.
- **One Workspace per bash call.** Mount it at the start of the call, run the execs,
  commit, and unmount it at the end (unmount in a `trap … EXIT`), leaving nothing
  mounted between calls. Commands use paths relative to the Workspace root, never the
  mount path that `mount` prints. Only an exec that must outlive one call (a build over
  540 s) keeps its Workspace, in a `run_in_background` bash call with an `--exec-id`
  (skill `team.md` "Waiting"), until you collect it.
- **Sandboxes: up to 4 on docker.** The session Sandbox `$SB` plus 3 you create in R1,
  one per lane: `layerfs sandbox create "$P" qv2-lane-<lane> docker` for front, vm and
  store (skill `references/methods/sandbox.md`); the tools lane and your `int`/`verify`
  stay in `$SB`. Check the toolchain in a first Workspace in each, record them in the
  ledger, put each worker's Sandbox in its brief, close the ones you created at the end,
  and never close `$SB`. If a create is refused, keep every lane in `$SB` and say so in
  the ledger. Each Sandbox holds 16 Workspaces (dsh's own counts in `$SB`). Names:
  workers `w-f1 w-f2 w-v1 w-v2 w-s1 w-s2 w-t1 w-t2`, yours `int` and `verify`, a rescue
  mount `spare`. Never mount anything else.
- **Installs and caches stay in the Workspace and are committed:** `.cargo-home/`,
  `target/<ws>/`, `.tools/` (the sqlite3 CLI), any tool cache. Never install into
  `HOME` or `/tmp`, never `cargo install` globally. The next mount reuses them.
- **The Sandbox environment:** every exec that uses Rust starts with
  `. scripts/env.sh <ws>` (before the skeleton has it:
  `export RUSTUP_HOME=/usr/local/rustup PATH=/usr/local/cargo/bin:$PATH`). `/tmp` is a
  3.9 GB memory-backed tmpfs shared by every Workspace: only logs and exit codes there,
  under `/tmp/<ws>/`; test data goes in `$TMPDIR` (`$HOME/tmp/<ws>`).
- **You are authorized to publish to `main`**, but only: the skeleton, an integration
  Branch whose full round check passed, and the report. Workers never publish, merge or
  fork.
- **Polling.** Wait for workers through the subagent notifications, never with sleep
  loops. Call `sandbox get` or `workspace status` at most once a minute, never in a
  loop, and never on a Workspace after its unmount.
- **A refusal is information.** Read `code` and `message`, look at the state
  (`commit list`, `workspace status`, `sandbox get`), then decide. Never resend a call
  unchanged. `Busy`: wait `sleep $((3 + RANDOM % 8))`, retry, at most 5 times.
  `Failed` with `Os { code: 2, kind: NotFound }` on a write (the docker Store, about 1
  in 70 when several writers land at once): check whether it landed (`file stat`,
  `commit list`), retry if not. Any other `Unknown`/`Failed`: establish the outcome first.
- **Time:** a bash call may run up to 600 s (set its `timeout` in ms); inner commands
  `timeout 540`, so the Commit and unmount still run. Split builds and tests (SPEC §6).
- **Disk.** At every integration record `df -h /`, `free -g` and
  `du -sh target/* .cargo-home` in `int`. Below 30 GB free, stop starting builds, ask
  workers to clear `$TMPDIR`, and tell the user.

## 4. Plan

### R0: skeleton (you, about 60 minutes)

1. Fork `skel` from `main`. Work on it with `file` calls (manifests, sources, docs,
   scripts) and, for commands, one `int` mount per bash call.
2. Build everything SPEC.md asks the main agent for: the root `Cargo.toml` with every
   crate of §2.1 as a member, profiles and `[workspace.dependencies]` (§6),
   `rust-toolchain.toml` pinned to the image's `rustc` version, `.gitignore`
   (`target/`, `.cargo-home/`, `.tools/`, `._*`), `/.lww` (`%include .gitignore`),
   `scripts/env.sh` (SPEC §6, exactly), `scripts/cargo-slot.sh` (3 slots),
   `scripts/sqlite3-build.sh`, `scripts/oracle.py`, the slt format doc and `strata-slt`,
   `strata-types` with the IRs, traits and `MemPager`/`MemBTree`, stub crates that build
   with one passing test each, the `strata-accept` frame with A01–A16 listed and
   failing, `docs/architecture.md`, `docs/acceptance.md` (SPEC §8.2's table), and a
   baseline corpus of ≥ 600 records produced by the oracle.
   - You may start **one** helper subagent for the baseline corpus. It writes corpus
     sources with `file` calls on `skel` and runs the oracle in its own Workspace
     `w-t2`, one per bash call, under the worker rules below.
3. Commands on `skel`, one bash call each (mount `int`, exec, commit, unmount):
   `scripts/sqlite3-build.sh`, `cargo generate-lockfile`, `cargo fetch --locked`,
   `cargo build`, `cargo test --no-run`, the gates, the slt runner (expected failures),
   `oracle.py --check`. Record `du -sh target/* .cargo-home .tools`.
4. Publish `skel`. Fork `verify-r0` from `main`, mount `verify`, run the gates, commit,
   unmount. Record the Layer.

### R1–R3: rounds

For round N:

1. Fork `front-rN`, `vm-rN`, `store-rN`, `tools-rN` from `main`. Warm each worker's
   build: on each lane Branch, `file cp "$P" <lane>-rN /target/int /target/w-<id>` for
   its two workers (a server-side copy, no data moves), so workers compile only their
   own crates.
2. **Start all eight workers together** with `subagent`, each with the brief in §5
   filled in. Leave `provider` and `model` unset (they inherit DeepSeek-V4.1-Flash) and
   pass `reasoning_effort: "max"`. DSH allows 8 live subagents: a replacement can start
   only after a worker ends. If a start is refused `ACTIVATION_LIMIT_REACHED`, record it
   and start that worker when another finishes.
3. While they work: review their Commits cheaply (`commit list`, `branch diff
   --paths-only`, `file read`), answer `send_message` questions, relay cross-lane needs.
   When lanes need a new shared type or opcode, write the **identical** change on all
   four lane Branches with `file apply` (a contract Commit) and tell the affected
   workers; they see it at their next mount.
4. A worker that reports before half the timebox gets a follow-up task in its lane
   (`send_message` to continue it, or a new `subagent` with the same Workspace name once
   it has ended). A worker past its timebox gets a `send_message`: finish the step,
   commit, report now.
5. **Integrate on a rolling basis**, a chain, one merge at a time (skill `team.md`
   "Integrating"): when a lane's two workers have both reported, merge it onto the
   chain: `int-rN.1` = `main` + the first finished lane, `int-rN.2` = `int-rN.1` + the
   next, and so on. After every merge, one bash call in `int` on the result:
   `. scripts/env.sh int && cargo metadata --locked --offline --format-version 1
   >/dev/null && cargo check --workspace --locked --offline` (v1: a merge left
   `Cargo.lock` truncated). Resolve each `Conflict` per `rules/conflicts.md`:
   mechanical ones yourself; semantic ones (a changed trait, IR or plan contract) back
   to the lane's workers.
   - When all four lanes are in: the full round check on the last `int-rN.<k>`, in
     several `int` bash calls: gates, `strata-slt`, `oracle.py --check`, release build,
     every acceptance check the round reaches (SPEC §3.2). Fix integration bugs there
     (`file` calls; commands in `int`), committing after every step.
   - Publish it with every build folder in it (`/target/int` and each `/target/w-<id>`).
     What is installed or built in the Store stays there: never `file rm` a `target/`,
     `.cargo-home/` or `.tools/` folder, so the next mount and the next round reuse it.
   - Publish it only if the gates pass and nothing regressed against the previous
     `main` (corpus pass count, passing checks). Then fork `verify-rN` from `main`,
     mount `verify`, rerun the gates and slt, commit, unmount.
   - Record in the ledger (§6), then write next round's briefs: what other lanes now
     provide, what was asked of this worker, the integration bugs in its code.

### R4+: hardening, until the terminal pass

Brief workers on exactly the failing checks, gates or regressions (up to eight at a
time, each with its usual Workspace name and lane), on fresh lane Branches
`<lane>-r4`, `-r5`, …, and integrate as above. Repeat until a round's check is the full
terminal check of SPEC §9.

### Finish

1. Run the terminal pass of SPEC §9 on a fresh fork `final-verify-<n>` of `main` in
   `verify` mounts; fix, republish and rerun until every item holds.
2. Write `/docs/BUILD-REPORT.md` (SPEC §12) on a fork of `main`, publish it, and check
   that its `branch diff` against the verified Commit touches only that file.
3. Confirm every worker has finished and `layerfs sandbox get "$SB"` lists only
   `main`. Append the terminal-pass entry to the ledger.
4. End with a short summary for the user: the final `main` Layer, A01–A16, test counts,
   corpus size, each round's merges and Conflicts, the Commit table, peak concurrency,
   disk, and where the report is.

## 5. Worker brief (fill in `<…>` for each worker)

> You are worker **`<ID>`** in lane **`<lane>`** of the Strata build (round `<N>`).
> Load the `dsh-layerfs` skill with the `skill` tool first, and read its
> `references/rules/team.md`, `references/methods/workspace.md`,
> `references/methods/file.md`, `references/rules/conflicts.md` and
> `references/rules/cargo.md`. Then read `./quarry-v2/SPEC.md` §2, §3, §5, §6, §8 (your
> local folder is scratch only; the code is in the LayerFS project
> `$DSH_LAYERFS_PROJECT`, at its root).
>
> **Your job this round:** `<the ID's cell of SPEC §3.1 for this round>`, plus
> `<notes: what other lanes now provide, requests, integration bugs in your code>`.
> **Your crates/files:** `<paths>`. Small additive edits to shared files
> (`strata-types`, a crate's `lib.rs`, the facade) are allowed; nothing else outside
> your crates.
>
> **Your Branch and Workspace.** Your lane Branch is `<lane>-r<N>`. Your lane-mate
> `<other ID>` works on the same Branch at the same time. Your Workspace name is
> `w-<id>`. Start every bash call with:
> `layerfs() { "$DSH_LAYERFS_CLI" "$@"; }; P=$DSH_LAYERFS_PROJECT SB=<your Sandbox: qv2-lane-<lane>, or ${DSH_LAYERFS_WS%%:*} for tools> ME=w-<id> BR=<lane>-r<N>; ws=$SB:$ME`
> Your first call: `layerfs branch get "$P" "$BR"`; if it is refused, report the brief
> as wrong. Never touch dsh's Workspace `$DSH_LAYERFS_WS` (`$SB:main`), never write to
> `$DSH_LAYERFS_BRANCH`, never fork, merge or publish, never mount another name.
>
> **Change files with `file` calls** on `$BR`: `file edit` for a change in place (read
> the lines first), `file write` for a new or rewritten file, `file apply` for several
> files that must land together. Each is a Commit; message them
> `[<ID> r<N>] <what> (<result>)`. Use bash only to run commands, and for batch changes
> or changes that need logic (`cargo fmt`, a codemod, a generator).
>
> **Run commands in one Workspace per bash call:** mount, exec(s), commit, unmount, all
> in that call (set the bash call's timeout to 600000 ms):
>
> ```bash
> layerfs workspace mount "$SB" "$BR" --name "$ME" >/dev/null || exit 1
> trap 'layerfs workspace unmount "$ws" >/dev/null' EXIT
> layerfs workspace exec "$ws" ". scripts/env.sh $ME && timeout 540 scripts/cargo-slot.sh test -p <crate> --locked --offline --no-run >/tmp/$ME/build.log 2>&1; echo exit=\$?; tail -n 30 /tmp/$ME/build.log" --stream
> layerfs workspace commit "$ws" -m "[<ID> r<N>] cargo test --no-run -p <crate> (exit <code>)"
> ```
>
> Use paths relative to the Workspace root, never the mount path. If the mount is
> refused `Exists`, your Workspace is still mounted from a cut-off call: run
> `layerfs workspace status "$ws"` once, commit it, unmount it, then mount again. If the
> unmount is refused `Dirty`, commit first.
>
> **Every exec** starts with `. scripts/env.sh $ME && ` (it sets Rust's PATH, Cargo's
> home and your own `target/$ME`, and `TMPDIR=$HOME/tmp/$ME`) and wraps commands in
> `timeout 540`, Cargo through `scripts/cargo-slot.sh`. Build tests with `--no-run`
> first, run them in the next bash call. Logs go to `/tmp/$ME/`; test data only under
> `$TMPDIR`. End every exec that runs tests with `rm -rf "$TMPDIR"/* /tmp/$ME/*`.
> Exit 137 means memory: rerun with `JOBS=1`. Build and test only your own packages
> (`-p`): the workspace-wide gates are the main agent's.
>
> **Commit after every step that changes files**, failing ones too. Target: at least 35
> Commits this round, no padding. Never leave work uncommitted for more than 10 minutes.
> - Your Workspace Commit merges with what your lane-mate committed since your mount.
>   Their `file` edits land on `$BR` at once, so if their half-finished change breaks
>   your build, tell them with `send_message` (or the main agent), and keep your own
>   crate building at every Commit.
> - `Conflict`: the markers are in your Workspace. Read both sides (skill
>   `rules/conflicts.md`), keep both changes, check no marker is left, build, commit
>   again, all before you unmount. Never delete markers to make it pass; never put
>   sources or `Cargo.lock` in `/.lww`.
> - `Busy`: `sleep $((3 + RANDOM % 8))`, retry, at most 5 times. `Failed` with
>   `Os { code: 2, kind: NotFound }` on a write: check whether it landed (`file stat`,
>   `commit list`), retry if not. Any other `Failed` or `Unknown`: run
>   `workspace status` once and tell the main agent; don't unmount a Workspace that
>   failed to commit.
>
> **Correctness comes from SQLite.** Compare with `.tools/bin/sqlite3` /
> `scripts/oracle.py` whenever behavior is in doubt. Never edit expected results in
> `tests/slt/` or the oracle; only T2 adds corpus files, and only through the oracle.
> Acceptance checks compare with sqlite3, never with stored Strata output. Use other
> lanes only through `strata-types`; if something you need isn't there, ask the main
> agent with `send_message` and use a stub or `MemPager`/`MemBTree` meanwhile. Don't
> add dependencies (ask the main agent).
>
> **Done** when every feature of your cell has tests (≥ 4 integration test files per
> crate) and fmt, clippy and tests pass for your crates on `$BR`'s head. Check that
> nothing of yours is mounted (`layerfs sandbox get "$SB" --page-size 16`), then end with
> skill `team.md`'s report block, plus your Commit count this round and what is missing
> from your cell:
>
> ```
> DONE w-<id>  branch=<lane>-r<N>  head=<66-hex id of your last Commit>
> ws=unmounted
> gates: fmt=0 clippy=0 test=0 (<crate> <n> passed)
> changed: <your crates>  # name every path outside them
> needs: <requests to other lanes, or —>
> lfs: Conflict×0 Busy×0 Failed×0 Capacity×0  # with one-line causes
> disk: <df -h / avail>  commits: <n>  missing: <what is not done>
> ```

## 6. Ledger and recovery

Keep the ledger in the local file `./quarry-v2/PROGRESS.md`, with the worker table of
skill `team.md` ("The main agent's ledger"). Append after the preflight, the skeleton,
every worker report, every merge, contract Commit, publish and check, and at least
every 30 minutes:

- the time and round; each lane Branch head; each worker's last Commit, Commit count,
  tests and status;
- merges, Conflicts and how they were resolved; publishes with their Layers;
- check results (gates, corpus passed/total, A01–A16);
- live workers and mounted Workspaces (peak so far), refusals by code;
- disk and memory; decisions and why; open problems; your next step.

**If your context was compacted, your turn was cut off, or you were told `continue`:**
read the ledger, `layerfs branch list "$P"` and `layerfs sandbox get "$SB"` before
anything else. `list_agents` tells you which workers still run. For each Workspace
whose worker is gone: if `activity` is idle (compare lowercase), both `dirty` counts
are 0 and `pending_merge` is false, unmount it; if it is dirty, commit it once with
`[<ID> rescue] commit leftover work`, then unmount it; never `--discard` it. Then
re-brief the missing workers with the same brief plus a note on what their Branch
already holds.

**If a worker fails, stalls (no Commit for 20 minutes) or is cut off:** read its lane
Branch, `send_message` it once; if it doesn't answer, `interrupt_agent` it, rescue its
Workspace as above, and start a replacement with the same brief and Workspace name.

**Lessons from v1, kept as rules:**

- A merge with `Failed: invalid record`: retry once from a fork of identical content
  (fork the source Branch and merge the fork).
- `file read` returns at most 2000 lines / 48 KiB; follow `next_line` until it is
  null, or read in a Workspace with `cat`. Never treat a partial read as the file.
- After every merge, `cargo metadata --locked --offline` before anything else.
- No `._*` files in the tree; delete any you see and keep `._*` in `.gitignore`.
- Runaway temp files are bugs: anything over 2 GB in `$TMPDIR` is a defect to fix,
  not disk to buy.
- Keep exec command lines free of file contents: write files with `file` calls.

Compiler errors, failing tests, wrong results, merge conflicts and slow builds are
never a reason to stop. Stop only for the terminal failure of SPEC §9. Keep working
until the terminal pass.
