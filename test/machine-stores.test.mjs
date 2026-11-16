// The machine page's Stores tab and Connect a database, as data
// (src/client/storage/machine-stores.ts): the two kinds on a machine, the kind
// the tab opens on, PostgreSQL Stores by server, connection URLs and which
// check a store.attach refusal failed.
//   node --test test/machine-stores.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = new URL('..', import.meta.url).pathname
const out = mkdtempSync(join(root, 'lib', '.test-machine-stores-'))
await build({ absWorkingDir: root, stdin: { contents: "export * from './src/client/storage/machine-stores.ts'", resolveDir: root, loader: 'ts' }, outfile: join(out, 'ms.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24', logLevel: 'warning' })
const M = await import(pathToFileURL(join(out, 'ms.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

const t = (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key)
const sqlite = (name, machine, bytes) => ({ name, kind: 'sqlite', machine, projects: [name], size: bytes == null ? null : { bytes, file: bytes, wal: 0 }, state: 'idle', holders: 0, down: null, links: [], job: null })
const pg = (name, target, machines) => ({
  name, kind: 'postgresql', machine: null, projects: ['p'], size: null, state: 'idle', holders: 0, down: null, links: [], job: null,
  postgresql: { target, reachable: true, version: '16', latencyMs: 2, error: null },
  attachments: machines.map((machine) => ({ machine, own: false, url: null, target: null, password: null, saved: false, checked: { at: 1, version: '16', latencyMs: 2 }, lastError: null })),
})
const machine = (name, platform, supports = { sqlite: true, postgresql_sandbox: true, reason: null }, state = 'running') => ({ name, platform, state, supports })
const view = (stores, machines = [machine('native', 'native'), machine('docker', 'docker')]) => ({ stores, machines, buckets: [], jobs: [], features: { attach: true }, at: 0 })

test('a machine\'s Stores: its SQLite files with their total size, and the PostgreSQL Stores attached to it, by name', () => {
  const v = view([sqlite('b', 'docker', 300), sqlite('a', 'docker', null), sqlite('h', 'native', 5), pg('z', 'u@localhost:5432/z', ['native', 'docker']), pg('y', 'u@localhost:5432/y', ['native'])])
  const s = M.machineStores(v, 'docker', t)
  assert.deepEqual(s.sqlite.map((x) => x.name), ['a', 'b'])
  assert.equal(s.sqliteBytes, 300, 'a Store without a size is left out of the total, never counted as 0')
  assert.deepEqual(s.postgresql.map((x) => x.store.name), ['z'])
  assert.equal(s.postgresql[0].attachment.machine, 'docker')
  assert.equal(s.noSqlite, null)
  assert.equal(M.machineStores(view([sqlite('a', 'docker', null)]), 'docker', t).sqliteBytes, null, 'no size known is null')
})

test('a machine that takes neither kind says why; the tab opens on the kind asked for when the machine takes it, else the kind with Stores', () => {
  const v = view([pg('z', 'u@db:5432/z', ['native'])], [machine('lima', 'lima', { sqlite: true, postgresql_sandbox: false, reason: 'no route to the host' })])
  const s = M.machineStores(v, 'lima', t)
  assert.equal(s.noPostgresql, 'no route to the host')
  assert.equal(M.startKind(s, 'postgresql'), 'sqlite', 'a kind the machine cannot run, with nothing attached, is not opened')
  const both = M.machineStores(view([sqlite('a', 'docker', 1), pg('z', 'u@db:5432/z', ['docker'])]), 'docker', t)
  assert.equal(M.startKind(both, 'postgresql'), 'postgresql')
  assert.equal(M.startKind(both, null), 'sqlite')
  const pgOnly = M.machineStores(view([pg('z', 'u@db:5432/z', ['docker'])]), 'docker', t)
  assert.equal(M.startKind(pgOnly, null), 'postgresql', 'with nothing asked, the kind that has Stores here')
})

test('Connect a database lists PostgreSQL Stores by server and user: on the machine already, attachable, or why not', () => {
  const v = view([
    pg('demo-services', 'layerfs@localhost:5432/demo_services', ['native', 'docker']),
    pg('demo-experiments', 'layerfs@localhost:5432/demo_experiments', ['native']),
    pg('analytics', 'ro_user@warehouse.lan:5432/analytics', ['native']),
  ], [machine('native', 'native'), machine('docker', 'docker'), machine('off', 'lima', undefined, 'stopped')])
  const groups = M.pgServers(v, 'docker', t)
  assert.deepEqual(groups.map((g) => `${g.user}@${g.server}`), ['layerfs@localhost:5432', 'ro_user@warehouse.lan:5432'])
  assert.deepEqual(groups[0].stores.map((s) => [s.store.name, s.database, s.here, s.why]), [
    ['demo-experiments', 'demo_experiments', false, null],
    ['demo-services', 'demo_services', true, null],
  ])
  const stopped = M.pgServers(v, 'off', t)
  assert.equal(stopped[1].stores[0].why, 'machineStoppedAttach', 'a stopped machine says why, never offers Attach')
})

test('connection URLs: parsed from a URL or a bare target, built back without a password; a loopback server becomes the machine\'s alias', () => {
  assert.deepEqual(M.parsePgUrl('postgresql://app@db.internal:5432/orders'), { user: 'app', host: 'db.internal:5432', database: 'orders' })
  assert.deepEqual(M.parsePgUrl('ro_user@warehouse.lan:5432/analytics'), { user: 'ro_user', host: 'warehouse.lan:5432', database: 'analytics' })
  assert.equal(M.parsePgUrl(''), null)
  assert.equal(M.pgUrl({ user: 'app', host: 'db:5432', database: 'orders' }), 'postgresql://app@db:5432/orders')
  assert.equal(M.routedServer('localhost:5432', 'host.docker.internal'), 'host.docker.internal:5432')
  assert.equal(M.routedServer('127.0.0.1:5432', '192.168.5.2'), '192.168.5.2:5432')
  assert.equal(M.routedServer('db.internal:5432', 'host.docker.internal'), 'db.internal:5432', 'a remote server is dialled as it is')
  assert.equal(M.routedServer('localhost:5432', null), 'localhost:5432', 'native dials the host itself')
})

test('the step a store.attach refusal failed, from LayerFS\'s documented refusals; any other refusal names no step', () => {
  assert.equal(M.failedStep('Unavailable', 'machine docker cannot reach PostgreSQL Store x\'s server at db:5432: connection refused'), 'server')
  assert.equal(M.failedStep('Unavailable', 'machine docker, PostgreSQL Store x at db:5432: the PostgreSQL server holds another Store than x'), 'store')
  assert.equal(M.failedStep('Denied', 'password authentication failed for user "app"'), 'server', 'a login refused')
  assert.equal(M.failedStep('Denied', 'role app lacks USAGE on schema layerfs (3 privilege(s) missing in all)'), 'store')
  assert.equal(M.failedStep('Denied', 'role app lacks INSERT on table layerfs.objects (1 privilege(s) missing in all)'), 'write')
  assert.equal(M.failedStep('Conflict', 'Store x changed while machine docker was checked; attach it again'), null)
  assert.equal(M.failedStep(undefined, undefined), null)
})
