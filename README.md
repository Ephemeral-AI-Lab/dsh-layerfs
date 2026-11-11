# dsh-layerfs

LayerFS for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): the
Machines and Storage pages of LayerFS Connect and one session mode, as in Connect:
every session works in a LayerFS project + its own scratch folder, with a LayerFS
session store and per-turn trajectory checkpoints. One DSH plugin bundle; DSH itself
is not modified.

## What it adds

| Where | What |
| --- | --- |
| Sidebar → **Machines** | LayerFS machines (native, docker, VMs): state, Sandboxes, Stores, spec, start/stop, add machine; the pinned LayerFS runtime (CLI, daemon, home) |
| Sidebar → **Storage** | Stores (SQLite, PostgreSQL), projects (import a folder), files, history and commit diffs, branches, Sandboxes, backups to buckets and restore, Store push/pull/move, home checks; a project's **Sessions** |
| Sidebar → **Presets** | LayerFS Connect's Studio project library (4 machines, 4 stores, 8 projects with dense branch/merge/publish histories) built into this LayerFS home: the machine → store → project plan, each project's paged CLI script, Filesystem or Mixed (workspace exec/commit) mode, **Build projects** and **Reset**, with real stage/count progress and a job log |
| Workspaces | Each LayerFS project is a DSH workspace (its scratch-folder workspace). **Add workspace** picks (or creates) a LayerFS project instead of a host folder |
| Every session | Its own branch `dsh.<session>`, Sandbox and Workspace mount (the working directory) and its own scratch folder that is never saved into the project. A session with no project of its own (the **Scratch** workspace, DSH's default workspace) works the same way in the Scratch project `dsh-scratch/scratch`, made on first use |
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
| `directory-picker` | Disabled: the add-workspace flows pick a LayerFS project (the plugin fills ui-workspace's directory-flow holes) |
| `sandbox-policy` | Replaced by a subclass that makes a bound session's Workspace mount its workspace-write root |

A step only runs in the session's mounted Workspace: when the Workspace cannot be
bound, the turn fails with LayerFS's reason. A session that already ran in a host
folder before dsh-layerfs (a legacy session) is refused with how to continue
(import the folder as a project), never moved.

## Limits

- **Presets Build and Reset empty this LayerFS home first**: every store (with its
  projects, branches, files and the session logs mirrored into them), sandbox,
  workspace and custom machine. The confirmation lists the detected inventory and the
  DSH project workspaces that are dropped; it is refused while a project session has an
  open Sandbox (close it first) or a storage job, import or doctor run is active. While
  a build runs, other changes are refused and new project sessions wait; pages stay
  readable. Studio needs Docker and Lima with a matching Linux bundle; Mixed mode also
  needs the matching native daemon.

- Session Workspaces run on the **native** machine (macOS loopback NFS, Linux FUSE),
  where the mount is a host path DSH's tools use directly. A project whose SQLite
  Store lives on another machine must be pulled to this host first.
- Restore and branch never rewrite history: a restore forks a new branch from the
  checkpoint and remounts it; the old branch stays.

## Development

See [AGENTS.md](AGENTS.md). Design notes: `../layerfs-connect/docs/dsh-layerfs/`.
