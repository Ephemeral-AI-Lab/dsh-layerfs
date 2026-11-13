# Quarry v2: the 10-minute checklist

The operator runs this every 10 minutes during the run. Commands and click paths are in
[RUNBOOK.md](RUNBOOK.md) §3 (host ops through the authenticated 3080 tab,
`window.__dshLayerfs`; files read directly, read only). `SID` is the root session, `SB`
its Sandbox, `KEY` the project key. Every check writes a snapshot (RUNBOOK §5.3) before
any fixing; fixes follow [FIX-POLICY.md](FIX-POLICY.md).

## Order of every check

1. **Watch list first** (below), oldest row first: earlier bugs come back more often
   than new ones appear, so they get the first and closest look.
2. **Harness** (H): the dsh-layerfs injection everything else depends on.
3. **Backend** (B), **Run** (R), **UI** (U).
4. **Slowness** (RUNBOOK §4): the monitor script against the thresholds.
5. Snapshot, new watch-list rows, the FIX-LOG line.

Budget: about 6 minutes, so a check never runs into the next one.

## Watch list

Kept at the top of `monitor/MONITOR-LOG.md`, one row per known bug. A bug found at any
check gets a row in that check, with a concrete probe, and is probed at **every** later
check. States: `open` → `fixed` (a fix shipped) → `retired` after **3 clean checks in a
row after the fix**. A hit sets it back to `open`, streak 0; a hit on a retired row
re-opens it with a new FIX-LOG entry naming the old one. Open rows also record how often
the bug happened since the last check.

