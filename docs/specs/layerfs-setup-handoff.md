# LayerFS setup: handoff (batches B, C, H, U)

Spec: [`layerfs-setup.md`](layerfs-setup.md). A1 was done before this
(`7aaf2a1feb`, LayerFS worktree `.claude/worktrees/home-setup-a1`, branch
`claude/home-setup-a1`).

## What was done

### LayerFS (branch `claude/home-setup-a1`, local only, not pushed)

Worktree `../layerfs/.claude/worktrees/home-setup-a1` (registered with
`tools/worktree.py`; resources
`~/.cache/layerfs-worktrees/home-setup-a1-aafe1446cd51/resources.json`).

- `7aaf2a1feb` A1: `home init`, `home get`, the daemon's build stamp,
  `source.dirty` in `bundle.json` (before this task).
- `3bf0ec569d` B: `machine platforms` gains the `bundle:<dir>` need, option
  `default`s, docker `socket {path, source, state}` and `candidates
  [{path, host, source, usable}]`; Homebrew/`/usr/local/bin`/Docker Desktop
  tool fallbacks (`LAYERFS_TOOL_FALLBACKS` replaces them); one automatic
  docker socket choice, recorded at the first start once the Engine answers;
  `machine update docker --docker ""` clears it; `machine create
  --os-image stock`; the stale progress tests fixed.
- `095f5887d9` C: doctor §2.6 (never-started docker is a warning;
  `host.native_daemon` checks the recorded daemon, else the default, and its
  commit, in the `DaemonMismatch` wording).
- `41a96bad2c` tests only: two call-table tests named the quiet calls
  without `home.get` (A1) and the machine family without `space` (#724,
  already stale on the parent). Production LOC unchanged, so the builds below
  (of `095f5887d9`) stand.

Builds of clean `095f5887d9`, release profile:
- sealed macOS bundle (CLI, daemon, `layerfs.node`, `api/`):
  `~/.cache/layerfs-worktrees/home-setup-a1-aafe1446cd51/artifacts/build-macos-985ca117f4434c45a22066aa52aa19aa`
- Linux bundle: `~/.cache/layerfs/bundle/2.0.0/linux-aarch64/` (protocol 3,
  `source.head` 095f5887d9, dirty false). **This replaced the dd4a2cc4
  bundle that was in that default cache folder**: anything that falls back to
  the cache bundle now gets 095f5887d9 (same protocol). 3080 is not affected:
  its runtime has its own bundle (`~/.layerfs/runtime/2.0.0-1c0ce0b54808/bundle`).
- `build-macos-cc697adc3a4d4b359969d28137ed050b` in the same artifacts folder
  is a debug build made by mistake (the launcher defaults to debug):
  disposable, release it at cleanup.

### dsh-layerfs (branch `layerfs-setup`, worktree `../dsh-layerfs-setup`)

- `66eff2b` H + U: the setup check and home gate (host), the Set up
  LayerFS modal, shared runtime picker, Center/Settings/Health/Add machine/
  docker socket/Runs on changes (UI).
- `5ecf238` review fixes: no deadlock between the gate's `machine list` and
  the SDK's in-flight read on old CLIs; a failing `home get` is "unknown",
  not current; stale checks are discarded (generation counter); a convert
  waits for a running check; the recorded daemon drives the daemon verdict;
  a never-started docker counts as idle for a bundle replace; machine events
  coalesced; logs treat `Uninitialized` as empty; failed runtime discovery
  is cached per file; the socket request lapses after 10 s.
- `ab5c393` the pin lease is written only after `startSetup()` (tests no
  longer leave leases in `~/.layerfs`).
- `ba73da7` "Use this daemon" only when the recorded daemon is gone or from
  another build (it showed for a same-commit daemon recorded from another
  folder, found on the B/C build); a test pins the cases.
- Merged into the 3080 checkout (`dsh-layerfs-integrate`) as `8ea64d6`, again
  after `ba73da7` (3080 restarted a second time for that host fix), and last
  with this handoff (docs only, no restart).
  Its untracked draft `docs/specs/layerfs-setup.md` (my branch's base text,
  without my edits) was moved aside before the merge; nothing else there
  was touched.

## Checks

- dsh-layerfs: `node scripts/build.mjs`, `npx tsc -p tsconfig.json`,
  `node --test test/*.test.mjs`: 674 pass, 1 skipped (in the worktree and
  again in the 3080 checkout after the merge); `test/setup.test.mjs` 13/13.
- e2e-sessions on a fake-llm side server with the **old runtime**
  (`DSH_LAYERFS_*` unset, the newest in `~/.layerfs/runtime`): E2E PASS at
  `ab5c393`.
- e2e-sessions with the **A1 build** (CLI/daemon from the A1 sealed bundle):
  E2E PASS at `66eff2b`.
- e2e-sessions with the **B/C build** (`DSH_LAYERFS_CLI`/`DAEMON` from the
  sealed 095f5887d9 bundle, `DSH_LAYERFS_BUNDLE` its Linux bundle): E2E PASS
  at `ab5c393`; the fallback on the old runtime again E2E PASS at `ba73da7`.
- Unit tests at `ba73da7`: 675 pass, 1 skipped; `test/setup.test.mjs` 14/14.
- Screenshots (side servers, private homes), checked by eye: missing home /
  no runtime (Center card, modal, picker), needs conversion, converted,
  current (all three pieces "Matches" on the B/C build), bundle mismatch
  (CLI/daemon 095f5887 with the dd4a2cc4 cache bundle: "From mixed builds",
  Done blocked), no docker (socket absent: "Can't run yet" with the reason,
  Start Docker, Socket…), docker's socket choice (Automatic plus the three
  candidates with sources and states), Add machine with Lima and Apple
  Container forms (CLI defaults 2 CPUs / 4G / 20G, Use stock image), Health,
  Settings.
