// Presets (src/host/presets): admission, request-ID reconciliation, restart
// recovery, the router's exclusive guard, script paging, and a live reset of a
// private temporary LAYERFS_HOME over the real pinned CLI.
//   node --test test/presets.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { loadRoutes, pinned, testHost } from './routes-helper.mjs'

const root = new URL('..', import.meta.url).pathname
const out = mkdtempSync(join(tmpdir(), 'dsh-presets-'))
await build({
  absWorkingDir: root, entryPoints: { presets: 'src/host/presets/manager.ts' }, outdir: out,
  bundle: true, format: 'esm', platform: 'node', target: 'node24', logLevel: 'warning', outExtension: { '.js': '.mjs' },
})
const { PresetManager } = await import(pathToFileURL(join(out, 'presets.mjs')).href)
const R = await loadRoutes()

function fakeHost({ cli = '/nonexistent/layerfs', home, state, sessions = [], projects = [], busy = [] } = {}) {
  const events = [], forgotten = []
  return {
    events, forgotten,
    host: {
      spec: () => ({ cli, home, bundle: null, daemon: null, state }),
      busy: () => busy,
      boundSessions: () => sessions,
      dshProjects: () => projects.filter((p) => !forgotten.includes(p.project)),
      forgetProject: async (project) => { forgotten.push(project) },
      emit: (type, data) => events.push({ type, data }),
    },
  }
}

function dirs() {
  const base = mkdtempSync(join(tmpdir(), 'dsh-presets-t-'))
  return { base, state: join(base, 'presets'), home: join(base, 'home') }
}

test('list: the Studio library over an uninitialized home', () => {
  const d = dirs()
  const m = new PresetManager(fakeHost(d).host, d.state, d.home)
  const view = m.list()
  assert.equal(view.busy, false)
  assert.equal(view.items.length, 1)
  const studio = view.items[0]
  assert.equal(studio.id, 'studio')
  assert.deepEqual([studio.machines.length, studio.stores, studio.projects], [4, 4, 8])
  assert.equal(studio.initialized, false)
  assert.equal(studio.built, false)
  assert.equal(studio.contentReady, false)
  assert.ok(studio.projectDefinitions.every((p) => p.history.commits > 0 && p.branches.length > 0))
  assert.deepEqual(studio.requirements, ['docker', 'lima'])
  assert.equal(m.definition('studio', 'mixed').requirements.includes('daemon'), true)
  rmSync(d.base, { recursive: true, force: true })
})

test('admission: bound sessions and active work refuse a reset with their names', async () => {
  const d = dirs()
  const sessions = [{ id: 'session-abc', project: 's/p' }]
  const m = new PresetManager(fakeHost({ ...d, sessions, busy: ['a storage job'] }).host, d.state, d.home)
  const body = { requestId: 'r1', expectedPlan: 'x', confirm: true, rebuild: false, sandboxes: false }
  await assert.rejects(m.resetEnvironment('studio', body), (e) => {
    assert.equal(e.code, 'ConnectBusy'); assert.equal(e.status, 409)
    assert.deepEqual(e.detail.sessions, sessions)
    assert.deepEqual(e.detail.work, ['a storage job'])
    assert.match(e.message, /open Sandbox/)
    return true
  })
  await assert.rejects(m.resetEnvironment('studio', { ...body, confirm: false }), (e) => e.code === 'InvalidInput')
  // force skips the session check, never the other work
  await assert.rejects(m.resetEnvironment('studio', { ...body, requestId: 'r2', force: true }), (e) => {
    assert.equal(e.code, 'ConnectBusy')
    assert.deepEqual(e.detail.sessions, [])
    assert.deepEqual(e.detail.work, ['a storage job'])
    assert.doesNotMatch(e.message, /open Sandbox/)
    return true
  })
  rmSync(d.base, { recursive: true, force: true })
})

test('admission: a forced reset is admitted with bound sessions', async () => {
  const d = dirs()
  const m = new PresetManager(fakeHost({ ...d, sessions: [{ id: 'session-abc', project: 's/p' }] }).host, d.state, d.home)
  const body = { requestId: 'r1', expectedPlan: 'x', confirm: true, rebuild: false, sandboxes: false, force: true }
  // admitted, then fails inside the run: this home was never initialized
  await assert.rejects(m.resetEnvironment('studio', body), (e) => e.code !== 'ConnectBusy')
  rmSync(d.base, { recursive: true, force: true })
})

