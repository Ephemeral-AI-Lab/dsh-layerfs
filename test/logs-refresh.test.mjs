// The Logs page's refreshes during a run (src/client/logs/LogsPage.tsx): `logs`
// events (about one a second) are coalesced, 3 s for a filtered scan such as
// "Only writes", and none run while the page is hidden; a scan refresh first
// reads the log's newest line and rescans nothing when nothing was logged, else
// only what was logged since its last scan (the host's scan stops at `since`).
// The whole-log emptiness behind Reset and "Show reads" is learned again when
// the log changes instead of sticking.
//   node --test test/logs-refresh.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { miniReact } from './mini-react.mjs'
import { isWrite } from '../src/shared/logs.ts'
import { FILTER_BUDGET, readCalls } from '../src/host/logs/source.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-logs-refresh-'))
await build({
  absWorkingDir: root,
  stdin: {
    contents: [
      "export { mount, elements, text } from 'react'",
      "export { LogsPage } from './src/client/logs/LogsPage.tsx'",
      "export * from './src/client/logs/filters.ts'",
    ].join('\n'),
    resolveDir: root, loader: 'tsx',
  },
  outfile: join(out, 'logs.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24', logLevel: 'error',
  jsx: 'automatic', loader: { '.module.css': 'local-css', '.css': 'css' }, plugins: [miniReact],
})
const M = await import(pathToFileURL(join(out, 'logs.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

// ---------------------------------------------------------------- environment

const docListeners = new Map()
globalThis.window = { addEventListener() {}, removeEventListener() {}, getSelection: () => null }
globalThis.document = {
  visibilityState: 'visible',
  addEventListener(type, fn) { docListeners.set(type, fn) },
  removeEventListener(type) { docListeners.delete(type) },
}
/** The page's coalescing timers (500 ms / 3 s) are held for the test to fire. */
const held = new Map()
let nextId = 1
const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout, realSetInterval = globalThis.setInterval
globalThis.setTimeout = (fn, ms, ...rest) => {
  if (ms === M.SCAN_REFRESH_MS || ms === M.REFRESH_COALESCE_MS) { const id = `held-${nextId++}`; held.set(id, { fn, ms }); return id }
  return realSetTimeout(fn, ms, ...rest)
}
globalThis.clearTimeout = (id) => { if (held.has(id)) held.delete(id); else realClearTimeout(id) }
globalThis.setInterval = (fn, ms, ...rest) => (ms === 30_000 ? 0 : realSetInterval(fn, ms, ...rest))
test.after(() => {
  globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout; globalThis.setInterval = realSetInterval
  delete globalThis.window; delete globalThis.document
})
const fireHeld = () => { const all = [...held.values()]; held.clear(); for (const { fn } of all) fn(); return all.map((h) => h.ms) }

// ---------------------------------------------------------------- a fake host

let clock = 1_000_000
const line = (argv) => ({ v: 1, at: (clock += 1000), ms: 1, client: 'cli', argv, outcome: 'ok', tag: 'dsh:-:x' })
const readLine = () => line(['branch', 'list', 'demo/app'])
const writeLine = () => line(['file', 'write', 'demo/app', 'main', '/f'])

/** `logs.list` over `log` (oldest first), newest first, with the filters the page sends. */
function fakeHost(log) {
  const calls = []
  const listeners = new Map()
  const api = {
    op: async (name, args = {}) => {
      calls.push({ name, args })
      if (name !== 'logs.list') return {}
      let lines = [...log].reverse()
      if (args.writes) lines = lines.filter((l) => isWrite(l.argv))
      if (args.op) lines = lines.filter((l) => l.argv[0] === args.op)
      if (typeof args.since === 'number') lines = lines.filter((l) => l.at >= args.since)
      const limit = args.limit ?? 100
      return { lines: lines.slice(0, limit), has_more: lines.length > limit, skipped: 0, source: 'layerfs' }
    },
    onEvent(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(fn)
      return () => listeners.get(type)?.delete(fn)
    },
    openSession() {},
  }
  const emit = (type, data = {}) => { for (const fn of listeners.get(type) ?? []) fn({ type, data }) }
  return { api, calls, emit }
}

const t = (key) => key
async function settle(view) { for (let i = 0; i < 6; i++) await view.settle() }
const find = (tree, pred) => M.elements(tree).filter((e) => pred(e.props ?? {}, e))
const resetButton = (tree) => find(tree, (p) => p.children === 'reset' && typeof p.onClick === 'function')[0]
/** The table's rows: their lines. */
const rows = (tree) => find(tree, (p) => p.line && typeof p.rowKey === 'string').map((e) => e.props.line)
const showReads = (tree) => find(tree, (p) => p.children === 'showReads')
const scans = (calls) => calls.filter((c) => c.name === 'logs.list' && c.args.writes)
const probes = (calls) => calls.filter((c) => c.name === 'logs.list' && c.args.limit === 1 && !c.args.writes)

async function mountPage(log) {
  held.clear()
  document.visibilityState = 'visible'
  const host = fakeHost(log)
  const view = M.mount(M.LogsPage, { api: host.api, t, refreshKey: 0 })
  await settle(view)
  return { ...host, view }
}
/** Set a filter control, found by its label (`writesOnly`: the Only writes box; `op`: the operation menu). */
async function choose(view, label, value) {
  find(view.tree, (p) => p.label === label && typeof p.onChange === 'function')[0].props.onChange(value)
  await settle(view)
}

// ---------------------------------------------------------------- tests

test('filters: a scan is Only writes or a project search; its refresh window is 3 s', () => {
  assert.equal(M.scansLog(M.DEFAULT_FILTERS), false)
  assert.equal(M.scansLog({ ...M.DEFAULT_FILTERS, writes: true }), true)
  assert.equal(M.scansLog({ ...M.DEFAULT_FILTERS, project: ' demo ' }), true)
  assert.equal(M.scansLog({ ...M.DEFAULT_FILTERS, op: 'branch' }), false, 'a native filter is one CLI page')
  assert.equal(M.refreshDelay({ ...M.DEFAULT_FILTERS, writes: true }), 3_000)
  assert.ok(M.refreshDelay(M.DEFAULT_FILTERS) >= 500)
  // A known answer from before the log changed is asked again.
  assert.equal(M.emptyAction({ lines: 0, hasMore: false, unfiltered: false, tag: false, known: true, stale: true }), 'probe')
  assert.equal(M.emptyAction({ lines: 0, hasMore: false, unfiltered: false, tag: false, known: true, stale: false }), 'skip')
})

test('Only writes: a burst of logs events is one scan 3 s later, of only the new lines', async (t) => {
  const log = [writeLine(), ...Array.from({ length: 300 }, readLine)]
  const page = await mountPage(log)
  t.after(() => page.view.unmount())
  await choose(page.view, 'writesOnly', true)
  assert.equal(scans(page.calls).length, 1, 'the filter change scans once')
  page.calls.length = 0

  log.push(readLine(), readLine())
  for (let i = 0; i < 5; i++) page.emit('logs')
  await settle(page.view)
  assert.equal(page.calls.length, 0, 'no read per event: the events wait for one refresh')
  assert.deepEqual([...held.values()].map((h) => h.ms), [M.SCAN_REFRESH_MS], 'one 3 s window for the burst')

  fireHeld()
  await settle(page.view)
  assert.equal(probes(page.calls).length, 1, 'the newest line is read first')
  const scan = scans(page.calls)
  assert.equal(scan.length, 1, 'one scan for the burst')
  assert.equal(typeof scan[0].args.since, 'number', 'the scan reads only what was logged since the last one')
  assert.ok(scan[0].args.since > log[0].at, 'not the whole log')
  assert.deepEqual(rows(page.view.tree).map((l) => l.argv[1]), ['write'], 'the write that was shown stays')

  // Nothing logged since: the refresh rescans nothing.
  page.calls.length = 0
  page.emit('logs')
  fireHeld()
  await settle(page.view)
  assert.equal(probes(page.calls).length, 1)
  assert.equal(scans(page.calls).length, 0, 'nothing new could match: no scan')

  // A new write lands on top of what is shown.
  log.push(writeLine())
  page.calls.length = 0
  page.emit('logs')
  fireHeld()
  await settle(page.view)
  assert.equal(scans(page.calls).length, 1)
  assert.deepEqual(rows(page.view.tree).map((l) => l.at), [log.at(-1).at, log[0].at], 'newest first, the old write kept')
})

test('a hidden page does not refresh; it refreshes once when shown again', async (t) => {
  const page = await mountPage([readLine()])
  t.after(() => page.view.unmount())
  page.calls.length = 0
  document.visibilityState = 'hidden'
  page.emit('logs'); page.emit('logs')
  await settle(page.view)
  assert.equal(held.size, 0, 'no refresh is scheduled while hidden')
  assert.equal(page.calls.length, 0)
  document.visibilityState = 'visible'
  docListeners.get('visibilitychange')?.()
  assert.equal(held.size, 1, 'one refresh when it shows')
  fireHeld()
  await settle(page.view)
  assert.equal(page.calls.filter((c) => c.name === 'logs.list').length, 1)
})

test('Only writes on an empty log: new reads re-enable Reset and bring back "Show reads"', async (t) => {
  const log = []
  const page = await mountPage(log)
  t.after(() => page.view.unmount())
  await choose(page.view, 'writesOnly', true)
  assert.equal(resetButton(page.view.tree).props.disabled, true, 'an empty log has nothing to reset')
  assert.equal(showReads(page.view.tree).length, 0, 'nothing to show')

  log.push(readLine(), readLine(), readLine())
  page.emit('logs')
  fireHeld()
  await settle(page.view)
  assert.ok(!resetButton(page.view.tree).props.disabled, 'Reset follows the log as it is now')
  assert.equal(showReads(page.view.tree).length, 1, '"Show reads" offers the calls hidden by the filter')
})

test('a native filter on a log that is reset elsewhere learns that the log is empty', async (t) => {
  const log = [readLine(), readLine()]
  const page = await mountPage(log)
  t.after(() => page.view.unmount())
  await choose(page.view, 'op', 'file')
  assert.ok(!resetButton(page.view.tree).props.disabled, 'the log has lines, the filter shows none')

  log.length = 0
  page.emit('logs')
  fireHeld()
  await settle(page.view)
  assert.equal(resetButton(page.view.tree).props.disabled, true, 'the emptied log is learned again')
})

test('host: a filtered scan with a local since stops at the first older line', async () => {
  // 2000 reads, no writes; `home log` here has no --since, so the page's since is a local filter.
  const lines = Array.from({ length: 2000 }, (_, i) => ({ at: 10_000 - i, argv: ['branch', 'list', 'demo/app'] }))
  let cliCalls = 0
  const layerfs = {
    nativeLogs: async () => true,
    discovery: async () => ({ calls: [{ family: 'home', call: 'log', options: ['call', 'client', 'tag', 'outcome', 'limit', 'cursor'].map((name) => ({ name })) }] }),
    lfs: {
      home: {
        log: async ({ limit = 100, cursor } = {}) => {
          cliCalls++
          const start = cursor ? Number(cursor) : 0
          const page = lines.slice(start, start + limit)
          const next = start + page.length < lines.length ? String(start + page.length) : undefined
          return {
            items: page.map((l) => ({ logged_at: new Date(l.at).toISOString(), duration_ms: 1, client: 'cli', argv: l.argv, outcome: 'ok' })),
            ...(next ? { next_cursor: next } : {}), skipped: 0,
          }
        },
      },
    },
  }
  const answer = await readCalls(layerfs, { writes: true, since: 10_000 - 5, limit: 100 })
  assert.deepEqual(answer.lines, [])
  assert.equal(cliCalls, 1, `one page, not FILTER_BUDGET (${FILTER_BUDGET})`)
  assert.equal(answer.has_more, false)
  assert.ok(!answer.partial, 'the since search reached its end')
})
