/**
 * The Machines page's data: the host's shapes (LayerFS Connect's
 * `host-api.ts`, served unchanged by the dsh-layerfs `http` operation) and
 * the pure helpers that turn `GET /api/machines` into what the page shows
 * (Connect's `compute.ts` and `states.ts`). Words are locale keys; the
 * components translate them.
 *
 * Connect never derives a state: it shows the SDK's `state`, and an `op` in
 * flight adds its name and phase. Power is manual: a machine runs between
 * Start and Stop and no read starts one. ssh and Firecracker machines are
 * turned off: the host leaves them out of home get --with platforms.
 */
import type { Tone } from '../ui/index.tsx'
import { parseTag, type CallLabel } from '../../shared/logs.ts'
import { removesMachine, runnableFix } from '../../shared/doctor.ts'
import { HOST_PLATFORM, PROCESS_BACKEND } from '../../shared/host-machine.ts'
import type { MachinesKey } from './locale.ts'

// ---------- host shapes ----------

/** The public SDK operation view. */
export interface SdkOperation {
  id: string
  name: string
  phase: string
  started: number | null
  uncertain: boolean
}

/** What a machine supports, as `machine list --detail` lists it: `sqlite`, `postgresql_sandbox`, `log` (it has a worker log). */
export type MachineSupport = 'sqlite' | 'postgresql_sandbox' | 'log' | (string & {})

/** Whether a machine's `supports` list has `what`; a machine without the list is not ruled out (`unknown` answers undefined). */
export const supports = (m: { supports?: readonly string[] | null } | null | undefined, what: MachineSupport): boolean | undefined =>
  (m?.supports ? m.supports.includes(what) : undefined)

export interface PlatformOption {
  /** The create option's name (`cpus`, `memory`, `disk`, `image`, `os_image`). */
  option: string
  kind: string
  /** What machine.create takes when it is not given (cpus 2; memory and disk in bytes, or a LayerFS size such as `4GiB`); absent from an older CLI. */
  default?: number | string | null
}

/** docker's socket as LayerFS reports it (`home get --with platforms`, docs/specs/layerfs-setup.md §2.3). */
export interface DockerSocket {
  path: string | null
  /** `recorded` (the machine's own), `env:DOCKER_HOST`, `context:<name>`, `desktop`, `colima`, `orbstack` or `default`. */
  source: string | null
  state: 'answering' | 'absent' | 'denied' | 'silent' | string | null
}

/** One Docker endpoint the host names; `usable: false` for one that is not a `unix://` socket. */
export interface DockerCandidate {
  path: string | null
  source: string | null
  /** A non-unix endpoint (`tcp://…`), listed but never followed. */
  host?: string
  usable?: false
}

/** One `home get --with platforms` item: readiness and create options. */
export interface MachinePlatformInfo {
  platform: string
  how: string
  backend: string | null
  /** How Workspaces are served: `nfs` (the macOS host machine) or `fuse`. */
  route: string | null
  sqlite: string | null
  postgresql: { store_calls: string, sandbox: boolean, reason: string | null }
  ready: boolean
  missing: string[]
  version: string | null
  options: PlatformOption[]
  description: string
  /** docker only, from a CLI with the setup fields: the socket in use and what it does. */
  socket?: DockerSocket
  /** docker only: every endpoint the host names (the Settings dialog's choices). */
  candidates?: DockerCandidate[]
}

/**
 * One machine (`machine list --detail`, then `machine get --detail --with
 * live` for each machine). `state` is one of LayerFS 2.0's six:
 * `ready`, `busy` (with `op`), `stopped`, `broken` (with `reason` and `fix`),
 * `unknown` (with `observedAt`); a machine is never `blocked`.
 */
export interface MachineInfo {
  name: string
  platform: string
  backend: string | null
  state: string
  op?: SdkOperation | null
  /** `broken`: why, as a code (`engine_down`, `not_answering`, `outdated`, `unreachable`, `missing`, `failed`, `unresolved`, `lost`, `unsupported`). */
  reason?: string | null
  /** `broken`: one runnable shell line that repairs it (two commands joined with `&&`). */
  fix?: string | null
  /** The sentence behind a state that is not ready. */
  message?: string | null
  /** When LayerFS last knew its state (ISO). */
  observedAt?: string | null
  supports?: readonly MachineSupport[]
  cpus: number | null
  memory: number | null
  disk: number | null
  /** The first 20 names (`storesCount` / `sandboxesCount` are all of them). */
  stores: string[]
  sandboxes: string[]
  storesCount?: number
  sandboxesCount?: number
  image?: string
  osImage?: string
  docker?: string
  wsl?: string
  daemon?: string
}

/** A sqlite Store on a machine. */
export interface MachineStore {
  state?: string
  op?: SdkOperation | null
  /** 2.0 state companions: `blocked_by` when its machine is not ready, `reason` and `fix` when broken. */
  blockedBy?: { machine?: string, reason: string }
  reason?: string
  fix?: string
  name: string
  machine: string
  projects: number
  names?: string[]
  size: number | null
}

/** A PostgreSQL Store: on no machine; Sandboxes on a machine that supports it reach its database. */
export interface MachinePgStore {
  /** The machines attached to it (`store attach`), with the last reach's word. */
  attached?: { machine: string, reached: string | null }[]
  state?: string
  op?: SdkOperation | null
  name: string
  projects: number
  names?: string[]
}

/** A Sandbox on a machine (sandbox.list()). */
export interface MachineSandbox {
  state?: string
  op?: SdkOperation | null
  /** 2.0 state companions: `blocked_by` when blocked, `reason` and `fix` when broken. */
  blockedBy?: { machine?: string, reason: string }
  reason?: string
  fix?: string
  message?: string
  backend?: string | null
  route?: string | null
  image?: string | null
  name: string
  machine: string | null
  project: string | null
  workspaces: number | null
  /**
   * Whether its daemon process runs now (sandbox.list `live`, layerfs-project#164):
   * absent from a CLI without the option, `null` when LayerFS could not
   * observe it (`liveReason` says why: `machine_stopped`, `deadline`, …).
   */
  live?: boolean | null
  liveReason?: string
}

/** A machine's `--with live` section (`machine get`), or why its probe could not be made (`error`). */
export interface MachineLive {
  name: string
  freeDisk: number | null
  toolVersion: string | null
  worker: { protocol: string | null, bundle: string | null } | null
  error?: { code: string, message: string }
}

/** What the pinned LayerFS CLI can do beyond the calls every CLI has (host `featuresOf`, docs/specs/sandbox-images.md §4.2). */
export interface CliFeatures {
  /** machine.stop takes force. */
  forceStop: boolean
  /** machine.images: a machine's cached Sandbox images. */
  images: boolean
  /** machine.load_image: copy an image to a machine without a Sandbox. */
  imageLoad?: boolean
  /** machine.prune: remove cached images. */
  imagePrune?: boolean
  /** sandbox.create --image takes a Docker reference or Id, not only a digest. */
  imageRefs?: boolean
  /** sandbox.create reports progress phases (inspect, export, send, unpack, start). */
  createProgress?: boolean
  /** The bundle carries the Sandbox runtime layer. */
  sandboxRuntime?: boolean
  /** 1: images from Docker, sizes and free space; 0: the ready group from the archive only. */
  imageStage?: 0 | 1
  /** Monitoring reads the pinned CLI has (layerfs-project#178, #164): a part shows only when its call is there. Absent from an older host. */
  inspect?: { machineLog: boolean, sandboxLog: boolean, files: boolean, machineFiles: boolean, machineStats?: boolean }
  /** `layerfs machine stats --with space`: where a machine's data disk goes. */
  machineSpace?: boolean
}

