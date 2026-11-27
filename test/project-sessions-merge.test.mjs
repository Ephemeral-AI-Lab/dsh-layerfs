// The sidebar's two reads merge: the local list paints first, then the
// portable archive lands. A session already on screen is never dropped; the
// late answer only adds rows and fills a missing title, while a local row sorts
// by its current time. The archive read (a Store walk) runs once per expand,
// after the local paint.
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
  stdin: {
    contents: [
      "export { mount } from 'react'",
      "export { mergeSessionRows, useProjectSessions } from './src/client/projects/hooks.ts'",
      "export { cachedAnswer } from './src/client/ui/use-query.ts'",
    ].join('\n'),
    resolveDir: root, loader: 'tsx',
  },
  outfile: join(out, 'hooks.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24', logLevel: 'error',
  jsx: 'automatic', loader: { '.module.css': 'local-css', '.css': 'css' }, plugins: [miniReact],
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

test('after an archive paint, the local answer places its rows by their own time; stored-only rows keep theirs', () => {
  const order = new Map()
  const archive = [row('x', 100, { state: 'stored' }), row('y', 200, { state: 'stored' })]
  assert.deepEqual(ids(H.mergeSessionRows(undefined, archive, order)), ['y', 'x'])
  const local = [row('x', 900, { state: 'closed' }), row('z', 50, { state: 'closed' })]
  const merged = H.mergeSessionRows(local, archive, order)
  assert.deepEqual(ids(merged), ['x', 'y', 'z'], 'x is local and was updated at 900; y keeps its place; z is added below')
  const x = merged.find((r) => r.sessionId === 'x')
  assert.equal(x.state, 'closed', 'the local answer updates the row')
  assert.equal(x.updatedAt, 900)
  // A later Store walk reports a newer time for the stored-only row: it does not move.
  assert.deepEqual(ids(H.mergeSessionRows(local, [row('x', 100), row('y', 5000, { state: 'stored' })], order)), ['x', 'y', 'z'])
})

test('a resumed conversation moves to the top: local rows sort by their current updatedAt', () => {
  const order = new Map()
  const archive = [row('stored-only', 150, { state: 'stored', local: false })]
  const first = [row('a', 100, { state: 'closed' }), row('b', 200, { state: 'closed' })]
  assert.deepEqual(ids(H.mergeSessionRows(first, undefined, order)), ['b', 'a'], 'the first paint')
  assert.deepEqual(ids(H.mergeSessionRows(first, archive, order)), ['b', 'stored-only', 'a'], 'the late archive answer only adds its row')
  // The reader resumes the old conversation `a`: the next local read has its new time.
  const resumed = [row('a', 300, { state: 'bound' }), row('b', 200, { state: 'closed' })]
  assert.deepEqual(ids(H.mergeSessionRows(resumed, archive, order)), ['a', 'b', 'stored-only'], 'a rises above b and the stored-only row')
  // The archive answering again (with the old time for a) does not pull it back down.
  const staleArchive = [row('a', 100, { state: 'stored' }), ...archive]
  assert.deepEqual(ids(H.mergeSessionRows(resumed, staleArchive, order)), ['a', 'b', 'stored-only'])
  // A row that leaves the local list keeps the place its last local time gave it.
  assert.deepEqual(ids(H.mergeSessionRows([row('b', 200)], staleArchive, order)), ['a', 'b', 'stored-only'])
})

test('a session only the local answer knows survives the archive answer', () => {
  const local = [row('local-only', 10), row('shared', 20)]
  const merged = H.mergeSessionRows(local, [row('shared', 20, { state: 'stored' }), row('stored-only', 30)], new Map())
  assert.deepEqual(ids(merged).sort(), ['local-only', 'shared', 'stored-only'])
})

test('without a first paint the merged rows sort by their updatedAt', () => {
  assert.deepEqual(ids(H.mergeSessionRows([row('a', 1)], [row('b', 2), row('c', 3)])), ['c', 'b', 'a'])
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('an expand walks the Store once, after the local paint, and a remount draws the last stored rows at once', async () => {
  const project = 'st/archive-deferral'
  const asked = []
  const api = {
    op: async (name, args) => {
      asked.push(args)
      return args.localOnly
        ? { sessions: [row('local-1', 100, { state: 'closed' })] }
        : { sessions: [row('stored-1', 50, { state: 'stored', local: false })] }
    },
    onEvent: () => () => {},
  }
  const walks = () => asked.filter((args) => args.localOnly === false).length
  const Probe = (props) => H.useProjectSessions(props.api, props.project, true)

  const view = H.mount(Probe, { api, project })
  await view.settle()
  assert.equal(walks(), 0, 'no Store walk before the local paint')
  assert.deepEqual(ids(view.tree.sessions), ['local-1'], 'the local rows paint')
  assert.equal(H.cachedAnswer(`sessions-archive:${project}::true`), undefined, 'no empty archive answer is cached while the walk waits')
  await sleep(450)
  await view.settle(); await view.settle()
  assert.equal(walks(), 1, 'the walk runs after the deferral')
  assert.deepEqual(ids(view.tree.sessions), ['local-1', 'stored-1'])
  await sleep(450)
  await view.settle()
  assert.equal(walks(), 1, 'one walk per expand, not two')
  view.unmount()

  // A remount (the row folded and unfolded, a tab switch) draws the last real answer at once ...
  const again = H.mount(Probe, { api, project })
  assert.deepEqual(ids(again.tree.sessions), ['local-1', 'stored-1'], 'the stored-only row is drawn from the kept answer')
  await again.settle()
  assert.deepEqual(ids(again.tree.sessions), ['local-1', 'stored-1'], 'and does not vanish while the walk waits')
  assert.equal(walks(), 1)
  // ... and walks once more after its own deferral.
  await sleep(450)
  await again.settle(); await again.settle()
  assert.equal(walks(), 2)
  assert.deepEqual(ids(again.tree.sessions), ['local-1', 'stored-1'])
  again.unmount()
})
