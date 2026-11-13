# Strata: a SQLite-compatible SQL engine in Rust, built by 9 agents on LayerFS v2

Strata is the Quarry v2 run. One dsh main agent and **eight worker subagents** build
a SQL engine in Rust that speaks SQLite's dialect, reads and writes **SQLite's own
database file format** (rollback journal and WAL), and returns the rows SQLite returns.
Everything happens in one LayerFS v2 project session through the `dsh-layerfs` skill:
Branches, Workspaces, Commits, merges and publishes.

The run has two purposes:

1. **Verify the multi-agent harness under concurrency:** eight workers in one session
   Sandbox, **two workers sharing one lane Branch at a time** (both commit to it) and
   **four lane Branches at once**, many small Commits, the same "until terminal pass"
   discipline as v1.
2. **Build something bigger than v1's Quarry**, checked against SQLite three ways: a
   sqllogictest corpus whose expected results come from SQLite, differential
   query generation, and file-level interoperability (sqlite3 opens what Strata
   writes, and the other way round).

This file says **what** to build and **how the team works**. Inside each crate the
design is the team's: names, modules and algorithms are free as long as the behavior
below holds and tests prove it. "Works" means "does what `sqlite3` does".

v1 for comparison (2026-10-20, LayerFS v1): 1 main + 7 workers, 3 lanes, 3 rounds,
4 h 16 min, 13 crates, 891 tests, 800 slt records, Q01–Q12, 913 Commits, 4 Sandboxes.

---

## 1. Run setup (operator, before the handoff)

The agents never set anything up. These hold when the handoff is pasted; the main agent
checks them in its preflight (HANDOFF.md) and stops if one fails.

| # | What | State (checked by the operator 2026-11-13) | Agent's check |
| --- | --- | --- | --- |
| 1 | Docker | 8 CPUs, 8 GiB memory, ≈ 116 GB free on the worker's data disk. Not resized: the run is sized to fit (§6, §10) | `nproc`, `free -g`, `df -h /` in a Workspace |
| 2 | Toolchain | The docker Sandbox's root is the LayerFS bundle's Sandbox image (Debian 12, Rust 1.85.1 with clippy and rustfmt, gcc, Python 3 with SQLite 3.40.1, `flock`, `timeout`, curl). **Its environment is not applied**: every exec needs `export RUSTUP_HOME=/usr/local/rustup PATH=/usr/local/cargo/bin:$PATH` (in `scripts/env.sh`). There is **no `sqlite3` CLI**: the skeleton builds 3.40.1 from source into `.tools/bin/sqlite3` (§6). Network reaches crates.io and sqlite.org. Not root (uid 501) | `rustc -V`, `cargo -V`, `python3 -c 'import sqlite3;print(sqlite3.sqlite_version)'` |
| 3 | Store | `qv2-store`, kind SQLite, on machine **docker** (writers queue; see §4) | `layerfs project get "$P"` shows `kind: sqlite`, `machine: docker` |
| 4 | Project | `qv2-strata` in Store `qv2-store`, empty | `$DSH_LAYERFS_PROJECT` = `qv2-store/qv2-strata` |
| 5 | Subagents | DSH `maxActiveSubagents` is **8** (default; root not counted), `maxDepth` 1 | 8 workers start without `ACTIVATION_LIMIT_REACHED` |
| 6 | Session | New Session in project `qv2-store/qv2-strata`, model **DeepSeek-V4.1-Flash** (`deepseek-flash`), reasoning effort **Max**, preset LayerFS. Scratch folder holds this file at `./quarry-v2/SPEC.md` | `$DSH_LAYERFS_WS` non-empty |
| 7 | Keep it live | The session page stays open for the whole run; `dsh web` is not restarted while a turn is live | — |

Why the image matters: on `docker` a Sandbox runs as namespaces in the docker machine's
worker container, rooted in the bundle's `sandbox-image.tar` whatever image the machine
records (LayerFS `docs/versioned/2.0.0/machines-and-stores.md`, D-8). So nothing the
operator could set changes the toolchain, and agents cannot create Sandboxes: what is
missing (the `sqlite3` CLI) is installed into the project, like any other dependency.

---

## 2. What to build

### 2.1 Crates

One Cargo workspace at the project root, `resolver = "3"`, edition 2024.

| Crate | Lane | Purpose |
| --- | --- | --- |
| `strata-types` | main | Shared types and contracts: `Value` (NULL/INTEGER/REAL/TEXT/BLOB), affinity, collation ids, `Error` with SQLite result codes (primary + extended) and SQLite's message text, the AST, the logical `Plan` IR, the bytecode `Program`/`Opcode` IR, the traits `Vfs`/`File`, `Pager`, `Wal`, `BTree`/`Cursor`, `Catalog`, `FunctionRegistry`; in-memory test doubles `MemPager` and `MemBTree` so lanes can test before the store lane lands |
| `strata-parser` | front F1 | Lexer and recursive-descent parser for SQLite's grammar; SQL text printer (for `sqlite_schema` text and `ALTER` rewrites) |
| `strata-sema` | front F2 | Schema catalog loaded from `sqlite_schema`, name resolution, affinity and collation resolution, views, triggers' `NEW`/`OLD`, constraint and foreign-key metadata |
| `strata-planner` | front F2 | Query planner: access paths, index selection, join order with `sqlite_stat1`, subquery flattening, `EXPLAIN QUERY PLAN`, `ANALYZE` statistics |
| `strata-codegen` | vm V1 | Plan → bytecode for every statement: DML with constraints, upsert, `RETURNING`, triggers, foreign keys, DDL, `ALTER TABLE`, `VACUUM`, `EXPLAIN` |
| `strata-vm` | vm V2 | Register-based bytecode VM (VDBE-like): cursors, comparisons with affinity, sorter with external merge, ephemeral tables, coroutines, aggregate and window opcodes |
| `strata-func` | vm V2 | Value conversions exactly as SQLite, collations, all scalar, aggregate, window, date/time and JSON functions listed in §2.3 |
| `strata-btree` | store S1 | Record format (serial types, varints), table and index b-trees, overflow pages, freelist, balance, `integrity_check` |
| `strata-pager` | store S2 | Database header, page cache, VFS (unix files, fsync), rollback journal, POSIX locking compatible with sqlite3 |
| `strata-wal` | store S2 | SQLite's WAL file format, in-process wal-index, snapshots, checkpoints, WAL recovery |
| `strata` | tools T1 | The library facade: `Connection::open` (file or `:memory:`), `prepare`/`bind`/`step`/`column`/`reset`/`finalize`, PRAGMA dispatch, schema load, busy timeout, statement cache |
| `strata-cli` | tools T1 | The `strata` binary: a shell compatible with the `sqlite3` shell for the dot-commands in §2.3 |
| `strata-slt` | main, T2 | sqllogictest runner (embedded engine) |
| `strata-gen` | tools T1 | Seeded random query generator over a fixed schema and seeded data generators (TPC-H-like `--scale`) |
| `strata-accept` | main, T2 | Acceptance harness: `strata-accept run Annn` prints `Annn PASS` or `Annn FAIL <why>` |

