// Recovering a machine whose worker does not answer (the demo-build case): the state
// the UI shows and the fixes a doctor finding offers as buttons.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { machineState, workerDown, powerOf } from '../src/client/machines/model.ts'
import { findingFixes, setupFindings } from '../src/client/doctor/fixes.ts'

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

test('a finding offers the commands the host runs, deduped', () => {
  assert.deepEqual(findingFixes({ severity: 'warning', fix: '`layerfs machine start demo-build` starts it again; `layerfs machine stop demo-build` records it stopped' }),
    [{ kind: 'start', name: 'demo-build' }, { kind: 'stop', name: 'demo-build' }])
  assert.deepEqual(findingFixes({ severity: 'warning', fix: '`layerfs sandbox get demo-mix-sdk-1` shows whether it still runs; `layerfs sandbox close demo-mix-sdk-1` closes one whose daemon is gone' }),
    [{ kind: 'close', name: 'demo-mix-sdk-1' }])
  assert.deepEqual(findingFixes({ severity: 'warning', fix: 'layerfs machine start a; layerfs machine start a' }), [{ kind: 'start', name: 'a' }])
})

test('an error about a Sandbox with no command offers Close; other findings offer nothing', () => {
  assert.deepEqual(findingFixes({ severity: 'error', fix: null, target: { kind: 'sandbox', name: 'demo-mix-sdk-1' } }), [{ kind: 'close', name: 'demo-mix-sdk-1' }])
  assert.deepEqual(findingFixes({ severity: 'warning', fix: null, target: { kind: 'sandbox', name: 'x' } }), [])
  assert.deepEqual(findingFixes({ severity: 'error', fix: 'layerfs doctor --fix', target: { kind: 'store', name: 's' } }), [])
  assert.deepEqual(findingFixes({ severity: 'warning', fix: 'layerfs sandbox get box shows it' }), [])
})

test('a never-started machine is a warning with Start (doctor machine.provider)', () => {
  const message = 'docker was never started; Start creates its worker container'
  assert.deepEqual(findingFixes({ severity: 'warning', fix: null, message, target: { kind: 'machine', name: 'docker' } }), [{ kind: 'start', name: 'docker' }])
  // a machine that ran and lost its container stays an error, with no Start offered for it here
  assert.deepEqual(findingFixes({ severity: 'error', fix: null, message: 'provider holds no runtime with the recorded machine identity', target: { kind: 'machine', name: 'docker' } }), [])
  // a command in the fix wins
  assert.deepEqual(findingFixes({ severity: 'warning', fix: 'layerfs machine start docker', message, target: { kind: 'machine', name: 'docker' } }), [{ kind: 'start', name: 'docker' }])
})

test('home get warnings open the setup section that fixes them; HomeMode is a note', () => {
  const found = setupFindings([
    { code: 'HomeNeedsConversion', message: 'a' }, { code: 'HomeMode', message: 'b' }, { code: 'BundleMismatch', message: 'c' },
    { code: 'DaemonMissing', message: 'd' }, { code: 'SomethingNew', message: 'e' },
  ])
  assert.deepEqual(found.map((f) => [f.code, f.severity, f.section]), [
    ['HomeNeedsConversion', 'warning', 'folder'], ['HomeMode', 'note', 'folder'], ['BundleMismatch', 'warning', 'runtime'],
    ['DaemonMissing', 'warning', 'runtime'], ['SomethingNew', 'warning', 'runtime'],
  ])
  assert.deepEqual(setupFindings(undefined), [])
})
