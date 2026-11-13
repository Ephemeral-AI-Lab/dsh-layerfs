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
import { cliFeatures, featuresOf, pages, refuse, type CliFeatures, type RouteHost } from './util.ts'

const BUILT_IN = new Set(['native', 'docker'])
/** Platforms LayerFS has that are turned off here: not offered, not created or connected. */
export const OFF = new Set(['ssh', 'firecracker'])
/** Create options only Firecracker used (a nested Lima machine hosts it): not offered either. */
const OFF_OPTIONS = new Set(['nested', 'host'])
/** States whose machine.status says something the list does not: free disk, or the op that holds it. */
const ASK_STATUS = new Set(['running', 'stopped', 'creating', 'removing', 'unresolved', 'failed', 'unknown'])

const list = (value: any): any[] => (Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [])
const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)
const count = (value: unknown): number => (typeof value === 'number' ? value : Array.isArray(value) ? value.length : 0)
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

/** One machine.list() entry, as the page reads it. */
export function machineOf(m: any) {
  return {
    name: String(m.name),
    platform: String(m.platform),
    backend: text(m.backend),
    // the SDK's state, as it is (#537 U4)
    state: text(m.state) ?? 'unknown',
    ...(m.supports && typeof m.supports === 'object' ? { supports: { sqlite: m.supports.sqlite !== false, postgresql_sandbox: m.supports.postgresql_sandbox === true, reason: text(m.supports.reason) } } : {}),
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
      return { version: d.identity?.version ?? null, features: featuresOf(d.calls) }
    } catch { return { version: null, features: featuresOf([]) } }
  }

  /** A write somewhere (the router calls this on every non-GET): the next view() reads anew. */
  changed(): void { this.generation++ }

  /** MachinesView: concurrent GETs (the sidebar, the machines store, a dialog) share one read. */
  view(): ReturnType<Machines['readView']> {
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
    const [platforms, listedStores, sandboxes, statuses] = await Promise.all([
      this.platforms().then((p) => p.platforms, failed('platforms')),
      lfs.store.list().then(list, failed('stores')),
      // sandbox.list items carry no Workspaces: each one's count is its sandbox.get (a record read; null when refused)
      pages((p) => lfs.sandbox.list(p)).then((rows) => rows.map(sandboxOf), failed('sandboxes')),
      // Starts nothing; stopped machines can carry provider/socket diagnostics too.
      Promise.all(machines.filter((m) => m.platform !== 'native' && ASK_STATUS.has(m.state)).map((m) => lfs.machine.status(m.name).then(statusOf, (e: any) => ({ name: m.name, state: null, freeDisk: null, toolVersion: null, down: e?.message ?? String(e), op: null })))),
    ])
    const stores = listedStores.map(storeOf).filter(Boolean)
    const postgresql = listedStores.map(pgStoreOf).filter(Boolean)
    const { version, features } = await this.identity()
    // features: what the pinned CLI can do (force stop, image inventory, image archives); the page offers only those
    const answer: any = { available: true, readErrors, layerfs: version, features, machines, platforms, stores, postgresql, sandboxes, status: Object.fromEntries(statuses.map((s: any) => [s.name, s])) }
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

  /**
   * The selected machine's Sandbox archive inventory; never starts or pulls.
   * A CLI without machine.images answers `mode: 'unsupported'` with no images.
   */
  async images(name: string) {
    if (!(await cliFeatures(this.host)).images) return { machine: name, mode: 'unsupported', default_digest: null, images: [] }
    return this.lfs.machine.images(name)
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
    return this.lfs.machine.update(name, pick(body ?? {}, ['cpus', 'memory', 'image', 'docker', 'wsl']))
  }

  /** Puts a sqlite Store on `machine`: a job in the host's table (its progress shows on Storage). */
  async moveStore(store: string, machine: string) {
    if (!store || !machine) throw refuse(null, 'InvalidInput', 'name the Store and the machine')
    if (!this.place) throw refuse(null, 'Unsupported', 'this host has no Storage job table to push or pull with')
    return this.place(store, machine)
  }
}
