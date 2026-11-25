/** Owner-routed persistence. Every conversation uses the unmodified DSH JSONL
 * backend; project logs use a separate, unpacked root and an additive sidecar. */
import type { Context } from '@deepseek-ai/cordis'
import * as jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionPersistence, SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import { randomUUID } from 'node:crypto'
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { homedir } from 'node:os'
import { ProjectCatalog, type ProjectIdentity, type CatalogProject } from './sessions/catalog.ts'
import { CliError } from './layerfs/cli.ts'

export const name = 'dsh-layerfs-session-persistence'
export type Config = jsonl.Config
export const Config = jsonl.Config

type Owner = { project: string, key: string, identity?: ProjectIdentity }
type Routes = { version: 1, sessions: Record<string, Owner> }
/** Conversations deleted on purpose: never imported back implicitly. */
type Deleted = { version: 1, sessions: Record<string, { project: string, at: number }> }
export interface SessionSidecar {
  version: 1
  sessionId: string
  project: string
  invocations: any[]
  archive?: { count: number, updatedAt: number, error?: string }
  [key: string]: any
}

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${randomUUID()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, path)
}

/** Identifies one version of a file; atomic replacement changes the inode. */
function signatureOf(path: string): string {
  try { const s = statSync(path); return `${s.ino}:${s.size}:${s.mtimeMs}` } catch { return 'missing' }
}

/** One session's header snapshot, reusable while its log keeps the same identity. */
interface CachedHeader {
  id: string
  /** The routed backend that produced it: an ownership move must miss. */
  backend: unknown
  snapshot: any
  path: string
  /** The stock backend's own change token: device, inode, size, mtime and ctime. */
  identity: string
  bytes: number
}

const HEADER_CACHE_LIMIT = 1024
/** Headers stay small; this caps a pathological header or a long-lived process. */
const HEADER_CACHE_BUDGET = 4 * 1024 * 1024

/** Bounded LRU of session headers, keyed by id and guarded by the log's identity. */
class HeaderCache {
  /** Insertion order is recency: `get` re-inserts, `set` trims from the front. */
  readonly entries = new Map<string, CachedHeader>()
  bytes = 0
  constructor(readonly limit = HEADER_CACHE_LIMIT, readonly budget = HEADER_CACHE_BUDGET) {}
  get(id: string): CachedHeader | undefined {
    const entry = this.entries.get(id)
    if (entry === undefined) return undefined
    this.entries.delete(id)
    this.entries.set(id, entry)
    return entry
  }
  set(entry: CachedHeader): void {
    this.delete(entry.id)
    if (entry.bytes > this.budget) return
    this.entries.set(entry.id, entry)
    this.bytes += entry.bytes
    while (this.entries.size > this.limit || this.bytes > this.budget) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.delete(oldest)
    }
  }
  delete(id: string): void {
    const entry = this.entries.get(id)
    if (entry === undefined) return
    this.entries.delete(id)
    this.bytes = Math.max(0, this.bytes - entry.bytes)
  }
}

/** The identity of one log file, or undefined when it cannot be read. */
function logIdentity(path: string): string | undefined {
  try {
    const s = statSync(path, { bigint: true })
    return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`
  } catch { return undefined }
}

/** A snapshot the caller can treat as its own, as the stock backend returns one. */
function copySnapshot(snapshot: any): any {
  const copy: any = { ...snapshot, header: { ...snapshot.header } }
  if (snapshot.location) copy.location = { ...snapshot.location }
  return copy
}

/** A storage key: the project UUID, or the 64-hex key of an owner recorded before project UUIDs. */
const OWNER_KEY = /^(?:[a-f0-9]{64}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/
/** A damaged routing index must not silently turn project sessions normal. */
function readRoutes(path: string): Routes {
  const routes = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { version: 1, sessions: {} }
  if (routes?.version !== 1 || !routes.sessions || typeof routes.sessions !== 'object' || Array.isArray(routes.sessions)) throw new Error('Invalid LayerFS session ownership index')
  for (const owner of Object.values(routes.sessions) as any[]) {
    if (!owner || !OWNER_KEY.test(owner.key) || typeof owner.project !== 'string' || !/^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/.test(owner.project)) throw new Error('Invalid LayerFS session owner identity')
  }
  return routes
}

const pause = new Int32Array(new SharedArrayBuffer(4))
/**
 * Hold an exclusive lock file while `run` executes. Short synchronous critical
 * sections only (read, change one entry, rename). A lock left by a crashed
 * process is broken after `staleMs`.
 */
export function withFileLock<T>(lock: string, run: () => T, { timeoutMs = 10_000, staleMs = 30_000 } = {}): T {
  mkdirSync(dirname(lock), { recursive: true })
  const deadline = Date.now() + timeoutMs
  let fd: number | undefined
  while (fd === undefined) {
    try { fd = openSync(lock, 'wx', 0o600) } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error
      try { if (Date.now() - statSync(lock).mtimeMs > staleMs) { unlinkSync(lock); continue } } catch { continue }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${lock}`)
      Atomics.wait(pause, 0, 0, 10)
    }
  }
  try { return run() } finally {
    closeSync(fd)
    try { unlinkSync(lock) } catch { /* already broken as stale */ }
  }
}

