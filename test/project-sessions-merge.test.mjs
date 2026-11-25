// The sidebar's two reads merge: the local list paints first, then the
// portable archive lands. A session already on screen keeps its place and is
// never dropped; the late answer only adds rows and fills a missing title.
//   node --test test/project-sessions-merge.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { miniReact } from './mini-react.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-project-sessions-merge-'))
await build({
  absWorkingDir: root,
  stdin: { contents: "export { mergeSessionRows } from './src/client/projects/hooks.ts'\n", resolveDir: root, loader: 'ts' },
  outfile: join(out, 'hooks.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24', logLevel: 'error',
  loader: { '.module.css': 'local-css', '.css': 'css' }, plugins: [miniReact],
})
const H = await import(pathToFileURL(join(out, 'hooks.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

const row = (sessionId, updatedAt, extra = {}) => ({ sessionId, title: null, local: true, updatedAt, ...extra })
const ids = (rows) => rows.map((r) => r.sessionId)

test('a slow archive answer after the local paint keeps the local rows, in order, and adds the stored ones', () => {
  const local = [row('c', 300), row('a', 100), row('b', 200)].map((r) => ({ ...r, state: 'closed', title: `local ${r.sessionId}` }))
  const painted = H.mergeSessionRows(local, undefined, new Map())
  assert.deepEqual(ids(painted), ['c', 'b', 'a'], 'the local answer sorts newest first')
  // The archive arrives with different timestamps for the same sessions and one only it knows.
  const archive = [row('a', 900, { state: 'stored', title: 'stored a' }), row('d', 950, { state: 'stored', title: 'stored d' }), row('c', 50)]
  const merged = H.mergeSessionRows(local, archive, new Map(painted.map((r) => [r.sessionId, r.updatedAt])))
  assert.deepEqual(ids(merged), ['d', 'c', 'b', 'a'], 'the local relative order is untouched; the new row joins above')
  const byId = Object.fromEntries(merged.map((r) => [r.sessionId, r]))
  assert.deepEqual(byId.c.state, 'closed', 'the local fields still win for a session both answers know')
  assert.equal(byId.c.title, 'local c', 'an archive row without a title does not blank the local one')
  assert.equal(byId.d.title, 'stored d')
  assert.equal(byId.d.local, true)
  assert.ok(ids(merged).indexOf('c') < ids(merged).indexOf('b'))
})

test('the archive paint first also keeps its places when the local answer lands', () => {
  const order = new Map()
  const archive = [row('x', 100, { state: 'stored' }), row('y', 200, { state: 'stored' })]
  assert.deepEqual(ids(H.mergeSessionRows(undefined, archive, order)), ['y', 'x'])
  const local = [row('x', 900, { state: 'closed' }), row('z', 50, { state: 'closed' })]
  const merged = H.mergeSessionRows(local, archive, order)
  assert.deepEqual(ids(merged), ['y', 'x', 'z'], 'x keeps the archive-paint place; z is added below it')
  const x = merged.find((r) => r.sessionId === 'x')
  assert.equal(x.state, 'closed', 'the local answer updates the row in place')
  assert.equal(x.updatedAt, 900)
})

test('a session only the local answer knows survives the archive answer', () => {
  const local = [row('local-only', 10), row('shared', 20)]
  const merged = H.mergeSessionRows(local, [row('shared', 20, { state: 'stored' }), row('stored-only', 30)], new Map())
  assert.deepEqual(ids(merged).sort(), ['local-only', 'shared', 'stored-only'])
})

test('without a first paint the merged rows sort by their updatedAt', () => {
  assert.deepEqual(ids(H.mergeSessionRows([row('a', 1)], [row('b', 2), row('c', 3)])), ['c', 'b', 'a'])
})
