/**
 * Project-owned sessions use a private LayerFS execution context and a selected
 * local folder as scratch. Normal sessions retain stock DSH behavior.
 *
 * Explicit bindings, pending choices, and durable persistence ownership select
 * the project; recorded legacy anchors are supported for migration only.
 * Native and remote projects both use scratch as the local working directory.
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
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { CliError, pages, sandboxWorkspaces, type Lfs } from '../layerfs/cli.ts'
import { JsonFile } from '../service.ts'
import { initialState, type Binding, type Checkpoint, type SessionsState, type SimulationBinding, type SimulationTarget } from './state.ts'
import type { SessionStore } from './store.ts'
import { withTraceContext, type Invocation } from '../layerfs/tracing.ts'
import { classifyStore, pgMachineOf, storeOf, type StoreHealth } from './availability.ts'

/** How long a passed identity and readiness check stands for pre-step checks. */
const IDENTITY_FRESH_MS = 15_000

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
const exists = (error: any) => error?.code === 'Exists' || error?.code === 'NameTaken'

/** Where a session works: a LayerFS project, its parent's Workspace, or a plain folder (stock DSH). */
export type Place =
  | { readonly kind: 'project', readonly project: string, readonly anchor: string }
  | { readonly kind: 'shared', readonly parent: string, readonly anchor: string }
  | { readonly kind: 'folder', readonly cwd: string }

/** The state a session panel shows. */
export interface SessionView {
  readonly sessionId: string
  readonly binding: Binding | null
  readonly checkpoints: readonly Checkpoint[]
  readonly project: string | null
  /** The session works in the Scratch project (it has no project of its own). */
  readonly scratchProject: boolean
  readonly status: unknown
  readonly mirror: unknown
  readonly execution?: { state: 'inactive' | 'activating' | 'active' | 'interrupted', available: boolean, reason?: string, projectId?: string }
  readonly archive: { localCount: number, savedCount: number, updatedAt?: number, error?: string } | null
}

/** Whether a session has not started its first turn (its preset can still change). */
const isFresh = (agent: any): boolean => !agent.session.snapshotEvents(0).some((e: any) => e.type === 'turn/start')

export class LayerfsSessions extends Service {
  static inject = ['layerfs', 'layerfsRemote', 'workspaceRegistry', 'workingDirectory', 'sessions']
  readonly state: JsonFile<SessionsState>
  /** One operation at a time per session (bind, checkpoint, restore). */
  private readonly lanes = new Map<string, Promise<unknown>>()
  private scratchReady: Promise<void> | undefined
  /** The LayerFS session store, while the sessions area is up (the persistence row imports through it). */
  store: SessionStore | undefined
  /** Last observed health of each Store a project conversation uses (read-only polling). */
  private readonly storeHealth = new Map<string, StoreHealth>()
  /** When each PostgreSQL Store's server was last asked (one connection per ask). */
  private readonly serverChecked = new Map<string, number>()
  private availabilityRun: Promise<void> | undefined

  constructor(ctx: Context) {
    super(ctx, 'layerfsSessions')
    this.state = new JsonFile(join(ctx.layerfs.root, 'sessions.json'), initialState)
  }

  get lfs(): Lfs { return this.ctx.layerfs.lfs }

