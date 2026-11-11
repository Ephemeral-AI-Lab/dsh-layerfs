/**
 * `ctx.layerfsSessions`: LayerFS project + scratch-folder workspaces for DSH sessions.
 *
 * A LayerFS project becomes one DSH workspace whose directory is the project's
 * scratch-folder workspace (an "anchor" under `<root>/projects/<store>/<name>`):
 * every session of the project shares it as `header.cwd`, so DSH lists them
 * under one workspace. Each session then gets
 *   - its own Branch `dsh.<session>` (forked from `main`, or from a checkpoint),
 *   - its own Sandbox + Workspace mount, which becomes its working directory,
 *   - its own scratch folder `<anchor>/sessions/<session>` (never committed).
 * The Scratch workspace (`<root>/scratch`) is the same without a project.
 * Subagents share their parent's mount. A fork of a session starts its files
 * from the parent's checkpoint at the fork point.
 *
 * Checkpoints: every turn that changed files ends with `workspace.commit`
 * (`agent/turn-stopping`); restore = fork a new Branch from a checkpoint and
 * remount; "branch here" = DSH session fork + Branch fork from the checkpoint.
 * The LayerFS session store mirrors each project session's log into its
 * project (`store.ts`).
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CliError, sandboxWorkspaces, type Lfs } from '../layerfs/cli.ts'
import { JsonFile } from '../service.ts'
import { initialState, type Binding, type Checkpoint, type SessionsState } from './state.ts'

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

/** The state a session panel shows. */
export interface SessionView {
  readonly sessionId: string
  readonly binding: Binding | null
  readonly checkpoints: readonly Checkpoint[]
  readonly project: string | null
  readonly status: unknown
  readonly sessionStore: 'layerfs' | 'local'
  readonly mirror: unknown
}

export class LayerfsSessions extends Service {
  static inject = ['layerfs', 'layerfsRemote', 'workspaceRegistry', 'workingDirectory', 'sessions']
  readonly state: JsonFile<SessionsState>
  /** One operation at a time per session (bind, checkpoint, restore). */
  private readonly lanes = new Map<string, Promise<unknown>>()

  constructor(ctx: Context) {
    super(ctx, 'layerfsSessions')
    this.state = new JsonFile(join(ctx.layerfs.root, 'sessions.json'), initialState)
  }

  get lfs(): Lfs { return this.ctx.layerfs.lfs }

