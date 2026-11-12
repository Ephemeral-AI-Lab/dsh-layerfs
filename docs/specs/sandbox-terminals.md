# Sandbox page: one terminal per Workspace

Status: design, not built. Replaces the Sandbox page's Layers view, mount map
and Commands list (`src/client/machines/SandboxDetail.tsx`,
`SandboxWorkspace.tsx`).

## What the page is

A Sandbox is bound to one project (`sandbox.create(project, …)`; mounts send
the project from the Sandbox record, so no other project's Branches can be
mounted). The page shows the Sandbox's Workspaces as terminals, tiled like a
TUI, in DSH's light theme. It shows no overlay, layer or file view.

```
sbpage-box ● Running            On native · project sbpage-v/demo        Diagnose  ⋯
● daemon reachable · 8 of 9 slots free · 5 of 16 Workspaces
┌─────────────────────────────────────────────── ‹ 1 / 2 ›   + New workspace ┐
│ build  main  workspaces/1      ⤢ ⋯ × │ sdk  sdk  workspaces/2       ⤢ ⋯ × │
│ build:workspaces/1 $ cargo fetch      │ sdk:workspaces/2 $ npm test         │
│   Downloaded 42 crates                │   FAIL test/client.test.js          │
│ [exit 0 · 18s]                        │ [exit 1 · 9s]                       │
│ build:workspaces/1 $ ▌                │ sdk:workspaces/2 $ ▌                │
├───────────────────────────────────────┼─────────────────────────────────────┤
│ docs …                                │ api …                               │
└───────────────────────────────────────┴─────────────────────────────────────┘
```

## LayerFS facts it rests on (`origin/layerfs_v2_0_0`)

- **Path = namespace.** `workspace.mount(sandbox, branch, {name})` takes no path. The daemon mounts at `<sandbox dir>/workspaces/<namespace>`. Namespaces start at 1, only count up, and are never reused by a daemon; a new daemon starts at 1 again. On Linux sandboxes the path is in the guest.
- **What can be mounted.** `main` is refused. Any other Branch of the bound project can be mounted, including the same Branch in several Workspaces (no check refuses it). `name` is optional; the name `Exists` and the 16-Workspace `Capacity` limit (`WORKSPACES = 16`) are the only refusals.
- **Workspace ref.** Use `workspaces[].ws` from `sandbox.get` as given (`<sandbox>:<name>`, or `<sandbox>:<path>` when unnamed).
- **What `workspace.exec` does.** It runs `bash -c <line>` in the Workspace directory, with the environment cleared to `PATH` and `HOME=<sandbox>/tmp`. There is no stdin, no PTY and no timeout, and output arrives only when the command ends (inline up to 1 MiB per stream, spooled beyond). Several commands may run at once in one Workspace. `exec_cancel` sends SIGTERM, then SIGKILL after 5 s (exit 128 + signal).
- **Unmount** refuses `Dirty` (uncommitted changes) or `Busy` (`detail.execs`: running commands). `discard` drops changes; `force` also cancels commands.
- **Commit** answers `Committed` (`commit.id`), `UpToDate`, or refuses (`Conflict` writes markers and commits nothing; `HeadMoved`, `Busy`).

## Behaviour

