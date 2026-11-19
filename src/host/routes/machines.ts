/**
 * Compute's machines (LayerFS 2.0, layerfs#533): `GET /api/machines` and the
 * calls the Machines page makes. Port of Connect `host/machines.js`.
 *
 * A LayerFS 2.0 home's compute is a set of machines: `native` and `docker`
 * built in, and VMs it creates (apple-container, microsandbox, lima).
 * LayerFS's ssh hosts and Firecracker machines are turned off (OFF): the
 * platforms list leaves them out and machine.create refuses them. A
 * machine holds sqlite Stores; a project's Sandboxes run on its Store's
 * machine. Power is manual (#535 D11): a machine runs between machine.start
 * and machine.stop, and no call starts one on demand.
 *
 * The 2.0 machine family (call-surface-2-0 `machine` rows): `machine list
 * --detail` (records only: each machine's six-state `state` with its
 * companion `op`, `reason` and `fix`, never guessed here), then `machine get
 * <m> --detail --with live` for each machine whose record LayerFS can read
 * (the live probe: the state it finds, free disk, tool version, worker;
 * native's is its free disk), with store.list() and
 * sandbox.list(): one read for the page, and none of it starts a machine.
 * The platforms come from `home get --with platforms`. One answer serves
 * every tab for {@link VIEW_KEEP_MS}. Whether a
 * listed Sandbox's daemon runs (`live`, layerfs-project#164) comes from the
 * metrics sampler's newest point (metrics.ts, #182 D2): the sampler reads
 * each machine once per 15 s, whoever looks.
 */
import { join } from 'node:path'
import { computer } from './computer.ts'
import { readArchive, type ImageProblem } from '../images/archive.ts'
import { InspectReads, filesQuery, logQuery, refusalOf, type FilesView, type LogView } from './inspect.ts'
import { MetricsSampler, STOPPED } from './metrics.ts'
import { liveOf, spaceAnswer, type MachineSpace, type MachineSpaceView, type MachineStatsView } from './observed.ts'
import { Answer, cliFeatures, featuresOf, fixOf, pages, refuse, type CliFeatures, type RouteHost } from './util.ts'
import { ImageLoads, type LoadReport } from './image-loads.ts'
import { createPhase } from './projects.ts'
import { pgMachineOf, StoreMachines } from '../store-machines.ts'
import { companionsOf, machineOf, opOf, unreadableRecord, probedRecord } from '../layerfs/machine-records.ts'

export { machineOf, opOf, STATES } from '../layerfs/machine-records.ts'
import { engineSocket, realEngineDeps, startEngine, type EngineDeps } from './docker-engine.ts'

const BUILT_IN = new Set(['native', 'docker'])
/** Platforms LayerFS has that are turned off here: not offered, not created or connected. */
export const OFF = new Set(['ssh', 'firecracker'])
/** Create options only Firecracker used (a nested Lima machine hosts it): not offered either. */
const OFF_OPTIONS = new Set(['nested', 'host'])
/** How long one machines view answers every tab (a write reads anew at once). */
export const VIEW_KEEP_MS = 5000

const list = (value: any): any[] => (Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [])
const DIGEST = /^sha256:[a-f0-9]{64}$/
/** The bundle's image has no RepoTags: what to call it. */
const BUNDLE_NAME = 'LayerFS default'
/** LayerFS's own copy of the bundle image in Docker (`layerfs-cache/sandbox:<config digest hex>`): never shown as a name. */
const CACHE_REF = /^layerfs-cache\//
/** Refusals of one image in a prune: answered in `refused`, the request goes on. */
const PRUNE_PER_IMAGE = new Set(['InUse', 'NotFound', 'InvalidInput'])

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
  /**
   * The item's 2.0 state (spec v19): absent when ready; `busy` while a copy
   * holds it (`op`: load_image and its phase); `broken` with `reason: partial`
   * and the `fix` (`layerfs machine load-image …`) that resumes it. Not usable
   * then.
   */
  state?: 'busy' | 'broken'
  op?: { name: string, phase: string, started: number | null } | null
  partial?: boolean
  /** A broken partial copy's bytes staged so far (`staged_bytes`). */
  staged?: number
  fix?: string
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

/** LayerFS's `Unavailable` for a machine whose worker runs another LayerFS build ("is of another build", "replace its worker"). */
const WORKER_OUTDATED = /another build|replace its worker|outdated/i

/**
 * Why a machine.images read failed, as the answer's `stale` (§4.1): the
 * refusal's code, message and `fix`; a worker of another LayerFS build is
 * `WorkerOutdated` (the machine runs, restarting its worker fixes it),
 * not a stopped machine.
 */
export function staleOf(error: any, at: number): { at: number, code: string, message: string, fix?: string } {
  const message = error instanceof Error ? error.message : typeof error?.message === 'string' ? error.message : String(error)
  const code = typeof error?.code === 'string' ? error.code : 'Unknown'
  const fix = typeof error?.fix === 'string' && error.fix ? error.fix : null
  return { at, code: code === 'Unavailable' && WORKER_OUTDATED.test(message) ? 'WorkerOutdated' : code, message, ...(fix ? { fix } : {}) }
}

