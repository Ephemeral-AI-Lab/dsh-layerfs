# Every interaction and its LayerFS call

Each row is one thing you can do (or one thing a view reads to draw itself), the host
route or operation it calls, and the LayerFS CLI call(s) behind it. The page guides carry
the same calls in their tables; this is the whole list in one place.

- **Routes** are dsh-layerfs host routes (`GET /api/…`), served through the `http`
  operation. **ops** are named host operations (`session.place`, `sessions.choose`, …).
- **LayerFS calls** are `layerfs <family> <call>`. "(read)" marks reads a view makes to
  draw itself. ↻ means the Storage view is read again afterwards (`home get`, `project list`,
  `store auths`, `store list`). `—` means no LayerFS call: the answer comes from host memory,
  the host's own logs, or this browser.
- Several calls in a row run in that order. When the first is refused, the rest don't run.
- To see the calls a click actually ran, open [Logs](logs.md): every row there is one call,
  tagged with the session that made it.
- The full route table, generated from the host code, is [cli-routes.md](cli-routes.md).

## Home, nav bar and entry points

Pages: [Home](home.md) · [Entry points](entry-points.md)

| Interaction | Where | Host route or op | LayerFS call(s) |
|---|---|---|---|
| Home draws | `LayerFS › Home` | `GET /api/storage`, `GET /api/projects` | `home get`, `project list`, `store auths`, `store list` (read) |
| Doctor count, home checks | Home › Overview head | `GET /api/doctor/results`, `POST /api/doctor/runs` `{kind: home}` | host memory; `home doctor` |
| Overview head Refresh | Home › Overview head | the Storage view, projects and a doctor run | the reads above, then `home doctor` |
| Runtime, Settings | Home › Overview head | ops `setup.status`, `runtime.status` | `home get` (+ `home init` if missing); `--version --json` |
| Jump to, crumb switcher, Back, Forward | nav bar | — | — |
| **Add › New Store** | nav bar | `POST /api/stores` | `store create` |
| **Add › Connect a database** | nav bar | `POST /api/stores/postgresql` | `store save-auth`, `store connect`, `store get` |
| **Add › New machine** | nav bar | `POST /api/machines` | `home get`, `machine create` |
| **Add › Add bucket** | nav bar | `POST /api/buckets` | `backup connect` |
| Project rows (commit line, counts, size) | `Home › Projects` | `GET /api/stores/:id/projects`, `GET /api/projects/:key/size` | `branch get`, `project list`, `project stats`; `project get`, `store get` (read) |
| A row's sessions | `Home › Projects` | op `sessions.list` | — |
| Open a session line | `Home › Projects`; the sidebar's LayerFS view | op `sessions.open` | none if local; else `branch list`, `project export` |
| **⋯ › New session** / **+ New session** | `Home › Projects` | op `sessions.choose` | `project get` (+ `branch list`, `branch fork` on first use) |
| **⋯ › Delete project…** | `Home › Projects` | `DELETE /api/projects/:key` | `project delete` |
| PostgreSQL sizes and logins | `Home › Stores › PostgreSQL` | `GET /api/stores/:id/stats`, `GET /api/store-auths` | `store get`; `store auths` |
| Machines table | `Home › Machines` | `GET /api/machines`, `GET /api/metrics`, `GET /api/machines/:id/space` | `home get`, `machine get`, `machine list`, `sandbox list`, `store list`; sampler memory; `machine stats` |
| Row power **Start**, **Stop** → **Confirm: Stop** | `Home › Machines` | `POST /api/machines/:id/stop` / `start` | `machine stop` / `machine start` |
| Row **Add Store** | `Home › Machines` | `POST /api/machines/:id/stores` | `store move` (a job) |
| Row **New Sandbox** | `Home › Machines` | `POST /api/projects/:id/sandboxes` | (`machine start`), `project get`, `sandbox create`, `store get` |
| **⋯ › Diagnose this host** | `Home › Machines` | `POST /api/doctor/runs` `{kind: home}` | `home doctor` |
| LayerFS sidebar row | DSH sidebar | — | — |
| Workspaces switch | DSH sidebar | — (this browser) | — |
| LayerFS view rows | DSH sidebar, LayerFS view | ops `projects.recent`, `projects.catalog`, `GET /api/storage`, `GET /api/machines` | `project list`, `branch list`, `store get` (read) |
| Project sessions in the sidebar | DSH sidebar, LayerFS view | op `sessions.list` | local list every 15 s; archive every 60 s: `branch list`, `file read` |
| **+ New session in {project}** | DSH sidebar, LayerFS view | ops `sessions.prepareScratch`, `sessions.choose` | `project get` (+ `branch list`, `branch fork`) |
| **Start {machine}** | DSH sidebar, LayerFS view | `POST /api/machines/:id/start` | `machine start` |
| **Archive {session}** | DSH sidebar, LayerFS view | op `sessions.archive` | — (DSH's own archive) |
| Project control: choose a project | New Session row | op `sessions.choose` | `project get` (+ `branch list`, `branch fork`), then the Store syncs in the background |
| Project control chip | New Session row | op `session.place` | — |
| Scratch folder picker | New Session row, project session | ops `sessions.scratchOptions`, `sessions.scratch` | — |
| Project dialog: **Create and open** | project dialog | `POST /api/project-sources/check`, `POST /api/stores`, `POST /api/projects`, `POST /api/machines/:id/stores`, op `sessions.choose` | `store create`, `project init`, `store move`, `project get` |
| Project dialog: PostgreSQL **Connect** | project dialog | `POST /api/stores/postgresql` | `store save-auth`, `store connect`, `store get` |
| Project dialog reads | project dialog | `GET /api/storage`, `GET /api/platforms`, `GET /api/store-auths` | the Storage view; `home get`; `store auths` |
| Project settings: **Move to {machine}** | project dialog › settings | `POST /api/machines/:id/stores` | `store move` |
| Project settings: **Hide from sidebar** | project dialog › settings | — (this browser) | — |
| Set up LayerFS: **Check** / **Check again** | Set up LayerFS | op `setup.status`, `GET /api/machines?fresh=1` | `home get`; `machine get`, `machine list` (read) |
| Runtime: **Use** / **Other build…** | Set up LayerFS › **Change…** | op `runtime.save` | `--version --json`, `help --json`, `machine update native` |
| **Use this daemon** | Set up LayerFS | op `setup.recordDaemon` | `machine get native`, `machine update native --daemon` |

## Stores and buckets

Pages: [Store](store.md) · [Bucket](bucket.md)

| Interaction | Where | Host route or op | LayerFS call(s) |
|---|---|---|---|
| Open the Store page | `LayerFS › Home › Stores › <store>` | `GET /api/storage` | `home get`, `project list`, `store auths`, `store list` (read) |
| Overview file card and tiles | `… › <store> › Overview` | `GET /api/stores/:id/stats` | `store get --with stats` (read) |
| How the Store grew | `… › <store> › Overview` | `GET /api/stores/:id/observations` | — (host journal of earlier reads) |
| Projects tile, Projects tab, card rows | `… › <store> › Projects` | `GET /api/stores/:id/projects` | `project list`, `project stats`, `branch get` (read) |
| Running now tile, a project's Sandboxes | `… › <store>` | `GET /api/machines` | `home get`, `machine list`, `machine get`, `sandbox list`, `store list` (read) |
| Project sessions column | `… › <store> › Projects` | op `sessions.list` | — (this DSH) |
| **Check integrity** / **Test connection** | `… › <store>` head | `POST /api/doctor/runs` `{kind: store}` | `store doctor` |
| **⋯ › Push to…** → **Push** | `… › <store> ⋯` | `POST /api/stores/:id/push` | `store move <s> <m>` (a job), `backup list` |
| **⋯ › Pull to home** / card **Pull** | `… › <store> ⋯` | `POST /api/stores/:id/pull` | `store get`, `store move <s> native` |
| **⋯ › Move to another machine…** → **Move** | `… › <store> ⋯` | `POST /api/stores/:id/move` | `store get`, `store move` ×2 through native |
| **⋯ › Back up to…** → **Back up** / **Back up now** | `… › <store> ⋯`, Backups tab | `POST /api/stores/:id/backup` | `backup create`, then `backup list` |
| **⋯ › Compact…** → **Compact** | `… › <store> ⋯` | `POST /api/stores/:id/compact` | `store get`, `store compact` |
| **⋯ › Remove…** → **Remove** | `… › <store> ⋯`, Store details | `DELETE /api/stores/:id?confirm=` | `store remove` ↻ |
| **⋯ › Disconnect…** (PostgreSQL) | `… › <store> ⋯` | `POST /api/stores/:id/disconnect` | `store disconnect` ↻ |
| **⋯ › Disconnect <machine>** / Connection › **Forget** | `… › <store>` | `POST /api/stores/:id/connection` `{machine, clear}` | `store disconnect --machine` ↻ |
| **⋯ › Check**, Connection › **Check**, a Connected-from chip, **Connect a machine** | `… › <store>` | `GET /api/stores/:id/check?machine=` | `store doctor --machine`, `store get` |
| **Change login…** → Edit connection | `… › <store> › Connection` | `POST /api/stores/:id/connection` | `store connect`, `store save-auth`, `store update`, `store get` ↻ |
| **Give <m> its own address** → **Save and check** | `… › Connection`, check screen | `POST /api/stores/:id/connection` `{machine, url}` | `store connect --machine`, then `store doctor --machine` |
| **Save a login…** → **Save** | `… › <store>` | `POST /api/stores/:id/connection` | `store save-auth`, `store update --auth` ↻ |
| **Rotate password…** → **Save and check** | `Home › Stores` PostgreSQL login header | `POST /api/store-auths/:id/rotate` | `store save-auth`, `store doctor` per Store, `store get` ↻ |
| **Remove login** | `Home › Stores` PostgreSQL login ⋯ | `DELETE /api/store-auths/:id` | `store remove-auth` ↻ |
| Saved logins list | PostgreSQL dialogs | `GET /api/store-auths` | `store auths` (read) |
| **Add project** → **Create project** | `… › <store> › Projects` | `POST /api/projects`, `GET /api/project-inits/:id` | `project init` |
| Backups tab › **Restore…** → **Restore Store** | `… › <store> › Backups` | `POST /api/buckets/:id/restore` | `backup restore`, then `backup list` |
| Backups badge → Backups of <store> | Store cards | `GET /api/buckets/:id/files` (each linked bucket) | `backup list` (read) |
| Backups dialog › **Update** / **Back up now** | Backups dialog | `POST /api/stores/:id/backup` | `backup create`, `backup list` |
| **Add › New Store** → **Create Store** | nav bar Add, Home › Stores, native › Stores | `POST /api/stores` (+ `POST /api/machines/:m/stores`) | `store create` ↻ (then `store get`, `store move` to place it) |
| New Store › Restore from a backup → **Restore Store** | New Store dialog | `POST /api/buckets/:id/restore` (+ `POST /api/machines/:m/stores`) | `backup restore`, `backup list` (then `store move`) |
| New Store › **List the bucket** | New Store dialog | `GET /api/buckets/:id/files` | `backup list` (read) |
| **Start <machine>** in New Store or Push | dialogs | `POST /api/machines/:id/start` | `machine start` |
| **Add › Connect a database** → **Connect** | nav bar Add, Home › Stores › PostgreSQL, a machine's Stores | `POST /api/stores/postgresql` | `store save-auth` (a new login), `store connect`, `store get` ↻, then `store doctor --machine` |
| Push a Store here / **Add Store** → **Move here** | `Machines › <m> › Stores` | `POST /api/machines/:id/stores` | `store get`, `store move` (push, pull, or pull then push) |
| Job **Retry** | job card | the job's route again | the job's own calls |
| Job **Dismiss** | job card | — | — (this browser) |
| Needs-you **Start <machine>** | Store page notice, card status | `POST /api/machines/:id/start` | `machine start` |
| **Add › Add bucket** → **Connect bucket** | nav bar Add, Back up dialog, Home › Stores › Buckets | `POST /api/buckets` | `backup connect` (the secret on stdin) ↻ |
| **Connect again…** → **Connect again** | bucket page, bucket card | `POST /api/buckets`, `GET /api/buckets/:id/files` | `backup connect`, `backup list` |
| Open a bucket page, **List** / **List again**, card **⋯ › List files** | `LayerFS › … › <bucket>` | `GET /api/buckets/:id/files` | `backup list` (read) |
| **List bucket files** | `Home › Stores › SQLite › Buckets` | `POST /api/storage/check` | `backup list` per bucket, then the Storage view reads |
| Bucket **Test connection** | `… › <bucket>` | `POST /api/doctor/runs` `{kind: bucket}` | `backup doctor` |
| Bucket **⋯ › Disconnect** → **Disconnect** | `… › <bucket>` | `DELETE /api/buckets/:id` | `backup disconnect` ↻ |
| Bucket or file row **Back up now** | `… › <bucket>`, `… › <bucket> › <file>` | `POST /api/stores/:s/backup` `{bucket, file}` | `backup create`, `backup list` |
| **Restore…** / **Restore as a new Store…** → **Restore Store** | bucket page, file page, bucket card | `POST /api/buckets/:id/restore` | `backup restore`, `backup list` |

## Projects

Pages: [Project](project.md)

| Interaction | Where | Host route or op | LayerFS call(s) |
|---|---|---|---|
| Open the project page (Files tab) | `LayerFS › Home › Stores › <store> › <project>` | `GET /api/projects/:id/branches` | `branch list`, `branch get main` (read) |
| Open a folder | `… › <project> › Files` | `GET /api/projects/:id/fs` | `file list` (read); `branch get` only when no saved id is known yet |
| Open a file (Code), **Show more lines** | `… › Files` | `GET /api/projects/:id/file` | `file stat`, `file read` (read) |
| **Blame** | `… › Files › Blame` | `GET /api/projects/:id/file-query?kind=blame` (+ `kind=revisions`) | `file read`, `file blame`, `file history`, `commit get` per owner not yet named (read) |
| File **History**, **Include other branches**, **Load earlier versions** | `… › Files › History` | `GET /api/projects/:id/file-query?kind=revisions` | `file history`; with other branches also `file history --traversal branch` and `commit get` per version saved elsewhere (read) |
| A version's diff, **Compare with:** | `… › Files › History` | `GET /api/projects/:id/file-query?kind=compare` | `commit diff --path --with patch` (read); a non-text file also `file stat --at` each side (read) |
| Branch picker, **Load more branches** | `… › Files` | `GET /api/projects/:id/branches?pos=` | `branch list` (read) |
| Open the History tab, **Refresh** | `… › History` | `GET /api/projects/:id/history` (Branch list, then pages) | `branch list`, `branch get main`, `commit list` (read) |
| **Load all** (background read) | `… › History` | `GET /api/projects/:id/history?branch=&at=&wide=1` | `commit list` (read) |
| Side-Branch totals | `… › History` | `GET /api/projects/:id/history?…&count=1` | `commit list` wide pages (read; kept per head) |
| **Stop**, zoom, **Whole run**, fold a Branch family | `… › History` | — | — (view state) |
| Select a leaf, Layer or Branch tag | `… › History` | `GET /api/projects/:id/history?branch=&commit=` | `commit get`, `commit diff` paths only (read) |
| **View diff** | `… › History › Changes in <id>` | `…/history?commit=` + `GET /api/projects/:id/file-query?kind=compare` | `commit get`, `commit diff`, `commit diff --path --with patch` (read) |
| **Compare** / **Compare with…** then pick a version or a Branch tag | `… › History › Compare versions` | `GET /api/projects/:id/file-query?kind=branch-diff` then `kind=compare` | `commit diff` (read), `commit diff --path --with patch` (read) |
| **Open at this commit** / click a changed path | History → Files | `GET /api/projects/:id/fs`, `/file` at that version | `file list`, `file stat`, `file read` (read) |
| Branch finder › **Load more branches** | `… › History` | `GET /api/projects/:id/history?pos=` | `branch list` (read) |
| Sandboxes tab (list) | `… › <project> › Sandboxes` | `GET /api/projects/:id/sandboxes`, `GET /api/sandboxes/:id` | `sandbox list` (read), `sandbox get` (read, host-kept) |
| Sandboxes tab (calls on the map) | `… › Sandboxes` | op `logs.project` | — (the plugin's call log) |
| Close a Sandbox (**Force close**) | `… › Sandboxes` | `DELETE /api/sandboxes/:id[?force=1]` | `sandbox remove` |
| Sessions tab | `… › <project> › Sessions` | op `sessions.list` | `branch list --prefix dsh.session.` (read), `project export` of a moved archive (read) |
| **New session** | `… › Sessions` | DSH new session + op `sessions.choose` (+ `sessions.prepareScratch` when no folder is selected) | `project get` (read); the session store syncs in the background; the Workspace is mounted on the first step |
| **Open** (a session) | `… › Sessions` | op `sessions.open` | none if local; `project export` (read) to import a stored one |
| Stats tab, **Recount** | `… › <project> › Stats` | `GET /api/projects/:id/storage[?refresh=1]` | `project get` (read, kept), `store get` ×2, `project stats`; ledger: `branch list`, `commit list` (read) |
| **View Store usage** | `… › Stats` | — (opens the Store page) | — |
| **Refresh project** | Project tab bar | the shown tab's routes again | as that tab |
| **⋯ › Delete project…** → **Delete** | Project tab bar | `DELETE /api/projects/:id` | `project delete` |

## Machines and Sandboxes

Pages: [Machine](machine.md) · [Sandbox](sandbox.md)

| Interaction | Where | Host route or op | LayerFS call(s) |
|---|---|---|---|
| Machine page, Machines board | `Home › Machines`, `… › <machine>` | `GET /api/machines` | `home get`, `machine list`, `machine get --with live`, `sandbox list`, `store list` (read) |
| **Check again** (fix panel) | machine notice, Add machine | `GET /api/machines?fresh=1` | the same reads, with platforms read fresh |
| Usage card, board Memory, Sandbox figures | Overview, board, Sandboxes tab, Sandbox Overview | `GET /api/metrics` | — (sampler memory; the sampler runs `machine stats` per machine every 15 s) |
| Board Disk, Usage disk split, **On disk** | board, Overview, Sandbox Overview | `GET /api/machines/:id/space` | `machine stats --with space` (read, kept 1 min) |
| Disk space dialog, **Refresh** | `… › <machine> › Overview` | `GET /api/machines/:id/space[?fresh=1]` | `machine stats --with space` (read) |
| **Run diagnostics** | machine Overview | Doctor (`/api/doctor/…`) | `machine doctor` |
| **Diagnose this host** | `Home › Machines` ⋯ | Doctor | `home doctor` |
| **Start worker** / **Start** | machine head, board, menu | `POST /api/machines/:id/start` | `machine start` |
| **Stop worker** / **Stop** | machine head, board, menu | `POST /api/machines/:id/stop` | `machine stop` |
| **Restart worker** (fix) | machine head, menu | `POST /api/machines/:id/restart` | `machine get`, `machine stop`, `machine start` |
| **Restart worker** (outdated worker) | `… › <machine> › Images` | `POST …/stop` then `POST …/start` | `machine stop`, `machine start` |
| **Force stop…** → **Force stop** | machine ⋯ | `POST /api/machines/:id/stop` `{force}` | `machine stop --force` |
| **Update settings…** → **Save** | machine ⋯, Details | `POST /api/machines/:id/update` | `machine update` |
| **Remove…** → **Remove** / **Remove everything** | machine ⋯, Danger zone | `DELETE /api/sandboxes/:s?force=1` ×n, `DELETE /api/stores/:s` ×n, `DELETE /api/machines/:id` | `sandbox remove --force`, `store remove`, `machine remove` |
| **New machine** → **Create** | `Home › Machines`, Add menu | `POST /api/machines` | `home get`, `machine create` |
| **Inspect current state** | Add machine, after a failure | `GET /api/machines/:id/inspect` | `machine get` (read) |
| New Sandbox: project list | New Sandbox dialog | `GET /api/projects` | `project list` (read) |
| New Sandbox: image menu, Images tab | New Sandbox dialog, `… › Images` | `GET /api/machines/:id/sandbox-images` | `machine get`, `machine images --with docker`, `sandbox list` (read) |
| New Sandbox → **Create** / **Start and create** | New Sandbox dialog | `POST /api/projects/:id/sandboxes` `{background}` | `store get`, `project get`, (`machine start`), `sandbox create` |
| **Retry** a failed create | creating row | `POST /api/projects/:id/sandboxes` | `sandbox create` |
| **Dismiss** a failed create | creating row | `DELETE /api/sandbox-creates/:id` | — (host only) |
| Copy an image to the machine | `… › Images` Docker list | `POST /api/machines/:id/load-image` | `machine load-image` (in the background) |
| **Dismiss** a failed copy | `… › Images` | `DELETE /api/image-loads/:id` | — (host only) |
| Remove an image / **Free space…** → **Remove n images** | Images card, Free space dialog | `POST /api/machines/:id/prune-images` | `machine prune <m> <image>` per image |
| Files tab (machine) | `… › <machine> › Files` | `GET /api/machines/:id/files` | `machine files` (read) |
| Cancel a Files or log read, leave the tab | Files, logs | op `inspect.cancel` | — (host only) |
| Worker log | `… › <machine> › Worker log` | `GET /api/machines/:id/log` | `machine log` (read) |
| Sandbox page, **Refresh** | `… › <sandbox>` | `GET /api/sandboxes/:id` | `sandbox get` (read) |
| **Diagnose** | Sandbox Overview | Doctor | `sandbox doctor` |
| **Delete Sandbox…** → **Delete Sandbox** | Sandbox ⋯, card ⋯, board row ⋯ | `DELETE /api/sandboxes/:id` | `sandbox remove` (a conversation's Sandbox: `workspace status`, `workspace commit`, `sandbox remove --force`) |
| **Force delete Sandbox…** | same | `DELETE /api/sandboxes/:id?force=1` | `sandbox remove --force` |
| **Close** (a gone Sandbox) | Sandbox card | `DELETE /api/sandboxes/:id` | `sandbox remove` |
| New workspace: Branch list | `… › <sandbox> › Workspaces` form | `GET /api/projects/:id/branches` | `branch list`, `branch get` (read) |
| **Mount** | Workspaces form | `POST /api/sandboxes/:id/workspaces` | `workspace mount` (a new Branch: `sandbox get`, `branch fork` first) |
| Run a command (Enter) | terminal pane | `POST /api/workspaces/:ws/commands` | `workspace exec` |
| Ctrl+C | terminal pane | `POST /api/workspaces/:ws/cancel` | `workspace cancel --exec` |
| Transcript | terminal pane | `GET /api/workspaces/:ws/commands` | — (host only) |
| **Commit…** → **Commit** | terminal ⋯ | `POST /api/workspaces/:ws/commit` | `workspace commit` |
| × close a pane | terminal head | `DELETE /api/workspaces/:ws?discard=1&force=1` | `workspace unmount --discard --force` |
| Sandbox Files (Sandbox folders, Whole filesystem) | `… › <sandbox> › Files` | `GET /api/sandboxes/:id/files` | `sandbox files` (read) |
| Sandbox Files (Workspaces view) | `… › <sandbox> › Files` | `GET /api/projects/:id/fs`, `/file` | `branch get`, `file list`, `file read`, `file stat` (read) |
| Daemon log | `… › <sandbox> › Daemon log` | `GET /api/sandboxes/:id/log` | `sandbox log` (read) |

## Project sessions, Doctor, Logs and Presets

Pages: [Conversation](conversation.md) · [Doctor](health.md) · [Logs](logs.md) · [Presets](presets.md)

| Interaction | Where | Host route or op | LayerFS call(s) |
|---|---|---|---|
| LayerFS tabs appear; the project-session mark | any conversation header | op `session.place` | — (host memory) |
| Trajectory tab draws | project session › Trajectory | op `session.trajectory` | — (the session's log and its LayerFS annotations) |
| Turn and LayerFS-call folds, **Only LayerFS writes**, search, **Show more rows**, timeline click, context messages | Trajectory toolbar and table | — | — (view state) |
| Inspector Payload / Result | Trajectory › a record › inspector | op `session.trajectory.record` | — (the session's log) |
| Version chip, **Open in History** | Trajectory row or inspector | opens the History tab | the History view's reads (`branch list`, `commit list`, `commit diff`) |
| Session line, unsaved count | Files, History, Stats tabs | op `session.state` | `workspace status --detail`, `project get`, `branch list --prefix dsh.project.`, `machine get`, `store get` (read) |
| Files tab | project session › Files | `GET /api/projects/:id/fs`, `/file`, … | `file list`, `file read`, `file stat`, `branch get` (read) |
| Stats tab | project session › Stats | `GET /api/projects/:id/storage` | `project get`, `project stats`, `store get` (read) |
| Sandbox map agents, Activity | project session › Sandbox | op `logs.list` `{tag: dsh:<session>:}` | `home log --tag` (read, 1000 per page) |
| Sandbox map machine marks | project session › Sandbox | `GET /api/machines` | `home get`, `machine list`, `machine get`, `sandbox list`, `store list` (read) |
| Play, Pause, Replay, speed, **Live**, scrub, This chat | project session › Sandbox | — | — |
| Activity call detail | project session › Sandbox | ops `logs.output`, `session.trajectory.record` | — (kept outputs) |
| **View script** and its modal | a scripted session's header | ops `simulation.script`, `simulation.status` | — (saved script files) |
| Doctor page draws | `LayerFS › Doctor` | `GET /api/doctor/tree`, `GET /api/doctor/results` | `home get --with tree --detail` (read); results: — |
| **Check** | a Doctor row | `POST /api/doctor/runs` | `home doctor` / `machine doctor <m>` / `store doctor <s>` / `project doctor <s/p>` / `sandbox doctor <b>` / `backup doctor <b>` |
| **Full check** | a Doctor project or bucket row | `POST /api/doctor/runs` `{full}` | `project doctor --full`, `backup doctor --full` |
| **Check all** | Doctor head | `POST /api/doctor/runs` (a group) | `home doctor`, `store doctor` ×n, `sandbox doctor` ×n |
| **Stop** | a Doctor row | `POST /api/doctor/runs/:id/stop` | — (stops the running CLI process) |
| **Start** / **Restart worker** / **Back up now** | a Doctor row's fix | `POST /api/doctor/fixes` | `machine start` / `machine stop` + `machine start` / `backup create <s> <b>`; then that thing's doctor again |
| **Delete project** → confirm | a Doctor project row | `POST /api/doctor/fixes` | `project delete <s/p>`, then the Store's doctor |
| **Copy** (call, fix) | Doctor row details | — | — |
| Logs table, filters, **Refresh**, **Load older calls**, tag chip, **Show all calls** | `LayerFS › Logs` | op `logs.list` | `home log --detail` with `--call` / `--client` / `--tag` / `--outcome` / `--cursor` (read); the stand-in file when the CLI has no `home log` |
| **Reset…** → **Reset** | Logs head | op `logs.reset` | `home clear-log` (or the stand-in), and the kept outputs |
| Call detail output, **Retry** | Logs › a row | op `logs.output` | — (re-reads the kept output; does not run the call again) |
| **Copy**, **Open session**, previous / next | Logs › a row | — | — |
| **Calls of this session / checkpoint** | Logs › a row | op `logs.list` `{tag}` | `home log --tag` (read) |
| Presets dialog, preset list, status, resource details | `Home ›` Try a preset | `GET /api/demo-presets` | — (host records) |
| **View script**, a project's **#** | Presets | `GET /api/demo-presets/:id/script` | `machine list`, `store list`, `sandbox list`, `sandbox get` ×n (read) |
| **Build…** / **Rebuild…** → **Continue** | Presets | `GET /api/demo-presets/:id/build-plan` | `home get --with platforms`, `machine list`, `store list`, `sandbox list`, `sandbox get` (read) |
| **Wipe and build** | Presets plan review | `POST /api/demo-presets/:id/environment-reset` `{rebuild: true}` | the reset (`machine start`, `workspace unmount --discard`, `sandbox remove`, `store remove`, `store disconnect`, `machine remove`, `machine stop docker`), then the recipe (`store create`, `project init`, `file write`, `branch fork` / `merge` / `publish`, …; mixed mode adds `workspace mount` / `exec` / `commit`), then reads to verify |
| **Stop machines…** (open) | Presets ⋯ | `GET /api/demo-presets/:id/environment-plan` | `machine list` (read) |
| **Stop machines** | Presets confirm | `POST /api/demo-presets/:id/environment-reset` `{rebuild: false}` | `machine stop <m> --force` for each machine; the project sessions are deleted |
| **Check operation** | Presets failure notice | `GET /api/demo-presets/requests/:id` | — |
