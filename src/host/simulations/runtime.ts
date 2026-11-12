// @ts-nocheck
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { compileSimulation, renderSimulationCommand, resolveSimulationStep } from './compiler.ts'
import { claimSimulationExecution, SimulationJournal, validateSimulationPackage, writeSimulationPackage } from './package.ts'
import { verifySimulation } from './verify.ts'
import { SimulationExecution } from './gate.ts'
import { admitStore, execute, storeOfCall } from '../layerfs/cli.ts'
import { managedCli, savedVersions } from '../layerfs/tracing.ts'
import { describeCommand, list, narrateBlocked, narrateDelegation, narrateFailure, narrateTask, narrateWait, reportTask, summarizeTurn, taskPhrase } from './narration.ts'

const textOf = message => (message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('')
const request = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const terminal = state => ['completed', 'stopped', 'interrupted', 'uncertain', 'failed'].includes(state)

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
  scripts() { return [...this.runs.values()].flatMap(run => run.plan.agents) }
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
          const meta = this.ctx.layerfsSessions.simulationOf(row.sessionId)
          if (meta && !terminal(meta.state)) await this.ctx.layerfsSessions.completeSimulation(row.sessionId, undefined, 'interrupted', 'The host restarted during script execution. Reconcile attempted operations before continuing.')
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
    const directory = await writeSimulationPackage(this.ctx.layerfs.root, compiled)
    await claimSimulationExecution(directory, 'host')
    const journal = await SimulationJournal.open(directory)
    const run = { ...compiled, directory, journal, execution: new SimulationExecution(compiled.plan, journal, { directory }), bindings: new Map(), dispatchDelayMs: options.dispatchDelayMs ?? 0 }
    this.runs.set(compiled.manifest.runId, run)
    this.ctx.emit('llm/models-updated', 'simulation')
    const cli = this.ctx.layerfs.cli
    if (!cli) throw new Error('Pin a LayerFS CLI before starting project work.')
    try {
      await this.ctx.layerfs.ensureNative()
      for (const step of run.plan.steps.filter(step => step.phase === 'setup')) {
        await run.execution.execute(step.key, { origin: 'host', runId: run.manifest.runId }, (argv, definition, executionSignal) => execute({ cli, home: this.ctx.layerfs.home, bundle: this.ctx.layerfs.bundle, cacheHome: this.ctx.layerfs.cacheHome, callLog: this.ctx.layerfs.callLog }, argv, { input: definition.input, beforeSpawn: () => executionSignal.throwIfAborted(), onSpawn: child => {
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
        const fallback = options.ordinaryModel ?? this.ctx.agentDefaultModel?.currentSelection?.() ?? undefined
        const binding = { run, script, sessionId: id, rootSessionId: id, ordinaryModel: fallback, turn: 0, state: 'running', controller: new AbortController(), complete: false }
        this.bindings.set(id, binding); run.bindings.set(script.agentKey, binding)
        await this.ctx.layerfsSessions.prepareSimulation(id, run.manifest.projectRef, this.metadata(binding))
        await run.journal.bind(script.agentKey, id)
        await this.ctx.sessionController.create({ sessionId: id, cwd, agentPreset: 'layerfs' })
        const agent = this.ctx.agents.get(id)
        binding.agent = agent
        binding.ordinaryModel ??= agent.model.current()
        if (!binding.ordinaryModel || binding.ordinaryModel.provider === 'simulation') throw new Error('Select an ordinary model before starting a script.')
        await this.ctx.layerfsSessions.prepareSimulation(id, run.manifest.projectRef, this.metadata(binding))
        agent.model.select({ provider: 'simulation', model: script.scriptId })
        this.authorize(agent, run)
        sessions.push(id)
      }
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
        if (binding.agent && binding.ordinaryModel) binding.agent.model.select(binding.ordinaryModel)
        await this.ctx.layerfsSessions.completeSimulation(binding.sessionId, undefined, 'failed', String(error?.message ?? error))
      }
      throw error
    }
  }
  authorize(agent, run) {
    if (agent.session.snapshotEvents(0).some(event => event.type === 'subagent/model-selection-policy')) return
    agent.session.append('subagent/model-selection-policy', { allowedModels: [...run.plan.agents.map(script => ({ provider: 'simulation', model: script.scriptId })), ...[...run.bindings.values()].map(binding => binding.ordinaryModel).filter(route => route && route.provider !== 'simulation').map(route => ({ provider: route.provider, model: route.model }))].filter((route, index, all) => all.findIndex(other => other.provider === route.provider && other.model === route.model) === index) })
  }
  async created(agent) {
    const id = String(agent.id)
    await this.restoreDeferred(agent)
    let binding = this.bindings.get(id)
    if (!binding) {
      const route = agent.model.current()
      if (route?.provider !== 'simulation') return
      const run = [...this.runs.values()].find(run => run.plan.agents.some(script => script.scriptId === route.model))
      const script = run?.plan.agents.find(script => script.scriptId === route.model)
      if (!run && this.ctx.layerfsSessions.simulationOf(id)) return
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
    }
    binding.agent = agent
    this.authorize(agent, binding.run)
    if (terminal(binding.state) && binding.parkedHuman?.size) await this.releaseHumans(binding, false)
  }
  async preStep(payload, next) {
    const binding = this.bindings.get(String(payload.agent.id))
    if (!binding || terminal(binding.state)) return next()
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
      if (native?.state === 'issued') throw new Error('A dispatched project action has no confirmed native result. Reconcile it before continuing; it cannot be replayed.')
      if (action.type === 'tool' && Object.hasOwn(run.journal?.receipts ?? {}, action.stepKey)) return false
      if (action.type === 'tool' && run.journal?.records?.some(record => record.type === 'intent' && record.stepKey === action.stepKey)) throw new Error('A project operation was already attempted without a confirmed receipt. Reconcile it before continuing; it cannot be replayed.')
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
          // The managed, tracing CLI by path: script-owned sessions are not bound
          // for the shell env, so `$DSH_LAYERFS_CLI` is unset in their shells.
          const cli = (this.ctx.layerfs.agentCli?.() ?? managedCli({ root: this.ctx.layerfs.root, cli: this.ctx.layerfs.cli, home: this.ctx.layerfs.home, bundle: this.ctx.layerfs.bundle, cacheHome: this.ctx.layerfs.cacheHome, callLog: this.ctx.layerfs.callLog }))
          const command = renderSimulationCommand(step, argv, cli)
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
        const all = (plan.tasks ?? []).map(task => task.id)
        await waitTasks(all, tasksReady(all) ? undefined : 'Waiting for the remaining project work in the other conversations before the final check.')
        await Promise.all([...run.bindings.values()].filter(item => item.script.agentId).map(item => item.agent.whenIdle()))
        if (!run.verification) run.verification = verifySimulation(run.manifest, run.plan, run.journal, argv => run.execution.globalBudget.run(() => execute({ cli: this.ctx.layerfs.cli, home: this.ctx.layerfs.home, bundle: this.ctx.layerfs.bundle, cacheHome: this.ctx.layerfs.cacheHome, callLog: this.ctx.layerfs.callLog }, argv, { read: true })))
        await run.verification
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
  workspaceOfCall(sessionId, callId) {
    const call = this.calls.get(String(callId))
    return call?.binding.sessionId === String(sessionId) && call.argv?.[0] === 'workspace' ? call.argv[2] : undefined
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
        // LayerFS fails a second process on one Store (`Busy`): scripted calls share
        // the host's per-Store lane; a remote workspace exec never touches the Store.
        const store = argv[0] === 'workspace' && argv[1] === 'exec' ? undefined : storeOfCall(argv) ?? binding.run.manifest?.store
        result = store && this.ctx.layerfs?.home ? await admitStore(this.ctx.layerfs.home, store, () => next()) : await next()
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
        if (item.script.agentId && this.ctx.agents && !live && ((!item.ordinaryRestored && target && item.ordinaryModel) || item.parkedHuman?.size)) {
          // A metadata-only writer retains the same native parent. Queued human
          // input is persisted without waking; the native continuation owner
          // activates it later, rather than this temporary writer running tools.
          const root = this.bindings.get(item.rootSessionId)
          if (!root?.agent) throw new Error('The native parent is unavailable for child handoff.')
          resumed = await this.ctx.agents.resume({ resumeSessionId: item.sessionId, parentAgent: root.agent, agentOptions: item.ordinaryModel })
          item.agent = resumed.agent
        } else if (live) item.agent = live
        if (target && item.ordinaryModel && !item.ordinaryRestored) {
          item.agent.model.select(item.ordinaryModel)
          item.ordinaryRestored = true
        }
        await binding.run.journal.append({ type: 'handoff', agentKey: item.script.agentKey, sessionId: item.sessionId, state: resolvedState, target, error })
        await this.ctx.layerfsSessions.completeSimulation(item.sessionId, target, resolvedState, error ?? (!target ? 'No confirmed continuation version is available. Reconcile project state before continuing.' : undefined))
        item.state = resolvedState
        await this.releaseHumans(item, !!target && !item.script.agentId)
      } finally { await resumed?.dispose() }
    }
  }
  async stop(sessionId) {
    const binding = this.bindings.get(sessionId)
    if (!binding || terminal(binding.state)) return { state: binding?.state ?? 'idle' }
    if (binding.stopping) return binding.stopping
    if (binding.state === 'stopping') return { state: 'stopping' }
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
        await this.ctx.layerfsSessions.completeSimulation(sessionId, undefined, 'stopped', 'The child stopped. Its parent must settle the shared continuation context.')
      } else await this.finishRoot(binding, binding.failure ? 'failed' : 'stopped', binding.failure)
      return { state: binding.state }
    })().catch(error => this.settlementFailed(binding, error))
    return binding.stopping
  }
  async settlementFailed(binding, error) {
    const message = `Project handoff failed: ${String(error?.message ?? error)}. Reconcile the saved file context before continuing.`
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
      if (!this.ctx.agents || live === item.agent) await this.releaseHumans(item, false).catch(warn)
    }
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
      return { script: { ...meta, source }, state, locked: !terminal(state) }
    }
    await validateSimulationPackage(binding.run.directory)
    return { script: { ...meta, source: await readFile(join(binding.run.directory, binding.script.path), 'utf8') }, state, locked: !terminal(state) }
  }
  /** What an active script session's shell commands may write: its run's project,
   * machine and planned sandboxes. Script sessions are never bound for ordinary
   * execution, so the sandbox policy asks here instead. */
  executionScope(sessionId) {
    const binding = this.bindings.get(String(sessionId))
    if (!binding || terminal(binding.state)) return undefined
    const { manifest, plan } = binding.run
    const sandboxes = [...new Set((plan.steps ?? []).filter(step => step.resource?.family === 'sandbox').map(step => step.resource.name))]
    return { project: manifest.projectRef, machine: manifest.machine, sandboxes, rootSessionId: binding.rootSessionId }
  }
}
