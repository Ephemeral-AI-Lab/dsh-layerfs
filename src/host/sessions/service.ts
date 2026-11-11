/**
 * `ctx.layerfsSessions`: sessions in a LayerFS project workspace work in that
 * project + their own scratch folder; sessions anywhere else are plain DSH.
 *
 * A LayerFS project becomes one DSH workspace whose directory is the project's
 * scratch-folder workspace (an "anchor" under `<root>/projects/<store>/<name>`):
 * every session of the project shares it as `header.cwd`, so DSH lists them
 * under one workspace. Each session then gets
 *   - its own Branch `dsh.<session>` (forked from `main`, or from a checkpoint),
 *   - its own Sandbox + Workspace mount, which becomes its working directory,
 *   - its own scratch folder `<anchor>/sessions/<session>` (never committed).
 * A session in any other workspace (a host folder, DSH's default workspace,
 * the Scratch workspace `<root>/scratch`) runs as stock DSH: no binding, no
 * Workspace mount, no checkpoints, nothing mirrored. Subagents of a bound
 * session share their parent's mount; subagents of a folder session are plain
 * too. A fork of a bound session starts its files from the parent's
 * checkpoint at the fork point.
 *
 * Checkpoints: every turn that changed files ends with `workspace.commit`
 * (`agent/turn-stopping`); restore = fork a new Branch from a checkpoint and
 * remount; "branch here" = DSH session fork + Branch fork from the checkpoint.
 * The LayerFS session store keeps each bound session's log in its project
 * (`store.ts`).
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CliError, pages, sandboxWorkspaces, type Lfs } from '../layerfs/cli.ts'
import { JsonFile } from '../service.ts'
import { initialState, type Binding, type Checkpoint, type SessionsState } from './state.ts'
import type { SessionStore } from './store.ts'

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

/** A project workspace's sidebar title: the LayerFS mark leads so truncation keeps it. */
export const projectTitle = (project: string): string => {
  const [store, name] = project.split('/')
  return `LayerFS · ${name} · ${store}`
}

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
}

export class LayerfsSessions extends Service {
  static inject = ['layerfs', 'layerfsRemote', 'workspaceRegistry', 'workingDirectory', 'sessions']
  readonly state: JsonFile<SessionsState>
  /** One operation at a time per session (bind, checkpoint, restore). */
  private readonly lanes = new Map<string, Promise<unknown>>()
  private scratchReady: Promise<void> | undefined
  /** The LayerFS session store, while the sessions area is up (the persistence row imports through it). */
  store: SessionStore | undefined

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

  /** Whether `project` is the Scratch project. */
  isScratch(project: string | undefined): boolean { return project === this.ctx.layerfs.scratchProject }

  private writeAnchor(dir: string, text: string): void {
    mkdirSync(join(dir, 'sessions'), { recursive: true })
    const readme = join(dir, 'README.md')
    if (!existsSync(readme)) writeFileSync(readme, text)
  }

  /**
   * The "LayerFS Projects" workspace: `<root>/projects`, the parent every
   * project workspace nests under in the sidebar's Workspace Tree view.
   */
  async ensureProjectsGroup(): Promise<{ workspaceId: string }> {
    const dir = join(this.ctx.layerfs.root, 'projects')
    mkdirSync(dir, { recursive: true })
    const workspace = await this.ctx.workspaceRegistry.create(dir, 'LayerFS Projects')
    // Older project workspaces keep their created title; retitle them. Skip the
    // Scratch entry old state may hold: its workspace is a plain folder now.
    for (const entry of Object.values(this.state.read().projects)) {
      if (this.isScratch(entry.project) || !entry.anchor.startsWith(`${dir}/`)) continue
      const title = projectTitle(entry.project)
      const ws = this.ctx.workspaceRegistry.get(entry.workspaceId as never)
      if (ws && ws.title !== title) await ws.setTitle(title)
    }
    return { workspaceId: String(workspace.id) }
  }

