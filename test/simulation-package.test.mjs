import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, appendFile, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileSimulation, SIMULATION_PROFILES } from '../src/host/simulations/compiler.ts'
import { writeSimulationPackage, validateSimulationPackage, claimSimulationExecution, SimulationJournal } from '../src/host/simulations/package.ts'
import { SimulationExecution, WorkspaceLifecycleGate } from '../src/host/simulations/gate.ts'
const project = Object.keys(SIMULATION_PROFILES)[0]
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-simulation-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const run = compileSimulation({ project, runId: 'test-run', cycles: 1 })
  const directory = await writeSimulationPackage(root, run)
  return { root, run, directory }
}
test('package hashes are checked and exactly one concurrent owner can claim execution', async t => {
  const { directory, run } = await fixture(t)
  await validateSimulationPackage(directory)
  const claims = await Promise.allSettled([claimSimulationExecution(directory), claimSimulationExecution(directory)])
  assert.equal(claims.filter(value => value.status === 'fulfilled').length, 1)
  await assert.rejects(claimSimulationExecution(directory), /already owned|already claimed/)
  await appendFile(join(directory, run.plan.agents[0].path), ' ')
  await assert.rejects(validateSimulationPackage(directory), /hash changed/)
})
test('journal serializes records, recovers a torn tail and rejects earlier corruption', async t => {
  const { directory } = await fixture(t)
  let journal = await SimulationJournal.open(directory)
  await Promise.all(Array.from({ length: 20 }, (_, n) => journal.append({ type: 'evidence', n })))
  assert.deepEqual(journal.records.map(record => record.seq), Array.from({ length: 20 }, (_, n) => n + 1))
  await appendFile(join(directory, 'journal.jsonl'), '{"torn":')
  journal = await SimulationJournal.open(directory)
  assert.equal(journal.records.length, 20)
  await journal.append({ type: 'recovered' })
  assert.equal((await SimulationJournal.open(directory)).records.length, 21)
  await writeFile(join(directory, 'journal.jsonl'), '{bad}\n{"type":"valid","seq":2}\n')
  await assert.rejects(SimulationJournal.open(directory), /Corrupt simulation journal/)
})
test('durable intent precedes mutation, uncertain attempts cannot replay after restart', async t => {
  const { directory } = await fixture(t)
  const plan = { steps: [{ key: 'a', phase: 'setup', argv: ['machine', 'get', 'native'], dependsOn: [] }], tasks: [], agents: [] }
  let journal = await SimulationJournal.open(directory)
  let engine = new SimulationExecution(plan, journal)
  await assert.rejects(engine.execute('a', { origin: 'host' }, async () => {
    assert.equal((await readFile(join(directory, 'journal.jsonl'), 'utf8')).includes('"type":"intent"'), true)
    throw new Error('connection lost after mutation')
  }), /connection lost/)
  journal = await SimulationJournal.open(directory)
  engine = new SimulationExecution(plan, journal)
  let spawned = false
  await assert.rejects(engine.execute('a', {}, async () => { spawned = true; return {} }), /already attempted/)
  assert.equal(spawned, false)
})
test('Stop releases dependency waits without dispatching mutation; independent agent remains usable', async t => {
  const { directory } = await fixture(t)
  const plan = { steps: [
    { key: 'a', phase: 'setup', argv: ['machine', 'get', 'native'], dependsOn: [] },
    { key: 'b', phase: 'setup', argv: ['machine', 'get', 'native'], dependsOn: ['a'] },
  ], tasks: [], agents: [] }
  const engine = new SimulationExecution(plan, await SimulationJournal.open(directory))
  let spawned = false
  const pending = engine.execute('b', {}, async () => { spawned = true; return {} })
  await engine.stop('host')
  await assert.rejects(pending, /Simulation stopped/)
  assert.equal(spawned, false)
})
test('workspace lifecycle gate holds fresh clients behind queued exclusive mutations', async () => {
  const gate = new WorkspaceLifecycleGate(), order = []
  const release = await gate.acquire('box', false)
  const writer = gate.acquire('box', true).then(done => { order.push('writer'); return done })
  const reader = gate.acquire('box', false).then(done => { order.push('reader'); return done })
  release(); const endWriter = await writer
  assert.deepEqual(order, ['writer'])
  endWriter(); (await reader)()
  assert.deepEqual(order, ['writer', 'reader'])
})