/** The computer this host runs on (the host machine): its OS names and marks it. */
export interface Computer {
  os: 'macos' | 'linux' | 'windows' | 'other'
  /** The OS release in words (macOS 15.4, Ubuntu 24.04.1 LTS), or null. */
  name: string | null
  arch: string
}

export interface AvailableView {
  available: true
  computer: Computer
  readErrors?: Record<string, { error: { code: string, message: string }, at: number }>
  layerfs: string | null
  /** Absent from an older host: everything is offered and LayerFS refuses what it lacks. */
  features?: CliFeatures
  machines: MachineInfo[]
  platforms: MachinePlatformInfo[]
  stores: MachineStore[]
  postgresql: MachinePgStore[]
  sandboxes: MachineSandbox[]
  /** Each machine: its live probe. */
  live: Record<string, MachineLive>
}

/** GET /api/machines. */
export type MachinesView = AvailableView | { available: false, layerfs: string | null, reason: string }

/** POST /api/machines. */
export interface NewMachine {
  platform: string
  name: string
  cpus?: number
  memory?: number
  disk?: number
  image?: string
  /** `stock`: the provider's stock OS image even when a prepared one exists (only when the platform declares `os_image`). */
  os_image?: string
}

export interface WorkspaceInfo {
  ws: string
  /** The Workspace's own id (sandbox.get's `workspace`), as a files answer names a Workspace mount. */
  wsId?: string | null
  name?: string | null
  branch: string
  path: string
  activity?: string | null
  base?: string | null
  baseLayer?: string | null
  headMovedSinceMount?: boolean | null
  dirty?: { inodes: number, entries: number } | null
  pendingMerge?: boolean | null
  root?: string | null
  revision?: unknown
  /**
   * The commands LayerFS says are running here, oldest first, whoever started
   * them (sandbox.get `running`). Absent from an older worker (unknown); null
   * when the records could not be read.
   */
  running?: RunningCommand[] | null
  /** The size of the Workspace's overlay file; it grows until unmount. Absent from an older worker; null when not observed. */
  overlayBytes?: number | null
  /**
   * What the Workspace's own cgroup (`ws-<workspace>`, its commands) has used,
   * as a Sandbox's `usage`. Absent from a worker that does not report usage
   * per Workspace; null with `usageReason` when there was none to read (LayerFS
   * removes the group once no command runs, so its CPU time starts again).
   */
  usage?: { cpuUsec: number | null, memoryCurrent: number | null, memoryPeak: number | null, pids: number | null } | null
  usageReason?: string
}

/** One command running in a Workspace, as sandbox.get reports it. */
export interface RunningCommand {
  execId: string
  /** When it started, epoch ms (0 when LayerFS gave no time). */
  started: number
  /** The log tag of the call that started it. */
  tag: string | null
  /** The command's first word. */
  program: string | null
  /** A Sandbox page of this host started it: its terminal shows it. */
  own?: boolean
  /** The project session its tag names (the host's label, as on the Logs page). */
  session?: CallLabel
}

/** sandbox.get `daemon_capacity`: the daemon's control admission and the connection failures it kept (best effort). */
export interface DaemonCapacity {
  admission?: { pool_vacant?: number, pool_running?: number, reserved_vacant?: number, reserved_running?: number } | null
  retained?: {
    limit?: number, ttl_ms?: number, count?: number, dropped?: number
    failures?: readonly { slot?: string | number, class?: string, cause?: string, age_ms?: number, expires_in_ms?: number, request?: string }[]
  } | null
}

/** GET /api/workspaces/<ws>/status (`workspace status --detail`, 2.0). */
export interface WorkspaceStatus {
  changes: { path: string, change: 'added' | 'modified' | 'removed', type?: string }[]
  changes_count?: number | null
  partial?: boolean | null
  branch_moved?: boolean | null
  state?: string | null
  branch?: string | null
  commit?: string | null
  base_layer?: string | null
  branch_head?: string | null
  activity?: string | null
  overlay?: { inode_count: number, entry_count: number } | null
  pending_merge?: boolean | null
}

/** One command a Sandbox page ran (host routes/commands.ts). */
export interface SandboxCommand {
  id: string
  ws: string
  sandbox: string
  command: string
  state: 'running' | 'exited' | 'cancelled' | 'failed' | 'unknown'
  startedAt: number
  finishedAt: number | null
  exitCode: number | null
  stdout: string
  stderr: string
  stdoutBytes: number
  stderrBytes: number
  /** The stream's kept bytes are not text (its text is then empty). */
  stdoutBinary?: boolean
  stderrBinary?: boolean
  error: { code: string, message: string } | null
}

/** GET /api/sandboxes/<name> (sandbox.get). */
export interface SandboxInfo {
  id: string
  name: string
  /** The conversation that owns this Sandbox today (a project session's own Sandbox); absent for any other. */
  sessionId?: string
  state: string
  op?: SdkOperation | null
  /** 2.0 state companions: `blocked_by` when blocked, `reason` and `fix` when broken, `observedAt` when unknown. */
  blockedBy?: { machine?: string, reason: string }
  reason?: string
  fix?: string
  message?: string
  observedAt?: number
  backend?: string | null
  route?: string | null
  project?: string | null
  refusal?: { code: string, message: string, detail?: unknown } | null
  image: string | null
  machine: string | null
  platform?: string
  created?: number | null
  daemonCapacity?: DaemonCapacity | null
  workspaces: WorkspaceInfo[]
  /** How many Workspaces one Sandbox holds (sandbox.get `workspace_capacity`); absent from an older CLI. */
  workspaceCapacity?: number
  /** The daemon process as the side that runs it sees it (layerfs-project#164): `startedAt` null once it has ended; null when not observed; absent from an older CLI. */
  daemon?: { pid: number | null, startedAt: number | null } | null
  /** What the Sandbox's own cgroup has used; null with `usageReason` when there is none to read. */
  usage?: { cpuUsec: number | null, memoryCurrent: number | null, memoryPeak: number | null, pids: number | null } | null
  /** Why `usage` is null (`host_process`, `cgroup_v1`, `no_cgroup`, `not_observed`), or why a usage that is there has null memory or process counts (`no_controller`). */
  usageReason?: string
  unread?: boolean
}

/** Why an image cannot run on a machine (its tag in the Image menu). */
export interface ImageReason { kind: 'arch' | 'os' | 'no-glibc' | 'compressed' | 'device-node', value?: string }