  /**
   * Ensure a project's scratch-folder workspace exists as a DSH workspace.
   * @returns the DSH workspace id and anchor.
   */
  async ensureProjectWorkspace(project: string): Promise<{ workspaceId: string, anchor: string }> {
    if (this.isScratch(project)) return await this.ensureScratchWorkspace()
    await this.lfs.project.get(project)
    await this.ensureProjectsGroup()
    const anchor = this.anchorOf(project)
    this.writeAnchor(anchor, `# ${project}\n\nThe DeepSeek Harness workspace of LayerFS project \`${project}\`.\n\nEach session works in its own LayerFS Workspace (branch \`dsh.<session>\`), mounted as its\nworking directory and checkpointed at the end of every turn. \`sessions/<session>/\` is that\nsession's scratch folder: it is never saved into the project.\n`)
    const title = projectTitle(project)
    const workspace = await this.ctx.workspaceRegistry.create(anchor, title)
    if (workspace.title !== title) await workspace.setTitle(title)
    this.state.update((s) => { s.projects[project] = { project, anchor, workspaceId: String(workspace.id), createdAt: s.projects[project]?.createdAt ?? Date.now() } })
    this.ctx.layerfs.emit('layerfs-workspaces-changed', { project })
    return { workspaceId: String(workspace.id), anchor }
  }

