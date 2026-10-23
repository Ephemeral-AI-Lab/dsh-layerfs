# Windows live verification and CLI launcher

> Status: Dated planning checkpoint; not release evidence or a product contract.

Current verification: all ten scenarios passed on Windows; see the final table.

[Tests tab: all passed](windows-live-20261024/all-passed.png).

## Final Windows result

All ten scripted scenarios passed, with all CLI scenarios enabled. No expected
outcome or exit assertion was removed or relaxed. The independent retained-trace
checks also passed; their separate historical-order/final-tree checks remain
NOT_RUN for the limitations stated below.

| Scenario | Form | Result | Time | Root session |
| --- | --- | --- | --- | --- |
| Tour | sdk | PASS | 0:18 | `session-263d6bfa-0764-4820-9abc-1e27155740a6` |
| Parallel Branches | cli | PASS | 0:07 | `session-84b0dcad-3c98-4a87-aec9-00566fa93898` |
| Conflicts | cli | PASS | 0:12 | `session-c7b56f74-a77f-46ef-8334-058634128ae5` |
| Commit & merge | sdk | PASS | 0:12 | `session-e7095f68-5d0b-477b-900a-aedeacdbc3bf` |
| One Sandbox, two Workspaces | sdk | PASS | 0:15 | `session-1e31d5fd-3bfc-46b1-835b-35fbe66ea3e2` |
| 5 agents | sdk | PASS | 1:41 | `session-74add8ec-c1db-4d2f-ba3c-312b474d1c10` |
| Shop | cli | PASS | 0:55 | `session-6c15f177-7d8a-428d-a215-f6d32b729cdb` |
| Depot | sdk | PASS | 9:13 | `session-8af042b0-00e9-4108-8a1c-2e131a999329` |
| Crew | cli | PASS | 10:19 | `session-5872ec3f-709d-49e6-a9dc-2c53291a31fb` |
| Checkpoints | cli | PASS | 0:13 | `session-6bdb70b8-98e9-4a33-b1f9-748822cc3ac5` |

Exact tags, project names, timestamps and elapsed milliseconds are in
[final-runs.json](windows-live-20261024/final-runs.json). These are observed run
times, not a controlled Windows/macOS performance comparison.

Nine runs used qualified image `sha256:b9eeeaefd7edc6771193b2100f7afd904e4182faad66c776a866b25019082667`.
Depot used its deployment-only proxy derivative
`sha256:2b6690982aed26bebcb004c803db64d8769d5c1d10559d4062046af7a78d5390`.
Both contain the same tools and binaries; the derivative adds proxy environment.
The default profile on port 3080 now uses the latter. The image was changed only
after every run and worker call had finished. Profile backups and the retained
relay lifecycle are documented below. This is per-scenario evidence, not a claim
that every run used one image or started in one uninterrupted Run all batch.

The fixes cover Windows command discovery and restricted-process stdio, Linux
fixture line endings, terminal failure reporting, fresh project ownership,
background readiness, deployment-image selection, runtime tool prerequisites,
and this machine's crates.io proxy route. Failed projects and receipts remain.
The owner subsequently authorized committing and pushing these changes. The
commit preparation checkpoint at the end records the integrated source checks.

## Initial installation and authorized changes

Installation succeeded. The baseline scenario loader rejected Windows backslashes.
After normalizing separators, all ten scenarios loaded. The first live Run all
failed before scenario LayerFS calls: Git Bash could not create its signal pipe
or shared mapping inside dsh's restricted Windows token (Win32 error 5).
The owner subsequently authorized fixes and requested the same `layerfs` command
as macOS. The plugin now installs `layerfs.cmd` on its inherited PATH on Windows.
SDK scenario steps use native Node scripts instead of the failed Git Bash bridge.
No CLI scenarios were disabled, and no scenario expectations were relaxed.
The scripted CLI fixtures now use a native runner. Parallel Branches, Conflicts
and Checkpoints passed live, followed by Shop and Crew after the runtime fix.

