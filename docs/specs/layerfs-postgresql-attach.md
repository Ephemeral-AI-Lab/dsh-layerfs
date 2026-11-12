# LayerFS 2.0: attach PostgreSQL Stores to machines one by one

Status: **implemented** (2026-11-12, owner approved) in the LayerFS worktree
`../layerfs-pg-attach`, uncommitted on top of `layerfs_v2_0_0`. §6 lists the
files as built; where they differ from the proposal below, §6 and the
"As built" notes win.

As built:

- `machine.remove` **refuses** (`InUse`, "Stores [..]") while a PostgreSQL
  Store is attached to the machine, as it does for its sqlite Stores; it
  does not drop attachments. `store detach` first.
- The privilege probe is one engine function,
  `layerfs_persistence::postgresql_access` (server version, latency, role,
  the privileges missing on the schema, its tables and sequences, and
  `TEMP`); `layerfs-store`'s `postgresql/attach.rs` turns it into the check.
- `store connect` records `native`'s check only when it passes (a role that
  may not write leaves native attached but unchecked).
- The store family has 12 calls (with `stats`), the table 68.

**This reverses two owner decisions of #536 (2026-11-03):**

| Decision | Today | Proposed |
| --- | --- | --- |
| C4 | "PostgreSQL Stores are usable from every machine automatically; there is no `store.attach`/`store.detach`." | A PostgreSQL Store is usable on the machines it is attached to. `store connect` attaches `native`; every other machine is attached by `store attach`. |
| H9 | "Per-machine PostgreSQL URL: deferred." | `store attach` takes an optional URL and password reference for that machine. |

H1 stays: sqlite Stores keep `store push` / `store pull`. Attach is not a
placement: it copies nothing, a Store may be attached to many machines, and
it does not apply to sqlite Stores.

## 1. Why

- **Supported is not reached.** `supports.postgresql_sandbox` says a platform
  can run a PostgreSQL Sandbox. It says nothing about whether this machine
  reaches this server with these credentials. Today the first
  `sandbox create` on a machine is the only check, and it needs a project,
  so an empty Store cannot be checked anywhere but `native`.
- **One login for every machine.** Each machine's Sandbox daemons get the
  host's URL and password. A VM can't get a role of its own with only the
  rights it needs, and one machine can't be cut off without changing the
  password for all of them.
