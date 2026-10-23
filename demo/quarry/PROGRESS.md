# Quarry progress ledger

## Run facts
- LayerFS project: `dsh-rust-playground`; local scratch: `dsh-new-playground`; code never in local folder.
- Rust image: `sha256:c29e44d36de5a9d8a2e8cb24025ef6953ffc96a6e93fa310f814c0649b171c28` (rustc 1.85.1, SQLite 3.40.1, lld, 8 cores).
- Sandboxes: `sb-main` (main), `sb-sql`, `sb-exec`, `sb-store` (Rust image). All open.
- `main` published layers:
  - 32a5f644bc1b: imported files (HANDOFF/PROBE/SPEC + rust-image/Dockerfile).
  - 32313159a31c: skeleton (logical 1,517,052,307).
  - 3272a732aa75: skeleton + shared hooks (vacuum/checkpoint, PlanProvider, SubqueryRunner).
- Forked `verify-skeleton` from 32313159a31c: gates + 75 tests + slt expect-fail pass; fresh mount rebuilt binary in 0.19s (target reuse works).

## Skeleton (Branch `skeleton`, published)
- Cleanup: removed HANDOFF.md, PROBE.md, SPEC.md; moved image recipe to /tools/rust-image/Dockerfile.
- Root Cargo workspace (resolver 3, edition 2024, rust-version 1.85), dependency list per SPEC, profiles debug=full, `rust-toolchain.toml` 1.85.1.
- `.gitignore` = target/, .cargo-home/; `/.lww` = %include .gitignore.
- `quarry-types`: DataType/Value/Field/Schema/Row/Batch/Error+SqlState/AST/ScalarExpr/Aggregate/Window/LogicalPlan/PhysicalPlan/traits (Catalog, Storage, Index, TxnManager, Txn, Statistics, Database accessors, PlanProvider, SubqueryRunner)/MemDatabase/SessionState/QueryEngine/canonical text formatting.
- Stubs for all 9 lane crates + quarry binary (serve/sql/check) + quarry-slt + quarry-gen + quarry-accept. Four integration test files per crate.
- Infrastructure: `scripts/oracle.py`, `scripts/gen_corpus.py`, `docs/slt-format.md`, `docs/architecture.md`, corpus 10 files / **800 records** (646 queries, 61 errors, 93 statements; 2556 expected rows), all expected query rows from SQLite via oracle.py; regenerating is byte-identical.
- Skeleton baseline build: build Commit 34804238 (newCanonical 135,209,033? see round notes), final gates Commit 120d25644872 (newCanonical 67,318,645 / newStored 21,220,813), `target` 1.2G, `.cargo-home` 137M, Docker disk 79G free.
- Skeleton gates: fmt 0, clippy 0, cargo test 75 passed 0 failed, slt expects 800 failures (disk store stub missing).
- Storage baseline (skeleton branch commits): 120d25644872 logical 1,517,052,307 newCanonical 67,318,645 newStored 21,220,813; 12b84fb73506 logical 1,516,927,929 newCanonical 8,141 (corpus creation commits); 1286f1268798 newCanonical 52,907,301 newStored 17,053,511; 12de1bda2e61 newCanonical 73,207,850 newStored 22,603,918; 12fb5608aa5d newCanonical 42,063,219 newStored 13,674,509; 12ac05fdbd38 newCanonical 25,168,512 newStored 8,373,113.

## Round 1 (started)
- Lane branches forked from main 3272a732aa75, each got a sync Commit for quarry-types (traits/lib):
  - sql-m1 (Sandbox sb-sql): P1 parser, P2 binder/catalog, P3 planner.
  - exec-m1 (Sandbox sb-exec): X1 operators, X2 expressions + wire server.
  - store-m1 (Sandbox sb-store): S1 pages/buffer/heap/storage, S2 WAL/txn/recovery.
- Acceptance target after round 1: Q01 over the DDL/DML/basic SELECT corpus records (plus as much of the rest as the lanes reach); gates.
- Open problems: none yet. Next: collect worker reports, integrate lanes into integrate-m1, run gates + Q01 subset, publish.

