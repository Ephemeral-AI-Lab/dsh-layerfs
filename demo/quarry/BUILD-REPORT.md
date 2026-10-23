# Quarry build report

Quarry is a SQL database in Rust built by a main agent and seven workers in three
lanes on LayerFS, over three milestone rounds. This report records what was built,
how the rounds merged, the final verification, and how LayerFS stored the builds.

- LayerFS project: `dsh-rust-playground`
- **Final code layer: `321d8559625a` (13,501,943,817 logical bytes); this report was published immediately after it**
- Rust: 1.85.1 (edition 2024, `rust-version = "1.85"`), rustfmt + clippy
- Oracle: SQLite 3.40.1 through `scripts/oracle.py`

## What was built

| Crate | Lane | Delivered |
| --- | --- | --- |
| `quarry-types` | main | values/types, schema/row/columnar `Batch`, SQLSTATE errors, full AST, bound `ScalarExpr`, logical/physical plans (with `CteScan`/`RecursiveCte`), the `Catalog`/`Storage`/`Index`/`TxnManager`/`Txn`/`Statistics`/`Database` traits, MVCC `TupleVersion`/`Snapshot`, `MemDatabase`, session state, canonical text formatting |
| `quarry-parser` | sql (P1) | hand-written lexer + recursive-descent parser for all SQL in SPEC.md, 42601 with byte positions, no-panic depth/chain limits, 144 tests |
| `quarry-binder` | sql (P2) | name/type resolution, implicit casts, catalog DDL, views, constraints, aggregates/windows extraction, subqueries with `OuterColumn` levels, recursive CTEs, parameter inference; 160 tests |
| `quarry-planner` | sql (P3) | logical rewrites (folding, pushdown, projection pruning), statistics/cost model, index selection, join reordering DP≤6, semi/anti decorrelation, hash/merge/nested-loop choice, TopN, `CteScan`/`RecursiveCte` planning, EXPLAIN; 89 tests |
| `quarry-expr` | exec (X2) | vectorized evaluation with 3VL, checked arithmetic, casts, LIKE/ILIKE, string/math functions, parameters, subqueries through the runner; 82 tests |
| `quarry-exec` | exec (X1) | vectorized pull engine, every join kind incl. semi/anti/merge, hash aggregate, sort/TopN with external spilling, distinct/set ops, windows with ROWS/RANGE frames, DML with constraints/ON CONFLICT/RETURNING, DDL, ANALYZE/VACUUM, EXPLAIN ANALYZE counters, recursive CTE fixpoint; 129 tests |
| `quarry-server` | exec (X2) | PostgreSQL startup/simple/extended protocol, COPY FROM STDIN, cancel + statement_timeout, metrics endpoint, transaction status/error semantics; 64 tests |
| `quarry-storage` | store (S1) | 8 KiB slotted pages with CRC, clock buffer pool with spill file, heap + MVCC version chains, overflow pages, page-backed B+tree with bulk build, free-space map, VACUUM, checkpoints, catalog persistence, v1 migration; 116 tests |
| `quarry-txn` | store (S2) | WAL v3 (CRC frames, group commit, checkpoint compaction), snapshots and first-committer-wins 40001, undo and savepoint CLRs, redo+undo recovery, kill -9 torture; 68 tests |
| `quarry` | main | `serve`, `sql`, `check`; parser→binder→planner→executor engine, plan cache with DDL/ANALYZE invalidation, transaction control |
| `quarry-slt` | main | sqllogictest runner over the real wire protocol, per-file fresh databases |
| `quarry-gen` | main | deterministic differential query generator and TPC-H-style data generator |
| `quarry-accept` | main | Q01–Q12 acceptance harness (real release server, SQLite oracle) |

### Decisions that shaped it

- The binder emits **`LogicalPlan` directly** (no separate bound-statement IR), so one
  expression/plan language is shared by sql, exec and store through `quarry-types`.
- Rust 1.85 has no trait upcasting, so `Database` exposes
  `as_catalog/as_storage/as_txn_manager/as_statistics`.
- One canonical text encoding (`Value::to_sql_text`: `true`/`false`, 9-significant-digit
  `%g` floats, `NULL`) is used by the wire protocol, the slt runner, the acceptance
  harness and the SQLite oracle, making text comparisons exact.
- `EXPLAIN` formatting lives in `PhysicalPlan` (`explain_text`/JSON) and the executor
  fills `ExplainStats` in preorder, so Q06/Q12 read spilled bytes and actual rows.
