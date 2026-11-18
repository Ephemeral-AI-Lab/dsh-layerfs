// The `http` operation's router: dispatch, Connect's status mapping and
// bodies over a fake lfs, and a live pass over the real pinned CLI against a
// private temporary LAYERFS_HOME.
//   node --test test/routes.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
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

function fakeGroups(impl, discover = discovery, secrets = undefined) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-routes-root-'))
  const { lfs, calls } = fakeLfs(impl)
  const t = testHost({ lfs, root, home: join(root, 'home'), discovery: discover, ...(secrets ? { secrets: secrets(root) } : {}) })
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
    assert.equal(nf.body.code, 'NotFound')
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

test('store projects: every project with its ledger, newest Commit and main files; one tree walk per main head', async () => {
  let head = 'h1'
  const { http, calls, groups, root } = fakeGroups({
    ...base,
    store: { ...base.store, get: async () => ({ name: 's1', projects: ['web', 'docs', 'web'] }) },
    project: {
      get: async (key) => ({ project: key, store: 's1', name: key.slice(3), created: 1000 }),
      stats: async (key) => ({ project: key, files: key === 's1/web' ? 40 : 10001, complete: key === 's1/web' }),
    },
    branch: {
      get: async () => ({ name: 'main', saved_head: { id: head } }),
      list: async () => ({ items: [], next_page_pos: null }),
    },
  })
  try {
    const a = await http('GET', '/api/stores/s1/projects')
    assert.equal(a.status, 200)
    assert.equal(a.body.store, 's1')
    assert.deepEqual(a.body.projects.map((p) => p.name), ['docs', 'web'], 'deduplicated and sorted')
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

const pgMachines = async () => ({ machines: [
  { name: 'native', platform: 'native', state: 'ready', supports: { sqlite: true, postgresql_sandbox: true } },
  { name: 'docker', platform: 'docker', state: 'running', supports: { sqlite: true, postgresql_sandbox: true } },
  { name: 'vm1', platform: 'lima', state: 'stopped', supports: { sqlite: true, postgresql_sandbox: true } },
  { name: 'nopg', platform: 'x', state: 'running', supports: { sqlite: true, postgresql_sandbox: false, reason: 'no route to the host' } },
] })

test('postgresql: an entered password goes to an owner-only file; store.update edits the Store\'s connection or a machine\'s own; refusals never echo it', async () => {
  const record = { name: 'pg', kind: 'postgresql', url: 'postgresql://lfs@db.lan:5432/team', password: 'env:PGPW', synchronous_commit: 'local', projects: ['app'], state: 'idle' }
  const seen = []
  const { http, root } = fakeGroups({
    ...base,
    machine: { ...base.machine, list: pgMachines },
    store: {
      ...base.store,
      list: async () => ({ items: [record] }),
      get: async () => record,
      status: async () => ({ state: 'idle', server: { reachable: true, server_version: '17.1', latency_ms: 2 } }),
      connect: async (name, url, options) => { seen.push(['connect', options.password]); if (url.includes('bad')) throw new Refusal('Denied', 'password authentication failed') },
      update: async (name, options) => {
        seen.push(['update', options])
        if (options.machine === 'dev') throw new Refusal('Unavailable', 'machine dev cannot reach PostgreSQL Store pg\'s server at db.lan: refused')
        if (options.clear) { delete record.machines[options.machine]; return record }
        const { machine, ...connection } = options
        if (machine) record.machines = { ...record.machines, [machine]: { ...record.machines?.[machine], ...connection } }
        else Object.assign(record, connection)
        return record
      },
      disconnect: async () => ({ disconnected: 'pg' }),
    },
  })
  const secrets = join(root, 'secrets')
  const files = () => (existsSync(secrets) ? readdirSync(secrets).sort() : [])
  try {
    // connect with an entered password: a 0600 file, passed as file:, removed on refusal
    const bad = await http('POST', '/api/stores/postgresql', { name: 'pg2', url: 'postgresql://lfs@bad/x', passwordValue: 's3cret' })
    assert.equal(bad.status, 403)
    assert.ok(seen[0][1].startsWith(`file:${secrets}/pg-pg2--`))
    assert.deepEqual(files(), [])
    const ok = await http('POST', '/api/stores/postgresql', { name: 'pg2', url: 'postgresql://lfs@db/x', passwordValue: 's3cret' })
    assert.equal(ok.status, 200)
    assert.equal(files().length, 1)
    assert.equal(statSync(join(secrets, files()[0])).mode & 0o777, 0o600)
    assert.equal(readFileSync(join(secrets, files()[0]), 'utf8'), 's3cret')
    assert.ok(!JSON.stringify(ok.body).includes('s3cret'))
    // the view: one connection (its password a reference, never a secret), no machines of its own, nothing about attachments
    const row = ok.body.stores[0]
    assert.deepEqual([row.postgresql.target, row.postgresql.password, row.postgresql.saved, row.postgresql.synchronousCommit], ['lfs@db.lan:5432/team', 'env:PGPW', false, 'local'])
    assert.deepEqual(row.ownConnections, [])
    assert.equal('attachments' in row, false)
    assert.equal('features' in ok.body, false)
    // the Store's own connection: only what changed goes to store.update
    const edited = await http('POST', '/api/stores/pg/connection', { url: 'postgresql://lfs@db2.lan/team', synchronousCommit: 'off' })
    assert.equal(edited.status, 200)
    assert.deepEqual(seen.at(-1), ['update', { url: 'postgresql://lfs@db2.lan/team', synchronous_commit: 'off' }])
    assert.equal(edited.body.stores[0].postgresql.target, 'lfs@db2.lan/team')
    // a typed password for the Store: its own file, shown as saved, the reference never in the view
    const typed = await http('POST', '/api/stores/pg/connection', { passwordValue: 'newpw' })
    assert.equal(typed.status, 200)
    const own = files().find((f) => /^pg-pg--[0-9a-f]{8}\.pw$/.test(f))
    assert.ok(own)
    assert.deepEqual([typed.body.stores[0].postgresql.saved, typed.body.stores[0].postgresql.password], [true, null])
    // a machine's own connection with an entered password: its own file, listed as that machine's
    const vm = await http('POST', '/api/stores/pg/connection', { machine: 'vm1', url: 'postgresql://vm@10.0.0.5/team', passwordValue: 'vmpw' })
    assert.equal(vm.status, 200)
    const vmFile = files().find((f) => f.startsWith('pg-pg--vm1--'))
    assert.ok(vmFile)
    assert.deepEqual(seen.at(-1), ['update', { machine: 'vm1', url: 'postgresql://vm@10.0.0.5/team', password: `file:${join(secrets, vmFile)}` }])
    assert.deepEqual(vm.body.stores[0].ownConnections, [{ machine: 'vm1', url: 'postgresql://vm@10.0.0.5/team', target: 'vm@10.0.0.5/team', password: null, saved: true }])
    // a second update of the same machine replaces its file, and leaves the Store's own
    await http('POST', '/api/stores/pg/connection', { machine: 'vm1', passwordValue: 'vmpw2' })
    assert.equal(files().filter((f) => f.startsWith('pg-pg--vm1--')).length, 1)
    assert.notEqual(files().find((f) => f.startsWith('pg-pg--vm1--')), vmFile)
    assert.ok(files().includes(own))
    // a refusal: LayerFS's code, its file removed, nothing kept for the view
    const refused = await http('POST', '/api/stores/pg/connection', { machine: 'dev', passwordValue: 'devpw' })
    assert.equal(refused.status, 502)
    assert.equal(refused.body.code ?? refused.body.error?.code, 'Unavailable')
    assert.ok(!files().some((f) => f.startsWith('pg-pg--dev--')))
    const view = await http('GET', '/api/storage')
    assert.ok(!JSON.stringify(view.body).includes('devpw'))
    assert.deepEqual(view.body.stores[0].ownConnections.map((c) => c.machine), ['vm1'])
    // a password in the URL, a bad reference, nothing to change: refused before LayerFS
    const before = seen.length
    assert.equal((await http('POST', '/api/stores/pg/connection', { machine: 'x1', url: 'postgresql://a:b@h/d' })).status, 400)
    assert.equal((await http('POST', '/api/stores/pg/connection', { machine: 'x1', password: 'plain' })).status, 400)
    assert.equal((await http('POST', '/api/stores/pg/connection', { machine: 'x1' })).status, 400)
    assert.equal((await http('POST', '/api/stores/pg/connection', { clear: true })).status, 400, 'clear names a machine')
    assert.equal(seen.length, before)
    // clear removes that machine's own connection and its files, never the Store's
    const cleared = await http('POST', '/api/stores/pg/connection', { machine: 'vm1', clear: true })
    assert.equal(cleared.status, 200)
    assert.deepEqual(seen.at(-1), ['update', { machine: 'vm1', clear: true }])
    assert.ok(!files().some((f) => f.startsWith('pg-pg--vm1--')))
    assert.ok(files().includes(own))
    assert.deepEqual(cleared.body.stores[0].ownConnections, [])
    // the old routes are gone
    assert.equal((await http('POST', '/api/stores/pg/attach', { machine: 'docker' })).status, 404)
    assert.equal((await http('POST', '/api/stores/pg/detach', { machine: 'docker' })).status, 404)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('postgresql: where a Store runs is the plugin\'s own choice: docker by default, saved by connect and runs-on, dropped on disconnect', async () => {
  const records = [{ name: 'pg', kind: 'postgresql', url: 'postgresql://lfs@db.lan/team', password: 'env:PGPW', projects: [], state: 'idle' }, { name: 's1', machine: 'native', projects: ['p'], state: 'idle' }]
  let machines = pgMachines
  const { http, calls, events, root } = fakeGroups({
    ...base,
    machine: { ...base.machine, list: () => machines() },
    store: {
      ...base.store,
      list: async () => ({ items: records }),
      get: async (name) => records.find((r) => r.name === name) ?? (() => { throw new Refusal('NotFound', `no Store ${name}`) })(),
      status: async () => ({ state: 'idle', server: { reachable: true, server_version: '17.1', latency_ms: 2 } }),
      connect: async (name, url, options) => { records.push({ name, kind: 'postgresql', url, password: options.password, projects: [], state: 'idle' }) },
      disconnect: async (name) => { records.splice(records.findIndex((r) => r.name === name), 1); return { disconnected: name } },
    },
  })
  const saved = () => { try { return JSON.parse(readFileSync(join(root, 'store-machines.json'), 'utf8')) } catch { return null } }
  const runsOn = async (name) => (await http('GET', '/api/storage')).body.stores.find((s) => s.name === name).runsOn
  try {
    assert.equal(await runsOn('pg'), 'docker', 'no choice yet: docker, which runs PostgreSQL Sandboxes')
    assert.equal(await runsOn('s1'), null, 'a SQLite Store runs where its file is')
    assert.equal(saved(), null, 'a default is not written down')
    // the choice, saved in the plugin root and never sent to LayerFS
    const before = calls.length
    const set = await http('POST', '/api/stores/pg/runs-on', { machine: 'vm1' })
    assert.equal(set.status, 200)
    assert.equal(set.body.stores.find((s) => s.name === 'pg').runsOn, 'vm1', 'a stopped machine can be chosen: nothing is checked or started for a choice')
    assert.deepEqual(saved(), { pg: 'vm1' })
    assert.ok(events.some((e) => e.type === 'storage'))
    // the Machines view names it too (a machine page lists the Stores that run there)
    assert.deepEqual((await http('GET', '/api/machines')).body.postgresql.map((x) => [x.name, x.runsOn]), [['pg', 'vm1']])
    assert.ok(!calls.slice(before).some((c) => /^store\.(update|attach|connect)$/.test(c)), 'LayerFS records no machine for a PostgreSQL Store')
    // refusals: a machine that runs none, no such machine, a SQLite Store
    const none = await http('POST', '/api/stores/pg/runs-on', { machine: 'nopg' })
    assert.deepEqual([none.status, none.body.code, none.body.message], [400, 'Unsupported', 'no route to the host'])
    assert.equal((await http('POST', '/api/stores/pg/runs-on', { machine: 'ghost' })).status, 404)
    assert.equal((await http('POST', '/api/stores/s1/runs-on', { machine: 'docker' })).status, 400)
    assert.deepEqual(saved(), { pg: 'vm1' })
    // connect saves the machine picked in the dialog
    assert.equal((await http('POST', '/api/stores/postgresql', { name: 'pg2', url: 'postgresql://lfs@db.lan/two', password: 'env:PGPW', runsOn: 'native' })).status, 200)
    assert.deepEqual(saved(), { pg: 'vm1', pg2: 'native' })
    assert.equal(await runsOn('pg2'), 'native')
    // a saved machine that is gone falls back to the default; with no docker, native
    machines = async () => ({ machines: (await pgMachines()).machines.filter((m) => m.name === 'native' || m.name === 'docker') })
    await http('POST', '/api/stores', { name: 'bump' }) // any write: the view is read anew
    assert.equal(await runsOn('pg'), 'docker')
    machines = async () => ({ machines: (await pgMachines()).machines.filter((m) => m.name === 'native') })
    await http('POST', '/api/stores', { name: 'bump' })
    assert.equal(await runsOn('pg'), 'native')
    // disconnect forgets the choice
    assert.equal((await http('POST', '/api/stores/pg2/disconnect')).status, 200)
    assert.deepEqual(saved(), { pg: 'vm1' })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('postgresql: a Sandbox is made on the machine asked for, else where its Store runs; no machine is "not attached"', async () => {
  const made = []
  const { http, root } = fakeGroups({
    ...base,
    machine: { ...base.machine, list: pgMachines },
    project: { get: async (key) => ({ project: key, store: 'pg', kind: 'postgresql' }) },
    store: { ...base.store, list: async () => ({ items: [{ name: 'pg', kind: 'postgresql', url: 'postgresql://l@h/d', state: 'idle' }] }), get: async () => ({ name: 'pg', kind: 'postgresql' }) },
    sandbox: { ...base.sandbox, create: async (project, name, machine) => { made.push([name, machine]); return { name, machine } } },
  })
  const create = (body) => http('POST', `/api/projects/${encodeURIComponent('pg/app')}/sandboxes`, body)
  try {
    assert.equal((await create({ name: 'b1' })).status, 200)
    assert.equal((await create({ name: 'b2', machine: 'vm1' })).status, 200, 'a machine it was never "attached" to')
    assert.equal((await http('POST', '/api/stores/pg/runs-on', { machine: 'native' })).status, 200)
    assert.equal((await create({ name: 'b3' })).status, 200)
    assert.deepEqual(made, [['b1', 'docker'], ['b2', 'vm1'], ['b3', 'native']])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('postgresql: the check from a machine is store.status --machine, answered as it came and kept nowhere', async () => {
  const seen = []
  let answer = { check: { machine: 'docker', host: 'host.docker.internal:5432', ok: true, at: 1700, server_version: '17.1 (Debian)', latency_ms: 3 } }
  const { http, root } = fakeGroups({
    ...base,
    store: {
      ...base.store,
      list: async () => ({ items: [{ name: 'pg', kind: 'postgresql', url: 'postgresql://l@localhost/d', state: 'idle' }] }),
      status: async (name, options) => {
        if (!options?.machine) return { state: 'idle', server: { reachable: true } }
        seen.push(options)
        if (options.machine === 'ghost') throw new Refusal('NotFound', 'no machine named ghost')
        return { state: 'idle', ...answer }
      },
    },
  })
  try {
    const ok = await http('GET', '/api/stores/pg/check?machine=docker')
    assert.equal(ok.status, 200)
    assert.deepEqual(ok.body, { machine: 'docker', host: 'host.docker.internal:5432', ok: true, at: 1700, version: '17.1 (Debian)', latencyMs: 3 })
    assert.equal(seen[0].machine, 'docker')
    assert.ok(seen[0].timeout_ms > 0, 'its own budget, so it always asks LayerFS')
    // a check that failed is an answer, not a refusal: the dialog draws the step it stopped at
    answer = { check: { machine: 'docker', host: 'host.docker.internal:5432', ok: false, error: { code: 'Unavailable', message: 'machine docker cannot reach PostgreSQL Store pg\'s server at host.docker.internal:5432: connection refused' } } }
    const failed = await http('GET', '/api/stores/pg/check?machine=docker')
    assert.equal(failed.status, 200)
    assert.deepEqual([failed.body.ok, failed.body.error.code], [false, 'Unavailable'])
    assert.match(failed.body.error.message, /connection refused/)
    // a bad input is LayerFS's refusal; no machine named is this host's
    assert.equal((await http('GET', '/api/stores/pg/check?machine=ghost')).status, 404)
    assert.equal((await http('GET', '/api/stores/pg/check')).status, 400)
    // a CLI that answers no check (before store.status --machine) says so
    answer = {}
    const old = await http('GET', '/api/stores/pg/check?machine=docker')
    assert.deepEqual([old.status, old.body.code], [502, 'Failed'])
    // nothing of a check reaches the view
    const view = await http('GET', '/api/storage')
    assert.ok(!JSON.stringify(view.body).includes('host.docker.internal'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('postgresql: a Store row names its server; a new Store reuses a Store\'s password on the same server only', async () => {
  const records = [
    { name: 'pg', kind: 'postgresql', url: 'postgresql://lfs@DB.lan/team?sslmode=require', password: 'env:PGPW', projects: [], state: 'idle', machines: {} },
  ]
  const seen = []
  const { http, root } = fakeGroups({
    ...base,
    store: {
      ...base.store,
      list: async () => ({ items: records }),
      get: async (name) => records.find((r) => r.name === name) ?? (() => { throw new Refusal('NotFound', `no Store ${name}`) })(),
      status: async () => ({ state: 'idle', server: { reachable: true, server_version: '17.1', latency_ms: 2 } }),
      connect: async (name, url, options) => { seen.push([name, url, options.password]); records.push({ name, kind: 'postgresql', url, password: options.password, projects: [], state: 'idle', machines: {} }) },
    },
  })
  const secrets = join(root, 'secrets')
  try {
    const view = await http('GET', '/api/storage')
    const pg = view.body.stores.find((s) => s.name === 'pg').postgresql
    assert.deepEqual([pg.server, pg.database, pg.user, pg.url], ['db.lan:5432', 'team', 'lfs', 'postgresql://lfs@DB.lan/team?sslmode=require'])
    // a reference of the user's is shared as it is
    assert.equal((await http('POST', '/api/stores/postgresql', { name: 'pg2', url: 'postgresql://lfs@db.lan:5432/two', passwordFrom: 'pg' })).status, 200)
    assert.deepEqual(seen.at(-1), ['pg2', 'postgresql://lfs@db.lan:5432/two', 'env:PGPW'])
    // a file this host wrote is copied into the new Store's own file
    assert.equal((await http('POST', '/api/stores/postgresql', { name: 'pg3', url: 'postgresql://lfs@db.lan/three', passwordValue: 's3cret' })).status, 200)
    assert.equal((await http('POST', '/api/stores/postgresql', { name: 'pg4', url: 'postgresql://lfs@db.lan/four', passwordFrom: 'pg3' })).status, 200)
    const [, , ref3] = seen.find((x) => x[0] === 'pg3')
    const [, , ref4] = seen.find((x) => x[0] === 'pg4')
    assert.ok(ref4.startsWith(`file:${secrets}/pg-pg4--`))
    assert.notEqual(ref4, ref3)
    assert.equal(readFileSync(ref4.slice(5), 'utf8'), 's3cret')
    // another server, or no such Store: refused before LayerFS
    const before = seen.length
    assert.equal((await http('POST', '/api/stores/postgresql', { name: 'pg5', url: 'postgresql://lfs@other/five', passwordFrom: 'pg' })).status, 400)
    assert.notEqual((await http('POST', '/api/stores/postgresql', { name: 'pg6', url: 'postgresql://lfs@db.lan/six', passwordFrom: 'nope' })).status, 200)
    assert.equal(seen.length, before)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

/** A fake LayerFS `backup` family that keeps its bucket records in `<home>/backup/<name>/record.json`, as 2.0 does. */
function fakeBackup(home, seen = []) {
  const dir = (name) => join(home, 'backup', name)
  return {
    connect: async (name, url, options) => {
      seen.push(['connect', name, url, options.key])
      const u = url.startsWith('r2://') ? null : new URL(url)
      const [bucket, ...prefix] = (u ? u.pathname.slice(1) : url.slice('r2://'.length).split('/').slice(1).join('/')).split('/')
      const record = u
        ? { v: 1, name, provider: 'minio', endpoint: u.origin, bucket, prefix: prefix.join('/'), region: options.region ?? 'us-east-1', key: options.key }
        : { v: 1, name, provider: 'r2', account: url.slice('r2://'.length).split('/')[0], bucket, prefix: prefix.join('/'), region: 'auto', key: options.key }
      mkdirSync(dir(name), { recursive: true })
      writeFileSync(join(dir(name), 'record.json'), JSON.stringify(record))
      return { url, region: record.region }
    },
    list: async () => ({ items: [] }),
    disconnect: async (name) => { rmSync(dir(name), { recursive: true, force: true }); return { unlinked: [] } },
  }
}

test('buckets: entered keys go to a configured secrets folder; replace and disconnect use the recorded file', async () => {
  const seen = []
  let home
  const { http, root } = fakeGroups({ ...base, backup: new Proxy({}, { get: (_t, call) => fakeBackup(home, seen)[call] }) }, discovery, (root) => (home = join(root, 'home'), join(root, 'keys')))
  const keys = join(root, 'keys')
  try {
    const ok = await http('POST', '/api/buckets', { name: 'r2b', provider: 'r2', account: 'a'.repeat(32), bucket: 'bk', accessKey: 'AK', secretKey: 'SK' })
    assert.equal(ok.status, 200)
    const file = join(keys, 'bucket-r2b.key')
    assert.deepEqual(seen[0], ['connect', 'r2b', `r2://${'a'.repeat(32)}/bk`, `file:${file}`])
    assert.equal(statSync(keys).mode & 0o777, 0o700)
    assert.equal(statSync(file).mode & 0o777, 0o600)
    assert.equal(readFileSync(file, 'utf8'), 'access_key=AK\nsecret_key=SK\n')
    assert.ok(!existsSync(join(root, 'secrets')))
    // the view reads the bucket from LayerFS's record; the keys never reach it, and no buckets.json is kept
    const b = ok.body.buckets.find((x) => x.name === 'r2b')
    assert.deepEqual([b.provider, b.keys, b.key, b.url, b.region], ['r2', 'saved', null, `r2://${'a'.repeat(32)}/bk`, 'auto'])
    assert.ok(!JSON.stringify(ok.body).includes('SK'))
    assert.ok(!existsSync(join(root, 'buckets.json')))
    const replaced = await http('POST', '/api/buckets/r2b/keys', { accessKey: 'AK2', secretKey: 'SK2' })
    assert.equal(replaced.status, 200)
    assert.equal(readFileSync(file, 'utf8'), 'access_key=AK2\nsecret_key=SK2\n')
    const gone = await http('DELETE', '/api/buckets/r2b')
    assert.equal(gone.status, 200)
    assert.ok(!existsSync(file))
    assert.deepEqual((await http('GET', '/api/storage')).body.buckets, [])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('buckets: by default entered keys go to <home>/secret; a home made for them is owner-only', async () => {
  let home
  const { http, root } = fakeGroups({ ...base, backup: new Proxy({}, { get: (_t, call) => fakeBackup(home)[call] }) }, discovery, (root) => (home = join(root, 'home'), join(root, 'home', 'secret')))
  try {
    const ok = await http('POST', '/api/buckets', { name: 'b', provider: 'minio', endpoint: 'http://minio:9000', bucket: 'bk', accessKey: 'AK', secretKey: 'SK' })
    assert.equal(ok.status, 200)
    assert.equal(statSync(join(root, 'home')).mode & 0o777, 0o700)
    assert.equal(statSync(join(root, 'home', 'secret', 'bucket-b.key')).mode & 0o777, 0o600)
    const b = ok.body.buckets.find((x) => x.name === 'b')
    assert.deepEqual([b.provider, b.keys, b.url], ['minio', 'saved', 'http://minio:9000/bk'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('storage state lives in the LayerFS home: buckets another client connected show up; jobs are kept in client-neutral <home>/job and <home>/stat', async () => {
  const { http, root } = fakeGroups(base)
  const home = join(root, 'home')
  try {
    // connected by Connect or the bare CLI: only LayerFS's record exists
    mkdirSync(join(home, 'backup', 'shared'), { recursive: true })
    writeFileSync(join(home, 'backup', 'shared', 'record.json'), JSON.stringify({ v: 1, name: 'shared', provider: 'minio', endpoint: 'http://127.0.0.1:9000', bucket: 'lfs', prefix: 'p', region: 'us-east-1', key: 'env:LAYERFS_SHARED' }))
    const v = await http('GET', '/api/storage')
    assert.equal(v.status, 200)
    assert.deepEqual(v.body.buckets.map((b) => [b.name, b.provider, b.keys, b.key, b.url]), [['shared', 'minio', 'reference', 'env:LAYERFS_SHARED', 'http://127.0.0.1:9000/lfs/p']])
    assert.equal(statSync(join(home, 'job')).mode & 0o777, 0o700)
    assert.equal(statSync(join(home, 'stat')).mode & 0o777, 0o700)
    assert.ok(!existsSync(join(home, 'dsh-layerfs')))
    assert.ok(!existsSync(join(root, 'buckets.json')) && !existsSync(join(root, 'storage-jobs.json')) && !existsSync(join(root, 'doctor-jobs.json')))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('storage state: an earlier <home>/dsh-layerfs is moved into job/ and stat/ when the routes start; what is there wins, the old folder goes', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-routes-root-'))
  const home = join(root, 'home'), legacy = join(home, 'dsh-layerfs')
  try {
    mkdirSync(join(legacy, 'project-storage'), { recursive: true })
    writeFileSync(join(legacy, 'doctor-jobs.json'), '[]')
    writeFileSync(join(legacy, 'project-storage', 'a.json'), '{}')
    mkdirSync(join(home, 'job'), { recursive: true })
    writeFileSync(join(home, 'job', 'storage-jobs.json'), '[]')
    writeFileSync(join(legacy, 'storage-jobs.json'), '[{"old":1}]')
    const { lfs } = fakeLfs(base)
    R.createGroups(testHost({ lfs, root, home, discovery }).host, async () => ({ ok: true }))
    assert.equal(readFileSync(join(home, 'job', 'doctor-jobs.json'), 'utf8'), '[]')
    assert.equal(readFileSync(join(home, 'stat', 'project-storage', 'a.json'), 'utf8'), '{}')
    assert.equal(readFileSync(join(home, 'job', 'storage-jobs.json'), 'utf8'), '[]')
    for (const d of ['job', 'stat', 'stat/project-storage', 'stat/storage-observations']) assert.equal(statSync(join(home, d)).mode & 0o777, 0o700, d)
    assert.ok(!existsSync(legacy))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('recordUrl: MinIO and R2 records', () => {
  assert.equal(R.recordUrl({ provider: 'minio', endpoint: 'http://h:9000/', bucket: 'b', prefix: 'x/y' }), 'http://h:9000/b/x/y')
  assert.equal(R.recordUrl({ provider: 'r2', account: 'f'.repeat(32), bucket: 'b', prefix: '', jurisdiction: 'eu' }), `r2://${'f'.repeat(32)}/b?jurisdiction=eu`)
  assert.equal(R.recordUrl({ provider: 'r2', endpoint: `https://${'f'.repeat(32)}.eu.r2.cloudflarestorage.com`, bucket: 'b', prefix: 'p' }), `r2://${'f'.repeat(32)}/b/p`)
  assert.equal(R.recordUrl({ url: 'r2://x/y' }), 'r2://x/y')
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
    assert.ok(existsSync(join(root, 'home', 'job', 'storage-jobs.json')))
    const view = await http('GET', '/api/storage')
    assert.equal(view.body.jobs[0].id, j.body.id)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('storage jobs: compact runs as a job with its steps, phases and report; an older runtime has none', async () => {
  const compactCall = (options) => async () => ({ ...(await discovery()), calls: [{ family: 'store', call: 'compact', args: [{ name: 'name', kind: 'name' }], options }] })
  let finish, given
  const impl = (kind) => ({
    ...base,
    store: {
      ...base.store,
      get: async () => ({ name: 's1', kind, machine: kind === 'sqlite' ? 'native' : null }),
      compact: (store, options) => new Promise((resolve) => { given = options; options.on_progress?.({ phase: 'mark', done: null, total: null }); options.on_progress?.({ phase: 'build', done: null, total: null }); finish = resolve }),
    },
  })
  // a runtime whose store.compact declares on_progress
  const { http, root } = fakeGroups(impl('sqlite'), compactCall([{ name: 'on_progress', kind: 'function' }]))
  try {
    assert.equal((await http('GET', '/api/storage')).body.compact, true)
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
    finish({ kind: 'Compacted', path: 'rebuild', physical_shrink: 4096 })
    await new Promise((r) => setTimeout(r, 10))
    const done = await http('GET', `/api/storage-jobs/${j.body.id}`)
    assert.equal(done.body.outcome, 'succeeded')
    assert.deepEqual(done.body.result, { kind: 'Compacted', path: 'rebuild', physical_shrink: 4096 })
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
  // store.compact without on_progress: the job runs, and the option is not passed
  const plain = fakeGroups(impl('sqlite'), compactCall([]))
  try {
    await plain.http('POST', '/api/stores/s1/compact')
    await new Promise((r) => setTimeout(r, 10))
    assert.equal(given.on_progress, undefined)
    finish({ kind: 'Compacted', path: 'none' })
    await new Promise((r) => setTimeout(r, 10))
  } finally { rmSync(plain.root, { recursive: true, force: true }) }
  // a runtime with no store.compact: the view says so and the route refuses before any call
  const old = fakeGroups(impl('sqlite'))
  try {
    assert.equal((await old.http('GET', '/api/storage')).body.compact, false)
    const refused = await old.http('POST', '/api/stores/s1/compact')
    assert.equal(refused.status, 409)
    assert.equal(refused.body.code, 'Unsupported')
    assert.ok(!old.calls.includes('store.compact'))
  } finally { rmSync(old.root, { recursive: true, force: true }) }
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

test('project storage: a ledger of each save\'s counters, read from listing pages once, then only new saves', async () => {
  const id = (c, n) => `12${String(n).padStart(2, '0')}${c.repeat(62)}`
  const layer = (n) => `32${String(n).padStart(2, '0')}${'f'.repeat(62)}`
  const commit = (branch, n, extra = {}) => ({ id: id(branch[0], n), ref: { id: id(branch[0], n), kind: 'Commit', branch }, time: 1000 + n, via: 'fs', logical: 100, ...extra })
  const counters = (c) => ({ message: `save ${c.id.slice(2, 4)}`, new_canonical: 20, new_stored: 10, new_metadata: 4 })
  const history = {
    a: [commit('a', 3), commit('a', 2, { via: 'merge' }), commit('a', 1)],
    // b's oldest save lists without counters (an older listing): it is read whole
    b: [commit('b', 2), commit('b', 1, { bare: true })],
    // c is long enough to page: 25 is refused, then 10 is refused on its second page
    c: Array.from({ length: 12 }, (_, i) => commit('c', 12 - i)),
    main: [{ id: layer(2), ref: { id: layer(2), kind: 'Layer', branch: 'main' }, logical: 40 }, { id: layer(1), ref: { id: layer(1), kind: 'Layer', branch: 'main' }, logical: 30 }],
  }
  const read = [], served = []
  let openB = () => {}
  let gate = new Promise((resolve) => { openB = resolve })
  const impl = {
    ...base,
    project: { get: async (key) => ({ project: key, name: 'p', store: 's1', machine: 'native', created: 7 }), stats: async () => ({ logical: 100, files: 3, directories: 1, complete: true }) },
    store: { ...base.store, stats: async () => ({ name: 's1', history_logical: 1000, canonical: 400, stored: 100, metadata: 50, file: 4096 }), get: async () => ({ name: 's1', projects: ['p', 'q'] }) },
    branch: {
      list: async () => ({ items: [{ name: 'main', base: history.main[0].id }, ...['a', 'b', 'c'].map((name) => ({ name, head: history[name][0].id }))], next_page_pos: null }),
      commits: async (_project, branch, options) => {
        if (branch === 'b') await gate
        if (branch === 'c' && (options.page_size === 25 || (options.page_size === 10 && options.page > 1))) throw Object.assign(new Error('saved history page exceeds reply budget'), { code: 'Capacity' })
        const all = history[branch], from = all.findIndex((c) => c.id === options.at_commit)
        const rows = all.slice(from < 0 ? 0 : from), start = (options.page - 1) * options.page_size
        const items = rows.slice(start, start + options.page_size).map(({ bare, ...c }) => options.include_storage && !bare ? { ...c, ...counters(c) } : c)
        if (options.include_storage) served.push(...items.map((c) => c.id))
        return { items, has_more: start + options.page_size < rows.length }
      },
      get_commit: async (_project, branch, commitId) => {
        read.push(commitId)
        const { bare, ...c } = history[branch].find((x) => x.id === commitId)
        return { ...c, ...counters(c) }
      },
    },
  }
  const { http, groups, root } = fakeGroups(impl)
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
    assert.deepEqual(done.body.totals, { saves: 17, merges: 1, branches: 3, publications: 2, commitLogical: 1700, publicationLogical: 70, canonical: 340, stored: 170, metadata: 68 })
    assert.equal(done.body.recent.length, 17)
    assert.equal(done.body.growth.at(-1), 170)
    assert.deepEqual({ name: done.body.store.name, projects: done.body.store.projects, stored: done.body.store.stored, file: done.body.store.file }, { name: 's1', projects: 2, stored: 100, file: 4096 })
    assert.deepEqual(done.body.main, { logical: 100, files: 3, directories: 1, complete: true })
    assert.deepEqual(read, [history.b[1].id], 'only the save listed without counters is read whole')
    const cServed = served.filter((x) => x.startsWith('12') && x.endsWith('c'.repeat(62)))
    assert.deepEqual(cServed.slice().sort(), history.c.map((c) => c.id).sort(), 'smaller pages resume where the refused one began')
    assert.equal(new Set(cServed).size, cServed.length, 'no save of c listed twice')
    // a new save on b: a recount lists only it
    history.b.unshift(commit('b', 3))
    read.length = 0
    served.length = 0
    await http('GET', `${path}?refresh=1`)
    await groups.projects.storageLedgers.settle('s1/p', 7)
    const again = await http('GET', path)
    assert.deepEqual(read, [])
    assert.deepEqual(served, history.b.map((c) => c.id), 'one listing page of b, nothing of a or c')
    assert.equal(again.body.totals.saves, 18)
    assert.equal(again.body.totals.stored, 180)
  } finally {
    openB()
    await groups.projects.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('project size: counting until the first count ends, then packed bytes and main\'s files; the Store\'s bytes when alone', async () => {
  const id = (n) => `12${String(n).padStart(2, '0')}${'a'.repeat(62)}`
  const history = [2, 1].map((n) => ({ id: id(n), ref: { id: id(n), kind: 'Commit', branch: 'a' }, time: 1000 + n, via: 'fs', logical: 100, new_canonical: 20, new_stored: 10, new_metadata: 4 }))
  let open = () => {}
  const gate = new Promise((resolve) => { open = resolve })
  const impl = {
    ...base,
    project: { get: async (key) => ({ project: key, name: 'p', store: 's1', machine: 'native', created: 7 }), stats: async () => ({ logical: 900, files: 3, directories: 1, complete: true }) },
    store: { ...base.store, stats: async () => ({ name: 's1', stored: 8423, metadata: 222021 }) },
    branch: {
      list: async () => ({ items: [{ name: 'a', head: history[0].id }], next_page_pos: null }),
      commits: async (_project, _branch, options) => {
        await gate
        const start = (options.page - 1) * options.page_size
        return { items: history.slice(start, start + options.page_size), has_more: start + options.page_size < history.length }
      },
    },
  }
  const { http, groups, root } = fakeGroups(impl)
  const path = `/api/projects/${encodeURIComponent('s1/p')}/size`
  try {
    const first = await http('GET', path)
    assert.equal(first.status, 200, JSON.stringify(first.body))
    assert.deepEqual(first.body, { project: 's1/p', stored: null, counting: true, files: 900 })
    open()
    await groups.projects.storageLedgers.settle('s1/p', 7)
    const done = await http('GET', path)
    assert.deepEqual(done.body, { project: 's1/p', stored: 20, counting: false, files: 900 })
    // alone in its Store: the Store's packed bytes, publications to main included
    const alone = await http('GET', `${path}?alone=1`)
    assert.deepEqual(alone.body, { project: 's1/p', stored: 8423, counting: false, files: 900 })
  } finally {
    open()
    await groups.projects.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('project storage: a CLI older than include_storage falls back to reading each save', async () => {
  const id = (n) => `12${String(n).padStart(2, '0')}${'a'.repeat(62)}`
  const history = [3, 2, 1].map((n) => ({ id: id(n), ref: { id: id(n), kind: 'Commit', branch: 'a' }, time: 1000 + n, via: 'fs', logical: 100 }))
  const read = [], asked = []
  const impl = {
    ...base,
    project: { get: async (key) => ({ project: key, name: 'p', store: 's1', machine: 'native', created: 7 }), stats: async () => null },
    store: { ...base.store, stats: async () => ({ name: 's1', stored: 100 }), get: async () => ({ name: 's1', projects: ['p'] }) },
    branch: {
      list: async () => ({ items: [{ name: 'a', head: history[0].id }], next_page_pos: null }),
      commits: async (_project, _branch, options) => {
        asked.push(options)
        // the SDK refuses an option the CLI's help does not list
        if ('include_storage' in options) throw Object.assign(new Error('branch.commits: unknown option include_storage'), { code: 'InvalidInput' })
        const start = (options.page - 1) * options.page_size
        return { items: history.slice(start, start + options.page_size), has_more: start + options.page_size < history.length }
      },
      get_commit: async (_project, _branch, commitId) => {
        read.push(commitId)
        return { ...history.find((c) => c.id === commitId), new_canonical: 20, new_stored: 10, new_metadata: 4 }
      },
    },
  }
  const { http, groups, root } = fakeGroups(impl)
  const path = `/api/projects/${encodeURIComponent('s1/p')}/storage`
  try {
    await http('GET', path)
    await groups.projects.storageLedgers.settle('s1/p', 7)
    const done = await http('GET', path)
    assert.equal(done.body.error, null, JSON.stringify(done.body.error))
    assert.equal(done.body.totals.saves, 3)
    assert.equal(done.body.totals.stored, 30)
    assert.deepEqual(read.slice().sort(), history.map((c) => c.id).sort())
    assert.equal(asked.filter((o) => 'include_storage' in o).length, 1, 'asked once, then remembered')
  } finally {
    await groups.projects.close()
    rmSync(root, { recursive: true, force: true })
  }
})
