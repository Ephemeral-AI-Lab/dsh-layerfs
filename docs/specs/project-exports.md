# Project exports to a local folder

A project's committed tree, at a Branch's head or at a Commit, copied into a new
folder on the computer DSH runs on, with progress and a stop. Built on the pinned
CLI's `project export <project> <destination> [--branch B] [--at C] [--progress]`.

## Where it starts

- **Home › Projects**: a project row's `···` menu has **Export main…**. Its dialog
  shows main's head (read when the dialog opens) and a folder; nothing else to
  choose. A link opens the project's History for any other version.
- **Project › History** (and a project session's History tab): the inspector of
  the selected version has **Export latest `<branch>`…** (a Branch head, or an
  empty Branch at its fork point) or **Export this version…** (any other Commit
  or Layer). The folder form and then the progress open inside the inspector.

Both send one fixed Commit and its Branch.

## Host (`src/host/routes/project-exports.ts`)

| Route | Answer |
|---|---|
| `POST /api/project-exports { project, branch?, commit?, folder, name? }` | the `queued` job |
| `GET /api/project-exports[?project=]` | `{ exports }`, newest first |
| `GET /api/project-exports/:id` | one job |
| `POST /api/project-exports/:id/stop` | the job, `stopping` |
| `POST /api/project-exports/:id/reveal` | shows a finished export in Finder (`open -R`) |
| `DELETE /api/project-exports/:id` | forgets an ended job |

Every change is a `project-export { export }` event; byte updates are coalesced
to one per 500 ms per job.

- **Version.** `project.stats --branch B [--at C] --detail` reads the Commit and
  the tree's size first; the export then runs `--branch B --at <that Commit>`.
  A Branch that moves meanwhile changes nothing, and the size is the progress
  total (the CLI's progress reports bytes done, never a total). LayerFS refuses
  an `--at` outside the Branch's history (`NotFound`), so the Branch is always
  sent. `head` says the Commit was the Branch's head when the export started.
- **Destination.** `folder` must be an existing absolute folder outside the
  LayerFS home and this plugin's state. The export makes a new folder in it:
  `name` (default: the project's name for main's head, else
  `<project>-<branch>-<commit8>`), else `name-2`, `name-3`, … — never a folder
  that exists or that a running export holds.
- **Phases.** `queued` (until the CLI starts; the `jobs` lane may hold it),
  then the CLI's `prepare`, `export` (bytes), `finalize`; then `done`,
  `stopped` or `failed` (the refusal). `stopping` after a stop.
- **Stop.** The CLI's process group gets SIGTERM. LayerFS puts the folder in
  place only at `finalize`, so a stopped export leaves nothing. While it
  finalizes, a stop is refused (`Busy`: it is about to finish). A stop that
  reaches a queued job ends its process as soon as it spawns, or before the
  export runs at all. If a folder is there after a stop, the export finished
  first and is reported `done`.
- Ended jobs stay listed for 30 minutes or until dismissed. Running exports
  hold preset admission (`a project export`) and end when the plugin unloads.

## Client (`src/client/exports/`)

One page store (`model.ts`) fed by the list and the events, shared by:

- `ExportDialog` (Home): version, folder (typed, or the native dialog's
  **Choose…** where the host has one), then the progress in place;
  **Run in background** closes it and the row keeps the progress.
- `ExportCell` (Home row's Size cell): a bar, the percent and a stop icon while
  it runs; the size with a check (click: show in Finder) or a warning after.
- `ExportInline` (History inspector) and `ExportChip` (History's dock: ring,
  percent, stop; the outcome for 5 minutes after).
- `ExportProgress`: the phase, a 4 px bar (a sliding segment while nothing is
  measurable), bytes and time left, **Stop** (greyed with "Almost done…" while
  it finalizes), and the outcome with its actions.

A stop from any view stops it for all of them.
