// Host read caches, their invalidation and TTL bounds, and "no writes on reads"
// (docs/specs/backend-e2e-tests.md §4.1, findings C1 and H6), in process over a
// fake `lfs` that records every `family.call`. Time is t.mock.timers' Date.
//   node --test test/cache.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadRoutes, testHost } from './routes-helper.mjs'

const root = new URL('..', import.meta.url).pathname
const R = await loadRoutes()
// the real project catalog (assertProjectIdentity) and presets manager, bundled like the routes
const extraDir = mkdtempSync(join(tmpdir(), 'dsh-cache-test-'))
await build({
  absWorkingDir: root,
  stdin: { contents: "export { ProjectCatalog } from './src/host/sessions/catalog.ts'\nexport { PresetManager } from './src/host/presets/manager.ts'\nexport { presetStateFor } from './src/host/presets/state-dir.ts'\n", resolveDir: root, loader: 'ts' },
  outfile: join(extraDir, 'extra.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24', logLevel: 'warning',
})
const { ProjectCatalog, PresetManager, presetStateFor } = await import(pathToFileURL(join(extraDir, 'extra.mjs')).href)
test.after(() => rmSync(extraDir, { recursive: true, force: true }))

class Refusal extends Error {
  constructor(code, message, detail = null, transport = 'refusal') { super(message); Object.assign(this, { code, detail, transport }) }
}

/** Calls that change LayerFS state: none may run while answering a GET. */
const MUTATING = new Set([
  'branch.fork', 'branch.merge', 'branch.publish', 'branch.delete',
  'file.write', 'file.edit', 'file.rm', 'file.mkdir', 'file.mv', 'file.cp', 'file.apply',
  'store.create', 'store.remove', 'store.connect', 'store.attach', 'store.detach', 'store.push', 'store.pull', 'store.disconnect',
  'sandbox.create', 'sandbox.close',
  'workspace.mount', 'workspace.unmount', 'workspace.commit', 'workspace.exec', 'workspace.exec_cancel',
  'project.init', 'project.remove', 'project.export',
  'machine.start', 'machine.stop', 'machine.create', 'machine.remove', 'machine.update',
  'backup.create', 'backup.restore', 'backup.connect', 'backup.disconnect',
  'logs.reset',
])
/** The read calls (cli.ts READS plus workspace.status and logs.list): anything else a GET makes is suspect too. */
const READS = new Set(['list', 'get', 'status', 'platforms', 'images', 'stats', 'storage_report', 'commits', 'get_commit', 'read', 'stat', 'glob', 'grep', 'blame', 'diff', 'revision'])
const isRead = (call) => READS.has(call.split('.')[1]) && !MUTATING.has(call)

const L = `32${'a'.repeat(64)}`
const C1 = `c1${'1'.repeat(64)}`
const C2 = `c2${'2'.repeat(64)}`
const commit1 = { id: C1, branch: 'feat', parent: null, base: L, time: 1, message: 'one', new_canonical: 1, new_stored: 1, new_metadata: 1, logical: 3 }
const commit2 = { id: C2, branch: 'feat', parent: C1, time: 2, message: 'two', new_canonical: 2, new_stored: 2, new_metadata: 1, logical: 4 }

/**
 * A fake LayerFS home (machines native + lima1, Store s1 with projects p and q,
 * Branch feat with two Commits, Sandbox box1 with Workspace box1:w) behind a
 * Proxy that records `family.call` with its args. `gate` holds sandbox.get until
 * released; `sandboxBusy` makes it refuse Busy.
 */
function fakeLayerfs() {
  const state = {
    calls: [],
    stores: [{ name: 's1', machine: 'native', kind: 'sqlite', projects: ['p', 'q'], state: 'idle' }],
    storeState: 'idle',
    sandboxBusy: false,
    gate: null,
  }
  const project = (key) => ({ project: key, store: key.split('/')[0], name: key.split('/')[1], kind: 'sqlite', machine: 'native', created: 100 })
  const projects = () => state.stores.flatMap((s) => s.projects.map((p) => project(`${s.name}/${p}`)))
  const branches = { main: { name: 'main', base: L }, feat: { name: 'feat', head: C2, base: L, forked_from: L } }
  const impl = {
    project: {
      list: async () => ({ items: projects(), next_page_pos: null }),
      get: async (key) => { const p = projects().find((x) => x.project === key); if (!p) throw new Refusal('NoSuchProject', `no project ${key}`); return p },
      stats: async () => ({ logical: 3, files: 1, directories: 1, complete: true }),
      init: async (key) => project(key),
      remove: async () => ({}),
    },
    branch: {
      list: async () => ({ items: Object.values(branches), next_page_pos: null }),
      get: async (_p, name) => { if (!branches[name]) throw new Refusal('NoSuchBranch', `no branch ${name}`); return branches[name] },
      commits: async () => ({ items: [commit2, commit1], has_more: false }),
      get_commit: async (_p, _b, id) => [commit1, commit2].find((c) => c.id === id) ?? commit2,
      diff: async () => ({ items: [], next_cursor: null }),
      fork: async () => ({}),
    },
    commit: { diff: async () => ({ items: [{ path: '/a.txt', kind: 'Modified' }], next_cursor: null }) },
    file: {
      list: async () => ({ items: [{ name: 'a.txt', path: '/a.txt', type: 'file', size: 3 }], has_more: false }),
      stat: async () => ({ size: 3, mode: 420 }),
      read: async () => ({ text: 'abc', start_line: 1, end_line: 1 }),
      blame: async () => ({ items: [] }),
      revision: async () => ({ items: [] }),
      diff: async () => ({ items: [] }),
    },
    store: {
      list: async () => ({ items: state.stores.map((s) => ({ ...s })) }),
      status: async () => ({ state: state.storeState, file: { exists: true, bytes: 100, wal_bytes: 5 }, holders: [] }),
      stats: async () => ({ kind: 'sqlite', canonical: 10, stored: 10, metadata: 1, history_logical: 10, store_id: 'id1', store_generation: 1 }),
      get: async (name) => ({ ...(state.stores.find((s) => s.name === name) ?? { name }) }),
      create: async (name) => { state.stores.push({ name, machine: 'native', kind: 'sqlite', projects: [], state: 'idle' }); return {} },
    },
    machine: {
      list: async () => ({ machines: [{ name: 'native', platform: 'native', state: 'ready' }, { name: 'lima1', platform: 'lima', state: 'stopped' }] }),
      platforms: async () => ({ host: 'macos', platforms: [{ platform: 'lima', ready: true, options: [] }] }),
      status: async (name) => ({ name, state: 'stopped', free_disk: 10 }),
      get: async (name) => ({ name, platform: name === 'native' ? 'native' : 'lima', state: 'ready', daemon: '/fake/daemon' }),
      images: async (name) => ({ machine: name, mode: 'cached', default_digest: null, images: [] }),
    },
    sandbox: {
      list: async () => ({ items: [{ name: 'box1', project: 's1/p', state: 'ready', machine: 'native' }], next_page_pos: null }),
      get: async (name) => {
        if (state.gate) await state.gate.promise
        if (state.sandboxBusy) throw new Refusal('Busy', `${name} is busy`, { op: { name: 'workspace.mount' } })
        return { name, project: 's1/p', state: 'ready', machine: 'native', workspaces: [{ ws: `${name}:w`, name: 'w', branch: 'feat', directory: '/tmp/w' }], next_page_pos: null }
      },
      close: async (name) => ({ kind: 'Closed', closed: name }),
    },
    workspace: {
      status: async () => ({ dirty: false }),
      mount: async (sandbox) => ({ ws: `${sandbox}:w2` }),
      unmount: async () => ({ kind: 'Unmounted' }),
      commit: async () => ({ id: C2 }),
    },
    backup: { list: async () => ({ items: [] }) },
  }
  const lfs = new Proxy({ spec: { cli: '/fake/layerfs', home: '/fake/home' } }, {
    get(target, family) {
      if (family in target) return target[family]
      if (typeof family !== 'string' || family === 'then') return undefined
      return new Proxy({}, {
        get(_t, call) {
          if (typeof call !== 'string' || call === 'then') return undefined
          return async (...args) => {
            state.calls.push({ call: `${family}.${call}`, args })
            const fn = impl[family]?.[call]
            if (!fn) throw new Refusal('Unsupported', `fake has no ${family}.${call}`)
            return fn(...args)
          }
        },
      })
    },
  })
  return { lfs, state, count: (call) => state.calls.filter((c) => c.call === call).length }
}

const discoveryOf = (calls = []) => async () => ({ identity: { version: '2.0.0-test', commit: 'a'.repeat(40), dirty: false, features: [] }, calls, commands: [], switches: [] })

/** Route groups over a fresh fake home. */
function setup(t, { discovery = discoveryOf() } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cache-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const fake = fakeLayerfs()
  const host = testHost({ lfs: fake.lfs, root: join(dir, 'root'), home: join(dir, 'home'), discovery })
  const groups = R.createGroups(host.host, async () => ({ ok: true, version: '2.0.0-test' }))
  t.after(() => groups.projects.close())
  const http = (method, path, body) => R.handle(groups, { method, path, body })
  return { ...fake, dir, host, groups, http }
}

const P = encodeURIComponent('s1/p')
const flush = () => new Promise((resolve) => setImmediate(resolve))

// ---------------------------------------------------------------- hits

// §4.1 Hits: the project list joins the Storage view (store.list …) at most once per 15 s (JOIN_MS).
test('two project lists within 15 s read the Store join once', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const f = setup(t)
  const a = await f.http('GET', '/api/projects')
  assert.equal(a.status, 200)
  assert.deepEqual(a.body.map((p) => [p.key, p.storeState]), [['s1/p', 'idle'], ['s1/q', 'idle']])
  t.mock.timers.tick(10_000)
  await f.http('GET', '/api/projects')
  assert.equal(f.count('project.list'), 2, 'the project records themselves are read each time')
  assert.equal(f.count('store.list'), 1, 'the joined Storage view is reused within 15 s')
  assert.equal(f.count('store.status'), 1)
})