Lanes meet only through `strata-types`. A lane that needs another lane's crate uses its
trait, never its internals; until the real one lands it uses `MemPager`/`MemBTree` or a
stub behind its own interface and tells the main agent.

### 2.2 File format and durability (the scale-up over v1)

- **SQLite database file format 3**: the 100-byte header (`"SQLite format 3\0"`,
  page size 512–65536, schema format 4, text encoding 1 = UTF-8 only, change counter,
  schema cookie, `user_version`, `application_id`, freelist head/count), table b-trees
  with rowids, index b-trees, overflow chains with SQLite's local-payload thresholds,
  freelist trunk and leaf pages, `sqlite_schema` with the statement text SQLite would
  store, `sqlite_sequence` (AUTOINCREMENT), `sqlite_stat1` (ANALYZE). Default page
  size 4096. Auto-vacuum is NONE. A UTF-16 database is refused with an error.
- **Rollback journal** (`journal_mode=DELETE`): SQLite's journal format (header magic,
  page records with checksums, nonce), hot-journal rollback on open, fsync ordering.
- **WAL** (`journal_mode=WAL`): SQLite's WAL format (32-byte header, 24-byte frame
  headers, salts, cumulative checksums in SQLite's byte order), commit frames,
  readers on snapshots (several connections in one process share an in-memory
  wal-index), checkpoints `PASSIVE`/`FULL`/`RESTART`/`TRUNCATE`, auto-checkpoint at
  1000 pages, recovery from the WAL on open. Strata never writes a `-shm` file; in WAL
  mode it holds SQLite's exclusive locking-mode lock, so a concurrent sqlite3 process
  gets `database is locked` instead of a shared wal-index.
- **Locking**: POSIX advisory locks at SQLite's lock bytes (PENDING `0x40000000`,
  RESERVED, SHARED range) in rollback mode, so Strata and sqlite3 exclude each other
  correctly on one file; `busy_timeout`; `SQLITE_BUSY` → `database is locked`.

### 2.3 SQL surface (SQLite 3.40 dialect)

Dynamic typing with SQLite's type affinity, storage classes and comparison rules
throughout. Integer arithmetic overflow becomes REAL as in SQLite; `sum()` overflow
is the error `integer overflow`; division by zero is NULL.

