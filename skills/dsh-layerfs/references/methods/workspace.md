# workspace calls

Part of the `dsh-layerfs` skill. Command examples start with the skill's line
(`layerfs() { "$DSH_LAYERFS_CLI" "$@"; }; P=… B=… SB=…`); SDK examples run in a
script that imported `layerfs` from `$DSH_LAYERFS_SDK` and set `P`, `B`, `SB`.

| Call | Command | SDK |
| --- | --- | --- |
| list | `layerfs workspace list [--sandbox S] [--limit 100] [--cursor C]` | `workspace.list({ sandbox, limit, cursor })` |
| mount | `layerfs workspace mount <sandbox> <branch> [--name <name>]` | `workspace.mount(sandbox, branch, { name })` |
| exec | `layerfs workspace exec <workspace> <command> [--cwd D] [--env K=V]... [--stdin] [--stream] [--progress]` | `workspace.exec(workspace, command, { cwd, env, stdin, stream, stdout, stderr, on_progress })` |
| cancel | `layerfs workspace cancel <workspace> [--exec E]` | `workspace.cancel(workspace, { exec })` |
| commit | `layerfs workspace commit <workspace> [-m <msg>] [--expected C] [--force]` | `workspace.commit(workspace, { message, expected, force })` |
| unmount | `layerfs workspace unmount <workspace> [--discard] [--force]` | `workspace.unmount(workspace, { discard, force })` |
| status | `layerfs workspace status <workspace> [--path P]` | `workspace.status(workspace, { path })` |

A Workspace is a complete, writable view of one Branch where ordinary commands run.
You need one only to run commands; read and change files with `file` calls. Each use
goes **mount, exec, commit, unmount**. Everything a command changes in it is saved by
its Commit and nothing else. (`workspace.exec_cancel` is removed in 2.0 — use
`workspace.cancel`.)

## dsh's Workspace and yours

| | dsh's Workspace `$DSH_LAYERFS_WS` (`<sandbox>:main`) | A Workspace you mount |
| --- | --- | --- |
| Mounted by | dsh, for the whole session | You, with `workspace mount` |
| Branch | The session Branch `$B` | `$B`, or any Branch of the project except `main` and other `dsh.…` Branches |
| Committed by | dsh, to record each checkpoint | You, after the commands that changed files |
| You may | `status`, nothing else | Every call |
| Lives | The whole session | One step: unmount it before your turn ends, or it is lost with its changes when the session's Sandbox stops |
| Sandbox | `$SB` | `$SB`, or a Sandbox you created for more room. At most 16 Workspaces per Sandbox, dsh's included in `$SB` |

## Shared rules

- A Workspace is named `<sandbox>:<name>`: the `workspace` field of `mount`'s result.
  Give every mount a `name` for its step (`test-cart`, `w-p1`), so its handle is
  `$SB:<name>` without parsing. Without `--name`, the default name is the Branch's
  lowercased/sanitized name (`<sandbox>:<sanitized-branch>`, never `<sandbox>:<path>`).
  Never use a handle after its unmount.
- **The mount path is new for every mount** (`mount` answers it as `path`). Commands
  run at the Workspace root (or `cwd`): use relative paths, and never write the mount
  path into a command, a script, a config file or a build flag.
- **Each mount is a new Workspace**, even on the same Branch, with its own uncommitted
  changes. Mounting is cheap: it copies nothing.
- **The view moves only at a Commit.** Between Commits it shows the Branch as it was
  when mounted (or last committed): later `file` writes and other Workspaces' Commits
  don't appear (`workspace status` sets `branch_moved: true`). A `commit` merges in
  what moved and leaves the Workspace showing the new head, also when it answers
  `unchanged: true`.
- **Everything in it is committed:** sources, `.git`, `node_modules`, build output and
  caches. Throwaway files belong in `/tmp`, outside it.
- Keep each Workspace's calls one after another, never two at once.
- While its Sandbox is being created or removed, `mount`, `exec`, `commit` and
  `unmount` are refused `Busy`: wait and try again.

## A step: mount, exec, commit, unmount

The unmount is guaranteed even if the step stops early:

```bash
ws=$SB:test-all
layerfs workspace mount "$SB" "$B" --name test-all >/dev/null || exit 1
trap 'layerfs workspace unmount "$ws" >/dev/null' EXIT
layerfs workspace exec "$ws" 'timeout 110 npm test 2>&1' --stream; code=$?
layerfs workspace commit "$ws" -m "npm test (exit $code)" >/dev/null
```