- The engine caches plans by SQL + parameter types + planner switches; DDL/ANALYZE
  clears the cache.
- Bulk loads are not wrapped in one giant transaction: the WAL buffers a transaction's
  records, and a 1M-row transaction would hold hundreds of MB. COPY commits in batches;
  Q06's 200 MB load peaks at ~26 MB RSS, and the whole check peaks below 256 MB.
- The TPC-H generator does not declare PRIMARY KEYs: without a PK index, per-row
  uniqueness checks made INSERT quadratic (10k rows took 15.7 s). The keys stay unique
  by construction and Q03's queries do not depend on the constraint.
- `proptest` was in the declared dependency list but never entered the offline
  Cargo.lock; workers used exhaustive/deterministic model tests instead, so no gate
  depends on it.

## Rounds, merges and publications

Each round: fork `sql-mN`, `exec-mN`, `store-mN` from `main`; seven workers share the
three lane Branches and their Sandboxes; integrate by merging the three heads plus the
main agent's infrastructure branch.

| Round | Lane heads | Merges / conflicts | Published `main` |
| --- | --- | --- | --- |
| 0 skeleton | `skeleton` | imported files removed; Dockerfile moved to `/tools`; corpus merged from `corpus-work`; 17 content conflicts resolved by copying the corpus files | Layer `32313159a31c` (then `3272a732aa75` with shared hooks) |
| 1 | `sql-m1` `exec-m1` `store-m1` | clean merges (no source conflicts); integration fixes: InList helper bug, planner right-child pushdown remap, `prune_project`, engine planner options/transactions, read-only implicit transactions | Layer `32f482a4efc7`, then `32eeb59e655d` |
| 2 | `sql-m2` `exec-m2` `store-m2` | clean merges; conflict in `quarry/src/main.rs` (engine planner hook) and `quarry-accept/src/checks.rs` resolved by keeping the engine wiring and the infra checks; integration fixes: bounded buffer spill, bulk B+tree build, streaming COPY, SET identifiers, read-only txns, Q02 null ordering, COPY loader | Layer `328e9fef8120` |
| 3 | `sql-m3` `exec-m3` `store-m3` | clean merges; engine CTE read-only + plan-cache invalidation; acceptance fixes for Q10's explicit NULL ordering and RANGE key; final Layer in the last section |

### Acceptance progression

- Round 1: corpus **604/604** in DDL/DML/SELECT/joins/functions/aggregate/types;
  Q08 and Q12 passed; Q04 passed. Subqueries, windows and recursive CTEs were open.
- Round 2: corpus **777/800**; **Q02,Q03,Q04,Q05,Q06,Q07,Q08,Q09,Q12** passed;
  Q01/Q10 were blocked only by recursive CTEs; Q11 needed VACUUM.
- Round 3: corpus **800/800**; **Q01–Q12 all passed** (below).

## Final check on `main`

On a fresh fork of the published `main`, using the build settings in SPEC.md:

| Check | Result |
| --- | --- |
| `cargo fmt --all --check` | exit 0 |
| `cargo clippy --workspace --all-targets --locked --offline -- -D warnings` | exit 0 |
| `cargo test --workspace --locked --offline` | **891 passed, 0 failed, 2 ignored** (run per crate because one workspace build exceeds the 2-minute step budget; every crate exit 0) |
| slt corpus (`quarry-slt tests/slt`) | **800/800 records**, 10 files |
| `cargo build --release -p quarry -p quarry-accept` | exit 0 |
| `Q01`…`Q12` | all **PASS** (each under 100 s) |

Per-crate test counts: types 19, parser 144, binder 160, planner 89, expr 82,
server 64, exec 129, storage 116 (+2 ignored), txn 68, slt 4, gen 7, accept 5,
binary 4.

## Storage evidence

All numbers come from the SDK (`branch.list_commits`, `LayerFSOperator.store.stats()`),
not estimates. `newCanonical` is new unique content, `newStored` is the bytes it added
to the Store.

### Baseline: the skeleton

| Commit | target | `.cargo-home` | newCanonical | newStored |
| --- | --- | --- | --- | --- |
| skeleton final gates `120d25644872` | 1.2 G | 137 M | 67,318,645 | 21,220,813 |

The skeleton fetched 157 locked packages; `target/` and `.cargo-home/` are listed in
`/.lww` so every later merge keeps the newer generated tree.

### Per round: each lane's first build Commit

`target/` sizes are the worker's measurement at the end of its round.

