# PostgreSQL Stores: the LayerFS calls the plugin builds on

Status: **current** (2026-11-17). Replaces `layerfs-postgresql-attach.md`:
`store.attach` and `store.detach` are gone. This page records the contract
the plugin is written against; LayerFS's own documentation is the source of
truth for the calls.

## The model

A PostgreSQL Store is a database on a server. It is on **no machine**. Its
record holds one connection: a URL (no password), a password reference and
`synchronous_commit`. Any machine whose platform runs PostgreSQL Sandboxes
(`machine.supports.postgresql_sandbox`) reaches the Store with that
connection; nothing is attached first. `sandbox.create` of a PostgreSQL
project works on any such machine.

A machine can have a connection **of its own** (another address, another
password) when the Store's does not work from it. That is the exception, and
the only thing LayerFS records per machine.

## Calls

| Call | What the plugin uses |
| --- | --- |
| `store.connect <name> <url> --password <ref> [--synchronous-commit]` | Connects the database as a Store. The result has no `machines`. |
| `store.update <name> [--url] [--password <ref>] [--synchronous-commit]` | Edits the Store's own connection. Answers the Store as `store.get` does. |
| `store.update <name> --machine <m> [--url] [--password <ref>]` | Sets that machine's own connection. LayerFS checks it from the machine before it saves anything. Refusals: `Unavailable`, `Denied`, `Unsupported`. A long call. |
| `store.update <name> --machine <m> --clear` | Removes that machine's own connection. |
| `store.status <name>` | `server`: the host's own reach of the server. |
| `store.status <name> --machine <m>` | Adds `check`: `{ machine, host, ok: true, at, server_version, latency_ms }` or `{ machine, host, ok: false, error: { code, message } }`. A bad input (no such machine, a SQLite Store, a platform that runs none) is a refusal. |
| `store.get` / `store.list` | `machines` only names machines with their own connection: `{ "<m>": { url?, password? } }`. No `checked`. |
| `store.disconnect <name>` | Forgets the Store. The database stays. |
| `machine.list` / `machine.get` | No `postgresql` field. `machine.remove` no longer refuses for PostgreSQL Stores. |
| `sandbox.create` | A machine that cannot reach the server refuses `Unavailable`: "machine <m> cannot reach PostgreSQL Store <s>'s server at <host>: ...". |

A password is always a reference (`env:NAME` or `file:/path`). LayerFS keeps
no password in a URL and refuses one.

## What LayerFS does not record

Which machine a Store's sessions run on. That is the plugin's own choice
(see [postgresql-stores-ui.md](postgresql-stores-ui.md) §2); LayerFS takes a
machine per `sandbox.create`.