/** One image that starts at once on the machine (the "On <machine>, ready" group). */
export interface ReadyImage {
  id: string
  /** The first ref, or "LayerFS default" for `source: 'bundle'` (the client says it in its words). */
  name: string
  refs: string[]
  size: number | null
  source: 'bundle' | 'machine' | 'imported'
  sandboxes: number
  lastUsed: string | null
  usable: boolean
  reason?: ImageReason
  /** LayerFS 2.0 spec v19: `busy` while a copy holds it (`op`), `broken` for a partial copy (`fix` resumes it). */
  state?: 'busy' | 'broken'
  op?: { name: string, phase: string, started: number | null } | null
  partial?: boolean
  staged?: number
  fix?: string
}

/** One image of this computer's Docker (Stage 1 only). */
export interface DockerImage {
  id: string
  name: string
  refs: string[]
  size: number
  architecture: string
  os: string
  need: number
  fits: boolean
  usable: boolean
  reason?: ImageReason
}

/** GET /api/machines/<name>/sandbox-images: what a Sandbox on the machine can start from. */
export interface SandboxImagesView {
  machine: string
  platform: string
  state: string
  stage: 0 | 1
  /** `host`: the macOS host machine (`process` backend), Sandboxes run on the Mac itself (no Image row). */
  mode: 'images' | 'host'
  architecture: string | null
  free: number | null
  /** The id of the preselected ready row (D7). */
  default: string | null
  observedAt: number
  /** The ready rows are the last answer kept in memory: a stopped machine, or an archive read that failed (`message` says why). */
  stale: false | { at: number, code: string, message?: string }
  ready: ReadyImage[]
  docker: null
    | { available: false, reason: 'not-installed' | 'not-running' | 'error', message?: string }
    | { available: true, images: DockerImage[] }
}

/** POST /api/machines/<name>/prune-images: the ids removed, the bytes freed, and the images LayerFS kept (InUse, …). */
export interface PruneAnswer { removed: string[], freed: number, refused: { id: string, code: string, message: string }[] }

/** An image copy the host runs in the background (host `ImageLoads`): `POST /api/machines/<name>/load-image`, `GET /api/image-loads` and `image-load` events. */
export interface ImageLoad {
  id: string
  machine: string
  /** The Docker image's Id, as the client sent it. */
  image: string
  phase: 'queued' | 'inspect' | 'lock' | 'export' | 'send' | 'unpack' | 'done' | 'failed'
  done?: number
  total?: number
  reused?: boolean
  error?: { code: string, message: string, detail?: unknown, fix?: string }
  startedAt: number
  updatedAt: number
}

/** A Sandbox create's phase (host `SandboxCreates`). */
export type CreationPhase = 'queued' | 'machine' | 'inspect' | 'lock' | 'export' | 'send' | 'unpack' | 'start' | 'mount' | 'done' | 'failed'

/** A Sandbox create the host runs in the background: the admission answer, `GET /api/sandbox-creates` and `sandbox-progress`. */
export interface Creation {
  id: string
  input: { project: string, name: string, machine: string, image?: string, start?: boolean }
  phase: CreationPhase
  done?: number
  total?: number
  error?: { code: string, message: string, detail?: unknown, fix?: string }
  startedAt: number
  updatedAt: number
}

/** GET /api/projects rows the New Sandbox dialog reads. */
export interface ProjectSummary {
  name: string
  key: string
  kind: string | null
  machine: string | null
}

/** `runtime.status`: the pinned LayerFS. */
export interface RuntimeStatus {
  ok: boolean
  cli: string | null
  daemon: string | null
  bundle?: string | null
  bundleInfo?: { hash: string | null, source: string | null } | null
  /** The cache home prepared machine images are read from, where it came from, and how many it holds. */
  cacheHome?: string
  cacheHomeSource?: 'config' | 'settings' | 'env' | 'inherited' | 'default'
  preparedImages?: number
  home: string
  root?: string
  source?: string
  version: string | null
  commit: string | null
  features?: readonly string[]
  /** The Node SDK agents get as `$DSH_LAYERFS_SDK` (built from `commit`), or null; `sdkDir` is where it is looked for. */
  sdk?: { dir: string, commit: string } | null
  sdkDir?: string | null
  error: { code: string, message: string } | null
}

/** A key and its values, for `t`. */
export interface Words { key: MachinesKey, values?: Record<string, string> }
const w = (key: MachinesKey, values?: Record<string, string | number>): Words =>
  ({ key, ...(values ? { values: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v)])) } : {}) })

// ---------- states ----------

export type Entity = 'machine' | 'store' | 'sandbox'

export interface StateLook {
  tone: Tone
  label: MachinesKey | null
  /** The word as it came, when LayerFS says one this page does not know. */
  raw?: string
  live?: boolean
  dashed?: boolean
  attention?: boolean
}

const LOOK: Record<Entity, Record<string, StateLook>> = {
  // LayerFS 2.0's six states; `busy` and `broken` are worded by their companion (machineState)
  machine: {
    ready: { tone: 'success', label: 'stateRunning' },
    busy: { tone: 'warning', label: 'stateBusy', live: true },
    stopped: { tone: 'neutral', label: 'stateStopped' },
    broken: { tone: 'danger', label: 'stateBroken', attention: true },
    blocked: { tone: 'warning', label: 'stateBlocked' },
    unknown: { tone: 'neutral', label: 'stateUnknown', dashed: true },
  },
  // a Store: ready, busy (move, remove, compact, backup, restore), blocked by its machine, broken (unresolved, missing, unreachable), unknown
  store: {
    ready: { tone: 'success', label: 'ready' },
    busy: { tone: 'warning', label: 'stateBusy', live: true },
    stopped: { tone: 'neutral', label: 'stateStopped' },
    blocked: { tone: 'warning', label: 'stateBlocked' },
    broken: { tone: 'danger', label: 'stateBroken', attention: true },
    unknown: { tone: 'neutral', label: 'stateUnknown', dashed: true },
  },
  // a Sandbox: ready (its daemon runs), busy (create, remove), blocked by its machine, broken (lost, not_answering, missing, unresolved, unsupported), unknown
  sandbox: {
    ready: { tone: 'success', label: 'stateRunning' },
    busy: { tone: 'warning', label: 'stateBusy', live: true },
    stopped: { tone: 'neutral', label: 'stateStopped' },
    blocked: { tone: 'warning', label: 'stateBlocked' },
    broken: { tone: 'danger', label: 'stateBroken', attention: true },
    unknown: { tone: 'neutral', label: 'stateUnknown', dashed: true },
  },
}

/** How `state` of an `entity` looks; an unknown word is shown as it came. */
export function stateLook(entity: Entity, state: string | null | undefined): StateLook {
  return LOOK[entity][state || 'unknown'] ?? { tone: 'neutral', label: null, raw: state || '', dashed: !state }
}

/** An operation in words: `store.move · send`. */
export function opWords(op: SdkOperation | null | undefined): string | null {
  if (!op) return null
  // a phase that only repeats the op's name (`stop · stop`) is said once
  const same = op.phase === op.name || op.phase === op.name.replace(/^[a-z_]+\./, '')
  return [op.name, same ? null : op.phase].filter(Boolean).join(' · ')
}

/**
 * The status call that shows an unresolved entity, and the call that clears
 * it: LayerFS's own `fix` line when it gave one (2.0 names the clearing call
 * on every `broken`/`unresolved` thing), else the family's remove.
 */
