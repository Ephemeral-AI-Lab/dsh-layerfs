# Quarry v2 — fix policy for the live run

Who this is for: the Claude Code operator who checks the run every 10 minutes and
"works iteratively and fixes UI and possibly `layerfs_v2_0_0` bugs/performance
issues" while 12–15 subagents work on the shared 3080 server.

Repository rules (`AGENTS.md`) and machine rules (`~/.claude/CLAUDE.md`) apply
in full. Nothing below loosens them. Items marked **OPEN DECISION** wait on the user.
Until the user decides, the default written next to each one applies.

## 0. Hard lines for the whole run

- **Never restart `dsh web` on 3080 while any turn is live** (the main agent or any
  worker), unless the user approves that specific restart. In v1, two restarts
  ended every running turn (16:38, 17:09) and left Workspaces mounted.
- Never close, replace or "clean up" the project's service Sandbox
  (`_service.<project>`) or any Sandbox, Workspace, Branch or Store the agents use.
  The operator's own test objects use the prefix `fx-` and stay off the run's project.
- Do not do the agents' work, and do not edit their Branches or files.
- Never change DSH code, `../layerfs`, `../layerfs-connect` or `~/.layerfs` by hand.
  Change 3080 state only through the app, the host API and `dsh plugin`.
- Merge into the 3080 checkout, never overwrite it. Other agents' uncommitted
  work may be there.
- Disk: run `python3 tools/cleanup.py check` (in a LayerFS checkout) at least every
  30 min and before any build. Run `docker system df` / free space in the Docker
  VM on each check: keep 20 GiB free there, and below 10 GiB clean up first.

## 1. Triage

### Severity

| Severity | Meaning | Response |
| --- | --- | --- |
| **S1 run-blocking** | Agents cannot make progress: calls fail for every lane, 3080 down, the service Sandbox gone, Docker or host disk below its floor, the model API down | Act now. Work around first, fix second. Tell the user in the next check-in |
| **S2 degrading** | Progress continues but with errors, retries or slowness: one call family fails sometimes, p90 regressions, a lane stuck, stale or blank UI panels | Fix in this or the next cycle, inside the live-run limits (§2) |
| **S3 cosmetic** | Wrong label, layout, copy, missing icon; nothing the agents depend on | Batch the fixes. Ship client-only fixes any time, otherwise after the run |

### Class: who fixes it, where, and when

| Class | How to recognise it | Who / where | When |
| --- | --- | --- | --- |
| **Agent mistake** | The call log shows a valid call used wrongly (wrong Branch, closed its own Sandbox, ignored an error, retried an unchanged call) | Nobody fixes the agent's work. Record it (§6); if the skill doc misled it, the fix is a **skill-doc gap** | Record now. Intervene only as §6 allows |
| **Skill-doc gap** | Several agents make the same mistake, or the skill says something wrong or nothing at all | Operator edits `skills/dsh-layerfs/SKILL.md` / `references/` in the 3080 checkout | Any time (§2): body edits are live on the next skill load |
| **dsh-layerfs client bug** | Wrong in the browser only; the host op/HTTP answer is right (`node tools/op.mjs`) | Operator, `src/client/**` | Any time once verified (§5). Client builds hot-reload |
| **dsh-layerfs host bug** | A host op, route, persistence row, call log, receipt or tracing is wrong; the CLI run by hand with the same argv is right | Operator, `src/host/**`, `skills.ts`, `cordis.patch.yml` | Verify on a side server now. Ship to 3080 only in a safe window (§2) |
| **LayerFS bug** (CLI/daemon/SDK/bundle) | The pinned CLI or SDK gives the wrong result, `Failed`/`invalid record`, a truncated read, or a hang when run outside dsh | Default: repro and issue draft only, plus a workaround (§3) | Repro now; workaround in dsh-layerfs or the skill if it is safe |
| **DSH bug** | A stock DSH package misbehaves (turn engine, stock UI, skill registry) with dsh-layerfs out of the path | Not fixed here. Draft an issue in `demo/quarry-v2/issues/` naming the missing seam or defect | Report to the user. Use a plugin-seam workaround only if one exists |
| **Infra** | Docker or host disk, Lima/Docker VM, model API errors or rate limits, network | Operator for disk (cleanup script, owner-released items only); user for model API keys/quota | S1 disk: now. Model API: tell the user and do not rotate keys |

