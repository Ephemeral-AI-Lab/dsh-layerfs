/**
 * Storage on LayerFS 2.0: the home's Stores by machine, PostgreSQL Stores and
 * the machines attached to them, buckets and their backups, and the moves,
 * backups, restores and compactions this host started. Port of Connect
 * `host/storage.js`.
 *
 *   view              StorageView: `store list --detail --with stats` (records,
 *                     and each sqlite file's size from one stat on its machine;
 *                     it starts nothing), each PostgreSQL Store's `store get
 *                     --detail` (its saved connection and attached machines
 *                     with their last reach; reads never dial), machine.list
 *                     for the groups, the buckets from `home get --with tree`
 *                     and their last listing, and the job table
 *   createStore       store.create(name): a sqlite Store on native
 *   removeStore       store.remove(name), `confirm` naming it
 *   connectPostgresql store.connect(name, url, { user, password,
 *                     synchronous_commit }): the URL is an address alone; the
 *                     password goes on stdin. The host checks it before it saves.
 *   updateConnection  store.connect again with what changed (an omitted user or
 *                     password keeps the saved one), then store.doctor, which
 *                     checks from the host and every attached machine
 *   attach / detach   store.attach / store.detach (`--machine`), one machine at
 *                     a time; attach checks from that machine before it records
 *   checkStore        store.doctor(name, { machine? }): the host, then its
 *                     attached machines (or the one named); the answer is the
 *                     reaches LayerFS recorded, read back with store.get
 *   disconnectStore   store.disconnect(name): a PostgreSQL Store
 *   connectBucket     backup.connect(name, url, { access_key, secret_key }):
 *                     the secret on stdin; LayerFS keeps it in the home
 *   disconnectBucket  backup.disconnect(name): every Store's link to it goes
 *   listBucket        backup.list({ bucket }): its files, `behind`, `changed`,
 *                     `missing`; a bucket that cannot be listed is `not_listed`
 *   push/pull/move    store.move as jobs: to a machine from native, to native,
 *                     or between two machines through native (two moves, #537 U5)
 *   place             the one of push, pull or move that puts a Store on a machine
 *   backup/restore    backup.create / backup.restore as jobs
 *   compact           store.compact as a job, its phases from on_progress (a
 *                     remote sqlite Store is compacted by its machine's worker)
 *   upgrade / stop    store.upgrade as a job (#804 §10): an older-format Store
 *                     to the latest format in place, its phases check,
 *                     convert, verify, commit (PostgreSQL check, convert).
 *                     Stop is the export pattern: SIGTERM to the job's CLI,
 *                     then its reply decides (`Cancelled` is `stopped`; an
 *                     `upgraded` reply is success); refused 409 at `commit`.
 *
 * Formats (`--with format`, when the pinned CLI lists it): each Store row's
 * `format` { version, latest, status, fix } comes from the same `store list`
 * call (no read of its own); the view says what the CLI can do (`upgrade`,
 * `format`) and the formats it writes (`formats`, `--version --json`).
 *
 * Secrets (a PostgreSQL password, a bucket's secret key) go to LayerFS on
 * stdin and are kept by the home (its secret folder); the host never writes,
 * keeps, logs or answers one. Storage state lives in the LayerFS home
 * (docs/specs/homes.md §5): the job table is in `host.jobs` (`<home>/job`).
 * Events: `storage-job` `{ type, job }` as a job moves, `storage` `{ type }`
 * when the view changed.
 */
import { READ_TIMEOUT_MS } from '../layerfs/cli.ts'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
import { COMPACT_STEPS, JobStore, UPGRADE_STEPS, failureOutcome, inspectJob, transferSummary, upgradeOutcome, type StorageJob } from './jobs.ts'
import { killGroup } from './project-exports.ts'
import { computer } from './computer.ts'
import { cliFeatures, fixOf, pages, refuse, wire, type RouteHost } from './util.ts'
import { StoreSizes } from './store-sizes.ts'
import { attachedOf, companionsOf, machineRows, msAt, opOf } from '../layerfs/machine-records.ts'

/** Finished jobs kept in the table. */
const KEEP_JOBS = 30
/** A project list joins a view this recent instead of reading one. */
const JOIN_MS = 15_000
/** The most a check from a machine may take. */
const CHECK_TIMEOUT_MS = 30_000

function checkName(value: unknown, what: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-z0-9](?:[a-z0-9_.-]{0,61}[a-z0-9])?$/.test(value)) throw refuse(400, 'InvalidInput', `${what} needs a lowercase name (maximum 63 characters), starting and ending with a letter or number`)
}

/** A URL with no user or password in it (LayerFS refuses one: logins are saved apart). */
function checkUrl(value: unknown, what: string): void {
  let url: URL
  try {
    url = new URL(String(value))
  } catch {
    throw refuse(400, 'InvalidInput', `${what} is not a URL`)
  }
  if (url.password || url.username) throw refuse(400, 'InvalidInput', `${what} must not hold a user or password: they are given apart`)
  // a login in a parameter, or a password file, is refused as LayerFS refuses it (spec v23 V23-13); sslkey/sslcert name files and pass
  if ([...url.searchParams.keys()].some((k) => loginParameter(k))) throw refuse(400, 'InvalidInput', `${what} must not carry a user, a password or a password file: give the login apart`)
}

/** Whether URL parameter `name` carries a login (`user`, any `password`, `passfile`), as LayerFS reads it. */
export const loginParameter = (name: string): boolean => { const n = name.toLowerCase(); return n === 'user' || n === 'passfile' || n.includes('password') }

/** A reach as LayerFS records it (`reach`, `machines[].reach`), as the page reads it. */
function reachOf(r: any): { at: number | null, ok: boolean, latencyMs: number | null, version: string | null, error: string | null } | null {
  if (!r || typeof r !== 'object') return null
  return { at: msAt(r.at), ok: r.ok === true, latencyMs: typeof r.latency_ms === 'number' ? r.latency_ms : null, version: typeof r.server_version === 'string' ? r.server_version : null, error: typeof r.error === 'string' ? r.error : null }
}

const word = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

/** A refused reach as the page reads it: LayerFS's code, words and fix, and the connection `step` it stopped at (its detail). */
function reachError(error: any): { code: string, message: string, fix?: string, step: string | null } {
  const step = word(error?.detail?.step) ?? word(error?.step)
  return { code: String(error?.code ?? 'Failed'), message: String(error?.message ?? error), ...(error?.fix ? { fix: String(error.fix) } : {}), step }
}

/**
 * One place a connection test ran from (`store connect --dry-run`'s `here` or
 * a `machines` row): passed, failed, or (a machine, when this computer's own
 * check failed first) not checked, `ok: null`.
 */
