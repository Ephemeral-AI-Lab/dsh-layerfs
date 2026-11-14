# dsh-layerfs

## Install with an agent

Paste the prompt below into a coding agent (Claude Code or similar) on the machine where
DeepSeek Harness runs, and give it the three inputs it asks for. It installs this plugin
and a LayerFS runtime built from the latest
[`layerfs_v2_0_0`](https://github.com/Ephemeral-AI-Lab/layerfs/tree/layerfs_v2_0_0),
pins it and proves it matches the remote tip. The same steps by hand are under
[Install](#install).

````markdown
Install the **dsh-layerfs** DeepSeek Harness plugin, and a LayerFS runtime built from
the **latest `layerfs_v2_0_0`** of Ephemeral-AI-Lab/layerfs, then pin that runtime
and prove that it matches the remote tip.

Inputs (ask me for any that are missing, and don't guess them):

- `WORK`: an absolute folder to put the checkouts in, e.g. `~/src`.
- `DSH_PROFILE`: the DSH profile to install into (normally `web`).
- `DSH_RUNNING`: whether a `dsh web` server is running now, and how it was started
  (its command, cwd and `DSH_HOME`).

## Rules

- Don't modify DeepSeek Harness or LayerFS sources. dsh-layerfs is a DSH plugin, and
  LayerFS is only built here, never edited.
- Don't hand-edit the LayerFS home (`~/.layerfs`, or `LAYERFS_HOME`). Only the DSH
  app (the Runtime → Change dialog or the host API) and the `layerfs` CLI change it.
- Build LayerFS with **`--profile release`** in every step. Both build tools default
  to debug, and a debug daemon makes docker Workspaces several times slower.
- Before restarting a running `dsh web`, or stopping a docker/Lima machine that has
  open Sandboxes or mounted Workspaces, tell me what will be interrupted and wait
  for my OK. Never unmount with `--discard` or remove Store contents.
- Never print the `dsh web` URL token into chat or files.
- Use Node ≥ 24. Every command that waits gets a timeout. Report failures with their
  output and don't retry blindly.

## Steps

1. **Plugin.** In `WORK`:
   ```sh
   git clone -b layerfs_v2_0_0 https://github.com/Ephemeral-AI-Lab/dsh-layerfs.git
   cd dsh-layerfs && npm install && node scripts/build.mjs
   npx tsc -p tsconfig.json && node --test test/*.test.mjs
   dsh plugin --profile "$DSH_PROFILE" add link:$PWD
   ```
   If dsh-layerfs is already cloned, `git fetch` and fast-forward
   `layerfs_v2_0_0` instead, and merge rather than overwrite any local changes. The
   unit tests must all pass.

2. **LayerFS at the tip.** Clone `https://github.com/Ephemeral-AI-Lab/layerfs` into
   `WORK/layerfs` if it's missing, then:
   ```sh
   git -C "$WORK/layerfs" fetch origin layerfs_v2_0_0
   TIP=$(git -C "$WORK/layerfs" rev-parse origin/layerfs_v2_0_0)
   git -C "$WORK/layerfs" worktree add --detach "$WORK/layerfs-v2-tip" "$TIP"
   ```
   Read `WORK/layerfs-v2-tip/AGENTS.md` and `docs/general/parallel-worktrees.md`.
   Register the worktree with `python3 tools/worktree.py register --worktree
   "$WORK/layerfs-v2-tip" --owner dsh-layerfs-runtime --build-image … --runtime-image
   … --sandbox-image …`, using the LayerFS build, runtime and sandbox images already
   installed on this host (the doc says how to find them). Keep the printed
   `resources.json` path as `R`.

3. **Build the macOS pair and SDK addon** (prints the sealed build folder; keep it as `B`):
   ```sh
   python3 tools/worktree.py build --resources "$R" --platform macos --profile release \
     --features layerfs-cli/postgresql,layerfs-cli/tls,layerfs-daemon/postgresql,layerfs-node/postgresql,layerfs-node/tls
   ```

4. **Build the Linux bundle** into its own folder, so the shared default under
   `~/.cache/layerfs/bundle/` isn't overwritten:
   ```sh
   for s in daemon worker helper seal; do
     python3 tools/linux_bundle.py $s --resources "$R" --profile release --dest "$WORK/layerfs-bundles/$TIP" || break
   done
   ```
   The bundle lands in `<dest>/<version>/linux-<arch>/`, e.g.
   `$WORK/layerfs-bundles/$TIP/2.0.0/linux-aarch64`. Keep that folder (the one holding
   `bundle.json`) as `BUNDLE`.

5. **Prove it's the tip, built as release:**
   ```sh
   "$B/layerfs" --version --json          # commit == $TIP; features include machine, postgresql, tls
   git ls-remote https://github.com/Ephemeral-AI-Lab/layerfs layerfs_v2_0_0   # still $TIP
   grep -E '"profile"|"head"' "$BUNDLE/bundle.json"   # "release", head == $TIP
   ```
   If the branch moved during the build, start again from step 2 with the new tip.

6. **SDK for agents** (in the dsh-layerfs checkout):
   ```sh
   node scripts/install-sdk.mjs "$B"      # must say "(macos, release)" and $TIP
   ```

7. **Pin.**
   - **`dsh web` running:** open DSH → the LayerFS sidebar row → Center → Settings →
     Runtime → **Change…**. Give it `$B/layerfs`, `$B/layerfs-daemon` and `BUNDLE`.
     It copies them into `~/.layerfs/runtime/<version>-<sha>/` and pins those copies.
   - **Not running:** start `dsh web` with `DSH_LAYERFS_CLI=$B/layerfs`,
     `DSH_LAYERFS_DAEMON=$B/layerfs-daemon` and `DSH_LAYERFS_BUNDLE=$BUNDLE`.

   A host restart is needed only if the plugin's host code changed since `dsh web`
   started; follow the rule above before restarting.

8. **Machines.** Every docker or Lima machine needs a worker of the new build.
   1. List its Sandboxes.
   2. With my OK, commit (don't discard) any dirty Workspace, then unmount the
      Workspaces and close the Sandboxes.
   3. Stop and start the machine.
   4. If the new CLI refuses with "worker … of another build", pin the previous
      runtime briefly to close and stop, then pin the new one and start.

9. **Verify on the running app:**
   - Runtime status shows commit `$TIP`.
   - A `layerfs file stat` through the agent wrapper
     (`$DSH_HOME/layerfs/agent-bin/layerfs`, which becomes a `#!/bin/bash` script after
     the first agent shell) succeeds against a docker Store.
   - No call is refused as "of another build".
   - Logs shows lines with source `layerfs`.

## Report

Report:
- `$TIP`, `B` and `BUNDLE`;
- the CLI's `--version --json`;
- the bundle's profile and head;
- the SDK install line;
- the pinned runtime id;
- each machine you restarted, and what was open on it;
- the test results;
- anything you skipped and why.

## Updating later

When `layerfs_v2_0_0` moves, repeat steps 2–9 in the same worktree
(`git -C "$WORK/layerfs-v2-tip" fetch origin layerfs_v2_0_0 && git -C
"$WORK/layerfs-v2-tip" checkout --detach origin/layerfs_v2_0_0`), with a new bundle
folder per commit.
````

## Starter preset with an agent

The quickest way to see LayerFS with real history. **Starter** builds one SQLite Store
(`demo-starter`) on the **docker** machine with one project, `bookshelf` (a small
lending-library API with SQLite migrations): 552 commits on 20 branches, with
feature branches, merges, releases published to main, and two exploration branches.
It needs Docker and a matching Linux bundle, but no VMs, and builds in under a
minute. Paste this prompt once dsh-layerfs and its runtime are installed. Like every
preset, building it wipes the LayerFS home it targets, so the prompt asks first.

````markdown
Build the LayerFS **Starter** preset in dsh-layerfs and show me its project.
dsh-layerfs and a release LayerFS runtime (CLI, daemon and Linux bundle from one
`layerfs_v2_0_0` commit) are already installed and pinned.

Inputs (ask me for any that are missing, and don't guess them):

- `SERVER`: which `dsh web` to use. Either a private dev server (recommended: in the
  dsh-layerfs checkout, `DSH_LAYERFS_DEV_DIR=<abs dir> node scripts/dev.mjs --port
  <N>`, which writes its URL to `<dir>/url.txt`), or my main server, with its
  authenticated URL saved in a 0600 file `<dir>/url.txt`.
- `WIPE_OK`: whether that server's LayerFS home may be wiped. **Building a preset
  first deletes every Store, project, Sandbox and custom machine in it**, plus that
  home's project sessions, including a Studio library built there earlier.

## Rules

- Never build on my main LayerFS home (`~/.layerfs`) unless I said yes for that home
  by name. A private dev home is the default.
- Don't hand-edit any LayerFS home. Change it only through the app, its host API, or
  the `layerfs` CLI.
- Never print the URL token into chat or files. Report failures with their output,
  and don't retry blindly.
- Shell access to host operations: in the dsh-layerfs checkout,
  `DSH_LAYERFS_DEV_DIR=<dir> node tools/op.mjs <op> '<json>'` (the `http` op takes
  `{"method","path","body"}`). Below, `L` is the pinned CLI path from
  `op runtime.status`, run with that server's `LAYERFS_HOME` and `LAYERFS_BUNDLE`
  (without the bundle, the CLI refuses the docker worker as "of another build").

## A. Prerequisites

1. `op runtime.status`: `ok`, with one `commit` shared by the CLI, daemon and bundle.
2. `docker info` succeeds.
3. `"$L" machine platforms`: docker is ready and supports SQLite.

## B. Build

- **UI:**
  1. Open LayerFS (sidebar). On the home's head card, click the **Presets** button
     (or **Try a preset** on an empty Projects tab, or **Add** → **Try a preset**).
  2. Select **Starter** under Quick start → **Build…**. Leave **Also commit through
     sandbox workspaces** unticked → **Continue**. Read the impact (what the wipe
     removes) → **Wipe and build**.
  3. Wait for "Build complete". The status line should read "Built and verified ·
     … · File commands only", and the Starter row says **Built**.
- **Same thing through the host API:**
  1. Get the plan; it removes nothing:
     `op http '{"method":"GET","path":"/api/demo-presets/quickstart/build-plan-no-sandboxes?executionMode=filesystem"}'`.
     Keep `signature`. Show me `home` and `remove` before going on. If
     `dsh.sessions` is non-empty, list those sessions to me (the build deletes them)
     and add `"force": true` below.
  2. Build:
     `op http '{"method":"POST","path":"/api/demo-presets/quickstart/environment-reset","body":{"requestId":"<new uuid>","expectedPlan":"<signature>","confirm":true,"rebuild":true,"sandboxes":false,"executionMode":"filesystem"}}'`.
     The answer is a job.
  3. Poll `op http '{"method":"GET","path":"/api/demo-presets/jobs/<job id>"}'` until
     it ends (`presetVerified: true`). If it fails, report its stage and log. If an
     answer is lost, reconcile with `GET /api/demo-presets/requests/<requestId>`;
     never resubmit the build.

## C. Check

- `"$L" store list`: `demo-starter`, kind `sqlite`, machine `docker`, project
  `bookshelf`.
- `op http '{"method":"GET","path":"/api/projects/demo-starter%2Fbookshelf/branches"}'`:
  20 branches, among them `main`, `feature-loans`, `feature-search`,
  `feature-holds`, `fix-due-dates`, `release-0.1`…`release-0.3`, `release-001`,
  `release-002` and `explore-fines`.
- In the app: open **bookshelf** from the Projects tab and look at its history graph
  and files (`db/migrations/`, `src/`, `docs/`).

## D. When done

Stop the docker machine if nothing else needs it: `"$L" machine stop docker`. The
Store and project stay. (Presets → **Stop machines…** does the same, but needs a CLI
that supports a forced `machine.stop`.)
````

## Presets and /simulation with an agent

Paste this prompt once dsh-layerfs and its runtime are installed. It checks
the prerequisites with the `layerfs` CLI, builds the **Studio** preset in **Mixed**
mode (from the UI or the host API), and runs a **/simulation** on the **docker**
machine in Mixed mode. Building Studio wipes the LayerFS home it targets, so the
prompt asks before touching any home that isn't a private dev home.

````markdown
Set up the LayerFS **Studio** preset and run a **/simulation** in dsh-layerfs, both
in **Mixed** mode, with the simulation on the **docker** machine. dsh-layerfs and a
release LayerFS runtime (CLI, daemon and Linux bundle from one `layerfs_v2_0_0`
commit, CLI built with `postgresql`) are already installed and pinned.

Inputs (ask me for any that are missing, and don't guess them):

- `SERVER`: which `dsh web` to use. Either a private dev server (recommended: in the
  dsh-layerfs checkout, `DSH_LAYERFS_DEV_DIR=<abs dir> node scripts/dev.mjs --port
  <N>`, which writes its URL to `<dir>/url.txt`), or my main server, with its
  authenticated URL saved in a 0600 file `<dir>/url.txt`.
- `WIPE_OK`: whether that server's LayerFS home may be wiped. **Building Studio
  first deletes every Store, project, Sandbox and custom machine in it**, plus that
  home's project sessions.
- `SCRATCH`: a folder the simulation can use as scratch.

## Rules

- Never build Studio on my main LayerFS home (`~/.layerfs`) unless I said yes for
  that home by name. A private dev home is the default.
- Don't hand-edit any LayerFS home. Change it only through the app, its host API, or
  the `layerfs` CLI.
- Never print the URL token into chat or files. Report failures with their output,
  and don't retry blindly.
- Shell access to host operations: in the dsh-layerfs checkout,
  `DSH_LAYERFS_DEV_DIR=<dir> node tools/op.mjs <op> '<json>'` (the `http` op takes
  `{"method","path","body"}`). Below, `L` is the pinned CLI path from
  `op runtime.status`, run with that server's `LAYERFS_HOME` and `LAYERFS_BUNDLE`.

## A. Prerequisites (CLI)

1. `op runtime.status`: `ok`, with one `commit` shared by the CLI, daemon and bundle.
   The bundle's `bundle.json` must say `"profile": "release"`.
2. `"$L" --version --json`: `features` includes `machine` and `postgresql`.
3. `"$L" machine platforms`: docker and lima are ready.
4. `docker info` succeeds, and `limactl --version` prints a version. Studio needs
   both; the docker machine and its PostgreSQL server run in Docker, and the two VMs
   in Lima.

## B. Studio preset, Mixed mode

Mixed means about 30% of commits run a shell command in a sandbox Workspace and
commit the result (`workspace mount → exec → commit → unmount`) instead of writing
files directly. It needs the matching native daemon (A.1).

- **UI:**
  1. Open LayerFS (sidebar) → the **Presets** button on the home's head card →
     **Studio** under Full demos → **Build…** (or **Rebuild…**).
  2. Tick **Also commit through sandbox workspaces**, then **Continue** →
     **Wipe and build**.
  3. Wait through Checking, Resetting, Building and Verifying until "Build complete".
     The status line should read "Built and verified · … · File commands and sandbox
     workspaces".
- **Same thing through the host API:**
  1. Get the plan; it removes nothing:
     `op http '{"method":"GET","path":"/api/demo-presets/studio/build-plan?executionMode=mixed"}'`.
     Keep `signature` (it starts with `mixed:`). If `dsh.sessions` is non-empty,
     list those sessions to me (the build deletes them) and add `"force": true` below.
  2. Build:
     `op http '{"method":"POST","path":"/api/demo-presets/studio/environment-reset","body":{"requestId":"studio-mixed-1","expectedPlan":"<signature>","confirm":true,"rebuild":true,"sandboxes":true,"executionMode":"mixed"}}'`.
     The answer is a job.
  3. Poll `op http '{"method":"GET","path":"/api/demo-presets/jobs/<job id>"}'` until
     it ends. If it fails, report its stage and log.
- **Check with the CLI:**
  - `"$L" machine list`: `native`, `docker`, `demo-build` and `demo-research`.
  - `"$L" store list`: `demo-studio`, `demo-services`, `demo-build-cache` and
    `demo-experiments`, with 8 projects between them.
  - `"$L" sandbox list`: Mixed Sandboxes `demo-mix-<project>-1`.
- **Stopping it later:** Presets → **Studio** → More actions → **Stop machines…**. It
  force-stops the machines and deletes project sessions, but keeps Stores and
  projects.

## C. /simulation on docker, Mixed mode

`/simulation` doesn't need the preset. It creates its own Store `sim-<project>-<hash>`
and project `<project>-<hash>`, pushes the Store to the machine you name, and never
starts that machine.

1. Make sure docker is running: `"$L" machine get docker`. If it's stopped, run
   `"$L" machine start docker` and check again.
2. In DSH, start a session whose folder is `SCRATCH` (it becomes the run's scratch),
   and select a usable real model. The scripts drive the agents; the real model
   continues the sessions after the script ends.
3. Type into the composer:
   ```
   /simulation --project design --machine docker --mixed
   ```
   Only these three flags exist; `--project` and `--machine` are required. Valid
   projects: design, billing, sdk, evaluation, embeddings, compiler, gateway,
   website.
4. It answers "Opened project session <id>." and opens it. The parent and child
   agents follow their scripts (model `simulation`; the header's **View script**
   shows them) and make real LayerFS calls. With `--mixed`, some steps mount a
   Workspace in Sandbox `sim-<hash>-1` on docker, run the command, commit and unmount.
5. Watch the session's **Sandbox** tab (agents → Branches → Workspaces, live and
   replay), **History** and **Files**, and Center → **Logs**.
6. To stop, use the composer's Stop; stopping a child stops its root family.
7. Check with the CLI:
   - `"$L" store list` shows `sim-design-<hash>` on `docker`.
   - `"$L" branch list sim-design-<hash>/design-<hash>` shows the run's Branches.
   - Logs shows no refusals except expected ones (e.g. NoMatch from probing reads).

## Report

Report:
- the server and home you used;
- the A checks with their output;
- the Studio job id, its stages and the machines, Stores and projects that resulted;
- the simulation's session id, Store, project and Sandbox;
- how many conversations and agents ran, and how it ended (finished or stopped);
- anything you skipped and why.
````

LayerFS for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): the
Machines and Storage pages of LayerFS Connect and its project session mode — a
project session belongs to a LayerFS project and uses the selected local folder
as scratch, with native DSH conversation logs and per-turn checkpoints. Normal
sessions belong to DSH workspaces and retain stock behavior. One DSH plugin bundle; DSH itself is not modified.

## What it adds

| Where | What |
| --- | --- |
| Sidebar → **Machines** | LayerFS machines (native, docker, VMs): state, Sandboxes, Stores, spec, start/stop, add machine; the pinned LayerFS runtime (CLI, daemon, home) |
| Sidebar → **Resources** | Stores (SQLite, PostgreSQL), projects (import a folder), files, history and commit diffs, branches, Sandboxes, backups to buckets and restore, Store push/pull/move, home checks; a project's **Sessions** |
| LayerFS home → **Presets** (head card button, **Try a preset** on an empty Projects tab, or **Add** → **Try a preset**) | A dialog listing the sample libraries this host can build into the LayerFS home. Quick starts: **Starter**, one SQLite Store on the docker machine with one project (`bookshelf`, 552 commits on 20 branches), no VMs, built in under a minute. Full demos: **Studio**, LayerFS Connect's library (4 machines, 4 stores, 8 projects with dense branch/merge/publish histories). Each shows its machine → store → project plan, each project's paged CLI script (**View script**), Filesystem or Mixed (workspace exec/commit) mode, **Build…** and **Stop machines…**, with real stage/count progress and a job log. One home holds one preset at a time; building another replaces it |
| Sidebar → **Projects** | Every LayerFS project as a card holding its sessions; **New session** per project, **New empty project** / **Import project…** in the header, sessions stored in a project open by id |
| New Session row | Choose **No project** for a normal workspace session or select a LayerFS project. The local folder chooser remains visible; in project mode that folder is scratch. Choose another project, create an empty project, or import one from a host folder before the first turn |
| Project sessions | Owned and listed by the LayerFS project, with a private execution context. The selected local folder is scratch, even if it is also a DSH workspace. Local shell commands run in scratch; project commands use the managed LayerFS CLI. Scratch is never checkpointed or deleted on session close/forget |
| Turn end | A checkpoint: the Workspace is committed to the branch when the turn changed files |
| Conversation tabs → **Files**, **History**, **Sandbox** | Project sessions only: the project's files on the session branch (with the unsaved count), its history graph, and a map of agents → branches → sandbox workspaces that replays their LayerFS calls. These tabs have no composer. Normal workspace sessions keep only Chat and Trajectory ([spec](docs/specs/conversation-views.md)) |
| Session store | Project conversations use unpacked native DSH JSONL under `$DSH_HOME/layerfs/project-sessions`, with additive `layerfs.json` annotations. Logs and annotations are archived inside the project for portability; normal logs remain under `$DSH_HOME/sessions`. |
| Conversation activity | SDK and managed CLI invocation receipts link exact tool-call IDs to confirmed saved versions. `workspace.exec` has no checkpoint links; automatic saves appear separately. Saved-version labels open immutable project files |

DSH's own **Fork** of a project session also starts its files from the checkpoint
at the fork point. Subagents share their parent's project execution context.
Changing the owner after work starts requires a new session.

## Install

Two parts: this plugin, and a LayerFS runtime built from the tip of
[`layerfs_v2_0_0`](https://github.com/Ephemeral-AI-Lab/layerfs/tree/layerfs_v2_0_0).
The plugin pins no LayerFS version; it runs the runtime you pin. To have an agent do
all of this, give it the prompt in [Install with an agent](#install-with-an-agent). To fill a home with
a sample project, the one in [Starter preset with an agent](#starter-preset-with-an-agent); for the full
Studio library and `/simulation`, the one in [Presets and /simulation with an agent](#presets-and-simulation-with-an-agent).

### 1. The plugin (Node ≥ 24, DSH 0.2.2-rc.1)

`lib/` is not committed, so build after cloning; the `@deepseek-ai` packages come
from the public npm registry.

```sh
git clone -b layerfs_v2_0_0 https://github.com/Ephemeral-AI-Lab/dsh-layerfs.git
cd dsh-layerfs && npm install && node scripts/build.mjs
dsh plugin --profile web add link:$PWD
```

### 2. A LayerFS runtime from the latest `layerfs_v2_0_0`

Build in a LayerFS worktree registered with `tools/worktree.py` (LayerFS
`docs/general/parallel-worktrees.md`). **Pass `--profile release` everywhere**: both
build tools default to debug, and a debug daemon makes docker Workspaces several
times slower.

```sh
git -C /path/to/layerfs fetch origin layerfs_v2_0_0
git -C /path/to/layerfs worktree add --detach /path/to/layerfs-v2-tip origin/layerfs_v2_0_0
cd /path/to/layerfs-v2-tip
# prints the registration's resources.json ($R); the images are the LayerFS build,
# runtime and sandbox images already installed on this host
python3 tools/worktree.py register --worktree "$PWD" --owner <name> \
  --build-image <build-image> --runtime-image <runtime-image> --sandbox-image <sandbox-image>
# macOS CLI, daemon and Node SDK addon; prints the sealed build folder ($B)
python3 tools/worktree.py build --resources "$R" --platform macos --profile release \
  --features layerfs-cli/postgresql,layerfs-cli/tls,layerfs-daemon/postgresql,layerfs-node/postgresql,layerfs-node/tls
# the Linux bundle docker and Lima machines run; --dest keeps the shared default untouched
for s in daemon worker helper seal; do
  python3 tools/linux_bundle.py $s --resources "$R" --profile release --dest "$HOME/layerfs-bundles/tip" || break
done
```

Check that it matches the remote tip: the CLI's `commit` equals the branch head, and
the bundle says `"profile": "release"` with the same `head`.

```sh
"$B/layerfs" --version --json
git ls-remote https://github.com/Ephemeral-AI-Lab/layerfs layerfs_v2_0_0
grep -E '"profile"|"head"' "$HOME"/layerfs-bundles/tip/*/linux-*/bundle.json   # <dest>/<version>/linux-<arch>/
```

### 3. The Node SDK agents import, then the pin

```sh
node scripts/install-sdk.mjs "$B"     # in this checkout; must match the pinned CLI's commit
```

Pin it on **Center → Settings → Runtime → Change…** (`$B/layerfs`, `$B/layerfs-daemon`
and the bundle folder), which installs the CLI, daemon and bundle into the LayerFS
home (`runtime/<version>-<sha>/`) and pins those copies; or start `dsh web` with
`DSH_LAYERFS_CLI`, `DSH_LAYERFS_DAEMON` and `DSH_LAYERFS_BUNDLE`. Then stop and start
each docker or Lima machine so its worker is of the new build (close its Sandboxes
first; while the new CLI refuses a worker "of another build", pin the old runtime to
close and stop, then pin the new one and start). When `layerfs_v2_0_0` moves, check
out the new tip in the same worktree and repeat steps 2 and 3.
The LayerFS home is LayerFS's own, apart from DSH: `~/.layerfs` by default
(`DSH_LAYERFS_HOME`, then `LAYERFS_HOME`, override it). It holds LayerFS's records,
its runtime, the secrets entered in the panel (`secret/`) and storage
jobs, statistics and Presets state (`job/`, `stat/`, `preset/`, named for no client); the bucket list
is read from LayerFS's records in the home. This plugin's per-install state
(runtime pin, session bindings, scratch) stays in `$DSH_HOME/layerfs`. See [docs/specs/homes.md](docs/specs/homes.md).

### Configuration (`layerfs` row in `cordis.patch.yml`)

| Key | Default | Meaning |
| --- | --- | --- |
| `root` | `$DSH_HOME/layerfs` | Plugin runtime settings, legacy anchors, execution bindings and receipt spool |
| `projectSessionHome` | `$DSH_HOME/layerfs/project-sessions` | Unpacked project conversation storage; `DSH_LAYERFS_SESSION_HOME` overrides the default |
| `cli`, `daemon`, `bundle` | unset | Explicit pins (otherwise saved setting, then env, then the newest runtime installed in the LayerFS home) |
| `cacheHome` | unset | The XDG cache home holding prepared VM OS images (`<cacheHome>/layerfs/machine-images`, built by LayerFS `tools/machine_image.py`), passed to every CLI as `XDG_CACHE_HOME`. Otherwise the saved setting (Machines → LayerFS runtime), then `DSH_LAYERFS_CACHE_HOME`, then the host's own `XDG_CACHE_HOME`. Without a prepared image, a new Lima machine boots the stock Ubuntu image (about 30 s instead of about 9 s) |
| `home` | `~/.layerfs` | The LayerFS home (`DSH_LAYERFS_HOME`, then `LAYERFS_HOME`, override the default) |
| `secrets` | `<home>/secret` | Where bucket keys and PostgreSQL passwords entered in the panel are saved (owner-only files LayerFS reads through `file:` references); `DSH_LAYERFS_SECRETS` overrides the default. A bucket keeps the key file it was connected with; only new saves use a changed folder |
| `scratchProject` | `dsh-scratch/scratch` | Legacy Scratch-project identity; normal sessions do not bind to it |
| `checkpoints` | `turn` | `off` disables per-turn commits |
| `idleMinutes` | `30` | Close an idle session's Sandbox (it reopens on the next turn) |

The bundle patch changes the following DSH rows:

| Row | Change |
| --- | --- |
| `session-persistence-jsonl` | Replaced by `layerfs-session-persistence`: stock JSONL stays the normal-session backend; project ownership routes native unpacked logs to a separate root. Missing project logs can be imported from the project archive |
| `sandbox-policy` | Replaced by a subclass that keeps selected scratch as the local working root and allows the bound project mount, private LayerFS runtime, and invocation receipts; normal sessions retain stock policy |

A project session's step requires its project execution context to be ready:
when it cannot be bound, the turn fails with LayerFS's reason. A session without a
project placement is simply a plain DSH session — nothing is bound, refused
or moved.

## Limits

- **Presets Reset force-stops this home's machines** without starting them or
  cascading through resource removal. Machines, Stores, projects, committed history,
  conversation logs and scratch folders remain. Running work ends; uncommitted
  Workspace changes may be lost. The confirmed action immediately returns a tracked
  job with per-machine progress. Reset requires the pinned CLI to advertise the
  boolean `force` option for `machine.stop` in `help --json`. Unsupported runtimes
  are rejected before confirmation and checked again before execution. Select a
  compatible CLI and matching daemon under Machines → LayerFS runtime → Change;
  Reset never silently substitutes ordinary Stop.
- **Build projects clears and rebuilds this LayerFS home**: every Store (including
  its project archives), Sandbox, Workspace and custom machine is removed before
  creating the library. Its separate confirmation lists that destructive scope.
  Studio needs Docker and Lima with a matching Linux bundle; Mixed mode also needs
  the matching native daemon.

- Project execution runs on the project's machine. On native machines a host
  mount is available; remote mounts stay inside their Sandbox. On both, local
  commands use the selected scratch folder and project commands use
  `"$DSH_LAYERFS_CLI" workspace exec "$DSH_LAYERFS_WS" '<command>' --stream`.
  A generated scratch folder is only a fallback. User-selected folders can be
  shared with other sessions and are never treated as disposable.
- CLI tracing covers the managed CLI entry point. Direct calls to another binary
  are not observed. Unknown command grammar or uncertain results receive no
  invented checkpoint links. DSH's native tool cards remain unchanged; additive
  activity is rendered at the conversation turn tail through a public slot.
- Restore and branch never rewrite history: a restore forks a new branch from the
  checkpoint and remounts it; the old branch stays.

## Development

Specification: [Project sessions and conversation handling](docs/specs/project-sessions.md).

### Project action scripts

`/simulation --project design --machine native [--mixed]` prepares a fresh
Store/project and opens ordinary project conversations. Each parent and child
uses its own script as its model, with real DSH tool calls and the same native
session logs and LayerFS annotations as other project sessions. The conversation
header offers **View script**; there is no separate progress dashboard.

The normal **Stop** button cancels script dispatch and its active descendants
(stopping a child stops its root family); other conversations keep going. Once a
script ends for any reason (completed, stopped, interrupted by a restart or
import, or failed) it never runs again, the session is not locked, and its real
model is selected again. Follow-up messages continue the same session from the
pinned saved version of a clean completion or stop, otherwise from the project's
current main, like a new session. `/simulation` refuses to start, creating
nothing, unless a usable real model is selected.

Script activation and restoration are session-local and leave the global model
default alone. DSH currently exposes no public admission hook to disable all
manual model-selection entry points during execution; an unexpected active
route is rejected before script tools can continue. This UI lock requirement
remains a host integration limitation.

Design: [Model-like simulation](docs/specs/model-like-simulation.md). Bounded
browser fixtures require a private dev server with
`DSH_LAYERFS_SIMULATION_FIXTURES=1`; production slash commands run the full recipe.

See [AGENTS.md](AGENTS.md). Earlier design notes: `../layerfs-connect/docs/dsh-layerfs/`.