// §4.1 Hits: machine.platforms is answered from a 30 s cache.
test('two platform reads within 30 s make one machine.platforms', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const f = setup(t)
  assert.equal((await f.http('GET', '/api/platforms')).status, 200)
  t.mock.timers.tick(20_000)
  const again = await f.http('GET', '/api/platforms')
  assert.deepEqual(again.body.platforms.map((p) => p.platform), ['lima'])
  // the machines view reads platforms through the same cache
  await f.http('GET', '/api/machines')
  assert.equal(f.count('machine.platforms'), 1)
})

// §4.1 Hits: parallel reads of one Sandbox share the sandbox.get in flight.
test('two parallel Sandbox reads make one sandbox.get', async (t) => {
  const f = setup(t)
  f.state.gate = Promise.withResolvers()
  const both = Promise.all([f.http('GET', '/api/sandboxes/box1'), f.http('GET', '/api/sandboxes/box1')])
  for (let i = 0; i < 5; i++) await flush()
  f.state.gate.resolve()
  f.state.gate = null
  const [a, b] = await both
  assert.equal(a.status, 200)
  assert.deepEqual(b.body, a.body)
  assert.deepEqual(a.body.workspaces.map((w) => w.ws), ['box1:w'])
  assert.equal(f.count('sandbox.get'), 1)
})

