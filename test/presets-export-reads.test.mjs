// B10: the Presets catalog is built once per input change (not per request) and
// the open dialog reads only while it is visible and focused; the Export dialog
// opens with one version read (the Branch's head and that Commit's header) and
// neither page calls the writing build-plan route.
//   node --test test/presets-export-reads.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { miniReact } from './mini-react.mjs'
import { loadRoutes, testHost } from './routes-helper.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-presets-export-reads-'))
await build({
  absWorkingDir: root,
  stdin: {
    contents: `
      export { PresetManager } from './src/host/presets/manager.ts'
      export { CONTENT_VERSION } from './src/host/presets/recipe/presets.js'
      export { mount, elements, text } from 'react'
      export { ExportDialog } from './src/client/exports/ExportDialog.tsx'
      export { Library, usePresets, PRESETS_POLL_MS, PRESETS_RUNNING_POLL_MS } from './src/client/presets/PresetsSection.tsx'
    `,
    resolveDir: root,
    loader: 'tsx',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  jsx: 'automatic',
  loader: { '.module.css': 'local-css', '.css': 'css' },
  outfile: join(out, 'reads.mjs'),
  plugins: [miniReact],
  logLevel: 'warning',
})
const M = await import(pathToFileURL(join(out, 'reads.mjs')).href)
const R = await loadRoutes()
test.after(() => rmSync(out, { recursive: true, force: true }))

function dirs() {
  const base = mkdtempSync(join(tmpdir(), 'dsh-b10-'))
  return { base, state: join(base, 'presets'), home: join(base, 'home') }
}

/** The manager's host: no sessions, no stores, no events beyond what a list needs. */
function fakeHost({ cli = '/nonexistent/layerfs', home, state } = {}) {
  const events = []
  return {
    events,
    host: {
      spec: () => ({ cli, home, bundle: null, daemon: null, state }),
      busy: () => [],
      boundSessions: () => [],
      dshProjects: () => [],
      forgetProject: async () => {},
      homeStores: async (also) => (also ?? []).map((name) => ({ name })),
      projectConversations: () => [],
      deleteProjectConversations: async () => [],
      emit: (type, data) => events.push({ type, data }),
    },
  }
}

// ---------------------------------------------------------------- Presets host

test('presets: a second identical catalog request builds nothing and answers the same bytes', () => {
  const d = dirs()
  try {
    const m = new M.PresetManager(fakeHost(d).host, d.state, d.home)
    const built = []
    const build = m.buildDefinition.bind(m)
    m.buildDefinition = (name, mode) => { built.push(name); return build(name, mode) }
    const first = m.list()
    assert.deepEqual(built, ['quickstart', 'studio'], 'the first read builds each preset once')
    built.length = 0
    const second = m.list()
    assert.equal(built.length, 0, 'no preset definition is regenerated')
    assert.equal(second.items, first.items, 'the catalog array itself is reused')
    assert.equal(second.items[0], first.items[0], 'and so is every preset object')
    assert.equal(JSON.stringify(second), JSON.stringify(first))
    // a single-preset read serves the catalog's own object too
    assert.equal(m.definition('studio'), first.items[1])
    assert.deepEqual(built, [])
  } finally { rmSync(d.base, { recursive: true, force: true }) }
})

test('presets: a manifest (build) change and a job change each invalidate the catalog', async () => {
  const d = dirs()
  try {
    const m = new M.PresetManager(fakeHost(d).host, d.state, d.home)
    const first = m.list()
    assert.deepEqual(first.items.map((p) => p.built), [false, false])
    // a Build's manifest lands in the state folder (the runner writes it): no event needed
    writeFileSync(join(d.state, 'demo-fixtures.json'), JSON.stringify({ tool: 'dsh-layerfs-presets', version: 1, preset: 'quickstart', homeId: 'h1', contentVersion: M.CONTENT_VERSION }))
    const afterManifest = m.list()
    assert.deepEqual(afterManifest.items.map((p) => p.built), [true, false], 'the built preset is the manifest\'s')
    assert.notEqual(afterManifest.items, first.items, 'the catalog was rebuilt')
    // a job move (its publish bumps the revision) invalidates again, including verify state
    const job = await m.resetEnvironment('quickstart', { requestId: 'b10-1', expectedPlan: 'x', confirm: true, rebuild: true, sandboxes: false })
    const during = m.list()
    assert.equal(during.items[0].job.id, job.id, 'the queued job shows at once')
    assert.equal(during.busy, true)
    assert.notEqual(during.items, afterManifest.items)
    await m.settle()
    const after = m.list()
    assert.equal(after.items[0].job.state, 'failed', 'this home is not initialized, so the build fails')
    assert.notEqual(after.items, during.items, 'the settled job rebuilt the catalog')
  } finally { rmSync(d.base, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------- Presets client

/** A mini-react harness: `usePresets` under stubbed document/window and a captured interval. */
function pollHarness() {
  const listeners = new Map()
  const state = { focused: true, hidden: false }
  const real = { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval }
  const intervals = []
  globalThis.setInterval = (fn, ms) => { const id = { fn, ms }; intervals.push(id); return id }
  globalThis.clearInterval = (id) => { const at = intervals.indexOf(id); if (at >= 0) intervals.splice(at, 1) }
  globalThis.document = {
    get visibilityState() { return state.hidden ? 'hidden' : 'visible' },
    hasFocus: () => state.focused,
    addEventListener: (type, fn) => { const set = listeners.get(type) ?? new Set(); set.add(fn); listeners.set(type, set) },
    removeEventListener: (type, fn) => { listeners.get(type)?.delete(fn) },
  }
  globalThis.window = {
    addEventListener: (type, fn) => { const set = listeners.get(`window:${type}`) ?? new Set(); set.add(fn); listeners.set(`window:${type}`, set) },
    removeEventListener: (type, fn) => { listeners.get(`window:${type}`)?.delete(fn) },
  }
  return {
    intervals,
    state,
    fire: (type) => { for (const fn of [...(listeners.get(type) ?? [])]) fn() },
    restore: () => {
      globalThis.setInterval = real.setInterval
      globalThis.clearInterval = real.clearInterval
      delete globalThis.document
      delete globalThis.window
    },
  }
}

test('presets page: one catalog read on mount, none while hidden or unfocused, one at once on return; never build-plan', async () => {
  const h = pollHarness()
  const calls = []
  const api = {
    call: async (method, path) => { calls.push(path); return { items: [], home: '/h', busy: false } },
    onEvent: () => () => {},
  }
  const Probe = ({ api: a }) => { M.usePresets(a); return null }
  const view = M.mount(Probe, { api })
  try {
    await view.settle()
    assert.deepEqual(calls, ['/api/demo-presets'], 'the mount reads the catalog once')
    assert.ok(!calls.some((p) => p.includes('build-plan')), 'the page never reads the writing build-plan route')
    assert.equal(h.intervals.length, 1)
    assert.equal(h.intervals[0].ms, M.PRESETS_POLL_MS, 'an idle page reads every 30 s, not every 5 s')

    // 30 s of a visible, focused page: the one tick reads once.
    h.intervals.at(-1).fn()
    await view.settle()
    assert.equal(calls.length, 2)

    // Hidden: the tick is a no-op and the transition back is the only read.
    h.state.hidden = true
    h.fire('visibilitychange')
    h.intervals.at(-1).fn()
    await view.settle()
    assert.equal(calls.length, 2, 'a hidden page reads nothing')
    h.state.hidden = false
    h.fire('visibilitychange')
    await view.settle()
    assert.equal(calls.length, 3, 'coming back reads at once')

    // Unfocused: same, and focus plus visibilitychange together read once.
    h.state.focused = false
    h.fire('window:blur')
    h.intervals.at(-1).fn()
    await view.settle()
    assert.equal(calls.length, 3, 'an unfocused page reads nothing')
    h.state.focused = true
    h.fire('window:focus')
    h.fire('visibilitychange')
    await view.settle()
    assert.equal(calls.length, 4, 'the focus event and the visibility event do not double-read')
  } finally {
    view.unmount()
    assert.equal(h.intervals.length, 0, 'closing the page clears its poll')
    h.restore()
  }
})

test('presets page: a selected library reads nothing on mount (Build fetches the plan on its own press)', async () => {
  const h = pollHarness()
  const calls = []
  const api = {
    call: async (method, path) => { calls.push(path); return {} },
    onEvent: () => () => {},
    openPanel: () => {},
    openSession: () => {},
  }
  const preset = {
    id: 'quickstart', description: 'x', built: false, contentReady: false, initialized: false,
    executionMode: 'filesystem', requirements: ['docker'], projects: 1, stores: 1, machines: ['docker'],
    home: '/h', state: '/s', lastBuild: null, settings: null, job: null,
    projectDefinitions: [{ store: 's', name: 'p', title: 'P', description: '', branches: [], history: { branches: 4, commits: 600 }, tier: null, cycles: 0, layers: 0, commands: 0, workspaceRevisions: 0, authoredRevisions: 0, sandboxLimit: 0, workspaceLimit: 0 }],
  }
  const data = { items: [preset], home: '/h', busy: false }
  const view = M.mount(M.Library, { api, t: (key) => key, data, preset, onRefresh: () => {} })
  try {
    await view.settle()
    assert.deepEqual(calls, [], 'opening the library reads nothing; the catalog is its caller\'s read')
    assert.ok(!calls.some((p) => p.includes('build-plan')), 'no build-plan on mount')
  } finally { view.unmount(); h.restore() }
})

test('presets page: a running job polls every 2 s (from the catalog it already has)', async () => {
  const h = pollHarness()
  const calls = []
  const job = { id: 'j', state: 'running', rebuild: true, preset: 'quickstart' }
  const api = {
    call: async (method, path) => { calls.push(path); return { items: [{ id: 'quickstart', job }], home: '/h', busy: true } },
    onEvent: () => () => {},
  }
  const Probe = ({ api: a }) => { M.usePresets(a); return null }
  const view = M.mount(Probe, { api })
  try {
    await view.settle()
    // mini-react keeps the first effect's timer on a re-render (a real React cleanup
    // clears it): the latest timer is the one that governs the open page.
    assert.equal(h.intervals.at(-1).ms, M.PRESETS_RUNNING_POLL_MS)
    assert.equal(M.PRESETS_RUNNING_POLL_MS, 2000)
  } finally { view.unmount(); h.restore() }
})

// ---------------------------------------------------------------- Export

const HEAD = 'a'.repeat(66)
const NOW = Date.parse('2026-11-25T10:00:00Z')
function exportFixture(lfs) {
  const root2 = mkdtempSync(join(tmpdir(), 'dsh-b10-export-'))
  const t = testHost({ lfs, root: root2, home: join(root2, 'home'), discovery: async () => ({ identity: {}, calls: [], commands: [], switches: [] }) })
  const groups = R.createGroups(t.host, async () => ({}))
  return { groups, http: (method, path) => R.handle(groups, { method, path }), close: () => rmSync(root2, { recursive: true, force: true }) }
}

test('export route: one branches read answers the head and its Commit header, no diff, same data as the two reads', async () => {
  const calls = []
  const lfs = {
    branch: { get: async (_p, branch) => ({ branch, commit: HEAD, base: null, forked_from: null }) },
    commit: {
      get: async (_p, ref) => { calls.push('commit.get'); return { commit: ref, message: 'second save', created_at: '2026-11-25T10:00:00.000Z', parent: null, size: 9 } },
      diff: async () => { calls.push('commit.diff'); return { items: [] } },
    },
  }
  const f = exportFixture(lfs)
  const key = encodeURIComponent('perf2/demo2')
  try {
    const one = await f.http('GET', `/api/projects/${key}/branches?branch=main&with=commit`)
    assert.equal(one.status, 200)
    assert.equal(one.body.commit, HEAD)
    assert.equal(one.body.item.id, HEAD)
    assert.equal(one.body.item.message, 'second save')
    assert.equal(one.body.item.at, NOW)
    assert.deepEqual(calls, ['commit.get'], 'one route, one Commit header read, no diff')

    // The old shape (Branch, then Commit detail) answers the same message and time.
    const branch = await f.http('GET', `/api/projects/${key}/branches?branch=main`)
    const detail = await f.http('GET', `/api/projects/${key}/history?branch=main&commit=${HEAD}`)
    assert.equal(branch.body.commit, one.body.commit)
    assert.equal(detail.body.item.message, one.body.item.message)
    assert.equal(detail.body.item.at, one.body.item.at)
  } finally { f.close() }

  // A Commit header that cannot be read leaves the Branch's head usable (the dialog
  // then falls back to its own Commit read, as it did before the combined route).
  const broken = exportFixture({ ...lfs, commit: { get: async () => { throw new Error('unreadable') }, diff: async () => ({ items: [] }) } })
  try {
    const answer = await broken.http('GET', `/api/projects/${key}/branches?branch=main&with=commit`)
    assert.equal(answer.status, 200)
    assert.equal(answer.body.commit, HEAD)
    assert.equal(answer.body.item, null)
  } finally { broken.close() }
})

test('export dialog: opens with one read, shows the same version, and starts no export', async () => {
  const calls = []
  const api = {
    call: async (method, path, body) => {
      calls.push({ method, path })
      assert.equal(method, 'GET', 'opening the dialog writes nothing')
      return { branch: 'main', commit: HEAD, item: { id: HEAD, branch: 'main', message: 'second save', at: NOW } }
    },
    op: async () => { throw new Error('the dialog reads no op') },
    onEvent: () => () => {},
  }
  const t = (key, params) => params && params.name ? `${key}:${params.name}` : key
  const view = M.mount(M.ExportDialog, { api, t, project: 'perf2/demo2', onClose: () => {} })
  try {
    await view.settle()
    await view.settle()
    assert.equal(calls.length, 1, 'the dialog opens with one read')
    assert.equal(calls[0].path, `/api/projects/${encodeURIComponent('perf2/demo2')}/branches?branch=main&with=commit`)
    assert.ok(calls.every((c) => c.method === 'GET'), 'no export is started (a start is a POST)')
    const version = M.elements(view.tree).find((e) => e.props && e.props['data-export-version'] !== undefined)
    assert.ok(version, 'the version line renders')
    assert.equal(version.props['data-export-version'], `main@${HEAD}`)
    const shown = M.text(version)
    assert.match(shown, /aaaaaaaa/, 'the short id')
    assert.match(shown, /second save/, 'the Commit message')

    // "Choose version…" opens the picker on the same version list (main's head),
    // from the same answer: no third read.
    const choose = M.elements(view.tree).find((e) => e.props && e.props['data-export-choose'] !== undefined)
    assert.ok(choose, 'the version picker button renders')
    choose.props.onClick()
    await view.settle()
    const history = M.elements(view.tree).find((e) => e.type && e.type.name === 'ProjectHistory')
    assert.ok(history, 'the picker renders the History view')
    assert.equal(history.props.initialBranch, 'main')
    assert.equal(history.props.initialCommit, HEAD)
    assert.equal(calls.length, 1, 'opening the picker reads nothing more')
  } finally { view.unmount() }
})