- **Enter** sends exactly the typed line to `workspace.exec <ws> <line>`, through `POST /api/workspaces/<ws>/commands`. Nothing is wrapped and no working directory is carried: every line starts in the Workspace directory, and `cd` lasts one line (stated in the pane's hint).
- **Transcript.**
  - Each command shows as a prompt `<name or n>:workspaces/<n> $ <line>`, then stdout, then stderr (red, with a left rule; the two streams are not interleaved by LayerFS), then a dim line `[exit 0 · 18s]` (red when non-zero).
  - A running command shows `⠋ running 1m 12s — ^C to cancel`.
  - Output past 64 KB per stream shows `… last 64 KB of {total}`; binary output shows `{n} bytes of binary output not shown`.
  - The transcript scrolls inside the pane, sticks to the bottom while you're at the bottom, and offers "↓ New output" otherwise.
- **One command at a time per pane.** The host refuses a second with `409 CommandRunning`. LayerFS would allow more, but a terminal reads clearly with one.
- **Keys.**
  - Enter runs the line.
  - ↑/↓ steps through that Workspace's history.
  - Ctrl+C cancels the running command; when idle with no selection it echoes `^C` and clears the line.
  - Ctrl+L clears the view only; the log is kept.
  - Esc leaves maximize or closes a dialog.
  - Alt+1–4 focuses a pane, Alt+PageUp/PageDown changes the page, and Alt+Enter maximizes.
  - Clicking a pane focuses its prompt unless you're selecting text.
- **Tiling.**
  - Up to 4 panes per page: 1 fills the area, 2 sit side by side, 3 fill a 2×2 with a "+ New workspace" tile, 4 fill a 2×2.
  - More than 4 Workspaces page by 4 (`‹ 1 / 2 ›`).
  - Order is by namespace number, so creation order, stable across reloads and clients.
  - ⤢ maximizes one pane.
  - At 16 Workspaces the New tile and button are disabled ("16 Workspaces is the most a Sandbox holds").
- **Pane head.** Name, branch tag, `workspaces/<n>`, a running dot, then the buttons: ⤢, ⋯ (Commit…, Copy path), × (Close).
- **New workspace.**
  - A form in the next free tile (or a dialog when the page is full) with two fields: Branch, either an existing side branch of the bound project from `branch.list` (main hidden, already-mounted branches allowed) or "New branch from main…" with a name; and an optional Workspace name.
  - Mount calls `POST /api/sandboxes/<name>/workspaces {branch, fork?, name?}`, then opens the new pane, jumps to its page and focuses its prompt.
- **Close (×) = unmount, guided by LayerFS's refusal.**
  1. `DELETE /api/workspaces/<ws>`.
  2. `Dirty`: a dialog offers "Commit, then unmount" (optional message), "Discard and unmount" (`?discard=1`) and Cancel. A refused commit keeps the dialog open with the refusal, and nothing is unmounted.
  3. `Busy` with running commands: a dialog offers "Cancel commands and unmount" (`force`) and Cancel.

  No overlay count is read or shown; the refusal carries what's needed.
- **Sandbox down.**
  - When the Sandbox isn't running or its daemon is not reached, panes show their logs read-only with a notice in the prompt row, and Enter, New and × are disabled.
  - A Workspace unmounted elsewhere leaves on the next read.
  - A command left `running` by a host restart shows `outcome unknown`.

## Look (light theme, DSH tokens only)

| Element | Token or primitive |
|---|---|
| Pane background | `--dsw-alias-markdown-code-block`, as TerminalBlock uses (`bg-layer-*` are plain white in light) |
| Borders | `0.5px solid --dsw-alias-border-l2` |
| Active pane | `--dsw-alias-border-l3` |
| Maximized pane | `--dsw-elevation-panel`, with no border |
| Head row | `--dsw-alias-bg-base` with a bottom hairline |
| Font | `--ds-font-family-code`, 12px |
| Text | `label-primary` |
| Prompt path | `label-tertiary` |
| `$` and running | `state-business-primary` |
| Errors and non-zero exit | `state-error-primary` |
| Success dot | `state-success-primary` |
| Selection | `bg-document-selection` |
| Run state | `StateDot` (`ongoing` / `done` / `error`) |
| Icon buttons | `Button size="sm"` inside a `Tooltip` |
| Branch picker | `Menu` with a `Button` anchor |
| Prompt input | a native `<input>` with no border and a transparent background (`Input` always draws a framed box) |
| Output | `white-space: pre`, shared scrollbars (web-styling.md) |

## Code

**Client.**
- `SandboxDetail.tsx` shrinks to: head, status line, notice, `SandboxTerminals`, Record details.
- New files:
  - `SandboxTerminals.tsx`: grid, pager, New tile and form, and the close and commit dialogs.
  - `TerminalPane.tsx`: head, transcript, prompt.
  - `terminal.ts`: pure helpers plus a small store, so drafts, history and transcripts survive paging and maximize.
- `terminal.ts` holds `orderWorkspaces`, `pageLayout`, `pageOf`, `historyStep` and `transcript`.
- Deleted: `SandboxWorkspace.tsx`, `mountRows`, and the overlay/layer CSS and copy.
- New copy goes under `term*` keys, in en and zh.

**Host** (`routes/commands.ts`, `router.ts`):
- **Per-Workspace logs** at `<home>/job/sandbox-commands/<sandbox>/<hash(ws)>.json`, the newest 50 commands each, 64 KB tail per stream. `GET /api/workspaces/<ws>/commands` lists one Workspace's commands; the per-Sandbox list stays.
- **`409 CommandRunning`** for a second start in a busy Workspace.
- **Binary flag** on output.
- **Log cleanup:** a Workspace's log is deleted on unmount, and a Sandbox's on close, because namespace paths restart at 1 with a new daemon.
- **Force unmount:** `DELETE /api/workspaces/<ws>?force=1`.

## Tests

- **Unit:**
  - `orderWorkspaces` (numeric path order).
  - `pageLayout` for 0, 1, 2, 3, 4, 5, 9 and 16 Workspaces, plus maximize and full.
  - `historyStep`.
  - `transcript` (clear, omitted, binary, unknown).
  - Host: per-Workspace files, 409, cleanup, binary detection.
- **End to end** (side server, `e2eterm-` prefix, cleaned up):
  1. Mount a new forked branch.
  2. Run `echo hi; echo err >&2; exit 3`.
  3. A second start during `sleep 5` gets 409, then cancel.
  4. Run `touch f`, then × leads to `Dirty`, then commit and unmount.
  5. Mount five Workspaces and check paging, Enter, ↑, Ctrl+C and Ctrl+L in a browser.

## Open questions

1. **Pane title:** the Workspace name with `workspaces/<n>` beside it (proposed), or the path alone?
2. **Workspace name:** should it default to the branch name, so refs read `sandbox:build`?
3. **Closing:** should a closed Workspace's transcript be dropped (proposed), or kept greyed until dismissed?

## Noticed elsewhere (not part of this change)

`--dsw-font-mono`, `--dsw-font-family-mono` and `--dsw-alias-border-l` are not defined by DSH, but are used in `storage/HomeCards.module.css`, `storage/HomeOverview.module.css`, `views/sandbox.module.css`, `picker/picker.module.css` and `doctor/Doctor.module.css`. The fix is to use `--ds-font-family-code` and `--dsw-alias-border-l2`.
