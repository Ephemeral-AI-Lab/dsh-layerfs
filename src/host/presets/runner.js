/*
 * The preset runner: creates the Studio library's machines, stores, projects
 * and histories through the real CLI, with an append-before-mutate step
 * journal that is never replayed after an uncertain outcome, then verifies
 * every saved file and history. Port of LayerFS Connect
 * `tools/demo/runner.mjs`, trimmed to what Build uses (setup + verify):
 *   - the LayerFS home is the plugin's own (`home`), adopted with `adoptHome`
 *     because Build first resets it under an explicit confirmation;
 *   - no CLI Activity recorder: the step journal is the record, and
 *     verification checks it instead of activity capture.
 */
import { MixedSandboxPool, mixedSandboxName, MIXED_RECIPE_VERSION } from './recipe/mixed-recipe.js'
import { randomUUID } from 'node:crypto'
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { stringify } from '../routes/util.ts'
import { CONTENT_VERSION, presetOf, sourceFiles } from './recipe/presets.js'
import { verifyProject } from './recipe/project-verification.js'
import { runBounded } from './recipe/scheduler.js'
import { DEFAULT_HISTORY_LIMITS, runHistoryDAG } from './recipe/history-scheduler.js'
import { StepJournal } from './recipe/step-journal.js'
import { projectHistorySteps, projectHistoryPlan, assertProjectStep, resolveHistoryStep, machineCreateArgs } from './recipe/recipe.js'
import { CliInventory } from './inventory.js'
import { PresetPostgres, isPostgresql, storeMachines, usesMachine } from './postgresql.js'

/** The manifest's owner tag. */
export const TOOL = 'dsh-layerfs-presets'

const missing = error => ['NotFound', 'NoSuchProject', 'NoSuchStore', 'NoSuchBranch', 'NoSuchSandbox'].includes(error.code)
const rows = (value, field = 'items') => Array.isArray(value) ? value : value?.[field] ?? []
const fail = message => { throw new Error(message) }
const uncertain = error => error.code === 'Unknown' || error.transport === 'transport-unknown' || error.detail?.attempted === true
// LayerFS refused admission because another writer held the Store's history
// ("caller may retry later"): nothing changed, so the same step may run again.
// The CLI reports it with code Unknown, so it is matched by its refusal text.
export const historyBusy = error => error?.transport !== 'transport-unknown' && (error?.code === 'Busy' || /\bHistory\(Busy\)/.test(error?.message ?? ''))
export const BUSY_ATTEMPTS = 7
// One history writer per Store: concurrent writers in one Store intermittently fail on
// LayerFS 2.0 (History(Busy), or a refused fork on a worker). Stores still run in parallel.
export const PRESET_HISTORY_LIMITS = Object.freeze({ ...DEFAULT_HISTORY_LIMITS, perStore: 1 })

