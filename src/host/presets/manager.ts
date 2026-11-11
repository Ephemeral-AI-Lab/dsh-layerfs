/**
 * Presets: build LayerFS Connect's Studio project library (4 machines, 4
 * stores, 8 projects with dense histories) into the plugin's own LayerFS
 * home, or reset that home to empty. Port of Connect
 * `host/demo-presets/manager.js` for one home: there are no preset homes,
 * child hosts or environment switching, and no CLI Activity (a job keeps
 * its own log).
 *
 * Build and Reset remove every store, sandbox, workspace and custom machine
 * in the home, so they are admitted only when
 *   - the confirmed plan's signature still matches the inventory,
 *   - no DSH project session holds an open Sandbox (each is named), and
 *   - no storage job, project import or doctor run is in flight.
 * While a job runs, other changes through the routes are refused (reads stay
 * open) and new project sessions wait. After the stores are gone, the
 * removed projects' DSH workspaces and session records are dropped.
 *
 * Routes (under `/api/demo-presets`, answered by the `http` operation):
 *   GET  /                               the library, its latest job, busy
 *   GET  /studio[?executionMode]         one preset's definition
 *   GET  /studio/build-plan[-no-sandboxes]?executionMode   prepare + plan (removes nothing)
 *   GET  /studio/environment-plan        the reset plan
 *   POST /studio/environment-reset       { requestId, expectedPlan, confirm, rebuild, sandboxes, executionMode }
 *   GET  /studio/script[-no-sandboxes]?offset&limit&snapshot&kind&name&executionMode
 *   GET  /jobs/:id, /requests/:requestId reconcile without submitting work
 * Event: `demo-preset` { jobId } whenever a job moves.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LOG_LINES, type BusySession, type DemoPreset, type DemoPresets, type DshImpact, type EnvironmentResetPlan, type PresetExecutionMode, type PresetJob } from '../../shared/presets.ts'
import { CliDriver, type PresetSpec } from './driver.ts'
import {
  buildPreset, CONTENT_VERSION, EnvironmentReset, liveReceipt, MIXED_RECIPE_VERSION, prepareBuild, presetOf, presets,
  presetScript, projectDefinition, projectHistoryPlan, scriptPage, StepJournal, TOOL,
} from './js.ts'

/** What the manager needs from its host (tests pass a stand-in). */
export interface PresetHost {
  /** The pinned CLI/daemon/bundle over the plugin's home, plus the presets state folder; throws when no CLI is pinned. */
  spec(): PresetSpec
  /** Work in flight elsewhere in the plugin (storage jobs, imports, doctor), in words. */
  busy(): string[]
  /** DSH project sessions whose Sandbox is open. */
  boundSessions(): BusySession[]
  /** Projects with a DSH workspace and how many sessions each has. */
  dshProjects(): { project: string, sessions: number }[]
  /** Drop a removed project's DSH workspace and session records. */
  forgetProject(project: string): Promise<void>
  /** Publish a host event. */
  emit(type: string, data?: unknown): void
}