| Round | Lane | Commit | newCanonical | newStored | target |
| --- | --- | --- | --- | --- | --- |
| 1 | sql | `1239327dda4c` | 39,309,690 | 11,414,735 | 1.4 G |
| 1 | exec | `1218328f15ce` | 68,338,689 | 20,124,818 | 1.9 G |
| 1 | store | `12ea67c8` | 16,328,515 | 5,389,319 | 1.3 G |
| 1 | release build | `1227082e4fa6` | 419,914,053 | 116,131,275 | 6.0 G |
| 2 | sql | `12c7f0722374` | 228,145,301 | 68,054,253 | 6.4 G |
| 2 | exec | `1249b1cbc7d5` | 21,327,979 | 5,194,951 | 6.5 G |
| 2 | store | `121e91fbcfed` | 489,371 | 138,476 | 6.2 G |
| 2 | release build | `1259d4ed483c` | 132,504,592 | 34,676,631 | 6.5 G |
| 3 | sql | `1235ac541b43` | 10,151,226 | 3,052,459 | 8.9 G |
| 3 | exec | `128714a0fb35` | 77,936,834 | 22,693,934 | 9.1 G |
| 3 | store | `1253312a42f6` | 89,882,688 | 25,144,458 | 8.7 G |
| 3 | release build | `12c42b7f3935` | 248,813,453 | 65,696,744 | 11.0 G |

Only the first lane to build after a round pays for dependency compilation; the other
lanes start from the same `main` with `target/` committed and add megabytes, not
gigabytes. (Round 1's release build is large because it is the first `--release`
profile build of every dependency.)

### Per worker: selected build steps

Full commit histories are on each Branch; these are representative build steps.

| Worker | Round | Build-step Commit | newCanonical | newStored |
| --- | --- | --- | --- | --- |
| P1 | 1 | `1239327dda4c` parser build | 39,309,690 | 11,414,735 |
| P1 | 2 | `126a4bc29c62` parser tests | 45,364,982 | 13,321,719 |
| P1 | 3 | `12540eb` parser+binder build | 184,283,324 | 55,889,318 |
| P2 | 1 | `12cabf31f6` binder build | 177,062,346 | 54,109,303 |
| P2 | 2 | `12c7f0722374` core binder | 228,145,301 | 68,054,253 |
| P2 | 3 | `125b5b9` full binder suite | 190,337,000 | 58,767,679 |
| P3 | 1 | `122f245e91ba` planner build | 85,482,102 | 25,921,439 |
| P3 | 2 | `12c878f41df0` planner build | 66,142,270 | 19,784,394 |
| P3 | 3 | `12e8989c6467` CTE/merge-join tests | 348,265,368 | 104,946,116 |
| X1 | 1 | `12845643` exec build | 6.5 M | 20.8 M |
| X1 | 2 | `12051ba6f369` spilling/semi-anti | 100,371,952 | 34,217,552 |
| X1 | 3 | `12ffa22f2ca7` recursive CTE tests | 216,003,125 | 64,533,886 |
| X2 | 1 | `1218328f15ce` expr tests | 68,338,689 | 20,124,818 |
| X2 | 2 | `120d4a774553` first compile | 90,490,244 | 26,439,383 |
| X2 | 3 | `12f464d0c518` server tests | 238,706,007 | 77,066,277 |
| S1 | 1 | `1200c5f74dfb` engine | 36,570,242 | 8,794,888 |
| S1 | 2 | `12a2da37feee` WAL-verified heap | 264,506,349 | 73,390,880 |
| S1 | 3 | `1253312a42f6` storage tests | 89,882,688 | 25,144,458 |
| S2 | 1 | `12ea67c8` WAL tests | 16,328,515 | 5,389,319 |
| S2 | 2 | `128e6f7f745c` txn gates | 120,401,066 | 35,220,226 |
| S2 | 3 | `126fdc51d63d` crash tests/docs | 156,168,696 | 48,569,734 |

### Integration and Store totals

| Point | `logical` (main/layer) | Store file | Store canonical | Store stored | Store logical (all layers) | Dedupe |
| --- | --- | --- | --- | --- | --- | --- |
| Round 1 `main` `32f482a4efc7` | 6,962,278,674 | 2,383,314,944 | 7,873,753,910 | 2,331,726,209 | 674,168,134,355 | 85.6× |
| Round 1 verify `32eeb59e655d` | 8,227,409,958 | 3,120,074,752 | 10,314,659,801 | 3,055,727,541 | 1,260,673,157,948 | 122.2× |
| Round 2 `main` `328e9fef8120` | 9,943,438,252 | 5,968,666,624 | 19,805,782,352 | 5,849,619,604 | 3,221,644,212,169 | 162.7× |
| Round 3 `final4` `125ccac16365` | 13,501,928,358 | 8,775,585,792 | 29,191,998,606 | 8,609,170,010 | 4,805,415,389,158 | 164.6× |
| **Final `main` `321d8559625a`** | **13,501,943,817** | **8,775,606,272** | **29,192,038,398** | **8,609,178,280** | **4,832,419,276,792** | **165.5×** |

