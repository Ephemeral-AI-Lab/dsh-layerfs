// The Studio preset's PostgreSQL half (src/host/presets/postgresql.js): the
// recipe, the command plan, connect + attach through the runner, and the
// preset-owned Docker server, all against fakes (no Docker, no CLI).
//   node --test test/presets-postgresql.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = new URL('..', import.meta.url).pathname
const out = mkdtempSync(join(tmpdir(), 'dsh-presets-pg-'))
await build({
  absWorkingDir: root, entryPoints: { runner: 'src/host/presets/runner.js', build: 'src/host/presets/build.js', pg: 'src/host/presets/postgresql.js', presets: 'src/host/presets/recipe/presets.js' }, outdir: out,
  bundle: true, format: 'esm', platform: 'node', target: 'node24', logLevel: 'warning', outExtension: { '.js': '.mjs' },
})
const load = (name) => import(pathToFileURL(join(out, `${name}.mjs`)).href)
const { DemoRunner } = await load('runner')
const { presetScript } = await load('build')
const { PresetPostgres, storeMachines } = await load('pg')
const { presetOf } = await load('presets')

test('studio: half its Stores are PostgreSQL, each attached to its machine', () => {
  const stores = presetOf('studio').stores
  assert.equal(stores.length, 4)
  const pg = stores.filter((s) => s.kind === 'postgresql')
  assert.deepEqual(pg.map((s) => s.name), ['demo-services', 'demo-experiments'])
  assert.deepEqual(storeMachines(pg[0]), ['docker', 'native'])
  assert.deepEqual(storeMachines(pg[1]), ['demo-research'])
  assert.ok(pg.every((s) => /^[a-z_]+$/.test(s.database)))
})

test('script: PostgreSQL Stores connect and attach, never create or push', () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-presets-pg-state-'))
  const { commands, configuration } = presetScript({ preset: 'studio', spec: { state, home: join(state, 'home') }, sandboxes: false })
  assert.equal(configuration.historyLimits.perStore, 1) // one writer per Store
  const lines = commands.filter((c) => c.phase === 'build').map((c) => c.argv.join(' '))
  assert.ok(lines.some((l) => /^store connect demo-services postgresql:\/\/postgres@127\.0\.0\.1:<port>\/demo_services --password file:.*\/postgresql\/password$/.test(l)))
  assert.ok(lines.includes('store attach demo-services docker'))
  assert.ok(lines.includes('store attach demo-services native'))
  assert.ok(lines.includes('store attach demo-experiments demo-research'))
  assert.ok(!lines.some((l) => /store (create|push) demo-(services|experiments)\b/.test(l)))
  assert.ok(lines.includes('store create demo-studio') && lines.includes('store push demo-build-cache demo-build --progress'))
  // every machine a Store uses is started, attach targets included
  assert.ok(['docker', 'demo-research'].every((m) => lines.includes(`machine start ${m}`)))
  rmSync(state, { recursive: true, force: true })
})

/** A CLI that keeps Stores and their attachments, recording every mutation. */
function fakeDriver() {
  const stores = new Map(), calls = []
  const invoke = async (argv, options = {}) => {
    const [family, call, name, ...rest] = argv
    if (!options.read) calls.push(argv.join(' '))
    if (family === 'store' && call === 'list') return { items: [...stores.values()] }
    if (family === 'store' && call === 'get') { if (!stores.has(name)) throw Object.assign(new Error('no'), { code: 'NoSuchStore' }); return stores.get(name) }
    if (family === 'store' && call === 'connect') { stores.set(name, { name, kind: 'postgresql', created: 1, url: rest[0], machines: {} }); return stores.get(name) }
    if (family === 'store' && call === 'create') { stores.set(name, { name, kind: 'sqlite', created: 2, machine: 'native' }); return stores.get(name) }
    if (family === 'store' && call === 'attach') { stores.get(name).machines[rest[0]] = { checked: { at: 1 } }; return stores.get(name) }
    if (family === 'store' && call === 'push') { stores.get(name).machine = rest[0]; return stores.get(name) }
    throw new Error(`unexpected ${argv.join(' ')}`)
  }
  return { stores, calls, driver: { invoke, spec: {} } }
}

