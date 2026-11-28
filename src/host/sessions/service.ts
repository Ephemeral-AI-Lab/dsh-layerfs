/**
 * Project-owned sessions use a private LayerFS execution context and a selected
 * local folder as scratch. Normal sessions retain stock DSH behavior.
 *
 * Explicit bindings, pending choices, and durable persistence ownership select
 * the project; recorded legacy anchors are supported for migration only.
 * Host-machine and remote projects both use scratch as the local working directory.
 * Subagents share their parent's project execution context and scratch folder.
 * Conversation forks start project files from the matching saved checkpoint.
 *
 * Changed turns save through workspace.commit. Saved-version annotations retain
 * exact tool/host provenance alongside the original native DSH conversation.
 * Branches and sandbox handles are internal implementation details.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { CliError, pages, sandboxWorkspaces, type Lfs } from '../layerfs/cli.ts'
import { JsonFile } from '../service.ts'
import { initialState, type Binding, type Checkpoint, type SessionsState, type SimulationBinding, type SimulationTarget } from './state.ts'
import type { SessionStore } from './store.ts'
import { withTraceContext, type Invocation } from '../layerfs/tracing.ts'
import { classifyStore, storeOf, type StoreHealth } from './availability.ts'
import type { SessionFailure } from '../../shared/pg-failure.ts'
import { branchFields, type BranchFields } from '../../shared/session-branch.ts'
import { attachedFrom, lastUsed, pgPlacement } from '../placement.ts'
import { HOST_MACHINE, isHostName, machineRows } from '../layerfs/machine-records.ts'

/** The Scratch folder's README (`<state>/scratch`). */
const SCRATCH_README = `# Scratch

The DSH x LayerFS Scratch folder. Project sessions start here, and each gets
its own scratch folder inside it (\`session-<id>/\`) unless you pick another
folder for it. Scratch files are never saved into the project.
`

/** How long a passed identity and readiness check stands for pre-step checks. */
const IDENTITY_FRESH_MS = 15_000

/**
 * How long a successful observed identity check (project.get + branch.list)
 * stands while the views poll. They read `session.state {observe: true}` every
 * SESSION_POLL_MS (10 s, src/client/views/model.ts) through a 500 ms coalescing
 * timer, so consecutive polls are ~10.5 s apart; 12 s clears that cadence with
 * margin for scheduling jitter. Each observed read that reuses the check renews
 * this window, so a steady poll pays only the Workspace status read instead of
 * re-reading identity every time.
 */
const OBSERVED_IDENTITY_MS = 12_000

/**
 * The longest a renewed identity check may stand without a fresh read. A poll
 * renewing OBSERVED_IDENTITY_MS would otherwise leave an identity branch
 * changed by another installation unread for as long as a view stays open; one
 * real check a minute bounds it. Identity changes this host sees (a save, bind,
 * mount, detach, restore or interrupt) clear the memo at once regardless.
 */
const OBSERVED_IDENTITY_FULL_MS = 60_000

/**
 * How long a successful observed machine + Store readiness check stands when a
 * poll does not follow. Both change rarely and every change this host sees
 * clears it (`machinesStopped`, a Store health transition, a save or interrupt).
 * An observed read that reuses the check renews this window, so a steady poll
 * keeps it instead of re-reading the machine and Store every 30 s.
 */
const OBSERVED_READY_MS = 30_000

/**
 * The longest a renewed readiness check may stand without a fresh read. A
 * machine stopped or a Store lost from outside this host is the change no local
 * invalidation sees, and this bounds how long a polling view may show it as
 * ready; the first check still stands only this long regardless of renewals.
 * Identity shares this ceiling. A steady poll renews both checks, so their hard
 * re-checks are deliberately allowed to fall on the same poll: one 5-CLI full
 * pass a minute rather than two separate 3-CLI passes. Do not lengthen either
 * window; 60 s is the freshness bound.
 */
const OBSERVED_READY_FULL_MS = 60_000

/**
 * How long an observed answer stands while the session's local revision does
 * not change. Kept under the views' 10 s poll: a repeat inside the window costs
 * no CLI call, while the poll still reads the Workspace status and the mount, so
 * an unsaved file or a lost mount shows within one poll as before.
 */
const OBSERVED_MEMO_MS = 8_000

/** A Store of this LayerFS home; `id` when the CLI reports Store identity. */
export interface HomeStore { name: string, id?: string }

declare module '@deepseek-ai/cordis' {
  interface Context {
    layerfsSessions: LayerfsSessions
  }
}

/** Names LayerFS accepts for branches and sandboxes, derived from a session id. */
const compact = (sessionId: string) => sessionId.replace(/^session-/, '').replace(/[^A-Za-z0-9]/g, '').toLowerCase()
export const branchOf = (sessionId: string, generation = 0) => `dsh.${compact(sessionId)}${generation ? `.r${generation}` : ''}`
export const sandboxOf = (sessionId: string) => `dsh-${compact(sessionId).slice(0, 20)}`
const WS_NAME = 'main'

const real = (path: string): string => { try { return realpathSync(path) } catch { return path } }
const errorOf = (error: any) => ({ code: String(error?.code ?? 'Failed'), message: String(error?.message ?? error) })
const exists = (error: any) => error?.code === 'Exists'

/** Where a session works: a LayerFS project, its parent's Workspace, or a plain folder (stock DSH). */
export type Place =
  | { readonly kind: 'project', readonly project: string, readonly anchor: string }
  | { readonly kind: 'shared', readonly parent: string, readonly anchor: string }
  | { readonly kind: 'folder', readonly cwd: string }

/** A binding as the views read it: the host also names the branch kind. */
export type ViewBinding = Binding & BranchFields

/** Where one observed read spent its time, for `session.state {debug: true}`. */
export interface SessionViewTiming {
  /** Wall time in ms by step; `other` is the host-side remainder of `total`. */
  readonly phases: Record<string, number>
  /** CLI calls this read issued by step (0 when a remembered pass answered). */
  readonly calls: { readonly identity: number, readonly readiness: number, readonly status: number }
  /** Whether the answer came from the memo (no CLI call at all). */
  readonly memo: boolean
}

/** The state a session panel shows. */
export interface SessionView {
  readonly sessionId: string
  readonly binding: ViewBinding | null
  readonly checkpoints: readonly Checkpoint[]
  readonly project: string | null
  readonly status: unknown
  readonly mirror: unknown
  readonly execution?: { state: 'inactive' | 'activating' | 'active' | 'interrupted', available: boolean, reason?: string, projectId?: string }
  readonly archive: { localCount: number, savedCount: number, updatedAt?: number, error?: string } | null
  /** Opt-in (`debug: true`): where an observed read spent its time. */
  readonly timing?: SessionViewTiming
}

/** Whether a session has not started its first turn (its preset can still change). */
const isFresh = (agent: any): boolean => !agent.session.snapshotEvents(0).some((e: any) => e.type === 'turn/start')

/**
 * The events a conversation's log may hold when it has never started: the
 * header `session` line and creation/opening metadata. Any message, turn,
 * title, request or tool event means it has started and is never pruned.
 */
const BLANK_EVENTS = new Set(['session', 'permission/preset', 'sandbox/mode', 'approval/policy', 'agent-preset/selected', 'session/end-seed'])
/** A blank log holds a handful of those events; a longer one is a conversation (and is never read in full). */
const BLANK_EVENTS_MAX = 64

/** Whether a log's events are only creation metadata: no message, title or turn (conservative: unknown events mean started). */
export function neverStartedLog(events: readonly any[]): boolean {
  if (events.length > BLANK_EVENTS_MAX) return false
  for (const event of events) if (!BLANK_EVENTS.has(String(event?.type ?? ''))) return false
  return true
}