/** An image's name (§5.1.1): the ref ending `:latest` if it has one (what people pick), else its first ref. */
export const imageName = (refs: readonly string[]): string | undefined => refs.find((r) => r.endsWith(':latest')) ?? refs[0]

/**
 * One `machine images --detail` item as a row; null without an id. A ready
 * item (no `state`) is usable. A `busy` one (a copy holds it, `op`) and a
 * `broken` one (`reason: partial`, a part no copy holds, with the `fix` that
 * resumes it, and `staged_bytes` copied so far) are listed but not usable (spec v19).
 */
export function readyOf(i: any): ReadyImage | null {
  const id = text(i?.image)
  if (!id) return null
  const refs = refsOf(i.refs).filter((r) => !CACHE_REF.test(r))
  const source = i.source === 'bundle' || i.source === 'machine' ? i.source : 'imported'
  const row: ReadyImage = {
    id, name: imageName(refs) ?? (source === 'bundle' ? BUNDLE_NAME : id.replace(/^sha256:/, '').slice(0, 12)),
    refs, size: num(i.size), source, sandboxes: num(i.sandboxes_count) ?? count(i.sandboxes), lastUsed: isoOf(i.last_used_at), usable: true,
  }
  if (i.state === 'busy') return { ...row, usable: false, state: 'busy', op: opOf(i.op) }
  if (i.state === 'broken') return { ...row, usable: false, state: 'broken', partial: i.reason === 'partial', ...(text(i.fix) ? { fix: i.fix } : {}), ...(num(i.staged_bytes) !== null ? { staged: num(i.staged_bytes)! } : {}) }
  return row
}

/**
 * `machine images --with docker`'s `docker` section as the "From Docker"
 * group (§4.1): the host's Docker images the machine does not hold (D3), each
 * `{image, refs, size, os, architecture, usable, needed_bytes, fits,
 * unusable}`; `reason` and `message` say why Docker did not answer (then
 * `images` is empty). Null when LayerFS gives no section (macOS native).
 */
export function dockerOf(answer: any): SandboxImagesView['docker'] {
  const d = answer?.docker
  if (!d || typeof d !== 'object') return null
  if (text(d.reason)) {
    const reason = d.reason === 'not_installed' ? 'not-installed' : d.reason === 'not_running' || d.reason === 'engine_down' ? 'not-running' : 'error'
    return { available: false, reason, ...(text(d.message) ? { message: d.message } : {}) }
  }
  const images: DockerImage[] = []
  for (const r of Array.isArray(d.images) ? d.images : []) {
    const id = text(r?.image)
    const refs = refsOf(r?.refs)
    if (!id) continue
    const u = r.unusable
    const reason: ImageReason | undefined = u && typeof u === 'object' && typeof u.kind === 'string'
      ? { kind: u.kind, ...(text(u.value) ? { value: u.value } : {}) } : undefined
    images.push({
      id, name: imageName(refs) ?? id.replace(/^sha256:/, '').slice(0, 12), refs, size: num(r.size) ?? 0,
      architecture: text(r.architecture) ?? '', os: text(r.os) ?? '', need: num(r.needed_bytes) ?? 0, fits: r.fits !== false,
      usable: r.usable !== false, ...(reason ? { reason } : {}),
    })
  }
  return { available: true, images }
}

/** A machine's `--with live` section (`machine get`): free disk, the provider tool's version, its worker; or why the probe was not made. */
export function machineLive(name: string, got: any, error?: any) {
  const live = got?.live && typeof got.live === 'object' ? got.live : null
  return {
    name,
    freeDisk: num(live?.disk_free_bytes),
    toolVersion: text(live?.tool_version),
    worker: live?.worker && typeof live.worker === 'object' ? { protocol: live.worker.protocol == null ? null : String(live.worker.protocol), bundle: text(live.worker.bundle) } : null,
    ...(error ? { error: { code: typeof error?.code === 'string' ? error.code : 'Unknown', message: String(error?.message ?? error), ...fixOf(error) } } : {}),
  }
}

/** One `home get --with platforms` item (`platforms.items`), as the SDK answers it. */
export const platformOf = (p: any) => ({
  platform: String(p.platform),
  how: String(p.how ?? ''),
  backend: text(p.backend),
  route: text(p.route),
  sqlite: text(p.sqlite),
  postgresql: { store_calls: String(p.postgresql?.store_calls ?? ''), sandbox: p.postgresql?.sandbox === true, reason: text(p.postgresql?.reason) },
  ready: p.ready === true,
  missing: list(p.missing).map(String),
  version: text(p.version),
  options: list(p.options).map((o: any) => ({ option: String(o.option), kind: String(o.kind), ...(o.default !== undefined && o.default !== null ? { default: o.default } : {}) })),
  description: String(p.description ?? ''),
  // docker's socket and the ones it could use
  ...(p.socket && typeof p.socket === 'object' ? { socket: { path: text(p.socket.path), source: text(p.socket.source), state: text(p.socket.state) } } : {}),
  ...(Array.isArray(p.candidates) ? { candidates: p.candidates.map((c: any) => ({ path: text(c?.path), source: text(c?.source), ...(text(c?.host) ? { host: text(c.host) } : {}), ...(c?.usable === false ? { usable: false } : {}) })) } : {}),
})