/** A stable facade keeps lifecycle-owned handles valid after an empty session
 * receives its explicit owner. The underlying stock backend retains live routing. */
class RoutedHandle {
  constructor(public current: any) {}
  get id() { return this.current.id }
  get header() { return this.current.header }
  get access() { return this.current.access }
  get inheritedEventCount() { return this.current.inheritedEventCount }
  read(...args: any[]) { return this.current.read(...args) }
  append(...args: any[]) { return this.current.append(...args) }
  flush(...args: any[]) { return this.current.flush(...args) }
  close() { return this.current.close() }
  [Symbol.asyncDispose]() { return this.close() }
}

/** What a loaded session writes to after its log was deleted: nothing. DSH
 * keeps the (archived, stopped) session in memory until it unloads it. */
function deletedHandle(previous: any): any {
  const header = previous.header
  const access = previous.access
  return {
    id: previous.id, header, access, inheritedEventCount: previous.inheritedEventCount,
    read: async () => ({ events: [] }),
    append: async () => {},
    flush: async () => {},
    close: async () => {},
  }
}

export class LayerfsSessionPersistence extends (SessionPersistence as any) {
  private readonly backends = new Map<string, Promise<any>>()
  private catalogInstance?: { root: string, catalog: ProjectCatalog }
  private readonly handles = new Map<string, RoutedHandle>()
  private readonly migrations = new Map<string, Promise<void>>()
  private routes?: Routes
  private routesPath?: string
  private routesSignature?: string
  private readonly stock: any
  private headerCache?: HeaderCache
  /**
   * Parsed sidecars kept for the trajectory's frequent reads, by file path and
   * identity. A long project session's `layerfs.json` carries tens of thousands
   * of receipts (tens of MB), so re-parsing it on every event would dominate the
   * Trajectory tab. The identity is the same one the header cache trusts
   * (`logIdentity`): a rewrite replaces the inode, so a hit is a fresh read.
   * Bounded by count and source bytes.
   */
  private readonly sidecars = new Map<string, { key: string, bytes: number, value: SessionSidecar | undefined }>()
  private sidecarBytes = 0
  /** Non-importing facade for the archive store; routes to the owner's backend. */
  readonly local: any

  constructor(ctx: Context, stock: any) {
    super(ctx)
    this.stock = stock
    this.local = {
      create: (header: any, options?: any) => this.create(header, options),
      open: (id: string, access: any, options?: any) => this.openLocal(id, access, options),
      stat: (id: string, options?: any) => this.statLocal(id, options),
      list: (options?: any) => this.list(options),
      flush: () => this.flush(),
    }
  }

  private get headers(): HeaderCache { return (this.headerCache ??= new HeaderCache()) }
  /** Drop one session's cached header after its log or its route changed. */
  private invalidateHeader(id: string): void { this.headerCache?.delete(String(id)) }

