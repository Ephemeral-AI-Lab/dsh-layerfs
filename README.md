# dsh-layerfs

LayerFS for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): the
Machines and Storage pages of LayerFS Connect and its project session mode — a
session placed in a LayerFS project works in that project + its own scratch
folder, with a LayerFS session store and per-turn trajectory checkpoints; every
other session is plain DSH. One DSH plugin bundle; DSH itself is not modified.

## What it adds

| Where | What |
| --- | --- |
| Sidebar → **Machines** | LayerFS machines (native, docker, VMs): state, Sandboxes, Stores, spec, start/stop, add machine; the pinned LayerFS runtime (CLI, daemon, home) |
| Sidebar → **Storage** | Stores (SQLite, PostgreSQL), projects (import a folder), files, history and commit diffs, branches, Sandboxes, backups to buckets and restore, Store push/pull/move, home checks; a project's **Sessions** |
| Sidebar → **Presets** | LayerFS Connect's Studio project library (4 machines, 4 stores, 8 projects with dense branch/merge/publish histories) built into this LayerFS home: the machine → store → project plan, each project's paged CLI script, Filesystem or Mixed (workspace exec/commit) mode, **Build projects** and **Reset**, with real stage/count progress and a job log |
| Sidebar → **Projects** | Every LayerFS project as a card holding its sessions; **New session** per project, **New empty project** / **Import project…** in the header, sessions stored in a project open by id |
| New Session row | A LayerFS project chip on the conversation hero: **No project** for a plain workspace session, or the project the session works in — shown in place of DSH's folder chip, since the session's files live in the project. The menu places the session: another project, **No project**, **New empty project** or **Import project…** (a host folder), following the import's progress |
| Project sessions | A session placed in a project keeps the workspace it was opened in — no project workspaces are created. It gets its own branch `dsh.<session>`, Sandbox and Workspace mount (the working directory) and its own scratch folder under `<root>/projects/<store>/<name>/`, never saved into the project. A session without a placement (a folder workspace, DSH's default workspace, the **Scratch** workspace) runs as stock DSH: no binding, no checkpoints, nothing stored |
| Turn end | A checkpoint: the Workspace is committed to the branch when the turn changed files |
| Conversation header / right sidebar → **LayerFS** | The session's branch, mount, scratch folder, unsaved changes, checkpoints with their diffs, **Restore files**, **Branch here**, **Checkpoint now** |
| Session store | Each session's log is mirrored into its project (`dsh.session.<session>` branch, `/.dsh/session/`), so it travels with the project. Another DSH on the same LayerFS home imports a project's sessions when it opens the project, and DSH's session persistence imports a missing session when it is opened |

DSH's own **Fork** of a project session also forks its files from the checkpoint at
the fork point. Subagents share their parent's Workspace.

## Install

```sh
pnpm --dir /path/to/dsh-layerfs install   # or npm install
node scripts/build.mjs
dsh plugin --profile web add link:/path/to/dsh-layerfs
```

Pin LayerFS 2.0 (CLI and matching daemon) with `DSH_LAYERFS_CLI` / `DSH_LAYERFS_DAEMON`,
or later on Machines → LayerFS runtime → Change. The LayerFS home defaults to
`$DSH_HOME/layerfs/home` (`DSH_LAYERFS_HOME` overrides it).

### Configuration (`layerfs` row in `cordis.patch.yml`)

| Key | Default | Meaning |
| --- | --- | --- |
| `root` | `$DSH_HOME/layerfs` | LayerFS home, project scratch-folder workspaces, plugin state |
| `cli`, `daemon`, `home` | unset | Explicit pins (otherwise saved setting, then env) |
| `scratchProject` | `dsh-scratch/scratch` | Where sessions without a project of their own work (a SQLite Store on native, made on first use) |
| `checkpoints` | `turn` | `off` disables per-turn commits |
| `idleMinutes` | `30` | Close an idle session's Sandbox (it reopens on the next turn) |

The bundle patch also changes three DSH rows:

| Row | Change |
| --- | --- |
| `session-persistence-jsonl` | Replaced by `layerfs-session-persistence` (same root): DSH's JSONL backend runs inside it as the local log; a session missing locally is imported from the LayerFS project that stores it |
| `sandbox-policy` | Replaced by a subclass that makes a bound session's Workspace mount its workspace-write root; unbound sessions fall back to the stock policy |

A bound session's step only runs in its mounted Workspace: when the Workspace
cannot be bound, the turn fails with LayerFS's reason. A session without a
project placement is simply a plain DSH session — nothing is bound, refused
or moved.

## Limits

- **Presets Build and Reset empty this LayerFS home first**: every store (with its
  projects, branches, files and the session logs mirrored into them), sandbox,
  workspace and custom machine. The confirmation lists the detected inventory and the
  DSH project workspaces that are dropped; project sessions with an open Sandbox are
  force-closed and their changes discarded. It is refused while a storage job, import
  or doctor run is active. While
  a build runs, other changes are refused and new project sessions wait; pages stay
  readable. Studio needs Docker and Lima with a matching Linux bundle; Mixed mode also
  needs the matching native daemon.

- Session Workspaces run on the project's own machine. On **native** (macOS
  loopback NFS, Linux FUSE) the mount is a host path used as the session's
  working directory. On any other machine the mount lives inside the Sandbox:
  the session works from its host scratch folder and drives the Workspace
  through the LayerFS CLI (`$DSH_LAYERFS_CLI`, e.g.
  `workspace exec "$DSH_LAYERFS_WS" '<command>' --stream`); bound sessions run
  the `layerfs` agent preset (bash + delegation, no host filesystem tools), so
  file tools that would only see the scratch folder are not offered.
- Restore and branch never rewrite history: a restore forks a new branch from the
  checkpoint and remounts it; the old branch stays.

## Development

See [AGENTS.md](AGENTS.md). Design notes: `../layerfs-connect/docs/dsh-layerfs/`.
