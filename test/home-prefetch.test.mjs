// Home's first card is warm before the click: the sidebar warms the Store view,
// the catalogs and the visible projects' sessions through the shared host seam;
// the panel draws a prefetched answer on its first render while its own read on
// mount still starts (and joins a prefetch still in flight). The paint hint is
// bounded, used once, and dropped by the host events that can change the answer
// (a Store or project change, a session change, a connection drop); the share
// age and the read-on-mount contract are the ones the client already had.
//   node --test test/home-prefetch.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { miniReact } from './mini-react.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-home-prefetch-'))
await build({
  stdin: {
    contents: `
      export { mount, elements, text } from 'react'
      export * as P from './src/client/storage/prefetch.ts'
      export * as U from './src/client/ui/use-query.ts'
      export * as S from './src/client/storage/session-cache.ts'
      export * as H from './src/client/ui/paint-hints.ts'
      export * as A from './src/client/api.ts'
      export { useSessionLists, ProjectTable, ProjectGrid, EarlyCard } from './src/client/storage/ProjectTable.tsx'
    `,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  outfile: join(out, 'home.mjs'),
  absWorkingDir: root,
  loader: { '.module.css': 'empty', '.css': 'empty', '.svg': 'text' },
  plugins: [miniReact],
  logLevel: 'warning',
})
const M = await import(pathToFileURL(join(out, 'home.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function view(stores = [
  { name: 'perf', projects: ['demo'] },
  { name: 'perf2', projects: ['demo2', 'other'] },
]) {
  return {
    machines: [], buckets: [], jobs: [], at: 1,
    stores: stores.map((s) => ({ name: s.name, kind: 'sqlite', machine: 'native', projects: s.projects, projectsCount: s.projects.length, size: null, state: 'ready', links: [], job: null })),
  }
}

const session = (id) => ({ sessionId: id, title: id, local: true, updatedAt: 1 })

/** An api that records what the prefetch asks and answers with fixed data. */
function recordingApi(storeView) {
  const calls = []
  const api = {
    connected: () => true,
    call(method, path, body, options) {
      calls.push({ kind: 'call', method, path, options })
      return Promise.resolve(path === '/api/storage' ? storeView : path === '/api/projects' ? [] : {})
    },
    op(name, args, options) {
      calls.push({ kind: 'op', name, args, options })
      return Promise.resolve(name === 'sessions.list' ? { sessions: [session(args.project)] } : name === 'projects.catalog' ? { rows: [], scratchKey: null } : {})
    },
    onEvent: () => () => {},
  }
  return { api, calls }
}

/** A remote with answers per call; `hold` keeps one pending until the test settles it. */
function fakeRig(answers) {
  const state = { calls: [], held: [], emit: undefined }
  const remote = {
    call(request) {
      state.calls.push(request)
      const key = request.op === 'http' ? `http ${request.args.method} ${request.args.path}` : request.op
      const spec = answers[key] ?? { value: {} }
      if (spec.hold) {
        return new Promise((resolve) => {
          state.held.push({
            key,
            request,
            settle() { resolve({ ok: true, value: spec.value }) },
          })
        })
      }
      return Promise.resolve({ ok: true, value: spec.value })
    },
    events() {
      let ready = false
      const queue = []
      const waiters = []
      // The test's one hand on the host stream: a pushed event reaches the api's
      // dispatch exactly as the host's would (the first item is always `ready`).
      // Items are iterator results, so the api's unwrap sees `{ value: event }`.
      state.emit = (event) => {
        const item = { value: event }
        const waiter = waiters.shift()
        if (waiter) waiter(item)
        else queue.push(item)
      }
      return {
        [Symbol.asyncIterator]() {
          return {
            next: () => {
              if (!ready) { ready = true; return Promise.resolve({ value: { type: 'ready' } }) }
              const queued = queue.shift()
              if (queued) return Promise.resolve(queued)
              return new Promise((resolve) => waiters.push(resolve))
            },
          }
        },
        dispose() { state.emit = undefined },
      }
    },
  }
  return { state, remote: () => remote }
}

async function newApi(t, answers) {
  const rig = fakeRig(answers)
  const api = M.A.createApi(rig.remote, {
    createSession: async () => 'session-x',
    openPanel() {},
    openWorkspace: async () => {},
    openSession() {},
  }, () => undefined)
  t.after(() => api.dispose())
  for (let i = 0; i < 50 && !api.connected(); i++) await flush()
  assert.ok(api.connected(), 'the fake host is connected')
  return { api, ...rig }
}

const sends = (state, key) => state.calls.filter((call) => (call.op === 'http' ? `http ${call.args.method} ${call.args.path}` : call.op) === key)

test('the prefetch issues Home\'s reads through the shared background seam', async () => {
  M.P.resetHomePrefetch()
  const { api, calls } = recordingApi(view())
  await M.P.prefetchHome(api)
  const http = calls.filter((c) => c.kind === 'call').map((c) => c.path)
  assert.deepEqual(http, ['/api/storage', '/api/projects'], 'the Store view and Home\'s catalog are read')
  assert.ok(calls.some((c) => c.kind === 'op' && c.name === 'projects.catalog'), 'the picker catalog is read too')
  const sessions = calls.filter((c) => c.kind === 'op' && c.name === 'sessions.list')
  const local = sessions.filter((c) => c.args.localOnly === true).map((c) => c.args.project)
  assert.deepEqual(local, ['perf/demo', 'perf2/demo2', 'perf2/other'], 'each visible project\'s local list is warmed')
  const archive = sessions.filter((c) => c.args.localOnly === false).map((c) => c.args.project)
  assert.deepEqual(archive, ['perf/demo', 'perf2/demo2'], 'the first rows\' archives are warmed, bounded')
  assert.ok(calls.every((c) => c.options?.priority === 'background' && c.options?.share === true), 'every send is decoration that may share')
  const before = calls.length
  await M.P.prefetchHome(api)
  assert.equal(calls.length, before, 'a second intent inside the repeat window reuses the run')
})

test('a mount joins the prefetch in flight, then reads the host again after the share age', async (t) => {
  const storeView = view()
  const answers = {
    'http GET /api/storage': { hold: true, value: { status: 200, body: storeView } },
    'http GET /api/projects': { value: { status: 200, body: [] } },
    'projects.catalog': { value: { rows: [], scratchKey: null } },
    'sessions.list': { hold: true, value: { sessions: [session('perf/demo')] } },
  }
  const rig = await newApi(t, answers)
  // A failed assertion must not leave a held send keeping the run alive.
  t.after(() => { for (const held of rig.state.held) held.settle() })
  M.P.resetHomePrefetch()
  const run = M.P.prefetchHome(rig.api)
  await flush()
  assert.equal(sends(rig.state, 'http GET /api/storage').length, 1, 'the prefetch read the Store view once')

  // The panel's mount read (same path, share) joins the send already in flight.
  const mount = rig.api.call('GET', '/api/storage', undefined, { share: true })
  await flush()
  assert.equal(sends(rig.state, 'http GET /api/storage').length, 1, 'the mount joined, it did not re-read')
  rig.state.held.find((h) => h.key === 'http GET /api/storage').settle()
  await flush()
  assert.deepEqual(await mount, storeView, 'the joiner gets the prefetch answer')
  await flush()

  // The local session reads the prefetch started are shared the same way.
  const localKey = 'sessions.list'
  const localBefore = rig.state.calls.filter((c) => c.op === localKey && c.args.project === 'perf/demo' && c.args.localOnly).length
  assert.equal(localBefore, 1, 'the prefetch read the visible project\'s sessions')
  const joined = rig.api.op('sessions.list', { project: 'perf/demo', localOnly: true }, { share: true })
  await flush()
  assert.equal(rig.state.calls.filter((c) => c.op === localKey && c.args.project === 'perf/demo' && c.args.localOnly).length, 1, 'the table joined that send')
  for (const held of [...rig.state.held]) held.settle()
  await Promise.all([run, joined])

  // Freshness: the share window is still the client's 1 s, so a later read reaches the host.
  assert.equal(M.A.SHARE_MAX_AGE_MS, 1_000, 'the share age is unchanged')
  await new Promise((resolve) => setTimeout(resolve, 1_050))
  answers['http GET /api/storage'].hold = false
  rig.state.calls.length = 0
  await rig.api.call('GET', '/api/storage', undefined, { share: true })
  assert.equal(sends(rig.state, 'http GET /api/storage').length, 1, 'after the share age the mount read goes to the host')
})

test('the first render draws a prefetched answer; a stale hint is dropped and the read still runs', async () => {
  const first = view()
  M.U.keepPrefetched('test:home-card', first)
  let release
  const calls = []
  const api = {
    call() { calls.push(1); return new Promise((resolve) => { release = resolve }) },
    onEvent: () => () => {},
  }
  function Panel({ api }) {
    const q = M.U.useQuery(() => api.call(), [api], { cache: 'test:home-card' })
    return { type: 'panel', props: { view: q.data, loading: q.loading } }
  }
  const mounted = M.mount(Panel, { api })
  assert.equal(mounted.tree.props.view, first, 'the card has the prefetched view before its own read settles')
  assert.equal(mounted.tree.props.loading, true, 'the read on mount is still running')
  assert.equal(calls.length, 1, 'the read on mount still starts')
  const fresh = view([{ name: 'perf', projects: ['new'] }])
  release(fresh)
  await mounted.settle()
  assert.equal(mounted.tree.props.view, fresh, 'the fresh answer replaces the hint')
  mounted.unmount()

  // A hint older than the paint window is not drawn.
  const stale = view()
  M.U.keepPrefetched('test:stale', stale)
  const never = { call: () => new Promise(() => {}), onEvent: () => () => {} }
  const realNow = Date.now
  Date.now = () => realNow() + M.U.PREFETCH_PAINT_MAX_AGE_MS + 1
  let late
  try {
    function Late({ api }) {
      const q = M.U.useQuery(() => api.call(), [api], { cache: 'test:stale' })
      return { type: 'late', props: { view: q.data } }
    }
    late = M.mount(Late, { api: never })
  } finally { Date.now = realNow }
  assert.equal(late.tree.props.view, undefined, 'an expired hint does not paint')
  late.unmount()
})

test('the session lists the table draws are known before its own read settles', async () => {
  const rows = [session('local-1')]
  M.S.keepSessionList('perf/demo', rows)
  let release
  const calls = []
  const api = {
    op(name, args, options) { calls.push({ name, args, options }); return new Promise((resolve) => { release = resolve }) },
    onEvent: () => () => {},
  }
  function Rows({ api }) {
    const r = M.useSessionLists(api, ['perf/demo'])
    return { type: 'rows', props: { sessions: r.lists.get('perf/demo'), ready: r.ready } }
  }
  const mounted = M.mount(Rows, { api })
  assert.deepEqual(mounted.tree.props.sessions, rows, 'the row has its sessions on the first render')
  assert.equal(mounted.tree.props.ready, true)
  assert.equal(calls.length, 1, 'the table still reads its own list on mount')
  assert.equal(calls[0].options?.share, true, 'that read may join the prefetch')
  const fresh = { sessions: [session('local-2')] }
  release(fresh)
  await mounted.settle()
  assert.deepEqual(mounted.tree.props.sessions, fresh.sessions, 'the fresh list replaces the primed one')
  mounted.unmount()
})

test('an event between the prefetch and the mount drops the paint hints and the mount reads fresh', async (t) => {
  const before = view([{ name: 'perf', projects: ['demo', 'removed'] }])
  const after = view([{ name: 'perf', projects: ['demo'] }])
  const answers = {
    'http GET /api/storage': { value: { status: 200, body: before } },
    'http GET /api/projects': { value: { status: 200, body: [] } },
    'projects.catalog': { value: { rows: [], scratchKey: null } },
    'sessions.list': { value: { sessions: [session('old-session')] } },
  }
  const rig = await newApi(t, answers)
  const emit = async (event) => { rig.state.emit(event); await flush(); await flush() }

  M.H.forgetPaintHints()
  M.P.resetHomePrefetch()
  await M.P.prefetchHome(rig.api)
  assert.deepEqual(M.S.knownSessionList('perf/demo'), [session('old-session')], 'the prefetch primed the session list')

  // A project was removed after the prefetch and before the panel mounted; the
  // host announces it, and the answers the panel will read are the new ones.
  answers['http GET /api/storage'] = { value: { status: 200, body: after } }
  answers['sessions.list'] = { value: { sessions: [session('new-session')] } }
  await emit({ type: 'projects' })
  await emit({ type: 'storage' })
  assert.equal(M.S.knownSessionList('perf/demo'), undefined, 'the event dropped the primed session list')

  const calls = []
  const api = { ...rig.api, call: (...args) => { calls.push(args); return rig.api.call(...args) } }
  function Panel({ api }) {
    const q = M.U.useQuery(() => api.call('GET', '/api/storage', undefined, { share: true }), [api], { cache: 'GET /api/storage' })
    return { type: 'panel', props: { view: q.data, loading: q.loading } }
  }
  const panel = M.mount(Panel, { api })
  assert.equal(panel.tree.props.view, undefined, 'the first render after the event does not paint the removed project')
  assert.equal(panel.tree.props.loading, true, 'the mount starts its own read')
  await panel.settle()
  assert.equal(panel.tree.props.view, after, 'the fresh answer replaces the hint')
  assert.deepEqual(panel.tree.props.view.stores[0].projects, ['demo'], 'the removed project is not painted')
  assert.equal(calls.length, 1, 'the mount read the host')
  panel.unmount()

  // The session rows start from their own read too.
  function Rows({ api }) {
    const r = M.useSessionLists(api, ['perf/demo'])
    return { type: 'rows', props: { sessions: r.lists.get('perf/demo'), ready: r.ready } }
  }
  const rows = M.mount(Rows, { api: rig.api })
  assert.equal(rows.tree.props.sessions, undefined, 'the primed list does not paint after the event')
  assert.equal(rows.tree.props.ready, false, 'the row waits for its own read')
  await rows.settle()
  assert.deepEqual(rows.tree.props.sessions, [session('new-session')], 'its own read answers')
  rows.unmount()

  // A disconnect clears both, and a never-answering host proves the first render.
  M.U.keepPrefetched('test:conn-card', before)
  M.S.keepSessionList('perf/demo', [session('old-session')])
  await emit({ type: 'connection', data: { connected: false } })
  const never = { call: () => new Promise(() => {}), op: () => new Promise(() => {}), onEvent: () => () => {} }
  function Conn({ api }) {
    const q = M.U.useQuery(() => api.call(), [api], { cache: 'test:conn-card' })
    return { type: 'conn', props: { view: q.data } }
  }
  const conn = M.mount(Conn, { api: never })
  assert.equal(conn.tree.props.view, undefined, 'a disconnect drops the card hint')
  conn.unmount()
  const connRows = M.mount(Rows, { api: never })
  assert.equal(connRows.tree.props.sessions, undefined, 'a disconnect drops the session list hint')
  connRows.unmount()

  // The control: a hint kept after the last event still paints, so the event is
  // the only thing that changed.
  M.U.keepPrefetched('test:control', before)
  function Control({ api }) {
    const q = M.U.useQuery(() => api.call(), [api], { cache: 'test:control' })
    return { type: 'control', props: { view: q.data } }
  }
  const control = M.mount(Control, { api: never })
  assert.equal(control.tree.props.view, before, 'a hint kept since the last event still paints')
  control.unmount()
})

test('the first card paints what the row already knows, with no blank line', async () => {
  const row = {
    key: 'perf/demo',
    store: { name: 'perf', kind: 'sqlite' },
    p: { name: 'demo', created: null, totals: null, last: null, files: null, partial: true, building: null, error: null },
    boxes: [],
    sessions: [session('session-a'), session('session-b')],
    sizeRoute: { alone: true },
  }
  const card = M.mount(M.EarlyCard, { r: row, t: (key) => key, now: 10, onOpen: () => {} })
  const marked = M.elements(card.tree).find((el) => el?.props?.['data-project-card'] !== undefined)
  assert.equal(marked?.props['data-project-card'], 'demo', 'the card carries the project card mark')
  const words = M.text(card.tree)
  assert.match(words, /demo/, 'the name is known')
  assert.match(words, /perf/, 'the Store is known')
  assert.match(words, /2 ptSessions/, 'the primed sessions are known')
  assert.match(words, /spReading/, 'the figures it does not have yet say they are being read, not a blank')
  card.unmount()
})

test('the table shows the first card for a frame, then the full grid', async (t) => {
  const frames = []
  globalThis.requestAnimationFrame = (cb) => { frames.push(cb); return frames.length }
  globalThis.cancelAnimationFrame = () => {}
  t.after(() => { delete globalThis.requestAnimationFrame; delete globalThis.cancelAnimationFrame })
  const storeView = view()
  const api = { call: () => new Promise(() => {}), op: () => new Promise(() => {}), onEvent: () => () => {} }
  const table = M.mount(M.ProjectTable, {
    api, t: (key) => key, now: 1, tick: 0, query: '', sort: 'default', frozen: null,
    stores: storeView.stores, view: storeView, fleet: null, jobs: [], place: (m) => m ?? '',
    onOpen: () => {}, onRemove: () => {},
  })
  assert.notEqual(table.tree.type, M.ProjectGrid, 'the first render is the light card, not the wide grid')
  assert.equal(table.tree.props.r.key, 'perf/demo', 'it shows the first project the table already ordered')
  assert.equal(frames.length, 1, 'the full grid is queued for the next frame')
  frames.shift()()
  frames.shift()()
  await table.settle()
  assert.equal(table.tree.type, M.ProjectGrid, 'the grid replaces the card')
  assert.equal(table.tree.props.rows.length, 3, 'every project row is there')
  table.unmount()
})
