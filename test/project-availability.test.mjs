import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { transform } from 'esbuild'

const { code } = await transform(readFileSync(new URL('../src/client/projects/availability.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'esm' })
const { projectAvailability: availability } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
// the project's Store in the 2.0 six states: only a ready Store lets a command run
const project = { key: 'store/compiler', machine: 'build', kind: 'sqlite', storeState: 'ready' }
// the machines view over 2.0 records: six states with their companions (op, reason, message), and the live probes
const view = (state, extra = {}, live = {}) => ({ available: true, machines: [{ name: 'build', platform: 'lima', state, ...extra }], live: { build: live } })

test('projects distinguish a stopped machine from an unavailable machine and a ready machine', () => {
  assert.equal(availability(project, view('ready')).state, 'available')
  assert.equal(availability(project, view('ready')).canRun, true)
  const stopped = availability(project, view('stopped'))
  assert.equal(stopped.state, 'stopped')
  assert.equal(stopped.canStart, true)
  assert.equal(stopped.canRun, false)
  for (const [state, extra] of [['broken', { reason: 'missing' }], ['broken', { reason: 'unresolved' }], ['blocked', {}], ['unknown', {}]]) {
    assert.equal(availability(project, view(state, extra)).state, 'unavailable', state)
    assert.equal(availability(project, view(state, extra)).canStart, false)
  }
})

test('runtime failures and failed refreshes cannot advertise availability from stale data', () => {
  const down = availability(project, view('broken', { reason: 'not_answering', message: 'Docker socket is unreachable' }))
  assert.equal(down.state, 'unavailable')
  assert.equal(down.reason, 'Docker socket is unreachable')
  assert.equal(down.canStart, false)
  assert.equal(availability(project, view('ready'), new Error('offline')).canRun, false)
  assert.equal(availability(project, { available: false, reason: 'CLI missing' }).reason, 'CLI missing')
  assert.equal(availability(project, { available: true, machines: [], live: {} }).state, 'unavailable')
  // an unknown machine without its own message says why its live probe failed
  assert.equal(availability(project, view('unknown', {}, { error: { code: 'Unavailable', message: 'probe timed out' } })).reason, 'probe timed out')
})

test('checking and machine operations never enable execution', () => {
  assert.equal(availability(project).state, 'checking')
  const starting = availability(project, view('busy', { op: { name: 'machine.start', phase: 'boot', started: 1 } }))
  assert.equal(starting.state, 'starting')
  assert.equal(starting.canRun, false)
  assert.equal(starting.canStart, false)
  assert.equal(availability(project, view('busy', { op: { name: 'machine.remove', phase: null, started: 1 } })).state, 'busy')
})

test('running machine does not conceal storage blockers, including unknown storage state', () => {
  for (const storeState of ['blocked', 'busy', 'broken', 'stopped', 'unknown', undefined]) {
    const result = availability({ ...project, storeState }, view('ready'))
    assert.equal(result.state, 'available')
    assert.equal(result.storageBlocked, true)
    assert.equal(result.canRun, false)
  }
  assert.equal(availability({ ...project, storeState: 'ready' }, view('ready')).canRun, true)
})

test('a stopped host machine is offered Start like any machine; PostgreSQL uses the host machine by default', () => {
  const host = { available: true, machines: [{ name: 'macos-host', platform: 'host', state: 'stopped' }], live: {} }
  assert.equal(availability({ ...project, machine: 'macos-host' }, host).canStart, true)
  assert.equal(availability({ ...project, kind: 'postgresql', machine: null }, host).machine, 'macos-host')
})
