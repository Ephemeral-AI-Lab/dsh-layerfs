/**
 * The LayerFS session store: each session's log is kept inside its LayerFS
 * project (the Scratch project for sessions without one), so conversations
 * travel with the project (backups, Store push/pull, another DSH install on
 * the same Store).
 *
 *   branch  dsh.session.<session>   (forked from main; never mounted, never published)
 *   /.dsh/session/manifest.json     header, segment list, checkpoints, code branch
 *   /.dsh/session/segments/NNNNNN.jsonl   bounded slices of the event log
 *
 * DSH's local JSONL log stays the write-ahead copy the agent runs from; after
 * each turn the new events are appended here with one `file.apply` (one Commit).
 * A mirror failure never fails a turn: it is recorded and retried at the next
 * turn. Discovery lists a project's stored sessions; import rebuilds a session
 * that is missing locally in DSH's local log (`localPersistence`), and sync
 * imports every stored session of a project this DSH has a workspace for. The
 * session persistence row (`session-persistence.ts`) imports on demand when a
 * missing session is opened.
 */
import type { Context } from '@deepseek-ai/cordis'
import { realpathSync } from 'node:fs'
import { CliError, pages } from '../layerfs/cli.ts'
import type { LayerfsSessions } from './service.ts'

export const STORE_PREFIX = 'dsh.session.'
const DIR = '/.dsh/session'
const SEGMENT_EVENTS = 500
const SEGMENT_BYTES = 256 * 1024
const MISS_MS = 30_000

