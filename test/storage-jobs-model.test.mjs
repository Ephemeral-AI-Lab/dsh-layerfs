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
const store = (over = {}) => ({ name: 's1', kind: 'sqlite', machine: 'native', state: 'idle', ...over })

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

test('a compaction ends in the words of its report', () => {
  assert.equal(M.doingWords(job(), t), 'jobCompacting {"place":"s1"}')
  assert.equal(M.endedWords(job({ ended: 9, result: { path: 'none' } }), t), 'jobCompactedNone {"place":"s1"}')
  const size = (n) => `${n} B`
  assert.equal(M.endedWords(job({ ended: 9, result: { path: 'rebuild', physical_shrink: 4096 } }), t, size), 'jobCompactedFreed {"place":"s1","freed":"4096 B"}')
  // no shrink reported, or no way to write a size: the plain words
  assert.equal(M.endedWords(job({ ended: 9, result: { path: 'rebuild', physical_shrink: 0 } }), t, size), 'jobCompacted {"place":"s1"}')
  assert.equal(M.endedWords(job({ ended: 9, result: { path: 'rebuild', physical_shrink: 4096 } }), t), 'jobCompacted {"place":"s1"}')
  assert.match(M.endedWords(job({ ended: 9, phase: 'build', error: { code: 'Capacity', message: 'no space', phase: 'build' } }), t), /^jobFailed .*"phase":"build"/)
})

test('compaction starts on an idle Store, a machine Store only while its machine runs', () => {
  assert.equal(M.compactBlock(store(), t), null)
  assert.equal(M.compactBlock(store({ kind: 'postgresql', machine: null }), t), null)
  // LayerFS compacts a Store on a machine in that machine's worker (GC decision D5)
  assert.equal(M.compactBlock(store({ machine: 'lima1' }), t), null)
  assert.equal(M.compactBlock(store({ machine: 'lima1', state: 'down' }), t), 'compactNeedsMachine {"machine":"lima1"}')
  assert.equal(M.compactBlock(store({ state: 'busy' }), t), 'compactNeedsIdle')
  assert.equal(M.compactBlock(store({ kind: 'postgresql', machine: null, state: 'unresolved' }), t), 'compactNeedsIdle')
})