If unsure between host and LayerFS, take the failing call's argv from the call
log and run it with the pinned CLI against a **private** LayerFS home
(`DSH_LAYERFS_HOME`). If it fails there too, it is a LayerFS bug.

## 2. Live-run safety: what can ship while the run is live

| Change | Takes effect | While turns are live? |
| --- | --- | --- |
| `src/client/**` | `node scripts/build.mjs` in the 3080 checkout; browsers hot-reload | **Yes**, after side verification (§5). Check that no in-flight UI action by another agent is broken by the reload |
| `skills/dsh-layerfs/SKILL.md` body, `references/*` | Next `skill` load. The provider re-reads the file on every `get` (`src/host/skills.ts`), and dsh-skill caches only the catalog, not the content | **Yes**. Agents that already loaded the skill keep the old text in context until they load it again; say so in the fix log |
| `SKILL.md` frontmatter `description`, adding/removing a skill | Read once at host start (`apply()`) and cached in dsh-skill's catalog | **No**: needs a restart, so wait for a safe window |
| `src/host/**`, `cordis.patch.yml`, `lib/session-persistence.js`, `lib/sandbox-policy.js`, `lib/skills.js` | 3080 host restart | **No**: verify on a side server, then wait for a safe window |
| Runtime pin (Machines → LayerFS runtime, `runtime.json`), new SDK in `.layerfs-sdk/` | Switches the CLI/daemon/SDK used by every lane | **No**: see §3. It is an OPEN DECISION |
| `demo/quarry-v2/**` notes, issue drafts, this log | Nothing live | Yes |