// §4.1 Hits: concurrent reads that need the Storage view (the project list's join and the
// Storage page) share one store.list; a Store write in between makes the next read anew.
test('parallel project list and Storage reads make one store.list; a write reads anew', async (t) => {
  const f = setup(t)
  const [a, b, c] = await Promise.all([f.http('GET', '/api/projects'), f.http('GET', '/api/storage'), f.http('GET', '/api/storage')])
  assert.deepEqual([a.status, b.status, c.status], [200, 200, 200])
  assert.equal(f.count('store.list'), 1, 'one Storage view for all three')
  const created = await f.http('POST', '/api/stores', { name: 's2' })
  assert.equal(created.status, 200)
  assert.equal(f.count('store.list'), 2, 'the write reads the view anew')
  assert.ok(created.body.stores.some((s) => s.name === 's2'))
})

// §4.1 Hits: concurrent machines views (the sidebar, the machines store, a dialog) share one read;
// a GET after a write does not join a read started before it.
test('parallel machines views make one machine.list; a write reads anew', async (t) => {
  const f = setup(t)
  const [a, b] = await Promise.all([f.http('GET', '/api/machines'), f.http('GET', '/api/machines')])
  assert.equal(a.status, 200)
  assert.deepEqual(b.body, a.body)
  assert.equal(f.count('machine.list'), 1)
  const first = f.http('GET', '/api/machines')
  await f.http('POST', '/api/machines/lima1/start')
  const second = f.http('GET', '/api/machines')
  await Promise.all([first, second])
  assert.equal(f.count('machine.list'), 3, 'the GET after the start read anew')
})