| Area | In scope |
| --- | --- |
| DDL | `CREATE TABLE` (column affinity from declared type, `INTEGER PRIMARY KEY` rowid alias, `AUTOINCREMENT`, `PRIMARY KEY`, `UNIQUE`, `NOT NULL`, `DEFAULT`, `CHECK`, `COLLATE`, `REFERENCES … ON DELETE/UPDATE`, `STRICT`), `CREATE TABLE … AS SELECT`, `DROP TABLE`, `CREATE [UNIQUE] INDEX` (multi-column, `ASC/DESC`, partial `WHERE`), `DROP INDEX`, `CREATE VIEW`, `DROP VIEW`, `CREATE TRIGGER` (`BEFORE`/`AFTER`/`INSTEAD OF`, `INSERT`/`UPDATE [OF]`/`DELETE`, `WHEN`, `RAISE`), `DROP TRIGGER`, `ALTER TABLE` `RENAME TO`, `RENAME COLUMN`, `ADD COLUMN`, `DROP COLUMN`, `IF [NOT] EXISTS` everywhere SQLite has it |
| DML | `INSERT` (multi-row `VALUES`, `INSERT … SELECT`, `DEFAULT VALUES`, `OR REPLACE/IGNORE/ABORT/FAIL/ROLLBACK`, upsert `ON CONFLICT … DO NOTHING / DO UPDATE … WHERE`), `REPLACE`, `UPDATE` (incl. `UPDATE … FROM`, `OR …`), `DELETE`, `RETURNING` |
| Queries | `WHERE`, `GROUP BY`, `HAVING`, `ORDER BY … [ASC/DESC] [NULLS FIRST/LAST]`, `LIMIT`/`OFFSET`, `DISTINCT`; `INNER`, `LEFT`, `RIGHT`, `FULL`, `CROSS`, `NATURAL`, `USING` joins; scalar, `IN`, `EXISTS` and correlated subqueries; `UNION [ALL]`, `INTERSECT`, `EXCEPT`; `VALUES` as a query; `WITH` and `WITH RECURSIVE`; window functions with `PARTITION BY`, `ORDER BY`, `ROWS`/`RANGE`/`GROUPS` frames, `EXCLUDE`, named windows, `FILTER` on aggregates; `INDEXED BY` / `NOT INDEXED` |
| Expressions | Arithmetic, `%`, bitwise ops, comparisons with affinity, `IS [NOT]`, `IS [NOT] DISTINCT FROM`, `AND`/`OR`/`NOT`, `CASE`, `CAST`, `LIKE` (with `ESCAPE`), `GLOB`, `BETWEEN`, `IN` lists, `IS [NOT] NULL`, `||`, `COLLATE`, `->`, `->>`, bound parameters `?`, `?NNN`, `:name`, `@name`, `$name` |
| Scalar functions | `abs changes char coalesce format glob hex ifnull iif instr last_insert_rowid length like likelihood likely lower ltrim max min nullif printf quote random randomblob replace round rtrim sign substr substring total_changes trim typeof unicode unlikely upper zeroblob` |
| Aggregates | `avg count count(*) count(DISTINCT) group_concat max min sum total`, with `FILTER` and `DISTINCT` |
| Window | `row_number rank dense_rank percent_rank cume_dist ntile lag lead first_value last_value nth_value`, every aggregate `OVER` |
| Date/time | `date time datetime julianday strftime unixepoch` with SQLite's modifiers (`+N days`…, `start of …`, `weekday N`, `unixepoch`, `localtime`/`utc` excluded from the oracle) |
| JSON | `json json_array json_array_length json_extract json_insert json_object json_patch json_quote json_remove json_replace json_set json_type json_valid json_group_array json_group_object`, `->`, `->>` (hand-written, SQLite's minified output text) |
| Transactions | `BEGIN [DEFERRED/IMMEDIATE/EXCLUSIVE]`, `COMMIT`/`END`, `ROLLBACK`, `SAVEPOINT`, `RELEASE`, `ROLLBACK TO` |
| PRAGMA | `table_info table_xinfo index_list index_info index_xinfo foreign_key_list foreign_keys foreign_key_check integrity_check quick_check journal_mode page_size page_count freelist_count cache_size busy_timeout user_version application_id schema_version wal_checkpoint wal_autocheckpoint synchronous database_list` |
| Other | `EXPLAIN` (Strata's opcode listing), `EXPLAIN QUERY PLAN` (SQLite's `SCAN`/`SEARCH … USING [COVERING] INDEX … (a=?)` wording), `ANALYZE`, `VACUUM`, `VACUUM INTO 'file'` |
| Shell (`strata`) | `strata [db] [sql]`, SQL from stdin; `.tables .schema .indexes .headers .mode list/csv/quote/line/column/insert .separator .nullvalue .import --csv .read .output .dump .quit`; output byte-equal to `sqlite3` for `list`, `csv`, `quote`, `insert` and for `.dump`, `.tables`, `.schema` |

Out of scope: UTF-16, auto-vacuum, `ATTACH`, virtual tables (including `json_each`,
FTS, R-Tree), loadable extensions, `WITHOUT ROWID`, generated columns, expression
indexes, `-shm` sharing with sqlite3. Stretch items (recorded, never required):
`WITHOUT ROWID`, `json_each`/`json_tree`, generated columns.

**Errors** carry SQLite's primary and extended result codes and SQLite's exact message
text, at least: `near "X": syntax error`, `incomplete input`, `no such table: T`,
`no such column: C`, `ambiguous column name: C`, `table T already exists`,
`UNIQUE constraint failed: t.c`, `NOT NULL constraint failed: t.c`,
`CHECK constraint failed: name`, `FOREIGN KEY constraint failed`,
`datatype mismatch`, `integer overflow`, `misuse of aggregate: f()`,
`database is locked`, `cannot start a transaction within a transaction`,
`cannot commit - no transaction is active`, `no such savepoint: s`,
`cannot store TEXT value in INTEGER column t.c` (STRICT).

---


---

## 3. Team

| Agent | Workspace | Lane | Owns |
| --- | --- | --- | --- |
| **Main** | `int`, `verify` | all | Skeleton, `strata-types` and its IRs, the dependency list and `Cargo.lock`, `scripts/` (env, oracle, cargo slot, sqlite3 build), the slt format and runner, the baseline corpus, the acceptance harness frame and `docs/acceptance.md`, briefs, contract Commits, merges and conflicts, integration, publishing, the ledger, the report |
| **F1** | `w-f1` | front | `strata-parser` |
| **F2** | `w-f2` | front | `strata-sema`, `strata-planner` |
| **V1** | `w-v1` | vm | `strata-codegen` |
| **V2** | `w-v2` | vm | `strata-vm`, `strata-func` |
| **S1** | `w-s1` | store | `strata-btree` |
| **S2** | `w-s2` | store | `strata-pager`, `strata-wal` |
| **T1** | `w-t1` | tools | `strata`, `strata-cli`, `strata-gen` |
| **T2** | `w-t2` | tools | the slt corpus beyond the baseline (always from the oracle), function/affinity grids and data fixtures, the acceptance checks' code in `strata-accept`, the kill -9 torture driver, interop fixtures |

Workers are subagents started by the main agent with `subagent`; they cannot start
subagents themselves (DSH max depth 1). DSH allows 8 live subagents per root, so all
eight run at once and a replacement can only start after a worker ends. The main agent
never writes lane features, except to fix integration bugs.

### 3.1 Milestones

Each cell is the finished behavior for that round, with tests. A worker with two crates
does both columns' work for its crates (the second crate's cell after the semicolon).

