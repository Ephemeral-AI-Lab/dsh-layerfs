# LayerFS projects: sidebar and the project dialog

Status: **implemented** (2026-11-13, fifth pass). Covers the sidebar's LayerFS
view, the New Session project menu and the project dialog, one modal that
creates, imports, configures and picks projects. There is no Projects page and
no per-project page.

## 1. The model the UI follows (LayerFS 2.0)

- The LayerFS Home (`~/.layerfs`) holds records only. Nothing runs "in" it.
- `native` is the host's own machine, built in and always running. `docker`
  is built in too; Lima / apple-container machines are made by hand. Nothing
  starts a machine by itself.
- A **SQLite Store** is one file on exactly one machine. `store create` puts it
  on native; `store push` / `store pull` move it (both machines running; the
  whole Store moves, every project in it; refused while one of its projects
  has a Sandbox).
- A **PostgreSQL Store** is on no machine. `store connect` records one
  connection, and any machine that runs PostgreSQL Sandboxes reaches it;
  nothing is attached. The plugin keeps one machine per Store, where its
  sessions run (postgresql-stores-ui.md §2). It belongs to the Store, not one
  project.
- A **project** is `<store>/<name>`. Its sessions run on its SQLite Store's
  machine, or on the machine its PostgreSQL Store runs on (the saved choice,
  else docker, else native).
- `project init` never creates a Store. The UI creates SQLite projects on
  native and then pushes the Store, the order the presets use.

## 2. One dialog

`projectDialog.open(request)` (`src/client/projects/dialog.ts`) shows the
dialog in one of four modes:

| Mode | Opened from |
| --- | --- |
| `new` | sidebar `+` → New project, the sidebar's empty state, New Session menu → New project…, the picker's New project |
| `import` | sidebar `+` → Import a folder…, New Session menu → Import a folder…, the picker |
| `configure` | ⚙ on a sidebar row, a New Session menu row or a picker row |
| `pick` | sidebar `+` → Other project… |

The dialog renders from the first mounted host (the sidebar foot's
`sidebar.footer.action` entry, or the New Session row), so it shows once
wherever it opens. It is a headless `Modal` with its own head: the LayerFS mark
in a tile, the title, one line under it, and Close.

## 3. Create, import and configure

### Create / Import

A short form: a **Name** (and, for an import, the **Folder** above it) and one
**Saved in** line. Most projects need only the name; everything else has a
default the line states. The page scrolls inside a height cap while the head
and the footer stay put. Opened from the picker, the head has a **‹ Projects**
link back to it.

- **Name**: free text, saved as its slug (`Saved as <slug>` shows when they
  differ). An import's name follows the folder's until one is typed.
- **Folder** (import): an absolute path; Browse opens a native dialog. The
  footer's **Start from a folder…** / **Start empty instead** switches between
  the two (the title follows); the dialog opens on the folder for Import a
  folder.
- **Saved in**: the Store's kind mark, its name and kind (`shop · SQLite`, or
  `New SQLite Store website`, `New PostgreSQL connection website`), then the
  machine (`This Mac`, `docker`; for PostgreSQL `sessions run on <machine>`),
  and **Last used** on the last-used Store. **Change** opens the details in
  place (Hide closes them).
  - **Default Store: the last-used one** — the Store of the newest project
    with sessions on this DSH (`projects.recent`, §7; a Create opens a
    session, so the Store of the last project made or worked in). A SQLite
    Store whose machine is stopped stays the default (its Start shows). When
    the last-used Store can't be used (broken, or a PostgreSQL Store that is
    not ready) the default is a new SQLite Store and a line says so, with
    **Show**. With no last-used Store (a first project) it is a new SQLite
    Store named after the project (`-2`… when taken, with a notice).
  - What needs the person shows under the line whether the details are open
    or not: the auto-renamed new Store, the PostgreSQL machine that will be
    attached, the warning that moving an existing SQLite Store moves its
    other projects too, and a named **Start** for each stopped machine Create
    needs (Create starts no machine itself).