function tested(r: any): { ok: boolean | null, latencyMs: number | null, version: string | null, error: { code: string, message: string, step: string | null } | null } {
  const ok = r?.ok === true ? true : r?.ok === false ? false : null
  return {
    ok, latencyMs: typeof r?.latency_ms === 'number' ? r.latency_ms : null, version: word(r?.server_version),
    error: ok === false ? { code: word(r?.code) ?? 'Unavailable', message: word(r?.message) ?? '', step: word(r?.step) } : null,
  }
}

/** A synchronous_commit value LayerFS takes, or undefined (keep the saved one). */
const SYNC = new Set(['off', 'local', 'remote_write', 'on', 'remote_apply'])
const syncOf = (v: unknown): string | undefined => {
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v !== 'string' || !SYNC.has(v)) throw refuse(400, 'InvalidInput', `synchronous_commit is one of ${[...SYNC].join(', ')}`)
  return v
}

/**
 * The machines attached to a PostgreSQL Store as the page reads them
 * ({@link attachedOf}: `store get` `machines` rows, or the bare names
 * `store list` gives). A machine attached but not yet checked has no reach
 * (`reached` null): "not checked".
 */
export function attachedRows(s: any): { machine: string, reached: 'ok' | 'failed' | null, reach: ReturnType<typeof reachOf> }[] {
  return attachedOf(s).map((r) => ({ machine: r.machine, reached: r.reached, reach: reachOf(r.reach) }))
}

/**
 * A PostgreSQL Store's saved connection (`store get`): its address (never a
 * login), user, whether a password is saved and when it changed, its
 * synchronous_commit and id, and the host's last check (`reach`; null until
 * the host checks it). `passwordSaved` is null when the record was not read.
 */
export function pgOf(s: any) {
  const url = word(s?.url)
  const where = pgWhere(url)
  const user = word(s?.user)
  return {
    url, target: url ? pgTarget(url, user) : null, server: where?.server ?? null, database: where?.database ?? null,
    user,
    passwordSaved: typeof s?.password_saved === 'boolean' ? s.password_saved as boolean : null,
    passwordChangedAt: msAt(s?.password_changed_at),
    synchronousCommit: word(s?.synchronous_commit),
    binding: word(s?.binding),
    host: reachOf(s?.reach),
  }
}

