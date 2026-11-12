# PostgreSQL Stores in dsh-layerfs

Status: **implemented** (2026-11-12) except where "As built" says
otherwise. Attach and Detach need `store.attach` / `store.detach` from
[layerfs-postgresql-attach.md](layerfs-postgresql-attach.md) in the pinned
CLI; the host detects them from the CLI's call table
(`StorageView.features.attach`).

As built:

- Password files are `<secrets>/pg-<store>--<random>.pw` (the Store's; `<secrets>`
  is config `secrets` / `DSH_LAYERFS_SECRETS`, default `<root>/secrets`)
  and `pg-<store>--<machine>--<random>.pw` (a machine's own), a new file per
  write so a refused call never breaks the file an earlier call recorded;
  a passing attach removes that machine's older files, detach removes them
  all, disconnect removes the Store's.
- The view's attachment carries the machine's own `url` and `password`
  reference (never a secret) and `saved` when the reference names a file the
  host wrote. Refused attaches to machines not attached are
  `attachRefusals` on the Store row.
- Without `store.attach` in the CLI, the Store shows one unchecked
  attachment, the LayerFS Home, and the Attach controls are hidden (sessions
  run on native, as before).
- The Store page's Machines table has no Sandboxes column; LayerFS's
  `InUse` on Detach names the Sandboxes.
- Not built yet: the New Session / `NewProjectForm` machine choice (§7);
  sessions take the default machine (`pgMachineOf`: the session's own,
  else native, else the first checked, else the first attached).
- `environment-reset.js` (copied from Connect) still leaves `pg-*.pw` files.

## 1. What changes for the user

Today a PostgreSQL Store can only be added from the Storage panel's
"+ New Store" dialog. It then appears as a pretend machine named
"PostgreSQL" under Machines, and the Machines page lists it on every
machine that supports PostgreSQL Sandboxes. Sessions of its projects
always run on `native`.

After this change:

- PostgreSQL gets its own group in the Storage sidebar, next to Backups,
  with a "Connect a database" row. A database is an outside server, like
  a bucket, not a machine.
- Each machine shows the PostgreSQL Stores **attached** to it, beside its
  sqlite Stores.
- A Store's page lists its machines, each with its connection and its last
  check, and attaches more.
- A project session in a PostgreSQL Store runs on a machine the Store is
  attached to.

## 2. Sidebar

```
Overview
MACHINES
  LayerFS Home
    demo-studio                 18.9 MB
    ⛁ team ↗                    ●          attached, checked
  docker
    ⛁ team ↗                    ○          attached, not checked yet
  demo-build
    demo-build-cache            14.7 MB
POSTGRESQL                                   +
  ⛁ team                        db.lan:5432
      api
      load
BACKUPS                                      +
  + Connect a bucket
```

With no PostgreSQL Stores the group shows one dim row, "+ Connect a
database", as Backups shows "+ Connect a bucket".

| Row | Behaviour |
| --- | --- |
| `POSTGRESQL` group | always shown; its `+` opens the Connect dialog (§3); collapsed, it carries the worst signal of its Stores |
| a PostgreSQL Store | the PostgreSQL glyph; meta is the server (`user@host:port/db` without the user when narrow); expands to its projects; opens the Store page; dot: the host's `store.status` server check |
| an attachment, under a machine | the PostgreSQL glyph with a small link mark, never expandable (the projects are under the Store); opens the Store page at its Machines section; dot: `checked` and the latest refusal (§4) |
| drag a PostgreSQL Store onto a machine | opens the Attach dialog with that machine chosen (§5). It is not instant: the machine may need its own connection. Only machines that can take it accept the drop: platform supports PostgreSQL Sandboxes, not already attached, not stopped. Others show why on hover. |

The pretend "PostgreSQL" machine row (`g:postgresql` under `g:machines` in
`Explorer.tsx`) goes; its key moves to the top level.

Search matches a PostgreSQL Store by name, project and server, and shows
its attachments under the machines that matched.

## 3. Connect a database

Opened from the group's `+`, the "Connect a database" row, or "+ New Store"
with PostgreSQL chosen (the existing tile choice in `dialogs.tsx` stays).

| Field | Rules |
| --- | --- |
| Name | as today (`NAME`, not taken) |
| Database URL | `postgresql://user@host:5432/db`; a password in it is refused in the dialog with "Give the password below" before LayerFS refuses it |
| Password | a segmented choice, as buckets' keys: **Enter password**, which the host writes to an owner-only file `<root>/secrets/pg-<store>.pw` and passes as `file:<path>`, or **Reference** (`env:NAME` / `file:/path`) |
| `synchronous_commit` | under "Advanced", default `off` |

Action: **Connect**. On success the dialog closes and opens the Store's
page with a notice: "Connected and attached to the LayerFS Home. Attach it
to other machines to run Sandboxes there."

Refusals in the dialog: `Exists` (name taken, or the same database under
another Store's name, which LayerFS names), `Denied` (login), `Unavailable`
(not reached; LayerFS names the host).

An `env:` reference resolves in the 3080 server's environment, not the
browser's. The hint says so, and "Enter password" is the default.

## 4. The Store page (PostgreSQL)

Sections, top to bottom:

1. **Pane bar**: name, server, state chip; actions: Doctor's "Test
   connection" (exists), and a menu with Disconnect.
2. **Machines** (new):

   | Machine | Connection | Check | Sandboxes | |
   | --- | --- | --- | --- | --- |
   | LayerFS Home | Same as the host | ● 17.2 · 3 ms · 2 min ago | 1 | Re-check · Edit · Detach |
   | docker | Same as the host | ○ Not checked | 0 | Re-check · Edit · Detach |
   | dev | Own: `lfs_dev@10.0.0.5:5432/team` | ✕ Unavailable: dev cannot reach 10.0.0.5 | 0 | … |

   - **Re-check** runs `store attach` with the same settings.
   - **Edit** opens the Attach dialog filled in.
   - **Detach** asks for confirmation. It is disabled with "Close its
     Sandboxes first" while Sandboxes of the Store run there (LayerFS's
     `InUse` names them).
   - A failed check is shown only in the browser session that ran it, with
     LayerFS's message: LayerFS writes only passing checks. It is kept in
     the host's view state until the next check of that machine passes.
   - The section's button **Attach to a machine…** opens §5.
3. **Projects**: unchanged.
4. **Facts**: server, version, reachable from the host, latency,
   `synchronous_commit`.

Backups stay hidden for PostgreSQL Stores (LayerFS refuses them).

## 5. Attach dialog

| Field | Rules |
| --- | --- |
| Machine | a picker of every machine. Disabled with the reason: already attached, platform doesn't support PostgreSQL Sandboxes (`supports.reason`), stopped ("Start it on Machines first", with a link). |
| Connection | **Same as the host** (default) or **Own connection** |
| Same as the host | a note of what the machine dials: "localhost becomes host.docker.internal on docker", from LayerFS's per-platform table (`stores.md`, "Sandboxes and reach"). For ssh with a localhost server, "Use an own connection: an ssh machine cannot reach this host's localhost". |
| Own connection | Database URL and Password, as in §3. An entered password goes to `<root>/secrets/pg-<store>-<machine>.pw`. |

Action: **Attach and check**, then "Checking from docker…" while it runs.
On success the row appears with its check. On failure the dialog stays
open with LayerFS's refusal (`Unavailable` naming the host tried, `Denied`
naming the missing privilege, `Unsupported` naming a worker to restart), so
the user can change the connection and retry.