export function clearingCall(entity: Entity, name: string, _op?: SdkOperation | null, fix?: string | null): { status: string, clear: string } {
  if (entity === 'store') return { status: `layerfs store get ${name} --with live`, clear: fix ?? `layerfs store remove ${name}` }
  if (entity === 'machine') return { status: `layerfs machine get ${name} --with live`, clear: fix ?? `layerfs machine remove ${name}` }
  return { status: `layerfs sandbox get ${name}`, clear: fix ?? `layerfs sandbox remove ${name}` }
}

/** A busy thing's word by its op (2.0 `op.name`: a call word, with or without its family). */
const BUSY_LABEL: Record<string, MachinesKey> = {
  create: 'stateCreating', start: 'stateStarting', stop: 'stateStopping', remove: 'stateRemoving', move: 'stateMoving', compact: 'stateCompacting',
  backup: 'stateBackingUp', restore: 'stateRestoring', mount: 'stateMounting', commit: 'stateCommitting', unmount: 'stateUnmounting', load_image: 'stateCopying',
}
/** The word a busy thing shows for an op (`stop` or `machine.stop` -> Stopping), if this page has one. */
export const busyWordOf = (name: string): MachinesKey | undefined => BUSY_LABEL[name.replace(/^[a-z_]+\./, '')]
/** A broken thing's word by its reason (2.0 `state_companions.broken.reason`). */
const BROKEN_LABEL: Record<string, MachinesKey> = {
  engine_down: 'stateEngineDown', not_answering: 'stateNotAnswering', outdated: 'stateOutdated', unreachable: 'stateUnreachable',
  missing: 'stateMissing', failed: 'stateFailed', unresolved: 'stateUnresolved', lost: 'stateLost', unsupported: 'stateUnsupported', partial: 'statePartial',
}

/** A Store's or Sandbox's look: its 2.0 state, worded by its companion (a busy op's name, a broken reason). */
export function thingLook(entity: Entity, x: { state?: string | null, op?: SdkOperation | null, reason?: string | null }): StateLook {
  const state = x.state || 'unknown'
  const look = stateLook(entity, state)
  if (state === 'busy' && x.op) return { ...look, label: BUSY_LABEL[x.op.name.replace(/^[a-z]+\./, '')] ?? look.label }
  if (state === 'broken' && x.reason) return { ...look, label: BROKEN_LABEL[x.reason] ?? look.label }
  return look
}

/** A Sandbox whose daemon is gone (broken `lost` or `missing`): its record and run folder stay until removed. */
export const sandboxGone = (b: { state?: string | null, reason?: string | null }): boolean => b.state === 'broken' && (b.reason === 'lost' || b.reason === 'missing')
/** A Sandbox LayerFS is creating (busy with op create). */
export const sandboxCreating = (b: { state?: string | null, op?: SdkOperation | null }): boolean => b.state === 'busy' && !!b.op && /(^|\.)create$/.test(b.op.name)
/** A thing whose outcome LayerFS does not know (broken `unresolved`). */
export const unresolvedOf = (x: { state?: string | null, reason?: string | null }): boolean => x.state === 'broken' && x.reason === 'unresolved'

// ---------- machines ----------

export const GIB = 2 ** 30
export const VM_KINDS = ['apple-container', 'microsandbox', 'lima'] as const
/** The built-in machines' platforms: the host machine (`host`) and `docker`. */
export const BUILT_IN = new Set([HOST_PLATFORM, 'docker'])
/** The built-in machines' names, refused for a new machine or Sandbox. */
export const BUILT_IN_NAMES = new Set(['macos-host', 'linux-host', 'docker'])

/**
 * Whether New machine opens: some platform here creates machines (a VM kind),
 * ready or not. A platform that is not ready yet still opens the dialog, which
 * shows its readiness ladder and the fix (install, setup) that makes it ready.
 */
export const canAddMachine = (platforms: readonly Pick<MachinePlatformInfo, 'platform' | 'how'>[]): boolean =>
  platforms.some((p) => p.how === 'created' && (VM_KINDS as readonly string[]).includes(p.platform))

const KIND_LABEL: Record<string, MachinesKey> = {
  host: 'kindHost',
  docker: 'kindDocker',
  'apple-container': 'kindAppleContainer',
  microsandbox: 'kindMicrosandbox',
  lima: 'kindLima',
}
/** A platform's name key, or null for a raw name shown as it came. */
export const kindKey = (platform: string): MachinesKey | null => KIND_LABEL[platform] ?? null

const KIND_BLURB: Record<string, MachinesKey> = {
  host: 'blurbHost',
  docker: 'blurbDocker',
  'apple-container': 'blurbAppleContainer',
  microsandbox: 'blurbMicrosandbox',
  lima: 'blurbLima',
}
export const blurbKey = (platform: string): MachinesKey | null => KIND_BLURB[platform] ?? null

/** LayerFS's defaults for a new VM. */
export const VM_DEFAULTS = { cpus: 2, memory: 4 * GIB, disk: 20 * GIB } as const

