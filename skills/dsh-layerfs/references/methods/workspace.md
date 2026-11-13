# workspace calls

Part of the `dsh-layerfs` skill. Command examples start with the skill's line
(`layerfs() { "$DSH_LAYERFS_CLI" "$@"; }; P=… B=… SB=…`); SDK examples run in a
script that imported `layerfs` from `$DSH_LAYERFS_SDK` and set `P`, `B`, `SB`.

| Call | Command | SDK |
| --- | --- | --- |
| mount | `layerfs workspace mount <sandbox> <branch> [--name <name>]` | `workspace.mount(sandbox, branch, { name })` |
| exec | `layerfs workspace exec <ws> <command> [-m <msg>] [--stream] [--exec-id <id>]` | `workspace.exec(ws, command, { message, stream, stdout, stderr, exec_id })` |
| exec-cancel | `layerfs workspace exec-cancel <ws> <exec-id> [--grace-ms N]` | `workspace.exec_cancel(ws, exec_id, { grace_ms })` |
| commit | `layerfs workspace commit <ws> [-m <msg>]` | `workspace.commit(ws, { message })` |
| unmount | `layerfs workspace unmount <ws> [--discard]` | `workspace.unmount(ws, { discard })` |
| status | `layerfs workspace status <ws>` | `workspace.status(ws)` |

A Workspace is a complete, writable view of one Branch where ordinary commands run.
You need one only to run commands; read and change files with `file` calls. Each use
goes **mount, exec, commit, unmount**. Everything a command changes in it is saved by
its Commit and nothing else.

## dsh's Workspace and yours

| | dsh's Workspace `$DSH_LAYERFS_WS` (`<sandbox>:main`) | A Workspace you mount |
| --- | --- | --- |
| Mounted by | dsh, for the whole session | You, with `workspace mount` |
| Branch | The session Branch `$B` | `$B`, or any Branch of the project but `main` and other `dsh.…` Branches |
| Committed by | dsh, to record each checkpoint | You, after the commands that changed files |
| You may | `status`, nothing else | Every call |
| Lives | The whole session | One step: unmount it before your turn ends, or it is lost with its changes when the session's Sandbox stops |
| Sandbox | `$SB` | `$SB` too: sessions can't create Sandboxes. At most 16 Workspaces, dsh's included |

## Shared rules

- A Workspace is named `<sandbox>:<name>`: the `ws` field of `mount`'s result. Give
  every mount a `name` for its step (`test-cart`, `w-p1`), so its handle is
  `$SB:<name>` without parsing. Without a name it is `<sandbox>:<path>`. Never use a
  handle after its unmount.
- **The mount path is new for every mount** (`mount` answers it as `path`). Commands
  run at the Workspace root: use relative paths, and never write the mount path into a
  command, a script, a config file or a build flag.
- **Each mount is a new Workspace**, even on the same Branch, with its own uncommitted
  changes. Mounting is cheap: it copies nothing.
- **The view moves only at a Commit.** Between Commits it shows the Branch as it was
  when mounted (or last committed): later `file` writes and other Workspaces' Commits
  don't appear. A `commit` merges in what moved and leaves the Workspace showing the
  new head, also when it answers `UpToDate`.
- **Everything in it is committed:** sources, `.git`, `node_modules`, build output and
  caches. Throwaway files belong in `/tmp`, outside it.