export class DemoRunner extends CliInventory {
  constructor({ state, home, adoptHome = false, preset = 'studio', driver, sandboxes, report = console.log, progress = () => {}, historyDensity = 'dense', historyCycles, executionMode = 'filesystem', historySchedule = 'parallel', historyConcurrency = PRESET_HISTORY_LIMITS.concurrency, historyStoreConcurrency = PRESET_HISTORY_LIMITS.perStore, historyProjectConcurrency = PRESET_HISTORY_LIMITS.perProject, postgres }) {
    super(driver)
    this.state = resolve(state)
    this.home = home ? resolve(home) : join(this.state, 'home-2')
    this.adoptHome = adoptHome
    this.file = join(this.state, 'demo-fixtures.json')
    this.journalFile = join(this.state, 'demo-steps.ndjson')
    this.lock = join(this.state, 'demo-fixtures.lock')
    this.presetName = preset; this.preset = presetOf(preset); this.driver = driver
    this.postgres = postgres ?? new PresetPostgres({ state: this.state })
    if (!['filesystem', 'mixed'].includes(executionMode)) throw new Error(`Unknown execution mode ${executionMode}`)
    this.executionMode = executionMode
    this.mixedPools = new Map()
    this.historyOptions = { density: historyDensity, cycles: historyCycles, executionMode }
    if (!['parallel', 'serial'].includes(historySchedule)) throw new Error(`Unknown history schedule ${historySchedule}`)
    this.historySchedule = historySchedule
    this.historyLimits = { concurrency: historyConcurrency, perStore: historyStoreConcurrency, perProject: historyProjectConcurrency }
    for (const [name, value] of Object.entries(this.historyLimits)) if (!Number.isInteger(value) || value < 1) throw new Error(`Invalid history ${name}: ${value}`)
    if (historyConcurrency > 16) throw new Error('History concurrency cannot exceed 16 CLI processes.')
    this.sandboxesExplicit = sandboxes !== undefined
    this.sandboxes = this.preset.sandboxes === false ? false : sandboxes ?? true; this.report = report; this.progress = (value, force = false) => {
      const now = Date.now()
      if (!force && value.stage === this.lastProgressStage && value.completed !== value.total && now - (this.lastProgressAt ?? 0) < 250) return
      this.lastProgressAt = now; this.lastProgressStage = value.stage
      if (value.stage === 'verifying' && this.historyTasks && !value.tasks) value = { ...value, tasks: this.historyTasks }
      progress(value)
      if (this.manifest?.presetOperation?.state === 'running') { this.manifest.presetOperation.progress = value; this.save() }
    }
  }
  plan() {
    return { preset: this.presetName, description: this.preset.description, executionMode: this.executionMode, sandboxLimit: 3, workspaceLimit: 16, state: this.state, home: this.home, machines: this.preset.machines, stores: this.preset.stores, projects: this.preset.stores.reduce((n, s) => n + s.projects.length, 0), sandboxes: this.executionMode === 'mixed' ? this.preset.stores.reduce((n, store) => n + store.projects.length, 0) : this.sandboxes ? this.preset.stores.length : 0, workspaces: this.executionMode === 'mixed' ? this.preset.stores.reduce((n, store) => n + store.projects.length * 2, 0) : this.sandboxes ? this.preset.stores.length * 2 : 0, journal: this.journalFile }
  }
  save() {
    const temporary = `${this.file}.${process.pid}.tmp`
    const { steps, ...snapshot } = this.manifest
    writeFileSync(temporary, stringify({ ...snapshot, steps: {}, ...(this.journal ? { stepJournal: this.journal.metadata() } : {}) }), { mode: 0o600 })
    renameSync(temporary, this.file)
  }
  acquire() {
    mkdirSync(this.state, { recursive: true, mode: 0o700 })
    if (lstatSync(this.state).isSymbolicLink()) fail('The demo state must be a real directory, not a symlink.')
    let fd
    try { fd = openSync(this.lock, 'wx', 0o600) } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const previous = readFileSync(this.lock, 'utf8')
      let owner
      try { owner = JSON.parse(previous) } catch { fail('The demo lock is malformed; inspect it before continuing.') }
      try { process.kill(owner.pid, 0); fail(`Another demo operation is running (PID ${owner.pid}).`) } catch (e) { if (e.code !== 'ESRCH') throw e }
      if (readFileSync(this.lock, 'utf8') !== previous) fail('The demo lock changed; try the command again.')
      unlinkSync(this.lock)
      fd = openSync(this.lock, 'wx', 0o600)
    }
    writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() })); closeSync(fd)
    this.locked = true
  }
  release() { if (this.locked) { unlinkSync(this.lock); this.locked = false } }
  load(create = false) {
    if (existsSync(this.home) && lstatSync(this.home).isSymbolicLink()) fail('The demo home must not be a symlink.')
    if (existsSync(this.file)) {
      this.manifest = JSON.parse(readFileSync(this.file, 'utf8'))
      if (this.manifest.tool !== TOOL || this.manifest.version !== 1 || (this.manifest.preset !== this.presetName && this.command !== 'reset') || this.manifest.state !== realpathSync(this.state)) fail('The demo ownership manifest does not match this state and preset. Use a separate state directory for each preset.')
      if (this.preset.sandboxes !== false && !this.sandboxesExplicit && typeof this.manifest.sandboxes === 'boolean') this.sandboxes = this.manifest.sandboxes
      if (this.sandboxesExplicit && this.manifest.sandboxes !== undefined && this.preset.sandboxes !== false && this.manifest.sandboxes !== this.sandboxes && this.command !== 'reset') fail('Changing sandbox configuration requires reset; setup does not silently remove existing sandboxes.')
    } else {
      if (!create) fail('No demo ownership manifest. Run setup or preview first; an existing LayerFS home will not be adopted.')
      if (!this.adoptHome && existsSync(this.home) && readdirSync(this.home).length) fail('Refusing to adopt a nonempty LayerFS home without a demo ownership manifest. Choose a fresh --state directory.')
      this.manifest = { tool: TOOL, version: 1, id: randomUUID(), preset: this.presetName, contentVersion: CONTENT_VERSION, executionMode: this.executionMode, ...(this.executionMode === 'mixed' ? { mixedRecipeVersion: MIXED_RECIPE_VERSION } : {}), sandboxes: this.sandboxes, state: realpathSync(this.state), homeId: null, created: Date.now(), resources: { machine: {}, store: {}, sandbox: {} }, projects: {}, borrowed: {}, steps: {} }
      this.save()
    }
    if (this.manifest.stepJournal && !existsSync(this.journalFile)) fail('The preset step journal is missing. Inspect the state directory; mutations will not be replayed.')
    this.journal = new StepJournal(this.journalFile)
    this.manifest.steps = this.journal.load(this.manifest.steps)
    const homeFile = join(this.home, 'layerfs.json')
    if (existsSync(homeFile)) {
      const homeId = JSON.parse(readFileSync(homeFile, 'utf8')).id
      if (this.manifest.homeId && this.manifest.homeId !== homeId) fail('The LayerFS home identity changed. The ownership manifest cannot authorize cleanup of this home.')
      if (!homeId) fail('The demo home has no valid LayerFS identity.')
      this.manifest.homeId = homeId
    } else if (this.manifest.homeId) fail('The owned LayerFS home is missing. Preserve its manifest and inspect the state directory.')
  }
  async query(argv) { return this.driver.invoke(argv, { read: true }) }
  async maybe(argv) {
    const [family, call, name] = argv
    // Inventory first: an expected absence is not a failed CLI invocation.
    if (call === 'get' && ['machine', 'store', 'sandbox', 'project'].includes(family)) {
      let page = 0, found = false
      do {
        const list = await this.query([family, 'list', ...(family === 'project' ? [name.split('/')[0]] : []), ...(['sandbox', 'project'].includes(family) ? ['--page-size', '1000', '--page-pos', String(page)] : [])])
        found = rows(list, family === 'machine' ? 'machines' : 'items').some(row => family === 'project' ? (row.project ?? row.key ?? `${row.store}/${row.name}`) === name : row.name === name)
        if (found) break
        page = list.next_page_pos ?? null
      } while (page !== null)
      if (!found) return null
    }
    try { return await this.query(argv) } catch (error) { if (missing(error)) return null; throw error }
  }
  recordStep(key, step) {
    this.journal ??= new StepJournal(this.journalFile)
    try { this.journal.append(key, step) } catch (error) { error.presetJournalFailure = true; throw error }
    this.manifest.steps[key] = step
  }
  async once(key, argv, options) {
    const previous = this.manifest.steps[key]
    if (previous?.status === 'done') {
      if (stringify(previous.argv) !== stringify(argv)) fail(`Step ${key} no longer matches its recorded command. Reset before changing the recipe.`)
      return previous.result
    }
    if (previous && ['running', 'uncertain'].includes(previous.status)) fail(`Step ${key} has no certain final result. Run status and inspect LayerFS; reset/teardown perform cleanup rather than replaying this step.`)
    this.recordStep(key, { status: 'running', argv, ...(options?.dependencies ? { dependencies: options.dependencies } : {}), at: Date.now(), actionId: this.action?.id })
    try {
      let result
      for (let attempt = 1; ; attempt++) {
        try {
          result = await this.driver.invoke(argv, { ...options, onInvocation: identity => {
            this.recordStep(key, { ...this.manifest.steps[key], invocationId: identity.id, actionId: identity.actionId })
          } })
          break
        } catch (error) {
          if (!historyBusy(error) || attempt >= BUSY_ATTEMPTS) throw error
          await this.backoff(attempt)
        }
      }
      this.recordStep(key, { ...this.manifest.steps[key], status: 'done', ended: Date.now(), result })
      return result
    } catch (error) {
      this.recordStep(key, { ...this.manifest.steps[key], status: uncertain(error) || error.presetJournalFailure || argv[0] === 'project' && argv[1] === 'init' && error.code === 'Failed' ? 'uncertain' : 'failed', code: error.code ?? 'Failed', ended: Date.now() })
      throw error
    }
  }
  /** Wait before retrying a History(Busy) refusal: 0.2 s doubling, with jitter. */
  backoff(attempt) { return new Promise(resolve => setTimeout(resolve, 200 * 2 ** (attempt - 1) + Math.random() * 200)) }
  assertSetupSettled() {
    const pending = Object.entries(this.manifest.steps).find(([, s]) => ['running', 'uncertain'].includes(s.status))
    if (pending) fail(`Setup cannot replay ${pending[0]} after an interrupted/uncertain outcome. Run status, inspect the named resource, then use reset or teardown for owned cleanup.`)
  }
  async ensureResource(family, name, argv, { before } = {}) {
    const current = await this.maybe([family, 'get', name])
    const owned = this.manifest.resources[family][name]
    if (current) {
      if (!owned?.owned) fail(`${family} ${name} already exists but is not confirmed as created by this fixture. It will not be adopted or removed.`)
      if (owned.created != null && current.created != null && owned.created !== current.created) fail(`${family} ${name} was replaced outside the fixture. Cleanup authority is no longer certain.`)
      if (current.op?.uncertain || ['unresolved', 'creating', 'removing', 'closing'].includes(current.state)) fail(`${family} ${name} needs inspection (${current.state}); no operation will be replayed.`)
      return current
    }
    if (owned?.owned) fail(`Owned ${family} ${name} is missing. Run reset to rebuild the fixture.`)
    this.manifest.resources[family][name] = { owned: false, status: 'creating' }; this.save()
    await before?.()
    try { await this.once(`${family}.create:${name}`, argv) } catch (error) {
      if (family === 'machine' && error.detail?.vm_exists === true && !uncertain(error)) {
        this.manifest.resources[family][name] = { owned: true, created: null, status: 'failed' }; this.save()
      }
      throw error
    }
    this.manifest.resources[family][name] = { owned: true, created: null, status: 'ready' }; this.save()
    const made = await this.query([family, 'get', name])
    this.manifest.resources[family][name] = { owned: true, created: made.created ?? null, status: 'ready' }; this.save()
    return made
  }
  async initialize() {
    mkdirSync(this.home, { recursive: true, mode: 0o700 }); chmodSync(this.home, 0o700)
    if (!existsSync(join(this.home, 'layerfs.json'))) await this.driver.invoke(['machine', 'list'])
    this.load(); this.save()
  }
  async preflight() {
    if (this.preset.stores.some(isPostgresql)) {
      // `machine platforms` lists PostgreSQL support even in a build without the engine; the CLI's own features say.
      const features = (await this.driver.discover?.())?.identity?.features
      if (Array.isArray(features) && !features.includes('postgresql')) fail(`This preset has PostgreSQL Stores, and the pinned LayerFS CLI was built without PostgreSQL (features: ${features.join(', ') || 'none'}). Pin a runtime built with the postgresql feature (CLI and Linux bundle) in Machines → LayerFS runtime, then build again.`)
    }
    const supported = rows(await this.query(['machine', 'platforms']), 'platforms')
    for (const machine of this.preset.machines) {
      const name = typeof machine === 'string' ? machine : machine.name
      if (!this.preset.stores.some(store => usesMachine(store, name))) continue
      const platform = typeof machine === 'string' ? machine : machine.platform
      const row = supported.find(row => row.platform === platform)
      const needsSqlite = this.preset.stores.some(store => !isPostgresql(store) && store.machine === name)
      const needsPostgresql = this.preset.stores.some(store => isPostgresql(store) && usesMachine(store, name))
      if (row?.ready && needsPostgresql && row.postgresql?.sandbox !== true) fail(`${platform} cannot run PostgreSQL Store work on this host: ${row.postgresql?.reason ?? 'unsupported'}. Nothing will be fabricated.`)
      if (!row?.ready || (needsSqlite && !row.sqlite)) fail(`${platform} is not ready for this preset: ${(row?.missing ?? ['unsupported on this host']).join(', ')}. Fix the prerequisite or select a smaller preset; nothing will be fabricated.`)
    }
    if (this.preset.stores.some(isPostgresql)) {
      const problem = await this.postgres.available()
      if (problem) fail(`This preset's PostgreSQL Stores live on a PostgreSQL server it runs in Docker, and Docker is not available: ${problem}`)
    }
    if ((this.sandboxes || this.executionMode === 'mixed') && this.preset.stores.some(store => store.machine === 'native') && !this.driver.spec.daemon) fail('Native sandboxes need a matching layerfs-daemon. Pin it in Machines → LayerFS runtime (or DSH_LAYERFS_DAEMON), or use Filesystem mode.')
  }
  async startMachine(name) {
    const current = await this.query(['machine', 'get', name])
    if (current.op || current.state === 'unresolved') fail(`Machine ${name} has an operation in flight or unresolved. Inspect it first.`)
    if (['running', 'ready'].includes(current.state)) return
    if (name === 'docker' && !this.manifest.borrowed.docker) { this.manifest.borrowed.docker = { initially: current.state, started: true }; this.save() }
    await this.once(`machine.start:${name}:${this.commandId}`, ['machine', 'start', name])
  }
  /** A SQLite Store created at home, or a PostgreSQL Store connected to a fresh database on the preset's server. */
  async ensureStore(store) {
    if (!isPostgresql(store)) return this.ensureResource('store', store.name, ['store', 'create', store.name])
    if (!this.manifest.resources.store[store.name]?.owned) {
      const { port } = await this.postgres.ensure()
      const argv = ['store', 'connect', store.name, this.postgres.url(port, store.database), '--password', this.postgres.passwordRef()]
      return this.ensureResource('store', store.name, argv, { before: () => this.postgres.freshDatabase(store.database) })
    }
    return this.ensureResource('store', store.name, null)
  }
  /** A SQLite Store pushed to its machine; a PostgreSQL Store attached to each of its machines. */
  async placeStore(store, reportProgress = () => {}) {
    const placed = await this.query(['store', 'get', store.name])
    if (placed.op || placed.state === 'unresolved') fail(`Store ${store.name} has an operation that needs inspection.`)
    if (isPostgresql(store)) {
      for (const machine of storeMachines(store)) {
        if (placed.machines?.[machine]?.checked) continue
        reportProgress(`Attaching ${store.name} to ${machine}`)
        await this.once(`store.attach:${store.name}:${machine}`, ['store', 'attach', store.name, machine])
      }
      return
    }
    if (placed.machine !== store.machine) {
      if (placed.machine !== 'native') fail(`Store ${store.name} moved outside the fixture plan. Inspect it or reset.`)
      reportProgress(`Moving ${store.name} to ${store.machine}`)
      await this.once(`store.push:${store.name}`, ['store', 'push', store.name, store.machine, '--progress'])
    }
  }
  source(store, name) {
    const root = join(this.state, 'demo-sources'), storeRoot = join(root, store), folder = join(storeRoot, name)
    for (const path of [root, storeRoot, folder]) {
      if (existsSync(path) && lstatSync(path).isSymbolicLink()) fail('Demo source paths must not be symlinks.')
      mkdirSync(path, { recursive: true, mode: 0o700 })
    }
    for (const [path, content] of Object.entries(sourceFiles(name))) {
      const file = join(folder, path)
      if (existsSync(dirname(file)) && lstatSync(dirname(file)).isSymbolicLink() || existsSync(file) && lstatSync(file).isSymbolicLink()) fail('Demo source files must not be symlinks.')
      mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, content)
    }
    return folder
  }
  async ensureProject(store, name) {
    const key = `${store}/${name}`
    const current = await this.maybe(['project', 'get', key])
    if (!current) {
      if (this.manifest.projects[key]) fail(`Owned project ${key} is missing. Run reset to rebuild it.`)
      await this.once(`project.init:${key}`, ['project', 'init', key, this.source(store, name), '--progress'])
      this.manifest.projects[key] = { seeded: false }; this.save()
    } else if (!this.manifest.projects[key]) fail(`Project ${key} was not created by this fixture; it will not be overwritten.`)
  }
  historyArgv(step, project) {
    if (!step.commitFrom) return step.argv
    const dependency = this.manifest.steps[`${step.commitFrom}:${project}`]
    if (dependency?.status !== 'done' || typeof dependency.result?.head !== 'string' || !dependency.result.head) fail(`Missing immutable Commit receipt for ${step.key}; no publication was attempted.`)
    return resolveHistoryStep(step, { [step.commitFrom]: dependency.result })
  }
  async executeHistoryStep(project, step) {
    for (const key of step.dependsOn ?? []) if (this.manifest.steps[`${key}:${project}`]?.status !== 'done') fail(`Unconfirmed dependency ${key} for ${step.key}; no mutation was attempted.`)
    const key = `${step.key}:${project}`
    if (step.resource?.family === 'sandbox') {
      const made = await this.ensureResource('sandbox', step.resource.name, step.argv)
      if (!this.manifest.steps[key]) this.recordStep(key, { status: 'done', argv: step.argv, result: made, resourceReceipt: `sandbox.create:${step.resource.name}`, at: Date.now() })
      return made
    }
    let pool, sandbox, workspace
    if (step.argv[0] === 'workspace' && step.argv[1] === 'mount') {
      pool = this.mixedPools.get(project)
      if (!pool) { pool = new MixedSandboxPool(project); this.mixedPools.set(project, pool) }
      workspace = step.argv[step.argv.indexOf('--name') + 1]
      sandbox = pool.acquire(workspace)
      if (sandbox !== step.argv[2]) fail('Mixed workspace allocation does not match its recorded script.')
    }
    await this.once(key, this.historyArgv(step, project), { ...(step.input === undefined ? {} : { input: step.input }), dependencies: step.dependsOn })
    const result = this.manifest.steps[key]?.result
    assertProjectStep(step, result)
    if (step.argv[0] === 'workspace' && step.argv[1] === 'unmount') {
      const [box, ws] = step.argv[2].split(':'); this.mixedPools.get(project)?.release(box, ws)
    }
    return result
  }
  async seedProjectHistory(store, name, onStep = () => {}, shouldStop = () => false) {
    const key = `${store}/${name}`
    if (!this.manifest.projects[key]) fail(`Project ${key} has not been imported.`)
    const steps = projectHistorySteps(store, name, this.historyOptions)
    if (this.manifest.projects[key].seeded) {
      for (const [index, step] of steps.entries()) onStep(index + 1, step, this.manifest.steps[`${step.key}:${key}`]?.result)
      return
    }
    for (const [index, step] of steps.entries()) {
      if (shouldStop()) throw Object.assign(new Error('Stopped before the next CLI step because another project failed. Inspect the failed project before rebuilding.'), { code: 'PresetStopped' })
      const result = await this.executeHistoryStep(key, step)
      onStep(index + 1, step, result)
    }
    this.manifest.projects[key].seeded = true; this.save()
  }
  async seedProject(store, name) {
    await this.ensureProject(store, name)
    await this.seedProjectHistory(store, name)
  }
  async setupConcurrentProjects({ advance, reportProgress }) {
    // Import serially within each Store. No history operation starts until all
    // Stores are placed, so the generated history exercises the target machines.
    await runBounded(this.preset.stores, 2, async (store, { shouldStop }) => {
      const stopIfFailed = () => { if (shouldStop()) throw Object.assign(new Error('Preparation stopped because another store failed.'), { code: 'PresetStopped' }) }
      reportProgress(`Preparing store ${store.name} for ${store.machine}`)
      await this.ensureStore(store)
      for (const name of store.projects) {
        stopIfFailed()
        reportProgress(`Importing project ${store.name}/${name}`)
        await this.ensureProject(store.name, name)
      }
      stopIfFailed()
      await this.placeStore(store, reportProgress)
      advance(isPostgresql(store) ? `Store ${store.name} is attached to ${storeMachines(store).join(', ')}` : `Store ${store.name} is placed on ${store.machine}`)
    })
    const tasks = this.preset.stores.flatMap(store => store.projects.map(name => {
      const plan = projectHistoryPlan(name, this.historyOptions)
      return { id: `${store.name}/${name}`, project: `${store.name}/${name}`, machine: store.machine, store: store.name, name, tier: plan.tier, state: 'waiting', completed: 0, total: projectHistorySteps(store.name, name, this.historyOptions).length, commits: 0, branches: 1, layers: 1, targetCommits: plan.commits, targetBranches: plan.branches.length + 1, targetLayers: plan.layers }
    }))
    const workspaceRequired = tasks.reduce((n, task) => n + projectHistoryPlan(task.name, this.historyOptions).workspaceRevisions, 0)
    const authoredTotal = tasks.reduce((n, task) => n + projectHistoryPlan(task.name, this.historyOptions).authoredRevisions, 0)
    let workspaceCompleted = 0
    let lastTaskProgress = 0
    const preparation = this.preset.machines.length + this.preset.stores.length
    const total = preparation + tasks.reduce((sum, task) => sum + task.total, 0)
    const publish = (label, immediate = false) => {
      const now = Date.now()
      if (!immediate && now - lastTaskProgress < 250) return
      lastTaskProgress = now
      this.historyTasks = tasks.map(({ store, name, ...task }) => ({ ...task }))
      const historyCompleted = tasks.reduce((sum, task) => sum + task.completed, 0)
      this.progress({ stage: 'building', completed: preparation + historyCompleted, total, historyCompleted, historyTotal: total - preparation, workspaceCoverage: { completed: workspaceCompleted, required: workspaceRequired, total: authoredTotal }, label, tasks: this.historyTasks }, true)
    }
    publish(`All stores are placed. Preparing ${tasks.length} project histories concurrently`)
    const previousConcurrency = this.driver.concurrency
    this.driver.concurrency = this.historyLimits.concurrency
    try {
      if (this.historySchedule === 'parallel') {
        const scheduled = tasks.map(task => ({ ...task, seeded: this.manifest.projects[task.project]?.seeded === true, steps: projectHistorySteps(task.store, task.name, this.historyOptions), commitIds: new Set() }))
        try {
          await runHistoryDAG(scheduled, async (item, step) => {
            const task = tasks.find(task => task.id === item.id)
            if (!task.started) { task.started = Date.now(); task.state = 'running'; publish(`Building ${task.project} on ${task.machine}`, true) }
            try {
              let result
              if (item.seeded) {
                // Completed version-3 histories used moving-head publish argv.
                // Retain their exact original custody instead of replaying/rekeying.
                const receipt = this.manifest.steps[`${step.key}:${task.project}`]
                if (receipt?.status !== 'done') fail(`Seeded project ${task.project} has no confirmed receipt for ${step.key}; inspect its journal before reset.`)
                result = receipt.result; assertProjectStep(step, result)
              } else result = await this.executeHistoryStep(task.project, step)
              task.completed++
              if (step.workspaceRevision && result?.kind === 'Committed') workspaceCompleted++
              if (['Committed', 'Merged'].includes(result?.kind) && result.head) item.commitIds.add(result.head)
              task.commits = item.commitIds.size
              if (['Forked', 'Merged'].includes(result?.kind)) task.branches++
              if (result?.kind === 'Added') task.layers++
              if (task.completed === task.total) {
                this.manifest.projects[task.project].seeded = true; this.save()
                task.ended = Date.now(); task.state = 'completed'
              }
              publish(`Building ${task.project} on ${task.machine}`, task.completed === task.total)
            } catch (error) {
              task.ended = Date.now(); task.state = 'failed'; task.error = error.message; task.errorCode = error.code ?? 'Failed'
              publish(`${task.project} history stopped`, true)
              throw error
            }
          }, this.historyLimits)
        } catch (error) {
          for (const task of tasks) if (!['failed', 'completed'].includes(task.state)) { task.state = 'stopped'; task.ended = Date.now() }
          publish('History scheduling stopped; all dispatched commands have settled', true)
          throw error
        }
        return
      }
      await runBounded(tasks, 8, async (task, { shouldStop }) => {
        task.started = Date.now(); task.state = 'running'; publish(`Building ${task.project} on ${task.machine}`, true)
        const commitIds = new Set()
        try {
          await this.seedProjectHistory(task.store, task.name, (completed, step, result) => {
            task.completed = completed
            if (step?.workspaceRevision && result?.kind === 'Committed') workspaceCompleted++
            if (step && result) {
              if (['Committed', 'Merged'].includes(result.kind) && result.head) commitIds.add(result.head)
              task.commits = commitIds.size
              if (['Forked', 'Merged'].includes(result.kind)) task.branches++
              if (result.kind === 'Added') task.layers++
            }
            publish(`Building ${task.project} on ${task.machine}`)
          }, shouldStop)
          task.ended = Date.now(); task.state = 'completed'; publish(`${task.project} history is ready`, true)
        } catch (error) {
          task.ended = Date.now(); task.state = error.code === 'PresetStopped' ? 'stopped' : 'failed'; task.error = error.message; task.errorCode = error.code ?? 'Failed'; publish(`${task.project} history stopped`, true)
          throw error
        }
      })
    } finally {
      // runBounded drains all in-flight calls before restoring admission or
      // allowing run() to release the environment operation lock.
      this.driver.concurrency = previousConcurrency
    }
  }
  async setup() {
    this.assertSetupSettled()
    if (Object.keys(this.manifest.projects).length && (this.manifest.executionMode ?? 'filesystem') !== this.executionMode) fail('Changing execution mode requires Build projects to reset the existing library first.')
    if (Object.keys(this.manifest.projects).length && this.executionMode === 'mixed' && this.manifest.mixedRecipeVersion !== MIXED_RECIPE_VERSION) fail('Mixed workspace sessions have changed. Use Build projects to reset and build the current two-revision workspace sessions.')
    this.manifest.executionMode = this.executionMode
    if (this.executionMode === 'mixed') this.manifest.mixedRecipeVersion = MIXED_RECIPE_VERSION
    if (Object.keys(this.manifest.projects).length && this.manifest.contentVersion !== CONTENT_VERSION) fail('Preset content has changed. Use Build preset to reset and prepare the new project library; existing data has been preserved.')
    await this.preflight()
    let completed = 0
    const total = this.preset.machines.length + this.preset.stores.length + this.preset.stores.reduce((n, store) => n + (this.preset.concurrentHistory ? store.projects.reduce((sum, name) => sum + projectHistorySteps(store.name, name, this.historyOptions).length, 0) : store.projects.length), 0)
    const reportProgress = (label, tasks) => this.progress({ stage: 'building', completed, total, label, ...(tasks ? { tasks } : {}) })
    const advance = (label, tasks) => { completed++; reportProgress(label, tasks) }
    this.progress({ stage: 'building', completed, total, label: 'Preparing preset resources' })
    for (const machine of this.preset.machines) {
      const name = typeof machine === 'string' ? machine : machine.name
      if (typeof machine !== 'string') await this.ensureResource('machine', name, machineCreateArgs(machine))
      // Empty preset lists built-ins but does not start Docker.
      if (this.preset.stores.some(store => usesMachine(store, name))) await this.startMachine(name)
      advance(`Machine ${name} ready`)
    }
    if ((this.sandboxes || this.executionMode === 'mixed') && this.preset.stores.some(store => store.machine === 'native')) {
      const native = await this.query(['machine', 'get', 'native'])
      if (native.daemon !== this.driver.spec.daemon) await this.once(`native.daemon:${this.driver.spec.daemon}`, ['machine', 'update', 'native', '--daemon', this.driver.spec.daemon])
    }
    if (this.preset.concurrentHistory) {
      await this.setupConcurrentProjects({ advance, reportProgress })
      return
    }
    await runBounded(this.preset.stores, 2, async store => {
      await this.ensureStore(store)
      for (const project of store.projects) {
        this.progress({ stage: 'building', completed, total, label: `Building project ${store.name}/${project}` })
        await this.seedProject(store.name, project); advance(`Project ${store.name}/${project} ready`)
      }
      await this.placeStore(store)
      if (!this.sandboxes) { advance(`Store ${store.name} ready`); return }
      const sandbox = `demo-${store.projects[0]}`, project = `${store.name}/${store.projects[0]}`
      await this.ensureResource('sandbox', sandbox, ['sandbox', 'create', project, sandbox, store.machine])
      const detail = await this.query(['sandbox', 'get', sandbox])
      if (detail.down_reason) fail(`Sandbox ${sandbox} cannot be reached: ${detail.down_reason}`)
      for (const [name, branch] of [['feature', projectHistoryPlan(store.projects[0], this.historyOptions).definition.features[0].name], ['fix', projectHistoryPlan(store.projects[0], this.historyOptions).definition.features[1].name]]) {
        if (!detail.workspaces?.some(ws => ws.name === name)) await this.once(`workspace.mount:${sandbox}:${name}`, ['workspace', 'mount', sandbox, branch, '--name', name])
      }
      advance(`Store ${store.name} and workspaces ready`)
    })
  }
  async verify() {
    if (this.executionMode === 'mixed' && this.manifest.mixedRecipeVersion !== MIXED_RECIPE_VERSION) fail('This environment uses older Mixed workspace sessions. Build the current two-revision workspace recipe before verifying it.')
    if (this.manifest.contentVersion !== CONTENT_VERSION) fail('This environment has older preset content. Build the current project library before verifying it.')
    let projects = 0
    const projectTotal = this.preset.stores.reduce((sum, store) => sum + store.projects.length, 0)
    this.progress({ stage: 'verifying', completed: 0, total: projectTotal, label: 'Verifying saved project files and histories' }, true)
    for (const machine of this.preset.machines) await this.query(['machine', 'get', typeof machine === 'string' ? machine : machine.name])
    // Four independent read pipelines; projects and pagination remain ordered
    // inside a Store. A failed pipeline stops every sibling before its next read.
    await runBounded(this.preset.stores, 4, async (store, { shouldStop }) => {
      const query = argv => {
        if (shouldStop()) throw Object.assign(new Error('Verification stopped because another Store failed; all dispatched reads have settled.'), { code: 'PresetStopped' })
        return this.query(argv)
      }
      const current = await query(['store', 'get', store.name])
      const placedRight = isPostgresql(store) ? current.kind === 'postgresql' && storeMachines(store).every(machine => current.machines?.[machine]?.checked) : current.machine === store.machine
      if (!placedRight || current.op) fail(`Store ${store.name} does not match its intended placement or has an operation in flight.`)
      for (const name of store.projects) {
        const key = `${store.name}/${name}`
        await query(['project', 'get', key])
        const receipt = { steps: Object.fromEntries(projectHistorySteps(store.name, name, this.historyOptions).map(step => [step.key, this.manifest.steps[`${step.key}:${key}`]?.result])) }
        const verified = await verifyProject(query, store.name, name, receipt, this.historyOptions)
        if (this.executionMode === 'mixed') {
          const box = await query(['sandbox', 'get', mixedSandboxName(name), '--page-size', '16', '--page-pos', '0'])
          if (box.project !== key || !storeMachines(store).includes(box.machine) || box.state !== 'running' || box.op || box.down_reason || !Array.isArray(box.workspaces) || box.workspaces.length || box.next_page_pos != null) fail(`Mixed sandbox for ${key} is unreachable, misplaced or still mounted.`)
          const plan = projectHistoryPlan(name, this.historyOptions)
          const completed = projectHistorySteps(store.name, name, this.historyOptions).filter(step => step.workspaceRevision && this.manifest.steps[`${step.key}:${key}`]?.result?.kind === 'Committed').length
          if (completed !== plan.workspaceRevisions || completed / plan.authoredRevisions < 0.3) fail(`Mixed workspace coverage is incomplete for ${key}.`)
          verified.workspaceRevisions = completed; verified.authoredRevisions = plan.authoredRevisions
        }
        this.manifest.projects[key].verification = verified; this.save()
        projects++
        this.progress({ stage: 'verifying', completed: projects, total: projectTotal, label: `Verified ${projects} of ${projectTotal} projects: ${key}` }, true)
      }
      if (this.sandboxes) {
        const inspector = new CliInventory({ invoke: query })
        const box = await inspector.sandboxDetails(`demo-${store.projects[0]}`)
        if (box.down_reason || !['feature', 'fix'].every(name => box.workspaces?.some(ws => ws.name === name))) fail(`Sandbox ${box.name} is missing its workspaces or is unreachable.`)
      }
    })
    const journal = this.journalSummary()
    return { presetVerified: true, projects, journal }
  }
  /** Every completed step has its recorded final result; nothing is pending or uncertain. */
  journalSummary() {
    const steps = Object.values(this.manifest.steps)
    const unsettled = steps.filter(step => step.status !== 'done')
    if (unsettled.length) fail(`The preset step journal has ${unsettled.length} step(s) without a confirmed final result. Inspect the LayerFS inventory before rebuilding.`)
    return { verifiedAt: Date.now(), steps: steps.length, mutations: steps.filter(step => !['get', 'list'].includes(step.argv?.[1])).length }
  }

  /** Setup under the lock the environment reset holds (`inheritedLock`), or under a fresh one. */
  async run(command, { actionId, onReady, inheritedLock } = {}) {
    if (command !== 'setup') fail(`Unknown preset command ${command}`)
    this.command = command
    if (inheritedLock) {
      const lease = JSON.parse(readFileSync(this.lock, 'utf8'))
      if (lease.pid !== process.pid || lease.actionId !== inheritedLock) fail('The inherited build lock does not belong to this operation.')
    } else this.acquire()
    try {
      this.load(true)
      this.commandId = actionId ?? randomUUID()
      this.action = { id: this.commandId, name: `demo.${command}`, label: `Build ${this.presetName} preset`, target: this.presetName }
      if (!inheritedLock) writeFileSync(this.lock, JSON.stringify({ pid: process.pid, at: Date.now(), actionId: this.action.id }), { mode: 0o600 })
      try {
        this.manifest.presetOperation = { id: this.action.id, actionId: this.action.id, command, preset: this.presetName, pid: process.pid, created: Date.now(), state: 'running', phase: 'Building preset through the CLI' }
        this.save()
        await onReady?.(this.action)
        await this.driver.discover()
        await this.initialize()
        await this.setup()
        const verificationLabel = this.sandboxes ? 'Verifying preset files, history and workspaces' : 'Verifying project files, branches and main Layers'
        this.progress({ stage: 'verifying', completed: 0, total: this.preset.stores.reduce((sum, store) => sum + store.projects.length, 0), label: verificationLabel }, true)
        this.report(verificationLabel)
        const verification = await this.verify()
        this.progress({ stage: 'verifying', completed: verification.projects, total: verification.projects, label: 'Preset verified' }, true)
        this.manifest.lastSetupActionId = this.action.id; this.manifest.sandboxes = this.sandboxes
        this.manifest.last = { command, at: Date.now(), actionId: this.action.id }
        Object.assign(this.manifest.presetOperation, { state: 'completed', ended: Date.now(), presetVerified: verification.presetVerified, phase: 'Preset is ready and verified' }); this.save()
        return { preset: this.presetName, state: this.state, home: this.home, actionId: this.action.id, ...verification }
      } catch (error) {
        if (this.manifest.presetOperation) { Object.assign(this.manifest.presetOperation, { state: 'failed', ended: Date.now(), phase: error.message, error: { code: error.code ?? 'Failed', message: error.message } }); this.save() }
        throw error
      }
    } finally { if (!inheritedLock) this.release() }
  }
}
