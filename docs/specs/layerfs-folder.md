# The LayerFS folder: the LayerFS home and the DSH x LayerFS home

Status: implemented. Replaces the placement rules of `homes.md` §1, §2 and §6
(homes.md keeps §3–§5: runtime, secrets, storage state). Reviewed against the
stock JSONL store, LayerFS `layerfs_v2_0_0`, every path in this repo and the
live 3080 state before it was built.

## 1. Rule

One folder on the machine holds everything LayerFS-related, by owner:

- the **LayerFS home**: LayerFS's records, runtime, secrets. The folder is
  LayerFS's root (`LAYERFS_ROOT`), and LayerFS finds the home in it;
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
    ├── dsh.json                           { version, owner: DSH_HOME, install, layout: 2 }
    ├── runtime.json                       runtime pin (the setup modal's picker)
    ├── scratch/                           the Scratch workspace
    │   └── session-<uuid>/                a project session's default scratch folder
    ├── sessions/
    │   ├── state.json                     this machine's session state (bindings, pending choices, mounts)
    │   ├── owners.json                    session → project
    │   ├── deleted.json                   sessions deleted on purpose
    │   ├── projects.json                  known projects by id
    │   └── store/                         the stock JSONL store's root (nothing else may live here)
    │       └── <cwd-key>/session-<uuid>/
    │           ├── session.v4.jsonl       DSH's log
    │           ├── session.lock
    │           └── layerfs/
    │               ├── binding.json       project, Branch, title, checkpoints, archive, read counter
    │               └── calls.jsonl        one line per LayerFS call (tool call → call → versions)
    ├── simulations/<run-id>/              team runs; simulations/scratch/ their agents' folder
    ├── trace/
    │   └── outputs/<sha1(tag)>.json       call outputs, keyed by the call's tag; raw/ shell tees
    ├── bin/                               layerfs wrapper, layerfs.mjs, sdk.mjs (regenerated)
    └── tmp/                               sources/, archive-imports/ (short-lived)

$DSH_HOME/layerfs.json                     pointer: { "folder": "<path>" }
```

## 3. Resolution

- **folder** (LayerFS's root): config `folder` → `DSH_LAYERFS_FOLDER` →
  `LAYERFS_ROOT` → pointer → `~/.layerfs`.
- **home**: LayerFS's rule (`layerfs_v2_0_0` from `f83bc8cd8b`): the folder
  itself while it holds `layerfs.json` (a home made before the root layout),
  else `<folder>/home`. There is no separate home override: every CLI call, the
  agent's managed CLI and the agent SDK get `LAYERFS_ROOT=<folder>` and find the
  same home. A `dsh/` folder inside a legacy home is ignored by LayerFS. The
  pinned CLI must have `home move` (the marker of a CLI that reads
  `LAYERFS_ROOT`; an older one reads only `LAYERFS_HOME` and would fall back to
  `~/.layerfs`).
- **dsh**: config `state` → `DSH_LAYERFS_STATE` →
  `<folder>/dsh`. A `dsh/` owned by another DSH_HOME (`dsh.json` `owner`) is
  never shared: that install uses `<folder>/dsh-<8 hex of its DSH_HOME>`.
- `install` (in dsh.json) names this install in Sandbox names and the runtime
  pin lease.

## 4. Sessions

- One stock JSONL backend serves every project session at `sessions/store`;
  owners.json routes ids to projects. Listing a project reads owned ids with
  `stat`, never the whole store; a bad log is logged once and skipped.
- The backend groups logs by the session's creation folder (`<cwd-key>`); that
  level is the stock store's and stays.
- A project session's scratch folder is a new `scratch/session-<uuid>/` unless
  the user picks a folder (`sessions.selectScratch`); a picked folder is never
  cleared. The project is never inferred from a folder path.
- LayerFS's per-session files sit in `layerfs/` beside the log: `binding.json`
  (metadata only) and `calls.jsonl` (one line per recorded call). The project
  archive format is unchanged.
- Call outputs stay in one tag-keyed folder: host and team-run calls have no
  session, the agent wrapper only knows the tag, and the agent sandbox may write
  outputs but never beside a conversation log.

## 5. Layout version

`dsh.json` `layout` is the layout above (2). Only that layout is read: there is
no code for older ones (the flat `$DSH_HOME/layerfs` folder, `layerfs.json` /
`receipts.jsonl` beside a log, calls kept inside the binding, the Scratch
project, per-project anchor workspaces). Installs that had them were converted
once, and the old folder removed, by a one-shot migrator that has since been
deleted.

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
- Merge owners.json and deleted.json into one index.
