/**
 * Compute's machines (LayerFS 2.0, layerfs#533): `GET /api/machines` and the
 * calls the Machines page makes. Port of Connect `host/machines.js`.
 *
 * A LayerFS 2.0 home's compute is a set of machines: `native` and `docker`
 * built in, and VMs it creates (apple-container, microsandbox, lima).
 * LayerFS's ssh hosts and Firecracker machines are turned off (OFF):
 * machine.platforms leaves them out and machine.create refuses them. A
 * machine holds sqlite Stores; a project's Sandboxes run on its Store's
 * machine. Power is manual (#535 D11): a machine runs between machine.start
 * and machine.stop, and no call starts one on demand.
 *
 * The view (MachinesView) is machine.list() as the SDK answers it (each
 * machine's `state` and `supports`, never guessed here), with store.list()
 * and sandbox.list(), and machine.status() of the machines that run or hold an
 * operation (free disk, `op`): one read for the page, and none of it starts a machine.
 */
import { join } from 'node:path'
import { computer } from './computer.ts'
import { readArchive, type ImageProblem } from '../images/archive.ts'
import { InspectReads, logQuery, type LogView } from './inspect.ts'
import { cliFeatures, featuresOf, pages, refuse, type CliFeatures, type RouteHost } from './util.ts'

const BUILT_IN = new Set(['native', 'docker'])
/** Platforms LayerFS has that are turned off here: not offered, not created or connected. */
export const OFF = new Set(['ssh', 'firecracker'])
/** Create options only Firecracker used (a nested Lima machine hosts it): not offered either. */
const OFF_OPTIONS = new Set(['nested', 'host'])
/** States whose machine.status says something the list does not: free disk, or the op that holds it. */
const ASK_STATUS = new Set(['running', 'stopped', 'creating', 'removing', 'unresolved', 'failed', 'unknown'])

const list = (value: any): any[] => (Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [])
const DIGEST = /^sha256:[a-f0-9]{64}$/
/** The bundle's image has no RepoTags: what to call it. */
const BUNDLE_NAME = 'LayerFS default'
/** LayerFS's own copy of the bundle image in Docker (`layerfs-cache/sandbox:<config digest hex>`): never shown as a name. */
const CACHE_REF = /^layerfs-cache\//
/** Refusals of one image in a prune: answered in `refused`, the request goes on. */
const PRUNE_PER_IMAGE = new Set(['InUse', 'NotFound', 'NoSuchImage', 'InvalidInput'])

/** Why a listed image cannot run (docs/specs/sandbox-images.md §4.1). */
export interface ImageReason { kind: 'arch' | 'os' | ImageProblem, value?: string }

/** One ready row of `GET /api/machines/:id/sandbox-images`: an image a Sandbox on the machine starts at once. */
export interface ReadyImage {
  /** The config digest for bundle and VM-archive images; the Docker image Id for imported ones (D1). */
  id: string
  /** The ref ending `:latest`, else the first ref, or "LayerFS default" for the bundle's image. */
  name: string
  refs: string[]
  size: number | null
  source: 'bundle' | 'machine' | 'imported'
  /** Sandboxes on the machine whose record names this image. */
  sandboxes: number
  lastUsed: string | null
  usable: boolean
  reason?: ImageReason
}

/** `GET /api/machines/:id/sandbox-images` (§4.1): the New Sandbox menu, the Images section and Free space. */
export interface SandboxImagesView {
  machine: string
  platform: string | null
  state: string
  stage: 0 | 1
  /** `host`: macOS native, no Image row. */
  mode: 'images' | 'host'
  /** The machine's Linux architecture. */
  architecture: string | null
  /** Data-disk bytes (machine.images `free`); null at Stage 0. */
  free: number | null
  /** The id of the preselected ready row (D7). */
  default: string | null
  observedAt: number
  /** The ready rows are the last good answer kept in memory (this read failed: `code`, `message`; `WorkerOutdated`: the worker runs another LayerFS build). */
  stale: false | { at: number, code: string, message?: string }
  ready: ReadyImage[]
  /** The "From Docker" group: null at Stage 0 and on macOS native. */
  docker: null | { available: false, reason: 'not-installed' | 'not-running' | 'error', message?: string } | { available: true, images: DockerImage[] }
}

