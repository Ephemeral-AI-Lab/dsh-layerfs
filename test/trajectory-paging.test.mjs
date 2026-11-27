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
      "export { TrajectoryTimeline } from './src/client/views/TrajectoryTimeline.tsx'",
      "export { TrajectoryInspector } from './src/client/views/TrajectoryInspector.tsx'",
      "export { HISTORY_VIEW } from './src/client/views/FileViews.tsx'",
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
const mount = (api, sessionId, extra = {}) => M.mount(M.TrajectoryView, {
  api, sessionId, t, sessions, hideComposer: () => () => {}, ...extra,
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

test('a windowed answer keeps its footer when a filter empties the rows', async () => {
  const sessionId = 'session-paging-window'
  const first = answerOf(sessionId, 'r1', [turn(3, [record(30, 3, 'newest turn text')])], {
    windowed: true, windowFromSeq: 1, recordTotalKnown: false, recordTotal: 402, hasMore: true, olderBefore: 10,
  })
  const { api, calls } = fakeApi([first])

  const view = mount(api, sessionId)
  let tree = await view.settle()
  assert.ok(M.text(tree).includes('402 in the loaded window'), 'the footer says the totals are a window')
  const search = M.elements(tree).find((element) => element.props?.type === 'search')
  assert.ok(search, 'the search input is on screen')
  search.props.onChange({ currentTarget: { value: 'no-such-record' } })
  tree = await view.settle()
  assert.equal(recordRows(tree).length, 0, 'the filter emptied the rows')
  assert.ok(M.text(tree).includes('402 in the loaded window'), 'the footer stays so the full history can still be loaded')
  const button = byLabel(tree, 'Load older records')
  assert.ok(button, 'the window footer\'s action is still there')
  button.props.onClick()
  assert.equal(calls.at(-1).args.before, 10, 'the same cursor')
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

test('Chat\'s inspect reads older pages until it finds the call', async () => {
  const sessionId = 'session-paging-focus'
  const tool = { kind: 'tool', seq: 5, turn: 1, at: 1005, callId: 'call-old', name: 'bash', summary: 'layerfs file list', ops: [] }
  const first = answerOf(sessionId, 'r1', [turn(3, [record(30, 3, 'newest turn')])], { recordTotal: 2, hasMore: true, olderBefore: 10 })
  const older = answerOf(sessionId, 'r1', [turn(1, [tool])], { recordTotal: 2 })
  const ctx = fakeApi([(args) => args.before === 10 ? older : first])

  const view = mount(ctx.api, sessionId, {
    viewRequest: { view: 'trajectory', focus: 'call-old' },
    completeViewRequest: () => {},
  })
  // Each render's effect starts the next read or selects the row: let the
  // page land, then let the selection render.
  await view.settle(); await view.settle(); const tree = await view.settle()
  assert.ok(ctx.calls.some((call) => call.args.before === 10), 'the older page was read')
  assert.deepEqual(recordRows(tree).map((record) => record.seq), [5, 30], 'the older call is on screen, under the newest turn')
  const row = M.elements(tree).find((e) => e.props?.row?.record?.seq === 5)
  assert.equal(row?.props.h.selected, 'r:5', 'the inspector opens on the found call')
  view.unmount()
})


test('a checkpoint tick outside the loaded turns opens History; a loaded one still selects it', async () => {
  const sessionId = 'session-checkpoint-tick'
  const base = { turn: 0, kind: 'base', commit: '12' + '0'.repeat(64), branch: 'b1', changed: 0, message: 'base', at: 900 }
  const loadedCommit = '12' + '2'.repeat(64)
  const loadedRow = { kind: 'turn', commit: loadedCommit, branch: 'b1', changed: 1, message: 'turn 2', at: 1002 }
  const loadedTurn = turn(2, [record(20, 2, 'newest turn text')], { checkpoints: [loadedRow] })
  const first = answerOf(sessionId, 'r1', [loadedTurn], { recordTotal: 1, checkpoints: [base, { ...loadedRow, turn: 2 }] })
  const { api } = fakeApi([first])
  const opened = []
  const view = mount(api, sessionId, { openView: (name, focus) => opened.push([name, focus]) })
  const tree = await view.settle()

  const timeline = M.elements(tree).find((element) => element.type === M.TrajectoryTimeline)
  assert.ok(timeline, 'the timeline is mounted')
  assert.equal(timeline.props.checkpoints.length, 2, 'the full set reaches the lane')
  timeline.props.onSelect('c:0:0')
  await view.settle()
  assert.deepEqual(opened, [[M.HISTORY_VIEW, JSON.stringify({ branch: 'b1', commit: base.commit })]],
    'the unloaded base tick opens History at its commit')

  timeline.props.onSelect('c:2:0')
  const after = await view.settle()
  assert.equal(opened.length, 1, 'a loaded turn does not navigate away')
  const inspector = M.elements(after).find((element) => element.type === M.TrajectoryInspector)
  assert.equal(inspector?.props.inspected?.kind, 'checkpoint')
  assert.equal(inspector?.props.inspected?.checkpoint.commit, loadedCommit, 'the loaded checkpoint is selected')
  view.unmount()
})

/** Waits out the view's event coalescing (REFRESH_MS), then lets the read land and its effects render. */
const refreshed = async (ctx, view, sessionId) => {
  ctx.emit('layerfs-operation', { sessionId })
  await new Promise((resolve) => setTimeout(resolve, 1100))
  await view.settle() // the tick starts the read
  await view.settle() // the answer renders
  return view.settle() // what its effects changed renders
}

test('loaded older pages stay while the running session\'s first page is read again', async () => {
  const sessionId = 'session-paging-older-kept'
  const pages = [
    answerOf(sessionId, 'r1', [turn(3, [record(30, 3, 'newest')], { totalRecords: 2 })], { recordTotal: 3, hasMore: true, olderBefore: 30 }),
    // The step's next record lands: a new first page, still starting at seq 30.
    answerOf(sessionId, 'r2', [turn(3, [record(30, 3, 'newest'), record(31, 3, 'newer still')], { totalRecords: 3 })], { recordTotal: 4, hasMore: true, olderBefore: 30 }),
    // More records: the first page's window moves past seq 30.
    answerOf(sessionId, 'r3', [turn(3, [record(31, 3, 'newer still'), record(32, 3, 'third')], { totalRecords: 4 })], { recordTotal: 5, hasMore: true, olderBefore: 31 }),
  ]
  const older = answerOf(sessionId, 'r1', [turn(1, [record(2, 1, 'oldest')])], { recordTotal: 3 })
  let next = 0
  const ctx = fakeApi([(args) => args.before !== undefined ? older : pages[Math.min(next++, pages.length - 1)]])

  const view = mount(ctx.api, sessionId)
  byLabel(await view.settle(), 'Load older records').props.onClick()
  let tree = await view.settle()
  assert.deepEqual(recordedTexts(tree), ['oldest', 'newest'])

  tree = await refreshed(ctx, view, sessionId)
  assert.equal(next, 2, 'the first page was read again')
  assert.deepEqual(recordedTexts(tree), ['oldest', 'newest', 'newer still'], 'the older page stays under the new first page')
  assert.equal(byLabel(tree, 'Load older records'), undefined, 'the cursor stays the older page\'s (exhausted)')

  tree = await refreshed(ctx, view, sessionId)
  assert.equal(next, 3)
  assert.deepEqual(recordedTexts(tree), ['oldest', 'newest', 'newer still', 'third'],
    'a record that left the first page is kept from the page before; nothing repeats')
  assert.equal(ctx.calls.filter((call) => call.args.before !== undefined).length, 1, 'no older page was read again')
  view.unmount()
})

test('Chat\'s inspect gives up after its page bound, and a later answer does not move the selection', async () => {
  const sessionId = 'session-paging-focus-bound'
  const tool = { kind: 'tool', seq: 5000, turn: 3, at: 6000, callId: 'call-late', name: 'bash', summary: 'layerfs file list', ops: [] }
  const first = answerOf(sessionId, 'r1', [turn(3, [record(4000, 3, 'newest turn')])], { hasMore: true, olderBefore: 4000 })
  // The same call lands in a much later first page, after the search gave up.
  const later = answerOf(sessionId, 'r2', [turn(3, [record(4000, 3, 'newest turn'), tool])], { hasMore: true, olderBefore: 4000 })
  let late = false
  /** Every older page has one more record and says there is still more. */
  const olderPage = (before) => answerOf(sessionId, 'r1', [turn(1, [record(before - 1, 1, `old ${before - 1}`)])], { hasMore: true, olderBefore: before - 1 })
  const ctx = fakeApi([(args) => args.before !== undefined ? olderPage(args.before) : late ? later : first])
  const view = mount(ctx.api, sessionId, {
    viewRequest: { view: 'trajectory', focus: 'call-late' },
    completeViewRequest: () => {},
  })
  const olderReads = () => ctx.calls.filter((call) => call.args.before !== undefined).length
  // Each settle lands one page and starts the next; stop once ten settles read nothing more.
  for (let i = 0, quiet = 0; i < 300 && quiet < 10; i++) {
    const before = olderReads()
    await view.settle()
    quiet = olderReads() === before ? quiet + 1 : 0
  }
  assert.equal(olderReads(), 40, 'the search read FOCUS_PAGES older pages, then stopped')

  late = true
  const tree = await refreshed(ctx, view, sessionId)
  assert.ok(recordRows(tree).some((r) => r.seq === 5000), 'the later answer with the call is on screen')
  const selected = M.elements(tree).find((e) => e.props?.h?.selected)
  assert.equal(selected?.props.h.selected ?? null, null, 'the abandoned request does not select the call later')
  assert.equal(olderReads(), 40, 'no more older pages were read')
  view.unmount()
})

test('a refused "Load older records" says so beside the button, and Retry reads it again', async () => {
  const sessionId = 'session-paging-older-refused'
  const first = answerOf(sessionId, 'r1', [turn(3, [record(30, 3, 'newest')])], { recordTotal: 2, hasMore: true, olderBefore: 30 })
  const older = answerOf(sessionId, 'r1', [turn(1, [record(2, 1, 'oldest')])], { recordTotal: 2 })
  let refuse = true
  const ctx = fakeApi([(args) => {
    if (args.before === undefined) return first
    if (refuse) throw Object.assign(new Error('the Store is busy'), { code: 'Busy' })
    return older
  }])
  const view = mount(ctx.api, sessionId)
  byLabel(await view.settle(), 'Load older records').props.onClick()
  let tree = await view.settle()
  const failure = M.elements(tree).find((e) => e.props?.title === M.locales.en.trajOlderFailed)
  assert.ok(failure, 'the refusal is on screen')
  assert.equal(failure.props.error?.message, 'the Store is busy', 'with LayerFS\'s words')
  assert.equal(typeof failure.props.onRetry, 'function', 'and one Retry')
  assert.ok(M.locales.zh.trajOlderFailed, 'the words are localized')

  refuse = false
  failure.props.onRetry()
  tree = await view.settle()
  assert.deepEqual(recordedTexts(tree), ['oldest', 'newest'], 'the retry loaded the page')
  assert.equal(M.elements(tree).find((e) => e.props?.title === M.locales.en.trajOlderFailed), undefined, 'the refusal is gone')
  view.unmount()
})
