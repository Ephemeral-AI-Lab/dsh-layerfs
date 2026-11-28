// The `http` operation's router: dispatch, Connect's status mapping and
// bodies over a fake lfs, and a live pass over the real pinned CLI against a
// private temporary LAYERFS_HOME.
//   node --test test/routes.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { liveSkipReason, loadRoutes, pinned, testHost } from './routes-helper.mjs'
import { tmpRoot } from './support/env.mjs'

const R = await loadRoutes()
const repoRoot = new URL('..', import.meta.url).pathname
const msOut = mkdtempSync(join(repoRoot, 'lib', '.test-routes-ms-'))
await build({
  absWorkingDir: repoRoot,
  stdin: { contents: "export * from './src/client/storage/machine-stores.ts'", resolveDir: repoRoot, loader: 'ts' },
  outfile: join(msOut, 'ms.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24', external: ['@deepseek-ai/*'], logLevel: 'warning',
})
const MS = await import(pathToFileURL(join(msOut, 'ms.mjs')).href)
test.after(() => rmSync(msOut, { recursive: true, force: true }))

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

function fakeGroups(impl, discover = discovery, secrets = undefined) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-routes-root-'))
  const { lfs, calls } = fakeLfs(impl)
  const t = testHost({ lfs, root, home: join(root, 'home'), discovery: discover, ...(secrets ? { secrets: secrets(root) } : {}) })
  const groups = R.createGroups(t.host, async () => ({ ok: true, version: '2.0.0-test' }))
  return { groups, calls, events: t.events, root, http: (method, path, body) => R.handle(groups, { method, path, body }) }
}

const base = {
  // the 2.0 machine family (long forms): records from machine.list, the live probe from machine.get --with live
  machine: {
    list: async () => ({ items: [{ machine: 'macos-host', platform: 'host', state: 'ready', stores: ['s1'], sandboxes: [], supports: ['sqlite'] }, { machine: 'lima1', platform: 'lima', state: 'stopped', stores: [], sandboxes: [], supports: ['sqlite'] }] }),
    get: async (name) => ({ machine: name, platform: name === 'macos-host' ? 'host' : 'lima', state: name === 'macos-host' ? 'ready' : 'stopped', live: { disk_free_bytes: 10, tool_version: null, worker: null } }),
  },
  home: {
    get: async () => ({ state: 'ready', version: '2.0.0', platforms: { host: 'macos', items: [{ platform: 'lima', how: 'created', ready: true, options: [{ option: 'cpus', kind: 'int' }, { option: 'nested', kind: 'bool' }] }, { platform: 'ssh', how: 'created', ready: true, options: [] }] } }),
  },
  // the 2.0 store family: `store list --detail [--with stats]` rows keyed `store` (a ready row may leave `state` out)
  store: {
    list: async () => ({ items: [{ store: 's1', machine: 'macos-host', engine: 'sqlite', projects: ['p'], state: 'ready', size: 105 }] }),
    get: async (name) => ({ store: name, machine: 'macos-host', engine: 'sqlite', projects: ['p'], state: 'ready' }),
    create: async () => ({ ok: true }),
  },
  sandbox: { list: async () => ({ items: [] }) },
}

