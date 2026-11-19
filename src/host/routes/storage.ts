/**
 * Storage on LayerFS 2.0: the home's Stores by machine, PostgreSQL Stores and
 * their saved logins, buckets and their backups, and the moves, backups,
 * restores and compactions this host started. Port of Connect `host/storage.js`.
 *
 *   view              StorageView: `store list --detail --with stats` (records,
 *                     and each sqlite file's size from one stat on its machine;
 *                     it starts nothing), machine.list for the groups, the
 *                     buckets from `home get --with tree` and their last
 *                     listing, and the job table
 *   createStore       store.create(name): a sqlite Store on native
 *   removeStore       store.remove(name), `confirm` naming it
 *   connectPostgresql store.connect(name, url, { auth, synchronous_commit }):
 *                     the URL holds no user or password; the login is a saved
 *                     auth (`auth`), a new one saved now from `user` +
 *                     `passwordValue` under `authName` (store.save_auth, the
 *                     password on stdin; an existing name is refused, and a
 *                     refused connect removes the new login), or the one of
 *                     the Store named by `passwordFrom`
 *   updateStore       the Store's address (store.connect), one machine's own
 *                     address (store.connect --machine; `clear`: store.disconnect
 *                     --machine), another saved login or synchronous_commit
 *                     (store.update), or a new password for its login
 *                     (store.save_auth under the same name rotates it)
 *   checkStore        store.doctor(name, { machine }): the connection check from a machine
 *   setRunsOn         the machine a PostgreSQL Store's sessions run on by
 *                     default: this install's choice (store-machines.ts)
 *   disconnectStore   store.disconnect(name): a PostgreSQL Store
 *   auths             store.auths: the saved logins (never a password)
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
 *
 * Secrets (a PostgreSQL password, a bucket's secret key) go to LayerFS on
 * stdin and are kept by the home (its secret folder); the host never writes,
 * keeps, logs or answers one. Storage state lives in the LayerFS home
 * (docs/specs/homes.md §5): the job table is in `host.jobs` (`<home>/job`).
 * Events: `storage-job` `{ type, job }` as a job moves, `storage` `{ type }`
 * when the view changed.
 */
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
import { COMPACT_STEPS, JobStore, failureOutcome, inspectJob, transferSummary, type StorageJob } from './jobs.ts'
import { computer } from './computer.ts'
import { fixOf, pages, refuse, wire, type RouteHost } from './util.ts'
import { StoreSizes } from './store-sizes.ts'
import { pgMachineOf, StoreMachines, type PgMachine } from '../store-machines.ts'
import { companionsOf, machineRows, msAt, opOf, runsPostgresql } from '../layerfs/machine-records.ts'

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