```js
const { workspace } = await layerfs.workspace.mount(SB, B, { name: "test-all" });
try {
  const run = await layerfs.workspace.exec(workspace, "timeout 110 npm test 2>&1");
  await layerfs.workspace.commit(workspace, { message: `npm test (exit ${run.exit_code})` });
} finally {
  await layerfs.workspace.unmount(workspace);
}
```

Several commands may share one mount and one Commit (install, build, test). Keep a
Workspace mounted across bash calls only for work that has to keep running between
them (a long build reused step by step, a dev server), and unmount it as soon as that
work is done.

## `workspace mount`

Mounts the Branch's head as it is now in the named Sandbox. Mount in the session
Sandbox `$SB` unless it is full. It never starts a Sandbox. `main` is refused
`InvalidInput`: fork a Branch from it and mount that. `name` is 1 to 63 lowercase
letters, digits, `_ . -`, unique in the Sandbox while mounted; `main` is dsh's.

Short answer: `{"workspace":"<sandbox>:<name>","path":"..."}`. Long form (`--detail`)
adds `outcome: "mounted"`, `branch`, `commit`, `base_layer`, `root`, `id`, `namespace`.

| `error` | Meaning | Do |
| --- | --- | --- |
| `NotFound` | No Sandbox or Branch of that name (`NoSuchSandbox`, `NoSuchBranch`) | Check the name; `sandbox get`, `branch list` |
| `InvalidInput` | `main` (refusal carries runnable `fix`), or bad `name` | Fork a Branch and mount that; pass `--name` |
| `Exists` | A Workspace of that `name` is mounted | Pick another name |
| `Capacity` | The Sandbox holds 16 Workspaces, dsh's included | Unmount Workspaces of yours you're done with, or create another Sandbox |
| `Unavailable` | The Sandbox's machine worker is down | Stop and tell the user; don't start machines |
| `Failed` | The mount failed | Stop and report |

## `workspace exec`

Runs one command with `bash -c` in the Workspace root (or `cwd`, relative to the
Workspace root) and waits for it to end. Use relative paths (`src/cart.js`), never
the mount path. `HOME` is a private folder of the Sandbox.

- **Answer:** `{ exit_code }`, plus `stdout` and `stderr` when non-empty. Each
  stream comes back whole up to 1 MiB; a longer stream returns its last 1 MiB and
  names `stdout_file` / `stderr_file` (in the Sandbox's run folder, readable with
  `sandbox files`). `--detail` adds `exec`, `stop`, `stdout_bytes`, `stderr_bytes`,
  `duration_ms`, `cancelled`. A non-zero `exit_code` is a result, not a refusal.
- **Command:** `--stream` writes the command's output to stdout and stderr and exits
  with the command's own exit code (125 still means LayerFS refused). Without it, the
  result JSON is printed on stdout and the CLI exits with the command's exit code.
  Note: there is **no** `--exec-id` and **no** `-m`/`--message` on `workspace exec`.
- **SDK:** `stream: true` writes output to this process's stdout and stderr;
  `stdout` / `stderr` callbacks receive chunks (`string` or `Buffer`).
- **Stdin:** pass `--stdin` (CLI reads stdin whole) or `{ stdin }` (SDK string or
  `Buffer`). Without it, the command reads `/dev/null`.
- LayerFS generates every exec id (`exec-` + 16 hex chars); `--progress` /
  `on_progress` emits `{ phase: "start", done: 0, total: 1, exec: "exec-…" }` before
  the command starts.

**Limits**

- **No timeout:** put `timeout 110` inside the command, or run the exec with bash's
  `run_in_background` and collect it later. A native macOS Sandbox has no `timeout`:
  use `perl -e 'alarm shift; exec @ARGV' 110 <command>` there (`command -v timeout`
  tells you which).
- **Output is delivered after the command ends**, never live. For long logs, redirect
  to `/tmp` and read the tail in a second exec:

  ```js
  await layerfs.workspace.exec(workspace, "mkdir -p /tmp/build && timeout 110 npm run build >/tmp/build/log 2>&1; echo $? >/tmp/build/code");
  const tail = await layerfs.workspace.exec(workspace, "cat /tmp/build/code; tail -n 60 /tmp/build/log");
  ```