  /** Separate installations may resume one archived conversation in the same home. */
  private simulationSandbox(sessionId: string): string {
    const installation = createHash('sha256').update(this.ctx.layerfs.root).digest('hex').slice(0, 10)
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

  /** `<root>/projects/<store>/<name>`. */
  anchorOf(project: string): string {
    const [store, name] = project.split('/')
    if (!store || !name || project.split('/').length !== 2) throw new CliError('InvalidInput', `Not a project key: ${project}`)
    return join(this.ctx.layerfs.root, 'projects', store, name)
  }

  get scratchAnchor(): string { return join(this.ctx.layerfs.root, 'scratch') }

  /** Whether `project` is the Scratch project. */
  isScratch(project: string | undefined): boolean { return project === this.ctx.layerfs.scratchProject }

  private writeAnchor(dir: string, text: string): void {
    mkdirSync(join(dir, 'sessions'), { recursive: true })
    const readme = join(dir, 'README.md')
    if (!existsSync(readme)) writeFileSync(readme, text)
  }

  /**
   * The project's anchor directory (`<root>/projects/<store>/<name>`): the
   * parent of its sessions' scratch folders. It is a real directory but no
   * DSH workspace — sessions stay in whichever workspace they were placed in.
   */
  ensureAnchor(project: string): string {
    const anchor = this.anchorOf(project)
    this.writeAnchor(anchor, `# ${project}\n\nThe DeepSeek Harness scratch area of LayerFS project \`${project}\`.\n\nEach session works in its own LayerFS Workspace (branch \`dsh.<session>\`), used for project execution and checkpointed at the end of changed turns. \`sessions/<session>/\` is that\nsession's scratch folder: it is never saved into the project.\n`)
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
    this.writeAnchor(anchor, `# Scratch\n\nA workspace for sessions without a LayerFS project: sessions here run as ordinary\nDeepSeek Harness sessions in this folder.\n`)
    const workspace = await this.ctx.workspaceRegistry.create(anchor, 'Scratch')
    if (workspace.title !== 'Scratch') await workspace.setTitle('Scratch')
    return { workspaceId: String(workspace.id), anchor }
  }

  /** Make the Scratch project (a SQLite Store on native, initialized empty) when it does not exist. */
  async ensureScratchProject(): Promise<string> {
    const key = this.ctx.layerfs.scratchProject
    this.scratchReady ??= (async () => {
      try { await this.lfs.project.get(key); return } catch (error: any) {
        if (error?.code !== 'NoSuchProject' && error?.code !== 'NoSuchStore') throw error
      }
      await this.ctx.layerfs.ensureNative()
      await this.lfs.store.create(key.split('/')[0]).catch((error: any) => { if (!exists(error)) throw error })
      const sources = join(this.ctx.layerfs.root, 'project-sources')
      mkdirSync(sources, { recursive: true, mode: 0o700 })
      const empty = mkdtempSync(join(sources, 'scratch-'))
      try {
        await this.lfs.project.init(key, empty).catch((error: any) => { if (!exists(error)) throw error })
      } finally {
        rmSync(empty, { recursive: true, force: true })
      }
      this.ctx.layerfs.emit('storage-changed', { store: key.split('/')[0] })
    })()
    try { await this.scratchReady } catch (error) { this.scratchReady = undefined; throw error }
    return key
  }

  /** Which project workspace a session `cwd` is, if it is one. */
  classify(cwd: string | undefined): { project: string, anchor: string } | undefined {
    if (!cwd) return undefined
    const at = real(cwd)
    const root = real(join(this.ctx.layerfs.root, 'projects'))
    for (const entry of Object.values(this.state.read().projects)) {
      if (!entry.workspaceId) continue
      // Only anchors under the projects root: state may hold an old entry for
      // the Scratch workspace, which is a plain folder now.
      if (real(entry.anchor) === at && at.startsWith(`${root}/`)) return { project: entry.project, anchor: entry.anchor }
    }
    return undefined
  }

  /**
   * Record the project a session works in — the New Session control or a
   * Projects page names the blank/folder session it belongs to. `project`
   * `null` clears the choice; a recorded binding always outranks the pending
   * one, so a bound session cannot be re-placed this way.
   */
  async choose(sessionId: string, project: string | null, projectId?: string): Promise<void> {
    // The choice runs in the session's lane, and pre-step waits for the lane
    // before resolving the place: a first message sent while the choice is in
    // flight runs under the chosen owner, never as the previous one.
    await this.lane(sessionId, () => this.chooseNow(sessionId, project, projectId))
  }

  private async chooseNow(sessionId: string, project: string | null, projectId?: string): Promise<void> {
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
    await persistence?.migrateProject?.(live ?? sessionId, project)
    this.state.update((s) => {
      if (project) s.pending[sessionId] = { project }
      else delete s.pending[sessionId]
    })
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
    const where = this.classify(header.cwd)
    if (where) return { kind: 'project', ...where }
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

  private save(binding: Binding): Binding {
    binding.updatedAt = Date.now()
    this.state.update((s) => { s.sessions[binding.sessionId] = binding })
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
      onError: (e) => this.ctx.logger('layerfs').warn('record host operation: %s', String(e)),
    }, run)
  }