const compact = (sessionId: string) => sessionId.replace(/^session-/, '').replace(/[^A-Za-z0-9]/g, '').toLowerCase()
export const storeBranchOf = (sessionId: string) => `${STORE_PREFIX}${compact(sessionId)}`
const pad = (n: number) => String(n).padStart(6, '0')

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

  /** Append the session's new events to its project. */
  async mirror(sessionId: string): Promise<void> {
    const binding = this.sessions.binding(sessionId)
    if (!binding || binding.kind !== 'project' || !binding.project) return
    const session = (this.ctx.get('sessions' as never) as any)?.get(sessionId)
    if (!session) return
    await this.sessions.lane(`store:${sessionId}`, async () => {
      const project = binding.project!
      const branch = storeBranchOf(sessionId)
      const state = this.sessions.state.read().mirror[sessionId]
      const from = state?.count ?? 0
      const events = session.snapshotEvents(from) as unknown[]
      const segments = [...(state?.segments ?? [])]
      const changes: unknown[] = []
      let at = from
      for (let i = 0; i < events.length;) {
        const slice: string[] = []
        let size = 0
        while (i < events.length && slice.length < SEGMENT_EVENTS && size < SEGMENT_BYTES) {
          const line = JSON.stringify(events[i])
          slice.push(line); size += line.length + 1; i++
        }
        const file = `segments/${pad(segments.length + 1)}.jsonl`
        changes.push({ op: 'write', path: `${DIR}/${file}`, content: `${slice.join('\n')}\n` })
        segments.push({ file, from: at, to: at + slice.length })
        at += slice.length
      }
      const manifest = {
        version: 1,
        kind: 'dsh-session',
        sessionId,
        project,
        header: session.header,
        inheritedEventCount: session.inheritedEventCount ?? 0,
        title: this.titleOf(session),
        codeBranch: binding.branch ?? null,
        count: at,
        segments,
        checkpoints: this.sessions.checkpoints(sessionId),
        updatedAt: Date.now(),
      }
      if (!changes.length && state && JSON.stringify(state.segments) === JSON.stringify(segments) && state.count === at && state.updatedAt > (this.sessions.checkpoints(sessionId).at(-1)?.at ?? 0)) return
      changes.push({ op: 'write', path: `${DIR}/manifest.json`, content: `${JSON.stringify(manifest, null, 2)}\n` })
      if (!state?.segments?.length) changes.unshift({ op: 'mkdir', path: `${DIR}/segments` })
      try {
        if (!state) {
          await this.lfs.branch.fork(project, branch, 'main').catch((error: any) => { if (error?.code !== 'Exists' && error?.code !== 'NameTaken') throw error })
        }
        await this.lfs.file.apply(project, branch, changes, { message: `dsh session ${sessionId.slice(0, 8)}: events ${from}..${at}` })
        this.sessions.state.update((s) => { s.mirror[sessionId] = { project, branch, count: at, segments, updatedAt: Date.now() } })
        this.ctx.layerfs.emit('layerfs-session', { sessionId })
      } catch (error: any) {
        this.sessions.state.update((s) => { s.mirror[sessionId] = { ...(state ?? { project, branch, count: from, segments: [] }), updatedAt: Date.now(), error: String(error?.message ?? error) } })
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
          title: manifest.title ?? null,
          branch: b.name,
          codeBranch: manifest.codeBranch ?? null,
          events: manifest.count ?? 0,
          checkpoints: (manifest.checkpoints ?? []).filter((c: any) => c.kind !== 'base').length,
          updatedAt: manifest.updatedAt ?? null,
          local: !!(await localPersistence(this.ctx)?.stat(manifest.sessionId).catch(() => undefined)),
        })
        this.found.set(manifest.sessionId, project)
      } catch { /* a branch without a readable manifest is not a session */ }
    }
    return out
  }

  private async readText(project: string, branch: string, path: string): Promise<string> {
    let text = ''
    for (let start = 1; ;) {
      const page = await this.lfs.file.read(project, branch, path, { start_line: start })
      const lines = page.lines ?? page.content ?? page.text
      if (Array.isArray(lines)) text += lines.map((l: any) => (typeof l === 'string' ? l : l?.text ?? '') + '\n').join('')
      else if (typeof lines === 'string') text += lines
      const next = page.next_line ?? null
      if (!next || next <= start) break
      start = next
    }
    return text
  }

  async readManifest(project: string, branch: string): Promise<any> {
    return JSON.parse(await this.readText(project, branch, `${DIR}/manifest.json`))
  }

  /**
   * Rebuild a stored session in DSH's local session store. Its header's `cwd`
   * becomes this host's project anchor, so `classify` re-binds it to the
   * project. `workspaceId` lists it under a DSH workspace (the caller's
   * selected one, else the anchor's recorded workspace from before project
   * workspaces went away).
   */
  async import(project: string, sessionId: string, workspaceId?: string): Promise<{ sessionId: string, imported: boolean }> {
    return await this.sessions.lane(`import:${sessionId}`, () => this.importNow(project, sessionId, workspaceId))
  }

  private async importNow(project: string, sessionId: string, workspaceId?: string): Promise<{ sessionId: string, imported: boolean }> {
    const persistence = localPersistence(this.ctx)
    if (!persistence) throw new CliError('Unavailable', 'DSH session persistence is not available')
    if (await persistence.stat(sessionId).catch(() => undefined)) return { sessionId, imported: false }
    const branch = storeBranchOf(sessionId)
    const manifest = await this.readManifest(project, branch)
    if (manifest.sessionId !== sessionId) throw new CliError('InvalidInput', 'The stored manifest names another session')
    const anchor = this.sessions.ensureAnchor(project)
    const list = workspaceId ?? this.sessions.recordedWorkspace(project)
    const events: unknown[] = []
    for (const segment of manifest.segments ?? []) {
      const text = await this.readText(project, branch, `${DIR}/${segment.file}`)
      for (const line of text.split('\n')) if (line.trim()) events.push(JSON.parse(line))
    }
    let cwd = anchor
    try { cwd = realpathSync(anchor) } catch { /* keep */ }
    const header = { ...manifest.header, cwd }
    const handle = await persistence.create(header, manifest.inheritedEventCount ? { inheritedEventCount: manifest.inheritedEventCount } : undefined)
    try {
      if (events.length) await handle.append(events)
      await handle.flush?.()
    } finally {
      await handle.close?.()
    }
    // The session keeps its code branch and checkpoints; a new Sandbox mounts that branch on first use.
    this.sessions.state.update((s) => {
      s.checkpoints[sessionId] ??= manifest.checkpoints ?? []
      if (manifest.codeBranch && !s.sessions[sessionId]) {
        s.sessions[sessionId] = {
          sessionId, kind: 'project', project, anchor, scratch: `${anchor}/sessions/${sessionId}`, machine: 'native',
          branch: manifest.codeBranch, sandbox: `dsh-${compact(sessionId).slice(0, 20)}`, ws: `dsh-${compact(sessionId).slice(0, 20)}:main`,
          state: 'closed', createdAt: Date.now(), updatedAt: Date.now(),
        }
      }
      s.mirror[sessionId] = { project, branch, count: manifest.count ?? events.length, segments: manifest.segments ?? [], updatedAt: Date.now() }
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
      for (const stored of await this.discover(project)) {
        if (stored.local) continue
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
    return this.sessions.state.read().mirror[sessionId]?.project ?? this.found.get(sessionId)
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
