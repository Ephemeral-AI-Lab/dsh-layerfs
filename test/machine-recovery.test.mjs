// Recovering a machine whose worker does not answer (the demo-build case), with the 2.0
// six states: `broken` with its `reason` and `fix`, worded by the reason, and the one
// action the fix line becomes. (The Doctor page's own fixes: test/doctor-model.test.mjs.)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixAction, machineState, workerDown, powerOf } from '../src/client/machines/model.ts'

const vm = (state, extra = {}) => ({ name: 'demo-build', platform: 'lima', state, stores: ['demo-build-cache'], sandboxes: [], ...extra })
const restart = 'layerfs machine stop demo-build && layerfs machine start demo-build'

test('a broken VM whose worker does not answer is "not answering", needs you, and offers its fix', () => {
  const broken = vm('broken', { reason: 'not_answering', fix: restart, message: 'the machine runs but its worker does not answer' })
  assert.equal(workerDown(broken), true)
  const look = machineState(broken)
  assert.deepEqual([look.key, look.label], ['needs', 'stateWorkerDown'])
  // no Start or Stop: the fix line is the one action
  assert.equal(powerOf(broken), null)
  assert.deepEqual(fixAction(broken), { kind: 'restart' })
  // with Sandboxes on it the restart needs --force: offered off, with the line to copy
  assert.deepEqual(fixAction({ ...broken, sandboxes: ['tests'] }), { kind: 'forced', sandboxes: 1, line: restart })
  const forced = 'layerfs machine stop demo-build --force && layerfs machine start demo-build'
  assert.deepEqual(fixAction({ ...broken, reason: 'outdated', fix: forced, sandboxes: ['tests'] }), { kind: 'forced', sandboxes: 1, line: forced })
})

test('the fix line becomes the action only when the page runs exactly that call', () => {
  assert.deepEqual(fixAction(vm('broken', { reason: 'failed', fix: 'layerfs machine start demo-build' })), { kind: 'start' })
  // another machine's name, another call or an extra word is copied, never run in part
  for (const fix of ['layerfs machine start other', 'layerfs machine remove demo-build', 'layerfs machine start demo-build && layerfs store list']) {
    assert.deepEqual(fixAction(vm('broken', { reason: 'failed', fix })), { kind: 'copy', line: fix })
  }
  assert.equal(fixAction(vm('broken', { reason: 'failed', fix: null })), null)
  // Docker's Engine first; an unresolved operation and an unknown state are checked again (a live read)
  assert.deepEqual(fixAction(vm('broken', { platform: 'docker', reason: 'engine_down', fix: 'open Docker' })), { kind: 'engine' })
  assert.deepEqual(fixAction(vm('broken', { reason: 'unresolved', fix: 'layerfs machine get demo-build' })), { kind: 'check' })
  assert.deepEqual(fixAction(vm('unknown')), { kind: 'check' })
})

test('a clean stop, native, and the other states are not down', () => {
  assert.equal(workerDown(vm('stopped')), false)
  assert.equal(machineState(vm('stopped')).key, 'stopped')
  assert.equal(powerOf(vm('stopped')), 'start')
  assert.equal(powerOf(vm('ready')), 'stop')
  assert.equal(workerDown({ ...vm('broken', { reason: 'not_answering' }), platform: 'native' }), false)
  assert.equal(fixAction({ ...vm('broken', { reason: 'not_answering', fix: restart }), platform: 'native' }), null)
  const busy = machineState(vm('busy', { op: { name: 'machine.start', phase: 'boot', started: 1 } }))
  assert.deepEqual([busy.key, busy.label], ['busy', 'stateStarting'])
  assert.equal(workerDown(vm('busy')), false)
  assert.equal(fixAction(vm('ready')), null)
})
