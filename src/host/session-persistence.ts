/** Owner-routed persistence. Every conversation uses the unmodified DSH JSONL
 * backend; project logs use a separate, unpacked root and an additive sidecar. */
import type { Context } from '@deepseek-ai/cordis'
import * as jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionPersistence, SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import { randomUUID } from 'node:crypto'
import { closeSync, cpSync, existsSync, fsyncSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { homedir } from 'node:os'
import { ProjectCatalog, type ProjectIdentity, type CatalogProject } from './sessions/catalog.ts'
import { CliError } from './layerfs/cli.ts'
import {
  compactInvocations, foldRead, RECEIPT_CAP, RECEIPT_META, receiptDisposition, readOnlyOperation, setReceiptAggregate, withReceiptMeta,
  type Invocation, type ReceiptMeta,
} from './layerfs/tracing.ts'

export const name = 'dsh-layerfs-session-persistence'
export type Config = jsonl.Config
export const Config = jsonl.Config

type Owner = { project: string, key: string, identity?: ProjectIdentity }
type Routes = { version: 1, sessions: Record<string, Owner> }
/** Conversations deleted on purpose: never imported back implicitly. */
type Deleted = { version: 1, sessions: Record<string, { project: string, at: number }> }

/**
 * Receipts live beside their session's `layerfs.json`, one JSON object per
 * line, so a metadata read never parses a long session's history:
 *
 * - `layerfs.json` keeps annotations only (`version`, `sessionId`, `project`,
 *   `title`, `checkpoints`, `archive`, `bindingKind`, `codeBranch`, ...).
 * - `receipts.jsonl` keeps `invocations`, append-only. A write is one
 *   `writeSync` on a descriptor opened `a+` (`O_APPEND`) and no fsync per line:
 *   the tool call already ran and its tagged call-log line rebuilds the receipt
 *   (see tracing.ts), so a crash losing the unsynced tail does not lose a call.
 *   Migration and compaction fsync because they move data.
 *
 * A legacy sidecar with `invocations` inside is still read, and is migrated to
 * this layout on its first write. Migration writes and fsyncs the receipts
 * file first, then rewrites the metadata, keeping the original as `.bak`; a
 * crash in between leaves the old combined file authoritative, so a retry
 * reproduces the same receipts and never loses one.
 *
 * The byte budget bounds an outlier session (83k receipts is ~55 MB). When the
 * file would exceed it, compaction keeps the newest complete lines and puts a
 * marker at the top recording how many older receipts were dropped.
 */
const RECEIPTS_FILE = 'receipts.jsonl'
/** Receipts bytes retained per session; past this the oldest lines are dropped. */
const RECEIPT_BYTE_BUDGET = 32 * 1024 * 1024
/** First line of a compacted receipts file; it is not a receipt. */
const RECEIPTS_MARKER = '$layerfsReceipts'
/** Parsed receipts files kept hot: the trajectory rereads one session. */
const RECEIPT_CACHE_ENTRIES = 8
const RECEIPT_CACHE_BYTES = 64 * 1024 * 1024

/** A page of a session's retained receipts, oldest first unless `from` is negative. */
export interface ReceiptPage {
  /** The receipts in the requested window. Rows are shared cached objects: read, do not mutate. */
  invocations: any[]
  /** Retained receipts after id de-duplication. */
  total: number
  /** Index of the first returned receipt in retained order. */
  from: number
  /** Older receipts were dropped by the byte budget, or this page is not the whole set. */
  truncated: boolean
  /** Receipts permanently dropped by the byte budget (from the compaction marker). */
  dropped: number
  /** Unparseable lines skipped (a crashed final line is one). */
  skipped: number
  /** Bytes read from the receipts file when this page was loaded (0 on a cache hit). */
  bytes: number
}

/** One parsed receipts file, before paging. */
interface ReceiptLoad { receipts: any[], dropped: number, skipped: number, bytes: number }

/** The receipts sibling of a sidecar path. */
function receiptsPathOf(sidecar: string): string { return join(dirname(sidecar), RECEIPTS_FILE) }

/** Device, inode, size and nanosecond times: an append or replacement changes it. */
function fileIdentity(path: string): { key: string, bytes: number } | undefined {
  try {
    const s = statSync(path, { bigint: true })
    return { key: `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`, bytes: Number(s.size) }
  } catch { return undefined }
}

/** Write a whole file durably, then rename it into place (atomic replacement). */
function atomicBytes(path: string, data: Buffer | string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${randomUUID()}.tmp`
  const fd = openSync(tmp, 'w', 0o600)
  try { writeSync(fd, typeof data === 'string' ? Buffer.from(data) : data); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(tmp, path)
}

/** Receipts merged by id: the first occurrence keeps its place, the last value wins. */
function dedupeReceipts(rows: readonly any[]): any[] {
  const out: any[] = []
  const byId = new Map<string, number>()
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    if (typeof row.id === 'string') {
      const at = byId.get(row.id)
      if (at !== undefined) { out[at] = row; continue }
      byId.set(row.id, out.length)
    }
    out.push(row)
  }
  return out
}

/** Parse one receipts file. A partial or corrupt line is skipped, never fatal. */
function receiptLoadOf(buffer: Buffer): ReceiptLoad {
  const receipts: any[] = []
  const byId = new Map<string, number>()
  let dropped = 0, skipped = 0
  for (const line of buffer.toString('utf8').split('\n')) {
    if (!line) continue
    let row: any
    try { row = JSON.parse(line) } catch { skipped++; continue }
    if (row && typeof row === 'object' && !Array.isArray(row) && row[RECEIPTS_MARKER]) {
      const count = Number(row[RECEIPTS_MARKER]?.dropped)
      if (Number.isFinite(count) && count > 0) dropped = Math.max(dropped, count)
      continue
    }
    if (!row || typeof row !== 'object' || Array.isArray(row)) { skipped++; continue }
    if (typeof row.id === 'string') {
      const at = byId.get(row.id)
      if (at !== undefined) { receipts[at] = row; continue }
      byId.set(row.id, receipts.length)
    }
    receipts.push(row)
  }
  return { receipts, dropped, skipped, bytes: buffer.byteLength }
}

/** Page a parsed file. A negative `from` counts back from the newest receipt. */
function pageOf(load: ReceiptLoad, from?: number, limit?: number): ReceiptPage {
  const total = load.receipts.length
  let start = from === undefined || !Number.isFinite(from) ? 0 : Math.trunc(from)
  if (start < 0) start = Math.max(0, total + start)
  start = Math.min(Math.max(0, start), total)
  const count = limit === undefined || !Number.isFinite(limit) ? total - start : Math.max(0, Math.trunc(limit))
  const invocations = load.receipts.slice(start, start + count)
  return { invocations, total, from: start, truncated: load.dropped > 0 || start > 0 || start + invocations.length < total, dropped: load.dropped, skipped: load.skipped, bytes: load.bytes }
}

/** The value a caller sees. `invocations` is lazy when receipts live beside the
 * file: it is empty-cost until read, and is not part of the on-disk metadata. */
export interface SessionSidecar {
  version: 1
  sessionId: string
  project: string
  invocations: any[]
  /** The read-only receipt counter (see `layerfs/tracing.ts`); absent before the first fold. */
  receipts?: ReceiptMeta
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
/** How long a proven-missing session log is remembered (a pending session gains one on its first turn). */
const MISSING_TTL_MS = 2_000
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
  private readonly sidecars = new Map<string, { id: string, key: string, bytes: number, meta: any, legacy?: any[], value: SessionSidecar }>()
  /** Session id -> its sidecar path, so a write can drop exactly that entry. */
  private readonly sidecarPaths = new Map<string, string>()
  private sidecarBytes = 0
  /** Parsed receipts files, kept apart from metadata so one never pays for the other. */
  private receiptCache?: { entries: Map<string, { key: string, load: ReceiptLoad }>, bytes: number }
  private get receiptsCache(): { entries: Map<string, { key: string, load: ReceiptLoad }>, bytes: number } {
    return (this.receiptCache ??= { entries: new Map(), bytes: 0 })
  }
  /** Tests may lower the cap; production uses {@link RECEIPT_BYTE_BUDGET}. */
  private receiptBudget?: number
  private get receiptBudgetBytes(): number { return this.receiptBudget ?? RECEIPT_BYTE_BUDGET }
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
  /** id -> epoch ms a `stat` may answer "no log" without asking the backend again (lazy: tests build the object without field initializers). */
  private missingCache?: Map<string, number>
  private get missing(): Map<string, number> { return (this.missingCache ??= new Map<string, number>()) }
  /** Drop one session's cached header after its log or its route changed. */
  private invalidateHeader(id: string): void { this.headerCache?.delete(String(id)); this.missing.delete(String(id)) }

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
    this.invalidateSidecar(id)
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
    this.invalidateSidecar(id)
    this.invalidateDiscovery(undefined)
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
        return (...args: any[]) => { this.invalidateHeader(id); this.invalidateSidecar(id); return inner(...args) }
      }
      wrapped.append = write('append')
      wrapped.flush = write('flush')
      this.handles.set(id, wrapped)
      const close = wrapped.close.bind(wrapped)
      wrapped.close = () => {
        this.invalidateHeader(id)
        this.invalidateSidecar(id)
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
      this.invalidateSidecar(id)
      this.invalidateDiscovery(owner.project)
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
    this.invalidateSidecar(id)
    try { await run } finally {
      if (this.migrations.get(id) === run) this.migrations.delete(id)
      this.invalidateHeader(id)
      this.invalidateSidecar(id)
      // The conversation may have moved between projects: both stored lists changed.
      this.invalidateDiscovery(undefined)
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
      if (target?.location?.path && existsSync(sourceSidecar)) this.copySidecar(sourceSidecar, join(dirname(target.location.path), 'layerfs.json'), project)
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
  /** Carry a sidecar and its receipts to the session's new folder, receipts first. */
  private copySidecar(source: string, target: string, project: string | null): void {
    const raw = JSON.parse(readFileSync(source, 'utf8'))
    const legacy = Array.isArray(raw.invocations) ? raw.invocations : undefined
    const meta: any = { ...raw }
    delete meta.invocations
    if (project) meta.project = project
    const sourceReceipts = receiptsPathOf(source)
    if (legacy !== undefined) {
      const folded = compactInvocations(meta[RECEIPT_META], legacy)
      meta[RECEIPT_META] = folded.meta
      this.writeReceipts(target, folded.invocations)
    } else if (existsSync(sourceReceipts)) {
      // Receipts are durable beside the metadata before it names them; the
      // source folder is retained until the move finishes, so nothing is lost.
      atomicBytes(receiptsPathOf(target), readFileSync(sourceReceipts))
    }
    atomicJson(target, meta)
    this.forgetSidecar(target)
  }

  async create(header: any, options?: any) {
    const id = String(header.id)
    this.invalidateHeader(id)
    this.invalidateSidecar(id)
    try { return this.wrap(await (await this.target(id, header)).create(header, options)) } finally {
      this.invalidateHeader(id)
      this.invalidateSidecar(id)
      this.invalidateDiscovery(this.owners.sessions[id]?.project)
    }
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
    // A pending session has no log yet, and asking the stock backend for it scans
    // the project home (`findLog`): a 33-session project listed 22 of them, so
    // every list read cost 22 fruitless scans (~700 ms). Remember the miss for a
    // moment; create/append/flush and the writes below clear it at once.
    const missingUntil = this.missing.get(id)
    if (missingUntil !== undefined) {
      if (Date.now() < missingUntil) { options?.signal?.throwIfAborted(); return undefined }
      this.missing.delete(id)
    }
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
    if (!snapshot) this.missing.set(id, Date.now() + MISSING_TTL_MS)
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
  /**
   * A session's snapshot. A miss is imported from its LayerFS project unless
   * `options.restore === false`: listing must not import (a pending session has
   * no log yet, so a list of 33 sessions used to attempt 23 Store imports on
   * every read, ~600 ms). Opening the session imports it.
   */
  async stat(id: any, options?: any) {
    const snapshot = await this.statLocal(String(id), options)
    if (snapshot || options?.restore === false) return snapshot
    if (!(await this.restore(String(id)))) return snapshot
    // The import just wrote the log: forget the miss it was imported from.
    this.missing.delete(String(id))
    return this.statLocal(String(id), options)
  }
  async open(id: any, access: any, options?: any) {
    try { return await this.openLocal(String(id), access, options) } catch (error: any) {
      if (!(error instanceof SessionPersistenceNotFoundError) || !(await this.restore(String(id)))) throw error
      return this.openLocal(String(id), access, options)
    }
  }
  /** The sidecar path; `snapshot` is the log stat a caller already read (one stat per list, not two). */
  private async sidecarPath(id: string, snapshot?: any): Promise<string> {
    let current = snapshot ?? await this.statLocal(id)
    if (current && !current.location?.path) {
      await (await this.target(id)).flush()
      current = await this.statLocal(id)
    }
    if (!current?.location?.path) throw new Error(`Session ${id} has no durable log for LayerFS metadata`)
    return join(dirname(current.location.path), 'layerfs.json')
  }
  /** The sidecar file's identity (as {@link logIdentity}) and its size in bytes. */
  private sidecarIdentity(path: string): { key: string, bytes: number } | undefined { return fileIdentity(path) }
  /** Drop only the sidecar entry: its receipts file did not change with the metadata. */
  private forgetSidecarEntry(path: string): void {
    const kept = this.sidecars.get(path)
    if (!kept) return
    this.sidecars.delete(path)
    this.sidecarBytes -= kept.bytes
    if (this.sidecarPaths.get(kept.id) === path) this.sidecarPaths.delete(kept.id)
  }
  private forgetSidecar(path: string): void {
    this.forgetReceipts(receiptsPathOf(path))
    this.forgetSidecarEntry(path)
  }
  private forgetReceipts(path: string): void {
    const kept = this.receiptsCache.entries.get(path)
    if (!kept) return
    this.receiptsCache.entries.delete(path)
    this.receiptsCache.bytes -= kept.load.bytes
  }
  private rememberReceipts(path: string, key: string, load: ReceiptLoad): void {
    this.forgetReceipts(path)
    this.receiptsCache.entries.set(path, { key, load })
    this.receiptsCache.bytes += load.bytes
    while (this.receiptsCache.entries.size > RECEIPT_CACHE_ENTRIES || (this.receiptsCache.bytes > RECEIPT_CACHE_BYTES && this.receiptsCache.entries.size > 1)) {
      const oldest = this.receiptsCache.entries.keys().next().value
      if (oldest === undefined) break
      this.forgetReceipts(oldest)
    }
  }
  private rememberSidecar(path: string, id: string, key: string, bytes: number, meta: any, legacy?: any[]): void {
    // Replacing the metadata does not touch receipts.jsonl; keep its parsed cache.
    this.forgetSidecarEntry(path)
    this.sidecars.set(path, { id, key, bytes, meta, legacy, value: this.sidecarValue(path, meta, legacy) })
    this.sidecarPaths.set(id, path)
    this.sidecarBytes += bytes
    while (this.sidecars.size > 1024 || (this.sidecarBytes > 64 * 1024 * 1024 && this.sidecars.size > 1)) {
      const oldest = this.sidecars.keys().next().value as string
      this.forgetSidecar(oldest)
    }
  }
  /** Drop one session's cached sidecar after its file, its log or its route changed. */
  private invalidateSidecar(id: string): void {
    const path = this.sidecarPaths.get(id)
    if (path !== undefined) this.forgetSidecar(path)
    this.sidecarPaths.delete(id)
  }
  /** A local write changed what a project's stored-session list shows (save, import, delete). */
  private invalidateDiscovery(project: string | undefined): void {
    try { this.store?.invalidateDiscovery?.(project) } catch { /* the discovery memo is best effort */ }
  }
  /** Read one sidecar file; overridable so a test can count real file reads. */
  private readSidecarFile(path: string): SessionSidecar | undefined {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as SessionSidecar : undefined
  }
  /** Read one receipts file; overridable so a test can count real receipts reads. */
  private readReceiptsFile(path: string): Buffer | undefined {
    try { return readFileSync(path) } catch (error: any) {
      if (error?.code === 'ENOENT') return undefined
      throw error
    }
  }
  /** One parsed receipts file while its identity holds (an append moves size/mtime). */
  private receiptLoadAt(sidecarPath: string): ReceiptLoad | undefined {
    const path = receiptsPathOf(sidecarPath)
    const identity = fileIdentity(path)
    if (identity === undefined) { this.forgetReceipts(path); return undefined }
    const kept = this.receiptsCache.entries.get(path)
    if (kept?.key === identity.key) {
      // Keep it hot for the next read.
      this.receiptsCache.entries.delete(path)
      this.receiptsCache.entries.set(path, kept)
      return kept.load
    }
    const buffer = this.readReceiptsFile(path)
    if (buffer === undefined) { this.forgetReceipts(path); return undefined }
    const load = receiptLoadOf(buffer)
    this.rememberReceipts(path, identity.key, load)
    return load
  }
  /** Receipts for a sidecar: its sibling file, else a not-yet-migrated in-file array. */
  private receiptsFor(sidecarPath: string): ReceiptLoad {
    const kept = this.receiptLoadAt(sidecarPath)
    if (kept) return kept
    const sidecar = this.readSidecarFile(sidecarPath)
    if (sidecar && Array.isArray(sidecar.invocations)) return { receipts: dedupeReceipts(sidecar.invocations), dropped: 0, skipped: 0, bytes: 0 }
    return { receipts: [], dropped: 0, skipped: 0, bytes: 0 }
  }
  /** What a `cached: true` read shares: metadata plus a lazy receipts property. */
  private sidecarValue(path: string, meta: any, legacy?: any[]): SessionSidecar {
    const value: any = { ...meta }
    // The receipts array carries the counter (non-enumerably) for trajectory
    // inputs that hand over only the array; `value.receipts` is the same object.
    if (legacy !== undefined) value.invocations = withReceiptMeta(legacy, meta[RECEIPT_META])
    else Object.defineProperty(value, 'invocations', {
      enumerable: true, configurable: true,
      // Metadata consumers (sessions.list) never pay for this; receipt readers do.
      get: () => withReceiptMeta(this.receiptsFor(path).receipts, meta[RECEIPT_META]),
    })
    return value
  }
  /** What an ordinary read returns: metadata deep-copied, receipts copied on access. */
  private sidecarCopy(path: string, meta: any, legacy?: any[]): SessionSidecar {
    const copy: any = structuredClone(meta)
    if (legacy !== undefined) copy.invocations = withReceiptMeta(structuredClone(legacy), meta[RECEIPT_META])
    else {
      let memo: any[] | undefined
      Object.defineProperty(copy, 'invocations', {
        enumerable: true, configurable: true,
        get: () => (memo ??= withReceiptMeta(structuredClone(this.receiptsFor(path).receipts), meta[RECEIPT_META])),
      })
    }
    return copy
  }
  /**
   * The session's `layerfs.json`, kept while the file's identity holds. `cached`
   * shares the value (the Trajectory tab rereads on every event); every other
   * caller gets a copy, so it can keep or mutate it freely. A sidecar passed in
   * by a caller that has already stat'ed the log (`snapshot`) avoids that stat.
   * An absent sidecar is never cached, so one written later shows next read.
   *
   * A metadata read never opens `receipts.jsonl`: `invocations` is lazy. A caller
   * that touches it pays for the retained receipts (or the legacy in-file array
   * until the first write migrates it); paged readers use {@link readReceipts}.
   */
  async readSidecar(id: string, options: { cached?: boolean, snapshot?: any } = {}): Promise<SessionSidecar | undefined> {
    const path = await this.sidecarPath(id, options.snapshot)
    const identity = this.sidecarIdentity(path)
    if (identity === undefined) { this.invalidateSidecar(id); return undefined }
    const kept = this.sidecars.get(path)
    if (kept?.key === identity.key) {
      // Keep it hot for the next read.
      this.sidecars.delete(path)
      this.sidecars.set(path, kept)
      return options.cached ? kept.value : this.sidecarCopy(path, kept.meta, kept.legacy)
    }
    const value = this.readSidecarFile(path)
    if (value === undefined) { this.invalidateSidecar(id); return undefined }
    const legacy = Array.isArray(value.invocations) ? value.invocations : undefined
    const meta: any = { ...value }
    delete meta.invocations
    this.rememberSidecar(path, id, identity.key, identity.bytes, meta, legacy)
    const entry = this.sidecars.get(path)!
    return options.cached ? entry.value : this.sidecarCopy(path, entry.meta, entry.legacy)
  }
  /**
   * One session's receipts, paged: `from` indexes retained order, oldest first
   * (a negative value counts back from the newest, so `{ from: -50 }` is the
   * newest page), and `limit` bounds the result. The file is streamed from disk
   * once per identity; stale entries are never served after a write. A legacy
   * combined sidecar is read from its metadata until the first write migrates.
   */
  async readReceipts(id: string, options: { from?: number, limit?: number, snapshot?: any } = {}): Promise<ReceiptPage> {
    const path = await this.sidecarPath(id, options.snapshot)
    return pageOf(this.receiptsFor(path), options.from, options.limit)
  }
  /** The original combined sidecar, kept for recovery the one time it is rewritten. */
  private backupSidecar(path: string, text: string): void {
    const backup = `${path}.bak`
    if (existsSync(backup)) return
    atomicBytes(backup, text)
  }
  /** Write all receipts (migration, import merge and the count cap), atomically and durably. */
  private writeReceipts(sidecarPath: string, rows: readonly any[], dropped = 0): void {
    // Same marker B1's byte compaction writes: the cumulative count a reader
    // skips and reports as `dropped`/`truncated`.
    let text = dropped > 0 ? `${JSON.stringify({ [RECEIPTS_MARKER]: { version: 1, truncated: true, dropped, at: Date.now() } })}\n` : ''
    for (const row of rows) text += `${JSON.stringify(row)}\n`
    const path = receiptsPathOf(sidecarPath)
    atomicBytes(path, text)
    // The rows are already in memory: seed the parsed cache instead of making
    // the next trajectory read parse them back off disk.
    const identity = fileIdentity(path)
    if (identity) this.rememberReceipts(path, identity.key, { receipts: dedupeReceipts(rows), dropped, skipped: 0, bytes: identity.bytes })
    else this.forgetReceipts(path)
  }
  /** Receipts kept per session; overridable so a test can use a small cap. */
  private receiptCap?: number
  private get receiptLimit(): number { return this.receiptCap ?? RECEIPT_CAP }
  /**
   * The per-session cap: keep the newest {@link receiptLimit} receipts, drop the
   * oldest and record the cumulative count in the file's marker. Runs after an
   * append (the parsed file is already cached, so a steady session costs no
   * re-read); returns whether it trimmed.
   */
  private trimReceipts(sidecarPath: string): boolean {
    const load = this.receiptsFor(sidecarPath)
    const cap = this.receiptLimit
    if (load.receipts.length <= cap) return false
    const drop = load.receipts.length - cap
    this.writeReceipts(sidecarPath, load.receipts.slice(drop), load.dropped + drop)
    return true
  }
  /**
   * Fold one append into the parsed cache, but only when that cache was current
   * right before the write (same identity): otherwise a foreign append would be
   * hidden. A metadata rewrite alone no longer drops this cache.
   */
  private noteReceiptAppend(sidecarPath: string, receipt: any, previousKey: string | undefined): void {
    const path = receiptsPathOf(sidecarPath)
    const kept = this.receiptsCache.entries.get(path)
    if (!kept) return
    if (previousKey === undefined || kept.key !== previousKey) { this.forgetReceipts(path); return }
    const rows = kept.load.receipts
    if (receipt && typeof receipt === 'object' && typeof receipt.id === 'string') {
      const at = rows.findIndex((row: any) => row?.id === receipt.id)
      if (at >= 0) rows[at] = receipt
      else rows.push(receipt)
    } else rows.push(receipt)
    const identity = fileIdentity(path)
    if (identity === undefined) { this.forgetReceipts(path); return }
    this.receiptsCache.bytes += identity.bytes - kept.load.bytes
    kept.load.bytes = identity.bytes
    kept.key = identity.key
  }
  /**
   * Append one receipt with a single `O_APPEND` write and no fsync: the call
   * already happened and its tagged call-log line can rebuild the receipt, so
   * paying a disk flush per tool call would slow every turn for no recoverable
   * data. A tail left without a newline by a crash gets one first.
   */
  private appendReceipt(sidecarPath: string, receipt: any, { compact = true } = {}): boolean {
    const path = receiptsPathOf(sidecarPath)
    let compacted = false
    // Migration's first append does not compact: moving a legacy combined file
    // keeps every receipt, and the cap starts applying to later writes.
    try {
      if (compact && statSync(path).size > this.receiptBudgetBytes) { this.compactReceipts(path); compacted = true }
    } catch { /* no receipts file yet */ }
    const fd = openSync(path, 'a+', 0o600)
    try {
      const size = Number(fstatSync(fd).size)
      if (size > 0) {
        const last = Buffer.alloc(1)
        readSync(fd, last, 0, 1, size - 1)
        if (last[0] !== 10) writeSync(fd, '\n')
      }
      writeSync(fd, `${JSON.stringify(receipt)}\n`)
    } finally { closeSync(fd) }
    return compacted
  }
  /**
   * Bound one outlier session: keep the newest complete lines up to the byte
   * budget and prepend a marker with the cumulative dropped count. The rewrite
   * is atomic (tmp, fsync, rename), so a crash keeps the old file intact.
   */
  private compactReceipts(path: string): void {
    const buffer = readFileSync(path)
    if (!buffer.byteLength) return
    let dropped = 0
    let bodyStart = 0
    const firstNewline = buffer.indexOf(10)
    if (buffer[0] === 0x7b && firstNewline > 0) {
      try {
        const first = JSON.parse(buffer.subarray(0, firstNewline).toString('utf8'))
        if (first?.[RECEIPTS_MARKER]) {
          dropped = Math.max(0, Number(first[RECEIPTS_MARKER].dropped) || 0)
          bodyStart = firstNewline + 1
        }
      } catch { /* a corrupt first line is just dropped below */ }
    }
    const keepFrom = Math.max(bodyStart, buffer.byteLength - this.receiptBudgetBytes)
    let cut = keepFrom
    if (cut > bodyStart) {
      const newline = buffer.indexOf(10, cut)
      cut = newline < 0 ? buffer.byteLength : newline + 1
    } else cut = bodyStart
    let lines = 0
    for (let at = bodyStart; at < cut; at++) if (buffer[at] === 10) lines++
    const marker = { [RECEIPTS_MARKER]: { version: 1, truncated: true, dropped: dropped + lines, at: Date.now() } }
    atomicBytes(path, Buffer.concat([Buffer.from(`${JSON.stringify(marker)}\n`), buffer.subarray(cut)]))
    this.forgetReceipts(path)
  }
  async updateSidecar(id: string, fn: (sidecar: SessionSidecar) => void): Promise<void> {
    const path = await this.sidecarPath(id)
    const owner = this.owners.sessions[id]
    if (!owner?.project) return
    const project = owner.project
    // Synchronous under the lock every writer of this sidecar takes: concurrent
    // appenders cannot migrate or rewrite on top of a stale read.
    withFileLock(`${path}.lock`, () => {
      const text = existsSync(path) ? readFileSync(path, 'utf8') : undefined
      const raw: any = text === undefined ? { version: 1, sessionId: id, project, invocations: [] } : JSON.parse(text)
      const legacy = Array.isArray(raw.invocations) ? raw.invocations : undefined
      const value: any = { ...raw }
      delete value.invocations
      if (!value.version) value.version = 1
      if (!value.sessionId) value.sessionId = id
      if (!value.project) value.project = project
      let assigned: any[] | undefined
      let assignedFlag = false
      Object.defineProperty(value, 'invocations', {
        enumerable: true, configurable: true,
        get: () => assigned !== undefined ? assigned : legacy !== undefined ? legacy : this.receiptsFor(path).receipts,
        set: (next: any) => { assignedFlag = true; assigned = Array.isArray(next) ? next : [] },
      })
      fn(value)
      // A callback that replaces the property (Object.assign) still goes through
      // the setter; one that deletes it leaves the stored receipts alone.
      const descriptor = Object.getOwnPropertyDescriptor(value, 'invocations')
      if (!assignedFlag && descriptor && descriptor.get === undefined && Array.isArray(descriptor.value)) { assignedFlag = true; assigned = descriptor.value }
      if (legacy !== undefined) {
        // Lazy migration *and* receipt compaction: writes/refusals go durably
        // beside the file, read-only receipts fold into the counter, then the
        // small metadata replaces the combined original (kept as `.bak`). A
        // crash before the metadata rewrite leaves the old file authoritative:
        // the retry reproduces the same kept receipts and folds the same reads.
        if (text !== undefined) this.backupSidecar(path, text)
        const folded = compactInvocations(value[RECEIPT_META], assignedFlag ? assigned! : legacy)
        value[RECEIPT_META] = folded.meta
        this.writeReceipts(path, folded.invocations)
      } else if (assignedFlag) {
        this.writeReceipts(path, assigned!)
        this.trimReceipts(path)
      }
      delete value.invocations
      // Imported sidecars cannot override the verified destination identity.
      value.projectId = this.projectIdOf(id)
      value.projectIdentity = owner.identity
      atomicJson(path, value)
      // A cached read sees the value just written; the new file identity also
      // makes every other entry stale on its own.
      const identity = this.sidecarIdentity(path)
      if (identity) this.rememberSidecar(path, id, identity.key, identity.bytes, value)
      else this.forgetSidecar(path)
    })
  }
  /**
   * Fold one read-only host call into the session's receipt counter instead of
   * writing a receipt: called by `traceInvocation` through the process-wide
   * sink. The metadata counter is bumped under the sidecar lock and the cached
   * read sees it immediately (no TTL); a legacy combined sidecar is compacted
   * here too, so its first observation folds its read receipts. A refusal is
   * recorded separately as a receipt but still moves the counter's last
   * outcome, so the aggregate line stays truthful.
   */
  async aggregateInvocation(invocation: Invocation): Promise<void> {
    const id = String(invocation?.sessionId ?? '')
    const operation = typeof invocation?.operation === 'string' ? invocation.operation : ''
    if (!id || !operation) return
    const path = await this.sidecarPath(id)
    const owner = this.owners.sessions[id]
    if (!owner?.project) return
    const at = Number.isFinite(invocation.at) ? invocation.at! : Date.now()
    const outcome = invocation.outcome === 'refusal' || invocation.outcome === 'unknown' ? invocation.outcome : 'success'
    withFileLock(`${path}.lock`, () => {
      const text = existsSync(path) ? readFileSync(path, 'utf8') : undefined
      const meta: any = text === undefined ? { version: 1, sessionId: id, project: owner.project } : JSON.parse(text)
      const legacy = Array.isArray(meta.invocations) ? meta.invocations : undefined
      delete meta.invocations
      if (!meta.version) meta.version = 1
      if (!meta.project) meta.project = owner.project
      if (legacy !== undefined) {
        // Compatibility: an old combined sidecar compacts on this first
        // observation, writes/refusals kept beside the file, reads folded.
        const folded = compactInvocations(meta[RECEIPT_META], legacy)
        meta[RECEIPT_META] = folded.meta
        if (text !== undefined) this.backupSidecar(path, text)
        this.writeReceipts(path, folded.invocations)
      }
      meta[RECEIPT_META] = foldRead(meta[RECEIPT_META], { operation, at, outcome }, { count: outcome === 'success', cap: this.receiptLimit })
      meta.projectId = this.projectIdOf(id)
      meta.projectIdentity = owner.identity
      atomicJson(path, meta)
      // A cached read sees the bumped counter at once: the file identity moved,
      // and this entry matches it; no TTL, no receipts re-read.
      const identity = this.sidecarIdentity(path)
      if (identity) this.rememberSidecar(path, id, identity.key, identity.bytes, meta)
      else this.forgetSidecar(path)
    })
  }
  async recordInvocation(invocation: any): Promise<void> {
    const id = String(invocation.sessionId)
    const path = await this.sidecarPath(id)
    const owner = this.owners.sessions[id]
    if (!owner?.project) return
    const operation = typeof invocation.operation === 'string' ? invocation.operation : ''
    const readOnly = !!operation && readOnlyOperation(operation, Array.isArray(invocation.argv) ? invocation.argv : undefined)
    // A host read that bypassed traceInvocation is still a counter, not a row;
    // a tool's tagged line is the agent's command and always keeps its receipt.
    const observe = readOnly && receiptDisposition(invocation, invocation.origin === 'tool' ? 'tool' : 'host') === 'aggregate'
    withFileLock(`${path}.lock`, () => {
      const text = existsSync(path) ? readFileSync(path, 'utf8') : undefined
      const meta: any = text === undefined ? { version: 1, sessionId: id, project: owner.project } : JSON.parse(text)
      const legacy = Array.isArray(meta.invocations) ? meta.invocations : undefined
      delete meta.invocations
      if (!meta.version) meta.version = 1
      if (!meta.project) meta.project = owner.project
      if (legacy !== undefined) {
        // The first write migrates *and* compacts: writes/refusals go durably
        // beside the file first, reads fold into the counter, then the small
        // metadata replaces the combined original (retained as `.bak`). A crash
        // before the metadata rewrite leaves the old file authoritative, so the
        // retry reproduces the same kept receipts and the same count.
        if (text !== undefined) this.backupSidecar(path, text)
        const folded = compactInvocations(meta[RECEIPT_META], legacy)
        meta[RECEIPT_META] = folded.meta
        this.writeReceipts(path, folded.invocations)
      }
      // Metadata lands before the append: a crash in between leaves the legacy
      // file (or the prior small one) authoritative, and a retry can only add
      // receipts, never overwrite appended ones with the old in-file array.
      meta.projectId = this.projectIdOf(id)
      meta.projectIdentity = owner.identity
      if (observe) {
        meta[RECEIPT_META] = foldRead(meta[RECEIPT_META], { operation, at: Number.isFinite(invocation.at) ? invocation.at : Date.now(), outcome: 'success' }, { cap: this.receiptLimit })
        atomicJson(path, meta)
        const foldedIdentity = this.sidecarIdentity(path)
        if (foldedIdentity) this.rememberSidecar(path, id, foldedIdentity.key, foldedIdentity.bytes, meta)
        else this.forgetSidecar(path)
        return
      }
      atomicJson(path, meta)
      const receiptKey = fileIdentity(receiptsPathOf(path))?.key
      const compacted = this.appendReceipt(path, invocation, { compact: legacy === undefined })
      const identity = this.sidecarIdentity(path)
      if (identity) this.rememberSidecar(path, id, identity.key, identity.bytes, meta)
      else this.forgetSidecar(path)
      if (compacted) this.forgetReceipts(receiptsPathOf(path))
      else this.noteReceiptAppend(path, invocation, receiptKey)
      // The cap is a count bound beside the byte bound: the newest receipts
      // survive, the oldest are dropped and the file marker says how many.
      this.trimReceipts(path)
    })
  }
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const inner = ctx.isolate('sessionPersistence')
  await inner.plugin(jsonl as any, config).await()
  const local = inner.get('sessionPersistence' as never)
  if (!local) throw new Error('dsh-layerfs: the inner JSONL session persistence did not start')
  await ctx.plugin({
    name: 'dsh-layerfs-session-persistence-service',
    apply(serviceCtx: Context) {
      const service = new LayerfsSessionPersistence(serviceCtx, local)
      // The receipt policy folds host reads here, without tracing.ts knowing
      // the persistence service (it only exposes the sink).
      setReceiptAggregate((invocation) => service.aggregateInvocation(invocation))
    },
  }).await()
  ctx.logger('layerfs').info('session persistence: stock JSONL at %s; project conversations use owner-routed unpacked JSONL', config.root)
}