// §4.1 Hits (finding 1): History reads a Branch at its head with its fork point from the Branch
// list: no branch.get, and a page read at a named Commit is kept (it never changes).
test('history pages read at a head skip branch.get and are kept', async (t) => {
  const f = setup(t)
  const path = `/api/projects/${P}/history?branch=feat&at=${C2}&fork=${L}`
  const a = await f.http('GET', path)
  assert.equal(a.status, 200)
  assert.deepEqual(a.body.items.map((c) => c.id), [C2, C1])
  assert.equal(f.count('branch.get'), 0, 'the fork point came from the caller')
  const b = await f.http('GET', path)
  assert.deepEqual(b.body, a.body)
  assert.equal(f.count('branch.commits'), 1, 'the page at a named head is kept')
  // without a head the Branch may have moved: read again
  await f.http('GET', `/api/projects/${P}/history?branch=feat&fork=${L}`)
  await f.http('GET', `/api/projects/${P}/history?branch=feat&fork=${L}`)
  assert.equal(f.count('branch.commits'), 3)
})

// §4.1 Hits: a Commit's changed paths are kept (a Commit never changes): repeated branch-commits make no new commit.diff.
test('repeated branch-commits reuse each Commit\'s changed paths', async (t) => {
  const f = setup(t)
  const a = await f.http('GET', `/api/projects/${P}/branch-commits?branch=feat&branch=main`)
  assert.equal(a.status, 200)
  assert.deepEqual(a.body.main, [])
  assert.deepEqual(a.body.feat.map((c) => [c.id, c.changes]), [[C2, [{ path: '/a.txt', kind: 'modified' }]], [C1, [{ path: '/a.txt', kind: 'modified' }]]])
  assert.equal(f.count('commit.diff'), 2)
  const b = await f.http('GET', `/api/projects/${P}/branch-commits?branch=feat`)
  assert.deepEqual(b.body.feat, a.body.feat)
  await f.http('GET', `/api/projects/${P}/commits?branch=feat`)
  assert.equal(f.count('commit.diff'), 2, 'no commit.diff for a Commit already compared')
})

// §4.1 Hits: discovery runs once per CLI path (cli.ts `discover`), not per call.
test('discovery runs once per CLI path', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cache-disc-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { cli, log } = fakeCli(dir)
  const [a, b] = await Promise.all([R.cli.discover({ cli }), R.cli.discover({ cli })])
  await R.cli.discover({ cli })
  assert.equal(a, b)
  assert.deepEqual(readLog(log).map((argv) => argv.join(' ')), ['--version --json', 'help --json'])
})

// ---------------------------------------------------------------- invalidation

// §4.1 Invalidation: a Store write refreshes the joined view, so the next project list shows it without waiting 15 s.
test('creating a Store refreshes the project list\'s Store join', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const f = setup(t)
  await f.http('GET', '/api/projects')
  // store.list's item carries the state the view shows
  f.state.stores[0].state = 'busy'
  t.mock.timers.tick(1_000)
  assert.equal((await f.http('POST', '/api/stores', { name: 'new1' })).status, 200)
  const after = await f.http('GET', '/api/projects')
  assert.deepEqual(after.body.map((p) => p.storeState), ['busy', 'busy'], 'the write\'s fresh view is joined, not the cached one')
  assert.equal(f.count('store.list'), 2, 'one read before, one by the write; the list after it reuses that')
  const storage = await f.http('GET', '/api/storage')
  assert.ok(storage.body.stores.some((s) => s.name === 'new1'))
})