/** A bucket URL from its parts: MinIO `<endpoint>/<bucket>/<prefix>`, R2 `r2://<account>/<bucket>/<prefix>[?jurisdiction=…]`. */
export function bucketUrl({ provider, endpoint, account, jurisdiction, bucket, prefix }: any = {}): string {
  const path = [bucket, ...(prefix ? [String(prefix).replace(/^\/+|\/+$/g, '')] : [])].filter(Boolean).join('/')
  if (!bucket) throw refuse(400, 'InvalidInput', 'Name the bucket')
  if (provider === 'r2') {
    if (!/^[0-9a-f]{32}$/.test(account ?? '')) throw refuse(400, 'InvalidInput', 'A Cloudflare account id is 32 lowercase hex digits')
    return `r2://${account}/${path}${jurisdiction ? `?jurisdiction=${jurisdiction}` : ''}`
  }
  if (provider === 'minio') {
    if (!/^https?:\/\//.test(endpoint ?? '')) throw refuse(400, 'InvalidInput', 'A MinIO endpoint is http(s)://host:port')
    return `${String(endpoint).replace(/\/+$/, '')}/${path}`
  }
  throw refuse(400, 'InvalidInput', 'Choose MinIO or Cloudflare R2')
}

/** A PostgreSQL URL as `user@host:port/db` (the saved user, else the URL's), never a password or parameters; null when it does not parse. */
function pgTarget(url: string, user: string | null = null): string | null {
  try {
    const u = new URL(url)
    const who = user ?? (u.username ? decodeURIComponent(u.username) : null)
    return `${who ? `${who}@` : ''}${u.host}${u.pathname}`
  } catch {
    return null
  }
}

/**
 * Where a PostgreSQL URL points: the server as `host:port` (host in lower
 * case, port 5432 by default, as LayerFS compares them), the database and
 * the user. Null when it does not parse.
 */
export function pgWhere(url: unknown): { server: string, database: string | null, user: string | null } | null {
  if (typeof url !== 'string') return null
  try {
    const u = new URL(url)
    if (!/^postgres(ql)?:$/.test(u.protocol) || !u.hostname) return null
    const database = decodeURIComponent(u.pathname.replace(/^\//, '')) || null
    return { server: `${u.hostname.toLowerCase()}:${u.port || '5432'}`, database, user: u.username ? decodeURIComponent(u.username) : null }
  } catch {
    return null
  }
}

/**
 * An earlier build kept storage state in `<home>/dsh-layerfs/`, named after this
 * plugin. Move it to the client-neutral folders (`job/`, `stat/`) once: what
 * already exists there wins and the old copy is dropped (job history and
 * statistics are rebuilt or regrow), so the old folder always goes. Never throws. Called when the routes start, never
 * from the service constructor (which must not touch the home).
 */
export function moveLegacyStorageState(home: string, jobDir: string, statDir: string): void {
  const legacy = join(home, 'dsh-layerfs')
  if (!existsSync(legacy)) return
  const moves: [string, string][] = [['storage-jobs.json', jobDir], ['doctor-jobs.json', jobDir], ['storage-observations', statDir], ['project-storage', statDir]]
  for (const [name, dir] of moves) {
    try {
      if (!existsSync(join(legacy, name))) continue
      if (existsSync(join(dir, name))) { rmSync(join(legacy, name), { recursive: true, force: true }); continue }
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      renameSync(join(legacy, name), join(dir, name))
    } catch {}
  }
  try { rmdirSync(legacy) } catch {}
}

/**
 * One `store list --detail --with stats` item -> StoreRow: the six-state
 * `state` with its companions, its projects (the first 20 names and the
 * count), its size, its backup links, and (PostgreSQL) its saved connection
 * and the machines attached to it (`attached`).
 */
export function storeRow(s: any, jobs: StorageJob[]) {
  const kind: 'sqlite' | 'postgresql' = s.engine === 'postgresql' ? 'postgresql' : 'sqlite'
  const names = (Array.isArray(s.projects) ? s.projects : []).map(String)
  // this host's upgrade holds the Store: busy with it, whatever the list read before its op was recorded
  const upgrading = jobs.find((j) => j.store === s.store && !j.ended && j.kind === 'upgrade')
  const held = upgrading && (s.state ?? 'ready') === 'ready' ? { state: 'busy', op: { id: '', name: 'store.upgrade', phase: upgrading.phase ?? '', started: upgrading.started, uncertain: false } } : null
  return {
    name: String(s.store),
    kind,
    machine: typeof s.machine === 'string' ? s.machine : null,
    projects: names,
    projectsCount: typeof s.projects_count === 'number' ? s.projects_count : names.length,
    created: msAt(s.created_at),
    size: typeof s.size === 'number' ? { bytes: s.size } as { bytes: number, seen?: number, stale?: true } : null,
    state: held?.state ?? (typeof s.state === 'string' ? s.state : 'ready'),
    op: held?.op ?? opOf(s.op),
    ...companionsOf(s),
    format: formatOf(s.format),
    links: (Array.isArray(s.backups) ? s.backups : []).filter((b: any) => typeof b?.bucket === 'string').map((b: any) => ({
      bucket: b.bucket, file: typeof b.file === 'string' ? b.file : String(s.store),
      last: b.last && typeof b.last === 'object' ? { op: String(b.last.call ?? ''), at: msAt(b.last.ended_at), bytes: typeof b.last.size === 'number' ? b.last.size : null } : null,
      attempt: b.attempt && typeof b.attempt === 'object' ? { op: String(b.attempt.call ?? ''), at: msAt(b.attempt.ended_at), error: b.attempt.error ?? null } : null,
    })),
    job: jobs.find((j) => j.store === s.store && !j.ended)?.id ?? null,
    postgresql: kind === 'postgresql' ? pgOf(s) : null,
    attached: kind === 'postgresql' ? attachedRows(s) : [],
  }
}

/**
 * A Store's format as `--with format` answers it (#804 §2): its version, the
 * latest this build writes, the status word (`current`, `outdated`,
 * `unsupported`, `newer`) and its fix line; null when the section is absent
 * (a CLI without it, or a read that did not report it).
 */
export function formatOf(f: any): { version: number | null, latest: number | null, status: string, fix: string | null } | null {
  if (!f || typeof f !== 'object' || typeof f.status !== 'string') return null
  const n = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) ? v : null)
  return { version: n(f.version), latest: n(f.latest), status: f.status, fix: typeof f.fix === 'string' && f.fix ? f.fix : null }
}

/** The not_listed entry for a bucket as the page shows it: its reason, LayerFS's sentence and its fix line (`backup connect`, when the key was refused or the record has none). */
const notListedError = (n: any) => ({ code: String(n?.reason ?? 'lost'), message: String(n?.message ?? 'the bucket could not be listed'), ...(typeof n?.fix === 'string' && n.fix ? { fix: n.fix } : {}) })

type Listing = { at: number | null, items: any[] | null, error: { code: string, message: string, fix?: string } | null }

/** A bucket as `home get --with tree` records it: its name, provider, and its state with its companions when it is not ready. */
type BucketRecord = { name: string, provider: string | null, url?: string, state?: string, reason?: string, fix?: string, message?: string }

export class Storage {
  readonly jobStore: JobStore
  readonly jobs: Map<string, StorageJob>
  /** bucket name -> its last backup.list */
  readonly listings = new Map<string, Listing>()
  private readonly listingInFlight = new Map<string, Promise<Listing>>()
  private readonly listingPending = new Set<string>()
  private readonly listingEpoch = new Map<string, number>()
  lastView: any = null
  /** The StorageView read in flight, shared by concurrent callers; a write (`changed`) bumps `generation` so later callers read anew. */
  private viewing: { promise: ReturnType<Storage['readView']>, generation: number } | null = null
  private generation = 0
  /** The last size each Store was read at: a Store on a machine that does not answer shows it (store-sizes.ts). */
  readonly sizes: StoreSizes
  readonly reconciled: Promise<void>

  /** Upgrade jobs whose Stop has sent SIGTERM to their CLI (once each). */
  private readonly signalled = new Set<string>()

  /**
   * @param host - the route dependencies.
   * @param kill - signals a CLI's process group (the export Stop's own; tests pass a recorder).
   */
  constructor(private readonly host: RouteHost, private readonly kill: (pid: number, signal: NodeJS.Signals) => void = killGroup) {
    // the job and stat folders in the LayerFS home, all owner-only (LayerFS requires 0700; a home made here is too)
    moveLegacyStorageState(host.home, host.jobs, host.stats)
    for (const dir of [host.jobs, host.stats, join(host.stats, 'storage-observations'), join(host.stats, 'project-storage')]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      chmodSync(dir, 0o700)
    }
    this.sizes = new StoreSizes(host.stats)
    this.jobStore = new JobStore(host.jobs)
    this.jobs = this.jobStore.jobs
    this.reconciled = Promise.resolve().then(async () => {
      for (const job of this.jobs.values()) if (job.outcome === 'interrupted') {
        try { await this.inspect(job.id) } catch (error: any) { job.reconcileError = { code: error?.code ?? 'Failed', message: error?.message }; this.jobStore.save() }
      }
    })
  }

  get lfs() { return this.host.lfs() }

  private event(e: { type: string } & Record<string, unknown>): void {
    this.host.emit(e.type, wire(e))
  }

  private log(line: string): void { this.host.log(line) }

  changed(): void {
    this.lastView = null
    this.generation++
    this.event({ type: 'storage' })
  }

  /** The buckets connected to this LayerFS home, by any client: `home get --with tree` (records only). */
  private async bucketRows(probe: { timeout_ms?: number }): Promise<BucketRecord[] | null> {
    const tree = (await this.lfs.home.get({ with: ['tree'], ...probe }))?.tree
    if (!tree) return null
    const text = (v: unknown) => (typeof v === 'string' && v ? { value: v } : null)
    return (Array.isArray(tree?.buckets) ? tree.buckets : []).filter((b: any) => typeof b?.bucket === 'string')
      .map((b: any) => {
        const out: BucketRecord = { name: b.bucket as string, provider: typeof b.provider === 'string' ? b.provider : null }
        for (const key of ['url', 'state', 'reason', 'fix', 'message'] as const) { const v = text(b[key]); if (v && !(key === 'state' && v.value === 'ready')) out[key] = v.value }
        return out
      })
  }

  /** StorageView: concurrent reads (the project list's join, the Storage page) share one. */
  view(fresh = false): ReturnType<Storage['readView']> {
    if (fresh) this.generation++
    if (this.viewing && this.viewing.generation === this.generation) return this.viewing.promise
    const generation = this.generation
    const promise = this.readView(generation, fresh).finally(() => { if (this.viewing?.promise === promise) this.viewing = null })
    this.viewing = { promise, generation }
    return promise
  }

  private async readView(generation: number, fresh: boolean) {
    // An explicit refresh also observes changes from other CLI processes.
    const probe = fresh ? { timeout_ms: READ_TIMEOUT_MS } : {}
    // what the pinned CLI can do: an upgrade, and each Store's format in the same list read (#804)
    const features = await cliFeatures(this.host)
    const [listed, machines, bucketRecords] = await Promise.all([
      this.lfs.store.list({ ...probe, detail: true, with: features.storeFormat ? ['stats', 'format'] : ['stats'] }),
      machineRows(this.lfs),
      this.bucketRows(probe).catch((error: any) => (this.log(`[storage] home get --with tree: ${error?.message ?? error}`), null)),
    ])
    const items: any[] = listed?.items ?? []
    const jobs = this.jobList()
    // a PostgreSQL Store's list item names its machines only: its record adds each one's last reach and the saved connection
    await Promise.all(items.map(async (item, i) => {
      if (item?.engine !== 'postgresql') return
      const record = await this.lfs.store.get(String(item.store), { ...probe, detail: true }).catch((error: any) => (this.log(`[storage] store get ${item.store}: ${error?.message ?? error}`), null))
      if (record && typeof record === 'object') items[i] = { ...item, ...record, projects: item.projects, projects_count: item.projects_count ?? record.projects_count }
    }))
    const stores = items.map((s) => storeRow(s, jobs))
    // a Store with more than 20 projects: `projects` is cut at 20 beside `projects_count`, so its names come page by page
    await Promise.all(stores.filter((s) => s.projectsCount > s.projects.length).map(async (s) => {
      const all = await pages((p) => this.lfs.project.list({ ...probe, store: s.name, ...p })).catch((error: any) => (this.log(`[storage] project list --store ${s.name}: ${error?.message ?? error}`), null))
      if (all) s.projects = all.map((r: any) => String(r?.project ?? '')).filter(Boolean).map((key) => key.slice(key.indexOf('/') + 1))
    }))
    // a Store whose machine does not answer keeps its last read size, marked stale
    const sqlite = stores.filter((s) => s.kind === 'sqlite')
    const sizes = this.sizes.answer(sqlite.map((s) => ({ name: s.name, size: s.size ? { bytes: s.size.bytes } : null })))
    sqlite.forEach((s, i) => { s.size = sizes[i] ?? null })
    const recorded = bucketRecords ?? []
    const names = new Set([...recorded.map((b) => b.name), ...stores.flatMap((s) => s.links.map((l: { bucket: string }) => l.bucket))])
    const buckets = [...names].sort().map((name) => {
      const listing = this.listings.get(name)
      const record = recorded.find((b) => b.name === name)
      // the record's own state (a record with no access key reads broken, with the connect-again fix) beside the last listing
      const own = record?.state ? { state: record.state, reason: record.reason ?? null, fix: record.fix ?? null, message: record.message ?? null } : {}
      return { name, provider: record?.provider ?? null, ...(record?.url ? { url: record.url } : {}), ...own, listed: listing?.at ?? null, files: listing?.items ?? null, error: listing?.error ?? null, stores: stores.filter((s) => s.links.some((l: { bucket: string }) => l.bucket === name)).map((s) => s.name) }
    })
    const view = {
      machines: machines.map((m) => ({ name: m.name, platform: m.platform, state: m.state, supports: m.supports, reason: m.reason ?? null })),
      // this computer (the native machine): its OS names it
      computer: computer(),
      stores,
      buckets,
      bucketInventoryComplete: bucketRecords !== null,
      jobs,
      compact: true,
      upgrade: features.storeUpgrade,
      format: features.storeFormat,
      formats: features.formats,
      at: Date.now(),
    }
    // a write while this read ran: answer it, but do not keep it for the join
    if (generation === this.generation) this.lastView = view
    return view
  }

  /** Store name -> { state, op, machine, reason } for the project list: a recent view, else a new one. */
  async projectJoin(): Promise<Map<string, { state: string, op: unknown, machine: string | null, reason: string | null }>> {
    const view = this.lastView && Date.now() - this.lastView.at < JOIN_MS ? this.lastView : await this.view()
    return new Map(view.stores.map((s: any) => [s.name, { state: s.state, op: s.op, machine: s.machine, reason: s.reason ?? null }]))
  }

  // ---------- Stores ----------

  async createStore({ name }: any = {}) {
    checkName(name, 'A Store')
    await this.lfs.store.create(name)
    this.changed()
    return this.view()
  }

  async removeStore(name: string, { confirm }: { confirm?: string | null } = {}) {
    if (confirm !== name) throw refuse(400, 'InvalidInput', `type the Store's name (${name}) to remove it and every project in it`)
    const affected = [...this.listings.entries()]
      .filter(([, l]) => l.items?.some((i: any) => i?.store === name))
      .map(([bucket]) => bucket)
    await this.lfs.store.remove(name)
    this.changed()
    for (const bucket of affected) void this.listBucket(bucket, { force: true }).catch(() => {})
    return this.view()
  }

  /**
   * A PostgreSQL database as a Store: `{ name, url, user, passwordValue,
   * synchronousCommit? }`. The URL is an address alone (a user or password in
   * it is refused); the password goes to LayerFS on stdin. LayerFS checks the
   * connection from the host and saves the Store only when it passes. Where its
   * Sandboxes run is the machines attached afterwards. Answers the view and
   * the outcome (`connected`).
   */
  async connectPostgresql(input: any = {}) {
    const { name, url } = input
    checkName(name, 'A PostgreSQL Store')
    checkUrl(url, 'The database address')
    const user = typeof input.user === 'string' ? input.user.trim() : ''
    if (!user) throw refuse(400, 'InvalidInput', 'Give the database user')
    if (typeof input.passwordValue !== 'string' || input.passwordValue === '') throw refuse(400, 'InvalidInput', 'Give the password')
    const sync = syncOf(input.synchronousCommit)
    const answer: any = await this.lfs.store.connect(name, url, { user, password: input.passwordValue, ...(sync ? { synchronous_commit: sync } : {}), detail: true })
    this.changed()
    return { ...(await this.view()), outcome: word(answer?.outcome) }
  }

  /**
   * A PostgreSQL Store's connection changed: `{ url?, user?, passwordValue?,
   * synchronousCommit? }`, only what changed. `store connect` again with the
   * Store's address (the saved one unless a new one is given; an omitted user
   * or password keeps the saved one), then `store doctor`, which checks from
   * the host and every attached machine. The connect's refusal is the answer;
   * once it is saved, a failed check is part of the result, not a refusal.
   * Answers `{ outcome, check }`.
   */
  async updateConnection(name: string, input: any = {}) {
    checkName(name, 'A PostgreSQL Store')
    const given = typeof input.url === 'string' && input.url.trim() ? input.url.trim() : null
    if (given) checkUrl(given, 'The database address')
    const user = typeof input.user === 'string' && input.user.trim() ? input.user.trim() : undefined
    const password = typeof input.passwordValue === 'string' && input.passwordValue !== '' ? input.passwordValue : undefined
    const sync = syncOf(input.synchronousCommit)
    if (!given && !user && !password && !sync) throw refuse(400, 'InvalidInput', 'Give an address, a user, a password or synchronous_commit to change')
    const url = given ?? pgOf(await this.lfs.store.get(name, { detail: true })).url
    if (!url) throw refuse(400, 'InvalidInput', `Store ${name} has no saved address: give one`)
    const answer: any = await this.lfs.store.connect(name, url, { ...(user ? { user } : {}), ...(password ? { password } : {}), ...(sync ? { synchronous_commit: sync } : {}), detail: true })
    this.changed()
    const check = await this.checkStore(name, null).catch((error: any) => ({ store: name, error: { code: String(error?.code ?? 'Failed'), message: String(error?.message ?? error) } }))
    return { outcome: word(answer?.outcome), check }
  }

  /**
   * Attaches machines to a PostgreSQL Store, one `store attach --machine` each,
   * in order: LayerFS checks from the machine, then records it. Each machine
   * answers for itself (`{ machine, ok, outcome?, latencyMs?, version?, error? }`);
   * a refusal for one does not stop the rest, and nothing is tried twice.
   */
  async attach(name: string, input: any = {}) {
    checkName(name, 'A PostgreSQL Store')
    const machines: string[] = Array.isArray(input.machines) ? input.machines : typeof input.machine === 'string' ? [input.machine] : []
    if (!machines.length) throw refuse(400, 'InvalidInput', 'Choose a machine to attach')
    for (const m of machines) checkName(m, 'A machine')
    const results: any[] = []
    for (const machine of [...new Set(machines)]) {
      try {
        const answer: any = await this.lfs.store.attach(name, { machine, detail: true, timeout_ms: CHECK_TIMEOUT_MS })
        results.push({ machine, ok: true, outcome: word(answer?.outcome), latencyMs: typeof answer?.latency_ms === 'number' ? answer.latency_ms : null, version: word(answer?.server_version) })
      } catch (error: any) {
        results.push({ machine, ok: false, error: reachError(error) })
      }
    }
    this.changed()
    return { store: name, results }
  }

  /**
   * Tests one machine's connection to a PostgreSQL Store without attaching it:
   * `store attach --machine M --dry-run` runs attach's own check from that
   * machine and records nothing. Answers `{ machine, ok, latencyMs, version }`,
   * or `{ machine, ok: false, error: { code, message, fix?, step } }`, where
   * `step` is the connection step LayerFS says it stopped at.
   */
  async testAttach(name: string, input: any = {}) {
    checkName(name, 'A PostgreSQL Store')
    const machine = input.machine
    checkName(machine, 'A machine')
    try {
      const answer: any = await this.lfs.store.attach(name, { machine, dry_run: true, detail: true, timeout_ms: CHECK_TIMEOUT_MS })
      return { machine, ok: true, latencyMs: typeof answer?.latency_ms === 'number' ? answer.latency_ms : null, version: word(answer?.server_version), error: null }
    } catch (error: any) {
      return { machine, ok: false, latencyMs: null, version: null, error: reachError(error) }
    }
  }

  /**
   * Tests a PostgreSQL Store's connection as it would be saved, without
   * saving: `{ url?, user?, passwordValue? }`, only what changed, through
   * `store connect --dry-run`, from this computer and then every attached
   * machine. Answers `{ store, here, machines }`, each `{ ok, latencyMs,
   * version, error }` (machines also name their `machine`).
   */
  async testConnection(name: string, input: any = {}) {
    checkName(name, 'A PostgreSQL Store')
    const given = typeof input.url === 'string' && input.url.trim() ? input.url.trim() : null
    if (given) checkUrl(given, 'The database address')
    const user = typeof input.user === 'string' && input.user.trim() ? input.user.trim() : undefined
    const password = typeof input.passwordValue === 'string' && input.passwordValue !== '' ? input.passwordValue : undefined
    const url = given ?? pgOf(await this.lfs.store.get(name, { detail: true })).url
    if (!url) throw refuse(400, 'InvalidInput', `Store ${name} has no saved address: give one`)
    const answer: any = await this.lfs.store.connect(name, url, { ...(user ? { user } : {}), ...(password ? { password } : {}), dry_run: true, detail: true, timeout_ms: CHECK_TIMEOUT_MS })
    const rows: any[] = Array.isArray(answer?.machines) ? answer.machines : []
    return { store: name, here: tested(answer?.here), machines: rows.map((m) => ({ machine: String(m?.machine ?? ''), ...tested(m) })) }
  }

  /** Detaches a machine (`store detach --machine`): LayerFS refuses `InUse` while a Sandbox of the Store is there, `NotFound` when it is not attached. */
  async detach(name: string, input: any = {}) {
    checkName(name, 'A PostgreSQL Store')
    checkName(input.machine, 'A machine')
    await this.lfs.store.detach(name, { machine: input.machine })
    this.changed()
    return this.view()
  }

  /**
   * The connection check (`store doctor <store> [--machine M]`): from this
   * computer, then every attached machine (machines are skipped when this
   * computer fails), or from attached `machine` alone. LayerFS records what each side saw; the
   * answer is the Store's reaches read back (`store get`): `{ store, host,
   * machines, findings }`, `findings` the doctor's failed checks' messages
   * (full text for the Store page; rows show labels). A refusal (no such
   * Store, a sqlite Store) is LayerFS's.
   */
  async checkStore(name: string, machine: unknown) {
    checkName(name, 'A PostgreSQL Store')
    const from = machine === undefined || machine === null || machine === '' ? null : machine
    if (from !== null) checkName(from, 'A machine')
    const report: any = await this.lfs.store.doctor(name, { ...(from ? { machine: from } : {}), detail: true, timeout_ms: CHECK_TIMEOUT_MS })
    this.changed()
    const record: any = await this.lfs.store.get(name, { detail: true })
    const findings = (Array.isArray(report?.findings) ? report.findings : []).filter((f: any) => f && f.severity === 'error')
      .map((f: any) => ({ check: word(f.check), from: word(f.from), message: String(f.message ?? ''), ...(word(f.fix) ? { fix: f.fix } : {}) }))
    return { store: name, host: pgOf(record).host, machines: attachedRows(record), findings, state: word(record?.state) ?? 'ready', reason: word(record?.reason) }
  }

  async disconnectStore(name: string) {
    await this.lfs.store.disconnect(name)
    this.changed()
    return this.view()
  }

  // ---------- buckets ----------

  /**
   * An r2 or MinIO bucket. The URL is given whole ({ url }) or built from its
   * parts: MinIO { provider: 'minio', endpoint, bucket, prefix? }, R2
   * { provider: 'r2', account, jurisdiction?, bucket, prefix? }, with
   * { accessKey, secretKey }. The secret goes to LayerFS on stdin
   * (`--key-stdin`); the home keeps it. To change a key: connect again at
   * the same URL (spec v21); the answer's `outcome` is then `rotated`.
   */
  async connectBucket(input: any = {}) {
    const { name } = input
    checkName(name, 'A bucket')
    const url = input.url ?? bucketUrl(input)
    if (typeof url !== 'string' || !/^(https?:\/\/|r2:\/\/)/.test(url)) throw refuse(400, 'InvalidInput', 'A bucket URL is http(s)://<host>/<bucket>/<prefix> (MinIO) or r2://<account>/<bucket>/<prefix>')
    if (!url.startsWith('r2://')) checkUrl(url, 'The bucket URL')
    const [access, secret] = [input.accessKey, input.secretKey].map((v) => (typeof v === 'string' ? v.trim() : ''))
    if (!access || !secret || /\s/.test(access + secret)) throw refuse(400, 'InvalidInput', 'Give both the access key and the secret key (no spaces)')
    // the long form says what happened: `rotated` when the name was already connected at this URL (spec v21: the key is replaced, links kept)
    const answer: any = await this.lfs.backup.connect(name, url, { access_key: access, secret_key: secret, detail: true })
    // a listing read with the old key is dropped; one that was running or asked for runs again with the new key
    if (this.invalidateListing(name)) void this.listBucket(name).catch(() => {})
    // a connect that succeeded answers a remembered refusal ("key refused"): it is no longer the bucket's word,
    // with or without List again (RV4 NOTE 6); its last files stay until the next listing
    const prior = this.listings.get(name)
    if (prior?.error) this.listings.set(name, { ...prior, error: null })
    this.changed()
    const view = await this.view()
    return { ...view, outcome: typeof answer?.outcome === 'string' ? answer.outcome : null }
  }

  /** Drops the bucket and its key; LayerFS drops every Store's link to it too. Answers which Stores lost theirs. */
  async disconnectBucket(name: string) {
    const done = await this.lfs.backup.disconnect(name, { detail: true })
    this.invalidateListing(name)
    this.listings.delete(name)
    this.changed()
    return { unlinked: done?.unlinked ?? [], view: await this.view() }
  }

  /** Drops the bucket's running listing (its answer is discarded) and any relist queued behind it; answers whether there was one. */
  private invalidateListing(name: string): boolean {
    this.listingEpoch.set(name, (this.listingEpoch.get(name) ?? 0) + 1)
    const running = this.listingInFlight.delete(name)
    const queued = this.listingPending.delete(name)
    return running || queued
  }

  /**
   * `backup list --bucket <name> --detail`: its files, kept as the bucket's
   * last listing. A file: its Store link (`store`), `behind` (the Store
   * changed since its last backup), `changed` (the bucket's copy is not the
   * one the link last moved), `missing` (linked, not in the bucket); null
   * with a `message` where LayerFS could not read it. A bucket that could not
   * be listed comes back in `not_listed`: its reason and message.
   */
  async listBucket(name: string, { force = false }: { force?: boolean } = {}): Promise<Listing> {
    checkName(name, 'A bucket')
    const inflight = this.listingInFlight.get(name)
    if (inflight) {
      if (force) this.listingPending.add(name)
      return inflight
    }
    const epoch = this.listingEpoch.get(name) ?? 0
    const run = (async (): Promise<Listing> => {
      let next: Listing
      try {
        const listed = await this.lfs.backup.list({ bucket: name, detail: true })
        const failed = (Array.isArray(listed?.not_listed) ? listed.not_listed : []).find((n: any) => n?.bucket === name)
        const items = (Array.isArray(listed?.items) ? listed.items : []).filter((i: any) => i?.bucket === name).map((i: any) => ({
          file: String(i.file), store: typeof i.store === 'string' ? i.store : null, bytes: typeof i.size === 'number' ? i.size : null, modified: msAt(i.modified_at),
          behind: typeof i.behind === 'boolean' ? i.behind : null, changed: typeof i.changed === 'boolean' ? i.changed : null, missing: i.missing === true,
          message: typeof i.message === 'string' ? i.message : null,
        }))
        const prev = this.listings.get(name)
        next = failed ? { at: prev?.at ?? null, items: prev?.items ?? null, error: notListedError(failed) } : { at: Date.now(), items, error: null }
      } catch (error: any) {
        const prev = this.listings.get(name)
        next = { at: prev?.at ?? null, items: prev?.items ?? null, error: { code: error?.code ?? 'Failed', message: error?.message ?? String(error) } }
      }
      if ((this.listingEpoch.get(name) ?? 0) !== epoch) return this.listings.get(name) ?? next
      this.listings.set(name, next)
      this.changed()
      return next
    })().finally(() => {
      if (this.listingInFlight.get(name) === run) {
        this.listingInFlight.delete(name)
        if (this.listingPending.delete(name)) void this.listBucket(name).catch(() => {})
      }
    })
    this.listingInFlight.set(name, run)
    return run
  }

  /** Lists every bucket (`bucket`: one), each on its own call. */
  async check({ bucket }: { bucket?: string } = {}) {
    const view = await this.view()
    const names = bucket ? [bucket] : view.buckets.map((b) => b.name)
    await Promise.all(names.map((n) => this.listBucket(n)))
    return this.view()
  }

  // ---------- jobs ----------

  jobList(): StorageJob[] {
    return [...this.jobs.values()].reverse().map((j) => ({ ...j }))
  }

  job(id: string) {
    const job = this.jobs.get(id)
    if (!job) throw refuse(404, 'NotFound', 'no such job: it ended long ago or another host started it')
    return { ...job }
  }

  /** Whether a job is running (for runtime admission). */
  busy(): boolean { return [...this.jobs.values()].some((j) => !j.ended) }

  /**
   * Starts LayerFS work with on_progress as a job; answers the job at once.
   * `run(on_progress, step, on_spawn)` may make more than one call: `step(half)`
   * marks the half a move is in.
   */
  start(kind: StorageJob['kind'], store: string, target: string, file: string | null | undefined, run: (on_progress: (p: any) => void, step: (half: 'pull' | 'push', from?: string | null) => void, on_spawn: (pid: number) => void) => Promise<unknown>, from: string | null = null, steps?: readonly string[]) {
    if ([...this.jobs.values()].some((j) => j.store === store && !j.ended)) throw refuse(409, 'ConnectBusy', `this host is already running a job on ${store}; wait for it to end`)
    const job: StorageJob = { id: randomUUID(), kind, store, target, from, file: file ?? null, started: Date.now(), ended: null, half: null, phase: null, phases: [], outcome: null, pid: null, observation: null, summary: null, done: null, total: null, error: null, result: null, ...(steps ? { steps } : {}) }
    this.jobs.set(job.id, job)
    while (this.jobs.size > KEEP_JOBS) {
      const oldest = [...this.jobs.values()].find((j) => j.ended)
      if (!oldest) break
      this.jobs.delete(oldest.id)
    }
    const emit = () => { this.jobStore.save(); this.event({ type: 'storage-job', job: { ...job } }) }
    const on_progress = (p: any) => {
      // a new phase changes the Store's op in store.list: the view is read again (not on every byte step)
      if (typeof p?.phase === 'string' && p.phase !== job.phase) {
        job.phase = p.phase
        job.phases.push({ phase: p.phase, half: job.half, at: Date.now() })
        this.changed()
      }
      // push and pull give bytes only while sending (#536 §10b), in 8 MiB steps
      job.done = typeof p?.done === 'number' ? p.done : null
      job.total = typeof p?.total === 'number' && p.total > 0 ? p.total : null
      emit()
    }
    const step = (half: 'pull' | 'push', from: string | null | undefined = undefined) => {
      if (from !== undefined) job.from = from
      Object.assign(job, { half, phase: null, done: null, total: null })
      emit()
      // between a move's halves the Store is on native: the view follows
      this.changed()
    }
    this.jobStore.save()
    let running: Promise<unknown>
    try { running = Promise.resolve(run(on_progress, step, (pid) => { job.pid = pid; if (job.stopping) this.signal(job); emit() })) } catch (error) { running = Promise.reject(error) }
    this.running.set(job.id, running)
    running
      .then(
        (result) => { job.result = result ?? null; job.outcome = 'succeeded' },
        (error: any) => {
          // the SDK's refusal as it came: its code and text, the phase it stopped in, and its detail (entity, op, related)
          job.phase = error?.detail?.phase ?? job.phase
          // a transfer that stops in install or record is unknown; a compaction's refusal says so itself (`Unknown`)
          // an upgrade's own reply decides: Cancelled is stopped (nothing changed)
          job.outcome = kind === 'upgrade' ? upgradeOutcome(error) : failureOutcome(error, kind === 'compact' ? null : job.phase)
          job.error = { transport: error?.transport ?? null, code: error?.code ?? 'Failed', message: error?.message ?? String(error), phase: error?.detail?.phase ?? job.phase, detail: error?.detail ?? null, ...fixOf(error), ...(error?.note ? { note: error.note } : {}) }
          this.log(`[storage] ${kind} ${store}: ${error?.code ?? ''} ${error?.message ?? error}`)
        },
      )
      .finally(() => {
        this.running.delete(job.id)
        this.signalled.delete(job.id)
        job.ended = Date.now()
        job.summary = transferSummary(job)
        emit()
        // the bucket's listing changed with a backup or restore
        if (kind === 'backup' || kind === 'restore') void this.listBucket(target, { force: true }).catch(() => {})
        this.changed()
      })
    emit()
    this.changed()
    return { ...job }
  }

  /** store.move(store, machine): a sqlite Store on native to `machine`. */
  push(store: unknown, machine: unknown, made = false) {
    checkName(store, 'A move')
    checkName(machine, 'A move')
    const job = this.start('push', store, machine, null, async (on_progress, _step, on_spawn) => {
      await this.host.ensureNative()
      return this.lfs.store.move(store, machine, { on_progress, on_spawn, detail: true })
    })
    if (!made) return job
    // the table's own row carries the mark (saved and sent with the next event), the answer too
    const own = this.jobs.get(job.id)
    if (own) own.made = true
    return { ...job, made: true }
  }

  /** store.move(store, native): a sqlite Store on a machine back to this computer. */
  async pull(store: unknown) {
    checkName(store, 'A move')
    // the machine it comes from (store.get reads the record; it starts nothing): the job row reads "<store> ← <machine>"
    const from = (await this.lfs.store.get(store))?.machine ?? null
    return this.start('pull', store, 'native', null, async (on_progress, _step, on_spawn) => {
      await this.host.ensureNative()
      return this.lfs.store.move(store, 'native', { on_progress, on_spawn, detail: true })
    }, from)
  }

  /**
   * A Store on one machine to another: to native, then to the target, two
   * moves (a sqlite Store goes to or from this computer only; U5). When the
   * second fails the Store stays on native; the error's `note` says so (`pulled`).
   */
  move(store: unknown, machine: unknown) {
    checkName(store, 'A move')
    checkName(machine, 'A move')
    return this.start('move', store, machine, null, async (on_progress, step, on_spawn) => {
      await this.host.ensureNative()
      const source = await this.lfs.store.get(store)
      step('pull', source.machine ?? null)
      await this.lfs.store.move(store, 'native', { on_progress, on_spawn, detail: true })
      let pushPhase: string | null = null
      const trackPush = (p: any) => {
        if (typeof p?.phase === 'string') pushPhase = p.phase
        on_progress(p)
      }
      step('push')
      try {
        return await this.lfs.store.move(store, machine, { on_progress: trackPush, on_spawn, detail: true })
      } catch (error: any) {
        const failPhase = error?.detail?.phase ?? pushPhase
        if (failureOutcome(error, failPhase) === 'failed' && failPhase !== 'retire') error.note = 'pulled'
        throw error
      }
    })
  }

  /** Puts sqlite Store `store` on `machine`: a move from native, to native, else two moves through native. */
  /** @param made - a Store a New Store dialog just made: the push job is marked so its words read "created on". */
  async place(store: unknown, machine: unknown, made = false) {
    checkName(store, 'A Store')
    checkName(machine, 'A machine')
    const record = await this.lfs.store.get(store)
    if (record.engine && record.engine !== 'sqlite') throw refuse(400, 'InvalidInput', `${store} is a PostgreSQL Store; it is never moved`)
    if (record.machine === machine) throw refuse(400, 'InvalidInput', `${store} is on ${machine} already`)
    if (machine === 'native') return this.pull(store)
    if (record.machine === 'native') return this.push(store, machine, made)
    return this.move(store, machine)
  }

  /** A started job's LayerFS work while it runs (its result, or its refusal as it came). */
  private readonly running = new Map<string, Promise<unknown>>()

  /**
   * The Doctor page's backup fix: the same Storage job as the Backups page's
   * (its job row, `storage-job` events, one job per Store), awaited to its end.
   */
  async backupAndWait(store: string, bucket: string): Promise<unknown> {
    checkName(store, 'A backup')
    checkName(bucket, 'A backup')
    const record: any = await this.lfs.store.get(store, { detail: true })
    // `store get --detail` answers `backups` as a list of links ({ bucket, file, … }), as `storeRow` reads it
    const linked = (Array.isArray(record?.backups) ? record.backups : []).find((b: any) => b?.bucket === bucket)?.file
    const file = typeof linked === 'string' && linked ? linked : undefined
    const job = this.backup(store, { bucket, ...(file ? { file } : {}) })
    return await (this.running.get(job.id) ?? Promise.resolve(null))
  }

  /** backup.create(store, bucket, { file? }): a sqlite Store's snapshot to a bucket. */
  backup(store: unknown, { bucket, file }: any = {}) {
    checkName(store, 'A backup')
    checkName(bucket, 'A backup')
    return this.start('backup', store, bucket, file, (on_progress, _step, on_spawn) => this.lfs.backup.create(store, bucket, { ...(file ? { file } : {}), on_progress, on_spawn, detail: true }))
  }

  /** backup.restore(bucket, file, store): a Store on native from a bucket's file (default: the file named after the Store). */
  restore({ store, bucket, file }: any = {}) {
    checkName(store, 'A restore')
    checkName(bucket, 'A restore')
    return this.start('restore', store, bucket, file, (on_progress, _step, on_spawn) => this.lfs.backup.restore(bucket, file || store, store, { on_progress, on_spawn, detail: true }))
  }

  /**
   * store.compact(store): rebuild a Store from its live history where it is
   * (a sqlite file in the home or on its machine, compacted by that
   * machine's worker; or its PostgreSQL server). LayerFS refuses a Store
   * with mounts (`InUse`), a busy one (`Busy` with `op`) and one whose
   * machine is not running (`Unavailable`, fix `layerfs machine start M`);
   * the job carries that refusal. One attempt: nothing here runs it again.
   * Its result is `{ freed_bytes, outcome, … }`.
   */
  async compact(store: unknown) {
    checkName(store, 'A compaction')
    const family = (await this.lfs.store.get(store))?.engine === 'postgresql' ? 'postgresql' : 'sqlite'
    return this.start('compact', store, store, null, (on_progress, _step, on_spawn) => this.lfs.store.compact(store, { on_progress, on_spawn, detail: true }), null, COMPACT_STEPS[family])
  }

  /**
   * store.upgrade(store): an older-format Store to the latest format, in place
   * and in one transaction (#804). LayerFS refuses a Store in use (`InUse`), a
   * busy one (`Busy`), one it cannot upgrade (`Unsupported`, with remove or
   * disconnect as its fix) and answers `current` for one already at the latest
   * format. One attempt: nothing here runs it again. Its result is
   * `{ outcome, format_before, format_after, steps, warnings, … }`.
   */
  async upgrade(store: unknown) {
    checkName(store, 'An upgrade')
    if (!(await cliFeatures(this.host)).storeUpgrade) throw refuse(501, 'Unsupported', 'The selected LayerFS runtime cannot upgrade a Store; choose a newer one in Setup')
    const family = (await this.lfs.store.get(store))?.engine === 'postgresql' ? 'postgresql' : 'sqlite'
    return this.start('upgrade', store, store, null, (on_progress, _step, on_spawn) => this.lfs.store.upgrade(store, { on_progress, on_spawn, detail: true }), null, UPGRADE_STEPS[family])
  }

  /**
   * Cancel of a running upgrade (the export Stop): SIGTERM to its CLI, which
   * ends the transaction before COMMIT and answers `Cancelled`; the job keeps
   * reading that reply, and the reply decides (a Cancel that lands too late
   * reads `upgraded`). A Stop before the CLI was spawned signals it as soon
   * as its pid is known (LayerFS masks SIGINT/SIGTERM right after parsing, so
   * an earlier kill reads Unknown, never a false Cancelled). A Stop whose kill
   * failed is tried again by the next press. Refused at `commit`, the point of
   * no return, and for a job that is not a running upgrade.
   */
  stop(id: string) {
    const job = this.jobs.get(id)
    if (!job) throw refuse(404, 'NotFound', 'no such job: it ended long ago or another host started it')
    if (job.kind !== 'upgrade') throw refuse(409, 'Conflict', 'Only a Store upgrade can be cancelled')
    if (job.ended) throw refuse(409, 'Conflict', 'This upgrade has already ended')
    if (job.phase === 'commit') throw refuse(409, 'Busy', 'The upgrade is finishing (commit) and can no longer be cancelled')
    const first = !job.stopping
    job.stopping = true
    // a later press retries a kill that did not go through
    this.signal(job)
    if (first) {
      this.jobStore.save()
      this.event({ type: 'storage-job', job: { ...job } })
    }
    return { ...job }
  }

  /**
   * SIGTERM to a stopping upgrade's CLI once its pid is known. It counts as
   * sent only when the kill went through (or the process is already gone,
   * ESRCH: its reply is on its way); any other failure leaves it to the next
   * Stop. The reply decides how the job ends either way.
   */
  private signal(job: StorageJob): void {
    if (!job.pid || this.signalled.has(job.id) || job.ended) return
    try {
      this.kill(job.pid, 'SIGTERM')
      this.signalled.add(job.id)
    } catch (error: any) {
      if (error?.code === 'ESRCH') this.signalled.add(job.id)
      else this.log(`[storage] upgrade ${job.store}: SIGTERM to ${job.pid} failed: ${error?.code ?? ''} ${error?.message ?? error}`)
    }
  }

  async inspect(id: string) {
    const job = this.jobs.get(id)
    if (!job || !job.ended) throw refuse(409, 'ConnectBusy', 'Wait for a completed job before inspecting recovery')
    job.observation = await inspectJob(this.lfs, job, (await cliFeatures(this.host)).storeFormat)
    const value = job.observation.value
    if (value?.state === 'broken' && value?.reason === 'unresolved') job.outcome = 'unknown'
    // an upgrade's Check reads its format (the client words it Upgraded or Outdated); its outcome stays as its reply left it
    else if (job.kind !== 'upgrade' && value?.state === 'ready' && job.error?.transport === 'transport-unknown' && !['install', 'record'].includes(job.phase ?? '')) job.outcome = 'interrupted'
    job.summary = transferSummary(job)
    this.jobStore.save()
    return { ...job }
  }

  async retry(id: string) {
    const old = this.jobs.get(id)
    if (!old?.observation?.action) throw refuse(409, 'InspectRequired', 'Inspect the current Store before choosing recovery')
    const job = await this.inspect(id)
    if (!job.observation.action) throw refuse(409, 'RecoveryUnavailable', 'The fresh observation does not permit this recovery')
    if (job.observation.direction === 'pull') return this.pull(job.store)
    return this.push(job.store, job.target)
  }

  close(): void { this.jobStore.save() }
}
