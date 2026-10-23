# Wayfare progress ledger

Project: `node-projec-multiagent` (LayerFS). Local folder only holds scratch (wf/).

## Round 0 — skeleton (done)
- Branch `skeleton` built from empty `main`; Sandboxes `sb-main`, `sb-trials...` no.
- `main` Layers:
  - L1 `327b87b2f991…` (first skeleton: 36 tests pass, build, accept empty) via `skeleton` head `121fa41b8bb9`.
  - L2 `32463955937c…` (cross-lane seams: service hooks, per-area auto-discovery of server routes / CLI commands, fixed web view parts; 38 tests pass) via `skeleton` head `1273c44a2ad8`.
  - L3 `3241fd4b490c…` (architecture doc wording: service registration at module load) via `skeleton` head `125f49bc62bb`.
- Verified on `main` forks `verify-m0`, `verify-m1`: `npm ci && npm run build && npm test` = 0; acceptance harness says "no checks yet".
- Decision: **zero external dependencies** (node:http, node:sqlite, node:test, plain DOM). Keeps `npm ci` fast and `node_modules` tiny (workspace symlinks only), which keeps LayerFS merges cheap.
- Decision: acceptance `scripts/accept.mjs` loads `scripts/accept/a*.mjs`; rounds 1–2 build features, round 3 adds A01–A12.
- Decision: lanes never edit shared registries. Server: every `*.routes.js` auto-mounted. CLI: every `*.commands.js` merged. Web: fixed `*.view.js` parts per lane. Cross-lane data: `services.js` hooks + `domain_events`.

## Round 1 — setup
- Sandboxes: `sb-main`, `sb-trips`, `sb-ledger`, `sb-pulse` (created, stay open).
- Branches forked from main L2 (32463955937c): `trips-m1` `125aee52e814`, `ledger-m1` `12bb3d038299`, `pulse-m1` `124647866542` (each seeded with the round-0 doc).
- Assignment: T1 trips/members/invitations/permissions; T2 itinerary; T3 places; L1 expenses/currencies/splits; L2 balances/expense pages; P1 activity feed; P2 comments/reactions.
- Next: launch 7 workers, watch branch heads, then integrate.

## Round 1 — integrated (done)
- Lane heads at finish: `trips-m1` 121d5e21a26b (80/80), `ledger-m1` 124fa552c025 (62/62), `pulse-m1` 12d57fd3bf65 (71/71). Workers: T1, T2, T3, L1, L2, P1, P2 all reported; all sandboxes still open, no workspaces left mounted.
- Fixes I made while lanes ran: skeleton `can()` test was stale once real trip rules existed (changed to a lane-independent case) on `main` + all three lane branches; published as main L5 32c17c72…; also added per-check timeout to the acceptance harness and forced socket close on `app.close()` (SSE-safe).
- Merges (no source conflicts): `int-m1-1` = main+trips-m1; `int-m1-2` = +ledger-m1; `integrate-m1` = +pulse-m1, head 12cbbb28ec97, then 121ab43a45c8/1232b016a3bb after fixes. Only `dist/` LWW decisions.
- Integration bug: `pulse-activity.test.js` asserted a lane-local 403 that the real trip rules no longer produce (viewer may read). Fixed in the test on `integrate-m1`; real 403 coverage stays in trips tests.
- Check on `integrate-m1`: npm ci 0, build 0, test 137/137, accept 0 (no checks yet). Live cross-lane smoke (`wf/smoke.mjs`, 37 checks): signup/trip/invitations/roles/places/items+overlaps/days/currency/expense splits/base splits/balances net zero/comments/mentions/activity/viewer 403/editor 201/non-member 404/archive lock — all pass.
- Published `integrate-m1` -> `main` Layer 32b269355bb5 (no overwritten layers). Verified on `verify-m3` fork of main: npm ci/build/test 137/137, accept 0, smoke 37/37.
- Round 2 branches forked from main: `trips-m2`, `ledger-m2`, `pulse-m2`.

## Round 2 — integrated (done)
- Lane heads at finish: `trips-m2` 126a66e82f99 (187/187), `ledger-m2` 12f46af682dc (152/152), `pulse-m2` 123e77d2249d (173/173). Workers T1, T2, T3, L1, L2, P1, P2 all reported.
- Merges (no source conflicts): `int-m2-1` = main+trips-m2 (fast-forward), `int-m2-2` = +ledger-m2, `integrate-m2` = +pulse-m2, head 12f14942819c; only dist/ LWW.
- Check on integrate-m2: ci 0, build 0, test 238/238, accept 0. Extended live smoke (82 checks: dashboard, drag within/across days + restart stability, reorder, legs/warnings, reservations + duplicate code, packing template/assign/progress/assignee notification, document exact bytes+sha256+413, recurring per-night, budgets 80/100 → activity + inbox, settle-up ≤ n−1 then zeroed balances, inbox bulk read, digest outbox, SSE live + Last-Event-ID replay, ranked poll close + item apply idempotent, archive) — all pass after fixing three smoke expectations of mine (leg set on the wrong item; budget category already over-spent before budget creation; poll winner shape `{id,label}`).
- Published `integrate-m2` -> `main` Layer 32e94f1b8be3 (no overwritten layers). Verified on `verify-m4`: 238/238, accept 0, smoke 82/82.
- Round 3 branches forked from main: `trips-m3`, `ledger-m3`, `pulse-m3`. Round 3 adds M3 features + CLI commands + acceptance checks A01–A12.