test('a workspace lifecycle waiter consumes no shared command slot', async t => {
  const { directory } = await fixture(t)
  const plan = { steps: [
    { key: 'detach', phase: 'conversation', conversationId: 'c1', agentId: null, argv: ['workspace', 'unmount', 'box:work'], dependsOn: [] },
    { key: 'independent', phase: 'conversation', conversationId: 'c2', agentId: null, argv: ['machine', 'get', 'native'], dependsOn: [] },
  ], tasks: [], agents: [{ agentKey: 'c1-main', conversationId: 'c1', agentId: null }, { agentKey: 'c2-main', conversationId: 'c2', agentId: null }] }
  const journal = await SimulationJournal.open(directory)
  await journal.bind('c1-main', 'one'); await journal.bind('c2-main', 'two')
  const engine = new SimulationExecution(plan, journal, { concurrency: 1 })
  const releaseReader = await engine.lifecycle.acquire('box', false)
  const waiting = engine.execute('detach', { agentKey: 'c1-main', sessionId: 'one', turnId: 'turn1', toolCallId: 'tool1' }, async () => ({}))
  assert.deepEqual(await engine.execute('independent', { agentKey: 'c2-main', sessionId: 'two', turnId: 'turn2', toolCallId: 'tool2' }, async () => ({ state: 'ready' })), { state: 'ready' })
  assert.equal(journal.records.some(record => record.type === 'intent' && record.stepKey === 'detach'), false)
  await engine.stop('c1-main')
  await assert.rejects(waiting, /Simulation stopped/)
  releaseReader()
})

test('selected stopped or SQLite-incompatible machines fail before any dependent store mutation', async t => {
  for (const [index, receipt] of [
    { state: 'stopped', supports: { sqlite: true } },
    { state: 'running', supports: { sqlite: false } },
  ].entries()) {
    const root = await mkdtemp(join(tmpdir(), 'dsh-simulation-machine-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const run = compileSimulation({ project, runId: `machine-${index}`, machine: 'worker', cycles: 1 })
    const directory = await writeSimulationPackage(root, run)
    const journal = await SimulationJournal.open(directory)
    const engine = new SimulationExecution(run.plan, journal)
    await assert.rejects(engine.execute('setup.machine', { origin: 'host' }, async () => receipt), /not ready for a SQLite simulation/)
    let storeSpawned = false
    await assert.rejects(engine.execute('setup.store', { origin: 'host' }, async () => { storeSpawned = true; return {} }), /Dependency setup.machine did not complete/)
    assert.equal(storeSpawned, false)
    assert.equal(journal.records.some(record => record.type === 'intent' && record.stepKey === 'setup.store'), false)
  }
})
test('the recorded native ready machine shape and running workers pass setup readiness', async t => {
  for (const [index, state] of ['ready', 'running'].entries()) {
    const root = await mkdtemp(join(tmpdir(), 'dsh-simulation-ready-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const run = compileSimulation({ project, runId: `ready-${index}`, cycles: 1 })
    const directory = await writeSimulationPackage(root, run)
    const receipt = { name: 'native', platform: 'native', backend: 'native', supports: { sqlite: true, postgresql_sandbox: true, reason: null }, state }
    assert.deepEqual(await new SimulationExecution(run.plan, await SimulationJournal.open(directory)).execute('setup.machine', { origin: 'host' }, async () => receipt), receipt)
  }
})
