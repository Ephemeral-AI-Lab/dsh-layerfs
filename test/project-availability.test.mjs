import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { transform } from 'esbuild'

const { code } = await transform(readFileSync(new URL('../src/client/projects/availability.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'esm' })
const { projectAvailability: availability } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
const project = { key: 'store/compiler', machine: 'build', kind: 'sqlite', storeState: 'idle' }
const view = (state, live = {}, extra = {}) => ({ available: true, machines: [{ name: 'build', platform: 'lima', state, ...extra }], status: { build: live } })

test('projects distinguish a stopped machine from an unavailable machine and a ready machine', () => {
  assert.equal(availability(project, view('running')).state, 'available')
  assert.equal(availability(project, view('running')).canRun, true)
  const stopped = availability(project, view('stopped'))
  assert.equal(stopped.state, 'stopped')
  assert.equal(stopped.canStart, true)
  assert.equal(stopped.canRun, false)
  for (const state of ['missing', 'failed', 'unresolved', 'unknown']) {
    assert.equal(availability(project, view(state)).state, 'unavailable')
    assert.equal(availability(project, view(state)).canStart, false)
  }
})

test('runtime failures and failed refreshes cannot advertise availability from stale data', () => {
  const down = availability(project, view('stopped', { down: 'Docker socket is unreachable' }))
  assert.equal(down.state, 'unavailable')
  assert.equal(down.reason, 'Docker socket is unreachable')
  assert.equal(down.canStart, false)
  assert.equal(availability(project, view('running'), new Error('offline')).canRun, false)
  assert.equal(availability(project, { available: false, reason: 'CLI missing' }).reason, 'CLI missing')
  assert.equal(availability(project, { available: true, machines: [], status: {} }).state, 'unavailable')
})

test('checking and machine operations never enable execution', () => {
  assert.equal(availability(project).state, 'checking')
  const starting = availability(project, view('stopped', { op: { name: 'machine.start', phase: 'boot' } }))
  assert.equal(starting.state, 'starting')
  assert.equal(starting.canRun, false)
  assert.equal(starting.canStart, false)
  assert.equal(availability(project, view('removing')).state, 'busy')
})

test('running machine does not conceal storage blockers, including unknown storage state', () => {
  for (const storeState of ['down', 'busy', 'unresolved', undefined]) {
    const result = availability({ ...project, storeState }, view('running'))
    assert.equal(result.state, 'available')
    assert.equal(result.storageBlocked, true)
    assert.equal(result.canRun, false)
  }
  assert.equal(availability({ ...project, storeState: 'in_use' }, view('running')).canRun, true)
})

test('native machines are never offered a power action; PostgreSQL uses the default execution machine', () => {
  const native = { available: true, machines: [{ name: 'native', platform: 'native', state: 'stopped' }], status: {} }
  assert.equal(availability({ ...project, machine: 'native' }, native).canStart, false)
  assert.equal(availability({ ...project, kind: 'postgresql', machine: null }, native).machine, 'native')
})
