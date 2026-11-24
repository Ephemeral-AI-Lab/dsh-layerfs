# Store home rows, PostgreSQL connect and machine attach

> **Status:** owner-approved design, 2026-11-24. Supersedes the connection and
> "runs on" parts of `layerfs-postgresql-connection.md` and
> `postgresql-stores-ui.md` (saved logins, per-machine addresses, the shared
> login row, the server-grouped Connect dialog).

## The LayerFS model this UI shows

- **The host is the one place a PostgreSQL Store's URL and login are saved.**
  `store.connect(store, url, { user, password, synchronous_commit })` connects a
  new Store or, run again, changes its address, user, password or
  synchronous_commit (an omitted user/password keeps the saved one). The URL is
  an address alone; a user or password inside it is refused. The password is
  never answered.
- **Machines attach to a PostgreSQL Store and inherit its URL and login.**
  `store.attach(store, { machine })` checks from that machine, then records it;
  `store.detach(store, { machine })` is refused while a Sandbox of the Store is on
  that machine. There is no per-machine address. A Sandbox of a PostgreSQL
  Store's project can only be created on an attached machine (refusal fix:
  `layerfs store attach <store> --machine <machine>`).
- **Reach is tested, never predicted** (owner, 2026-11-24). The server may be on
  this computer or anywhere else, so the UI never greys a machine because of
  the address. `store.attach(store, { machine, dry_run: true })` runs attach's
  own check from that machine and records nothing; every reach refusal names
  its connection `step` (`configuration`, `transport`, `tls`, `authentication`,
  `database`, `schema`, `identity`). LayerFS still refuses a loopback address
  from a machine that does not share this computer's network (step
  `configuration`), and never rewrites the URL.
- **A changed connection never cuts off a machine silently.** `store.connect`
  with a new address or login checks from this computer and every attached
  machine before saving and refuses `Conflict` (with `machines`) when one would
  fail; `dry_run: true` answers `{ here, machines }` and saves nothing.
- **Checks:** `store.doctor(store)` checks from the host, then every attached
  machine (machines are skipped when the host fails); with `{ machine }` the host
  plus that machine. `store.get` answers the saved connection (url, user,
  password_saved, password_changed_at, synchronous_commit, id), `machines` (each
  with its last reach `{at, ok, latency_ms, server_version, error}`), projects and
  backups. Reads never dial; only doctor/connect/attach dial.
- **No migration, no backward compatibility, no fallback** (owner,
  2026-11-24). Code only against this contract: nothing reads or detects old
  shapes (`auth`, per-machine connections, saved logins), no call probing, no
  old calls kept as fallbacks, no plugin-side migration of old state. Old
  records fail through the normal path.
- Removed calls: `store.save_auth`, `store.auths`, `store.remove_auth`,
  `--auth`, `--machine` on connect/disconnect, and `store.update`'s connection
  role. Remove every UI path that used them (Logins switch, login row,
  "change password for every Store", per-machine address rows, "Runs on"
  defaults).
- A SQLite Store lives on exactly one machine (`store.move` moves it; one end
  must be this computer) and backs up to linked buckets (`backup.*`).
  PostgreSQL Stores have no bucket backups (the server keeps its own).

## Home view, Store tab

The SQLite | PostgreSQL switch stays. Each view is one bordered list (not a
card grid) of **accordion rows**, one per Store. Several rows may be open at
once; the open set is remembered per viewer (localStorage, wrapped in
try/catch). After "Check all", a row whose host check just failed opens itself.

### PostgreSQL row

Folded:

| Part | Content |
|---|---|
| Left, line 1 | Health dot (host check: ok / failed / unchecked) and Store name |
| Left, line 2 | `user@host:port/database` in mono |
| Right | `N projects` · divider · up to 3 machine provider icons, each with a reach dot, then `+N` · `N machines` · one status word: `N failed` (danger), or `N stopped` (warning) |
| Right, host failed | `N projects` · the failure label (danger) · `Edit connection…` link; machine icons are not shown |
| End | Chevron, rotates when open |

Unfolded body, two columns (projects wider):

- **Projects:** each project, its size or "no commits yet", a box icon + count
  when Sandboxes run. Total size on the heading line. Max 5, then `+N projects →`
  (opens the Store page). Host failed: list greyed, heading says "last read
  <time>".
- **Runs on:** one row per attached machine: provider icon, name, provider
  name, reach dot + result (`reachable` / failure label / `checking` /
  `not checked`), then `×` (detach) or, when Sandboxes run there, a box icon +
  count with a tooltip instead. Max 5, then `+N →`. Heading action
  `+ Attach machine` opens the attach picker.
- **Footer links:** `Check` (this Store: host, then its machines),
  `Edit connection…`, `Open Store page →`.