/** A PostgreSQL URL as `user@host:port/db`, never its password or parameters; null when it does not parse. */
function pgTarget(url: string): string | null {
  try {
    const u = new URL(url)
    return `${u.username ? `${decodeURIComponent(u.username)}@` : ''}${u.host}${u.pathname}`
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
 * count), its size, its backup links, and (PostgreSQL) its login and
 * addresses: the home's own (`machine: null`, every machine dials it) and
 * each machine's own.
 */
export function storeRow(s: any, jobs: StorageJob[], runsOn: string | null = null) {
  const kind: 'sqlite' | 'postgresql' = s.engine === 'postgresql' ? 'postgresql' : 'sqlite'
  const connections: { machine: string | null, url: string }[] = (Array.isArray(s.connections) ? s.connections : [])
    .filter((c: any) => typeof c?.url === 'string').map((c: any) => ({ machine: typeof c.machine === 'string' ? c.machine : null, url: c.url }))
  const home = connections.find((c) => c.machine === null)?.url ?? null
  const where = pgWhere(home)
  const names = (Array.isArray(s.projects) ? s.projects : []).map(String)
  return {
    name: String(s.store),
    kind,
    machine: typeof s.machine === 'string' ? s.machine : null,
    projects: names,
    projectsCount: typeof s.projects_count === 'number' ? s.projects_count : names.length,
    created: msAt(s.created_at),
    size: typeof s.size === 'number' ? { bytes: s.size } as { bytes: number, seen?: number, stale?: true } : null,
    state: typeof s.state === 'string' ? s.state : 'ready',
    op: opOf(s.op),
    ...companionsOf(s),
    links: (Array.isArray(s.backups) ? s.backups : []).filter((b: any) => typeof b?.bucket === 'string').map((b: any) => ({
      bucket: b.bucket, file: typeof b.file === 'string' ? b.file : String(s.store),
      last: b.last && typeof b.last === 'object' ? { op: String(b.last.call ?? ''), at: msAt(b.last.ended_at), bytes: typeof b.last.size === 'number' ? b.last.size : null } : null,
      attempt: b.attempt && typeof b.attempt === 'object' ? { op: String(b.attempt.call ?? ''), at: msAt(b.attempt.ended_at), error: b.attempt.error ?? null } : null,
    })),
    job: jobs.find((j) => j.store === s.store && !j.ended)?.id ?? null,
    postgresql: kind === 'postgresql' ? {
      auth: typeof s.auth === 'string' ? s.auth : null,
      url: home, target: home ? pgTarget(home) : null, server: where?.server ?? null, database: where?.database ?? null,
      synchronousCommit: typeof s.synchronous_commit === 'string' ? s.synchronous_commit : null,
    } : null,
    // PostgreSQL: the machine its sessions run on by default (this install's choice), and the machines with an address of their own
    runsOn: kind === 'postgresql' ? runsOn : null,
    ownConnections: connections.filter((c) => c.machine !== null).map((c) => ({ machine: c.machine as string, url: c.url, target: pgTarget(c.url) })),
  }
}

/** The not_listed entry for a bucket as the page shows it. */
const notListedError = (n: any) => ({ code: String(n?.reason ?? 'lost'), message: String(n?.message ?? 'the bucket could not be listed') })

type Listing = { at: number, items: any[] | null, error: { code: string, message: string } | null }

export class Storage {
  readonly jobStore: JobStore
  readonly jobs: Map<string, StorageJob>
  /** bucket name -> its last backup.list */
  readonly listings = new Map<string, Listing>()
  /** Where each PostgreSQL Store's sessions run by default (this install's choice). */
  readonly storeMachines: StoreMachines
  lastView: any = null
  /** The StorageView read in flight, shared by concurrent callers; a write (`changed`) bumps `generation` so later callers read anew. */
  private viewing: { promise: ReturnType<Storage['readView']>, generation: number } | null = null
  private generation = 0
  /** The last size each Store was read at: a Store on a machine that does not answer shows it (store-sizes.ts). */
  readonly sizes: StoreSizes
  readonly reconciled: Promise<void>

  /** @param host - the route dependencies. */
  constructor(private readonly host: RouteHost) {
    // the job and stat folders in the LayerFS home, all owner-only (LayerFS requires 0700; a home made here is too)
    moveLegacyStorageState(host.home, host.jobs, host.stats)
    for (const dir of [host.jobs, host.stats, join(host.stats, 'storage-observations'), join(host.stats, 'project-storage')]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      chmodSync(dir, 0o700)
    }
    this.sizes = new StoreSizes(host.stats)
    this.storeMachines = new StoreMachines(host.root)
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
  private async bucketRows(): Promise<{ name: string, provider: string | null }[]> {
    const tree = (await this.lfs.home.get({ with: ['tree'] }))?.tree
    return (Array.isArray(tree?.buckets) ? tree.buckets : []).filter((b: any) => typeof b?.bucket === 'string')
      .map((b: any) => ({ name: b.bucket as string, provider: typeof b.provider === 'string' ? b.provider : null }))
  }

  /** StorageView: concurrent reads (the project list's join, the Storage page) share one. */
  view(): ReturnType<Storage['readView']> {
    if (this.viewing && this.viewing.generation === this.generation) return this.viewing.promise
    const generation = this.generation
    const promise = this.readView(generation).finally(() => { if (this.viewing?.promise === promise) this.viewing = null })
    this.viewing = { promise, generation }
    return promise
  }

  private async readView(generation: number) {
    const [listed, machines, recorded] = await Promise.all([
      this.lfs.store.list({ detail: true, with: ['stats'] }),
      machineRows(this.lfs),
      this.bucketRows().catch((error: any) => (this.log(`[storage] home get --with tree: ${error?.message ?? error}`), [] as { name: string, provider: string | null }[])),
    ])
    const items: any[] = listed?.items ?? []
    const jobs = this.jobList()
    const fleet: PgMachine[] = machines
    const stores = items.map((s) => storeRow(s, jobs, s.engine === 'postgresql' ? pgMachineOf(this.storeMachines.get(String(s.store)), fleet) : null))
    // a Store with more than 20 projects: `projects` is cut at 20 beside `projects_count`, so its names come page by page
    await Promise.all(stores.filter((s) => s.projectsCount > s.projects.length).map(async (s) => {
      const all = await pages((p) => this.lfs.project.list({ store: s.name, ...p })).catch((error: any) => (this.log(`[storage] project list --store ${s.name}: ${error?.message ?? error}`), null))
      if (all) s.projects = all.map((r: any) => String(r?.project ?? '')).filter(Boolean).map((key) => key.slice(key.indexOf('/') + 1))
    }))
    // a Store whose machine does not answer keeps its last read size, marked stale
    const sqlite = stores.filter((s) => s.kind === 'sqlite')
    const sizes = this.sizes.answer(sqlite.map((s) => ({ name: s.name, size: s.size ? { bytes: s.size.bytes } : null })))
    sqlite.forEach((s, i) => { s.size = sizes[i] ?? null })
    const names = new Set([...recorded.map((b) => b.name), ...stores.flatMap((s) => s.links.map((l: { bucket: string }) => l.bucket))])
    const buckets = [...names].sort().map((name) => {
      const listing = this.listings.get(name)
      const record = recorded.find((b) => b.name === name)
      return { name, provider: record?.provider ?? null, listed: listing?.at ?? null, files: listing?.items ?? null, error: listing?.error ?? null, stores: stores.filter((s) => s.links.some((l: { bucket: string }) => l.bucket === name)).map((s) => s.name) }
    })
    const view = {
      machines: machines.map((m) => ({ name: m.name, platform: m.platform, state: m.state, supports: m.supports })),
      // this computer (the native machine): its OS names it
      computer: computer(),
      stores,
      buckets,
      jobs,
      compact: true,
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
    await this.lfs.store.remove(name)
    this.changed()
    return this.view()
  }

  /**
   * The saved login a PostgreSQL call names: `auth` (an existing one), the
   * login of Store `passwordFrom` (its server must be the URL's), or a new one
   * saved now from `user` + `passwordValue` under `authName` (default: the
   * Store's name). Saving under a name that exists rotates its password.
   */
  private async loginOf(input: any, store: string, url: string | null): Promise<string | undefined> {
    if (typeof input?.auth === 'string' && input.auth) { checkName(input.auth, 'A saved login'); return input.auth }
    if (input?.passwordFrom !== undefined && input.passwordFrom !== null && input.passwordFrom !== '') {
      checkName(input.passwordFrom, 'The Store to take the login from')
      const source: any = await this.lfs.store.get(input.passwordFrom, { detail: true })
      if (source?.engine !== 'postgresql' || typeof source.auth !== 'string') throw refuse(400, 'InvalidInput', `Store ${input.passwordFrom} is not a PostgreSQL Store with a saved login`)
      const there = pgWhere((Array.isArray(source.connections) ? source.connections : []).find((c: any) => !c?.machine)?.url)
      const here = pgWhere(url)
      if (url && (!here || !there || here.server !== there.server)) throw refuse(400, 'InvalidInput', `Store ${input.passwordFrom} is on another server (${there?.server ?? 'unknown'}); give this connection its own login`)
      return source.auth
    }
    if (typeof input?.passwordValue === 'string' && input.passwordValue !== '') {
      const user = typeof input.user === 'string' ? input.user.trim() : ''
      if (!user) throw refuse(400, 'InvalidInput', 'Give the database user with the password')
      const auth = typeof input.authName === 'string' && input.authName ? input.authName : store
      checkName(auth, 'A saved login')
      await this.lfs.store.save_auth(auth, { user, password: input.passwordValue })
      return auth
    }
    return undefined
  }

  /** A new login's name: refused when a saved login has it (saving under it would change another Store's password). */
  private async freeLoginName(authName: unknown): Promise<string> {
    checkName(authName, 'The new login')
    if ((await this.auths()).items.some((a: { auth: string }) => a.auth === authName)) throw refuse(400, 'InvalidInput', `A saved login named ${authName} exists: pick it, or name another`)
    return authName
  }

  /**
   * A PostgreSQL database as a Store: { name, url (no user or password), auth
   * | passwordFrom | user + passwordValue + authName?, synchronousCommit?,
   * runsOn? }. A typed user and password are saved as a new login named
   * `authName` (default: the Store's name), never one that exists; when
   * LayerFS refuses the connect, that new login is removed again, so the
   * same name can be given once more. `runsOn` saves the machine its
   * sessions run on by default.
   */
  async connectPostgresql(input: any = {}) {
    const { name, url, synchronousCommit } = input
    checkName(name, 'A PostgreSQL Store')
    checkUrl(url, 'The database URL')
    const named = (typeof input.auth === 'string' && input.auth) || (input.passwordFrom !== undefined && input.passwordFrom !== null && input.passwordFrom !== '')
    const typed = !named && typeof input.passwordValue === 'string' && input.passwordValue !== ''
    if (typed && !(typeof input.user === 'string' && input.user.trim())) throw refuse(400, 'InvalidInput', 'Give the database user with the password')
    const fresh = typed ? await this.freeLoginName(input.authName === undefined || input.authName === null || input.authName === '' ? name : input.authName) : undefined
    const auth = await this.loginOf(fresh ? { ...input, authName: fresh } : input, name, url)
    if (!auth) throw refuse(400, 'InvalidInput', 'Choose a saved login, or give the user and password')
    try {
      await this.lfs.store.connect(name, url, { auth, ...(synchronousCommit ? { synchronous_commit: synchronousCommit } : {}) })
    } catch (error) {
      // only a refusal proves the connect did not happen; an unknown outcome keeps the login
      if (fresh && (error as { transport?: string })?.transport === 'refusal') {
        try { await this.lfs.store.remove_auth(fresh) } catch { /* the refusal below is the answer; the login stays listed */ }
      }
      throw error
    }
    if (typeof input.runsOn === 'string' && input.runsOn) this.storeMachines.set(name, input.runsOn)
    this.changed()
    return this.view()
  }

  /**
   * A PostgreSQL Store's connection: `{ machine?, url?, clear?, auth?,
   * passwordFrom?, user? + passwordValue?, synchronousCommit? }`. With a
   * `url`: the Store's address, or with `machine` that machine's own (proven
   * from it; store.connect). `clear` with `machine`: that machine's own
   * address goes (store.disconnect --machine). `auth`/`passwordFrom` or
   * `synchronousCommit`: store.update. A typed password: saved under the
   * Store's current login (store.save_auth rotates it). A Store that names no
   * saved login (`auth: null`: LayerFS answers it `broken` `outdated` and
   * refuses its calls) takes LayerFS's fix: a typed user and password are
   * saved as the login the person named (`authName`, never one that exists,
   * which would change another Store's password), then store.update names it.
   */
  async updateStore(name: string, input: any = {}) {
    checkName(name, 'A PostgreSQL Store')
    const machine: string | undefined = input.machine === undefined || input.machine === null || input.machine === '' ? undefined : input.machine
    if (machine !== undefined) checkName(machine, 'A machine')
    if (input.clear === true) {
      if (machine === undefined) throw refuse(400, 'InvalidInput', 'Name the machine whose own address to remove')
      await this.lfs.store.disconnect(name, { machine })
      this.changed()
      return this.view()
    }
    if (input.url) {
      checkUrl(input.url, 'The database URL')
      await this.lfs.store.connect(name, input.url, machine ? { machine } : {})
    }
    const sync = typeof input.synchronousCommit === 'string' && input.synchronousCommit ? input.synchronousCommit : undefined
    let rotated = false
    if (typeof input.passwordValue === 'string' && input.passwordValue !== '' && !input.auth) {
      const record: any = await this.lfs.store.get(name, { detail: true })
      if (typeof record?.auth !== 'string') {
        // no saved login: `store save-auth <auth> --user <user> --password-stdin && store update <store> --auth <auth>`, <auth> the person's
        const authName = await this.freeLoginName(input.authName)
        const auth = await this.loginOf({ ...input, authName }, name, null)
        await this.lfs.store.update(name, { auth, ...(sync ? { synchronous_commit: sync } : {}) })
        this.changed()
        return this.view()
      }
      // `store save-auth` needs the user with the password: the saved login's own unless one was typed
      const saved = (await this.auths()).items
      const user = typeof input.user === 'string' && input.user.trim() ? input.user : saved.find((a: { auth: string }) => a.auth === record.auth)?.user ?? undefined
      await this.loginOf({ ...input, user, authName: record.auth }, name, null)
      rotated = true
    }
    const auth = rotated ? undefined : await this.loginOf({ auth: input.auth, passwordFrom: input.passwordFrom }, name, null)
    if (auth || sync) await this.lfs.store.update(name, { ...(auth ? { auth } : {}), ...(sync ? { synchronous_commit: sync } : {}) })
    if (!input.url && !auth && !sync && !rotated) throw refuse(400, 'InvalidInput', 'Give an address, a login, a password or synchronous_commit to change')
    this.changed()
    return this.view()
  }

  /**
   * The connection check from `machine` (`store doctor <store> --machine M`):
   * `{ machine, host, ok, at }` or `{ machine, host, ok: false, error }` from
   * its `store.connection` check from that machine. Nothing is kept: the
   * caller shows it. A bad input (no such machine, a sqlite Store) is
   * LayerFS's refusal.
   */
  async checkStore(name: string, machine: unknown) {
    checkName(name, 'A PostgreSQL Store')
    checkName(machine, 'A machine')
    const report: any = await this.lfs.store.doctor(name, { machine, detail: true, timeout_ms: CHECK_TIMEOUT_MS })
    const finding = (Array.isArray(report?.findings) ? report.findings : []).find((f: any) => f?.check === 'store.connection' && f?.from === machine)
    const skipped = (Array.isArray(report?.not_checked) ? report.not_checked : []).find((n: any) => (n?.check === 'store.connection' || !n?.check) && (n?.from === machine || !n?.from))
    const at = msAt(report?.observed_at) ?? Date.now()
    if (finding) return { machine, host: null, ok: false as const, error: { code: finding.severity === 'error' ? 'Unavailable' : 'Failed', message: String(finding.message ?? 'the check failed') } }
    // a not_checked entry is `{ check, blocked_by, reason }`: no message of its own
    if (skipped) return { machine, host: null, ok: false as const, error: { code: String(skipped.reason ?? skipped.blocked_by?.reason ?? 'Unknown'), message: `machine ${machine} was not checked` } }
    return { machine, host: null, ok: true as const, at, version: null, latencyMs: null }
  }

  /** `{ machine }`: the machine PostgreSQL Store `name`'s sessions run on by default (this install's choice). */
  async setRunsOn(name: string, input: any = {}) {
    checkName(name, 'A PostgreSQL Store')
    checkName(input.machine, 'A machine')
    const record: any = await this.lfs.store.get(name)
    if (record?.engine !== 'postgresql') throw refuse(400, 'InvalidInput', `${name} is a SQLite Store; it runs on the machine that holds its file`)
    const target = (await machineRows(this.lfs)).find((m) => m.name === input.machine)
    if (!target) throw refuse(404, 'NotFound', `no machine named ${input.machine}`)
    if (!runsPostgresql(target)) throw refuse(400, 'Unsupported', `machine ${input.machine} runs no PostgreSQL Sandboxes`)
    this.storeMachines.set(name, input.machine)
    this.changed()
    return this.view()
  }

  async disconnectStore(name: string) {
    await this.lfs.store.disconnect(name)
    this.storeMachines.drop(name)
    this.changed()
    return this.view()
  }

  /** The home's saved PostgreSQL logins (`store auths --detail`): name, user, the Stores naming it; never a password. */
  async auths() {
    const listed = await this.lfs.store.auths({ detail: true })
    return { items: (Array.isArray(listed?.items) ? listed.items : []).map((a: any) => ({ auth: String(a.auth), user: typeof a.user === 'string' ? a.user : null, stores: Array.isArray(a.stores) ? a.stores.map(String) : [] })) }
  }

  // ---------- buckets ----------

  /**
   * An r2 or MinIO bucket. The URL is given whole ({ url }) or built from its
   * parts: MinIO { provider: 'minio', endpoint, bucket, prefix? }, R2
   * { provider: 'r2', account, jurisdiction?, bucket, prefix? }, with
   * { accessKey, secretKey }. The secret goes to LayerFS on stdin
   * (`--key-stdin`); the home keeps it. To change a key: disconnect and
   * connect again.
   */
  async connectBucket(input: any = {}) {
    const { name } = input
    checkName(name, 'A bucket')
    const url = input.url ?? bucketUrl(input)
    if (typeof url !== 'string' || !/^(https?:\/\/|r2:\/\/)/.test(url)) throw refuse(400, 'InvalidInput', 'A bucket URL is http(s)://<host>/<bucket>/<prefix> (MinIO) or r2://<account>/<bucket>/<prefix>')
    if (!url.startsWith('r2://')) checkUrl(url, 'The bucket URL')
    const [access, secret] = [input.accessKey, input.secretKey].map((v) => (typeof v === 'string' ? v.trim() : ''))
    if (!access || !secret || /\s/.test(access + secret)) throw refuse(400, 'InvalidInput', 'Give both the access key and the secret key (no spaces)')
    await this.lfs.backup.connect(name, url, { access_key: access, secret_key: secret })
    this.changed()
    return this.view()
  }

  /** Drops the bucket and its key; LayerFS drops every Store's link to it too. Answers which Stores lost theirs. */
  async disconnectBucket(name: string) {
    const done = await this.lfs.backup.disconnect(name, { detail: true })
    this.listings.delete(name)
    this.changed()
    return { unlinked: done?.unlinked ?? [], view: await this.view() }
  }

  /**
   * `backup list --bucket <name> --detail`: its files, kept as the bucket's
   * last listing. A file: its Store link (`store`), `behind` (the Store
   * changed since its last backup), `changed` (the bucket's copy is not the
   * one the link last moved), `missing` (linked, not in the bucket); null
   * with a `message` where LayerFS could not read it. A bucket that could not
   * be listed comes back in `not_listed`: its reason and message.
   */
  async listBucket(name: string): Promise<Listing> {
    checkName(name, 'A bucket')
    try {
      const listed = await this.lfs.backup.list({ bucket: name, detail: true })
      const failed = (Array.isArray(listed?.not_listed) ? listed.not_listed : []).find((n: any) => n?.bucket === name)
      const items = (Array.isArray(listed?.items) ? listed.items : []).filter((i: any) => i?.bucket === name).map((i: any) => ({
        file: String(i.file), store: typeof i.store === 'string' ? i.store : null, bytes: typeof i.size === 'number' ? i.size : null, modified: msAt(i.modified_at),
        behind: typeof i.behind === 'boolean' ? i.behind : null, changed: typeof i.changed === 'boolean' ? i.changed : null, missing: i.missing === true,
        message: typeof i.message === 'string' ? i.message : null,
      }))
      this.listings.set(name, failed ? { at: Date.now(), items: this.listings.get(name)?.items ?? null, error: notListedError(failed) } : { at: Date.now(), items, error: null })
    } catch (error: any) {
      this.listings.set(name, { at: Date.now(), items: this.listings.get(name)?.items ?? null, error: { code: error?.code ?? 'Failed', message: error?.message ?? String(error) } })
    }
    this.changed()
    return this.listings.get(name)!
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
    try { running = Promise.resolve(run(on_progress, step, (pid) => { job.pid = pid; emit() })) } catch (error) { running = Promise.reject(error) }
    this.running.set(job.id, running)
    running
      .then(
        (result) => { job.result = result ?? null; job.outcome = 'succeeded' },
        (error: any) => {
          // the SDK's refusal as it came: its code and text, the phase it stopped in, and its detail (entity, op, related)
          job.phase = error?.detail?.phase ?? job.phase
          // a transfer that stops in install or record is unknown; a compaction's refusal says so itself (`Unknown`)
          job.outcome = failureOutcome(error, kind === 'compact' ? null : job.phase)
          job.error = { transport: error?.transport ?? null, code: error?.code ?? 'Failed', message: error?.message ?? String(error), phase: error?.detail?.phase ?? job.phase, detail: error?.detail ?? null, ...fixOf(error), ...(error?.note ? { note: error.note } : {}) }
          this.log(`[storage] ${kind} ${store}: ${error?.code ?? ''} ${error?.message ?? error}`)
        },
      )
      .finally(() => {
        this.running.delete(job.id)
        job.ended = Date.now()
        job.summary = transferSummary(job)
        emit()
        // the bucket's listing changed with a backup or restore
        if (kind === 'backup' || kind === 'restore') void this.listBucket(target).catch(() => {})
        this.changed()
      })
    emit()
    this.changed()
    return { ...job }
  }

  /** store.move(store, machine): a sqlite Store on native to `machine`. */
  push(store: unknown, machine: unknown) {
    checkName(store, 'A move')
    checkName(machine, 'A move')
    return this.start('push', store, machine, null, async (on_progress, _step, on_spawn) => {
      await this.host.ensureNative()
      return this.lfs.store.move(store, machine, { on_progress, on_spawn, detail: true })
    })
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
      step('push')
      try {
        return await this.lfs.store.move(store, machine, { on_progress, on_spawn, detail: true })
      } catch (error: any) {
        if (failureOutcome(error, error?.detail?.phase) === 'failed' && error?.detail?.phase !== 'retire') error.note = 'pulled'
        throw error
      }
    })
  }

  /** Puts sqlite Store `store` on `machine`: a move from native, to native, else two moves through native. */
  async place(store: unknown, machine: unknown) {
    checkName(store, 'A Store')
    checkName(machine, 'A machine')
    const record = await this.lfs.store.get(store)
    if (record.engine && record.engine !== 'sqlite') throw refuse(400, 'InvalidInput', `${store} is a PostgreSQL Store; it is never moved`)
    if (record.machine === machine) throw refuse(400, 'InvalidInput', `${store} is on ${machine} already`)
    if (machine === 'native') return this.pull(store)
    if (record.machine === 'native') return this.push(store, machine)
    return this.move(store, machine)
  }

  /** A started job's LayerFS work while it runs (its result, or its refusal as it came). */
  private readonly running = new Map<string, Promise<unknown>>()

  /**
   * The Doctor page's backup fix: the same Storage job as the Backups page's
   * (its job row, `storage-job` events, one job per Store), awaited to its end.
   */
  async backupAndWait(store: string, bucket: string): Promise<unknown> {
    const job = this.backup(store, { bucket })
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

  async inspect(id: string) {
    const job = this.jobs.get(id)
    if (!job || !job.ended) throw refuse(409, 'ConnectBusy', 'Wait for a completed job before inspecting recovery')
    job.observation = await inspectJob(this.lfs, job)
    const value = job.observation.value
    if (value?.state === 'broken' && value?.reason === 'unresolved') job.outcome = 'unknown'
    else if (value?.state === 'ready' && job.error?.transport === 'transport-unknown' && !['install', 'record'].includes(job.phase ?? '')) job.outcome = 'interrupted'
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
