# LayerFS setup: home, runtime and machine detection

Status: A1, B, C, H and U built (see `layerfs-setup-handoff.md`); A2 waits for the maintainers. Revised after a four-part review
(CLI conventions, scenarios, UI fit, compatibility). §2 asks LayerFS
(`layerfs_v2_0_0`) for CLI changes; §3–§4 are dsh-layerfs; §6 lists the
decisions still open.

## 1. The problem

- **Nothing sets up the home on purpose.** LayerFS opens (creates or converts)
  the home before every call, reads included (`dispatch.rs` → `migrate::open`,
  layerfs-project#104). The plugin refuses reads while `layerfs.json` is
  missing (`src/host/layerfs/cli.ts`), so on Linux, or on macOS with no daemon,
  the home is never created and every view fails.
- **Builds mix silently.** The CLI, the host daemon, the Linux bundle and the
  Node SDK can come from different commits. Only the CLI carries a commit
  (`layerfs-cli/build.rs`); the bundle has `source.head` but no dirty flag; the
  daemon has neither. The plugin always sets `LAYERFS_BUNDLE`, so LayerFS's own
  folder rules never protect its users.
- **Detection misses what Create and Start need.** `machine platforms` does not
  report a missing bundle, searches only `PATH` (a Dock-started server sees
  Lima, Apple Container and Docker as not installed) and only one Docker socket
  (the recorded one, else `/var/run/docker.sock`), while the Sandbox code path
  follows the Docker context: the two can disagree today.
- **The UI has no first-run state.** With no runtime, Center becomes one red
  error box naming a page that does not exist; the only remedy is typed paths.

## 2. LayerFS CLI changes

Two new calls, additions to `machine platforms` and `machine create`, three
behaviour fixes, two doctor fixes. Nothing is removed. One change (§2.7)
reverses #104 and needs the maintainers' agreement; everything else is
additive and lands without it.

### 2.1 `layerfs home init` (new)

(Superseded for older homes by the 2026-11-19 CUT: `home init` converts
nothing; an older home is `broken` `outdated` and refused with the fix
`mv <home> <home>.old && layerfs home init`.)

Creates an empty home (0700, `layerfs.json`, the built-in host machine (`macos-host` or
`linux-host`) and `docker` records), converts a layout 2 or 1.1.0 home, and finishes an interrupted
conversion (`v2::finish`). A current home is left alone.

```jsonc
{"home":"/Users/me/.layerfs","created":true,"converted":false,"layout":3}
```

Refused (exit 125): inside a worker root (`guest::is_root`) with `InvalidInput`;
a conversion blocked by running Sandboxes with `InUse`, listing them and the
build that started them.

### 2.2 `layerfs home get` (new)

Read-only and cheap: it reads files (no processes, Docker or network) and never
creates, converts or logs, so it can be polled and works on a missing home. It
reports what LayerFS resolved, so no client re-derives the rules.

```jsonc
{
  "home":   {"path":"/Users/me/.layerfs","state":"current","layout":3,"mode":"0700","mode_ok":true},
  "bundle": {"dir":"…/bundle/linux-aarch64","source":"env:LAYERFS_BUNDLE","present":true,
             "commit":"61252791…","dirty":false,"matches":true},
  "daemon": {"path":"…/bin/layerfs-daemon","source":"recorded","commit":"61252791…","matches":true},
  "cache":  {"path":"/Users/me/.cache"},
  "warnings": []
}
```

- `home.state`: `missing` (no `layerfs.json`, folder present or not), `current`,
  `needs_conversion`, `unknown` (unreadable, or a newer layout).
- `mode_ok`: no group or world read or write. Others' execute (o+x) is allowed:
  namespaces Sandboxes add it (`records.rs` `traversable`).
- `bundle.source`: `env:LAYERFS_BUNDLE` or `cache` (`<cache>/layerfs/bundle/<version>/…`).
  `commit` from `bundle.json` `source.head`, `dirty` from `source.dirty` (new,
  written by `tools/linux_bundle.py`).
- `daemon`: macOS only (`null` elsewhere). `commit` from build info stamped into
  `layerfs-daemon` (new, a `build.rs` like the CLI's), never by running it.
- `matches`: equal commit and both clean; `null` when either commit is unknown
  (an unknown is not a mismatch).
- `warnings`: `{code, message}` with the next step in `message`, as refusals do.
  Codes: `HomeMissing`, `HomeNeedsConversion`, `HomeMode`, `BundleMissing`,
  `BundleMismatch`, `DaemonMismatch`. The build's own identity stays in
  `--version --json`.

### 2.3 `machine platforms`

- `missing` gains `bundle:<dir>` for every platform that runs a worker
  (`sqlite: "worker"`: docker on macOS and Linux, Lima, Apple Container) when
  the bundle is absent or has an incompatible protocol; `<dir>` is the folder
  LayerFS would use (`LAYERFS_BUNDLE`, else the cache). A bundle from another commit is not a need: it is the
  `BundleMismatch` warning in `home get` (§2.5).
- `options` entries gain `default` (`cpus` 2, `memory` 4 GiB, `disk` 20 GiB for
  the VMs), so clients stop hard-coding them.
- The docker row gains:
  ```jsonc
  "socket": {"path":"/Users/me/.docker/run/docker.sock","source":"context:desktop-linux",
             "state":"silent"},          // answering | absent | denied | silent
  "candidates": [
    {"path":"/Users/me/.docker/run/docker.sock","host":"unix:///Users/me/.docker/run/docker.sock",
     "source":"context:desktop-linux","usable":true},
    {"path":"/Users/me/.colima/default/docker.sock","host":"unix:///Users/me/.colima/default/docker.sock",
     "source":"context:colima","usable":true},
    {"path":"/var/run/docker.sock","host":"unix:///var/run/docker.sock","source":"default","usable":true}
  ]
  ```
  `host` is the endpoint as Docker writes it; a non-`unix://` one has
  `path: null`, `usable: false`. `socket.source` is `recorded`, `legacy` (a
  machine that ran before sockets were recorded keeps `/var/run/docker.sock`
  until its next start records it), or the automatic choice named as the
  candidates name it. `absent` is ENOENT/ENOTDIR, `denied` EACCES/EPERM,
  `silent` anything else (one ping, 2 s per read and write).
  `denied` (EACCES) gets its own state, so a client offers the docker group fix
  instead of Start. Candidates come from `~/.docker` files (contexts,
  `DOCKER_CONTEXT`), `DOCKER_HOST` and the default; non-unix endpoints are
  listed as not usable, never followed.
- Works without a home (it describes the host and the build); with a home it
  uses the recorded socket.

### 2.4 Behaviour fixes

| Area | Change |
|---|---|
| Tool lookup | `Tools` carries fallback folders after `PATH` (macOS: `/opt/homebrew/bin`, `/usr/local/bin`, `/Applications/Docker.app/Contents/Resources/bin`); provider commands get `PATH` from `Tools.path`; `layerfs-sandbox`'s own docker lookup goes through `tool::find`. Tests can empty the fallbacks |
| Docker socket | Chosen automatically only while the docker machine has never started: `DOCKER_HOST` (`unix://`), else the current context, else `/var/run/docker.sock`. The first start records the chosen socket, so an existing machine never moves to another engine (its data volume and loaded image live in one engine). Both code paths use the same choice |
| `machine update docker --docker ""` | Clears the recorded socket: back to automatic until the next start records one |
| `machine create --os-image stock` | Uses the provider's stock image even when a prepared one exists (today absent means prepared-if-any) |

### 2.5 Bundle and build identity

A Linux bundle from another commit keeps working when its protocol matches
(the normal dev loop rebuilds the CLI, not the slow bundle). So LayerFS
reports a mismatch and does not refuse it: `home get` warns `BundleMismatch`,
and `machine start` events carry the same warning. Refusal stays on protocol,
as today. Clients that must not mix builds (dsh-layerfs, §3) enforce it.
Needs: `source.dirty` in `bundle.json`, a commit stamped into
`layerfs-daemon`.

### 2.6 Doctor

| Check | Change |
|---|---|
| `machine.provider` | A built-in machine never started (provider `missing`, no recorded state) is a warning: "docker was never started; Start creates its worker container". A machine that ran and lost its container stays an error |
| `home.host_daemon` | Checks the recorded daemon, else the default daemon the host machine's launch uses, and its commit (not `<cache>/…/macos-<arch>/layerfs-daemon` alone), reusing the `DaemonMismatch` wording. A missing or non-executable recorded daemon is an error, the default one a warning; "commit unknown or tree dirty" passes as not comparable. Not run on Linux yet |

### 2.7 Reads never change the home (needs agreement)

Calls get a `read` flag in the call table (`layerfs-api/src/calls/table.rs`,
shown in `help --json`). A read on a missing home refuses `Uninitialized`
(exit 125, `detail.missing: ["home:<path>"]`, a new code added to the
refusals table); on a home needing conversion, the same with "`layerfs home
init` converts it". "Change" means create, convert, or finish a conversion; the
call log and `layerfs.lock` are allowed. The guard sits in `migrate::open_from`
after the worker-root check. Calls that write still create a missing home.
`doctor` already skips opening.

Before it lands: both preset runners call `home init` instead of `machine list`
(dsh-layerfs `presets/runner.js`, Connect's copy), the Node SDK test
(`api/node/test/calls.mjs`) and the Rust fixtures that start with `machine
list` call `home init`, and the SDK knows `Uninitialized`.

### 2.8 Not changed (dropped after review)

- `import-env` stays: 1.1.0 homes have no other way in, LayerFS tests and
  messages use it.
- `machine get` and `machine status` stay separate: `get` is a cheap record
  read clients poll, `status` probes the provider (up to 10 s).
- The bundle folder keeps `<version>/`: renaming it moves docs, tools and the
  macOS daemon fallback for little gain; `home get` reports the commit instead.
- No `overrides` list (2.0 ignores the retired 1.x variables such as
  `LAYERFS_DOCKER`; only `import-env` reads them), no `build` block (that is
  `--version --json`), no OS image field in `platforms`, no `bundle-mismatch:`
  need, no `machines` in `home init`.

## 3. dsh-layerfs host

- **Setup check.** `home get` runs at start, after any runtime change, when the
  setup modal opens or Check again is pressed, and on any `Uninitialized`
  refusal; `<home>/runtime` is rescanned each time (and watched), so a runtime
  the app installs later is picked up without a restart. When `home.state` is
  `missing`, run `home init` without asking; `needs_conversion` waits for the
  user (it can lock out older CLIs). A CLI without the `home` family (older
  runtimes; known from discovery) gets today's behaviour: one `machine list`.
- **One build.** The pin is checked whatever its source (config, saved,
  environment, newest in the home), not only on save: a `BundleMismatch` or
  `DaemonMismatch` makes the runtime "from another build". Saving refuses a
  mixed set unless `DSH_LAYERFS_ALLOW_MIXED=1` (development). A runtime folder
  whose bundle is from another build may have it replaced while no worker
  machine runs (`placeBundle` refuses this today).
- **Host daemon.** Re-recorded only when the recorded one is missing or
  unreadable. A mismatch is a warning, not an automatic re-record (two hosts
  sharing a home would flip it). `cleanRuntimes` also keeps a runtime that a
  pin lease names (`<home>/runtime/<id>/pins/<host id>`), so one host never
  removes another's pinned runtime.
- **SDK.** The setup modal shows whether an SDK exists for the build; installing
  one stays `scripts/install-sdk.mjs` from a sealed build (runtime folders hold
  no SDK). It never blocks Done.
- **Errors.** `CliUnavailable` and `Uninitialized` answer 503 and are expected
  (no stack traces). The plugin's own read guard uses `Uninitialized` too.
  Messages name pages that exist.
- **Agents.** Unbound sessions get no LayerFS variables (as today); the skill
  tells agents never to run a bare `layerfs` (the one on `PATH` may be another
  build). No stub.
- **Freshness.** A `setup-changed` event after init, convert, save and runtime
  installs. The platform cache is cleared after machine create, update, remove,
  start, stop and Start Docker. While the setup modal or Settings is visible,
  `home get` is re-read (debounced, page visible). Views use
  `useQuery(load, deps, {refresh, cache})`.
- **Installed runtimes.** A `runtime.installed` op: the home's runtimes, each
  with its version, commit and `home get`'s bundle and daemon verdict (one call
  per CLI, kept by path and modification time).

## 4. UI

Modals over pages, readiness in words inside modals, brand marks once, one
LayerFS sidebar row; status shown once (feedback-layerfs-project-ui).

### 4.1 Set up LayerFS (new modal)

**Opens by itself** at most once per page load, and only when something
required is missing: no runtime, a LayerFS folder made by an older LayerFS, or a
runtime from mixed builds. A wrong folder mode never opens it. Also opened by
Settings (Check setup…) and Health fixes. Later is remembered per viewer
(`localStorage`) and leaves a "Finish setting up LayerFS" card in Center.

**Sections**: one scrolling column (no rail: the user dropped it on
2026-11-17), each section's state in words beside its title. A row says
its own state only when it needs attention (Ready is said once, by the section):

| Section | Content | Actions |
|---|---|---|
| Runtime | One line for the chosen runtime; Change version… opens the shared runtime picker. Its CLI, daemon, bundle and SDK each say Matches, From another build, or Can't tell | Change version…, Other build… |
| LayerFS folder | Path and state: "Created just now", "Made by an older LayerFS" (LayerFS's sentence as the tip), "Other users can read it". Under it a tree: the LayerFS home and the DSH x LayerFS home, named relative to the folder (`home/`, `dsh/`), each with a summary (Stores and machines; project conversations, `sessions.count`), expanding to the folders it holds (`setup.contents`: one listing per folder of a fixed list, `src/shared/folder-parts.ts`; `secret/` is never listed) | Open, Change folder…; on each tree line (on hover or focus) Copy path and Open (`setup.open {which, part}`: the host opens only listed names); Copy LayerFS's fix (`mv <home> <home>.old && layerfs home init`: LayerFS 2.0 converts no older home since the CUT of 2026-11-19, and the page never moves a folder), Copy `chmod` |
| Machines | The host machine (required) and Docker (optional) as two cards: mark, name, state tag, role, facts (OS and architecture; Docker's socket or what blocks it), with readiness from `needs.ts` | Start Docker; Socket… opens docker's socket setting |

No Environment section. Lima and Apple Container are one line pointing to
Machines. **Done** requires: a runtime, the folder `current`, and no `matches:
false` (unknown passes). The SDK and the folder mode are notes.

Names: the section says "LayerFS folder" because the host machine was once called
"LayerFS Home" in the UI; machine rows keep their existing names, and the
platform word comes from LayerFS's `host` (This Mac, This computer).

### 4.2 Runtime picker (shared)

One component for the setup modal and Settings' Change…: the installed
runtimes (`runtime.installed`), each with version, commit and what is wrong
("Linux bundle from another build", "No Linux bundle: only the host machine
can run"); path fields behind Other build….

### 4.3 Changes to existing views

- **Center, nothing set up:** the bar stays; the body is one card instead of
  the red error box.
- **Settings, runtime card:** a summary of `home get`, its warnings, the "Use in
  a terminal" line, Check setup…. The Storage home's embedded runtime card
  links here instead of repeating it.
- **docker's machine page, Settings:** the one place to choose the socket:
  Automatic (naming the one in use) or a candidate from `platforms`; `denied`
  shows the docker group fix. The "Docker isn't answering" message links here.
- **New project, Runs on:** tiles use `machineBlock` (they don't today); the
  default is the host machine when Docker cannot run.
- **Health:** "Not checked yet" before any check; `home get` warnings appear as
  findings with `FindingActions` linking into the setup modal (the only place
  that fixes them); a never-started Docker is a warning with Start.
- **`needs.ts`:** the bundle need says "Fix in setup" (opens the modal) and
  takes the folder from `bundle.dir`, not a hard-coded `bundle/<version>/`.

### 4.4 Lima and Apple Container machines

Optional VMs, added from Machines → Add machine; their life cycle is LayerFS's
(`machine create`, `start`, `stop`, `update`, `remove`).

**Rows** from `machine platforms`: tool and version (`tool:` → Copy install
command), host support (unsupported platforms stay folded under "Not available
on this computer"), bundle (`bundle:` → Fix in setup). Any of these blocks
Create.

**Create, inline in the row:** name; CPUs, memory and disk from `options` with
their `default`; a room line from `machine stats macos-host` and the other VMs'
recorded sizes ("This Mac has 14 CPUs and 36 GB of memory, 304 GB free on the
LayerFS folder's disk; your other VMs are set to 4 CPUs and 8 GB"), where too
much is a warning, not a refusal; OS image left to LayerFS (prepared when there
is one) with "Use stock image" under More (`--os-image stock`). Progress shows
LayerFS's real stages (`bundle-validation`, `provider-and-worker`,
`worker-compatibility`, through `stageWords`), then opens the machine's page.

**The machine's page** (exists): Start, Stop, Resize while stopped, Remove (as
LayerFS allows). A worker from another build keeps today's handling: LayerFS
refuses the call ("another build") and the page offers Restart.

## 5. Order

| Batch | Contents | Lands |
|---|---|---|
| A1 | `home init`, `home get` (§2.1–§2.2), with `source.dirty` and the daemon commit stamp | Now: additive |
| B | `platforms` additions, tool lookup, Docker socket rules, `--docker ""`, `--os-image stock` (§2.3–§2.4) | Now; the socket rule records existing machines' sockets on their next start |
| C | Doctor (§2.6) | Now |
| H | dsh-layerfs host (§3), using A1 and B where present and today's behaviour otherwise | After A1 |
| U | UI: §4.1, Center card and §4.2, then §4.3 and §4.4 | With H |
| A2 | Reads never change the home (§2.7) | After the maintainers agree and the runners, SDK and tests are moved to `home init` |

## 6. Open decisions

1. §2.7 reverses layerfs-project#104: do the LayerFS maintainers agree?
2. Should the Docker socket rule record a socket for docker machines that
   already ran (at `home init` conversion), or only on their next start?
3. Where does a runtime come from on a machine with none: only the LayerFS app,
   or also an Install-from-build action in the setup modal (which could bring
   the SDK too)?