At the end the Store held **8.78 GB on disk** for a **29.2 GB** canonical corpus and a
**4.805 TB** cumulative logical history (164.6× dedupe, 3.39× compression). Each lane's
`target/` is committed on its Branch; heads measured `final4` 11.0 G, `sql-m3` 8.9 G,
`exec-m3` 9.3 G, `store-m3` 8.7 G, plus ~0.55 G of `.cargo-home` per head — roughly
38 G of visible build state against 8.78 G of Store, because the same dependency
objects and generated artifacts are shared across Branch histories. Docker's disk had
**68 GB free** at the end (the image is 196 GB).

### Where the storage went

- First builds of a round that compile dependencies cost tens to hundreds of MB of
  canonical data because Cargo's `target/` is committed; subsequent lane builds add
  only project-crate artifacts.
- `target/` and `.cargo-home/` are the only `/.lww` entries (via `.gitignore`), so
  merge conflicts never involve generated state; source, manifests and `Cargo.lock`
  always merge as source.
- LayerFS deduplicates identical content across Branches, so the 38 G of visible
  `target/`/`.cargo-home/` at the four heads costs far less than 38 G of new Store
  bytes.

## LayerFS surprises a future team should know

- **Merging from the published `main` ref failed** with `Failed: invalid record:
  binding kind`; the same two branches merged cleanly when the base was a Branch
  Commit of identical content. The integration chains here start from a committed
  Branch (`integrate-m1-full`, `prev12`) instead of `main`.
- **`fs.read` can silently truncate near 48 KiB.** P2 read a 51,161-byte `query.rs`
  as a 49,135-byte prefix with `truncated:false`/`nextLine:null`; writing it back
  persisted the truncation, and a later merge truncated `expr.rs` to the parent
  inode's size. Restoring from `main` by byte size fixed it. Verify byte sizes for
  large files.
- **`Cargo.lock` can be truncated mid-checksum by a merge**, making every
  `--locked` command fail with a TOML parse error. Run `cargo metadata --locked` or a
  cheap `--locked` build after every integration merge and regenerate the lock if
  needed.
- **`sandbox.commit` occasionally returns `Failed: invalid record: captured inode
  creation binding`** after a large test run; the source commits were already durable,
  and remounting a fresh Workspace resolved it. Discard only generated state.
- **macOS AppleDouble `._*` files** appeared in trees written by `fs.*`; they were
  removed and `find . -name '._*'` is part of the final cleanup.
- **Disk hygiene matters:** killed acceptance runs leave `/tmp/.tmp*` data (one leaked
  55 GB spill directory), and a buffer-pool spill bug initially grew a spill file to
  80 GB. Clean `/tmp/.tmp*` after interrupted acceptance runs; the fixed store's spill
  file is bounded by pages touched and truncated after commit.
- **Workspaces are expensive but shareable:** target reuse works across mounts only
  when the Remap flags match (all workers used the same build settings). A fresh mount
  path with different flags recompiles dependencies.

## How to rerun

```sh
export CARGO_HOME="$PWD/.cargo-home" CARGO_TARGET_DIR="$PWD/target" \
       CARGO_NET_RETRY=0 CARGO_BUILD_JOBS=2 CARGO_INCREMENTAL=0 \
       RUSTFLAGS="--remap-path-prefix=$PWD=/w -C link-arg=-fuse-ld=lld -C link-arg=-B$(rustc --print sysroot)/lib/rustlib/aarch64-unknown-linux-gnu/bin/gcc-ld"
unset RUSTC_WRAPPER RUSTC_WORKSPACE_WRAPPER
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked --offline -- -D warnings
cargo test --workspace --locked --offline
cargo build --release -p quarry -p quarry-accept
./target/release/quarry-accept run Q01   # … Q12
./target/release/quarry-slt tests/slt
```

`scripts/gen_corpus.py` regenerates the corpus from SQLite; `scripts/oracle.py` and
`scripts/load_sqlite.py` are the comparison tools. The acceptance harness starts
`target/release/quarry serve` on an ephemeral port with a fresh data directory for
each check.