/** One row of the "From Docker" group (Stage 1): an image of this computer's Docker, copied to the machine once. */
export interface DockerImage {
  /** Docker's image Id (D1). */
  id: string
  /** The ref ending `:latest`, else the first ref. */
  name: string
  refs: string[]
  size: number
  architecture: string
  os: string
  /** Bytes the copy needs on the machine (D8). */
  need: number
  /** `free` is unknown, or `need` fits in it. */
  fits: boolean
  usable: boolean
  reason?: ImageReason
}

/** `POST /api/machines/:id/prune-images`: what went, the bytes freed, and the images LayerFS kept (InUse, …). */
export interface PruneAnswer { removed: string[], freed: number, refused: { id: string, code: string, message: string }[] }

/** The Linux architecture a machine on this host runs (Lima, Apple containers and Docker Desktop run the host's). */
export const linuxArchitecture = (arch: string = process.arch): string => (arch === 'x64' ? 'amd64' : arch)
const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)
const count = (value: unknown): number => (typeof value === 'number' ? value : Array.isArray(value) ? value.length : 0)
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

const refsOf = (value: unknown): string[] => (Array.isArray(value) ? value.filter((r): r is string => typeof r === 'string' && !!r) : [])
/** An ISO time from LayerFS's `last_used` (ISO text, or epoch seconds or ms). */
const isoOf = (value: unknown): string | null => {
  if (typeof value === 'string' && value && Number.isFinite(Date.parse(value))) return value
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return new Date(value < 1e12 ? value * 1000 : value).toISOString()
  return null
}

/** One machine.images row as a ready row (Stage 1: all usable); null without an id. */
/** LayerFS's `Unavailable` for a machine whose worker runs another LayerFS build ("is of another build", "replace its worker"). */
const WORKER_OUTDATED = /another build|replace its worker/i

/**
 * Why a machine.images read failed, as the answer's `stale` (§4.1): the
 * refusal's code and message; a worker of another LayerFS build is
 * `WorkerOutdated` (the machine runs, restarting its worker fixes it),
 * not a stopped machine.
 */
export function staleOf(error: any, at: number): { at: number, code: string, message: string } {
  const message = error instanceof Error ? error.message : typeof error?.message === 'string' ? error.message : String(error)
  const code = typeof error?.code === 'string' ? error.code : 'Unknown'
  return { at, code: code === 'Unavailable' && WORKER_OUTDATED.test(message) ? 'WorkerOutdated' : code, message }
}

/** An image's name (§5.1.1): the ref ending `:latest` if it has one (what people pick), else its first ref. */
export const imageName = (refs: readonly string[]): string | undefined => refs.find((r) => r.endsWith(':latest')) ?? refs[0]

export function readyOf(i: any): ReadyImage | null {
  const id = text(i?.id)
  if (!id) return null
  const refs = refsOf(i.refs).filter((r) => !CACHE_REF.test(r))
  const source = i.source === 'bundle' || i.source === 'machine' ? i.source : 'imported'
  return {
    id, name: imageName(refs) ?? (source === 'bundle' ? BUNDLE_NAME : id.replace(/^sha256:/, '').slice(0, 12)),
    refs, size: num(i.size), source, sandboxes: count(i.sandboxes), lastUsed: isoOf(i.last_used), usable: true,
  }
}

/**
 * machine.images' Docker part as the "From Docker" group (§4.1): LayerFS
 * lists the images of the Docker it copies from (D3), already without the
 * ready ones and the untagged ones, each with `usable`/`reason` and the
 * space a copy needs (`need`, `fits`, D8). Mapped as it comes; null when
 * LayerFS reports no Docker part (macOS native).
 */
export function dockerOf(answer: any): SandboxImagesView['docker'] {
  const d = answer?.docker
  if (!d || typeof d !== 'object') return null
  if (d.available !== true) {
    const reason = d.reason === 'not-installed' || d.reason === 'not-running' ? d.reason : 'error'
    return { available: false, reason, ...(text(d.message) ? { message: d.message } : {}) }
  }
  const images: DockerImage[] = []
  for (const r of Array.isArray(answer.available) ? answer.available : []) {
    const id = text(r?.id)
    const refs = refsOf(r?.refs)
    if (!id) continue
    const reason: ImageReason | undefined = r.reason && typeof r.reason === 'object' && typeof r.reason.kind === 'string'
      ? { kind: r.reason.kind, ...(text(r.reason.value) ? { value: r.reason.value } : {}) } : undefined
    images.push({
      id, name: imageName(refs) ?? id.replace(/^sha256:/, '').slice(0, 12), refs, size: num(r.size) ?? 0,
      architecture: text(r.architecture) ?? '', os: text(r.os) ?? '', need: num(r.need) ?? 0, fits: r.fits !== false,
      usable: r.usable !== false, ...(reason ? { reason } : {}),
    })
  }
  return { available: true, images }
}