// H6: every Sandbox write (mount, unmount, commit, close) clears the cached Busy refusal, so the next read asks again.
for (const [label, write] of [
  ['mount', (http) => http('POST', '/api/sandboxes/box1/workspaces', { branch: 'feat' })],
  ['unmount', (http) => http('DELETE', '/api/workspaces/box1:w')],
  ['commit', (http) => http('POST', '/api/workspaces/box1:w/commit', { message: 'save' })],
  ['close', (http) => http('DELETE', '/api/sandboxes/box1')],
]) {
  test(`a Sandbox ${label} clears its cached Busy`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
    const f = setup(t)
    f.state.sandboxBusy = true
    assert.equal((await f.http('GET', '/api/sandboxes/box1')).status, 409)
    t.mock.timers.tick(1_000)
    const cached = await f.http('GET', '/api/sandboxes/box1')
    assert.equal(cached.status, 409)
    assert.equal(cached.body.code, 'Busy')
    assert.equal(f.count('sandbox.get'), 1, 'a Busy refusal answers again without a call')
    f.state.sandboxBusy = false
    const w = await write(f.http)
    assert.equal(w.status, 200, JSON.stringify(w.body))
    const fresh = await f.http('GET', '/api/sandboxes/box1')
    assert.equal(fresh.status, 200)
    assert.equal(f.count('sandbox.get'), 2, `the ${label} made the next read ask LayerFS again`)
  })
}

// H6: a write while a read is in flight drops that read, so a read after the write is not answered by the stale one.
test('a mount during a Sandbox read makes the next read a new sandbox.get', async (t) => {
  const f = setup(t)
  f.state.gate = Promise.withResolvers()
  const first = f.http('GET', '/api/sandboxes/box1')
  for (let i = 0; i < 5; i++) await flush()
  assert.equal(f.count('sandbox.get'), 1)
  assert.equal((await f.http('POST', '/api/sandboxes/box1/workspaces', { branch: 'feat' })).status, 200)
  const second = f.http('GET', '/api/sandboxes/box1')
  for (let i = 0; i < 5; i++) await flush()
  f.state.gate.resolve()
  f.state.gate = null
  await Promise.all([first, second])
  assert.equal(f.count('sandbox.get'), 2)
})

// ---------------------------------------------------------------- TTL bounds

// §4.1 TTL bounds: Store join (15 s), platforms (30 s) and a cached Busy (BUSY_MS 30 s): cached at TTL − 1 ms, asked at TTL.
test('TTL bounds: cached at TTL − 1 ms, read again at TTL', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const f = setup(t)
  const bound = async (read, call, ttl) => {
    const start = f.count(call)
    await read()
    assert.equal(f.count(call), start + 1, `${call}: first read`)
    t.mock.timers.tick(ttl - 1)
    await read()
    assert.equal(f.count(call), start + 1, `${call}: cached at ${ttl - 1} ms`)
    t.mock.timers.tick(1)
    await read()
    assert.equal(f.count(call), start + 2, `${call}: read again at ${ttl} ms`)
  }
  await bound(() => f.http('GET', '/api/projects'), 'store.list', 15_000)
  await bound(() => f.http('GET', '/api/platforms'), 'machine.platforms', 30_000)
  f.state.sandboxBusy = true
  await bound(() => f.http('GET', '/api/sandboxes/box1'), 'sandbox.get', 30_000)
})

// ---------------------------------------------------------------- no writes on reads

