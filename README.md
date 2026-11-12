# dsh-layerfs

LayerFS for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): the
Machines and Storage pages of LayerFS Connect and its project session mode — a
project session belongs to a LayerFS project and uses the selected local folder
as scratch, with native DSH conversation logs and per-turn checkpoints. Normal
sessions belong to DSH workspaces and retain stock behavior. One DSH plugin bundle; DSH itself is not modified.

## What it adds

| Where | What |
| --- | --- |
| Sidebar → **Machines** | LayerFS machines (native, docker, VMs): state, Sandboxes, Stores, spec, start/stop, add machine; the pinned LayerFS runtime (CLI, daemon, home) |
| Sidebar → **Resources** | Stores (SQLite, PostgreSQL), projects (import a folder), files, history and commit diffs, branches, Sandboxes, backups to buckets and restore, Store push/pull/move, home checks; a project's **Sessions** |
| Sidebar → **Settings** → Presets | LayerFS Connect's Studio project library (4 machines, 4 stores, 8 projects with dense branch/merge/publish histories) built into this LayerFS home: the machine → store → project plan, each project's paged CLI script, Filesystem or Mixed (workspace exec/commit) mode, **Build projects** and **Reset**, with real stage/count progress and a job log |
| Sidebar → **Projects** | Every LayerFS project as a card holding its sessions; **New session** per project, **New empty project** / **Import project…** in the header, sessions stored in a project open by id |
| New Session row | Choose **No project** for a normal workspace session or select a LayerFS project. The local folder chooser remains visible; in project mode that folder is scratch. Choose another project, create an empty project, or import one from a host folder before the first turn |
| Project sessions | Owned and listed by the LayerFS project, with a private execution context. The selected local folder is scratch, even if it is also a DSH workspace. Local shell commands run in scratch; project commands use the managed LayerFS CLI. Scratch is never checkpointed or deleted on session close/forget |
| Turn end | A checkpoint: the Workspace is committed to the branch when the turn changed files |
| Conversation tabs → **Files**, **History**, **Sandbox** | Project sessions only: the project's files on the session branch (with the unsaved count), its history graph, and a map of agents → branches → sandbox workspaces that replays their LayerFS calls. These tabs have no composer. Normal workspace sessions keep only Chat and Trajectory ([spec](docs/specs/conversation-views.md)) |
| Session store | Project conversations use unpacked native DSH JSONL under `$DSH_HOME/layerfs/project-sessions`, with additive `layerfs.json` annotations. Logs and annotations are archived inside the project for portability; normal logs remain under `$DSH_HOME/sessions`. |
| Conversation activity | SDK and managed CLI invocation receipts link exact tool-call IDs to confirmed saved versions. `workspace.exec` has no checkpoint links; automatic saves appear separately. Saved-version labels open immutable project files |

DSH's own **Fork** of a project session also starts its files from the checkpoint
at the fork point. Subagents share their parent's project execution context.
Changing the owner after work starts requires a new session.

## Install

```sh
pnpm --dir /path/to/dsh-layerfs install   # or npm install
node scripts/build.mjs
dsh plugin --profile web add link:/path/to/dsh-layerfs
```

Pin LayerFS 2.0 (CLI and matching daemon) with `DSH_LAYERFS_CLI` / `DSH_LAYERFS_DAEMON`,
or later on Machines → LayerFS runtime → Change, which installs the CLI, daemon and
bundle into the LayerFS home (`runtime/<version>-<sha>/`) and pins those copies.
The LayerFS home is LayerFS's own, apart from DSH: `~/.layerfs` by default
(`DSH_LAYERFS_HOME`, then `LAYERFS_HOME`, override it). It holds LayerFS's records,
its runtime, the secrets entered in the panel (`secret/`) and storage
jobs, statistics and Presets state (`job/`, `stat/`, `preset/`, named for no client); the bucket list
is read from LayerFS's records in the home. This plugin's per-install state
(runtime pin, session bindings, scratch) stays in `$DSH_HOME/layerfs`. See [docs/specs/homes.md](docs/specs/homes.md).

### Configuration (`layerfs` row in `cordis.patch.yml`)