/** One machine.list() entry, as the page reads it. */
export function machineOf(m: any) {
  return {
    name: String(m.name),
    platform: String(m.platform),
    backend: text(m.backend),
    // the SDK's state, as it is (#537 U4)
    state: text(m.state) ?? 'unknown',
    // `log` (the machine has a worker log to read, layerfs-project#178) only when LayerFS says so: absent from an older CLI
    ...(m.supports && typeof m.supports === 'object' ? { supports: { sqlite: m.supports.sqlite !== false, postgresql_sandbox: m.supports.postgresql_sandbox === true, reason: text(m.supports.reason), ...(typeof m.supports.log === 'boolean' ? { log: m.supports.log } : {}) } } : {}),
    cpus: num(m.cpus),
    memory: num(m.memory),
    disk: num(m.disk),
    stores: list(m.stores).map(String),
    // the PostgreSQL Stores attached to it (store.attach); absent from a CLI before attachments
    ...(Array.isArray(m.postgresql) ? { postgresql: m.postgresql.map(String) } : {}),
    sandboxes: list(m.sandboxes).map(String),
    ...(text(m.image) ? { image: m.image } : {}),
    ...(text(m.docker) ? { docker: m.docker } : {}),
    ...(text(m.wsl) ? { wsl: m.wsl } : {}),
    ...(text(m.error) ? { error: m.error } : {}),
  }
}

/** One machine.platforms row, as the SDK answers it. */
export const platformOf = (p: any) => ({
  platform: String(p.platform),
  how: String(p.how ?? ''),
  backend: text(p.backend),
  kernel: text(p.kernel),
  sqlite: text(p.sqlite),
  postgresql: { store_calls: String(p.postgresql?.store_calls ?? ''), sandbox: p.postgresql?.sandbox === true, reason: text(p.postgresql?.reason) },
  ready: p.ready === true,
  missing: list(p.missing).map(String),
  version: text(p.version),
  options: list(p.options).map((o: any) => ({ name: String(o.name), kind: String(o.kind) })),
  description: String(p.description ?? ''),
})

/** An SDK `op` ({ id, name, phase, started, uncertain }), or null. */
export const opOf = (o: any) => (o && typeof o === 'object' && typeof o.name === 'string' ? { id: String(o.id ?? ''), name: o.name as string, phase: text(o.phase) ?? '', started: num(o.started), uncertain: o.uncertain === true } : null)

/** One store.list() item, when it is a sqlite Store on a machine. */
export function storeOf(s: any) {
  const machine = text(s.machine)
  if (!machine) return null
  return { name: String(s.name), machine, projects: count(s.projects), names: Array.isArray(s.projects) ? s.projects.map(String) : [], size: null, state: text(s.state) ?? 'unknown', op: opOf(s.op) }
}

/** One store.list() item, when it is a PostgreSQL Store (on no machine: Sandboxes reach its database). */
export function pgStoreOf(s: any) {
  if (s.kind !== 'postgresql') return null
  return { name: String(s.name), projects: count(s.projects), names: Array.isArray(s.projects) ? s.projects.map(String) : [], state: text(s.state) ?? 'unknown', op: opOf(s.op), machines: s.machines && typeof s.machines === 'object' ? Object.entries(s.machines).map(([machine, a]: [string, any]) => ({ machine, checked: !!a?.checked })) : null }
}

/** One sandbox.list() item. */
export function sandboxOf(b: any) {
  return { name: String(b.name ?? b.sandbox), machine: text(b.machine), project: text(b.project), workspaces: b.workspaces === undefined ? null : count(b.workspaces), state: text(b.state) ?? 'unknown', op: opOf(b.op), backend: text(b.backend), route: text(b.route), image: text(b.image) }
}

/** One machine.status() answer (the reason is `down_reason`). */
export const statusOf = (s: any) => ({ name: String(s.name), state: text(s.state), freeDisk: num(s.free_disk), toolVersion: text(s.tool_version), down: /^the machine is stopped\.?$/i.test(String(s.down_reason ?? s.why_down ?? '')) ? null : text(s.down_reason ?? s.why_down), op: opOf(s.op) })

