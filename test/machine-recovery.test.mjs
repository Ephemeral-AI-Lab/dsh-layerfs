// Recovering a machine whose worker does not answer (the demo-build case): the state
// the UI shows. (The fixes a doctor finding offers are the Doctor page's: test/doctor-model.test.mjs.)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { machineState, workerDown, powerOf } from '../src/client/machines/model.ts'

const vm = (state, extra = {}) => ({ name: 'demo-build', platform: 'lima', state, stores: ['demo-build-cache'], sandboxes: [], ...extra })
const live = (down) => ({ name: 'demo-build', state: 'stopped', freeDisk: null, toolVersion: null, down })

test('a stopped or running VM with a down reason is "not answering" and needs you', () => {
  const down = live('the machine runs but its worker does not answer')
  assert.equal(workerDown(vm('stopped'), down), true)
  assert.equal(workerDown(vm('running'), down), true)
  const look = machineState(vm('stopped'), down)
  assert.deepEqual([look.key, look.label, look.tone], ['needs', 'stateWorkerDown', 'danger'])
  // Start stays the power offer of a stopped one (the button reads Restart worker)
  assert.equal(powerOf(vm('stopped')), 'start')
})

test('a clean stop, native, and a machine in another state are not', () => {
  assert.equal(workerDown(vm('stopped'), live(null)), false)
  assert.equal(workerDown(vm('stopped')), false)
  assert.equal(machineState(vm('stopped'), live(null)).key, 'stopped')
  assert.equal(workerDown({ ...vm('ready'), platform: 'native' }, live('x')), false)
  assert.equal(workerDown(vm('creating'), live('x')), false)
})
