/** Project-owned portable session archives. Each internal history branch stores
 * a standard unpacked DSH session.jsonl and its additive layerfs.json sidecar.
 * Local logs are authoritative; archive progress advances only after confirmed
 * saves. Version-1 segmented archives remain readable for migration. */
import type { Context } from '@deepseek-ai/cordis'
import { constants, mkdirSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { withoutTraceContext } from '../layerfs/tracing.ts'
import { CliError, pages } from '../layerfs/cli.ts'
import type { LayerfsSessions } from './service.ts'
import type { SimulationBinding } from './state.ts'

export const STORE_PREFIX = 'dsh.session.'
const DIR = '/.dsh/session'
const MISS_MS = 30_000

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
    clearTimeout(this.timers.get(sessionId))
    this.timers.delete(sessionId)
    this.found.delete(sessionId)
  }

  /** Append the session's new events to its project. */
  async mirror(sessionId: string): Promise<void> {
    const binding = this.sessions.binding(sessionId)
    if (!binding || !binding.project) return
    const session = (this.ctx.get('sessions' as never) as any)?.get(sessionId)
    if (!session && !(await localPersistence(this.ctx)?.stat(sessionId))) return
    await this.sessions.lane(`store:${sessionId}`, async () => {
      const project = binding.project!
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
      const sidecar = { ...annotations, title: this.titleOf(session ?? { snapshotEvents: () => events }), bindingKind: binding.kind, ...(binding.parent ? { sharedParent: binding.parent } : {}), codeBranch, checkpoints, archive: { count: at, updatedAt: Date.now() } }
      // Use the official codec, including native fork/inheritance metadata.
      // This is a standard unpacked DSH log, not a second event representation.
      const text = [
        JSON.stringify(sessionFormatCatalog.encodeCurrentHeader({ ...header!, delegationDepth: header!.delegationDepth ?? 0 }, inheritedEventCount!)),
        ...events!.map((event: any) => JSON.stringify(sessionFormatCatalog.encodeCurrentEvent(event))),
      ].join('\n') + '\n'
      const digest = createHash('sha256').update(text).update(JSON.stringify({ ...sidecar, archive: undefined })).digest('hex')
      const segments = [{ file: 'session.jsonl', from: 0, to: at }]
      const manifest = {
        version: 2, kind: 'dsh-session', sessionId, project, projectId: provider?.projectIdOf?.(sessionId), header,
        inheritedEventCount, title: this.titleOf(session ?? { snapshotEvents: () => events }), codeBranch, bindingKind: binding.kind, ...(binding.parent ? { sharedParent: binding.parent } : {}),
        count: at, segments, checkpoints, digest, updatedAt: Date.now(),
      }
      const changes: any[] = [
        { op: 'write', path: `${DIR}/session.jsonl`, content: text },
        { op: 'write', path: `${DIR}/layerfs.json`, content: JSON.stringify(sidecar) + '\n' },
        { op: 'write', path: `${DIR}/manifest.json`, content: JSON.stringify(manifest) + '\n' },
      ]
      if (!state) changes.unshift({ op: 'mkdir', path: DIR })
      try {
        await provider?.assertSessionIdentity?.(sessionId)
        if (state) {
          const remote = await this.readManifest(project, branch)
          if (!state.digest || remote.digest !== state.digest || remote.count !== from) {
            throw new CliError('ArchiveConflict', 'The project archive differs from the last confirmed save, possibly after restore or another writer. Local history is retained; reconcile the archive before saving again.')
          }
        } else {
          await withoutTraceContext(() => this.lfs.branch.fork(project, branch, 'main')).catch((error: any) => {
            if (error?.code === 'Exists' || error?.code === 'NameTaken') throw new CliError('ArchiveConflict', 'An archive already exists for this conversation. Reconcile it before saving local history.')
            throw error
          })
        }
        if (state?.digest === digest && !state.error) return
        await withoutTraceContext(() => this.lfs.file.apply(project, branch, changes, { message: `dsh session ${sessionId.slice(0, 8)}: events ${from}..${at}` }))
        this.sessions.state.update((s) => { s.mirror[sessionId] = { project, branch, count: at, segments, updatedAt: Date.now(), digest } as any })
        await provider?.updateSidecar?.(sessionId, (value: any) => { value.title = sidecar.title; value.bindingKind = binding.kind; if (binding.parent) value.sharedParent = binding.parent; value.codeBranch = codeBranch; value.checkpoints = checkpoints; value.archive = sidecar.archive })
        this.ctx.layerfs.emit('layerfs-session', { sessionId })
      } catch (error: any) {
        this.sessions.state.update((s) => { s.mirror[sessionId] = { ...(state ?? { project, branch, count: from, segments: [] }), updatedAt: Date.now(), error: String(error?.message ?? error) } })
        await provider?.updateSidecar?.(sessionId, (value: any) => { value.archive = { count: from, updatedAt: Date.now(), error: String(error?.message ?? error) } })
        throw error
      }
    })
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

  /** The sessions stored in a project, joined with what this DSH has locally. */
  async discover(project: string): Promise<StoredSession[]> {
    const branches = await pages((paging) => this.lfs.branch.list(project, paging))
    const stored = branches.filter((b: any) => typeof b.name === 'string' && b.name.startsWith(STORE_PREFIX))
    const out: StoredSession[] = []
    for (const b of stored) {
      try {
        const manifest = await this.readManifest(project, b.name)
        out.push({
          sessionId: manifest.sessionId,
          projectId: manifest.projectId,
          title: manifest.title ?? null,
          branch: b.name,
          codeBranch: manifest.codeBranch ?? null,
          events: manifest.count ?? 0,
          checkpoints: (manifest.checkpoints ?? []).filter((c: any) => c.kind !== 'base' && c.kind !== 'restore' && c.commit && c.changed > 0).length,
          updatedAt: manifest.updatedAt ?? null,
          local: !!(await localPersistence(this.ctx)?.stat(manifest.sessionId).catch(() => undefined)),
          shared: manifest.bindingKind === 'shared' || manifest.header?.origin === 'subagent',
        })
        this.found.set(manifest.sessionId, project)
      } catch { /* a branch without a readable manifest is not a session */ }
    }
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
    const page = await withoutTraceContext(() => this.lfs.file.read(project, branch, `${DIR}/manifest.json`, { start_line: 1 }))
    let size: bigint | undefined
    if (typeof page.size === 'bigint' && page.size >= 0n) size = page.size
    else if (typeof page.size === 'number' && Number.isSafeInteger(page.size) && page.size >= 0) size = BigInt(page.size)
    else if (typeof page.size === 'string' && /^[0-9]{1,20}$/.test(page.size)) size = BigInt(page.size)
    if (page.kind === 'ok' && page.start_line === 1 && page.line_truncated === false && page.truncated === false && page.next_line === null && typeof page.text === 'string' && size === BigInt(Buffer.byteLength(page.text))) return JSON.parse(page.text)
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
    if (manifest.version === 2) {
      const text = await read(`${DIR}/session.jsonl`)
      const lines = text.split('\n').filter((line) => line.trim())
      const restore = sessionFormatCatalog.createRestore(JSON.parse(lines.shift()!), { recovery: 'strict', validation: 'current' })
      for (const line of lines) restore.decodeRow(JSON.parse(line))
      const artifact = restore.finish()
      header = artifact.header
      events = [...artifact.events]
      inheritedEventCount = artifact.inheritedEventCount
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
    if (sidecar) await provider?.updateSidecar?.(sessionId, (value: any) => Object.assign(value, sidecar))
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
      s.mirror[sessionId] = { project, branch, count: manifest.count ?? events.length, segments: manifest.segments ?? [], updatedAt: Date.now(), digest: manifest.digest }
    })
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
      for (const stored of await this.discover(project)) {
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
      await this.discover(project).catch(() => [])
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
