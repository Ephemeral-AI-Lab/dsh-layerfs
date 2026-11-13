# Quarry v2: runbook for setup, the 10-minute check, and slowness detection

Status: draft plan, written 2026-11-13 from the code in this checkout (`integrate-onemode`)
and read-only looks at the 3080 install. Items marked **[unverified]** were not checked on
the running UI and need confirming the first time someone goes through them.

Companion files: [FIX-POLICY.md](FIX-POLICY.md) covers what may be fixed during the run and
how; `FIX-LOG.md` records findings (format in FIX-POLICY §6);
[SKILL-IMPROVEMENTS.md](SKILL-IMPROVEMENTS.md) is for skill text. The v1 run is documented in
the scratchpad `quarry/README.md` (results, latency table, incidents).

Conventions:

- **3080** is the user's DSH (`../deepseek-harness`, `DSH_HOME=../deepseek-harness/state`,
  pid in `../deepseek-harness/web.pid`). Its web profile links this checkout
  (`state/profiles/web/package.json` → `link:/Users/yifanxu/Ephemeral-AI-Lab/dsh-layerfs-integrate`).
- **App home** is the LayerFS home 3080 uses (`~/.layerfs`). The pinned runtime is the newest
  one under `~/.layerfs/runtime/` (now `2.0.0-814768197b73`, see `scripts/runtime-pin.mjs`).
  Read it only; never edit anything under it.
- **Plugin root** is `../deepseek-harness/state/layerfs` (`$DSH_HOME/layerfs`). The checks
  below read files there and never write.
- **Names on 3080** use the prefix `qv2-`: Store `qv2-store`, project `qv2-quarry`, so the
  project key is `qv2-store/qv2-quarry` (URL-encoded `qv2-store%2Fqv2-quarry`).
- Times are in UTC unless a line says otherwise. 1 GB = 10^9 B, 1 GiB = 2^30 B.

---

## 0. Before the run (preflight)

| # | Check | Command / place | Pass |
| --- | --- | --- | --- |
| P1 | Host free disk | `cd ../layerfs && python3 tools/cleanup.py check` | exit 0 and ≥ 100 GB free. Below 100 GB, follow the cleanup rule in `~/.claude/CLAUDE.md` first |
| P2 | Docker free disk inside the app's worker | `docker exec <worker> df -h /layerfs/data` (§3.4 says how to find `<worker>`) | ≥ 30 GB free to start (v1 used up to 80 GB in one spill-bug episode); the hard floor is 20 GiB |
| P3 | 3080 is up and runs this checkout | `lsof -nP -iTCP:3080 -sTCP:LISTEN`; the profile `link:` above | one `node` listener; the link points here |
| P4 | Client and host build are current | `git -C . log -1 --oneline`; `ls -l lib/index.js lib/client.js` | built after the last merge. A host change needs a 3080 restart, which happens **before** the run, never during it |
| P5 | Pinned runtime | LayerFS page → "LayerFS runtime" card, or `node tools/op.mjs runtime.status` (§3.1) | "Ready"; the CLI has the families `project branch commit file sandbox workspace machine store backup` (no `logs` family, so `logs.list` answers `source: "plugin"`) |
| P6 | Call log stand-in exists | `ls -l ../deepseek-harness/state/layerfs/trace/` | `calls.jsonl` (rotates to `calls.1.jsonl` at 16 MiB) and `outputs/` |
| P7 | No preset build or reset running | Settings → Presets | nothing running. A running build or reset holds the home (`exclusive`) and refuses session Sandboxes |
| P8 | Monitor log started | `demo/quarry-v2/monitor/MONITOR-LOG.md` (§5.3) | header written, check #0 = this preflight |

---

## 1. Setup click path (real UI on 3080)

Labels come from the locale files cited, in English (`preference: en` in the web profile).

### 1.1 Open 3080

The authenticated URL is in the 3080 start log (`../deepseek-harness/web.log`). Read it
into a shell variable or open it in the Browser pane. Never paste it into chat, a tracked
file, or this runbook (AGENTS.md).

### 1.2 Sidebar layout (where things are)

From `src/client/index.tsx`, `overview/locale.ts`, `storage/locale.ts`, `logs/locale.ts`,
`settings/locale.ts`, `doctor/locale.ts`, `projects/list-locale.ts`:

- **LayerFS**: the LayerFS page (panel id `layerfs`). The chevron toggles "Show Resources
  and Settings" / "Hide Resources and Settings" and so shows or hides the entries below.
  - **Resources** (`layerfs-storage`): Stores, projects, machines, Sandboxes, backups. There
    is no separate Machines page: machines are in the Resources outline under **Machines**.
  - **Health** (`layerfs-health`): the doctor grid.
  - **Logs**: the call log.
  - **Settings** (`layerfs-settings`, title "LayerFS settings"): runtime and **Presets**.
- **LayerFS Projects**: the sidebar project list (toggle "Show LayerFS projects" / "Show DSH
  workspaces"), with "New session in {project}" per project.

### 1.3 Docker machine ready

1. **LayerFS** → **Resources**. In the outline, under **Machines**, open the Docker machine
   (kind "Docker", blurb "A worker container in Docker"; the machine is named `docker`, which
   the call log confirms with `machine status docker`).
2. Pass: state **Running** and the line "{name} is running.". If it is **Stopped** ("The
   LayerFS worker is stopped…"), click **Start worker** and wait until the startup panel
   says "Startup completed" (stages: "Checking runtime compatibility", "Preparing sandbox
   image", "Starting LayerFS worker").
3. Read the **Sandbox image** fact. **[unverified]** The app's worker container uses image
   `layerfs-352-runtime` (label: Node 24, Rust 1.85.1, SQLite development headers,
   Chromium). Whether new Sandboxes default to that image or to another one has to be read
   off this page. Write the image and its digest into the monitor log header
   (`docker image inspect <image> --format '{{.Id}}'`).
4. On the **LayerFS** page, the runtime card must say "LayerFS runtime" … **Ready**.

### 1.4 Store (SQLite) and project: path A, one dialog (recommended)

This path makes the Store, the project and the placement in one go and opens the session.
It is the New Session hero control (`src/client/hero/`) plus the project dialog
(`src/client/projects/setup/`).

1. Start a **new session** (DSH sidebar new-session button, or **LayerFS Projects** → "New
   session or project" menu).
2. In the New Session row, open the project chip (aria-label "LayerFS project: No
   project"). The menu lists projects, then **New project…** and **Import a folder…**.
3. Click **New project…**. The dialog "New project" ("A project is a folder of files kept in
   a LayerFS Store.") has three rail steps: **Project**, **Store**, **Machine**.
   - **Project** → **Name**: `qv2-quarry` (hint "Also the name of its folder in the
     Store.").
   - **Store** → **Kind**: **SQLite** ("A file on one machine."). **Store** segmented
     control: **New Store**. **Store name**: `qv2-store` (hint "Made for this project").
   - **Machine** (**Runs on**, "One machine: the Store file lives there.") → select the
     Docker machine. If it is stopped, the dialog says "{machine} is stopped. Create starts
     it."
4. Click **Create and open**. The progress list shows the steps in order: "Create Store
   qv2-store", ("Start docker" if it was stopped), "Create project qv2-quarry", "Move
   qv2-store to docker", "Open a session". On failure it says "Stopped at “{step}”:
   {message}"; record that in FIX-LOG and retry with **Retry**.
5. Pass: the chip now reads `qv2-quarry`. **Resources** lists `qv2-store` under the Docker
   machine (not under "LayerFS Home") with 1 project.

### 1.5 Store and project: path B, Resources (if the brief needs separate steps)

1. **Resources** → **New Store**. **Kind of Store**: **SQLite**, then **Empty Store** ("A
   new SQLite Store saved under the home, with no projects yet…"). **Name** `qv2-store` →
   **Create Store**. The Store is created in **LayerFS Home**.
2. Open `qv2-store` → **Add project** → "Add project to qv2-store": **Project name**
   `qv2-quarry`, **Source folder (optional)** empty (or an absolute path to import) →
   **Create project**. If it takes long, **Check creation**.
3. Put the Store on Docker: the Store's menu ("qv2-store actions") → **Push to…** →
   **Machine**: docker → **Push**. Alternatively, on the Docker machine page, **Add Store** →
   "Move one here" → `qv2-store` → **Move here**. The job shows "Pushing to docker" and
   then "Pushed to docker". Push is refused while the Store has Sandboxes, so do it before
   any session starts.
4. New session → project chip → pick `qv2-quarry` ("On docker").

### 1.6 Scratch folder

After the project is chosen, the hero shows "Choose scratch folder" / "Scratch: {folder}".
The selected local folder is scratch only ("Its files are not saved into the project.").
Put the brief files (SPEC.md and so on) there if the handoff tells the agents to read them
from scratch. **[unverified]** whether a managed scratch folder is preselected for a new
project.

### 1.7 Preset

Picking a project switches the New Session row's preset chip to **LayerFS** (`preset-layerfs`
in `cordis.patch.yml`, id `layerfs`, name "LayerFS"; `LayerfsSessions.selectPreset` applies
it while the session has not started a turn). Pass: the preset chip says **LayerFS** before
the first message. If it shows something else, choose **LayerFS** in the preset chip. The
preset gives bash, jobs, schedule, subagent / subagent_fork / workflow, ask_user, skills
(including the `dsh-layerfs` skill), compaction, and no host filesystem tools.

### 1.8 Model and reasoning effort

The 3080 default model, from `state/profiles/web/cordis.patch.yml` (`agent-default-model`):
**provider `deepseek-account`, model id `deepseek-flash`, `reasoningEffort: high`**. The
stock catalog (`@deepseek-ai/dsh-llm-deepseek`) names `deepseek-flash`
**"DeepSeek-V4.1-Flash"** (context 1,048,576). Its effort levels are Off, Low, High, **Max**.

1. In the composer, open the model trigger (aria-label "Select model, current
   DeepSeek-V4.1-Flash, reasoning effort High"). The menu ("Model and reasoning effort") has
   two rows: **Model** and **Effort**.
2. **Model** → under the "DeepSeek Account" group → **DeepSeek-V4.1-Flash** (it should
   already be selected). **[unverified]** The account catalog can replace the stock one, so
   the shown name may differ slightly. The id must be `deepseek-flash`.
3. **Effort** → **Max** ("Reserve for the hardest quality-first tasks.").
4. Pass: the trigger reads `DeepSeek-V4.1-Flash` · `Max`. After the first step, the session
   log's `request/header` record has `config.provider = deepseek-account`,
   `config.model = deepseek-flash` and effort `max` (check H3).
5. Subagents: `tool-subagent` runs with `modelSelection: true`. Without a recorded
   model-selection policy, a child can only use the parent route. **[unverified]** whether
   children inherit `max` effort. The handoff should tell the main agent to pass
   `reasoning_effort: max` (or to keep the parent route), and H3 checks each child's
   `request/header`.

### 1.9 Paste the handoff

Paste HANDOFF.md as the first message. Note the session id right away (Browser pane:
`window.__dshLayerfs.selectedSessionId()` with the debug flag, §3.1; or the newest
directory under the project's `project-sessions/projects/<projectId>/sessions/`). Write it
into the monitor log header with the session Sandbox name `dsh-<first 20 compact chars of
the id>` (`sandboxOf` in `src/host/sessions/service.ts`) and the Workspace
`<sandbox>:<WS_NAME>` from `session.state`.

**Workspace capacity, plan for it in the handoff:** a Sandbox holds at most **16 Workspaces**
("A Sandbox holds at most 16 Workspaces."). The session Workspace already takes one slot in
the session Sandbox. With 12–15 subagents each mounting a Workspace there, the session
Sandbox reaches the cap. Agents can't create Sandboxes (the sandbox policy lets a session
write only its own Sandbox's records), so the handoff caps concurrent mounts at 13 workers plus
the main agent's `int` and one spare (skill: `references/rules/team.md`).

---

## 2. The 10-minute check

### 2.1 Order of every check

Each check runs in this order. Write its snapshot (§5.3) before doing any fixing.

1. **Regression pass**: the whole watch list (§2.2), oldest entry first. Earlier bugs come
   back more often than new ones show up, so they are checked first.
2. **Harness** (H*): checks the injection that every later reading depends on.
3. **Backend** (B*), then **Run** (R*), then **UI** (U*).
4. **Slowness pass** (§4): the script output against the thresholds.
5. Snapshot, then any new watch-list entries, then the one-line FIX-LOG entry (FIX-POLICY §6).

Budget: about 6 minutes of active work, so a check never runs into the next one. When a
check overruns, the snapshot says so and the next one starts on time anyway.

### 2.2 The watch list and the checklist

Both live in [CHECKLIST.md](CHECKLIST.md): the watch list (W1–W4 found while preparing,
V1–V8 from v1) and the Harness, Backend, Run and UI items with their probes and pass
criteria.

---

## 3. How to read the backend

### 3.1 Host operations

Operations are dispatched by `LayerfsRemote.call {op,args}` (`src/host/remote.ts`).

**Option 1, preferred, no token on disk:** run them in the Browser pane on the already
authenticated 3080 tab. Once: `localStorage.setItem('dsh-layerfs:debug','1'); location.reload()`.
Then, with `javascript_tool`:

```js
const L = window.__dshLayerfs
const SID = L.selectedSessionId()           // with the root session open
const st = await L.op('session.state', { sessionId: SID })
const sb = await L.op('http', { method: 'GET', path: `/api/sandboxes/${encodeURIComponent(st.binding.sandbox)}` })
// http answers { status, body }
```

**Option 2:** `node tools/op.mjs <op> '<json>'`. It reads the URL from
`$DSH_LAYERFS_DEV_DIR/url.txt` (`tools/ui.mjs devUrl`), so pointing it at 3080 means putting
the token in a file. If that is used at all, the file goes in the session scratchpad with
mode 0600 and is deleted at the end, never in the repo. Each call starts a headless Chrome and
a full page, and that page's own polling adds host load. Batch reads in one page (option 1)
instead of calling op.mjs in a loop.

**Option 3, no host at all:** the call log stand-in and the session logs are plain files under
the plugin root. The monitor script reads them directly (read only).

Operations useful here (all read-only):

| Op | Args | Gives |
| --- | --- | --- |
| `runtime.status` | — | pinned CLI, daemon, bundle, home |
| `session.state` | `{sessionId}` | `binding` (project, branch, sandbox, ws, machine, state), `checkpoints`, `status` (overlay entries, pending_merge), `execution`, `archive` |
| `session.place` | `{sessionId}` | project placement (subagents resolve to the root) |
| `session.annotations` | `{sessionId}` | receipts sidecar (`invocations`) |
| `session.trajectory` | `{sessionId}` | the Trajectory tab's model (heavy on long sessions; at most once per check) |
| `sessions.list` | `{project:"qv2-store/qv2-quarry"}` | project sessions |
| `sessions.availability` | — | Store availability as sessions see it |
| `logs.list` | `{limit≤1000, since, project, op, tag, outcome, writes, cursor}` | call lines, newest first, labelled with `dsh` (session, turn, checkpoint) |
| `logs.project` | `{project, sandboxes?, limit≤2000}` | one project's calls |
| `logs.output` | `{tag}` | stdout/stderr kept for one call |
| `http` | `{method:"GET", path}` | the routes below |

Read routes (`src/host/routes/router.ts`): `/api/status`, `/api/storage`,
`/api/stores/<s>/stats`, `/api/stores/<s>/observations`, `/api/machines`,
`/api/machines/<m>/inspect`, `/api/machines/<m>/images`, `/api/platforms`, `/api/doctor`,
`/api/doctor-jobs`, `/api/projects`, `/api/projects/<KEY>` (state),
`…/branches`, `…/commits?branch=&limit=`, `…/branch-commits?branch=a&branch=b`,
`…/history`, `…/sandboxes`, `…/fs?branch=&path=`, `…/file?branch=&path=`, `…/file-query`,
`…/stats`, `…/storage` (without `refresh=1`), `/api/sandboxes/<name>` (= `sandbox.get` with
Workspaces), `/api/sandboxes/<name>/commands`, `/api/workspaces/<ws>/status`,
`/api/workspaces/<ws>/commands`, `/api/storage-jobs/<id>`, `/api/project-inits`.

**Never call during the run:** any non-GET route (`DELETE /api/sandboxes/…`,
`close-sandboxes`, `DELETE /api/workspaces/…`, `…/commit`, `…/commands` POST, store push,
pull, move or remove, `/api/demo-presets` writes), `logs.reset`, `sessions.close`,
`sessions.forget`, `sessions.retireLegacyWorkspaces`, `checkpoints.restore` or
`checkpoints.branch`, `simulation.launch` or `simulation.stop`, and `runtime.save`.

### 3.2 Files read directly (read only)

| What | Path |
| --- | --- |
| Call log (stand-in, LayerFS #659 lines) | `../deepseek-harness/state/layerfs/trace/calls.jsonl`, `calls.1.jsonl` |
| Call outputs | `../deepseek-harness/state/layerfs/trace/outputs/` |
| Project session logs | `../deepseek-harness/state/layerfs/project-sessions/projects/<projectId>/sessions/<cwd-slug>/<sessionId>/session.v4.jsonl` and `layerfs.json` (subagents are their own directories with `parentSession` and `origin: "subagent"` in the header) |
| Host state | `../deepseek-harness/state/layerfs/sessions.json` |
| 3080 log | `../deepseek-harness/web.log` (contains the auth URL: grep it, never print whole lines that hold `token=`) |

A call-log line: `{"v":1,"at":<ms>,"ms":<duration>,"client":"cli","argv":[family,call,…],
"outcome":"ok"|<code>,"kind"?,"commit"?,"layer"?,"tag":"dsh:<sessionId>:<receiptId>"}`.
`dsh:-:<id>` is the plugin's own page or host call; `dsh-sim:` is a simulation. The v2 op name
is `argv[0] + "." + argv[1]` (CLI words, `exec-cancel` style). Agent calls made through the
`agent-bin/layerfs` wrapper are logged. **Gap:** calls the agents make through the Node SDK
(`$DSH_LAYERFS_SDK`) are **not** in the stand-in, because the pinned CLI has no native `logs`
family. If the agents use the SDK, those calls are invisible to the script. H8 and R4
cross-check the Commits in History against the logged writes.

### 3.3 CLI against the app home

AGENTS.md: only the app and the CLI change `~/.layerfs`, and tests or dev servers never
point at it. Prefer the app's operations. When a direct read is needed, run only the pinned
CLI's read calls, never writes: `layerfs sandbox get <SB>`, `layerfs sandbox list`,
`layerfs workspace status <ws>`, `layerfs store stats qv2-store`, `layerfs store status
qv2-store`, `layerfs branch list qv2-store/qv2-quarry`, `layerfs commit list …`, `layerfs
machine status docker`, `layerfs doctor`. Never run `sandbox close`, `workspace unmount`,
`workspace commit`, `store *` writes, `machine stop` or `remove`. Binary:
`~/.layerfs/runtime/<pinned>/bin/layerfs`. Direct CLI calls are not tagged and land in no
plugin log; note them in the snapshot.

### 3.4 Finding the app's Docker worker

Worker containers are named `lfs-<hash>-docker` (label `layerfs.role=machine-worker`), and
dev homes have their own. The app's worker is the one whose `/layerfs/bundle` mount comes from
`~/.layerfs/runtime/<pinned>/bundle/…`:

```sh
for c in $(docker ps --filter label=layerfs.role=machine-worker --format '{{.Names}}'); do
  echo "$c $(docker inspect "$c" --format '{{range .Mounts}}{{if eq .Destination "/layerfs/bundle"}}{{.Source}}{{end}}{{end}}')"
done | grep '/.layerfs/runtime/'
```

On 2026-11-13 that was `lfs-0c9dc9c9-docker` (data volume `lfs-0c9dc9c9-docker-data`, 119 GB
free of 244 GB). Confirm it on the Docker machine page **[unverified which fact names the
container]** and write it in the log header.

---

## 4. Slowness detection

### 4.1 Per-call thresholds

The columns are: v1 (SDK in-process, quarry v1, from 3,021 down to 22 samples), a v2 baseline
from 3080's call log 2026-11-12 09:41 → 11-13 06:49 (89,332 lines: host page calls plus
simulation agents; each v2 call is one CLI process, so it carries a 10–130 ms spawn floor),
and the thresholds. **Warn** applies to the window p90 when n ≥ 10. **Alarm** applies to any
single call. Times in ms unless marked.

| v2 call | v1 name | v1 p50 / p90 / max | v2 base p50 / p90 (who) | Warn p90 > | Alarm one > |
| --- | --- | --- | --- | --- | --- |
| `workspace.status` | `sandbox.status` | 2.8 / 6.0 / 1.41 s | — | 250 | 2 s |
| `workspace.exec` | `sandbox.exec` | 0.42 s / 28.8 s / 655 s | 33 / 56 (host terminals) | (work time: see §4.2) | 15 min, or a `true`-like command > 2 s |
| `file.read` | `fs.read` | 7.5 / 15 / 29.0 s | 21 / 58 (host) | 300 | 5 s |
| `workspace.commit` | `sandbox.commit` | 99 / 3.78 s / 61.4 s | — | 10 s | 90 s; `UpToDate` > 1 s |
| `branch.commits` | `branch.list_commits` | 6.4 / 12 / 130 | 27 / 162 (host) | 500 | 3 s |
| `file.apply` | `fs.apply` | 21 / 39 / 31.3 s | — | 500 | 10 s |
| `file.list` | `fs.list` | 9.4 / 16 / 29 | 22 / 64 | 300 | 3 s |
| `file.grep` | `fs.grep` | 12 / 657 / 10.2 s | — | 2 s | 20 s |
| `file.write` | `fs.write` | 21 / 42 / 333 | 50 / 59 (agents), 116 / 136 (host) | 400 | 3 s |
| `workspace.unmount` | `sandbox.unmount` | 63 / 197 / 7.34 s | — | 1 s | 15 s |
| `workspace.mount` | `sandbox.mount` | 26 / 46 / 944 | 49 / 121 (agents) | 500 | 5 s |
| `file.diff` | `fs.diff_files` | 12 / 22 / 62 | — | 300 | 3 s |
| `file.stat` | `fs.stat` | 2.5 / 6.6 / 21 | 22 / 57 | 200 | 2 s |
| `file.mkdir` | `fs.mkdir` | 7.1 / 21 / 31 | — | 300 | 3 s |
| `file.edit` | `fs.edit` | 14 / 22 / 28 | — | 300 | 3 s |
| `branch.merge` | `branch.merge` | 268 / 503 / 879 | 48 / 59 (agents), 115 / 152 (host) | 1.5 s | 10 s |
| `branch.list` | `project.list_branches` | 7.9 / 13 / 25 | 21 / 30 (agents), 56 / 120 (host) | 400 | 3 s |
| `branch.diff` | `branch.diff_branches` | 133 / 499 / 852 | — | 2 s | 10 s |
| `branch.fork` | `branch.fork` | 3.6 / 10 / 20 | 19 / 25 (agents) | 300 | 3 s |
| `branch.publish` | `branch.publish` | — | 20 / 24 (agents), 54 / 62 (host) | 500 | 5 s |
| `project.get` | — | — | 9 / 17 (host), **21 / 1,329 (agents)** | 500 | 5 s |
| `store.status` | — | — | 18 / 84 (host), **max 91.9 s** | 300 | 5 s |
| `store.stats` | `operator.store.stats` | — | 31 / 57 | 1 s | 10 s |
| `sandbox.get` | — | — | 41 / 89 | 500 | 5 s |
| `sandbox.list` | — | — | 8 / 11 | 200 | 2 s |
| `sandbox.create` | `sandbox.create` | — | 985 / 7,295 (agents) | 15 s | 60 s |
| `machine.status` / `machine.get` | — | — | 114 / 147, 128 / 172 | 500 | 3 s |
| any other call | | | | 1 s | 10 s |

Two baseline outliers are already on the watch list before the run starts: host
`store.status` max 91.9 s and `project.get` max 56.3 s, and agent `project.get` p90 1.3 s.
Seed them as `B-store-status` and `B-project-get` rows (probe: their window max).

Commit time grows with the new bytes written (v1: UpToDate 24 ms median, under 1 MB 75 ms,
10–100 MB 927 ms, 100 MB–1 GB 3.84 s, over 1 GB 24.5 s). The stand-in line has no byte size,
so a `workspace.commit` alarm is judged with the call's output (`logs.output {tag}` shows the
sizes) before it is called slow.

### 4.2 Model and agent stalls

- **Step stall:** a live session (it has a `turn/start` without a matching `turn/end`) with
  no new log record for **10 min** → warn, **20 min** → alarm. The exception is a
  `workspace.exec` in flight for that session's tag, or a `tool/call` whose `job/settled`
  has not arrived (a running build): those are allowed up to 15 min (v1's longest command was
  10.9 min), then they count as a stall.
- **Stream stall:** DSH's DeepSeek adapter drops a stream idle for 300 s
  (`DEFAULT_STREAM_IDLE_TIMEOUT_MS`). Count `step/end` records with an error finish
  **[unverified record shape]**. More than 2 per 10 min across sessions points to an API or
  network problem, not the plugin.
- **Fan-out stall:** fewer than 12 live workers while the ledger says a round is running →
  warn (the main agent may be waiting on a merge or a stuck child).

### 4.3 Refusals and polling storms

- Refusal rate: refused / total over the window, without `workspace.status` `NotMounted`
  (counted separately, V1). Warn > 10%, alarm > 25%.
- Any `Failed` or `Unknown` outcome is an alarm, and so is `Busy` on unmount. Read the call's
  stderr with `logs.output {tag}` (V4 looks for "invalid record").
- `Conflict` > 3 per 10 min is a warning (lane-mates racing on one Branch).
- A mount refused for capacity while the Sandbox is at 16 Workspaces is an alarm.
- Storm: the same (session tag, op, `argv[2]` target) over 60 calls in the window, or one
  session over 300 LayerFS calls per 10 min, or host page calls (`dsh:-:`) over 2,000 per
  10 min (baseline ≈ 67 / min ≈ 670 / 10 min, mostly `store.status`, `branch.list`,
  `machine.status`).

### 4.4 Script outline: `demo/quarry-v2/monitor/check.mjs` (to be written)

Read-only. It reads the call log files and the session logs directly, so it needs no host or
token. State is kept in the session scratchpad (`qv2-monitor-state.json`: `lastAt`, the
known session ids, the previous Store size).

```js
#!/usr/bin/env node
// node demo/quarry-v2/monitor/check.mjs --root ../deepseek-harness/state/layerfs \
//   --project qv2-store/qv2-quarry --sid <root session id> --state <scratch>/qv2-monitor-state.json
import { readFileSync, existsSync, statSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]]] : a), []))
const state = existsSync(args.state) ? JSON.parse(readFileSync(args.state, 'utf8')) : { lastAt: Date.now() - 600_000 }
const now = Date.now()
const T = { /* §4.1 table: op -> { warnP90, alarmMs } */ }
const ROOT_TAG = 'dsh:'
// 1. lines since lastAt from trace/calls.1.jsonl + calls.jsonl (rotation-safe: read both, dedupe on at+tag+argv)
const lines = []; let skipped = 0
for (const f of ['calls.1.jsonl', 'calls.jsonl']) {
  const p = join(args.root, 'trace', f); if (!existsSync(p)) continue
  for (const l of readFileSync(p, 'utf8').split('\n')) { if (!l) continue; try { const x = JSON.parse(l); if (x.at >= state.lastAt) lines.push(x) } catch { skipped++ } }
}
const op = (x) => `${x.argv[0]}.${String(x.argv[1]).replaceAll('-', '_')}`
const sessionOf = (x) => x.tag?.startsWith(ROOT_TAG) ? x.tag.split(':')[1] : null      // '-' = host page call
// 2. scope to the run: agent lines whose session is SID or a child (children found from the session logs' headers, step 5)
//    plus host lines whose argv names the project or one of its Sandboxes
// 3. per op: n, p50, p90, max, refusals by code; compare with T -> breaches[]
// 4. storms: count by `${session}|${op}|${x.argv[2]}`; NotMounted count; host '-' count; per-session totals
// 5. sessions: walk project-sessions/projects/*/sessions/*/*/session.v4.jsonl; header line -> {id, parentSession, origin, agentPreset};
//    keep SID and every descendant; per session: last record time, open turn?, last step/end, skill loads, request/header config
// 6. stalls per §4.2 (an in-flight exec = a workspace.exec line has not landed yet: use the session's open tool/call without job/settled)
// 7. print the §5.3 markdown snapshot to stdout; exit 0 clean, 1 warn, 2 alarm
state.lastAt = now; writeFileSync(args.state, JSON.stringify(state))
```

Percentiles are taken over the window, not cumulatively. The script also prints the
cumulative per-op table since run start, so the final report can use it. A second mode,
`--since-start`, rebuilds that table at the end.

### 4.5 UI responsiveness and event lag

- UI budgets (first meaningful content after the click, timed in the Browser pane with
  `performance.now()` around a `find` for the expected text): conversation or subagent open
  2 s; Files, History, Sandbox, Logs, Resources, Store page 3 s; Trajectory 5 s (alarm 15 s);
  model menu 1 s. A read that hits the 20 s client deadline ("The read timed out. Try again.",
  `readWithDeadline`) is an alarm.
- **Event lag:** in the Browser pane, `L.onEvent('logs', () => marks.push(Date.now()))`, and at
  the next `logs` event compare `Date.now()` with the newest line's `at + ms`
  (`L.op('logs.list',{limit:1})`). p90 under 2 s is healthy; over 10 s is an alarm (the host
  watcher missed appends, or the event stream disconnected; look for `ready` re-sends).
  Repeat 5 times per check.
- **Page polling load:** the host's own `dsh:-:` calls per minute (§4.3). A jump with no new
  page open means a client poll loop is out of control (FIX-POLICY §4).

---

## 5. Scheduling and recording

### 5.1 The 10-minute clock (Claude Code session)

- Preferred: the `loop` skill, `/loop 10m <the check prompt: "Run RUNBOOK.md §2 check #n">`.
  Each tick runs one full check (§2.1).
- Fallback (self-paced): at the end of each check, start a background Bash
  `sleep <seconds until the next :x0 boundary>` with `run_in_background: true`. Its exit wakes
  the session, which then runs the next check and starts the next sleep. Foreground `sleep`
  is blocked. Do not poll the output file.
- The schedule is wall-clock: check n is due at T0 + 10·n min. A late check records its delay
  and does not move later ones. Two missed checks in a row is itself a finding (the operator
  session stalled).
- Between checks the operator may work on fixes per FIX-POLICY, but a fix never delays a
  check.

### 5.2 Never during a live run

- **Restart, stop or rebuild the 3080 host.** v1's two restarts ended every running turn.
  Client-only builds hot-reload and are allowed under FIX-POLICY §2. Host builds wait for a
  window the user approves.
- **Reset or Build presets** (Settings → Presets). They take the home exclusively and delete
  machines.
- **Close the session Sandbox or a live lane Sandbox**: Store page → project → Sandboxes →
  **Close** / **Force close**; `DELETE /api/sandboxes/…`; `close-sandboxes`; `layerfs sandbox
  close`. Also never **Stop** or **Force stop** the docker machine, `docker restart` its
  worker, or unmount another agent's Workspace.
- Close or unload the root conversation for over 30 min (H10, idle close).
- `logs.reset` (Logs → **Reset…**): it deletes the run's evidence.
- Push, pull, move, back up or restore `qv2-store`, run its integrity check, or press
  **Recount** on project storage.
- Change the model, effort or preset of the live session, or send the main agent anything
  beyond FIX-POLICY §6's allowed messages.
- Edit anything under `../deepseek-harness/state/` or `~/.layerfs` by hand, write the 3080
  token to a tracked file or chat, or re-link the web profile.
- Run cleanup that touches the worker volume, `qv2-store`, or warm targets.

### 5.3 Snapshot format

File: `demo/quarry-v2/monitor/MONITOR-LOG.md`. Header: run start (UTC), SID, SB, lane
Sandboxes as they appear, worker container, image and digest, 3080 pid and start time, pinned
runtime, model route. Then the watch list table (§2.2). Then one block per check, appended:

```md
## Check #<n> · <HH:MM>Z (due <HH:MM>Z, +<late> min) · verdict: CLEAN | WARN | ALARM

Watch list: <k> rows probed · hits: F03 (open, 4 since last), V1 (NotMounted 12) · fixed→clean: F01 2/3

| Group | Pass | Warn | Fail | Notes |
| --- | --- | --- | --- | --- |
| Harness | H1–H10 | H5 | — | worker x7 never loaded dsh-layerfs |
| Backend | … | … | … | SB 13/16 ws; lane-a 9/16; Store 6.2 GB (+410 MB); host 212 GB; docker 88 GiB |
| Run | … | … | … | live workers 14; commits +37; merges 3 (1 Conflict); tests 612→655 pass |
| UI | … | … | … | Trajectory 6.8 s (warn) |

Calls since last: 1,284 (agents 1,102 · host 182) · refused 41 (3.2%; NotMounted 9)

| op | n | p50 | p90 | max | thr p90/max | refusals |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| workspace.exec | 210 | 0.9 s | 41 s | 9.8 min | — / 15 min | 101×3 |
| workspace.commit | 96 | 140 ms | 4.1 s | 22 s | 10 s / 90 s | Conflict×1 |

Breaches: <list, each with tag/receipt> · Storms: none · Stalls: none · Event lag p90 1.1 s
New findings: F07 → FIX-LOG, watch list row added
```

The FIX-LOG also gets FIX-POLICY §6's one-line check entry.

---

## 6. Open items and gaps

1. **[unverified]** The exact shown model name in the account catalog
   ("DeepSeek-V4.1-Flash" in the stock catalog), and whether subagents inherit `max` effort.
2. **[unverified]** Which Sandbox image the docker machine gives new Sandboxes, and which
   machine-page fact names the worker container.
3. Node SDK calls (`$DSH_LAYERFS_SDK`) are in the stand-in call log: the generated module
   writes the same lines with `client: "node"` (checked by `test/e2e-skill.mjs`).
4. The stand-in line has no byte sizes, so commit slowness needs `logs.output` to judge it.
5. `idleMinutes: 30` closes the session Sandbox 30 min after the root Agent is disposed.
   When DSH disposes an Agent during a long run is not established.
6. `tools/op.mjs` takes its URL only from a file; a variant that reads an environment
   variable would avoid putting the token on disk (a small tooling change, outside this
   document).
7. The 16-Workspace cap against 12–15 workers: the handoff must spread Workspaces over lane
   Sandboxes (§1.9).
