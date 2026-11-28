# The LayerFS folder: the LayerFS home and the DSH x LayerFS home

Status: implemented. Replaces the placement rules of `homes.md` §1, §2 and §6
(homes.md keeps §3–§5: runtime, secrets, storage state). Reviewed against the
stock JSONL store, LayerFS `layerfs_v2_0_0`, every path in this repo and the
live 3080 state before it was built.

## 1. Rule

One folder on the machine holds everything LayerFS-related, by owner:

- the **LayerFS home** (`LAYERFS_HOME`): LayerFS's records, runtime, secrets;
- the **DSH x LayerFS home** (`dsh/`): this plugin's LayerFS-related state for
  one DSH install: project conversations, their bindings and call records,
  scratch folders, team runs, the agent wrapper.

DSH's own data (normal sessions, profiles, settings) stays in `DSH_HOME`; the
only file this plugin adds there is the pointer `$DSH_HOME/layerfs.json`.

## 2. Layout

```text
~/.layerfs/                                LayerFS folder
├── layerfs.json  machine/  store/  …      the LayerFS home, while LayerFS defaults to ~/.layerfs (§3)
│   (or home/ once LayerFS's default moves there)
└── dsh/                                   DSH x LayerFS home
    ├── dsh.json                           { version, owner: DSH_HOME, install, migratedFrom?, migratedAt? }
    ├── runtime.json                       runtime pin (the setup modal's picker)
    ├── scratch/                           the Scratch workspace
    │   └── session-<uuid>/                a project session's default scratch folder
    ├── sessions/
    │   ├── state.json                     this machine's session state (bindings, pending choices, mounts)
    │   ├── owners.json                    session → project
    │   ├── deleted.json                   sessions deleted on purpose
    │   ├── projects.json                  known projects by id
    │   ├── backups/                       copies kept by log migrations
    │   └── store/                         the stock JSONL store's root (nothing else may live here)
    │       └── <cwd-key>/session-<uuid>/
    │           ├── session.v4.jsonl       DSH's log
    │           ├── session.lock
    │           └── layerfs/
    │               ├── binding.json       project, Branch, title, checkpoints, archive, read counter
    │               └── calls.jsonl        one line per LayerFS call (tool call → call → versions)
    ├── simulations/<run-id>/              team runs; simulations/scratch/ their agents' folder
    ├── trace/
    │   ├── outputs/<sha1(tag)>.json       call outputs, keyed by the call's tag; raw/ shell tees
    │   └── calls.jsonl                    the stand-in call log (only for a CLI without native logs)
    ├── bin/                               layerfs wrapper, layerfs.mjs, sdk.mjs (regenerated)
    └── tmp/                               sources/, archive-imports/ (short-lived)

$DSH_HOME/layerfs.json                     pointer: { "folder": "<path>" }
```

## 3. Resolution

- **folder**: config `folder` → `DSH_LAYERFS_FOLDER` → pointer → `~/.layerfs`.
- **home**: config `home` → `DSH_LAYERFS_HOME` → `LAYERFS_HOME` → `<folder>/home`
  when it holds `layerfs.json` → `<folder>`. LayerFS's own default is still
  `~/.layerfs`; a container holding only `home/` and `dsh/` is reported by
  every client that defaults there (the bare CLI, MCP, Connect) as an outdated
  home with a fix that moves it aside. So the home stays at `<folder>` until
  LayerFS moves its default; a `dsh/` folder inside a home is ignored by
  LayerFS (its layout check reads only a folder without `layerfs.json`; the
  doctor scans machine/store/sandbox/backup).
- **dsh**: config `state` (or the older `root`) → `DSH_LAYERFS_STATE` →
  `<folder>/dsh`. A `dsh/` owned by another DSH_HOME (`dsh.json` `owner`) is
  never shared: that install uses `<folder>/dsh-<8 hex of its DSH_HOME>`.
- `install` (in dsh.json) names this install in Sandbox names and the runtime
  pin lease. A migrated install keeps the id its old folder had.

## 4. Sessions

- One stock JSONL backend serves every project session at `sessions/store`;
  owners.json routes ids to projects. Listing a project reads owned ids with
  `stat`, never the whole store; a bad log is logged once and skipped.
- The backend groups logs by the session's creation folder (`<cwd-key>`); that
  level is the stock store's and stays.
- A project session's scratch folder is a new `scratch/session-<uuid>/` unless
  the user picks a folder (`sessions.selectScratch`); a picked folder is never
  cleared. The project is never inferred from a folder path.
- LayerFS's per-session files sit in `layerfs/` beside the log, with the same
  formats as before (`binding.json` was `layerfs.json`, `calls.jsonl` was
  `receipts.jsonl`). The project archive format is unchanged.
- Call outputs stay in one tag-keyed folder: host and team-run calls have no
  session, the agent wrapper only knows the tag, and the agent sandbox may write
  outputs but never beside a conversation log.

## 5. Migration

At service start, before anything reads state, when `dsh.json` is missing and
the old folder (`$DSH_HOME/layerfs`, or config `root`) holds state:

1. Copy (APFS clone where possible): runtime.json, sessions.json →
   sessions/state.json, simulations, the project-session indexes,
   migration-backups → sessions/backups, trace/outputs, and each owned session
   `project-sessions/projects/<owner>/sessions/<cwd>/<id>` →
   `sessions/store/<cwd>/<id>`, with `layerfs.json` → `layerfs/binding.json` and
   `receipts.jsonl` → `layerfs/calls.jsonl`.
2. Write `dsh.json` last (owner, the old install id, migratedFrom).
3. Rename the copied entries in the old folder to `<name>.moved` and write
   `MOVED.txt`. The old `scratch/` and `projects/` stay where they are: running
   and past sessions, and DSH's workspace registry, name them by path.

Dropped: store-machines.json, images/, the flat presets files (homes.md §5),
`.bak` files.

## 6. Setup modal

```text
[📁]  Folder                                     Ready   [Open] [Change…]
      ~/.layerfs
        LayerFS home          ~/.layerfs                 Ready
        DSH x LayerFS home    ~/.layerfs/dsh             Ready
```

`setup.status` `folder` gains `root`, `dsh` and `source`; `setup.open {which:
'folder'|'home'|'dsh'}` opens one in the file manager; `setup.folder {path}`
saves the pointer (refused when config or env sets the folder) and takes effect
after a restart.

## 7. Later

- LayerFS: move its default home to `~/.layerfs/home` (with a fallback to a
  legacy `~/.layerfs`), and a supported way to move a home (host Sandboxes
  stopped, daemon path, run owner files and pins rewritten).
- Retire the stand-in call log once every supported CLI has native logs.
- Merge owners.json and deleted.json into one index.
