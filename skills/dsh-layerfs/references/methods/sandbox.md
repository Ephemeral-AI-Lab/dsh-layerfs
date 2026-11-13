# sandbox calls

Part of the `dsh-layerfs` skill. Command examples start with the skill's line
(`layerfs() { "$DSH_LAYERFS_CLI" "$@"; }; P=… B=… SB=…`); SDK examples run in a
script that imported `layerfs` from `$DSH_LAYERFS_SDK` and set `P`, `B`, `SB`.

| Call | Command | SDK |
| --- | --- | --- |
| get | `layerfs sandbox get <name> [--page-size N] [--page-pos N]` | `sandbox.get(name, { page_size, page_pos })` |
| list | `layerfs sandbox list <project> [--page-size N] [--page-pos N]` | `sandbox.list(project, { page_size, page_pos })` |
| create | `layerfs sandbox create <project> <name> [<machine>]` | `sandbox.create(project, name, machine?)` |
| close | `layerfs sandbox close <name>` | `sandbox.close(name)` |

A Sandbox runs one LayerFS daemon on the project's machine and holds up to 16
Workspaces of its project, on any of its Branches.

## Your Sandbox is `$SB`

The session has one Sandbox, `$SB`, on the project's machine, running the session
Workspace `$DSH_LAYERFS_WS` (`main`), which records the checkpoints. dsh starts it and
stops it with the session.

- **Mount extra Workspaces in `$SB`** ([workspace mount](workspace.md#workspace-mount))
  while it has room: 16 Workspaces, dsh's own included.
- **Need more room, or a lane of its own?** Create a Sandbox of your own (below).
- **Never close `$SB`**, and never close a Sandbox another agent created.
- **When the session closes** (the user closes it, or it idles out), dsh stops `$SB`.
  A Workspace still mounted there then loses its uncommitted changes: commit and
  unmount yours before your turn ends.

## `sandbox get`

Asks the Sandbox's daemon and answers its record plus `workspaces`, one page of its
mounted Workspaces. This is how you find leftover Workspaces.

```bash
layerfs sandbox get "$SB" --page-size 16 --text
```

```js
const { workspaces } = await layerfs.sandbox.get(SB);
for (const w of workspaces) console.log(w.ws, w.branch, w.activity, w.dirty);
```

**Answers** `{ name, project, machine, id, platform, runtime, image, backend, route,
state, workspaces, next_page_pos }`. `state` is `running`, or `creating`, `closing`,
`gone` or `unresolved` (tell the user; don't act on it). Each Workspace entry has:

| Field | Meaning |
| --- | --- |
| `ws` | The handle to pass to `workspace` calls (`<sandbox>:<name>`) |
| `name`, `branch`, `base` | Its name (`main` is dsh's Workspace), Branch and the Commit it was mounted at |
| `activity` | `idle`, `busy`; anything else (`closing`, `uncertain`, `failed`) needs a look before you unmount |
| `head_moved_since_mount` | Its next Commit merges first |
| `dirty`, `pending_merge` | Uncommitted changes (`{ inodes, entries }`; both 0 when clean), and a pending Conflict (markers wait in it) |

When the machine is down, `get` answers `workspaces: []` with `down_reason`: tell the
user; don't start machines.

## `sandbox create`

Starts a Sandbox of this project on a machine: one more LayerFS daemon, holding up to 16
Workspaces. Create one when `$SB` is full or a lane of workers should build apart (its
own `/tmp`, CPU and disk accounting). Each Sandbox costs memory on the machine, so
create few and keep them for the run.

```bash
layerfs sandbox create "$P" lane-store docker     # the project's machine: the runtime context names it
```

- **Name** it for its use (`lane-store`), 1 to 63 lowercase letters, digits,
  `_ . -`; never `dsh-…` (dsh's names).
- Use the project's machine (the runtime context's Machine row). It never starts a
  machine: if the machine is down, tell the user.
- The Sandbox uses the machine's image, like `$SB`: check `command -v cargo` (or your
  tools) in a first Workspace there.
- Record it in your ledger, and tell the workers that mount there its name.
- Refused `Failed` with `Os { code: 1, kind: PermissionDenied }`: this host does not let
  sessions create Sandboxes. Don't retry: use `$SB` for everyone (16 Workspaces) and
  say so in your ledger.

**Answers** `{ name, project, machine, id, platform, runtime, image, backend, route,
state }`; `state: "running"` when it is ready.

## `sandbox close`

Stops a Sandbox you created, and every Workspace still mounted in it, which loses its
uncommitted changes. Close it only after every Workspace there was committed and
unmounted (`sandbox get` lists none), at the end of its work and before you report.
Never close `$SB`: dsh closes it with the session.

```bash
layerfs sandbox close lane-store
```

**Answers** `{ kind: "Closed", sandbox, closed, unknown }`.

## `sandbox list`

The project's Sandbox records, one page at a time. Always pass `$P`: without it the
call lists every project's. It reads records only, so a Sandbox whose daemon ended
still reads `running`; `sandbox get` asks the daemon.

```bash
layerfs sandbox list "$P" --text
```
