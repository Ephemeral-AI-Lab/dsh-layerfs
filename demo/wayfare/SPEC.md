# Wayfare: a collaborative trip planner, built by a team of agents

Wayfare lets a group plan a trip together: who's coming, where they'll go and when,
what it costs and who owes whom, and what the group decided along the way. A main
agent and seven workers in three lanes build it in the LayerFS project, through the
LayerFS SDK.

This file says **what** to build and **how the team works**. Inside each module the
design is up to the team: choose names, files and algorithms freely, as long as the
behavior below holds and the tests prove it.

## Kickoff (for the main agent)

1. Read the LayerFS SDK guide (`cat "$DSH_LAYERFS_SKILL"`) and this file. This file
   is in the local folder; the code goes into the LayerFS project, never into the
   local folder.
2. The project is `node-projec-multiagent`, and the app lives at its root. `main` is
   read-only and starts empty: build on Branches and publish them.
3. Build the skeleton (below), publish it, then start the seven workers together,
   each with its lane brief from this file.
4. Integrate after each milestone round, run the acceptance checks, and publish.
5. Finish with the report described at the end.

## Team

| Agent | Count | Lane | Owns |
| --- | --- | --- | --- |
| Main agent | 1 | all | Skeleton, dependency list, lane briefs, merges and conflicts, integration, publishing, acceptance, report |
| `trips` workers T1, T2, T3 | 3 | trips | Trips, people, places, the itinerary, reservations, packing, documents, exports |
| `ledger` workers L1, L2 | 2 | ledger | Expenses, currencies, splits, balances, settle-up, budgets, spending reports |
| `pulse` workers P1, P2 | 2 | pulse | Activity, comments, notifications, live updates, polls and voting, search, digests |

Each worker is a subagent with the same tools as the main agent. The main agent never
writes lane features itself, except to fix integration bugs.

## Stack

- Node.js 24 from the Sandbox image, ES modules. `node:sqlite` works without a flag.
- An npm workspaces monorepo at the project root, with four packages:
  - `shared`: schemas, validation, error codes, event names, money math, the query language;
  - `server`: the HTTP API with SQLite storage;
  - `web`: the browser app;
  - `cli`: a `wayfare` command that talks to the API with a personal API token.
- Free choice of libraries and frameworks: Express or `node:http`, Preact or plain
  DOM, a bundler or none. Use pure JavaScript only: no native addons and no browser
  drivers (no Selenium, Playwright or Puppeteer). The main agent fixes the dependency
  list in the skeleton. A worker that needs another package asks the main agent, who
  adds it on `main`.
- Tests use `node:test` and `node:assert` in every package. HTTP tests start the app on
  an ephemeral port with a temporary data folder. Web code is tested without a
  browser: render components or view functions to HTML strings and test the state
  logic directly.
- Configuration comes from the environment: `PORT` (default 4200), `WAYFARE_DATA_DIR`
  (default `./data`: the SQLite file and uploaded files), `WAYFARE_SECRET`, and
  `WAYFARE_MAX_UPLOAD_BYTES` (default 20 MiB). No external services and no network
  calls at runtime.
- Money is stored as integers in minor units, never as floats.

There's no size target. Build the features well; don't pad.

## Skeleton (main agent, before the workers start)

- The root `package.json` with workspaces and scripts: `test` (every package),
  `build`, `start`, `seed`, `accept`.
- `.gitignore` (`node_modules/`, `dist/`, `data/`, `coverage/`, `*.log`) and a `/.lww`
  containing `%include .gitignore`.
- **Server:**
  - an app factory that mounts each module's router;
  - config, graceful shutdown, and an error envelope `{ error: { code, message, details } }`;
  - cursor pagination;
  - a numbered migration runner (each lane adds its own files);
  - a transaction helper;
  - an in-process domain event bus: `emit(name, payload)` after commit, and `on(name, fn)`.
- **Accounts:** sign up, log in and log out with scrypt-hashed passwords; cookie
  sessions; `GET /api/me`; personal API tokens (create with a name, list, revoke,
  stored hashed) for the CLI.
- **Permissions:** the hook `can(user, action, resource)`, with trip roles filled in
  by the trips lane.
- **Web:** a shell with routing, a layout, a navigation slot per lane, an API
  client, and a login page.