test('restart: running jobs become interrupted, a dead lock is cleared; request IDs reconcile', async () => {
  const d = dirs()
  mkdirSync(d.state, { recursive: true })
  const job = { id: 'j1', requestId: 'r1', fingerprint: JSON.stringify(['studio', 'environment-reset', 'sig', false, false, 'filesystem', false]), preset: 'studio', command: 'environment-reset', executionMode: 'filesystem', rebuild: false, actionId: 'a', state: 'running', phase: 'x', created: 1, log: [] }
  writeFileSync(join(d.state, 'demo-preset-jobs.json'), JSON.stringify([job]))
  writeFileSync(join(d.state, 'demo-fixtures.lock'), JSON.stringify({ pid: 2 ** 22 + 12345, actionId: 'a' }))
  const m = new PresetManager(fakeHost(d).host, d.state, d.home)
  assert.equal(existsSync(join(d.state, 'demo-fixtures.lock')), false)
  const seen = await m.route('GET', ['requests', 'r1'], undefined, new URLSearchParams())
  assert.equal(seen.state, 'interrupted')
  assert.equal(m.exclusive(), false)
  // the same request answers the same job; other settings under its ID are refused
  const same = await m.resetEnvironment('studio', { requestId: 'r1', expectedPlan: 'sig', confirm: true, rebuild: false, sandboxes: false })
  assert.equal(same.id, 'j1')
  await assert.rejects(m.resetEnvironment('studio', { requestId: 'r1', expectedPlan: 'other', confirm: true, rebuild: false, sandboxes: false }), (e) => e.code === 'Conflict')
  await assert.rejects(m.route('GET', ['requests', 'nope'], undefined, new URLSearchParams()), (e) => e.status === 404)
  assert.equal(await m.route('GET', ['studio', 'unknown-op'], undefined, new URLSearchParams()), undefined)
  rmSync(d.base, { recursive: true, force: true })
})

test('script: paged snapshot, scoped to a project, without touching the home', async () => {
  const d = dirs()
  const m = new PresetManager(fakeHost(d).host, d.state, d.home)
  const first = await m.route('GET', ['studio', 'script-no-sandboxes'], undefined, new URLSearchParams({ offset: '0', limit: '100' }))
  assert.equal(first.commands.length, 100)
  assert.ok(first.total > 1000)
  assert.equal(first.next, 100)
  assert.equal(first.dynamicReset, true)
  assert.equal(first.configuration.home, d.home)
  const second = await m.route('GET', ['studio', 'script-no-sandboxes'], undefined, new URLSearchParams({ offset: '100', limit: '100', snapshot: first.snapshot }))
  assert.equal(second.offset, 100)
  assert.equal(second.snapshot, first.snapshot)
  const scoped = await m.route('GET', ['studio', 'script-no-sandboxes'], undefined, new URLSearchParams({ offset: '0', limit: '1000', kind: 'project', name: 'demo-studio/website' }))
  assert.ok(scoped.commands.length > 0)
  assert.ok(scoped.commands.every((c) => c.phase !== 'reset' && c.argv.join(' ').includes('demo-studio/website')))
  await assert.rejects(m.route('GET', ['studio', 'script'], undefined, new URLSearchParams({ offset: '0', snapshot: first.snapshot })), (e) => e.code === 'Conflict')
  assert.equal(existsSync(d.home), false)
  rmSync(d.base, { recursive: true, force: true })
})

test('router: while a preset holds the home, changes are refused and reads pass', async () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-presets-r-'))
  const lfs = new Proxy({ spec: { cli: '/fake', home: base } }, { get: (t, f) => f in t ? t[f] : new Proxy({}, { get: () => async () => ({ items: [], machines: [] }) }) })
  const t = testHost({ lfs, root: base, home: join(base, 'home'), discovery: async () => ({ identity: {}, calls: [], commands: [], switches: [] }) })
  const groups = R.createGroups(t.host, async () => ({ ok: true }))
  let held = true
  groups.presets = { exclusive: () => held, route: async (method, parts) => ({ method, parts }) }
  const refused = await R.handle(groups, { method: 'POST', path: '/api/stores', body: { name: 's' } })
  assert.equal(refused.status, 409)
  assert.equal(refused.body.code, 'ConnectBusy')
  const preset = await R.handle(groups, { method: 'POST', path: '/api/demo-presets/studio/environment-reset', body: {} })
  assert.deepEqual(preset, { status: 200, body: { method: 'POST', parts: ['studio', 'environment-reset'] } })
  const read = await R.handle(groups, { method: 'GET', path: '/api/demo-presets' })
  assert.equal(read.status, 200)
  held = false
  const allowed = await R.handle(groups, { method: 'POST', path: '/api/stores', body: { name: 's' } })
  assert.notEqual(allowed.body?.code, 'ConnectBusy')
  groups.storage.close(); await groups.projects.close()
  rmSync(base, { recursive: true, force: true })
})

