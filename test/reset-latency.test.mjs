import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EnvironmentReset } from '../src/host/presets/environment-reset.js'

test('reset confirmation does not contact sandbox workers, including machines marked running', async () => {
  const home = mkdtempSync(join(tmpdir(), 'reset-plan-'))
  writeFileSync(join(home, 'layerfs.json'), JSON.stringify({ id: 'private-test-home' }))
  const calls = []
  const inventory = {
    machine: { machines: [{ name: 'native', state: 'ready' }, { name: 'offline', state: 'stopped' }, { name: 'unresponsive', state: 'running' }] },
    store: { items: [{ name: 's', machine: 'offline', projects: ['p'] }] },
    sandbox: { items: [{ name: 'a', machine: 'offline' }, { name: 'b', machine: 'unresponsive' }] },
  }
  const driver = { invoke: async (argv) => {
    calls.push(argv)
    assert.equal(argv[1], 'list', 'confirmation must use local inventory, never sandbox get')
    return inventory[argv[0]]
  } }
  try {
    const reset = new EnvironmentReset({ spec: { home, state: home }, driver })
    const plan = await reset.plan()
    assert.equal(calls.length, 3)
    assert.deepEqual(plan.unknownSandboxes, ['a', 'b'])
    assert.deepEqual(plan.remove.sandboxes, ['a', 'b'])
    assert.deepEqual(plan.projectKeys, ['s/p'])
    assert.deepEqual(plan.startMachines, ['offline'])
    assert.equal((await reset.plan()).signature, plan.signature)
    inventory.store.items.push({ name: 'added', machine: 'offline', projects: ['q'] })
    assert.notEqual((await reset.plan()).signature, plan.signature, 'resource changes must still invalidate confirmation')
  } finally { rmSync(home, { recursive: true, force: true }) }
})
