/**
 * Storage on LayerFS 2.0: the home's Stores by machine, PostgreSQL Stores,
 * buckets and their backups, and the pushes, pulls, backups and restores this
 * host started. Port of Connect `host/storage.js`.
 *
 *   view              StorageView: store.list, store.status per Store (it
 *                     starts no machine: a Store on a stopped one is `down`),
 *                     machine.list for the groups, the buckets and their last
 *                     listing, and the job table
 *   createStore       store.create(name): a sqlite Store on native
 *   removeStore       store.remove(name), `confirm` naming it
 *   connectPostgresql store.connect(name, url, { password, synchronous_commit }):
 *                     the URL holds no password; `password` is a reference, or
 *                     `passwordValue`, written to an owner-only file
 *   attachStore       store.attach(name, machine, { url, password }): the
 *                     machine's own connection or the Store's, checked from
 *                     that machine; a refusal is kept for the view
 *   detachStore       store.detach(name, machine)
 *   disconnectStore   store.disconnect(name): a PostgreSQL Store
 *   connectBucket     backup.connect(name, url, { key, region }): `key` is a
 *                     reference (env:LAYERFS_… or file:/absolute/path)
 *   disconnectBucket  backup.disconnect(name): every Store's link to it goes
 *   listBucket        backup.list(bucket): one call per bucket, its seven states
 *   push/pull/move    store.push / store.pull as jobs; a move is pull then push
 *                     (#537 U5); a push that fails leaves the Store on native
 *   place             the one of push, pull or move that puts a Store on a machine
 *   backup/restore    backup.create / backup.restore as jobs
 *
 * Buckets and PostgreSQL Stores take env:/file: references, which LayerFS
 * resolves; a key or password entered in the panel is written by the host to
 * an owner-only file in the secrets folder (`host.secrets`: config `secrets`,
 * DSH_LAYERFS_SECRETS, default `<home>/secret`, docs/specs/homes.md) and
 * passed as its `file:` reference (never logged, recorded or answered back).
 * Storage state lives in the LayerFS home (docs/specs/homes.md §5): the
 * connected buckets are read from LayerFS's own records
 * (`<home>/backup/<name>/record.json`; 2.0 has no call that lists them without
 * contacting each one, §9 Q7), and the job table is in `host.jobs` (`<home>/job`). Events: `storage-job`
 * `{ type, job }` as a job moves, `storage` `{ type }` when the view changed.
 */
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { execute } from '../layerfs/cli.ts'
import { BackupMarks, historyFingerprint, remoteOnly, settleRemote } from './backup-heads.ts'
import { JobStore, failureOutcome, inspectJob, transferSummary, type StorageJob } from './jobs.ts'
import { computer } from './computer.ts'
import { refuse, wire, type RouteHost } from './util.ts'

/** Finished jobs kept in the table. */
const KEEP_JOBS = 30
/** A project list joins a view this recent instead of reading one. */
const JOIN_MS = 15_000

/** A reference LayerFS resolves: env:LAYERFS_… or file:/absolute/path. */
const REFERENCE = /^(env:[A-Za-z_][A-Za-z0-9_]*|file:\/.+)$/

function checkReference(value: unknown, what: string): void {
  if (typeof value !== 'string' || !REFERENCE.test(value)) throw refuse(400, 'InvalidInput', `${what} must be a reference: env:LAYERFS_<NAME> or file:/absolute/path (the host never takes the secret itself)`)
}
function checkName(value: unknown, what: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-z0-9](?:[a-z0-9_.-]{0,61}[a-z0-9])?$/.test(value)) throw refuse(400, 'InvalidInput', `${what} needs a lowercase name (maximum 63 characters), starting and ending with a letter or number`)
}