## Decisions (why)
- Binder emits `LogicalPlan` directly (not a separate BoundStatement) so only one expression/plan IR is shared by all lanes.
- `Database` exposes `as_catalog/as_storage/as_txn_manager/as_statistics` because Rust 1.85 has no trait upcasting.
- Canonical text encoding (`Value::to_sql_text`, 9-significant-digit %g floats, true/false booleans) is shared by wire, slt, accept and oracle.py, so text comparisons are exact.
- `EXPLAIN` formatting lives in quarry-types' `PhysicalPlan::Display`/`explain_text`; executor fills `ExplainStats` in preorder so Q06/Q12 can read spilled bytes and actual rows.
- Plan cache lives in the `quarry` engine keyed by SQL + parameter types; counters exposed via `SELECT quarry_stat('plans_created')` for Q12.
- Lane branches got an identical shared-types sync Commit instead of re-forking (branch names cannot be deleted).

## Round 1 integration preview (updated)
- Live preview chain: preview-m1 (sql+exec) → preview2..preview5 → preview6/7/8 (merged skeleton infra + latest exec).
- preview8 corpus results (per file, debug):
  - 01-ddl 76/76 PASS; 03-select 115/115 PASS; 09-aggregate 69/69 PASS.
  - 02-dml 73/89: INSERT…SELECT projection bug (binder) inserts source columns instead of bound literals/refs; no-FROM not involved.
  - 06-setops-cte 35/63: no-FROM Values loses the row (columnar Batch has no row count), WITH RECURSIVE unsupported (needs a plan node).
  - 08-functions 65/96 and 10-types 47/90: no-FROM SELECT returns 0 rows (same Values bug).
  - 05-subqueries 11/65: uncorrelated scalar subqueries 0 rows (no-FROM), correlated returns 0A000 (round 2).
  - 07-window 6/68: X-M3 window operators not implemented (round 3).
  - 04-joins: timeout/hang — RIGHT JOIN (and likely FULL) loops forever in quarry-exec; INNER/LEFT correct. Reported to X1.
- Fixes requested: P2 (no-FROM dummy column + INSERT…SELECT projection), X1 (right/full join termination).
- Integration decisions: engine must use `Planner::with_catalog(db.as_catalog()).with_statistics(db.as_statistics()).with_options(...)` so IndexScan and SET switches work (round 3); cache key must include the switches.
- LayerFS surprise (from P3): a merge truncated Cargo.lock mid-checksum; repaired. Always run `cargo metadata --locked --offline` after integration merges.

## Round 1 published
- main Layer 32f482a4efc7 (logical 6,962,278,674), source integrate-m1-full 120125fe.
- Full check on integration: fmt 0, clippy 0, cargo test all crates green (types 20, parser, binder 101, planner 51, expr 68, server 30, exec 63, storage 60, txn 40, infra), release build OK (target 6.0G), release corpus round-1 scope **604/604 records** (01,02,03,04,08,09,10). Q01 full FAIL 139 (05 subqueries 54, 06 recursive 23, 07 windows 62).
- Fixes made at integration: InList referenced/remap helpers; planner pushdown right-child remap + prune_project; engine PlannerOptions wiring + cache key flags; explicit BEGIN/COMMIT/SAVEPOINT.
- Storage evidence round 1: sql lane first build 1239327d (newC 39,309,690/newS 11,414,735); exec lane 1218328f (68,338,689/20,124,818); store lane 12ea67c8 (16,328,515/5,389,319); release build 1227082e (419,914,053/116,131,275); Store totals file 2,383,314,944, canonical 7,873,753,910, stored 2,331,726,209, logical 674,168,134,355, dedupe 85.6x; df 76G free.
- Fresh fork verify-m1: fmt 0, clippy 0, release corpus 604/604; full cargo test timed out at 115s (per-crate runs were green on integration).