type Failure = Error & { status?: number, code?: string, detail?: unknown }
const error = (status: number, code: string, message: string, detail?: unknown): Failure => Object.assign(new Error(message), { status, code, ...(detail === undefined ? {} : { detail }) })
const busy = (message: string, detail?: unknown) => error(409, 'ConnectBusy', message, detail)
const pending = (job: PresetJob | null | undefined) => !!job && ['queued', 'running'].includes(job.state)
const read = (file: string): any => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch (e: any) { if (e.code === 'ENOENT') return null; throw e } }
const save = (file: string, value: unknown) => { const tmp = `${file}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 }); renameSync(tmp, file) }
const known = (name: string) => Object.hasOwn(presets, name)
function modeOf(value: unknown): PresetExecutionMode {
  const mode = value ?? 'filesystem'
  if (mode !== 'filesystem' && mode !== 'mixed') throw error(400, 'InvalidInput', 'Choose Filesystem or Mixed execution mode.')
  return mode
}

export class PresetManager {
  private readonly jobs: Map<string, PresetJob>
  private readonly file: string
  private switching = false
  private readonly tasks = new Set<Promise<unknown>>()
  private readonly snapshots = new Map<string, { name: string, sandboxes: boolean, executionMode: PresetExecutionMode, script: any }>()

  constructor(private readonly host: PresetHost, readonly state: string, readonly home: string) {
    mkdirSync(state, { recursive: true, mode: 0o700 })
    this.file = join(state, 'demo-preset-jobs.json')
    const interrupted = (job: PresetJob): PresetJob => ({ ...job, state: 'interrupted', ended: Date.now(), phase: 'Interrupted: the host restarted during this operation. Inspect Machines and Storage, then build or reset again.' })
    this.jobs = new Map(((read(this.file) ?? []) as PresetJob[]).map((job) => [job.id, pending(job) ? interrupted(job) : job]))
    // A lock whose process ended belongs to an interrupted job of this host: every
    // operation starts with a verified environment reset, so nothing is replayed.
    const lock = join(state, 'demo-fixtures.lock')
    if (existsSync(lock) && !liveReceipt(lock)) unlinkSync(lock)
    this.persist()
  }

  private persist(): void {
    const kept = [...this.jobs.values()].slice(-20)
    save(this.file, kept)
  }

  private publish(job: PresetJob): void {
    this.persist()
    this.host.emit('demo-preset', { jobId: job.id, preset: job.preset, state: job.state })
  }

  /** Whether a preset operation holds the home (other changes wait). */
  exclusive(): boolean { return this.switching || [...this.jobs.values()].some(pending) }

  /** Wait for running work to settle (shutdown, tests). */
  async settle(): Promise<void> { await Promise.allSettled([...this.tasks]) }

  private spec(): PresetSpec { return this.host.spec() }

  private latest(name: string): PresetJob | null {
    return [...this.jobs.values()].reverse().find((job) => job.preset === name) ?? null
  }

  definition(name: string, requestedMode?: string): DemoPreset {
    const preset = presetOf(name)
    const manifest = read(join(this.state, 'demo-fixtures.json'))
    const job = this.latest(name)
    const executionMode = modeOf(requestedMode ?? manifest?.executionMode)
    const stores = preset.stores.length
    const projectDefinitions = preset.stores.flatMap((store: any) => store.projects.map((project: string) => {
      const definition = projectDefinition(project), plan = projectHistoryPlan(project, { executionMode })
      return { store: store.name, name: project, title: definition.title, description: definition.description, branches: plan.branches, history: plan.history, tier: plan.tier, cycles: plan.cycles, layers: plan.layers, commands: plan.commands, workspaceRevisions: plan.workspaceRevisions, authoredRevisions: plan.authoredRevisions, sandboxLimit: plan.sandboxLimit, workspaceLimit: plan.workspaceLimit }
    }))
    const contentReady = (manifest?.executionMode ?? 'filesystem') === executionMode && manifest?.contentVersion === CONTENT_VERSION && (executionMode !== 'mixed' || manifest?.mixedRecipeVersion === MIXED_RECIPE_VERSION) && job?.state === 'completed' && job.rebuild && !!job.presetVerified
    const projects = preset.stores.reduce((n: number, s: any) => n + s.projects.length, 0)
    return {
      id: name, description: preset.description, executionMode, contentVersion: CONTENT_VERSION, contentReady, projectDefinitions,
      machineDefinitions: preset.machines.map((m: any) => typeof m === 'string' ? { name: m, platform: m } : m),
      projectGroups: preset.stores.map((s: any) => ({ store: s.name, machine: s.machine, projects: s.projects })),
      machines: preset.machines.map((m: any) => typeof m === 'string' ? m : m.name),
      stores, projects,
      sandboxes: executionMode === 'mixed' ? projects : preset.sandboxes === false ? 0 : stores,
      workspaces: executionMode === 'mixed' ? 0 : preset.sandboxes === false ? 0 : stores * 2,
      requirements: [
        ...(preset.stores.some((s: any) => s.machine === 'docker') ? ['docker'] : []),
        ...(preset.machines.some((m: any) => typeof m !== 'string') ? ['lima'] : []),
        ...((executionMode === 'mixed' || (stores && preset.sandboxes !== false)) ? ['daemon'] : []),
      ],
      home: this.home, state: this.state,
      initialized: existsSync(join(this.home, 'layerfs.json')),
      built: !!manifest?.homeId,
      settings: manifest ? { sandboxes: manifest.sandboxes, executionMode: manifest.executionMode ?? 'filesystem' } : null,
      job,
    }
  }

  list(): DemoPresets {
    const items = Object.keys(presets).map((name) => this.definition(name))
    return { items, home: this.home, busy: this.exclusive() || !!liveReceipt(join(this.state, 'demo-fixtures.lock')) }
  }

  /** The DSH side of a reset: blocking sessions, and project workspaces it drops. */
  private impact(projectKeys: readonly string[]): DshImpact {
    const removed = new Set(projectKeys)
    return {
      sessions: this.host.boundSessions(),
      workspaces: this.host.dshProjects().filter((p) => removed.has(p.project)),
    }
  }

  /** Refuse while other work holds the home. */
  private idle(): void {
    const sessions = this.host.boundSessions()
    const work = this.host.busy()
    if (!sessions.length && !work.length) return
    const parts = [
      ...(sessions.length ? [`${sessions.length === 1 ? 'A session has' : `${sessions.length} sessions have`} an open Sandbox in this LayerFS home; close ${sessions.length === 1 ? 'it' : 'them'} first (session panel → Close Sandbox, or wait for the idle close)`] : []),
      ...(work.length ? [`Wait for active work to finish: ${work.join(', ')}`] : []),
    ]
    throw busy(`${parts.join('. ')}.`, { sessions, work })
  }

  async script(name: string, sandboxes: boolean, query: URLSearchParams): Promise<unknown> {
    const executionMode = modeOf(query.get('executionMode') ?? undefined)
    const snapshotId = query.get('snapshot')
    const cached = snapshotId ? this.snapshots.get(snapshotId) : undefined
    if (snapshotId && (!cached || cached.name !== name || cached.sandboxes !== sandboxes || cached.executionMode !== executionMode)) throw error(409, 'Conflict', 'This script preview expired. Close and reopen it to load the current plan.')
    const params = Object.fromEntries(query)
    if (cached) return { ...scriptPage(cached.script, params), snapshot: snapshotId }
    const spec = this.spec()
    let resetPlan, resetNote = 'Build discovers this home\'s resources and generates the cleanup commands when it starts.'
    if (existsSync(join(spec.home, 'layerfs.json'))) {
      try {
        const driver = new CliDriver(spec)
        await driver.discover()
        resetPlan = await new EnvironmentReset({ spec, driver }).plan()
        resetNote = 'Cleanup commands below reflect the current inventory. Build checks the inventory again before executing.'
      } catch { resetNote = 'The current inventory could not be fully inspected. Build discovers cleanup targets before executing; this preview does not claim the home is empty.' }
    }
    const script = presetScript({ preset: name, spec, sandboxes, executionMode, resetPlan, resetNote })
    const id = randomUUID()
    this.snapshots.set(id, { name, sandboxes, executionMode, script })
    while (this.snapshots.size > 2) this.snapshots.delete(this.snapshots.keys().next().value!)
    return { ...scriptPage(script, params), snapshot: id }
  }

  async buildPlan(name: string, sandboxes: boolean, mode?: string): Promise<EnvironmentResetPlan> {
    const executionMode = modeOf(mode)
    if (this.list().busy) throw busy('Wait for the preset operation to finish before building.')
    const spec = this.spec()
    const plan = await prepareBuild({ spec, preset: name, sandboxes, executionMode, driver: new CliDriver(spec) })
    return { ...plan, environment: name, dsh: this.impact(plan.projectKeys) }
  }

  async environmentPlan(name: string): Promise<EnvironmentResetPlan> {
    if (this.list().busy) throw busy('Wait for the preset operation to finish before planning a reset.')
    const spec = this.spec()
    if (!existsSync(join(spec.home, 'layerfs.json'))) throw error(409, 'InvalidInput', 'This LayerFS home has not been initialized; there is nothing to reset.')
    const reset = new EnvironmentReset({ spec, driver: new CliDriver(spec) })
    await reset.driver.discover()
    const plan = await reset.plan()
    return { ...plan, environment: name, dsh: this.impact(plan.projectKeys) }
  }

  /** Drop the DSH records of projects whose Store the reset removed (verified first). */
  private async forget(job: PresetJob, receipt: any): Promise<void> {
    if (!receipt?.verified) return
    const removed = new Set<string>(receipt.remove?.stores ?? [])
    const keys = new Set<string>(receipt.projectKeys ?? [])
    for (const p of this.host.dshProjects()) if (removed.has(p.project.split('/')[0]!)) keys.add(p.project)
    job.forgotten = []
    for (const key of [...keys].sort()) {
      if (!this.host.dshProjects().some((p) => p.project === key)) continue
      await this.host.forgetProject(key)
      job.forgotten.push(key)
    }
  }

  async resetEnvironment(name: string, body: any): Promise<PresetJob> {
    if (!body || !/^[\w-]{1,80}$/.test(body.requestId ?? '') || typeof body.expectedPlan !== 'string' || body.confirm !== true || typeof body.rebuild !== 'boolean' || typeof body.sandboxes !== 'boolean') throw error(400, 'InvalidInput', 'Review and confirm the environment reset plan.')
    const executionMode = modeOf(body.executionMode)
    const fingerprint = JSON.stringify([name, 'environment-reset', body.expectedPlan, body.rebuild, body.sandboxes, executionMode])
    const duplicate = [...this.jobs.values()].find((j) => j.requestId === body.requestId)
    if (duplicate) {
      if (duplicate.fingerprint !== fingerprint) throw error(409, 'Conflict', 'This request ID was already used with different settings.')
      return duplicate
    }
    if (this.list().busy) throw busy('Another preset operation is in progress.')
    this.idle()
    const spec = this.spec()
    this.switching = true
    try {
      const job: PresetJob = { id: randomUUID(), requestId: body.requestId, fingerprint, preset: name, command: 'environment-reset', executionMode, rebuild: body.rebuild, actionId: null, state: 'queued', phase: 'Checking environment', created: Date.now(), log: [], progress: { stage: 'checking', completed: 0, total: null, label: 'Checking environment' } }
      this.jobs.set(job.id, job); this.publish(job)
      let last = 0
      const report = (text: string) => {
        job.phase = text.slice(0, 240)
        job.log.push({ at: Date.now(), text: text.slice(0, 2000) })
        if (job.log.length > LOG_LINES) job.log.splice(0, job.log.length - LOG_LINES)
        if (Date.now() - last >= 250) { last = Date.now(); this.publish(job) }
      }
      const progress = (value: any) => { job.progress = value; if (Date.now() - last >= 250 || value.completed === value.total) { last = Date.now(); this.publish(job) } }
      const driver = new CliDriver(spec, report)
      let admitted!: (job: PresetJob) => void, rejected!: (e: unknown) => void
      const ready = new Promise<PresetJob>((yes, no) => { admitted = yes; rejected = no })
      const onReady = async (action: { id: string }) => { Object.assign(job, { actionId: action.id, state: 'running', started: Date.now() }); this.publish(job); admitted(job) }
      const options = { expectedPlan: body.expectedPlan, assertIdle: async () => this.idle(), onReady }
      const operation: Promise<any> = body.rebuild
        ? buildPreset({ spec, preset: name, driver, sandboxes: body.sandboxes, executionMode, ...options, report, progress,
          onCleanup: async (receipt: any) => { job.cleanup = receipt; await this.forget(job, receipt); this.publish(job) },
          onBuildReady: (action: { id: string }) => { job.rebuildActionId = action.id; this.publish(job) } })
        : new EnvironmentReset({ spec, driver, report, progress }).run(options)
      const task = operation.then(async (result) => {
        const receipt = body.rebuild ? result.cleanup : result
        job.cleanup = receipt
        if (body.rebuild) job.presetVerified = result.presetVerified
        else {
          await this.forget(job, receipt)
          const file = join(this.state, 'demo-fixtures.json'), manifest = read(file)
          if (manifest?.tool === TOOL && manifest.homeId === receipt.homeId && receipt.verified) {
            const journal = new StepJournal(join(this.state, 'demo-steps.ndjson')); journal.clear(); manifest.stepJournal = journal.metadata()
            Object.assign(manifest, { resources: { machine: {}, store: {}, sandbox: {} }, projects: {}, steps: {}, borrowed: {}, lastSetupActionId: null, sandboxes: body.sandboxes }); save(file, manifest)
          }
        }
        Object.assign(job, { state: 'completed', phase: body.rebuild ? 'Environment reset verified. Studio rebuilt and verified.' : 'Environment is empty. Reset verified.', ended: Date.now() })
      }).catch((e: any) => {
        const receipt = read(join(this.state, 'environment-reset.json'))
        Object.assign(job, { state: 'failed', cleanup: receipt?.actionId === job.actionId ? receipt : job.cleanup, error: { code: e?.code ?? 'Failed', message: String(e?.message ?? e) }, phase: String(e?.message ?? e), ended: Date.now() })
        rejected(e)
      }).finally(() => {
        this.switching = false
        this.publish(job)
        this.tasks.delete(task)
      })
      this.tasks.add(task)
      return await ready
    } finally { this.switching = false }
  }

  /** One request: `method` + segments after `/api/demo-presets` -> the answer, or undefined. */
  async route(method: string, parts: string[], body: unknown, query: URLSearchParams): Promise<unknown> {
    if (parts.length > 2) return undefined
    const [id, operation] = parts
    if (method === 'GET' && !id) return this.list()
    if (method === 'GET' && id === 'requests' && operation) {
      const job = [...this.jobs.values()].find((j) => j.requestId === operation)
      if (!job) throw error(404, 'NotFound', 'This request has not been admitted. Dismiss this message and choose Build or Reset explicitly.')
      return job
    }
    if (method === 'GET' && id === 'jobs' && operation) {
      const job = this.jobs.get(operation)
      if (!job) throw error(404, 'NotFound', 'This preset operation is no longer available.')
      return job
    }
    if (!id || !known(id)) throw error(404, 'NotFound', 'Unknown preset.')
    if (method === 'GET' && !operation) return this.definition(id, query.get('executionMode') ?? undefined)
    if (method === 'GET' && operation === 'environment-plan') return this.environmentPlan(id)
    if (method === 'POST' && operation === 'environment-reset') return this.resetEnvironment(id, body)
    if (method === 'GET' && (operation === 'build-plan' || operation === 'build-plan-no-sandboxes')) return this.buildPlan(id, operation === 'build-plan', query.get('executionMode') ?? undefined)
    if (method === 'GET' && (operation === 'script' || operation === 'script-no-sandboxes')) return this.script(id, operation === 'script', query)
    return undefined
  }
}
