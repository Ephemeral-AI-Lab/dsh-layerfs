// @ts-nocheck
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { compileSimulation, renderSimulationCommand, resolveSimulationStep, SIMULATION_CLI } from './compiler.ts'
import { claimSimulationExecution, SimulationJournal, validateSimulationPackage, writeSimulationPackage } from './package.ts'
import { verifySimulation } from './verify.ts'
import { SimulationExecution } from './gate.ts'
import { admitStore, execute, storeOfCall } from '../layerfs/cli.ts'
import { managedCli, savedVersions } from '../layerfs/tracing.ts'
import { describeCommand, list, narrateBlocked, narrateDelegation, narrateFailure, narrateTask, narrateWait, reportTask, summarizeTurn, taskPhrase } from './narration.ts'

const textOf = message => (message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('')
const request = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const terminal = state => ['completed', 'stopped', 'interrupted', 'uncertain', 'failed'].includes(state)
/** A remembered route a real model adapter can serve; script routes never qualify. */
const realRoute = route => route && typeof route.provider === 'string' && typeof route.model === 'string' && route.provider && route.model && route.provider !== 'simulation' ? route : undefined
const CONTINUE_FRESH = 'The script will not run again; a real model continues this session from the project\'s current files.'

export { parseSimulationBashReceipt as bashReceipt } from './receipts.ts'
import { parseSimulationBashReceipt } from './receipts.ts'

/** Fold authoritative native actions; compaction only replaces their surface,
 * never these canonical log events. This is a disposable derived cache. */
export function foldNativeActions(events, actions = new Map()) {
  for (const event of events) {
    if (event.type === 'assistant/message') for (const block of event.data?.message?.content ?? []) {
      if (block.type === 'tool-call') actions.set(String(block.id), { state: 'issued' })
    }
    if (event.type === 'tool/call') actions.set(String(event.data.callId), { state: 'issued' })
    if (event.type === 'tool/result') {
      const message = event.data?.message
      const id = message?.toolCallId ?? message?.source?.callId
      if (id !== undefined) actions.set(String(id), { state: message.isError ? 'failed' : 'completed' })
    }
  }
  return actions
}

export class SimulationRuntime {
  runs = new Map()
  bindings = new Map()
  calls = new Map()
  recoveredDeferred = new Map()
  constructor(ctx) { this.ctx = ctx }
  dispose() {
    for (const binding of this.bindings.values()) {
      if (terminal(binding.state)) continue
      binding.controller.abort(new Error('The simulation host was disposed'))
      binding.agent?.cancel({ kind: 'disposed' }, { keepInbox: true })
      void binding.run.execution.stop(binding.script.agentKey).catch(() => {})
    }
  }
  /** Only routes a running script can still use: live non-terminal bindings,
   * plus child routes a running parent may still delegate to. */
  scripts() {
    const routes = new Map()
    for (const run of this.runs.values()) {
      for (const binding of run.bindings.values()) {
        if (!terminal(binding.state) && !(binding.script.agentId && binding.ordinaryRestored)) routes.set(binding.script.scriptId, binding.script)
      }
      for (const script of run.plan.agents) {
        if (!script.agentId || run.bindings.has(script.agentKey)) continue
        const root = run.bindings.get(`${script.conversationId}-main`)
        if (root && !terminal(root.state)) routes.set(script.scriptId, script)
      }
    }
    return [...routes.values()]
  }
  /** Drop finished runs and tell model pickers when the offered scripts change. */
  refreshModels() {
    for (const [runId, run] of this.runs) {
      const roots = run.plan.agents.filter(script => !script.agentId).map(script => run.bindings.get(script.agentKey))
      if (roots.length && roots.every(binding => binding && terminal(binding.state))) this.runs.delete(runId)
    }
    const signature = this.scripts().map(script => script.scriptId).sort().join('\n')
    if (signature === this.modelSignature) return
    this.modelSignature = signature
    this.ctx.emit?.('llm/models-updated', 'simulation')
  }
  /** Whether a script currently owns this session (running, stopping or handing off). */
  isActive(sessionId) {
    const binding = this.bindings.get(String(sessionId))
    return !!binding && !terminal(binding.state)
  }
  ordinaryRoute(remembered) {
    return realRoute(remembered) ?? realRoute(this.ctx.agentDefaultModel?.currentSelection?.())
  }
  /** Session-local only: switch a session off a finished script route. */
  restoreOrdinary(agent, remembered, force = false) {
    if (!agent?.model?.select) return false
    if (!force && agent.model.current?.()?.provider !== 'simulation') return true
    const route = this.ordinaryRoute(remembered)
    if (!route) return false
    agent.model.select(route)
    return true
  }
  /** A launch needs a real model to hand off to; check before creating anything. */
  async usableRealModel(requested, signal) {
    const candidates = [realRoute(requested), realRoute(this.ctx.agentDefaultModel?.currentSelection?.())].filter(Boolean)
    for (const route of candidates) {
      if (!this.ctx.llm?.resolveModelInfo) return route
      try { await this.ctx.llm.resolveModelInfo(route.provider, route.model, signal); return route } catch (error) {
        signal?.throwIfAborted()
        this.ctx.logger?.('layerfs').warn('simulation real model %s/%s unavailable: %s', route.provider, route.model, String(error?.message ?? error))
      }
    }
    throw new Error('Select a usable real model before starting /simulation; it continues the sessions after the script. Nothing was created.')
  }
  metadata(binding) {
    const { run, script, ordinaryModel, rootSessionId } = binding
    return { runId: run.manifest.runId, agentKey: script.agentKey, scriptId: script.scriptId, name: script.name, hash: script.hash, ordinaryModel, ...(script.agentId ? { rootSessionId } : {}), state: binding.state }
  }
  async recover() {
    const root = join(this.ctx.layerfs.root, 'simulations')
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue
      const directory = join(root, entry.name)
      try {
        const manifest = await validateSimulationPackage(directory)
        if (!manifest.owner) continue
        const plan = JSON.parse(await readFile(join(directory, 'plan.json'), 'utf8'))
        const journal = await SimulationJournal.open(directory)
        for (const record of journal.records.filter(record => record.type === 'human-deferred')) {
          if (!journal.records.some(released => released.type === 'human-released' && released.messageId === record.messageId)) {
            const pending = this.recoveredDeferred.get(record.sessionId) ?? { journal, ids: new Set() }
            pending.ids.add(record.messageId); this.recoveredDeferred.set(record.sessionId, pending)
          }
        }
        const bound = journal.records.filter(record => record.type === 'binding')
        for (const row of bound) {
          if (this.isActive(row.sessionId)) continue
          const meta = this.ctx.layerfsSessions.simulationOf(row.sessionId)
          if (meta && !terminal(meta.state)) await this.ctx.layerfsSessions.completeSimulation(row.sessionId, undefined, 'interrupted', `The host restarted during script execution. ${CONTINUE_FRESH}`)
          // A plugin reload keeps live agents: switch them now, agent/created will not fire again.
          const live = this.ctx.agents?.get?.(row.sessionId)
          if (live && meta) {
            this.restoreOrdinary(live, meta.ordinaryModel)
            await this.restoreDeferred(live)
          }
        }
        // Recovered packages are deliberately never registered as executable models.
      } catch (error) { this.ctx.logger('layerfs').warn('simulation recovery %s: %s', entry.name, String(error)) }
    }
  }
  async launch(options, signal) {
    if ((options.cycles !== undefined || options.dispatchDelayMs !== undefined) && process.env.DSH_LAYERFS_SIMULATION_FIXTURES !== '1') throw new Error('Bounded simulation fixtures are disabled.')
    if (options.dispatchDelayMs !== undefined && (!Number.isInteger(options.dispatchDelayMs) || options.dispatchDelayMs < 0 || options.dispatchDelayMs > 10000)) throw new Error('Invalid fixture dispatch delay')
    if (options.cwd !== undefined && (!(await stat(options.cwd)).isDirectory() || !String(options.cwd).startsWith('/'))) throw new Error('Choose an existing absolute local scratch folder.')
    const compiled = compileSimulation({ project: options.project, machine: options.machine ?? 'native', mixed: options.mixed ?? false, ...(options.cycles === undefined ? {} : { cycles: options.cycles }) })
    const cli = this.ctx.layerfs.cli
    if (!cli) throw new Error('Pin a LayerFS CLI before starting project work.')
    // Every session hands off to a real model; refuse before any Store or project exists.
    const ordinaryModel = await this.usableRealModel(options.ordinaryModel, signal)
    const directory = await writeSimulationPackage(this.ctx.layerfs.root, compiled)
    await claimSimulationExecution(directory, 'host')
    const journal = await SimulationJournal.open(directory)
    const run = { ...compiled, directory, journal, execution: new SimulationExecution(compiled.plan, journal, { directory }), bindings: new Map(), dispatchDelayMs: options.dispatchDelayMs ?? 0 }
    this.runs.set(compiled.manifest.runId, run)
    try {
      await this.ctx.layerfs.ensureNative()
      for (const step of run.plan.steps.filter(step => step.phase === 'setup')) {
        await run.execution.execute(step.key, { origin: 'host', runId: run.manifest.runId }, (argv, definition, executionSignal) => execute({ cli, home: this.ctx.layerfs.home, bundle: this.ctx.layerfs.bundle, cacheHome: this.ctx.layerfs.cacheHome, callLog: this.ctx.layerfs.callLog }, argv, { input: definition.input, tag: `dsh-sim:${run.manifest.runId}:${step.key}`, beforeSpawn: () => executionSignal.throwIfAborted(), onSpawn: child => {
          const cancel = () => child.kill('SIGTERM')
          executionSignal.addEventListener('abort', cancel, { once: true })
          if (executionSignal.aborted) cancel()
          child.once('close', () => executionSignal.removeEventListener('abort', cancel))
        } }), signal)
      }
      const sessions = []
      for (const script of run.plan.agents.filter(agent => !agent.agentId)) {
        signal?.throwIfAborted()
        const id = `session-${randomUUID()}`
        const cwd = resolve(options.cwd ?? join(this.ctx.layerfs.root, 'simulation-scratch', run.manifest.runId, script.agentKey))
        await mkdir(cwd, { recursive: true })
        const binding = { run, script, sessionId: id, rootSessionId: id, ordinaryModel, turn: 0, state: 'running', controller: new AbortController(), complete: false }
        this.bindings.set(id, binding); run.bindings.set(script.agentKey, binding)
        await this.ctx.layerfsSessions.prepareSimulation(id, run.manifest.projectRef, this.metadata(binding))
        await run.journal.bind(script.agentKey, id)
        await this.ctx.sessionController.create({ sessionId: id, cwd, agentPreset: 'layerfs' })
        const agent = this.ctx.agents.get(id)
        binding.agent = agent
        agent.model.select({ provider: 'simulation', model: script.scriptId })
        this.authorize(agent, run)
        sessions.push(id)
      }
      this.refreshModels()
      // All immutable identities and session bindings are durable before first dispatch.
      for (const id of sessions) {
        const binding = this.bindings.get(id)
        this.queueScript(binding, binding.script.turns[0].request)
      }
      return { runId: run.manifest.runId, sessionId: sessions[0], sessions, navigate: { sessionId: sessions[0] } }
    } catch (error) {
      await journal.append({ type: 'setup-failed', error: String(error) })
      for (const binding of run.bindings.values()) {
        binding.state = 'failed'; binding.controller.abort(error)
        if (binding.agent) this.restoreOrdinary(binding.agent, binding.ordinaryModel, true)
        await this.ctx.layerfsSessions.completeSimulation(binding.sessionId, undefined, 'failed', `${String(error?.message ?? error)} ${CONTINUE_FRESH}`)
      }
      // A failed setup is never offered as a model.
      this.runs.delete(run.manifest.runId)
      this.refreshModels()
      throw error
    }
  }
  authorize(agent, run) {
    if (agent.session.snapshotEvents(0).some(event => event.type === 'subagent/model-selection-policy')) return
    agent.session.append('subagent/model-selection-policy', { allowedModels: [...run.plan.agents.map(script => ({ provider: 'simulation', model: script.scriptId })), ...[...run.bindings.values()].map(binding => binding.ordinaryModel).filter(route => route && route.provider !== 'simulation').map(route => ({ provider: route.provider, model: route.model }))].filter((route, index, all) => all.findIndex(other => other.provider === route.provider && other.model === route.model) === index) })
  }
  async created(agent) {
    const id = String(agent.id)
    let binding = this.bindings.get(id)
    if (!binding) {
      const saved = this.ctx.layerfsSessions?.simulationOf?.(id)
      if (saved) {
        // Reopened after its script ended (or after a restart): a real model owns it now.
        this.restoreOrdinary(agent, saved.ordinaryModel)
        await this.restoreDeferred(agent)
        return
      }
      await this.restoreDeferred(agent)
      const route = agent.model.current()
      if (route?.provider !== 'simulation') return
      const run = [...this.runs.values()].find(run => run.plan.agents.some(script => script.scriptId === route.model))
      const script = run?.plan.agents.find(script => script.scriptId === route.model)
      if (!run || !script?.agentId) throw new Error('This script is not authorized to start a fresh session.')
      const root = run.bindings.get(`${script.conversationId}-main`)
      if (!root || terminal(root.state)) throw new Error('The parent script has stopped.')
      const header = agent.session.header
      if (header?.origin !== 'subagent' || String(header.parentSession) !== root.sessionId) throw new Error('This child script must be started by its own native parent session.')
      const assigned = run.bindings.get(script.agentKey)
      if (assigned && assigned.sessionId !== id) throw new Error('This script already belongs to another native child session.')
      binding = { run, script, sessionId: id, rootSessionId: root.sessionId, ordinaryModel: root.ordinaryModel, turn: 0, state: 'running', controller: new AbortController(), complete: false, agent }
      this.bindings.set(id, binding); run.bindings.set(script.agentKey, binding)
      await this.ctx.layerfsSessions.prepareSimulation(id, run.manifest.projectRef, this.metadata(binding))
      await run.journal.bind(script.agentKey, id)
      this.refreshModels()
    } else await this.restoreDeferred(agent)
    binding.agent = agent
    this.authorize(agent, binding.run)
    if (terminal(binding.state)) {
      if (this.restoreOrdinary(agent, binding.ordinaryModel)) binding.ordinaryRestored = true
      if (binding.parkedHuman?.size) await this.releaseHumans(binding, false)
    }
  }
  async preStep(payload, next) {
    const binding = this.bindings.get(String(payload.agent.id))
    if (!binding || terminal(binding.state)) {
      // Backstop: a finished script route never stays selected for the next step.
      if (payload.modelSelection?.provider === 'simulation') {
        const saved = binding ?? this.ctx.layerfsSessions?.simulationOf?.(String(payload.agent.id))
        if (saved) this.restoreOrdinary(payload.agent, saved.ordinaryModel)
      }
      return next()
    }
    if (['stopping', 'handoff'].includes(binding.state)) {
      await Promise.all(payload.messages.map(message => this.parkHuman(binding, message)))
      await this.drainParking(binding)
      return { kind: 'reject' }
    }
    if (payload.modelSelection.provider !== 'simulation' || payload.modelSelection.model !== binding.script.scriptId) throw new Error('Stop the active project script before changing its model.')
    const aborted = () => { void this.stop(binding.sessionId).catch(error => this.ctx.logger('layerfs').warn('simulation stop: %s', String(error))) }
    binding.turnSignals ??= new WeakSet()
    if (!binding.turnSignals.has(payload.signal)) {
      binding.turnSignals.add(payload.signal)
      payload.signal.addEventListener('abort', aborted, { once: true })
    }
    // The turn signal remains connected after this pre-step returns, including tools and waits.
    const decision = await next()
    await this.drainParking(binding)
    if (decision.kind !== 'enter') return decision
    const held = new Set()
    for (const message of decision.messages) if (this.isHuman(binding, message)) {
      held.add(String(message.id))
      await this.parkHuman(binding, message)
    }
    return { ...decision, messages: decision.messages.filter(message => !held.has(String(message.id))) }
  }
  nativeActions(binding) {
    const session = binding.agent?.session
    if (!session?.snapshotEvents) return new Map()
    if (binding.nativeActionSession !== session) {
      binding.nativeActionSession = session
      binding.nativeActionOffset = 0
      binding.nativeActionStates = new Map()
    }
    const events = session.snapshotEvents(binding.nativeActionOffset)
    foldNativeActions(events, binding.nativeActionStates)
    if (events.length) binding.nativeActionOffset = Number(events.at(-1).seq) + 1
    return binding.nativeActionStates
  }
  compactionContext(options) {
    const binding = this.bindings.get(String(options.sessionId))
    if (!binding) return ''
    const { run, script } = binding
    const request = script.turns[binding.turn]?.request ?? script.turns.at(-1)?.request
    const records = run.journal?.records ?? []
    const versions = []
    for (const record of records) {
      if (record.type !== 'result' || record.ok !== true) continue
      const step = run.plan.steps.find(step => step.key === record.stepKey)
      if (step?.conversationId !== script.conversationId) continue
      for (const version of savedVersions(step.argv.slice(0, 2).join('.'), record.receipt)) versions.push(`${version.kind} ${version.id}`)
    }
    const children = [...run.bindings.values()].filter(item => item.script.conversationId === script.conversationId && item.script.agentId).map(item => `${item.script.name}: native session ${item.sessionId}`)
    return [
      `Project: ${run.manifest.projectRef}`,
      request ? `Current recorded work objective: ${request}` : '',
      versions.length ? `Latest confirmed saved-version references: ${[...new Set(versions)].slice(-6).join('; ')}` : 'No saved version is asserted by this checkpoint.',
      children.length ? `Native child sessions: ${children.join('; ')}` : '',
    ].filter(Boolean).join('\n')
  }
  async next(options, stream) {
    const binding = this.bindings.get(String(options.sessionId))
    if (!binding || binding.script.scriptId !== options.model || terminal(binding.state)) throw new Error('This script is no longer active. Select an ordinary model to continue.')
    // A failure already narrated in this session settles through the ordinary failure path.
    if (binding.narratedFailure) throw new Error(binding.narratedFailure)
    const signal = options.signal ? AbortSignal.any([options.signal, binding.controller.signal]) : binding.controller.signal
    signal.throwIfAborted()
    const { run, script } = binding
    if (!binding.initialDelayDone && run.dispatchDelayMs) {
      binding.initialDelayDone = true
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, run.dispatchDelayMs)
        const abort = () => { clearTimeout(timer); reject(signal.reason) }
        signal.addEventListener('abort', abort, { once: true })
      })
      signal.throwIfAborted()
    }
    const turn = script.turns[binding.turn]
    if (!turn) throw new Error('No script request is pending; ordinary follow-ups require a real model.')
    const nativeActions = this.nativeActions(binding)
    const results = new Map(options.messages.filter(message => message.role === 'tool').map(message => [String(message.toolCallId ?? message.source?.callId), message]))
    const seenChildren = new Set()
    // Prose for actions not yet issued: assignment intent and task reports are
    // said once, in the message that issues the next call (derived, not stored).
    let pending = []
    const say = async text => { if (text) await stream?.say?.(text) }
    const speak = async (...extra) => { const text = [...pending, ...extra].filter(Boolean).join(' '); pending = []; await say(text) }
    const plan = run.plan ?? {}
    const taskOf = id => plan.tasks?.find(task => task.id === id)
    const ready = keys => keys.every(key => Object.hasOwn(run.journal?.receipts ?? {}, key))
    const tasksReady = ids => ready(ids.flatMap(id => taskOf(id)?.stepKeys ?? []))
    // Waiting for dependencies is never silent: say what is awaited first.
    const waitTasks = async (ids, line) => {
      if (!tasksReady(ids)) await speak(line ?? narrateWait(ids.map(taskOf).filter(task => task && !ready(task.stepKeys)), script))
      try { await run.execution.waitTasks(ids, signal) } catch (error) {
        if (signal.aborted || !/did not complete/.test(String(error?.message ?? error))) throw error
        const blocked = ids.map(taskOf).filter(task => task && !ready(task.stepKeys))
        throw Object.assign(error, { narration: narrateBlocked(blocked, script) })
      }
    }
    // The reply carries the explanation; the run settles through fail() once idle.
    const narrateFailureAndSettle = (error, narration) => {
      const agent = binding.agent
      if (!agent || typeof agent.whenIdle !== 'function') throw error
      binding.narratedFailure = String(error?.message ?? error)
      void Promise.resolve(agent.whenIdle()).then(() => this.fail(agent, error), () => this.fail(agent, error))
      return { text: narration }
    }
    const issuable = (index, id, action) => {
      const result = results.get(id)
      const native = nativeActions.get(id)
      if (result?.isError || native?.state === 'failed') {
        const error = new Error('A project tool call failed. Inspect its native result before continuing.')
        const call = this.calls.get(id)
        const step = action.type === 'tool' ? plan.steps?.find(step => step.key === action.stepKey) : undefined
        throw Object.assign(error, { narration: action.type === 'tool' ? narrateFailure({ argv: call?.argv ?? step?.argv, output: result ? textOf(result) : '' }) : undefined })
      }
      if (native?.state === 'completed' || result) return false
      if (native?.state === 'issued') throw new Error('A dispatched project action has no confirmed native result; the script cannot replay it and stops here.')
      if (action.type === 'tool' && Object.hasOwn(run.journal?.receipts ?? {}, action.stepKey)) return false
      if (action.type === 'tool' && run.journal?.records?.some(record => record.type === 'intent' && record.stepKey === action.stepKey)) throw new Error('A project operation was already attempted without a confirmed receipt; the script cannot replay it and stops here.')
      return true
    }
    const delegation = (action, id) => {
      const child = plan.agents.find(agent => agent.conversationId === script.conversationId && agent.agentId === action.agentId)
      const childTurn = child.turns.find(item => item.taskIds.some(taskId => turn.taskIds.includes(taskId)))
      if (!childTurn) throw new Error('Missing child assignment script')
      const existing = run.bindings.get(child.agentKey)
      const title = childTurn.taskIds.map(taskOf).find(Boolean)?.title ?? child.name
      const args = existing
        ? { agent_id: existing.sessionId, message: childTurn.request }
        : { description: title, name: child.agentId, prompt: childTurn.request, provider: 'simulation', model: child.scriptId }
      this.calls.set(id, { binding, action, turn })
      const tasks = childTurn.taskIds.map(taskOf).filter(Boolean)
      return { call: { id, name: existing ? 'send_message' : 'subagent', arguments: args }, assignment: { agentId: child.agentId, phrase: tasks.length ? list(tasks.map(taskPhrase)) : 'the next assignment' } }
    }
    try {
      for (let index = 0; index < turn.actions.length; index++) {
        const action = turn.actions[index]
        const id = `sim-${script.scriptId}-${turn.id}-${index}`
        if (action.type === 'delegate') {
          if (seenChildren.has(action.agentId)) continue
          seenChildren.add(action.agentId)
        }
        if (action.type === 'assignment') { const task = taskOf(action.taskId); if (task) pending.push(narrateTask(task, plan)); continue }
        if (action.type === 'report') { const task = taskOf(action.taskId); if (task) pending.push(reportTask(task, plan, run.journal?.receipts ?? {})); continue }
        if (action.type === 'wait') { await waitTasks(action.tasks); continue }
        if (!issuable(index, id, action)) { pending = []; continue }
        if (action.type === 'tool') {
          const step = plan.steps.find(step => step.key === action.stepKey)
          if (!ready(step.dependsOn ?? [])) await speak('Waiting for an earlier step to finish.')
          await run.execution.waitSteps(step.dependsOn ?? [], signal)
          const argv = resolveSimulationStep(step, run.journal.receipts, run.directory)
          // A bound session's shell has `$DSH_LAYERFS_CLI` (the same managed, tracing
          // wrapper as agentCli()), as real models are told; else the wrapper's path.
          const cli = (this.ctx.layerfs.agentCli?.() ?? managedCli({ root: this.ctx.layerfs.root, cli: this.ctx.layerfs.cli, home: this.ctx.layerfs.home, bundle: this.ctx.layerfs.bundle, cacheHome: this.ctx.layerfs.cacheHome, callLog: this.ctx.layerfs.callLog }))
          let bound = this.ctx.layerfsSessions?.binding?.(binding.sessionId)
          if (bound?.kind === 'shared' && bound.parent) bound = this.ctx.layerfsSessions.binding(bound.parent) ?? bound
          const command = renderSimulationCommand(step, argv, bound?.state === 'bound' ? SIMULATION_CLI : cli)
          this.calls.set(id, { binding, action, turn, argv, command })
          const text = pending.filter(Boolean).join(' ')
          return { ...(text ? { text } : {}), calls: [{ id, name: 'bash', arguments: { description: describeCommand(argv), command } }] }
        }
        if (action.type === 'delegate') {
          // Independent delegations leave together in one message, as DSH asks of models.
          const group = [delegation(action, id)]
          for (let next = index + 1; turn.actions[next]?.type === 'delegate'; next++) {
            const other = turn.actions[next], otherId = `sim-${script.scriptId}-${turn.id}-${next}`
            if (seenChildren.has(other.agentId)) continue
            if (!issuable(next, otherId, other)) break
            seenChildren.add(other.agentId)
            group.push(delegation(other, otherId))
          }
          const text = [...pending, narrateDelegation(group.map(item => item.assignment))].filter(Boolean).join(' ')
          return { text, calls: group.map(item => item.call) }
        }
      }
      // The closing reply summarizes the whole request; earlier reports are superseded.
      pending = []
      await waitTasks(turn.taskIds)
      if (!script.agentId && binding.turn === script.turns.length - 1) {
        const own = (plan.tasks ?? []).filter(task => task.conversationId === script.conversationId).map(task => task.id)
        if (!tasksReady(own)) await speak(narrateWait(own.map(taskOf).filter(task => task && !ready(task.stepKeys)), script))
        await this.settleConversation(binding, signal)
        signal.throwIfAborted()
      }
      binding.complete = true
      const final = !script.agentId && binding.turn === script.turns.length - 1 ? this.target(binding) : undefined
      return { text: summarizeTurn({ script, turn, plan, receipts: run.journal?.receipts ?? {}, target: final }) }
    } catch (error) {
      if (!error?.narration || signal.aborted) throw error
      return narrateFailureAndSettle(error, error.narration)
    }
  }
  /** A root's last turn waits for its own conversation (tasks and children) only;
   * other conversations of the run keep going or stop independently. The
   * whole-project verification runs once every task of the run has a confirmed
   * receipt, i.e. only when no conversation stopped or failed before finishing. */
  async settleConversation(binding, signal) {
    const { run, script } = binding
    await run.execution.waitTasks(run.plan.tasks.filter(task => task.conversationId === script.conversationId).map(task => task.id), signal)
    await Promise.all([...run.bindings.values()].filter(item => item.script.agentId && item.script.conversationId === script.conversationId).map(item => item.agent?.whenIdle()))
    const complete = run.plan.tasks.every(task => task.stepKeys.every(key => Object.hasOwn(run.journal.receipts, key)))
    if (!complete) return
    if (!run.verification) run.verification = verifySimulation(run.manifest, run.plan, run.journal, argv => run.execution.globalBudget.run(() => execute({ cli: this.ctx.layerfs.cli, home: this.ctx.layerfs.home, bundle: this.ctx.layerfs.bundle, cacheHome: this.ctx.layerfs.cacheHome, callLog: this.ctx.layerfs.callLog }, argv, { read: true, tag: `dsh-sim:${run.manifest.runId}:verify` })))
    await run.verification
  }
  workspaceOfCall(sessionId, callId) {
    const call = this.calls.get(String(callId))
    return call?.binding.sessionId === String(sessionId) && call.argv?.[0] === 'workspace' ? call.argv[2] : undefined
  }
  stepOfCall(sessionId, callId) {
    const call = this.calls.get(String(callId))
    return call?.binding.sessionId === String(sessionId) && call.action.type === 'tool' ? { runId: call.binding.run.manifest.runId, stepKey: call.action.stepKey } : undefined
  }
  async executeTool(execution, next) {
    const binding = this.bindings.get(String(execution.agent?.id))
    if (!binding || terminal(binding.state)) return next()
    binding.controller.signal.throwIfAborted()
    const call = this.calls.get(String(execution.callId))
    if (!call || call.binding !== binding) throw new Error('Tool call is not part of this session script.')
    execution.signal = AbortSignal.any([execution.signal, binding.controller.signal])
    if (call.action.type !== 'tool') return next()
    if (execution.name !== 'bash' || execution.arguments.command !== call.command || execution.arguments.run_in_background) throw new Error('Command differs from the authorized project action.')
    let result
    await binding.run.execution.execute(call.action.stepKey, { origin: 'tool', agentKey: binding.script.agentKey, sessionId: binding.sessionId, turnId: call.turn.id, toolCallId: String(execution.callId) }, async (argv, step, signal) => {
      binding.run.execution.validateCommand(step.key, call.argv, step.input)
      let cancellation
      const cancel = () => {
        if (argv[0] !== 'workspace' || argv[1] !== 'exec' || cancellation) return
        const position = argv.indexOf('--exec-id')
        cancellation = (async () => {
          if (position < 0 || !argv[position + 1]) throw new Error('Remote execution cancellation has no confirmed execution identity.')
          const receipt = await execute({ cli: this.ctx.layerfs.cli, home: this.ctx.layerfs.home, bundle: this.ctx.layerfs.bundle, cacheHome: this.ctx.layerfs.cacheHome, callLog: this.ctx.layerfs.callLog }, ['workspace', 'exec-cancel', argv[2], argv[position + 1]], { timeout: 30000 })
          if (!['cancelled', 'ended'].includes(receipt?.outcome) || receipt.outcome === 'cancelled' && !['SIGTERM', 'SIGKILL'].includes(receipt.signal)) throw new Error(`Execution cancellation was not confirmed: ${receipt?.outcome ?? 'missing outcome'}`)
          await binding.run.journal.append({ type: 'execution.cancelled', stepKey: step.key, agentKey: binding.script.agentKey, origin: 'host', receipt })
        })().catch(async error => {
          await binding.run.journal.append({ type: 'execution.cancel-uncertain', stepKey: step.key, agentKey: binding.script.agentKey, origin: 'host', error: String(error) })
          throw error
        })
        // Awaited below even if the local shell reports cancellation first.
        void cancellation.catch(() => {})
      }
      signal.addEventListener('abort', cancel, { once: true })
      try {
        signal.throwIfAborted()
        // LayerFS fails a second process on one Store (`Busy`). Scripted calls take
        // turns on their own per-Store lane and start once the host's lane is free;
        // holding the host lane across the tool hook chain could deadlock with host
        // work that hook awaits. A remote workspace exec never touches the Store.
        const store = argv[0] === 'workspace' && argv[1] === 'exec' ? undefined : storeOfCall(argv) ?? binding.run.manifest?.store
        const home = this.ctx.layerfs?.home
        result = store && home
          ? await scriptedStoreLane(`${home}\0${store}`, async () => { await admitStore(home, store, async () => {}); return next() })
          : await next()
        return parseSimulationBashReceipt(result, { events: step.argv.includes('--events') })
      } finally {
        signal.removeEventListener('abort', cancel)
        await cancellation
      }
    }, execution.signal)
    return result
  }
  async turnStopping(agent) {
    const binding = this.bindings.get(String(agent.id))
    if (!binding || terminal(binding.state) || !binding.complete) return
    binding.complete = false
    binding.turn++
    await binding.run.journal.append({ type: 'turn-settled', agentKey: binding.script.agentKey, sessionId: binding.sessionId, turn: binding.turn })
    if (binding.script.agentId) {
      if (binding.turn >= binding.script.turns.length && binding.ordinaryModel) {
        agent.model.select(binding.ordinaryModel)
        binding.ordinaryRestored = true
        this.refreshModels()
      }
      return // Native parent assignments own child wakeup.
    }
    if (binding.turn < binding.script.turns.length) {
      // Ordinary followup opens the next native turn after this one settles.
      this.queueScript(binding, binding.script.turns[binding.turn].request, true)
      return
    }
    await this.finishRoot(binding, 'completed')
  }
  target(binding, allowFallback = false) {
    const familyKeys = new Set(binding.run.plan.agents.filter(agent => agent.conversationId === binding.script.conversationId).map(agent => agent.agentKey))
    if (binding.run.journal.records.some(record => record.type === 'intent' && familyKeys.has(record.agentKey) && !binding.run.journal.records.some(result => result.type === 'result' && result.stepKey === record.stepKey && result.ok === true))) return undefined
    const target = binding.run.plan.continuationTargets[binding.script.conversationId]
    if (allowFallback) {
      // An open workload workspace may contain unsaved changes; never hide it behind an older saved pin.
      const mounts = binding.run.plan.steps?.filter(step => step.conversationId === binding.script.conversationId && step.argv[0] === 'workspace' && step.argv[1] === 'mount' && binding.run.journal.receipts[step.key]) ?? []
      for (const mount of mounts) {
        const ws = binding.run.journal.receipts[mount.key].ws
        if (!binding.run.plan.steps.some(step => step.argv[0] === 'workspace' && step.argv[1] === 'unmount' && binding.run.journal.receipts[step.key] && resolveSimulationStep(step, binding.run.journal.receipts, binding.run.directory)[2] === ws)) return undefined
      }
    }
    const candidates = allowFallback ? (target?.fallbacks ?? [target]) : [target]
    for (const candidate of candidates) {
      const receipt = candidate?.receipt && binding.run.journal.receipts[candidate.receipt]
      const version = candidate.initial === true && candidate.receipt === 'setup.project' && typeof receipt?.layer === 'string' && /^[a-f0-9]{66}$/.test(receipt.layer)
        ? { kind: 'Layer', id: receipt.layer }
        : savedVersions('branch.publish', receipt).find(version => version.kind === 'Layer')
      if (version) return { kind: version.kind, id: version.id, branch: candidate.branch }
    }
    return undefined
  }
  async finishRoot(binding, state, error) {
    const family = [...binding.run.bindings.values()].filter(item => item.rootSessionId === binding.rootSessionId).sort((a, b) => Number(!a.script.agentId) - Number(!b.script.agentId))
    const target = this.target(binding, state !== 'completed')
    const resolvedState = !target && state !== 'interrupted' ? 'failed' : state
    for (const item of family) {
      item.state = 'handoff'
      await this.drainParking(item)
      let resumed
      try {
        const live = this.ctx.agents?.get?.(item.sessionId)
        if (item.script.agentId && this.ctx.agents && !live && ((!item.ordinaryRestored && item.ordinaryModel) || item.parkedHuman?.size)) {
          // A metadata-only writer retains the same native parent. Queued human
          // input is persisted without waking; the native continuation owner
          // activates it later, rather than this temporary writer running tools.
          const root = this.bindings.get(item.rootSessionId)
          if (!root?.agent) throw new Error('The native parent is unavailable for child handoff.')
          resumed = await this.ctx.agents.resume({ resumeSessionId: item.sessionId, parentAgent: root.agent, agentOptions: item.ordinaryModel })
          item.agent = resumed.agent
        } else if (live) item.agent = live
        // Every terminal state hands the session to its real model, with or without a pin.
        if (!item.ordinaryRestored && this.restoreOrdinary(item.agent, item.ordinaryModel, true)) item.ordinaryRestored = true
        await binding.run.journal.append({ type: 'handoff', agentKey: item.script.agentKey, sessionId: item.sessionId, state: resolvedState, target, error })
        await this.ctx.layerfsSessions.completeSimulation(item.sessionId, target, resolvedState, error ?? (!target ? `No confirmed continuation version is available. ${CONTINUE_FRESH}` : undefined))
        item.state = resolvedState
        await this.releaseHumans(item, !item.script.agentId)
      } finally { await resumed?.dispose() }
    }
    this.refreshModels()
  }
  async stop(sessionId) {
    const binding = this.bindings.get(sessionId)
    if (!binding || terminal(binding.state)) return { state: binding?.state ?? 'idle' }
    if (binding.stopping) return binding.stopping
    if (binding.state === 'stopping') return { state: 'stopping' }
    // Stopping a child ends its whole root family, exactly like stopping the root.
    const root = binding.script.agentId ? this.bindings.get(binding.rootSessionId) : undefined
    if (root && root !== binding && !terminal(root.state)) return this.stop(root.sessionId)
    // Decided before this conversation's own steps are marked stopped below.
    const blocked = !binding.script.agentId && !!binding.failure && !!binding.run.execution.blockedByStop?.(binding.script.conversationId)
    binding.stopping = (async () => {
      const family = binding.script.agentId ? [binding] : [...binding.run.bindings.values()].filter(item => item.rootSessionId === sessionId)
      // Close every descendant gate synchronously before journal I/O can yield.
      for (const item of family) { item.state = 'stopping'; item.controller.abort(new Error('Project work stopped')) }
      for (const item of family) {
        // Preserve human followups; script requests can be identified by exact immutable content.
        for (const queued of [...item.agent.inbox.nextTurn, ...item.agent.inbox.nextStep]) if (item.scriptRequests?.has(String(queued.id))) item.agent.inbox.remove(queued.id)
        await Promise.all([...item.agent.inbox.nextTurn, ...item.agent.inbox.nextStep].map(message => this.parkHuman(item, message)))
        item.agent.cancel({ kind: 'user' }, { keepInbox: true })
      }
      await binding.run.execution.stop(binding.script.agentKey)
      // Final graph reads must settle before an LLM can create an isolated branch.
      if (binding.run.verification) await Promise.allSettled([binding.run.verification])
      await Promise.all(family.map(item => item.agent.whenIdle()))
      await Promise.all(family.map(item => this.drainParking(item)))
      if (binding.script.agentId) {
        binding.state = 'stopped'
        await binding.run.journal.append({ type: 'driver-stopped', agentKey: binding.script.agentKey, sessionId })
        // Child continuation waits for its root's shared saved context.
        await this.ctx.layerfsSessions.completeSimulation(sessionId, undefined, 'stopped', `The child stopped. ${CONTINUE_FRESH}`)
        await this.releaseHumans(binding, false)
        this.refreshModels()
      } else {
        // Work that waited on another conversation's stopped steps ends as stopped, not failed.
        await this.finishRoot(binding, binding.failure && !blocked ? 'failed' : 'stopped', blocked ? `Another conversation of this run was stopped before this conversation's prerequisites completed. ${CONTINUE_FRESH}` : binding.failure)
      }
      return { state: binding.state }
    })().catch(error => this.settlementFailed(binding, error))
    return binding.stopping
  }
  async settlementFailed(binding, error) {
    const message = `Project handoff failed: ${String(error?.message ?? error)}. ${CONTINUE_FRESH}`
    const family = binding.script.agentId ? [binding] : [...binding.run.bindings.values()].filter(item => item.rootSessionId === binding.rootSessionId)
    for (const item of family) {
      item.state = 'failed'
      item.controller.abort(new Error(message))
      item.agent?.cancel({ kind: 'user' }, { keepInbox: true })
    }
    const warn = failure => this.ctx.logger?.('layerfs').warn('simulation failed handoff: %s', String(failure))
    await binding.run.execution.stop(binding.script.agentKey).catch(warn)
    await Promise.allSettled(family.map(item => item.agent?.whenIdle()))
    for (const item of family) {
      await binding.run.journal.append({ type: 'driver-handoff-failed', agentKey: item.script.agentKey, sessionId: item.sessionId, state: 'failed', error: message }).catch(warn)
      await this.ctx.layerfsSessions.completeSimulation(item.sessionId, undefined, 'failed', message).catch(warn)
      // Dormant children keep durable native-message references until their
      // actual continuation owner reopens them; never send through a stale Agent.
      const live = this.ctx.agents?.get?.(item.sessionId)
      if (!this.ctx.agents || live === item.agent) {
        let restored = !!item.ordinaryRestored
        if (!restored) try { restored = item.ordinaryRestored = this.restoreOrdinary(item.agent, item.ordinaryModel, true) } catch (failure) { warn(failure) }
        await this.releaseHumans(item, restored && !item.script.agentId).catch(warn)
      }
    }
    this.refreshModels()
    return { state: 'failed', error: message }
  }
  turnEnded(session) {
    const binding = this.bindings.get(String(session.id))
    if (binding?.script.agentId && binding.state === 'stopping' && !binding.ordinaryRestored && binding.ordinaryModel) {
      binding.agent.model.select(binding.ordinaryModel)
      binding.ordinaryRestored = true
    }
  }
  queueScript(binding, text, prepend = false) {
    const message = request(text)
    binding.scriptRequests ??= new Set()
    binding.scriptRequests.add(String(message.id))
    if (prepend) binding.agent.inbox.prepend('next-turn', message)
    else binding.agent.followup(message)
  }
  isHuman(binding, message) {
    if (message.source?.kind !== 'user') return false
    if (binding.scriptRequests?.has(String(message.id))) return false
    // Native children are addressed through their parent; their fresh activation
    // prompt is minted by the subagent runtime, not by this host driver.
    if (binding.script.agentId && !binding.initialPromptId && message.content?.[0]?.type === 'text' && message.content[0].text === binding.script.turns[0]?.request) {
      binding.initialPromptId = String(message.id)
      binding.scriptRequests ??= new Set()
      binding.scriptRequests.add(String(message.id))
      return false
    }
    return true
  }
  parkHuman(binding, message) {
    if (!this.isHuman(binding, message)) return Promise.resolve()
    binding.parkedHuman ??= new Map()
    binding.parking ??= new Map()
    const id = String(message.id)
    if (binding.parkedHuman.has(id)) return Promise.resolve()
    if (binding.parking.has(id)) return binding.parking.get(id)
    const pending = (async () => {
      // The native insertion remains authoritative. Flush its recovery reference
      // before removing it; preStep filters a message if claiming raced this flush.
      await binding.run.journal.append({ type: 'human-deferred', agentKey: binding.script.agentKey, sessionId: binding.sessionId, messageId: id })
      binding.parkedHuman.set(id, message)
      binding.agent.inbox.remove(message.id)
    })().finally(() => binding.parking.delete(id))
    binding.parking.set(id, pending)
    return pending
  }
  async drainParking(binding) {
    while (binding.parking?.size) await Promise.all([...binding.parking.values()])
  }
  inserted(agent, message) {
    const binding = this.bindings.get(String(agent.id))
    if (binding && !terminal(binding.state)) void this.parkHuman(binding, message).catch(error => this.fail(agent, error))
  }
  async releaseHumans(binding, wake) {
    await this.drainParking(binding)
    for (const [id, message] of binding.parkedHuman ?? []) {
      const pending = [...(binding.agent.inbox.nextTurn ?? []), ...(binding.agent.inbox.nextStep ?? [])]
      if (!pending.some(queued => String(queued.id) === id)) binding.agent.send(message, 'next-turn', wake)
      await binding.run.journal.append({ type: 'human-released', sessionId: binding.sessionId, messageId: id })
      binding.parkedHuman.delete(id)
    }
  }
  async restoreDeferred(agent) {
    const pending = this.recoveredDeferred.get(String(agent.id))
    if (!pending) return
    for (const event of agent.session.snapshotEvents(0)) {
      if (event.type !== 'agent/inbox/spliced') continue
      for (const message of event.data.inserted ?? []) if (pending.ids.has(String(message.id))) {
        if (![...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(queued => queued.id === message.id)) agent.send(message, 'next-turn', false)
        await pending.journal.append({ type: 'human-released', sessionId: String(agent.id), messageId: String(message.id) })
        pending.ids.delete(String(message.id))
      }
    }
    this.recoveredDeferred.delete(String(agent.id))
  }
  fail(agent, error) {
    const binding = this.bindings.get(String(agent.id))
    if (!binding || terminal(binding.state) || binding.state === 'stopping') return
    const root = this.bindings.get(binding.rootSessionId) ?? binding
    root.failure = String(error?.message ?? error)
    void this.stop(root.sessionId).catch(failure => this.ctx.logger('layerfs').warn('simulation settlement: %s', String(failure)))
  }
  async inspect(sessionId) {
    const binding = this.bindings.get(sessionId)
    const meta = binding ? this.metadata(binding) : this.ctx.layerfsSessions.simulationOf(sessionId)
    if (!meta) return { script: null, state: 'idle', locked: false }
    const state = binding?.state ?? meta.state
    if (!binding) {
      if (typeof meta.runId !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,62}$/.test(meta.runId) || typeof meta.hash !== 'string' || !/^[a-f0-9]{64}$/.test(meta.hash)) throw new Error('The saved script identity is invalid.')
      const directory = join(this.ctx.layerfs.root, 'simulations', meta.runId)
      let source = null
      try {
        const manifest = await validateSimulationPackage(directory)
        const plan = JSON.parse(await readFile(join(directory, 'plan.json'), 'utf8'))
        const script = plan.agents.find(script => script.agentKey === meta.agentKey && script.scriptId === meta.scriptId && script.hash === meta.hash)
        if (!script || !Object.hasOwn(manifest.hashes, script.path) || manifest.hashes[script.path] !== meta.hash) throw new Error('The saved script identity does not match this session.')
        source = await readFile(join(directory, script.path), 'utf8')
      } catch (error) { if (error?.code !== 'ENOENT') throw error }
      // Without a live binding no script can run: the session is never locked.
      return { script: { ...meta, source }, state: terminal(state) ? state : 'interrupted', locked: false }
    }
    await validateSimulationPackage(binding.run.directory)
    return { script: { ...meta, source: await readFile(join(binding.run.directory, binding.script.path), 'utf8') }, state, locked: !terminal(state) }
  }
  /** What an active script session's shell commands may write: its run's project,
   * machine and planned sandboxes, for the sandbox policy. */
  executionScope(sessionId) {
    const binding = this.bindings.get(String(sessionId))
    if (!binding || terminal(binding.state)) return undefined
    const { manifest, plan } = binding.run
    const sandboxes = [...new Set((plan.steps ?? []).filter(step => step.resource?.family === 'sandbox').map(step => step.resource.name))]
    return { project: manifest.projectRef, machine: manifest.machine, sandboxes, rootSessionId: binding.rootSessionId }
  }
}

/** One scripted CLI process per Store at a time, across all script sessions. */
const scriptedLanes = new Map()
function scriptedStoreLane(key, run) {
  const previous = scriptedLanes.get(key) ?? Promise.resolve()
  const current = previous.catch(() => {}).then(run)
  const tail = current.catch(() => {})
  scriptedLanes.set(key, tail)
  void tail.then(() => { if (scriptedLanes.get(key) === tail) scriptedLanes.delete(key) })
  return current
}
