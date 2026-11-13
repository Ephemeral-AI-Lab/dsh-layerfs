# dsh-layerfs skill: proposed changes for a 12–15 worker run

What this covers: the `dsh-layerfs` skill (`skills/dsh-layerfs/`) reviewed for Quarry v2, which runs
12–15 concurrent subagents in one Docker Linux `$SB`, with more Commits and a larger Rust
engine, on DeepSeek V4.1 Flash. These are proposals only: no skill file was edited. Each item
gives the file and section, the problem it solves, and text ready to paste.

Verified in `src/host/sessions/{index,service}.ts` and DSH's `bash-local` README: subagents get a
`shared` binding and **never checkpoint**; a turn checkpoint also commits when only
`head_moved_since_mount` is true; after the owner agent is disposed, `close()` force-closes `$SB`
once `idleMinutes` (default 30) pass; `$DSH_LAYERFS_BRANCH`/`_WS` are resolved from the parent's
binding on every bash call; the bash tool defaults to 120 s, max 600 s per call. v1 failures
addressed: 2,956 `NotMounted` polls, 10 lane-mate Conflicts, 33 `NoSuchBranch`, 25 `NoSuchPath`,
7 `Binary`, exits 137 ×21 / 143 ×25, a truncated `Cargo.lock` and `fs.read`, `._*` files, 55 GB
and 80 GB leaks in `/tmp`.

---

## P0: the run fails or stalls without these

### P0-1 · New page `references/rules/team.md`, linked from SKILL.md and parallel.md

**Problem.** Nothing in the skill covers more than a few subagents. Every example uses `$WS`,
and subagents inherit `$WS`. So 15 workers that follow the skill literally all run cargo in the
session Workspace at the same time, which breaks "never two calls at once". The cap of 16
Workspaces includes `$WS`. If 15 workers each mount one, the cap is full and the main agent has
no slot left to integrate or verify. Nothing says what a Workspace should be named, who unmounts
it, or what the main agent tracks. In v1 the main agent and the workers scanned guessed
Workspace paths, which produced 2,956 refused polls.

**SKILL.md, "Which call for which job"**: change the row to
`| Run work in parallel with subagents | [parallel work](references/rules/parallel.md); 4 or more at once: [team runs](references/rules/team.md) |`
and add a row to the reference table: `| [team runs](references/rules/team.md) | many workers in one Sandbox: slots, Branches, waiting, integration |`.

**New page, first part:**

~~~markdown
# Team runs: many workers in one Sandbox

Part of the `dsh-layerfs` skill. For a main agent with 4 or more subagents building at once.
Read [parallel work](parallel.md) first.

## Slots: 16 Workspaces, the session's own included

