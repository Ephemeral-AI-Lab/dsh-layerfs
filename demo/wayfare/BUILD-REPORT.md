# Wayfare — build report

Wayfare is a collaborative trip planner built from an empty LayerFS project by one main
agent and seven workers in three lanes. This report covers the foundation, each round's
branches, merges, conflicts and publications, the test and acceptance results, and the
LayerFS surprises along the way.

- Project: `node-projec-multiagent` (app at the project root, `main` read-only)
- Final `main` Layer before this report: `32760a0c8d23` (from `integrate-m3` head `12b7cf8ac5e1`, check commit `1203d8060195`)
- Final verification on a fresh `main` fork: `npm ci`, `npm run build`, `npm test` (334/334), `npm run accept` (A01–A12 all PASS)
- No external dependencies; Node.js 24 standard library only (`node:http`, `node:sqlite`, `node:test`).

## Decisions that shaped the build

1. **Zero dependencies.** Every package runs on the Node standard library. `node_modules`
   holds only workspace symlinks, so LayerFS merges stay small and `npm ci` is fast.
2. **Fixed lane wiring, no shared edits.** Server routes are auto-mounted from
   `packages/server/src/modules/<lane>/*.routes.js`; CLI commands are merged from
   `packages/cli/src/commands/<lane>/*.commands.js`; web views are composed from fixed
   `*.view.js` parts per lane. Workers add files in their own lane folder and never edit a
   shared registry, so lanes merged without source conflicts.
3. **One cross-lane seam, documented.** `packages/server/src/services.js` is a registry of
   lane-owned hooks (`trips:access`, `trips:members`, `trips:items`, `trips:places`,
   `trips:createItem`, `trips:createPlace`, `ledger:summary`, `ledger:spendOn`,
   `ledger:expensesFor`, `pulse:summary`, `pulse:openPolls`). A consumer gets `null` when
   the lane is absent and degrades gracefully. Lanes read each other's data only through
   hooks; durable `domain_events` are the push direction.
4. **Acceptance owned by the lanes, executed by the main agent.** `scripts/accept.mjs`
   loads `scripts/accept/aNN.mjs`; one check per module, a fresh server and data folder per
   check, a 25 s per-check timeout, and a 64 KiB upload limit so the oversize case is cheap.
   Workers wrote A01–A12 in their M3 round; the main agent ran them on the integration
   branches and on `main`.
5. **Merge rules.** `/.lww` is `%include .gitignore` plus `package-lock.json`. Only
   generated paths (`node_modules/`, `dist/`, `data/`, logs, the lockfile) are
   last-writer-wins; every source path merges and conflicts surface.

## Round 0 — foundation

Branch `skeleton`, forked from the empty `main`; Sandbox `sb-main`.

- 94 files: root `package.json` (workspaces + `build/test/start/seed/accept`), `.gitignore`,
  `/.lww`, `docs/architecture.md`, four packages (shared/server/web/cli), `scripts/seed.mjs`,
  `scripts/accept.mjs` and `scripts/accept/README.md`.
- Server: app factory, config from `PORT`/`WAYFARE_DATA_DIR`/`WAYFARE_SECRET`/
  `WAYFARE_MAX_UPLOAD_BYTES`, error envelope `{error:{code,message,details}}`, cursor
  pagination, numbered JS migrations with a runner, a transaction helper with
  after-commit hooks, an in-process domain-event bus that persists to `domain_events` and
  dispatches only after commit, scrypt passwords, cookie sessions, `GET /api/me`, personal
  API tokens (hashed), and the `can(user, action, resource)` allow-list hook.
- Shared: error codes, ids, money in minor units with largest-remainder `allocate`,
  event names, validation, cursor pagination, the search query language (tokenizer,
  parser with positions, matcher, highlighter).
- Web shell: hash router, layout, per-lane navigation slot, API client, login/signup page,
  all rendering to HTML strings. CLI: `wayfare login` plus an auto-discovered command
  registry. `scripts/seed.mjs` creates a demo group of four users.
- Published Layers: `327b87b2f991` (skeleton, 36 tests), `32463955937c` (cross-lane seams
  and the auto-discovery wiring, 38 tests), `3241fd4b490c` (architecture wording). Each
  was verified on a fresh fork of `main` with `npm ci && npm run build && npm test`.

## Round 1 — T-M1 / L-M1 / P-M1

Branches forked from `main` Layer `32463955937c`: `trips-m1`, `ledger-m1`, `pulse-m1`;
Sandboxes `sb-trips`, `sb-ledger`, `sb-pulse` (created once, kept for the whole run).
Seven workers started together; each lane's workers shared the lane Branch and Sandbox.

