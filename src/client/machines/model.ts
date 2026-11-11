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
 * turned off: the host leaves them out of machine.platforms.
 */
import type { Tone } from '../ui/index.tsx'
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

export interface MachineSupports {
  sqlite: boolean
  postgresql_sandbox: boolean
  reason: string | null
}

export interface PlatformOption {
  name: string
  kind: string
}

/** One machine.platforms row: readiness and create options. */
export interface MachinePlatformInfo {
  platform: string
  how: string
  backend: string | null
  kernel: string | null
  sqlite: string | null
  postgresql: { store_calls: string, sandbox: boolean, reason: string | null }
  ready: boolean
  missing: string[]
  version: string | null
  options: PlatformOption[]
  description: string
}

/** One machine.list() entry. */
export interface MachineInfo {
  name: string
  platform: string
  backend: string | null
  state: string
  op?: SdkOperation | null
  supports?: MachineSupports
  cpus: number | null
  memory: number | null
  disk: number | null
  stores: string[]
  sandboxes: string[]
  image?: string
  docker?: string
  wsl?: string
  error?: string
}

/** A sqlite Store on a machine. */
export interface MachineStore {
  state?: string
  op?: SdkOperation | null
  name: string
  machine: string
  projects: number
  names?: string[]
  size: number | null
}

/** A PostgreSQL Store: on no machine; Sandboxes on a machine that supports it reach its database. */
export interface MachinePgStore {
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
  backend?: string | null
  route?: string | null
  image?: string | null
  name: string
  machine: string | null
  project: string | null
  workspaces: number | null
}

/** machine.status(name). */
export interface MachineLive {
  op?: SdkOperation | null
  name: string
  state: string | null
  freeDisk: number | null
  toolVersion: string | null
  down: string | null
}

export interface AvailableView {
  available: true
  readErrors?: Record<string, { error: { code: string, message: string }, at: number }>
  layerfs: string | null
  machines: MachineInfo[]
  platforms: MachinePlatformInfo[]
  stores: MachineStore[]
  postgresql: MachinePgStore[]
  sandboxes: MachineSandbox[]
  status: Record<string, MachineLive>
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
}

export interface WorkspaceInfo {
  ws: string
  name?: string | null
  branch: string
  path: string
  activity?: string | null
  base?: string | null
  baseLayer?: string | null
  headMovedSinceMount?: boolean | null
  dirty?: { inodes: number, entries: number } | null
  pendingMerge?: boolean | null
}

/** GET /api/sandboxes/<name> (sandbox.get). */
export interface SandboxInfo {
  id: string
  name: string
  state: string
  op?: SdkOperation | null
  backend?: string | null
  route?: string | null
  project?: string | null
  refusal?: { code: string, message: string, detail?: unknown } | null
  image: string | null
  machine: string | null
  runtime?: string | null
  platform?: string
  runtimeId?: string | null
  created?: number | null
  downReason?: string | null
  workspaces: WorkspaceInfo[]
  unread?: boolean
}

/** GET /api/machines/<name>/images. */
export interface MachineImages {
  machine: string
  mode: 'host' | 'archive'
  archive?: string
  default_digest: string | null
  images: { digest: string, title?: string, tags: string[] }[]
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
  home: string
  root?: string
  source?: string
  version: string | null
  commit: string | null
  features?: readonly string[]
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
  machine: {
    creating: { tone: 'warning', label: 'stateCreating', live: true },
    running: { tone: 'success', label: 'stateRunning' },
    ready: { tone: 'success', label: 'stateRunning' },
    stopped: { tone: 'neutral', label: 'stateStopped' },
    removing: { tone: 'warning', label: 'stateRemoving', live: true },
    failed: { tone: 'danger', label: 'stateFailed', attention: true },
    missing: { tone: 'danger', label: 'stateMissing', attention: true },
    unresolved: { tone: 'danger', label: 'stateUnresolved', attention: true },
    unknown: { tone: 'neutral', label: 'stateUnknown', dashed: true },
  },
  store: {
    idle: { tone: 'success', label: 'stateIdle' },
    in_use: { tone: 'info', label: 'stateInUse', live: true },
    busy: { tone: 'warning', label: 'stateBusy', live: true },
    down: { tone: 'danger', label: 'stateDown' },
    unresolved: { tone: 'danger', label: 'stateUnresolved', attention: true },
    unknown: { tone: 'neutral', label: 'stateUnknown', dashed: true },
  },
  sandbox: {
    creating: { tone: 'warning', label: 'stateCreating', live: true },
    running: { tone: 'success', label: 'stateRunning' },
    closing: { tone: 'warning', label: 'stateClosing', live: true },
    gone: { tone: 'neutral', label: 'stateGone' },
    unresolved: { tone: 'danger', label: 'stateUnresolved', attention: true },
    unknown: { tone: 'neutral', label: 'stateUnknown', dashed: true },
  },
}