| id | Bug | Probe | Pass |
| --- | --- | --- | --- |
| W1 | macOS Store refuses concurrent writers ([issue 01](issues/01-macos-store-concurrent-writers.md)) | call log since last check: refusals whose message has `Busy` (`Busy`, `Failed … busy before effect`, `Storage(Busy)`, `Unknown History(Busy)`), and `Failed … NotFound` on writes; per session and per call | open: record the rate; alarm when > 5% of writes or any `Unknown` that the agent did not verify before retrying |
| W2 | Checkpoints counted 0 files when only `file` writes moved the Branch (fixed 2026-11-13, `pathsChanged`) | `session.state` → newest turn checkpoints | `changed > 0` whenever the Branch moved; Trajectory shows "Saved", not "Saved unchanged" |
| W3 | `/api/machines` stalls behind an unresponsive Lima worker (`demo-build`, peer report) | time `GET /api/machines`; Resources → Machines load | under 2 s |
| W4 | Slow host calls already in 3080's log: `store.status` max 91.9 s, `project.get` max 56.3 s | call log max per call since last check | under 5 s |
| V1 | v1 polling storm (2,956 `NotMounted` status calls) | count per (session, call, target) | no triple over 60 per 10 min; `NotMounted` under 20 per 10 min |
| V2 | v1: an agent closed a shared Sandbox | call log `sandbox close` lines | none (agents can't, by policy; a hit is a policy bypass) |
| V3 | v1: dsh restarts ended every live turn | 3080 pid and start time; sessions with interrupted executions | unchanged pid; none interrupted |
| V4 | v1: `invalid record` failures on merges and commits | `Failed` on `branch merge` / `workspace commit`, output stderr | none |
| V5 | v1: a read returned a prefix without saying so | 3 largest `file read`s: output length against `file stat` size | equal, or `truncated: true` |
| V6 | v1: a merge truncated `Cargo.lock` | after each integration merge, `Cargo.lock` on the result | ends with a complete `[[package]]` block; `cargo metadata --locked` ok in the agents' output |
| V7 | v1: AppleDouble `._*` files | `file glob '**/._*'` on the newest integration Branch | none |
| V8 | v1: Workspaces left mounted by cut-off scripts | `GET /api/sandboxes/SB` against the main agent's ledger | no leftover count growing between checks |

## Harness (dsh-layerfs injection)

| id | Check | How | Pass |
| --- | --- | --- | --- |
| H1 | Preset and system prompt | root and new child logs: header `agentPreset`, the `system/message` | `layerfs` everywhere; persona line, AGENTS.md text, the skill catalog listing `dsh-layerfs` |
| H2 | Project block in the runtime context | the `Current runtime context` user message of root and of 2 new children | `## LayerFS project session` table shows the project, machine, session Branch, session Sandbox and dsh's Workspace, equal to `session.state` binding; children get the "You are a subagent" lines; after a restore the Branch row shows the new name |
| H3 | Tools offered | `request/header` → tools | `bash`, job tools, `subagent`, `skill`; no host file tools |
| H4 | Model route | `request/header` → config, root and every new child | DeepSeek-V4.1-Flash (`deepseek-flash`), effort **max**; children inherit it |
| H5 | Variables | a tool result that printed them, else `session.state` binding | `DSH_LAYERFS_CLI`, `_SDK` (file URL of `agent-bin/sdk.mjs`), `_PROJECT`, `_BRANCH` (`dsh.<id>[.rN]`), `_WS`, `_TRACE_CONTEXT`; children share the root's binding |
| H6 | Skill loads | `tool/call` of `skill` with `dsh-layerfs`, per session | every session loads it before its first LayerFS call; list sessions that never did |
| H7 | File policy | call log per session: `file` writes against Workspace-exec changes; exec argv | edits mostly by `file edit/write/apply`; bash used for batch or logic changes; no `exec` on `<SB>:main` (dsh's Workspace) |
| H8 | Workspace lifecycle | per bash tool call (`toolCallId` in the tag): mount, exec, commit, unmount | each mount has a commit and an unmount in the same tool call, or a stated reason (a background build); no exec argv containing a mount path (`/run/lfs-`, `/workspaces/`) |
| H9 | Installs and caches in the Workspace | exec argv; `file stat` on the integration Branch | no `npm i -g`, no installs or caches under `$HOME`/`/tmp`; `.cargo-home/`, `target/`, `node_modules/` (as used) committed; later mounts don't reinstall (no repeated `cargo fetch` downloads in outputs) |
| H10 | Checkpoints | `session.state` → checkpoints | one per finished root turn in which the Branch moved, `changed > 0`, no `error` |
| H11 | Persistence and archive | project-session log files; `session.state` → archive | logs and `layerfs.json` grow; no `archive.error`; saves keep up (lag ≤ 1) |
| H12 | Tracing | call-log tags; `session.annotations`; `logs.output` for 3 tags | ≥ 99% of agent calls tagged `dsh:<session>:<receipt>`, CLI and Node SDK (`client: "node"`) alike; outputs exist |
| H13 | Binding and idle close | `session.state` → binding, execution | `bound`, `active`; the root session stays loaded (idle close stops `SB` 30 min after unload) |

## Backend

| id | Check | How | Pass |
| --- | --- | --- | --- |
| B1 | Session Sandbox | `GET /api/sandboxes/SB` | running; Workspaces ≤ 14 (cap 16, alarm at 15); none `pendingMerge` for 2 checks; none idle-dirty for 30 min |
| B2 | Machine | `GET /api/machines` (docker) | running; no startup in progress; answers under 2 s (W3) |
| B3 | Store | `GET /api/storage`, `GET /api/stores/<store>/stats` | Idle / In use; record size and WAL size growth |
| B4 | Project head | `GET /api/projects/KEY/branches`, newest Commits on `main` | counts recorded; `main` moves only by publishes |
| B5 | Call log | `trace/calls*.jsonl` size, unparsable lines | grows; 0 unparsable; at most one rotation per check |
| B6 | Output records | `trace/outputs` count and size | grows with calls |
| B7 | Doctor (cheap) | `GET /api/doctor` | no new errors; never run the full integrity check during the run |
| B8 | Host disk | `python3 tools/cleanup.py check` (in `../layerfs`) | ≥ 100 GB free |
| B9 | Docker | `docker stats --no-stream`, `docker system df`, guest `df` | CPU/memory not pinned 2 checks running; guest ≥ 20 GiB free (< 10 GiB urgent) |
| B10 | 3080 process | pid, start time, RSS; `web.log` errors | same pid; RSS growth < 300 MB per check; no new unhandled errors |

## Run (agent progress)

| id | Check | How | Pass |
| --- | --- | --- | --- |
| R1 | Live agents | sidebar subagent rows; child logs with an open turn | count recorded; at the planned concurrency while a round runs, never above DSH's `maxActiveSubagents` |
| R2 | Stalls | minutes since each live session's last step | none over 10 min without a running exec |
| R3 | Commits | call log: `file` writes, Workspace Commits, merges, per worker | every active worker committed since the last check; cumulative count on track for the SPEC target |
| R4 | Integration | merges into the integration chain; `int` checks in the agents' output | rolling integration at least every 45 min; `Conflict` ≤ 3 per 10 min |
| R5 | Tests | the main agent's ledger; newest test exit codes | pass counts never go down; failures explained |
| R6 | Refusal loops | refusals per session and code | no session over 20 of one code per 10 min |
| R7 | Tokens | `usage` sums since the last check | recorded; cache-hit share ≥ 90% |

## UI

| id | Check | Click path | Pass |
| --- | --- | --- | --- |
| U1 | Conversation | root session, newest message | renders under 2 s; matches the log; no error toast |
| U2 | Subagent rows | expand the root's subagents; open 2 | count equals R1; each opens under 2 s |
| U3 | Files / History tabs | root session → Files, History | first content under 3 s; History shows the newest Commits from B4, including `file` writes |
| U4 | Sandbox tab | root session → Sandbox | agents, the session Sandbox and its Workspaces match B1; live dots on running agents |
| U5 | Trajectory tab | root session → Trajectory | loads under 5 s (alarm 15 s); newest turn present; versions created keep increasing; no freeze during its 3 s refresh |
| U6 | Machines | Resources → Machines → docker → the session Sandbox | Workspace count equals B1; no "can't be reached" |
| U7 | Store and project pages | Resources → the Store; project tabs | sizes equal B3; Sessions lists the root "Active"; leave Stats closed (1.5 s polling), never Recount |
| U8 | Logs page | Logs, filter the project, then Outcome = Refused | loads under 3 s; newest line under 30 s old; refusals match the script, W1 included |
| U9 | Health | Health | no new problem cards |
| U10 | LayerFS page | LayerFS | counts agree with B1–B3; runtime Ready, Node SDK row present |
| U11 | Model picker | composer model trigger (don't change it) | DeepSeek-V4.1-Flash · Max |

End each check on the root conversation's Chat tab; close pages that poll fast.