| Key | Default | Meaning |
| --- | --- | --- |
| `root` | `$DSH_HOME/layerfs` | Plugin runtime settings, legacy anchors, execution bindings and receipt spool |
| `projectSessionHome` | `$DSH_HOME/layerfs/project-sessions` | Unpacked project conversation storage; `DSH_LAYERFS_SESSION_HOME` overrides the default |
| `cli`, `daemon`, `bundle` | unset | Explicit pins (otherwise saved setting, then env, then the newest runtime installed in the LayerFS home) |
| `cacheHome` | unset | The XDG cache home holding prepared VM OS images (`<cacheHome>/layerfs/machine-images`, built by LayerFS `tools/machine_image.py`), passed to every CLI as `XDG_CACHE_HOME`. Otherwise the saved setting (Machines → LayerFS runtime), then `DSH_LAYERFS_CACHE_HOME`, then the host's own `XDG_CACHE_HOME`. Without a prepared image, a new Lima machine boots the stock Ubuntu image (about 30 s instead of about 9 s) |
| `home` | `~/.layerfs` | The LayerFS home (`DSH_LAYERFS_HOME`, then `LAYERFS_HOME`, override the default) |
| `secrets` | `<home>/secret` | Where bucket keys and PostgreSQL passwords entered in the panel are saved (owner-only files LayerFS reads through `file:` references); `DSH_LAYERFS_SECRETS` overrides the default. A bucket keeps the key file it was connected with; only new saves use a changed folder |
| `scratchProject` | `dsh-scratch/scratch` | Legacy Scratch-project identity; normal sessions do not bind to it |
| `checkpoints` | `turn` | `off` disables per-turn commits |
| `idleMinutes` | `30` | Close an idle session's Sandbox (it reopens on the next turn) |

The bundle patch changes the following DSH rows:

| Row | Change |
| --- | --- |
| `session-persistence-jsonl` | Replaced by `layerfs-session-persistence`: stock JSONL stays the normal-session backend; project ownership routes native unpacked logs to a separate root. Missing project logs can be imported from the project archive |
| `sandbox-policy` | Replaced by a subclass that keeps selected scratch as the local working root and allows the bound project mount, private LayerFS runtime, and invocation receipts; normal sessions retain stock policy |

A project session's step requires its project execution context to be ready:
when it cannot be bound, the turn fails with LayerFS's reason. A session without a
project placement is simply a plain DSH session — nothing is bound, refused
or moved.

## Limits

- **Presets Reset force-stops this home's machines** without starting them or
  cascading through resource removal. Machines, Stores, projects, committed history,
  conversation logs and scratch folders remain. Running work ends; uncommitted
  Workspace changes may be lost. The confirmed action immediately returns a tracked
  job with per-machine progress. Reset requires the pinned CLI to advertise the
  boolean `force` option for `machine.stop` in `help --json`. Unsupported runtimes
  are rejected before confirmation and checked again before execution. Select a
  compatible CLI and matching daemon under Machines → LayerFS runtime → Change;
  Reset never silently substitutes ordinary Stop.
- **Build projects clears and rebuilds this LayerFS home**: every Store (including
  its project archives), Sandbox, Workspace and custom machine is removed before
  creating the library. Its separate confirmation lists that destructive scope.
  Studio needs Docker and Lima with a matching Linux bundle; Mixed mode also needs
  the matching native daemon.

- Project execution runs on the project's machine. On native machines a host
  mount is available; remote mounts stay inside their Sandbox. On both, local
  commands use the selected scratch folder and project commands use
  `"$DSH_LAYERFS_CLI" workspace exec "$DSH_LAYERFS_WS" '<command>' --stream`.
  A generated scratch folder is only a fallback. User-selected folders can be
  shared with other sessions and are never treated as disposable.
- CLI tracing covers the managed CLI entry point. Direct calls to another binary
  are not observed. Unknown command grammar or uncertain results receive no
  invented checkpoint links. DSH's native tool cards remain unchanged; additive
  activity is rendered at the conversation turn tail through a public slot.
- Restore and branch never rewrite history: a restore forks a new branch from the
  checkpoint and remounts it; the old branch stays.

## Development

Specification: [Project sessions and conversation handling](docs/specs/project-sessions.md).

### Project action scripts

`/simulation --project design --machine native [--mixed]` prepares a fresh
Store/project and opens ordinary project conversations. Each parent and child
uses its own script as its model, with real DSH tool calls and the same native
session logs and LayerFS annotations as other project sessions. The conversation
header offers **View script**; there is no separate progress dashboard.

The normal **Stop** button cancels script dispatch and its active descendants
(stopping a child stops its root family); other conversations keep going. Once a
script ends for any reason (completed, stopped, interrupted by a restart or
import, or failed) it never runs again, the session is not locked, and its real
model is selected again. Follow-up messages continue the same session from the
pinned saved version of a clean completion or stop, otherwise from the project's
current main, like a new session. `/simulation` refuses to start, creating
nothing, unless a usable real model is selected.

Script activation and restoration are session-local and leave the global model
default alone. DSH currently exposes no public admission hook to disable all
manual model-selection entry points during execution; an unexpected active
route is rejected before script tools can continue. This UI lock requirement
remains a host integration limitation.

Design: [Model-like simulation](docs/specs/model-like-simulation.md). Bounded
browser fixtures require a private dev server with
`DSH_LAYERFS_SIMULATION_FIXTURES=1`; production slash commands run the full recipe.

See [AGENTS.md](AGENTS.md). Earlier design notes: `../layerfs-connect/docs/dsh-layerfs/`.
