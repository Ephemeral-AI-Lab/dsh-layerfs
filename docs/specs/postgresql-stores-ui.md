# PostgreSQL Stores in dsh-layerfs

Status: **implemented** (2026-11-17), built against the calls in
[layerfs-postgresql-connection.md](layerfs-postgresql-connection.md). Not
yet verified against a live runtime: the pinned CLI must be one with
`store.update` and `store.status --machine`.

## 1. The model the UI shows

A PostgreSQL Store is a database on a server, connected once. It is on no
machine. Two things can be said about it and a machine:

- **Runs on**: the one machine its sessions start on. A choice, changed any
  time, with no call to LayerFS.
- **Own connection**: an address or password one machine uses instead of the
  Store's. Offered only when a check from that machine fails.

There is no Attach, no Detach, no "attached" mark and no per-machine check
state. A check is run when asked for and shown once; nothing keeps it.

## 2. Where a Store runs

The plugin keeps the choice in `<root>/store-machines.json`
(`src/host/store-machines.ts`), one machine name per Store, read on every
use. LayerFS records none.

`pgMachineOf(saved, machines, preferred)`:

1. `preferred`: the session's own machine, or one named in the request;
2. else the saved choice, while that machine exists and runs PostgreSQL
   Sandboxes;
3. else `docker`, when it exists and runs them;
4. else the host machine (`macos-host` / `linux-host`).

A default (3, 4) is not written down. Connect saves the machine picked in
the dialog; `POST /api/stores/:s/runs-on` saves a change; Disconnect drops
the entry. A stopped machine can be chosen. Saving a choice starts nothing;
a session starts no machine either, so a stopped one must be started (Create
does it, §6).

Sessions (`sessions/service.ts machineFor`), `POST /api/projects/:p/sandboxes`
and the presets all use it. A preset names one machine per PostgreSQL Store
and hands it to the plugin (`PresetSpec.runsOn`); its script holds no
attach command.

## 3. Host routes

| Route | Does |
| --- | --- |
| `POST /api/stores/postgresql` | `store.connect`. Body: `name`, `url`, `password` \| `passwordValue` \| `passwordFrom`, `synchronousCommit?`, `runsOn?`. |
| `POST /api/stores/:s/connection` | `store.update`. Body: `machine?`, `url?`, `password?` \| `passwordValue?`, `synchronousCommit?`, `clear?`. Without `machine` the Store's own connection; with one, that machine's; `clear` removes it. Nothing to change is refused 400. |
| `GET /api/stores/:s/check?machine=<m>` | `store.status --machine`. Answers `{ machine, host, ok: true, at, version, latencyMs }` or `{ machine, host, ok: false, error }`. A failed check is an answer (200), not a refusal. |
| `POST /api/stores/:s/runs-on` | Body: `machine`. Saves the choice. Refused for a SQLite Store, an unknown machine, or one that runs no PostgreSQL Sandboxes. |
| `POST /api/stores/:s/disconnect` | `store.disconnect`; removes the Store's password files and its saved machine. |

`GET /api/storage` gives each PostgreSQL Store row:

- `postgresql`: `target`, `url`, `server`, `database`, `user`, the host's own
  check (`reachable`, `version`, `latencyMs`, `error`), `password` (the
  reference, or null with `saved: true` when it names a file the host
  wrote) and `synchronousCommit`;
- `runsOn`: §2's answer;
- `ownConnections`: `[{ machine, url, target, password, saved }]`, only the
  machines with a connection of their own.

`GET /api/machines` gives each PostgreSQL Store its `runsOn`; a machine row
has no `postgresql` list.

Password files: `<secrets>/pg-<store>--<random>.pw` (the Store's) and
`pg-<store>--<machine>--<random>.pw` (a machine's own), mode 0600, a new file
per write so a refused call never breaks the file an earlier call recorded.
A passing update removes the older files of that connection, `clear` removes
that machine's, Disconnect removes them all. A typed password never reaches
a view, an event or a log.

## 4. Stores tab (Home and a machine page)

The PostgreSQL tile has one view. There is no Servers / Databases switch and
no server card.

```text
localhost:5432   ● Reachable · 2 ms   layerfs · PG 17        + Add database
┌───────────────────────┐ ┌───────────────────────┐
│ demo-services      ⋯  │ │ demo-experiments   ⋯  │
│ 48 MB  demo_services  │ │ 12 MB  demo_exp…      │
│ Runs on [docker] Change│ │ On [macos-host] Change│
│ api        31 MB ▆▆▆  │ │ trials     12 MB ▆▆▆  │
│ worker     17 MB ▆▆   │ │                       │
└───────────────────────┘ └───────────────────────┘
```

- One thin header per server: address, the host's check (reachable and
  latency, said once for all its databases), user, version, **Add
  database** (Connect a database with that host and user filled in and its
  password reused).
- One card per database: name, size, the database, **Runs on** with
  **Change**, its projects.
- A card says its own status only when it is not its server's: this
  database fails while the server answers. No "Home reaches it" footer.
- Card menu: **Edit connection**, **Check from a machine…**, **Disconnect**.
- **Connect a database** is the tile's button, top right.

A machine page lists the Stores that run on it, and those with a Sandbox on
it now. Its **Connect a database** opens the same dialog with new databases
set to run there.

## 5. Dialogs

**Connect a database** (`storage/ConnectDatabase.tsx`) is the one connect
dialog; New Store's and Add Store's PostgreSQL tiles open it.

1. *Pick*: connected Stores under their server, each with where it runs and
   **Check** (on a machine page, **Run here** for one that runs elsewhere);
   "New database on this server"; "New server".
2. *New*: database, Store name, host, user and password for a new server
   (a pasted URL fills them), **Runs on**, synchronous_commit under More
   options. Connect, then the check from that machine.
3. *Check*: the path the machine dials and three steps (reaches the server,
   finds the Store, may write it), from `GET …/check`. "Check from" picks
   another machine. Only after a failure at the server, and never for the
   LayerFS Home, the machine can be given **its own address**
   (`POST …/connection` with `machine`), then it is checked again.

**Edit connection** (`pg-edit`): the Store's URL, password and
synchronous_commit; or one machine's own URL and password. Only what changed
is sent.

**Where it runs** (`pg-runs-on`): one machine, picked from those that run
PostgreSQL Sandboxes.

## 6. Other pages

- **Store page**: the third tab is **Connection**: the connection (URL,
  password reference, synchronous_commit, the host's check) with Edit and
  Check from a machine; where it runs, with Change; then one row per machine
  with its own connection (Check, Edit, Remove own connection). The
  Overview's fourth tile is Runs on.
- **Project dialog**: both Store kinds pick one machine. Create connects a
  new PostgreSQL Store with it (`connect`), or changes an existing Store's
  (`runs-on:<m>`), then starts that machine if it is stopped; nothing is
  attached. Configure
  changes where the Store runs.
- **Health**: per PostgreSQL Store, "server reachable" (the host's check)
  and the doctor's connection check. No per-machine item.
- **Presets**: the Studio preset's PostgreSQL Stores name one machine each.

## 7. Not built

- A check runs only when asked for; the Overview does not show that a
  machine cannot reach a Store until a session or a check finds out.
- `synchronous_commit` defaults to `local` in LayerFS 2.0 (`store connect`
  writes `local` and `open` sends `SET synchronous_commit = local`); Edit
  connection labels `local` as `local (LayerFS default)` so users can revert to
  LayerFS's default. Leaving `synchronous_commit` unset for the PostgreSQL
  server's own default is not supported by upstream `store update`.
- `environment-reset.js` (copied from Connect) still leaves `pg-*.pw` files.
