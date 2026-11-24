// A storage job in words and steps (src/client/storage/model.ts): a compaction
// keeps the steps the host named, in order, from the first event.
//   node --test test/storage-jobs-model.test.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
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
  // a job without host-named steps anchors to its full canonical STEPS list (never shrinking the denominator)
  const push = job({ kind: 'push', steps: undefined, phase: 'send', phases: [{ phase: 'check', half: null, at: 1 }, { phase: 'send', half: null, at: 2 }] })
  assert.deepEqual(M.stepsOf(push).map((s) => `${s.step}:${s.state}`), [
    'check:done', 'snapshot:done', 'send:now', 'verify:todo', 'install:todo', 'record:todo', 'retire:todo',
  ])
})

test('shareOf / jobPercent stay monotonic across 7 equal steps, cap at 99% until ended, and resist stale polls via mergeJob', () => {
  const frames = [
    job({ kind: 'push', steps: undefined, phase: 'check', phases: [{ phase: 'check', half: null, at: 1 }] }),
    job({ kind: 'push', steps: undefined, phase: 'snapshot', done: 50, total: 100, phases: [{ phase: 'check', half: null, at: 1 }, { phase: 'snapshot', half: null, at: 2 }] }),
    job({ kind: 'push', steps: undefined, phase: 'snapshot', done: 100, total: 100, phases: [{ phase: 'check', half: null, at: 1 }, { phase: 'snapshot', half: null, at: 2 }] }),
    job({ kind: 'push', steps: undefined, phase: 'send', done: 0, total: 100, phases: [{ phase: 'check', half: null, at: 1 }, { phase: 'snapshot', half: null, at: 2 }, { phase: 'send', half: null, at: 3 }] }),
    job({ kind: 'push', steps: undefined, phase: 'send', done: 50, total: 100, phases: [{ phase: 'check', half: null, at: 1 }, { phase: 'snapshot', half: null, at: 2 }, { phase: 'send', half: null, at: 3 }] }),
    job({ kind: 'push', steps: undefined, phase: 'verify', done: 100, total: 100, phases: [{ phase: 'check', half: null, at: 1 }, { phase: 'snapshot', half: null, at: 2 }, { phase: 'send', half: null, at: 3 }, { phase: 'verify', half: null, at: 4 }] }),
    job({ kind: 'push', steps: undefined, phase: 'retire', phases: [{ phase: 'check', half: null, at: 1 }, { phase: 'snapshot', half: null, at: 2 }, { phase: 'send', half: null, at: 3 }, { phase: 'verify', half: null, at: 4 }, { phase: 'install', half: null, at: 5 }, { phase: 'record', half: null, at: 6 }, { phase: 'retire', half: null, at: 7 }] }),
  ]
  let cur
  let prev = -1
  for (const f of frames) {
    cur = M.mergeJob(cur, f)
    const pct = M.jobPercent(cur)
    assert.ok(pct >= prev, `regressed ${prev} -> ${pct} at ${f.phase}`)
    assert.ok(pct <= 99, `hit ${pct}% before ended`)
    prev = pct
  }
  // send at 50% of 7 equal steps: (2 + 0.5) / 7 = 36%
  assert.equal(M.jobPercent(frames[4]), 36)
  // stale poll with earlier phase/bytes is ignored
  const stale = M.mergeJob(cur, frames[3])
  assert.equal(stale, cur)
  // ended reaches 100%
  const done = M.mergeJob(cur, { ...frames.at(-1), ended: 99 })
  assert.equal(M.jobPercent(done), 100)
})

test('diskFit distinguishes full (<1.0x), tight (1.0x..1.15x), ok (>=1.15x) and unknown', () => {
  assert.deepEqual(M.diskFit(100, 500), { state: 'full', free: 100, need: 500, shortBy: 400 })
  assert.deepEqual(M.diskFit(520, 500), { state: 'tight', free: 520, need: 500, shortBy: 0 })
  assert.deepEqual(M.diskFit(600, 500), { state: 'ok', free: 600, need: 500, shortBy: 0 })
  assert.deepEqual(M.diskFit(null, 500), { state: 'unknown', free: null, need: 500, shortBy: 0 })
})

test('movePushFailed, localized endedWords (ignoring raw summary) and cross-kind failureSuperseded', () => {
  const pushFail = job({
    kind: 'move', half: 'push', from: 'lima1', target: 'docker', ended: 10, phase: 'send',
    summary: 'Pulled to Home; push failed (certain)',
    error: { code: 'Capacity', message: 'no space', phase: 'send', note: 'pulled' },
  })
  assert.equal(M.movePushFailed(pushFail), true)
  assert.equal(M.endedWords(pushFail, t), 'jobMovePushFailed {"place":"docker","phase":"stepSend"}')
  const retireFail = job({
    kind: 'move', half: 'push', from: 'lima1', target: 'docker', ended: 10, phase: 'retire',
    error: { code: 'Failed', message: 'busy', phase: 'retire' },
  })
  assert.equal(M.movePushFailed(retireFail), false)
  assert.equal(M.endedWords(retireFail, t), 'jobRetireTarget {"place":"docker"}')
  const pullFail = job({
    kind: 'move', half: 'pull', from: 'lima1', target: 'docker', ended: 10, phase: 'send',
    error: { code: 'Failed', message: 'io', phase: 'send' },
  })
  assert.equal(M.movePushFailed(pullFail), false)
  assert.equal(M.endedWords(pullFail, t), 'jobMovePullFailed {"place":"docker","from":"lima1","phase":"stepSend"}')
  // a later push success supersedes a failed move on the same Store
  assert.equal(M.failureSuperseded(pushFail, [pushFail, { id: 'j2', kind: 'push', store: 's1', ended: 20, error: null }], [{ name: 's1' }]), true)
})

