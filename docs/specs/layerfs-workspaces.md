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

One page with three parts, **Project**, **Store** and **Runs on**, in a pane
that is the only thing that scrolls. A left rail lists **Project**, **Store**
and **Machine** with their readiness: a check and what was chosen
(`website`, `SQLite · new · website`, `docker`) when ready, else the part's
number and what is missing in warning ink (`Not named yet`, `Needs a name`,
`Pick a Store`). Clicking a rail item scrolls the pane to that part; the item
of the part on screen is highlighted. The footer says the first missing part
and has Cancel and Create and open (which jumps to the first missing part
instead while one is missing). On a narrow screen the rail becomes a row above
the pane. Opened from the picker, the head has a **‹ Projects** link back to it.

- **Project**: Name (free text; saved as its slug). Import adds Folder
  (absolute path, Browse opens a native dialog).
- **Store**: two kind cards, **SQLite** (feather) and **PostgreSQL**
  (elephant), then **New Store / New connection** or **Existing · N**. New asks
  the Store name (prefilled, `-2`… when taken); a new connection also asks the
  URL without a user or password, and its login (LayerFS 2.0 saved logins):
  **New login** (login name, prefilled with the Store's when no saved login has
  it; user; password typed once) or **Saved · N** (picked from `store auths`).
  The host saves a new login with `store save-auth <login> --user <user>
  --password-stdin` (the password on stdin, never in argv or a log), refuses a
  name a saved login has (never overwrites it), then runs `store connect
  <store> <url> --auth <login>`; if LayerFS refuses that connect, the new login
  is removed again (`store remove-auth`), and an unknown outcome keeps it. A
  stopped Create shows Refused (or No answer) and the step, LayerFS's words as
  the dot's tip, and one action, Edit, which scrolls to the part to change.
  Existing shows one searchable list of that kind's Stores (`name`, then
  `<machine> · N projects` or `<server> · N projects`); the kind icon is on the
  card only, not repeated on rows.
- **Runs on**: machine tiles with the machine's mark (Docker whale, Apple for
  native, Lima…), name, state and a badge (Default, Here now). Both kinds pick one
  (radio). **Default: docker** when it can run the kind, else native. Machines
  that can't run the kind are not offered. A stopped one is offered with a
  line saying Create starts it. **New machine**
  closes the dialog and opens Resources with Add machine open
  (`openStorage(api, 'machines:new')`). Moving an existing SQLite Store warns
  that its other projects move too.
- **Create and open** runs these steps, listed with their state at the top of
  the page; a failure stops there and says which step failed:
  - SQLite, new Store: `POST /api/stores` → Init (`POST /api/projects`, wait) →
    start the machine if stopped → place (`POST /api/machines/<m>/stores`, wait
    the storage job) when not native → open a session.
  - SQLite, existing Store: start its machine if stopped → Init → start the
    target and place when it differs → open.
  - PostgreSQL, new connection: `POST /api/stores/postgresql` (with the
    machine picked, `runsOn`) → Init → start the machine if stopped → open.
    Existing connection: Init → `POST /api/stores/<s>/runs-on` when another
    machine is picked → start it if stopped → open. Nothing is attached.

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
