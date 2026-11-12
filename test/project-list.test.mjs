import { test } from 'node:test'
import assert from 'node:assert/strict'
import { visibleProjectSessions } from '../src/client/projects/session-visibility.ts'

test('project history hides unused drafts, retaining started and stored conversations', () => {
  const sessions = [{ sessionId: 'empty' }, { sessionId: 'greeting' }, { sessionId: 'untitled-but-started' }, { sessionId: 'stored' }]
  const summaries = { empty: { blank: true }, greeting: { blank: false }, 'untitled-but-started': { blank: false } }
  assert.deepEqual(visibleProjectSessions(sessions, summaries).map((s) => s.sessionId), ['greeting', 'untitled-but-started', 'stored'])
  summaries.empty.blank = false
  assert.equal(visibleProjectSessions(sessions, summaries).length, 4, 'the draft appears after its first turn')
})

const avail = (state, extra = {}) => ({ state, machine: 'm', canStart: false, canRun: false, storageBlocked: false, ...extra })

test('sidebar readiness: only runnable projects are Ready; the rest carry one short reason', async () => {
  const { sidebarStatus, splitByReadiness } = await import('../src/client/projects/readiness.ts')
  assert.equal(sidebarStatus({ catalogState: 'available' }, avail('available', { canRun: true })).key, 'available')
  assert.equal(sidebarStatus({ catalogState: 'available' }, avail('stopped', { canStart: true })).key, 'machineStopped')
  assert.equal(sidebarStatus({ catalogState: 'available' }, avail('starting')).key, 'starting')
  assert.equal(sidebarStatus({ catalogState: 'available' }, avail('available', { storageBlocked: true })).key, 'storeUnavailable', 'machine up, Store down')
  assert.equal(sidebarStatus({ catalogState: 'unavailable' }, avail('unavailable', { storageBlocked: true })).key, 'notVerified')
  assert.equal(sidebarStatus({ catalogState: 'removed' }, avail('unavailable')).key, 'removed')
  assert.equal(sidebarStatus({ catalogState: 'identity-mismatch' }, avail('unavailable')).key, 'replaced')
  assert.equal(sidebarStatus({ catalogState: 'available' }, avail('unavailable')).key, 'machineUnavailable')
  const rows = [{ id: 'a', availability: avail('available', { canRun: true }) }, { id: 'b', availability: avail('stopped') }, { id: 'c', availability: avail('available', { canRun: true }) }]
  const split = splitByReadiness(rows, true)
  assert.deepEqual(split.ready.map((r) => r.id), ['a', 'c'], 'catalog order is kept')
  assert.deepEqual(split.inactive.map((r) => r.id), ['b'])
  assert.deepEqual(splitByReadiness(rows.map((r) => ({ ...r, availability: avail('checking') })), false), { ready: rows.map((r) => ({ ...r, availability: avail('checking') })), inactive: [] }, 'nothing moves before machines are read')
})

test('a periodic read rides out one failed refresh and reports the second', async () => {
  const { steadyRead } = await import('../src/client/projects/read-deadline.ts')
  const last = { current: null }
  const ok = (v) => () => Promise.resolve(v)
  const fail = () => Promise.reject(new Error('slow'))
  await assert.rejects(steadyRead(last, fail), /slow/, 'nothing to hold before the first answer')
  assert.equal(await steadyRead(last, ok('a')), 'a')
  assert.equal(await steadyRead(last, fail), 'a', 'one failed refresh keeps the last answer')
  await assert.rejects(steadyRead(last, fail), /slow/, 'two in a row are reported')
  await assert.rejects(steadyRead(last, fail), /slow/)
  assert.equal(await steadyRead(last, ok('b')), 'b')
  assert.equal(await steadyRead(last, fail), 'b', 'a good answer resets the count')
})