/** The host machine and Docker first, then the rest by name. */
export function machineOrder(machines: MachineInfo[]): MachineInfo[] {
  const rank = (m: MachineInfo) => (m.platform === HOST_PLATFORM ? 0 : m.platform === 'docker' ? 1 : 2)
  return [...machines].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

/** How a machine's state is counted on the board: `running` is `ready`, `needs` is `broken`. */
export type MachineKey = 'running' | 'stopped' | 'busy' | 'needs' | 'unknown'

/** A busy machine's word by its op (`create`, `start`, `stop`, `remove`). */
const OP_LABEL: Record<string, MachinesKey> = { create: 'stateCreating', start: 'stateStarting', stop: 'stateStopping', remove: 'stateRemoving' }
/** A broken machine's word by its reason. */
const REASON_LABEL: Record<string, MachinesKey> = {
  engine_down: 'stateEngineDown', not_answering: 'stateWorkerDown', outdated: 'stateOutdated', unreachable: 'stateUnreachable',
  missing: 'stateMissing', failed: 'stateFailed', unresolved: 'stateUnresolved', lost: 'stateLost', unsupported: 'stateUnsupported',
}

/**
 * A machine whose record LayerFS cannot read: listed `broken` with reason
 * `failed`, no platform and the fix `layerfs machine doctor <name>`. Its
 * get, remove and update are refused `Failed`; the Doctor names what is wrong.
 */
export const unreadableRecord = (m: Pick<MachineInfo, 'state' | 'reason' | 'platform'>): boolean => m.state === 'broken' && m.reason === 'failed' && !m.platform

/**
 * The machine whose record a refused read names as unreadable
 * (`…/machine/<name>/record.json: <parse error>`), or null (UI pass 3 F9).
 */
export function unreadableNamed(error: unknown): string | null {
  const message = error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string' ? (error as { message: string }).message : ''
  return /\/machine\/([^/\s]+)\/record\.json\b/.exec(message)?.[1] ?? null
}

/**
 * The last machines view after a read that failed because one record cannot be
 * read (UI pass 3 F9): that machine shows as LayerFS lists an unreadable record
 * (broken `failed`, no platform, its message), so its page and row stop
 * offering Stop and stop reading Running/Healthy; the rest stay as last read.
 */
export function staleView<V extends { available?: boolean, machines?: MachineInfo[] }>(view: V | null, error: unknown): V | null {
  const name = unreadableNamed(error)
  if (!view || !name || !view.available || !view.machines?.some((m) => m.name === name)) return view
  const message = (error as { message: string }).message
  return { ...view, machines: view.machines.map((m) => (m.name === name ? { ...m, state: 'broken', reason: 'failed', platform: '', fix: `layerfs machine doctor ${name}`, message } : m)) }
}

/**
 * The disk line's words when no free space was read: an unreadable record
 * says so (its platform and disk are not known, whatever runs), "while
 * stopped" only for a stopped machine, else "not reported".
 */
export function unreportedDiskKey(m: Pick<MachineInfo, 'state' | 'reason' | 'platform'>): 'diskRecordUnreadable' | 'diskWhileStopped' | 'diskUnreported' {
  if (unreadableRecord(m)) return 'diskRecordUnreadable'
  return m.state === 'stopped' ? 'diskWhileStopped' : 'diskUnreported'
}

/** A machine's state as LayerFS gives it (one of the six), worded by its companion: a busy op's name, a broken reason. */
export function machineState(m: MachineInfo, _live?: MachineLive): StateLook & { key: MachineKey, state: string, op: SdkOperation | null } {
  const state = m.state || 'unknown'
  const look = stateLook('machine', state)
  const op = m.op ?? null
  if (state === 'busy') return { ...look, label: (op && OP_LABEL[op.name.replace(/^machine\./, '')]) || look.label, key: 'busy', state, op }
  if (state === 'broken') return { ...look, label: unreadableRecord(m) ? 'stateUnreadable' : recordOutdated(m) ? 'stateRecordOutdated' : vmGone(m) ? 'stateVmGone' : (m.reason && REASON_LABEL[m.reason]) || look.label, key: 'needs', state, op }
  const key: MachineKey = state === 'ready' ? 'running' : state === 'stopped' ? 'stopped' : 'unknown'
  return { ...look, key, state, op }
}

/** The board's order rank. */
export const RANK: Record<MachineKey, number> = { needs: 0, busy: 1, running: 2, stopped: 3, unknown: 4 }

/** Why a machine needs you or did not answer, in LayerFS's words (its state's `message`, else why its live probe failed); a plain stop is not a reason. */
export const downReason = (m: MachineInfo, live?: MachineLive): string | null => (m.state === 'stopped' || m.state === 'ready' ? null : m.message ?? live?.error?.message ?? null)

/** Binary sizes as LayerFS gives them (8 GiB, 40 GiB). */
export function gib(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const g = n / GIB
  if (g >= 1) return `${Number.isInteger(g) ? g : g.toFixed(1)} GiB`
  return `${Math.round(n / 2 ** 20)} MiB`
}

/** "1.2 MB", "340 KB": decimal units. */
export function bytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  if (n < 1000) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1000
  let i = 0
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++ }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

/** A Docker image digest cut to its first twelve hex digits; an archive path to its file name. */
export const shortImage = (ref: string | null | undefined): string =>
  !ref ? '—' : ref.startsWith('/') ? ref.slice(ref.lastIndexOf('/') + 1) : ref.replace(/^(sha256:)?([0-9a-f]{12})[0-9a-f]+$/, (_, p: string | undefined, h: string) => `${p ?? ''}${h}…`)

/**
 * The sqlite Stores a machine holds: every store.list row on it (the record's
 * `stores` names only the first 20), and one store.list omits still by name.
 */
export function storesOn(view: AvailableView, m: MachineInfo): MachineStore[] {
  const listed = view.stores.filter((s) => s.machine === m.name)
  return [...listed, ...m.stores.filter((name) => !listed.some((s) => s.name === name)).map((name) => ({ name, machine: m.name, projects: 0, size: null }))]
}

/** A machine's Sandboxes from sandbox.list() (all of them; the record names 20), by project then name; one it omits still shows by name. */
export function sandboxesOn(view: AvailableView, m: MachineInfo): MachineSandbox[] {
  const listed = view.sandboxes.filter((x) => x.machine === m.name)
  const rows = [...listed, ...m.sandboxes.filter((b) => !listed.some((x) => x.name === b)).map((b) => ({ name: b, machine: m.name, project: null, workspaces: null }))]
  return rows.sort((a, b) => Number(!a.project) - Number(!b.project) || (a.project ?? '').localeCompare(b.project ?? '') || a.name.localeCompare(b.name, undefined, { numeric: true }))
}

/** The facts line's numbers. */
export function factsOf(view: AvailableView) {
  const n: Record<MachineKey, number> = { running: 0, stopped: 0, busy: 0, needs: 0, unknown: 0 }
  for (const m of view.machines) n[machineState(m, view.live[m.name]).key]++
  const ops = [...view.machines.filter((m) => m.op), ...view.stores.filter((s) => s.op), ...view.sandboxes.filter((b) => b.op)].length
  const workspaces = view.sandboxes.reduce((sum, b) => sum + (b.workspaces ?? 0), 0)
  return { ...n, ops, sandboxes: view.sandboxes.length, workspaces, workspacesKnown: !view.sandboxes.some((b) => b.workspaces == null) }
}

/** How many Stores and Sandboxes a machine holds: the record's counts (its name lists stop at 20). */
export const heldStores = (m: Pick<MachineInfo, 'stores' | 'storesCount'>): number => m.storesCount ?? m.stores.length
export const heldSandboxes = (m: Pick<MachineInfo, 'sandboxes' | 'sandboxesCount'>): number => m.sandboxesCount ?? m.sandboxes.length

/** Remove refuses while a machine holds Stores or Sandboxes (InUse): the reason, or null. */
export function inUse(m: MachineInfo): { stores: number, sandboxes: number } | null {
  const stores = heldStores(m), sandboxes = heldSandboxes(m)
  return stores || sandboxes ? { stores, sandboxes } : null
}

/** Why Remove is refused before it is asked. */
export function heldWords(held: { stores: number }): Words {
  return held.stores > 0 ? w(held.stores === 1 ? 'heldOneStore' : 'heldStores', { n: held.stores }) : w('heldSandboxes')
}

/**
 * A VM or worker LayerFS cannot reach: `broken` with a reason a start or a
 * restart repairs (`not_answering`, `outdated`, `unreachable`, `engine_down`,
 * `missing`). Its `fix` says how; {@link fixAction} says what the page runs.
 */
export const workerDown = (m: MachineInfo, _live?: MachineLive): boolean =>
  m.state === 'broken' && ['not_answering', 'outdated', 'unreachable', 'engine_down'].includes(m.reason ?? '') && !recordOutdated(m)

/**
 * A machine whose VM or container is gone (LayerFS reason `missing`, fix
 * `layerfs machine remove M`; M FAIL 9): not a worker that does not answer.
 * Nothing to restart or stop; LayerFS's fix is the one action.
 */
export const vmGone = (m: Pick<MachineInfo, 'platform' | 'state' | 'reason'>): boolean =>
  m.platform !== HOST_PLATFORM && m.state === 'broken' && m.reason === 'missing'