test('runner: a fresh database, then connect, then attach each machine once', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-presets-pg-runner-'))
  const { calls, driver } = fakeDriver()
  const log = []
  const postgres = {
    ensure: async () => { log.push('ensure'); return { container: 'c', port: 54999 } },
    freshDatabase: async (db) => { log.push(`fresh ${db}`) },
    url: (port, db) => `postgresql://postgres@127.0.0.1:${port}/${db}`,
    passwordRef: () => 'file:/state/postgresql/password',
  }
  const runner = new DemoRunner({ state, home: join(state, 'home'), adoptHome: true, preset: 'studio', driver, postgres, report: () => {} })
  runner.load(true)
  const services = presetOf('studio').stores.find((s) => s.name === 'demo-services')
  await runner.ensureStore(services)
  await runner.placeStore(services)
  await runner.placeStore(services) // already attached and checked: nothing more
  assert.deepEqual(log, ['ensure', 'fresh demo_services'])
  assert.deepEqual(calls, [
    'store connect demo-services postgresql://postgres@127.0.0.1:54999/demo_services --password file:/state/postgresql/password',
    'store attach demo-services docker',
    'store attach demo-services native',
  ])
  assert.equal(runner.manifest.resources.store['demo-services'].owned, true)
  // a second ensure finds the owned Store and neither drops nor reconnects it
  await runner.ensureStore(services)
  assert.deepEqual(log, ['ensure', 'fresh demo_services'])
  assert.equal(calls.length, 3)
  rmSync(state, { recursive: true, force: true })
})

test('server: one 127.0.0.1-only container on a fixed port, password kept 0600, databases recreated', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-presets-pg-server-'))
  const runs = []
  let created = false
  const exec = async (file, args) => {
    runs.push(args)
    if (args[0] === 'inspect') { if (!created) throw new Error('No such object'); return 'running\n' }
    if (args[0] === 'run') { created = true; return 'id\n' }
    if (args[0] === 'port') return `127.0.0.1:${runs.find((a) => a[0] === 'run')[runs.find((a) => a[0] === 'run').indexOf('-p') + 1].split(':')[1]}\n`
    return ''
  }
  const pg = new PresetPostgres({ state, docker: '/fake/docker', exec, sleep: async () => {} })
  const { port } = await pg.ensure()
  const run = runs.find((a) => a[0] === 'run')
  assert.equal(run.at(-1), 'postgres:17')
  assert.equal(run[run.indexOf('-p') + 1], `127.0.0.1:${port}:5432`)
  assert.ok(run.includes('--env-file') && !run.some((a) => a.includes('POSTGRES_PASSWORD=')))
  assert.equal(statSync(pg.passwordFile).mode & 0o777, 0o600)
  assert.ok(readFileSync(pg.passwordFile, 'utf8').length >= 20)
  assert.equal(pg.passwordRef(), `file:${pg.passwordFile}`)
  await pg.freshDatabase('demo_services')
  const psql = runs.at(-1)
  assert.deepEqual(psql.slice(-4), ['-c', 'DROP DATABASE IF EXISTS "demo_services" WITH (FORCE)', '-c', 'CREATE DATABASE "demo_services"'])
  await assert.rejects(pg.freshDatabase('x"; DROP'), (e) => e.code === 'InvalidInput')
  assert.equal(JSON.parse(readFileSync(join(state, 'postgresql', 'server.json'), 'utf8')).port, port)
  rmSync(state, { recursive: true, force: true })
})

test('preflight: a CLI built without PostgreSQL is refused before anything is reset', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-presets-pg-preflight-'))
  const calls = []
  const driver = { spec: {}, discover: async () => ({ identity: { features: ['machine'] } }), invoke: async (argv) => { calls.push(argv.join(' ')); return { platforms: [] } } }
  const runner = new DemoRunner({ state, home: join(state, 'home'), adoptHome: true, preset: 'studio', driver, postgres: { available: async () => null }, report: () => {} })
  await assert.rejects(runner.preflight(), /built without PostgreSQL \(features: machine\)/)
  assert.deepEqual(calls, [])
  rmSync(state, { recursive: true, force: true })
})

test('runner: a History(Busy) refusal is retried; other failures are not', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-presets-busy-'))
  let calls = 0
  const busy = () => Object.assign(new Error('Service(History(Busy))'), { code: 'Unknown', transport: 'refusal' })
  const driver = { spec: {}, invoke: async (argv) => { calls++; if (argv[1] === 'write' && calls < 3) throw busy(); if (argv[1] === 'fail') throw Object.assign(new Error('x'), { code: 'Unknown', transport: 'refusal' }); return { kind: 'Committed', head: 'h' } } }
  const runner = new DemoRunner({ state, home: join(state, 'home'), adoptHome: true, preset: 'studio', driver, report: () => {} })
  runner.backoff = async () => {}
  runner.load(true)
  assert.deepEqual(await runner.once('w', ['file', 'write', 'a/b', 'x', '/f']), { kind: 'Committed', head: 'h' })
  assert.equal(calls, 3)
  assert.equal(runner.manifest.steps.w.status, 'done')
  calls = 0
  await assert.rejects(runner.once('f', ['file', 'fail']))
  assert.equal(calls, 1)
  assert.equal(runner.manifest.steps.f.status, 'uncertain')
  // a refusal that keeps coming back stops after the bounded attempts
  calls = -100
  await assert.rejects(runner.once('w2', ['file', 'write', 'a/b', 'y', '/g']), /History\(Busy\)/)
  rmSync(state, { recursive: true, force: true })
})