/** 501: the pinned CLI's call table has no such monitoring call. */
const noCall = (call: string, what: string) => Object.assign(refuse(501, 'Unsupported', `The pinned LayerFS CLI cannot read ${what} (it has no ${call}).`), { detail: { need: call } })

/** The options a call takes, without empty ones. */
function pick(body: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of keys) if (body[key] !== undefined && body[key] !== null && body[key] !== '') out[key] = body[key]
  return out
}

type PlatformsView = { host: string, platforms: ReturnType<typeof platformOf>[] }

/** The machines view and its calls. */
export class Machines {
  private lastView: any = null
  /** The MachinesView read in flight, shared by concurrent GETs; `changed()` (any write) makes later GETs read anew. */
  private viewing: { promise: ReturnType<Machines['readView']>, generation: number } | null = null
  private generation = 0
  private platformAnswer: { at: number, value: PlatformsView } | null = null
  private platformRead: Promise<PlatformsView> | null = null

  /**
   * @param host - the route dependencies.
   * @param place - puts a Store on a machine as a job in Storage's table (push, pull, or pull then push).
   */
  constructor(private readonly host: RouteHost, private readonly place: ((store: string, machine: string) => Promise<unknown>) | null = null) {}

  get lfs() { return this.host.lfs() }

  /** The pinned CLI's version and the optional features its call table has. */
  private async identity(): Promise<{ version: string | null, features: CliFeatures }> {
    try {
      const d = await this.host.discover()
      return { version: d.identity?.version ?? null, features: featuresOf(d) }
    } catch { return { version: null, features: featuresOf(null) } }
  }

  /** A write somewhere (the router calls this on every non-GET): the next view() reads anew. */
  changed(): void { this.generation++ }

  /**
   * MachinesView: concurrent GETs (the sidebar, the machines store, a dialog) share one read.
   * `fresh`: probe the platforms again now (Check again after an install), not within 30 s.
   */
  view(fresh = false): ReturnType<Machines['readView']> {
    if (fresh) { this.platformAnswer = null; this.generation++ }
    if (this.viewing && this.viewing.generation === this.generation) return this.viewing.promise
    const promise = this.readView().finally(() => { if (this.viewing?.promise === promise) this.viewing = null })
    this.viewing = { promise, generation: this.generation }
    return promise
  }

  private async readView() {
    const lfs = this.lfs
    const listed = await lfs.machine.list()
    const machines = list(listed.machines).map(machineOf)
    const readErrors: Record<string, unknown> = {}
    const failed = (name: string) => (e: any) => { readErrors[name] = { error: { code: e?.code ?? 'Unknown', message: e?.message ?? String(e) }, at: Date.now() }; return [] as any[] }
    let host: string | null = null
    const [platforms, listedStores, sandboxes, statuses] = await Promise.all([
      this.platforms().then((p) => { host = p.host || null; return p.platforms }, failed('platforms')),
      lfs.store.list().then(list, failed('stores')),
      // sandbox.list items carry no Workspaces: each one's count is its sandbox.get (a record read; null when refused)
      pages((p) => lfs.sandbox.list(p)).then((rows) => rows.map(sandboxOf), failed('sandboxes')),
      // Starts nothing; stopped machines can carry provider/socket diagnostics too.
      Promise.all(machines.filter((m) => m.platform !== 'native' && ASK_STATUS.has(m.state)).map((m) => lfs.machine.status(m.name).then(statusOf, (e: any) => ({ name: m.name, state: null, freeDisk: null, toolVersion: null, down: e?.message ?? String(e), op: null })))),
    ])
    const stores = listedStores.map(storeOf).filter(Boolean)
    const postgresql = listedStores.map(pgStoreOf).filter(Boolean)
    const { version, features } = await this.identity()
    // features: what the pinned CLI can do (force stop, the image stage and its parts); the page offers only those
    const answer: any = { available: true, readErrors, layerfs: version, features, computer: computer(host), machines, platforms, stores, postgresql, sandboxes, status: Object.fromEntries(statuses.map((s: any) => [s.name, s])) }
    for (const [part, fields] of Object.entries({ stores: ['stores', 'postgresql'], sandboxes: ['sandboxes'], platforms: ['platforms'] })) {
      if (readErrors[part] && this.lastView) for (const field of fields) answer[field] = this.lastView[field]
    }
    this.lastView = answer
    return answer
  }