test('a compaction ends in the words of its 2.0 report (`outcome`, `freed_bytes`)', () => {
  assert.equal(M.doingWords(job(), t), 'jobCompacting {"place":"s1"}')
  assert.equal(M.endedWords(job({ ended: 9, result: { outcome: 'unchanged', freed_bytes: 0 } }), t), 'jobCompactedNone {"place":"s1"}')
  const size = (n) => `${n} B`
  assert.equal(M.endedWords(job({ ended: 9, result: { outcome: 'compacted', freed_bytes: 4096 } }), t, size), 'jobCompactedFreed {"place":"s1","freed":"4096 B"}')
  // nothing freed, or no way to write a size: the plain words
  assert.equal(M.endedWords(job({ ended: 9, result: { outcome: 'compacted', freed_bytes: 0 } }), t, size), 'jobCompacted {"place":"s1"}')
  assert.equal(M.endedWords(job({ ended: 9, result: { outcome: 'compacted', freed_bytes: 4096 } }), t), 'jobCompacted {"place":"s1"}')
  // U12 F10: the step is named in words (stepBuild), never LayerFS's step code
  assert.match(M.endedWords(job({ ended: 9, phase: 'build', error: { code: 'Capacity', message: 'no space', phase: 'build' } }), t), /^jobFailed .*"phase":"stepBuild"/)
  assert.match(M.endedWords(job({ ended: 9, phase: 'mark', error: { code: 'MountsActive', message: 'mounts active: 2 holder(s)', phase: 'mark' } }), t), /^jobInUse /, 'in use is its own word')
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
  assert.equal(M.compactWaitsFor(store({ state: 'busy', op: { name: 'compact', phase: 'build', started_at: 'x' } }), t), 'opRunning {"op":"compact · build"}')
  assert.equal(M.compactWaitsFor(store({ state: 'unknown' }), t), 'compactNeedsIdle')
  // an earlier run left its outcome unknown: the fix is another compaction, so it is offered
  assert.equal(M.compactWaitsFor(store({ state: 'broken', reason: 'unresolved', fix: 'layerfs store compact s1' }), t), null)
  assert.equal(M.compactWaitsFor(store({ kind: 'postgresql', machine: null, state: 'broken', reason: 'unreachable' }), t), 'storeNeedsRepair')
})

// LayerFS N-D / Q: a Store on a machine that is not just stopped is `blocked` with
// `blocked_by { machine, reason }`, the reason being the machine's state (`busy`) or
// its broken reason (`failed`: a record LayerFS cannot read; `not_answering`: its worker).
test('a blocked Store says why by its blocked_by reason, and Compact waits for a repair, not a start', () => {
  const blocked = (reason) => store({ machine: 'lima1', state: 'blocked', blockedBy: { machine: 'lima1', reason } })
  assert.equal(M.blockedWords({ machine: 'lima1', reason: 'stopped' }, t), 'machineStopped {"machine":"lima1"}')
  assert.equal(M.blockedWords({ machine: 'lima1', reason: 'busy' }, t), 'machineBusyBlock {"machine":"lima1"}')
  assert.equal(M.blockedWords({ machine: 'lima1', reason: 'failed' }, t), 'machineUnreadableBlock {"machine":"lima1"}')
  // F3 (UI pass 2): the word names the machine, never its raw reason (that is the tip)
  assert.equal(M.blockedWords({ machine: 'lima1', reason: 'not_answering' }, t), 'machineBrokenBlock {"machine":"lima1"}')
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
  assert.equal(M.listStatusWords('refused', t), 'bucketStatusRefused')
  assert.equal(M.listStatusWords('timeout', t), 'bucketStatusTimeout')
  assert.equal(M.listStatusWords('busy', t), 'bucketStatusBusy')
  assert.equal(M.listStatusWords('lost', t), 'bucketStatusLost')
  assert.equal(M.listStatusWords('Unavailable', t), 'bucketStatusOther')
})

// A broken PostgreSQL Store with no saved password: its words say so, the tip says to edit
// its connection, and LayerFS's own sentence wins when its answer has one.
test('a broken PostgreSQL Store with no saved password: its words, its tip and its fix', () => {
  const fix = 'layerfs store connect old postgresql://db/old --user <user> --password-stdin'
  const pg = store({ name: 'old', kind: 'postgresql', machine: null, state: 'broken', reason: 'failed', fix, postgresql: { passwordSaved: false } })
  assert.equal(M.needsLogin(pg), true)
  assert.equal(M.brokenWords(pg, t), 'stateBroken · reasonNoLogin')
  assert.equal(M.storeTip(pg, t), 'pgNoLoginTip {"store":"old"}')
  assert.deepEqual(M.storeSignal(pg, undefined, null, [], t), { state: 'error', reason: 'stateBroken · reasonNoLogin' })
  assert.equal(M.storeTip({ ...pg, message: 'PostgreSQL Store old has no password saved' }, t), 'PostgreSQL Store old has no password saved')
  // a Store with a saved password, an unread record, or a sqlite Store is not this case
  assert.equal(M.needsLogin({ ...pg, postgresql: { passwordSaved: true } }), false)
  assert.equal(M.needsLogin({ ...pg, postgresql: { passwordSaved: null } }), false)
  assert.equal(M.needsLogin(store({ state: 'broken', reason: 'outdated' })), false)
  assert.equal(M.brokenWords(store({ state: 'broken', reason: 'not_answering' }), t), 'stateBroken · reasonNotAnswering')
  assert.equal(M.brokenWords(store({ state: 'broken', reason: 'unresolved' }), t), 'unresolved')
  assert.equal(M.storeTip(store({ state: 'broken', reason: 'missing', fix: 'layerfs store remove s1' }), t), 'layerfs store remove s1')
})