`layerfs project list_branches` passed through the real dsh workspace-write
Windows sandbox and authenticated WSL worker against existing `mock-tour`.
The sandbox reports partial enforcement, its existing Windows capability.
No Store mutation was needed for this proof. PowerShell and cmd launcher tests
also passed: spaces, stdin, stderr, exit 125 and missing-project exit 2.

## Identity

- Windows and WSL LayerFS: `3c21c62c6edf800d3aabb8ecd83620a75ecf7084`.
- Live-tested plugin base: `56fc353f45960dd3f1e502d06c9838602da2a466`, plus the fixes in this record.
- dsh: `0.2.1-rc.2`, commit `687f282e8625c6b8d11ff58211a90524be2e4317`.
- Windows Node: v24.11.1; pnpm 10.32.1. WSL Node: `/usr/local/bin/node`, v22.22.1.
- Ubuntu WSL2, kernel `6.6.87.2-microsoft-standard-WSL2`; Python 3.14.4; `/dev/fuse` present.
- Docker Engine 29.9.2 inside Ubuntu; Unix socket, local ext4 `/dev/sdd`.
- Initial image: `sha256:9781a93410ef8f32b0b4ceaa99bd9ff33b731958d2a0aee4a7e2fe7717877863`.
- Bundle: `/home/yifan/.cache/layerfs-worktrees/layerfs-428-verification-c2c22458d2d3/artifacts/build-linux-e068b8575eaf4c4cb34dde4d356ca072`.
- Manifest SHA256: `dc2321dabc605b81dbd4974cf868658eeba0e8db311cf2c4c082276478ccebf5`.
- `core.autocrlf=true`; worker accepted Windows SDK against the sealed bundle.
- Default web profile, no DSH_HOME override, port 3080. Linux home `/var/lib/dsh-layerfs-windows/default`.

## Installation and checks

Exact commands, working directories, environment overrides, wall timeouts,
elapsed times and exit outcomes are in [commands-all.md](windows-live-20261024/commands-all.md).
The earlier [commands.md](windows-live-20261024/commands.md) retains baseline evidence.

1. WSL2, FUSE, native Docker, Linux Node and Python: PASS.
2. Independent Linux checkout at exact pin on Linux filesystem: PASS.
3. Runtime image: PASS; Docker free space roughly 930 GiB before build.
4. Worktree register, prepare, Linux release build: PASS. Build 100.391 s within 110 s bound; required daemon, addon and worker/server.js present.
5. Windows checkout and both npm link installs: PASS.
6. Plugin install, build, check:layerfs at pinned commit: PASS.
7. Baseline test:windows and pnpm test: FAIL at platform-specific PATH test.
   After the launcher fix the Host PATH checks pass, but the full Host test fails
   later at host.mjs:574: fixture expects Windows home, implementation selects WSL home.
   Proposed fix: make that deployment assertion platform-aware, retaining actual WSL-home validation.
8. Profile backup: `C:/Users/yifan/.dsh/profile-backups/layerfs-428-20261024-0521`.
   CLI plugin-add: FAIL resolving pre-existing dsh-loop registry metadata.
   README manual profile/link installation: PASS; existing patches preserved.
9. Web and GET /layerfs/status: PASS, missing []. Restarted only owned instance
   after confirming zero running scenarios and zero runtime calls. Current launcher PID 19788.
10. Docker and worker ready: PASS; host about 491 GB free, Docker about 999 GB.
    No manual Start action required. UI's misleading "older build" text compares
    build to absent expected field; proposed fix is to require expected before comparison.
11. Initial Run all: FAIL all ten at shell startup; original failed projects retained.
12. Latest recorded failed sessions: checker attempted once each, FAIL (no scenario traces).

## Scenario evidence

The table retains the latest rows observed before loading the native launcher.
Tour had a later failed invocation while the intermediate Git Bash runner was
being replaced: MODULE_NOT_FOUND. Its original Run all also failed at Git Bash
startup. This is an intermediate edit failure, not evidence against the worker.
No full suite rerun was performed after the native launcher change.