- **One address for every machine.** The loopback rewrite (`reach`) covers a
  server on this host. It does not cover a server that a VM or ssh host
  sees at another address, or `sslmode=verify-full` with a certificate
  name the rewrite would break (H9's case).
- **Clients can't show where a Store is usable.** `machine list` names only
  sqlite Stores per machine, so a client has to assume every PostgreSQL
  Store is on every capable machine.

## 2. Model

```
store connect team <url> --password <ref>      the host's connection; makes the Store
   └─ attaches native (checked by connect's own probe)
store attach  team docker                      docker reuses the host's connection
store attach  team dev --url <url> --password <ref>    dev has its own connection
store detach  team dev
```

- `store connect` is unchanged in meaning: it records the Store's identity
  (database, schema `layerfs`, binding) and the host's connection. Store
  calls (project, branch, commit, fs, Init) keep running in the caller's
  process with this connection.
- An **attachment** lets one machine run Sandboxes of the Store, with
  either the Store's connection or its own. Either way it must reach the
  database that holds the Store's binding; a machine's URL can never name
  another Store.
- `attach` never creates a Store; the Store must be connected first.

## 3. The record

`store/<name>/record.json` of a PostgreSQL Store gains `machines`:

```json
{
  "kind": "postgresql",
  "url": "postgresql://lfs_host@db.lan:5432/team",
  "password": "env:LAYERFS_PG_TEAM",
  "schema": "layerfs",
  "synchronous_commit": "off",
  "binding": "…",
  "machines": {
    "native": { "checked": { "at": 1763000000000, "server_version": "17.2", "latency_ms": 3 } },
    "docker": { "checked": { "at": 1763000100000, "server_version": "17.2", "latency_ms": 5 } },
    "dev": {
      "url": "postgresql://lfs_dev@10.0.0.5:5432/team?sslmode=verify-full",
      "password": "file:/Users/me/.config/layerfs/dev.pw",
      "checked": { "at": 1763000200000, "server_version": "17.2", "latency_ms": 9 }
    }
  }
}
```

- `url` and `password` per machine are optional; when absent the machine
  uses the Store's. As for the Store, `url` holds no password and
  `password` is a reference (`env:NAME` or `file:/path`). No secret is
  written.
- `checked` is the last check that passed. A failed check writes nothing.
- **A record without `machines`** (written before this change) is read as
  `{ "native": {} }`. 2.0 is unreleased, so there is no conversion; `native`
  shows no `checked` until the next `attach native`.
- Every read and write goes through `StoreRecord` (`store/record.rs`), as
  for every other field; `StoreRef::Postgres` gains the parsed attachments.

## 4. Calls

The `store` family goes from 9 calls to 11 (`api/crates/layerfs-api/src/store/mod.rs`).

| Call | Arguments | Options | What it does |
| --- | --- | --- | --- |
| ★ `store.attach` | `name`, `machine` | `url`, `password` | attaches a PostgreSQL Store to a machine after checking it from that machine; again on an attached machine, re-checks and replaces its connection |
| ★ `store.detach` | `name`, `machine` | — | detaches it; its data and other machines are untouched |

```
layerfs store attach <name> <machine> [--url <url>] [--password <password>]
    let a machine run Sandboxes of a PostgreSQL Store, after checking it reaches the server
layerfs store detach <name> <machine>
    stop a machine running Sandboxes of a PostgreSQL Store
```

The result of both is the Store's `store.get` view, with `machines`.

### 4.1 `store.attach`

Every refusal of its input comes before any effect, as in `store.connect`.

1. `name` must be a Store: else `NotFound`. A sqlite Store is
   `InvalidInput`: "Store X is a sqlite Store; `store push X M` places it".
2. `machine` must exist (`NotFound`) and its platform must allow
   PostgreSQL Sandboxes on this host (`layerfs_machine::sandbox_allowed`):
   else `Unsupported` with the support table's reason, word for word.
3. `url`, when given, is refused as `store.connect` refuses one
   (`refuse_password`, `target`): `InvalidInput`.
4. The password (the given reference, else the Store's) must resolve in
   this process (`common::secrets::resolve`): else its refusal.
5. The URL the machine dials is built as `sandbox/route.rs` `reached()`
   builds it today: the given URL else the Store's, with its password,
   through `layerfs_machine::reach` (loopback rewritten, ssh loopback
   refused, `verify-full` with a rewrite refused).
6. **The check**, on the side that runs the machine's calls
   (`common::place::on_machine`):
   - `Executor::Local`: in this process.
   - `Executor::Worker`: a new worker op `store.reach` (§5). A machine with
     no recorded worker is refused `Unavailable`, naming
     `layerfs machine start M` (`Worker::ready`). Nothing is started.

   The check opens one connection and runs, read-only:
   - `read_binding` (`store/postgres.rs`). It must equal the record's
     `binding`: else `Unavailable` "the PostgreSQL server M reaches at
     <host> holds another Store than X" (today's `reach_check` wording).
   - `has_schema_privilege(current_user, 'layerfs', 'USAGE')` and, for
     every table in schema `layerfs`, `has_table_privilege` for `SELECT`,
     `INSERT`, `UPDATE` and `DELETE` (a Sandbox commits, and a write
     takes `store_lane` with `UPDATE`). Any missing: `Denied`, naming
     the role and the first missing privilege.
   - `server_version` and the connection's latency.

   A failure names the machine and the host it tried, never the URL; the
   apple-container hint of `reach_check` is added as today.
7. Under the Store's entity lock (`store::record::lock`), re-read the
   record. If the Store's binding changed or the Store is gone,
   `Conflict`. Then write `machines.<machine>` = `{ url?, password?,
   checked }`.

Attaching `native` with no options is how a caller re-checks `native`.

### 4.2 `store.detach`

1. `name` must be a PostgreSQL Store (`NotFound`, `InvalidInput` as above).
2. `machine` must be attached: else `InvalidInput` "Store X is not
   attached to machine M".
3. `InUse` while a Sandbox record of a project of this Store names the
   machine, with `detail.related` naming each, as `store.disconnect` does.
4. Remove `machines.<machine>` under the Store's lock. Detaching `native`
   is allowed: Store calls still run on the host with the Store's
   connection; only Sandboxes on `native` are refused.

LayerFS never creates or drops PostgreSQL roles; it has no admin
credentials. Revoking a machine's role is the operator's step.

### 4.3 Changes to existing calls

| Call | Change |
| --- | --- |
| `store.connect` | writes `machines: { native: { checked } }` from the probe it already makes. That probe runs in the caller's process, which is `native`'s network. |
| `sandbox.create` | for a PostgreSQL Store, after the machine is chosen (none named: `native`, unchanged) and under the home lock that claims the name: refused `Unsupported` unless the machine is attached, "PostgreSQL Store X is not attached to machine M; `layerfs store attach X M`". The reach check on create stays, as the last guard. |
| every Sandbox host op (`sandbox/route.rs` `reached()`) | uses the machine's attachment `url`/`password` when set, else the Store's; the rest unchanged |
| `store.get`, `store.list` | the record view shows `machines` (references only, as it shows `url` and `password` today) |
| `machine.list`, `machine.get` | each machine gains `postgresql`: the names of the PostgreSQL Stores attached to it, sorted. `stores` keeps its meaning (sqlite Stores on its disk), so no caller of `stores` changes. |
| `machine.remove` | drops the machine from every PostgreSQL Store's `machines`, each under its Store's lock, after its existing refusals (its Sandboxes) pass |
| `store.disconnect` | unchanged; the attachments go with the record |
| `store.status` | unchanged (the host's server check). Per-machine state is the record's `checked`. |

`machine.list`'s new field is computed in `inventory.rs` beside `stores_on`
(a `postgresql_on(home, machine)` that reads each PostgreSQL record's
`machines`).

## 5. The worker op `store.reach`

`machine/worker/server.rs` `run()` gains:

```
"store.reach" => args { postgresql: <selection, as reached() builds it>, binding: <hex> }
              -> { server_version, latency_ms } | refusal
```

The caller resolves the password and rewrites the URL; the selection
travels only in this request, as for every Sandbox call today. The worker
reads no home. A worker from a bundle without the op answers an unknown op;
`attach` maps that to `Unsupported` "machine M's worker predates
store.attach; `layerfs machine stop M` and `machine start M` update it".

## 6. Files

| File | Change |
| --- | --- |
| `api/crates/layerfs-api/src/store/attach.rs`, `detach.rs` | new table entries (`a("name", Name), a("machine", Name)`; `opt("url", Text), opt("password", Text)`) |
| `api/crates/layerfs-api/src/store/mod.rs` | 12 calls; help order puts `attach`, `detach` after `connect` |
| `engine/crates/layerfs-persistence/src/backend/postgresql/access.rs` | new: the read-only privilege probe (`postgresql_access`) |
| `control/crates/layerfs-store/src/postgresql/attach.rs` | new: `check`, `record` (under the home and Store locks, `Conflict` if the binding changed), `detach` |
| `control/crates/layerfs-store/src/record.rs` | `Attachment`, `attachments()` (absent `machines` = native), `with_attachment`, `without_attachment`, `url_on` |
| `control/crates/layerfs-store/src/postgresql/connect.rs` | attaches `native` on connect; `refuse_password`, `target` public |
| `control/crates/layerfs-sandbox/src/route.rs` | `reached(home, machine, record)` dials the attachment's connection |
| `control/crates/layerfs-sandbox/src/create.rs` | the attachment refusal |
| `control/crates/layerfs-control/src/store.rs` | `attach` (local or `worker.attempt("store.reach")`), `reach_in_worker`, `detach` |
| `control/crates/layerfs-control/src/worker_server.rs` | the `store.reach` op |
| `control/crates/layerfs-control/src/inventory.rs` | `postgresql_on`, `store_idle_on`; `can_remove_machine` counts attached Stores |
| `control/crates/layerfs-machine/src/{related,record,list}.rs` | `postgresql` per machine |
| `docs/versioned/2.0.0/calls.md`, `machines-and-stores.md`; `docs/architecture/api/sdk/store/{README,attach,detach,connect}.md`, `machine/{list,get,remove}.md`, call-table `table.md`, `coverage.md` | the calls |
| `core/docs/issues/536/DECISIONS.md`, `README.md`; `control/AGENTS.md` | C4 superseded, H9 taken up (owner, 2026-11-12); the G3 rule replaced |
| `api/node/src/index.d.ts`, `api/python/src/layerfs/_client.pyi`, `aio.pyi` | regenerated |

The CLI, Node and Python faces have no per-call code for `store.connect`
(`layerfs-cli`, `layerfs-node`, `layerfs-python` don't name it), so they
follow from the call table. Regenerate whatever type files the build emits.

## 7. Tests

- `store.attach` refusals in order, each before any effect: no Store,
  a sqlite Store, no machine, a platform the table refuses, a URL with a
  password, an unresolved reference, a stopped worker machine.
- The check: another database (binding mismatch → `Unavailable`), a role
  without `INSERT` on one table (`Denied`), a good role (`checked`
  written), re-attach replacing the connection, a failed re-attach
  keeping the old one.
- `sandbox.create` on an unattached machine refused before the name is
  claimed; on an attached one with its own URL, the daemon dials that URL
  (the receipt names the host).
- `store.detach` `InUse` with a Sandbox recorded, then allowed after
  `sandbox close`.
- `machine.list` `postgresql`; `machine.remove` refused while attached.
- A record without `machines` reads as `native` only.
- Per platform, beside `tests/sandbox_machines.rs`
  (`a_sandbox_runs_where_its_store_can_be_reached`): attach and a Sandbox
  on `native`, `docker`, `lima`, with the Store's connection and with one
  of the machine's own.

## 8. Not in this change

- Creating PostgreSQL roles or grants.
- Changing `store push` / `store pull` (H1).
- A per-machine `synchronous_commit` (it stays the Store's).
- Backups of PostgreSQL Stores (still `InvalidInput`).