  private get service(): any { return (this as any).ctx.get('layerfs') }
  private get sessions(): any { return (this as any).ctx.get('layerfsSessions') }
  private get store(): any { return this.sessions?.store }
  get projectHome(): string { return this.service?.projectSessionHome ?? process.env.DSH_LAYERFS_SESSION_HOME ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'layerfs', 'project-sessions') }
  /**
   * `owners.json` is shared by every DSH using this project-session home (it can
   * be configured to one per user, not per DSH home). Reads reload it when
   * another process replaced it; writes change one entry under a lock against
   * the file's current contents, so concurrent writers never drop each other's routes.
   */
  private get owners(): Routes {
    const path = join(this.projectHome, 'owners.json')
    const signature = signatureOf(path)
    if (!this.routes || this.routesPath !== path || this.routesSignature !== signature) {
      this.routes = readRoutes(path)
      this.routesPath = path
      this.routesSignature = signature
    }
    return this.routes!
  }
  /** Set (or with `undefined`, remove) one session's owner route. */
  private setOwner(id: string, owner: Owner | undefined): void {
    // A route change can point the id at another backend with its own log.
    this.invalidateHeader(id)
    const path = join(this.projectHome, 'owners.json')
    withFileLock(`${path}.lock`, () => {
      const routes = readRoutes(path)
      if (owner) routes.sessions[id] = owner
      else delete routes.sessions[id]
      atomicJson(path, routes)
      this.routes = routes
      this.routesPath = path
      this.routesSignature = signatureOf(path)
    })
    this.invalidateHeader(id)
  }
  /** Ownership is local durable metadata, readable without reaching LayerFS. */
  ownerOf(id: string): { project: string } | undefined {
    if (!this.stock || !this.service) return undefined
    const owner = this.owners.sessions[id]
    return owner ? { project: owner.project } : undefined
  }
  /** The Store ID recorded with a conversation's owner, when its identity is known. */
  storeIdOf(id: string): string | undefined { return this.owners.sessions[id]?.identity?.storeId }
  ownedSessionIds(project?: string, projectId?: string): string[] {
    if (!this.stock || !this.service) return []
    return Object.entries(this.owners.sessions).filter(([, owner]) => (!project || owner.project === project) && (!projectId || (owner.identity?.id ?? owner.key) === projectId)).map(([id]) => id)
  }
  get catalog(): ProjectCatalog {
    if (this.catalogInstance?.root !== this.projectHome) this.catalogInstance = { root: this.projectHome, catalog: new ProjectCatalog(() => this.service.lfs, this.projectHome) }
    return this.catalogInstance.catalog
  }
  projectIdOf(id: string): string | undefined {
    const owner = this.owners.sessions[id]
    return owner?.identity?.id ?? owner?.key
  }
  /** Reading local logs requires no Store. Execution and archive writes must
   * freshly find the owner's project UUID at its address, including on an
   * already mounted session; a missing or different UUID blocks them. */
  async assertSessionIdentity(id: string): Promise<CatalogProject | undefined> {
    const owner = this.owners.sessions[id]
    if (!owner) return undefined
    const expected = owner.identity?.id ?? owner.key
    const row = await this.catalog.resolve(owner.project, { claim: false }).catch((error: any) => {
      if (error?.code === 'ProjectIdentityChanged') throw new CliError('ProjectIdentityChanged', 'The project identity changed. Conversation history was retained and execution is blocked.')
      throw error
    })
    if (row.projectId !== expected) throw new CliError('ProjectIdentityChanged', 'The project identity changed. Conversation history was retained and execution is blocked.')
    return row
  }
  async catalogProjects(): Promise<CatalogProject[]> {
    const rows = await this.catalog.list()
    // Owners whose project is not listed live keep a row, so their histories stay reachable.
    for (const owner of Object.values(this.owners.sessions)) {
      const id = owner.identity?.id ?? owner.key
      if (rows.some((row) => row.projectId === id)) continue
      const [store, name] = owner.project.split('/')
      const row: CatalogProject = { projectId: id, identity: owner.identity, key: owner.project, name, store, kind: null, machine: null,
        created: owner.identity?.created ?? null, lastSeen: 0, catalogState: 'unavailable', catalogError: 'The original project identity cannot currently be verified.', storeState: null }
      this.catalog.remember(row)
      rows.push(row)
    }
    return rows
  }
  private async backend(owner: Owner): Promise<any> {
    let pending = this.backends.get(owner.key)
    if (!pending) {
      pending = (async () => {
        const inner = (this as any).ctx.isolate('sessionPersistence')
        await inner.plugin(jsonl as any, { root: join(this.projectHome, 'projects', owner.key, 'sessions'), compression: 'none' }).await()
        return inner.get('sessionPersistence')
      })()
      this.backends.set(owner.key, pending)
      pending.catch(() => this.backends.delete(owner.key))
    }
    return pending
  }
  async projectBackend(project: string): Promise<any> { const row = await this.catalog.resolve(project); return this.backend({ project, key: row.projectId, identity: row.identity }) }
  private async target(id: string, header?: any): Promise<any> {
    // Prototype-based unit fakes predate routing and intentionally use local only.
    if (!this.stock) return this.local
    if (!this.service) return this.stock
    const owner = this.owners.sessions[id]
    if (owner) return this.backend(owner)
    const state = this.sessions?.state.read()
    const project = state?.sessions[id]?.project ?? state?.pending[id]?.project ?? (header?.parentSession ? this.owners.sessions[header.parentSession]?.project : undefined)
    if (project) {
      // Legacy bindings can coexist with a stock log. Do not publish a new
      // route until migrateProject has copied and validated that history.
      if (await this.stock.stat(id)) return this.stock
      const row = await this.catalog.resolve(project)
      const next = { project, key: row.projectId, identity: row.identity }
      this.setOwner(id, next)
      return this.backend(next)
    }
    return this.stock
  }
  private wrap(handle: any): any {
    if (!this.stock) return handle
    const wrapped = new RoutedHandle(handle)
    if (handle.access === 'write') {
      const id = String(handle.id)
      // Delegate through the facade: a migration swaps `current` under it.
      const write = (name: 'append' | 'flush'): any => {
        const inner = (wrapped as any)[name].bind(wrapped)
        return (...args: any[]) => { this.invalidateHeader(id); return inner(...args) }
      }
      wrapped.append = write('append')
      wrapped.flush = write('flush')
      this.handles.set(id, wrapped)
      const close = wrapped.close.bind(wrapped)
      wrapped.close = () => {
        this.invalidateHeader(id)
        if (this.handles.get(id) === wrapped) this.handles.delete(id)
        return close()
      }
    }
    return wrapped
  }

  private readDeleted(): Deleted {
    const path = join(this.projectHome, 'deleted.json')
    try {
      const value = JSON.parse(readFileSync(path, 'utf8'))
      if (value?.version === 1 && value.sessions && typeof value.sessions === 'object' && !Array.isArray(value.sessions)) return value
    } catch {}
    return { version: 1, sessions: {} }
  }
  /** Whether this conversation was deleted here (a Presets Reset). Only an explicit import brings it back. */
  isDeleted(id: string): boolean { return !!this.readDeleted().sessions[id] }
  /** An explicit import of a deleted conversation lifts its deletion record. */
  undelete(id: string): void {
    if (!this.isDeleted(id)) return
    const path = join(this.projectHome, 'deleted.json')
    withFileLock(`${path}.lock`, () => { const value = this.readDeleted(); delete value.sessions[id]; atomicJson(path, value) })
  }
  /**
   * Delete owner-routed project conversations: the unpacked log folder (with
   * its `layerfs.json` sidecar) and the owner route, plus a deletion record so
   * store sync and open-by-id never import them back implicitly. A loaded
   * session's writer is retired first; later writes go nowhere. Logs outside
   * this project-session home (stock or legacy) are never touched.
   * @returns the ids whose route or log was removed.
   */
  async deleteSessions(ids: readonly string[]): Promise<string[]> {
    if (!this.stock || !this.service) return []
    const removed: string[] = []
    const records: Deleted['sessions'] = {}
    for (const id of ids) {
      const owner = this.owners.sessions[id]
      this.invalidateHeader(id)
      if (!owner) continue
      records[id] = { project: owner.project, at: Date.now() }
      const writer = this.handles.get(id)
      if (writer) {
        this.handles.delete(id)
        const previous = writer.current
        writer.current = deletedHandle(previous)
        await previous.close().catch(() => {})
      }
      const backend = await this.backend(owner)
      await backend.flush().catch(() => {})
      const snapshot = await backend.stat(id).catch(() => undefined)
      const root = join(this.projectHome, 'projects', owner.key, 'sessions')
      const dir = snapshot?.location?.path ? dirname(snapshot.location.path) : undefined
      const inside = dir ? relative(root, dir) : ''
      if (dir && inside && !inside.startsWith('..') && !inside.startsWith(sep)) {
        this.forgetSidecar(join(dir, 'layerfs.json'))
        rmSync(dir, { recursive: true, force: true })
      }
      this.setOwner(id, undefined)
      this.invalidateHeader(id)
      removed.push(id)
    }
    if (Object.keys(records).length) {
      const path = join(this.projectHome, 'deleted.json')
      withFileLock(`${path}.lock`, () => { const value = this.readDeleted(); Object.assign(value.sessions, records); atomicJson(path, value) })
    }
    return removed
  }

  /** Move a session only when its owner changes before work starts, or as an
   * explicit legacy migration. Copy and validate first; retain source as backup. */
  async migrateProject(session: any, project: string | null): Promise<void> {
    const id = typeof session === 'string' ? session : String(session.id)
    const previous = this.migrations.get(id) ?? Promise.resolve()
    const run = previous.then(() => this.migrateNow(id, project))
    this.migrations.set(id, run)
    this.invalidateHeader(id)
    try { await run } finally {
      if (this.migrations.get(id) === run) this.migrations.delete(id)
      this.invalidateHeader(id)
    }
  }
  private async migrateNow(id: string, project: string | null): Promise<void> {
    const oldOwner = this.owners.sessions[id]
    const row = project ? await this.catalog.resolve(project) : undefined
    if (oldOwner && row && oldOwner.project === project) await this.assertSessionIdentity(id)
    const newOwner: Owner | undefined = row ? { project: project!, key: oldOwner?.project === project ? oldOwner.key : row.projectId, identity: row.identity } : undefined
    const source = oldOwner ? await this.backend(oldOwner) : this.stock
    const destination = newOwner ? await this.backend(newOwner) : this.stock
    if (source === destination) return
    const writer = this.handles.get(id)
    await source.flush()
    const sourceStat = await source.stat(id)
    if (!sourceStat) {
      this.setOwner(id, newOwner)
      return
    }
    const reader = await source.open(id, 'read')
    let events: any[], inheritedEventCount: number
    try { events = (await reader.read()).events; inheritedEventCount = reader.inheritedEventCount } finally { await reader.close() }
    let target = await destination.stat(id)
    if (target) {
      const existing = await destination.open(id, 'read')
      try {
        if (JSON.stringify(existing.header) !== JSON.stringify(sourceStat.header) || JSON.stringify((await existing.read()).events) !== JSON.stringify(events) || existing.inheritedEventCount !== inheritedEventCount) throw new Error(`Session ${id} has divergent histories; ownership was not changed`)
      } finally { await existing.close() }
    } else {
      const created = await destination.create(sourceStat.header, inheritedEventCount! ? { inheritedEventCount: inheritedEventCount! } : undefined)
      try { if (events!.length) await created.append(events!); await created.flush() } finally { await created.close() }
      target = await destination.stat(id)
      const verify = await destination.open(id, 'read')
      try { if (JSON.stringify((await verify.read()).events) !== JSON.stringify(events)) throw new Error(`Session ${id} migration validation failed`) } finally { await verify.close() }
    }
    // Closing drains the live writer's buffer into the source before the new
    // route is published. Events appended after the copy above (a turn that
    // started while the owner was being chosen) are carried over, never left
    // behind in the retained source.
    if (writer) await writer.current.close()
    let migratedWriter: any
    try {
      if (writer) {
        const after = await source.open(id, 'read')
        let drained: any[]
        try { drained = (await after.read()).events } finally { await after.close() }
        if (drained.length > events!.length) {
          if (JSON.stringify(drained.slice(0, events!.length)) !== JSON.stringify(events)) throw new Error(`Session ${id} changed during migration; ownership was not changed`)
          const tail = await destination.open(id, 'write')
          try { await tail.append(drained.slice(events!.length)); await tail.flush() } finally { await tail.close() }
        }
        migratedWriter = await destination.open(id, 'write')
      }
      this.setOwner(id, newOwner)
    } catch (error) {
      await migratedWriter?.close()
      if (writer) writer.current = await source.open(id, 'write')
      throw error
    }
    if (writer) writer.current = migratedWriter
    if (sourceStat.location?.path) {
      const sourceDir = dirname(sourceStat.location.path)
      const sourceSidecar = join(sourceDir, 'layerfs.json')
      if (target?.location?.path) this.forgetSidecar(join(dirname(target.location.path), 'layerfs.json'))
      if (target?.location?.path && existsSync(sourceSidecar)) {
        const sidecar = JSON.parse(readFileSync(sourceSidecar, 'utf8'))
        atomicJson(join(dirname(target.location.path), 'layerfs.json'), { ...sidecar, ...(project ? { project } : {}) })
      }
      this.forgetSidecar(sourceSidecar)
      const backup = join(this.projectHome, 'migration-backups', randomUUID())
      mkdirSync(dirname(backup), { recursive: true })
      try { renameSync(sourceDir, backup) } catch (error: any) {
        // The source may be on another volume. Preserve it as inert recovery
        // evidence if it cannot be moved; the committed owner route controls
        // all future reads/writes and normal listing excludes this copy.
        try { cpSync(sourceDir, backup, { recursive: true, errorOnExist: true, force: false }) } catch {}
        ;(this as any).ctx.logger('layerfs').warn('session %s moved; original migration source retained at %s: %s', id, sourceDir, error?.message ?? error)
      }
    }
    if (project) await this.updateSidecar(id, () => {})
  }

  async create(header: any, options?: any) {
    const id = String(header.id)
    this.invalidateHeader(id)
    try { return this.wrap(await (await this.target(id, header)).create(header, options)) } finally { this.invalidateHeader(id) }
  }
  async flush() {
    if (!this.stock) return this.local.flush()
    await this.stock.flush()
    for (const backend of this.backends.values()) await (await backend).flush()
  }
  async list(options?: any) {
    if (!this.stock) return this.local.list(options)
    if (!this.service) return this.stock.list(options)
    const all = new Map<string, any>()
    for (const snapshot of await this.stock.list(options)) if (!this.owners.sessions[snapshot.header.id]) all.set(snapshot.header.id, snapshot)
    for (const owner of new Map(Object.values(this.owners.sessions).map((owner) => [owner.key, owner])).values()) {
      for (const snapshot of await (await this.backend(owner)).list(options)) {
        if (this.owners.sessions[snapshot.header.id]?.key === owner.key) all.set(snapshot.header.id, snapshot)
      }
    }
    return [...all.values()]
  }
  private async statLocal(id: string, options?: any) {
    const backend = await this.target(id)
    const cache = this.headers
    const cached = cache.get(id)
    if (cached && cached.backend === backend && cached.snapshot.formatStatus !== 'migration-required') {
      options?.signal?.throwIfAborted()
      // One metadata read is the whole freshness check: this backend only appends
      // to a log, and the header is its first line. A rewrite replaces the inode or
      // bumps size/mtime (the stock revision names exactly these fields), so an
      // unchanged identity means an unchanged header.
      if (logIdentity(cached.path) === cached.identity) return copySnapshot(cached.snapshot)
      cache.delete(id)
    }
    const snapshot = await backend.stat(id, options)
    const path = snapshot?.location?.path
    // A versioned (historical) header's revision also covers the historical
    // corpus, which can move without this file changing: keep re-reading it.
    if (path && snapshot.formatStatus !== 'migration-required') {
      const identity = logIdentity(path)
      // The cache keeps its own copy: the caller owns the snapshot it was handed.
      if (identity !== undefined) cache.set({ id, backend, snapshot: copySnapshot(snapshot), path, identity, bytes: path.length + JSON.stringify(snapshot.header).length + 128 })
    }
    return snapshot
  }
  private async openLocal(id: string, access: any, options?: any) { return this.wrap(await (await this.target(id)).open(id, access, options)) }
  private async restore(id: string): Promise<boolean> {
    if (!this.store || (this.stock && this.service && this.isDeleted(id))) return false
    try {
      const project = await this.store.locate(id)
      return !!project && (await this.store.import(project, id)).imported
    } catch (error: any) {
      ;(this as any).ctx.logger('layerfs').warn('session %s: import from LayerFS failed: %s', id, error?.message ?? error)
      return false
    }
  }
  async stat(id: any, options?: any) {
    const snapshot = await this.statLocal(String(id), options)
    if (snapshot || !(await this.restore(String(id)))) return snapshot
    return this.statLocal(String(id), options)
  }
  async open(id: any, access: any, options?: any) {
    try { return await this.openLocal(String(id), access, options) } catch (error: any) {
      if (!(error instanceof SessionPersistenceNotFoundError) || !(await this.restore(String(id)))) throw error
      return this.openLocal(String(id), access, options)
    }
  }
  private async sidecarPath(id: string): Promise<string> {
    let snapshot = await this.statLocal(id)
    if (snapshot && !snapshot.location?.path) {
      await (await this.target(id)).flush()
      snapshot = await this.statLocal(id)
    }
    if (!snapshot?.location?.path) throw new Error(`Session ${id} has no durable log for LayerFS metadata`)
    return join(dirname(snapshot.location.path), 'layerfs.json')
  }
  /** The sidecar file's identity (as {@link logIdentity}) and its size in bytes. */
  private sidecarIdentity(path: string): { key: string, bytes: number } | undefined {
    try {
      const s = statSync(path, { bigint: true })
      return { key: `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`, bytes: Number(s.size) }
    } catch { return undefined }
  }
  private forgetSidecar(path: string): void {
    const kept = this.sidecars.get(path)
    if (!kept) return
    this.sidecars.delete(path)
    this.sidecarBytes -= kept.bytes
  }
  private rememberSidecar(path: string, key: string, bytes: number, value: SessionSidecar | undefined): void {
    this.forgetSidecar(path)
    this.sidecars.set(path, { key, bytes, value })
    this.sidecarBytes += bytes
    while (this.sidecars.size > 8 || (this.sidecarBytes > 64 * 1024 * 1024 && this.sidecars.size > 1)) {
      const oldest = this.sidecars.keys().next().value as string
      this.forgetSidecar(oldest)
    }
  }
  /**
   * The session's `layerfs.json`. `cached` keeps the parsed value while the
   * file's identity holds: the Trajectory tab rereads on every event, and a
   * long session's receipts are far too big to parse each time. The value is
   * shared, so a cached caller must not mutate it.
   */
  async readSidecar(id: string, options: { cached?: boolean } = {}): Promise<SessionSidecar | undefined> {
    const path = await this.sidecarPath(id)
    if (!options.cached) return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined
    const identity = this.sidecarIdentity(path)
    const kept = this.sidecars.get(path)
    if (identity && kept?.key === identity.key) {
      // Keep it hot for the next read.
      this.sidecars.delete(path)
      this.sidecars.set(path, kept)
      return kept.value
    }
    const value = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined
    if (identity) this.rememberSidecar(path, identity.key, identity.bytes, value)
    return value
  }
  async updateSidecar(id: string, fn: (sidecar: SessionSidecar) => void): Promise<void> {
    const path = await this.sidecarPath(id)
    const project = this.owners.sessions[id]?.project
    if (!project) return
    // Mutations below are synchronous after resolving the path, keeping concurrent
    // appenders from reading a stale sidecar and dropping one another's records.
    const value: SessionSidecar = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { version: 1, sessionId: id, project, invocations: [] }
    fn(value)
    // Imported sidecars cannot override the verified destination identity.
    value.projectId = this.projectIdOf(id)
    value.projectIdentity = this.owners.sessions[id]?.identity
    atomicJson(path, value)
    // A cached trajectory read sees the value just written; the new file
    // identity also makes any other cache entry stale on its own.
    if (this.sidecars.has(path)) {
      const identity = this.sidecarIdentity(path)
      if (identity) this.rememberSidecar(path, identity.key, identity.bytes, value)
      else this.forgetSidecar(path)
    }
  }
  async recordInvocation(invocation: any): Promise<void> {
    await this.updateSidecar(String(invocation.sessionId), (sidecar) => {
      sidecar.invocations ??= []
      const index = sidecar.invocations.findIndex((item: any) => item.id === invocation.id)
      if (index < 0) sidecar.invocations.push(invocation)
      else sidecar.invocations[index] = invocation
    })
  }
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const inner = ctx.isolate('sessionPersistence')
  await inner.plugin(jsonl as any, config).await()
  const local = inner.get('sessionPersistence' as never)
  if (!local) throw new Error('dsh-layerfs: the inner JSONL session persistence did not start')
  await ctx.plugin({ name: 'dsh-layerfs-session-persistence-service', apply(serviceCtx: Context) { new LayerfsSessionPersistence(serviceCtx, local) } }).await()
  ctx.logger('layerfs').info('session persistence: stock JSONL at %s; project conversations use owner-routed unpacked JSONL', config.root)
}