- **Details** (Change): one Store list, **Existing** first (the last-used on
  top; mark, name, `<machine> · N projects` or `<server> · N projects`, a
  status tag, and Open Store on a broken one, which can't be picked), then
  **New**: **New SQLite Store** and **Connect PostgreSQL…**. Picking a Store
  sets the kind: there is no separate kind choice. A search box shows above
  more than six Stores. A new Store shows its **Store name**; a new connection
  adds the URL without a user or password, and its User and Password (saved
  by this computer for the Store; the password goes to LayerFS on stdin).
  Then the machine tiles (mark, name, state, a Default or Here now badge):
  **Store file on** for SQLite (choosing another for an existing Store moves
  it), **This session runs on** for PostgreSQL (only machines that run now and
  run PostgreSQL Sandboxes; none is guessed). **New machine** closes the
  dialog and opens Add machine (`openStorage(api, 'machines:new')`).
- **Errors** show at the field, never as a disabled button: an empty name
  (`Enter a name`), a name the chosen Store already has (from its first 20
  project names; LayerFS refuses the rest), an invalid folder, URL or Store
  name. Create and open with something missing focuses the name or opens the
  details at what is missing.
- **Create and open** runs these steps (model.ts `createSteps`), listed with
  their state at the top of the page; a stopped Create shows Refused (or No
  answer), the step, LayerFS's words as the dot's tip, and Edit, which focuses
  the name or opens the details:
  - an import checks the folder first, so a wrong one leaves no empty Store;
  - SQLite: create the Store when new → Init → place it on the chosen machine
    when it differs from where the Store is → open a session;
  - PostgreSQL: connect when new → Init → attach the chosen machine when it is
    not yet → open a session on it.

  On success the dialog closes and the new session is on screen.

### Configure

- Head: the project name and `<store>/<name>` (and ‹ Projects when opened
  from the picker). One pane, the same labels and spacing as Create.
- **Store** card: its mark, name, kind, server for PostgreSQL, how many
  projects share it.
- **SQLite Runs on**: the tiles, the current one marked Here now. Choosing
  another shows the move warning and **Move to <machine>** in the footer, which
  starts both machines if needed and places the Store.
- **PostgreSQL Runs on**: the tiles, the current one marked Here now. Choosing
  another shows **Run on <machine>** in the footer, which saves the choice
  (`POST /api/stores/<s>/runs-on`). Applies to every project in the Store.
- Footer: **Hide from sidebar** (per browser, until the project's next
  session) and Done. A project whose Store is gone says so and offers Open
  Resources.

## 4. Pick

- A search field (project or Store) and every project: LayerFS mark, name,
  Store with its kind mark, the machines it runs on with their marks, and its
  session count, or words when it can't run (Machine stopped, Removed,
  Replaced). Store names carry no kind icon. Projects that can run come first, most used first.
- A row starts a session in the project and closes the dialog; **Start**
  starts a stopped machine; **⚙** (on hover) switches to configure.
- Footer: Import a folder, New project.

## 5. Sidebar (LayerFS view)

- Projects with at least one session on this DSH (`projects.recent`, §7),
  newest activity first; unused drafts count.
- Rows match DSH's own Workspaces list (32px, 14px titles, one 16px leading
  slot): the **LayerFS mark**, swapped for the fold arrow on hover or keyboard
  focus, then the project name. **No status lights.** When it can't run, a few
  words follow the name. Sessions keep an empty leading slot so their titles
  line up under the project's.
- On hover or focus: **⚙** (configure) and **+** (new session); **Start**
  instead of `+` while its machine is stopped.
- Header: the LayerFS switch and `+` (recent projects, Other project…, New
  project, Import a folder…). Nothing under the list: Resources is in the
  LayerFS navigation.

## 6. New Session project menu

- Each project row: the LayerFS mark, the name, and where it runs. The Store
  is in the tooltip. A row picks the project for this session; **⚙** (on
  hover) opens configure.
- New project… and Import a folder… open the dialog.

## 7. Projects with sessions (`projects.recent`)

A host operation answering `{ projects: [{ project, projectId, lastActivity,
newestSession, sessionIds }] }` from this DSH's own records (bindings, pending
placements, owned sessions with a local log; not subagents, not the Scratch
project). It never calls LayerFS. `lastActivity` orders rows; `newestSession`
decides when a hidden project shows again.

## 8. Readiness

A project's machine for readiness is its SQLite Store's machine, or for
PostgreSQL the machine its Store runs on (§1; the Store row's `runsOn`), read
from `/api/storage`. Readiness shows as words, never a light.

## 9. Not in scope

- Choosing the machine per session for PostgreSQL projects (the host picks).
- Resuming a Create interrupted by closing the page.