| Scenario | Form | Latest recorded result | Time | Reason |
|---|---|---|---:|---|
| tour | sdk | FAIL | 0.711 s | root: agents.root[0] (Fork feature-home from main) expected branch.fork:Forked; its LayerFS calls show nothing, so root stops here: ode:internal/modules/cjs/loader:1227:37)      at TracingChannel.traceSync (node:diagnostics_channel:328:14)      at wrapModuleLoad (node:internal/modules/cjs/loader:245:24)      at Module.executeUserEntryPoint [as runMain] (node:internal/modules/run_main:154:5)      at node:internal/main/run_main_module:33:47 {    code: 'MODULE_NOT_FOUND',    requireStack: []  }    Node.js v24.11.1  [exit code: 1] |
| parallel | cli | FAIL | 1.391 s | footer: agents.footer[0] (Fork footer, write and test it) expected branch.fork:Forked, fs.write:Committed, sandbox.create:ok, workspace.mount:Mounted, workspace.exec:exit:0, workspace.unmount:Unmounted, sandbox.close:Closed, branch.list_commits:ok; its LayerFS calls show nothing, so footer stops here: [stderr]       0 [main] bash (5912) E:\Git\bin\..\usr\bin\bash.exe: *** fatal error - CreateFileMapping S-1-5-21-137653902-1729454338-2926228789-1001.1, Win32 error 5.  Terminating. [exit code: 3221225794] |
| conflicts | cli | FAIL | 0.881 s | root: agents.root[0] (Fork feature) expected branch.fork:Forked; its LayerFS calls show nothing, so root stops here: [stderr]       0 [main] bash (37556) E:\Git\bin\..\usr\bin\bash.exe: *** fatal error - couldn't create signal pipe, Win32 error 5 [exit code: 3221225794] |
| merge | sdk | FAIL | 0.919 s | root: agents.root[0] (Fork feature from main) expected branch.fork:Forked; its LayerFS calls show nothing, so root stops here: [stderr]       0 [main] bash (11648) E:\Git\bin\..\usr\bin\bash.exe: *** fatal error - CreateFileMapping S-1-5-21-137653902-1729454338-2926228789-1001.1, Win32 error 5.  Terminating. [exit code: 3221225794] |
| sandbox | sdk | FAIL | 0.852 s | root: agents.root[0] (Fork docs and site; mount both in one new Sandbox) expected branch.fork:Forked, branch.fork:Forked, sandbox.create:ok, workspace.mount:Mounted, workspace.mount:Mounted, workspace.exec:exit:0, workspace.exec:exit:0, workspace.exec:exit:0; its LayerFS calls show nothing, so root stops here: [stderr]       0 [main] bash (40028) E:\Git\bin\..\usr\bin\bash.exe: *** fatal error - couldn't create signal pipe, Win32 error 5 [exit code: 3221225794] |
| agents | sdk | FAIL | 0.864 s | root: agents.root[0] (fork checkout) expected branch.fork:Forked; its LayerFS calls show nothing, so root stops here: [stderr]       0 [main] bash (10584) E:\Git\bin\..\usr\bin\bash.exe: *** fatal error - couldn't create signal pipe, Win32 error 5 [exit code: 3221225794] |
| shop | cli | FAIL | 0.855 s | root: agents.root[0] (M1: initialize project and skeleton) expected branch.fork:Forked, fs.apply:Committed; its LayerFS calls show nothing, so root stops here: [stderr]       0 [main] bash (39476) E:\Git\bin\..\usr\bin\bash.exe: *** fatal error - couldn't create signal pipe, Win32 error 5 [exit code: 3221225794] |
| depot | sdk | FAIL | 0.856 s | root: agents.root[0] (M1: scaffold frozen four-package workspace, health and CLI) expected branch.fork:Forked, fs.apply:Committed; its LayerFS calls show nothing, so root stops here: [stderr]       0 [main] bash (46816) E:\Git\bin\..\usr\bin\bash.exe: *** fatal error - couldn't create signal pipe, Win32 error 5 [exit code: 3221225794] |
| crew | cli | FAIL | 0.936 s | root: agents.root[0] (L0: fork shared skeleton) expected branch.fork:Forked; its LayerFS calls show nothing, so root stops here: [stderr]       0 [main] bash (39792) E:\Git\bin\..\usr\bin\bash.exe: *** fatal error - couldn't create signal pipe, Win32 error 5 [exit code: 3221225794] |
| checkpoints | cli | FAIL | 1.057 s | a01: agents.a01[0] (a01: range 1 on lane r1-a01) expected branch.fork:Forked, fs.mkdir:Committed, fs.write:Committed, fs.write:Committed; its LayerFS calls show nothing, so a01 stops here: [stderr]       0 [main] bash (43904) E:\Git\bin\..\usr\bin\bash.exe: *** fatal error - couldn't create signal pipe, Win32 error 5 [exit code: 3221225794] |