| Worker | Round 1 (M1) | Round 2 (M2) | Round 3 (M3) |
| --- | --- | --- | --- |
| F1 | Full lexer (all literal forms, `X''` blobs, quoted identifiers `""`/`[]`/backticks, comments); DDL, DML, `SELECT` core with every expression form; positions on errors | CTEs, compound selects, window syntax, upsert, `RETURNING`, triggers, `ALTER`, `PRAGMA`, `VACUUM INTO`, `EXPLAIN [QUERY PLAN]` | SQLite's exact syntax-error messages; SQL printer for `sqlite_schema` text and rename rewrites; no-panic fuzzing (proptest), depth limits |
| F2 | sema: catalog from `sqlite_schema`; name resolution with aliases and qualified names; affinity from declared type; collation resolution; `no such table/column` messages; planner: full scan, rowid lookup/range, filter, nested-loop join (all join kinds), aggregate, sort, limit; constant folding | sema: correlated subqueries, CTE scoping, views, triggers `NEW`/`OLD`, constraint and FK metadata, `STRICT`; planner: index selection (equality/range prefixes, covering, `IN`, `OR` terms), join ordering with a cost model fed by `sqlite_stat1`, subquery flattening, `IN`/`EXISTS` decorrelation, partial-index use | sema: window binding; dependency analysis for `ALTER TABLE RENAME TABLE/COLUMN` and `DROP COLUMN`; parameter numbering as SQLite; planner: `EXPLAIN QUERY PLAN` in SQLite's wording; `ANALYZE` writes `sqlite_stat1`; ORDER BY satisfied by an index; plans that make A12/A13 fast |
| V1 | Codegen for `SELECT`/`INSERT`/`UPDATE`/`DELETE`, `CREATE TABLE`/`INDEX` (root pages, `sqlite_schema` rows), `NOT NULL`/`UNIQUE`/`PRIMARY KEY` | Conflict algorithms and upsert, `RETURNING`, `CHECK`, foreign keys (immediate, deferred, actions), triggers, `AUTOINCREMENT` | `ALTER TABLE` (all forms), `VACUUM`/`VACUUM INTO`, window codegen, `EXPLAIN` listing |
| V2 | vm: registers and cursors over the `BTree` trait (and `MemBTree`), comparisons with affinity, in-memory sorter, aggregates; func: text↔number conversion exactly as SQLite (incl. `' 12 '`, `'1e3'`, hex literals), cross-class comparison, `BINARY`/`NOCASE`/`RTRIM`, string and math functions, `printf`/`format` | vm: external merge sorter with temp files bounded by `cache_size`, ephemeral tables (DISTINCT, compound, `IN`), coroutines for subqueries/CTEs, window opcodes; func: all aggregates with `FILTER`/`DISTINCT`, `group_concat`, date/time functions with modifiers | vm: interrupt, reset/finalize cleanup, memory bounds (A14), the performance A12–A14 need; func: JSON functions and operators, window built-ins, `quote`/`hex`/`typeof`/`zeroblob`/`likelihood` |
| S1 | Record format and varints; table b-tree read/write with splits; cursors (seek, next, prev); overflow pages | Index b-trees, delete with rebalance, freelist, every page size, `integrity_check` | Bulk-load path for `VACUUM` and big inserts; cell defragmentation; speed for A12/A14 |
| S2 | pager: database header; page cache bounded in pages; unix VFS with fsync; rollback journal with hot-journal rollback; wal: WAL format, append commit frames, read path via an in-memory frame index, checksums and salts | pager: sqlite3-compatible POSIX locking, read/write transactions, change counter and schema cookie, `busy_timeout`; wal: snapshot readers (several connections), checkpoint modes, recovery on open, auto-checkpoint | kill -9 torture in rollback and WAL mode (A06), temp files for sorter/ephemeral tables, journal_mode switching; sqlite3 recovers Strata's WAL, Strata recovers sqlite3's WAL (A05) |
| T1 | `strata` facade: open/prepare/bind/step/column/finalize, schema load; `strata` shell list mode; `strata-gen` query generator (joins, filters, aggregates, subqueries) | Dot-commands, `.import`, `.dump`, PRAGMA handlers, statement cache; TPC-H-like data generator | Byte-equal shell output vs sqlite3 (A16), busy timeout and error reporting as sqlite3 prints it; generator covers windows, CTEs, compound selects, upsert |
| T2 | Corpus to ≥ 1,500 records; A01–A04 and their fixtures | Corpus ≥ 2,500; function and affinity argument grids; A05, A07–A11 | Corpus ≥ 3,000 with every area ≥ 80 records; A06 torture driver, A12–A16; every check documented in `docs/acceptance.md` |

### 3.2 Rounds and target concurrency

| Round | Workers live | Timebox | Exit gate (on the integration Branch, then on `main`) |
| --- | --- | --- | --- |
| R0 skeleton | main (+1 corpus helper subagent optional) | 60 min | Builds; gates green; `.tools/bin/sqlite3` built; slt runner runs the baseline corpus (expected to fail); published |
| R1 | **8** | 90 min | Gates green; corpus pass count recorded; A03 on simple tables |
| R2 | **8** | 120 min | Gates green; corpus ≥ 70 % passing; A01 subset, A02, A04, A05, A07–A11 attempted, results recorded |
| R3 | **8** | 120 min | Gates green; corpus ≥ 95 %; every check A01–A16 runs |
| R4+ hardening | ≤ 8, briefed per failing check | 60–90 min each | Repeat until the terminal pass (§9) |

Expected wall time 7–10 h. A worker that finishes before half its timebox gets a
follow-up task in its lane from the main agent. No round's integration may publish a
regression: the corpus pass count and passing checks never go down from one `main`
Layer to the next.

---

## 4. Concurrency ceiling and Workspace plan

| Limit | Value | Source |
| --- | --- | --- |
| Workspaces per Sandbox | **16**, dsh's own (`$SB:main`) included | skill `references/rules/team.md` (`Capacity`) |
| Sandboxes the session may use | **up to 4** on docker: `$SB` plus 3 the main agent creates (`qv2-lane-front`, `qv2-lane-vm`, `qv2-lane-store`) and closes at the end; never `$SB` | skill `references/methods/sandbox.md` (operator correction 07:41Z) |
| Concurrent DSH subagents | `maxActiveSubagents` = **8** (root not counted), max depth 1 | `@deepseek-ai/dsh-subagent` (`ACTIVATION_LIMIT_REACHED`) |
| Store writers | one at a time, **queued** on a docker Store; 2 of 140 simultaneous writes were refused `Failed` `Os { code: 2, kind: NotFound }` before effect | `issues/01-macos-store-concurrent-writers.md` (rerun on docker) |
| Machine | 8 CPUs, 8 GiB, `/tmp` a 3.9 GB tmpfs shared by all Workspaces | operator probe, `issues/02-docker-sandbox-image-env.md` |