| Slots | Holder | Workspace name |
| --- | --- | --- |
| 1 | the session Workspace `$WS` | `main` (dsh's; never touch) |
| 1 | main agent: integration and checks | `int` |
| 1 | spare: a re-mount, a leftover, a fresh verify | — |
| ≤ 13 | one per building worker | `w-<id>`, such as `w-p1`, `w-x2` |

- At most 13 workers hold a Workspace at once. Workers beyond that get work that needs no
  build (docs, the test corpus, review), done with `file` calls on their own Branch, or wait
  until a worker reports.
- A worker mounts exactly one Workspace, always with `--name w-<id>`, and keeps it for its task
  (Cargo reuse). With a fixed name, a lost mount is found with one `workspace status`.
- The worker that mounted a Workspace unmounts it, after its last Commit and before it reports.
  The main agent unmounts a Workspace only for a worker that has finished, and only when
  [cleaning up](parallel.md#cleaning-up) allows it.
- On `Capacity`, don't mount again. The worker reports it and waits. The main agent runs **one**
  `layerfs sandbox get "$SB" --page-size 16`, compares it with its ledger, and clears what is
  left over.

## The main agent's ledger

Keep it in the local scratch folder (`./team.md`) and update it on every report:

| worker | Branch | Workspace | files it owns | last head (66 hex) | state | waits on |
| --- | --- | --- | --- | --- | --- | --- |
| p1 | `w-p1-r2` | `w-p1` | `crates/quarry-parser/**` | `12ab…` | building | — |

- One `sandbox get` before each integration and before you report: any name not in the
  ledger is a leftover. Briefs carry exact Branch and Workspace names; workers never guess
  (v1: 33 `NoSuchBranch`, 25 `NoSuchPath`).

## The worker's line

A worker never runs commands in `$WS` and never writes `$B`: those belong to the session.
Start every bash call with this line in place of the skill's, using the names from the brief:

```bash
layerfs() { "$DSH_LAYERFS_CLI" "$@"; }; P=$DSH_LAYERFS_PROJECT SB=${DSH_LAYERFS_WS%%:*} ME=w-p1 BR=w-p1-r2; ws=$SB:$ME
layerfs workspace status "$ws" >/dev/null 2>&1 || layerfs workspace mount "$SB" "$BR" --name "$ME" >/dev/null || exit 1
```

```js
const ME = "w-p1", BR = "w-p1-r2", ws = `${SB}:${ME}`;
const st = await layerfs.workspace.status(ws).catch((e) => { if (e.code === "NotMounted") return null; throw e; });
if (!st) await layerfs.workspace.mount(SB, BR, { name: ME });
else if (st.branch !== BR) throw new Error(`${ws} is on ${st.branch}, not ${BR}: report it`);
```

Your first call in a task: `layerfs branch get "$P" "$BR"`. If it is refused, report the brief as wrong; never fork a Branch of your own.
~~~

### P0-2 · team.md: choosing the Branch model and how often to commit

**Problem.** parallel.md recommends "one Workspace each on `$B`" for subagents that run at the
same time. That was v1's model of lane-mates sharing one Branch: 8 Commit conflicts, and every
Commit takes in everyone else's half-finished changes. At 15 workers it also exposes everyone to
a restore (`$B` becomes `.rN`, and every Workspace is stranded on the old Branch). It also
competes with the checkpoint. Nothing compares the models or says when to merge. Also, in v2 a
merge always makes a **new** Branch, and only a Workspace Commit combines work in place. That
property drives the whole design, and the skill never says so.

~~~markdown
## Choosing where workers commit

Work combines in place on a Branch in one way only: a `workspace commit` merges what moved on
that Branch. `branch merge` always makes a new Branch. So choose who shares a Branch:

| Model | Conflicts show up | Isolation | Cost | Use for |
| --- | --- | --- | --- | --- |
| **A Branch per worker** `w-<id>-r<N>` (default) | Only at integration, for the main agent | Full: no Commit ever merges, and restores can't strand it | One merge per worker per integration | 5 or more workers, Rust builds with `target/` committed |
| **A lane Branch** shared by 2–3 workers | At each Commit, for the committer, as small conflicts | None inside the lane | Commit-time merges of `target/` (by `/.lww`) | Workers on the same crate who need each other's changes within minutes |
| **`$B` itself** | At each Commit, and at the main agent's checkpoint | None; a restore strands every mount | Lowest | 4 or fewer workers on disjoint files, nobody restoring |

- Commit after every command that changes files, on your own Branch. That is free: nobody else
  sees it until the main agent merges it.
- On a shared Branch, commit only states that build (`cargo check -p <yours>` exit 0). The
  others take in every Commit you make at their next Commit. Record a failing step in your
  report, not as a Commit there.
- Pull in other workers' work by forking again, not by merging into your Branch: report your
  head, get the new base from the main agent, commit, unmount, fork `w-<id>-r<N>.<k>` from
  the base, and mount it under the same name.
- Contract changes to shared crates (`quarry-types`) come from the main agent between
  integrations. It writes the identical change onto each affected worker Branch with
  `file write` (identical writes merge cleanly), and each worker takes it in at its next Commit.
- The main agent integrates on a rolling basis: whenever 3 or more workers have reported, or
  every 30–45 minutes, not once at the end of a round. Small merges keep conflicts small.
~~~

### P0-3 · team.md + SKILL.md "Running commands": waiting and timeouts, without polling storms

**Problem.** The skill says "wrap in `timeout 110`; for longer work use `run_in_background`",
and nothing more. A cold build of a larger engine in Docker exceeds 110 s (in v1 the longest
exec took 10.9 min, and 87 took over a minute). Nothing says that the bash tool allows up to 600 s
per call. Nothing says that a timeout that kills the client process can leave the command
running in the Sandbox with the Workspace `Busy`, or how a worker should wait for a subagent or
a background exec. In v1 the scripts polled: 2,128 `sandbox.status` calls in one loop.

**team.md:**

~~~markdown
## Waiting

- **For a subagent or a background bash job**, use the subagent and job tools. You are told when
  it ends. Never use a sleep loop, and never use LayerFS calls to find out whether work is done.
- **For a long command:** one bash call may run up to 600 s (set the call's `timeout`, in ms).
  Set the inner `timeout` 30 s below it, so the command ends, its output is collected and the
  Commit runs within the same call: `timeout 540 cargo test …` in a 600 s call. Anything longer
  goes in a `run_in_background` bash call, with an `--exec-id` you choose:

  ```bash
  layerfs workspace exec "$ws" "mkdir -p /tmp/$ME && timeout 1500 cargo build --workspace --locked --offline >/tmp/$ME/build.log 2>&1; echo \$? >/tmp/$ME/build.code" --exec-id "$ME-build"
  layerfs workspace exec "$ws" "cat /tmp/$ME/build.code; tail -n 40 /tmp/$ME/build.log" --stream   # after the job notice
  layerfs workspace commit "$ws" -m "cargo build (exit $(…))"
  ```

  While that exec runs, make no other call on that Workspace except `status`: no exec, commit
  or unmount.
- **When a tool timeout kills the `layerfs` process**, the command can keep running in the
  Sandbox, and the Workspace stays `Busy` (an unmount is refused `Busy`). End it with
  `workspace exec-cancel "$ws" <exec-id>`. That only works if you gave it an exec-id, so give
  one to every exec longer than a minute.
- **Loops that call LayerFS** sleep at least 5 s between rounds, stop after a fixed number of
  tries, and stop at the first `NotMounted` or `NoSuchSandbox`. Never call a Workspace after
  its unmount. Never probe guessed names: one `sandbox get` lists every Workspace.
- **`Busy`:** wait `sleep $((3 + RANDOM % 8))` and try again, at most 5 times, then report it.
  With 15 agents, waits without jitter collide again.
~~~

**SKILL.md "Running commands"**: end the "No timeout of its own" bullet with "Longer: up to
600 s per bash call, then `run_in_background` with an `--exec-id` ([waiting](references/rules/team.md#waiting))."

### P0-4 · team.md + cargo.md: disk, CPU, RAM and `/tmp` are shared by everything in `$SB`

**Problem.** One Sandbox is one container. Its `/tmp`, `HOME`, CPU, RAM and disk are shared by
all 16 Workspaces. The skill's own example writes `/tmp/build.log` and `/tmp/build.code`, so 15
workers overwrite each other's logs and exit codes. With cargo.md's `CARGO_BUILD_JOBS=3`, 15
builds run 45 rustc processes plus link steps with `debug = "full"`; v1 already saw 21 exits
with 137 and 25 with 143. Each mounted Workspace holds what it built until it is unmounted. In
v1 a lane head reached 8.7–11 GB of `target/`, Docker had 68 GB free at the end with only 4
Sandboxes, and a leaked 55 GB `/tmp/.tmp*` directory and an 80 GB spill file appeared.

**team.md:**

~~~markdown
## One Sandbox, shared by everyone

Every Workspace in `$SB` shares one machine: `/tmp`, `HOME`, CPU, RAM and disk.

- **Your own `/tmp`:** write logs, exit codes and test data under `/tmp/$ME/` only, never
  `/tmp/build.log`. Clear it at the end of each step (`rm -rf /tmp/$ME/*`). Point test temp dirs
  there too (`TMPDIR=/tmp/$ME`).
- **Disk:** check before any build that compiles dependencies, and the main agent checks before
  each integration: `df -BG --output=avail / | tail -1`. Below 30 GB, start no cold builds:
  report it. The main agent then unmounts finished workers' Workspaces and looks for leaks with
  `du -xsh /tmp/* 2>/dev/null | sort -h | tail`. A mounted Workspace keeps what it built until
  its unmount, so unmount as soon as your task ends.
- **CPU and RAM:** `CARGO_BUILD_JOBS=2`, and at most 4 cargo builds at once in `$SB`:
  `flock /tmp/lfs-build.$((RANDOM % 4)).lock cargo …` (check `command -v flock` once). Exit
  137 means the kernel killed the process (memory): wait for a slot and run it again, don't
  raise the job count.
- **Warm start:** the main agent compiles every dependency once (debug and test) and commits
  `target/` before forking worker Branches. Workers then compile only their own crates.
~~~

### P0-5 · team.md: integrating many worker Branches (merge chain, Cargo.lock, generated files)

**Problem.** conflicts.md explains how to resolve one merge, but not how to combine 13 Branches
or in what order. It doesn't cover the v1 `Cargo.lock` truncation (the only safeguard v1 found
was a `--locked` check after each merge). Nothing prevents `Cargo.lock` conflicts in the first
place, nor says what to do with generated files that are tracked (the corpus, expected results).

~~~markdown
## Integrating

Merge one Branch at a time onto the growing result: a chain, not a tree. Then each conflict
belongs to exactly one worker, and `a`'s `/.lww` (the result so far) is the one applied.

```js
const reported = ["w-p1-r2", "w-x1-r2", "w-s1-r2"];          // in report order, from the ledger
let acc = "base-r2", n = 0;
for (const w of reported) {
  try {
    const m = await layerfs.branch.merge(P, `int-r2.${++n}`, acc, w, { message: `integrate ${w}` });
    console.log(m.branch, m.fast_forward ? "ff" : "merged", "lww:", m.lww.length);
    acc = m.branch;
  } catch (e) {
    if (e.code !== "Conflict") throw e;                       // anything else: stop and look
    console.log("CONFLICT", w, JSON.stringify(e.detail.conflicts.map((c) => [c.path, c.kind])));
  }                                                           // skip it; resolve after the rest
}
console.log("integrated:", acc);
```

- **Check every result in the `int` Workspace before you merge the next batch:** mount `acc`
  under the name `int` (unmount the old `int` first), then run
  `cargo metadata --locked --offline --format-version 1 >/dev/null && cargo check --workspace --locked --offline`.
  A `Cargo.lock` that is broken or truncated fails here, not three merges later.
- **`Cargo.lock` has one writer.** Only the main agent changes `[workspace.dependencies]` and
  `Cargo.lock`. Worker crates use `dep = { workspace = true }`. A worker that needs a dependency
  asks for it in its report. If a lockfile conflicts anyway: fork `<w>-fix` from the worker
  Branch, write `acc`'s `Cargo.lock` onto it (`file read` then `file write`), merge `acc` with
  `<w>-fix`, then run `cargo metadata --offline` in `int` to add what is missing, and commit.
  Never put `Cargo.lock` in `/.lww`.
- **Tracked generated files** (expected test results, generated code): list them in `/.lww`
  only if the integration step regenerates them after each merge and checks the result.
- **A source conflict:** if it is mechanical, resolve it yourself
  ([branch-merge conflicts](conflicts.md#branch-merge-conflicts)). If it is semantic, send the
  worker `detail.conflicts`, the other Branch's name and `detail.mergeBase`. The worker fixes it
  on its own Branch, and you merge again.
- **Where it ends up:** the latest `int-r<N>.<k>` is the team's head. Fork the next base from
  it. Publish it only when the user (or the handoff) asks, after a fresh verify. To bring it
  into the session, see [bringing work into the session](parallel.md#bringing-work-into-the-session).
~~~

---

## P1: wrong, ambiguous or missing on the current pages

### P1-1 · SKILL.md "Checkpoints": subagents, a moved `$B`, and idle close

**Problem.** "At the end of every turn that changed files" is ambiguous for subagents, and wrong
by omission for a turn where only `$B` moved. The code checkpoints on `head_moved_since_mount`
too. Nothing warns that closing or idling out the session force-closes `$SB` while workers still
have Workspaces mounted there.

~~~markdown
- **Only the main agent's turns checkpoint.** A subagent's turn never does. Changes a subagent
  makes in `$WS` are saved at the main agent's next turn end.
- A turn whose `$WS` is unchanged still checkpoints when `$B` moved (subagents' Commits): the
  checkpoint merges that head into `$WS`.
- **During a team run, keep `$WS` quiet.** The main agent edits nothing in `$WS` while workers
  commit to `$B`, and in the default model workers commit to their own Branches
  ([team runs](references/rules/team.md)). Then a checkpoint can't conflict.
- When the conversation is closed, or idles out (30 min after it is unloaded, by default), dsh
  saves `$WS` and force-closes `$SB`. Every other Workspace in it is lost with its uncommitted
  changes. Keep the conversation open while workers run, and have them commit after every step.
~~~

### P1-2 · parallel.md "Bringing work into the session": the recipe breaks on Rust

**Problem.** It `file read`s every changed path. With `target/` committed that is thousands of
binary files (`Binary` refusals) and one huge `file apply` (v1: a 156 KB apply took 31 s).
Generated output needs no carrying over: it is rebuilt.

Add before `let content = ""` in the loop:

~~~js
if (/^\/(target|\.cargo-home)\/|\/node_modules\//.test(item.path)) continue;   // generated: rebuild after
if (item.type === "symlink") { skipped.push(item.path); continue; }
~~~

and wrap the read in `try { … } catch (e) { if (e.code !== "Binary") throw e; skipped.push(item.path); continue; }`.
Then add a bullet: "Copy the `skipped` paths in a Workspace. Rebuild generated output in `$WS`
afterwards. A team's integration Branch is usually published or forked from, not brought in."

### P1-3 · workspace.md "Shared rules": does the view follow the head after a Commit?

**Problem.** The pages contradict each other. workspace.md says "The view is fixed at mount …
To *see* those Commits, mount again". conflicts.md says that after a Conflict "the Workspace now
follows the new head". The v1 probe found that after a lane-mate's write, the Commit answered
`UpToDate` and "the Workspace then shows the file". Workers on a shared Branch need to know
whether their build now includes their lane-mates' changes. Verify this against the pinned build,
then replace the text with:

~~~markdown
- **The view moves only at a Commit.** Between Commits it shows the Branch as it was. A
  `workspace commit` that answers `Committed` with `merged`, or `UpToDate`, leaves the Workspace
  showing the new head, others' Commits included. A `Conflict` leaves it on the new head, with
  markers. To see others' Commits without committing, mount again.
~~~

### P1-4 · `activity` casing differs across workspace.md, sandbox.md and parallel.md

**Problem.** `workspace status` shows `Idle`/`Busy`; `sandbox get` and parallel.md's cleanup rule
say `idle`/`busy`. A cleanup script comparing `=== "Idle"` against `sandbox get` never matches.
Check the pinned CLI, make the pages agree, and add to parallel.md "Cleaning up": "compare
`activity.toLowerCase() === "idle"`".

### P1-5 · cargo.md: settings for many Workspaces, and the Docker timeout

**Problem.** cargo.md leaves out the two settings v1 showed were required for reuse across fresh
mounts. Without `--remap-path-prefix`, "a third of a full copy is new again", and
"target reuse works across mounts only when the Remap flags match". Its `CARGO_BUILD_JOBS=3`
and the 110 s budget fit one agent. The "Build reuse" section tells you to keep a Workspace
mounted, but doesn't say a fresh mount can reuse when the flags match.

Replace the exec block and "Build reuse" with:

~~~markdown
```bash
layerfs workspace exec "$ws" 'timeout 540 bash -c "set -eu
export CARGO_HOME=\$PWD/.cargo-home CARGO_TARGET_DIR=\$PWD/target CARGO_NET_RETRY=0 CARGO_BUILD_JOBS=2 CARGO_INCREMENTAL=0
export RUSTFLAGS=\"--remap-path-prefix=\$PWD=/w\"
unset RUSTC_WRAPPER RUSTC_WORKSPACE_WRAPPER
cargo fetch --locked"' --stream          # in a bash call with a 600 s timeout
```

## Build reuse

Each mount has its own path, so set the same `RUSTFLAGS` (with `--remap-path-prefix=$PWD=/w`),
profile, features and jobs in **every** exec, in every Workspace. Then a fresh mount of a Branch
with `target/` committed reuses it: an unchanged `cargo build` prints no `Compiling` for
dependencies. Check that once per task. If it recompiles, compare the flags first.
`debug = "full"` makes `target/` several times larger. Prefer
`[profile.dev] debug = "line-tables-only"` unless the task needs full debuginfo.
~~~

Also change "each within `timeout 110`" in "Split and label the work" to "each within one bash
call (up to 600 s, inner `timeout` 30 s less; [team runs: waiting](team.md#waiting) for longer)".
A Docker Linux Sandbox has `timeout`; the `perl` form is for native macOS only.

### P1-6 · team.md: the report a worker sends

**Problem.** v1 reports were free text: the main agent ran 70 `send_message` calls and re-read
Branches to find out what was ready. Short, fixed fields let 15 reports fit in context and go
straight into the ledger.

~~~markdown
## Reporting

End your task with one block, and nothing else first:

```
DONE w-p1  branch=w-p1-r2  head=<66-hex id from `workspace commit`>
ws=unmounted                      # or kept: <reason>
gates: check=0 clippy=0 test=0 (parser 144 passed)
changed: crates/quarry-parser/**  # every path outside your files: name it
needs: P2 — ScalarExpr::Collate   # cross-worker requests, or —
lfs: Conflict×0 Busy×1 Capacity×0 # refusals you hit, with one-line causes
disk: 41G free
```

`BLOCKED` in place of `DONE` when you stopped early: keep the same fields and add `why:`.
~~~

---

## P2: smaller fixes

- **file.md "`file read`"** (v1: a 51,161-byte file came back as 49,135 bytes with
  `truncated:false`). Add: "For a file near or above 48 KiB, check the result against `size`:
  `Buffer.byteLength(text) === (await layerfs.file.stat(P, br, path)).size`. If they differ,
  read it with `cat` in a Workspace and report the mismatch." Never write back a file you read
  in windows unless that check passed.
- **file.md "Shared refusals"**: add a row `| Binary | Not UTF-8 text | Read or copy it in a Workspace (`xxd`, `cp`); `file stat` first when unsure |`.
  The refusal is mentioned only inside the `read` prose today.
- **lww.md "Treat it as your `.gitignore`"** (v1 found AppleDouble files): add "`._*` and
  `.DS_Store` belong in `.gitignore`. Copy folders from macOS with `COPYFILE_DISABLE=1 tar`,
  and check with `find . -name '._*'` before a publish."
- **SKILL.md "What you already have"**: add a row
  `| DSH_LAYERFS_TRACE_CONTEXT | Ties each call to this session and tool call. Keep it; never `env -i` or override it |`.
  Scripts that scrub the environment lose their receipts, and the call is then attributed to nobody.
- **commit.md "`commit list`"**: "each checkpoint is one Commit (`via: "exec"`)" doesn't tell a
  checkpoint from a worker's Workspace Commit on `$B`, because both are `exec`. Add: "Checkpoints
  carry dsh's messages: `dsh turn <n>`, `Saved before restore`, `Saved before closing`."
- **sandbox.md "`sandbox get`"** and **SKILL.md "Rules" (`Busy`)**: pass `--page-size 16`
  (one page lists every Workspace); on `Busy`, jitter and stop after 5 tries (as P0-3).
- **parallel.md "Subagents at the same time"**: change the section title to
  "A few subagents at the same time: one Workspace each on `$B`", and add after it: "More than
  4, or Rust builds: give each worker its own Branch ([team runs](team.md))." In that section's
  SDK example, the name `sub-api` doesn't follow the `w-<id>` convention: make it `w-api`.
- **Restores during a run** (parallel.md, the restore bullet): add "A worker that writes `$B`
  compares `$DSH_LAYERFS_BRANCH` (read fresh in every bash call) with the Branch its Workspace
  was mounted on (`workspace status` → `branch`). If they differ, commit, unmount, and report it
  instead of mounting again by itself."