/** A URL with no password in it (and, for a bucket, no user either). */
function checkUrl(value: unknown, what: string, { user = true } = {}): void {
  let url: URL
  try {
    url = new URL(String(value))
  } catch {
    throw refuse(400, 'InvalidInput', `${what} is not a URL`)
  }
  if (url.password || (user && url.username)) throw refuse(400, 'InvalidInput', `${what} must not hold a ${user ? 'user or ' : ''}password: give the secret as a reference`)
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

/** A PostgreSQL Store's server: its record's URL (no password) and what store.status's `server` answered. */
function pgServer(s: any, server: any) {
  const reached = typeof server?.reachable === 'boolean' ? server.reachable : null
  return {
    target: typeof s.url === 'string' ? pgTarget(s.url) : null,
    reachable: reached,
    version: reached ? (server.server_version ?? null) : null,
    latencyMs: reached ? (server.latency_ms ?? null) : null,
    error: server?.unavailable ?? server?.error?.message ?? null,
  }
}

type AttachError = { code: string, message: string, at: number }

/** Whether `reference` is `file:` naming a file the host wrote: `<secrets>/<prefix>…`. */
function savedFile(reference: unknown, secrets: string | undefined, prefix: string): boolean {
  if (typeof reference !== 'string' || !reference.startsWith('file:')) return false
  const path = reference.slice('file:'.length)
  return secrets ? dirname(path) === secrets && basename(path).startsWith(prefix) : new RegExp(`/secrets/${prefix}`).test(path)
}

/**
 * A PostgreSQL Store's machines (`store.attach`): `{ machine, own, target,
 * checked, lastError }`, `own` when the machine dials its own URL or
 * password. Null from a CLI before attachments (no `machines` field).
 */
export function attachmentsOf(s: any, errors: Map<string, AttachError> = new Map(), secrets?: string) {
  if (s.kind !== 'postgresql' || !s.machines || typeof s.machines !== 'object') return null
  return Object.entries(s.machines).map(([machine, a]: [string, any]) => {
    const checked = a?.checked && typeof a.checked === 'object' ? a.checked : null
    return {
      machine,
      own: typeof a?.url === 'string' || typeof a?.password === 'string',
      // the machine's own URL (LayerFS keeps no password in it), or null (the Store's)
      url: typeof a?.url === 'string' ? a.url : null,
      target: typeof a?.url === 'string' ? pgTarget(a.url) : (typeof s.url === 'string' ? pgTarget(s.url) : null),
      // a reference (never a secret); `saved` when it names a file this host wrote
      password: typeof a?.password === 'string' ? a.password : null,
      saved: savedFile(a?.password, secrets, 'pg-'),
      checked: checked ? { at: checked.at ?? null, version: checked.server_version ?? null, latencyMs: checked.latency_ms ?? null } : null,
      lastError: errors.get(`${s.name}/${machine}`) ?? null,
    }
  })
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

/** A store.list item and its store.status -> StoreRow. */
export function storeRow(s: any, status: any, jobs: StorageJob[], errors?: Map<string, AttachError>, secrets?: string) {
  const op = s.op ?? status?.op ?? null
  const file = status?.file
  return {
    name: s.name,
    kind: s.kind ?? 'sqlite',
    machine: s.machine ?? null,
    projects: (s.projects ?? []).map(String),
    created: s.created ?? null,
    size: file?.exists ? { bytes: (file.bytes ?? 0) + (file.wal_bytes ?? 0), file: file.bytes ?? 0, wal: file.wal_bytes ?? 0 } : null,
    // the SDK's state: store.list's item, derived as store.status derives it (#537 U4)
    state: s.state ?? status?.state ?? 'unknown',
    op: op && typeof op === 'object' ? { id: String(op.id ?? ''), name: String(op.name ?? ''), phase: op.phase ?? '', started: op.started ?? null, uncertain: op.uncertain === true } : null,
    holders: (status?.holders ?? []).length,
    down: status?.down_reason ?? (status ? null : 'store.status did not answer'),
    links: Object.entries(s.backups ?? {}).map(([bucket, link]: [string, any]) => ({ bucket, file: link.file ?? s.name, last: link.last ? { op: link.last.op, at: link.last.at ?? null, bytes: link.last.bytes ?? null } : null })),
    job: jobs.find((j) => j.store === s.name && !j.ended)?.id ?? null,
    postgresql: s.kind === 'postgresql' ? pgServer(s, status?.server) : null,
    attachments: attachmentsOf(s, errors, secrets),
    // refused attaches (from this host) to machines the Store is not attached to
    attachRefusals: s.kind === 'postgresql' ? [...(errors ?? new Map()).entries()].filter(([key]) => key.startsWith(`${s.name}/`) && !(s.machines && key.slice(s.name.length + 1) in s.machines)).map(([key, e]) => ({ machine: key.slice(s.name.length + 1), ...e })) : [],
  }
}

type BucketRecord = { name: string, provider: string | null, keys?: 'saved' | 'reference', key?: string | null, /** the key file the host wrote (keys: saved) */ file?: string | null, url?: string | null, region?: string | null }

/** A bucket's URL from its LayerFS record: MinIO `<endpoint>/<bucket>/<prefix>`, R2 `r2://<account>/<bucket>/<prefix>`. */
export function recordUrl(r: any): string | null {
  if (typeof r?.url === 'string') return r.url
  const path = [r?.bucket, r?.prefix].filter((p) => typeof p === 'string' && p).join('/')
  const r2Host = typeof r?.endpoint === 'string' ? /^https:\/\/([0-9a-f]{32})\.(?:[a-z]+\.)?r2\.cloudflarestorage\.com/.exec(r.endpoint) : null
  const account = typeof r?.account === 'string' ? r.account : r2Host?.[1]
  if (r?.provider === 'r2' && account) return `r2://${account}/${path}${r.jurisdiction ? `?jurisdiction=${r.jurisdiction}` : ''}`
  if (typeof r?.endpoint === 'string') return `${r.endpoint.replace(/\/+$/, '')}/${path}`
  return null
}
type Listing = { at: number, items: any[] | null, error: { code: string, message: string } | null }

export class Storage {
  readonly jobStore: JobStore
  readonly jobs: Map<string, StorageJob>
  /** bucket name -> its last backup.list */
  readonly listings = new Map<string, Listing>()
  /** `<store>/<machine>` -> the last refused store.attach from this host, until one passes */
  readonly attachErrors = new Map<string, AttachError>()
  lastView: any = null
  /** The StorageView read in flight, shared by concurrent callers; a write (`changed`) bumps `generation` so later callers read anew. */
  private viewing: { promise: ReturnType<Storage['readView']>, generation: number } | null = null
  private generation = 0
  /** What this host knew of a Store on another machine when it backed it up (see backup-heads.ts). */
  readonly marks: BackupMarks
  readonly reconciled: Promise<void>
  private readonly doctorCall: () => Promise<any>

  /**
   * @param host - the route dependencies.
   * @param doctor - the `layerfs doctor` report reader (tests pass a stand-in).
   */
  constructor(private readonly host: RouteHost, doctor: (() => Promise<any>) | null = null) {
    this.doctorCall = doctor ?? (async () => {
      await this.host.discover()
      return execute(this.lfs.spec, ['doctor'], { read: true })
    })
    // the job and stat folders in the LayerFS home, all owner-only (LayerFS requires 0700; a home made here is too)
    moveLegacyStorageState(host.home, host.jobs, host.stats)
    for (const dir of [host.jobs, host.stats, join(host.stats, 'storage-observations'), join(host.stats, 'project-storage')]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      chmodSync(dir, 0o700)
    }
    this.marks = new BackupMarks(host.stats)
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

  /**
   * What `layerfs doctor` finds in the home (#537 §5 "Needs attention"):
   * `{ ok, findings: [{ severity, entity: { kind, name }, message, fix }], at }`.
   * Report-only; read when the Storage page asks, never on a timer.
   */
  async doctor() {
    const report = await this.doctorCall()
    const findings = (report?.findings ?? []).map((f: any) => ({
      severity: f?.severity === 'error' ? 'error' : 'warning',
      entity: f?.entity && typeof f.entity === 'object' ? { kind: String(f.entity.kind ?? ''), name: String(f.entity.name ?? '') } : null,
      message: String(f?.message ?? ''),
      fix: typeof f?.fix === 'string' && f.fix ? f.fix : null,
    }))
    return { ok: report?.ok !== false && !findings.some((f: any) => f.severity === 'error'), findings, at: Date.now() }
  }

  changed(): void {
    this.lastView = null
    this.generation++
    this.event({ type: 'storage' })
  }

  /**
   * The buckets connected to this LayerFS home, by any client: LayerFS's own
   * records (`<home>/backup/<name>/record.json`, read only, never written here).
   * `keys` is `saved` when the key reference names a file in the secrets folder.
   */
  bucketRecords(): BucketRecord[] {
    const dir = join(this.host.home, 'backup')
    let names: string[]
    try { names = readdirSync(dir) } catch { return [] }
    const records: BucketRecord[] = []
    for (const name of names.sort()) {
      let r: any
      try { r = JSON.parse(readFileSync(join(dir, name, 'record.json'), 'utf8')) } catch { continue }
      if (!r || typeof r !== 'object') continue
      const key = typeof r.key === 'string' ? r.key : null
      const saved = savedFile(key, this.host.secrets, 'bucket-')
      records.push({ name: typeof r.name === 'string' ? r.name : name, provider: typeof r.provider === 'string' ? r.provider : null, keys: key ? (saved ? 'saved' : 'reference') : undefined, key: saved ? null : key, file: saved ? key!.slice('file:'.length) : null, url: recordUrl(r), region: typeof r.region === 'string' ? r.region : null })
    }
    return records
  }

  knownBuckets(): string[] {
    return this.bucketRecords().map((b) => b.name)
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
    const [listed, machines] = await Promise.all([this.lfs.store.list(), this.lfs.machine.list()])
    const items: any[] = listed.items ?? []
    const statuses = await Promise.all(items.map((s) => this.lfs.store.status(s.name).catch((error: any) => (this.log(`[storage] store.status ${s.name}: ${error?.message ?? error}`), null))))
    const jobs = this.jobList()
    const stores = items.map((s, i) => storeRow(s, statuses[i], jobs, this.attachErrors, this.host.secrets))
    const names = new Set([...this.knownBuckets(), ...stores.flatMap((s) => s.links.map((l) => l.bucket))])
    const records = this.bucketRecords()
    const buckets = [...names].sort().map((name) => {
      const listing = this.listings.get(name)
      const record = records.find((b) => b.name === name)
      return { name, keys: record?.keys ?? null, key: record?.key ?? null, url: record?.url ?? null, region: record?.region ?? null, provider: record?.provider ?? null, listed: listing?.at ?? null, files: listing?.items ?? null, error: listing?.error ?? null, stores: stores.filter((s) => s.links.some((l) => l.bucket === name)).map((s) => s.name) }
    })
    const view = {
      machines: (machines.machines ?? []).map((m: any) => ({ name: m.name, platform: m.platform, state: m.state ?? null, supports: m.supports ?? null })),
      // this computer (the native machine): its OS names it
      computer: computer(),
      stores,
      // store.attach in the pinned CLI: without it a PostgreSQL Store runs on native only
      features: { attach: await this.attachSupported() },
      buckets,
      jobs,
      at: Date.now(),
    }
    // a write while this read ran: answer it, but do not keep it for the join
    if (generation === this.generation) this.lastView = view
    return view
  }

  /** Store name -> { state, op, machine, down } for the project list: a recent view, else a new one. */
  async projectJoin(): Promise<Map<string, { state: string, op: unknown, machine: string | null, down: string | null }>> {
    const view = this.lastView && Date.now() - this.lastView.at < JOIN_MS ? this.lastView : await this.view()
    return new Map(view.stores.map((s: any) => [s.name, { state: s.state, op: s.op, machine: s.machine, down: s.down }]))
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

  /** Whether the pinned CLI has store.attach (false when discovery fails). */
  async attachSupported(): Promise<boolean> {
    try {
      return (await this.host.discover()).calls.some((c: any) => c.family === 'store' && c.call === 'attach')
    } catch {
      return false
    }
  }

  /** The prefix of the password files the host writes for PostgreSQL Store `store` (and `machine`). */
  private pgSecretPrefix(store: string, machine?: string): string {
    return `pg-${store}${machine ? `--${machine}` : ''}--`
  }

  /** The host's password files for `store` (and `machine`; `''` the Store's own). */
  private pgSecretFiles(store: string, machine?: string): string[] {
    const dir = this.host.secrets
    const prefix = machine === undefined ? `pg-${store}--` : this.pgSecretPrefix(store, machine || undefined)
    try {
      return readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.pw') && (machine !== '' || !f.slice(prefix.length).includes('--'))).map((f) => join(dir, f))
    } catch {
      return []
    }
  }

  /**
   * `{ password }` (a reference) or `{ passwordValue }` (written to a new
   * owner-only file, answered as its `file:` reference and path). Each write
   * gets a new file, so a refused call never breaks the file an earlier
   * call recorded.
   */
  private pgPassword(input: any, store: string, machine?: string): { password?: string, written: string | null } {
    if (typeof input?.passwordValue === 'string' && input.passwordValue !== '') {
      if (input.password !== undefined && input.password !== null && input.password !== '') throw refuse(400, 'InvalidInput', 'Give the password or a reference, not both')
      const dir = this.secretsDir()
      const written = join(dir, `${this.pgSecretPrefix(store, machine)}${randomUUID().slice(0, 8)}.pw`)
      writeFileSync(written, input.passwordValue, { mode: 0o600 })
      chmodSync(written, 0o600)
      return { password: `file:${written}`, written }
    }
    if (input?.password === undefined || input?.password === null || input?.password === '') return { written: null }
    checkReference(input.password, 'The password')
    return { password: input.password, written: null }
  }

  /** Removes the host's password files of `store`/`machine` other than `keep`. */
  private dropPgSecrets(store: string, machine: string | undefined, keep: string | null = null): void {
    for (const file of this.pgSecretFiles(store, machine)) if (file !== keep) rmSync(file, { force: true })
  }

  /**
   * A PostgreSQL database as a Store: { name, url (no password), password (a
   * reference) | passwordValue, synchronousCommit? }. LayerFS attaches it to
   * native.
   */
  async connectPostgresql(input: any = {}) {
    const { name, url, synchronousCommit } = input
    checkName(name, 'A PostgreSQL Store')
    checkUrl(url, 'The database URL', { user: false })
    if (!input.passwordValue) checkReference(input.password, 'The password')
    const { password, written } = this.pgPassword(input, name, '')
    try {
      await this.lfs.store.connect(name, url, { password, ...(synchronousCommit ? { synchronous_commit: synchronousCommit } : {}) })
    } catch (error) {
      if (written) rmSync(written, { force: true })
      throw error
    }
    this.changed()
    return this.view()
  }

  /**
   * store.attach(name, machine, { url, password }): `{ machine, url?,
   * password? | passwordValue? }`; no url and no password reuse the Store's.
   * A refusal is kept for the view (`lastError`) and thrown as LayerFS gave it.
   */
  async attachStore(name: string, input: any = {}) {
    checkName(name, 'A PostgreSQL Store')
    const { machine } = input
    checkName(machine, 'A machine')
    if (!(await this.attachSupported())) throw refuse(400, 'Unsupported', 'The pinned LayerFS CLI has no store attach; update it to attach PostgreSQL Stores to machines')
    if (input.url) checkUrl(input.url, 'The database URL', { user: false })
    const { password, written } = this.pgPassword(input, name, machine)
    const key = `${name}/${machine}`
    try {
      await this.lfs.store.attach(name, machine, { ...(input.url ? { url: input.url } : {}), ...(password ? { password } : {}) })
    } catch (error: any) {
      if (written) rmSync(written, { force: true })
      this.attachErrors.set(key, { code: error?.code ?? 'Failed', message: error?.message ?? String(error), at: Date.now() })
      this.changed()
      throw error
    }
    this.attachErrors.delete(key)
    // the files an earlier attach of this machine recorded
    this.dropPgSecrets(name, machine, written ?? (password?.startsWith('file:') ? password.slice(5) : null))
    this.changed()
    return this.view()
  }

  /** store.detach(name, machine): `{ machine }`; removes that machine's password files. */
  async detachStore(name: string, input: any = {}) {
    checkName(name, 'A PostgreSQL Store')
    checkName(input.machine, 'A machine')
    await this.lfs.store.detach(name, input.machine)
    this.attachErrors.delete(`${name}/${input.machine}`)
    this.dropPgSecrets(name, input.machine)
    this.changed()
    return this.view()
  }

  async disconnectStore(name: string) {
    await this.lfs.store.disconnect(name)
    for (const key of this.attachErrors.keys()) if (key.startsWith(`${name}/`)) this.attachErrors.delete(key)
    this.dropPgSecrets(name, undefined)
    this.changed()
    return this.view()
  }

  // ---------- buckets ----------

  /** The secrets folder, created owner-only. */
  private secretsDir(): string {
    // by default it is <home>/secret: a home made here is owner-only, as LayerFS requires
    if (this.host.secrets.startsWith(`${this.host.home}/`) && !existsSync(this.host.home)) mkdirSync(this.host.home, { recursive: true, mode: 0o700 })
    mkdirSync(this.host.secrets, { recursive: true, mode: 0o700 })
    chmodSync(this.host.secrets, 0o700)
    return this.host.secrets
  }

  /** The owner-only key file the host writes for bucket `name` (LayerFS gets its file: reference). */
  keyFile(name: string): string {
    return join(this.host.secrets, `bucket-${String(name).replace(/[^a-z0-9_.-]/gi, '-')}.key`)
  }

  /** The key file a saved bucket uses: the one recorded at connect (the secrets folder may have moved since). */
  private savedKeyFile(name: string): string {
    return this.bucketRecords().find((b) => b.name === name)?.file ?? this.keyFile(name)
  }

  /**
   * An r2 or MinIO bucket. The URL is given whole ({ url }) or built from its
   * parts: MinIO { provider: 'minio', endpoint, bucket, prefix? }, R2
   * { provider: 'r2', account, jurisdiction?, bucket, prefix? }. The key is
   * a reference ({ key: env:LAYERFS_… or file:/abs }) or the two keys
   * ({ accessKey, secretKey }), which the host writes to an owner-only file
   * in the secrets folder and passes as that file's reference: the keys
   * never go into the URL, storage records or the home.
   */
  async connectBucket(input: any = {}) {
    const { name, region } = input
    checkName(name, 'A bucket')
    const url = input.url ?? bucketUrl(input)
    if (typeof url !== 'string' || !/^(https?:\/\/|r2:\/\/)/.test(url)) throw refuse(400, 'InvalidInput', 'A bucket URL is http(s)://<host>/<bucket>/<prefix> (MinIO) or r2://<account>/<bucket>/<prefix>')
    if (!url.startsWith('r2://')) checkUrl(url, 'The bucket URL')
    let key = input.key
    let written: string | null = null
    if (input.accessKey !== undefined || input.secretKey !== undefined) {
      const [access, secret] = [input.accessKey, input.secretKey].map((v) => (typeof v === 'string' ? v.trim() : ''))
      if (!access || !secret || /\s/.test(access + secret)) throw refuse(400, 'InvalidInput', 'Give both the access key and the secret key (no spaces)')
      written = this.keyFile(name)
      if (existsSync(written)) throw refuse(409, 'Exists', 'Saved keys already exist for this bucket; use Replace keys')
      this.secretsDir()
      writeFileSync(written, `access_key=${access}\nsecret_key=${secret}\n`, { mode: 0o600 })
      chmodSync(written, 0o600)
      key = `file:${written}`
    }
    checkReference(key, 'The key')
    try {
      // LayerFS records the bucket in the home (backup/<name>/record.json); the view reads it from there
      await this.lfs.backup.connect(name, url, { key, ...(region ? { region } : {}) })
    } catch (error) {
      if (written) rmSync(written, { force: true })
      throw error
    }
    this.changed()
    return this.view()
  }

  /** Drops the bucket; LayerFS drops every Store's link to it too. Answers which Stores lost theirs. */
  async disconnectBucket(name: string) {
    const file = this.savedKeyFile(name)
    const done = await this.lfs.backup.disconnect(name)
    // the key file the host wrote for it, if any
    rmSync(file, { force: true })
    this.listings.delete(name)
    this.changed()
    return { unlinked: done?.unlinked ?? [], view: await this.view() }
  }

  /** backup.list(bucket): its files with their states, kept as the bucket's last listing. */
  async listBucket(name: string): Promise<Listing> {
    checkName(name, 'A bucket')
    try {
      const listed = await this.lfs.backup.list(name)
      let items = (listed.items ?? []).map((i: any) => ({ file: i.file, store: i.store ?? null, state: i.state, bytes: i.bytes ?? null, modified: i.modified ?? null, reason: i.reason ?? null, heads: i.heads ?? null }))
      // a Store on another machine lists as unknown: settle it from this host's marks (backup-heads.ts)
      if (items.some(remoteOnly)) {
        const stores = (await this.lfs.store.list().catch(() => null))?.items ?? []
        items = await settleRemote(items, name, stores, this.marks, (store) => historyFingerprint(this.lfs, store))
      }
      this.listings.set(name, { at: Date.now(), items, error: null })
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
  start(kind: StorageJob['kind'], store: string, target: string, file: string | null | undefined, run: (on_progress: (p: any) => void, step: (half: 'pull' | 'push', from?: string | null) => void, on_spawn: (pid: number) => void) => Promise<unknown>, from: string | null = null) {
    if ([...this.jobs.values()].some((j) => j.store === store && !j.ended)) throw refuse(409, 'ConnectBusy', `this host is already running a job on ${store}; wait for it to end`)
    const job: StorageJob = { id: randomUUID(), kind, store, target, from, file: file ?? null, started: Date.now(), ended: null, half: null, phase: null, phases: [], outcome: null, pid: null, observation: null, summary: null, done: null, total: null, error: null, result: null }
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
    try { running = run(on_progress, step, (pid) => { job.pid = pid; emit() }) } catch (error) { running = Promise.reject(error) }
    Promise.resolve(running)
      .then(
        (result) => { job.result = result ?? null; job.outcome = 'succeeded' },
        (error: any) => {
          // the SDK's refusal as it came: its code and text, the phase it stopped in, and its detail (entity, op, related)
          job.phase = error?.detail?.phase ?? job.phase
          job.outcome = failureOutcome(error, job.phase)
          job.error = { transport: error?.transport ?? null, code: error?.code ?? 'Failed', message: error?.message ?? String(error), phase: error?.detail?.phase ?? job.phase, detail: error?.detail ?? null, ...(error?.note ? { note: error.note } : {}) }
          this.log(`[storage] ${kind} ${store}: ${error?.code ?? ''} ${error?.message ?? error}`)
        },
      )
      .finally(() => {
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

  /** store.push(store, machine): a sqlite Store on native to `machine`. */
  push(store: unknown, machine: unknown) {
    checkName(store, 'A push')
    checkName(machine, 'A push')
    return this.start('push', store, machine, null, async (on_progress, _step, on_spawn) => {
      await this.host.ensureNative()
      return this.lfs.store.push(store, machine, { on_progress, on_spawn })
    })
  }

  /** store.pull(store): a sqlite Store on a machine back to native. */
  async pull(store: unknown) {
    checkName(store, 'A pull')
    // the machine it comes from (store.get reads the record; it starts nothing): the job row reads "<store> ← <machine>"
    const from = (await this.lfs.store.get(store))?.machine ?? null
    return this.start('pull', store, 'native', null, async (on_progress, _step, on_spawn) => {
      await this.host.ensureNative()
      return this.lfs.store.pull(store, { on_progress, on_spawn })
    }, from)
  }

  /**
   * A Store on one machine to another: pull, then push, two operations (U5).
   * When the push half fails the Store stays on native; the error's `note`
   * says so (`pulled`).
   */
  move(store: unknown, machine: unknown) {
    checkName(store, 'A move')
    checkName(machine, 'A move')
    return this.start('move', store, machine, null, async (on_progress, step, on_spawn) => {
      await this.host.ensureNative()
      const source = await this.lfs.store.get(store)
      step('pull', source.machine ?? null)
      await this.lfs.store.pull(store, { on_progress, on_spawn })
      step('push')
      try {
        return await this.lfs.store.push(store, machine, { on_progress, on_spawn })
      } catch (error: any) {
        if (failureOutcome(error, error?.detail?.phase) === 'failed' && error?.detail?.phase !== 'retire') error.note = 'pulled'
        throw error
      }
    })
  }

  /** Puts sqlite Store `store` on `machine`: a push from native, a pull to native, else a move. */
  async place(store: unknown, machine: unknown) {
    checkName(store, 'A Store')
    checkName(machine, 'A machine')
    const record = await this.lfs.store.get(store)
    if (record.kind && record.kind !== 'sqlite') throw refuse(400, 'InvalidInput', `${store} is a PostgreSQL Store; it is never pushed or pulled`)
    if (record.machine === machine) throw refuse(400, 'InvalidInput', `${store} is on ${machine} already`)
    if (machine === 'native') return this.pull(store)
    if (record.machine === 'native') return this.push(store, machine)
    return this.move(store, machine)
  }

  /** backup.create(store, bucket, file?). */
  backup(store: unknown, { bucket, file }: any = {}) {
    checkName(store, 'A backup')
    checkName(bucket, 'A backup')
    return this.start('backup', store, bucket, file, async (on_progress, _step, on_spawn) => {
      // LayerFS cannot tell later whether a Store on another machine changed since this backup:
      // the host fingerprints its history first and keeps it with the sha256 the backup moved
      const record = ((await this.lfs.store.list().catch(() => null))?.items ?? []).find((s: any) => s.name === store)
      const remote = record && (record.kind ?? 'sqlite') === 'sqlite' && record.machine && record.machine !== 'native'
      const fingerprint = remote ? await historyFingerprint(this.lfs, store).catch((error: any) => (this.log(`[storage] fingerprint ${store}: ${error?.message ?? error}`), null)) : null
      const result = await this.lfs.backup.create(store, bucket, file || undefined, { on_progress, on_spawn })
      if (fingerprint && typeof result?.sha256 === 'string') {
        try { this.marks.set(store, bucket, String(result.file ?? (file || store)), { sha256: result.sha256, fingerprint, at: Date.now() }) } catch (error: any) { this.log(`[storage] backup mark ${store}: ${error?.message ?? error}`) }
      }
      return result
    })
  }

  /** backup.restore(store, bucket, file?): a new Store `store` on native. */
  restore({ store, bucket, file }: any = {}) {
    checkName(store, 'A restore')
    checkName(bucket, 'A restore')
    return this.start('restore', store, bucket, file, (on_progress, _step, on_spawn) => this.lfs.backup.restore(store, bucket, file || undefined, { on_progress, on_spawn }))
  }

  async inspect(id: string) {
    const job = this.jobs.get(id)
    if (!job || !job.ended) throw refuse(409, 'ConnectBusy', 'Wait for a completed job before inspecting recovery')
    job.observation = await inspectJob(this.lfs, job)
    if (job.observation.value?.state === 'unresolved') job.outcome = 'unknown'
    else if (job.observation.value?.state === 'idle' && job.error?.transport === 'transport-unknown' && !['install', 'record'].includes(job.phase ?? '')) job.outcome = 'interrupted'
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

  async replaceBucketKeys(name: string, input: any) {
    const record = this.bucketRecords().find((b) => b.name === name)
    if (!record) throw refuse(404, 'NotFound', 'No saved bucket with this name')
    if (record.keys !== 'saved') throw refuse(400, 'InvalidInput', 'This bucket uses an external secret reference; update that reference instead')
    const access = input?.accessKey?.trim(), secret = input?.secretKey?.trim()
    if (!access || !secret || /\s/.test(access + secret)) throw refuse(400, 'InvalidInput', 'Give both keys without spaces')
    // where LayerFS reads it: the file recorded at connect
    const file = record.file ?? this.keyFile(name)
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(file, `access_key=${access}\nsecret_key=${secret}\n`, { mode: 0o600 })
    chmodSync(file, 0o600)
    await this.listBucket(name)
    return this.view()
  }

  close(): void { this.jobStore.save() }
}