/** How `state` of an `entity` looks; an unknown word is shown as it came. */
export function stateLook(entity: Entity, state: string | null | undefined): StateLook {
  return LOOK[entity][state || 'unknown'] ?? { tone: 'neutral', label: null, raw: state || '', dashed: !state }
}

/** An operation in words: `store.push · send`. */
export function opWords(op: SdkOperation | null | undefined): string | null {
  if (!op) return null
  return [op.name, op.phase].filter(Boolean).join(' · ')
}

/** The status call that shows an unresolved entity, and the call that clears it. */
export function clearingCall(entity: Entity, name: string, op?: SdkOperation | null): { status: string, clear: string } {
  if (entity === 'store') {
    const clear = op?.name === 'store.remove' ? `layerfs store remove ${name}` : op?.name === 'store.pull' ? `layerfs store pull ${name}` : `layerfs store push ${name} <machine> (or store pull ${name})`
    return { status: `layerfs store status ${name}`, clear }
  }
  if (entity === 'machine') return { status: `layerfs machine status ${name}`, clear: `layerfs machine remove ${name}` }
  return { status: `layerfs sandbox get ${name}`, clear: `layerfs sandbox close ${name}` }
}

// ---------- machines ----------

export const GIB = 2 ** 30
export const VM_KINDS = ['apple-container', 'microsandbox', 'lima'] as const
export const BUILT_IN = new Set(['native', 'docker'])

const KIND_LABEL: Record<string, MachinesKey> = {
  native: 'kindNative',
  docker: 'kindDocker',
  'apple-container': 'kindAppleContainer',
  microsandbox: 'kindMicrosandbox',
  lima: 'kindLima',
}
/** A platform's name key, or null for a raw name shown as it came. */
export const kindKey = (platform: string): MachinesKey | null => KIND_LABEL[platform] ?? null

const KIND_BLURB: Record<string, MachinesKey> = {
  native: 'blurbNative',
  docker: 'blurbDocker',
  'apple-container': 'blurbAppleContainer',
  microsandbox: 'blurbMicrosandbox',
  lima: 'blurbLima',
}
export const blurbKey = (platform: string): MachinesKey | null => KIND_BLURB[platform] ?? null

/** LayerFS's defaults for a new VM. */
export const VM_DEFAULTS = { cpus: 2, memory: 4 * GIB, disk: 20 * GIB } as const

