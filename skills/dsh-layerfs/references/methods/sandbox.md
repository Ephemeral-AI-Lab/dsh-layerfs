# sandbox calls

Part of the `dsh-layerfs` skill. Command examples start with the skill's line
(`layerfs() { "$DSH_LAYERFS_CLI" "$@"; }; P=… B=… SB=…`); SDK examples run in a
script that imported `layerfs` from `$DSH_LAYERFS_SDK` and set `P`, `B`, `SB`.

| Call | Command | SDK |
| --- | --- | --- |
| get | `layerfs sandbox get <sandbox> [--with stats]` | `sandbox.get(sandbox, { with: ["stats"] })` |
| list | `layerfs sandbox list [--project P] [--machine M] [--limit 100] [--cursor C]` | `sandbox.list({ project, machine, limit, cursor })` |
| create | `layerfs sandbox create <project> <name> [--machine M] [--image I] [--mount B] [--progress]` | `sandbox.create(project, name, { machine, image, mount, on_progress })` |
| remove | `layerfs sandbox remove <sandbox> [--force] [--progress]` | `sandbox.remove(sandbox, { force, on_progress })` |
| files | `layerfs sandbox files <sandbox> [path] [--depth 1] [--limit 100] [--cursor C] [--byte-offset 0] [--byte-length 262144]` | `sandbox.files(sandbox, path?, { depth, limit, cursor, byte_offset, byte_length })` |
| log | `layerfs sandbox log <sandbox> [--limit 200] [--cursor C]` | `sandbox.log(sandbox, { limit, cursor })` |
| doctor | `layerfs sandbox doctor <sandbox> [--progress]` | `sandbox.doctor(sandbox, { on_progress })` |

A Sandbox runs one LayerFS daemon on the project's machine and holds up to 16
Workspaces of its project, on any of its Branches (`sandbox.close` is removed in
2.0 — use `sandbox.remove`).

## Your Sandbox is `$SB`

The session has one Sandbox, `$SB`, on the project's machine, running the session
Workspace `$DSH_LAYERFS_WS` (`main`), which records the checkpoints. dsh starts it and
stops it with the session.

- **Mount extra Workspaces in `$SB`** ([workspace mount](workspace.md#workspace-mount))
  while it has room: 16 Workspaces, dsh's own included.
- **Need more room, or a lane of its own?** Create a Sandbox of your own (below).
- **Never remove `$SB`**, and never remove a Sandbox another agent created.
- **When the session closes** (the user closes it, or it idles out), dsh stops `$SB`.
  A Workspace still mounted there then loses its uncommitted changes: commit and
  unmount yours before your turn ends.

## `sandbox get`

Asks the Sandbox's daemon and answers its state plus `workspaces`, its mounted
Workspaces (unpaged — never pass `--page-size`!). This is how you find leftover
Workspaces.

```bash
layerfs sandbox get "$SB" --text
```

```js
const { state, workspaces = [] } = await layerfs.sandbox.get(SB, { detail: true });
for (const w of workspaces) console.log(w.workspace, w.branch, w.state, w.pending_merge);
```

Short answer: `{ state, workspaces?, op?, blocked_by?, reason?, fix?, observed_at? }`.
Long form (`--detail` / `{ detail: true }`) adds `message`, `sandbox`, `project`,
`machine`, `platform`, `image`, `backend`, `route`, `created_at`, `workspace_capacity`.
Sandbox `state` is `ready`, `busy`, `stopped`, `blocked`, `broken`, or `unknown`
(if `stopped`, `blocked`, or `broken`, tell the user; don't start machines).

Each Workspace entry has short `{ workspace, branch, running?, state?, op?, reason?, fix? }`;
`--detail` adds:

| Field | Meaning |
| --- | --- |
| `workspace` | The handle to pass to `workspace` calls (`<sandbox>:<name>`) |
| `branch`, `commit` | Its Branch and the Commit it was mounted at |
| `running` | Whether a command is currently executing inside it |
| `state`, `op` | `ready`, `busy`, `broken`, etc. (anything other than `ready` needs a look before you unmount) |
| `branch_moved` | Its next Commit merges first |
| `pending_merge` | True after a `Conflict` while conflict markers remain in the Workspace |
| `path`, `base_layer`, `mounted_at`, `commands`, `id` | Mount details |

Passing `--with stats` (`with: ["stats"]`) adds `stats.workspaces[].overlay_bytes` and
`stats.daemon_capacity`.

## `sandbox create`

Starts a Sandbox of this project on a machine: one more LayerFS daemon, holding up to 16
Workspaces. Create one when `$SB` is full or a lane of workers should build apart (its
own `/tmp`, CPU and disk accounting). Each Sandbox costs memory on the machine, so
create few and keep them for the run.

```bash
layerfs sandbox create "$P" lane-store --machine docker     # the project's machine: the runtime context names it
```

- **Name** it for its use (`lane-store`), 1 to 63 lowercase letters, digits,
  `_ . -`; never `dsh-…` (dsh's names).
- Pass `--machine <machine>` (an option, not a positional argument; use the runtime
  context's Machine row). It never starts a machine: if the machine is down, tell
  the user (`Unavailable`).
- The Sandbox uses the machine's image, like `$SB`: check `command -v cargo` (or your
  tools) in a first Workspace there.
- Record it in your ledger, and tell the workers that mount there its name.
- Refused `Failed` or `Unavailable` (host policy): this host does not let sessions
  create Sandboxes. Don't retry: use `$SB` for everyone (16 Workspaces) and say so in
  your ledger.

Short answer: `{"ok":true}` (or `{ workspace, path }` when `--mount <branch>` is
passed). Long form adds `outcome`, `sandbox`, `project`, `machine`, `platform`,
`image`, `backend`, `route`, `state` (`"ready"`), `created_at`, `forward_failed`.

## `sandbox remove`

Stops and removes a Sandbox you created, and every Workspace still mounted in it
(only if `--force` is passed; otherwise `InUse` while Workspaces remain mounted).
Remove it only after every Workspace there was committed and unmounted (`sandbox get`
lists none), at the end of its work and before you report. Never remove `$SB`: dsh
removes it with the session.

```bash
layerfs sandbox remove lane-store
```

Short answer: `{"ok":true}` (plus `unmounted`, `left` when applicable); `--detail`
adds `outcome`, `sandbox`.

## `sandbox list`

The project's Sandbox records, one page at a time (`--limit` / `--cursor` ->
`{ items, next_cursor? }`). Always pass `--project "$P"` (`{ project: P }`): `project`
is an option, not a positional argument! Without it, the call lists every project's
Sandboxes.

```bash
layerfs sandbox list --project "$P" --text
```

## `sandbox files`, `sandbox log`, `sandbox doctor`

- `sandbox files <sandbox> [path]`: inspects files in the Sandbox's run folder
  (such as `stdout_file` / `stderr_file` from a large `workspace exec` output).
- `sandbox log <sandbox>`: reads `daemon.log` lines (`--limit` default 200, `--cursor`).
- `sandbox doctor <sandbox>`: read-only diagnostics on the Sandbox and its Workspaces
  (exits `0` once the report is made).