/** One `store list --detail` item, when it is a sqlite Store on a machine: the six-state `state` with its companions. */
export function storeOf(s: any) {
  const machine = text(s.machine)
  if (!machine || s.engine === 'postgresql') return null
  const names = Array.isArray(s.projects) ? s.projects.map(String) : []
  return { name: String(s.store), machine, projects: num(s.projects_count) ?? names.length, names, size: null, state: text(s.state) ?? 'ready', op: opOf(s.op), ...companionsOf(s) }
}

/**
 * One store.list() item, when it is a PostgreSQL Store (on no machine: Sandboxes
 * reach its database). `runsOn`: the machine its sessions run on by default,
 * this DSH install's own choice (store-machines.ts).
 */
export function pgStoreOf(s: any, runsOn: string | null = null) {
  if (s.engine !== 'postgresql') return null
  const names = Array.isArray(s.projects) ? s.projects.map(String) : []
  return { name: String(s.store), projects: num(s.projects_count) ?? names.length, names, state: text(s.state) ?? 'ready', op: opOf(s.op), ...companionsOf(s), runsOn }
}

/**
 * One `sandbox list --detail` row: the six-state `state` with its companions,
 * its Workspace count (null where the machine's worker keeps them,
 * `workspaces_not_listed`, or when blocked). Whether its daemon runs now is
 * the metrics sampler's `live` (withLive), not a list read.
 */
export function sandboxOf(b: any) {
  return { name: String(b.sandbox ?? b.name), machine: text(b.machine), project: text(b.project), workspaces: Array.isArray(b.workspaces) ? b.workspaces.length : null, state: text(b.state) ?? 'ready', op: opOf(b.op), ...companionsOf(b), image: text(b.image), platform: text(b.platform) }
}