- Keep each Workspace's calls one after another, never two at once.
- While its Sandbox is being created or closed, `mount`, `exec`, `commit` and
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
const { ws } = await layerfs.workspace.mount(SB, B, { name: "test-all" });
try {
  const run = await layerfs.workspace.exec(ws, "timeout 110 npm test 2>&1");
  await layerfs.workspace.commit(ws, { message: `npm test (exit ${run.exit_code})` });
} finally {
  await layerfs.workspace.unmount(ws);
}
```

Several commands may share one mount and one Commit (install, build, test). Keep a
Workspace mounted across bash calls only for work that has to keep running between
them (a long build reused step by step, a dev server), and unmount it as soon as that
work is done.

## `workspace mount`

Mounts the Branch's head as it is now in the named Sandbox. Mount in the session
Sandbox `$SB` unless it is full. It never starts a Sandbox. `main` is refused: fork a
Branch from it and mount that. `name` is 1 to 63 lowercase letters, digits, `_ . -`,
unique in the Sandbox while mounted; `main` is dsh's.

**Answers:** `ws` (pass this on), `name`, `kind: "Mounted"`, `path` (inside the
Sandbox; don't use it in commands), `branch`, `base` (the Commit it shows),
`base_layer`, `root`, `sandbox`, `image`, `platform`.

| Code | Meaning | Do |
| --- | --- | --- |
| `NoSuchSandbox` | No Sandbox of that name, or its daemon ended | Check the name; `sandbox get` |
| `InvalidInput` | `main` ("the project's published line"), or a name that is no Branch | Fork a Branch and mount that; `branch list` |
| `Exists` | A Workspace of that `name` is mounted | Pick another name |
| `Capacity` | The Sandbox holds 16 Workspaces, dsh's included | Unmount Workspaces of yours you're done with; if it is still full, stop and tell the user ([sandbox](sandbox.md)) |
| `Failed` | The mount failed | Stop and report |

## `workspace exec`

Runs one command with `bash -c` in the Workspace root and waits for it to end. Use
relative paths (`src/cart.js`), never the mount path. `HOME` is a private folder of
the Sandbox.

- **Answer:** `{ kind: "exit:<code>", exit_code, stdout, stderr, exec_id }`. Each
  stream comes back whole up to 1 MiB; a bigger stream is `null` there and arrives
  only through streaming. A non-zero `exit_code` is a result, not a refusal.
- **Command:** `--stream` writes the command's output to your stdout and stderr and
  exits with the command's own exit code (125 still means LayerFS refused). Without
  it the answer is printed as JSON and the exit code is 0.
- **SDK:** `stream: true` writes the output to this process's stdout and stderr;
  `stdout` and `stderr` functions get each piece (a string, or a `Buffer` when not
  UTF-8) instead.
- `message` labels the step in the call log; it creates no Commit.

**Limits**

- **No stdin.** The command does not get your stdin: `… | layerfs workspace exec
  "$ws" 'cat > f'` writes an empty file. Send content as base64 (below).
- **No timeout:** put `timeout 110` inside the command, or run the exec with bash's
  `run_in_background` and collect it later. A native macOS Sandbox has no `timeout`:
  use `perl -e 'alarm shift; exec @ARGV' 110 <command>` there (`command -v timeout`
  tells you which).
- **Output comes when the command ends**, not live. For long logs, redirect to `/tmp`
  and read the end in a second exec:

  ```js
  await layerfs.workspace.exec(ws, "mkdir -p /tmp/build && timeout 110 npm run build >/tmp/build/log 2>&1; echo $? >/tmp/build/code");
  const tail = await layerfs.workspace.exec(ws, "cat /tmp/build/code; tail -n 60 /tmp/build/log");
  ```

- It waits until everything holding its output has ended, background jobs included.
  Start a server, probe it and stop it in **one** exec, its output redirected to `/tmp`.
- Tools come from the Sandbox: check with `command -v node python3 git rg`.

**Files:** write them with `file` calls before you mount. When a command really needs
content from your local folder (a script to run, a fixture), send it as base64 inside
the command:

```bash
b64=$(base64 < ./draft/migrate.sh | tr -d '\n')
layerfs workspace exec "$ws" "printf %s '$b64' | base64 -d > /tmp/migrate.sh && bash /tmp/migrate.sh"
```

**Refusals:** `NoSuchSandbox` (the Sandbox is gone, and its Workspaces with it),
`NotMounted`, `Unknown` (the exit code is not known: the command may or may not have
run; look before running it again).

## `workspace exec-cancel`

Ends a running command: SIGTERM, then SIGKILL after `grace_ms`. Give a command your
own `exec_id` when you start it, so you can stop it from another call.

```bash
layerfs workspace exec "$ws" 'npm run watch' --exec-id watch-1 --stream   # in a background bash call
layerfs workspace exec-cancel "$ws" watch-1 --grace-ms 2000
```

## `workspace commit`

**Only for Workspaces you mounted**; dsh commits its own. Saves everything changed in the Workspace as one Commit on its Branch. If
the Branch moved since the mount, it merges first. The Workspace stays mounted.

| `kind` | Fields | Meaning |
| --- | --- | --- |
| `Committed` | `head`, `commit`, `merged`, `lww` | A new Commit. `merged` is `{ from, head }` when a merge ran. `lww` lists files decided by [`/.lww`](../rules/lww.md) |
| `UpToDate` | `head`, `root`, `merged`, `lww` | Nothing changed; no Commit |

| Code | Meaning | Do |
| --- | --- | --- |
| `Conflict` | The merge with the moved head overlaps. Markers are written into the Workspace; nothing is committed | [Resolve it](../rules/conflicts.md#commit-conflicts) in that Workspace, then commit again |
| `NotMounted` | Not mounted | Use the `ws` from `mount` |

Commit before you unmount, a failing step too, with a message naming the step and its
result: the Commit is the only way what the commands wrote is saved.

## `workspace unmount`

**Only for Workspaces you mounted**; never dsh's. Ends the Workspace.
The Sandbox keeps running.

| Code | Meaning | Do |
| --- | --- | --- |
| `Dirty` | Uncommitted changes (`detail.changed` lists paths) | Commit them so the step is recorded; `discard` only a Workspace you are abandoning |
| `Busy` | A process still runs there | Wait for it, or end it (`exec-cancel`) |
| `NotMounted` | Already unmounted, or the wrong `ws` | Nothing to do |

Never pass `discard` for a Workspace another agent mounted.

## `workspace status`

What a Workspace holds before its next Commit: use it on yours before committing, and
to find a Workspace you lost track of (`$SB:<name>`).

```json
{"kind":"ok","branch":"work","base":"12a42768…","base_layer":"32fe4d4e…","branch_head":"12a42768…",
 "head_moved_since_mount":false,"activity":"Idle","overlay":{"inodes":2,"entries":1,"pending_merge":false}}
```

| Field | Meaning |
| --- | --- |
| `branch`, `base` | The Branch and the Commit it was mounted at |
| `branch_head` | The Branch's head now |
| `head_moved_since_mount` | `true` when its next Commit merges first |
| `activity` | `Idle`, or `Busy` while a Commit or mount runs. Capitalized here, lowercase in `sandbox get`: compare with `.toLowerCase()` |
| `overlay` | Changed files (`inodes`) and folder entries (`entries`); `pending_merge` after a Conflict |

`Unavailable` when the Sandbox's machine is down: tell the user; don't start machines.
