// @ts-nocheck
/** FIFO per-sandbox reader/writer admission. Lifecycle mutations exclude fresh
 * workspace clients until detach and record cleanup have both returned. */
export class WorkspaceLifecycleGate {
  constructor() { this.lanes = new Map() }
  acquire(key, exclusive, signal) {
    signal?.throwIfAborted()
    let lane = this.lanes.get(key)
    if (!lane) this.lanes.set(key, lane = { readers: 0, writer: false, queue: [] })
    return new Promise((resolve, reject) => {
      const entry = { exclusive, signal, resolve, reject }
      entry.abort = () => {
        lane.queue = lane.queue.filter(waiter => waiter !== entry)
        signal.removeEventListener('abort', entry.abort)
        reject(signal.reason ?? new Error('Workspace admission stopped.'))
        this.drain(key, lane)
      }
      signal?.addEventListener('abort', entry.abort, { once: true })
      lane.queue.push(entry)
      this.drain(key, lane)
    })
  }
  drain(key, lane) {
    while (!lane.writer && lane.queue.length) {
      const entry = lane.queue[0]
      if (entry.exclusive && lane.readers) break
      lane.queue.shift(); entry.signal?.removeEventListener('abort', entry.abort)
      if (entry.exclusive) lane.writer = true
      else lane.readers++
      let released = false
      entry.resolve(() => {
        if (released) return
        released = true
        if (entry.exclusive) lane.writer = false
        else lane.readers--
        this.drain(key, lane)
      })
      if (entry.exclusive) break
    }
    if (!lane.writer && !lane.readers && !lane.queue.length && this.lanes.get(key) === lane) this.lanes.delete(key)
  }
  async run(key, exclusive, signal, execute) {
    const release = await this.acquire(key, exclusive, signal)
    try { signal?.throwIfAborted(); return await execute() } finally { release() }
  }
}

import { resolveSimulationStep } from './compiler.ts'
import { assertProjectStep } from '../presets/recipe/recipe.js'
/** Shared FIFO command budget. Dependency/lifecycle waiters never consume it. */
export class SimulationCommandBudget {
  constructor(limit = 12) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid shared simulation command budget')
    this.limit = limit; this.active = 0; this.queue = []
  }
  acquire(signal) {
    signal?.throwIfAborted()
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal }
      entry.abort = () => {
        this.queue = this.queue.filter(item => item !== entry)
        reject(signal.reason ?? new Error('Simulation stopped'))
      }
      signal?.addEventListener('abort', entry.abort, { once: true })
      this.queue.push(entry); this.drain()
    })
  }
  drain() {
    while (this.active < this.limit && this.queue.length) {
      const entry = this.queue.shift()
      entry.signal?.removeEventListener('abort', entry.abort)
      this.active++
      let released = false
      entry.resolve(() => { if (!released) { released = true; this.active--; this.drain() } })
    }
  }
  async run(execute, signal) {
    const release = await this.acquire(signal)
    try { signal?.throwIfAborted(); return await execute() } finally { release() }
  }
}
const hostCommandBudget = new SimulationCommandBudget()