| Lane | Branch head at merge | Workers' last commits |
| --- | --- | --- |
| trips | `123da966906e` | T1 `121d5e21a26b`, T2 `1281e180273b`, T3 `122d8af29f2d` |
| ledger | `1255781fb534` | L1 `1265de54dd9c`, L2 `124fa552c025` |
| pulse | `12c760e4d6e1` | P1 `1297bf60cbbd`, P2 `12d57fd3bf65` |

Built: trips/members/invitations with organizer-editor-viewer rules and `can()` for every
trip route; itinerary days with overlap flags; places with filters; expenses, per-trip
currency history and four split types with exact, deterministic allocation; balances;
activity feed per trip and per user; safe-markdown comments with `@mentions` and emoji
reactions.

Merges (all new merge commits, no source conflicts): `int-m1-1` `1211b3411d7d` =
`main` + `trips-m1`; `int-m1-2` `12a0494730ac` = + `ledger-m1`; `integrate-m1`
`12cbbb28ec97` = + `pulse-m1`. The only merge decisions were `dist/` paths ruled
last-writer-wins by `/.lww`.

Integration fix: P1's `pulse-activity.test.js` asserted a lane-local `403` that the real
trip rules no longer produce (a viewer may read the feed). Fixed in the test on
`integrate-m1` (`121ab43a45c8`); real `403` coverage remains in the trips tests.
Published `integrate-m1` → `main` Layer `32b269355bb5`. Fresh-fork check: 137/137 tests,
`npm run accept` clean (no checks yet), and a 37-check live HTTP smoke of all round-1
flows.

## Round 2 — T-M2 / L-M2 / P-M2

Branches forked from Layer `32b269355bb5`: `trips-m2`, `ledger-m2`, `pulse-m2`; same
Sandboxes.

| Lane | Branch head at merge | Workers' last commits |
| --- | --- | --- |
| trips | `126a66e82f99` | T1 `12e585781f8c`, T2 `12c1ebb23320`, T3 `126a66e82f99` |
| ledger | `12f46af682dc` | L1 `12b56fa4db01`, L2 `12f46af682dc` |
| pulse | `123e77d2249d` | P1 `123e77d2249d`, P2 `12317ae71a5c` |

Built: trip dashboard fed by every lane's hooks; drag ordering with dense ranks, travel
legs and warnings, reservations that generate schedule items; packing lists with templates
and assignees, documents with SHA-256 and exact-byte download; recurring costs and an
expense audit trail; settle-up and settlements, category budgets with one-shot threshold
events; inbox, automatic subscriptions, batched email outbox and SSE with `Last-Event-ID`;
approval/ranked-choice polls that can turn their winner into an item or place.

Merges: `int-m2-1` `128702fe47b1` (fast-forward to `trips-m2`), `int-m2-2`
`126d974385bc` = + `ledger-m2`, `integrate-m2` `12f14942819c` = + `pulse-m2`. No source
conflicts; only `dist/` LWW decisions.
Published `integrate-m2` → `main` Layer `32e94f1b8be3`. Fresh-fork check: 238/238 tests,
and an 82-check live smoke extending round 1 with dashboard, ordering across restart,
legs/warnings, reservations, packing + assignee notification, documents (exact bytes,
SHA-256, 413), recurring costs, budget events reaching activity and inbox, settle-up and
zeroed balances, bulk inbox read, digest outbox, SSE live + resume, ranked poll → item, and
the archive lock.

## Round 3 — T-M3 / L-M3 / P-M3, CLI and acceptance

Branches forked from Layer `32e94f1b8be3` (with the final acceptance harness):
`trips-m3`, `ledger-m3`, `pulse-m3`.

| Lane | Branch head at merge | Workers' last commits |
| --- | --- | --- |
| trips | `123f10b797bf` | T1 `120c9899a9cf`, T2 `123f10b797bf`, T3 `125e3770adce` |
| ledger | `122222f41626` | L1 `128618e6f6d1`, L2 `12c6c0136ff1` |
| pulse | `129c116d2bf4` | P1 `12f7c50a0462`, P2 `12c97e040c10` |

Built: trip duplication as a date-shifted template; ICS export per trip and per member,
printable itinerary; SVG place map with per-day routes, JSON export/import round-trip;
per-person statements, CSV exports, the archive lock; SVG spending reports; the daily
digest for the outbox and the web; search over places/items/expenses/comments with the
query language, positional errors, highlighting and saved searches; and every CLI command
(`trip`, `day`, `place`, `pack`, `expense`, `balance`, `settle`, `feed`, `inbox`, `vote`,
`search`). A01–A12 were written in this round.

Merges: `int-m3-1` `1216e3457435`, `int-m3-2` `1297b1f762a7`, `integrate-m3`
`12b7cf8ac5e1`. No source conflicts; only `dist/` LWW decisions; no integration bug needed
a fix.
Published `integrate-m3` → `main` Layer `32760a0c8d23` (no overwritten layers).

## Final verification

On a fresh fork of `main` (`verify-final`), one Workspace, one command chain:

```
npm ci                        exit 0
npm run build                 exit 0  (140 source files syntax-checked, web copied to packages/web/dist)
npm test                      exit 0  334 tests, 334 pass, 0 fail
npm run accept                exit 0  12/12 checks passed
```

| Package | Test files | Tests |
| --- | --- | --- |
| `@wayfare/shared` | 4 | 11 |
| `@wayfare/server` | 28 | 186 |
| `@wayfare/web` | 15 | 103 |
| `@wayfare/cli` | 8 | 34 |
| **total** | **55** | **334** |

Acceptance, each on a fresh server and data folder:

| Check | Result | What it drives |
| --- | --- | --- |
| A01 | PASS | Four users sign up; one creates a 5-day trip and invites the other three, who accept; a viewer's edit is refused 403 `Forbidden`. |
| A02 | PASS | Places, items and a reservation; the reservation's item appears on its day, overlaps are flagged, and a leg that does not fit is warned. |
| A03 | PASS | Items dragged within and across days; dense order survives a server restart. |
| A04 | PASS | Document upload/download is byte-exact with the SHA-256 in the header; a 70 KiB upload against the 64 KiB limit is refused 413 `PayloadTooLarge`. |
| A05 | PASS | Expenses in EUR/USD/JPY with equal, exact, percent and shares splits; both currency columns sum exactly; repeated creates are deterministic; bad sums are 400. |
| A06 | PASS | Balances sum to zero; settle-up suggests at most n−1 transfers; recording them zeroes every net. |
| A07 | PASS | A budget crosses 80% and 100%; both events reach the activity feed and the creator's inbox exactly once. |
| A08 | PASS | An `@mention` notifies the mentioned user; an SSE client that disconnects and resumes with `Last-Event-ID` misses nothing. |
| A09 | PASS | A ranked-choice poll closes with a deterministic winner (two closes agree), which becomes a schedule item exactly once. |
| A10 | PASS | Search with every operator returns the right kinds; a malformed query returns 400 `InvalidQuery` with `details.position`; highlighting contains `<mark>`. |
| A11 | PASS | ICS parses (VCALENDAR + VEVENTs), CSV parses (header + one row per expense), and a trip's JSON export imports into a new trip with the same contents. |
| A12 | PASS | The CLI logs in with an API token, lists trips, adds an expense, shows balances and searches. |

Two additional live smokes (run from the Workspace, not committed) were used as
independent gates: 82 checks for rounds 1–2 and 43 checks for round 3 (duplicate, ICS,
print, map, JSON round-trip, statement/CSV, reports, digest + outbox, search operators and
position errors, saved searches, and every CLI command).

## LayerFS surprises and what was done

1. **Workspace capacity.** `sb-trips` reached the daemon's 16-Workspace limit after one
   worker's scripts committed but skipped `unmount`; new mounts were refused
   `Failed` / `ControlRefusal {code: Capacity, phase: "admission"}`. The refusal was
   accurate. I unmounted the 16 leftover Workspaces (`sandbox.unmount("sb-trips", path)`,
   no discard); every one returned `Unmounted`, nothing uncommitted was lost, and mounts
   worked again. All workers were told to unmount in a `finally` block; the guilty script
   was fixed and no other Sandbox ever leaked beyond a step.
2. **Publishing a stale lineage replaces `main`'s view.** After round 2 I published the
   `skeleton` Branch (forked from the empty project) to add an acceptance-harness patch;
   `main` then showed skeleton-only content (38 tests) and the publish reported the
   displaced Layer. The SDK behaved as documented — the mistake was publishing a Branch
   that did not contain the integration history. I forked `fix-main` from the round-2
   integration Branch, re-applied the harness change, verified 238/238, and published it:
   `main` Layer `32d9927029b9`, `overwrote` only the bad layer. From then on, fixes went on
   a branch forked from current `main`.
3. **A lane-local test met the real rules.** One integration test asserted a `403` that
   only held while the trips permission rule was absent. It was a test-expectation bug, not
   a code bug; the assertion was rewritten to the behaviour that holds with the real rules.
4. **`branch.merge` never produced a source Conflict.** All nine lane merges were new merge
   commits (one fast-forward) with only `dist/` paths decided by `/.lww`; the lane
   isolation design (one folder per lane, fixed wiring, hooks) is why. `sandbox.commit`
   likewise reported `merged` when a lane-mate's commit landed first, and `UpToDate` for
   runs that changed nothing, as documented.
5. **`main` is not a Branch.** `branch.list_commits("main")` is refused `NoSuchBranch` as
   documented; the current `main` reference and publication Layer come from
   `project.list_branches()`. No worker ever published or merged; every publication was
   made by the main agent from an integration Branch whose full check had passed.

No unexpected `Unknown` result, no refusal that contradicted the guide, and no repeat of a
LayerFS error after the approach changed. The build reached terminal success.