/** Native and Docker first, then the rest by name. */
export function machineOrder(machines: MachineInfo[]): MachineInfo[] {
  const rank = (m: MachineInfo) => (m.platform === 'native' ? 0 : m.platform === 'docker' ? 1 : 2)
  return [...machines].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

/** How a machine's state is counted: `needs` is failed, missing or unresolved. */
export type MachineKey = 'running' | 'stopped' | 'busy' | 'needs' | 'unknown'

/** A machine's state as the SDK gives it, with the op machine.status shows. */
export function machineState(m: MachineInfo, live?: MachineLive): StateLook & { key: MachineKey, state: string, op: SdkOperation | null } {
  const state = m.state || 'unknown'
  const look = stateLook('machine', state)
  const key: MachineKey = look.attention ? 'needs' : state === 'running' || state === 'ready' ? 'running' : state === 'stopped' ? 'stopped' : state === 'creating' || state === 'removing' ? 'busy' : 'unknown'
  return { ...look, key, state, op: live?.op ?? m.op ?? null }
}

/** The board's order rank. */
export const RANK: Record<MachineKey, number> = { needs: 0, busy: 1, running: 2, stopped: 3, unknown: 4 }

/** Why a machine needs you or did not answer, in LayerFS's words; a plain stop is not a reason. */
export const downReason = (m: MachineInfo, live?: MachineLive): string | null => live?.down ?? m.error ?? null

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

/** The sqlite Stores a machine holds; one store.list() omits still shows by name. */
export function storesOn(view: AvailableView, m: MachineInfo): MachineStore[] {
  return m.stores.map((name) => view.stores.find((s) => s.name === name && s.machine === m.name) ?? { name, machine: m.name, projects: 0, size: null })
}

/** A machine's Sandboxes from sandbox.list(), by project then name; one it omits still shows by name. */
export function sandboxesOn(view: AvailableView, m: MachineInfo): MachineSandbox[] {
  const rows = m.sandboxes.map((b) => view.sandboxes.find((x) => x.name === b) ?? { name: b, machine: m.name, project: null, workspaces: null })
  return rows.sort((a, b) => Number(!a.project) - Number(!b.project) || (a.project ?? '').localeCompare(b.project ?? '') || a.name.localeCompare(b.name, undefined, { numeric: true }))
}

/** The facts line's numbers. */
export function factsOf(view: AvailableView) {
  const n: Record<MachineKey, number> = { running: 0, stopped: 0, busy: 0, needs: 0, unknown: 0 }
  for (const m of view.machines) n[machineState(m, view.status[m.name]).key]++
  const ops = [...Object.values(view.status).filter((s) => s.op), ...view.stores.filter((s) => s.op), ...view.sandboxes.filter((b) => b.op)].length
  const workspaces = view.sandboxes.reduce((sum, b) => sum + (b.workspaces ?? 0), 0)
  return { ...n, ops, sandboxes: view.sandboxes.length, workspaces, workspacesKnown: !view.sandboxes.some((b) => b.workspaces == null) }
}

/** Remove refuses while a machine holds Stores or Sandboxes (InUse): the reason, or null. */
export function inUse(m: MachineInfo): { stores: number, sandboxes: number } | null {
  return m.stores.length || m.sandboxes.length ? { stores: m.stores.length, sandboxes: m.sandboxes.length } : null
}

/** Why Remove is refused before it is asked. */
export function heldWords(held: { stores: number }): Words {
  return held.stores > 0 ? w(held.stores === 1 ? 'heldOneStore' : 'heldStores', { n: held.stores }) : w('heldSandboxes')
}

/** Start or Stop, when the machine is non-native and running or stopped. */
export const powerOf = (m: MachineInfo): 'start' | 'stop' | null =>
  m.platform !== 'native' && (m.state === 'running' || m.state === 'stopped') ? (m.state === 'running' ? 'stop' : 'start') : null

/** A machine's size in a line. */
export function sizeOf(m: MachineInfo, live?: MachineLive): Words {
  if (m.platform === 'native') return w('sizeNative')
  if (m.platform === 'docker') return live?.freeDisk != null ? w('sizeDockerFree', { free: gib(live.freeDisk) }) : w('sizeDocker')
  const values = { cpus: m.cpus ?? VM_DEFAULTS.cpus, memory: gib(m.memory ?? VM_DEFAULTS.memory), disk: gib(m.disk ?? VM_DEFAULTS.disk) }
  return live?.freeDisk != null ? w('sizeVmFree', { ...values, free: gib(live.freeDisk) }) : w('sizeVm', values)
}

/** How a machine runs its Sandboxes. */
export function runtimeOf(m: MachineInfo): Words {
  if (m.backend === 'native') return w('runsProcesses')
  if (m.backend === 'docker') return w('runsContainers')
  if (m.backend === 'namespaces') return w('runsNamespaces')
  return m.backend ? w('raw', { text: m.backend }) : w('runsUnknown')
}

// ---------- Add a machine ----------

/** A can_create need in words. */
export function needWords(need: string, platform?: string): Words {
  // Docker's `host:<socket>`: the Engine does not answer there; starting it fixes it, so it is no hardware need.
  if (platform === 'docker' && need.startsWith('host:/')) return w('needDockerSocket', { socket: need.slice(5) })
  if (need.startsWith('tool:')) return w('needTool', { tool: need.slice(5) })
  if (need.startsWith('bundle:')) return w('needBundle')
  const host: Record<string, MachinesKey> = {
    'host:apple-m3': 'needAppleM3',
    'host:macos15': 'needMacos15',
    'host:apple-silicon': 'needAppleSilicon',
    'host:macos': 'needMacos',
    'host:macos-or-linux': 'needMacosOrLinux',
    'host:wsl2': 'needWsl2',
    'host:root': 'needRoot',
    'host:/dev/fuse': 'needFuse',
    'host:cgroup2': 'needCgroup2',
  }
  if (host[need]) return w(host[need])
  if (need.startsWith('host:')) return w('needHost', { thing: need.slice(5) })
  return w('raw', { text: need })
}

/** How to get what a platform misses: words and commands to copy; null for hardware/OS needs. Docker's `host:<socket>` is excepted: a stopped Engine answers that, and starting it fixes it. */
export function installHelp(missing: string[], layerfs: string | null, platform?: string): { label: MachinesKey, words: Words, commands: string[] } | null {
  if (missing.some((n) => n.startsWith('host:') && !(platform === 'docker' && n.startsWith('host:/')))) return null
  const tool = missing.find((n) => n.startsWith('tool:'))?.slice(5)
  if (tool === 'msb') return { label: 'howToInstall', words: w('installMsb'), commands: ['curl -fsSL https://install.microsandbox.dev | sh', 'export PATH="$HOME/.microsandbox/bin:$PATH"'] }
  if (tool === 'container') return { label: 'howToInstall', words: w('installContainer'), commands: ['https://github.com/apple/container/releases', 'container system start'] }
  if (tool === 'limactl') return { label: 'howToInstall', words: w('installLima'), commands: ['brew install lima'] }
  if (tool === 'docker') return { label: 'howToInstall', words: w('installDockerEngine'), commands: ['brew install --cask docker', 'brew install colima docker && colima start'] }
  if (tool) return { label: 'howToInstall', words: w('installTool', { tool }), commands: [] }
  if (platform === 'docker' && missing.some((n) => n.startsWith('host:/'))) {
    return { label: 'howToInstall', words: w('installDockerStart'), commands: ['open -a Docker', 'colima start'] }
  }
  if (missing.some((n) => n.startsWith('bundle:'))) {
    const version = layerfs ?? '<version>'
    return {
      label: 'howToGetIt',
      words: w('installBundle', { version, folder: `~/.cache/layerfs/bundle/${version}/` }),
      commands: ['daemon', 'worker', 'helper', 'seal'].map((step) => `python3 tools/linux_bundle.py ${step} --resources <resources.json>`),
    }
  }
  return null
}

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

export interface VmForm { name: string, cpus: string, memory: string, disk: string, image: string }
export type FormErrors = Partial<Record<keyof VmForm, Words>>

export const emptyVm = (): VmForm => ({ name: '', cpus: String(VM_DEFAULTS.cpus), memory: '4G', disk: '20G', image: '' })

export const isImageRef = (image: string): boolean => /^sha256:[0-9a-f]{12,64}$/.test(image) || image.startsWith('/')

export function vmErrors(f: VmForm, machines: MachineInfo[], archive: boolean): FormErrors {
  const e: FormErrors = {}
  const n = f.name.trim()
  if (!n) e.name = w('errNameRequired')
  else if (BUILT_IN.has(n)) e.name = w('errNameBuiltIn', { name: n })
  else if (!NAME.test(n)) e.name = w('errNameShape')
  else if (machines.some((m) => m.name === n)) e.name = w('errNameTaken', { name: n })
  const cpus = Number(f.cpus)
  if (!Number.isInteger(cpus) || cpus < 1 || cpus > 64) e.cpus = w('errCpus')
  const memory = parseSize(f.memory)
  if (memory === null || memory < 512 * 2 ** 20) e.memory = w('errMemory')
  const disk = parseSize(f.disk)
  if (disk === null || disk < 2 * GIB) e.disk = w('errDisk')
  if (archive && !isImageRef(f.image.trim())) e.image = w('errImage')
  return e
}

/** The platforms a machine is created on (not the built-ins), in machine.platforms order. */
export const addable = (platforms: MachinePlatformInfo[]): MachinePlatformInfo[] => platforms.filter((p) => p.how === 'created')

/** Whether `platform` declares create option `name`. */
export const declares = (platforms: MachinePlatformInfo[], platform: string, name: string): boolean =>
  !!platforms.find((p) => p.platform === platform)?.options.some((o) => o.name === name)

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

/** Merge one reported stage; a late `started` never undoes a terminal stage. */
export function mergeStage(stages: StartupStage[], progress: { stage?: unknown, state?: unknown, elapsed_ms?: unknown }, at: number): StartupStage[] {
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
  'bundle-validation': 'stageBundle',
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

export function workspaceChanges(ws: WorkspaceInfo): Words & { tone?: 'warning' } {
  if (ws.pendingMerge) return { ...w('wsMergePending'), tone: 'warning' }
  if (ws.dirty == null) return w('notReported')
  if (ws.dirty.entries > 0) return { ...w('wsUncommitted', { n: ws.dirty.entries }), tone: 'warning' }
  return w('wsClean')
}