**Workspaces are short-lived.** Every agent mounts a Workspace at the start of a bash
call and commits and unmounts it at the end of that call (skill: "one Workspace per bash
call"). A worker always uses the same name, `w-<id>`, so at most one Workspace per worker
exists at a time, and none between its bash calls. The committed `target/` and
`.cargo-home/` make the next mount warm.

| Slot | Workspace (`$SB:<name>`) | Who | Mounted |
| --- | --- | --- | --- |
| 1 | `main` (= `$WS`) | dsh | always; agents never touch it |
| 2–9 | `w-f1 w-f2 w-v1 w-v2 w-s1 w-s2 w-t1 w-t2` | one per worker | only during that worker's bash call, on its lane Branch |
| 10 | `int` | main | only during one integration bash call |
| 11 | `verify` | main | only during one fresh-fork check bash call |
| 12–16 | spare | main | a leftover's rescue; long background builds (`--exec-id`) |

Peak ≤ 11 of 16. An exec that has to outlive one bash call (over 570 s) runs in a
`run_in_background` bash call with an `--exec-id` and keeps its Workspace until it is
collected (skill `team.md` "Waiting").

---

## 5. Branch and Workspace model (LayerFS v2)

- **`main`** is the published line. Only the main agent changes it, with
  `branch publish`, and only for: the skeleton, an integration Branch whose full
  check passed, and the report. The handoff is the user's standing request to publish
  these, and nothing else.
- **`$B` (`dsh.<id>`) and `$WS`** belong to dsh. Nobody execs in, commits or unmounts
  `$WS`, writes to `$B`, or names a Branch `dsh.…`. The main agent's own turns change
  no files on `$B`, so dsh's turn-end checkpoint stays empty and conflict-free.
- **Skeleton:** Branch `skel` forked from `main`, built by the main agent in Workspace
  `int` (one bash call per step), published.
- **Lane Branches, one per lane per round,** forked from the newest `main`:
  `front-r<N>`, `vm-r<N>`, `store-r<N>`, `tools-r<N>`. **Both workers of a lane work on
  the same lane Branch at the same time**, each in its own Workspace name (`w-f1` and
  `w-f2` both mount `front-r1`), and all four lane Branches move at once.
- **Edits** are `file edit` / `file write` / `file apply` on the lane Branch (each a
  Commit at once). Bash is for commands, and for batch edits or edits that need logic
  (a codemod, a formatter, a generator, `cargo fmt`).
- **Commands:** one Workspace per bash call: `workspace mount "$SB" <lane>-r<N> --name
  w-<id>` → exec(s) → `workspace commit` → `workspace unmount`, with the unmount in a
  `trap … EXIT`. Commands use paths relative to the Workspace root, never the mount path.
- **Commit merges:** a Workspace Commit merges with what moved on the lane Branch since
  the mount (the lane-mate's `file` writes and Commits) first. A `Conflict` leaves
  markers in that Workspace, which its worker resolves before its next exec. Generated
  paths (`target/`, `.cargo-home/`, `.tools/`) merge by `/.lww`. Each worker builds into
  its own `target/w-<id>/`, so lane-mates never overwrite each other's build state.
- **Contract Commits:** when lanes need a new shared type or opcode mid-round, the main
  agent writes the **identical** change on all four lane Branches with `file apply`
  (identical changes merge cleanly later). Workers see it in their next mount.
- **Integration (per round, a chain):** `branch merge` always makes a new Branch:
  `int-r<N>.1` = `main`'s head merged with the first lane that reported (or two lanes),
  `int-r<N>.2` = `int-r<N>.1` + the next lane, and so on, one merge at a time. After
  each merge, one bash call in Workspace `int` on the result: `cargo metadata --locked
  --offline` then `cargo check --workspace`. Fixes go onto the newest `int-r<N>.<k>`
  (with `file` calls, or in `int`). Publish the last one after the round check; then
  check a fresh fork `verify-r<N>` of `main` in Workspace `verify`.
- **Branches can't be deleted.** Name them for their work; add `-2`, `-3` on
  `NameTaken`.

---

## 6. Build settings

Fixed in the skeleton. Every exec that runs Cargo or the oracle starts with
`. scripts/env.sh <ws-name> && `:

```sh
# scripts/env.sh <ws-name>: the Sandbox's PATH misses Rust; Cargo state stays in the Workspace
export RUSTUP_HOME=/usr/local/rustup PATH="$PWD/.tools/bin:/usr/local/cargo/bin:$PATH"
export CARGO_HOME="$PWD/.cargo-home" CARGO_TARGET_DIR="$PWD/target/${1:?ws name}" \
       CARGO_NET_RETRY=0 CARGO_INCREMENTAL=0 \
       CARGO_BUILD_JOBS="${JOBS:-2}" RUST_TEST_THREADS="${TEST_THREADS:-2}"
export TMPDIR="$HOME/tmp/$1"      # on the machine's disk; /tmp is a small shared tmpfs
mkdir -p "$TMPDIR" "/tmp/$1"
HOST=$(rustc -vV | sed -n 's/^host: //p')
export RUSTFLAGS="-C link-arg=-fuse-ld=lld -C link-arg=-B$(rustc --print sysroot)/lib/rustlib/$HOST/bin/gcc-ld"
unset RUSTC_WRAPPER RUSTC_WORKSPACE_WRAPPER
```

- **`sqlite3` CLI:** `scripts/sqlite3-build.sh` (skeleton) downloads
  `https://www.sqlite.org/2022/sqlite-autoconf-3400100.tar.gz` into `$TMPDIR`, builds
  `gcc -O2 -DSQLITE_THREADSAFE=0 -DSQLITE_ENABLE_MATH_FUNCTIONS shell.c sqlite3.c -lm`
  into `.tools/bin/sqlite3` (about 25 s), and checks that `sqlite3 --version` starts with
  the version Python's `sqlite3` module reports (3.40.1). `.tools/` is committed like
  `target/`, so nobody builds it again.
- `target/`, `.cargo-home/` and `.tools/` live **inside the Workspace** and are committed
  with the source (skill `rules/cargo.md`). `.gitignore` is exactly `target/`,
  `.cargo-home/`, `.tools/` and `._*`; `/.lww` is exactly `%include .gitignore`. Never
  `Cargo.lock`, manifests or sources in `/.lww`.
- **Per-Workspace target:** `CARGO_TARGET_DIR=target/<ws>`. The skeleton and every
  integration build `target/int` (debug and test builds of everything). After forking a
  round's lane Branches the main agent copies it for each worker with
  `file cp "$P" <lane>-r<N> /target/int /target/w-<id>` (server side, no data moves), so
  workers compile only their own crates. Every `/target/<ws>` stays: nothing installed or
  built in the Store is ever removed (no `file rm` of `target/`, `.cargo-home/` or
  `.tools/`), and integration Branches are published with them. `RUSTFLAGS` never
  contains the mount path (`$PWD`): every mount has a new path, and a flag that changes
  rebuilds everything (skill `rules/cargo.md`, "Build reuse across mounts").
- Profiles: `[profile.dev] debug = 0`, `[profile.dev.package."*"] debug = false`,
  `[profile.test]` inherits dev, `[profile.release] debug = false`. Each crate keeps its
  integration tests in one binary (`tests/it/main.rs`, one module per area). Every byte
  a build writes goes through the Workspace and its Commit, so smaller artifacts mean
  faster rounds.
- After the skeleton's `cargo fetch`, every Cargo command is `--locked --offline`.
- **Jobs:** workers `JOBS=2`, `TEST_THREADS=2`; the main agent `JOBS=4` when no worker
  builds, else 2. Exit 137 / signal 9 (memory): wait, rerun with `JOBS=1`.
- **Build slots:** `scripts/cargo-slot.sh` wraps Cargo with an `flock` semaphore in
  `/tmp/strata-slots/` (shared by every Workspace of one Sandbox: verified; each Sandbox has
  its own `/tmp`): **1** slot in each lane Sandbox, **2** in `$SB`, so at most 5 builds:
  it tries each slot, waits up to 300 s in total, then runs anyway with `JOBS=1`.
- **Time:** a bash call may take up to 600 s (its `timeout` in ms). Inner commands use
  `timeout 540`, so the Commit and unmount still run in the same call. Build tests first
  (`cargo test --no-run -p <crate>`), run them in the next bash call. A build that times
  out is rerun (Cargo resumes from the committed `target/`). Logs go to `/tmp/<ws>/`,
  read with `tail` in the same bash call.
- **Temp data:** tests and checks write only under `$TMPDIR` (= `$HOME/tmp/<ws>`), cap
  their files at 2 GB, and every exec that runs tests ends with
  `rm -rf "$TMPDIR"/* /tmp/<ws>/*`. Never large files in `/tmp`.
- **Dependencies** (root `[workspace.dependencies]`, crates use `workspace = true`):
  `thiserror` 2, `anyhow`, `clap` 4 (derive), `libc` (fcntl locks, `getrusage`),
  `rand` 0.8, `tempfile`, `proptest` (dev), `serde`/`serde_json` (tooling and fixtures
  only; the JSON SQL functions are hand-written). No SQL, storage or SQLite crate
  (`rusqlite`, `libsqlite3-sys`, `sqlparser` …): the oracle is the `sqlite3` binary and
  Python's `sqlite3` module, run as separate processes. New dependencies only through
  the main agent.
- `unsafe` only in `strata-pager`/`strata-btree` page access, each block with a
  `// SAFETY:` comment.

---

## 7. Commit cadence ("more commits")

v1: 913 Commits (440 Workspace Commits, 207 `fs.apply`, 161 `fs.write`, 29 merges),
302 more `UpToDate`. Targets for v2:

| Measure | Target | How it is reached |
| --- | --- | --- |
| Commits on all non-`dsh.` Branches (excluding `UpToDate`) | **≥ 1,300** (stretch 2,000) | 8 workers × 3–4 rounds, small steps |
| Commits by workers | **≥ 35 per worker per round** (≥ 840 over R1–R3) | Every `file` edit/write/apply is one Commit; every bash call that ran a command ends with a Workspace Commit (failing steps too) |
| Heartbeat | ≥ 1 Commit per 10 minutes of active work per worker | Never sit on uncommitted work |
| Merges | ≥ 12 merge Branches (≈ 3–4 per round + fixes) | §5 integration |
| Publishes | ≥ 6 Layers on `main` | skeleton, R1–R3, hardening, report |

Rules: one step per Commit, message `[<id> r<N>] <step> (<result>)`, e.g.
`[S1 r2] cargo test -p strata-btree (exit 0, 143 passed)`. No padding: no empty
changes, no timestamp-only files, no splitting a file write into byte-sized Commits.
A Commit refused or `UpToDate` doesn't count.

**Measured by:** `commit list` on every non-`dsh.` Branch (paged) counted by message
prefix per worker; the call log's `workspace.commit` results by kind (`Committed` vs
`UpToDate`) and `file` writes; merges from `branch list`; Layers from
`branch commits "$P" main`. The main agent records counts per round in the ledger.

---

## 8. The oracle and the acceptance checks

### 8.1 Oracle and corpus

- `scripts/oracle.py` (main, skeleton): runs a script on Python's `sqlite3` module
  (autocommit, `isolation_level=None`) and the `sqlite3` CLI at `.tools/bin/sqlite3` (built in the skeleton from
  SQLite 3.40.1's amalgamation, the same library version as Python's module, recorded
  in every generated file's header). It turns
  sources `tests/slt-src/*.sqlin` into `tests/slt/*.slt`. `oracle.py --check`
  regenerates everything and must be byte-identical to what is committed.
- Format: standard sqllogictest (`statement ok`, `statement error <SQLite message>`,
  `query <I|R|T…> [nosort|rowsort|valuesort]`, `----`, integers as `%d`, reals as
  `%.3f`, NULL as `NULL`, empty text as `(empty)`, optional `hash-threshold`). Text
  results computed by SQLite itself (`CAST(x AS TEXT)`, `printf`, `typeof`) check
  exact real formatting.
- Expected results are **never typed by hand** and never edited to match Strata.
  Only the main agent and T2 change corpus files, and only through the oracle.
- **Size: ≥ 3,000 records in ≥ 24 files**, every area ≥ 80 records, ≥ 10 % error
  records: ddl, insert, update-delete, select, expressions, affinity-typeof,
  collation, null-3vl, joins, subqueries, compound, cte, recursive, aggregates, window,
  functions-string, functions-math, datetime, json, constraints, upsert-returning,
  foreign-keys, triggers, views, alter, transactions-savepoints, pragma, errors.
  The skeleton ships ≥ 600 records; T2 grows it per §3.1. (v1: 800.)

### 8.2 Acceptance (`strata-accept`)

`cargo build --release -p strata-cli -p strata-accept`, then
`target/release/strata-accept run Annn`, each check **under 100 s**, each printing
`Annn PASS` or `Annn FAIL <why>`. Checks compare with `sqlite3` on the same data,
never with stored Strata output. Pass criteria below are fixed; changing a check's code
needs the main agent's review against this table.

| Check | Scenario | Pass |
| --- | --- | --- |
| A01 | The whole slt corpus, embedded | every record passes |
| A02 | Differential: 5,000 queries from `strata-gen --seed 1` over generated data | rows identical to sqlite3 (sorted when no `ORDER BY`), errors match |
| A03 | Read interop: databases written by sqlite3 (all corpus schemas, TPC-H-like 0.05, rows > 16 KB with overflow, page sizes 1024/4096/65536, freelist pages after deletes) | Strata reads every table and index; queries match sqlite3; Strata's `integrity_check` is `ok` |
| A04 | Write interop: the same workloads written by Strata, closed | `sqlite3 db 'PRAGMA integrity_check'` = `ok`; sqlite3 query results identical; `sqlite3 .dump` of Strata's file equals `.dump` of sqlite3's file for the same script |
| A05 | WAL: two connections in one process, snapshot isolation of readers, all four checkpoint modes; a WAL left by a SIGKILLed sqlite3 process | readers see their snapshot; after checkpoint sqlite3 `integrity_check` = `ok`; Strata recovers sqlite3's WAL with exactly the committed rows |
| A06 | Crash torture: 10 runs per mode (rollback, WAL) of 20 s transfers between accounts, `strata` killed with SIGKILL at a random moment | After reopen by Strata **and** by sqlite3 (on a copy): total balance unchanged, every acknowledged Commit visible, no unacknowledged one, `integrity_check` = `ok` |
| A07 | Locking interop (rollback mode): sqlite3 holds `BEGIN IMMEDIATE`, Strata writes; and the reverse | the blocked side gets `database is locked` after its busy timeout and succeeds once the lock is released |
| A08 | Constraints, upsert, `RETURNING`, foreign keys (all actions, deferred), triggers (all kinds, `RAISE`) — scripted scenarios | results, `changes()`, and error messages identical to sqlite3 |
| A09 | Affinity matrix: every declared-type affinity × every literal kind, `typeof()` and cross-class comparisons, `STRICT` | identical to sqlite3 |
| A10 | Function grid: every function in §2.3 over generated arguments (no `random`, `randomblob`, `now`, `localtime`) | identical to sqlite3 |
| A11 | Windows (all frame kinds, `GROUPS`, `EXCLUDE`, named windows) and recursive CTEs (graph walk, running totals, series) | identical to sqlite3 |
| A12 | Planner: 1,000,000-row table, after `ANALYZE` | `EXPLAIN QUERY PLAN` shows `SEARCH … USING INDEX`; ≥ 20× faster than `NOT INDEXED`; a 6-table join written in a bad order finishes < 5 s; `sqlite_stat1` has a row per index sqlite3 would write |
| A13 | TPC-H-like scale 0.05 (built by `strata-gen`, loaded by both engines): Q1, Q3, Q5, Q6, Q10, Q12, Q14, Q19 (dates as ISO text) | rows identical; each < 10 s |
| A14 | Sorter: `ORDER BY` and `GROUP BY` over 2,000,000 rows with `PRAGMA cache_size=-8192` | rows identical; peak RSS (`VmHWM`) < 256 MiB; temp files were used |
| A15 | Schema changes: `ALTER TABLE` (all four forms), `CREATE/DROP INDEX/VIEW/TRIGGER`, `VACUUM` after deleting 90 % of rows, `VACUUM INTO` | after each step sqlite3 `integrity_check` = `ok` and `SELECT type,name,tbl_name,sql FROM sqlite_schema` equals sqlite3's for the same script; `VACUUM` shrinks the file ≥ 70 % |
| A16 | Shell: same database through `strata` and `sqlite3` | `.tables`, `.schema`, `.mode list/csv/quote/insert` output and `.dump` byte-identical; `strata db .dump \| sqlite3 new.db` reproduces identical content; `.import --csv` loads the same rows |

### 8.3 Tests and gates

- Unit tests in each crate and **≥ 4 integration test files per crate** in `tests/`.
  Property tests with `proptest` where a model exists (b-tree vs `BTreeMap`, record and
  varint round trips, WAL replay vs applied pages, parser print/parse round trip).
  Target **≥ 1,500 tests** in total (v1: 891).
- Quality gates: `cargo fmt --all --check`,
  `cargo clippy --workspace --all-targets --locked --offline -- -D warnings`,
  `cargo test --workspace --locked --offline` (per crate when the workspace doesn't fit
  in one bash call). At most 5 `#[ignore]` per crate, each with a reason.

---


---

## 9. Terminal pass

The run is done only when **all** of these hold. Anything less is not done.

1. **Fresh fork of the final `main`.** Fork `final-verify-<n>` from `main`'s latest
   Layer and mount it as Workspace `verify` (new, never left over). With §6's settings
   (`. scripts/env.sh verify`), each command separately, each under 540 s:
   - `cargo fmt --all --check` → exit 0;
   - `cargo clippy --workspace --all-targets --locked --offline -- -D warnings` → exit 0
     (per crate allowed; every one exit 0);
   - `cargo test --workspace --locked --offline` → 0 failed (per crate allowed), total
     passed ≥ 1,500, every crate has ≥ 4 integration test files;
   - `python3 scripts/oracle.py --check` → byte-identical; corpus ≥ 3,000 records in
     ≥ 24 files;
   - `strata-slt tests/slt` → every record passes;
   - `cargo build --release -p strata-cli -p strata-accept`, then
     `strata-accept run A01` … `A16` → sixteen `PASS` lines, each run < 100 s;
   - `find . -name '._*' -not -path './target/*' -not -path './.cargo-home/*'` → empty.
   These may span several bash calls (mount → commands → commit → unmount each time, on
   the same `final-verify-<n>` Branch); the verification Commits are on that Branch.
2. **Every milestone of §3.1** is built with tests (the report's table names the tests
   per cell).
3. **`/docs/BUILD-REPORT.md` is on `main`**: either in the verified Layer, or in one
   later report-only publish whose `branch diff` against the verified Commit touches
   only `/docs/BUILD-REPORT.md`.
4. **Clean finish:** every worker has finished (no live subagent), and
   `layerfs sandbox get "$SB"` lists **only** dsh's Workspace `main`. `$WS` has no
   pending merge and no markers. The session Sandbox is not closed (agents can't, and
   must not).
5. The ledger `./quarry-v2/PROGRESS.md` ends with the terminal-pass entry.

A pass on an integration or worker Branch doesn't count until it is published and
rerun on a fresh fork of `main`.

**Terminal failure** only when LayerFS itself blocks progress: an `Unknown`/`Failed`
outcome that can't be established from the project's state, a refusal that contradicts
the skill, or the same LayerFS error after a changed approach (including the
`Capacity`, `NoSuchSandbox` or `Unavailable` that only the user can fix). Then: write
the exact calls and results into the report, publish it if possible, unmount
everything, stop. Compiler errors, failing tests, wrong results, slow builds, merge
conflicts and missing features are never terminal. **Scope is fixed:** only the user
may drop or relax a check.

---

## 10. Resource budget

| Resource | Budget | Basis / floor |
| --- | --- | --- |
| Docker CPUs | 8 | ≤ 3 Cargo builds × `JOBS=2` through the slots, plus tests and the oracle |
| Docker memory | 8 GiB (≈ 5 GiB available) | ≈ 0.5–1 GB per rustc/link with line-tables debuginfo; exit 137 → `JOBS=1` |
| Docker disk | ≈ 116 GB free at start; **floor 30 GB** | `target/<ws>` ≤ 3 GB × (8 workers + `int` + `verify`) per Branch in use + Store + temp. Below 30 GB the main agent stops starting builds and tells the user |
| `/tmp` | 3.9 GB tmpfs, shared | logs and exit codes only |
| Workspaces | ≤ 11 of 16 at once | §4 |
| Subagents | 8 live | §4 |
| Wall time | 7–10 h | v1 4 h 16 min for a smaller engine |

The main agent records `df -h /`, `free -g` and `du -sh target/* .cargo-home` (in `int`)
at every integration.

---

## 11. Evidence to record

The main agent, in the ledger and the report:

- Per round: lane Branch heads, each worker's last Commit, test counts, Commit count,
  and status; merges and Conflicts with their resolution; contract Commits; publishes
  with their Layers; the round's check results (gates, corpus passed/total, A01–A16).
- Concurrency: the highest number of simultaneously live workers, the highest number
  of mounted Workspaces seen in `sandbox get "$SB"`, every `Capacity` or
  `ACTIVATION_LIMIT_REACHED`.
- Refusals by code (`Conflict`, `Busy`, `HeadMoved`, `Failed`, `Unknown`, …) with what
  was done; slow LayerFS calls (> 10 s for anything but `workspace exec`).
- Commit counts (§7) per worker, per round, per hour.
- Disk and memory at each integration; `target/` sizes per Workspace.
- Wall times: round starts and ends, first and last worker report per round.

The operator, after the run (outside the agents): session ids and logs, the call log
(`$DSH_HOME/layerfs/trace/calls.jsonl`) counts and latencies per call family vs v1, the
Store totals from the app's Storage/Stats views, screenshots of History and Files.

## 12. Report (`/docs/BUILD-REPORT.md`)

What was built crate by crate and the decisions behind it; each round's Branch heads,
merges, Conflicts and Layers; the final check (gates, tests per crate, slt records,
A01–A16 with timings); the Commit table (§7); concurrency and disk evidence (§11);
LayerFS surprises (refusals, slow steps, anything a future team should know).

---


## Open questions

Settled by the operator's preflight (2026-11-13):

1. **Image on `docker`:** the Sandbox root is the bundle's `sandbox-image.tar` whatever
   the machine records; it has Rust 1.85.1 but its environment is not applied (§1, §6,
   `issues/02`). No custom image.
2. **Docker resources:** not resized (8 CPUs, 8 GiB); the run is sized to fit.
3. **Subagent capacity:** 8 (default); hence 8 workers.
4. **crates.io and sqlite.org** are reachable from a docker Sandbox.
5. **Shared `/tmp`:** yes, across Workspaces of one Sandbox; it is a 3.9 GB tmpfs.
6. **Store concurrency:** writers queue on docker; residual `Failed NotFound` ≈ 1.4 %
   before effect (`issues/01`).

Still open:

7. **Reasoning effort of workers.** A child inherits the parent's route; the handoff
   passes `reasoning_effort: "max"`. Confirm in the first worker's session view.
8. **Disk per Workspace:** whether a short-lived mount of a Branch with a large
   committed `target/` costs time or disk per mount is unmeasured; watch mount and commit
   latency.
9. **Idle close.** dsh closes the session Sandbox 30 min after the session's agent is
   disposed. Keep the session open.
10. **Commit counting.** `commit list` walks first parents; cross-check with the call log.
11. **Feasibility.** The scope is large for the model and the machine; the terminal pass
    does not shrink if timeboxes slip.
