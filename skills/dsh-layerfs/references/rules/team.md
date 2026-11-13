# Team runs: many workers in one Sandbox

Part of the `dsh-layerfs` skill. For a main agent with 4 or more subagents building at
once. Read [parallel work](parallel.md) first. Command examples start with the skill's
line; SDK examples run in a script that imported `layerfs` from `$DSH_LAYERFS_SDK`.

## Slots: 16 Workspaces, the session's own included

Every subagent works in the session Sandbox `$SB`, and you can't create another. It
holds 16 Workspaces:

| Slots | Holder | Workspace name |
| --- | --- | --- |
| 1 | dsh's Workspace `$DSH_LAYERFS_WS` | `main` (never touch) |
| 1 | main agent: integration and checks | `int` |
| 1 | spare: a re-mount, a leftover, a fresh verify | — |
| ≤ 13 | one per building worker | `w-<id>`, such as `w-p1`, `w-x2` |

- At most 13 workers hold a Workspace at once. Further workers get work that needs no
  build (docs, the test corpus, review), done with `file` calls on their own Branch,
  or wait until a worker reports.
- A worker holds at most one Workspace at a time, always named `w-<id>`. As everywhere,
  it mounts at the start of a bash call and commits and unmounts at its end; the
  committed `target/` and caches make the next mount warm. With a fixed name, a lost
  mount is found with one `workspace status`.
- The worker that mounted a Workspace unmounts it; nothing of a worker's is mounted
  when it reports. The main agent unmounts one only for a worker that has finished, and only
  when [cleaning up](parallel.md#cleaning-up) allows it.
- On `Capacity`, don't mount again. The worker reports it and waits. The main agent
  runs **one** `layerfs sandbox get "$SB" --page-size 16`, compares it with its
  ledger, and clears what is left over.

## The main agent's ledger

Keep it in the local working directory (`./team.md`) and update it on every report:

| worker | Branch | Workspace | files it owns | last head (66 hex) | state | waits on |
| --- | --- | --- | --- | --- | --- | --- |
| p1 | `w-p1-r2` | `w-p1` | `crates/quarry-parser/**` | `12ab…` | building | — |

- Briefs carry exact Branch and Workspace names, created by you before the brief
  (`branch fork`). Workers never guess names.
- One `sandbox get` before each integration and before you report: any Workspace not
  in the ledger is a leftover.

## The worker's line

A worker never touches dsh's Workspace and never writes `$B`: those belong to the
session. It starts every bash call with this line in place of the skill's, using the
names from its brief:

```bash
layerfs() { "$DSH_LAYERFS_CLI" "$@"; }; P=$DSH_LAYERFS_PROJECT SB=${DSH_LAYERFS_WS%%:*} ME=w-p1 BR=w-p1-r2; ws=$SB:$ME
layerfs workspace status "$ws" >/dev/null 2>&1 || layerfs workspace mount "$SB" "$BR" --name "$ME" >/dev/null || exit 1
trap 'layerfs workspace unmount "$ws" >/dev/null' EXIT          # commit before the call ends
```

```js
const ME = "w-p1", BR = "w-p1-r2", ws = `${SB}:${ME}`;
const st = await layerfs.workspace.status(ws).catch((e) => { if (e.code === "NotMounted") return null; throw e; });
if (!st) await layerfs.workspace.mount(SB, BR, { name: ME });
else if (st.branch !== BR) throw new Error(`${ws} is on ${st.branch}, not ${BR}: report it`);
```

Its first call in a task is `layerfs branch get "$P" "$BR"`. If that is refused, it
reports the brief as wrong; it never forks a Branch of its own.

## Choosing where workers commit

Work combines in place on a Branch in one way only: a `workspace commit` merges what
moved on that Branch. `branch merge` always makes a **new** Branch. So choose who
shares a Branch:

| Model | Conflicts show up | Isolation | Use for |
| --- | --- | --- | --- |
| **A Branch per worker** `w-<id>-r<N>` (default) | Only at integration, for the main agent | Full: no Commit ever merges, and a restore can't strand it | 5 or more workers; Rust builds with `target/` committed |
| **A lane Branch** shared by 2–3 workers | At each Commit, for the committer | None inside the lane | Workers on one crate who need each other's changes within minutes |
| **`$B` itself** | At each Commit, and at the main agent's checkpoint | None; a restore strands every mount | 4 or fewer workers on disjoint files |

- Commit after every command that changes files, on your own Branch. Small, frequent
  Commits cost little and nobody sees them until the main agent merges them.
- On a shared Branch, commit only states that build (`cargo check -p <yours>` exit 0):
  the others take in every Commit you make at their next Commit.
- A Workspace's view moves at a Commit: a Commit that answers `Committed` (with
  `merged`) or `UpToDate` leaves it showing the Branch's new head, others' Commits
  included.
- Take in other workers' work by forking again, not by merging into your Branch:
  report your head, get the new base from the main agent, commit, unmount, fork
  `w-<id>-r<N>.<k>` from the base, and mount it under the same name.
- Contract changes to shared crates come from the main agent between integrations: it
  writes the identical change onto each affected worker Branch with `file write`
  (identical writes merge cleanly), and each worker takes it in at its next Commit.