test('dispatch: machines view, platforms filter, unknown route 404', async () => {
  const { http, root } = fakeGroups(base)
  try {
    const m = await http('GET', '/api/machines')
    assert.equal(m.status, 200)
    assert.deepEqual(m.body.machines.map((x) => x.name), ['macos-host', 'lima1'])
    assert.equal(m.body.layerfs, '2.0.0-test')
    // B4: a plain read is records only and never waits on the live probe; the
    // page's Check again (`?fresh=1`) probes now and its answer is the liveness
    assert.equal(m.body.live.lima1.freeDisk, null)
    const again = await http('GET', '/api/machines?fresh=1')
    assert.equal(again.body.live.lima1.freeDisk, 10)
    assert.deepEqual(m.body.stores.map((s) => s.name), ['s1'])
    const p = await http('GET', '/api/platforms')
    assert.deepEqual(p.body.platforms.map((x) => x.platform), ['lima'])
    assert.deepEqual(p.body.platforms[0].options.map((o) => o.option), ['cpus'])
    const nf = await http('GET', '/api/demos')
    assert.equal(nf.status, 404)
    assert.equal(nf.body.code, 'NotFound')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('status mapping: refusal codes, transport, detail, conversion', async () => {
  const { http, root } = fakeGroups({
    ...base,
    project: {
      get: async (key) => { throw new Refusal('NotFound', `no project ${key}`, { entity: key }) },
      delete: async () => { throw new Refusal('InUse', 'converting', { related: [{ kind: 'sandbox', name: 'b', why: 'close it' }] }) },
    },
    store: { ...base.store, remove: async () => { throw new Refusal('Unknown', 'lost', null, 'transport-unknown') } },
    machine: { ...base.machine, stop: async () => { throw new Refusal('Busy', 'held', { op: { name: 'machine.start' } }) } },
  })
  try {
    const a = await http('GET', `/api/projects/${encodeURIComponent('s1/p')}`)
    assert.equal(a.status, 404)
    assert.deepEqual(a.body, { code: 'NotFound', transport: 'refusal', message: 'no project s1/p', detail: { entity: 's1/p' } })
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
    // 2.0 `store get --with stats`: the section under `stats`; no Store identity (no observation journal)
    store: { ...base.store, get: async (name) => ({ store: name, engine: 'postgresql', stats: { canonical_bytes: 2n ** 70n, size: 105 } }) },
  })
  try {
    const r = await http('POST', '/api/stores', { name: 'new1' })
    assert.equal(r.status, 200)
    assert.ok(calls.includes('store.create'))
    assert.equal(r.body.stores[0].size.bytes, 105, 'the size from `store list --with stats`')
    assert.deepEqual(events.map((e) => e.type), ['storage'])
    assert.deepEqual(events[0].data, { type: 'storage' })
    const bad = await http('POST', '/api/stores', { name: 'Bad Name' })
    assert.equal(bad.status, 400)
    const s = await http('GET', '/api/stores/s1/stats')
    assert.deepEqual(s.body.canonical_bytes, { $layerfs: 'i64-v1', decimal: String(2n ** 70n) })
    assert.match(s.body.observationError, /Store identity/, 'no identity: no observation is kept, and the answer says why')
    const o = await http('GET', '/api/stores/s1/observations')
    assert.equal(o.body.series.length, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('storage view: a Store with more than 20 projects lists every name by project list --store (its `projects` is cut at 20)', async () => {
  const names = Array.from({ length: 25 }, (_, i) => `p${String(i).padStart(2, '0')}`)
  const asked = []
  const { http, root } = fakeGroups({
    ...base,
    store: { ...base.store, list: async () => ({ items: [{ store: 's1', machine: 'macos-host', engine: 'sqlite', projects: names.slice(0, 20), projects_count: 25, state: 'ready', size: 1 }, { store: 's2', machine: 'macos-host', engine: 'sqlite', projects: ['a'], state: 'ready', size: 1 }] }) },
    project: {
      list: async (o) => {
        asked.push(o.store)
        const from = o.cursor ? Number(o.cursor) : 0
        return { items: names.slice(from, from + 10).map((n) => ({ project: `s1/${n}` })), next_cursor: from + 10 < names.length ? String(from + 10) : null }
      },
    },
  })
  try {
    const view = await http('GET', '/api/storage')
    assert.equal(view.status, 200, JSON.stringify(view.body))
    const s1 = view.body.stores.find((s) => s.name === 's1'), s2 = view.body.stores.find((s) => s.name === 's2')
    assert.deepEqual(s1.projects, names)
    assert.equal(s1.projectsCount, 25)
    assert.deepEqual(s2.projects, ['a'], 'a whole list is not read again')
    assert.deepEqual(asked, ['s1', 's1', 's1'], 'only the cut Store, three pages')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('storage view distinguishes a refused bucket inventory from confirmed removal', async () => {
  let buckets = [{ bucket: 'unlinked', provider: 'minio' }]
  let offline = false
  const { http, root } = fakeGroups({
    ...base,
    home: { get: async () => {
      if (offline) throw new Refusal('Busy', 'home tree is busy')
      return { tree: { buckets } }
    } },
  })
  try {
    const initial = await http('GET', '/api/storage')
    assert.equal(initial.body.bucketInventoryComplete, true)
    assert.deepEqual(initial.body.buckets.map((bucket) => bucket.name), ['unlinked'])

    offline = true
    const refused = await http('GET', '/api/storage')
    assert.equal(refused.status, 200)
    assert.equal(refused.body.bucketInventoryComplete, false)
    assert.deepEqual(refused.body.buckets, [])

    offline = false
    buckets = []
    const removed = await http('GET', '/api/storage')
    assert.equal(removed.body.bucketInventoryComplete, true)
    assert.deepEqual(removed.body.buckets, [])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('project catalog Refresh rereads the pinned CLI', async () => {
  const requested = []
  const { http, root } = fakeGroups({
    ...base,
    project: { list: async (options) => { requested.push(options); return { items: [] } } },
  })
  try {
    assert.equal((await http('GET', '/api/projects')).status, 200)
    assert.equal((await http('GET', '/api/projects?fresh=1')).status, 200)
    assert.deepEqual(requested.map((options) => options.timeout_ms), [undefined, R.cli.READ_TIMEOUT_MS])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('the Doctor page\'s backup fix runs as a Storage job (job row, storage-job events, one job per Store) and waits for its end (review UR M7)', async () => {
  let finish
  const { groups, events, root } = fakeGroups({
    ...base,
    backup: { create: (store, bucket) => new Promise((resolve, reject) => { finish = { resolve, reject } }) },
  })
  try {
    // the Doctor's fix action as createGroups wires it
    const run = groups.checks.actions.backupCreate('s1', 'r2')
    let settled = false
    void run.then(() => { settled = true }, () => { settled = true })
    await new Promise((r) => setTimeout(r, 10))
    assert.equal(settled, false, 'it waits for the backup to end')
    const jobs = events.filter((e) => e.type === 'storage-job').map((e) => e.data.job)
    assert.ok(jobs.some((j) => j.kind === 'backup' && j.store === 's1' && j.target === 'r2' && !j.ended), 'a running backup job on the Storage page')
    await assert.rejects(groups.checks.actions.backupCreate('s1', 'r2'), (e) => e.code === 'ConnectBusy', 'one job per Store')
    finish.resolve({ store: 's1', bucket: 'r2' })
    assert.deepEqual(await run, { store: 's1', bucket: 'r2' })
    await new Promise((r) => setTimeout(r, 10))
    assert.ok(events.some((e) => e.type === 'storage-job' && e.data.job.kind === 'backup' && e.data.job.outcome === 'succeeded'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('store projects: every project with its ledger, newest Commit and main files; one tree walk per main head', async () => {
  let head = 'h1'
  const { http, calls, groups, root } = fakeGroups({
    ...base,
    // 2.0 long forms: `project list --store` by cursor (every project, not `store get`'s first 20), `project stats` file_count/partial, `branch get` commit
    store: { ...base.store, get: async () => ({ store: 's1', projects: ['web'], projects_count: 2 }) },
    project: {
      list: async (o) => {
        assert.equal(o.store, 's1')
        const all = [{ project: 's1/web', store: 's1', created_at: new Date(1000).toISOString() }, { project: 's1/docs', store: 's1', created_at: new Date(1000).toISOString() }]
        return o.cursor ? { items: [all[1]], next_cursor: null } : { items: [all[0]], next_cursor: 'c1' }
      },
      stats: async (key) => ({ file_count: key === 's1/web' ? 40 : 10001, partial: key !== 's1/web' }),
    },
    branch: {
      get: async () => ({ commit: head }),
      list: async () => ({ items: [] }),
    },
    commit: { list: async () => ({ items: [] }) },
  })
  try {
    const a = await http('GET', '/api/stores/s1/projects')
    assert.equal(a.status, 200)
    assert.equal(a.body.store, 's1')
    assert.deepEqual(a.body.projects.map((p) => p.name), ['docs', 'web'], 'both pages, sorted')
    assert.deepEqual(a.body.projects.map((p) => p.files), [{ files: 10001, complete: false }, { files: 40, complete: true }])
    assert.equal(a.body.projects[0].created, 1000)
    await http('GET', '/api/stores/s1/projects')
    assert.equal(calls.filter((c) => c === 'project.stats').length, 2, 'an unchanged head walks no tree again')
    head = 'h2'
    await http('GET', '/api/stores/s1/projects')
    assert.equal(calls.filter((c) => c === 'project.stats').length, 4, 'a new head is walked once per project')
    await groups.projects.close()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

const pgMachines = async () => ({ items: [
  { machine: 'macos-host', platform: 'host', state: 'ready', supports: ['sqlite', 'postgresql_sandbox'] },
  { machine: 'docker', platform: 'docker', state: 'ready', supports: ['sqlite', 'postgresql_sandbox'] },
  { machine: 'vm1', platform: 'lima', state: 'stopped', supports: ['sqlite', 'postgresql_sandbox'] },
  { machine: 'nopg', platform: 'x', state: 'ready', supports: ['sqlite'] },
] })

// The PostgreSQL connect/attach contract (docs/specs/store-home-rows.md): `store connect`
// takes the address, the user and the password (on stdin, through the SDK's content
// option); `store get` gives the saved connection and each attached machine's last reach.
const pgRecord = (more = {}) => ({
  store: 'pg', engine: 'postgresql', state: 'ready', url: 'postgresql://db.lan:5432/team', user: 'app', password_saved: true,
  password_changed_at: '2026-11-20T10:00:00Z', synchronous_commit: 'local', binding: 'f64587b8a1c2d3e4',
  reach: { at: '2026-11-20T10:00:00Z', ok: true, latency_ms: 3, server_version: '17.6', error: null },
  machines: [{ machine: 'docker', reached: 'ok', reach: { at: '2026-11-20T10:00:01Z', ok: true, latency_ms: 4, server_version: '17.6', error: null } }, { machine: 'vm1', reached: null, reach: null }],
  projects: ['app'], ...more,
})

test('postgresql: a Store row is its saved connection and the machines attached to it; a machine not yet checked has no reach', async () => {
  const record = pgRecord()
  const { http, root } = fakeGroups({
    ...base,
    machine: { ...base.machine, list: pgMachines },
    store: { ...base.store, list: async () => ({ items: [{ store: 'pg', engine: 'postgresql', state: 'ready', user: 'app', machines: ['docker', 'vm1'], projects: ['app'] }] }), get: async () => record },
  })
  try {
    const view = await http('GET', '/api/storage')
    assert.equal(view.status, 200)
    const row = view.body.stores.find((s) => s.name === 'pg')
    assert.deepEqual(row.postgresql, {
      url: 'postgresql://db.lan:5432/team', target: row.postgresql.target, server: 'db.lan:5432', database: 'team', user: 'app',
      passwordSaved: true, passwordChangedAt: Date.parse('2026-11-20T10:00:00Z'), synchronousCommit: 'local', binding: 'f64587b8a1c2d3e4',
      host: { at: Date.parse('2026-11-20T10:00:00Z'), ok: true, latencyMs: 3, version: '17.6', error: null },
    })
    assert.deepEqual(row.attached.map((a) => [a.machine, a.reached, a.reach?.latencyMs ?? null]), [['docker', 'ok', 4], ['vm1', null, null]])
    assert.equal('auths' in view.body, false, 'no saved-login list')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('postgresql: Connect sends the address, the user and the password to store connect; a login in the address is refused before LayerFS', async () => {
  const seen = []
  const { http, root } = fakeGroups({
    ...base,
    store: { ...base.store, connect: async (name, url, options) => { seen.push([name, url, options]); return { ok: true, outcome: 'connected' } } },
  })
  try {
    const ok = await http('POST', '/api/stores/postgresql', { name: 'pg', url: 'postgresql://db.lan:5432/team', user: ' app ', passwordValue: 's3cret', synchronousCommit: 'local' })
    assert.equal(ok.status, 200)
    assert.equal(ok.body.outcome, 'connected')
    assert.deepEqual(seen, [['pg', 'postgresql://db.lan:5432/team', { user: 'app', password: 's3cret', synchronous_commit: 'local', detail: true }]])
    for (const body of [
      { name: 'pg', url: 'postgresql://app:pw@db.lan/team', user: 'app', passwordValue: 'x' },
      { name: 'pg', url: 'postgresql://db.lan/team?password=x', user: 'app', passwordValue: 'x' },
      { name: 'pg', url: 'postgresql://db.lan/team', user: '', passwordValue: 'x' },
      { name: 'pg', url: 'postgresql://db.lan/team', user: 'app', passwordValue: '' },
    ]) assert.equal((await http('POST', '/api/stores/postgresql', body)).status, 400, JSON.stringify(body))
    assert.equal(seen.length, 1, 'nothing else reached LayerFS')
    for (const gone of ['/api/store-auths', '/api/store-auths/pg']) assert.equal((await http('GET', gone)).status, 404, gone)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('postgresql: Edit connection connects again with only what changed (the saved address kept), then checks from the host and every attached machine', async () => {
  const seen = []
  let record = pgRecord()
  const { http, root } = fakeGroups({
    ...base,
    store: {
      ...base.store,
      get: async () => record,
      connect: async (name, url, options) => { seen.push(['connect', name, url, options]); return { ok: true, outcome: 'updated' } },
      doctor: async (name, options) => { seen.push(['doctor', name, options.machine ?? null]); return { findings: [{ check: 'store.connection', severity: 'error', from: 'docker', message: 'machine docker cannot reach the server: connection refused' }] } },
    },
  })
  try {
    const r = await http('POST', '/api/stores/pg/connection', { passwordValue: 'new' })
    assert.equal(r.status, 200)
    assert.deepEqual(seen, [['connect', 'pg', 'postgresql://db.lan:5432/team', { password: 'new', detail: true }], ['doctor', 'pg', null]])
    assert.equal(r.body.outcome, 'updated')
    assert.deepEqual(r.body.check.findings, [{ check: 'store.connection', from: 'docker', message: 'machine docker cannot reach the server: connection refused' }])
    assert.deepEqual(r.body.check.machines.map((m) => m.machine), ['docker', 'vm1'])
    assert.equal((await http('POST', '/api/stores/pg/connection', {})).status, 400, 'nothing to change')
    record = pgRecord({ url: null })
    assert.equal((await http('POST', '/api/stores/pg/connection', { user: 'b' })).status, 400, 'no saved address and none given')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('postgresql: attach is one store attach per machine, each answering for itself; detach is LayerFS\'s refusal while Sandboxes run there', async () => {
  const seen = []
  const { http, root } = fakeGroups({
    ...base,
    store: {
      ...base.store,
      attach: async (name, options) => {
        seen.push(['attach', name, options.machine])
        if (options.machine === 'vm1') throw new Refusal('Unavailable', 'machine vm1 cannot reach the server: connection refused')
        return { ok: true, outcome: 'attached', store: name, machine: options.machine, latency_ms: 2, server_version: '17.6' }
      },
      detach: async (name, options) => { seen.push(['detach', name, options.machine]); if (options.machine === 'docker') throw new Refusal('InUse', '1 Sandbox of pg runs on docker'); return { ok: true } },
    },
  })
  try {
    const r = await http('POST', '/api/stores/pg/attach', { machines: ['docker', 'vm1', 'docker'] })
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.results.map((x) => [x.machine, x.ok, x.ok ? x.latencyMs : x.error.code]), [['docker', true, 2], ['vm1', false, 'Unavailable']])
    assert.deepEqual(seen, [['attach', 'pg', 'docker'], ['attach', 'pg', 'vm1']], 'each machine once, in order; a refusal does not stop the rest')
    assert.equal((await http('POST', '/api/stores/pg/attach', { machines: [] })).status, 400)
    assert.equal((await http('POST', '/api/stores/pg/detach', { machine: 'docker' })).status, 409)
    assert.equal((await http('POST', '/api/stores/pg/detach', { machine: 'vm1' })).status, 200)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('postgresql: Check is store doctor (from the host, or the host and one machine), answered with the reaches LayerFS recorded', async () => {
  const seen = []
  const { http, root } = fakeGroups({
    ...base,
    store: {
      ...base.store,
      get: async () => pgRecord(),
      doctor: async (name, options) => { seen.push(options); if (options.machine === 'ghost') throw new Refusal('NotFound', 'no machine named ghost'); return { findings: [] } },
    },
  })
  try {
    const all = await http('GET', '/api/stores/pg/check')
    assert.equal(all.status, 200)
    assert.deepEqual([all.body.host.ok, all.body.machines.length, all.body.findings], [true, 2, []])
    assert.equal(seen[0].machine, undefined)
    assert.ok(seen[0].timeout_ms > 0, 'its own budget')
    await http('GET', '/api/stores/pg/check?machine=docker')
    assert.equal(seen[1].machine, 'docker')
    assert.equal((await http('GET', '/api/stores/pg/check?machine=ghost')).status, 404)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('postgresql: a Sandbox is made on the machine asked for, else its project\'s last machine while attached and running, else the only attached one, else no machine is named (LayerFS refuses)', async () => {
  const made = []
  let last = null
  let attached = []
  const { http, root } = fakeGroups({
    ...base,
    machine: { ...base.machine, list: pgMachines },
    project: { get: async (key) => ({ project: key, store: 'pg', engine: 'postgresql' }) },
    store: { ...base.store, list: async () => ({ items: [{ store: 'pg', engine: 'postgresql', machines: attached.map((a) => a.machine), state: 'ready' }] }),
      get: async () => pgRecord({ machines: attached }) },
    sandbox: { ...base.sandbox, list: async () => ({ items: last ? [{ sandbox: 'old', machine: last, created_at: '2026-11-19T00:00:00Z' }] : [] }), create: async (project, name, options) => { made.push([name, options.machine]); return { ok: true } } },
  })
  const create = (body) => http('POST', `/api/projects/${encodeURIComponent('pg/app')}/sandboxes`, body)
  try {
    assert.equal((await create({ name: 'b1' })).status, 200, 'none attached: no machine named, LayerFS answers (with its attach fix)')
    assert.equal((await create({ name: 'b2', machine: 'vm1' })).status, 200, 'the machine asked for goes to LayerFS as asked')
    attached = [{ machine: 'docker', reached: null }]
    assert.equal((await create({ name: 'b3' })).status, 200, 'the only attached machine')
    attached = [{ machine: 'vm1', reached: 'ok' }, { machine: 'docker', reached: null }]
    last = 'vm1'
    assert.equal((await create({ name: 'b4' })).status, 200, 'vm1 is stopped, and two are attached: none named (LayerFS answers with next.machines)')
    last = 'macos-host'
    attached = [...attached, { machine: 'macos-host', reached: null }]
    assert.equal((await create({ name: 'b5' })).status, 200, 'the host machine, attached like any machine, as the last machine')
    assert.deepEqual(made, [['b1', undefined], ['b2', 'vm1'], ['b3', 'docker'], ['b4', undefined], ['b5', 'macos-host']])
    assert.equal(existsSync(join(root, 'store-machines.json')), false, 'nothing Store-wide is written')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('buckets: the keys go to LayerFS (the secret on stdin), never to a file here; the home\'s buckets come from home get --with tree', async () => {
  const seen = []
  const buckets = []
  const { http, root } = fakeGroups({
    ...base,
    home: { get: async (o = {}) => ({ ...(await base.home.get()), ...(o.with?.includes('tree') ? { tree: { machines: [], stores: [], buckets: buckets.map((b) => ({ ...b })) } } : {}) }) },
    backup: {
      // the long form (spec v21): `rotated` when the name is connected at that URL already (the key replaced, links kept)
      connect: async (name, url, options) => {
        seen.push(['connect', name, url, options])
        const had = buckets.some((b) => b.bucket === name)
        if (!had) buckets.push({ bucket: name, provider: url.startsWith('r2://') ? 'r2' : 'minio' })
        return options?.detail ? { bucket: name, outcome: had ? 'rotated' : 'connected' } : { ok: true }
      },
      disconnect: async (name) => { seen.push(['disconnect', name]); buckets.splice(buckets.findIndex((b) => b.bucket === name), 1); return { ok: true, unlinked: ['s1'] } },
      list: async () => ({ items: [] }),
    },
  })
  const home = join(root, 'home')
  try {
    const ok = await http('POST', '/api/buckets', { name: 'r2b', provider: 'r2', account: 'a'.repeat(32), bucket: 'bk', accessKey: 'AK', secretKey: 'SK' })
    assert.equal(ok.status, 200)
    // `secret_key` is a content option: the seam writes it on stdin (`--key-stdin`), never on argv or disk
    assert.deepEqual(seen[0], ['connect', 'r2b', `r2://${'a'.repeat(32)}/bk`, { access_key: 'AK', secret_key: 'SK', detail: true }])
    assert.equal(ok.body.outcome, 'connected', 'the long form\'s outcome comes back with the view')
    assert.ok(!existsSync(join(home, 'secret')) && !existsSync(join(root, 'secrets')), 'no key file on this host')
    assert.deepEqual(ok.body.buckets.map((b) => [b.name, b.provider]), [['r2b', 'r2']])
    assert.ok(!JSON.stringify(ok.body).includes('SK'))
    // both keys, without spaces, or nothing is sent
    const before = seen.length
    assert.equal((await http('POST', '/api/buckets', { name: 'm', provider: 'minio', endpoint: 'http://minio:9000', bucket: 'bk', accessKey: 'AK' })).status, 400)
    assert.equal((await http('POST', '/api/buckets', { name: 'm', url: 'http://u:p@minio:9000/bk', accessKey: 'AK', secretKey: 'SK' })).status, 400)
    assert.equal(seen.length, before)
    // a bucket another client connected shows up: the home's records are LayerFS's
    buckets.push({ bucket: 'shared', provider: 'minio' })
    assert.equal((await http('POST', '/api/stores', { name: 'bump' })).status, 200)
    assert.deepEqual((await http('GET', '/api/storage')).body.buckets.map((b) => [b.name, b.provider]), [['r2b', 'r2'], ['shared', 'minio']])
    // connecting again at the same URL rotates the key (U10 add-on 3): the answer says so, the page shows "Key replaced; links kept"
    const again = await http('POST', '/api/buckets', { name: 'r2b', provider: 'r2', account: 'a'.repeat(32), bucket: 'bk', accessKey: 'AK2', secretKey: 'SK2' })
    assert.equal(again.status, 200)
    assert.equal(again.body.outcome, 'rotated')
    assert.ok(!JSON.stringify(again.body).includes('SK2'))
    // the old key routes are gone: a key changes by connecting again
    assert.equal((await http('POST', '/api/buckets/r2b/keys', { accessKey: 'AK2', secretKey: 'SK2' })).status, 404)
    const gone = await http('DELETE', '/api/buckets/r2b')
    assert.equal(gone.status, 200)
    assert.deepEqual(gone.body.unlinked, ['s1'])
    assert.deepEqual(gone.body.view.buckets.map((b) => b.name), ['shared'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('RV4 NOTE 6: a connect that succeeds clears the bucket\'s remembered "key refused" without List again', async () => {
  let refused = true
  const { http, root } = fakeGroups({
    ...base,
    home: { get: async (o = {}) => ({ ...(await base.home.get()), ...(o.with?.includes('tree') ? { tree: { machines: [], stores: [], buckets: [{ bucket: 'bk', provider: 'minio', url: 'http://minio:9000/bk' }] } } : {}) }) },
    backup: {
      connect: async (name, url, options) => { refused = false; return options?.detail ? { bucket: name, outcome: 'rotated' } : { ok: true } },
      list: async () => { if (refused) throw new Refusal('refused', 'the access key was refused'); return { items: [] } },
    },
  })
  try {
    assert.equal((await http('GET', '/api/buckets/bk/files')).body.error.code, 'refused')
    assert.equal((await http('GET', '/api/storage')).body.buckets.find((b) => b.name === 'bk').error.code, 'refused', 'remembered')
    const again = await http('POST', '/api/buckets', { name: 'bk', url: 'http://minio:9000/bk', accessKey: 'AK2', secretKey: 'SK2' })
    assert.equal(again.status, 200)
    assert.equal(again.body.buckets.find((b) => b.name === 'bk').error, null, 'the connect answers the refusal at once')
    assert.equal((await http('GET', '/api/storage')).body.buckets.find((b) => b.name === 'bk').error, null)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('RV4 NOTE 5: Inspect reads the record now; a broken listing fixed outside the page does not read broken again', async () => {
  let fixed = false
  const broken = { machine: 'lima1', platform: 'lima', state: 'broken', reason: 'outdated', fix: 'layerfs machine update lima1', message: 'the worker is outdated', stores: [], sandboxes: [], supports: ['sqlite'] }
  const reads = []
  const { http, root } = fakeGroups({
    ...base,
    machine: {
      list: async () => ({ items: [base.machine.list ? (await base.machine.list()).items[0] : null, broken].filter(Boolean) }),
      get: async (name, o = {}) => {
        reads.push(o.with?.includes('live') ? 'live' : 'record')
        if (name !== 'lima1') return base.machine.get(name)
        // LayerFS's record after `machine update` on the CLI: ready; before: broken (the live read alone says unknown)
        if (!o.with?.includes('live')) return fixed ? { ...broken, state: 'ready', reason: null, fix: null, message: null } : broken
        return { machine: 'lima1', platform: 'lima', state: fixed ? 'ready' : 'unknown', live: { disk_free_bytes: 7, worker: null, tool_version: null } }
      },
    },
  })
  try {
    assert.equal((await http('GET', '/api/machines')).body.machines.find((m) => m.name === 'lima1').state, 'broken')
    const before = await http('GET', '/api/machines/lima1/inspect')
    assert.deepEqual([before.body.state, before.body.reason], ['broken', 'outdated'], 'a record broken now keeps its state over the live read')
    fixed = true   // fixed on the CLI; the page has not listed since
    reads.length = 0
    const after = await http('GET', '/api/machines/lima1/inspect')
    assert.equal(after.status, 200)
    assert.equal(after.body.state, 'ready', 'never the stale listing\'s broken')
    assert.equal(after.body.fix ?? null, null)
    assert.deepEqual(reads.sort(), ['live', 'record'], 'one record read beside the live one')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('storage state lives in the LayerFS home: jobs are kept in client-neutral <home>/job and <home>/stat', async () => {
  const { http, root } = fakeGroups(base)
  const home = join(root, 'home')
  try {
    const v = await http('GET', '/api/storage')
    assert.equal(v.status, 200)
    assert.equal(statSync(join(home, 'job')).mode & 0o777, 0o700)
    assert.equal(statSync(join(home, 'stat')).mode & 0o777, 0o700)
    assert.ok(!existsSync(join(home, 'dsh-layerfs')))
    assert.ok(!existsSync(join(root, 'buckets.json')) && !existsSync(join(root, 'storage-jobs.json')) && !existsSync(join(root, 'doctor-jobs.json')))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('storage jobs: a move runs as a job with storage-job events; one job per Store', async () => {
  let finish
  const { http, events, root } = fakeGroups({
    ...base,
    // 2.0 `store move` replaces push and pull
    store: { ...base.store, move: (store, machine, { on_progress }) => new Promise((resolve) => { on_progress({ phase: 'send', done: 1, total: 2 }); finish = resolve }) },
  })
  try {
    const j = await http('POST', '/api/stores/s1/push', { machine: 'lima1' })
    assert.equal(j.status, 200)
    assert.equal(j.body.kind, 'push')
    const again = await http('POST', '/api/stores/s1/push', { machine: 'lima1' })
    assert.equal(again.status, 409)
    assert.equal(again.body.code, 'ConnectBusy')
    await new Promise((r) => setTimeout(r, 10))
    finish({ ok: true, outcome: 'moved' })
    await new Promise((r) => setTimeout(r, 10))
    const done = await http('GET', `/api/storage-jobs/${j.body.id}`)
    assert.equal(done.body.outcome, 'succeeded')
    const jobEvents = events.filter((e) => e.type === 'storage-job')
    assert.ok(jobEvents.length >= 2)
    assert.equal(jobEvents.at(-1).data.type, 'storage-job')
    assert.ok(jobEvents.at(-1).data.job.ended)
    assert.ok(existsSync(join(root, 'home', 'job', 'storage-jobs.json')))
    const view = await http('GET', '/api/storage')
    assert.equal(view.body.jobs[0].id, j.body.id)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('project removal sends project.delete (2.0 has no project.remove)', async () => {
  const sent = []
  const project = { delete: async (key) => { sent.push(['delete', key]); return { ok: true } } }
  const { http, root } = fakeGroups({ ...base, project })
  try {
    const r = await http('DELETE', '/api/projects/s1%2Fp')
    assert.equal(r.status, 200)
    assert.deepEqual(r.body, { removed: true })
    assert.deepEqual(sent, [['delete', 's1/p']])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('storage jobs: compact runs as a job with its steps, phases and report (2.0 store compact always reports progress)', async () => {
  const compactCall = (options) => async () => ({ ...(await discovery()), calls: [{ family: 'store', call: 'compact', args: [{ name: 'name', kind: 'name' }], options }] })
  let finish, given
  const impl = (kind) => ({
    ...base,
    store: {
      ...base.store,
      get: async () => ({ store: 's1', engine: kind, machine: kind === 'sqlite' ? 'macos-host' : null }),
      compact: (store, options) => new Promise((resolve) => { given = options; options.on_progress?.({ phase: 'mark', done: null, total: null }); options.on_progress?.({ phase: 'build', done: null, total: null }); finish = resolve }),
    },
  })
  // a runtime whose store.compact declares on_progress
  const { http, root } = fakeGroups(impl('sqlite'), compactCall([{ name: 'on_progress', kind: 'function' }]))
  try {
    const j = await http('POST', '/api/stores/s1/compact')
    assert.equal(j.status, 200)
    assert.equal(j.body.kind, 'compact')
    assert.deepEqual(j.body.steps, ['mark', 'build', 'verify', 'install'])
    await new Promise((r) => setTimeout(r, 10))
    assert.equal(typeof given.on_progress, 'function')
    const running = await http('GET', `/api/storage-jobs/${j.body.id}`)
    assert.equal(running.body.phase, 'build')
    assert.deepEqual(running.body.phases.map((p) => p.phase), ['mark', 'build'])
    assert.equal((await http('POST', '/api/stores/s1/compact')).body.code, 'ConnectBusy')
    // the 2.0 long form: `outcome` and `freed_bytes`
    finish({ outcome: 'compacted', freed_bytes: 4096 })
    await new Promise((r) => setTimeout(r, 10))
    const done = await http('GET', `/api/storage-jobs/${j.body.id}`)
    assert.equal(done.body.outcome, 'succeeded')
    assert.deepEqual(done.body.result, { outcome: 'compacted', freed_bytes: 4096 })
  } finally { rmSync(root, { recursive: true, force: true }) }
  // a PostgreSQL Store names its own steps; a refusal in `install` keeps the SDK's own code (not a transfer's unknown)
  const pg = fakeGroups({ ...impl('postgresql'), store: { ...impl('postgresql').store, compact: async () => { throw new Refusal('Capacity', 'no space', { phase: 'install' }) } } }, compactCall([{ name: 'on_progress', kind: 'function' }]))
  try {
    const j = await pg.http('POST', '/api/stores/s1/compact')
    assert.deepEqual(j.body.steps, ['mark', 'build', 'swap', 'cleanup'])
    await new Promise((r) => setTimeout(r, 10))
    const failed = await pg.http('GET', `/api/storage-jobs/${j.body.id}`)
    assert.equal(failed.body.outcome, 'failed')
    assert.equal(failed.body.error.code, 'Capacity')
  } finally { rmSync(pg.root, { recursive: true, force: true }) }
})

test('project init job and saved reads route to their calls', async () => {
  const head = 'c'.repeat(66)
  const src = mkdtempSync(join(tmpdir(), 'dsh-routes-src-'))
  const { http, root } = fakeGroups({
    ...base,
    // 2.0 long forms: project rows, `branch get`/list `commit`, `file list` items `{ path, type }`, `file stat`, `file read --detail`
    project: {
      init: async (key) => ({ project: key, store: 's1', engine: 'sqlite', machine: 'macos-host' }),
      list: async () => ({ items: [{ project: 's1/p', store: 's1', engine: 'sqlite' }] }),
      get: async (key) => ({ project: key, store: 's1', engine: 'sqlite', machine: 'macos-host' }),
    },
    branch: { get: async () => ({ commit: head }), list: async () => ({ items: [{ branch: 'main', commit: head }] }) },
    file: {
      list: async () => ({ items: [{ path: '/a.txt', type: 'file' }] }),
      stat: async () => ({ type: 'file', size: 3, mode: 0o644 }),
      read: async () => ({ text: 'hi\n', next_line: null, line_truncated: false, binary: false, size: 3 }),
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
    assert.deepEqual(list.body.map((p) => [p.key, p.storeState]), [['s1/p', 'ready']])
    const key = encodeURIComponent('s1/p')
    const fs = await http('GET', `/api/projects/${key}/fs?branch=main&path=/`)
    assert.deepEqual(fs.body, { items: [{ name: 'a.txt', path: '/a.txt', kind: 'file', size: null, mode: null }], next: null, at: { id: head } }, '2.0 lists no size or mode: an opened file reads them')
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

test('live: machines, store create, project init, list/get, branches, fs, file', { skip: !pin && liveSkipReason(), timeout: 600_000 }, async (context) => {
  // a short-ish path: the host daemon's sockets live in the home
  const root = tmpRoot('dshrt-')
  const home = join(root, 'home')
  // a 2.0 CLI makes no home on a read: `home init` first, as Set up LayerFS does
  execFileSync(pin.cli, ['home', 'init'], { env: { ...process.env, LAYERFS_HOME: home }, timeout: 30_000 })
  const src = join(root, 'src')
  mkdirSync(join(src, 'lib'), { recursive: true })
  writeFileSync(join(src, 'README.md'), '# hello\nworld\n')
  writeFileSync(join(src, 'lib', 'a.js'), 'export const a = 1\n')
  const lfs = R.cli.client({ cli: pin.cli, home })
  let recorded
  const t = testHost({
    lfs, root, home, cli: pin.cli, daemon: pin.daemon ?? null,
    discovery: () => R.cli.discover({ cli: pin.cli }),
    ensureHostDaemon: () => recorded ??= (process.platform === 'darwin' && pin.daemon ? lfs.machine.update('macos-host', { daemon: pin.daemon }) : Promise.resolve()),
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
  context.after(async () => {
    await http('POST', `/api/projects/${key}/close-sandboxes`, { force: true }).catch(() => {})
    await groups.projects.close()
    execFileSync(pin.cli, ['machine', 'stop', 'macos-host'], { env: { ...process.env, LAYERFS_HOME: home }, timeout: 30_000 })
    rmSync(root, { recursive: true, force: true })
  })
  const machines = await ok('GET', '/api/machines')
  assert.ok(machines.machines.some((m) => m.name === 'macos-host'))
  const status = await ok('GET', '/api/status')
  assert.equal(status.settings.home, home)
  const view = await ok('POST', '/api/stores', { name: 'rt' })
  assert.ok(view.stores.some((s) => s.name === 'rt' && s.machine === 'macos-host'))
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
})

// A Linux host machine Sandbox needs root for FUSE; the docker machine's worker runs
// namespaces Sandboxes as the container's own user. On macOS the host machine runs
// them directly. Either way the project sits on a Store of that machine.
const sandboxHost = !pin ? null : process.platform === 'darwin' ? 'macos-host' : existsSync('/var/run/docker.sock') && pin.bundle ? 'docker' : null
const sandboxSkip = !pin ? liveSkipReason() : !sandboxHost && 'needs Docker and DSH_LAYERFS_BUNDLE: a Linux host machine Sandbox needs root for FUSE'

test('live: a Sandbox, a forked side Branch mounted in it, its status, unmount and close', { skip: sandboxSkip, timeout: 600_000 }, async (context) => {
  const root = tmpRoot('dshsb-'), home = join(root, 'home'), src = join(root, 'src')
  const env = { ...process.env, LAYERFS_HOME: home, ...(pin.bundle ? { LAYERFS_BUNDLE: pin.bundle } : {}) }
  const savedBundle = process.env.LAYERFS_BUNDLE
  if (pin.bundle) process.env.LAYERFS_BUNDLE = pin.bundle
  const lfs = R.cli.client({ cli: pin.cli, home, bundle: pin.bundle })
  // the host machine's Sandboxes run this build's daemon, recorded once before the first call (as the host does)
  let recorded
  const ensureHostDaemon = () => recorded ??= (sandboxHost === 'macos-host' && pin.daemon ? lfs.machine.update('macos-host', { daemon: pin.daemon }) : Promise.resolve())
  const t = testHost({ lfs, root, home, cli: pin.cli, daemon: pin.daemon ?? null, discovery: () => R.cli.discover({ cli: pin.cli }), ensureHostDaemon })
  const groups = R.createGroups(t.host, async () => ({ ok: true }))
  const http = async (method, path, body) => R.handle(groups, { method, path, body })
  const ok = async (method, path, body) => {
    const r = await http(method, path, body)
    assert.equal(r.status, 200, `${method} ${path}: ${JSON.stringify(r.body)}`)
    return r.body
  }
  const key = encodeURIComponent('sbd/demo')
  context.after(async () => {
    await http('POST', `/api/projects/${key}/close-sandboxes`, { force: true }).catch(() => {})
    await groups.projects.close()
    // --force: a failed assertion may leave the Sandbox recorded; its worker must still go.
    try { execFileSync(pin.cli, ['machine', 'stop', sandboxHost, '--force'], { env, timeout: 120_000 }) } catch {}
    if (savedBundle === undefined) delete process.env.LAYERFS_BUNDLE; else process.env.LAYERFS_BUNDLE = savedBundle
    rmSync(root, { recursive: true, force: true })
  })
  execFileSync(pin.cli, ['home', 'init'], { env, timeout: 30_000 })
  if (sandboxHost === 'docker') execFileSync(pin.cli, ['machine', 'start', 'docker'], { env, timeout: 300_000 })
  mkdirSync(src)
  writeFileSync(join(src, 'README.md'), '# hello\n')
  execFileSync(pin.cli, ['store', 'create', 'sbd', '--machine', sandboxHost], { env, timeout: 120_000 })
  execFileSync(pin.cli, ['project', 'init', 'sbd/demo', src], { env, timeout: 120_000 })
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
  // The namespaces backend can still see a Sandbox process a moment after cgroup.kill and refuses
  // the removal with `nothing was sent` (before effect). Wait for it to clear, as a Busy retry does,
  // instead of failing this route test on LayerFS's teardown race.
  for (let i = 0; ; i++) {
    const removed = await http('DELETE', '/api/sandboxes/rtsb')
    if (removed.status === 200) break
    if (i >= 60 || !/nothing was sent/.test(String(removed.body?.message ?? ''))) {
      assert.equal(removed.status, 200, `DELETE /api/sandboxes/rtsb: ${JSON.stringify(removed.body)}`)
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  const gone = await http('GET', '/api/sandboxes/rtsb')
  assert.equal(gone.status, 404, JSON.stringify(gone.body))
})

test('file history: a provenance page walks the Branch\'s own line once per pinned head, then keeps it', async () => {
  const pin = (c) => c.repeat(66)
  const own = [{ commit: 'c3', parent: 'c2', change: 'modified', message: 'three' }, { commit: 'c2', parent: null, change: 'modified', message: 'two' }]
  const other = [{ commit: 'm1', parent: 'm0', change: 'added', message: 'one' }]
  const impl = {
    ...base,
    branch: { get: async () => ({ commit: pin('f') }) },
    // provenance: two of feat's own Commits and one made on main before the fork
    file: { history: async (_project, _branch, _path, o) => (o.traversal === 'branch' ? { items: own } : { items: [...own, ...other] }) },
    commit: { get: async (_project, id) => ({ m1: { branch: 'main' }, c3: { branch: 'feat' }, c2: { branch: 'feat' } })[id] ?? {} },
  }
  const { http, calls, root } = fakeGroups(impl)
  const path = `/api/projects/${encodeURIComponent('s1/p')}/file-query?branch=feat&path=%2Fa.txt&kind=revisions`
  try {
    const first = await http('GET', path)
    assert.equal(first.status, 200, JSON.stringify(first.body))
    assert.deepEqual(first.body.items.map((r) => [r.ref.id, r.ref.branch, r.message]), [['c3', 'feat', 'three'], ['c2', 'feat', 'two'], ['m1', 'main', 'one']])
    assert.deepEqual([first.body.has_more, first.body.continuation], [false, null])
    assert.deepEqual(calls, ['branch.get', 'file.history', 'file.history', 'commit.get'], 'the page, its own line, and the one version saved elsewhere')
    calls.length = 0
    const again = await http('GET', path)
    assert.deepEqual(again.body, first.body, 'the same rows in the same order')
    assert.deepEqual(calls, ['branch.get', 'file.history'], 'the own line of this pinned head is kept, so the history is walked once')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('commit detail: the diff is read only when the caller asks for the changes', async () => {
  const commit = 'a'.repeat(66), parent = 'b'.repeat(66)
  const impl = {
    ...base,
    branch: { get: async () => ({ commit }) },
    commit: {
      get: async () => ({ commit, parent, branch: 'feat', message: 'one', created_at: new Date(5).toISOString(), size: 12, new_canonical_bytes: 3, new_stored_bytes: 2, new_metadata_bytes: 1 }),
      diff: async () => ({ items: [{ path: '/a.txt', change: 'modified' }], next_cursor: 'c2' }),
    },
  }
  const { http, calls, root } = fakeGroups(impl)
  const path = `/api/projects/${encodeURIComponent('s1/p')}/history?branch=feat&commit=${commit}`
  try {
    const full = await http('GET', path)
    assert.equal(full.status, 200, JSON.stringify(full.body))
    assert.deepEqual(calls, ['commit.get', 'commit.diff'])
    assert.deepEqual(full.body.changes, [{ path: '/a.txt', kind: 'modified' }], 'the diff\'s rows, as the route has always named them')
    assert.equal(full.body.nextChanges, 'c2')
    // the fork-point row reads the header only (its `sourceBranch`), so its diff is not read
    calls.length = 0
    const head = await http('GET', `${path}&changes=0`)
    assert.equal(head.status, 200, JSON.stringify(head.body))
    assert.deepEqual(calls, ['commit.get'], 'no commit.diff')
    assert.deepEqual(head.body, { item: full.body.item, changes: [], nextChanges: null }, 'the same shape, with no changes read')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('project storage: a ledger of each save\'s counters from 2.0 commit list --detail pages (by cursor), then only new saves', async () => {
  const id = (c, n) => `12${String(n).padStart(3, '0')}${c.repeat(61)}`
  const layer = (n) => `32${String(n).padStart(3, '0')}${'f'.repeat(61)}`
  const at = (n) => new Date(1_000_000 + n * 1000).toISOString()
  // a 2.0 `commit list --detail` row: its time, how it was made, its tree's bytes and the bytes it wrote first
  const commit = (branch, n, extra = {}) => ({ commit: id(branch[0], n), branch, created_at: at(n), via: 'fs', size: 100, new_canonical_bytes: 20, new_stored_bytes: 10, new_metadata_bytes: 4, message: `save ${n}`, ...extra })
  const history = {
    a: [commit('a', 3), commit('a', 2, { via: 'merge' }), commit('a', 1)],
    b: [commit('b', 2), commit('b', 1)],
    // c is longer than one page (100 rows): its second page is asked by cursor
    c: Array.from({ length: 120 }, (_, i) => commit('c', 120 - i)),
    main: [{ commit: layer(2), source_branch: 'a', size: 40 }, { commit: layer(1), source_branch: 'b', size: 30 }],
  }
  const asked = []
  let openB = () => {}
  const gate = new Promise((resolve) => { openB = resolve })
  const impl = {
    ...base,
    project: {
      get: async (key) => ({ project: key, store: 's1', engine: 'sqlite', machine: 'macos-host', created_at: new Date(7).toISOString() }),
      stats: async () => ({ size: 100, file_count: 3, dir_count: 1, symlink_count: 0 }),
    },
    store: { ...base.store, get: async (name, o = {}) => ({ store: 's1', engine: 'sqlite', projects: ['p', 'q'], ...(o.with?.includes('stats') ? { stats: { logical_bytes: 1000, canonical_bytes: 400, stored_bytes: 100, metadata_bytes: 50, file_bytes: 4096 } } : {}) }) },
    branch: {
      // a Branch with no Commit of its own answers the one it was forked at (`d`): nothing to walk
      list: async () => ({ items: [{ branch: 'main', commit: history.main[0].commit }, ...['a', 'b', 'c'].map((b) => ({ branch: b, commit: history[b][0].commit, forked_from: layer(1) })), { branch: 'd', commit: layer(1), forked_from: layer(1) }] }),
    },
    commit: {
      list: async (_project, branch, options) => {
        asked.push([branch, options.cursor ?? null])
        if (branch === 'b') await gate
        const all = history[branch], from = all.findIndex((c) => c.commit === options.at)
        const rows = all.slice(from < 0 ? 0 : from), start = options.cursor ? Number(options.cursor) : 0
        return { items: rows.slice(start, start + options.limit), ...(start + options.limit < rows.length ? { next_cursor: String(start + options.limit) } : {}) }
      },
    },
  }
  const { http, groups, calls, root } = fakeGroups(impl)
  const path = `/api/projects/${encodeURIComponent('s1/p')}/storage`
  try {
    const first = await http('GET', path)
    assert.equal(first.status, 200, JSON.stringify(first.body))
    assert.equal(first.body.totals, null, 'nothing counted yet')
    assert.ok(first.body.building, 'the first read runs in the background')
    // while b's listing waits, the view already holds a's saves, marked partial
    let midway = first
    for (let i = 0; i < 100 && !(midway.body.totals?.saves >= 3); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      midway = await http('GET', path)
    }
    assert.equal(midway.body.totals?.saves, 3, JSON.stringify(midway.body))
    assert.equal(midway.body.partial, true)
    assert.ok(midway.body.building)
    assert.equal(midway.body.totals.stored, 30)
    openB()
    await groups.projects.storageLedgers.settle('s1/p', 7)
    const done = await http('GET', path)
    assert.equal(done.body.building, null)
    assert.equal(done.body.partial, false)
    assert.deepEqual(done.body.totals, { saves: 125, merges: 1, branches: 3, publications: 2, commitLogical: 12500, publicationLogical: 70, canonical: 2500, stored: 1250, metadata: 500 })
    assert.equal(done.body.recent.length, 30)
    assert.equal(done.body.growth.at(-1), 1250)
    assert.deepEqual({ name: done.body.store.name, projects: done.body.store.projects, stored: done.body.store.stored, file: done.body.store.file }, { name: 's1', projects: 2, stored: 100, file: 4096 })
    assert.deepEqual(done.body.main, { logical: 100, files: 3, directories: 1, complete: true })
    // the Store is opened once: one `store get --with stats` answers its counters and its projects
    calls.length = 0
    const counted = await http('GET', path)
    assert.equal(counted.status, 200, JSON.stringify(counted.body))
    assert.deepEqual(counted.body.store, done.body.store)
    assert.equal(calls.filter((c) => c === 'store.get').length, 1, 'one store get opens the Store once')
    assert.equal(calls.filter((c) => c === 'project.stats').length, 1, 'the main tree is still one project.stats')
    assert.deepEqual(asked.filter(([b]) => b === 'c'), [['c', null], ['c', '100']], 'c\'s second page by the cursor its first answered')
    assert.ok(!asked.some(([b]) => b === 'd'))
    // a new save on b: a recount lists only b, and stops at the save it knows
    history.b.unshift(commit('b', 200))
    asked.length = 0
    await http('GET', `${path}?refresh=1`)
    await groups.projects.storageLedgers.settle('s1/p', 7)
    const again = await http('GET', path)
    assert.deepEqual(asked, [['b', null]], 'one listing page of b, nothing of a, c or main')
    assert.equal(again.body.totals.saves, 126)
    assert.equal(again.body.totals.stored, 1260)
  } finally {
    openB()
    await groups.projects.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('project size: one call a row (the Store alone, the record otherwise), counting until the first count ends', async () => {
  const id = (n) => `12${String(n).padStart(3, '0')}${'a'.repeat(61)}`
  const history = [2, 1].map((n) => ({ commit: id(n), created_at: new Date(1_000_000 + n).toISOString(), via: 'fs', size: 100, new_canonical_bytes: 20, new_stored_bytes: 10, new_metadata_bytes: 4 }))
  let open = () => {}
  const gate = new Promise((resolve) => { open = resolve })
  const impl = {
    ...base,
    project: { get: async (key) => ({ project: key, store: 's1', engine: 'sqlite', machine: 'macos-host', created_at: new Date(7).toISOString() }), stats: async () => ({ size: 900, file_count: 3, dir_count: 1, symlink_count: 0 }) },
    store: { ...base.store, get: async (name, o = {}) => ({ store: 's1', engine: 'sqlite', projects: ['p'], ...(o.with?.includes('stats') ? { stats: { stored_bytes: 8423, metadata_bytes: 222021 } } : {}) }) },
    branch: { list: async () => ({ items: [{ branch: 'a', commit: history[0].commit, forked_from: null }] }) },
    commit: {
      list: async (_project, _branch, options) => {
        await gate
        const start = options.cursor ? Number(options.cursor) : 0
        return { items: history.slice(start, start + options.limit) }
      },
    },
  }
  const { http, groups, calls, root } = fakeGroups(impl)
  const path = `/api/projects/${encodeURIComponent('s1/p')}/size`
  try {
    // alone in its Store: the Store's packed bytes, publications to main included, from ONE read
    calls.length = 0
    const alone = await http('GET', `${path}?alone=1`)
    assert.equal(alone.status, 200, JSON.stringify(alone.body))
    assert.deepEqual(alone.body, { project: 's1/p', stored: 8423, counting: false })
    assert.deepEqual(calls, ['store.get'], 'one store get --with stats: no project record and no tree walk')
    // a shared Store: the record names the ledger, which is read from disk, so nothing else is asked
    calls.length = 0
    const first = await http('GET', path)
    assert.equal(first.status, 200, JSON.stringify(first.body))
    assert.deepEqual(first.body, { project: 's1/p', stored: null, counting: true })
    open()
    await groups.projects.storageLedgers.settle('s1/p', 7)
    calls.length = 0
    const done = await http('GET', path)
    assert.deepEqual(done.body, { project: 's1/p', stored: 20, counting: false })
    assert.deepEqual(calls, ['project.get'], 'the ledger is fresh: one record read, and no project.stats or store.get')
  } finally {
    open()
    await groups.projects.close()
    rmSync(root, { recursive: true, force: true })
  }
})