  /** machine.platforms(): each platform on this host but the ones turned off; starts nothing (PlatformsView). */
  async platforms(): Promise<PlatformsView> {
    const now = Date.now()
    if (this.platformAnswer && now - this.platformAnswer.at < 30000) return this.platformAnswer.value
    if (this.platformRead) return this.platformRead
    this.platformRead = this.readPlatforms().then((value) => { this.platformAnswer = { at: Date.now(), value }; return value }).finally(() => { this.platformRead = null })
    return this.platformRead
  }

  private async readPlatforms(): Promise<PlatformsView> {
    const answer = await this.lfs.machine.platforms()
    const rows = list(answer.platforms).map(platformOf).filter((p) => !OFF.has(p.platform))
    return { host: String(answer.host ?? ''), platforms: rows.map((p) => ({ ...p, options: p.options.filter((o: any) => !OFF_OPTIONS.has(o.name)) })) }
  }

  async inspect(name: string) { return { ...(await this.lfs.machine.get(name)), ...(await this.lfs.machine.status(name)), observedAt: Date.now() } }

  /** The monitoring reads' shared state: one read per key, last good answers, page requests that can be cancelled. */
  readonly reads = new InspectReads()

  /**
   * `GET /api/machines/:id/log?cursor=&before=&limit=&rid=`: the machine's
   * worker log (logs.machine), a tail without a cursor. Its own read: never
   * part of the machines view. A refusal (a stopped machine `Unavailable`, a
   * machine without a worker `Unsupported`, a replaced log's cursor
   * `InvalidInput`, a full inspect lane `Busy`, no answer in time `Timeout`)
   * is answered as `stale` with the last good tail, not as an error. 501
   * while the pinned CLI has no logs.machine (the page hides the tab).
   */
  async machineLog(name: string, query: URLSearchParams, outer?: AbortSignal): Promise<LogView> {
    if (!name) throw refuse(400, 'InvalidInput', 'name the machine')
    if (!(await cliFeatures(this.host)).inspect.machineLog) throw noCall('logs.machine', 'a machine\'s worker log')
    const lfs = this.lfs
    const request = this.reads.request(query.get('rid'), outer)
    try { return await this.reads.log(`machine:${name}`, logQuery(query), (options) => lfs.logs.machine(name, options), request.signal) } finally { request.done() }
  }

  /**
   * `GET /api/sandboxes/:name/log?cursor=&before=&limit=&rid=`: the Sandbox's
   * daemon log (logs.sandbox), as {@link machineLog}. It never waits on
   * sandbox.get and never dials the daemon; a lost or unresolved Sandbox's
   * refusal is answered as `stale`.
   */
  async sandboxLog(name: string, query: URLSearchParams, outer?: AbortSignal): Promise<LogView> {
    if (!name) throw refuse(400, 'InvalidInput', 'name the Sandbox')
    if (!(await cliFeatures(this.host)).inspect.sandboxLog) throw noCall('logs.sandbox', 'a Sandbox\'s daemon log')
    const lfs = this.lfs
    const request = this.reads.request(query.get('rid'), outer)
    try { return await this.reads.log(`sandbox:${name}`, logQuery(query), (options) => lfs.logs.sandbox(name, options), request.signal) } finally { request.done() }
  }