/** A recording fake CLI for the paths that spawn it directly (doctor, presets): argv lines in `log`. */
function fakeCli(dir) {
  const cli = join(dir, 'fake-layerfs.cjs'), log = join(dir, 'fake-layerfs.log')
  const required = ['project.init', 'project.list', 'project.get', 'project.export', 'branch.fork', 'branch.list', 'branch.commits', 'commit.diff',
    'file.read', 'file.list', 'file.apply', 'sandbox.create', 'sandbox.get', 'sandbox.close', 'workspace.mount', 'workspace.commit', 'workspace.status',
    'workspace.unmount', 'workspace.exec', 'machine.list', 'machine.platforms', 'machine.get', 'store.list', 'store.create', 'store.get']
  const help = { calls: required.map((k) => ({ family: k.split('.')[0], call: k.split('.')[1], args: [], options: [] })), commands: [{ name: 'doctor', args: [], options: [] }], switches: [] }
  writeFileSync(cli, `#!${process.execPath}
const { appendFileSync, existsSync, writeFileSync } = require('node:fs')
const argv = process.argv.slice(2)
appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + '\\n')
const out = (v) => process.stdout.write(JSON.stringify(v) + '\\n')
if (argv[0] === '--version') out({ version: '2.0.0-test', commit: '${'b'.repeat(40)}', dirty: false, features: ['machine'] })
else if (argv[0] === 'help') out(${JSON.stringify(help)})
else if (argv[0] === 'doctor') out({ ok: true, findings: [] })
else if (argv[1] === 'list') out({ items: [], machines: [], next_page_pos: null })
else if (argv[1] === 'platforms') out({ host: 'macos', platforms: [] })
else if (argv[1] === 'get') out({ name: argv[argv.indexOf('--') + 1] ?? argv[2], state: 'ready' })
else out({})
`, { mode: 0o700 })
  return { cli, log }
}
const readLog = (log) => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []

/**
 * Every GET route of router.ts's `route()`, as `group[/:id|/literal][/sub]`,
 * read from its source so a new GET route fails the coverage check below.
 */