  /**
   * The machine a project's Sandboxes run on: a sqlite Store's machine; for a
   * PostgreSQL Store `preferred` when the Store is attached to it, else the
   * default of {@link pgMachineOf}.
   */
  private async machineFor(project: string, preferred?: string | null): Promise<string> {
    const info = await this.lfs.project.get(project)
    if (info.kind !== 'postgresql') return info.machine ?? 'native'
    const store = storeOf(project)!
    const machine = pgMachineOf(await this.lfs.store.get(store), preferred)
    if (!machine) throw new CliError('Unsupported', `Attach ${store} to a machine to run its projects.`)
    return machine
  }

  /**
   * Make sure the session's Sandbox runs and its Workspace is mounted on its
   * branch. Answers the mount's host path on `native`; on any other machine the
   * mount lives inside the Sandbox, the session works through the LayerFS CLI
   * (`workspace.exec`, `file.*`) and its working directory stays its scratch
   * folder, so the answer is undefined.
   */
  private async mount(binding: Binding): Promise<string | undefined> {
    const held = this.ctx.layerfs.exclusive?.()
    if (held) throw new CliError('ConnectBusy', held)
    const { project, sandbox, branch } = binding as Required<Binding>
    const native = (binding.machine ?? 'native') === 'native'
    if (native) await this.ctx.layerfs.ensureNative()
    let observed: any
    try { observed = await sandboxWorkspaces(this.lfs, sandbox) } catch (error: any) {
      if (error?.code !== 'NoSuchSandbox' && error?.code !== 'NotFound') throw error
    }
    if (!observed || observed.state === 'stopped' || observed.state === 'gone' || observed.down_reason) {
      if (observed) await this.lfs.sandbox.close(sandbox, { force: true }).catch(() => {})
      await this.lfs.sandbox.create(project, sandbox, binding.machine ?? 'native')
      observed = { workspaces: [] }
    }
    const existing = (observed.workspaces ?? []).find((w: any) => w.name === WS_NAME)
    if (existing && existing.branch === branch && (existing.directory ?? existing.path)) return native ? (existing.directory ?? existing.path) : undefined
    if (existing) await this.lfs.workspace.unmount(`${sandbox}:${WS_NAME}`, { force: true, discard: false }).catch(() => this.lfs.workspace.unmount(`${sandbox}:${WS_NAME}`, { force: true, discard: true }))
    const mounted = await this.lfs.workspace.mount(sandbox, branch, { name: WS_NAME })
    binding.base ??= mounted.base ?? mounted.base_layer ?? null
    if (mounted.ws) binding.ws = mounted.ws
    return native ? mounted.path : undefined
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
        const preparing = this.binding(sessionId)
        if (preparing?.kind === 'project') this.save({ ...preparing, executionState: 'activating' })
        if (this.isSimulationManaged(sessionId)) return await this.bindSimulation(agent, place)
        if (place.kind === 'shared') return await this.bindShared(agent, place.parent, place.anchor, strict)
        await this.hostOperation(sessionId, place.project, undefined, () => this.bindProject(agent, place.project, place.anchor, source))
      } catch (error: any) {
        const previous = this.binding(sessionId)
        this.ctx.logger('layerfs').warn('session %s: bind failed: %s', sessionId, error?.message ?? error)
        if (place.kind === 'project') {
          this.save({
            ...(previous ?? { sessionId, kind: 'project', anchor: place.anchor, scratch: join(place.anchor, 'sessions', sessionId), createdAt: Date.now(), updatedAt: Date.now() }),
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
    // Normal sessions are stock DSH: no LayerFS lock, identity or binding applies.
    if (this.placeOf(agent.session ?? { id: sessionId }).kind === 'folder' && !this.simulationOf(sessionId)) return
    const held = this.ctx.layerfs.exclusive?.()
    if (held) throw new CliError('ConnectBusy', held)
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
        const machine = row.kind === 'postgresql' ? (binding?.machine ?? 'native') : (row.machine ?? 'native')
        await this.assertReady(row, machine)
        if (binding?.branch) {
          const latest = [...this.checkpoints(id)].reverse().find((checkpoint) => checkpoint.commit && !checkpoint.error)
          if (latest?.commit) await this.lfs.file.list(row.key, latest.branch ?? binding.branch, '/', latest.commit, { page_size: 1 }).catch(() => { throw new CliError('CheckpointUnavailable', 'The latest saved file checkpoint is unavailable in this Store. History and checkpoint references are retained; recover that checkpoint before continuing.') })
        }
        if (binding && binding.machine && binding.machine !== machine) this.save({ ...binding, machine, state: 'closed', executionState: 'inactive', mount: undefined, ws: undefined })
      }
      checked.set(id, Date.now())
    } catch (error: any) {
      const message = String(error?.message ?? error)
      const kind = error?.code === 'Unavailable' ? 'availability' : 'blocked'
      const current = binding ? this.binding(binding.sessionId) : undefined
      // An active context is deactivated; an inactive one only records why it cannot start.
      if (current?.state === 'bound') this.interrupt(current.sessionId, message, kind)
      else if (current) this.save({ ...current, error: message, interruption: { kind, at: Date.now() } })
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

  private scratchFor(anchor: string, sessionId: string): string {
    const dir = join(anchor, 'sessions', sessionId)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  /** The selected folder is scratch on every machine; generated scratch is a fallback. */
  private selectedScratch(agent: any, anchor: string, previous?: Binding): { scratch: string, scratchManaged: boolean } {
    if (previous?.scratch && existsSync(previous.scratch) && statSync(previous.scratch).isDirectory()) return { scratch: previous.scratch, scratchManaged: previous.scratchManaged === true }
    const cwd = this.ctx.workingDirectory?.get(agent.session) ?? agent.session.header?.cwd
    if (cwd && isAbsolute(cwd) && !this.classify(cwd)) {
      if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new CliError('ScratchUnavailable', 'Select an existing local folder to use as scratch for this project session')
      return { scratch: cwd, scratchManaged: false }
    }
    return { scratch: this.scratchFor(anchor, String(agent.id)), scratchManaged: true }
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
    if (this.isScratch(project)) await this.ensureScratchProject()
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
          machine: await this.machineFor(project), sandbox: metadata.simulation ? this.simulationSandbox(sessionId) : sandboxOf(sessionId), ws: `${metadata.simulation ? this.simulationSandbox(sessionId) : sandboxOf(sessionId)}:${WS_NAME}`,
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
    let binding: Binding
    let forkReceipt: string | undefined
    if (existing?.branch && existing.sandbox) {
      const resolved = await persistence?.assertSessionIdentity?.(sessionId)
      binding = { ...existing, ...selected, machine: resolved ? (resolved.kind === 'postgresql' ? existing.machine ?? 'native' : resolved.machine ?? 'native') : existing.machine, state: existing.state }
    } else {
      const machine = await this.machineFor(project, existing?.machine)
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
    try {
      await (this.ctx.get?.('sessionPersistence' as never) as any)?.assertSessionIdentity?.(sessionId)
      const status = await this.lfs.workspace.status(binding.ws)
      // In-place edits count as dirty inodes with no new directory entries.
      const entries = Math.max(Number(status?.overlay?.inodes ?? 0) || 0, Number(status?.overlay?.entries ?? 0) || 0)
      if (!entries && !status?.overlay?.pending_merge && !status?.head_moved_since_mount && kind === 'turn') return undefined
      // Tagged with this session's own id: the session that owns the checkpoint.
      const result = await this.hostOperation(sessionId, binding.project!, turn, () => this.lfs.workspace.commit(binding.ws!, { message }), (invocation) => { receipt = invocation.id })
      const commit = result?.kind === 'Committed' ? result.commit?.id ?? result.head : result?.head ?? null
      // Agents change files with `file` calls and their own Workspaces' Commits, so the
      // session Branch often moved while this Workspace changed nothing: count what moved.
      const changed = result?.kind === 'Committed' ? Math.max(entries, 1)
        : status?.head_moved_since_mount && commit ? await this.pathsChanged(binding.project!, status.base ?? status.base_layer, commit) : 0
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
      const page: any = await this.lfs.commit.diff(project, from, to, { paths_only: true, page_size: 1000 })
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
      await this.lfs.branch.fork(project, branch, from, commit)
    } catch (error: any) {
      if (from === 'main' || exists(error)) throw error
      await this.lfs.branch.fork(project, branch, 'main', commit)
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
  private interrupt(ownerId: string, reason: string, kind: NonNullable<Binding['interruption']>['kind']): void {
    const bindings = this.state.read().sessions
    for (const binding of Object.values(bindings)) {
      if (binding.sessionId !== ownerId && !(binding.kind === 'shared' && binding.parent === ownerId)) continue
      this.save({ ...binding, state: 'closed', executionState: 'interrupted', mount: undefined, ws: undefined, error: reason, interruption: { kind, at: Date.now() } })
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
    for (const owner of this.owners((b) => !!b.sandbox && stopped.has(b.machine ?? 'native') && (b.state === 'bound' || !!b.ws))) {
      this.interrupt(owner.sessionId, `Machine ${owner.machine ?? 'native'} was stopped. Execution was interrupted; send a new message after it is started again.`, 'availability')
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
    try { rows = (await this.lfs.store.list())?.items ?? [] } catch (error: any) {
      // Not knowing is not evidence of loss: never deactivate on a failed list.
      this.ctx.logger('layerfs').warn('availability: store list: %s', String(error?.message ?? error))
      return
    }
    let changed = false
    for (const name of stores) {
      const row = rows.find((r) => r?.name === name)
      let status: any
      const askServer = row?.kind === 'postgresql' && Date.now() - (this.serverChecked.get(name) ?? 0) >= 60_000
      if (askServer || row?.state === 'down') {
        if (askServer) this.serverChecked.set(name, Date.now())
        status = await this.lfs.store.status(name).catch(() => undefined)
      }
      const previous = this.storeHealth.get(name)
      let health = classifyStore(row, status)
      // A PostgreSQL verdict holds until the server is asked again.
      if (row?.kind === 'postgresql' && !askServer && previous?.state === 'unavailable' && health.state === 'available') health = previous
      if (previous?.state !== health.state || previous?.reason !== health.reason) changed = true
      this.storeHealth.set(name, health)
      for (const owner of watched) {
        if (storeOf(owner.project) !== name) continue
        if ((health.state === 'unavailable' || health.state === 'removed') && owner.state === 'bound') {
          // Queued behind the session's own work (a bind or save in flight), never blocking the next poll.
          const reason = `${health.reason ?? 'The project Store is unavailable.'} Execution was interrupted; history is retained and a new message re-activates it after access returns.`
          void this.lane(owner.sessionId, async () => {
            if (this.binding(owner.sessionId)?.state === 'bound') this.interrupt(owner.sessionId, reason, 'availability')
          }).catch((error) => this.ctx.logger('layerfs').warn('availability: interrupt %s: %s', owner.sessionId, String(error?.message ?? error)))
        } else if (health.state === 'available' && owner.state !== 'bound' && owner.interruption?.kind === 'availability' && owner.error) {
          const current = this.binding(owner.sessionId)
          if (current && current.state !== 'bound' && current.interruption?.kind === 'availability') this.save({ ...current, error: undefined })
        }
      }
    }
    if (changed) this.ctx.layerfs.emit('layerfs-availability', { stores: Object.fromEntries([...stores].map((s) => [s, this.storeHealth.get(s)])) })
  }

  /** The machine and Store a project executes on must be ready now (read-only; starts nothing). */
  private async assertReady(row: { kind?: string | null, machine?: string | null, store: string }, placed?: string | null): Promise<void> {
    const machine = row.kind === 'postgresql' ? (placed ?? 'native') : (row.machine ?? 'native')
    const status = await this.lfs.machine.get(machine)
    if (!['ready', 'running'].includes(status?.state) || status?.op) throw new CliError('Unavailable', `Machine ${machine} is not ready. Start or repair it, then send the message again.`)
    const store = await this.lfs.store.status(row.store)
    const health = classifyStore({ name: row.store, kind: row.kind ?? store?.kind }, store)
    this.storeHealth.set(row.store, health)
    if (health.state !== 'available') throw new CliError('Unavailable', health.reason ?? 'The project Store is not ready. Restore access, then send the message again.')
  }

  /** Save and close execution resources; a new message activates them again. */
  async close(sessionId: string, reason: 'idle' | 'user' = 'user'): Promise<void> {
    await this.lane(sessionId, async () => {
      const binding = this.binding(sessionId)
      if (!binding || binding.kind !== 'project' || binding.state !== 'bound' || !binding.sandbox) return
      const saved = await this.checkpoint(sessionId, 'idle', this.lastTurn(sessionId), reason === 'idle' ? 'Saved before the idle Sandbox closed' : 'Saved before closing')
      if (saved?.error) throw new CliError(saved.error.code, saved.error.message)
      await this.lfs.sandbox.close(binding.sandbox, { force: true })
      this.save({ ...binding, state: 'closed', executionState: 'inactive', mount: undefined, ws: undefined })
      this.store?.schedule(sessionId, 0)
    })
  }

  /** Forget a binding without deleting the user's selected folder or local history. */
  async forget(sessionId: string): Promise<void> {
    if (this.isSimulationManaged(sessionId)) throw new CliError('Busy', 'Settle script execution before forgetting its binding')
    const binding = this.binding(sessionId)
    if (!binding) return
    if (binding.kind === 'project' && binding.sandbox) await this.lfs.sandbox.close(binding.sandbox, { force: true }).catch(() => {})
    // Scratch is a user-selected folder and may be shared with normal sessions.
    // Even legacy generated scratch can hold evidence; release it separately.
    this.state.update((s) => { delete s.sessions[sessionId]; delete s.pending[sessionId] })
  }

  /** Save and close every session Sandbox of a project (before the project is removed). */
  async closeProject(project: string): Promise<void> {
    for (const b of Object.values(this.state.read().sessions)) {
      if (b.project !== project || b.kind !== 'project') continue
      if (b.state === 'bound') await this.close(b.sessionId, 'user').catch(() => {})
      if (b.sandbox) await this.lfs.sandbox.close(b.sandbox, { force: true }).catch(() => {})
    }
    // Session Sandboxes another DSH on this LayerFS home made (same naming) block removal too.
    const listed = await pages((paging) => this.lfs.sandbox.list(project, paging)).catch(() => [] as any[])
    for (const s of listed) if (typeof s?.name === 'string' && s.name.startsWith('dsh-')) await this.lfs.sandbox.close(s.name, { force: true }).catch(() => {})
  }

  /**
   * This LayerFS home's Stores, with their Store ID when the CLI reports one.
   * `also` adds names known to belong here (a preset's Stores) so a failed or
   * partial listing still covers them.
   */
  async homeStores(also: readonly string[] = []): Promise<HomeStore[]> {
    const rows: any[] = await this.lfs.store.list().then((value: any) => value?.items ?? [], () => [])
    const out = new Map<string, HomeStore>(also.map((name) => [name, { name }]))
    for (const row of rows) {
      if (typeof row?.name !== 'string') continue
      const stats = await this.lfs.store.stats(row.name).catch(() => undefined)
      out.set(row.name, { name: row.name, ...(stats?.store_id ? { id: String(stats.store_id) } : {}) })
    }
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
   * Delete this home's project conversations (Presets Reset and Build). A
   * loaded session is archived with its activity stopped first, through DSH's
   * workspace registry, so it cannot start another turn; then its log, owner
   * route, binding, checkpoints and store progress are removed. Sandboxes are
   * force-closed; project files and the copies archived inside Stores are not
   * touched (a deletion record keeps store sync from importing them back).
   * @returns the deleted session ids.
   */
  async deleteProjectConversations(stores: readonly HomeStore[]): Promise<string[]> {
    const targets = this.projectConversations(stores)
    if (!targets.length) return []
    const ids = targets.map((t) => t.id)
    for (const id of ids) {
      if (!this.ctx.sessions.get(id as never)) continue
      await this.ctx.workspaceRegistry.archiveSession(id as never, { stopActivity: true }).catch((error: any) => {
        this.ctx.logger('layerfs').warn('reset: could not stop session %s: %s', id, String(error?.message ?? error))
      })
    }
    await Promise.all(ids.map((id) => this.lane(id, async () => {})))
    for (const id of ids) {
      const binding = this.binding(id)
      if (binding?.kind === 'project' && binding.sandbox) await this.lfs.sandbox.close(binding.sandbox, { force: true }).catch(() => {})
      this.store?.forget(id)
    }
    const persistence = this.ctx.get?.('sessionPersistence' as never) as any
    await persistence?.deleteSessions?.(ids)
    this.state.update((s) => { for (const id of ids) { delete s.sessions[id]; delete s.checkpoints[id]; delete s.mirror[id]; delete s.pending[id] } })
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

  /** Everything the session panel shows. */
  async view(sessionId: string): Promise<SessionView> {
    let binding = this.binding(sessionId) ?? null
    let effective = binding
    if (binding?.kind === 'shared' && binding.parent) effective = this.binding(binding.parent) ?? binding
    const persistence = this.ctx.get?.('sessionPersistence' as never) as any
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
    const ownerId = effective?.sessionId ?? sessionId
    let refusal: string | undefined
    try {
      const row = await persistence?.assertSessionIdentity?.(ownerId)
      if (row) await this.assertReady(row, effective?.machine)
    } catch (error: any) { available = false; reason = String(error?.message ?? error); refusal = error?.code }
    let status: unknown = null
    if (available && effective?.kind === 'project' && effective.state === 'bound' && effective.ws) {
      status = await this.lfs.workspace.status(effective.ws).catch((error: any) => { available = false; reason = String(error?.message ?? error); refusal = error?.code; return { error: errorOf(error) } })
    }
    const stored = effective ? this.binding(effective.sessionId) : undefined
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
    const live = this.ctx.sessions.get(sessionId as never) as any
    const snapshot = project ? await persistence?.local?.stat(sessionId) : undefined
    const mirror = effective ? this.state.read().mirror[effective.sessionId] ?? null : null
    return {
      sessionId,
      binding: effective,
      checkpoints: effective ? this.checkpoints(effective.sessionId).length ? this.checkpoints(effective.sessionId) : archivedCheckpoints : [],
      project,
      execution: project ? { state: effective?.executionState ?? (effective?.state === 'bound' ? 'active' : effective?.state === 'failed' ? 'interrupted' : 'inactive'), available, reason, projectId: persistence?.projectIdOf?.(sessionId) } : undefined,
      scratchProject: this.isScratch(effective?.project),
      status,
      mirror,
      archive: project ? {
        localCount: live ? live.snapshotEvents(0).length : snapshot?.eventCount ?? 0,
        savedCount: mirror?.count ?? 0,
        ...(mirror ? { updatedAt: mirror.updatedAt, ...(mirror.error ? { error: mirror.error } : {}) } : {}),
      } : null,
    }
  }
}
