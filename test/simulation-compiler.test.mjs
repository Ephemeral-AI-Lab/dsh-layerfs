import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compileSimulation, SIMULATION_PROFILES, resolveSimulationStep, renderSimulationCommand } from '../src/host/simulations/compiler.ts'

test('all workload profiles compile with one script per native parent/child and pinned handoff receipts', () => {
  assert.equal(Object.keys(SIMULATION_PROFILES).length, 8)
  for (const project of Object.keys(SIMULATION_PROFILES)) for (const mixed of [false, true]) {
    const run = compileSimulation({ project, mixed, cycles: 1, runId: `test-${project}-${mixed}` })
    const keys = new Set(run.plan.steps.map(step => step.key))
    assert.equal(keys.size, run.plan.steps.length)
    for (const step of run.plan.steps) for (const dep of step.dependsOn) assert.ok(keys.has(dep), dep)
    assert.equal(run.plan.agents.length, run.plan.conversations.reduce((n,c) => n + 1 + c.subagents.length, 0))
    for (const agent of run.plan.agents) {
      assert.ok(agent.name && agent.scriptId && agent.agentKey)
      assert.ok(agent.turns.length <= 10)
      assert.ok(run.files[agent.path])
      assert.equal(run.manifest.hashes[agent.path], agent.hash)
    }
    for (const [conversationId, target] of Object.entries(run.plan.continuationTargets)) {
      const step = run.plan.steps.find(step => step.key === target.receipt)
      assert.deepEqual(step.argv.slice(0, 2), ['branch', 'publish'])
      assert.equal(target.type, 'Layer')
      const rootPublications = run.plan.steps.filter(step => step.conversationId === conversationId && !step.agentId && step.argv[0] === 'branch' && step.argv[1] === 'publish').reverse()
      assert.deepEqual(target.fallbacks.map(fallback => fallback.receipt), [...rootPublications.map(step => step.key), 'setup.project'])
      assert.equal(target.fallbacks[0].receipt, target.receipt)
      assert.equal(target.fallbacks.at(-1).initial, true)
      for (const fallback of target.fallbacks) {
        assert.equal(fallback.project, target.project)
        assert.equal(fallback.type, 'Layer')
      }
    }
    assert.ok(!Object.hasOwn(run.files, 'sessions.json'))
    assert.ok(!Object.hasOwn(run.files, 'resources.json'))
    assert.ok(!Object.keys(run.files).some(path => path.includes('conversation.json')))
    assert.ok(!run.plan.steps.some(step => step.argv.includes('<ws:undefined>')))
  }
})
test('confirmed references resolve before CLI rendering and shell data stays quoted', () => {
  const step = { key: 'x', argv: ['workspace', 'commit', '<ws:mount>', "x'$(echo wrong)"] }
  assert.throws(() => renderSimulationCommand(step), /Resolve confirmed/)
  assert.throws(() => resolveSimulationStep(step, {}, '/tmp/run'), /Missing confirmed workspace/)
  const argv = resolveSimulationStep(step, { mount: { ws: 'box:work' } }, '/tmp/run')
  assert.equal(argv[2], 'box:work')
  const command = renderSimulationCommand(step, argv, '/tmp/cli')
  assert.ok(command.includes("'x'\\''$(echo wrong)'"))
})
test('unknown presets and traversal IDs fail before package preparation', () => {
  assert.throws(() => compileSimulation({ project: 'unknown' }), /Unknown simulation/)
  assert.throws(() => compileSimulation({ project: Object.keys(SIMULATION_PROFILES)[0], runId: '../escape' }), /valid LayerFS names/)
})