- 3080 restarted (other sessions told first) exactly as AGENTS.md says;
  the setup modal and Center checked there with the user's home: "Everything
  required is ready", nothing converted.
- LayerFS, release, macOS, through `tools/worktree.py cargo`, every test
  target of each touched package (platform, machine, sandbox,
  sandbox-backend, control, api, cli, daemon, python; 267 targets): all pass
  after `41a96bad2c` (before it, the two stale table tests above failed).
  Linux-only targets (FUSE, Store execution, namespaces) compile and run
  nothing on macOS. `cargo +1.85.1 fmt --all --check` clean; clippy
  `--all-targets -D warnings` clean on all of them (with and without
  `--features machine`). `tools/test_linux_bundle.py`, `tools/test_worktree.py`
  34/34. Node SDK (15 files) and Python (66 OK, 3 skipped) against the sealed
  bundle (B/C agent).
- LayerFS MCP tests against the sealed bundle: 8 pass, 8 fail, all from one
  **pre-existing** cause: `sandbox.create`'s `image` option kind (#682,
  before the parent `dd4a2cc40f`) has no schema in `api/mcp/src/tools.js`, so
  the server stops at launch. The profile tests A1 changed pass. Not fixed
  here (outside B/C).

## Decisions

- §6.1 / A2 skipped (needs the LayerFS maintainers). Without it, any CLI
  call still opens (creates or converts) the home, so the plugin's **home
  gate** does it instead: before the first call it asks `home get` once; a
  folder that needs converting refuses every call `Uninitialized` (503)
  until Convert in the setup modal; a read on a missing folder runs
  `home init` first. Presets and simulations go through the same gate.
  The read guard that blocked home setup on Linux is gone (it is this gate).
- §6.2: a docker machine records its socket on its next start only.
- §6.3: runtimes come only from the LayerFS app; the picker lists
  `<home>/runtime`, and "Other build…" takes paths (copied into the home as
  before). No Install-from-build.
- **No rail in the setup modal** (the user, 2026-11-17: "we do not need the
  side bar"): one column, each section's state in words beside its title;
  machine cards refined (mark, name, state tag, role, facts, actions). Spec
  §4.1 updated.
- Build verdicts are computed by the plugin with LayerFS's `matches` rule
  from the same stamps (`--version --json`, `bundle.json` `source.head`/
  `source.dirty`, the daemon's `layerfs-build-identity:<commit>:clean|dirty`
  read from the file), so runtimes whose CLI predates `home get` and a
  candidate daemon at save time get one too. The active bundle verdict comes
  from `home get` when the CLI has it (it resolves `LAYERFS_BUNDLE`, else the
  cache).
- A runtime without its own Linux bundle is judged by the bundle LayerFS
  would use (the cache one); if that is from another build, Done is blocked
  ("From mixed builds"), as the spec's "no `matches: false`" says. Revisit if
  native-only users should pass.
- "Created/Converted just now" shows for 10 minutes after the setup check
  did it.
- Center: while setup misses something required after Later, it is the
  head card's first need (one place), not a second card; with nothing set
  up, the setup card replaces the error box.
- Preset runner/machine-stop messages now name Center → Settings → Change…
  (they named a page that no longer exists); this diverges those copied
  Connect files by one line each.
- `scripts/dev.mjs` gains `DSH_LAYERFS_DEV_NO_RUNTIME=1` (the "no runtime"
  state on a side server).
- LayerFS B/C (made by the B/C agent; see their commit messages):
  `bundle:<dir>` on every worker platform, not only docker on macOS; a bundle
  from another commit is no need, another protocol is. `machine platforms`
  needs no home and makes none. Socket states `absent` (ENOENT/ENOTDIR),
  `denied` (EACCES/EPERM), `silent` (anything else). Source `legacy` keeps
  `/var/run/docker.sock` for a machine that ran before sockets were recorded.
  The socket is pinned before the start once the Engine answers and recorded
  again after the provider starts. `stock` is a reserved `os_image` value.
  Doctor messages add a CLI hint. Spec §2.3/§2.6 updated to what was built.

## Left

- **A2** (§2.7, reads never change the home): needs the LayerFS
  maintainers' agreement.
- **Pushing the LayerFS branch** `claude/home-setup-a1` (A1, B, C and the
  test fix, four commits on `dd4a2cc40f`): needs the user's OK.
- Docker machines converted from 1.1.0 records that already ran but have no
  `lasting` state and no `vm_name` are `legacy` for the socket, yet doctor may
  call them "never started" (B/C agent's note).
- Not verified: `docker_socket_choice` and `host.native_daemon` on Linux
  (type-checked only); no real docker worker start on the Engine (it would
  create a worker container in Docker Desktop); doctor host's
  default-missing / non-executable-default cases have no unit test (the real
  CLI showed default-missing).
- Follow-up (older code, not this task): Center's head line clips a long need
  (a docker socket path) without an ellipsis; Health shows a raw warning code;
  ProjectDialog's `useStorage` machine-progress listener is not coalesced.
- LayerFS follow-up: the MCP server has no schema for the `image` kind
  (`api/mcp/src/tools.js` `COMMON`), so `layerfs-mcp` fails at launch on
  this branch and on its parent.
