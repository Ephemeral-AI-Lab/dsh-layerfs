// Recovering a machine whose worker does not answer (the demo-build case), with the 2.0
// six states: `broken` with its `reason` and `fix`, worded by the reason, and the one
// action the fix line becomes. (The Doctor page's own fixes: test/doctor-model.test.mjs.)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixAction, machineState, workerDown, powerOf, unreadableRecord } from '../src/client/machines/model.ts'
import { machineOf, unreadableRecord as hostUnreadable } from '../src/host/layerfs/machine-records.ts'

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
  for (const fix of ['layerfs machine start other', 'layerfs machine remove other', 'layerfs machine remove demo-build --force', 'layerfs machine start demo-build && layerfs store list']) {
    assert.deepEqual(fixAction(vm('broken', { reason: 'failed', fix })), { kind: 'copy', line: fix })
  }
  assert.equal(fixAction(vm('broken', { reason: 'failed', fix: null })), null)
  // the cut: a record with no vm_name (a created machine, or the built-in docker) is fixed by its remove, records only, behind a confirm
  assert.deepEqual(fixAction(vm('broken', { reason: 'outdated', fix: 'layerfs machine remove demo-build' })), { kind: 'remove' })
  assert.deepEqual(fixAction({ ...vm('broken', { reason: 'outdated' }), name: 'docker', platform: 'docker', fix: 'layerfs machine remove docker' }), { kind: 'remove' })
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

// LayerFS N-D: a machine record LayerFS cannot read is a `machine list` item `broken`
// with reason `failed`, no platform and the fix `layerfs machine doctor <name>` (its
// get, remove and update refuse `Failed`). The page names it, offers no start or
// restart, and its one action is the Doctor (the fix line is not run from here).
test('an unreadable machine record: broken, "record unreadable", nothing to start, the Doctor as its action', () => {
  const item = { machine: 'bad', platform: null, state: 'broken', op: null, reason: 'failed', fix: 'layerfs machine doctor bad', message: '/home/machine/bad/record.json: expected a field name at byte 1', stores: null, sandboxes: null }
  const m = machineOf(item)
  assert.equal(m.platform, '')
  assert.equal(hostUnreadable(m), true)
  assert.equal(unreadableRecord(m), true)
  const look = machineState(m)
  assert.deepEqual([look.key, look.label], ['needs', 'stateUnreadable'])
  assert.equal(workerDown(m), false)
  assert.equal(powerOf(m), null)
  // the fix is a doctor call the page does not run: kept as a line, never a button here
  assert.deepEqual(fixAction(m), { kind: 'copy', line: 'layerfs machine doctor bad' })
  // a broken machine whose record reads is not one
  assert.equal(unreadableRecord(vm('broken', { reason: 'failed', fix: 'layerfs machine start demo-build' })), false)
  assert.equal(machineState(vm('broken', { reason: 'failed' })).label, 'stateFailed')
})
