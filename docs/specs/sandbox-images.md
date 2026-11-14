# Sandbox images: pick an image, press Create

Status (2026-11-14): Stage 0 and Stage 1 are implemented, and the terminal pass condition (§6.1)
passed on 3080.
- **LayerFS:** R0–R5 and the runtime layer's written source offer are merged into `layerfs_v2_0_0`
  as `8cfb6e2734` ([layerfs#682](https://github.com/Ephemeral-AI-Lab/layerfs/pull/682)). 3080 runs
  its release build (`~/.layerfs/runtime/2.0.0-06d4e17044f2`, built from `0c18d49a72`, the same tree),
  so it tracks the tip of `layerfs_v2_0_0` again. Each machine needs one stop and start after a
  bundle change.
- **Licences (decided: keep the Debian binaries, offer source):** the bundle's `licenses/` holds each
  package's copyright file and `SOURCES`, a written offer naming every runtime file's Debian source
  package and version (bash, busybox, gcc-12, glibc, openssl); `bundle.json` lists them in
  `sandbox_runtime.sources`, and `linux_bundle.py sources` downloads exactly those sources (146 MB)
  from snapshot.debian.org to publish beside a release.
- **Plugin:** all of §4 and §5, except that the Docker candidates come from LayerFS's
  `machine images` (`available`, `docker`) rather than from the plugin (D3 now lives in LayerFS).
- **Checked:**
  - docker: `postgres:17-bookworm` and `alpine` run from Docker names, and a second create copies
    nothing.
  - Lima: `machine load` and `machine images`; Sandboxes from loaded images run commands.
  - UI: both groups, copy progress, the Images section and Free space, on 3080's `docker` and
    `demo-build` machines.

Implementation notes (where the build differs from the text below):
- With `start: true` a Stage-0 job runs `queued → machine → queued → done`.
- R6 (image ENV/PATH) and DNS inside Sandboxes (binding the worker's `resolv.conf`) are not done.
- Every machine's worker must be stopped and started once after a bundle change ("another build").
- LayerFS removed `--image-archive` (spec Q5 settled as "remove").

## 1. Goal

Choosing a Sandbox's image is one menu in New Sandbox and nothing else.

- **docker machine:** any local Docker image on this host can be picked.
- **VM machines** (Lima, apple-container): the same menu. A picked image is copied into LayerFS on
  that machine once and reused by every later Sandbox.
- **macOS native:** no image; Sandboxes run on the Mac itself.
- **Hidden from the user:** archives, digests, file paths, VM restarts and "prepare" steps.
- **No image-build API.** Building images is Docker's job (`docker build`). LayerFS copies and caches
  images; the plugin lists them and passes a name.

```text
 Mac                                               machine (docker, Lima, apple-container)
 New Sandbox: Image [ postgres:17-bookworm v ]  →  plugin  →  layerfs sandbox create … --image postgres:17-bookworm
   layerfs CLI: docker image inspect → Id, arch ✓
                machine has Id? ── yes ─────────────────────────────→ start Sandbox
                └ no → docker create + export (flat tar) → send in 1 MiB frames → unpack once → start Sandbox
 Sandbox row: Starting machine → Copying image 148 of 412 MB → Starting Sandbox
```

## 2. Decisions

The three parts below were drafted separately against one contract. These rulings settle every
point where they differed, and they override any part text that disagrees.

| # | Question | Decision |
|---|---|---|
| D1 | Image identity | LayerFS keys a cached image by the **Docker image Id** (with Docker's containerd store that is the manifest/index digest, not the config digest). Bundle and VM-archive images keep their config digest. `machine.images` rows carry `id` and `refs`; the plugin's `docker image ls` reads the same Ids, so the two groups merge exactly by `id`, then by ref. |
| D2 | What is sent | A flat rootfs tar from `docker export`, minus the init-layer files `docker create` adds (`.dockerenv`, empty `etc/hosts`, `etc/hostname`, `etc/resolv.conf`, `etc/mtab`, `dev/*`), plus the inspected config. Not a synthesized docker-archive. |
| D3 | Which Docker | The `docker` built-in machine's recorded socket (`machine update docker --docker`) for every target machine. The plugin lists images through the same socket. VM machines have no Docker setting. |
| D4 | Where images live | Only on each machine: unpacked once under its worker root (`/layerfs/data/machines/native/run/images/<hex>.2/` plus a `.json` sidecar); the staged tar is deleted after unpack. The host keeps nothing; Docker is the source. A host store (`LAYERFS_HOME/images/`) for images that don't come from Docker is later. |
| D5 | Starting a stopped machine | The plugin does it, on the user's explicit "Start and create": the create route with `start: true` runs `machine start --progress`, then `sandbox create`. LayerFS keeps "never start a machine on demand" (its #535 decision D11), so it never emits a `machine` phase; the plugin does. Works in Stage 0. |
| D6 | Image for project sessions and agents | When a caller names no image, LayerFS's own default rule picks it. The plugin's per-VM default (`defaults.tsv`, the `--image` injection in `execute()` and in both agent wrappers) is deleted. |
| D7 | Menu preselection | The ready image with the newest `last_used` (which R1 asks LayerFS to record on every create; Stage 0 has none), else the machine's default, else the first usable ready image. Never a Docker row unless picked. No plugin state. The client always sends the picked row's `id`. |
| D8 | Disk precheck | `need = 2 × size × 1.05` (tar staged, then unpacked). The plugin computes `fits` for the button label; LayerFS's `NoSpace {need, free}` refusal is the real answer. |
| D9 | Cleanup | Manual only: the machine's Images section (Remove on unused) and Free space. No automatic eviction is requested; the UI does not promise one. |
| D10 | Creation jobs | Host-kept, in memory: `GET /api/sandbox-creates` lists running and failed creations (failed ones for 10 min); `DELETE /api/sandbox-creates/:id` dismisses. Retry re-sends the job's input to the create route. Closing the dialog cancels nothing. |
| D11 | Stage gate | Stage 1 turns on only when discovery shows `machine.images`, `machine.load`, `machine.prune`, `sandbox.create --image` declared with the new option kind `image`, and the identity feature `sandbox-runtime`. Never by version. Without the runtime layer most real images fail, so the Docker group stays hidden. |
| D12 | Image settings | Stage 2: ENV and PATH from the image config apply to exec. WORKDIR (exec always runs in the Workspace) and USER (unpack makes files root-owned) are not applied. |
| D13 | Machine field | None. Both New Sandbox entry points fix the machine. |
| D14 | Free space from New Sandbox | A modal stacked on New Sandbox, so the form is kept. |
| D15 | Answer shape | The one `GET /api/machines/:id/sandbox-images` answer in §4.1 serves the menu, the Images section and Free space. |

**How to read §3–§5.**

§3 is the change request to LayerFS, §4 the plugin host, §5 the plugin UI. Each was checked
against the code: LayerFS at `origin/layerfs_v2_0_0` `c5e58735bb` and `feat/sandbox-image-artifacts`
`970dac8a70`; dsh-layerfs at this checkout.

## 3. LayerFS change request

This part lists what LayerFS has to change for "pick an image, press Create" to work. dsh-layerfs does not change LayerFS (AGENTS.md); the user decides whether to make these changes. Line numbers refer to `origin/layerfs_v2_0_0` at `c5e58735bb`. "Feature branch" means `feat/sandbox-image-artifacts` at `970dac8a70` (4 commits ahead, 94 behind).

### 3.1 Summary

| # | Change | Why | What breaks without it |
|---|---|---|---|
| R0 | `choose()` refuses an image it cannot use | Today a reference such as `postgres:17` is silently replaced by the bundle image | A user picks Postgres and gets a Sandbox running the default image, with no error |
| R1 | `sandbox create --image <ref\|Id\|digest> [--progress]` resolves the image from host Docker and copies it to the machine | The "From Docker on this Mac" group | Only images already in the bundle or VM archive can be used |
| R2 | `machine images <name>` | The "ready" group, the Images section, `free` for the NoSpace check | The plugin cannot show what is cached or how many Sandboxes use each image |
| R3 | `machine load <name> <image> [--progress]` | Retry, warm-up, and copying without creating a Sandbox | A failed create cannot be retried without also creating a Sandbox |
| R4 | `machine prune <name> [<image>] [--unused]` | Cached images are large and live on the machine's data disk | The data disk fills up and there is no supported way to free it |
| R5 | Sandbox runtime layer in the bundle | The daemon runs inside the image root and needs glibc 2.34 or newer, libssl3 and bash | alpine (musl), distroless, Debian bullseye and Ubuntu 20.04 (glibc 2.31) and shell-less images fail at start or at the first exec |
| R6 | Apply image ENV and PATH to exec | `golang`, `node` and `python` images put their tools on PATH through ENV | `go version` fails in a `golang` image (Stage 2) |

### 3.2 Per change

#### R1 `sandbox create`: resolve, copy, unpack

**Surface.** `layerfs sandbox create <project> <name> [<machine>] [--image <image>] [--progress]`, SDK `sandbox.create { image }`. `<image>` can be a `sha256:<64 hex>` digest or Docker Id, or a Docker reference.

Resolution order:
1. If the machine's cache holds that Id, use it. Docker is not needed.
2. If `docker image inspect <image>` answers, use the `.Id` it returns.
3. If Docker is unreachable, use the cache entry whose `refs` contains the reference.
4. Otherwise refuse: `Unavailable` with `detail: {what: 'docker'}` when Docker was unreachable,
   `InvalidInput` when Docker answered that no such image exists.

Every refusal carries a machine-readable `detail`:
- `Unsupported` with `detail: {reason: 'arch', value: <image arch>}` when the image's `.Architecture`/`.Variant` does not match the machine bundle's `linux-<arch>`, or `detail: {reason: 'host'}` on macOS native.
- `Unavailable` with `detail: {what: 'machine'}` when the machine is stopped.

Records: the Sandbox record stores the resolved image `id` (also when no `--image` was given and
the machine default was used), and every create sets the image sidecar's `last_used`. Bundle and
VM-archive images get a sidecar the first time they are unpacked. `machine images` (R2) counts
Sandboxes from that recorded `id`, and prune (R4) agrees with it, so the default image never
shows "Unused" while prune refuses it.
- `NoSpace {need, free}` when `need` is more than `free`, where `need = 2 × .Size × 1.05` (the tar is staged, then unpacked, then deleted).

`--progress` events are `{phase:'inspect'|'export'|'send'|'unpack'|'start', done?, total?}`. The feature branch emits `image-hash`, `image-validation`, `image-transfer` and `image-verification` today; rename them to these.

**Docker socket.** VM machine records have no Docker socket. The host uses the `docker` built-in machine's recorded socket (`machine update docker --docker`), the same `docker -H unix://…` path as `platforms/docker/cli.rs:10-15`, whatever machine the image is going to.

**Export with a stable key.** `docker export` output differs between runs, because `docker create` writes a new init layer each time (`.dockerenv`, empty `etc/hosts`, `etc/hostname`, `etc/resolv.conf`, `etc/mtab`, `dev/*`). Hashing the export, or a 1-layer docker-archive wrapped around it, therefore gives a different digest every time. Key the cache by the Docker image Id instead. With the containerd image store that Id is the manifest or index digest, not the config digest (`platforms/docker/images.rs:1-2`). Keying by Id is still correct, because Ids and config digests never collide.

I recommend sending a flat rootfs tar plus the inspected config JSON (`Env`, `WorkingDir`, `User`, `Architecture`, `RepoTags`), not a synthesized docker-archive. A wrapper adds a `diff_ids` hash and a config digest that nothing can reuse. The host-side converter drops the init-layer entries listed above and any device or FIFO entry, which the unpacker refuses (`rootfs/mod.rs:67-80`).

The host names the temporary container `layerfs-export-<idhex>` and keeps it until the worker publishes the image, so a retry re-exports identical bytes. A leftover `layerfs-export-*` container is removed by the next load.

**Code to change:**
- `control/crates/layerfs-sandbox/src/deploy.rs:42-60` (`choose`). It receives an already-resolved Id.
- `route.rs:285` replaces the feature branch's `image_archive` hook (`route.rs` +288-297, +351-360) with the export-and-send step, for both `Executor::Local` (`:287`) and `Executor::Worker` (`:328`).
- Rework `image_artifact.rs` from the feature branch:
  - Keep its 1 MiB frames and its `probe`/`write`/`publish`/`discard` steps.
  - Change `key` from the whole-file sha256 to the image Id hex.
  - Make `publish` unpack and delete the tar, instead of keeping `<root>/image/<sha>.tar` forever.
- `rootfs/cache.rs:30` (`ensure`) gains a variant that unpacks a flat tar. The name stays `<hex>.2`.
- Each image directory gets a sidecar `<hex>.2.json` beside it: `{id, refs[], size, architecture, source, config, last_used}`. `ensure` already makes the image directory 0555, so the sidecar cannot go inside it.
- The worker dispatch at `worker_server.rs:258` stays. The feature branch's `"image.artifact"` arm is reused.

**Storage on the worker.** The worker root is `/layerfs/data` (`api/crates/layerfs-cli/src/worker.rs:14`):

| Path | Content |
|---|---|
| `/layerfs/data/machines/native/run/images/<hex>.2/` | Unpacked image (overlay lower, read-only) |
| `/layerfs/data/machines/native/run/images/<hex>.2.json` | Sidecar |
| `/layerfs/data/machines/native/run/images/<hex>.2.lock` | Existing per-image `flock` |
| `/layerfs/data/machines/native/run/images/.recv-<hex>.part` | Staged tar during transfer, deleted after unpack |

Native Linux uses the same layout under `$LAYERFS_HOME/machines/native/run/images` (`layerfs-home/src/home/paths.rs:85`).

**Concurrency.** Two creates of the same image use the same `.recv-<hex>.part`. While its mtime is less than 30 s old, `probe` answers `{present:false, receiving:true, offset}`, and the second caller polls (bounded) instead of sending. Unpack is already single-flight per digest: `cache.rs:30-76` takes a `flock`, unpacks to a temporary directory and publishes with a rename.

**Resumable transfer.** The `.part` file is keyed by Id, not by the feature branch's per-call token. `probe` returns `{offset, prefix_sha256}`. The host re-exports from the kept container, hashes the first `offset` bytes, and skips them if the hashes match; otherwise it truncates the file and starts over. A lost `write` reply is safe because `write` already checks `len == offset`.

**Docker fast path (optional).** On the `docker` machine, the worker container runs on the same Engine as the host. The host can run `docker export <tmp> | docker exec -i <worker> /layerfs/bundle/layerfs worker image-receive <hex>`, a new hidden worker subcommand that writes the same `.part` file and publishes it. This avoids one round trip per 1 MiB frame. The worker still never sees the Docker socket. `docker cp -` is not acceptable: it would unpack with Docker's rules and skip LayerFS's checks.

**Behaviour by machine kind:**

| Kind | Transport | Notes |
|---|---|---|
| docker | Worker frames: `-p` on Docker Desktop, `--network host` loopback on a Linux Engine (`docker/power.rs:66-89`); or the fast path | Image source: same Engine |
| lima | Worker frames over `ssh -L` | 1 MiB frames, one round trip each. Pipelining is a later optimisation |
| apple-container | Worker frames over `--publish 127.0.0.1:<port>` (`apple_container/create.rs:31`) | — |
| native Linux | `Executor::Local`: export straight into the local `.part` file, no frames | Needs root, as namespaces already does |
| native macOS | Refused `Unsupported` | `machine images` answers `mode:'host'` |

#### R2 `machine images <name>`

The result is the contract's shape plus `free`, which is `statvfs` of the cache directory. `machine status` already reports free disk; reuse its probe. The command is read-only.

- `images` combines the cache sidecars with what the archives still hold: the bundle's `sandbox-image.tar` (`source:'bundle'`) and a VM's `/layerfs/image/<file>` (`source:'machine'`), even when those are not unpacked yet.
- `sandboxes` is counted on the host from Sandbox records with `machine == name` and `image == id`. The worker never reads home records.
- `default` is the record's image, else the bundle archive's single image.

The feature branch's `images.rs` already provides `list`, `in_worker` and `mode:'host'`. It reads `.tar` archives (`inspect_linux`) and needs to read sidecars instead. It also uses the field names `digest`, `tags` and `default_digest`, which must be renamed to the contract's `id`, `refs` and `default`.

#### R3 `machine load`

`machine load` runs R1's resolve-export-send-unpack steps without creating a Sandbox. Its result is `{id, refs, size, reused: bool}`, and it takes the same refusals and events as R1.

#### R4 `machine prune`

`machine prune <name> [<image>] [--unused]` returns `{removed:[id], freed}`.

An image counts as in use if any Sandbox directory's `config/helper.spec` `lower=` names it. That is the record `provider.rs:179` already reads on reopen. An image in use is refused with `InUse`.

Race: `ensure` releases the `flock` before `helper.spec` is written (`create.rs:188` and `:288`). Hold a shared lock from `ensure` until the spec is written. Prune takes the exclusive lock without blocking, and skips the image if the lock is busy.

`--unused` keeps the machine default. Naming the default explicitly removes it, and the next create unpacks it again from the bundle archive. Old-layout `<hex>` directories (`cache.rs:17-19`) are removable when unused. `freed` is measured as `statvfs` before and after, not summed from file sizes.

### 3.3 Daemon runtime layer (R5)

**Current behaviour.** The daemon binary is copied into the Sandbox (`namespaces/create.rs:273`). After `pivot_root` it is spawned as `Command::new(&spec.daemon)` (`helper init.rs:59-65`), so it loads the image's `ld.so` and libraries. It also resolves hostnames by running `/usr/bin/getent` from the image (`engine/crates/layerfs-bridge/src/network.rs:43`). Exec runs `bash -c` (`layerfs-sandbox/src/exec/run.rs:146`) through the helper after `setns` (`namespaces/exec.rs:104-147`).

**Bundle.** `tools/linux_bundle.py` `seal` (`:169-225`) adds `runtime/` beside `ARCHIVE`:

| Path | Content |
|---|---|
| `runtime/lib/` | `ld-linux-<arch>.so.*`, `libc.so.6`, `libm.so.6`, `libgcc_s.so.1`, `libssl.so.3`, `libcrypto.so.3`, plus whatever `ldd layerfs-daemon` lists |
| `runtime/bin/bash` | Debian `bash-static` |
| `runtime/bin/busybox` | `busybox-static` |
| `runtime/bin/getent` | glibc `getent` |

`seal` copies the libraries out of the same build image the daemon was built in, so the ABIs match by construction. It refuses when `ldd` lists a library it did not copy. Each runtime file goes into `files` (`:202`), so the bundle `hash` covers it and machines copy the bundle in again when the runtime changes.

`bundle.json` already has a `runtime` key (the hash of the binaries, `:210`). The new field therefore needs another name: `"sandbox_runtime": {"hash", "loader": "lib/ld-linux-aarch64.so.1", "glibc": "<ver>"}`.

**Mount.** `HelperSpec` (`helper_spec.rs:35-58`) gains an optional `runtime` path. `parse` (`:90-92`) currently accepts exactly eight fields; it must also accept specs without `runtime`, so Sandboxes made before this change reopen unchanged. `mounts.rs` `build` (`:28-66`) binds `runtime` read-only with nosuid and nodev at `<root>/.layerfs/runtime`. The worker-side source is `beside_self("runtime")` (`deploy.rs`), or the guest's bundle copy on a VM.

**Start.** In `init.rs` `inner`, when `spec.runtime` is set, the daemon starts as:

```
/.layerfs/runtime/lib/ld-linux-… --inhibit-cache --library-path /.layerfs/runtime/lib <daemon> --config <cfg>
```

with `LAYERFS_SANDBOX_RUNTIME=/.layerfs/runtime`, and `network.rs` runs `getent` through the same loader. The daemon never receives the image's environment, so an `LD_PRELOAD` in the image cannot reach it. The image's `/etc/ld.so.preload` is still read by `ld.so`; that is a risk to test.

**Images with no bash.** The helper exec stage (`helper exec.rs`) gets a `--shell-fallback /.layerfs/runtime/bin/bash` argument. If `execvp("bash")` fails with `ENOENT`, it executes the fallback. `/.layerfs/runtime/bin` is appended at the end of PATH, so the image's own tools win. That directory holds only `bash` and `busybox`, with no applet links.

An alternative to the loader is to link `layerfs-daemon` statically (musl, with vendored OpenSSL or rustls), which removes the coupling to glibc. The static shell and `getent` would still be needed. See Q2.

### 3.4 Image config (R6)

`check_environment` (`namespaces/create.rs:195-203`, and the same refusal in `host_process/provider.rs:49`) refuses `PATH` in the daemon's startup environment. That refusal is correct and stays. Image ENV must not be routed through `options.environment`.

Instead:
- At create, the Sandbox record stores `image_config {env, path}` from the sidecar, or from the archive's config blob for bundle and machine images.
- `namespaces/exec.rs:137-147` builds the command environment in this order: `env_clear`, then the image's `Env` without `LAYERFS_*`, then `PATH` set to the image's `PATH` or else `CONTAINER_PATH` (`local/search.rs:7`) with the runtime bin appended, then `request.environment` on top.

WORKDIR cannot replace the exec's working directory, which is always the Workspace (`--cwd`).

USER is not applied. Unpack makes every file owned by root and drops setuid bits (`rootfs/mod.rs:78-80`), and commands already run as the recorded command identity (`files.rs:221-225`).

DNS inside a Sandbox comes from the image's `/etc/resolv.conf`. An exported image has an empty one, and the converter drops it. The helper should bind the worker's `/etc/resolv.conf` and `/etc/hosts` read-only.

### 3.5 Fix that can ship first (R0)

The bug, in `deploy.rs:42-60`:
- `named.filter(|i| is_digest(i))` (`:55`) drops any image that is not a digest.
- On VM machines, `image.or(record.image())` means a non-digest call image also hides the record's digest.
- On macOS native, `resolve` (`:84-87`) ignores a digest entirely.

The fix:
- Refuse `InvalidInput` when the image is not a digest. The feature branch does this at `deploy.rs` +43-48.
- Refuse `Unsupported` when an image is given on macOS native (feature branch `route.rs` +300-305).

This change touches nothing else and can land on its own.

### 3.6 Landing order, tests, docs, effort, risks

**Order.**
1. R0.
2. R5. Images from Docker must not be offered before it lands, because most real images would fail.
3. Rebase the feature branch onto `layerfs_v2_0_0`, then R1 to R4 together.
4. R6, in Stage 2.

**Unit tests:**
- R0 refusals.
- The converter drops init-layer entries.
- The sidecar round trip.
- Two concurrent loads give one unpack.
- Resume, with matching and with mismatched prefixes.
- `NoSpace`.
- Prune refuses an image in use, including during the `ensure`-to-spec window.
- `HelperSpec` parses eight-field specs.

**Live proof.** Extend `tools/sandbox_image_live.py` (feature branch) with these phases, run on docker, lima and apple-container:

| Image | Checks |
|---|---|
| `debian:bookworm-slim` | Create from a reference; exec `cat /etc/os-release` |
| `debian:bullseye` | Create and exec (glibc 2.31) |
| `alpine` | Create and exec (musl, no bash) |
| `gcr.io/distroless/static` | Runtime-bash exec |
| amd64 image on arm64 | Refused |
| Any | Second create sends 0 bytes |
| Any | Two concurrent creates |
| Any | Killed mid-send, then resumed |
| Any | `prune --unused` frees bytes |
| `golang` | `go version` (R6) |
| Any | `getent hosts host.docker.internal` inside the Sandbox |

**Docs to update in `docs/versioned/2.0.0/`:**
- `calls.md:245-252` and `machines-and-stores.md:24`, `:84-91` and `:224-233` say the Sandbox root on docker is only the bundle's `sandbox-image.tar` and that `--image` is a digest.
- `limitations.md:138-142`.
- The machine table at `calls.md:382` gains `images`, `load` and `prune`.
- The feature branch's `docs/architecture/api/sdk/machine/images.md` and `sandbox/create.md`.

**Effort.**

| Item | Estimate |
|---|---|
| R0 | 0.5 day |
| R5 | 3–5 days |
| Rebase plus R1–R4 | 6–8 days |
| R6 | 1–2 days |
| Live proofs | 2–3 days |
| Total | About 3 weeks |

**Risks:**
- Transfer speed over 1 MiB request frames, especially Lima over ssh.
- Peak disk use of twice the image size while the staged tar and the unpacked copy coexist.
- Licence obligations for redistributing glibc (LGPL), bash and busybox (GPL) in the bundle
  (settled: a written source offer, see Status).
- An image's `/etc/ld.so.preload`.
- Root ownership after unpack breaks images that expect files owned by a user (e.g. postgres).
- The daemon may need `fusermount` if mounted with auto-unmount (`fuser fuse_pure.rs:113`).

### 3.7 Open questions for the user

1. (Settled by D5: the plugin starts the machine; `sandbox create` keeps #535 D11.)
2. For R5, should the daemon start through the runtime loader (as the contract says) or be linked statically?
3. Should the feature branch's `--image-archive` stay as an SDK-only input for images that do not come from Docker, or be removed?
4. Is it acceptable to refuse amd64 images on Apple Silicon even where Rosetta binfmt could run them?
5. Can the bundle carry GPL `bash` and `busybox` binaries? (Settled: yes, with a written source offer.)

## 4. dsh-layerfs host

The host's job gets smaller. It lists what can run on a machine, starts a create, relays progress
and runs prune. It keeps no image files and builds no archives. It also stops injecting image
flags into other callers' CLI calls. Each stage is turned on by what the pinned CLI's call table
shows (`featuresOf`), never by a version string.

### 4.1 Routes after the change

#### `GET /api/machines/:id/sandbox-images`

This one read serves the New Sandbox menu and the machine's Images section. It never starts a
machine and never pulls an image.

```
{
  machine: 'lima1', platform: 'lima', state: 'running' | 'stopped' | ...,
  stage: 0 | 1,
  mode: 'images' | 'host',              // 'host': macOS native, no Image row
  architecture: 'arm64',                // the machine's Linux arch
  free: number | null,                  // data-disk bytes (machine.images `free`); null at Stage 0
  default: string | null,               // id of the preselected ready row (D7)
  observedAt: number,
  stale: false | { at: number, code: string },   // ready rows are the last answer kept in memory
  ready: [{                             // what starts at once
    id, name,                           // name: first ref, or "LayerFS default" for source 'bundle'
    refs: string[], size: number | null,
    source: 'bundle' | 'machine' | 'imported',
    sandboxes: number, lastUsed: string | null,
    usable: boolean, reason?: Reason,   // Stage 0 archive images LayerFS cannot run
  }],
  docker: null                          // Stage 0, or macOS native
    | { available: false, reason: 'not-installed' | 'not-running' | 'error', message?: string }
    | { available: true, images: [{
        id, name, refs: string[], size: number, architecture: string, os: string,
        need: number, fits: boolean,    // D8
        usable: boolean, reason?: Reason,
      }] },
}
type Reason = { kind: 'arch' | 'os' | 'no-glibc' | 'compressed' | 'device-node', value?: string }  // value: "amd64"
```

`id` is the Docker image Id for imported images and the config digest for bundle and VM-archive
images (D1). The client always sends the picked row's `id` as `image`, for ready and Docker rows
alike: a ready pick then never goes through Docker again, and a tag that moved since the list was
read cannot swap the image. Refs are for display only.

How the two groups merge:
- **Ready group.** In Stage 1 the rows come from `machine.images`, all `usable: true`. In
  Stage 0 they come from the archive a Sandbox on that machine would use (see §3); a row that
  LayerFS cannot run has `usable: false` and the archive's `reason`.
- **Docker group.** This group exists only in Stage 1 and only for non-native machines. Rows
  come from `docker image ls` plus one batched `docker image inspect` (Id, Os, Architecture,
  Size in bytes, RepoTags).
  - Untagged and `<none>` rows are left out.
  - A row whose Id or refs match a ready row is dropped from this group, so an image never
    shows twice.
  - `os != linux` gives `usable: false, reason: { kind: 'os', value: os }`. An architecture
    other than the machine's gives `usable: false, reason: { kind: 'arch', value: architecture }`.
    Every other row is `usable: true` and will be copied once.
  - The machine's architecture is the host's for VMs (`vmArchitecture()`) and the Docker
    server's (`docker version -f {{.Server.Arch}}`) for the docker machine.
- **Docker socket.** Listed through the `docker` machine record's `docker` socket, else the
  default context: the same daemon LayerFS exports from (D3).
- **Space.** `need = 2 × size × 1.05` (the staged tar plus the unpacked tree, D8). `fits = free == null || need <= free`. The UI uses `fits` to pick its button
  label ("Free space"), but the decision belongs to LayerFS: its `NoSpace` refusal is the real
  answer.
- **Stopped machine.** `machine.images` refuses `Unavailable`. The route then answers the last
  good ready rows it kept in memory for that machine, marked `stale`, so the menu can still
  offer "Start and create". With no kept answer the ready group is empty and the default is
  LayerFS's.

**Default** (D7, the same rule at both stages). The ready row with the newest `lastUsed`, else
`default` (the machine's own: the record's digest, else the archive's only image), else the first
usable ready row. Since the client always sends `id`, a multi-image VM archive with no digest
still creates fine from the menu. Stage 1 needs no plugin state: `last_used` is a field R1
asks LayerFS to record on every create, including agents' and the CLI's (it does not exist
today), and a pruned image drops out on its own. Stage 0 has no `last_used`, so its default is
`default`, else the first usable row. Nothing is written under the plugin root. If LayerFS drops
`last_used` from the request, the fallback is `$DSH_HOME/layerfs/images/last-used.json`
(`{ [machine]: { id, ref, at } }`), written only by the create route below. It would be used
for preselection only and never injected into a CLI call.

**Project sessions and agents.** When a caller names no image, LayerFS's default rule picks it
(decided). `sessions/service.ts` `mount()` keeps calling
`sandbox.create(project, sandbox, machine)` with no image, and the agents' wrapper passes argv
through untouched. Reasons:
- One rule is visible to the CLI, agents and the UI alike.
- The current injection costs a `machine get` spawn per create.
- It races with `machine update`.
- It is copied into a node prelude and a bash wrapper whose argv parsing does not match the
  SDK's.
- The case it covered, a VM archive with several images, only arises from the archive saving
  that is being deleted.

If the user wants sessions on a particular image, that belongs in LayerFS's machine default
(see Open questions), not in plugin state.

#### Sandbox create

`POST /api/projects/:key/sandboxes { name, image?, machine?, start?: boolean, background?: boolean }`

- **`image` is a string.**
  - Stage 0 accepts only a full `sha256:` digest. Anything else is refused before any CLI call
    with `501 Unsupported` and `detail.need: 'image-refs'`, because the pinned CLI would drop it
    silently.
  - Stage 1 passes a reference, a Docker Id or a digest through unchanged.
  - The object form (`{ archive, digest }`) is removed.
- **`start: true`** first runs `machine.start` (relayed as phase `machine` and as the usual
  `machine-progress`) and then creates the Sandbox. This is the "Start and create" button, an
  explicit user action, so the manual-power rule (#535 D11) still holds.
- **Precheck.** Stage 1 only, when the image is not ready on the machine and `free` and `size`
  are known and `need > free`: refuse `507 NoSpace` with `detail { need, free }` before the
  export starts.
- **`background: true`** (what the UI sends) answers right after the precheck with the pending
  entry. The create runs as an in-memory job in a new `SandboxCreates` class next to
  `Machines`. Without `background` the route waits as it does today, which keeps tests, e2e and
  presets unchanged.
- **Creation job** (one shape for the admission answer, the list and the event):

  ```
  interface Creation {
    id: string,                 // `c-<base36 time>-<4 random>`, made by the host at admission
    input: { project, name, machine, image?: string, start?: boolean },
    phase: 'queued' | 'machine' | 'inspect' | 'export' | 'send' | 'unpack' | 'start' | 'done' | 'failed',
    done?: number, total?: number,          // bytes, only while a phase reports them
    error?: { code, message, detail? },     // phase 'failed'
    startedAt: number, updatedAt: number,
  }
  ```

  `background: true` answers `202 { creation: Creation }`.
- **Progress.** The host emits `sandbox-progress { creation: Creation }` on every phase change
  at once, and byte updates within a phase coalesced per job to one event every 500 ms (the
  data-loading rule). `machine` comes from the host's own `machine start` and exists at Stage 0;
  `inspect` … `start` need `sandbox.create`'s `on_progress` (`createProgress`); without it the
  job goes `queued` (or `machine`) → `done`/`failed`.
- **`GET /api/sandbox-creates`** → `{ creations: Creation[] }`: running jobs, and failed ones for
  10 minutes or until the same `input.project`/`input.name` is created again. Retry is the client
  re-sending `input` to the create route (a new job id). `DELETE /api/sandbox-creates/:id`
  dismisses a failed job. A remount or reload draws the progress rows from this list. Closing
  the dialog cancels nothing.

#### Images section

- The list is the ready group of `sandbox-images` (`sandboxes` count, `size`, `lastUsed`, total).
- `POST /api/machines/:id/prune-images { images?: string[], unused?: boolean }` calls
  `machine.prune(name, image)` once per id, or `machine.prune(name, { unused: true })` when
  `unused` is set. It answers `{ removed: id[], freed: bytes, refused: [{ id, code, message }] }`.
  A per-image `InUse` goes into `refused`; it is not an error for the whole request.
- The route uses a `sub` segment (`prune-images`) because the router rejects deeper paths.

#### Caching

- **Docker.** `docker image ls` and its inspect are one single-flight read kept for 10 s in
  `DockerImages`, and the `available: false` answer is kept for the same 10 s. The read runs
  outside the LayerFS admission lanes with a 10 s timeout (30 s today).
- **`machine.images`** goes into `KEPT_READS` with 5000 ms, like `machine.status`. Every write
  through the host's SDK client (`sandbox.create`, `machine.load`, `machine.prune`,
  `machine.start`) already clears all kept answers (`recent.clear()` in `cli.ts`). Creates by
  agents through the wrapper are covered by the 5 s bound.
- **Lanes.** `machine.images` joins `PROBES` (short timeout, probes lane), and `machine.load` and
  `machine.prune` join `LONG_CALLS`.
- **Stale ready rows** are kept per machine in memory only.
- **Stage-0 archive reads** are memoised by `(path, size, mtimeMs)`, so no GET parses a tar
  again (the KEPT_READS rule).

### 4.2 Feature detection and staging

`CliFeatures` loses `imageArchive` and becomes:

| flag | discovered from |
|---|---|
| `forceStop` | `machine.stop` option `force` (unchanged) |
| `images` | call `machine.images` |
| `imageLoad` | call `machine.load` |
| `imagePrune` | call `machine.prune` |
| `imageRefs` | `sandbox.create` option `image` with kind `image` (requested signal, below) |
| `createProgress` | `sandbox.create` option `on_progress` |
| `sandboxRuntime` | identity feature `sandbox-runtime` (requested signal, below) |
| `imageStage` | `1` when `images && imageLoad && imagePrune && imageRefs && sandboxRuntime`, else `0` |

`featuresOf(calls)` (`util.ts:90`) takes only the call table today; it becomes
`featuresOf(discovery)` so it can read `identity.features` too.

**Signal for references.** I'm asking LayerFS to declare `sandbox.create --image` with a new
call-table kind `image`: "a digest, Docker reference or Id". Today it is `text` on the pinned
tip and `json` on `feat/sandbox-image-artifacts`. A kind change shows up in `help --json` with no
version check, and it is the exact behaviour the plugin must not guess, because the pinned CLI
drops non-digests silently. The three calls alone do not prove it.

The daemon runtime (contract item 5) is not visible in the call table either. The request is a
token `sandbox-runtime` in `identity.features`. Without it the plugin stays at Stage 0 and the
Docker group stays hidden (D11): most real images would fail.

| stage | what the host serves |
|---|---|
| 0 | `sandbox-images` with the ready group from the archive (bundle image on docker; the VM's own archive or the bundle's), `docker: null` (Docker never read), no `need`/`fits`; create accepts digests only; `sandbox-progress` phases `queued`, `machine` (with `start: true`), `done`, `failed`; `prune-images` answers `501 Unsupported` |
| 1 | everything in §4.1 |
| 2 | no host change beyond passing new `machine.images` fields through |

`GET /api/machines` keeps answering `features`, with the new flags.

### 4.3 Delete or simplify (current uncommitted work)

- **`src/host/routes/docker-images.ts`.**
  - Delete `save()`, `saved()`, `SAVE_TIMEOUT_MS`, `NAME`, `REF` and the `<root>/images/*.tar`
    output.
  - Keep `dockerCli()`, `Exec` and `vmArchitecture()`.
  - `list()` becomes the 10 s cached Docker read behind `sandbox-images`.
  - Remove the routes `GET /api/docker-images` and `POST /api/docker-images/save`.
- **`src/host/images/uncompress.ts`:** delete the whole file (the `docker save` + gunzip/zstd
  rewrite). LayerFS's `docker export` path replaces it.
- **`src/host/images/defaults.ts`:** delete the whole file (`defaults.tsv`, `readDefaults`,
  `writeDefault`, `createMachineOf`, `withImage`, `namesImage`).
- **`src/host/layerfs/cli.ts`:**
  - Remove the `sandbox create` branch in `execute()`, along with `useImageDefaults`,
    `defaultRoots` and `withDefaultImage`. Fold `executeNow` back into `execute`.
  - Remove the committed `{ archive, digest }` → `image_archive` mapping in the SDK proxy.
  - Add `machine.images` to `KEPT_READS` and `PROBES`, and `machine.load` and `machine.prune` to
    `LONG_CALLS`.
- **`src/host/layerfs/tracing.ts`:** remove the node prelude's image line (and `spawnSync`), the
  `defaults` config field, and the bash block plus the `defaults` parameter in `nativeWrapper`.
  The wrapper goes back to a pure passthrough.
- **`src/host/service.ts`:** remove the `useImageDefaults(...)` call and its import.
- **`src/host/routes/machines.ts`:**
  - Delete `recordDefault`, `setDefaultImage`, the `writeDefault` in `remove()`, and the
    post-call steps in `create()` and `update()`.
  - `create()` and `update()` still pass LayerFS's own `image` option through for CLI parity,
    with no bookkeeping.
  - `images()` becomes `sandboxImages()`.
  - `archiveImages()` stays as the Stage-0 ready-group source. Changes:
    - It drops `readDefaults`.
    - It reads the archive through the memo.
    - It returns rows in the shape above.
    - It stops falling back to bundle.json's digest as a "default" when the archive cannot be
      read; it answers an empty ready group with `stale`/error instead.
  - Its problems were a sync full tar walk on every GET, a default kept in two places, and a
    `no-glibc` heuristic presented as fact.
- **`src/host/images/archive.ts`:** keep for Stage 0, plus the memo. In Stage 1 it is used only
  when `imageStage === 0`.
- **`src/host/routes/router.ts`:** remove `default-image`, `docker-images` and
  `machines/:id/images`; add `sandbox-images`, `prune-images` and `sandbox-creates`; drop the
  `dockerImages` group in favour of a `sandboxCreates` group. Add `NoSpace: 507` to `STATUS`.
- **`src/host/routes/util.ts`:** keep `bundle?()` on `RouteHost` (Stage 0 reads
  `sandbox-image.tar`); `featuresOf` as in §4.2.
- **`src/host/routes/projects.ts`:** `createSandbox` takes the string-only image and gets the
  stage check, `start`, `background` and progress.

**Before deleting, check 3080.** Read `GET /api/machines` there. If any VM's `image` points
under `$DSH_HOME/layerfs/images/` with several images, tell the user: its session Sandboxes
will need `machine update --image <digest>`, which is LayerFS's own rule.

### 4.4 Error mapping

| LayerFS / host code | HTTP | UI key | notes |
|---|---|---|---|
| `InvalidInput` (unknown image) | 400 | `imageUnknown` | |
| `Unsupported` + `detail.reason: 'arch'` (`detail.value`) | 501 | `imageWrongArch` {arch} | |
| `Unsupported` + `detail.reason: 'host'` | 501 | `imageHostOnly` | macOS native |
| `Unsupported` + `detail.need: 'image-refs'` (host's Stage-0 guard) | 501 | `imageNeedsNewerLayerfs` | |
| `Unavailable` (machine stopped) | 502 | `machineStopped` | button: Start and create |
| `Unavailable` + `detail.what: 'docker'` | 502 | `dockerNotRunning` | |
| `NoSpace` {need, free} | 507 | `imageNoSpace` | button: Free space |
| `InUse` (prune) | 409, per row | `imageInUse` {count} | |
| `Busy` | 409 | `machineBusy` | |
| `Exists` / `NameTaken` | 409 | `sandboxNameTaken` | |
| `Timeout` | 504 | `imageTimeout` | |
| anything else | 500 | `sandboxCreateFailed` | Retry shows the message |

`handle()` logs every status of 500 or more except 503. `Unavailable`, `NoSpace` and
`Unsupported` are expected refusals: skip the stack log for exactly those three codes. `Unknown`
(500) and `Timeout` (504) keep logging.

### 4.5 Tests

- **Delete:**
  - `test/image-defaults.test.mjs` (the whole file).
  - In `test/image-archives.test.mjs`: the docker images/save tests and both uncompress tests.
    The archive reader tests (legacy, OCI, no manifest, runnable) stay.
  - In `test/routes-features.test.mjs`: the "default image" test.
- **Change:**
  - `routes-features`: the features test gets the new flags, Stage 0 and Stage 1 fake tables.
    The "images" tests move to `sandbox-images` and assert the Stage-0 row shape.
  - `cache.test.mjs`: in `GETS`, replace `docker-images` and `machines/:id/images` with
    `machines/:id/sandbox-images` and `sandbox-creates`. Add `machine.load` and `machine.prune`
    to `MUTATING`. Inject a fake `Exec` so no test spawns real Docker.
- **Add, unit with a fake CLI and a fake Docker `Exec`:**
  - Merge, dedupe, arch/os reasons and `fits`.
  - Docker missing or not running.
  - A stopped machine answering the kept stale rows.
  - Default from `last_used`.
  - Docker read kept 10 s (mock timers).
  - `machine.images` kept, then cleared by a prune.
  - Create: the Stage-0 guard; digest passed through; Stage-1 ref passed through; `start` calls
    `machine.start` first; NoSpace precheck; progress coalesced to 500 ms with phase changes
    immediate; a background job listed and then dropped.
  - Prune: partial `InUse`.
  - `errorAnswer` for the new codes.
  - `tracing.test`: the generated wrappers contain no `--image` insertion.
- **E2E (fake-llm):** in `e2e-sessions`, a project session's create carries no `--image` (call
  log). `e2e-crawl` opens New Sandbox on the pinned CLI and sees only the ready group. A Stage-1
  e2e runs only when discovery shows `imageStage 1`: Docker on a private home, `alpine:3` and a
  glibc image, progress row, Images remove.
- **3080:**
  1. Merge into the linked checkout and run `node scripts/build.mjs`.
  2. Tell the other agents, then restart 3080 exactly as started (this is a host change).
  3. With a uniquely prefixed project, check that Machines loads, that `sandbox-images` answers
     on docker and on one VM, and that a Sandbox gets created with the default image and then
     removed.
  4. Confirm no request to `/api/docker-images` remains.

### 4.6 Open questions

1. Should the Images section offer "Use for new Sandboxes" (`machine update <m> --image <id>`,
   LayerFS's default), so project sessions run a chosen image without plugin state?
2. Can `machine.images` answer a stopped machine from a host-side index, instead of
   `Unavailable`? That would remove the in-memory stale fallback.
3. Are the requested signals (`image` option kind, `sandbox-runtime` feature) acceptable, or
   does LayerFS prefer another discoverable form?

Settled in §2: image identity (D1), Docker socket (D3), disk need (D8), stage gate (D11).

## 5. dsh-layerfs UI

Scope: `src/client/machines/` and the one shared control in `src/client/ui/`. Everything follows AGENTS.md "UI rules" (CSS Modules + `clsx`, `--dsw-alias-*` tokens only, primitives first, en+zh copy) and "Data loading rules", plus the saved preferences (modals, no status lights, words for readiness in dialogs, one scroll area).

### 5.1 Screens and states

#### 5.1.1 New Sandbox: the Image control

`NewSandboxDialog` keeps Project and Name. The old `SandboxImageFields` (default/archive/digest/"Use Docker images…") becomes one **Image** menu, a note line under it, and a footer button whose label says what will happen.

```
 New Sandbox                                             x
 Project   [ acme/web                         v ]
 Name      [ web-1                              ]
 Image     [ postgres:17-bookworm   412 MB · copies once v ]
           Copies postgres:17-bookworm (412 MB) to lima-1 once;
           later Sandboxes start at once.
                                     [Cancel] [ Create ]

 menu open:
 ┌──────────────────────────────────────────────────────┐
 │ ON LIMA-1, READY                                     │
 │   ubuntu:24.04              used 2 h ago          ✓  │
 │   LayerFS default           ready                    │
 │ FROM DOCKER ON THIS MAC                              │
 │   postgres:17-bookworm      412 MB · copies once     │
 │   node:22                   1.1 GB · copies once     │
 │   mcr.microsoft.com/mssql   amd64 only      (grey)   │
 └──────────────────────────────────────────────────────┘
```

- **Groups.** "On `<machine>`, ready" lists the machine's cached images (`machine.images`); "From Docker on this Mac" ("…on this computer" off macOS) lists `docker image ls`. An image whose Id is already ready shows only in the ready group. Dangling `<none>` images are not listed.
- **Row = name + one tag.** Name is the first ref (`repo:tag`), else "LayerFS default" for `source:'bundle'`. Tag: ready rows "used 2 h ago" (from `last_used`), or "ready" if never used; Docker rows "412 MB · copies once"; unusable rows are disabled (greyed) with the reason as the tag: "amd64 only" (other architecture), "Windows only", and at Stage 0 only "needs glibc" / "can't unpack". The menu never shows digests, paths or Ids. The full ref list shows as the row's `title`.
- **Default selection.** The ready image with the newest `last_used`. If none has been used, the LayerFS default (`default`). If that is missing too, the first ready image. The choice never falls to a Docker row unless the user picks one.
- **Note line** (one line, `Field` hint, always present when the menu is): ready pick → "ubuntu:24.04 is already on lima-1."; Docker pick → "Copies `<image>` (`<size>`) to `<machine>` once; later Sandboxes start at once."; stopped machine → "lima-1 is stopped; Create starts it first."; low disk → "Needs 1.2 GB; lima-1 has 0.4 GB free.". Only one sentence shows, picked in this order: no space, stopped, Docker off, the pick's sentence.
- **Button label.** `Create`; `Start and create` when the answer's `state` is `stopped`; `Free space` when the Docker pick has `fits: false` (D8). Free space opens the Free space dialog (5.1.3) on top of New Sandbox with the unused images preselected and the pick's `need` stated. When it closes after removing, the images are read again and the button returns to `Create`. While submitting: `Creating…`.
- **Machine switch.** Both entry points (machine detail, Overview machine card) fix the machine, so today there is no switch. If a Machine field is added later, changing it re-reads that machine's images. The pick is kept when the same image Id or ref is offered there, otherwise the new machine's default is chosen, and the note says "Image changed to `<x>`: `<y>` is not on `<machine>`." See open question 1.
- **macOS native.** No Image row. One muted line in its place: "Sandboxes on this Mac use its own system." Driven by `mode:'host'`.
- **Docker not running / not installed.** Only the ready group. The note says "Docker isn't running, so only images already on lima-1 are listed." ("isn't installed" variant). It is replaced by a more urgent sentence as ordered above.
- **Stopped machine.** New Sandbox is enabled on a stopped machine. Today's `startBeforeSandbox` gating in `MachineDetail` and `HomeCards` goes; it stays only while a startup or another power action is running. `machine.images` refuses a stopped machine, so the ready group shows the host's last answer for that machine, with a muted group footer "As of when lima-1 last ran". With no last answer, the ready group shows only "LayerFS default". Docker rows still list. The button reads `Start and create`.
- **Reading / failed.** While the first answer loads, the menu is disabled and shows "Loading images from lima-1…". If the read fails, `Refusal` plus `Retry loading images` show, and Create still works with the LayerFS default (no `image` sent).

#### 5.1.2 The new Sandbox's row: progress, failure, Retry

On admission the dialog closes. Closing does not cancel: the job belongs to the host. A pending row appears at the top of the machine's Sandboxes column in `Inventory` (and as a chip on the Overview machine card):

```
 Sandboxes 3                                   [+ New Sandbox]
 ◻ web-1     acme/web   Copying image  148 of 412 MB  ▬▬▬▬░░░░░
 ◻ web-1     acme/web   Starting machine
 ◻ web-1     acme/web   Starting Sandbox
 ◻ web-1     acme/web   Couldn't create: lima-1 has 0.4 GB free   [Retry] [x]
```

Phases map to three words: `machine` → "Starting machine"; `inspect|export|send|unpack` → "Copying image", with "x of y MB" and a bar only while `send` reports `done/total`; `start` → "Starting Sandbox". At Stage 0 (no `--progress`) the row says "Creating". The phase text is `StateChip`'s `op` with `live`, so no extra light. On success the pending row is replaced by the real row from the next `/api/machines` read. On failure the row keeps its place with the refusal's message, `Retry` (re-sends the same input), and a dismiss `x`. A `NoSpace` failure's Retry button reads `Free space` and opens 5.1.3. The row is not clickable until the Sandbox exists.

#### 5.1.3 Machine detail: Images section and Free space

A new `Card` on `MachineDetail` between Inventory and Details, Stage 1 only, not on macOS native:

```
 Images                                            [Free space…]
 Image                    Size      Used by
 ubuntu:24.04             780 MB    2 Sandboxes
 postgres:17-bookworm     412 MB    Unused              [Remove]
 LayerFS default          310 MB    1 Sandbox
 1.5 GB on lima-1 · 12.4 GB free
 Images are copied here from Docker once. Removing one never touches Docker.
```

- Columns: Image (name as in the menu), Size, Used by ("Unused" / "1 Sandbox" / "N Sandboxes"). `Remove` appears only on unused rows. There is no confirm, because the image can be copied again; the button reads "Removing…" while it runs. The bundle image has no Remove.
- On a stopped machine the section shows the last answer, a line "Start lima-1 to remove images.", and no Remove buttons.
- **Free space dialog** (`Modal`): one `Checkbox` per image. Unused images are preselected; in-use rows are disabled with "In use by 2". The footer line reads "Frees 1.2 GB", or "Frees 1.2 GB; the new Sandbox needs 0.8 GB" when opened from New Sandbox. The button reads "Remove 3 images" or "Remove 1 image". It calls prune with the checked Ids; a `NoSpace`/`InUse` refusal shows inline.

```
 Free space on lima-1                                    x
 ☑ postgres:17-bookworm   412 MB   Unused
 ☑ debian:12              120 MB   Unused
 ☐ ubuntu:24.04           780 MB   In use by 2   (disabled)
 Frees 532 MB; the new Sandbox needs 0.8 GB
                                [Cancel] [Remove 2 images]
```

### 5.2 Components

New, in `src/client/machines/`:
- `ImageMenu.tsx`: `ImageMenu({ machine: MachineInfo, value: string | null, onChange(pick: ImagePick | null), disabled })`, with `ImagePick = { id, ref, name, from: 'ready'|'docker', size, usable }`. It wraps the primitives `Menu` directly with `MenuLabel` group heads and data `MenuItem`s (`disabled` for greyed rows, `label` a ReactNode: name + `.imageTag`), and uses `selection="check"`, `portal`, `minWidthFromAnchor`. The anchor reuses `ui/index.tsx`'s select-button styling: export the `css.select` anchor as a `SelectAnchor` from `ui/index.tsx`, so `MenuSelect` and `ImageMenu` share it. Also exports `useSandboxImages(machine)` (the query, §3) and `imagePlan(answer, pick)` → `{ label: 'create'|'start'|'free', note: Words }`, a pure function that is unit-tested.
- `MachineImages.tsx`: `ImagesSection({ m })` and `FreeSpaceDialog({ m, need?: number, onClose(freed: boolean) })`. Uses `Card`, `Section` and `Refusal` from `src/client/ui`, and `Button`, `Checkbox`, `Modal` and `fileSizeText` from the primitives.
- `CreatingRow` in `Inventory.tsx`: the pending/failed row. Reuses `.line`, `.sandboxLine`, `StateChip`, and a thin progress bar. `ui/Meter` turns red above 90%, so add `Meter tone="neutral"` (no threshold tones) rather than a new bar.

Changed:
- `Sandboxes.tsx`: `SandboxImageFields` is deleted. `NewSandboxDialog` uses `ImageMenu` + `imagePlan`, sends `image: pick.id` (always the id, §4.1; omitted only when the images read failed) and `start: true` when stopped, and closes on admission.
- `controller.ts`: delete `dockerImages`, `saveDockerImages`, `setDefaultImage`, and `machineImages` (replaced). Add `sandboxImages(machine)`, `pruneImages(machine, ids)`, `retryCreation(creation)` (re-sends `creation.input`), `dismissCreation(id)`, and a `creations` source (keyed by job `id`) fed by `GET /api/sandbox-creates` and `sandbox-progress` events.
- `MachineDetail.tsx`, `HomeCards.tsx`: New Sandbox enabled when stopped (§5.1.1). `MachineDetail` renders `ImagesSection`.
- `parts.tsx`: delete `VmImageDialog` and the VM "Sandbox images…" menu item (VMs return to Remove only). `SettingsDialog` loses its Sandbox image digest field (docker keeps socket/WSL). Native gets no Settings item if nothing is left.
- `AddMachineDialog.tsx`: delete the image choice (`imageMode`, `DockerImagePicker`, `ArchiveSummary`, the archive field). `model.ts`: `VmForm.image`, `isImageRef` and `vmErrors`' image check go. `Spec.tsx`: drop the `defaultImage` and `imagesInUse` facts (digests). `SandboxDetail.tsx`'s Image fact shows the image name when the images answer knows it.
- `model.ts`: delete `DockerImagesView`, `SavedImageArchive`, the old `MachineImages`, `ImageProblem`, `PROBLEM_WORDS`. Add `SandboxImagesView` and `Creation` (both §4.1). `CliFeatures`: drop `imageArchive`, keep `images`, add the other §4.2 flags (`imageStage`, `createProgress`, …).

Deleted: `DockerImagePicker.tsx` (whole file). CSS removed: `.dockerList`, `.dockerRow`, `.dockerMeta`, `.archiveImages`, `.vmImage` (+ its media rule). CSS added: `.imageItem`, `.imageTag`, `.imageTag[data-off]`, `.imagesTable`, `.imagesFoot`, `.creatingLine`, `.creatingBar`. All use `--dsw-alias-label-tertiary`/`-secondary`, 0.5px `--dsw-alias-border-l2` hairlines, and hover under `@media (hover: hover)`.

### 5.3 Data

| View | Read | Key / refresh |
|---|---|---|
| Image menu, Images section, Free space | `GET /api/machines/:id/sandbox-images` | `useQuery(..., [machine], { cache: 'machines:images:'+machine, refresh: [tick] })` |
| Pending rows | `GET /api/sandbox-creates` + `sandbox-progress` events | controller `creations` cell |
| Create | `POST /api/projects/:p/sandboxes { name, machine, image?, start?, background: true }` → the job entry on admission | then one `reload()` |
| Remove / Free space | `POST /api/machines/:id/prune-images { images: [id] }` → `{ removed, freed, refused }` | bumps the machine's tick |
| Retry / dismiss | Retry re-POSTs the job's input to the create route; dismiss is `DELETE /api/sandbox-creates/:id` | reload |

The answer shape is the one in §4.1 (D15). `stale` marks the host's kept answer for a stopped machine. `docker` is `null` at Stage 0 and on macOS native. The "From Docker on this Mac" heading uses "…on this computer" when the host is not macOS (the client knows its platform). `useQuery` moves from `src/client/files/use-query.ts` to `src/client/ui/use-query.ts`, re-exported from the old path, because machines must not import from `files/`.

Events:
- `sandbox-progress { creation }` (the §4.1 `Creation`) updates the `creations` cell in place by `creation.id`, with no read. Byte updates arrive at most every 500 ms per job, matching the data-loading rule. A `done` or `failed` event queues one `/api/machines` reload and bumps that machine's images tick, coalesced at 500 ms.
- `machine-progress` (start finished) and `storage-changed` bump the images tick, coalesced at 500 ms.
- The Docker list has no events. It is read when the dialog opens and the window regains focus, through the same query (cache keeps the last answer on screen).

Nothing drops a running read. A machine switch is a `deps` change; everything else is a `refresh`.

### 5.4 Copy (en / zh)

Add:
`imagesReadyOn` "On {machine}, ready" / "{machine} 上，已就绪" · `imagesFromDockerMac` "From Docker on this Mac" / "来自本机 Docker" · `imagesFromDockerHost` "From Docker on this computer" / "来自本机 Docker" · `imagesAsOf` "As of when {machine} last ran" / "{machine} 上次运行时的镜像" · `imageLayerfsDefault` "LayerFS default" / "LayerFS 默认" · `imageReadyTag` "ready" / "已就绪" · `imageUsedAgo` "used {ago}" / "{ago}用过" · `imageCopiesOnce` "{size} · copies once" / "{size} · 仅复制一次" · `imageOnlyOs` "{os} only" / "仅 {os}" · `imageNeedsGlibc` "needs glibc" / "需要 glibc" · `imageCannotUnpack` "can't unpack" / "无法解包" · `noteReady` "{image} is already on {machine}." / "{image} 已在 {machine} 上。" · `noteCopy` "Copies {image} ({size}) to {machine} once; later Sandboxes start at once." / "将 {image}（{size}）复制到 {machine} 一次；之后的 Sandbox 会立即启动。" · `noteStopped` "{machine} is stopped; Create starts it first." / "{machine} 已停止；创建时会先启动它。" · `noteNoSpace` "Needs {need}; {machine} has {free} free." / "需要 {need}；{machine} 只有 {free} 可用。" · `noteDockerOff` "Docker isn't running, so only images already on {machine} are listed." / "Docker 未运行，只列出 {machine} 上已有的镜像。" · `noteDockerMissing` "Docker isn't installed, so only images already on {machine} are listed." / "未安装 Docker，只列出 {machine} 上已有的镜像。" · `noteSwitched` "Image changed to {image}: {was} is not on {machine}." / "镜像已改为 {image}：{machine} 上没有 {was}。" · `nativeOwnSystem` "Sandboxes on this Mac use its own system." / "此 Mac 上的 Sandbox 使用它自己的系统。" · `startAndCreate` "Start and create" / "启动并创建" · `freeSpace` "Free space" / "释放空间" · `freeSpaceItem` "Free space…" / "释放空间…" · `phaseCreating` "Creating" / "正在创建" · `phaseMachine` "Starting machine" / "正在启动机器" · `phaseCopy` "Copying image" / "正在复制镜像" · `phaseCopyOf` "Copying image {done} of {total}" / "正在复制镜像 {done}/{total}" · `phaseSandbox` "Starting Sandbox" / "正在启动 Sandbox" · `createFailedRow` "Couldn't create: {reason}" / "无法创建：{reason}" · `dismiss` "Dismiss" / "关闭" · `imagesTitle` "Images" / "镜像" · `imagesColImage` "Image" / "镜像" · `imagesColSize` "Size" / "大小" · `imagesColUsedBy` "Used by" / "使用者" · `imagesUnused` "Unused" / "未使用" · `imagesUsedByOne` "1 Sandbox" / "1 个 Sandbox" · `imagesUsedBy` "{n} Sandboxes" / "{n} 个 Sandbox" · `imageRemove` "Remove" / "移除" · `imageRemoving` "Removing…" / "正在移除…" · `imagesTotal` "{total} on {machine} · {free} free" / "{machine} 上共 {total} · 可用 {free}" · `imagesNote` "Images are copied here from Docker once. Removing one never touches Docker." / "镜像从 Docker 复制到这里一次。在这里移除不会影响 Docker。" · `imagesEmpty` "No images on {machine} yet. The first Sandbox with an image copies it here." / "{machine} 上还没有镜像。第一个使用镜像的 Sandbox 会把它复制过来。" · `imagesStoppedNote` "Start {machine} to remove images." / "启动 {machine} 后才能移除镜像。" · `freeSpaceTitle` "Free space on {machine}" / "释放 {machine} 的空间" · `freeSpaceBody` "Remove images no Sandbox uses. Docker keeps its copies." / "移除没有 Sandbox 使用的镜像。Docker 中的副本会保留。" · `inUseBy` "In use by {n}" / "{n} 个正在使用" · `freesSize` "Frees {size}" / "释放 {size}" · `freesSizeNeed` "Frees {size}; the new Sandbox needs {need}" / "释放 {size}；新 Sandbox 需要 {need}" · `removeImagesOne` "Remove 1 image" / "移除 1 个镜像" · `removeImages` "Remove {n} images" / "移除 {n} 个镜像". Ages come from the primitives `relativeTime` bucket, rendered by `agoMinutes`/`agoHours`/`agoDays` ("{n} min ago" / "{n} 分钟前", "{n} h ago" / "{n} 小时前", "{n} d ago" / "{n} 天前") unless the namespace already has them.

Keep: `sandboxImage`, `dockerOtherArch` (reused for "amd64 only"), `imagesLoading`, `imagesFailed`, `imagesRetry`, `stageImage` (machine start stage), `image`, `imageNone`, `retry`.

Delete (uncommitted): `imageDefaultDigest`, `imageFixedBundle`, `imageFixedDocker`, `imageFixedMachine`, `imageFromDocker`, `imageUseDocker`, `useDockerHint`, `imagesOneVm`, `restartForImages`, `restartingForImages`, `restartMachine`, `restartingMachine`, `chooseAgain`, `defaultImageLabel`, `defaultImageHint`, `imagesFromMachine`, `imagesFromBundle`, `imagesChoose`, `archiveProblem`, `problemCompressed`, `problemDevice`, `problemGlibc`, `cannotRun`, `imageCannotRun`, `chooseImage`, `dockerImagesLoading`, `dockerUnavailable`, `savedArchives`, `chooseSavedArchive`, `dockerImagesLabel`, `dockerImagesHint`, `dockerNoImages`, `archiveName`, `errArchiveName`, `errArchiveTaken`, `saveArchive`, `savingArchive`, `savingArchiveHint`, `archiveHolds`, `sandboxImagesItem`, `sandboxImagesTitle`, `sandboxImagesBody`, `currentImage`, `vmImageHint`.
Delete (already committed, same features): `imageDefault`, `defaultWord`, `imageProvideArchive`, `imagesNone`, `archivePath`, `archiveHint`, `digestOptional`, `digestHint`, `errDigest`, `imageBundle`, `imageArchiveChoice`, `archivePathOrDigest`, `errImage`, `defaultImage`, `imagesInUse`, `startBeforeSandbox` (if no other user remains).

### 5.5 Staging (feature flags)

The client reads `features.imageStage` and `features.createProgress` (§4.2, D11) through `AvailableView.features`; `sandboxImages` below means `imageStage === 1`.

- **Stage 0** (pinned CLI): the menu shows only the ready group. That is "LayerFS default" on docker, plus the VM's archive images that the host reads today. Picks send a `sha256:` digest, which the pinned CLI honours. Unrunnable archive images are greyed ("needs glibc", "can't unpack"). There is no Docker group, no low-disk check (no `free`), no Images section, and no Free space. The pending row says "Creating" with no phases. `Start and create` works, because the create route's `start: true` runs `machine start` first (D5); it needs no LayerFS change.
- **Stage 1** (`sandboxImages`): the Docker group, size/free checks, the Images section and Free space. The progress phases need `createProgress`; without it the row stays "Creating".
- **Stage 2**: nothing in this UI changes. A later registry pull would add a third group.

### 5.6 Verification

- Unit (`test/machines-images.test.mjs`): `imagePlan` (label/note for ready, Docker, stopped, no-space, Docker off, native host), default selection (newest `last_used`, then `default`), dedupe of ready Ids out of the Docker group, phase→words mapping, and `featuresOf` stage flags.
- Step modules for `tools/shot.mjs` (side server, private home), in `test/shots/`:
  `new-sandbox-image.mjs` opens machine → New Sandbox → Image menu, screenshots both groups, asserts the groups via `getByRole('menu')`, picks a Docker row and asserts that the button reads Create and the note says "copies once". `stopped-create.mjs` stops the docker machine, opens New Sandbox, and asserts `Start and create`. `images-section.mjs` checks the table, Remove on an unused row, and that Free space has the unused rows preselected. `native-mac.mjs` asserts the native New Sandbox has no Image field and shows the one line. Also take dark-mode shots and zh shots (DSH locale switch).
- e2e (`test/e2e-sandbox-images.mjs`, fake-llm side server, Docker required, skipped without it): Stage 0 checks the ready group only, then creates with the default and expects a "Creating" row followed by the real row. Stage 1 (with `DSH_LAYERFS_CLI` built from the LayerFS change) creates from a small local image (`docker build` of a 2-line Dockerfile tagged `e2eimg-<pid>:1`) and expects phases in order, `machine.images` showing it with "1 Sandbox", then deletes the Sandbox, Removes the image, and checks that `freed > 0`. The failure path forces `NoSpace` with a fixture image larger than a tiny Lima disk (or a stubbed refusal in routes tests) and checks the row shows the reason, Retry, and dismiss. Add Image menu / Images section entries to `e2e-crawl.mjs`.
- 3080: after the merge, rebuild (client hot-reloads) and restart 3080 for the host routes, following the shared-server rules. On the existing docker machine, open New Sandbox with an `<agent-prefix>-` project and check the groups and labels. Create one Sandbox from a Docker image and watch the row's phases, then delete it and Remove the image. Leave the LayerFS home's other images alone.

### 5.7 Open questions

None left in this part. Settled in §2: Machine field (D13), Free space as a stacked modal (D14), no automatic cleanup (D9), who starts the machine (D5), host-kept creation jobs (D10).

## 6. Plan and open questions

### 6.1 Order of work

| Step | Where | What | Needs |
|---|---|---|---|
| 1 | dsh-layerfs | Stage 0: delete the archive/default-image pipeline (§4.3, §5.2), add `sandbox-images`, the Image menu with the ready group, `start: true`, creation jobs and rows, the Stage-0 digest guard | nothing; pinned CLI |
| 2 | LayerFS | R0: refuse an image `choose()` cannot use | user's go-ahead |
| 3 | LayerFS | R5: daemon runtime layer in the bundle | user's go-ahead, Q2, Q3 |
| 4 | LayerFS | Rebase `feat/sandbox-image-artifacts`, then R1–R4 and the discovery signals (D11) | user's go-ahead |
| 5 | dsh-layerfs | Stage 1: Docker group, progress phases, Images section, Free space; turned on by discovery | steps 3–4 in the pinned build |
| 6 | both | Stage 2: R6 (image ENV and PATH) | later |

Step 1 lands on 3080 like any plugin change (side server, merge into the linked checkout, 3080
restart for host routes). Before it does, check 3080's VMs (§4.3): any VM whose `image` points at
an archive the plugin saved under `$DSH_HOME/layerfs/images/` with several images loses the
plugin's injected default and needs `machine update --image <digest>`.

Step 1 is done (see Status). The user approved changing LayerFS's `layerfs_v2_0_0` sources
(2026-11-14), so steps 2–5 are in progress.

**Terminal pass condition for Stage 1** (set by the user):
1. **Docker first.** On the `docker` machine, local Docker images are listed and usable: a Sandbox
   created from at least `postgres:17-bookworm` and `alpine:latest` (by Docker reference, through
   `layerfs sandbox create … --image`) starts and runs commands, and a second create of the same
   image sends nothing.
2. **Then Lima.** A few of the same images are imported into a Lima machine with
   `layerfs machine load <lima> <image>`; `layerfs machine images <lima>` lists them as ready, and
   Sandboxes created from them on that Lima machine start and run commands.
3. **In the UI.** The plugin's New Sandbox menu shows the "From Docker on this Mac" group and the
   ready images on both machines, and creating from a Docker image shows the copy progress; checked
   on a side server, then on 3080 once 3080 is pinned to the new LayerFS build through the app.

### 6.2 Open questions for the user

1. **Go-ahead for the LayerFS changes** (§3), and in which order (R0 alone first is cheap and
   fixes a silent wrong-image bug today).
2. **Daemon runtime:** start the daemon through a bundled loader and libraries (§3.3), or link it
   statically (musl with vendored OpenSSL or rustls)?
3. **Licences:** may the bundle redistribute glibc (LGPL), `bash` and `busybox` (GPL)? Settled:
   yes, with `licenses/SOURCES` (a written source offer) and the sources published beside releases.
4. **amd64 images on Apple Silicon:** refuse them (proposed), or allow Rosetta/binfmt later?
5. **`--image-archive`:** keep it as an SDK-only input for images that do not come from Docker
   (the later `LAYERFS_HOME/images` store), or remove it?
6. **Discovery signals:** is an `image` option kind on `sandbox.create` plus an identity feature
   `sandbox-runtime` acceptable to LayerFS (§4.2)?
7. **Image for project sessions:** add "Use for new Sandboxes" in the Images section
   (`machine update <m> --image <id>`, LayerFS's own default), or keep the default rule as is?
8. **Stopped machines:** should `machine.images` answer a stopped machine from a host-side index,
   so the plugin needs no in-memory stale copy?
9. **Root-owned files:** unpack makes every file root-owned and drops setuid, so images that check
   ownership (postgres' data directory, for example) may misbehave. Accept for now, or ask LayerFS
   to keep owners?