  /**
   * `GET /api/machines/:id/sandbox-images` (docs/specs/sandbox-images.md
   * §4.1). Never starts a machine or pulls an image. At Stage 0 (the pinned
   * CLI has no machine.images) the ready rows come from the archive a Sandbox
   * on the machine would run, read on this host ({@link archiveRows}), so a
   * stopped machine answers too; `docker` is null and `free` unknown.
   * Default (D7 at Stage 0): the record's digest, else the archive's only
   * image, else the first usable row.
   */
  async sandboxImages(name: string): Promise<SandboxImagesView> {
    if (!name) throw refuse(null, 'InvalidInput', 'name the machine')
    const lfs = this.lfs
    let record: any = null
    try { record = await lfs.machine.get(name) } catch (error: any) { if (error?.code === 'NotFound' || error?.code === 'NoSuchMachine') throw error }
    let state = text(record?.state)
    if (!state) {
      try { state = text(list((await lfs.machine.list()).machines).find((m: any) => m.name === name)?.state) } catch {}
    }
    const platform = text(record?.platform) ?? (BUILT_IN.has(name) ? name : null)
    const stage = (await cliFeatures(this.host)).imageStage
    const base = { machine: name, platform, state: state ?? 'unknown', stage: 0 as const, free: null, docker: null, observedAt: Date.now() }
    // a native Sandbox off Linux runs on the computer itself: no image
    if (platform === 'native' && process.platform !== 'linux') return { ...base, stage, mode: 'host', architecture: null, default: null, stale: false, ready: [] }
    // Stage 1: everything from machine.images (ready images, free space, and the Docker images LayerFS can copy)
    if (stage === 1) return this.stage1Images(name, base)
    const architecture = linuxArchitecture()
    const own = platform === 'docker' ? null : text(record?.image)
    const pinned = own && DIGEST.test(own) ? own : null
    let rows: ReadyImage[]
    try {
      rows = this.archiveRows(record, platform, architecture)
    } catch (error: any) {
      // an unreadable archive: the last good rows for this machine, marked stale; none kept, an empty group
      const kept = this.keptImages.get(name)
      const stale = staleOf(error, kept?.at ?? Date.now())
      const ready = kept?.ready ?? []
      return { ...base, mode: 'images', architecture, default: defaultOf(ready, pinned), stale, ready }
    }
    if (rows.length) {
      const counts = await this.sandboxCounts(name)
      rows = rows.map((r) => ({ ...r, sandboxes: counts.get(r.id) ?? 0 }))
    }
    this.keptImages.set(name, { at: base.observedAt, ready: rows })
    return { ...base, mode: 'images', architecture, default: defaultOf(rows, pinned), stale: false, ready: rows }
  }

  /** The last good answer per machine (memory only): a later failed read answers it as `stale`. */
  private readonly keptImages = new Map<string, { at: number, ready: ReadyImage[], free?: number | null, default?: string | null, docker?: SandboxImagesView['docker'] }>()

  /**
   * Stage 1 (§4.1): one machine.images read (a kept read, 5 s) answers it
   * all: `images` are the ready rows, `free` the data disk, `default`, and
   * `docker` + `available` the "From Docker" group, which LayerFS lists,
   * dedupes and sizes itself. The plugin never reads Docker. A machine that
   * cannot answer (stopped: `Unavailable`) answers the last good answer kept
   * for it, marked `stale`, or none.
   */
  private async stage1Images(name: string, base: { machine: string, platform: string | null, state: string, observedAt: number }): Promise<SandboxImagesView> {
    let ready: ReadyImage[]
    let free: number | null
    let own: string | null
    let docker: SandboxImagesView['docker']
    let architecture = linuxArchitecture()
    let stale: SandboxImagesView['stale'] = false
    try {
      const answer = await this.lfs.machine.images(name)
      if (answer?.mode === 'host') return { ...base, stage: 1, free: null, docker: null, mode: 'host', architecture: null, default: null, stale: false, ready: [] }
      ready = (Array.isArray(answer?.images) ? answer.images : []).map(readyOf).filter((r: ReadyImage | null): r is ReadyImage => !!r)
      free = num(answer?.free)
      own = text(answer?.default)
      docker = dockerOf(answer)
      architecture = text(answer?.architecture) ?? architecture
      this.keptImages.set(name, { at: base.observedAt, ready, free, default: own, docker })
    } catch (error: any) {
      if (error?.code === 'NotFound' || error?.code === 'NoSuchMachine') throw error
      const kept = this.keptImages.get(name)
      stale = staleOf(error, kept?.at ?? base.observedAt)
      ready = kept?.ready ?? []
      free = kept?.free ?? null
      own = kept?.default ?? null
      docker = kept?.docker ?? null
    }
    return { ...base, stage: 1, mode: 'images', architecture, free, default: defaultOf(ready, own), stale, ready, docker }
  }

  /**
   * The Stage-1 disk precheck of a create (§4.1, D8): `{ need, free }` when
   * `image` is a Docker image that is not ready on `machine` and its copy
   * does not fit in the machine's free space; null when it fits, is ready,
   * or anything is unknown (LayerFS's own NoSpace refusal is the real answer).
   */
  async spaceFor(machine: string, image: string): Promise<{ need: number, free: number } | null> {
    try {
      const view = await this.sandboxImages(machine)
      if (view.stage !== 1 || view.stale || view.free == null) return null
      if (view.ready.some((r) => r.id === image || r.refs.includes(image))) return null
      const row = view.docker?.available ? view.docker.images.find((r) => r.id === image || r.refs.includes(image)) : undefined
      return row && row.need > view.free ? { need: row.need, free: view.free } : null
    } catch { return null }
  }