  /** List a session (an imported one) under a DSH workspace. Never throws. */
  async attach(workspaceId: string, sessionId: string): Promise<void> {
    try {
      await this.ctx.workspaceRegistry.get(workspaceId as never)?.attachSession(sessionId as never)
    } catch (error: any) {
      this.ctx.logger('layerfs').warn('session %s not listed in workspace %s: %s', sessionId, workspaceId, error?.message ?? error)
    }
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
      // Only anchors under the projects root: state may hold an old entry for
      // the Scratch workspace, which is a plain folder now.
      if (real(entry.anchor) === at && at.startsWith(`${root}/`)) return { project: entry.project, anchor: entry.anchor }
    }
    if (at.startsWith(`${root}/`)) {
      const [store, name, extra] = at.slice(root.length + 1).split('/')
      if (store && name && !extra) return { project: `${store}/${name}`, anchor: join(this.ctx.layerfs.root, 'projects', store, name) }
    }
    return undefined
  }

  /**
   * Where a session works. In order: its existing binding; a bound parent's
   * Workspace (a subagent); a project workspace's anchor; the place of the
   * session it was forked from; otherwise a plain folder (stock DSH).
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
    const where = this.classify(header.cwd)
    if (where) return { kind: 'project', ...where }
    if (parent?.project) return { kind: 'project', project: parent.project, anchor: parent.anchor }
    return { kind: 'folder', cwd: String(header.cwd ?? '') }
  }

  /**
   * The project a session works in, for the New Session control and the sidebar
   * row mark. A live session is asked for its place; one that is only
   * persisted answers from its recorded binding.
   */
  placeOfId(sessionId: string): { project: string | null } | null {
    const persisted = this.binding(sessionId)
    const session = this.ctx.sessions.get(sessionId as never) as any
    if (!session) {
      if (!persisted) return null
      if (persisted.kind === 'shared') return { project: this.binding(String(persisted.parent))?.project ?? persisted.project ?? null }
      return { project: persisted.project ?? null }
    }
    const place = this.placeOf(session)
    if (place.kind === 'shared') return { project: this.binding(place.parent)?.project ?? null }
    if (place.kind === 'folder') return { project: null }
    return { project: place.project }
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
      throw new CliError('Unsupported', `Project ${project} lives on machine "${machine}". dsh-layerfs runs session Workspaces on the native machine; pull the Store to this host first (Storage → Store → Push).`)
    }
    return machine
  }

  /** Make sure the session's Sandbox runs and its Workspace is mounted on its branch; answers the mount path. */
  private async mount(binding: Binding): Promise<string> {
    const held = this.ctx.layerfs.exclusive?.()
    if (held) throw new CliError('ConnectBusy', held)
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
   * Bind a session's Agent to its place and move it into its Workspace.
   * With `strict` a failure throws (the step must not run outside the
   * Workspace); otherwise it is recorded on the binding and shown in the panel.
   */
  async bindAgent(agent: any, source: string, strict = false): Promise<void> {
    const sessionId = String(agent.id)
    const place = this.placeOf(agent.session)
    if (place.kind === 'folder') return
    await this.lane(sessionId, async () => {
      try {
        if (place.kind === 'shared') return await this.bindShared(agent, place.parent, place.anchor, strict)
        await this.bindProject(agent, place.project, place.anchor, source)
      } catch (error: any) {
        const previous = this.binding(sessionId)
        this.ctx.logger('layerfs').warn('session %s: bind failed: %s', sessionId, error?.message ?? error)
        if (place.kind === 'project') {
          this.save({
            ...(previous ?? { sessionId, kind: 'project', anchor: place.anchor, scratch: join(place.anchor, 'sessions', sessionId), createdAt: Date.now(), updatedAt: Date.now() }),
            project: place.project, state: 'failed', error: String(error?.message ?? error),
          } as Binding)
        }
        if (strict) throw error
      }
    })
  }

  /** Whether a session may run a step now: bound (re-binding if needed), else it throws. */
  async ensureBound(agent: any): Promise<void> {
    const sessionId = String(agent.id)
    let b = this.binding(sessionId)
    if (b?.kind === 'shared' && b.parent) b = this.binding(b.parent)
    if (b?.state === 'bound' && (b.mount ? existsSync(b.mount) : true)) return
    await this.bindAgent(agent, 'pre-step', true)
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

  private async bindShared(agent: any, parent: string, anchor: string, strict: boolean): Promise<void> {
    const sessionId = String(agent.id)
    // A subagent of a subagent follows the root binding.
    let root = this.binding(parent)
    while (root?.kind === 'shared' && root.parent) root = this.binding(root.parent)
    if (!root || root.state !== 'bound' || !root.mount) {
      if (strict) throw new CliError('Unavailable', 'The parent session\'s LayerFS Workspace is not mounted')
      return
    }
    this.save({ sessionId, kind: 'shared', anchor, parent: root.sessionId, scratch: root.scratch, project: root.project, mount: root.mount, state: 'bound', createdAt: Date.now(), updatedAt: Date.now() })
    await this.moveTo(agent, root.mount)
  }

  private async bindProject(agent: any, project: string, anchor: string, source: string): Promise<void> {
    const sessionId = String(agent.id)
    const held = this.ctx.layerfs.exclusive?.()
    if (held) throw new CliError('ConnectBusy', held)
    if (this.isScratch(project)) await this.ensureScratchProject()
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
        if (!exists(error)) throw error
      }
      binding = {
        sessionId, kind: 'project', project, anchor, scratch, machine, branch,
        sandbox: sandboxOf(sessionId), ws: `${sandboxOf(sessionId)}:${WS_NAME}`,
        state: 'bound', createdAt: existing?.createdAt ?? Date.now(), updatedAt: Date.now(),
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

  /** After a project is removed: drop its bindings, its DSH workspace and its scratch-folder workspace. */
  async forgetProject(project: string): Promise<void> {
    const state = this.state.read()
    const entry = state.projects[project]
    if (entry?.workspaceId) await this.ctx.workspaceRegistry.delete(entry.workspaceId as never).catch(() => false)
    this.state.update((s) => {
      for (const [id, b] of Object.entries(s.sessions)) {
        if (b.project !== project) continue
        delete s.sessions[id]; delete s.checkpoints[id]; delete s.mirror[id]; delete s.pending[id]
      }
      delete s.projects[project]
    })
    const anchor = entry?.anchor ?? this.anchorOf(project)
    if (anchor.startsWith(join(this.ctx.layerfs.root, 'projects'))) rmSync(anchor, { recursive: true, force: true })
    this.ctx.layerfs.emit('layerfs-workspaces-changed', { project })
  }

  /** Everything the session panel shows. */
  async view(sessionId: string): Promise<SessionView> {
    const binding = this.binding(sessionId) ?? null
    let effective = binding
    if (binding?.kind === 'shared' && binding.parent) effective = this.binding(binding.parent) ?? binding
    let status: unknown = null
    if (effective?.kind === 'project' && effective.state === 'bound' && effective.ws) {
      status = await this.lfs.workspace.status(effective.ws).catch((error: any) => ({ error: errorOf(error) }))
    }
    return {
      sessionId,
      binding: effective,
      checkpoints: effective ? this.checkpoints(effective.sessionId) : [],
      project: effective?.project ?? null,
      scratchProject: this.isScratch(effective?.project),
      status,
      mirror: effective ? this.state.read().mirror[effective.sessionId] ?? null : null,
    }
  }
}
