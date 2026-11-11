// The `http` operation's router: dispatch, Connect's status mapping and
// bodies over a fake lfs, and a live pass over the real pinned CLI against a
// private temporary LAYERFS_HOME.
//   node --test test/routes.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRoutes, pinned, testHost } from './routes-helper.mjs'

const R = await loadRoutes()

class Refusal extends Error {
  constructor(code, message, detail = null, transport = 'refusal') { super(message); Object.assign(this, { code, detail, transport }) }
}

/** A fake SDK: `calls` records every `family.call(args)`; `impl[family][call]` answers. */
function fakeLfs(impl) {
  const calls = []
  const lfs = new Proxy({ spec: { cli: '/fake/layerfs', home: '/fake/home' } }, {
    get(target, family) {
      if (family in target) return target[family]
      return new Proxy({}, {
        get(_t, call) {
          return async (...args) => {
            calls.push(`${family}.${call}`)
            const fn = impl[family]?.[call]
            if (!fn) throw new Refusal('Unsupported', `fake has no ${family}.${call}`)
            return fn(...args)
          }
        },
      })
    },
  })
  return { lfs, calls }
}

const discovery = async () => ({ identity: { version: '2.0.0-test', commit: 'a'.repeat(40), dirty: false, features: [] }, calls: [], commands: [], switches: [] })

function fakeGroups(impl) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-routes-root-'))
  const { lfs, calls } = fakeLfs(impl)
  const t = testHost({ lfs, root, home: join(root, 'home'), discovery })
  const groups = R.createGroups(t.host, async () => ({ ok: true, version: '2.0.0-test' }))
  return { groups, calls, events: t.events, root, http: (method, path, body) => R.handle(groups, { method, path, body }) }
}

const base = {
  machine: {
    list: async () => ({ machines: [{ name: 'native', platform: 'native', state: 'ready', stores: ['s1'] }, { name: 'lima1', platform: 'lima', state: 'stopped' }] }),
    platforms: async () => ({ host: 'macos', platforms: [{ platform: 'lima', ready: true, options: [{ name: 'cpus', kind: 'int' }, { name: 'nested', kind: 'bool' }] }, { platform: 'ssh', ready: true }] }),
    status: async (name) => ({ name, state: 'stopped', free_disk: 10 }),
  },
  store: {
    list: async () => ({ items: [{ name: 's1', machine: 'native', projects: ['p'], state: 'idle' }] }),
    status: async () => ({ state: 'idle', file: { exists: true, bytes: 100, wal_bytes: 5 }, holders: [] }),
    create: async () => ({}),
  },
  sandbox: { list: async () => ({ items: [], next_page_pos: null }) },
}