/** A real title: a non-empty string. "New session" is a client display fallback, never a stored title. */
export function realSessionTitle(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/**
 * What {@link LayerfsSessions.neverStarted} was given by a caller that already
 * read the snapshot and sidecar (a list reads both anyway).
 */
export interface NeverStartedKnown { snapshot?: any, sidecar?: any }

export class LayerfsSessions extends Service {
  static inject = ['layerfs', 'layerfsRemote', 'workspaceRegistry', 'workingDirectory', 'sessions']
  readonly state: JsonFile<SessionsState>
  /** One operation at a time per session (bind, checkpoint, restore). */
  private readonly lanes = new Map<string, Promise<unknown>>()
  /** The LayerFS session store, while the sessions area is up (the persistence row imports through it). */
  store: SessionStore | undefined
  /** Last observed health of each Store a project conversation uses (read-only polling). */
  private readonly storeHealth = new Map<string, StoreHealth>()
  /** When each PostgreSQL Store's server was last asked (one connection per ask). */
  private readonly serverChecked = new Map<string, number>()
  private availabilityRun: Promise<void> | undefined
  /** Successful observed identity checks by owner, with the row facts they answered. */
  private freshIdentity?: Map<string, { at: number, checkedAt: number, project: string, machine?: string, row: { kind?: string | null, machine?: string | null, store: string } }>
  /** Successful observed machine + Store readiness checks by owner. */
  private freshReadiness?: Map<string, { at: number, checkedAt: number, project: string, machine: string, store: string }>
  /** The last observed answer per requested session, keyed by the revision it answered. */
  private observedAnswers?: Map<string, { at: number, revision: string, ownerId: string, project: string, machine?: string, view: SessionView }>
  /** Project ids read for sessions.places, reused for the same window. */
  private freshProjectIds?: Map<string, { at: number, id?: string }>

  constructor(ctx: Context) {
    super(ctx, 'layerfsSessions')
    this.state = new JsonFile(join(ctx.layerfs.state, 'sessions', 'state.json'), initialState)
  }

  get lfs(): Lfs { return this.ctx.layerfs.lfs }

  /** Separate installations may resume one archived conversation in the same home. */
  private simulationSandbox(sessionId: string): string {
    const installation = this.ctx.layerfs.install?.slice(0, 10) ?? createHash('sha256').update(this.ctx.layerfs.state).digest('hex').slice(0, 10)
    return `${sandboxOf(sessionId)}-${installation}`
  }

  /** Serialize work per session. */
  lane<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
    const next = (this.lanes.get(sessionId) ?? Promise.resolve()).then(run, run)
    this.lanes.set(sessionId, next.catch(() => {}))
    return next
  }

  /** Wait until the session's queued operations (an owner choice, a bind) finish. */
  async settled(sessionId: string): Promise<void> {
    let current: Promise<unknown> | undefined
    while ((current = this.lanes.get(sessionId))) {
      await current
      if (this.lanes.get(sessionId) === current) return
    }
  }

  // ------------------------------------------------------------- workspaces

  /**
   * The parent of a project session's default scratch folder: the Scratch
   * folder `<state>/scratch` for every project (docs/specs/layerfs-folder.md
   * §4). Bindings made before it keep the anchor they recorded.
   */
  anchorOf(project: string): string {
    const [store, name] = project.split('/')
    if (!store || !name || project.split('/').length !== 2) throw new CliError('InvalidInput', `Not a project key: ${project}`)
    return this.scratchAnchor
  }

  get scratchAnchor(): string { return join(this.ctx.layerfs.state, 'scratch') }

  private writeAnchor(dir: string, text: string): void {
    mkdirSync(dir, { recursive: true })
    const readme = join(dir, 'README.md')
    if (!existsSync(readme) || readFileSync(readme, 'utf8') !== text) writeFileSync(readme, text)
  }

  /**
   * Record a project this install works in (`state.projects`: the projects an
   * open-by-id searches) and make the Scratch folder its sessions' default
   * scratch folders go in; answers that folder.
   */
  ensureAnchor(project: string): string {
    const anchor = this.anchorOf(project)
    this.writeAnchor(anchor, SCRATCH_README)
    this.state.update((s) => { s.projects[project] ??= { project, anchor, createdAt: Date.now() } })
    return anchor
  }

  /** The anchor a recorded project entry points at, once workspaces held them. */
  recordedWorkspace(project: string): string | undefined {
    return this.state.read().projects[project]?.workspaceId
  }

  /** List a session (an imported one) under a DSH workspace. Never throws. */
  async attach(workspaceId: string | undefined, sessionId: string): Promise<void> {
    if (this.placeOfId(sessionId)?.project) { await this.detach(sessionId); return }
    if (!workspaceId) return
    try {
      await this.ctx.workspaceRegistry.get(workspaceId as never)?.attachSession(sessionId as never)
    } catch (error: any) {
      this.ctx.logger('layerfs').warn('session %s not listed in workspace %s: %s', sessionId, workspaceId, error?.message ?? error)
    }
  }

  /** Project ownership is independent of the folder selected as local scratch. */
  async detach(sessionId: string): Promise<void> {
    for (const workspace of this.ctx.workspaceRegistry?.list?.() ?? []) {
      if (workspace.sessionIds.includes(sessionId as never)) await workspace.detachSession(sessionId as never)
    }
  }

  /** Change the local folder's scratch role without moving project ownership. */
  async selectScratch(sessionId: string, cwd: string): Promise<void> {
    if (!this.placeOfId(sessionId)?.project) throw new CliError('InvalidInput', 'Select a LayerFS project before choosing its scratch folder')
    if (!isAbsolute(cwd) || !existsSync(cwd) || !statSync(cwd).isDirectory()) throw new CliError('ScratchUnavailable', 'Select an existing absolute local directory')
    const agent = (this.ctx.get?.('agents' as never) as any)?.get?.(sessionId)
    if (!agent) throw new CliError('Unavailable', 'Open this project session before changing its scratch folder')
    const binding = this.binding(sessionId)
    if (binding?.kind === 'shared') throw new CliError('InvalidInput', 'Choose the scratch folder on the parent project session')
    if (binding?.mount && (real(cwd) === real(binding.mount) || real(cwd).startsWith(`${real(binding.mount)}/`))) {
      throw new CliError('InvalidInput', 'Choose a local scratch folder outside the project mount')
    }
    await this.moveTo(agent, real(cwd))
    if (binding) this.save({ ...binding, scratch: real(cwd), scratchManaged: false })
    // Not bound yet: the pick waits on the pending placement and wins over a new folder at the first bind.
    else this.state.update((s) => { const pending = s.pending[sessionId]; if (pending) pending.scratch = real(cwd) })
    for (const child of Object.values(this.state.read().sessions)) {
      if (child.kind !== 'shared' || child.parent !== sessionId) continue
      const childAgent = (this.ctx.get?.('agents' as never) as any)?.get?.(child.sessionId)
      if (childAgent) await this.moveTo(childAgent, real(cwd))
      this.save({ ...child, scratch: real(cwd), scratchManaged: false })
    }
    this.ctx.layerfs.emit('layerfs-session', { sessionId })
  }

  /** Ensure the Scratch workspace: a plain folder workspace for sessions without a project. */
  async ensureScratchWorkspace(): Promise<{ workspaceId: string, anchor: string }> {
    const anchor = this.scratchAnchor
    this.writeAnchor(anchor, SCRATCH_README)
    const workspace = await this.ctx.workspaceRegistry.create(anchor, 'Scratch')
    if (workspace.title !== 'Scratch') await workspace.setTitle('Scratch')
    await this.retitleMovedScratch()
    return { workspaceId: String(workspace.id), anchor }
  }

  /** The Scratch workspace an older build registered (`<old state>/scratch`) is titled so it is not taken for this one. */
  private async retitleMovedScratch(): Promise<void> {
    const from = this.ctx.layerfs.migratedFrom
    if (!from) return
    const old = join(from, 'scratch')
    for (const workspace of this.ctx.workspaceRegistry?.list?.() ?? []) {
      if (workspace.path === old && workspace.title === 'Scratch') await workspace.setTitle('Scratch (before the move)').catch(() => {})
    }
  }

  /**
   * Record the project a session works in — the New Session control or a
   * Projects page names the blank/folder session it belongs to. `project`
   * `null` clears the choice; a recorded binding always outranks the pending
   * one, so a bound session cannot be re-placed this way.
   */
  async choose(sessionId: string, project: string | null, projectId?: string, machine?: string): Promise<void> {
    // The choice runs in the session's lane, and pre-step waits for the lane
    // before resolving the place: a first message sent while the choice is in
    // flight runs under the chosen owner, never as the previous one.
    await this.lane(sessionId, () => this.chooseNow(sessionId, project, projectId, machine))
  }

  private async chooseNow(sessionId: string, project: string | null, projectId?: string, machine?: string): Promise<void> {
    const live = this.ctx.sessions.get(sessionId as never) as any
    const bound = this.binding(sessionId)
    const persistence = this.ctx.get?.('sessionPersistence' as never) as any
    const previous = bound?.project ?? this.state.read().pending[sessionId]?.project ?? persistence?.ownerOf?.(sessionId)?.project ?? null
    let started = live?.snapshotEvents(0).some((e: any) => e.type === 'turn/start') ?? false
    if (!live && persistence?.local && await persistence.local.stat(sessionId)) {
      const reader = await persistence.local.open(sessionId, 'read')
      try { started = (await reader.read()).events.some((e: any) => e.type === 'turn/start') } finally { await reader.close() }
    }
    if (previous !== project && (bound || started)) {
      throw new CliError('SessionStarted', 'Start a new session to change its project or switch to normal workspace mode')
    }
    if (!project && previous && live) {
      const original = live.header?.cwd
      if (!original || !isAbsolute(original) || !existsSync(original) || !statSync(original).isDirectory()) {
        throw new CliError('WorkspaceUnavailable', 'Start a normal session in an existing local workspace')
      }
      const agent = (this.ctx.get?.('agents' as never) as any)?.get?.(sessionId)
      if (agent) await this.moveTo(agent, original)
    }
    if (project) {
      // Choosing places the session: the one place an unclaimed project is claimed.
      if (projectId) await persistence?.catalog?.assert(project, projectId, { claim: true })
      await this.lfs.project.get(project); this.ensureAnchor(project)
    }
    const ownerBefore = persistence?.ownerOf?.(sessionId)?.project ?? null
    await persistence?.migrateProject?.(live ?? sessionId, project)
    const written = project ? { project, ...(machine ? { machine } : {}) } : undefined
    // A placement change can change the place (and with it identity/readiness).
    this.forgetFreshReads(sessionId)
    this.state.update((s) => {
      // A scratch folder picked before the first turn stays picked across project changes.
      const picked = s.pending[sessionId]?.scratch
      if (written) s.pending[sessionId] = picked ? { ...written, scratch: picked } : written
      else delete s.pending[sessionId]
    })
    try {
      // The New Session row's preset chip follows the choice before the first
      // turn: a project session runs the `layerfs` preset, a plain one the default.
      const agent = live ? (this.ctx.get?.('agents' as never) as any)?.get?.(sessionId) : undefined
      if (agent && previous !== project) await this.selectPreset(agent, !project)
      // DSH reuses a blank session only while it remains a candidate of the
      // selected workspace. Remove membership at pre-step, after materialization.
      if (project && bound) await this.detach(sessionId)
      else if (!project && live?.header?.cwd) {
        const workspace = this.ctx.workspaceRegistry?.list?.().find((w) => real(w.path) === real(live.header.cwd))
        if (workspace) await workspace.attachSession(sessionId as never)
      }
      this.ctx.layerfs.emit('layerfs-session', { sessionId })
    } catch (error) {
      // A choice that fails after writing its pending placement leaves no half
      // placement behind, so a retry starts clean. A claimed project identity
      // stays: it is intentional and shared by every conversation of the project.
      if (written) this.state.update((s) => {
        const pending = s.pending[sessionId]
        if (pending && pending.project === written.project && (pending.machine ?? undefined) === (written.machine ?? undefined)) delete s.pending[sessionId]
      })
      // The owner route moved with the choice: move it back, or the draft stays
      // owned by a project no pending placement names (pruneNeverStarted skips it).
      if ((persistence?.ownerOf?.(sessionId)?.project ?? null) !== ownerBefore) {
        await persistence.migrateProject(live ?? sessionId, ownerBefore).catch((undo: any) => this.ctx.logger('layerfs').warn('session %s: owner not restored after a failed choice: %s', sessionId, undo?.message ?? undo))
      }
      throw error
    }
  }

  /**
   * Read-only check of what placing a new conversation in `project` needs: the
   * identity the client listed (`projectId`, when it has one), the project
   * itself, and the machine and Store its Sandbox would use. Nothing is
   * claimed or written and no session is touched. Throws the same refusal the
   * placement would, so the client can stop before creating a session.
   */
  async checkPlacement(project: string, projectId?: string, machine?: string): Promise<{ ok: true }> {
    const persistence = this.ctx.get?.('sessionPersistence' as never) as any
    // The same two checks `chooseNow` makes before it writes anything: the
    // listed identity still names this project, and the project is readable.
    const row = projectId ? await persistence?.catalog?.assert(project, projectId, { claim: false }) : undefined
    const info: any = await this.lfs.project.get(project, { detail: true })
    const kind = row?.kind ?? info?.engine ?? null
    // A PostgreSQL project's machine is chosen per session when it is bound
    // (`machineFor`, as `mount` does): the picked one, else its last Sandbox's.
    const effective = kind === 'postgresql' ? await this.machineFor(project, machine) : undefined
    // A PostgreSQL project's machine is per session: when none is picked and the
    // Store has no single attached machine, say so here rather than checking a
    // machine (the host machine) that nothing attached to this Store.
    if (kind === 'postgresql' && !effective) throw this.unplaced(project)
    await this.assertReady({
      kind,
      machine: row?.machine ?? info?.machine ?? null,
      store: row?.store ?? info?.store ?? storeOf(project)!,
    }, effective)
    return { ok: true }
  }

  /**
   * Where a session works. In order: its existing binding; a bound parent's
   * Workspace (a subagent); the project it was placed in (`state.pending`);
   * a project anchor's `cwd` (a legacy project workspace or an imported
   * session); the place of the session it was forked from; otherwise a plain
   * folder (stock DSH).
   */
  placeOf(session: any): Place {
    const sessionId = String(session.id)
    const header = session.header ?? {}
    const existing = this.binding(sessionId)
    if (existing?.kind === 'shared' && existing.parent) return { kind: 'shared', parent: existing.parent, anchor: existing.anchor }
    if (existing?.project) return { kind: 'project', project: existing.project, anchor: existing.anchor }
    if (existing) return { kind: 'folder', cwd: existing.anchor }
    const parent = header.parentSession ? this.binding(String(header.parentSession)) : undefined
    if (header.origin === 'subagent' && parent) return { kind: 'shared', parent: String(header.parentSession), anchor: header.cwd }
    const pending = this.state.read().pending[sessionId]
    if (pending?.project) return { kind: 'project', project: pending.project, anchor: this.anchorOf(pending.project) }
    const owner = (this.ctx.get?.('sessionPersistence' as never) as any)?.ownerOf?.(sessionId)
    if (owner?.project) return { kind: 'project', project: owner.project, anchor: this.anchorOf(owner.project) }
    if (parent?.project) return { kind: 'project', project: parent.project, anchor: parent.anchor }
    return { kind: 'folder', cwd: String(header.cwd ?? '') }
  }

  /**
   * The project a session works in, for the New Session control and the sidebar
   * row mark. A live session is asked for its place; one that is only
   * persisted answers from its recorded binding or its pending choice.
   */
  placeOfId(sessionId: string): { project: string | null, scratch?: string } | null {
    const persisted = this.binding(sessionId)
    const session = this.ctx.sessions.get(sessionId as never) as any
    if (!session) {
      if (persisted?.kind === 'shared') return { project: this.binding(String(persisted.parent))?.project ?? persisted.project ?? null }
      if (persisted) return { project: persisted.project ?? null, ...(persisted.project ? { scratch: persisted.scratch } : {}) }
      const pending = this.state.read().pending[sessionId]?.project
      const owner = (this.ctx.get?.('sessionPersistence' as never) as any)?.ownerOf?.(sessionId)
      return pending || owner?.project ? { project: pending ?? owner.project } : null
    }
    const place = this.placeOf(session)
    if (place.kind === 'shared') return { project: this.binding(place.parent)?.project ?? null }
    if (place.kind === 'folder') return { project: null }
    return { project: place.project, scratch: persisted?.scratch ?? this.ctx.workingDirectory?.get?.(session) ?? session.header?.cwd }
  }

  // ------------------------------------------------------------- binding

  binding(sessionId: string): Binding | undefined { return this.state.read().sessions[sessionId] }

  /**
   * Whether an in-memory record (a binding, a pending choice, a live session)
   * names this id. `sessions.places` uses it to skip ids no session can know
   * before asking the ownership index.
   */
  knows(sessionId: string): boolean {
    const state = this.state.read()
    return !!state.sessions[sessionId] || !!state.pending[sessionId] || !!this.ctx.sessions?.get?.(sessionId as never)
  }
  checkpoints(sessionId: string): Checkpoint[] { return this.state.read().checkpoints[sessionId] ?? [] }

  simulationOf(sessionId: string): SimulationBinding | undefined {
    return this.binding(sessionId)?.simulation ?? this.state.read().pending[sessionId]?.simulation
  }

  /** Must precede agent creation so ownership is known before its first hook. */
  async prepareSimulation(sessionId: string, project: string, metadata: Omit<SimulationBinding, 'state'> & { state?: SimulationBinding['state'] }): Promise<void> {
    const previous = this.placeOfId(sessionId)?.project
    if (previous && previous !== project) throw new CliError('SessionStarted', 'A script cannot change the session project')
    const current = this.binding(sessionId)
    if (current?.ws || (current?.simulation && (current.simulation.runId !== metadata.runId || current.simulation.scriptId !== metadata.scriptId))) {
      throw new CliError('SessionStarted', 'Start a fresh project session for a different script')
    }
    this.ensureAnchor(project)
    const simulation: SimulationBinding = { ...metadata, state: metadata.state ?? 'running', handoffReady: false }
    this.forgetFreshReads(sessionId)
    this.state.update((s) => {
      s.pending[sessionId] = { project, simulation }
      if (s.sessions[sessionId]) s.sessions[sessionId].simulation = simulation
    })
    const persistence = this.ctx.get?.('sessionPersistence' as never) as any
    await persistence?.migrateProject?.(sessionId, project)
  }

  /** Final metadata precedes a fresh archive; normal mounting happens lazily. */
  async completeSimulation(sessionId: string, target: SimulationTarget | undefined, state: SimulationBinding['state'], error?: string): Promise<void> {
    await this.lane(sessionId, async () => {
      const simulation = this.simulationOf(sessionId)
      if (!simulation) throw new CliError('NotFound', 'This session has no script binding')
      if (target && (!['Commit', 'Layer'].includes(target.kind) || !/^[a-f0-9]{66}$/.test(target.id) || !target.branch)) throw new CliError('InvalidInput', 'A confirmed saved-version target is required')
      const next = { ...simulation, state, continuation: target, handoffReady: !!target, error }
      this.state.update((s) => {
        if (s.sessions[sessionId]) s.sessions[sessionId].simulation = next
        if (s.pending[sessionId]) s.pending[sessionId].simulation = next
      })
      await this.persistMetadata(sessionId)
    })
    // Caller restores the native model selection before calling this method.
    this.store?.schedule(sessionId, 0)
  }

  /**
   * Whether a script owns this session right now (running, stopping or handing
   * off in this host). Any terminal state, a restart or an import leaves the
   * session free for a real model; the script never runs again.
   */
  isSimulationManaged(sessionId: string): boolean {
    const simulation = this.simulationOf(sessionId)
    if (!simulation || simulation.state !== 'running') return false
    return (this.ctx.get?.('layerfsSimulations' as never) as any)?.isActive?.(sessionId) === true
  }

  /**
   * Clear an owner's remembered reads: a saved binding (a mount, a detach, an
   * interrupt, an activation) can change what identity+readiness would answer.
   * A memo of the owner or of a subagent placed under it goes too.
   */
  private forgetFreshReads(sessionId: string): void {
    this.freshIdentity?.delete(sessionId)
    this.freshReadiness?.delete(sessionId)
    this.freshProjectIds?.delete(sessionId)
    for (const [id, entry] of this.observedAnswers ?? []) {
      if (id === sessionId || entry.ownerId === sessionId) this.observedAnswers!.delete(id)
    }
  }

  /** Clear remembered reads whose project or machine a transition may have invalidated. */
  private clearFreshReads(test: (entry: { project: string, machine?: string }) => boolean): void {
    for (const [sessionId, entry] of this.freshIdentity ?? []) if (test(entry)) this.freshIdentity!.delete(sessionId)
    for (const [sessionId, entry] of this.freshReadiness ?? []) if (test(entry)) this.freshReadiness!.delete(sessionId)
    for (const [sessionId, entry] of this.observedAnswers ?? []) if (test(entry)) this.forgetFreshReads(sessionId)
  }

  /**
   * The row a successful observed identity pass returned, while it still stands
   * for this binding. A reuse renews the poll window; the first check still
   * stands only OBSERVED_IDENTITY_FULL_MS.
   */
  private observedIdentity(ownerId: string, binding: Binding | null | undefined): { kind?: string | null, machine?: string | null, store: string } | undefined {
    const entry = (this.freshIdentity ??= new Map()).get(ownerId)
    if (!entry) return undefined
    const now = Date.now()
    if (now - entry.at >= OBSERVED_IDENTITY_MS || now - entry.checkedAt >= OBSERVED_IDENTITY_FULL_MS) { this.freshIdentity.delete(ownerId); return undefined }
    if (!binding?.project || entry.project !== binding.project || entry.machine !== binding.machine) return undefined
    entry.at = now
    return entry.row
  }

  /** Remember a successful observed identity pass; a refused pass never reaches here. */
  private rememberObservedIdentity(ownerId: string, binding: Binding | null | undefined, row: { kind?: string | null, machine?: string | null, store: string }): void {
    if (!binding?.project) return
    const now = Date.now()
    ;(this.freshIdentity ??= new Map()).set(ownerId, { at: now, checkedAt: now, project: binding.project, machine: binding.machine, row: { kind: row.kind, machine: row.machine, store: row.store } })
  }

  /** The machine and Store a readiness check reads for one identity row (assertReady's own rule). */
  private readyTargets(row: { kind?: string | null, machine?: string | null, store: string }, placed?: string | null): { machine: string, store: string } {
    return { machine: row.kind === 'postgresql' ? (placed ?? HOST_MACHINE) : (row.machine ?? HOST_MACHINE), store: row.store }
  }

  /**
   * Whether a successful observed readiness check still stands for this binding
   * and identity row. A reuse renews the poll window; the check still stands at
   * most OBSERVED_READY_FULL_MS after it was read.
   */
  private observedReadiness(ownerId: string, binding: Binding | null | undefined, row: { kind?: string | null, machine?: string | null, store: string }): boolean {
    const entry = (this.freshReadiness ??= new Map()).get(ownerId)
    if (!entry) return false
    const now = Date.now()
    if (now - entry.at >= OBSERVED_READY_MS || now - entry.checkedAt >= OBSERVED_READY_FULL_MS) { this.freshReadiness.delete(ownerId); return false }
    const target = this.readyTargets(row, binding?.machine)
    if (!binding?.project || entry.project !== binding.project || entry.machine !== target.machine || entry.store !== target.store) return false
    entry.at = now
    return true
  }

  /** Remember a successful observed readiness check; a refused pass never reaches here. */
  private rememberObservedReadiness(ownerId: string, binding: Binding | null | undefined, row: { kind?: string | null, machine?: string | null, store: string }): void {
    if (!binding?.project) return
    const target = this.readyTargets(row, binding.machine)
    const now = Date.now()
    ;(this.freshReadiness ??= new Map()).set(ownerId, { at: now, checkedAt: now, project: binding.project, machine: target.machine, store: target.store })
  }

  /**
   * What an observed answer depends on, from local state only: the binding and
   * checkpoints it shows, the live log length, the mirror and the Store health.
   * Equal revisions answer identically, so a repeat can reuse the answer.
   */
  private observedRevision(sessionId: string, ownerId: string, binding: Binding | null | undefined, persistence: any): string {
    const state = this.state.read()
    const checkpoints = state.checkpoints[ownerId] ?? []
    const last = checkpoints[checkpoints.length - 1]
    const mirror = state.mirror[ownerId]
    const live = this.ctx.sessions?.get?.(sessionId as never) as any
    const seq = typeof live?.seq === 'number' ? live.seq : live?.snapshotEvents ? live.snapshotEvents(0).length : ''
    const store = binding?.project ? storeOf(binding.project) : undefined
    const health = store ? this.storeHealth?.get(store) : undefined
    return [
      binding?.updatedAt ?? '', binding?.state ?? '', binding?.executionState ?? '', binding?.branch ?? '',
      binding?.ws ?? '', binding?.mount ?? '', binding?.restores ?? '', binding?.error ?? '', binding?.interruption?.at ?? '',
      seq, checkpoints.length,
      last ? `${last.kind}:${last.turn}:${last.endSeq ?? ''}:${last.commit ?? ''}:${last.changed}` : '',
      mirror ? `${mirror.count}:${mirror.updatedAt}:${mirror.error ?? ''}` : '',
      health ? `${health.state}:${health.reason ?? ''}` : '',
      persistence?.projectIdOf?.(sessionId) ?? '', persistence?.projectIdOf?.(ownerId) ?? '',
    ].join('|')
  }

  /**
   * The project id recorded for a session, for sessions.places. It is local
   * routing metadata (no CLI call), but a batch asks for many at once and each
   * lookup re-reads the ownership index, so a second batch inside the window
   * reuses it. A missing id is remembered as missing.
   */
  projectIdFor(sessionId: string): string | undefined {
    const cache = (this.freshProjectIds ??= new Map())
    const entry = cache.get(sessionId)
    if (entry && Date.now() - entry.at < OBSERVED_READY_MS) return entry.id
    const id = (this.ctx.get?.('sessionPersistence' as never) as any)?.projectIdOf?.(sessionId) as string | undefined
    cache.set(sessionId, { at: Date.now(), id })
    return id
  }

  private save(binding: Binding): Binding {
    // a classified failure belongs to the error it was read from: a binding saved with another error (or none)
    // drops the failure it carried over (`...binding`), unless the caller set a new one with it
    const prior = this.binding(binding.sessionId)
    if (binding.failure && prior !== binding && prior?.failure === binding.failure && prior.error !== binding.error) delete binding.failure
    if (!binding.error) delete binding.failure
    binding.updatedAt = Date.now()
    this.state.update((s) => { s.sessions[binding.sessionId] = binding })
    this.forgetFreshReads(binding.sessionId)
    this.ctx.layerfs.emit('layerfs-session', { sessionId: binding.sessionId })
    return binding
  }

  private async record(sessionId: string, checkpoint: Checkpoint): Promise<void> {
    this.state.update((s) => { (s.checkpoints[sessionId] ??= []).push(checkpoint) })
    await this.persistMetadata(sessionId)
    this.ctx.layerfs.emit('layerfs-checkpoint', { sessionId, checkpoint })
  }

  private async persistMetadata(sessionId: string): Promise<void> {
    const persistence = this.ctx.get?.('sessionPersistence' as never) as any
    await persistence?.updateSidecar?.(sessionId, (sidecar: any) => {
      const binding = this.binding(sessionId)
      sidecar.codeBranch = binding?.kind === 'shared' && binding.parent ? this.binding(binding.parent)?.branch : binding?.branch
      sidecar.bindingKind = binding?.kind
      sidecar.sharedParent = binding?.kind === 'shared' ? binding.parent : undefined
      sidecar.checkpoints = this.checkpoints(sessionId)
      if (binding?.simulation) sidecar.simulation = binding.simulation
    })
  }

  /**
   * Run host calls in `sessionId`'s trace context: each call gets a receipt
   * (and the log tag `dsh:<sessionId>:<receipt>`); `onInvocation` sees each
   * receipt before it is recorded, even when recording fails.
   */
  private hostOperation<T>(sessionId: string, project: string, turn: number | undefined, run: () => Promise<T>, onInvocation?: (invocation: Invocation) => void): Promise<T> {
    return withTraceContext({
      origin: 'host', sessionId, project, workspace: this.binding(sessionId)?.ws, turn,
      record: async (invocation) => {
        onInvocation?.(invocation)
        const persistence = this.ctx.get?.('sessionPersistence' as never) as any
        if (persistence?.recordInvocation) {
          await persistence.recordInvocation(invocation)
          this.ctx.layerfs.emit('layerfs-operation', { sessionId })
        }
      },
      // The counter sink is resolved here, through the context, not through
      // tracing.ts's process-wide registration: the persistence plugin is a
      // separate bundle with its own copy of that module, so a registration
      // made there never reaches the CLI calls this plugin makes.
      aggregate: async (invocation) => {
        const persistence = this.ctx.get?.('sessionPersistence' as never) as any
        if (persistence?.aggregateInvocation) await persistence.aggregateInvocation(invocation)
      },
      onError: (e) => this.ctx.logger('layerfs').warn('record host operation: %s', String(e)),
    }, run)
  }

  /** The refusal a PostgreSQL placement without a single attached machine gets (nothing is guessed). */
  private unplaced(project: string): CliError {
    return new CliError('InvalidInput', `Choose the machine this session runs on: Store ${storeOf(project)} has no single attached machine`, null, 'refusal', null)
  }

  /**
   * The machine a project's Sandboxes run on: a sqlite Store's machine; for a
   * PostgreSQL Store `preferred` (the session's own machine) when it has one,
   * else placement.ts's order: the project's last machine while attached, the
   * only machine attached to its Store, else null (the session's machine is
   * the person's pick: none attached, or several).
   */
  private async machineFor(project: string, preferred?: string | null): Promise<string | null> {
    const info: any = await this.lfs.project.get(project, { detail: true })
    if (info?.engine !== 'postgresql') return info?.machine ?? HOST_MACHINE
    if (preferred) return preferred
    const [machines, store, sandboxes] = await Promise.all([
      machineRows(this.lfs),
      this.lfs.store.get(storeOf(project)!, { detail: true }).catch(() => null),
      this.lfs.sandbox.list({ project, detail: true }).then((r: any) => r?.items ?? [], () => []),
    ])
    return pgPlacement(machines, { last: lastUsed(sandboxes), attached: attachedFrom(store) })
  }

  /**
   * Make sure the session's Sandbox runs and its Workspace is mounted on its
   * branch. Answers the mount's host path on the host machine; on any other machine the
   * mount lives inside the Sandbox, the session works through the LayerFS CLI
   * (`workspace.exec`, `file.*`) and its working directory stays its scratch
   * folder, so the answer is undefined.
   */
  private async mount(binding: Binding): Promise<string | undefined> {
    const held = this.ctx.layerfs.exclusive?.()
    if (held) throw new CliError('ConnectBusy', held)
    const { project, sandbox, branch } = binding as Required<Binding>
    const onHost = isHostName(binding.machine ?? HOST_MACHINE)
    if (onHost) await this.ctx.layerfs.ensureHostDaemon()
    let observed: any
    try { observed = await sandboxWorkspaces(this.lfs, sandbox) } catch (error: any) {
      if (error?.code !== 'NotFound') throw error
    }
    // a Sandbox whose daemon is gone (broken: lost, missing, not answering, unresolved) is removed and made again
    if (!observed || observed.state === 'broken') {
      if (observed) await this.lfs.sandbox.remove(sandbox, { force: true }).catch(() => {})
      const machine = binding.machine ?? HOST_MACHINE
      // `--machine` defaults to the Store's machine (a PostgreSQL project's: this computer)
      await this.lfs.sandbox.create(project, sandbox, !isHostName(machine) ? { machine } : {})
      observed = { workspaces: [] }
    }
    const handle = `${sandbox}:${WS_NAME}`
    const existing = (observed.workspaces ?? []).find((w: any) => w.workspace === handle)
    if (existing && existing.branch === branch && existing.path) {
      // Re-activating an interrupted binding (which dropped `ws`) over a Workspace that
      // is still mounted: restore the handle too, or every tool call stays refused
      // "Project execution is not active" (Quarry v2 FIX-LOG F23).
      binding.ws = handle
      return onHost ? existing.path : undefined
    }
    if (existing) await this.lfs.workspace.unmount(handle, { force: true, discard: false }).catch(() => this.lfs.workspace.unmount(handle, { force: true, discard: true }))
    const mounted = await this.lfs.workspace.mount(sandbox, branch, { name: WS_NAME, detail: true })
    binding.base ??= mounted.commit ?? mounted.base_layer ?? null
    if (typeof mounted.workspace === 'string') binding.ws = mounted.workspace
    return onHost ? mounted.path : undefined
  }

  /**
   * Recompose a project session's Agent under the `layerfs` preset while the
   * session is still blank. `leaving` instead moves a blank session that
   * leaves its project off `layerfs` (see {@link enforceFolderPreset}).
   */
  private async selectPreset(agent: any, leaving = false): Promise<void> {
    if (leaving) return this.enforceFolderPreset(agent)
    const presets = (this.ctx.get?.('agentPresets' as never) as any)
    if (!presets?.select || !isFresh(agent)) return
    try { await presets.select(agent, 'layerfs') } catch (error: any) {
      this.ctx.logger('layerfs').warn('session %s: layerfs preset not applied: %s', String(agent.id), error?.message ?? error)
    }
  }

  /**
   * The `layerfs` preset belongs to project sessions only. A blank session with
   * no project that ends up on it (picked in the New Session row, the configured
   * default, or left from a cleared project) moves to the default preset, or to
   * the first other working preset when `layerfs` is the default. A started
   * session keeps the composition its history was produced under.
   */
  async enforceFolderPreset(agent: any): Promise<void> {
    const presets = (this.ctx.get?.('agentPresets' as never) as any)
    if (!presets?.select || !agent?.session || !isFresh(agent)) return
    if (this.placeOf(agent.session).kind !== 'folder') return
    if (presets.presetForSession?.(agent.session) !== 'layerfs') return
    let wanted: string | undefined = presets.defaultId
    if (!wanted || wanted === 'layerfs') {
      const roster: any[] = await presets.list?.().catch(() => []) ?? []
      wanted = roster.find((p) => p.id !== 'layerfs' && !p.broken)?.id
    }
    if (!wanted) return
    try { await presets.select(agent, wanted) } catch (error: any) {
      this.ctx.logger('layerfs').warn('session %s: %s preset not applied: %s', String(agent.id), wanted, error?.message ?? error)
    }
  }

  /**
   * Bind a session's Agent to its place and move it into its Workspace.
   * With `strict` a failure throws (the step must not run outside the
   * Workspace); otherwise it is recorded on the binding and shown in the panel.
   */
  async bindAgent(agent: any, source: string, strict = false): Promise<void> {
    const sessionId = String(agent.id)
    const persistence = this.ctx.get?.('sessionPersistence' as never) as any
    if (!this.binding(sessionId) && persistence?.ownerOf?.(sessionId)) {
      const metadata = await persistence.readSidecar(sessionId)
      if (metadata?.simulation) {
        const simulation = { ...metadata.simulation }
        // Reopening history never restarts an unfinished script.
        if (simulation.state === 'running') { simulation.state = 'interrupted'; simulation.handoffReady = false; simulation.continuation = undefined }
        this.state.update((s) => { s.pending[sessionId] = { project: metadata.project, simulation } })
      }
      if (metadata?.bindingKind === 'shared' && metadata.sharedParent) {
        this.save({ sessionId, kind: 'shared', project: metadata.project, parent: metadata.sharedParent, anchor: this.anchorOf(metadata.project), scratch: '', state: 'closed', simulation: this.state.read().pending[sessionId]?.simulation, createdAt: Date.now(), updatedAt: Date.now() })
      }
    }
    const place = this.placeOf(agent.session)
    if (place.kind === 'folder') return void await this.enforceFolderPreset(agent)
    if (!strict) {
      // Opening a log only prepares local ownership metadata. Workspace setup
      // happens at pre-step, never in response to navigation or polling.
      if (place.kind === 'project' && !this.binding(sessionId)) {
        const metadata = await persistence?.readSidecar?.(sessionId).catch(() => undefined)
        const anchor = this.ensureAnchor(place.project)
        const selected = this.selectedScratch(agent, anchor)
        this.save({ sessionId, kind: 'project', project: place.project, projectId: persistence?.projectIdOf?.(sessionId), anchor, ...selected,
          branch: metadata?.codeBranch, sandbox: metadata?.codeBranch ? sandboxOf(sessionId) : undefined,
          simulation: metadata?.simulation, state: 'closed', executionState: 'inactive', createdAt: Date.now(), updatedAt: Date.now() })
        if (metadata?.checkpoints) this.state.update((s) => { s.checkpoints[sessionId] ??= metadata.checkpoints })
      }
      if (place.kind === 'project') await this.selectPreset(agent)
      return
    }
    await this.lane(sessionId, async () => {
      try {
        await this.validateExecutionIdentity(sessionId)
        if (this.isSimulationManaged(sessionId)) return await this.bindSimulation(agent, place)
        if (place.kind === 'shared') return await this.bindShared(agent, place.parent, place.anchor, strict)
        await this.hostOperation(sessionId, place.project, undefined, () => this.bindProject(agent, place.project, place.anchor, source))
      } catch (error: any) {
        const previous = this.binding(sessionId)
        this.ctx.logger('layerfs').warn('session %s: bind failed: %s', sessionId, error?.message ?? error)
        if (place.kind === 'project') {
          this.save({
            ...(previous ?? { sessionId, kind: 'project', anchor: place.anchor, scratch: join(this.scratchAnchor, sessionId), createdAt: Date.now(), updatedAt: Date.now() }),
            project: place.project, executionState: 'interrupted', state: 'failed', error: String(error?.message ?? error),
          } as Binding)
        }
        if (strict) throw error
      }
    })
  }

  /**
   * Whether a session may run now: bound, else it throws. At pre-step (a new
   * message) a closed or interrupted context is re-activated; a tool call passes
   * `rebind: false` so access returning mid-turn never restarts execution.
   */
  async ensureBound(agent: any, options: { rebind?: boolean } = {}): Promise<void> {
    const sessionId = String(agent.id)
    // An owner choice in flight decides this step's place; wait for it.
    await this.settled(sessionId)
    const place = this.placeOf(agent.session ?? { id: sessionId })
    // Normal sessions are stock DSH: no LayerFS lock, identity or binding applies.
    if (place.kind === 'folder' && !this.simulationOf(sessionId)) return
    const held = this.ctx.layerfs.exclusive?.()
    if (held) throw new CliError('ConnectBusy', held)
    // From here on every LayerFS call is this session's host work, so run it in
    // the session's trace context: successful reads fold into its receipt
    // counter (no receipt), writes and refusals keep theirs, and each call
    // carries `dsh:<sessionId>:` rather than the session-less `dsh:-:` tag.
    const project = this.binding(sessionId)?.project ?? (place.kind === 'project' ? place.project : undefined)
    if (!project) return await this.ensureBoundNow(agent, options)
    await this.hostOperation(sessionId, project, undefined, () => this.ensureBoundNow(agent, options))
  }

  /** {@link ensureBound} once the session's place and project are known. */
  private async ensureBoundNow(agent: any, options: { rebind?: boolean } = {}): Promise<void> {
    const sessionId = String(agent.id)
    await this.validateExecutionIdentity(sessionId, { recent: true })
    if (this.isSimulationManaged(sessionId)) {
      if (agent.model?.current?.()?.provider !== 'simulation') throw new CliError('Busy', 'Stop the active project script before changing its model')
      // Creation only records a closed binding; the script's first step binds
      // project ownership and scratch (no automatic branch or mount).
      if (this.binding(sessionId)?.state !== 'bound') return await this.bindAgent(agent, 'pre-step', true)
      await this.detach(sessionId)
      return
    }
    let b = this.binding(sessionId)
    if (b?.kind === 'shared' && b.parent) b = this.binding(b.parent)
    if (b?.state === 'bound' && b.ws && (b.mount ? existsSync(b.mount) : true)) {
      const provider = this.ctx.get?.('sessionPersistence' as never) as any
      const usable = !provider?.assertSessionIdentity || await this.lfs.workspace.status(b.ws).then(() => true, () => false)
      if (usable) { await this.detach(sessionId); return }
      this.interrupt(b.sessionId, 'The execution workspace was lost. A new message reconnects it.', 'availability')
    }
    if (options.rebind === false) {
      const owner = b ? this.binding(b.sessionId) : undefined
      throw new CliError('Unavailable', owner?.error ?? 'Project execution is not active. Send a new message to activate it.')
    }
    await this.bindAgent(agent, 'pre-step', true)
  }

  /** When each bound session's identity and readiness last passed (pre-step checks reuse it briefly). */
  private identityChecked?: Map<string, number>

  /**
   * The session's Store, project and latest checkpoint are still its own, and its machine
   * and Store are ready. `recent`: a bound session that passed within `IDENTITY_FRESH_MS`
   * passes again without reads (every agent step of a team run calls this; each check is
   * five Store and machine reads queued behind that Store's other work).
   */
  private async validateExecutionIdentity(sessionId: string, options: { recent?: boolean } = {}): Promise<void> {
    const persistence = this.ctx.get?.('sessionPersistence' as never) as any
    let binding = this.binding(sessionId)
    while (binding?.kind === 'shared' && binding.parent) binding = this.binding(binding.parent)
    const id = binding?.sessionId ?? sessionId
    const checked = this.identityChecked ??= new Map()
    const passed = checked.get(id)
    if (options.recent && passed && binding?.state === 'bound' && Date.now() - passed < IDENTITY_FRESH_MS) return
    checked.delete(id)
    try {
      const row = await persistence?.assertSessionIdentity?.(id)
      if (row) {
        // a PostgreSQL session keeps the machine it was placed on
        const machine = row.kind === 'postgresql' ? (binding?.machine ?? HOST_MACHINE) : (row.machine ?? HOST_MACHINE)
        await this.assertReady(row, machine)
        if (binding?.branch) {
          const latest = [...this.checkpoints(id)].reverse().find((checkpoint) => checkpoint.commit && !checkpoint.error)
          if (latest?.commit) await this.lfs.file.list(row.key, latest.branch ?? binding.branch, '/', { at: latest.commit, limit: 1 }).catch(() => { throw new CliError('CheckpointUnavailable', 'The latest saved file checkpoint is unavailable in this Store. History and checkpoint references are retained; recover that checkpoint before continuing.') })
        }
        if (binding && binding.machine && binding.machine !== machine) this.save({ ...binding, machine, state: 'closed', executionState: 'inactive', mount: undefined, ws: undefined })
      }
      checked.set(id, Date.now())
    } catch (error: any) {
      const message = String(error?.message ?? error)
      const kind = error?.code === 'Unavailable' ? 'availability' : 'blocked'
      const current = binding ? this.binding(binding.sessionId) : undefined
      // A readiness read that fails under host load (a machine status timing out) must
      // not stop a running team: when the bound execution Workspace still answers, the
      // machine and Sandbox are up. Keep running; the next check reads again
      // (Quarry v2 FIX-LOG F21).
      if (kind === 'availability' && current?.state === 'bound' && current.ws
        && await this.lfs.workspace.status(current.ws).then(() => true, () => false)) {
        this.ctx.logger('layerfs').warn('session %s: readiness check failed while its Workspace answers; keeping execution: %s', current.sessionId, message)
        checked.set(id, Date.now())
        return
      }
      // An active context is deactivated; an inactive one only records why it cannot start.
      // the Store's classified failure (assertReady) travels with its reason, so the row names it without parsing text
      const failure: SessionFailure | undefined = error?.failure
      if (current?.state === 'bound') this.interrupt(current.sessionId, message, kind, failure ? { ...failure, interrupted: true } : undefined)
      else if (current) this.save({ ...current, error: message, failure, interruption: { kind, at: Date.now() } })
      throw error
    }
  }

  private async bindSimulation(agent: any, place: Exclude<Place, { kind: 'folder' }>): Promise<void> {
    const sessionId = String(agent.id), simulation = this.simulationOf(sessionId)!
    const parent = simulation.rootSessionId ?? (place.kind === 'shared' ? place.parent : undefined)
    const root = parent ? this.binding(parent) : undefined
    const project = place.kind === 'project' ? place.project : root?.project
    if (!project) throw new CliError('Unavailable', 'The script parent project is unavailable')
    const anchor = this.anchorOf(project), existing = this.binding(sessionId)
    const selected = root ? { scratch: root.scratch, scratchManaged: root.scratchManaged } : this.selectedScratch(agent, anchor, existing)
    await (this.ctx.get?.('sessionPersistence' as never) as any)?.migrateProject?.(agent.session, project)
    this.save({ sessionId, kind: parent ? 'shared' : 'project', ...(parent ? { parent } : {}), project,
      anchor, ...selected, state: 'bound', simulation, createdAt: existing?.createdAt ?? Date.now(), updatedAt: Date.now() })
    this.state.update((s) => { delete s.pending[sessionId] })
    await this.persistMetadata(sessionId)
    await this.selectPreset(agent)
    await this.moveTo(agent, selected.scratch)
    await this.detach(sessionId)
  }

  /** `<state>/scratch/<session>`: a project session's own new scratch folder. */
  private scratchFor(sessionId: string): string {
    const dir = join(this.scratchAnchor, sessionId)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  /**
   * A project session's scratch folder: the one it already has (a folder the
   * user picked, `sessions.scratch`, or one made earlier), else a new folder of
   * its own. The folder it was created in never becomes its scratch.
   */
  private selectedScratch(agent: any, _anchor: string, previous?: Binding): { scratch: string, scratchManaged: boolean } {
    if (previous?.scratch && existsSync(previous.scratch) && statSync(previous.scratch).isDirectory()) return { scratch: previous.scratch, scratchManaged: previous.scratchManaged === true }
    const picked = this.state.read().pending[String(agent.id)]?.scratch
    if (picked && existsSync(picked) && statSync(picked).isDirectory()) return { scratch: picked, scratchManaged: false }
    return { scratch: this.scratchFor(String(agent.id)), scratchManaged: true }
  }

  /** Move the session's working directory: silently before its first turn, with DSH's notice afterwards. */
  private async moveTo(agent: any, dir: string): Promise<void> {
    const wd = this.ctx.workingDirectory
    if (wd.get(agent.session) === dir) return
    const fresh = !agent.session.snapshotEvents(0).some((e: any) => e.type === 'turn/start')
    if (fresh) agent.session.append('working-directory/change', { cwd: dir })
    else await wd.set(agent, dir)
  }

  private async bindShared(agent: any, parent: string, anchor: string, strict: boolean): Promise<void> {
    const sessionId = String(agent.id)
    // A subagent of a subagent follows the root binding.
    let root = this.binding(parent)
    while (root?.kind === 'shared' && root.parent) root = this.binding(root.parent)
    // A finished script root gets its ordinary context first; children share it.
    if (root?.simulation && !this.isSimulationManaged(root.sessionId) && !root.ws) {
      const parentAgent = (this.ctx.get?.('agents' as never) as any)?.get?.(root.sessionId)
      if (parentAgent) { await this.bindAgent(parentAgent, 'child-handoff', strict); root = this.binding(root.sessionId) }
    }
    if (!root || root.state !== 'bound' || !(root.mount ?? root.scratch)) {
      if (strict) throw new CliError('Unavailable', 'The parent session\'s LayerFS Workspace is not bound')
      return
    }
    await (this.ctx.get?.('sessionPersistence' as never) as any)?.migrateProject?.(agent.session, root.project)
    this.save({ sessionId, kind: 'shared', anchor, parent: root.sessionId, scratch: root.scratch, project: root.project, mount: root.mount, simulation: this.simulationOf(sessionId), projectId: (this.ctx.get?.('sessionPersistence' as never) as any)?.projectIdOf?.(sessionId), executionState: 'active', state: 'bound', createdAt: Date.now(), updatedAt: Date.now() })
    await this.persistMetadata(sessionId)
    await this.moveTo(agent, root.scratch)
    await this.detach(sessionId)
  }

  private async bindProject(agent: any, project: string, anchor: string, source: string): Promise<void> {
    const sessionId = String(agent.id)
    const held = this.ctx.layerfs.exclusive?.()
    if (held) throw new CliError('ConnectBusy', held)
    const header = agent.session.header
    let existing = this.binding(sessionId)
    const persistence = this.ctx.get?.('sessionPersistence' as never) as any
    if (!existing && persistence?.ownerOf?.(sessionId)) {
      const metadata = await persistence.readSidecar(sessionId)
      if (!metadata?.codeBranch && !metadata?.simulation && !this.state.read().pending[sessionId] && agent.session.snapshotEvents(0).some((e: any) => e.type === 'turn/end')) {
        throw new CliError('RecoveryRequired', 'This project conversation has no saved file-context metadata; recover its LayerFS annotations before continuing')
      }
      if (metadata?.checkpoints) this.state.update((s) => { s.checkpoints[sessionId] = metadata.checkpoints })
      if (metadata?.codeBranch) {
        existing = {
          sessionId, kind: 'project', project, anchor, scratch: '', branch: metadata.codeBranch,
          machine: (await this.machineFor(project)) ?? undefined, sandbox: metadata.simulation ? this.simulationSandbox(sessionId) : sandboxOf(sessionId), ws: `${metadata.simulation ? this.simulationSandbox(sessionId) : sandboxOf(sessionId)}:${WS_NAME}`,
          state: 'closed', createdAt: Date.now(), updatedAt: Date.now(),
          simulation: metadata.simulation,
        }
      }
    }
    // A finished script session without a pin starts "as if fresh" from the project's current files.
    if (!existing?.branch && persistence?.ownerOf?.(sessionId) && !this.state.read().pending[sessionId] && !this.simulationOf(sessionId) && agent.session.snapshotEvents(0).some((e: any) => e.type === 'turn/end')) {
      throw new CliError('RecoveryRequired', 'This conversation has no confirmed saved file context. Recover its annotations before continuing; execution cannot start from the current project files.')
    }
    const selected = this.selectedScratch(agent, anchor, existing)
    const { scratch } = selected
    await persistence?.migrateProject?.(agent.session, project)
    // The row says Starting while the Sandbox is made and its Workspace mounted.
    // This binding is replaced by the same one saved Active below; a failure
    // leaves it Interrupted (bindAgent's catch), never stuck starting. A normal
    // step on a live session returns from ensureBound before reaching this.
    const usable = existing?.state === 'bound' && !!existing.ws && (!existing.mount || existsSync(existing.mount))
    if (!usable) {
      this.save({
        ...(existing ?? { sessionId, kind: 'project', project, anchor, ...selected, state: 'closed', createdAt: Date.now(), updatedAt: Date.now() }),
        executionState: 'activating',
      })
    }
    let binding: Binding
    let forkReceipt: string | undefined
    if (existing?.branch && existing.sandbox) {
      const resolved = await persistence?.assertSessionIdentity?.(sessionId)
      // A PostgreSQL project has no Store-wide machine: keep the recorded one and
      // never fall back to the host machine. With none recorded (and the identity resolver
      // silent), the project's own row says the kind; then the person picks one.
      const kind = resolved?.kind ?? (existing.machine ? null : ((await this.lfs.project.get(project, { detail: true }))?.engine ?? null))
      const machine = kind === 'postgresql'
        ? existing.machine
        : resolved?.machine ?? existing.machine ?? (resolved ? HOST_MACHINE : undefined)
      if (kind === 'postgresql' && !machine) throw this.unplaced(project)
      binding = { ...existing, ...selected, machine, state: existing.state }
    } else {
      const machine = await this.machineFor(project, existing?.machine ?? this.state.read().pending[sessionId]?.machine)
      // no machine named and none (or several) attached: the person picks one; nothing is guessed
      if (!machine) throw this.unplaced(project)
      const sandbox = this.simulationOf(sessionId) ? this.simulationSandbox(sessionId) : sandboxOf(sessionId)
      const branch = existing?.resumeFromArchive ? `${branchOf(sessionId)}.resume.${randomUUID().replaceAll('-', '').slice(0, 12)}` : branchOf(sessionId)
      const start = this.forkSource(sessionId, header, project)
      try {
        forkReceipt = await this.tracedFork(sessionId, project, 0, branch, start.branch ?? 'main', start.commit ?? null)
      } catch (error: any) {
        if (!exists(error)) throw error
      }
      binding = {
        sessionId, kind: 'project', project, anchor, ...selected, machine, branch,
        simulation: this.simulationOf(sessionId),
        sandbox, ws: `${sandbox}:${WS_NAME}`,
        state: 'bound', createdAt: existing?.createdAt ?? Date.now(), updatedAt: Date.now(),
        ...(start.session ? { from: { session: start.session, commit: start.commit, turn: start.turn } } : {}),
      }
    }
    binding.mount = await this.mount(binding)
    this.state.update((s) => { delete s.pending[sessionId] })
    binding.state = 'bound'
    binding.executionState = 'active'
    binding.projectId = persistence?.projectIdOf?.(sessionId)
    delete binding.error
    delete binding.failure
    delete binding.interruption
    this.save(binding)
    if (!this.checkpoints(sessionId).length) {
      await this.record(sessionId, {
        kind: 'base', turn: 0, seq: agent.session.seq, endSeq: agent.session.seq, commit: binding.from?.commit ?? binding.simulation?.continuation?.id ?? binding.base ?? null, branch: binding.branch!,
        changed: 0, at: Date.now(), message: binding.from ? `Forked from turn ${binding.from.turn ?? '?'}` : `Started from ${project}`,
        ...(forkReceipt ? { receipt: forkReceipt } : {}),
      })
    }
    await this.persistMetadata(sessionId)
    await this.selectPreset(agent)
    await this.moveTo(agent, scratch)
    await this.detach(sessionId)
    void source
  }

  /** Where a new session's files start: a pending fork, a DSH fork's checkpoint, or `main`. */
  private forkSource(sessionId: string, header: any, project: string): { branch?: string | null, commit?: string | null, session?: string, turn?: number } {
    const simulation = this.simulationOf(sessionId)
    if (simulation?.handoffReady && simulation.continuation) {
      return { branch: simulation.continuation.branch, commit: simulation.continuation.id }
    }
    // Stopped, interrupted or failed without a confirmed pin: start like a brand-new session.
    if (simulation) return {}
    const pending = this.state.read().pending[sessionId]
    if (pending && pending.project === project) return { branch: pending.branch, commit: pending.commit, session: pending.session, turn: pending.turn }
    const parent = header.parentSession ? String(header.parentSession) : undefined
    const parentBinding = parent ? this.binding(parent) : undefined
    if (!parent || !parentBinding || parentBinding.project !== project) return {}
    // A DSH fork copies `inheritedEventCount` events: start from the last checkpoint inside that prefix.
    const inherited = Number(header.inheritedEventCount ?? this.ctx.sessions.get(sessionId as never)?.inheritedEventCount ?? Infinity)
    const points = this.checkpoints(parent).filter((c) => c.commit && (c.endSeq ?? c.seq) < inherited)
    const point = points.at(-1)
    if (!point) return { branch: parentBinding.branch ?? null, session: parent, turn: 0 }
    return { branch: point.branch, commit: point.kind === 'base' ? null : point.commit, session: parent, turn: point.turn }
  }

  // ------------------------------------------------------------- checkpoints

  /**
   * Save the session's Workspace as a checkpoint. `turn` checkpoints of
   * unchanged turns record no commit.
   */
  async checkpoint(sessionId: string, kind: Checkpoint['kind'], turn: number, message: string): Promise<Checkpoint | undefined> {
    if (this.isSimulationManaged(sessionId)) return undefined
    const binding = this.binding(sessionId)
    if (!binding || binding.kind !== 'project' || binding.state !== 'bound' || !binding.ws) return undefined
    const session = this.ctx.sessions.get(sessionId as never) as any
    const seq = session?.seq ?? 0
    let checkpoint: Checkpoint
    let receipt: string | undefined
    let status: any
    try {
      // The identity and status reads are this session's host reads: fold them
      // into its counter even though the save itself writes a receipt.
      await this.hostOperation(sessionId, binding.project!, turn, async () => {
        await (this.ctx.get?.('sessionPersistence' as never) as any)?.assertSessionIdentity?.(sessionId)
        // 2.0 `workspace status --detail`: `changes` (the first 20) and `changes_count`, `branch_moved`, `pending_merge`
        status = await this.lfs.workspace.status(binding.ws, { detail: true })
      })
      const entries = Number(status?.changes_count ?? (Array.isArray(status?.changes) ? status.changes.length : 0)) || 0
      if (!entries && !status?.pending_merge && !status?.branch_moved && kind === 'turn') return undefined
      // Tagged with this session's own id: the session that owns the checkpoint.
      const result = await this.hostOperation(sessionId, binding.project!, turn, () => this.lfs.workspace.commit(binding.ws!, { message, detail: true }), (invocation) => { receipt = invocation.id })
      const commit = typeof result?.commit === 'string' ? result.commit : null
      // Agents change files with `file` calls and their own Workspaces' Commits, so the
      // session Branch often moved while this Workspace changed nothing: count what moved.
      const changed = result?.unchanged !== true ? Math.max(entries, 1)
        : status?.branch_moved && commit ? await this.hostOperation(sessionId, binding.project!, turn, () => this.pathsChanged(binding.project!, status.commit ?? status.base_layer, commit)) : 0
      checkpoint = { kind, turn, seq, commit, branch: binding.branch!, changed, message, at: Date.now(), ...(receipt ? { receipt } : {}) }
      if (commit && binding.simulation?.handoffReady) {
        this.state.update((s) => {
          s.sessions[sessionId].simulation!.continuation = { kind: 'Commit', id: commit, branch: binding.branch! }
        })
      }
    } catch (error: any) {
      // Conflict markers or an uncertain outcome: never retry blindly; the panel shows it.
      checkpoint = { kind, turn, seq, commit: null, branch: binding.branch!, changed: 0, message, at: Date.now(), error: errorOf(error), ...(receipt ? { receipt } : {}) }
    }
    await this.record(sessionId, checkpoint)
    return checkpoint
  }

  /** Files that differ between two saved versions (one page, so at most 1000); 1 when unknown. */
  private async pathsChanged(project: string, from: string | null | undefined, to: string): Promise<number> {
    if (!from || from === to) return from ? 0 : 1
    try {
      const page: any = await this.lfs.commit.diff(project, to, { from, limit: 1000, detail: true })
      const files = (page?.items ?? []).filter((item: any) => item?.type !== 'dir').length
      return Math.max(files, page?.items?.length ? 1 : 0)
    } catch { return 1 }
  }

  /** `turn/end` seen: complete the turn's checkpoint with its boundary seq. */
  markTurnEnd(sessionId: string, turn: number, seq: number): void {
    const list = this.state.read().checkpoints[sessionId]
    if (!list?.some((c) => c.kind === 'turn' && c.turn === turn && c.endSeq === undefined)) return
    this.state.update((s) => {
      for (const c of s.checkpoints[sessionId] ?? []) if (c.kind === 'turn' && c.turn === turn && c.endSeq === undefined) c.endSeq = seq
    })
    void this.persistMetadata(sessionId).catch((e) => this.ctx.logger('layerfs').warn('persist checkpoint boundary: %s', String(e)))
  }

  /**
   * Restore the session's files to a checkpoint: save current changes, fork a
   * new Branch from the checkpoint and remount it in place.
   */
  async restore(sessionId: string, commit: string): Promise<Binding> {
    if (this.isSimulationManaged(sessionId)) throw new CliError('Busy', 'Stop script execution and establish its continuation context before restoring files')
    return await this.lane(sessionId, async () => {
      const binding = this.binding(sessionId)
      if (!binding || binding.kind !== 'project' || !binding.project || !binding.sandbox) throw new CliError('InvalidInput', 'This session has no LayerFS Workspace')
      await this.validateExecutionIdentity(sessionId)
      const target = this.checkpoints(sessionId).find((c) => c.commit === commit)
      if (!target) throw new CliError('NotFound', 'No such checkpoint in this session')
      const session = this.ctx.sessions.get(sessionId as never) as any
      if (binding.state === 'bound') {
        const saved = await this.checkpoint(sessionId, 'manual', this.lastTurn(sessionId), 'Saved before restore')
        if (saved?.error) throw new CliError(saved.error.code, saved.error.message)
      }
      const generation = (binding.restores ?? 0) + 1
      const branch = branchOf(sessionId, generation)
      const receipt = await this.tracedFork(sessionId, binding.project, this.lastTurn(sessionId), branch, target.branch ?? binding.branch ?? 'main', commit)
      // The fork is durable: the binding names the restored branch from here, so a
      // failed mount leaves a retry forking the next generation (never `Exists`),
      // and it claims no Workspace until the mount succeeds.
      const forked: Binding = { ...binding, branch, restores: generation, base: undefined, mount: undefined, ws: undefined, state: 'closed', executionState: 'activating', error: undefined, interruption: undefined }
      if (forked.simulation?.handoffReady) forked.simulation = { ...forked.simulation, continuation: { kind: target.kind === 'base' ? forked.simulation.continuation?.kind ?? 'Commit' : 'Commit', id: commit, branch } }
      this.save(forked)
      await this.record(sessionId, {
        kind: 'restore', turn: target.turn, seq: session?.seq ?? 0, endSeq: session?.seq ?? 0, commit,
        branch, changed: 0, at: Date.now(), message: `Restored files to ${target.kind === 'base' ? 'the start' : `turn ${target.turn}`}`,
        ...(receipt ? { receipt } : {}),
      })
      await this.lfs.workspace.unmount(`${binding.sandbox}:${WS_NAME}`, { discard: true, force: true }).catch(() => {})
      const next: Binding = { ...forked, ws: binding.ws ?? `${binding.sandbox}:${WS_NAME}`, state: 'bound', executionState: 'active' }
      next.mount = await this.mountOrFail(forked, next)
      this.save(next)
      const agent = (this.ctx.get('agents' as never) as any)?.get?.(sessionId)
      if (agent) {
        await this.moveTo(agent, next.scratch)
        try {
          const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
          agent.inject(createUserMessage({ content: [{ type: 'text', text: `The project files were restored to the checkpoint of ${target.kind === 'base' ? 'the session start' : `turn ${target.turn}`}. Changes made after it are no longer in the project Workspace.` }], source: { kind: 'working-directory' } as never }))
        } catch { /* notice is best effort */ }
      }
      return next
    })
  }

  /**
   * Mount `next` (a freshly forked branch). A failed mount keeps `forked` (its
   * new branch, no Workspace) as `failed`, so the next message re-mounts that branch.
   */
  private async mountOrFail(forked: Binding, next: Binding): Promise<string | undefined> {
    try { return await this.mount(next) } catch (error: any) {
      this.save({ ...forked, state: 'failed', executionState: 'interrupted', error: `Mounting the project files failed: ${errorOf(error).message}. A new message mounts them again.` })
      throw error
    }
  }

  /** {@link forkAt} as a host operation of `sessionId`: answers the successful fork's receipt id. */
  private async tracedFork(sessionId: string, project: string, turn: number, branch: string, from: string, commit: string | null): Promise<string | undefined> {
    let receipt: string | undefined
    await this.hostOperation(sessionId, project, turn, () => this.forkAt(project, branch, from, commit), (invocation) => {
      if (invocation.operation === 'branch.fork' && invocation.outcome === 'success') receipt = invocation.id
    })
    return receipt
  }

  /** Fork `branch` at a commit (or base Layer) id: from the branch that holds it, else from `main`. */
  private async forkAt(project: string, branch: string, from: string, commit: string | null): Promise<void> {
    if (!commit) { await this.lfs.branch.fork(project, branch, from); return }
    try {
      await this.lfs.branch.fork(project, branch, from, { at: commit })
    } catch (error: any) {
      if (from === 'main' || exists(error)) throw error
      await this.lfs.branch.fork(project, branch, 'main', { at: commit })
    }
  }

  private lastTurn(sessionId: string): number {
    const session = this.ctx.sessions.get(sessionId as never) as any
    let turn = 0
    for (const e of session?.snapshotEvents?.(0) ?? []) if (e.type === 'turn/end' || e.type === 'turn/start') turn = Math.max(turn, Number(e.data?.turn ?? 0))
    return turn
  }

  /**
   * Branch the conversation and its files at a checkpoint: a DSH session fork
   * at the checkpoint's turn end, whose files start from the checkpoint.
   */
  async branchAt(sessionId: string, commit: string | null, turn: number): Promise<{ sessionId: string }> {
    if (this.isSimulationManaged(sessionId)) throw new CliError('Busy', 'Stop script execution before forking its conversation')
    const binding = this.binding(sessionId)
    if (!binding?.project) throw new CliError('InvalidInput', 'This session has no LayerFS project')
    await this.validateExecutionIdentity(sessionId)
    const target = this.checkpoints(sessionId).find((c) => c.turn === turn && (commit === null || c.commit === commit))
    if (!target) throw new CliError('NotFound', 'No such checkpoint in this session')
    const controller = (this.ctx as any).get?.('sessionController')
    if (!controller?.fork) throw new CliError('Unavailable', 'DSH session forking is not available in this profile')
    const atSeq = target.kind === 'base' ? undefined : target.endSeq
    if (target.kind !== 'base' && atSeq === undefined) throw new CliError('Busy', 'That turn has not ended yet')
    const start = { project: binding.project!, commit: target.kind === 'base' ? (target.commit ?? null) : target.commit, branch: target.branch, session: sessionId, turn: target.turn }
    const forked = await controller.fork({ sessionId, ...(atSeq !== undefined ? { atSeq } : {}) })
    const child = String(forked.sessionId)
    this.state.update((s) => { s.pending[child] = start })
    // The fork may already have entered (and bound) its Agent: point its files at the checkpoint.
    await this.lane(child, async () => {
      const bound = this.binding(child)
      if (!bound || bound.kind !== 'project' || !bound.sandbox) return
      if (bound.from?.session === sessionId && bound.from.turn === target.turn) return
      const branch = branchOf(child, (bound.restores ?? 0) + 1)
      const receipt = await this.tracedFork(child, start.project, 0, branch, start.branch ?? 'main', start.commit)
      // As in restore: the forked branch is recorded before the mount, so a failed
      // mount re-mounts it on the next message (which also records the base checkpoint).
      const forked: Binding = { ...bound, branch, restores: (bound.restores ?? 0) + 1, base: undefined, from: { session: sessionId, commit: start.commit, turn: target.turn }, mount: undefined, ws: undefined, state: 'closed', executionState: 'activating', error: undefined, interruption: undefined }
      this.save(forked)
      await this.persistMetadata(child)
      await this.lfs.workspace.unmount(`${bound.sandbox}:${WS_NAME}`, { discard: true, force: true }).catch(() => {})
      const next: Binding = { ...forked, ws: bound.ws ?? `${bound.sandbox}:${WS_NAME}`, state: 'bound', executionState: 'active' }
      next.mount = await this.mountOrFail(forked, next)
      this.save(next)
      this.state.update((s) => {
        delete s.pending[child]
        s.checkpoints[child] = [{ kind: 'base', turn: 0, seq: 0, endSeq: 0, commit: start.commit ?? next.base ?? null, branch, changed: 0, at: Date.now(), message: `Forked from turn ${target.turn}`, ...(receipt ? { receipt } : {}) }]
      })
      await this.persistMetadata(child)
      const agent = (this.ctx.get('agents' as never) as any)?.get?.(child)
      if (agent) await this.moveTo(agent, next.scratch)
    })
    return { sessionId: child }
  }

  // ------------------------------------------------------------- lifecycle

  /**
   * Deactivate an owner's execution and its subagents' shared bindings: drop the
   * mount and Workspace handles, keep the Sandbox name, branch, checkpoints and
   * ownership. Nothing is closed, saved or replayed; the next message re-activates
   * (re-mounting the retained branch, or recreating a gone Sandbox).
   */
  private interrupt(ownerId: string, reason: string, kind: NonNullable<Binding['interruption']>['kind'], failure?: SessionFailure): void {
    const bindings = this.state.read().sessions
    for (const binding of Object.values(bindings)) {
      if (binding.sessionId !== ownerId && !(binding.kind === 'shared' && binding.parent === ownerId)) continue
      this.save({ ...binding, state: 'closed', executionState: 'interrupted', mount: undefined, ws: undefined, error: reason, failure, interruption: { kind, at: Date.now() } })
    }
  }

  /** Owner bindings (not subagents' shared ones) matching `test`. */
  private owners(test: (binding: Binding) => boolean): Binding[] {
    return Object.values(this.state.read().sessions).filter((b) => b.kind === 'project' && test(b))
  }

  /** A confirmed stop invalidates mounts, never conversation ownership.
   * No checkpoint or worker call is possible after its machine has stopped. */
  machinesStopped(machines: readonly string[]): void {
    const stopped = new Set(machines)
    // A stopped machine changes readiness even for a session whose binding is
    // already closed (no save would clear its entry).
    this.clearFreshReads((entry) => stopped.has(entry.machine ?? HOST_MACHINE))
    for (const owner of this.owners((b) => !!b.sandbox && stopped.has(b.machine ?? HOST_MACHINE) && (b.state === 'bound' || !!b.ws))) {
      this.interrupt(owner.sessionId, `Machine ${owner.machine ?? HOST_MACHINE} was stopped. Execution was interrupted; send a new message after it is started again.`, 'availability')
    }
  }

  /** A forced Sandbox close releases only its own execution handles. */
  sandboxClosed(sandbox: string): void {
    for (const owner of this.owners((b) => b.sandbox === sandbox)) {
      this.interrupt(owner.sessionId, 'The session Sandbox was closed. Execution was interrupted; a new message starts it again.', 'sandbox')
    }
  }

  /**
   * One read-only availability pass over the Stores of project conversations.
   * An active conversation whose Store is unavailable or removed is deactivated
   * (`interrupted`); once the Store answers again its stale error is cleared, and
   * execution waits for a new message. Never starts a machine, mounts or replays.
   * Emits `layerfs-availability` when any watched Store's health changes.
   */
  refreshAvailability(): Promise<void> {
    this.availabilityRun ??= this.pollAvailability().finally(() => { this.availabilityRun = undefined })
    return this.availabilityRun
  }

  /** The last observed health of each watched Store. */
  availability(): Record<string, StoreHealth> { return Object.fromEntries(this.storeHealth) }

  /** Whether any conversation needs availability polling (active, or waiting to clear an availability error). */
  watchesAvailability(): boolean {
    return this.owners((b) => !!b.project && !b.simulation && (b.state === 'bound' || (b.interruption?.kind === 'availability' && !!b.error))).length > 0
  }

  private async pollAvailability(): Promise<void> {
    if (this.ctx.layerfs.exclusive?.()) return
    const watched = this.owners((b) => !!b.project && !b.simulation && (b.state === 'bound' || (b.interruption?.kind === 'availability' && !!b.error)))
    const stores = new Set(watched.map((b) => storeOf(b.project)).filter((s): s is string => !!s))
    if (!stores.size) return
    let rows: any[]
    try { rows = (await this.lfs.store.list({ detail: true }))?.items ?? [] } catch (error: any) {
      // Not knowing is not evidence of loss: never deactivate on a failed list.
      this.ctx.logger('layerfs').warn('availability: store list: %s', String(error?.message ?? error))
      return
    }
    let changed = false
    for (const name of stores) {
      const row = rows.find((r) => r?.store === name)
      let live: any
      // a PostgreSQL Store's server is asked once a minute (`store get --with live`, from this computer); records answer the rest
      const askServer = row?.engine === 'postgresql' && Date.now() - (this.serverChecked.get(name) ?? 0) >= 60_000
      if (askServer) {
        this.serverChecked.set(name, Date.now())
        live = await this.lfs.store.get(name, { detail: true, with: ['live'] }).catch(() => undefined)
      }
      const previous = this.storeHealth.get(name)
      let health = classifyStore(row, live)
      // A PostgreSQL verdict holds until the server is asked again.
      if (row?.engine === 'postgresql' && !askServer && previous?.state === 'unavailable' && health.state === 'available') health = previous
      if (previous?.state !== health.state || previous?.reason !== health.reason) {
        changed = true
        // A Store transition invalidates observed readiness for its projects.
        this.clearFreshReads((entry) => storeOf(entry.project) === name)
      }
      this.storeHealth.set(name, health)
      for (const owner of watched) {
        if (storeOf(owner.project) !== name) continue
        if ((health.state === 'unavailable' || health.state === 'removed') && owner.state === 'bound') {
          // Queued behind the session's own work (a bind or save in flight), never blocking the next poll.
          const reason = `${health.reason ?? 'The project Store is unavailable.'} Execution was interrupted; history is retained and a new message re-activates it after access returns.`
          const failure = health.failure ? { ...health.failure, interrupted: true } : undefined
          void this.lane(owner.sessionId, async () => {
            if (this.binding(owner.sessionId)?.state === 'bound') this.interrupt(owner.sessionId, reason, 'availability', failure)
          }).catch((error) => this.ctx.logger('layerfs').warn('availability: interrupt %s: %s', owner.sessionId, String(error?.message ?? error)))
        } else if (health.state === 'available' && owner.state !== 'bound' && owner.interruption?.kind === 'availability' && owner.error) {
          const current = this.binding(owner.sessionId)
          if (current && current.state !== 'bound' && current.interruption?.kind === 'availability') this.save({ ...current, error: undefined, failure: undefined })
        }
      }
    }
    if (changed) this.ctx.layerfs.emit('layerfs-availability', { stores: Object.fromEntries([...stores].map((s) => [s, this.storeHealth.get(s)])) })
  }

  /** The machine and Store a project executes on must be ready now (read-only; starts nothing). */
  private async assertReady(row: { kind?: string | null, machine?: string | null, store: string }, placed?: string | null): Promise<void> {
    const { machine, store: storeName } = this.readyTargets(row, placed)
    // records only (the 2.0 six states): `ready` with no op is ready; anything else is named with its fix
    const status = await this.lfs.machine.get(machine, { detail: true })
    if ((status?.state ?? 'ready') !== 'ready' || status?.op) {
      throw new CliError('Unavailable', `Machine ${machine} is not ready (${status?.state ?? 'unknown'}${status?.reason ? `: ${status.reason}` : ''}). Start or repair it, then send the message again.`, null, 'refusal', typeof status?.fix === 'string' ? status.fix : null)
    }
    const store = await this.lfs.store.get(storeName, { detail: true })
    const health = classifyStore(store)
    this.storeHealth.set(storeName, health)
    if (health.state !== 'available') {
      throw Object.assign(new CliError('Unavailable', health.reason ?? 'The project Store is not ready. Restore access, then send the message again.'), health.failure ? { failure: health.failure } : {})
    }
  }

  /** Save and close execution resources; a new message activates them again. */
  async close(sessionId: string, reason: 'idle' | 'user' = 'user'): Promise<void> {
    await this.lane(sessionId, async () => {
      const binding = this.binding(sessionId)
      if (!binding || binding.kind !== 'project' || binding.state !== 'bound' || !binding.sandbox) return
      const saved = await this.checkpoint(sessionId, 'idle', this.lastTurn(sessionId), reason === 'idle' ? 'Saved before the idle Sandbox closed' : 'Saved before closing')
      if (saved?.error) throw new CliError(saved.error.code, saved.error.message)
      await this.lfs.sandbox.remove(binding.sandbox, { force: true })
      this.save({ ...binding, state: 'closed', executionState: 'inactive', mount: undefined, ws: undefined })
      this.store?.schedule(sessionId, 0)
    })
  }

  /** Forget a binding without deleting the user's selected folder or local history. */
  async forget(sessionId: string): Promise<void> {
    if (this.isSimulationManaged(sessionId)) throw new CliError('Busy', 'Settle script execution before forgetting its binding')
    const binding = this.binding(sessionId)
    if (!binding) return
    if (binding.kind === 'project' && binding.sandbox) await this.lfs.sandbox.remove(binding.sandbox, { force: true }).catch(() => {})
    // Scratch is a user-selected folder and may be shared with normal sessions.
    // Even legacy generated scratch can hold evidence; release it separately.
    this.state.update((s) => { delete s.sessions[sessionId]; delete s.pending[sessionId] })
    this.forgetFreshReads(sessionId)
  }

  /** Save and close every session Sandbox of a project (before the project is removed). */
  async closeProject(project: string): Promise<void> {
    for (const b of Object.values(this.state.read().sessions)) {
      if (b.project !== project || b.kind !== 'project') continue
      if (b.state === 'bound') await this.close(b.sessionId, 'user').catch(() => {})
      if (b.sandbox) await this.lfs.sandbox.remove(b.sandbox, { force: true }).catch(() => {})
    }
    // Session Sandboxes another DSH on this LayerFS home made (same naming) block removal too.
    const listed = await pages((paging) => this.lfs.sandbox.list({ project, ...paging })).catch(() => [] as any[])
    for (const s of listed) if (typeof s?.sandbox === 'string' && s.sandbox.startsWith('dsh-')) await this.lfs.sandbox.remove(s.sandbox, { force: true }).catch(() => {})
  }

  /**
   * This LayerFS home's Stores, with their Store ID when the CLI reports one.
   * `also` adds names known to belong here (a preset's Stores) so a failed or
   * partial listing still covers them.
   */
  async homeStores(also: readonly string[] = []): Promise<HomeStore[]> {
    // 2.0 answers no Store ID (`store get` has none): the Store name decides
    const rows: any[] = await this.lfs.store.list().then((value: any) => value?.items ?? [], () => [])
    const out = new Map<string, HomeStore>(also.map((name) => [name, { name }]))
    for (const row of rows) if (typeof row?.store === 'string') out.set(row.store, { name: row.store })
    return [...out.values()]
  }

  /**
   * The project conversations (owner-routed logs, bindings, pending choices)
   * whose Store is one of `stores`. A Store ID decides when both sides know it;
   * otherwise the Store name does. The project-session home may be shared by
   * several DSH homes, so conversations of other LayerFS homes stay.
   */
  projectConversations(stores: readonly HomeStore[]): { id: string, project: string }[] {
    const persistence = this.ctx.get?.('sessionPersistence' as never) as any
    const state = this.state.read()
    const ours = (project: string | null | undefined, storeId?: string): boolean => {
      const name = project ? storeOf(project) : undefined
      return !!name && stores.some((s) => s.name === name && (!s.id || !storeId || s.id === storeId))
    }
    const found = new Map<string, string>()
    for (const id of persistence?.ownedSessionIds?.() ?? []) {
      const project = persistence.ownerOf?.(id)?.project
      if (ours(project, persistence.storeIdOf?.(id))) found.set(id, project)
    }
    for (const b of Object.values(state.sessions)) if (b.project && (b.kind === 'project' || b.kind === 'shared') && ours(b.project)) found.set(b.sessionId, b.project)
    for (const [id, p] of Object.entries(state.pending)) if (ours(p.project)) found.set(id, p.project)
    return [...found].map(([id, project]) => ({ id, project })).sort((a, b) => a.project.localeCompare(b.project) || a.id.localeCompare(b.id))
  }

  /**
   * Whether one conversation has never started: it has no user/assistant
   * message, no title and no turn in its log, and no checkpoint, archive or
   * mirror record. It is also false for a subagent, an imported/seeded session
   * and anything that cannot be verified (a missing log that is not a pending
   * choice), so a caller may only ever delete what this proves blank.
   * `known` lets a caller that already read the snapshot and sidecar pass them
   * in (sessions.list does); without it they are read here.
   *
   * A read is not usage: the sidecar's receipt counter also folds the draft's
   * own placement/identity reads (`project.get`, `branch.list`, `machine.get`,
   * `store.get`), so it is deliberately not consulted. Content in the log (a
   * message, turn or title event) or a title/checkpoint/archive record starts
   * the conversation and keeps it.
   */
  async neverStarted(sessionId: string, known: NeverStartedKnown = {}): Promise<boolean> {
    const state = this.state.read()
    const binding = state.sessions[sessionId]
    // A subagent, a fork, or anything with a checkpoint/mirror record has history that is not this cleanup's.
    if (binding?.kind === 'shared' || binding?.from || binding?.base || state.checkpoints[sessionId]?.length || state.mirror[sessionId]) return false
    const persistence = this.ctx.get?.('sessionPersistence' as never) as any
    // `local` routes to the owner's backend and never imports on a miss.
    const local = persistence?.local ?? persistence
    // A read that fails is not a miss: what cannot be read cannot be proven
    // blank, so it stays (when in doubt, skip).
    let unreadable = false
    const unread = (): undefined => { unreadable = true; return undefined }
    const snapshot = 'snapshot' in known ? known.snapshot : await local?.stat?.(sessionId).catch(unread)
    if (snapshot?.header?.origin === 'subagent' || snapshot?.header?.isSeeded === true) return false
    const sidecar = 'sidecar' in known ? known.sidecar : await persistence?.readSidecar?.(sessionId, { cached: true }).catch(unread)
    if (unreadable) return false
    // Receipts are not consulted: `sidecar.receipts.readsTotal` counts the
    // draft's own placement reads and is kept for the trajectory's OBSERVATION.
    if (realSessionTitle(sidecar?.title) !== null || sidecar?.archive?.count || sidecar?.checkpoints?.length || sidecar?.invocations?.length) return false
    // A pending choice with no log yet has nothing to keep; any other missing
    // log cannot be verified and stays (when in doubt, skip).
    if (!snapshot) return state.pending[sessionId] !== undefined
    // The header cache's event count is a cheap reject: a log past the blank
    // bound is a conversation, and is not opened here.
    if (Number(snapshot.eventCount) > BLANK_EVENTS_MAX) return false
    const live = (this.ctx.get?.('sessions' as never) as any)?.get?.(sessionId as never) as any
    if (live) return neverStartedLog(live.snapshotEvents?.(0) ?? [])
    // A draft's log is a handful of metadata lines: read only the short prefix
    // that can still prove blank (the list already has the snapshot/sidecar).
    const reader = await local?.open?.(sessionId, 'read').catch(() => undefined)
    if (!reader) return false
    try {
      const read = await reader.read(0, BLANK_EVENTS_MAX + 1)
      return neverStartedLog(read?.events ?? [])
    } catch { return false } finally { await reader.close?.().catch(() => {}) }
  }

  /**
   * Delete this home's conversations that never started (an empty New Session
   * that was placed in a project but never received a message). A candidate is
   * pending (or bound) and proven blank by {@link neverStarted}; the current
   * selection and every loaded conversation are always kept. An id the person
   * archived in DSH is never a draft to prune, and `exclude` keeps further ids
   * for a caller that already knows them. `dryRun` defaults to true, so only
   * `{ dryRun: false }` deletes; a real run removes each candidate's log and
   * owner route through the persistence row (the same path Presets Reset uses),
   * its binding/pending choice and checkpoint/mirror rows, and emits one
   * `layerfs-session {deleted: true}` per id. Safe to re-run: a second run finds
   * no candidates.
   *
   * Only an array at `workspaceRegistry.archivedSessionIds` proves the archive
   * set; a missing field means **unknown**, not empty. A dry run still answers
   * (with `archiveKnown: false`) so an operator can inspect the candidates, but
   * a real run refuses: without the set, an archived draft looks like a draft.
   * @returns the candidates the scan proved blank, the ids actually deleted,
   * and whether the host could name DSH's archive set.
   */
  async pruneNeverStarted(options: { dryRun?: boolean, project?: string, current?: string | readonly string[], exclude?: string | readonly string[] } = {}): Promise<{ candidates: string[], deleted: string[], archiveKnown: boolean }> {
    const state = this.state.read()
    const only = typeof options.project === 'string' && options.project ? options.project : undefined
    const current = new Set<string>(Array.isArray(options.current) ? options.current : options.current ? [options.current] : [])
    // Archived conversations are an explicit keep, not drafts: the person put
    // them in DSH's archive. `exclude` is the caller's own keep list for an id
    // that is not archived (the CLI's --exclude).
    const claimed = (this.ctx.workspaceRegistry as any)?.archivedSessionIds
    const archiveKnown = Array.isArray(claimed)
    if (options.dryRun === false && !archiveKnown) {
      throw new CliError('InvalidInput',
        'Refusing to delete: this host cannot verify DSH\'s archived conversations (workspaceRegistry.archivedSessionIds is not available), so an archived draft could be mistaken for a candidate. Nothing was deleted; a dry run still lists candidates. Restart DSH to apply.',
        { archiveKnown: false, reason: 'archive-unknown' }, 'refusal',
        'Restart DSH so the host exposes workspaceRegistry.archivedSessionIds, then run again with dryRun: false')
    }
    const archived = new Set<string>(archiveKnown ? claimed : [])
    const exclude = new Set<string>([...archived, ...(Array.isArray(options.exclude) ? options.exclude : options.exclude ? [options.exclude] : [])])
    const catalog = this.ctx.get?.('sessions' as never) as any
    const candidates: string[] = []
    for (const id of [...new Set([...Object.keys(state.pending), ...Object.keys(state.sessions)])].sort()) {
      const project = state.pending[id]?.project ?? state.sessions[id]?.project
      if (only && project !== only) continue
      // The conversation open under a cursor never vanishes; nor does one that is loaded and may be running, archived, or explicitly excluded.
      if (current.has(id) || exclude.has(id) || catalog?.get?.(id as never)) continue
      if (await this.neverStarted(id).catch(() => false)) candidates.push(id)
    }
    if (options.dryRun !== false || !candidates.length) return { candidates, deleted: [], archiveKnown }
    const persistence = this.ctx.get?.('sessionPersistence' as never) as any
    // Each candidate is checked again and deleted inside its own lane, after
    // its in-flight work (a bind, a choice): the scan above awaited I/O per
    // session, so a draft the person opened or wrote to since then is kept.
    // Candidates are never loaded, so no activity is stopped and nothing is
    // archived first.
    const deleted: string[] = []
    const projects = new Set<string>()
    for (const id of candidates) {
      const removed = await this.lane(id, async () => {
        if (catalog?.get?.(id as never)) return false
        if (!(await this.neverStarted(id).catch(() => false))) return false
        const binding = this.state.read().sessions[id]
        const project = this.state.read().pending[id]?.project ?? binding?.project
        await persistence?.deleteSessions?.([id])
        this.store?.forget(id)
        this.state.update((s) => { delete s.sessions[id]; delete s.checkpoints[id]; delete s.mirror[id]; delete s.pending[id] })
        this.forgetFreshReads(id)
        if (project) projects.add(project)
        // The log is gone first, so the slow Sandbox removal cannot widen the
        // window in which the draft could start.
        if (binding?.kind === 'project' && binding.sandbox) {
          try { await this.lfs.sandbox.remove(binding.sandbox, { force: true }) } catch { /* an empty Sandbox may already be gone */ }
        }
        return true
      })
      if (removed) deleted.push(id)
    }
    for (const id of deleted) this.ctx.layerfs.emit('layerfs-session', { sessionId: id, deleted: true })
    for (const project of projects) this.ctx.layerfs.emit('layerfs-workspaces-changed', { project })
    return { candidates, deleted, archiveKnown }
  }

  /**
   * Delete this home's project conversations (Presets Reset and Build). A
   * loaded session is archived with its activity stopped first, through DSH's
   * workspace registry, so it cannot start another turn; then its log, owner
   * route, binding, checkpoints and store progress are removed. Sandboxes are
   * force-closed; project files and the copies archived inside Stores are not
   * touched (a deletion record keeps store sync from importing them back).
   * @returns the deleted session ids.
   */
  async deleteProjectConversations(stores: readonly HomeStore[]): Promise<string[]> {
    return this.deleteConversations(this.projectConversations(stores))
  }

  /**
   * Delete one project's conversations on this DSH (the sidebar's Remove):
   * every conversation routed, bound or pending to it. With a project identity
   * a conversation belongs by that identity (a renamed project's old address
   * included), and by address only when it records no identity, so a
   * different project that reused the address keeps its conversations. The
   * project itself (files, Branches, Store) is not touched; the deletion is
   * {@link deleteProjectConversations}'s.
   * @returns the deleted session ids.
   */
  async deleteConversationsOfProject(project: string, projectId?: string): Promise<string[]> {
    const persistence = this.ctx.get?.('sessionPersistence' as never) as any
    const state = this.state.read()
    const found = new Map<string, string>()
    const mine = (id: string, key: string) => {
      const recorded = projectId ? persistence?.projectIdOf?.(id) as string | undefined : undefined
      return recorded ? recorded === projectId : key === project
    }
    for (const id of persistence?.ownedSessionIds?.() ?? []) {
      const key = persistence.ownerOf?.(id)?.project
      if (key && mine(id, key)) found.set(id, key)
    }
    for (const b of Object.values(state.sessions)) if (b.project && (b.kind === 'project' || b.kind === 'shared') && mine(b.sessionId, b.project)) found.set(b.sessionId, b.project)
    for (const [id, p] of Object.entries(state.pending)) if (p.project && mine(id, p.project)) found.set(id, p.project)
    return this.deleteConversations([...found].map(([id, key]) => ({ id, project: key })).sort((a, b) => a.id.localeCompare(b.id)))
  }

  /**
   * Delete one project conversation on this DSH (a conversation row's Delete),
   * as {@link deleteProjectConversations} does. A conversation that is not a
   * LayerFS project's is refused: DSH's own conversations are DSH's to delete.
   * @returns the deleted session ids (this one).
   */
  async deleteConversation(id: string): Promise<string[]> {
    const persistence = this.ctx.get?.('sessionPersistence' as never) as any
    const state = this.state.read()
    const binding = state.sessions[id]
    const project = (binding && (binding.kind === 'project' || binding.kind === 'shared') ? binding.project : undefined)
      ?? state.pending[id]?.project ?? persistence?.ownerOf?.(id)?.project as string | undefined
    if (!project) throw new CliError('NotFound', `Conversation ${id} is not a LayerFS project conversation on this DSH`)
    return this.deleteConversations([{ id, project }])
  }

  private async deleteConversations(targets: readonly { id: string, project: string }[]): Promise<string[]> {
    if (!targets.length) return []
    const ids = targets.map((t) => t.id)
    for (const id of ids) {
      if (!this.ctx.sessions.get(id as never)) continue
      await this.ctx.workspaceRegistry.archiveSession(id as never, { stopActivity: true }).catch((error: any) => {
        this.ctx.logger('layerfs').warn('delete: could not stop session %s: %s', id, String(error?.message ?? error))
      })
    }
    await Promise.all(ids.map((id) => this.lane(id, async () => {})))
    for (const id of ids) {
      const binding = this.binding(id)
      if (binding?.kind === 'project' && binding.sandbox) await this.lfs.sandbox.remove(binding.sandbox, { force: true }).catch(() => {})
      this.store?.forget(id)
    }
    const persistence = this.ctx.get?.('sessionPersistence' as never) as any
    await persistence?.deleteSessions?.(ids)
    this.state.update((s) => { for (const id of ids) { delete s.sessions[id]; delete s.checkpoints[id]; delete s.mirror[id]; delete s.pending[id] } })
    for (const id of ids) this.forgetFreshReads(id)
    for (const id of ids) this.ctx.layerfs.emit('layerfs-session', { sessionId: id, deleted: true })
    for (const project of new Set(targets.map((t) => t.project))) this.ctx.layerfs.emit('layerfs-workspaces-changed', { project })
    return ids
  }

  /** Removal invalidates execution, not conversation ownership or checkpoints. */
  async forgetProject(project: string): Promise<void> {
    for (const binding of Object.values(this.state.read().sessions)) if (binding.project === project) {
      this.save({ ...binding, state: 'failed', executionState: 'interrupted', mount: undefined, ws: undefined,
        error: 'The project was removed. Conversation history and checkpoint references are retained.', interruption: { kind: 'removed', at: Date.now() } })
    }
    this.ctx.layerfs.emit('layerfs-workspaces-changed', { project })
  }

  /**
   * Everything the session panel shows. `observe` (every poll and
   * effect-driven read from the views) changes nothing: a refused machine,
   * Store or Workspace check is answered as unavailable, but the binding is
   * neither interrupted nor saved; that stays with an explicit action or the
   * host's own availability poll.
   *
   * An observed read is cheap when nothing moved: a successful identity check
   * stands for OBSERVED_IDENTITY_MS since the poll that last used it (and at
   * most OBSERVED_IDENTITY_FULL_MS since it was read), machine and Store
   * readiness for OBSERVED_READY_MS since the poll that last used it (and at
   * most OBSERVED_READY_FULL_MS since it was read), and an answer whose local
   * revision is unchanged (inside OBSERVED_MEMO_MS) is returned with no CLI call
   * at all. Every other observed read still reads the Workspace status and the
   * mount, so the unsaved count and a lost mount stay current. `debug` adds
   * `timing`, the per-step split.
   */
  async view(sessionId: string, options: { observe?: boolean, debug?: boolean } = {}): Promise<SessionView> {
    // The panel polls and effect reads are the session's own host work: every
    // LayerFS call below runs in its trace context, so a successful poll folds
    // into that session's counter (and carries its `dsh:<sessionId>:` tag)
    // instead of disappearing as an untagged host call. A session with no
    // project (a plain folder or a not-yet-placed draft) makes no project call.
    const binding = this.binding(sessionId)
    const effective = binding?.kind === 'shared' && binding.parent ? this.binding(binding.parent) ?? binding : binding
    const project = effective?.project ?? this.placeOfId(sessionId)?.project
    if (!project) return this.viewNow(sessionId, options)
    return this.hostOperation(sessionId, project, undefined, () => this.viewNow(sessionId, options))
  }

  /** {@link view} in the session's trace context (see there). */
  private async viewNow(sessionId: string, options: { observe?: boolean, debug?: boolean } = {}): Promise<SessionView> {
    const observe = options.observe === true
    const profile = options.debug === true
      ? { at: performance.now(), phases: {} as Record<string, number>, calls: { identity: 0, readiness: 0, status: 0 }, memo: false }
      : undefined
    /** Time one awaited step into the opt-in phase split. */
    const time = async <T,>(name: string, run: () => Promise<T> | T): Promise<T> => {
      if (!profile) return await run()
      const at = performance.now()
      try { return await run() } finally { profile.phases[name] = +((profile.phases[name] ?? 0) + (performance.now() - at)).toFixed(1) }
    }
    const timing = (): SessionViewTiming | undefined => {
      if (!profile) return undefined
      const total = +(performance.now() - profile.at).toFixed(1)
      if (profile.memo) return { phases: { total }, calls: { identity: 0, readiness: 0, status: 0 }, memo: true }
      const named = Object.values(profile.phases).reduce((sum, ms) => sum + ms, 0)
      return { phases: { ...profile.phases, total, other: +Math.max(0, total - named).toFixed(1) }, calls: profile.calls, memo: false }
    }
    let binding = this.binding(sessionId) ?? null
    let effective = binding
    if (binding?.kind === 'shared' && binding.parent) effective = this.binding(binding.parent) ?? binding
    const persistence = this.ctx.get?.('sessionPersistence' as never) as any
    const ownerId = effective?.sessionId ?? sessionId
    // The cheap path first: while this session's own revision holds, the last
    // answer still stands, and answering it costs no CLI call at all. Memos are
    // only kept for a placed session (an archived row has no local binding).
    if (observe && binding?.project) {
      const kept = this.observedAnswers?.get(sessionId)
      if (kept && kept.revision === this.observedRevision(sessionId, ownerId, effective, persistence) && Date.now() - kept.at < OBSERVED_MEMO_MS) {
        if (profile) profile.memo = true
        return profile ? { ...kept.view, timing: timing() } : kept.view
      }
    }
    let archivedCheckpoints: Checkpoint[] = []
    if (!effective) {
      const project = this.placeOfId(sessionId)?.project
      if (project) {
        const metadata = await persistence?.readSidecar?.(sessionId).catch(() => undefined)
        archivedCheckpoints = metadata?.checkpoints ?? []
        effective = { sessionId, kind: 'project', project, projectId: persistence?.projectIdOf?.(sessionId), branch: metadata?.codeBranch,
          anchor: this.anchorOf(project), scratch: '', state: 'closed', executionState: 'inactive', createdAt: 0, updatedAt: 0 }
      }
    }
    let available = true
    let reason: string | undefined
    let refusal: string | undefined
    try {
      // Observed reads (the views' polls) reuse a successful identity check and a
      // successful readiness check; a refusal is never cached, and the
      // non-observe path always reads afresh.
      if (observe) {
        let row = this.observedIdentity(ownerId, effective)
        if (!row) {
          row = await time('identity', () => persistence?.assertSessionIdentity?.(ownerId))
          if (row) {
            if (profile) profile.calls.identity = 2
            this.rememberObservedIdentity(ownerId, effective, row)
          }
        }
        if (row && !this.observedReadiness(ownerId, effective, row)) {
          await time('readiness', () => this.assertReady(row!, effective?.machine))
          if (profile) profile.calls.readiness = 2
          this.rememberObservedReadiness(ownerId, effective, row)
        }
      } else {
        const row = await persistence?.assertSessionIdentity?.(ownerId)
        if (row) await this.assertReady(row, effective?.machine)
      }
    } catch (error: any) {
      available = false
      reason = String(error?.message ?? error)
      refusal = error?.code
      // A refusal is never cached: the next observed read checks identity and
      // readiness again, and no older answer may stand in for this one.
      if (observe) { this.freshIdentity?.delete(ownerId); this.freshReadiness?.delete(ownerId); this.observedAnswers?.delete(sessionId) }
    }
    let status: unknown = null
    if (available && effective?.kind === 'project' && effective.state === 'bound' && effective.ws) {
      const ws = effective.ws
      if (profile) profile.calls.status = 1
      status = await time('status', () => this.lfs.workspace.status(ws, { detail: true }).catch((error: any) => {
        available = false
        reason = String(error?.message ?? error)
        refusal = error?.code
        // A failed status is never answered from an older successful memo.
        this.observedAnswers?.delete(sessionId)
        return { error: errorOf(error) }
      }))
    }
    const stored = effective && !observe ? this.binding(effective.sessionId) : undefined
    if (!available && stored?.state === 'bound') {
      // Same deactivation as the background poll: the panel just noticed first.
      this.interrupt(stored.sessionId, reason ?? 'The project is unavailable.', refusal === 'Unavailable' ? 'availability' : 'blocked')
    } else if (available && stored && stored.state !== 'bound' && stored.interruption?.kind === 'availability' && stored.error) {
      // Access returned: availability changes, execution still waits for a new message.
      this.save({ ...stored, error: undefined })
    }
    if (stored) {
      effective = this.binding(stored.sessionId) ?? effective
      binding = this.binding(sessionId) ?? binding
    }
    const project = effective?.project ?? this.placeOfId(sessionId)?.project ?? null
    const live = this.ctx.sessions?.get?.(sessionId as never) as any
    const snapshot = project ? await persistence?.local?.stat(sessionId) : undefined
    const mirror = effective ? this.state.read().mirror[effective.sessionId] ?? null : null
    const view: SessionView = {
      sessionId,
      // A new object: the persisted binding never gains these fields.
      binding: effective ? { ...effective, ...branchFields(effective.sessionId, effective.branch) } : null,
      checkpoints: effective ? this.checkpoints(effective.sessionId).length ? this.checkpoints(effective.sessionId) : archivedCheckpoints : [],
      project,
      execution: project ? { state: effective?.executionState ?? (effective?.state === 'bound' ? 'active' : effective?.state === 'failed' ? 'interrupted' : 'inactive'), available, reason, projectId: persistence?.projectIdOf?.(sessionId) } : undefined,
      status,
      mirror,
      archive: project ? {
        localCount: live ? live.snapshotEvents(0).length : snapshot?.eventCount ?? 0,
        savedCount: mirror?.count ?? 0,
        ...(mirror ? { updatedAt: mirror.updatedAt, ...(mirror.error ? { error: mirror.error } : {}) } : {}),
      } : null,
    }
    // A successful observed answer stands while its revision holds: the revision
    // is read again now, after the awaits, so a state change during the read is
    // never answered stale.
    if (observe && available && binding?.project) {
      const kept = (this.observedAnswers ??= new Map())
      kept.set(sessionId, { at: Date.now(), revision: this.observedRevision(sessionId, ownerId, effective, persistence), ownerId, project: effective?.project ?? project ?? '', machine: effective?.machine, view })
      while (kept.size > 256) kept.delete(kept.keys().next().value!)
    }
    return profile ? { ...view, timing: timing() } : view
  }
}