/** How long a `machine stats --with space` answer (or refusal) stands before a page's read asks LayerFS again. */
export const SPACE_KEEP_MS = 60_000

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
  /** The last `machine list --detail` rows by name: the records an inspect keeps a broken state from. */
  private records = new Map<string, any>()
  /** The MachinesView read in flight, shared by concurrent GETs; `changed()` (any write) makes later GETs read anew. */
  private viewing: { promise: ReturnType<Machines['readView']>, generation: number } | null = null
  private generation = 0
  /** When `lastView` was read, and in which generation: within VIEW_KEEP_MS of the same generation it answers again without a call. */
  private lastViewAt: { at: number, generation: number } | null = null
  private platformAnswer: { at: number, value: PlatformsView } | null = null
  private platformRead: Promise<PlatformsView> | null = null

  /**
   * @param host - the route dependencies.
   * @param place - puts a Store on a machine as a job in Storage's table (push, pull, or pull then push).
   */
  constructor(private readonly host: RouteHost, private readonly place: ((store: string, machine: string, made?: boolean) => Promise<unknown>) | null = null) {}

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
   * The metrics sampler (metrics.ts, layerfs-project#182 D1): one
   * `machine.stats` at a time across the machines that run, each once per
   * 15 s, kept as an hour of history in memory. Started by the routes plugin
   * (index.ts) for as long as dsh runs; `GET /api/metrics` and the stats route
   * answer from it without a LayerFS call.
   */
  readonly metrics = new MetricsSampler({
    // the native daemon is recorded once before the first call, as the router does before every route
    list: async () => {
      await this.host.ensureNative()
      return list((await this.lfs.machine.list({ detail: true })).items).map((m: any) => ({ name: String(m?.machine ?? ''), state: text(m?.state) ?? 'ready' }))
    },
    // the abort signal is an SDK-side option of monitoring reads (cli.ts), never a CLI flag
    stats: (name, signal) => { const options = { signal, detail: true }; return this.lfs.machine.stats(name, options) },
    offered: async () => (await cliFeatures(this.host)).inspect.machineStats,
  })

  /** The view with each Sandbox's `live` from the sampler's newest point (absent where it has none). */
  private withLive(answer: any): any {
    if (!Array.isArray(answer?.sandboxes)) return answer
    return { ...answer, sandboxes: answer.sandboxes.map((b: any) => ({ ...b, ...this.metrics.liveOf(b.name) })) }
  }

  /**
   * MachinesView: concurrent GETs (the sidebar, the machines store, a dialog) share one read.
   * `fresh`: probe the platforms again now (Check again after an install), not within 30 s.
   */
  async view(fresh = false): Promise<any> {
    if (fresh) { this.platformAnswer = null; this.generation++ }
    const kept = this.lastViewAt
    if (kept && kept.generation === this.generation && Date.now() - kept.at < VIEW_KEEP_MS && this.lastView) return this.withLive(this.lastView)
    if (this.viewing && this.viewing.generation === this.generation) return this.withLive(await this.viewing.promise)
    const generation = this.generation
    const promise = this.readView().finally(() => { if (this.viewing?.promise === promise) this.viewing = null })
    this.viewing = { promise, generation }
    const answer = await promise
    this.lastViewAt = { at: Date.now(), generation }
    return this.withLive(answer)
  }

  private async readView() {
    const lfs = this.lfs
    const rows = list((await lfs.machine.list({ detail: true })).items)
    const readErrors: Record<string, unknown> = {}
    const failed = (name: string) => (e: any) => { readErrors[name] = { error: { code: e?.code ?? 'Unknown', message: e?.message ?? String(e), ...fixOf(e) }, at: Date.now() }; return [] as any[] }
    let host: string | null = null
    const { version, features } = await this.identity()
    // whether each daemon runs is the metrics sampler's (withLive), one machine.stats per machine per 15 s
    const listSandboxes = (p: { limit: number, cursor?: string }) => lfs.sandbox.list({ ...p, detail: true })
    const [platforms, listedStores, sandboxes, probes] = await Promise.all([
      this.platforms().then((p) => { host = p.host || null; return p.platforms }, failed('platforms')),
      lfs.store.list({ detail: true }).then((a: any) => list(a?.items), failed('stores')),
      // records only: a row's Workspaces where the home keeps them
      pages(listSandboxes).then((rows) => rows.map(sandboxOf), failed('sandboxes')),
      // the live probe of each machine (native's answers its free disk): starts nothing; its answer is the machine's current state.
      // A record LayerFS cannot read is not probed: `machine get` refuses it `Failed` with the same fix its list row carries.
      // (a probe that throws at once is a failed probe like any other: the record's row stands)
      Promise.all(rows.filter((m: any) => !unreadableRecord({ state: m?.state, reason: m?.reason, platform: m?.platform })).map((m: any) => Promise.resolve().then(() => lfs.machine.get(String(m.machine), { detail: true, with: ['live'] }))
        .then((got: any) => ({ name: String(m.machine), got }), (error: any) => ({ name: String(m.machine), error })))),
    ])
    const probed = new Map<string, { got?: any, error?: any }>(probes.map((p: any) => [p.name, p]))
    // a probe that answered is the newer word on the machine; one that failed leaves its record's;
    // a record that is broken itself (outdated, unreadable…) keeps its state, reason and fix over any probe
    this.records = new Map(rows.map((m: any) => [String(m.machine), m]))
    const machines = rows.map((m: any) => machineOf(probedRecord(m, probed.get(String(m.machine))?.got)))
    const live = Object.fromEntries([...probed].map(([name, p]) => [name, machineLive(name, p.got, p.error)]))
    const stores = listedStores.map(storeOf).filter(Boolean)
    const saved = new StoreMachines(this.host.root)
    const postgresql = listedStores.map((s: any) => pgStoreOf(s, s.engine === 'postgresql' ? pgMachineOf(saved.get(String(s.store)), machines) : null)).filter(Boolean)
    // features: what the pinned CLI can do (force stop, the image stage and its parts); the page offers only those
    const answer: any = { available: true, readErrors, layerfs: version, features, computer: computer(host), machines, platforms, stores, postgresql, sandboxes, live }
    for (const [part, fields] of Object.entries({ stores: ['stores', 'postgresql'], sandboxes: ['sandboxes'], platforms: ['platforms'] })) {
      if (readErrors[part] && this.lastView) for (const field of fields) answer[field] = this.lastView[field]
    }
    this.lastView = answer
    return answer
  }

  /** `home get --with platforms`: each platform on this host but the ones turned off; starts nothing (PlatformsView). */
  async platforms(): Promise<PlatformsView> {
    const now = Date.now()
    if (this.platformAnswer && now - this.platformAnswer.at < 30000) return this.platformAnswer.value
    if (this.platformRead) return this.platformRead
    this.platformRead = this.readPlatforms().then((value) => { this.platformAnswer = { at: Date.now(), value }; return value }).finally(() => { this.platformRead = null })
    return this.platformRead
  }

  private async readPlatforms(): Promise<PlatformsView> {
    const answer = (await this.lfs.home.get({ detail: true, with: ['platforms'] }))?.platforms ?? {}
    const rows = list(answer.items).map(platformOf).filter((p) => !OFF.has(p.platform))
    return { host: String(answer.host ?? ''), platforms: rows.map((p) => ({ ...p, options: p.options.filter((o: any) => !OFF_OPTIONS.has(o.option)) })) }
  }

  /** `machine get <m> --detail --with live`, with the last listed record's own broken state kept over it ({@link probedRecord}). */
  async inspect(name: string) { return { ...probedRecord(this.records.get(name) ?? null, await this.lfs.machine.get(name, { detail: true, with: ['live'] })), observedAt: Date.now() } }

  /** The monitoring reads' shared state: one read per key, last good answers, page requests that can be cancelled. */
  readonly reads = new InspectReads()

  /**
   * `GET /api/machines/:id/log?before=&limit=&rid=`: the machine's worker log
   * (`machine log`), its last lines without `before`. A 2.0 log pages
   * backwards only (`next_cursor` is `before`): a page that follows it reads
   * the tail again, so a forward `cursor` is refused here. Its own read:
   * never part of the machines view. A refusal (a stopped machine
   * `Unavailable`, a machine without a worker `Unsupported`, a replaced log's
   * cursor `InvalidInput`, a full inspect lane `Busy`, no answer in time
   * `Timeout`) is answered as `stale` with the last good tail, not as an
   * error. 501 while the pinned CLI has no machine.log (the page hides the tab).
   */
  async machineLog(name: string, query: URLSearchParams, outer?: AbortSignal): Promise<LogView> {
    if (!name) throw refuse(400, 'InvalidInput', 'name the machine')
    if (!(await cliFeatures(this.host)).inspect.machineLog) throw noCall('machine.log', 'a machine\'s worker log')
    if (query.get('cursor')) throw refuse(400, 'InvalidInput', 'A machine\'s log pages backwards only: read its tail again, or earlier lines with before.')
    const lfs = this.lfs
    const request = this.reads.request(query.get('rid'), outer)
    try {
      return await this.reads.log(`machine:${name}`, logQuery(query), (o) => lfs.machine.log(name, { ...(o.before ? { cursor: o.before } : {}), ...(o.limit ? { limit: o.limit } : {}), signal: o.signal, detail: true }), request.signal)
    } finally { request.done() }
  }

  /**
   * `GET /api/sandboxes/:name/log?before=&limit=&rid=`: the Sandbox's
   * daemon log (`sandbox log`), as {@link machineLog}. It never waits on
   * sandbox.get and never dials the daemon; a lost or unresolved Sandbox's
   * refusal is answered as `stale`.
   */
  async sandboxLog(name: string, query: URLSearchParams, outer?: AbortSignal): Promise<LogView> {
    if (!name) throw refuse(400, 'InvalidInput', 'name the Sandbox')
    if (!(await cliFeatures(this.host)).inspect.sandboxLog) throw noCall('sandbox.log', 'a Sandbox\'s daemon log')
    if (query.get('cursor')) throw refuse(400, 'InvalidInput', 'A Sandbox\'s log pages backwards only: read its tail again, or earlier lines with before.')
    const lfs = this.lfs
    const request = this.reads.request(query.get('rid'), outer)
    try { return await this.reads.log(`sandbox:${name}`, logQuery(query), (o) => lfs.sandbox.log(name, { ...(o.before ? { cursor: o.before } : {}), ...(o.limit ? { limit: o.limit } : {}), signal: o.signal, detail: true }), request.signal) } finally { request.done() }
  }

  /**
   * `GET /api/machines/:id/files?path=&depth=&cursor=&limit=&offset=&length=&rid=`:
   * the machine's files (machine.files). Without a path, its roots: LayerFS's
   * own folders by role, then `/` where the machine has that view. With one, a
   * folder page (by `cursor`) or a file window (by `offset`). Its own read, as
   * {@link machineLog}: a refusal (`Unavailable`, `InvalidInput`, `Busy`,
   * `Unsupported`, `Timeout`) is answered inside the view (`stale` on a kept
   * folder page, else `refused`), not as an error. 501 while the pinned CLI
   * has no machine.files (the page hides the tab).
   */
  async machineFiles(name: string, query: URLSearchParams, outer?: AbortSignal): Promise<FilesView> {
    if (!name) throw refuse(400, 'InvalidInput', 'name the machine')
    if (!(await cliFeatures(this.host)).inspect.machineFiles) throw noCall('machine.files', 'a machine\'s files')
    const lfs = this.lfs
    const request = this.reads.request(query.get('rid'), outer)
    // 2.0: a file window is `byte_offset` / `byte_length`, and the answer is read in the long form
    const call = (path: string | undefined, { offset, length, ...o }: Record<string, unknown>) => lfs.machine.files(name, path, { ...o, ...(offset != null ? { byte_offset: offset } : {}), ...(length != null ? { byte_length: length } : {}), detail: true })
    try { return await this.reads.files(`machine:${name}`, filesQuery(query), call, request.signal) } finally { request.done() }
  }

  /**
   * `GET /api/sandboxes/:name/files?…`: the Sandbox's files (sandbox.files),
   * as {@link machineFiles}. Without a path, its roots: one per Workspace,
   * its home and its log, then `/` where its commands' root can be read. It
   * never waits on sandbox.get and never dials the daemon.
   */
  async sandboxFiles(name: string, query: URLSearchParams, outer?: AbortSignal): Promise<FilesView> {
    if (!name) throw refuse(400, 'InvalidInput', 'name the Sandbox')
    if (!(await cliFeatures(this.host)).inspect.files) throw noCall('sandbox.files', 'a Sandbox\'s files')
    const lfs = this.lfs
    const request = this.reads.request(query.get('rid'), outer)
    // the shape of machine files: a file window is `byte_offset` / `byte_length`, read in the long form
    const call = (path: string | undefined, { offset, length, ...o }: Record<string, unknown>) => lfs.sandbox.files(name, path, { ...o, ...(offset != null ? { byte_offset: offset } : {}), ...(length != null ? { byte_length: length } : {}), detail: true })
    try { return await this.reads.files(`sandbox:${name}`, filesQuery(query), call, request.signal) } finally { request.done() }
  }

  /**
   * `GET /api/machines/:id/stats`: what the machine has and uses now
   * (machine.stats, layerfs-project#164), as the metrics sampler last read it
   * (#182 D1): no LayerFS call. When the sampler's newest point is a gap (a
   * refusal, or a machine that is not running), it is answered as `stale`
   * with the last good values (none: `stats: null`). 501 while the pinned CLI
   * has no machine.stats.
   */
  async machineStats(name: string): Promise<MachineStatsView> {
    if (!name) throw refuse(400, 'InvalidInput', 'name the machine')
    if (!(await cliFeatures(this.host)).inspect.machineStats) throw noCall('machine.stats', 'a machine\'s observed resources')
    const now = Date.now()
    const kept = this.metrics.machine(name)
    const at = kept?.latest?.at ?? null, stats = kept?.latest?.stats ?? null
    const last = kept?.last
    if (last && !last.values) {
      const code = last.code ?? 'Unknown'
      return { machine: name, readAt: now, at, stats, stale: { at, code: code === STOPPED ? 'Unavailable' : code, message: last.message ?? (code === STOPPED ? 'The machine is not running; it is not asked.' : code) } }
    }
    return { machine: name, readAt: now, at, stats, stale: false }
  }

  /** Each machine's last good `machine stats --with space` answer and when it was read (this host's clock). */
  private readonly spaceKept = new Map<string, { at: number, space: MachineSpace }>()
  /** Each machine's last `machine stats --with space` attempt, good or refused: one read per {@link SPACE_KEEP_MS} unless asked `fresh`. */
  private readonly spaceTried = new Map<string, { at: number, stale: false | { at: number | null, code: string, message: string } }>()

  /**
   * `GET /api/machines/:id/space?fresh=1`: where the machine's data disk goes
   * (`machine stats --with space`): LayerFS's parts, each Sandbox's run folder and what the
   * disk holds that is not LayerFS's. One bounded walk where the machine's
   * data is, so it is read at most once per {@link SPACE_KEEP_MS} per machine
   * (concurrent callers share one read) unless `fresh=1` (the page's Refresh).
   * A refusal (a stopped machine `Unavailable`, an older worker
   * `InvalidInput`, a full lane `Busy`) is answered as `stale` with the last
   * good answer. 501 while the pinned CLI's machine.stats has no `--with space`.
   */
  async machineSpace(name: string, query: URLSearchParams = new URLSearchParams()): Promise<MachineSpaceView> {
    if (!name) throw refuse(400, 'InvalidInput', 'name the machine')
    if (!(await cliFeatures(this.host)).machineSpace) throw noCall('machine.stats --with space', 'where a machine\'s disk goes')
    const tried = this.spaceTried.get(name)
    const answer = (): MachineSpaceView => {
      const kept = this.spaceKept.get(name)
      const last = this.spaceTried.get(name)
      return { machine: name, readAt: Date.now(), at: kept?.at ?? null, space: kept?.space ?? null, stale: last?.stale ?? false }
    }
    if (tried && query.get('fresh') !== '1' && Date.now() - tried.at < SPACE_KEEP_MS) return answer()
    const lfs = this.lfs
    try {
      const raw = await this.reads.read(`space:${name}`, (signal) => { const options = { signal, detail: true, with: ['space'] }; return lfs.machine.stats(name, options) })
      const at = Date.now()
      this.spaceKept.set(name, { at, space: spaceAnswer(raw) })
      this.spaceTried.set(name, { at, stale: false })
    } catch (error: any) {
      this.spaceTried.set(name, { at: Date.now(), stale: refusalOf(error, this.spaceKept.get(name)?.at ?? null) })
    }
    return answer()
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
    try { record = await lfs.machine.get(name, { detail: true }) } catch (error: any) { if (error?.code === 'NotFound') throw error }
    const state = text(record?.state)
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
      const answer = await this.lfs.machine.images(name, { detail: true, with: ['docker'] })
      if (answer?.mode === 'host') return { ...base, stage: 1, free: null, docker: null, mode: 'host', architecture: null, default: null, stale: false, ready: [] }
      const items = Array.isArray(answer?.items) ? answer.items : []
      ready = items.map(readyOf).filter((r: ReadyImage | null): r is ReadyImage => !!r)
      free = num(answer?.disk_free_bytes)
      own = text(items.find((i: any) => i?.default === true)?.image)
      docker = dockerOf(answer)
      architecture = text(answer?.architecture) ?? architecture
      this.keptImages.set(name, { at: base.observedAt, ready, free, default: own, docker })
    } catch (error: any) {
      if (error?.code === 'NotFound') throw error
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
   * or anything is unknown (LayerFS's own Capacity refusal is the real answer).
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

  /** Sandboxes on `machine` per recorded image id (`sandbox list --machine --detail`: `machine` and `image` are long-only; 0 each when it cannot be read). */
  private async sandboxCounts(machine: string): Promise<Map<string, number>> {
    const counts = new Map<string, number>()
    try {
      for (const b of (await pages((p) => this.lfs.sandbox.list({ machine, ...p, detail: true }))).map(sandboxOf)) {
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
   * (§4.1): `machine prune` once per id, or once with `--unused`, in the long
   * form (`removed`, `freed_bytes`). An image LayerFS keeps (InUse, gone) is
   * listed in `refused`, not an error of the request. 501 while the pinned
   * CLI has no machine.prune.
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
      answer.freed += num(r?.freed_bytes) ?? 0
      // `--unused` keeps an image a Sandbox uses or a copy holds: `skipped` items `{ image, message }`
      for (const k of Array.isArray(r?.skipped) ? r.skipped : []) if (text(k?.image)) answer.refused.push({ id: k.image, code: 'Skipped', message: text(k.message) ?? 'kept' })
    }
    if (unused) take(await this.lfs.machine.prune(name, { unused: true, detail: true }))
    for (const id of ids) {
      try { take(await this.lfs.machine.prune(name, id, { detail: true })) } catch (error: any) {
        if (!PRUNE_PER_IMAGE.has(error?.code)) throw error
        answer.refused.push({ id, code: error.code, message: error?.message ?? String(error), ...fixOf(error) })
      }
    }
    return answer
  }

  /** Image copies running in the background (`image-load` events); a copy that ends drops the machine's kept images answer. */
  readonly loads = new ImageLoads((type, data) => this.host.emit(type, data), (machine) => { this.keptImages.delete(machine) })

  /**
   * `POST /api/machines/:id/load-image { image }`: copies one image of this
   * computer's Docker (its Id or a ref) to the machine with `machine
   * load-image`, without creating a Sandbox, in the background: `202 { load }`
   * at once, then `image-load` events (its `{ phase, done, total }` progress:
   * inspect, export, send, unpack). A copy of the same image already running
   * is answered instead of a second one. 501 while the pinned CLI has no
   * machine.load_image. Never starts the machine (a stopped one is refused by LayerFS).
   */
  async loadImage(name: string, body: any): Promise<Answer> {
    if (!name) throw refuse(null, 'InvalidInput', 'name the machine')
    const image = text(body?.image)
    if (!image || image.includes('\0')) throw refuse(400, 'InvalidInput', 'name the Docker image to copy (its Id or a ref)')
    const features = await cliFeatures(this.host)
    if (!features.imageLoad) {
      throw Object.assign(refuse(501, 'Unsupported', 'The pinned LayerFS CLI cannot copy an image to a machine (it has no machine.load_image).'), { detail: { need: 'image-load' } })
    }
    const running = this.loads.running(name, image)
    if (running) return new Answer(202, { load: running })
    // load-image phases: inspect, lock (a plain `{ phase: "lock" }` each second while another copy holds the image), export, send, unpack
    const run = (report: LoadReport) => this.lfs.machine.load_image(name, image, { detail: true, on_progress: (p: unknown) => { const u = createPhase(p); if (u && u.phase !== 'start' && u.phase !== 'mount') report(u as Parameters<LoadReport>[0]) } })
    return new Answer(202, { load: this.loads.admit(name, image, run) })
  }

  /**
   * `machine start <m> --progress`: a stopped machine and its worker, waited
   * for (phases bundle, image, boot, worker); a running one answers
   * `{ unchanged: true }` at once. A lost reply leaves it `broken`,
   * `unresolved`, which the next view's live read settles.
   */
  async start(name: string) {
    if (!name) throw refuse(null, 'InvalidInput', 'name the machine to start')
    const report = this.progress(name, 'start')
    await this.engineFirst(name, report)
    try { return await this.lfs.machine.start(name, { on_progress: report, detail: true }) } finally { this.platformsChanged(); this.metrics.relist() }
  }

  /**
   * An outdated worker's fix (R2, review fix 5): `machine stop <m>` then
   * `machine start <m>`, one attempt each; refused before anything runs while
   * Sandboxes are on the machine (their stop needs `--force`, which this host
   * never sends for a fix).
   */
  async restart(name: string) {
    if (!name) throw refuse(null, 'InvalidInput', 'name the machine to restart')
    const m = machineOf(await this.lfs.machine.get(name, { detail: true }))
    if (m.sandboxes.length) throw refuse(409, 'InUse', `${m.sandboxes.length} Sandbox${m.sandboxes.length === 1 ? ' is' : 'es are'} on ${name}; copy the fix to stop it anyway`)
    await this.stop(name)
    return this.start(name)
  }

  /** The Docker Engine launch in flight, shared by concurrent starts. */
  private engine: Promise<unknown> | null = null
  /** What the Engine launch reaches outside (fakes in tests). */
  engineDeps: () => EngineDeps = realEngineDeps

  /**
   * A docker machine on macOS whose platform is not ready only because the
   * Docker Engine does not answer at its socket: launch the Engine and wait
   * for it (docker-engine.ts), then read the platforms anew. Any other machine,
   * OS or missing need goes straight to machine.start, which refuses as before.
   */
  private async engineFirst(name: string, report: (progress: any) => void): Promise<void> {
    const socket = await this.engineSocketOf(name)
    if (!socket) return
    this.engine ??= startEngine(socket, this.engineDeps(), report).finally(() => {
      this.engine = null
      // the platform row said the socket did not answer: probe it again now, and the page reads anew
      this.platformsChanged()
      this.changed()
    })
    await this.engine
  }

  /** The socket whose Engine must be started before `name` can start, or null; a read that fails is null (machine.start answers as before). */
  private async engineSocketOf(name: string): Promise<string | null> {
    try {
      const known = Array.isArray(this.lastView?.machines) ? this.lastView.machines.find((m: any) => m.name === name) : undefined
      const platform = known?.platform ?? text((await this.lfs.machine.get(name, { detail: true }))?.platform)
      if (platform !== 'docker') return null
      const view = await this.platforms()
      if (computer(view.host).os !== 'macos') return null
      return engineSocket(view.platforms.find((p) => p.platform === 'docker'))
    } catch { return null }
  }

  /** Phases (`{ phase, done, total }`) as `machine-progress` events (the Machines page shows them live). */
  private progress(name: string, kind: 'start' | 'create' | 'stop' | 'remove') {
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
    const result = await this.lfs.machine.stop(name, { ...(force ? { force: true } : {}), on_progress: this.progress(name, 'stop'), detail: true }).finally(() => this.platformsChanged())
    this.metrics.relist()
    await this.host.machinesStopped?.([name])
    return result
  }

  /** The options `platform` declares for machine.create (`home get --with platforms`), or null when unknown. */
  async declared(platform: string): Promise<string[] | null> {
    const row = (await this.platforms().catch(() => null))?.platforms.find((p) => p.platform === platform)
    return row ? row.options.map((o) => o.option) : null
  }

  /** A VM: { name, platform, cpus?, memory?, disk?, image? (its Sandbox image), os_image? }. */
  async create(body: any) {
    const { name, platform, ...rest } = body ?? {}
    if (!name || !platform) throw refuse(null, 'InvalidInput', 'a machine needs a name and a platform')
    if (OFF.has(platform)) throw refuse(null, 'Unsupported', `${platform} machines are turned off`)
    // the options this platform declares (its platforms row); one it does not take is refused here, not sent
    const declared = (await this.declared(platform)) ?? ['cpus', 'memory', 'disk', 'image']
    const given = pick(rest, Object.keys(rest))
    const extra = Object.keys(given).filter((k) => !declared.includes(k))
    if (extra.length) throw refuse(null, 'InvalidInput', `${platform} takes no ${extra.join(', ')} (its options: ${declared.join(', ') || 'none'})`)
    try { return await this.lfs.machine.create(name, platform, { ...given, on_progress: this.progress(name, 'create'), detail: true }) } finally { this.platformsChanged(); this.metrics.relist() }
  }

  /**
   * Removes a VM; LayerFS refuses InUse while it holds Stores or running
   * Sandboxes. A built-in is LayerFS's to refuse: it removes one only as the
   * fix of a record with no vm_name (`layerfs machine remove docker`: its
   * record goes and the built-in comes back fresh), so the page only sends it
   * as that fix.
   */
  async remove(name: string) {
    const lfs = this.lfs
    try { return await lfs.machine.remove(name, { on_progress: this.progress(name, 'remove'), detail: true }) } finally { this.platformsChanged(); this.metrics.relist() }
  }

  /** A built-in's settings ({ image, docker, wsl }); a VM's `cpus`/`memory` are refused `Unsupported` by LayerFS 2.0 (no resizing; there is no `disk`). */
  async update(name: string, body: any) {
    const changes = pick(body ?? {}, ['cpus', 'memory', 'image', 'docker', 'wsl'])
    if (body?.disk != null) throw refuse(400, 'InvalidInput', 'A machine\'s disk cannot be changed (LayerFS 2.0 resizes nothing).')
    // `docker: ""` clears docker's recorded socket (automatic until its next start records one)
    if (body?.docker === '') changes.docker = ''
    try { return await this.lfs.machine.update(name, { ...changes, detail: true }) } finally { this.platformsChanged() }
  }

  /** A machine write or an Engine start: the platforms (docker's socket, a VM tool) are probed again on the next read. */
  platformsChanged(): void { this.platformAnswer = null }

  /** Puts a sqlite Store on `machine`: a job in the host's table (its progress shows on Storage). */
  /** @param made - the Store was just made by a New Store dialog (the job's words say so). */
  async moveStore(store: string, machine: string, made = false) {
    if (!store || !machine) throw refuse(null, 'InvalidInput', 'name the Store and the machine')
    if (!this.place) throw refuse(null, 'Unsupported', 'this host has no Storage job table to push or pull with')
    return this.place(store, machine, made)
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