## Remaining verification and limitations

- The Windows scripted runner supports the notation used by shipped scenarios,
  not arbitrary Bash programs. Ordinary Windows agents use PowerShell syntax.
- All ten scenarios passed live on the final product source. Depot additionally
  uses the local proxy-enabled deployment image documented below.
- Recorded final-tree byte/hash and historical order comparisons are NOT_RUN by
  tools/checks/run.mjs; its public read-only route lacks those capabilities.
  Scripted step outcomes and each scenario's own acceptance commands are checked.
- macOS/Linux live scenarios, desktop and headless profiles were not rerun.
- This local deployment needs the retained bridge relay and existing proxy for
  crates.io; the final relay uses a persistent WSL source and Docker restart
  policy `unless-stopped`. WSL, Docker and the upstream proxy still must start.
- SDK loader tests preserve POSIX checks in Linux; Windows mode/symlink seed
  checks are NOT_RUN because Windows does not implement those POSIX operations.
- The failed uncommitted Git Bash bridge test was replaced with native Node
  launcher coverage. Its earlier outside-sandbox pass did not qualify it inside dsh.
- Existing unrelated dsh-sessions resolution and dsh-loop compatibility warnings remain.
- Durable: NOT_RUN — disabled by owner until explicit reauthorization.
- No commit, push, system-wide install or deletion of unrelated Docker resources.

The CLI launcher is scoped to dsh's child environment, not a system-wide command
installation. Ordinary terminals outside dsh do not gain this PATH entry.
Shell quoting follows the selected shell; identical CLI arguments do not imply
identical Bash and PowerShell programs.

## Production source comparison

Production LOC: **7,944 -> 8,214 (delta +270)**, plugin scope including the earlier
scenario loader/native SDK launcher changes. Exact parent and private-index
candidate tree identities are in [candidate-loc.json](windows-live-20261024/candidate-loc.json).
Reproduce with `python docs/windows-live-20261024/count-loc.py <repo> <tree> <pinned-layerfs>/tools/production_loc.py`.
The pinned scanner blob is `caf176ba66d0fc8978772a7d0c809be365c5294d`.
The original `loc.json` retains the earlier docs-only proposal, not this candidate.
No real index staging or commit was performed. A future commit must count its final
staged tree again if the product source changes. LayerFS core is unchanged;
reference absent (retired R9c; last counted 65,417 at tree 498dd1917812).

## Follow-up: apparent slowness, 05:50–05:52 local

Read-only inspection; no restart, replay, project deletion or cancellation.
Eight rows still showed the earlier Git Bash failures. Two newer runs were
Tour `session-587866db-eb37-4e08-b554-7e1050b40360` and Parallel
`session-a2636349-6a37-4798-886e-8c677b93e008`.

