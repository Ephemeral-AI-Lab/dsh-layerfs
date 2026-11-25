// The Trajectory tab's paged reads: `since` keeps the answer on screen when the
// host says `unchanged`, a changed answer replaces it, and "Load older records"
// appends the next page. Mounted with the mini hook runtime; no DOM.
//   node --test test/trajectory-paging.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { miniReact } from './mini-react.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-trajectory-paging-'))
await build({
  absWorkingDir: root,
  stdin: {
    contents: [
      "export { mount, elements, text } from 'react'",
      "export { TrajectoryView } from './src/client/views/TrajectoryView.tsx'",
      "export { locales } from './src/client/views/locale.ts'",
    ].join('\n'),
    resolveDir: root, loader: 'tsx',
  },
  outfile: join(out, 'paging.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24', logLevel: 'error',
  jsx: 'automatic', loader: { '.module.css': 'local-css', '.css': 'css' }, plugins: [miniReact],
})
const M = await import(pathToFileURL(join(out, 'paging.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

const fill = (text, vars = {}) => String(text).replace(/\{(\w+)\}/g, (_, key) => String(vars[key] ?? ''))
const t = (key, vars) => {
  const text = M.locales.en[key]
  return text === undefined ? key : fill(text, vars)
}
const sessions = { getSnapshot: () => ({ byId: {} }), subscribe: () => () => {} }
const record = (seq, turn, text) => ({ kind: 'user', seq, turn, at: 1000 + seq, source: 'user', text })
const turn = (n, records, extra = {}) => ({ turn: n, at: 900 + n, records, orphanCalls: [], hostOps: [], checkpoints: [], ...extra })
const answerOf = (sessionId, revision, turns, extra = {}) => ({
  sessionId, project: 'st/p', branch: 'b1', turns, logLoaded: true, counts: { versionsCreated: 0, callsWithVersions: 0 }, revision, ...extra,
})

/** One page per request, in order; every request is recorded for the `since`/`before` assertions. */
function fakeApi(replies) {
  const calls = []
  const listeners = new Map()
  let index = 0
  return {
    calls,
    emit(name, data) { for (const listener of listeners.get(name) ?? []) listener(data) },
    api: {
      op: async (name, args) => {
        calls.push({ name, args })
        const reply = replies[Math.min(index++, replies.length - 1)]
        return typeof reply === 'function' ? reply(args) : reply
      },
      onEvent: (name, listener) => {
        const list = listeners.get(name) ?? []
        list.push(listener)
        listeners.set(name, list)
        return () => {}
      },
    },
  }
}
const mount = (api, sessionId) => M.mount(M.TrajectoryView, {
  api, sessionId, t, sessions, hideComposer: () => () => {},
})
const byLabel = (tree, label) => M.elements(tree).find((e) => typeof e.props?.onClick === 'function' && M.text(e).includes(label))
/** The record rows the table would render (mini-react does not call TableRow, so read its props). */
const recordRows = (tree) => M.elements(tree).flatMap((e) => e.props?.row?.type === 'record' ? [e.props.row.record] : [])
const recordedTexts = (tree) => recordRows(tree).map((record) => record.text)

test('an unchanged read keeps the rows on screen and sends the revision it holds', async () => {
  const sessionId = 'session-paging-unchanged'
  const first = answerOf(sessionId, 'r1', [turn(2, [record(20, 2, 'newest turn text')])], { recordTotal: 1 })
  const { api, calls } = fakeApi([first, { sessionId, revision: 'r1', unchanged: true }])

  const view = mount(api, sessionId)
  assert.deepEqual(recordedTexts(await view.settle()), ['newest turn text'])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].args.since, undefined, 'a tab opening without an answer has no revision to pass')
  view.unmount()

  const again = mount(api, sessionId)
  const tree = await again.settle()
  assert.equal(calls.length, 2)
  assert.equal(calls[1].args.since, 'r1', 'the revision of the answer it already has')
  assert.deepEqual(recordedTexts(tree), ['newest turn text'], 'the unchanged answer keeps the rows')
  assert.equal(recordRows(tree).length, 1, 'not an empty answer')
  again.unmount()
})

test('a new revision replaces the rows', async () => {
  const sessionId = 'session-paging-changed'
  const first = answerOf(sessionId, 'r1', [turn(2, [record(20, 2, 'old text')])], { recordTotal: 1 })
  const next = answerOf(sessionId, 'r2', [turn(3, [record(21, 3, 'new text')])], { recordTotal: 1 })
  const { api, calls } = fakeApi([first, next])

  const view = mount(api, sessionId)
  assert.deepEqual(recordedTexts(await view.settle()), ['old text'])
  view.unmount()

  const changed = mount(api, sessionId)
  const tree = await changed.settle()
  assert.equal(calls[1].args.since, 'r1')
  assert.deepEqual(recordedTexts(tree), ['new text'])
  changed.unmount()
})

test('"Load older records" asks for the before cursor and appends the older page', async () => {
  const sessionId = 'session-paging-older'
  const first = answerOf(sessionId, 'r1', [turn(3, [record(30, 3, 'newest turn text')], { totalRecords: 2 })], {
    recordTotal: 3, hasMore: true, olderBefore: 10,
  })
  const older = answerOf(sessionId, 'r1', [turn(1, [record(2, 1, 'oldest turn text')])], { recordTotal: 3 })
  const { api, calls } = fakeApi([first, older])

  const view = mount(api, sessionId)
  const before = await view.settle()
  assert.deepEqual(recordedTexts(before), ['newest turn text'])
  const button = byLabel(before, 'Load older records')
  assert.ok(button, 'the button appears when the answer says there is more')
  button.props.onClick()
  const tree = await view.settle()
  assert.equal(calls.at(-1).args.before, 10, 'the answer\'s oldest loaded seq')
  assert.deepEqual(recordedTexts(tree), ['oldest turn text', 'newest turn text'], 'the older page is appended under the first')
  assert.equal(byLabel(tree, 'Load older records'), undefined, 'the cursor is exhausted')
  view.unmount()
})

test('a reconnect reads whole, without the revision it holds', async () => {
  const sessionId = 'session-paging-reconnect'
  const first = answerOf(sessionId, 'r1', [turn(2, [record(20, 2, 'after reconnect')])], { recordTotal: 1 })
  const ctx = fakeApi([first])
  const view = mount(ctx.api, sessionId)
  await view.settle()
  assert.equal(ctx.calls[0].args.since, undefined)

  ctx.emit('connection', {})
  await new Promise((resolve) => setTimeout(resolve, 1100))
  const tree = await view.settle()
  assert.equal(ctx.calls.length, 2, 'the reconnect scheduled one read')
  assert.equal(ctx.calls[1].args.since, undefined, 'the feed may have missed events: read everything')
  assert.deepEqual(recordedTexts(tree), ['after reconnect'])
  view.unmount()
})