/**
 * An `outdated` record no call repairs (UI pass 3 R FAIL 2): a record with no
 * vm_name, whose LayerFS fix removes the record (`layerfs machine remove M`,
 * after its Stores: `layerfs store remove S && layerfs machine remove M`).
 * Its worker is not "not answering": nothing to restart or stop, the fix is the remove.
 */
export const recordOutdated = (m: Pick<MachineInfo, 'name' | 'state' | 'reason' | 'fix'>): boolean =>
  m.state === 'broken' && m.reason === 'outdated' && removesMachine(runnableFix(m.fix)) === m.name

/** Start or Stop: Stop when it is ready, Start when it is stopped (the host machine too: LayerFS stops and starts it). */
export const powerOf = (m: MachineInfo): 'start' | 'stop' | null =>
  (m.state === 'ready' || m.state === 'stopped') ? (m.state === 'ready' ? 'stop' : 'start') : null

/**
 * The one action a machine's state offers (UI rule: dot, word, tip, one
 * action): from its `fix` line when it is one this page runs (`machine start`,
 * or `machine stop && machine start` with no Sandbox on it), Start that first
 * launches Docker for `engine_down`, Check (a live read) for `unresolved` or
 * `unknown`; a `--force` restart is offered off, with the line to copy.
 * `remove`: `layerfs machine remove M`, the fix of a record with no vm_name
 * (records only; a built-in comes back fresh), run behind a confirm press.
 * Null when there is none.
 */
export type FixAction =
  | { kind: 'start' | 'restart' | 'engine' | 'check' | 'remove' }
  /** LayerFS's multi-command fix the page runs step by step behind one confirm press (`layerfs store remove S && layerfs machine remove M`). */
  | { kind: 'chain', line: string }
  | { kind: 'forced', sandboxes: number, line: string }
  | { kind: 'copy', line: string }
export function fixAction(m: MachineInfo): FixAction | null {
  if (m.state === 'unknown') return { kind: 'check' }
  if (m.state !== 'broken') return null
  if (m.reason === 'engine_down') return { kind: 'engine' }
  if (m.reason === 'unresolved') return { kind: 'check' }
  const line = m.fix ?? ''
  const commands = line.split('&&').map((c) => c.trim()).filter(Boolean)
  const word = (c: string, verb: string, force = false) => c.split(/\s+/).join(' ') === ['layerfs', 'machine', verb, m.name, ...(force ? ['--force'] : [])].join(' ')
  if (commands.length === 1 && word(commands[0]!, 'start')) return { kind: 'start' }
  if (commands.length === 1 && word(commands[0]!, 'remove')) return { kind: 'remove' }
  if (commands.length === 2 && word(commands[0]!, 'stop') && word(commands[1]!, 'start')) return heldSandboxes(m) ? { kind: 'forced', sandboxes: heldSandboxes(m), line } : { kind: 'restart' }
  if (commands.length === 2 && word(commands[0]!, 'stop', true) && word(commands[1]!, 'start')) return { kind: 'forced', sandboxes: heldSandboxes(m), line }
  // a chain about this very machine (its last step removes it): run step by step, never "Run diagnostics" (UI pass 3 R FAIL 1)
  if (commands.length > 1 && runnableFix(line)?.kind === 'chain' && removesMachine(runnableFix(line)) === m.name) return { kind: 'chain', line }
  return line ? { kind: 'copy', line } : null
}

/** Whether LayerFS's own fix for a machine removes its record (alone, or after its Stores): Remove… is then that machine's fix, built in or not. */
export const fixRemoves = (m: MachineInfo): boolean => { const f = fixAction(m); return f?.kind === 'remove' || f?.kind === 'chain' }

/** Whether LayerFS's fix for a machine is one the page runs behind its one button (start, restart, remove, force): then nothing else is offered beside it. */
export const runsFix = (m: MachineInfo): boolean => { const f = fixAction(m); return !!f && f.kind !== 'copy' && f.kind !== 'check' }

/** Force stop remains available for registered runtimes even when the worker
 * is stopped or unavailable; on the host machine it tears down its Sandboxes and stops it. */
export const forceStopOf = (m: MachineInfo, hasSandboxes = heldSandboxes(m) > 0, features?: CliFeatures): boolean =>
  features?.forceStop !== false && m.platform !== 'ssh' && m.platform !== 'firecracker' && (powerOf(m) === 'stop' || hasSandboxes)

/**
 * A machine's size in a line: what its record was created with (VM defaults
 * for a value it leaves out). A record with no size at all (a machine that
 * shares what it runs on) says only its free disk, or nothing known; decided
 * by what the record holds, never by the platform.
 */
export function sizeOf(m: MachineInfo, live?: MachineLive): Words {
  if (m.cpus == null && m.memory == null && m.disk == null) return live?.freeDisk != null ? w('sizeFree', { free: gib(live.freeDisk) }) : w('sizeNotRecorded')
  const values = { cpus: m.cpus ?? VM_DEFAULTS.cpus, memory: gib(m.memory ?? VM_DEFAULTS.memory), disk: gib(m.disk ?? VM_DEFAULTS.disk) }
  return live?.freeDisk != null ? w('sizeVmFree', { ...values, free: gib(live.freeDisk) }) : w('sizeVm', values)
}

/** How a machine runs its Sandboxes. */
export function runtimeOf(m: MachineInfo): Words {
  if (m.backend === PROCESS_BACKEND) return w('runsProcesses')
  if (m.backend === 'docker') return w('runsContainers')
  if (m.backend === 'namespaces') return w('runsNamespaces')
  return m.backend ? w('raw', { text: m.backend }) : w('runsUnknown')
}

// ---------- Add a machine ----------

// A platform's needs and how to meet them: needs.ts.

/** `8G`, `512M`, `40` (GiB) -> bytes; null when unreadable. */
export function parseSize(text: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kmgt]?)i?b?\s*$/i.exec(text)
  if (!m) return null
  const unit = m[2].toLowerCase()
  const scale = unit === 'k' ? 2 ** 10 : unit === 'm' ? 2 ** 20 : unit === 't' ? 2 ** 40 : GIB
  const out = Math.round(Number(m[1]) * scale)
  return out > 0 ? out : null
}

const NAME = /^[a-z0-9][a-z0-9-]{0,30}$/
const KIND_SHORT: Record<string, string> = { 'apple-container': 'ac', microsandbox: 'msb', lima: 'lima' }

/** A free name for a new machine: `<short><n>`, the lowest n not taken. */
export function freeMachineName(kind: string, machines: MachineInfo[]): string {
  const taken = new Set(machines.map((m) => m.name))
  const short = KIND_SHORT[kind] ?? kind
  for (let n = 1; ; n++) if (!taken.has(`${short}${n}`)) return `${short}${n}`
}

export interface VmForm { name: string, cpus: string, memory: string, disk: string }
export type FormErrors = Partial<Record<keyof VmForm, Words>>

/** A size LayerFS gave (bytes, or a size such as `4GiB`) as the form writes it (`4G`, `512M`); null when unreadable. */
export function sizeText(v: number | string | null | undefined): string | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    if (v % GIB === 0) return `${v / GIB}G`
    if (v % 2 ** 20 === 0) return `${v / 2 ** 20}M`
    return `${Number((v / GIB).toFixed(2))}G`
  }
  if (typeof v === 'string' && parseSize(v) !== null) return v.trim()
  return null
}