## 6. Machines panel

The machine page's Stores tab (`machines/Stores.tsx`) lists the PostgreSQL
Stores **attached** to the machine, from `machine.list`'s new `postgresql`
field, each with its check. It no longer lists every PostgreSQL Store on
every capable machine. A button **Attach a PostgreSQL Store…** opens §5
with the machine fixed and a Store picker.

## 7. Sessions and projects

- `SessionService.machineFor` (`src/host/sessions/service.ts`) and the
  other hard-coded `'native'` for PostgreSQL projects (`service.ts` at the
  binding and placement sites, `projects/availability.ts`,
  `routes/projects.ts` `createSandbox`): a PostgreSQL project's machine is
  the session binding's `machine` when it is attached. Otherwise it is
  `native` when attached, then the first attached machine whose check
  passed. If none is attached, the session can't run and says "Attach team
  to a machine".
- The New Session project control and `NewProjectForm`: for a PostgreSQL
  project attached to more than one machine, a machine choice, defaulting
  as above. A sqlite project keeps its Store's machine.
- `createSandbox` refuses an unattached machine itself (`Unsupported`,
  LayerFS's wording) so the panel's error comes before a LayerFS call.
- A session's machine never changes after its first turn, as its project
  doesn't (`project-sessions.md` §1).

## 8. Host

### Routes (`src/host/routes/router.ts`)

| Route | Calls |
| --- | --- |
| `POST /api/stores/postgresql` `{ name, url, password? \| passwordValue?, synchronousCommit? }` | `store.connect`; `passwordValue` is written to `<root>/secrets/pg-<name>.pw` (0600) and passed as `file:` |
| `POST /api/stores/:name/attach` `{ machine, url?, password? \| passwordValue? }` | `store.attach`; `passwordValue` → `<root>/secrets/pg-<name>-<machine>.pw` |
| `POST /api/stores/:name/detach` `{ machine }` | `store.detach`; removes that machine's password file, if the host wrote one |
| `POST /api/stores/:name/disconnect` | unchanged, and removes the Store's password files |

A password value is never logged, never put in a job record or an event,
and never sent back. The host writes the file first, calls LayerFS, and
removes the file again if the call refuses.

### View (`src/host/routes/storage.ts`, `machines.ts`)

- `storeRow` gains `attachments: [{ machine, own: boolean, target
  (user@host:port/db, from the attachment's url), checked: { at, version,
  latencyMs } | null, lastError: { code, message, at } | null }]` from the
  record's `machines`. `lastError` is the host's memory of the last failed
  `attach` from this server.
- `machineOf` reads `postgresql`. `pgStoreOf` stays for the per-machine
  lists.
- **Feature detection**: attach is on when the pinned CLI's call table has
  `store.attach` (`discover()` identity / `layerfs help store`). Without
  it (Phase 1), attachments are derived as today, "every machine whose
  platform supports it", marked "not checked", and the Attach and Detach
  controls are hidden.

### Presets

`environment-reset.js` still disconnects PostgreSQL Stores; it also removes
`<root>/secrets/pg-*.pw`.

## 9. Phases

**Phase 1, now (no LayerFS change):**
- The POSTGRESQL group, the "Connect a database" row and dialog, entered
  passwords written to owner-only files.
- The Store page's Machines section, read-only: every capable machine, "not
  checked".
- Sessions keep running PostgreSQL projects on `native`.

**Phase 2, after LayerFS ships attach and the pinned CLI is bumped
(`DSH_LAYERFS_CLI`/`DSH_LAYERFS_DAEMON`):**
- Attach and Detach, attachment rows under machines, drag to attach.
- The Machines tab from `machine.list` `postgresql`.
- Machine choice for PostgreSQL sessions.

## 10. Copy (en; zh alongside in `storage/locale.ts` and `machines/locale.ts`)

| Key | en |
| --- | --- |
| `groupPostgresql` | PostgreSQL |
| `connectDatabaseRow` | Connect a database |
| `connectDatabase` | Connect a database |
| `pgPasswordHow` | Password |
| `pgPasswordEntered` | Enter password |
| `pgPasswordReference` | Reference |
| `pgPasswordInUrl` | Give the password below, not in the URL. |
| `pgEnvHint` | An env: reference is read from the LayerFS server's environment. |
| `connectedAttached` | Connected and attached to the LayerFS Home. Attach it to other machines to run Sandboxes there. |
| `machinesSection` | Machines |
| `attachToMachine` | Attach to a machine… |
| `attachAndCheck` | Attach and check |
| `checkingFrom` | Checking from {machine}… |
| `sameAsHost` | Same as the host |
| `ownConnection` | Own connection |
| `notChecked` | Not checked |
| `recheck` | Re-check |
| `detach` | Detach |
| `detachTitle` | Detach {store} from {machine}? |
| `detachBody` | Sandboxes of its projects can no longer run on {machine}. Its data stays on the server. |
| `closeSandboxesFirst` | Close its Sandboxes on {machine} first. |
| `notAttachedAnywhere` | Attach {store} to a machine to run its projects. |
| `loopbackNote` | localhost becomes {alias} on {machine}. |

## 11. Tests

- `test/routes.test.mjs`: connect with an entered password writes a 0600
  file and passes `file:`, and removes it on refusal; attach and detach
  routes; disconnect removes the files; no password in any answer or
  event; the Phase 1 fallback when the CLI has no `store.attach`.
- Storage model: tree grouping (POSTGRESQL group; attachments under
  machines; search).
- `test/sessions.test.mjs`: a PostgreSQL project's machine from the
  binding, the defaults of §7, and none attached.
- End to end on a side server with a disposable PostgreSQL
  (`docker run postgres`, a role per machine): connect, attach `docker`
  with the host's connection, attach with an own role, a role without
  `INSERT` refused `Denied`, a Sandbox on the attached machine, detach
  `InUse` then allowed. Clean up with `tools/cleanup-dev.mjs` and drop
  the container.