  /** Serialize work per session. */
  lane<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
    const next = (this.lanes.get(sessionId) ?? Promise.resolve()).then(run, run)
    this.lanes.set(sessionId, next.catch(() => {}))
    return next
  }

  // ------------------------------------------------------------- workspaces

  /** `<root>/projects/<store>/<name>`. */
  anchorOf(project: string): string {
    const [store, name] = project.split('/')
    if (!store || !name || project.split('/').length !== 2) throw new CliError('InvalidInput', `Not a project key: ${project}`)
    return join(this.ctx.layerfs.root, 'projects', store, name)
  }

  get scratchAnchor(): string { return join(this.ctx.layerfs.root, 'scratch') }

  private writeAnchor(dir: string, text: string): void {
    mkdirSync(join(dir, 'sessions'), { recursive: true })
    const readme = join(dir, 'README.md')
    if (!existsSync(readme)) writeFileSync(readme, text)
  }

  /**
   * Ensure a project's scratch-folder workspace exists as a DSH workspace.
   * @returns the DSH workspace id and anchor.
   */
  async ensureProjectWorkspace(project: string): Promise<{ workspaceId: string, anchor: string }> {
    await this.lfs.project.get(project)
    const anchor = this.anchorOf(project)
    this.writeAnchor(anchor, `# ${project}\n\nThe DeepSeek Harness workspace of LayerFS project \`${project}\`.\n\nEach session works in its own LayerFS Workspace (branch \`dsh.<session>\`), mounted as its\nworking directory and checkpointed at the end of every turn. \`sessions/<session>/\` is that\nsession's scratch folder: it is never saved into the project.\n`)
    const workspace = await this.ctx.workspaceRegistry.create(anchor, project.split('/')[1])
    this.state.update((s) => { s.projects[project] = { project, anchor, workspaceId: String(workspace.id), createdAt: s.projects[project]?.createdAt ?? Date.now() } })
    this.ctx.layerfs.emit('layerfs-workspaces-changed', { project })
    return { workspaceId: String(workspace.id), anchor }
  }

  /** Ensure the Scratch workspace (no project). */
  async ensureScratchWorkspace(): Promise<{ workspaceId: string, anchor: string }> {
    const anchor = this.scratchAnchor
    this.writeAnchor(anchor, '# Scratch\n\nSessions here have no LayerFS project: each works in its own scratch folder `sessions/<session>/`.\n')
    const workspace = await this.ctx.workspaceRegistry.create(anchor, 'Scratch')
    return { workspaceId: String(workspace.id), anchor }
  }

  /** Which project (or the Scratch workspace) a session `cwd` belongs to. */
  classify(cwd: string | undefined): { kind: 'project', project: string, anchor: string } | { kind: 'scratch', anchor: string } | undefined {
    if (!cwd) return undefined
    const at = real(cwd)
    if (at === real(this.scratchAnchor)) return { kind: 'scratch', anchor: this.scratchAnchor }
    for (const entry of Object.values(this.state.read().projects)) {
      if (real(entry.anchor) === at) return { kind: 'project', project: entry.project, anchor: entry.anchor }
    }
    const root = real(join(this.ctx.layerfs.root, 'projects'))
    if (at.startsWith(`${root}/`)) {
      const [store, name, extra] = at.slice(root.length + 1).split('/')
      if (store && name && !extra) return { kind: 'project', project: `${store}/${name}`, anchor: join(this.ctx.layerfs.root, 'projects', store, name) }
    }
    return undefined
  }

  // ------------------------------------------------------------- binding

  binding(sessionId: string): Binding | undefined { return this.state.read().sessions[sessionId] }
  checkpoints(sessionId: string): Checkpoint[] { return this.state.read().checkpoints[sessionId] ?? [] }

  private save(binding: Binding): Binding {
    binding.updatedAt = Date.now()
    this.state.update((s) => { s.sessions[binding.sessionId] = binding })
    this.ctx.layerfs.emit('layerfs-session', { sessionId: binding.sessionId })
    return binding
  }

  private record(sessionId: string, checkpoint: Checkpoint): void {
    this.state.update((s) => { (s.checkpoints[sessionId] ??= []).push(checkpoint) })
    this.ctx.layerfs.emit('layerfs-checkpoint', { sessionId, checkpoint })
  }

  /** The machine a project's Sandboxes run on (v1: native only). */
  private async machineFor(project: string): Promise<string> {
    const info = await this.lfs.project.get(project)
    const machine = info.kind === 'postgresql' ? 'native' : (info.machine ?? 'native')
    if (machine !== 'native') {
      throw new CliError('Unsupported', `Project ${project} lives on machine "${machine}". dsh-layerfs runs session Workspaces on the native machine; pull the Store to this host first.`)
    }
    return machine
  }

  /** Make sure the session's Sandbox runs and its Workspace is mounted on its branch; answers the mount path. */
  private async mount(binding: Binding): Promise<string> {
    await this.ctx.layerfs.ensureNative()
    const { project, sandbox, branch } = binding as Required<Binding>
    let observed: any
    try { observed = await sandboxWorkspaces(this.lfs, sandbox) } catch (error: any) {
      if (error?.code !== 'NoSuchSandbox' && error?.code !== 'NotFound') throw error
    }
    if (!observed || observed.state === 'stopped' || observed.down_reason) {
      if (observed) await this.lfs.sandbox.close(sandbox, { force: true }).catch(() => {})
      await this.lfs.sandbox.create(project, sandbox, binding.machine ?? 'native')
      observed = { workspaces: [] }
    }
    const existing = (observed.workspaces ?? []).find((w: any) => w.name === WS_NAME)
    if (existing && existing.branch === branch && (existing.directory ?? existing.path)) return existing.directory ?? existing.path
    if (existing) await this.lfs.workspace.unmount(`${sandbox}:${WS_NAME}`, { force: true, discard: false }).catch(() => this.lfs.workspace.unmount(`${sandbox}:${WS_NAME}`, { force: true, discard: true }))
    const mounted = await this.lfs.workspace.mount(sandbox, branch, { name: WS_NAME })
    binding.base ??= mounted.base ?? mounted.base_layer ?? null
    return mounted.path
  }

  /**
   * Bind a session when its Agent enters (fresh, resumed, forked or a subagent).
   * Never throws: a failure is recorded on the binding and shown in the panel.
   */
  async bindAgent(agent: any, source: string): Promise<void> {
    const session = agent.session
    const header = session.header
    const sessionId = String(agent.id)
    const where = this.classify(header.cwd)
    if (!where) return
    await this.lane(sessionId, async () => {
      try {
        if (header.origin === 'subagent' && header.parentSession) return await this.bindShared(agent, String(header.parentSession), where.anchor)
        if (where.kind === 'scratch') return await this.bindScratch(agent, where.anchor)
        await this.bindProject(agent, where.project, where.anchor, source)
      } catch (error: any) {
        const previous = this.binding(sessionId)
        this.ctx.logger('layerfs').warn('session %s: bind failed: %s', sessionId, error?.message ?? error)
        this.save({
          ...(previous ?? { sessionId, kind: where.kind === 'scratch' ? 'scratch' : 'project', anchor: where.anchor, scratch: join(where.anchor, 'sessions', sessionId), createdAt: Date.now(), updatedAt: Date.now() }),
          ...(where.kind === 'project' ? { project: where.project } : {}),
          state: 'failed', error: String(error?.message ?? error),
        } as Binding)
      }
    })
  }

  private scratchFor(anchor: string, sessionId: string): string {
    const dir = join(anchor, 'sessions', sessionId)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  /** Move the session's working directory: silently before its first turn, with DSH's notice afterwards. */
  private async moveTo(agent: any, dir: string): Promise<void> {
    const wd = this.ctx.workingDirectory
    if (wd.get(agent.session) === dir) return
    const fresh = !agent.session.snapshotEvents(0).some((e: any) => e.type === 'turn/start')
    if (fresh) agent.session.append('working-directory/change', { cwd: dir })
    else await wd.set(agent, dir)
  }

  private async bindScratch(agent: any, anchor: string): Promise<void> {
    const sessionId = String(agent.id)
    const scratch = this.scratchFor(anchor, sessionId)
    const previous = this.binding(sessionId)
    this.save({ ...(previous ?? { sessionId, kind: 'scratch', anchor, scratch, createdAt: Date.now() }), state: 'bound', error: undefined } as Binding)
    await this.moveTo(agent, scratch)
  }

  private async bindShared(agent: any, parent: string, anchor: string): Promise<void> {
    const sessionId = String(agent.id)
    // A subagent of a subagent follows the root binding.
    let root = this.binding(parent)
    while (root?.kind === 'shared' && root.parent) root = this.binding(root.parent)
    if (!root || root.state !== 'bound') return
    const dir = root.mount ?? root.scratch
    this.save({ sessionId, kind: 'shared', anchor, parent: root.sessionId, scratch: root.scratch, project: root.project, mount: root.mount, state: 'bound', createdAt: Date.now(), updatedAt: Date.now() })
    await this.moveTo(agent, dir)
  }

  private async bindProject(agent: any, project: string, anchor: string, source: string): Promise<void> {
    const sessionId = String(agent.id)
    const header = agent.session.header
    const existing = this.binding(sessionId)
    const scratch = this.scratchFor(anchor, sessionId)
    let binding: Binding
    if (existing?.branch && existing.sandbox) {
      binding = { ...existing, scratch, state: existing.state }
    } else {
      const machine = await this.machineFor(project)
      const branch = branchOf(sessionId)
      const start = this.forkSource(sessionId, header, project)
      try {
        await this.forkAt(project, branch, start.branch ?? 'main', start.commit ?? null)
      } catch (error: any) {
        if (error?.code !== 'Exists' && error?.code !== 'NameTaken') throw error
      }
      binding = {
        sessionId, kind: 'project', project, anchor, scratch, machine, branch,
        sandbox: sandboxOf(sessionId), ws: `${sandboxOf(sessionId)}:${WS_NAME}`,
        state: 'bound', createdAt: Date.now(), updatedAt: Date.now(),
        ...(start.session ? { from: { session: start.session, commit: start.commit, turn: start.turn } } : {}),
      }
      this.state.update((s) => { delete s.pending[sessionId] })
    }
    binding.mount = await this.mount(binding)
    binding.state = 'bound'
    delete binding.error
    this.save(binding)
    if (!this.checkpoints(sessionId).length) {
      this.record(sessionId, {
        kind: 'base', turn: 0, seq: agent.session.seq, endSeq: agent.session.seq, commit: binding.from?.commit ?? binding.base ?? null, branch: binding.branch!,
        changed: 0, at: Date.now(), message: binding.from ? `Forked from turn ${binding.from.turn ?? '?'}` : `Started from ${project} main`,
      })
    }
    await this.moveTo(agent, binding.mount)
    void source
  }

  /** Where a new session's files start: a pending fork, a DSH fork's checkpoint, or `main`. */
  private forkSource(sessionId: string, header: any, project: string): { branch?: string | null, commit?: string | null, session?: string, turn?: number } {
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
    const binding = this.binding(sessionId)
    if (!binding || binding.kind !== 'project' || binding.state !== 'bound' || !binding.ws) return undefined
    const session = this.ctx.sessions.get(sessionId as never) as any
    const seq = session?.seq ?? 0
    let checkpoint: Checkpoint
    try {
      const status = await this.lfs.workspace.status(binding.ws)
      const entries = Number(status?.overlay?.entries ?? 0)
      if (!entries && !status?.head_moved_since_mount && kind === 'turn') return undefined
      const result = await this.lfs.workspace.commit(binding.ws, { message })
      const commit = result?.kind === 'Committed' ? result.commit?.id ?? result.head : result?.head ?? null
      checkpoint = { kind, turn, seq, commit, branch: binding.branch!, changed: result?.kind === 'Committed' ? Math.max(entries, 1) : 0, message, at: Date.now() }
    } catch (error: any) {
      // Conflict markers or an uncertain outcome: never retry blindly; the panel shows it.
      checkpoint = { kind, turn, seq, commit: null, branch: binding.branch!, changed: 0, message, at: Date.now(), error: errorOf(error) }
    }
    this.record(sessionId, checkpoint)
    return checkpoint
  }

  /** `turn/end` seen: complete the turn's checkpoint with its boundary seq. */
  markTurnEnd(sessionId: string, turn: number, seq: number): void {
    const list = this.state.read().checkpoints[sessionId]
    if (!list?.some((c) => c.kind === 'turn' && c.turn === turn && c.endSeq === undefined)) return
    this.state.update((s) => {
      for (const c of s.checkpoints[sessionId] ?? []) if (c.kind === 'turn' && c.turn === turn && c.endSeq === undefined) c.endSeq = seq
    })
  }

  /**
   * Restore the session's files to a checkpoint: save current changes, fork a
   * new Branch from the checkpoint and remount it in place.
   */
  async restore(sessionId: string, commit: string): Promise<Binding> {
    return await this.lane(sessionId, async () => {
      const binding = this.binding(sessionId)
      if (!binding || binding.kind !== 'project' || !binding.project || !binding.sandbox) throw new CliError('InvalidInput', 'This session has no LayerFS Workspace')
      const target = this.checkpoints(sessionId).find((c) => c.commit === commit)
      if (!target) throw new CliError('NotFound', 'No such checkpoint in this session')
      const session = this.ctx.sessions.get(sessionId as never) as any
      if (binding.state === 'bound') await this.checkpoint(sessionId, 'manual', this.lastTurn(sessionId), 'Saved before restore')
      const generation = (binding.restores ?? 0) + 1
      const branch = branchOf(sessionId, generation)
      await this.forkAt(binding.project, branch, target.branch ?? binding.branch ?? 'main', commit)
      await this.lfs.workspace.unmount(`${binding.sandbox}:${WS_NAME}`, { discard: true, force: true }).catch(() => {})
      const next: Binding = { ...binding, branch, restores: generation, base: undefined, state: 'bound' }
      next.mount = await this.mount(next)
      this.save(next)
      this.record(sessionId, {
        kind: 'restore', turn: target.turn, seq: session?.seq ?? 0, endSeq: session?.seq ?? 0, commit: next.base ?? commit,
        branch, changed: 0, at: Date.now(), message: `Restored files to ${target.kind === 'base' ? 'the start' : `turn ${target.turn}`}`,
      })
      const agent = (this.ctx.get('agents' as never) as any)?.get?.(sessionId)
      if (agent) {
        await this.moveTo(agent, next.mount!)
        try {
          const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
          agent.inject(createUserMessage({ content: [{ type: 'text', text: `The project files in ${next.mount} were restored to the checkpoint of ${target.kind === 'base' ? 'the session start' : `turn ${target.turn}`} (LayerFS branch ${branch}). Changes made after it are no longer in the working directory.` }], source: { kind: 'working-directory' } as never }))
        } catch { /* notice is best effort */ }
      }
      return next
    })
  }

  /** Fork `branch` at a commit (or base Layer) id: from the branch that holds it, else from `main`. */
  private async forkAt(project: string, branch: string, from: string, commit: string | null): Promise<void> {
    if (!commit) { await this.lfs.branch.fork(project, branch, from); return }
    try {
      await this.lfs.branch.fork(project, branch, from, commit)
    } catch (error: any) {
      if (from === 'main' || error?.code === 'Exists' || error?.code === 'NameTaken') throw error
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
    const binding = this.binding(sessionId)
    if (!binding?.project) throw new CliError('InvalidInput', 'This session has no LayerFS project')
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
      await this.forkAt(start.project, branch, start.branch ?? 'main', start.commit)
      await this.lfs.workspace.unmount(`${bound.sandbox}:${WS_NAME}`, { discard: true, force: true }).catch(() => {})
      const next: Binding = { ...bound, branch, restores: (bound.restores ?? 0) + 1, base: undefined, from: { session: sessionId, commit: start.commit, turn: target.turn }, state: 'bound' }
      next.mount = await this.mount(next)
      this.save(next)
      this.state.update((s) => {
        delete s.pending[child]
        s.checkpoints[child] = [{ kind: 'base', turn: 0, seq: 0, endSeq: 0, commit: start.commit ?? next.base ?? null, branch, changed: 0, at: Date.now(), message: `Forked from turn ${target.turn}` }]
      })
      const agent = (this.ctx.get('agents' as never) as any)?.get?.(child)
      if (agent) await this.moveTo(agent, next.mount!)
    })
    return { sessionId: child }
  }

  // ------------------------------------------------------------- lifecycle

  /** Save and close a session's Sandbox (it reopens on the next turn or resume). */
  async close(sessionId: string, reason: 'idle' | 'user' = 'user'): Promise<void> {
    await this.lane(sessionId, async () => {
      const binding = this.binding(sessionId)
      if (!binding || binding.kind !== 'project' || binding.state !== 'bound' || !binding.sandbox) return
      await this.checkpoint(sessionId, 'idle', this.lastTurn(sessionId), reason === 'idle' ? 'Saved before the idle Sandbox closed' : 'Saved before closing')
      await this.lfs.sandbox.close(binding.sandbox, { force: true })
      this.save({ ...binding, state: 'closed', mount: undefined })
    })
  }

  /** Forget a session: close its Sandbox and delete its scratch folder; the branch stays as history. */
  async forget(sessionId: string): Promise<void> {
    const binding = this.binding(sessionId)
    if (!binding) return
    if (binding.kind === 'project' && binding.sandbox) await this.lfs.sandbox.close(binding.sandbox, { force: true }).catch(() => {})
    if (binding.kind !== 'shared' && binding.scratch.startsWith(binding.anchor)) rmSync(binding.scratch, { recursive: true, force: true })
    this.state.update((s) => { delete s.sessions[sessionId]; delete s.pending[sessionId] })
  }

  /** Everything the session panel shows. */
  async view(sessionId: string): Promise<SessionView> {
    const binding = this.binding(sessionId) ?? null
    let status: unknown = null
    if (binding?.kind === 'project' && binding.state === 'bound' && binding.ws) {
      status = await this.lfs.workspace.status(binding.ws).catch((error: any) => ({ error: errorOf(error) }))
    }
    let effective = binding
    if (binding?.kind === 'shared' && binding.parent) effective = this.binding(binding.parent) ?? binding
    return {
      sessionId,
      binding: effective,
      checkpoints: effective ? this.checkpoints(effective.sessionId) : [],
      project: effective?.project ?? null,
      status,
      sessionStore: this.ctx.layerfs.sessionStore,
      mirror: effective ? this.state.read().mirror[effective.sessionId] ?? null : null,
    }
  }
}
