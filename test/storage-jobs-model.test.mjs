// A storage job in words and steps (src/client/storage/model.ts): a compaction
// keeps the steps the host named, in order, from the first event.
//   node --test test/storage-jobs-model.test.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = new URL('..', import.meta.url).pathname
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-storage-jobs-'))
after(() => rmSync(out, { recursive: true, force: true }))
await build({ absWorkingDir: root, stdin: { contents: "export * from './src/client/storage/model.ts'", resolveDir: root, loader: 'ts' }, outfile: join(out, 'model.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24', logLevel: 'warning' })
const M = await import(pathToFileURL(join(out, 'model.mjs')).href)

const t = (key, vars = {}) => `${key}${Object.keys(vars).length ? ' ' + JSON.stringify(vars) : ''}`
const job = (over = {}) => ({ id: 'j', kind: 'compact', store: 's1', target: 's1', file: null, started: 1, ended: null, phase: null, done: null, total: null, error: null, phases: [], steps: ['mark', 'build', 'verify', 'install'], ...over })
const store = (over = {}) => ({ name: 's1', kind: 'sqlite', machine: 'native', state: 'ready', links: [], projects: [], ...over })

test('a compaction shows its named steps from the start and moves through them', () => {
  assert.deepEqual(M.stepsOf(job()).map((s) => s.state), ['now', 'todo', 'todo', 'todo'])
  const building = job({ phase: 'build', phases: [{ phase: 'mark', half: null, at: 1 }, { phase: 'build', half: null, at: 2 }] })
  assert.deepEqual(M.stepsOf(building).map((s) => `${s.step}:${s.state}`), ['mark:done', 'build:now', 'verify:todo', 'install:todo'])
  assert.equal(M.shareOf(building), 0.25)
  // a phase the host did not name is appended, not dropped
  const extra = job({ phase: 'cleanup', phases: [{ phase: 'mark', half: null, at: 1 }, { phase: 'cleanup', half: null, at: 2 }] })
  assert.deepEqual(M.stepsOf(extra).map((s) => s.step), ['mark', 'build', 'verify', 'install', 'cleanup'])
  // a failed run marks the step it stopped in
  const failed = job({ ended: 9, phase: 'build', error: { code: 'Capacity', message: 'no space', phase: 'build' } })
  assert.deepEqual(M.stepsOf(failed).map((s) => s.state), ['done', 'failed', 'todo', 'todo'])
  // a job without named steps keeps the phases it saw (push, pull, backup)
  const push = job({ kind: 'push', steps: undefined, phase: 'send', phases: [{ phase: 'check', half: null, at: 1 }, { phase: 'send', half: null, at: 2 }] })
  assert.deepEqual(M.stepsOf(push).map((s) => s.step), ['check', 'send'])
})

test('a compaction ends in the words of its 2.0 report (`outcome`, `freed_bytes`)', () => {
  assert.equal(M.doingWords(job(), t), 'jobCompacting {"place":"s1"}')
  assert.equal(M.endedWords(job({ ended: 9, result: { outcome: 'unchanged', freed_bytes: 0 } }), t), 'jobCompactedNone {"place":"s1"}')
  const size = (n) => `${n} B`
  assert.equal(M.endedWords(job({ ended: 9, result: { outcome: 'compacted', freed_bytes: 4096 } }), t, size), 'jobCompactedFreed {"place":"s1","freed":"4096 B"}')
  // nothing freed, or no way to write a size: the plain words
  assert.equal(M.endedWords(job({ ended: 9, result: { outcome: 'compacted', freed_bytes: 0 } }), t, size), 'jobCompacted {"place":"s1"}')
  assert.equal(M.endedWords(job({ ended: 9, result: { outcome: 'compacted', freed_bytes: 4096 } }), t), 'jobCompacted {"place":"s1"}')
  assert.match(M.endedWords(job({ ended: 9, phase: 'build', error: { code: 'Capacity', message: 'no space', phase: 'build' } }), t), /^jobFailed .*"phase":"build"/)
})

test('a PostgreSQL Store measures stored pack bodies plus metadata (`store get --with stats`)', () => {
  assert.equal(M.pgStoreBytes({ stored_bytes: 22356665, metadata_bytes: 3243233 }), 25599898)
  assert.equal(M.pgStoreBytes({ stored_bytes: 4096, metadata_bytes: null }), 4096)
  // nothing reported: unknown, not 0 B
  assert.equal(M.pgStoreBytes({ stored_bytes: null, metadata_bytes: null }), null)
  assert.equal(M.pgStoreBytes(undefined), null)
})

test('Compact is offered by the 2.0 state alone, a Store blocked by its machine waits for that machine', () => {
  assert.equal(M.compactWaitsFor(store(), t), null)
  assert.equal(M.compactWaitsFor(store({ kind: 'postgresql', machine: null }), t), null)
  // LayerFS compacts a Store on a machine in that machine's worker: no block for its place
  assert.equal(M.compactWaitsFor(store({ machine: 'lima1' }), t), null)
  assert.equal(M.compactWaitsFor(store({ machine: 'lima1', state: 'blocked', blockedBy: { machine: 'lima1', reason: 'stopped' } }), t), 'compactNeedsMachine {"machine":"lima1"}')
  assert.equal(M.compactWaitsFor(store({ state: 'busy', op: { name: 'compact', phase: 'build', started_at: 'x' } }), t), 'compactNeedsIdle')
  assert.equal(M.compactWaitsFor(store({ state: 'unknown' }), t), 'compactNeedsIdle')
  // an earlier run left its outcome unknown: the fix is another compaction, so it is offered
  assert.equal(M.compactWaitsFor(store({ state: 'broken', reason: 'unresolved', fix: 'layerfs store compact s1' }), t), null)
  assert.equal(M.compactWaitsFor(store({ kind: 'postgresql', machine: null, state: 'broken', reason: 'unreachable' }), t), 'compactNeedsIdle')
})

// LayerFS N-D / Q: a Store on a machine that is not just stopped is `blocked` with
// `blocked_by { machine, reason }`, the reason being the machine's state (`busy`) or
// its broken reason (`failed`: a record LayerFS cannot read; `not_answering`: its worker).
test('a blocked Store says why by its blocked_by reason, and Compact waits for a repair, not a start', () => {
  const blocked = (reason) => store({ machine: 'lima1', state: 'blocked', blockedBy: { machine: 'lima1', reason } })
  assert.equal(M.blockedWords({ machine: 'lima1', reason: 'stopped' }, t), 'machineStopped {"machine":"lima1"}')
  assert.equal(M.blockedWords({ machine: 'lima1', reason: 'busy' }, t), 'machineBusyBlock {"machine":"lima1"}')
  assert.equal(M.blockedWords({ machine: 'lima1', reason: 'failed' }, t), 'machineUnreadableBlock {"machine":"lima1"}')
  assert.equal(M.blockedWords({ machine: 'lima1', reason: 'not_answering' }, t), 'machineBrokenBlock {"machine":"lima1","reason":"not answering"}')
  assert.equal(M.blockedWords({ machine: 'lima1', reason: 'failed' }, t, (m) => `<${m}>`), 'machineUnreadableBlock {"machine":"<lima1>"}')
  assert.equal(M.storeSignal(blocked('failed'), undefined, null, [], t).reason, 'machineUnreadableBlock {"machine":"lima1"}')
  assert.equal(M.compactWaitsFor(blocked('failed'), t), 'compactNeedsMachineFixed {"machine":"lima1"}')
  assert.equal(M.compactWaitsFor(blocked('not_answering'), t), 'compactNeedsMachineFixed {"machine":"lima1"}')
  assert.equal(M.compactWaitsFor(blocked('stopped'), t), 'compactNeedsMachine {"machine":"lima1"}')
})

// LayerFS N-E: `backup list` `not_listed` reasons are timeout, busy, lost and refused
// (a bucket that answered and refused, or was never asked because its connection
// cannot be read); the page words the reason and keeps LayerFS's sentence as the tip.
test('a bucket that did not list is worded by its not_listed reason', () => {
  assert.equal(M.listFailedWords('refused', t), 'bucketWhyRefused')
  assert.equal(M.listFailedWords('timeout', t), 'bucketWhyTimeout')
  assert.equal(M.listFailedWords('busy', t), 'bucketWhyBusy')
  assert.equal(M.listFailedWords('lost', t), 'bucketWhyLost')
  assert.equal(M.listFailedWords('Unavailable', t), 'bucketWhyOther')
})