## Round 2 (started)
- Branches sql-m2, exec-m2, store-m2 forked from main 32f482a4efc7; each got a shared-types Commit adding JoinType::Semi/Anti.
- Workers: P1 parser hardening; P2 subquery binding; P3 join reorder + decorrelation + index/cost; X1 subquery execution + spilling + semi/anti (+windows if time); X2 COPY FROM STDIN + expr subqueries + cancel/timeout; S1 B+tree + overflow + sampling + MVCC heap; S2 MVCC/snapshots/undo/40001.
- S2 agreed MVCC interface (quarry_types::mvcc TupleVersion/Snapshot, Txn::{is_visible,is_own,snapshot_info}, UndoApply/redo_txn) and relayed to S1.
- Round 2 acceptance targets: Q02, Q03, Q05-Q08 (Q02/Q10 also need windows; X1 asked to do windows after spilling).

## Round 2 published
- main Layer 328e9fef8120 (logical 9,943,438,252); source prev12.
- Corpus: **777/800** (only 23 WITH RECURSIVE records fail; subqueries 65/65, windows 68/68).
- Acceptance on prev12 release: **Q02, Q03, Q04, Q05, Q06, Q07, Q08, Q09, Q12 PASS**; Q01/Q10 need recursive CTEs; Q11 needs VACUUM.
- Integration fixes this round: planner pushdown right-remap + prune_project; InList helpers; bounded buffer spill (S1); heap hole list (S1); bulk B+tree build (S1, 1M index 689ms); streaming COPY (server, bounded memory); COPY extended protocol (X2); SET accepts bare on/off; read-only implicit txns; write PlannerOptions 3-field; Q09 cancel token fix; Q02 generator explicit NULLS FIRST; TPC-H schema no declared PKs (O(n^2) INSERT); bulk loads commit per batch (WAL memory); acceptance phase timings.
- Storage evidence round 2 (newCanonical/newStored): sql lane first builds 12c7f072 (228,145,301/68,054,253), 126a4bc2 (45,364,982/13,321,719), 123edff (2,468,111/792,385); exec lane 1249b1cb (21,327,979/5,194,951) and 120d4a77 (90,490,244/26,439,383); store lane 121e91fb (489,371/138,476) and 122dec2 (19,245,577/5,732,409); release build 1259d4ed (132,504,592/34,676,631).
- Store totals at publish: file=5,968,666,624; canonical=19,805,782,352; stored=5,849,619,604; logical=3,221,644,212,169; metadata=192,981,599; dedupe 162.7x, compression 3.39x; Docker disk 72G free.

## Round 3 (started)
- Branches sql-m3, exec-m3, store-m3 forked from main 328e9fef8120; each got the RecursiveCte/CteScan plan-node contract.
- Workers: P1 parser recursive coverage; P2 binder RecursiveCte/CteScan; P3 plan nodes + merge join + cache key; X1 execute recursive CTE fixpoint; X2 metrics endpoint + protocol polish; S1 VACUUM/free-space/checkpoint; S2 full crash recovery/checkpoints/savepoints/kill -9.
- Targets: Q01 800/800, Q10, Q11, and keep the other nine checks green.

## Round 3 published — TERMINAL SUCCESS
- final4 head 125ccac16365 published as main Layer **321d8559625a** (logical 13,501,943,817); report-only follow-up on `report-final` published as Layer **32f3f3e56f2a** (logical 13,501,943,994).
- Corpus: **800/800** records.
- Final verification on fresh fork `verify-final`: fmt 0; clippy 0; all 13 crates' tests green = **891 passed, 0 failed, 2 ignored** (types 19, parser 144, binder 160, planner 89, expr 82, server 64, exec 129, storage 116, txn 68, slt 4, gen 7, accept 5, binary 4); release build 0; **Q01–Q12 all PASS** (run individually, each <100 s).
- Round-3 fixes at integration: engine CteScan/RecursiveCte read-only + plan-cache invalidation; Q10 explicit NULLS FIRST and RANGE frame on the non-null id key; no source conflicts in the lane merges.
- Final Store totals: file=8,775,606,272; canonical=29,192,038,398; stored=8,609,178,280; logical=4,832,419,276,792; metadata=270,551,298; dedupe 165.5x, compression 3.39x. Docker disk 69G free.
- Cleanup: no Workspaces mounted in sb-main/sb-sql/sb-exec/sb-store; all four Sandboxes closed. All workers finished. Build report published at /docs/BUILD-REPORT.md.