## Incident: main view overwritten by a skeleton-lineage publish (fixed)
- After round 2, publishing the `skeleton` branch (which was forked from the empty `main` and never merged round 1–2) to add the acceptance-harness `buf`/upload-limit patch replaced `main`'s view with skeleton-only content: main Layer `32195b34aed9` showed only 38 tests. `branch.publish` reported `overwrote: ["32195b34…"]` for the later fix, which is how I confirmed the cause.
- Fix: forked `fix-main` from `integrate-m2` (238 tests), wrote the same patched `scripts/accept.mjs`, verified `npm ci && build && test` (238/238) and accepted, then published it: `main` Layer `32d9927029b9`, `overwrote` only the bad skeleton layer. Verified on `verify-m6`: 238/238 + smoke 82/82.
- Rule going forward: never publish a skeleton-lineage branch after integration; fixes go on a branch forked from current `main`, then publish that branch.

## Round 3 — in progress
- Branches forked from round-2 main (32e94f1b8be3) and seeded with the new acceptance harness: `trips-m3` 12fb36d68253, `ledger-m3` 125ee9f49a60, `pulse-m3` 12d9289efc63.
- Jobs: T1 duplicate trip + `trip` CLI + A01/A12; T2 ICS/print + `day` CLI + A02/A03/A11; T3 SVG map + JSON export/import + `place`/`pack` CLI + A04; L1 statement/CSV/archive lock + `expense` CLI + A05; L2 SVG reports + `balance`/`settle` CLI + A06/A07; P1 digest + `feed`/`inbox` CLI + A08; P2 search/saved searches + `vote`/`search` CLI + A09/A10.
- Note: main was corrected to Layer 32d9927029b9 before round-3 integration; round-3 integration must fork from that.

## Incident: sb-trips hit its Workspace capacity (16 leftover mounts)
- A trips worker's scripts mounted → exec → committed but never unmounted; sb-trips reached the daemon's 16-Workspace limit and every new mount was refused `Failed`/`Capacity` ("daemon Workspace capacity"). T1 reported it; the list was /workspaces/5, 8, 9, 13 (m1), 23, 24, 27, 28, 29, 30 (m2), 31, 32, 33, 34, 35, 37 (m3).
- I unmounted all 16 with `sandbox.unmount("sb-trips", path)` (no discard); all returned `Unmounted`, so nothing uncommitted was lost. Mounts work again.
- Reminder sent to every running worker: `unmount` belongs in a `finally` block so it runs when exec/commit throws, and a worker must check nothing of theirs is mounted before reporting. Recorded here as a LayerFS surprise (the refusal itself was accurate and actionable).

## Round 3 — integrated and published (done)
- Lane heads at merge: `trips-m3` 123f10b797bf (268/268, A01–A04 pass), `ledger-m3` 122222f41626 (267/267, A05–A07 pass), `pulse-m3` 129c116d2bf4 (275/275, A08/A09 pass; A10 blocked only on L1's hook, absent on that fork).
- Merges (no source conflicts, only dist/ LWW): `int-m3-1` 1216e3457435, `int-m3-2` 1297b1f762a7, `integrate-m3` 12b7cf8ac5e1; check commit 1203d8060195.
- integrate-m3: npm ci 0, build 0, test 334/334, accept **12/12 PASS** (A01–A12). Live smokes 82/82 (rounds 1–2) and 43/43 (round 3: duplicate, ICS, print, map, JSON round-trip, statement/CSV, reports, digest+outbox, search ops/position/highlight/saved, every CLI command).
- Published `integrate-m3` -> main Layer **32760a0c8d23** (no overwritten layers).
- Report `docs/BUILD-REPORT.md` written on `build-report` (fork of main, head 12990dabf4a2 + check 12c8027cb0b5), published -> main Layer **3248e93aa03b** (no overwritten layers).
- TERMINAL CHECK on a fresh fork of that main (`verify-terminal`): ci 0, build 0, **334/334 tests**, **A01–A12 PASS**. All Workspaces unmounted, all four Sandboxes closed, service Sandbox closed.