  /** Sandboxes on `machine` per recorded image id (sandbox.list; 0 each when it cannot be read). */
  private async sandboxCounts(machine: string): Promise<Map<string, number>> {
    const counts = new Map<string, number>()
    try {
      for (const b of (await pages((p) => this.lfs.sandbox.list(p))).map(sandboxOf)) {
        if (b.machine === machine && b.image) counts.set(b.image, (counts.get(b.image) ?? 0) + 1)
      }
    } catch {}
    return counts
  }

  /**
   * The Stage-0 ready rows: the images of the archive LayerFS picks a
   * Sandbox's root from (layerfs-sandbox `deploy::choose`) — the machine's
   * own archive (`image_archive`, or an `image` path; never on docker), else
   * the pinned Linux bundle's `sandbox-image.tar`. Read through the archive
   * memo (path, size, mtime), so no GET parses a tar again. An image the
   * archive shows LayerFS cannot run is `usable: false` with the reason.
   * Throws when the archive cannot be read; no archive at all is no rows.
   */
  private archiveRows(record: any, platform: string | null, architecture: string): ReadyImage[] {
    const own = platform === 'docker' ? null : text(record?.image)
    const mine = platform === 'docker' ? null : text(record?.image_archive) ?? (own?.startsWith('/') ? own : null)
    const bundle = this.host.bundle?.() ?? null
    const archive = mine ?? (bundle ? join(bundle, 'sandbox-image.tar') : null)
    if (!archive) return []
    const source = mine ? 'machine' as const : 'bundle' as const
    return readArchive(archive).map((i) => {
      const reason: ImageReason | undefined = i.os && i.os !== 'linux' ? { kind: 'os', value: i.os }
        : i.architecture && i.architecture !== architecture ? { kind: 'arch', value: i.architecture }
        : i.problem ? { kind: i.problem } : undefined
      return {
        id: i.digest,
        name: imageName(i.tags) ?? (source === 'bundle' ? BUNDLE_NAME : i.digest.slice(7, 19)),
        refs: i.tags, size: i.size, source, sandboxes: 0, lastUsed: null,
        usable: !reason, ...(reason ? { reason } : {}),
      }
    })
  }

  /**
   * `POST /api/machines/:id/prune-images { images?: id[], unused?: boolean }`
   * (§4.1): machine.prune once per id, or once with `unused`. An image LayerFS
   * keeps (InUse, gone) is listed in `refused`, not an error of the request.
   * 501 while the pinned CLI has no machine.prune.
   */
  async pruneImages(name: string, body: any): Promise<PruneAnswer> {
    if (!name) throw refuse(null, 'InvalidInput', 'name the machine')
    if (!(await cliFeatures(this.host)).imagePrune) {
      throw Object.assign(refuse(501, 'Unsupported', 'The pinned LayerFS CLI cannot remove a machine\'s images (it has no machine.prune).'), { detail: { need: 'image-prune' } })
    }
    const unused = body?.unused === true
    const ids = [...new Set(refsOf(body?.images))]
    if (!unused && !ids.length) throw refuse(400, 'InvalidInput', 'Name the images to remove, or ask for the unused ones.')
    const answer: PruneAnswer = { removed: [], freed: 0, refused: [] }
    const take = (r: any) => {
      for (const id of refsOf(r?.removed)) if (!answer.removed.includes(id)) answer.removed.push(id)
      answer.freed += num(r?.freed) ?? 0
    }
    if (unused) take(await this.lfs.machine.prune(name, { unused: true }))
    for (const id of ids) {
      try { take(await this.lfs.machine.prune(name, id)) } catch (error: any) {
        if (!PRUNE_PER_IMAGE.has(error?.code)) throw error
        answer.refused.push({ id, code: error.code, message: error?.message ?? String(error) })
      }
    }
    return answer
  }

  /** machine.start(name): a stopped machine and its worker, waited for; native and a running one answer at once. */
  async start(name: string) {
    if (!name) throw refuse(null, 'InvalidInput', 'name the machine to start')
    return this.lfs.machine.start(name, { on_progress: this.progress(name, 'start') })
  }