test('dispatch: machines view, platforms filter, unknown route 404', async () => {
  const { http, root } = fakeGroups(base)
  try {
    const m = await http('GET', '/api/machines')
    assert.equal(m.status, 200)
    assert.deepEqual(m.body.machines.map((x) => x.name), ['native', 'lima1'])
    assert.equal(m.body.layerfs, '2.0.0-test')
    assert.equal(m.body.status.lima1.freeDisk, 10)
    assert.deepEqual(m.body.stores.map((s) => s.name), ['s1'])
    const p = await http('GET', '/api/platforms')
    assert.deepEqual(p.body.platforms.map((x) => x.platform), ['lima'])
    assert.deepEqual(p.body.platforms[0].options.map((o) => o.name), ['cpus'])
    const nf = await http('GET', '/api/demos')
    assert.equal(nf.status, 404)
    assert.equal(nf.body.code, 'not-found')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('status mapping: refusal codes, transport, detail, conversion', async () => {
  const { http, root } = fakeGroups({
    ...base,
    project: {
      get: async (key) => { throw new Refusal('NoSuchProject', `no project ${key}`, { entity: key }) },
      remove: async () => { throw new Refusal('InUse', 'converting', { related: [{ kind: 'sandbox', name: 'b', why: 'close it' }] }) },
    },
    store: { ...base.store, remove: async () => { throw new Refusal('Unknown', 'lost', null, 'transport-unknown') } },
    machine: { ...base.machine, stop: async () => { throw new Refusal('Busy', 'held', { op: { name: 'machine.start' } }) } },
  })
  try {
    const a = await http('GET', `/api/projects/${encodeURIComponent('s1/p')}`)
    assert.equal(a.status, 404)
    assert.deepEqual(a.body, { code: 'NoSuchProject', transport: 'refusal', message: 'no project s1/p', detail: { entity: 's1/p' } })
    const b = await http('DELETE', `/api/projects/${encodeURIComponent('s1/p')}`)
    assert.equal(b.status, 409)
    assert.equal(b.body.conversion, true)
    const c = await http('DELETE', '/api/stores/s1?confirm=s1')
    assert.equal(c.status, 500)
    assert.equal(c.body.transport, 'transport-unknown')
    const d = await http('POST', '/api/machines/lima1/stop')
    assert.equal(d.status, 409)
    assert.equal(d.body.code, 'Busy')
    // the host's own guards keep their explicit status
    const e = await http('DELETE', '/api/stores/s1?confirm=nope')
    assert.equal(e.status, 400)
    assert.equal(e.body.code, 'InvalidInput')
    const f = await http('GET', '/api/projects/bare')
    assert.equal(f.status, 400)
    const g = await http('POST', '/api/machines', { name: 'x', platform: 'ssh' })
    assert.equal(g.status, 501)
    const h = await http('POST', '/api/machines', { name: 'x', platform: 'lima', disk: 9 })
    assert.equal(h.status, 400)
    assert.match(h.body.message, /takes no disk/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('stores: create emits storage, answers the view; bigints are tagged i64-v1', async () => {
  const { http, events, calls, root } = fakeGroups({
    ...base,
    store: { ...base.store, stats: async () => ({ kind: 'postgresql', canonical: 2n ** 70n, store_id: 'id1', store_generation: 1 }), get: async () => ({ name: 's1' }) },
  })
  try {
    const r = await http('POST', '/api/stores', { name: 'new1' })
    assert.equal(r.status, 200)
    assert.ok(calls.includes('store.create'))
    assert.deepEqual(r.body.stores[0].size, { bytes: 105, file: 100, wal: 5 })
    assert.deepEqual(events.map((e) => e.type), ['storage'])
    assert.deepEqual(events[0].data, { type: 'storage' })
    const bad = await http('POST', '/api/stores', { name: 'Bad Name' })
    assert.equal(bad.status, 400)
    const s = await http('GET', '/api/stores/s1/stats')
    assert.deepEqual(s.body.canonical, { $layerfs: 'i64-v1', decimal: String(2n ** 70n) })
    const o = await http('GET', '/api/stores/s1/observations')
    assert.equal(o.body.series.length, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('storage jobs: push runs as a job with storage-job events; one job per Store', async () => {
  let finish
  const { http, events, root } = fakeGroups({
    ...base,
    store: { ...base.store, push: (store, machine, { on_progress }) => new Promise((resolve) => { on_progress({ phase: 'send', done: 1, total: 2 }); finish = resolve }) },
  })
  try {
    const j = await http('POST', '/api/stores/s1/push', { machine: 'lima1' })
    assert.equal(j.status, 200)
    assert.equal(j.body.kind, 'push')
    const again = await http('POST', '/api/stores/s1/push', { machine: 'lima1' })
    assert.equal(again.status, 409)
    assert.equal(again.body.code, 'ConnectBusy')
    await new Promise((r) => setTimeout(r, 10))
    finish({ ok: true })
    await new Promise((r) => setTimeout(r, 10))
    const done = await http('GET', `/api/storage-jobs/${j.body.id}`)
    assert.equal(done.body.outcome, 'succeeded')
    const jobEvents = events.filter((e) => e.type === 'storage-job')
    assert.ok(jobEvents.length >= 2)
    assert.equal(jobEvents.at(-1).data.type, 'storage-job')
    assert.ok(jobEvents.at(-1).data.job.ended)
    assert.ok(existsSync(join(root, 'storage-jobs.json')))
    const view = await http('GET', '/api/storage')
    assert.equal(view.body.jobs[0].id, j.body.id)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('project init job and saved reads route to their calls', async () => {
  const head = 'c'.repeat(66)
  const src = mkdtempSync(join(tmpdir(), 'dsh-routes-src-'))
  const { http, root } = fakeGroups({
    ...base,
    project: { init: async (key) => ({ project: key, name: 'p', store: 's1', machine: 'native' }), list: async () => ({ items: [{ project: 's1/p', name: 'p', store: 's1' }], next_page_pos: null }) },
    branch: { get: async () => ({ name: 'main', base: head }), list: async () => ({ items: [{ name: 'main', base: head }], next_page_pos: null }) },
    file: {
      list: async (project, branch, path, at) => ({ items: [{ name: 'a.txt', path: '/a.txt', type: 'file', size: 3 }], has_more: false, at: { id: at } }),
      stat: async () => ({ size: 3, mode: 0o644 }),
      read: async () => ({ text: 'hi\n', next_line: null }),
    },
  })
  try {
    const job = await http('POST', '/api/projects', { store: 's1', name: 'p', source: src })
    assert.equal(job.status, 200)
    assert.equal(job.body.name, 's1/p')
    await new Promise((r) => setTimeout(r, 10))
    const ended = await http('GET', `/api/project-inits/${job.body.id}`)
    assert.equal(ended.body.step, 'done')
    assert.equal(ended.body.project.key, 's1/p')
    const list = await http('GET', '/api/projects')
    assert.deepEqual(list.body.map((p) => [p.key, p.storeState]), [['s1/p', 'idle']])
    const key = encodeURIComponent('s1/p')
    const fs = await http('GET', `/api/projects/${key}/fs?branch=main&path=/`)
    assert.deepEqual(fs.body, { items: [{ name: 'a.txt', path: '/a.txt', kind: 'file', size: 3, mode: null }], next: null, at: { id: head } })
    const file = await http('GET', `/api/projects/${key}/file?branch=main&path=/a.txt`)
    assert.equal(file.body.text, 'hi\n')
    assert.equal(file.body.binary, false)
    const bad = await http('GET', `/api/projects/${key}/fs?branch=main&path=../x`)
    assert.equal(bad.status, 400)
    const br = await http('GET', `/api/projects/${key}/branches`)
    assert.deepEqual(br.body.items[0], { name: 'main', head, parent: null, forkedFrom: null, state: 'open', commits: null })
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(src, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------- live

const pin = pinned()

test('live: machines, store create, project init, list/get, branches, fs, file', { skip: !pin && 'no pinned LayerFS CLI', timeout: 600_000 }, async () => {
  // a short path: the native daemon's sockets live in the home
  const root = mkdtempSync('/tmp/dshrt-')
  const home = join(root, 'home')
  mkdirSync(home, { mode: 0o700 })
  const src = join(root, 'src')
  mkdirSync(join(src, 'lib'), { recursive: true })
  writeFileSync(join(src, 'README.md'), '# hello\nworld\n')
  writeFileSync(join(src, 'lib', 'a.js'), 'export const a = 1\n')
  const lfs = R.cli.client({ cli: pin.cli, home })
  let recorded
  const t = testHost({
    lfs, root, home, cli: pin.cli, daemon: pin.daemon ?? null,
    discovery: () => R.cli.discover({ cli: pin.cli }),
    ensureNative: () => recorded ??= (process.platform === 'darwin' && pin.daemon ? lfs.machine.update('native', { daemon: pin.daemon }) : Promise.resolve()),
  })
  const groups = R.createGroups(t.host, async () => ({ ok: true }))
  const http = async (method, path, body) => {
    const r = await R.handle(groups, { method, path, body })
    return r
  }
  const ok = async (method, path, body) => {
    const r = await http(method, path, body)
    assert.equal(r.status, 200, `${method} ${path}: ${JSON.stringify(r.body)}`)
    return r.body
  }
  const key = encodeURIComponent('rt/demo')
  try {
    const machines = await ok('GET', '/api/machines')
    assert.ok(machines.machines.some((m) => m.name === 'native'))
    const status = await ok('GET', '/api/status')
    assert.equal(status.settings.home, home)
    const view = await ok('POST', '/api/stores', { name: 'rt' })
    assert.ok(view.stores.some((s) => s.name === 'rt' && s.machine === 'native'))
    assert.ok(t.events.some((e) => e.type === 'storage'))
    const job = await ok('POST', '/api/projects', { store: 'rt', name: 'demo', source: src })
    let init = job
    for (let i = 0; i < 600 && !init.ended; i++) {
      await new Promise((r) => setTimeout(r, 200))
      init = await ok('GET', `/api/project-inits/${job.id}`)
    }
    assert.equal(init.step, 'done', JSON.stringify(init.error))
    const list = await ok('GET', '/api/projects')
    assert.ok(list.some((p) => p.key === 'rt/demo' && p.storeState))
    const state = await ok('GET', `/api/projects/${key}`)
    assert.equal(state.project.key, 'rt/demo')
    assert.ok(state.branches.some((b) => b.name === 'main'))
    const branches = await ok('GET', `/api/projects/${key}/branches`)
    assert.ok(branches.items.some((b) => b.name === 'main'))
    const fs = await ok('GET', `/api/projects/${key}/fs?branch=main&path=/`)
    assert.deepEqual(fs.items.map((i) => i.name).sort(), ['README.md', 'lib'])
    assert.equal(fs.items.find((i) => i.name === 'lib').kind, 'dir')
    const sub = await ok('GET', `/api/projects/${key}/fs?branch=main&path=/lib`)
    assert.deepEqual(sub.items.map((i) => i.path), ['/lib/a.js'])
    const file = await ok('GET', `/api/projects/${key}/file?branch=main&path=/README.md`)
    assert.equal(file.binary, false)
    assert.match(file.text, /hello/)
    const missing = await http('GET', `/api/projects/${key}/file?branch=main&path=/nope.txt`)
    assert.equal(missing.status, 404, JSON.stringify(missing.body))
    const sandboxes = await ok('GET', `/api/projects/${key}/sandboxes`)
    assert.ok(Array.isArray(sandboxes))
    const storage = await ok('GET', '/api/storage')
    assert.ok(storage.stores.some((s) => s.name === 'rt' && s.projects.includes('demo')))
    // a Sandbox, a forked side Branch mounted in it, its status, unmount and close
    await ok('POST', `/api/projects/${key}/sandboxes`, { name: 'rtsb' })
    const ws = await ok('POST', '/api/sandboxes/rtsb/workspaces', { branch: 'side', fork: true, name: 'w' })
    assert.equal(ws.branch ?? 'side', 'side')
    const sb = await ok('GET', '/api/sandboxes/rtsb')
    assert.equal(sb.workspaces.length, 1)
    const handle = sb.workspaces[0].ws
    await ok('GET', `/api/workspaces/${encodeURIComponent(handle)}/status`)
    const main = await http('POST', '/api/sandboxes/rtsb/workspaces', { branch: 'main' })
    assert.equal(main.status, 400)
    await ok('DELETE', `/api/workspaces/${encodeURIComponent(handle)}?discard=1`)
    await ok('DELETE', '/api/sandboxes/rtsb')
    const gone = await http('GET', '/api/sandboxes/rtsb')
    assert.equal(gone.status, 404, JSON.stringify(gone.body))
  } finally {
    await http('POST', `/api/projects/${key}/close-sandboxes`, { force: true }).catch(() => {})
    await groups.projects.close()
    rmSync(root, { recursive: true, force: true })
  }
})