Tour failed after 5.277 seconds at Build. Its fixture's install.sh and build.sh
contain CRLF on Windows; Linux sh rejects `set -e\r` as an illegal option.
The four demo-workspace shell files have 20, 7, 25 and 13 CRLF lines respectively
(build, install, serve, test). Proposed fix: repository LF attributes for Linux
shell fixtures, normalize the checked-out fixture bytes, then verify on a fresh
project without altering this failed project's evidence.

Parallel's header and footer children ended with `MOCK_FAILED: Windows scenarios
support SDK Node scripts only`, at 05:49:57.333 and 05:49:57.461. The root consumed
both failure notices but replied "Still waiting for header and footer" and ended
its turn at 05:49:57.637. The scenario row incorrectly remains running at 3/14.
The native SDK launcher introduced this explicit rejection for CLI fixtures;
adapter.js catches it without recording a terminal Progress failure. Proposed
fix: finish progress on adapter errors and propagate child failures, alongside
the still-required Windows CLI fixture execution path. This is a false running
state, not a long-running Store operation.

Tour's retained trace shows branch.fork 1.597 ms, fs.edit 8.921 ms, fs.mkdir
6.075 ms, fs.write 5.390 ms, workspace.mount 16.386 ms, sandbox.create 948.229 ms
and sandbox.close 732.535 ms. The worker was answering with zero active calls,
zero Sandboxes and zero Workspaces. These are diagnostic traced observations,
not a Windows/macOS benchmark or cold-cache performance claim.

## Fix checkpoint, 06:10 local

Owner authorized fixes and subagent collaboration after the initial install-only
run. CLI scenarios remain enabled. Windows native CLI shim, native scripted
SDK/CLI launchers, literal heredoc/large argument transport and file-backed
CLI stdio replace the blocked Git Bash/named-pipe paths. LF attributes protect
Linux fixtures with autocrlf enabled. Progress now records adapter/child failures;
new runs own unique projects and old session views cannot show replacement runs.

The dedicated scenarios preset disables foreground timeout promotion. Commands
have a 120-second dsh deadline and a best-effort 110-second watchdog. The earlier
confined watchdog test FAILED: taskkill was denied by the restricted token.
The separate dsh-managed deadline proof PASS killed both parent and descendant
at a 2-second diagnostic deadline. This does not claim arbitrary background
processes are covered by the foreground deadline.

Checks: pnpm test PASS (6.157 s, integrated-plugin-tests-01); final test:scenarios
PASS (3.703 s); test:windows PASS (3.750 s); pinned LayerFS check PASS (0.328 s).
Every command had an explicit 120-second outer cap. Exact commands and evidence
are the corresponding JSON/log files in windows-live-20261024. Restricted-shell
real CLI/worker read proof PASS (0.859 s), including captured command output.

At 06:09, no scenario runs or worker calls were active, so the owned dsh server
was restarted with the final fixes. Run all was pressed once at
2026-10-23T22:10:27.402Z (06:10 local). Final scenario results pending.

## Scenario/runtime diagnosis, 06:12?06:16 local

Seven scenarios passed with native Windows launchers: Tour, Parallel Branches,
Conflicts, Commit & merge, One Sandbox/two Workspaces, 5 agents, Checkpoints.
The pre-runtime-change snapshot records all latest identities and elapsed times.
Some owner-triggered runs replaced earlier rows; earlier traces remain untouched.
The 5 agents retained completed run d08ca6fb passed all 59 traced bash-step checks.

Shop, Depot and Crew failed sandbox.create because their scenarios explicitly
named the macOS machine's image sha256:091f785ba7d5d036dfa350e8fd69ee1fcd2d8320c3706841c8c95e6411eee9d2.
Docker answered404 in WSL. They now inherit the deployed Host image through
the SDK default; the converter preserves this on regeneration. Isolated
regeneration of all three from historical source3690e8bd54e27feb7ae505b363acd94228799c7a
matched the corrected scenarios exactly. Original failures and check output remain.

One background Sandbox run also failed a real readiness race: unmount started
at22:10:27.902Z, before process.start returned at22:10:27.904Z. Dirty was correct.
A subsequent unchanged run happened to pass; that does not qualify the race.
The changed scenario now waits for an explicit ready marker while the background
build holds an open file, assertsBusy once, then releases it. Both waits are bounded.
The changed readiness scenario still needs live qualification.

The documented runtime was Node-only. Depot additionally needs Rust1.85.1,
SQLiteheaders/pkg-config and Chromium/driver/Selenium. The image is being extended
inside WSL Docker. Its first capability check exposed missing rustfmt; that
failed receipt is retained and a corrected image is being built.

### Pre-runtime-change latest rows

| Scenario | Form | Result | Seconds |
| --- | --- | --- | ---: |
| tour | sdk | PASSED | 18.050 |
| parallel | cli | PASSED | 8.288 |
| conflicts | cli | PASSED | 12.456 |
| merge | sdk | PASSED | 12.781 |
| sandbox | sdk | PASSED | 14.496 |
| agents | sdk | PASSED | 101.951 |
| shop | cli | FAILED | 1.945 |
| depot | sdk | FAILED | 1.689 |
| crew | cli | FAILED | 3.432 |
| checkpoints | cli | PASSED | 12.971 |

The three failures are sandbox.create with a missing machine-local image.
These remain historical results, not passes inferred from a code change.

## Qualified runtime checkpoint

New image: `sha256:b9eeeaefd7edc6771193b2100f7afd904e4182faad66c776a866b25019082667`.
Build06 PASS 79.250 s (timeout110 inside outer120). Capability02 PASS 2.875 s:
Rust/Cargo 1.85.1 with scenario-specific CARGO_HOME; rustfmt1.8.0, Clippy0.1.85,
SQLite 3.40.1, Python 3.11.2, Chromium/driver156.0.8078.47, and a real Selenium
headless page/title assertion. Docker free925GiB. No host software installed.

Build01 succeeded but capability01 failed missing rustfmt. Build02 was cancelled
after Rustup's download stalled and attempted an internal retry; subsequent
builds set RUSTUP_MAX_RETRIES=0. Builds03?05 were cancelled during slow Debian
HTTP-proxy downloads. Build06 used host networking and HTTPS proxy build-argument
names only; Debian HTTP stayed direct. Exact bounded commands/results are retained.
No unsuccessful image was installed into the profile.

Before replacing the image, profile cordis.patch.yml and package.json were copied
to `~/.dsh/profile-backups/layerfs-428-runtime-20261024-0621`. Existing entries
were retained. With zero live scenarios and worker calls, the owned server was
restarted on 3080. All10 will be verified against this changed image; earlier
passes remain separate evidence.

## Network qualification checkpoint

The qualified image allowed Shop to pass and Crew to progress. Depot's first
real fetch then failed with Cargo exit 101: index.crates.io/config.json timed out
after 30 seconds; the failed project and traced checker output remain.
The machine's existing proxy listens on loopback, which ordinary Docker bridge
containers cannot reach. The pinned public API has no Sandbox proxy/environment
configuration port.

A local deployment-only relay binds172.17.0.1:15237 (Docker bridge only), forwards
to the existing loopback proxy127.0.0.1:15236, and runs as the owned read-only
container `layerfs-428-proxy-20261024` with all capabilities dropped.
Derived image `sha256:2b6690982aed26bebcb004c803db64d8769d5c1d10559d4062046af7a78d5390`
adds only HTTPS proxy and localhost bypass environment to the qualified image.
A bridge-container GET of the actual crates.io config passed in 1.985 s.
No dependency/source substitution, offline stand-in or scenario assertion change.
Exact startup, cleanup, identities and local prerequisites are in
[deployment/README.md](windows-live-20261024/deployment/README.md).

This is this machine's network configuration, not a portable hardcoded product
proxy. The relay remains running and depends on the existing local proxy; its
restart policy is no. The final report must identify this prerequisite.

The background readiness fix passed live in 14.679 s. Its independent trace check
matched all four bash steps, including the background step (sandbox-handshake-live-check).

## Final handoff state

Default web profile remains on 3080 with the proxy-derived runtime image. The
worker is answering, missing settings are empty, and there are zero active calls.
Host free space 481.58 GB; Docker free 992.40 GB. Two Sandboxes/three Workspaces
remain from retained failed runs; they were not deleted to make the view clean.
The task-owned proxy relay remains running and its lifecycle is documented.
Pinned Windows LayerFS and deepseek-harness checkouts are clean at their stated
commits; no LayerFS product or dsh product code was edited.

Nine final trace checks are in qualified-live-check-*.json/log; the Sandbox
handshake check is sandbox-handshake-live-check.json/log. Every invocation had
a 120-second wall cap and passed. Depot matched all 97 bash-step expectations.
Web startup URL credentials are redacted in the shareable evidence logs.

No commit, push or real-index staging. Production LOC 7944 -> 8214 (delta +270),
counted from the exact parent/private-index candidate with the pinned scanner.
A future commit must count its final staged tree, including any later changes.


## Commit preparation (owner authorized commit and push)

Remote main advanced to `6e1f2c13ecdf5c4bb92a091738583b1826cb411c` while this
verification was in progress. Fast-forwarded the local branch to preserve that
Workspace live-exec display change; no conflicts or discarded work. The earlier
live receipts remain attributed to their original source checkpoint.

At the integrated source, the combined command `pnpm test && pnpm run
test:windows && pnpm run test:scenarios && pnpm build && pnpm run check:layerfs`
passed in 15.906 seconds under one explicit 120-second wall deadline. See
[integrated receipt](windows-live-20261024/integrated-remote-main-tests-01.json)
and its adjacent log. This checks the new upstream trace/playback behavior too.
No server restart or scenario replay was used for these source checks.

Production LOC: 7971 -> 8241 (delta +270), compared to the integrated first
parent above. Method: the retained `count-loc.py` reads exact Git blobs and uses
LayerFS's `blank_js` scanner (counter blob
`caf176ba66d0fc8978772a7d0c809be365c5294d`), counting product package JS/TS/TSX,
shipped YAML/locales and shell/cmd launchers. Tests, fixtures, scenarios, tools,
docs, manifests and generated output are excluded. The commit message records
the final staged tree; counts are checked again against the resulting commit.
The earlier 7944 -> 8214 candidate comparison remains historical evidence.

No tracked test was deleted. POSIX seed mode/symlink assertions remain on POSIX
and are explicitly NOT_RUN on Windows. The abandoned uncommitted Git Bash
bridge test is replaced by native Windows coverage. Existing scenario expected
outcomes and exit assertions remain intact. Raw command receipts preserve their
original whitespace; the source/documentation diff outside receipts passes
`git diff --cached --check`. Host headroom at preparation: 480.68 GB free.


The Tests tab at the pre-commit checkpoint again showed all ten rows PASS, with
zero active worker calls. This was an already-running batch observed without
pressing Run again; [precommit-live-runs.json](windows-live-20261024/precommit-live-runs.json)
preserves its distinct session IDs and times, including Depot and Crew. These
additional observations do not replace the earlier qualified receipts or claim
that the running server loaded the newly integrated upstream source.

After the idle check, the deployment relay was moved off temporary storage to
`/home/yifan/.local/share/dsh-layerfs-proxy/relay.mjs` and recreated with Docker
`--restart unless-stopped`. The original task-owned container remains stopped
under a historical name. Container restart and one fresh-container crates.io GET
passed, with explicit 15/20-second limits (25-second outer subprocess limits).
See [the final deployment receipt](windows-live-20261024/deployment/persistent-relay.json).
No dsh restart was needed. Full Windows/WSL reboot remains NOT_RUN; this machine
still needs its existing upstream proxy, WSL and Docker running.