**Safe window** = the main agent is idle (its turn ended and is waiting on workers
or the user) **and** no worker turn is live **and** no Store save/merge/commit is in
flight (check the call log's last 60 s). Typical: between rounds. If there is none for
a long time and the fix is S1, ask the user. Never restart silently.

**Restart procedure (only in a safe window or with the user's yes):**

1. Note the state: open sessions, each lane's Branch and Sandbox, mounted
   Workspaces (`node tools/op.mjs`, the Work view). Save it in the fix log.
2. Tell the other operators/agents on 3080 (ListAgents / linked sessions).
3. Restart exactly as started: cwd `../deepseek-harness`,
   `DSH_HOME=../deepseek-harness/state`,
   `node node_modules/@deepseek-ai/dsh/lib/bin.js web --host 127.0.0.1 --port 3080 --no-open`.
4. Check: the page loads, project sessions are listed, the service Sandbox is
   answering, and `logs.list` shows new lines.
5. Resume: if a turn did end, send "continue" to the main agent only. It
   re-briefs its workers. Look for Workspaces mounted by cut-off scripts and report them
   to the main agent instead of unmounting them yourself.

## 3. LayerFS bugs

**Default (applies until the user decides otherwise):**

1. **Minimal repro** against a private home with the pinned CLI (the same commit 3080
   uses: `layerfs --version --json`). Write it as a shell script of CLI commands,
   or a short SDK script, in `demo/quarry-v2/issues/<nn>-<slug>/repro.sh`.
2. **Evidence:** the failing call-log lines (`$DSH_HOME/layerfs/trace/calls.jsonl`
   on 3080, or `logs.list`) with their receipt ids and `LAYERFS_LOGS_TAG`, the
   receipts, daemon log lines around the time, the store/branch/commit ids, and
   whether it reproduces outside dsh.
3. **Issue draft** `demo/quarry-v2/issues/<nn>-<slug>.md`: title, the built
   `layerfs_v2_0_0` commit, the symptom, repro steps, expected vs actual, frequency (n of N
   calls), workaround, and v1 links (e.g. "invalid record: binding kind",
   truncated `fs.read`, AppleDouble `._*`). Do not file it upstream. The user files it.
4. **Workaround** only if it is safe and reversible: a retry or validation in
   the dsh-layerfs host (for example, check a read's length against `fs.stat` and
   fail loudly) or a skill-doc note (for example, "on `invalid record` remount a fresh
   Workspace"; "merge from a committed Branch"). A workaround must never hide data
   loss or silently retry a non-idempotent write.

**OPEN DECISION FOR THE USER — may the operator patch `layerfs_v2_0_0`?**
AGENTS.md forbids editing `../layerfs` sources. Building the branch tip is allowed.
The default is **no patching**. If the user allows it, these are all required:

- A patch branch off the exact `origin/layerfs_v2_0_0` tip, in a LayerFS worktree
  registered with `tools/worktree.py`; never on `../layerfs` itself. Record the base
  and patched commits.
- Rebuild **all three from that one commit**: the host pair
  (`python3 tools/worktree.py build --resources <R> --platform macos`), the Linux
  bundle (`python3 tools/linux_bundle.py daemon|worker|helper|seal --resources <R>`),
  and the SDK (`node scripts/install-sdk.mjs <sealed build dir>`, which lands in
  `.layerfs-sdk/<commit>/`). A mixed CLI/daemon/bundle/SDK is not allowed.
- Verify on a side server with `DSH_LAYERFS_CLI/DAEMON/BUNDLE` pointed at the build:
  the repro passes, LayerFS's own tests for the touched area pass, and §5 passes.
- Repoint 3080 only through the app (Machines → LayerFS runtime), never by editing
  `~/.layerfs` or `state/` files. This changes the daemon for live Sandboxes, so it
  needs a safe window **and** the user's yes. It is followed by a 3080 restart
  (§2) and a check that existing Stores/Sandboxes still open.
- Disk: each build plus bundle is large. Run the disk check first, and release the
  worktree's caches at the end with the cleanup script.
- Sub-decision: whether the patch is offered upstream (a PR to `layerfs_v2_0_0`) is
  the user's call too.

## 4. Performance issues

**Measure before fixing.** No fix without a baseline from the same run.

- **Call log:** per call family, count, p50, p90 and max over a fixed window (the last
  30 min) from `calls.jsonl` / `logs.list`. Split `sandbox.commit` by new bytes as v1 did.
- **Receipts:** for the slow calls, which step took the time (CLI spawn, daemon,
  mount, exec), and whether the time is in dsh-layerfs (host op latency minus CLI
  duration) or in LayerFS.
- **Host side:** CLI spawn counts and background polls (`tools/perf-lib.mjs`,
  `tools/perf-fixture.mjs` on a side server). UI: the page's request timings.
- **Machine:** `docker stats --no-stream`, Docker VM disk, host CPU/memory. A slow call
  while the VM is at 100% CPU from Cargo builds is load, not a regression.

**Regression vs v1** (v1 table in the v1 README, "Call" table). Flag when, over at
least 50 calls of a family under similar load:

- p50 or p90 is **≥ 2× v1** (e.g. `fs.read` p90 > 30 ms, `sandbox.status` p90 > 12 ms,
  `sandbox.mount` p90 > 92 ms, `branch.merge` p90 > 1 s, `sandbox.commit` per
  size bucket ≥ 2× its v1 bucket), or
- a single call of a normally fast family (p90 < 100 ms) takes **> 10 s** (v1 had
  unexplained 29–31 s `fs.read`/`fs.apply` outliers; these get a repro attempt), or
- a host or UI path spawns CLIs per poll tick where it did not before.

`sandbox.exec` time is the agents' own commands and is never a LayerFS regression
by itself.

**Evidence a perf fix must show:** the same measurement before and after, on a side
server with the same fixture (`tools/perf-fixture.mjs`) or on the same call family on
3080 afterwards; n, p50 and p90 for both; no new errors; and, for a LayerFS-side fix,
the same commit-consistency rules as §3.

## 5. Verification gates (every fix, in order)

1. **Own worktree** of dsh-layerfs (its own `node_modules`, `cp -cR`), not the 3080
   checkout.
2. **Unit:** `node scripts/build.mjs && npx tsc -p tsconfig.json && node --test test/*.test.mjs`.
3. **Side server:** `DSH_LAYERFS_DEV_DIR=<abs .dev-fx> node scripts/dev.mjs --port 309x`
   (private DSH_HOME and LayerFS home, never 3080's or `~/.layerfs`). For host or
   session changes, also run fake-llm e2e:
   `DSH_LAYERFS_DEV_OVERLAY=<worktree copy of dev/fake-llm.overlay.yml> ...` then
   `node test/e2e-sessions.mjs`. For a UI fix, take a screenshot with `tools/shot.mjs`.
   For a bug fix, show the repro failing before and passing after.
4. **Merge into the 3080 checkout** (`grep dsh-layerfs ../deepseek-harness/state/profiles/web/package.json`):
   merge, keep both sides, no reset/stash/checkout over others' work. Wait if
   someone else is merging.
5. **Ship:** client or skill body: `node scripts/build.mjs` there, now. Host: wait for
   a safe window, then restart (§2).
6. **Check on 3080** with the authenticated URL (not written to files or chat): the
   fix works together with the live run, and the call log shows no new error class
   in the next 10-minute check.
7. Stop your side server (match its `.dev*/overlay.yml`) and remove `fx-` objects.

Skill-doc-only edits skip 2–3 but still need a reread for accuracy against the
code and the pinned CLI's actual behaviour.

## 6. Recording

Fix log: `demo/quarry-v2/FIX-LOG.md`, one entry per finding, newest last:

```
### F<nn> <HH:MM> <short symptom>
- Severity / class: S2 / dsh-layerfs host bug
- Symptom: what was seen, by whom (lane, session id), how often
- Evidence: call-log lines (receipt ids), op output, screenshot path, perf numbers
- Cause: one or two sentences (or "unknown")
- Fix: files changed / skill section / workaround / issue draft path
- Verification: gates passed (§5), side-server port, before/after numbers
- Shipped: build at HH:MM | restart at HH:MM (window, who was told) | pending window
- Commit: <sha> | uncommitted (default) | n/a
```

Every 10-minute check appends one line even when nothing changed:
`<HH:MM> check: lanes n live, errors since last k (classes), disk host X GB / docker Y GiB`.

**Agent mistakes:** record them as findings of class "agent mistake". The remedy is a
skill-doc improvement when the doc caused or allowed it. Do not take over the agent's
task, change its files, or close its Sandboxes.

**The operator may message the main agent (never workers directly) only to:**

- warn about a run-wide hazard (disk floor, model API outage, a known LayerFS bug with
  its workaround, "do not close the service Sandbox");
- announce a planned restart and ask it to reach a stopping point;
- say "continue" after a restart ended its turn;
- tell it that the skill doc changed and which section to reload.

Messages are short, factual, and never assign work or change its plan. Anything
more needs the user.

## 7. Commits

**OPEN DECISION FOR THE USER.** Default: **the operator does not commit.** Fixes are
merged into the 3080 checkout as working-tree changes, and the fix log records them as
"uncommitted". The user commits when they ask, or they may allow one commit per
verified fix (on a branch in the operator's worktree, merged into the 3080 checkout,
ending with the attribution line). Either way, nothing is pushed or filed upstream
without the user.

## Open decisions (summary)

1. May the operator patch `layerfs_v2_0_0` in a registered worktree, rebuild
   CLI/daemon/bundle/SDK from one commit, and repoint 3080's runtime (§3)? Default: no.
2. May a host-fix restart happen without asking when a safe window exists, or must
   every 3080 restart be approved (§2)? Default: safe window allowed for S1/S2, user
   told at the next check-in; restarts with live turns always need approval.
3. Commits: none by default, or one per verified fix (§7)?
4. Upstream: does the user file LayerFS/DSH issue drafts, or may the operator (§3)?
   Default: the user files them.