- **CLI:** `wayfare login` and the command registry; each lane adds its own commands.
- `scripts/seed.mjs` with a demo group of 4 users, and the `scripts/accept.mjs`
  harness (below) with no checks yet.
- `docs/architecture.md`: layers, events, permissions and how a module plugs in.

Each lane owns its own folder in every package, such as `server/src/modules/trips/`,
`web/src/lanes/trips/` and `cli/src/commands/trips/`. Lanes meet only through
`shared`, events and the public HTTP API.

## Lane `trips`: T1, T2, T3

| Milestone | Finished behavior |
| --- | --- |
| T-M1 | **T1:** trips (name, dates, home timezone, base currency, cover color, archive); members with roles organizer, editor and viewer; invitations through token links with expiry and revoke; `can()` rules for every trip route. **T2:** the itinerary: one day per trip date, with schedule items (start and end time in the trip's timezone, title, place, notes); overlapping items flagged. **T3:** places: a catalog per trip (name, category, address text, optional latitude and longitude, links, tags, notes) with filtering. |
| T-M2 | **T1:** a trip dashboard page (who, when, next items, counts from every lane through the API). **T2:** drag-and-drop ordering within and across days, with stable ranking; travel legs between consecutive items (mode, minutes) and warnings when a leg doesn't fit the gap; reservations (flight, stay, restaurant, activity) with confirmation codes, which create their schedule items automatically. **T3:** packing lists (shared and personal, templates, assignees, check-off progress); documents (upload with size limit and SHA-256, exact-byte download, linked to a reservation or item). |
| T-M3 | **T1:** duplicate a trip as a template, shifting every date. **T2:** an ICS calendar export per trip and per member; a printable itinerary page. **T3:** an SVG map of places by latitude and longitude, with each day's route (no map tiles); JSON export and import of a whole trip that round-trips. **All:** CLI commands `trip`, `day`, `place`, `pack`. |

## Lane `ledger`: L1, L2

| Milestone | Finished behavior |
| --- | --- |
| L-M1 | **L1:** expenses (amount, currency, payer, date, category, note, optional receipt document); a currency table per trip (manual rates to the base currency, with history); splits equal, exact, percent and shares, validated to sum exactly, with deterministic rounding (largest remainder, ties by member id). **L2:** balances per member in the base currency; an expense list and detail pages. |
| L-M2 | **L1:** recurring costs (per night, per day) that expand into expenses; editing and deleting with an audit trail of who changed what. **L2:** settle-up: suggest the fewest transfers that clear every balance (deterministic), and record settlements; budgets per category, with `budget.warning` at 80% and `budget.exceeded` at 100% emitted as events. |
| L-M3 | **L1:** a per-person statement; CSV export; the ledger locks when the trip is archived. **L2:** spending reports by category, day and person, drawn as SVG charts. **Both:** CLI commands `expense`, `balance`, `settle`. |

## Lane `pulse`: P1, P2

| Milestone | Finished behavior |
| --- | --- |
| P-M1 | **P1:** an activity feed per trip and per user, built from every lane's domain events. **P2:** comments on places, schedule items and expenses, in a safe markdown subset with `@mentions`; emoji reactions. |
| P-M2 | **P1:** a notification inbox (read and unread, bulk mark); automatic subscriptions for the creator, assignees and mentioned users; an email outbox table with per-user digest batching; live updates over server-sent events with `Last-Event-ID` resume. **P2:** polls with approval and ranked-choice voting, a closing time and a deterministic tie-break; a closed poll can turn its winner into a schedule item or place. |
| P-M3 | **P1:** a daily trip digest (yesterday's spend, today's plan, open polls) for the outbox and the web. **P2:** search across places, items, expenses and comments, with a query language (`in:places`, `tag:food`, `day:3`, `cost>50`, `by:@me`, quoted text, `AND`, `OR`, `NOT`, parentheses), errors that point at their position, highlighting, and saved searches. **Both:** CLI commands `feed`, `inbox`, `vote`, `search`. |

A lane that needs another lane's data uses that lane's HTTP API or events, not its
tables. When the data isn't there yet, ask the main agent; don't build it yourself.

## How the team works in LayerFS

- **One Branch and one Sandbox per lane.** The main agent builds the skeleton on
  Branch `skeleton` in its own Sandbox `sb-main`, and publishes it. For each milestone
  round, it then sets up each lane before starting that lane's workers:
  - it forks the round's lane Branches from `main`: `trips-m1`, `ledger-m1` and
    `pulse-m1`, then `-m2` and `-m3`;
  - it creates the lane Sandboxes once, for the whole run: `sb-trips`, `sb-ledger` and
    `sb-pulse`. If a name is refused `Exists`, it adds a suffix.

  A lane's workers all work on the lane's Branch, in the lane's Sandbox, at the same
  time.
- **Steps.** Each worker gets its own Workspace for each bash call, in the lane Sandbox
  on the lane Branch: mount, exec one or more commands, Commit, unmount.
  - Several workers commit to the same Branch at once. A Commit made after the Branch
    has moved merges with the newer head first. If two workers changed the same
    lines, that worker's Commit is refused `Conflict`, with markers left in its
    Workspace. It resolves them there and commits again.
  - Workers coordinate inside a lane through clear ownership. Each owns its own
    files, and shared lane files such as a router or index get small, additive
    edits.
  - Commit after every step that changes files, a failing one too, with a message
    naming the step and its result.
  - `fs.*` for reads and small edits; the Workspace for install, build and test.
  - Keep every command under 2 minutes (`timeout 110 npm test`). A command starts
    in the project root, which is the app's root.
  - Workers never create or close a Sandbox, never fork, and never merge.
- **Done.** A worker finishes a milestone when its features have tests and its lane's
  package tests pass on the lane Branch's head. It reports to the main agent with its
  last Commit, test counts, and anything the next round needs from other lanes.
  Workers never publish.
- **Integration.** When a round's lane workers have all reported, the main agent merges
  the three lane Branches into `integrate-mN`, one at a time with `branch.merge`, and
  resolves any Conflict:
  - in a working fork when it's mechanical;
  - by sending it back to the lane when it's semantic.

  The main agent then runs `npm ci`, `npm run build`, `npm test` and
  `npm run accept`, fixes integration bugs, and publishes. The next round's lane
  Branches fork from the new `main`.
- **Messages.** Workers talk only to the main agent. Requests to another lane go
  through it, and it answers them in the next round's briefs or in a skeleton fix
  on `main`.
- **Waiting.** The main agent waits for workers with the subagent tools, not with
  sleep loops.
- **Cleanup.** Every agent unmounts each Workspace in the same bash call that mounted
  it. At the end, the main agent closes the four Sandboxes.

## Acceptance (`npm run accept`)

`scripts/accept.mjs` starts the server on an ephemeral port with a fresh data folder.
It drives every check through the HTTP API and the CLI only, and prints
`A01 PASS` … `A12 PASS`, exiting non-zero on any failure. It runs in under 60 s.

| Check | Scenario |
| --- | --- |
| A01 | Four users sign up. One creates a 5-day trip and invites the other three, who accept. A viewer's edit is refused with a permission error. |
| A02 | Places, schedule items and a reservation are created. The reservation's item appears on its day, overlapping items are flagged, and a leg that doesn't fit is warned. |
| A03 | Items are dragged within and across days, and the order is stable after a server restart. |
| A04 | A document is uploaded and downloaded with exact bytes and SHA-256. An oversized upload is refused. |
| A05 | Expenses in three currencies use all four split types. Every split sums exactly, and rounding is deterministic. |
| A06 | Balances net to zero. The settle-up suggestion clears them in at most n−1 transfers, and recording it zeroes the balances. |
| A07 | A budget crosses 80% and 100%, and both events reach the activity feed and the inbox. |
| A08 | A comment with an `@mention` notifies the mentioned user. A server-sent event client that disconnects and resumes with `Last-Event-ID` misses nothing. |
| A09 | A ranked-choice poll closes with a deterministic winner, which becomes a schedule item. |
| A10 | Search queries with every operator return the right results. A malformed query gets an error that points at its position. |
| A11 | ICS and CSV exports parse. A trip's JSON export imports into a new trip with the same contents. |
| A12 | The CLI logs in with an API token, then lists trips, adds an expense, shows balances and searches. |

## Report

At the end, the main agent writes `/docs/BUILD-REPORT.md` in the project. It
covers:

- each round's Branches, merges (fast-forward or new merge), every Conflict and how it
  was resolved, and the publications;
- test counts per package, and acceptance results per check;
- any LayerFS refusal or surprise, with what the agent did about it.

Then it publishes.