/** An option's default as `platforms` reports it (`options[].default`), or undefined. */
const optionDefault = (platform: Pick<MachinePlatformInfo, 'options'> | undefined, name: string) => platform?.options.find((o) => o.option === name)?.default

/**
 * A new VM's form: CPUs, memory and disk from the platform's `options[].default`
 * when LayerFS reports them, else LayerFS's defaults as this page knew them.
 */
export function emptyVm(platform?: Pick<MachinePlatformInfo, 'options'>): VmForm {
  const cpus = optionDefault(platform, 'cpus')
  const cpuText = typeof cpus === 'number' && Number.isInteger(cpus) && cpus > 0 ? String(cpus)
    : typeof cpus === 'string' && /^\d+$/.test(cpus.trim()) ? cpus.trim() : String(VM_DEFAULTS.cpus)
  return {
    name: '',
    cpus: cpuText,
    memory: sizeText(optionDefault(platform, 'memory')) ?? sizeText(VM_DEFAULTS.memory)!,
    disk: sizeText(optionDefault(platform, 'disk')) ?? sizeText(VM_DEFAULTS.disk)!,
  }
}

/** What this computer has for VMs, as `machine stats` of the host machine observed it (null: not observed). */
export interface HostRoom { cpus: number | null, memory: number | null, diskFree: number | null }

/** The room line's facts: this computer, the other VMs' recorded sizes, and what the new one would overcommit. */
export interface Room {
  host: HostRoom
  /** The VMs already made (not the host machine or docker), their recorded sizes summed. */
  others: { count: number, cpus: number, memory: number }
  /** Where the new VM with the others asks for more than this computer has: a warning, never a refusal. */
  over: ('cpus' | 'memory' | 'disk')[]
}

/**
 * The room a new VM has: `host` from the host machine's `machine stats`, the other VMs'
 * recorded CPUs and memory, and which of `ask` (the form's values; null when
 * unreadable) would go past this computer's: CPUs and memory with the others
 * counted, the disk against the free space on the LayerFS folder's disk.
 */
export function roomOf(host: HostRoom, machines: readonly Pick<MachineInfo, 'platform' | 'cpus' | 'memory'>[], ask: { cpus: number | null, memory: number | null, disk: number | null }): Room {
  const vms = machines.filter((m) => !BUILT_IN.has(m.platform))
  const others = { count: vms.length, cpus: vms.reduce((n, m) => n + (m.cpus ?? 0), 0), memory: vms.reduce((n, m) => n + (m.memory ?? 0), 0) }
  const over: Room['over'] = []
  if (host.cpus != null && ask.cpus != null && others.cpus + ask.cpus > host.cpus) over.push('cpus')
  if (host.memory != null && ask.memory != null && others.memory + ask.memory > host.memory) over.push('memory')
  if (host.diskFree != null && ask.disk != null && ask.disk > host.diskFree) over.push('disk')
  return { host, others, over }
}

export function vmErrors(f: VmForm, machines: MachineInfo[]): FormErrors {
  const e: FormErrors = {}
  const n = f.name.trim()
  if (!n) e.name = w('errNameRequired')
  else if (BUILT_IN_NAMES.has(n)) e.name = w('errNameBuiltIn', { name: n })
  else if (!NAME.test(n)) e.name = w('errNameShape')
  else if (machines.some((m) => m.name === n)) e.name = w('errNameTaken', { name: n })
  const cpus = Number(f.cpus)
  if (!Number.isInteger(cpus) || cpus < 1 || cpus > 64) e.cpus = w('errCpus')
  const memory = parseSize(f.memory)
  if (memory === null || memory < 512 * 2 ** 20) e.memory = w('errMemory')
  const disk = parseSize(f.disk)
  if (disk === null || disk < 2 * GIB) e.disk = w('errDisk')
  return e
}

/** The platforms a machine is created on (not the built-ins), in home get --with platforms order. */
export const addable = (platforms: MachinePlatformInfo[]): MachinePlatformInfo[] => platforms.filter((p) => p.how === 'created')

/** Whether `platform` declares create option `name`. */
export const declares = (platforms: MachinePlatformInfo[], platform: string, name: string): boolean =>
  !!platforms.find((p) => p.platform === platform)?.options.some((o) => o.option === name)

// ---------- startup progress ----------

export interface StartupStage { stage: string, state: 'started' | 'completed' | 'failed', at: number, elapsedMs?: number }

/** An observed machine create or start, kept across board and detail navigation. */
export interface MachineStartup {
  id: string
  name: string
  kind: 'start' | 'create'
  platform: string
  startedAt: number
  endedAt?: number
  status: 'running' | 'success' | 'failed' | 'uncertain'
  stages: StartupStage[]
  error?: unknown
}

/** A lost reply cannot establish whether the provider changed state. */
export function startupFailure(error: unknown): 'failed' | 'uncertain' {
  const e = error as { code?: string, transport?: string, status?: number } | null
  return e?.code === 'Unknown' || e?.code === 'no-host' || e?.status === 0 || e?.transport === 'uncertain' || e?.transport === 'transport-unknown' ? 'uncertain' : 'failed'
}

/**
 * Merge one progress event. LayerFS 2.0's `{ phase, done, total }` (done and
 * total count phases): the phase it names runs, those before it are done, and
 * `done === total` ends them all. The host's own Docker Engine launch reports
 * `{ stage, state }` (started, completed, failed). A late `started` never
 * undoes a terminal stage.
 */
export function mergeStage(stages: StartupStage[], progress: { stage?: unknown, state?: unknown, elapsed_ms?: unknown, phase?: unknown, done?: unknown, total?: unknown }, at: number): StartupStage[] {
  const elapsedOf = typeof progress.elapsed_ms === 'number' && Number.isFinite(progress.elapsed_ms) && progress.elapsed_ms >= 0 ? { elapsedMs: progress.elapsed_ms } : {}
  if (typeof progress.phase === 'string' && progress.phase) {
    const phase = progress.phase
    const total = typeof progress.total === 'number' ? progress.total : 0, done = typeof progress.done === 'number' ? progress.done : 0
    const all = total > 0 && done >= total
    let next = stages.map((s) => (s.state === 'started' && (s.stage !== phase || all) ? { ...s, state: 'completed' as const } : s))
    if (!next.some((s) => s.stage === phase)) next = [...next, { stage: phase, state: all ? 'completed' : 'started', at, ...elapsedOf }]
    return next.every((s, i) => s === stages[i]) && next.length === stages.length ? stages : next
  }
  if (typeof progress.stage !== 'string' || !['started', 'completed', 'failed'].includes(String(progress.state))) return stages
  const state = progress.state as StartupStage['state']
  const previous = stages.find((s) => s.stage === progress.stage)
  if (previous && previous.state !== 'started' && state === 'started') return stages
  if (previous?.state === 'failed' && state !== 'failed') return stages
  const elapsed = typeof progress.elapsed_ms === 'number' && Number.isFinite(progress.elapsed_ms) && progress.elapsed_ms >= 0 ? { elapsedMs: progress.elapsed_ms } : {}
  const next: StartupStage = { stage: progress.stage, state, at: previous?.at ?? at, ...elapsed }
  return previous ? stages.map((s) => (s === previous ? next : s)) : [...stages, next]
}

