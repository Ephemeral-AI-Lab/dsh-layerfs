# Quarry: a SQL database in Rust, built by a team of agents

Quarry is a SQL database: its own parser, a cost-based optimizer, a vectorized
executor that spills to disk, paged storage with B+tree indexes, a write-ahead log,
MVCC with snapshot isolation, crash recovery, vacuum, and the PostgreSQL wire
protocol. A main agent and seven workers in three lanes build it as a Cargo workspace
in the LayerFS project, through the LayerFS SDK.

This file says **what** to build and **how the team works**. Inside each crate the
design is up to the team: choose names, modules and algorithms freely, as long as the
behavior below holds and the tests prove it. Results are checked against SQLite, so
"works" means "returns the same rows".

The run has a second purpose: it shows how LayerFS stores large Rust builds. Every
build's `target/` (several GB with this spec's settings) and the dependency cache
`.cargo-home/` are committed with the source, on every Branch. Parallel Branches
compile the same dependencies, and LayerFS should keep those artifacts once. The
[storage evidence](#storage-evidence) section says what to record.

## Kickoff (for the main agent)

1. Read the LayerFS SDK guide (`cat "$DSH_LAYERFS_SKILL"`), its Cargo rules
   (`cat "$(dirname "$DSH_LAYERFS_SKILL")/references/rules/cargo.md"`) and this file.
   This file is in the local folder; the code goes into the LayerFS project, never
   into the local folder.
2. The project is `dsh-rust-playground`, and the Cargo workspace lives at its root.
   `main` is read-only, and its first Layer holds only the files the project was
   imported from (see HANDOFF.md): build on Branches and publish them. The local
   folder is `dsh-new-playground`, scratch only.
3. Build the skeleton (below), publish it, then start the seven workers together,
   each with its lane brief from this file.
4. Integrate after each milestone round, run the checks, and publish.
5. Finish with the report described at the end.

## Team

| Agent | Count | Lane | Owns |
| --- | --- | --- | --- |
| Main agent | 1 | all | Skeleton, `quarry-types`, the dependency list, the test corpus and oracle, the acceptance harness, lane briefs, merges and conflicts, integration, publishing, report |
| `sql` workers P1, P2, P3 | 3 | sql | P1 the parser, P2 the binder, catalog and types, P3 the planner and optimizer |
| `exec` workers X1, X2 | 2 | exec | X1 the operators, X2 expressions, functions and the wire-protocol server |
| `store` workers S1, S2 | 2 | store | S1 pages, buffer pool, heap and indexes, S2 the WAL, transactions, recovery and vacuum |

Each worker is a subagent with the same tools as the main agent. The main agent never
writes lane features itself, except to fix integration bugs. Test infrastructure (the
corpus, the oracle, the generators, the acceptance harness) is the main agent's.

## Stack

- Rust **1.85.1** (edition 2024, `rust-version = "1.85"`), Clippy and rustfmt, from
  the Sandbox image named in HANDOFF.md. The default Sandbox image has no Rust.
  Python 3 with SQLite 3.40.1 is in the same image: it is the oracle.
- One Cargo workspace at the project root, `resolver = "3"`, so Cargo picks dependency
  versions that build on 1.85.
- **Dependencies** are declared once, in the root `[workspace.dependencies]`, and
  crates use `{ workspace = true }`. The main agent fixes this list in the skeleton:

  | Crate | Use |
  | --- | --- |
  | `tokio` (rt-multi-thread, net, macros, sync, time, fs, io-util, signal), `bytes` | The wire-protocol server |
  | `serde` (derive), `serde_json` | Plans for `EXPLAIN (FORMAT JSON)`, test fixtures |
  | `thiserror` 2, `anyhow` | Errors |
  | `tracing`, `tracing-subscriber` (env-filter, json) | Logging |
  | `clap` 4 (derive) | The `quarry` binary |
  | `crc32fast`, `rand` 0.8 | Checksums, generators |
  | `tempfile`, `proptest` (dev) | Tests |
  | `tokio-postgres` 0.7 (dev) | A real PostgreSQL client for wire-protocol tests |

  No SQL parser, query engine, storage engine or protocol crate: Quarry builds those
  itself. A worker that needs another crate asks the main agent. Every new crate is
  compiled by every Branch, so the list grows only with a reason.
- **Build settings**, the same for every agent and every command, so that parallel
  Branches produce identical dependency artifacts:

  ```sh
  export CARGO_HOME="$PWD/.cargo-home" CARGO_TARGET_DIR="$PWD/target" \
         CARGO_NET_RETRY=0 CARGO_BUILD_JOBS=2 CARGO_INCREMENTAL=0 \
         RUSTFLAGS="--remap-path-prefix=$PWD=/w -C link-arg=-fuse-ld=lld -C link-arg=-B$(rustc --print sysroot)/lib/rustlib/aarch64-unknown-linux-gnu/bin/gcc-ld"
  unset RUSTC_WRAPPER RUSTC_WORKSPACE_WRAPPER
  ```

  The path remap makes the artifacts independent of the Workspace path; lld (the
  `rust-lld` shipped with the toolchain) links fast and in little memory. The root
  `Cargo.toml` sets `debug = "full"` for `[profile.dev]` and `[profile.test]`. After
  the skeleton's `cargo fetch`, every Cargo command uses `--locked --offline`.
- **Tests:** unit tests in each crate, and **at least four integration test files per
  crate** in its `tests/` folder (each is its own binary). Property tests with
  `proptest` where the behavior has a model. Network tests bind `127.0.0.1:0` and use
  a temporary data folder. Build tests first (`cargo test --no-run -p <crate>`), then
  run them in a separate command.
- **Quality gates:** `cargo fmt --all --check`, `cargo clippy --workspace --all-targets
  --locked --offline -- -D warnings`, `cargo test --workspace --locked --offline`.
- `unsafe` only in `quarry-storage`'s page access, each block with a comment saying
  why it's sound.

There's no size target. Build the features well; don't pad.

## SQL that Quarry supports

Types: `BIGINT` (and `INT`, `INTEGER`), `DOUBLE PRECISION` (and `FLOAT`, `REAL`),
`TEXT` (and `VARCHAR(n)`), `BOOLEAN`, and `NULL`. Dates are ISO-8601 `TEXT`.
Three-valued logic and SQL `NULL` semantics throughout. Integer overflow and division
by zero are errors, not wraparound.

| Area | Statements and features |
| --- | --- |
| DDL | `CREATE TABLE` (`PRIMARY KEY`, `NOT NULL`, `UNIQUE`, `DEFAULT`, `CHECK`), `DROP TABLE`, `ALTER TABLE … ADD COLUMN`, `CREATE [UNIQUE] INDEX` (multi-column), `DROP INDEX`, `CREATE VIEW` |
| DML | `INSERT` (multi-row `VALUES`, `INSERT … SELECT`, `ON CONFLICT DO NOTHING / DO UPDATE`), `UPDATE`, `DELETE`, `RETURNING`, `COPY t FROM STDIN` over the wire |
| Queries | `WHERE`, `GROUP BY`, `HAVING`, `ORDER BY … [ASC|DESC] [NULLS FIRST|LAST]`, `LIMIT`/`OFFSET`, `DISTINCT`; `INNER`, `LEFT`, `RIGHT`, `FULL` and `CROSS` joins; scalar, `IN`, `EXISTS` and correlated subqueries; `UNION [ALL]`, `INTERSECT`, `EXCEPT`; `WITH` and `WITH RECURSIVE`; window functions (`ROW_NUMBER`, `RANK`, `DENSE_RANK`, `LAG`, `LEAD`, aggregates `OVER` with `ROWS` and `RANGE` frames) |
| Expressions | Arithmetic, comparison, `AND`/`OR`/`NOT`, `CASE`, `CAST`, `COALESCE`, `NULLIF`, `LIKE`, `BETWEEN`, `IN` lists, `IS [NOT] NULL`, `||`; `lower`, `upper`, `length`, `substr`, `trim`, `replace`, `abs`, `round`, `mod`; `count`, `count(DISTINCT)`, `sum`, `avg`, `min`, `max`, `string_agg` |
| Transactions | `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `ROLLBACK TO`; snapshot isolation; a write-write conflict fails the later committer with SQLSTATE `40001` |
| Other | `EXPLAIN`, `EXPLAIN ANALYZE`, `EXPLAIN (FORMAT JSON)`; `ANALYZE` (statistics); `VACUUM`; `SET work_mem`, `SET statement_timeout`, `SET enable_indexscan`, `SET enable_hashjoin` |

Errors carry PostgreSQL SQLSTATE codes: at least `42601` syntax error (with the
position), `42P01` undefined table, `42703` undefined column, `42804` datatype
mismatch, `23502` not-null violation, `23505` unique violation, `23514` check
violation, `22003` numeric out of range, `22012` division by zero, `40001`
serialization failure, `57014` query canceled.

## Skeleton (main agent, before the workers start)

- Root `Cargo.toml` with the workspace, `[workspace.dependencies]`, the profiles and
  every crate below as a member; `rust-toolchain.toml` pinning 1.85.1; `Cargo.lock`
  from `cargo generate-lockfile`, then `cargo fetch --locked`.
- `.gitignore` containing exactly `target/` and `.cargo-home/`, and a `/.lww`
  containing `%include .gitignore`. Nothing else goes in either file: source,
  manifests and `Cargo.lock` must merge as source.
- **`quarry-types`** (owned by the main agent; lanes may make small additive edits):
  - `DataType`, `Value`, `Schema`, `Row`, and a columnar `Batch` of up to 1,024 rows;
  - `Error` with SQLSTATE codes and an optional position;
  - the AST, `Expr`, `LogicalPlan` and `PhysicalPlan` types the lanes hand to each
    other;
  - the traits every lane codes against: `Catalog`, `Storage` (tables with row ids:
    scan, insert, update, delete), `Index` (point and range lookups), `TxnManager`
    and `Txn` (begin, snapshot, commit, abort), and `Statistics`;
  - `MemStorage`, an in-memory implementation of those traits with a trivial
    transaction manager, so the `sql` and `exec` lanes can build and test before the
    `store` lane lands.
- **Stub crates**, each building and with one passing test: `quarry-parser`,
  `quarry-binder`, `quarry-planner` (sql); `quarry-exec`, `quarry-expr`,
  `quarry-server` (exec); `quarry-storage`, `quarry-txn` (store).
- **`quarry`** (binary): `quarry serve --data <dir> --port <n>` and
  `quarry sql --data <dir>` (a local shell), wiring the crates together. Lanes add to
  it with small edits.
- **Test infrastructure** (main agent):
  - `tests/slt/*.slt`: a sqllogictest corpus of **at least 600 records** across
    every area of the SQL table above, with expected results produced by SQLite
    through `scripts/oracle.py`, and expected errors with their SQLSTATE;
  - `crates/quarry-slt`: a runner for that format (`statement ok`, `statement error
    <sqlstate>`, `query <types> [rowsort]`), against an embedded Quarry or a server;
  - `scripts/oracle.py`: runs a script of statements on SQLite and prints normalized
    results (booleans as `true`/`false`, floats rounded to 9 significant digits,
    `NULL` as `NULL`);
  - `crates/quarry-gen`: a seeded random query generator over a fixed schema (joins,
    filters, aggregates, subqueries, set operations, window functions; only
    constructs whose results SQLite and Quarry define the same way), and a seeded
    TPC-H-style data generator (`--scale 0.05` ≈ 50 MB);
  - `crates/quarry-accept`: the acceptance harness below, with no checks yet.
- `docs/architecture.md`: the crates, the traits, the path of a query from bytes on
  the wire to rows on the wire, and how a lane plugs in.
- The skeleton is done when the build, the quality gates and the slt runner (with the
  corpus marked expected-to-fail) all run. It's published with `target/` and
  `.cargo-home/` committed.

Each lane owns its crates. Lanes meet only through `quarry-types`.

## Lane `sql`: P1, P2, P3

| Milestone | Finished behavior |
| --- | --- |
| P-M1 | **P1:** `quarry-parser`: a hand-written lexer and recursive-descent parser for DDL, DML and `SELECT` (filters, grouping, ordering, limits, all join kinds), with errors that carry the byte position (`42601`). **P2:** `quarry-binder`: name resolution with aliases and qualified names, type checking with the implicit casts SQLite and PostgreSQL agree on, the catalog for DDL over `MemStorage`, constraint metadata. **P3:** `quarry-planner`: logical plans; rewrites (constant folding, predicate pushdown, projection pruning); physical plans (sequential scan, filter, project, nested-loop and hash join, hash aggregate, sort, limit); `EXPLAIN`. |
| P-M2 | **P1:** subqueries, set operations, `WITH`, `INSERT … SELECT`, `ON CONFLICT`, `RETURNING`, `CASE`, `CAST`, views. **P2:** correlated subquery binding; views; `ALTER TABLE`; constraint checks at bind time where possible. **P3:** decorrelation of `IN`/`EXISTS` into semi and anti joins; a cost model fed by `ANALYZE` statistics (row counts, distinct values, histograms); index selection; join reordering (dynamic programming up to 6 tables, greedy above). |
| P-M3 | **P1:** window functions, `WITH RECURSIVE`, `$n` parameters, `EXPLAIN ANALYZE` and `EXPLAIN (FORMAT JSON)`. **P2:** window binding; parameter type inference for prepared statements. **P3:** window planning; merge join when inputs are ordered; top-N sort; a plan cache for prepared statements, invalidated by DDL and `ANALYZE`. |

## Lane `exec`: X1, X2

| Milestone | Finished behavior |
| --- | --- |
| X-M1 | **X1:** `quarry-exec`: a pull-based vectorized engine over `Batch`; sequential scan over `Storage`, filter, project, nested-loop join, hash join (inner, left), hash aggregate, sort, limit; DML operators. **X2:** `quarry-expr`: a vectorized evaluator with three-valued logic, arithmetic with overflow and division errors, comparisons, `LIKE`, `CAST`, the string and math functions. `quarry-server`: the PostgreSQL startup handshake (no TLS, trust auth), the simple query protocol, `RowDescription`/`DataRow`/`CommandComplete`, `ErrorResponse` with SQLSTATE and position. |
| X-M2 | **X1:** right, full, semi and anti joins; merge join; `DISTINCT`; set operations; **spilling**: sort, hash aggregate and hash join stay within `work_mem` (default 16 MiB) by spilling to temporary files. **X2:** aggregates (`count(DISTINCT)`, `avg`, `string_agg`), `CASE`, `COALESCE`, `NULLIF`; the extended query protocol (Parse, Bind, Describe, Execute, Sync, Close), prepared statements with typed parameters, many concurrent sessions. |
| X-M3 | **X1:** window operators with `ROWS` and `RANGE` frames; top-N; per-operator counters for `EXPLAIN ANALYZE` (rows, loops, time, bytes spilled). **X2:** cancel requests and `statement_timeout` (`57014`); `COPY … FROM STDIN`; session `SET` variables; server metrics (`quarry serve --metrics-port`). |

## Lane `store`: S1, S2

| Milestone | Finished behavior |
| --- | --- |
| S-M1 | **S1:** `quarry-storage`: 8 KiB slotted pages with checksums, a disk manager, a buffer pool bounded in pages with pin counts and clock eviction, heap files with row ids, and `Storage` scan, insert, update and delete. **S2:** `quarry-txn`: a WAL with LSNs, CRC-framed records and group commit; redo recovery for heap changes; `BEGIN`/`COMMIT`/`ROLLBACK` with one writer at a time. |
| S-M2 | **S1:** B+tree indexes (unique and non-unique, multi-column keys, splits and merges, range scans) behind `Index`; values over 2 KiB in overflow pages; a sampling API for `ANALYZE`. **S2:** MVCC: versioned tuples (creating and deleting transaction ids), snapshots, snapshot isolation with concurrent readers and writers, first-committer-wins write conflicts (`40001`). |
| S-M3 | **S1:** a free-space map; `VACUUM` reclaiming dead versions and their index entries; checkpoints flushing dirty pages. **S2:** full crash recovery (redo, then undo of transactions that never committed) covering heap, indexes and transaction state; checkpoints that bound recovery; savepoints; a `kill -9` torture test in `tests/`. |

A lane that needs another lane's crate uses its `quarry-types` trait, never its
internals. Until a real implementation lands, use `MemStorage` or a stub behind your
own interface, and ask the main agent.

## How the team works in LayerFS

- **One Branch and one Sandbox per lane.** The main agent builds the skeleton on
  Branch `skeleton` in its own Sandbox `sb-main`, and publishes it. For each milestone
  round it forks the lane Branches from `main` (`sql-m1`, `exec-m1`, `store-m1`, then
  `-m2` and `-m3`). It creates the lane Sandboxes once, for the whole run: `sb-sql`,
  `sb-exec` and `sb-store`, all with the Rust image. A lane's workers all work on the
  lane's Branch, in the lane's Sandbox, at the same time.
- **One build Workspace per worker per round.** A fresh mount has a new path, and
  Cargo then recompiles every dependency and relinks every test binary. So each
  worker keeps one Workspace mounted for its whole round:
  - mount it once, print and record its path, and reuse it from every bash call;
  - exec each step there, and commit after every step that changes files, a failing
    one too, with the step and its result in the message;
  - after `fs.*` edits or a lane-mate's Commit, commit in the Workspace (an `UpToDate`
    Commit also brings them in) before building;
  - unmount it, in a `finally` block, before reporting. Never leave one mounted.

  Short checks and the main agent's integration steps use mount → exec → commit →
  unmount in one bash call, as usual.
- **Commits** made after the Branch moved merge with the newer head first. A Commit
  refused `Conflict` leaves markers in that worker's Workspace: resolve them there,
  rebuild, test, and commit again. Generated files in `target/` and `.cargo-home/`
  take the newer side through `/.lww`; never add other paths there. A Commit of a
  multi-GB tree takes seconds to tens of seconds: build and test once per step, not
  after every edit.
- **Ownership.** Each worker owns its files. In shared files (a crate's `lib.rs`, the
  `quarry` binary) make small, additive edits.
- **Time.** Keep every command under 2 minutes: `timeout 110 cargo build …`. A first
  build in a Workspace can take a minute while other lanes compile. If one times out,
  run it again in the same Workspace: Cargo continues where it stopped. If rustc or
  the linker is killed for memory (exit 137 or signal 9), rerun with
  `CARGO_BUILD_JOBS=1`.
- **Disk.** Each mounted Workspace holds its own copy of what it builds. At every
  integration the main agent records `df -h /` from a Sandbox (Docker's disk) and
  `du -sh target` per lane, and keeps at least 20 GB free.
- Workers never create or close a Sandbox, never fork, never merge and never publish.
- **Done.** A worker finishes a milestone when its features have tests and the
  quality gates pass for its crates on the lane Branch's head. It reports to the main
  agent with its last Commit, test counts, the build-step Commits' storage numbers
  (below), and anything the next round needs from other lanes.
- **Integration.** When a round's lane workers have all reported, the main agent
  merges the three lane Branches into `integrate-mN`, one at a time with
  `branch.merge`, and resolves any Conflict: in a working fork when it's mechanical,
  by sending it back to the lane when it's semantic (a changed plan or trait contract
  is semantic). It then runs the quality gates, the slt corpus and the acceptance
  checks the round has reached, fixes integration bugs, publishes, and reruns the
  checks on a fresh fork of `main`. The next round's lane Branches fork from the new
  `main`.
- **Messages.** Workers talk only to the main agent. Requests to another lane go
  through it.
- **Cleanup.** At the end every Workspace is unmounted and the main agent closes the
  four Sandboxes.

## Acceptance (`quarry-accept`)

`cargo build --release -p quarry -p quarry-accept` (main agent, at integration), then
`target/release/quarry-accept run Qnn` for each check, each under 100 s.
`quarry-accept` starts `target/release/quarry serve` as a child process on an
ephemeral port with a fresh data folder, and prints `Qnn PASS` or `Qnn FAIL <why>`.
Comparisons with SQLite go through `scripts/oracle.py` on the same data.

| Check | Scenario |
| --- | --- |
| Q01 | The whole slt corpus passes against the server over the wire: every record, results and SQLSTATEs. |
| Q02 | Differential testing: 2,000 generated queries (`quarry-gen --seed 1`) over generated data return exactly SQLite's rows (sorted when there is no `ORDER BY`). |
| Q03 | TPC-H-style data at scale 0.05, loaded with `COPY`: queries Q1, Q3, Q5, Q6, Q10, Q12, Q14 and Q19 (dates as ISO text, intervals precomputed) return SQLite's rows, each in under 10 s. |
| Q04 | 8 clients run 30 s of transactions (transfers between accounts) while the server is killed with SIGKILL at a random moment. After restart the total balance is unchanged, every committed transaction is visible, none of the uncommitted ones is, and every index agrees with its table (`quarry check`). |
| Q05 | Isolation: no dirty read, no non-repeatable read and no lost update; two concurrent updates of one row make the later committer fail with `40001`; a write-skew case behaves as snapshot isolation allows, as documented. |
| Q06 | Spilling: with `SET work_mem = '8MB'`, an `ORDER BY` and a hash join over 200 MB of rows return correct results while the server's peak resident memory stays under 256 MiB (`VmHWM` in `/proc/<pid>/status`), and `EXPLAIN ANALYZE` reports bytes spilled. |
| Q07 | Indexes: a selective lookup on 1,000,000 rows uses an index scan (`EXPLAIN`) and runs at least 20× faster than with `SET enable_indexscan = off`. A unique index rejects a duplicate with `23505`. |
| Q08 | Join order: after `ANALYZE`, a 6-table join written in a bad order gets a plan whose estimated cost is lower than the written order's, and finishes in under 5 s. |
| Q09 | Wire protocol through `tokio-postgres`: prepared statements with parameters of every type, 16 concurrent sessions, a cancel request and `statement_timeout` (`57014`), and the SQLSTATEs listed above. |
| Q10 | Window functions and `WITH RECURSIVE` (a graph walk and a running total) return SQLite's rows. |
| Q11 | Vacuum: 5 rounds of updating every row of a 100,000-row table with `VACUUM` between rounds: the table's file stops growing after the second round. |
| Q12 | `EXPLAIN ANALYZE` row counts match the rows each operator really produced, and executing one prepared statement 1,000 times plans it once (the plan cache counter). |

## Storage evidence

The build report records how LayerFS stored the Rust builds. Take the numbers from
the SDK, not estimates:

- `branch.list_commits(<branch>)` gives each Commit's `logical` (the full tree size),
  `newCanonical` (new unique content), `newStored` (bytes that content added to the
  Store) and `newMetadata`.
- `new (await import(process.env.DSH_LAYERFS_OPERATOR)).LayerFSOperator(lf).store.stats()`
  gives the Store's `file`, `logical`, `canonical`, `stored` and `metadata` totals.

Record:

1. **Per round, each lane's first build Commit**: `target/` size (`du -sh target`),
   `newCanonical`, `newStored`. Every lane starts its round from the same `main` and
   compiles the same dependencies, so only the first lane to commit should pay for
   them.
2. **Per worker**, the build-step Commits of its round: how much each rebuild added.
3. **Per integration**, the release build's Commit.
4. **At the end**, the Store totals, the sum of `logical` over every Commit (the
   full-copy history), and the sum of `target/` + `.cargo-home/` sizes over every
   Branch head, against the Store file size.

## Report

At the end, the main agent writes `/docs/BUILD-REPORT.md` in the project and
publishes it. It covers:

- what was built, crate by crate, and the decisions that shaped it;
- each round: the lane Branches' heads, the merges and Conflicts and how each was
  resolved, the publications with their Layers;
- the final check: quality gates, test counts per crate, slt records passed,
  `Q01`–`Q12`;
- the storage evidence above, as tables;
- LayerFS surprises: refusals, slow steps, anything a future team should know.
