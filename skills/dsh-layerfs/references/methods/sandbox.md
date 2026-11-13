# sandbox calls

Part of the `dsh-layerfs` skill. Command examples start with the skill's line
(`layerfs() { "$DSH_LAYERFS_CLI" "$@"; }; P=… B=… SB=…`); SDK examples run in a
script that imported `layerfs` from `$DSH_LAYERFS_SDK` and set `P`, `B`, `SB`.

| Call | Command | SDK |
| --- | --- | --- |
| get | `layerfs sandbox get <name> [--page-size N] [--page-pos N]` | `sandbox.get(name, { page_size, page_pos })` |
| list | `layerfs sandbox list <project> [--page-size N] [--page-pos N]` | `sandbox.list(project, { page_size, page_pos })` |
| create, close | not for sessions (below) | |

A Sandbox runs one LayerFS daemon on the project's machine and holds up to 16
Workspaces of its project, on any of its Branches.

## Your Sandbox is `$SB`

The session has one Sandbox, `$SB`, on the project's machine, running the session
Workspace `$DSH_LAYERFS_WS` (`main`), which records the checkpoints. dsh starts it and
stops it with the session.

- **Mount every extra Workspace in `$SB`** ([workspace mount](workspace.md#workspace-mount)).
  It holds 16 Workspaces, dsh's own included.
- **You can't create or close Sandboxes.** A session's shell may write only its own
  Sandbox's records in the LayerFS home, so `sandbox create` and `sandbox close` from
  the session fail. On `Capacity`, unmount Workspaces you are done with; if `$SB` is
  still full, stop and tell the user.
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

## `sandbox list`

The project's Sandbox records, one page at a time. Always pass `$P`: without it the
call lists every project's. It reads records only, so a Sandbox whose daemon ended
still reads `running`; `sandbox get` asks the daemon.

```bash
layerfs sandbox list "$P" --text
```