// ---------------------------------------------------------------- live

const pin = pinned()

test('live: environment plan and reset of a private home drop the removed projects\' DSH records', { skip: !pin && 'no pinned LayerFS CLI', timeout: 300_000 }, async () => {
  // a short path: the native daemon's sockets live in the home
  const base = mkdtempSync('/tmp/lfsp-')
  const home = join(base, 'h'), state = join(base, 'presets')
  const env = { ...process.env, LAYERFS_HOME: home }
  const cli = (...argv) => JSON.parse(execFileSync(pin.cli, argv, { env, encoding: 'utf8' }))
  try {
    cli('machine', 'list')
    cli('store', 'create', '--', 'ps')
    const src = join(base, 'src'); mkdirSync(src); writeFileSync(join(src, 'a.txt'), 'a\n')
    cli('project', 'init', '--', 'ps/p1', src)
    const f = fakeHost({ cli: pin.cli, home, state, sessions: [{ id: 'session-x', project: 'ps/p1' }], projects: [{ project: 'ps/p1', sessions: 2 }, { project: 'other/x', sessions: 1 }] })
    const m = new PresetManager(f.host, state, home)
    assert.equal(m.list().items[0].initialized, true)
    const plan = await m.route('GET', ['studio', 'environment-plan'], undefined, new URLSearchParams())
    assert.deepEqual(plan.remove.stores, ['ps'])
    assert.deepEqual(plan.projectKeys, ['ps/p1'])
    assert.deepEqual(plan.dsh.workspaces, [{ project: 'ps/p1', sessions: 2 }])
    assert.deepEqual(plan.dsh.sessions, [{ id: 'session-x', project: 'ps/p1' }])
    // a stale signature is refused before anything is removed
    const stale = await m.resetEnvironment('studio', { requestId: 'stale1', expectedPlan: 'nope', confirm: true, rebuild: false, sandboxes: false, force: true }).then(() => null, (e) => e)
    assert.equal(stale?.code, 'Conflict')
    assert.deepEqual(cli('store', 'list').items.map((s) => s.name), ['ps'])
    // a bound session refuses an unforced reset, and force overrides it
    await assert.rejects(m.resetEnvironment('studio', { requestId: 'blocked1', expectedPlan: plan.signature, confirm: true, rebuild: false, sandboxes: false }), (e) => e.code === 'ConnectBusy' && e.detail.sessions.length === 1)
    const job = await m.resetEnvironment('studio', { requestId: 'live1', expectedPlan: plan.signature, confirm: true, rebuild: false, sandboxes: false, force: true })
    assert.equal(job.state, 'running')
    assert.equal(m.exclusive(), true)
    await m.settle()
    const done = await m.route('GET', ['jobs', job.id], undefined, new URLSearchParams())
    assert.equal(done.state, 'completed', done.error?.message)
    assert.equal(done.cleanup.verified, true)
    assert.deepEqual(done.cleanup.completed, [['store', 'remove', 'ps']])
    assert.deepEqual(done.forgotten, ['ps/p1'])
    assert.deepEqual(f.forgotten, ['ps/p1'])
    assert.ok(done.log.length > 0)
    assert.deepEqual(cli('store', 'list').items, [])
    assert.equal(m.exclusive(), false)
    assert.ok(f.events.some((e) => e.type === 'demo-preset' && e.data.jobId === job.id))
    assert.equal(JSON.parse(readFileSync(join(state, 'environment-reset.json'), 'utf8')).verified, true)
  } finally {
    try { execFileSync(pin.cli, ['machine', 'stop', 'native'], { env, stdio: 'ignore' }) } catch { /* not running */ }
    rmSync(base, { recursive: true, force: true })
  }
})
