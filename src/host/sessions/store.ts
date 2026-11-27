/** Project-owned portable session archives. Each internal history branch stores
 * a standard unpacked DSH log and its additive sidecar. Version 3 keeps both
 * append-only: the native log is `session.jsonl` plus `session.<line>.jsonl`
 * parts holding the native rows added since (concatenated in manifest order
 * they are the exact log), and the sidecar is `layerfs.json` without its
 * receipts plus `invocations.jsonl` / `invocations.<line>.jsonl`, one receipt
 * per line. A save writes only what was added; a stream is rewritten as one
 * base file when its archived prefix changed or its parts outgrow the base.
 * Local logs are authoritative; archive progress advances only after confirmed
 * saves. Version-2 (one native file) and version-1 segmented archives remain
 * readable for migration. */
import type { Context } from '@deepseek-ai/cordis'
import { constants, mkdirSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { mergeInvocations, withoutTraceContext } from '../layerfs/tracing.ts'
import { CliError, pages } from '../layerfs/cli.ts'
import type { LayerfsSessions } from './service.ts'
import type { ArchivePiece, StreamMark, SimulationBinding } from './state.ts'

export const STORE_PREFIX = 'dsh.session.'

/** A listed Branch's head Commit id (its live head, else its saved head), or null when it has none. */
function branchHead(branch: any): string | null {
  // 2.0 `branch list`: `commit` is the Branch's head (or its fork point while it has none)
  const id = branch?.commit
  return typeof id === 'string' && id ? id : null
}
const DIR = '/.dsh/session'
const MISS_MS = 30_000
/**
 * How long a completed discovery answer is reused while every Branch head still
 * matches. The Branch list is read on every listing (the SDK keeps that read
 * for 2 s), so a stored session saved, added or removed by any process shows at
 * once; this bound only refreshes a stored row's `local` flag when another
 * process adds the log, and a write here invalidates the answer immediately.
 * A listing that finds a moved head (or this bound run out) answers the last
 * answer and rebuilds behind the call; that walk's completion emits one
 * `layerfs-session` change event.
 */
const DISCOVERY_MS = 5_000
/** A stream with this many parts is rewritten as one base file on its next save. */
export const PART_LIMIT = 32
/** Parts may hold up to this many bytes, or the base's size if larger, before a rewrite. */
export const COMPACT_FLOOR = 64 * 1024

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const joinLines = (lines: readonly string[], from = 0, to = lines.length) => to > from ? lines.slice(from, to).join('\n') + '\n' : ''
const STREAM_FILE = { session: /^session(\.[0-9]+)?\.jsonl$/, invocations: /^invocations(\.[0-9]+)?\.jsonl$/ } as const
type Stream = keyof typeof STREAM_FILE

/** What one save writes for an append-only stream (lines without their newline). */
export function planStream(stem: Stream, lines: readonly string[], mark: StreamMark | undefined, remote: readonly ArchivePiece[] | undefined): { changes: any[], pieces: ArchivePiece[], mark: StreamMark, text: string } {
  const text = joinLines(lines)
  const next = { lines: lines.length, digest: sha(text) }
  const last = remote?.[remote.length - 1]
  // Append only onto exactly what the archive is known to hold.
  if (mark && remote?.length && last!.to === mark.lines && lines.length >= mark.lines && sha(joinLines(lines, 0, mark.lines)) === mark.digest) {
    const added = joinLines(lines, mark.lines)
    if (!added) return { changes: [], pieces: [...remote], mark: next, text }
    const bytes = Buffer.byteLength(added)
    const parts = remote.length // the existing parts and this one
    const partBytes = remote.slice(1).reduce((sum, piece) => sum + piece.bytes, 0) + bytes
    if (parts <= PART_LIMIT && partBytes <= Math.max(remote[0].bytes, COMPACT_FLOOR)) {
      const piece = { file: `${stem}.${mark.lines}.jsonl`, from: mark.lines, to: lines.length, bytes }
      return { changes: [{ op: 'write', path: `${DIR}/${piece.file}`, content: added }], pieces: [...remote, piece], mark: next, text }
    }
  }
  const base = { file: `${stem}.jsonl`, from: 0, to: lines.length, bytes: Buffer.byteLength(text) }
  return {
    changes: [...(remote ?? []).filter((piece) => piece.file !== base.file).map((piece) => ({ op: 'rm', path: `${DIR}/${piece.file}` })), { op: 'write', path: `${DIR}/${base.file}`, content: text }],
    pieces: [base], mark: next, text,
  }
}

/** Version-3 archive checksum: the native log, the sidecar without its receipts or archive progress, and the receipts. */
const archiveDigest = (logDigest: string, rest: any, invocationsDigest: string) => sha(JSON.stringify([logDigest, sha(JSON.stringify({ ...rest, archive: undefined })), invocationsDigest]))

/** A version-3 manifest's pieces of one stream: safe names, contiguous from line 0. */
function piecesOf(manifest: any, stream: Stream): ArchivePiece[] {
  const pieces = manifest?.[stream === 'session' ? 'log' : 'invocations']
  if (!Array.isArray(pieces) || !pieces.length) throw new CliError('InvalidInput', 'The stored manifest lists no archive files')
  let at = 0
  for (const piece of pieces) {
    if (typeof piece?.file !== 'string' || !STREAM_FILE[stream].test(piece.file) || piece.from !== at || !Number.isSafeInteger(piece.to) || piece.to < at || !Number.isSafeInteger(piece.bytes)) throw new CliError('InvalidInput', 'Unsafe or discontinuous session archive file list')
    at = piece.to
  }
  return pieces
}

const compact = (sessionId: string) => sessionId.replace(/^session-/, '').replace(/[^A-Za-z0-9]/g, '').toLowerCase()
export const storeBranchOf = (sessionId: string) => `${STORE_PREFIX}${compact(sessionId)}`

/** A stored session as listed for a project. */
export interface StoredSession {
  readonly sessionId: string
  readonly title: string | null
  readonly branch: string
  readonly codeBranch: string | null
  readonly events: number
  readonly checkpoints: number
  readonly updatedAt: number | null
  readonly local: boolean
  readonly shared: boolean
  readonly projectId?: string
}

/** One stored Branch line of the discovery change token: its name and head. */
const storedHeads = (stored: readonly any[]) => stored.map((b: any) => `${b.name}@${branchHead(b) ?? ''}`).join('\n')
const copyRows = (rows: readonly StoredSession[]) => rows.map((row) => ({ ...row }))
/** Whether two discovery answers hold the same rows (what a client would paint). */
const rowsSignature = (rows: readonly StoredSession[] | undefined) => (rows ?? []).map((row) => [
  row.sessionId, row.projectId ?? '', row.title ?? '', row.branch, row.codeBranch ?? '', row.events, row.checkpoints, row.updatedAt ?? '', row.local ? 1 : 0, row.shared ? 1 : 0,
].join('\u0000')).join('\u0001')

export class SessionStore {
  private readonly timers = new Map<string, NodeJS.Timeout>()
  constructor(private readonly ctx: Context, private readonly sessions: LayerfsSessions) {}

  /** Where each stored session found by discovery lives (session id -> project). */
  private readonly found = new Map<string, string>()
  private readonly syncing = new Map<string, Promise<number>>()
  /** Session ids discovery did not find, and when: not searched again for {@link MISS_MS}. */
  private readonly missed = new Map<string, number>()

  private get lfs() { return this.ctx.layerfs.lfs }

  /** Mirror soon (debounced): after `turn/end` and on disposal. */
  schedule(sessionId: string, delay = 1200): void {
    clearTimeout(this.timers.get(sessionId))
    this.timers.set(sessionId, setTimeout(() => {
      this.timers.delete(sessionId)
      void this.mirror(sessionId).catch((error) => this.ctx.logger('layerfs').warn('session store %s: %s', sessionId, error?.message ?? error))
    }, delay))
  }

  dispose(): void { for (const t of this.timers.values()) clearTimeout(t); this.timers.clear() }

  /** Drop a deleted session's pending mirror and discovery memo. */
  forget(sessionId: string): void {
    const project = this.known(sessionId)
    clearTimeout(this.timers.get(sessionId))
    this.timers.delete(sessionId)
    this.found.delete(sessionId)
    if (project) this.invalidateDiscovery(project)
  }

  /** Mirrors queued on their Store's lane that have not started (session id -> run). */
  private readonly queued = new Map<string, Promise<void>>()

  /**
   * Append the session's new events to its project. Saves to one Store run one
   * at a time (concurrent writers only queue on LayerFS's Store lock), and a
   * session already queued is not queued twice: its run reads the latest log.
   */
  mirror(sessionId: string): Promise<void> {
    const waiting = this.queued.get(sessionId)
    if (waiting) return waiting
    const project = this.sessions.binding(sessionId)?.project
    if (!project) return Promise.resolve()
    // Once it starts, later changes need a run of their own.
    let started = false
    const run: Promise<void> = this.sessions.lane(`archive:${project.split('/')[0]}`, () => {
      started = true
      this.queued.delete(sessionId)
      return this.mirrorNow(sessionId)
    })
    if (!started) this.queued.set(sessionId, run)
    return run
  }

  private async mirrorNow(sessionId: string): Promise<void> {
    const binding = this.sessions.binding(sessionId)
    if (!binding || !binding.project) return
    const session = (this.ctx.get('sessions' as never) as any)?.get(sessionId)
    if (!session && !(await localPersistence(this.ctx)?.stat(sessionId))) return
    const project = binding.project
    const branch = storeBranchOf(sessionId)
    const state = this.sessions.state.read().mirror[sessionId]
    const persistence = localPersistence(this.ctx)
    await persistence.flush()
    const handle = await persistence.open(sessionId, 'read')
    let header: any, inheritedEventCount: number, events: any[]
    try {
      header = handle.header
      inheritedEventCount = handle.inheritedEventCount ?? 0
      events = (await handle.read()).events
    } finally { await handle.close() }
    const at = events!.length
    const from = state?.count ?? 0
    const checkpoints = this.sessions.checkpoints(sessionId)
    const provider = this.ctx.get('sessionPersistence') as any
    const annotations = await provider?.readSidecar?.(sessionId) ?? { version: 1, sessionId, project, invocations: [] }
    const codeBranch = binding.branch ?? (binding.parent ? this.sessions.binding(binding.parent)?.branch : null) ?? null
    const title = this.titleOf(session ?? { snapshotEvents: () => events })
    const sidecar = { ...annotations, title, bindingKind: binding.kind, ...(binding.parent ? { sharedParent: binding.parent } : {}), codeBranch, checkpoints, archive: { count: at, updatedAt: Date.now() } }
    const { invocations = [], ...rest } = sidecar
    // Use the official codec, including native fork/inheritance metadata. Its
    // rows are a standard unpacked DSH log, not a second event representation.
    const logLines = [
      JSON.stringify(sessionFormatCatalog.encodeCurrentHeader({ ...header!, delegationDepth: header!.delegationDepth ?? 0 }, inheritedEventCount!)),
      ...events!.map((event: any) => JSON.stringify(sessionFormatCatalog.encodeCurrentEvent(event))),
    ]
    const invocationLines = (Array.isArray(invocations) ? invocations : []).map((row: any) => JSON.stringify(row))
    // Only a confirmed save (one with a digest) continues an archive; a state
    // left by a failed first save is retried as a first save.
    const confirmed = state?.digest ? state : undefined
    try {
      await provider?.assertSessionIdentity?.(sessionId)
      // What the archive holds now: checked against the last confirmed save, or
      // (first save) an existing branch left by an earlier attempt.
      let remote: any = null
      if (confirmed) {
        remote = await this.readManifest(project, branch)
        if (remote.digest !== confirmed.digest || remote.count !== from) {
          throw new CliError('ArchiveConflict', 'The project archive differs from the last confirmed save, possibly after restore or another writer. Local history is retained; reconcile the archive before saving again.')
        }
      }
      const v3 = remote?.version === 3
      const marks = v3 ? confirmed?.streams : undefined
      const log = planStream('session', logLines, marks?.log, v3 ? piecesOf(remote, 'session') : undefined)
      const receipts = planStream('invocations', invocationLines, marks?.invocations, v3 ? piecesOf(remote, 'invocations') : undefined)
      const digest = archiveDigest(log.mark.digest, rest, receipts.mark.digest)
      if (confirmed?.digest === digest && !confirmed.error) return
      const manifest = {
        version: 3, kind: 'dsh-session', sessionId, project, projectId: provider?.projectIdOf?.(sessionId), header,
        inheritedEventCount, title, codeBranch, bindingKind: binding.kind, ...(binding.parent ? { sharedParent: binding.parent } : {}),
        count: at, log: log.pieces, invocations: receipts.pieces, checkpoints, digest, updatedAt: Date.now(),
      }
      const changes: any[] = [
        ...(confirmed ? [] : [{ op: 'mkdir', path: DIR }]),
        ...log.changes,
        ...receipts.changes,
        { op: 'write', path: `${DIR}/layerfs.json`, content: JSON.stringify(rest) + '\n' },
        { op: 'write', path: `${DIR}/manifest.json`, content: JSON.stringify(manifest) + '\n' },
      ]
      let saved = false
      if (!confirmed) {
        await withoutTraceContext(() => this.lfs.branch.fork(project, branch, 'main')).catch(async (error: any) => {
          if (error?.code !== 'Exists') throw error
          // The branch exists: ours from a first save whose write failed (no
          // manifest yet), or one that already holds exactly this save. Anything
          // else is another writer's archive.
          const existing = await this.readManifest(project, branch).catch((e: any) => {
            if (e?.code === 'NotFound') return null
            throw e
          })
          if (existing && existing.digest !== digest) throw new CliError('ArchiveConflict', 'An archive already exists for this conversation. Reconcile it before saving local history.')
          saved = !!existing
        })
      }
      const bytes = changes.reduce((sum, change) => sum + (typeof change.content === 'string' ? Buffer.byteLength(change.content) : 0), 0)
      if (!saved) await withoutTraceContext(() => this.lfs.file.apply(project, branch, changes, { message: `dsh session ${compact(sessionId).slice(0, 8)}: events ${from}..${at} (${bytes} bytes)` }))
      // An existing identical save holds the same content in its own layout: the
      // marks stay valid, and the next save reads its file list from its manifest.
      const streams = { log: log.mark, invocations: receipts.mark }
      this.sessions.state.update((s) => { s.mirror[sessionId] = { project, branch, count: at, segments: log.pieces.map(({ file, from, to }) => ({ file, from, to })), streams, updatedAt: Date.now(), digest } })
      await provider?.updateSidecar?.(sessionId, (value: any) => { value.title = sidecar.title; value.bindingKind = binding.kind; if (binding.parent) value.sharedParent = binding.parent; value.codeBranch = codeBranch; value.checkpoints = checkpoints; value.archive = sidecar.archive })
      // This process just wrote a manifest: the next list must see it, not a memo.
      this.invalidateDiscovery(project)
      this.ctx.layerfs.emit('layerfs-session', { sessionId })
    } catch (error: any) {
      this.sessions.state.update((s) => { s.mirror[sessionId] = { ...(state ?? { project, branch, count: from, segments: [] }), updatedAt: Date.now(), error: String(error?.message ?? error) } })
      await provider?.updateSidecar?.(sessionId, (value: any) => { value.archive = { count: from, updatedAt: Date.now(), error: String(error?.message ?? error) } })
      // A failed save can still have created its Branch; never serve the old answer.
      this.invalidateDiscovery(project)
      throw error
    }
  }

  private titleOf(session: any): string | null {
    let title: string | null = null
    for (const e of session.snapshotEvents?.(0) ?? []) {
      if (e.type === 'session/title' && typeof e.data?.title === 'string') title = e.data.title
      if (!title && e.type === 'user/message') {
        const text = (e.data?.message?.content ?? e.data?.content ?? []).find?.((p: any) => p?.type === 'text')?.text
        if (typeof text === 'string') title = text.slice(0, 80)
      }
    }
    return title
  }

  /**
   * Parsed manifests of stored sessions by `project\0branch`, with the Branch head they
   * were read at: a Branch whose head did not move is not read again. The session list
   * is polled by every open project view, and re-reading each manifest per poll stalled
   * host reads during a team run (Quarry v2 FIX-LOG F22).
   */
  private readonly manifests = new Map<string, { head: string, manifest: any }>()
  /** Discovery walks in flight by project: concurrent callers share one walk. */
  private readonly discovering = new Map<string, Promise<StoredSession[]>>()
  /** How each running walk started: fresh or not, and under which invalidation epoch ({@link epochOf}). */
  private readonly walkStart = new WeakMap<Promise<StoredSession[]>, { fresh: boolean, epoch: string }>()
  /** Invalidations by project, and of every project: a walk that started before one is stale. */
  private readonly epochs = new Map<string, number>()
  private allEpoch = 0
  private epochOf(project: string): string { return `${this.allEpoch}.${this.epochs.get(project) ?? 0}` }
  /**
   * The last completed discovery answer by `project\0identity`, with the Branch
   * heads it was built from: a listing still lists the Branches (one kept read),
   * and an answer whose heads all still match is reused. When a head moved (a
   * save, a new session, a deletion) the listing answers what this holds and
   * rebuilds behind the call. The short age bound only refreshes a stored row's
   * `local` flag when another process adds the log.
   */
  private readonly discoveries = new Map<string, { at: number, heads: string, value: StoredSession[] }>()

  /**
   * The sessions stored in a project, joined with what this DSH has locally.
   * `identity` keys the short-lived answer (a listing knows the project's live
   * identity); `fresh` skips it for reads that must find a conversation (open,
   * sync, recovery). A local write invalidates it before it returns.
   *
   * A listing — a caller that names its identity or says what it already stat'ed,
   * as `sessions.list` does — never waits for a walk: it answers what the last
   * walk knew (possibly nothing) and the walk finishes behind it, emitting one
   * `layerfs-session` change event so the client rereads and sees the rows it
   * found (or loses the ones that are gone). A bare or `fresh` call still waits:
   * it is a lookup, not a paint, and it must answer from the Store.
   */
  discover(project: string, { fresh = false, identity, local }: { fresh?: boolean, identity?: string, local?: (sessionId: string) => boolean | undefined } = {}): Promise<StoredSession[]> {
    const key = `${project}\0${identity ?? ''}`
    if (!fresh && (identity !== undefined || local !== undefined)) return this.listing(project, key, local)
    // Join a running walk only when it began after the last invalidation; a
    // fresh lookup also never joins a walk that may answer from a kept memo or a
    // Branch list seeded before the request (a listing's walk behind).
    const running = this.discovering.get(project)
    const started = running && this.walkStart.get(running)
    if (running && started && started.epoch === this.epochOf(project) && (started.fresh || !fresh)) return running
    const epoch = this.epochOf(project)
    const walk: Promise<StoredSession[]> = this.discoverNow(project, key, fresh, local, undefined, epoch).finally(() => { if (this.discovering.get(project) === walk) this.discovering.delete(project) })
    this.walkStart.set(walk, { fresh, epoch })
    this.discovering.set(project, walk)
    return walk
  }

  /**
   * Drop the short-lived discovery answers: one project, or all when the write
   * moved between projects. The known rows stay for the next listing (a Store
   * walk must not make a list blink empty); marking the answer stale forces that
   * listing to walk.
   */
  invalidateDiscovery(project?: string): void {
    // A walk running now finishes under the old epoch: its answer is stored stale.
    if (project === undefined) this.allEpoch++
    else this.epochs.set(project, (this.epochs.get(project) ?? 0) + 1)
    for (const [key, value] of this.discoveries) if (project === undefined || key.startsWith(`${project}\0`)) this.discoveries.set(key, { ...value, at: 0 })
  }

  /** A list read: one Branch list inline (the change token), the last walk's answer, the walk behind. */
  private async listing(project: string, key: string, local?: (sessionId: string) => boolean | undefined): Promise<StoredSession[]> {
    const kept = this.discoveries.get(key)
    const epoch = this.epochOf(project)
    const stored = await this.storedBranches(project)
    const heads = storedHeads(stored)
    if (kept && kept.heads === heads && Date.now() - kept.at < DISCOVERY_MS) return copyRows(kept.value)
    this.walkBehind(project, key, local, { stored, heads, epoch })
    return kept ? copyRows(kept.value) : []
  }

  /** Start the walk a listing could not wait for, unless one already runs; emit once when it lands with a changed answer. */
  private walkBehind(project: string, key: string, local: ((sessionId: string) => boolean | undefined) | undefined, seed: { stored: any[], heads: string, epoch: string }): void {
    // a walk that began before an invalidation does not stand in for this one
    const running = this.discovering.get(project)
    if (running && this.walkStart.get(running)?.epoch === seed.epoch) return
    const before = this.discoveries.get(key)?.value
    const walk = this.discoverNow(project, key, false, local, seed, seed.epoch)
    this.walkStart.set(walk, { fresh: false, epoch: seed.epoch })
    this.discovering.set(project, walk)
    void walk.then(() => {
      const after = this.discoveries.get(key)?.value
      if (rowsSignature(before) !== rowsSignature(after)) this.ctx.layerfs.emit('layerfs-session', { project, discovery: true })
    }, (error: any) => {
      // A walk behind a list must not fail the list: the next listing retries.
      try { this.ctx.logger('layerfs').warn('session store: discover %s: %s', project, error?.message ?? error) } catch { /* no logger */ }
    }).finally(() => { if (this.discovering.get(project) === walk) this.discovering.delete(project) })
  }

  private async storedBranches(project: string): Promise<any[]> {
    const branches = (await pages((paging) => this.lfs.branch.list(project, { prefix: STORE_PREFIX, ...paging }))).map((b: any) => ({ ...b, name: b.branch }))
    return branches.filter((b: any) => typeof b.name === 'string' && b.name.startsWith(STORE_PREFIX))
  }

  private async discoverNow(project: string, key: string, fresh: boolean, local?: (sessionId: string) => boolean | undefined, seed?: { stored: any[], heads: string }, epoch = this.epochOf(project)): Promise<StoredSession[]> {
    const stored = seed?.stored ?? await this.storedBranches(project)
    // The Branch list is the change token for every stored session: a save appends
    // a Commit (head moves), a new session adds a Branch, a deletion removes one.
    const heads = seed?.heads ?? storedHeads(stored)
    const kept = fresh ? undefined : this.discoveries.get(key)
    if (kept && kept.heads === heads && Date.now() - kept.at < DISCOVERY_MS) return copyRows(kept.value)
    const out: StoredSession[] = []
    const seen = new Set<string>()
    for (const b of stored) {
      try {
        const manifestKey = `${project}\0${b.name}`
        seen.add(manifestKey)
        const head = branchHead(b)
        const keptManifest = head ? this.manifests.get(manifestKey) : undefined
        const manifest = keptManifest && keptManifest.head === head ? keptManifest.manifest : await this.readManifest(project, b.name)
        if (head) this.manifests.set(manifestKey, { head, manifest })
        else this.manifests.delete(manifestKey)
        out.push({
          sessionId: manifest.sessionId,
          projectId: manifest.projectId,
          title: manifest.title ?? null,
          branch: b.name,
          codeBranch: manifest.codeBranch ?? null,
          events: manifest.count ?? 0,
          checkpoints: (manifest.checkpoints ?? []).filter((c: any) => c.kind !== 'base' && c.kind !== 'restore' && c.commit && c.changed > 0).length,
          updatedAt: manifest.updatedAt ?? null,
          // A caller that already stat'ed this id (the session list's own loops) answers
          // here, so one list call never reads the same log twice.
          local: local?.(manifest.sessionId) ?? !!(await localPersistence(this.ctx)?.stat(manifest.sessionId).catch(() => undefined)),
          shared: manifest.bindingKind === 'shared' || manifest.header?.origin === 'subagent',
        })
        this.found.set(manifest.sessionId, project)
      } catch { /* a branch without a readable manifest is not a session */ }
    }
    // Branches gone from the project leave nothing kept.
    for (const name of this.manifests.keys()) if (name.startsWith(`${project}\0`) && !seen.has(name)) this.manifests.delete(name)
    // An invalidation while this walk ran wins: its answer is kept, but stale.
    this.discoveries.set(key, { at: epoch === this.epochOf(project) ? Date.now() : 0, heads, value: out.map((row) => ({ ...row })) })
    while (this.discoveries.size > 64) this.discoveries.delete(this.discoveries.keys().next().value as string)
    return out
  }

  /** Read one pinned Branch export. The windowed file.read API deliberately
   * truncates long lines, so it cannot transport native JSONL or annotations. */
  private async withArchive<T>(project: string, branch: string, consume: (read: (path: string) => Promise<string>) => Promise<T>): Promise<T> {
    const parent = join(this.ctx.layerfs.root, 'archive-imports')
    await mkdir(parent, { recursive: true, mode: 0o700 })
    const owned = await mkdtemp(join(parent, 'read-'))
    const destination = join(owned, 'snapshot')
    try {
      await withoutTraceContext(() => this.lfs.project.export(project, destination, { branch }))
      const read = async (path: string): Promise<string> => {
        const parts = path.split('/').filter(Boolean)
        if (parts[0] !== '.dsh' || parts[1] !== 'session' || parts.length < 3 || parts.some(part => part === '.' || part === '..')) throw new CliError('InvalidInput', 'Unsafe session archive path')
        let current = destination
        for (let index = -1; index < parts.length; index++) {
          if (index >= 0) current = join(current, parts[index])
          const info = await lstat(current)
          if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())) throw new CliError('InvalidInput', 'Session archive entries must be real directories and regular files')
        }
        const file = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          if (!(await file.stat()).isFile()) throw new CliError('InvalidInput', 'Session archive entry is not a regular file')
          return await file.readFile('utf8')
        } finally { await file.close() }
      }
      return await consume(read)
    } finally {
      // Export preserves read-only directory permissions. Only this call's
      // private tree is made removable, without following exported symlinks.
      const writable = async (path: string): Promise<void> => {
        const info = await lstat(path).catch(() => undefined)
        if (!info?.isDirectory() || info.isSymbolicLink()) return
        await chmod(path, 0o700)
        for (const entry of await readdir(path)) await writable(join(path, entry))
      }
      await writable(owned)
      await rm(owned, { recursive: true, force: true })
    }
  }

  async readManifest(project: string, branch: string): Promise<any> {
    // Listing should not materialize a whole project for a small manifest. Only
    // the positively complete canonical response is safe: long lines may be
    // clipped even when there is no next line to request.
    const page: any = await withoutTraceContext(() => this.lfs.file.read(project, branch, `${DIR}/manifest.json`, { line: 1, detail: true }))
    let size: bigint | undefined
    if (typeof page.size === 'bigint' && page.size >= 0n) size = page.size
    else if (typeof page.size === 'number' && Number.isSafeInteger(page.size) && page.size >= 0) size = BigInt(page.size)
    else if (typeof page.size === 'string' && /^[0-9]{1,20}$/.test(page.size)) size = BigInt(page.size)
    // 2.0 long form: the whole file when it starts at line 1, has no next_line and no cut line, and its text is the file's size
    if (page.binary !== true && page.start_line === 1 && page.line_truncated === false && page.next_line == null && typeof page.text === 'string' && size === BigInt(Buffer.byteLength(page.text))) return JSON.parse(page.text)
    return this.withArchive(project, branch, async read => JSON.parse(await read(`${DIR}/manifest.json`)))
  }

  /** Import missing native history and annotations without rewriting identities.
   * Imported cwd remains historical; a safe local scratch folder is selected. */
  async import(project: string, sessionId: string, workspaceId?: string): Promise<{ sessionId: string, imported: boolean }> {
    return await this.sessions.lane(`import:${sessionId}`, () => this.importNow(project, sessionId, workspaceId))
  }

  private async importNow(project: string, sessionId: string, workspaceId?: string): Promise<{ sessionId: string, imported: boolean }> {
    const persistence = localPersistence(this.ctx)
    if (!persistence) throw new CliError('Unavailable', 'DSH session persistence is not available')
    if (await persistence.stat(sessionId).catch(() => undefined)) {
      await (this.ctx.get('sessionPersistence') as any)?.assertSessionIdentity?.(sessionId)
      return { sessionId, imported: false }
    }
    const branch = storeBranchOf(sessionId)
    return this.withArchive(project, branch, read => this.importSnapshot(project, sessionId, workspaceId, read))
  }

  private async importSnapshot(project: string, sessionId: string, workspaceId: string | undefined, read: (path: string) => Promise<string>): Promise<{ sessionId: string, imported: boolean }> {
    const persistence = localPersistence(this.ctx)
    const branch = storeBranchOf(sessionId)
    const manifest = JSON.parse(await read(`${DIR}/manifest.json`))
    const provider = this.ctx.get('sessionPersistence') as any
    if (!manifest.projectId && provider?.catalog) throw new CliError('BindingRequired', 'This legacy archive has no permanent project identity. Local histories are preserved; importing it requires explicit ownership recovery.')
    if (manifest.projectId && provider?.catalog) {
      const destination = await provider.catalog.resolve(project)
      if (manifest.projectId !== destination.projectId) throw new CliError('BindingRequired', 'This backup contains history owned by another project identity. Recover the original project explicitly before importing its conversations.')
    }
    if (manifest.sessionId !== sessionId) throw new CliError('InvalidInput', 'The stored manifest names another session')
    if (manifest.bindingKind === 'shared') {
      if (typeof manifest.sharedParent !== 'string' || !manifest.sharedParent) throw new CliError('InvalidInput', 'The stored shared session has no parent')
      const seen = new Set([sessionId])
      let parent: string | undefined = manifest.sharedParent
      while (parent) {
        if (seen.has(parent)) throw new CliError('InvalidInput', 'The stored shared session has a cyclic parent dependency')
        seen.add(parent)
        parent = this.sessions.binding(parent)?.parent
      }
    }
    const anchor = this.sessions.ensureAnchor(project)
    const list = workspaceId ?? this.sessions.recordedWorkspace(project)
    let events: any[] = []
    let header = manifest.header
    let inheritedEventCount = manifest.inheritedEventCount ?? 0
    let sidecar: any
    let streams: { log: StreamMark, invocations: StreamMark } | undefined
    const restoreLog = (text: string) => {
      const lines = text.split('\n').filter((line) => line.trim())
      const restore = sessionFormatCatalog.createRestore(JSON.parse(lines.shift()!), { recovery: 'strict', validation: 'current' })
      for (const line of lines) restore.decodeRow(JSON.parse(line))
      const artifact = restore.finish()
      header = artifact.header
      events = [...artifact.events]
      inheritedEventCount = artifact.inheritedEventCount
    }
    if (manifest.version === 3) {
      // Each stream is its files concatenated in manifest order, checked line by line.
      const stream = async (name: 'session' | 'invocations') => {
        let text = ''
        for (const piece of piecesOf(manifest, name)) {
          const part = await read(`${DIR}/${piece.file}`)
          const lines = part ? part.split('\n') : ['']
          if ((part !== '' && !part.endsWith('\n')) || lines.length - 1 !== piece.to - piece.from) throw new CliError('InvalidInput', 'A session archive file does not hold the lines its manifest lists')
          text += part
        }
        return text
      }
      const logText = await stream('session')
      const invocationsText = await stream('invocations')
      restoreLog(logText)
      const rest = JSON.parse(await read(`${DIR}/layerfs.json`))
      if (rest.sessionId !== sessionId || rest.project !== project) throw new CliError('InvalidInput', 'The stored annotations name another session or project')
      const lines = { log: logText.split('\n').length - 1, invocations: invocationsText ? invocationsText.split('\n').length - 1 : 0 }
      streams = { log: { lines: lines.log, digest: sha(logText) }, invocations: { lines: lines.invocations, digest: sha(invocationsText) } }
      if (manifest.digest !== archiveDigest(streams.log.digest, rest, streams.invocations.digest)) throw new CliError('InvalidInput', 'The archived session checksum does not match its manifest')
      sidecar = { ...rest, invocations: invocationsText.split('\n').filter(Boolean).map((line) => JSON.parse(line)) }
    } else if (manifest.version === 2) {
      const text = await read(`${DIR}/session.jsonl`)
      restoreLog(text)
      sidecar = JSON.parse(await read(`${DIR}/layerfs.json`))
      if (sidecar.sessionId !== sessionId || sidecar.project !== project) throw new CliError('InvalidInput', 'The stored annotations name another session or project')
      const digest = createHash('sha256').update(text).update(JSON.stringify({ ...sidecar, archive: undefined })).digest('hex')
      if (manifest.digest !== digest) throw new CliError('InvalidInput', 'The archived session checksum does not match its manifest')
    } else {
      for (const segment of manifest.segments ?? []) {
        if (!/^segments\/[0-9]+\.jsonl$/.test(segment.file)) throw new CliError('InvalidInput', 'Unsafe session segment path')
        const text = await read(`${DIR}/${segment.file}`)
        for (const line of text.split('\n')) if (line.trim()) events.push(JSON.parse(line))
      }
    }
    if (header?.id !== sessionId || events.length !== manifest.count) throw new CliError('InvalidInput', 'The stored session identity or event count does not match its manifest')
    // Preserve the native header verbatim. Imported absolute cwd is historical
    // metadata; execution uses the safe local scratch binding below instead.
    await provider?.migrateProject?.(sessionId, project)
    const handle = await persistence.create(header, inheritedEventCount ? { inheritedEventCount } : undefined)
    try {
      if (events.length) await handle.append(events)
      await handle.flush?.()
    } finally {
      await handle.close?.()
    }
    // Receipts merge by id (local ones are kept, incoming ones marked imported); other fields as stored.
    if (sidecar) await provider?.updateSidecar?.(sessionId, (value: any) => { const local = value.invocations; Object.assign(value, sidecar); value.invocations = mergeInvocations(local, sidecar.invocations) })
    const scratch = `${anchor}/sessions/${sessionId}`
    mkdirSync(scratch, { recursive: true })
    const simulation: SimulationBinding | undefined = sidecar?.simulation ? { ...sidecar.simulation } : undefined
    if (simulation?.state === 'running') {
      simulation.state = 'interrupted'
      simulation.handoffReady = false
      simulation.error = 'The imported script was interrupted. The script will not run again; a real model continues this session from the project\'s current files.'
    }
    if (simulation) await provider?.updateSidecar?.(sessionId, (value: any) => { value.simulation = simulation })
    // The session keeps its code branch and checkpoints; a new Sandbox mounts that branch on first use.
    this.sessions.state.update((s) => {
      s.checkpoints[sessionId] ??= sidecar?.checkpoints ?? manifest.checkpoints ?? []
      if (!manifest.codeBranch && !simulation) s.pending[sessionId] ??= { project }
      if ((manifest.codeBranch || simulation) && !s.sessions[sessionId]) {
        s.sessions[sessionId] = {
          sessionId, kind: manifest.bindingKind === 'shared' && manifest.sharedParent ? 'shared' : 'project',
          ...(manifest.bindingKind === 'shared' && manifest.sharedParent ? { parent: manifest.sharedParent } : {}), project, anchor, scratch, scratchManaged: true, machine: 'native',
          branch: manifest.codeBranch, sandbox: `dsh-${compact(sessionId).slice(0, 20)}`, ws: `dsh-${compact(sessionId).slice(0, 20)}:main`,
          ...(simulation ? { simulation, resumeFromArchive: true, sandbox: undefined, ws: undefined, branch: undefined } : {}),
          state: 'closed', createdAt: Date.now(), updatedAt: Date.now(),
        }
      }
      s.mirror[sessionId] = { project, branch, count: manifest.count ?? events.length, segments: (manifest.version === 3 ? manifest.log : manifest.segments ?? []).map(({ file, from, to }: any) => ({ file, from, to })), ...(streams ? { streams } : {}), updatedAt: Date.now(), digest: manifest.digest }
    })
    // The stored row is local now: the next list reads its log and sidecar, not the archive row.
    this.invalidateDiscovery(project)
    await this.sessions.attach(list, sessionId)
    return { sessionId, imported: true }
  }

  /**
   * Import every session stored in `project` that this DSH does not have.
   * @returns how many sessions were imported.
   */
  sync(project: string): Promise<number> {
    const running = this.syncing.get(project)
    if (running) return running
    const run = (async () => {
      let imported = 0
      const persistence = this.ctx.get('sessionPersistence') as any
      for (const stored of await this.discover(project, { fresh: true })) {
        // A conversation deleted here (Presets Reset) comes back only by an explicit import.
        if (stored.local || persistence?.isDeleted?.(stored.sessionId)) continue
        try { if ((await this.import(project, stored.sessionId)).imported) imported++ } catch (error: any) {
          this.ctx.logger('layerfs').warn('session store: import %s from %s: %s', stored.sessionId, project, error?.message ?? error)
        }
      }
      return imported
    })().finally(() => this.syncing.delete(project))
    this.syncing.set(project, run)
    return run
  }

  /** Sync every project this DSH has a workspace for (the Scratch project included). Never throws. */
  async syncAll(): Promise<void> {
    for (const project of Object.keys(this.sessions.state.read().projects)) {
      await this.sync(project).catch((error: any) => this.ctx.logger('layerfs').warn('session store: sync %s: %s', project, error?.message ?? error))
    }
  }

  /** The project this DSH already knows stores a session (no LayerFS calls). */
  known(sessionId: string): string | undefined {
    return (this.ctx.get('sessionPersistence') as any)?.ownerOf?.(sessionId)?.project ?? this.sessions.state.read().sessions[sessionId]?.project ?? this.sessions.state.read().pending[sessionId]?.project ?? this.sessions.state.read().mirror[sessionId]?.project ?? this.found.get(sessionId)
  }

  /**
   * The project a session missing locally is stored in: known from this DSH's
   * state or an earlier discovery, else found by discovering every known project.
   */
  async locate(sessionId: string): Promise<string | undefined> {
    const known = this.known(sessionId)
    if (known) return known
    if (Date.now() - (this.missed.get(sessionId) ?? 0) < MISS_MS) return undefined
    for (const project of Object.keys(this.sessions.state.read().projects)) {
      await this.discover(project, { fresh: true }).catch(() => [])
      if (this.found.has(sessionId)) return this.found.get(sessionId)
    }
    this.missed.set(sessionId, Date.now())
    if (this.missed.size > 1000) this.missed.delete(this.missed.keys().next().value!)
    return undefined
  }
}

/** DSH's local session log: the LayerFS persistence row's inner JSONL backend, else the persistence service itself. */
export function localPersistence(ctx: Context): any {
  const persistence = ctx.get('sessionPersistence') as any
  return persistence?.local ?? persistence
}