/** Execution admission only; the executor is supplied by the ordinary DSH tool runtime. */
export class SimulationExecution {
  constructor(plan, journal, { directory = journal.directory, concurrency = 12, globalBudget = hostCommandBudget } = {}) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Invalid simulation concurrency')
    this.plan = plan; this.journal = journal; this.directory = directory
    this.steps = new Map(plan.steps.map(step => [step.key, step]))
    if (this.steps.size !== plan.steps.length) throw new Error('Duplicate simulation step')
    const done = new Set(), active = new Set()
    const visit = key => {
      if (active.has(key)) throw new Error('Cyclic simulation dependencies')
      if (done.has(key)) return
      const step = this.steps.get(key)
      if (!step) throw new Error(`Missing simulation dependency: ${key}`)
      active.add(key); for (const dep of step.dependsOn ?? []) visit(dep); active.delete(key); done.add(key)
    }
    for (const key of this.steps.keys()) visit(key)
    this.globalBudget = globalBudget
    this.limit = concurrency; this.running = new Map(); this.controllers = new Map(); this.waiters = new Set()
    this.lifecycle = new WorkspaceLifecycleGate(); this.capacity = new WorkspaceLifecycleGate(); this.agents = new WorkspaceLifecycleGate()
    this.used = new Set(journal.records.filter(record => record.type === 'intent').map(record => record.stepKey))
    this.stopped = new Set()
    this.failed = new Set(journal.records.filter(record => record.type === 'intent' && !Object.hasOwn(journal.receipts, record.stepKey)).map(record => record.stepKey))
  }
  controller(agentKey) {
    if (!this.controllers.has(agentKey)) this.controllers.set(agentKey, new AbortController())
    return this.controllers.get(agentKey)
  }
  notify() { for (const callback of [...this.waiters]) callback() }
  async waitSteps(keys, signal) {
    signal?.throwIfAborted()
    const check = () => {
      for (const key of keys) {
        if (!this.steps.has(key)) throw new Error(`Unknown simulation dependency: ${key}`)
        if (this.failed.has(key)) throw new Error(`Dependency ${key} did not complete; execution cannot continue`)
      }
      return keys.every(key => Object.hasOwn(this.journal.receipts, key))
    }
    if (check()) return
    await new Promise((resolve, reject) => {
      const clean = () => { this.waiters.delete(tick); signal?.removeEventListener('abort', abort) }
      const tick = () => { try { if (check()) { clean(); resolve() } } catch (error) { clean(); reject(error) } }
      const abort = () => { clean(); reject(signal.reason ?? new Error('Simulation stopped')) }
      this.waiters.add(tick); signal?.addEventListener('abort', abort, { once: true }); tick()
    })
  }
  waitTasks(taskIds, signal) {
    return this.waitSteps(taskIds.flatMap(id => {
      const task = this.plan.tasks.find(task => task.id === id)
      if (!task) throw new Error(`Unknown simulation task: ${id}`)
      return task.stepKeys
    }), signal)
  }
  validateCommand(stepKey, argv, input) {
    const step = this.steps.get(stepKey)
    if (!step) throw new Error(`Unknown simulation step: ${stepKey}`)
    const expected = resolveSimulationStep(step, this.journal.receipts, this.directory)
    if (JSON.stringify(expected) !== JSON.stringify(argv) || input !== step.input) throw new Error(`Command does not match authorized step: ${stepKey}`)
    return step
  }
  async execute(stepKey, context, executor, externalSignal) {
    const step = this.steps.get(stepKey)
    if (!step) throw new Error(`Unknown simulation step: ${stepKey}`)
    const expectedAgent = step.conversationId ? `${step.conversationId}-${step.agentId ?? 'main'}` : 'host'
    if (context.agentKey && context.agentKey !== expectedAgent) throw new Error('Step belongs to another agent')
    if (step.phase === 'conversation') {
      const binding = this.journal.records.find(record => record.type === 'binding' && record.agentKey === expectedAgent)
      if (!binding || binding.sessionId !== context.sessionId || !context.turnId || !context.toolCallId) throw new Error('Missing native tool invocation identity')
    }
    const ownSignal = this.controller(expectedAgent).signal
    const signal = externalSignal ? AbortSignal.any([externalSignal, ownSignal]) : ownSignal
    signal.throwIfAborted()
    if (this.used.has(stepKey) || this.running.has(stepKey)) throw new Error(`Step ${stepKey} was already attempted; replay is forbidden`)
    const work = (async () => {
      await this.waitSteps(step.dependsOn ?? [], signal)
      const argv = resolveSimulationStep(step, this.journal.receipts, this.directory)
      // Capacity lanes each admit one writer; choose a free lane after dependencies settle.
      const admitted = async () => {
        signal.throwIfAborted()
        if (this.used.has(stepKey)) throw new Error('Simulation step was already attempted')
        this.used.add(stepKey)
        await this.journal.append({ type: 'intent', stepKey, agentKey: expectedAgent, argv, input: step.input, ...context })
        try {
          signal.throwIfAborted()
          const receipt = await executor(argv, step, signal)
          if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw new Error('Missing structured operation receipt')
          if (step.key === 'setup.machine' && (receipt.supports?.sqlite === false || !['ready', 'running'].includes(receipt.state))) {
            throw Object.assign(new Error(`Machine ${step.argv[2]} is not ready for a SQLite simulation. Start a supported machine and launch a new simulation.`), { code: 'Unavailable' })
          }
          assertProjectStep(step, receipt)
          await this.journal.append({ type: 'result', stepKey, agentKey: expectedAgent, ok: true, receipt })
          this.notify()
          return receipt
        } catch (error) {
          this.failed.add(stepKey)
          await this.journal.append({ type: 'result', stepKey, agentKey: expectedAgent, ok: false, error: String(error.message ?? error), uncertain: true })
          this.notify(); throw error
        }
      }
      const capacity = () => this.capacity.run('commands', false, signal, async () => {
        // FIFO semaphore, separate from workspace reader/writer admission.
        while ([...this.running.values()].filter(value => value.admitted).length >= this.limit || (step.conversationId && [...this.running.values()].filter(value => value.admitted && value.conversationId === step.conversationId).length >= (this.plan.limits?.perConversation ?? 3))) await new Promise((resolve, reject) => {
          const callback = () => { this.waiters.delete(callback); signal.removeEventListener('abort', abort); resolve() }
          const abort = () => { this.waiters.delete(callback); reject(signal.reason) }
          this.waiters.add(callback); signal.addEventListener('abort', abort, { once: true })
        })
        signal.throwIfAborted()
        const entry = this.running.get(stepKey); if (entry) entry.admitted = true
        try { return await this.globalBudget.run(admitted, signal) } finally { if (entry) entry.admitted = false; this.notify() }
      })
      return this.agents.run(expectedAgent, true, signal, () =>
        argv[0] === 'workspace' && !['exec-cancel', 'exec-kill'].includes(argv[1])
          ? this.lifecycle.run(argv[2].split(':')[0], ['mount', 'unmount'].includes(argv[1]), signal, capacity)
          : capacity())
    })()
    this.running.set(stepKey, { promise: work, agentKey: expectedAgent, conversationId: step.conversationId, admitted: false })
    try { return await work } finally { this.running.delete(stepKey); this.notify() }
  }
  stop(agentKey) {
    const agent = this.plan.agents?.find(agent => agent.agentKey === agentKey)
    const keys = agent && !agent.agentId ? this.plan.agents.filter(item => item.conversationId === agent.conversationId).map(item => item.agentKey) : [agentKey]
    for (const key of keys) this.controller(key).abort(new Error('Simulation stopped'))
    for (const step of this.steps.values()) {
      const owner = step.conversationId ? `${step.conversationId}-${step.agentId ?? 'main'}` : 'host'
      if (keys.includes(owner) && !Object.hasOwn(this.journal.receipts, step.key)) { this.failed.add(step.key); this.stopped.add(step.key) }
    }
    this.notify()
    return this.pending(keys)
  }
  /** Whether a conversation can no longer finish only because steps of a stopped
   * conversation it depends on will never complete (and none of its own failed). */
  blockedByStop(conversationId) {
    if (!this.stopped.size) return false
    const own = [...this.steps.values()].filter(step => step.conversationId === conversationId)
    if (own.some(step => this.failed.has(step.key) && !this.stopped.has(step.key))) return false
    const seen = new Set()
    const reaches = key => {
      if (this.stopped.has(key)) return true
      if (seen.has(key)) return false
      seen.add(key)
      return (this.steps.get(key)?.dependsOn ?? []).some(reaches)
    }
    return own.some(step => !Object.hasOwn(this.journal.receipts, step.key) && !this.stopped.has(step.key) && (step.dependsOn ?? []).some(reaches))
  }
  async pending(agentKeys) {
    await Promise.allSettled([...this.running.values()].filter(entry => !agentKeys || agentKeys.includes(entry.agentKey)).map(entry => entry.promise))
  }
}