  /** Startup phases as `machine-progress` events (the Machines page shows them live). */
  private progress(name: string, kind: 'start' | 'create') {
    const started = Date.now()
    return (progress: any) => this.host.emit('machine-progress', {
      type: 'machine-progress', name, kind,
      progress: { ...(progress && typeof progress === 'object' ? progress : { stage: String(progress) }), elapsed_ms: Date.now() - started },
    })
  }

  /** Normal stop preserves InUse refusals; explicit force ends running work. */
  async stop(name: string, { force = false } = {}) {
    if (!name) throw refuse(null, 'InvalidInput', 'name the machine to stop')
    if (force && !(await cliFeatures(this.host)).forceStop) throw refuse(501, 'Unsupported', 'The pinned LayerFS CLI has no forced stop (machine.stop takes no force option). Stop the machine normally, or pin a CLI that has it.')
    const result = force ? await this.lfs.machine.stop(name, { force: true }) : await this.lfs.machine.stop(name)
    await this.host.machinesStopped?.([name])
    return result
  }

  /** The options `platform` declares for machine.create (machine.platforms), or null when unknown. */
  async declared(platform: string): Promise<string[] | null> {
    const row = (await this.platforms().catch(() => null))?.platforms.find((p) => p.platform === platform)
    return row ? row.options.map((o) => o.name) : null
  }

  /** A VM: { name, platform, cpus?, memory?, disk?, image? (its Sandbox image), os_image? }. */
  async create(body: any) {
    const { name, platform, ...rest } = body ?? {}
    if (!name || !platform) throw refuse(null, 'InvalidInput', 'a machine needs a name and a platform')
    if (OFF.has(platform)) throw refuse(null, 'Unsupported', `${platform} machines are turned off`)
    // the options this platform declares (machine.platforms); one it does not take is refused here, not sent
    const declared = (await this.declared(platform)) ?? ['cpus', 'memory', 'disk', 'image']
    const given = pick(rest, Object.keys(rest))
    const extra = Object.keys(given).filter((k) => !declared.includes(k))
    if (extra.length) throw refuse(null, 'InvalidInput', `${platform} takes no ${extra.join(', ')} (its options: ${declared.join(', ') || 'none'})`)
    return this.lfs.machine.create(name, platform, { ...given, on_progress: this.progress(name, 'create') })
  }

  /** Removes a VM; LayerFS refuses InUse while it holds Stores or running Sandboxes. */
  async remove(name: string) {
    const lfs = this.lfs
    if (BUILT_IN.has(name)) throw refuse(null, 'InvalidInput', `${name} is built in and can't be removed`)
    const m = list((await lfs.machine.list()).machines).find((x) => x.name === name)
    if (!m) throw refuse(null, 'NotFound', `no machine named ${name}`)
    return lfs.machine.remove(name)
  }

  /** A built-in's settings ({ image, docker, wsl }) or a VM's size ({ cpus, memory }). */
  async update(name: string, body: any) {
    const changes = pick(body ?? {}, ['cpus', 'memory', 'image', 'docker', 'wsl'])
    return this.lfs.machine.update(name, changes)
  }

  /** Puts a sqlite Store on `machine`: a job in the host's table (its progress shows on Storage). */
  async moveStore(store: string, machine: string) {
    if (!store || !machine) throw refuse(null, 'InvalidInput', 'name the Store and the machine')
    if (!this.place) throw refuse(null, 'Unsupported', 'this host has no Storage job table to push or pull with')
    return this.place(store, machine)
  }
}

/**
 * The preselected ready row (D7): the usable row used last (`lastUsed`,
 * Stage 1), else the machine's own default when it is a usable row, else the
 * only row when usable, else the first usable row; none without rows.
 */
export function defaultOf(rows: readonly Pick<ReadyImage, 'id' | 'usable' | 'lastUsed'>[], pinned: string | null): string | null {
  const usable = rows.filter((r) => r.usable)
  const used = usable.filter((r) => r.lastUsed && Number.isFinite(Date.parse(r.lastUsed))).sort((a, b) => Date.parse(b.lastUsed!) - Date.parse(a.lastUsed!))
  if (used.length) return used[0].id
  if (pinned && usable.some((r) => r.id === pinned)) return pinned
  if (rows.length === 1 && rows[0].usable) return rows[0].id
  return usable[0]?.id ?? null
}
