# dsh-layerfs

LayerFS for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): the
Machines and Storage pages of LayerFS Connect, LayerFS project + scratch-folder
workspaces, a LayerFS session store and per-turn trajectory checkpoints, as one
DSH plugin bundle. DSH itself is not modified.

## What it adds

| Where | What |
| --- | --- |
| Sidebar → **Machines** | LayerFS machines (native, docker, VMs): state, Sandboxes, Stores, spec, start/stop, add machine; the pinned LayerFS runtime (CLI, daemon, home) |
| Sidebar → **Storage** | Stores (SQLite, PostgreSQL), projects (import a folder), files, history and commit diffs, branches, Sandboxes, backups to buckets and restore, Store push/pull/move, home checks; a project's **Sessions** |
| Workspaces | Each LayerFS project is a DSH workspace (its scratch-folder workspace). A **Scratch** workspace holds sessions without a project |
| Every project session | Its own branch `dsh.<session>`, Sandbox and Workspace mount (the working directory) and its own scratch folder that is never saved into the project |
| Turn end | A checkpoint: the Workspace is committed to the branch when the turn changed files |
| Conversation header / right sidebar → **LayerFS** | The session's branch, mount, scratch folder, unsaved changes, checkpoints with their diffs, **Restore files**, **Branch here**, **Checkpoint now** |
| Session store (`sessionStore: layerfs`) | Each project session's log is mirrored into its project (`dsh.session.<session>` branch, `/.dsh/session/`), so it travels with the project; another DSH on the same LayerFS home can list, import and continue it |

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
| `sessionStore` | `layerfs` | `layerfs` mirrors project sessions into their project; `local` keeps only DSH's log |
| `checkpoints` | `turn` | `off` disables per-turn commits |
| `idleMinutes` | `30` | Close an idle session's Sandbox (it reopens on the next turn) |

The bundle also replaces DSH's `sandbox-policy` row with a subclass that makes a
bound session's Workspace mount its workspace-write root.

## Limits

- Session Workspaces run on the **native** machine (macOS loopback NFS, Linux FUSE),
  where the mount is a host path DSH's tools use directly. A project whose SQLite
  Store lives on another machine must be pulled to this host first.
- Restore and branch never rewrite history: a restore forks a new branch from the
  checkpoint and remounts it; the old branch stays.

## Development

See [AGENTS.md](AGENTS.md). Design notes: `../layerfs-connect/docs/dsh-layerfs/`.