Header actions of the view: `Check all`, `Connect database`.

### SQLite row

Folded:

| Part | Content |
|---|---|
| Left, line 1 | State dot (ready / machine stopped / operation running / needs attention) and Store name |
| Left, line 2 | Size |
| Right | `N projects` · divider · the one machine (provider icon + name), or `stopped · Start`, or a running operation with progress · divider · backups: bucket icon + `N buckets · <last success>` and `N failed` (danger), or `not backed up` (muted) |

Unfolded body: **Projects** (same as PostgreSQL) on the left; on the right
**Lives on** (one machine row with state; heading action `Move…`, tooltip states
the move rule) and below it **Backups** (one row per linked bucket: name,
provider, last success or "last attempt failed" with the last success in the
tooltip, a `Back up` link; heading action `+ Add bucket`; empty: "not backed up
to any bucket"). Footer links: `Compact…`, `Restore…`, `Open Store page →`.

Header action of the view: `New Store`.

## Dialogs and picker

- **Connect database:** four fields, in this order: Name, Address
  (`postgres://host:port/database`, mono), User, Password; buttons Cancel and
  Connect. Pressing Connect is the test: the Store is saved only if the host
  check passes. Errors show as one line under the form with the fix; a
  password inside the address is refused client-side with a hint. No server
  list, no saved logins, no steps. A refusal's line comes from its `step`.
- **Edit connection:** the same form filled in, the Store's name under the title,
  Password empty with placeholder "leave empty to keep"; Save and check. Below
  the fields, **Who can reach it** with a **Test** button: it tests the values as
  typed from this computer and every attached machine (`store connect
  --dry-run`), each row `Reachable · N ms` or `Failed at <step>` (click for the
  steps). A result answers only for the values it ran with; after an edit it
  says to test again. Save is off while a tested machine would lose the Store,
  and LayerFS refuses such a save anyway (`Conflict`, `machines`).
- **Attach picker** (from a row, the Store page, or the machine page reversed):
  a search field, machines grouped by provider (group heading = provider name),
  checkboxes, multi-select, footer `N selected` + `Attach and check`. Each row
  has its own **Test**, run from that machine only when pressed (`store attach
  --dry-run`): `Not tested` → `Testing…` → `Reachable · N ms` or `Failed at
  <step>`, which opens the six steps (address, connection, TLS, login, database,
  this Store) with LayerFS's words; ↻ tests again. Testing is optional: Attach
  checks each machine again before saving it, and a refused attach shows on its
  row the same way and stays selected. Only a stopped machine (Start) or one
  that cannot run PostgreSQL Sandboxes (reason only) is greyed. Already attached
  machines are not listed. New providers add groups, never layout.

## Store page (PostgreSQL)

Breadcrumb, header (name, `PostgreSQL · size · N projects`, `Check`, `⋯` with
`Disconnect…` and `Copy address`). Two columns: **Projects** main (full list,
sorted by size, link to the Projects tab filtered by this Store) and a side
column with **Connection** (address, database, user, "password saved", last host
check; `Edit…`; tooltips for synchronous_commit and the Store id) and **Runs on**
(the machine rows as in the unfolded row, without the 5 cap). Disconnect says what
it hides ("N projects will no longer show on this computer; data in the database
stays") and stays refused while Sandboxes run.

## Machine page, Stores tab (reverse)

PostgreSQL Stores attached to this machine, one row each with reach dot and
`Detach`; `+ Attach Store` opens the same picker listing Stores, each with its
own Test from this machine.

## Status labels (one shared set)

Host/machine reach: `reachable`, `checking`, `not checked`, `cannot reach address`,
`wrong password`, `database not found`, `not this Store`, `machine stopped`,
`machine needs update`. Each failure has one action (Edit connection… / Start /
Update). Map from refusal codes and doctor observations; never show raw errors
on rows (full text in the tooltip or the Store page).

## Layout and overflow rules

- Rows: name and address truncate with an ellipsis on one line; the full value in
  `title` and a copy action where it is an address. The right summary never
  wraps under the name at ≥ 720 px; below 720 px it moves to its own line under
  the name. Below 560 px the unfolded columns stack (projects first).
- Numbers right-aligned in a fixed column; sizes formatted (B/KB/MB/GB), counts
  with `+N` caps: 3 icons in summaries, 5 rows in unfolded lists.
- Long machine, bucket and project names truncate inside their row; the
  trailing status/action never gets pushed out or overlaps.
- Both locales (en, zh): no fixed widths sized for one language; check zh and en.
- No nested scrolling; the page grows. Dialogs stay short (no field duplicated,
  one-line hints) and never wider than the viewport.
- Empty, loading (keep last answer, spinner only when nothing to draw), and
  failure states for every list.