- Integrate on a rolling basis: whenever 3 or more workers have reported, or every
  30–45 minutes, not once at the end of a round. Small merges keep conflicts small.

## Waiting

- **For a subagent or a background bash job**, use the subagent and job tools: you are
  told when it ends. Never a sleep loop, and never LayerFS calls to find out whether
  work is done.
- **For a long command:** one bash call may run up to 600 s (the call's `timeout`, in
  ms). Set the inner `timeout` 30 s below it, so the command ends, its output comes
  back and the Commit runs within the same call: `timeout 570 cargo test …` in a
  600 s call. Anything longer goes in a `run_in_background` bash call, with an
  `--exec-id` you choose:

  ```bash
  layerfs workspace exec "$ws" "mkdir -p /tmp/$ME && timeout 1500 cargo build --workspace --locked --offline >/tmp/$ME/build.log 2>&1; echo \$? >/tmp/$ME/build.code" --exec-id "$ME-build"
  layerfs workspace exec "$ws" "cat /tmp/$ME/build.code; tail -n 40 /tmp/$ME/build.log" --stream   # after the job notice
  ```

  While that exec runs, make no other call on that Workspace except `status`.
- **When a tool timeout kills the `layerfs` process**, the command can keep running in
  the Sandbox and the Workspace stays `Busy` (unmount is refused `Busy`). End it with
  `workspace exec-cancel "$ws" <exec-id>`, which needs the exec-id you gave it: give
  one to every exec that may run longer than a minute.
- **Loops that call LayerFS** sleep at least 5 s between rounds, stop after a fixed
  number of tries, and stop at the first `NotMounted` or `NoSuchSandbox`. Never call a
  Workspace after its unmount, and never probe guessed names: one `sandbox get` lists
  every Workspace.
- **`Busy`:** wait `sleep $((3 + RANDOM % 8))` and try again, at most 5 times, then
  report it. With 15 agents, waits without jitter collide again.

## One Sandbox, shared by everyone

Every Workspace in `$SB` shares one machine: `/tmp`, `HOME`, CPU, RAM and disk.

- **Your own `/tmp`:** write logs, exit codes and test data under `/tmp/$ME/` only,
  never `/tmp/build.log`, and point test temp dirs there (`TMPDIR=/tmp/$ME`). Clear it
  at the end of each step (`rm -rf /tmp/$ME/*`).
- **Disk:** check before any build that compiles dependencies, and the main agent
  checks before each integration: `df -BG --output=avail / | tail -1`. Below 30 GB,
  start no cold build: report it. The main agent then unmounts finished workers'
  Workspaces and looks for leaks with `du -xsh /tmp/* 2>/dev/null | sort -h | tail`.
  A mounted Workspace keeps what it built until its unmount.
- **CPU and RAM:** `CARGO_BUILD_JOBS=2`, and at most 4 cargo builds at once in `$SB`.
  Where `command -v flock` finds it (Linux Sandboxes usually; native macOS has none),
  take a slot with `flock /tmp/lfs-build.$((RANDOM % 4)).lock cargo …`. Exit 137
  means the kernel killed the process (memory): wait and run it again; don't raise
  the job count.
- **Warm start:** the main agent compiles every dependency once (debug and test) and
  commits `target/` before forking worker Branches, so workers compile only their own
  crates.

## Integrating

Merge one Branch at a time onto the growing result: a chain, not a tree. Each conflict
then belongs to exactly one worker, and `a`'s `/.lww` (the result so far) applies.

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

- **Check every result in the `int` Workspace before the next batch:** mount `acc`
  under the name `int` (unmount the old `int` first), then run
  `cargo metadata --locked --offline --format-version 1 >/dev/null && cargo check --workspace --locked --offline`.
  A broken or truncated `Cargo.lock` fails here, not three merges later.
- **`Cargo.lock` has one writer.** Only the main agent changes
  `[workspace.dependencies]` and `Cargo.lock`; worker crates use
  `dep = { workspace = true }` and ask for new dependencies in their report. Never put
  `Cargo.lock` in `/.lww`.
- **Tracked generated files** (expected test results, generated code) go in `/.lww`
  only if integration regenerates and checks them after each merge.
- **A source conflict:** resolve a mechanical one yourself
  ([branch-merge conflicts](conflicts.md#branch-merge-conflicts)). For a semantic one,
  send the worker `detail.conflicts`, the other Branch's name and `detail.mergeBase`;
  it fixes it on its own Branch and you merge again.
- **Where it ends up:** the latest `int-r<N>.<k>` is the team's head. Fork the next
  base from it, and publish it only when the user (or the brief) asks, after a fresh
  verify.

## Reporting

A worker ends its task with one block, and nothing before it:

```
DONE w-p1  branch=w-p1-r2  head=<66-hex id from `workspace commit`>
ws=unmounted                      # or kept: <reason>
gates: check=0 clippy=0 test=0 (parser 144 passed)
changed: crates/quarry-parser/**  # name every path outside your files
needs: P2 — ScalarExpr::Collate   # requests to other workers, or —
lfs: Conflict×0 Busy×1 Capacity×0 # refusals you hit, with one-line causes
disk: 41G free
```

`BLOCKED` in place of `DONE` when it stopped early: the same fields plus `why:`.