const STAGE: Record<string, MachinesKey> = {
  // LayerFS 2.0's phases of a start or create (bundle, image, boot, worker)
  bundle: 'stageBundle',
  image: 'stageImage',
  boot: 'stageBoot',
  worker: 'stageWorker',
  'bundle-validation': 'stageBundle',
  // the host launches the Docker Engine before a docker machine's start (host docker-engine.ts)
  'docker-engine': 'stageDockerEngine',
  'sandbox-image': 'stageImage',
  'worker-compatibility': 'stageWorker',
}

/** A stage in words. */
export function stageWords(stage: string, platform: string): Words {
  if (stage === 'provider-and-worker') return w(platform === 'docker' ? 'stageDockerWorker' : 'stageMachineWorker')
  return STAGE[stage] ? w(STAGE[stage]) : w('raw', { text: stage.replaceAll(/[-_]/g, ' ').replace(/^./, (c) => c.toUpperCase()) })
}

/** 4.0s, 12s, 1m 3s. */
export function duration(ms: number): string {
  const s = Math.max(0, ms / 1000)
  if (s < 10) return `${s.toFixed(1)}s`
  const whole = Math.floor(s)
  return whole < 60 ? `${whole}s` : `${Math.floor(whole / 60)}m ${whole % 60}s`
}

// ---------- Sandboxes ----------

export const SANDBOX_CAPACITY = 16
export const SANDBOX_NAME = /^[a-z0-9](?:[a-z0-9_.-]{0,61}[a-z0-9])?$/

/** A project key `<store>/<project>` as its parts. */
export function projectRef(key: string): { name: string, store: string | null } {
  const at = key.indexOf('/')
  return at < 0 ? { name: key, store: null } : { name: key.slice(at + 1), store: key.slice(0, at) }
}

export const workspaceName = (ws: WorkspaceInfo): string => ws.name || ws.path.split('/').filter(Boolean).at(-1) || ws.ws

/** The Workspace slots of a Sandbox: what sandbox.get says, else the constant LayerFS had before it said (16). */
export const workspaceCapacity = (info: Pick<SandboxInfo, 'workspaceCapacity'> | null | undefined): number =>
  (typeof info?.workspaceCapacity === 'number' && info.workspaceCapacity > 0 ? info.workspaceCapacity : SANDBOX_CAPACITY)

/**
 * The commands in a Workspace that this pane did not start: `running` without
 * the ones the host marks its own and without the exact exec ids the pane's
 * own log holds (never by an id's prefix). Oldest first.
 */
export function alsoRunning(ws: Pick<WorkspaceInfo, 'running'>, ownIds: ReadonlySet<string> = new Set()): RunningCommand[] {
  return (ws.running ?? []).filter((r) => !r.own && !ownIds.has(r.execId))
}

/** A Sandbox's running commands in numbers: all of them, and those another client started. */
export function runningSummary(workspaces: readonly Pick<WorkspaceInfo, 'ws' | 'running'>[]): { running: number, others: number, first: string | null } {
  let running = 0, others = 0, first: string | null = null, any: string | null = null
  for (const w of workspaces) {
    const all = w.running ?? []
    const other = alsoRunning(w).length
    running += all.length
    others += other
    if (other && first === null) first = w.ws
    if (all.length && any === null) any = w.ws
  }
  return { running, others, first: first ?? any }
}

/** Who started a running command, from its tag: a project session, this app's own host call, another tagged client, or an untagged one. */
export function runnerOf(r: Pick<RunningCommand, 'tag' | 'session'>): { kind: 'session', sessionId: string, title: string | null } | { kind: 'dsh' } | { kind: 'tag', tag: string } | { kind: 'other' } {
  const parsed = parseTag(r.tag ?? undefined)
  if (parsed) return { kind: 'session', sessionId: parsed.sessionId, title: r.session?.title ?? null }
  if (r.tag?.startsWith('dsh:') || r.tag?.startsWith('dsh-sim:')) return { kind: 'dsh' }
  return r.tag ? { kind: 'tag', tag: r.tag } : { kind: 'other' }
}

export function workspaceChanges(ws: WorkspaceInfo): Words & { tone?: 'warning' } {
  if (ws.pendingMerge) return { ...w('wsMergePending'), tone: 'warning' }
  if (ws.dirty == null) return w('notReported')
  // an edited file changes an inode and no directory entry: either count means changes
  if (overlayDirty(ws.dirty)) return { ...w('wsUncommitted', { n: overlayCount(ws.dirty) }), tone: 'warning' }
  return w('wsClean')
}

/**
 * A Sandbox's name as rows show it: the seven hex characters after `dsh-` for
 * the ids DSH generates (`dsh-986b86494b6e444ca800` → `986b864`), else the
 * name as it is. The full name stays in the row's title.
 */
export function shortSandbox(name: string): string {
  return /^dsh-[0-9a-f]{12,}$/.test(name) ? name.slice(4, 11) : name
}

/**
 * The PostgreSQL Stores a machine shows: those attached to it, and those
 * with a Sandbox on it now. A PostgreSQL Store is on no
 * machine, so every other one is left to Storage.
 */
export function pgUsable(view: Pick<AvailableView, 'postgresql' | 'sandboxes'>, m: Pick<MachineInfo, 'name'>): MachinePgStore[] {
  const here = new Set(view.sandboxes.filter((b) => b.machine === m.name && b.project).map((b) => b.project!.split('/')[0]))
  return (view.postgresql ?? []).filter((s) => (s.attached ?? []).some((c) => c.machine === m.name) || here.has(s.name))
}

// ---------- the Sandbox page ----------

/** How the Sandbox's daemon answered this read. */
export function daemonLook(info: SandboxInfo): { key: MachinesKey, tone: 'success' | 'danger' | 'neutral' } {
  if (info.state === 'broken') return { key: 'sbDaemonDown', tone: 'danger' }
  if (info.state !== 'ready') return { key: 'sbDaemonStopped', tone: 'neutral' }
  if (info.unread || info.refusal) return { key: 'sbDaemonUnknown', tone: 'neutral' }
  return { key: 'sbDaemonReachable', tone: 'success' }
}

/** Free control slots of all the daemon admits (pool and reserved), when it reported them. */
export function daemonSlots(info: SandboxInfo): { free: number, total: number } | null {
  const a = info.daemonCapacity?.admission
  if (!a) return null
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const free = n(a.pool_vacant) + n(a.reserved_vacant)
  return { free, total: free + n(a.pool_running) + n(a.reserved_running) }
}

/** Overlay counts: changed inodes (an edit changes one) and changed directory entries (a create, rename or delete). */
export interface OverlayCounts { inodes: number, entries: number }

/** Whether an overlay holds anything uncaptured: either count, since an in-place edit changes an inode and no entry. */
export const overlayDirty = (d: OverlayCounts | null | undefined): boolean => !!d && (d.inodes > 0 || d.entries > 0)

/** One number for an overlay's changes, for badges: the larger count (a new file is one of each). */
export const overlayCount = (d: OverlayCounts | null | undefined): number => (d ? Math.max(d.inodes, d.entries) : 0)