function routerGets() {
  const src = readFileSync(join(root, 'src/host/routes/router.ts'), 'utf8')
  const body = src.slice(src.indexOf('export async function route('), src.indexOf('export async function handle('))
  const sigs = new Set()
  let block = null, noId = false, projectGets = false
  for (const line of body.split('\n')) {
    const indent = /^ */.exec(line)[0].length
    if (indent === 2 && /^\s*if \(/.test(line)) {
      block = /^\s*if \(group === '([\w-]+)'(?: && !sub)?\) \{\s*$/.exec(line)?.[1] ?? null
      noId = false
      projectGets = false
    }
    if (/^\s*if \(!id\) \{/.test(line)) { noId = true; continue }
    if (noId && indent === 4 && /^\s*\}/.test(line)) { noId = false; continue }
    if (line.includes("method !== 'GET'")) { projectGets = true; continue }
    if (line.includes("'demo-presets'")) continue
    const projectSub = projectGets && /^\s*if \(sub === '([\w-]+)'\)/.exec(line)
    if (!line.includes("method === 'GET'") && !projectSub) continue
    const group = /group === '([\w-]+)'/.exec(line)?.[1] ?? block
    let id = /\bid === '([\w-]+)'/.exec(line)?.[1]
    if (id === undefined) id = /!id\b/.test(line) || noId ? '' : /\bid &&/.test(line) || group === 'projects' ? ':id' : ''
    const sub = /sub === '([\w-]+)'/.exec(line)?.[1] ?? ''
    sigs.add([group, id, sub].filter(Boolean).join('/'))
  }
  return sigs
}

/** One or more plausible requests per GET route (keep in sync: the test fails when router.ts gains a GET route). */
const GETS = [
  ['doctor-jobs', '/api/doctor-jobs'],
  ['doctor-jobs/:id', '/api/doctor-jobs/job-x'],
  ['storage', '/api/storage'],
  ['stores/:id/stats', '/api/stores/s1/stats'],
  ['stores/:id/observations', '/api/stores/s1/observations'],
  ['buckets/:id/files', '/api/buckets/b1/files'],
  ['storage-jobs/:id', '/api/storage-jobs/job-x'],
  ['doctor', '/api/doctor'],
  ['platforms', '/api/platforms'],
  ['machines', '/api/machines'],
  ['machines/:id/inspect', '/api/machines/lima1/inspect'],
  ['machines/:id/images', '/api/machines/lima1/images'],
  ['status', '/api/status'],
  ['projects', '/api/projects'],
  ['projects/:id', `/api/projects/${P}`],
  ['projects/:id/history', `/api/projects/${P}/history`],
  ['projects/:id/history', `/api/projects/${P}/history?branch=feat`],
  ['projects/:id/history', `/api/projects/${P}/history?branch=feat&commit=${C2}`],
  ['projects/:id/storage', `/api/projects/${P}/storage`],
  ['projects/:id/storage', `/api/projects/${P}/storage?refresh=1`],
  ['projects/:id/branches', `/api/projects/${P}/branches`],
  ['projects/:id/branches', `/api/projects/${P}/branches?branch=feat`],
  ['projects/:id/file-query', `/api/projects/${P}/file-query?branch=feat&path=/a.txt&kind=blame`],
  ['projects/:id/file-query', `/api/projects/${P}/file-query?branch=feat&path=/a.txt&kind=revisions`],
  ['projects/:id/file-query', `/api/projects/${P}/file-query?branch=feat&path=/a.txt&kind=compare`],
  ['projects/:id/file-query', `/api/projects/${P}/file-query?branch=feat&path=/a.txt&kind=attribution`],
  ['projects/:id/file-query', `/api/projects/${P}/file-query?branch=feat&path=/&kind=branch-diff&rightBranch=main`],
  ['projects/:id/stats', `/api/projects/${P}/stats`],
  ['projects/:id/commits', `/api/projects/${P}/commits?branch=feat`],
  ['projects/:id/branch-commits', `/api/projects/${P}/branch-commits?branch=feat&branch=main`],
  ['projects/:id/sandboxes', `/api/projects/${P}/sandboxes`],
  ['projects/:id/fs', `/api/projects/${P}/fs?branch=feat&path=/`],
  ['projects/:id/file', `/api/projects/${P}/file?branch=feat&path=/a.txt`],
  ['sandboxes/:id', '/api/sandboxes/box1'],
  ['sandboxes/:id/commands', '/api/sandboxes/box1/commands'],
  ['workspaces/:id/commands', '/api/workspaces/box1:w/commands'],
  ['workspaces/:id/status', '/api/workspaces/box1:w/status'],
  ['project-inits', '/api/project-inits'],
  ['project-inits/:id', '/api/project-inits/init-x'],
]
/** The presets manager's GET routes (manager.ts `route`), dispatched by router.ts under /api/demo-presets. */
const PRESET_GETS = ['', '/requests/r1', '/jobs/j1', '/studio', '/studio/environment-plan', '/studio/build-plan', '/studio/build-plan-no-sandboxes', '/studio/script', '/studio/script-no-sandboxes']
/** Routes whose 2xx needs more than the fake has: they may answer 4xx/5xx, but still must not write. */
const MAY_FAIL = new Set(['/api/doctor-jobs/job-x', '/api/storage-jobs/job-x', '/api/project-inits/init-x'])

// Guards the GETS table: it names every GET route router.ts has.
test('the no-writes table covers every GET route in router.ts', () => {
  const parsed = routerGets()
  assert.ok(parsed.size > 30, `parsed only ${parsed.size} GET routes from router.ts: the parser needs updating`)
  assert.deepEqual([...new Set(GETS.map(([sig]) => sig))].sort(), [...parsed].sort())
})

// C1 (finding: GETs with an `unclaimed:` projectId forked dsh.project.<uuid>): no GET route makes a mutating LayerFS call.
test('no GET route makes a mutating LayerFS call, with or without a projectId', { timeout: 30_000 }, async (t) => {
  const f = setup(t, { discovery: discoveryOf([{ family: 'machine', call: 'images', args: [], options: [] }]) })
  // the real identity check, wired as routes/index.ts wires it: reads never claim
  const catalog = new ProjectCatalog(() => f.lfs, join(f.dir, 'root'))
  f.host.host.assertProjectIdentity = (project, projectId) => catalog.assert(project, projectId, { claim: false })
  // doctor and presets spawn the CLI themselves: a recording fake CLI over a home that has its layerfs.json
  const home = join(f.dir, 'home')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'layerfs.json'), JSON.stringify({ id: 'home-test' }))
  const { cli, log } = fakeCli(f.dir)
  f.lfs.spec.cli = cli
  f.lfs.spec.home = home
  const presetState = presetStateFor(join(f.dir, 'root'), home)
  f.groups.presets = new PresetManager({
    spec: () => ({ cli, home, state: presetState, daemon: null }),
    busy: () => [], boundSessions: () => [], dshProjects: () => [], forgetProject: async () => {},
    homeStores: async (also) => also.map((name) => ({ name })), projectConversations: () => [], deleteProjectConversations: async () => [],
    emit: () => {},
  }, presetState, home)

  const requests = []
  for (const [sig, path] of GETS) {
    requests.push(path)
    if (sig.startsWith('projects/:id')) {
      const join = path.includes('?') ? '&' : '?'
      requests.push(`${path}${join}projectId=${encodeURIComponent('unclaimed:s1/p')}`)
      // a claimed id the project does not carry: refused ProjectIdentityChanged, still no write
      requests.push(`${path}${join}projectId=00000000-0000-4000-8000-00000000000a`)
    }
  }
  for (const p of PRESET_GETS) requests.push(`/api/demo-presets${p}`)

  const offenders = [], statuses = {}
  for (const path of requests) {
    const before = f.state.calls.length
    const answer = await f.http('GET', path)
    statuses[path] = answer.status
    for (const c of f.state.calls.slice(before)) if (!isRead(c.call)) offenders.push(`GET ${path} -> ${c.call}`)
  }
  // background work a read started (the project storage refresh) finishes too
  await f.groups.projects.close()
  for (const c of f.state.calls) if (!isRead(c.call)) offenders.push(`(any GET) -> ${c.call}`)
  for (const argv of readLog(log)) {
    const call = `${argv[0]}.${String(argv[1] ?? '').replaceAll('-', '_')}`
    if (MUTATING.has(call)) offenders.push(`(spawned CLI) -> layerfs ${argv.join(' ')}`)
  }
  assert.deepEqual([...new Set(offenders)], [])

  // the reads were real: the fake answered them (a failing route proves nothing about its writes)
  const failing = Object.entries(statuses).filter(([path, status]) => status >= 400 && !MAY_FAIL.has(path) && !path.includes('00000000-0000-4000') && !path.startsWith('/api/demo-presets/'))
  assert.deepEqual(failing, [], 'every plain GET answers 2xx over the fake home')
  for (const [path, status] of Object.entries(statuses)) if (path.includes('00000000-0000-4000')) assert.equal(status, 409, path)
  assert.equal(statuses['/api/demo-presets'], 200)
  assert.equal(f.count('branch.fork'), 0, 'an unclaimed projectId never claims (C1)')
  assert.ok(readLog(log).some((argv) => argv[0] === 'doctor'), 'GET /api/doctor ran the doctor report through the CLI')
  assert.ok(f.count('machine.images') > 0, 'GET /api/machines/:id/images read the image inventory')
  // GETs that write local stat journals only: Store observations and the project storage ledger, in the stat folder
  const stats = join(home, 'stat')
  assert.ok(readdirSync(join(stats, 'storage-observations')).length > 0, '/stores/:id/stats records an observation locally')
  assert.ok(readdirSync(join(stats, 'project-storage')).length > 0, '/projects/:id/storage?refresh=1 keeps its ledger locally')
})

// C1 wiring: the route identity guard passes claim: false (the catalog's own no-claim read is covered by
// test/project-catalog.test.mjs "reads with an unclaimed id never claim; they accept the address as it is").
test('routes/index.ts checks project identities without claiming', () => {
  const src = readFileSync(join(root, 'src/host/routes/index.ts'), 'utf8')
  assert.match(src, /assertProjectIdentity: async \(project, projectId\) => \{[^}]*catalog\.assert\(project, projectId, \{ claim: false \}\)/s)
})