- It waits until everything holding its output has ended, background jobs included.
  Start a server, probe it and stop it in **one** exec, its output redirected to `/tmp`.
- Tools come from the Sandbox: check with `command -v node python3 git rg`.

**Refusals:** `NotFound` (`NoSuchSandbox` or `NotMounted`), `Unknown` (the reply was
lost — the command may have started and may still run; refusal carries `exec` and a
`fix` naming `workspace cancel --exec`), `Unavailable`.

## `workspace cancel`

Ends every command running in the Workspace, or the one `--exec <id>` names:
SIGTERM, then SIGKILL after 5 s (there is no `--grace-ms`). Short answers:
`{ signal: "SIGTERM" | "SIGKILL" }`, `{ already_ended: true }`, or `{ unknown: true }`.
Long form adds `outcome` and `commands`.

```bash
layerfs workspace cancel "$ws"
layerfs workspace cancel "$ws" --exec exec-0123456789abcdef
```

## `workspace commit`

**Only for Workspaces you mounted**; dsh commits its own. Saves everything changed in
the Workspace as one Commit on its Branch. If the Branch moved since the mount, it
merges first (unless `--force` is passed). The Workspace stays mounted.

Short answer: `{ commit }` plus, when set, `unchanged: true`, `merged: true`,
`overwritten` (first 20 `/.lww` paths), `overwritten_count` (when past 20). Long form
(`--detail` / `{ detail: true }`) adds `outcome`, `branch`, `parent`, `root`,
`message`, `created_at`, `merged_from`, `displaced`.

| `error` | Meaning | Do |
| --- | --- | --- |
| `Conflict` | The merge with the moved head overlaps (markers are written into the Workspace; nothing is committed) or `expected` missed. Flat: `commit`, `conflicts` (first 20 paths), `conflicts_count` | [Resolve it](../rules/conflicts.md#commit-conflicts) in that Workspace, then commit again |
| `NotFound` | Not mounted (`detail.code: "NotMounted"`) | Use the `workspace` handle from `mount` |

Commit before you unmount, a failing step too, with a message naming the step and its
result: the Commit is the only way what the commands wrote is saved.

## `workspace unmount`

**Only for Workspaces you mounted**; never dsh's. Ends the Workspace (`{"ok":true}`).
The Sandbox keeps running.

| `error` | Meaning | Do |
| --- | --- | --- |
| `Dirty` | Uncommitted changes (flat `changes`, `changes_count`, `pending_merge`, `fix`) | Commit them so the step is recorded; `--discard` only a Workspace you are abandoning |
| `Busy` | A process still runs there (flat `running` exec ids) | Wait for it, or end it (`workspace cancel`) |
| `NotFound` | Already unmounted, or the wrong `workspace` | Nothing to do |

Never pass `discard` or `force` for a Workspace another agent mounted.

## `workspace status`

What a Workspace holds before its next Commit: use it on yours before committing, and
pass `--detail` (`{ detail: true }`) when checking `branch`, `activity`, `overlay`, or
`pending_merge`.

Short answer:

```json
{"changes":[{"path":"/out.txt","change":"added"}],"branch_moved":false}
```

With `--detail` (`{ detail: true }`):

```json
{"changes":[{"path":"/out.txt","change":"added","type":"file"}],"changes_count":null,"partial":false,"branch_moved":false,"state":"ready","op":null,"reason":null,"fix":null,"branch":"work","commit":"12a42768…","base_layer":"32fe4d4e…","branch_head":"12a42768…","activity":"idle","overlay":{"inode_count":2,"entry_count":1},"pending_merge":false}
```

| Field | Availability | Meaning |
| --- | --- | --- |
| `changes`, `changes_count`, `partial`, `branch_moved`, `state`, `op`, `reason`, `fix` | Short (when set) & Long | Pending overlay changes (`added`, `modified`, `removed`), head move flag, state |
| `branch`, `commit`, `base_layer`, `branch_head` | `--detail` only | Mounted Branch, base Commit, and current Branch head |
| `activity` | `--detail` only | `"idle"` or `"busy"` (lowercase) |
| `overlay` | `--detail` only | `{ inode_count, entry_count }` |
| `pending_merge` | `--detail` only | `true` after a `Conflict` while markers remain |

`Unavailable` when the Sandbox's machine is down: tell the user; don't start machines.
