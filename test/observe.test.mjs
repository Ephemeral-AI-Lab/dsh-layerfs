// Observed values (layerfs-project#164) and Doctor leftovers (#180), host and
// page side, over a fake `lfs` with the answer shapes of the merged LayerFS
// build (machine.stats, sandbox.list --live, sandbox.get daemon and usage,
// `layerfs doctor` leftovers):
//   host    featuresOf, the inspect lane, GET /api/machines/:id/stats (single
//           flight, one answer for 5 s, stale answers, 501 without the call),
//           the machines view's `live`, sandbox.get's fields, GET /api/doctor
//   page    the stats poller (src/client/machines/stats.ts), what a stopped
//           machine and a null value read as, live counts, usage words, and
//           the leftover rows' model (src/client/doctor/leftover-model.ts)
//   node --test test/observe.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { loadRoutes, testHost } from './routes-helper.mjs'

const root = new URL('..', import.meta.url).pathname
const out = mkdtempSync(join(root, 'lib', '.test-observe-'))
const bundle = async (name, contents) => {
  await build({ absWorkingDir: root, stdin: { contents, resolveDir: root, loader: 'ts' }, outfile: join(out, `${name}.mjs`), bundle: true, format: 'esm', platform: 'node', target: 'node24', external: ['@deepseek-ai/*', 'react', 'react/*'], logLevel: 'warning' })
  return import(pathToFileURL(join(out, `${name}.mjs`)).href)
}
const S = await bundle('stats', "export * from './src/client/machines/stats.ts'")
const L = await bundle('leftovers', "export * from './src/client/doctor/leftover-model.ts'")
const R = await loadRoutes()
test.after(() => rmSync(out, { recursive: true, force: true }))

class Refusal extends Error {
  constructor(code, message = code, detail = null) { super(message); Object.assign(this, { code, detail, transport: 'refusal' }) }
}
const entry = (family, call, options = [], kind = 'text') => ({ family, call, args: [], options: options.map((name) => ({ name, kind })) })
const BASE = [entry('machine', 'list'), entry('sandbox', 'list', ['page_size', 'page_pos'])]
/** The merged build's table, as far as these routes read it. */
const OBSERVE = [entry('machine', 'list'), entry('machine', 'stats'), entry('sandbox', 'list', ['page_size', 'page_pos', 'live'], 'bool'), entry('doctor', 'fix')]

function fixture(lfs, calls = OBSERVE) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-observe-'))
  const t = testHost({ lfs, root: dir, home: join(dir, 'home'), discovery: async () => ({ identity: { version: '2.0.0-test', features: [] }, calls }) })
  const groups = R.createGroups(t.host, async () => ({}))
  return { groups, logs: t.logs, http: (method, path, body) => R.handle(groups, { method, path, body }), close: () => rmSync(dir, { recursive: true, force: true }) }
}
const viewLfs = (machine = {}, sandbox = {}) => ({
  machine: { list: async () => ({ machines: [{ name: 'native', platform: 'native', state: 'ready' }] }), platforms: async () => ({ host: 'macos', platforms: [] }), ...machine },
  store: { list: async () => ({ items: [] }) },
  sandbox: { list: async () => ({ items: [], next_page_pos: null }), ...sandbox },
})

// The answers as the merged build gives them (docs/architecture/api/sdk/machine.md, sandbox.md).
const NATIVE = { machine: 'native', platform: 'native', observed_at: 1794776707857, worker: null, resources: { cpus: 14, memory_total: 38654705664, memory_used: 31340068864, disk_total: 994662584320, disk_used: 641705943040, disk_free: 352956641280, scope: 'host' }, data_disk: { path: '/Users/me/.layerfs', fs: 'apfs', scope: 'host_fs', volume: null, inodes_free: 3446842200 }, stores: [{ name: 'shop', bytes: 217088, allocated: 217088 }], sandboxes: { recorded: 12, live: 10 }, complete: true }
const DOCKER = { machine: 'docker', platform: 'docker', observed_at: 1794776707900, worker: { version: '2.0.0', pid: 41, started_at: 1794776000000, protocol: 7, bundle: '8de908dfcb63' }, resources: { cpus: 8, memory_total: 8327118848, memory_used: 1200000000, disk_total: 62671097856, disk_used: 20000000000, disk_free: 39000000000, scope: 'engine_host' }, data_disk: { path: '/layerfs/data', fs: 'ext4', scope: 'vm_disk', volume: 'layerfs-1a2b3c4d-docker-data', inodes_free: 3900000 }, stores: [], sandboxes: { recorded: 0, live: 0 }, complete: true }
const PARTIAL = { ...DOCKER, resources: { cpus: 8, memory_total: null, memory_used: null, disk_total: null, disk_used: null, disk_free: null, scope: 'engine_host', reason: 'memory_not_read, disk_not_read' }, stores: [{ name: 'big', bytes: null, allocated: null }], sandboxes: { recorded: 3, live: null }, complete: false, reason: 'deadline' }

// ---------------------------------------------------------------- host: features and the lane

test('features: machine.stats, sandbox.list live and doctor.fix are each read from the call table', () => {
  const { featuresOf } = R.util
  const none = featuresOf({ calls: BASE })
  assert.equal(none.inspect.machineStats, false); assert.equal(none.sandboxLive, false); assert.equal(none.leftovers, false)
  const all = featuresOf({ calls: OBSERVE })
  assert.equal(all.inspect.machineStats, true); assert.equal(all.sandboxLive, true); assert.equal(all.leftovers, true)
  // an option of another call, or the call without the option, is not the feature
  assert.equal(featuresOf({ calls: [entry('sandbox', 'get', ['live'])] }).sandboxLive, false)
  assert.equal(featuresOf({ calls: [entry('doctor', 'host')] }).leftovers, false)
  assert.equal(featuresOf(null).inspect.machineStats, false)
  for (const name of ['machine.stats', 'doctor.fix']) assert.ok(!R.cli.REQUIRED_CALLS.includes(name), `${name} is optional`)
})

test('machine.stats is a monitoring read: the inspect lane, whatever lane the caller names', () => {
  assert.ok(R.cli.INSPECT_CALLS.has('machine.stats'))
  assert.deepEqual(R.cli.laneOf(['machine', 'stats', '--', 'docker']), R.cli.INSPECT_LANE)
  // store.stats and machine.status stay where they were
  assert.equal(R.cli.laneOf(['store', 'stats', '--', 's']).name, 'calls')
  assert.equal(R.cli.laneOf(['machine', 'status', '--', 'docker']).name, 'probes')
  assert.ok(!R.cli.KEPT_READS.has('machine.stats'), 'the SDK keeps no monitoring answer: the route does, per machine')
})

// ---------------------------------------------------------------- host: GET /api/machines/:id/stats

test('stats route: 501 without machine.stats, and no call', async () => {
  let calls = 0
  const f = fixture({ ...viewLfs({ stats: async () => { calls++; return NATIVE } }) }, BASE)
  try {
    const r = await f.http('GET', '/api/machines/native/stats')
    assert.equal(r.status, 501); assert.equal(r.body.code, 'Unsupported'); assert.equal(r.body.detail.need, 'machine.stats')
    assert.equal(calls, 0)
    assert.deepEqual(f.logs, [], 'an expected refusal logs no stack')
    assert.equal((await f.http('POST', '/api/machines/native/stats', {})).status, 404, 'only GET')
  } finally { f.close() }
})

test('stats route: the answer as the page reads it, per scope; null stays null', async () => {
  const answers = { native: NATIVE, docker: DOCKER, slow: PARTIAL }
  const seen = []
  const f = fixture(viewLfs({ stats: async (name, options) => { seen.push([name, Object.keys(options ?? {})]); return answers[name] } }))
  try {
    const native = (await f.http('GET', '/api/machines/native/stats')).body
    assert.equal(native.stale, false); assert.equal(native.machine, 'native'); assert.equal(typeof native.at, 'number')
    assert.deepEqual(native.stats.resources, { cpus: 14, memoryTotal: 38654705664, memoryUsed: 31340068864, diskTotal: 994662584320, diskUsed: 641705943040, diskFree: 352956641280, scope: 'host', reason: null })
    assert.deepEqual(native.stats.dataDisk, { path: '/Users/me/.layerfs', fs: 'apfs', scope: 'host_fs', volume: null, inodesFree: 3446842200 })
    assert.equal(native.stats.worker, null, 'native has no worker')
    assert.deepEqual(native.stats.stores, [{ name: 'shop', bytes: 217088, allocated: 217088 }])
    assert.deepEqual(native.stats.sandboxes, { recorded: 12, live: 10 })
    assert.equal(native.stats.observedAt, 1794776707857)
    const docker = (await f.http('GET', '/api/machines/docker/stats')).body
    assert.deepEqual(docker.stats.worker, { version: '2.0.0', pid: 41, startedAt: 1794776000000, protocol: '7', bundle: '8de908dfcb63' })
    assert.equal(docker.stats.resources.scope, 'engine_host'); assert.equal(docker.stats.dataDisk.scope, 'vm_disk')
    assert.equal(docker.stats.dataDisk.volume, 'layerfs-1a2b3c4d-docker-data', 'the provider name as LayerFS gave it')
    // values LayerFS did not observe are null with the reason, never 0
    const slow = (await f.http('GET', '/api/machines/slow/stats')).body.stats
    assert.equal(slow.resources.memoryTotal, null); assert.equal(slow.resources.diskUsed, null); assert.equal(slow.resources.reason, 'memory_not_read, disk_not_read')
    assert.deepEqual(slow.stores, [{ name: 'big', bytes: null, allocated: null }])
    assert.deepEqual(slow.sandboxes, { recorded: 3, live: null })
    assert.equal(slow.complete, false); assert.equal(slow.reason, 'deadline')
    // the call takes the machine and the abort signal, nothing else
    assert.deepEqual(seen, [['native', ['signal']], ['docker', ['signal']], ['slow', ['signal']]])
  } finally { f.close() }
})

test('stats route: one process per machine at a time, one answer for 5 s, a write reads anew', async () => {
  let calls = 0, release
  const gate = new Promise((r) => { release = r })
  const f = fixture(viewLfs({ stats: async () => { calls++; if (calls === 1) await gate; return NATIVE }, update: async () => ({}) }))
  try {
    // two pages at once share one read
    const a = f.http('GET', '/api/machines/native/stats'), b = f.http('GET', '/api/machines/native/stats')
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(calls, 1)
    release()
    const [x, y] = await Promise.all([a, b])
    assert.equal(x.body.stale, false); assert.deepEqual(x.body.stats, y.body.stats)
    // a poll within STATS_KEEP_MS is answered from what was read
    const again = (await f.http('GET', '/api/machines/native/stats')).body
    assert.equal(calls, 1); assert.equal(again.at, x.body.at); assert.equal(again.stale, false)
    assert.ok(R.machinesModule && again.readAt >= x.body.readAt)
    // any write (the router marks the machines changed) makes the next read ask LayerFS
    await f.http('POST', '/api/machines/native/update', {})
    await f.http('GET', '/api/machines/native/stats')
    assert.equal(calls, 2)
    // another machine is its own read
    await f.http('GET', '/api/machines/docker/stats')
    assert.equal(calls, 3)
  } finally { f.close() }
})

test('stats route: a refusal answers stale with the last values (none: null), never an error; a gone machine keeps none', async () => {
  let mode = 'ok'
  const f = fixture(viewLfs({
    stats: async () => { if (mode === 'ok') return DOCKER; throw new Refusal(mode, `${mode} from LayerFS`) },
    update: async () => ({}),
  }))
  const write = () => f.http('POST', '/api/machines/docker/update', {})
  try {
    // never answered on this host: no values, the refusal
    mode = 'Unavailable'
    const first = await f.http('GET', '/api/machines/docker/stats')
    assert.equal(first.status, 200)
    assert.equal(first.body.stats, null); assert.equal(first.body.at, null)
    assert.deepEqual(first.body.stale, { at: null, code: 'Unavailable', message: 'Unavailable from LayerFS' })
    mode = 'ok'
    const good = (await f.http('GET', '/api/machines/docker/stats')).body
    assert.equal(good.stale, false)
    for (const code of ['Busy', 'Unavailable', 'Timeout', 'Unknown']) {
      await write()
      mode = code
      const r = await f.http('GET', '/api/machines/docker/stats')
      assert.equal(r.status, 200, code)
      assert.equal(r.body.stale.code, code); assert.equal(r.body.stale.at, good.at)
      assert.deepEqual(r.body.stats, good.stats, `${code}: the last values stay`)
      assert.equal(r.body.at, good.at)
    }
    // a machine that is gone has no last values
    await write()
    mode = 'NotFound'
    const gone = (await f.http('GET', '/api/machines/docker/stats')).body
    assert.equal(gone.stats, null); assert.equal(gone.stale.code, 'NotFound')
    assert.deepEqual(f.logs, [], 'a refused read is an answer: nothing is logged as an error')
  } finally { f.close() }
})

// ---------------------------------------------------------------- host: the machines view, sandbox.get, doctor

test('machines view: sandbox.list is asked with live only when the CLI has the option; live is read by presence', async () => {
  const asked = []
  const rows = [
    { name: 'up', machine: 'native', project: 's/p', state: 'running', live: true },
    { name: 'dead', machine: 'native', project: 's/p', state: 'running', live: false },
    { name: 'unseen', machine: 'dev', project: 's/p', state: 'running', live: null, live_reason: 'machine_stopped' },
  ]
  const lfs = (items) => viewLfs({}, { list: async (options) => { asked.push(options); return { items, next_page_pos: null } } })
  const withLive = fixture(lfs(rows))
  const without = fixture(lfs(rows.map(({ live, live_reason, ...rest }) => rest)), BASE)
  try {
    const view = (await withLive.http('GET', '/api/machines')).body
    assert.equal(asked.at(-1).live, true)
    assert.equal(view.features.sandboxLive, true)
    assert.deepEqual(view.sandboxes.map((b) => [b.name, b.state, b.live, b.liveReason]), [['up', 'running', true, undefined], ['dead', 'running', false, undefined], ['unseen', 'running', null, 'machine_stopped']])
    const old = (await without.http('GET', '/api/machines')).body
    assert.ok(!('live' in asked.at(-1)), 'a CLI without the option is not sent it')
    assert.equal(old.features.sandboxLive, false)
    for (const b of old.sandboxes) { assert.ok(!('live' in b), 'absent stays absent'); assert.ok(!('liveReason' in b)) }
  } finally { withLive.close(); without.close() }
})

test('sandbox.get: daemon, usage and usage_reason by presence', async () => {
  const record = (more) => ({ name: 'sb', state: 'running', project: 's/p', machine: 'native', workspaces: [], next_page_pos: null, ...more })
  const get = async (answer) => {
    const f = fixture({ ...viewLfs(), sandbox: { get: async () => answer } })
    try { return (await f.http('GET', '/api/sandboxes/sb')).body } finally { f.close() }
  }
  const old = await get(record({}))
  for (const key of ['daemon', 'usage', 'usageReason']) assert.ok(!(key in old), `${key} is absent from an older answer`)
  const host = await get(record({ daemon: { pid: 4242, started_at: 1794776000000 }, usage: null, usage_reason: 'host_process' }))
  assert.deepEqual(host.daemon, { pid: 4242, startedAt: 1794776000000 }); assert.equal(host.usage, null); assert.equal(host.usageReason, 'host_process')
  const ns = await get(record({ daemon: { pid: 77, started_at: null }, usage: { cpu_usec: 1234567, memory_current: 34000000, memory_peak: null, pids: 3 } }))
  assert.deepEqual(ns.daemon, { pid: 77, startedAt: null }, 'a process that has ended has no start time')
  assert.deepEqual(ns.usage, { cpuUsec: 1234567, memoryCurrent: 34000000, memoryPeak: null, pids: 3 }); assert.ok(!('usageReason' in ns))
  // the build at 73d824ec64: a usage whose memory and process counts are null comes with the reason beside it
  const bare = await get(record({ daemon: { pid: 7, started_at: 1794776000000 }, usage: { cpu_usec: 205364, memory_current: null, memory_peak: null, pids: null }, usage_reason: 'no_controller' }))
  assert.deepEqual([bare.usage, bare.usageReason], [{ cpuUsec: 205364, memoryCurrent: null, memoryPeak: null, pids: null }, 'no_controller'])
  const unseen = await get(record({ daemon: null, usage: null, usage_reason: 'not_observed' }))
  assert.equal(unseen.daemon, null); assert.equal(unseen.usageReason, 'not_observed')
})

const LEFT = (kind, name, more = {}) => ({ machine: 'native', kind, path: `/h/machine/native/run/${name}`, bytes: 4096, age: 7200, id: `native:${kind}:${name}`, fixable: true, ...more })
const REPORT = {
  ok: true,
  findings: [
    { severity: 'warning', entity: { kind: 'store', name: 'shop' }, message: 'a partial copy', fix: 'layerfs store pull shop' },
    { severity: 'warning', entity: { kind: 'machine', name: 'native' }, message: '/h/machine/native/run/lfs-1-sb1 on machine native is a Sandbox run folder no Sandbox record names (4096 bytes, last changed 7200 s ago)', fix: '`layerfs doctor fix native:run-folder:lfs-1-sb1` removes it when it has its `owner` marker', leftover: LEFT('run-folder', 'lfs-1-sb1') },
    { severity: 'warning', entity: { kind: 'machine', name: 'docker' }, message: 'a folder copy', fix: 'report-only', leftover: { machine: 'docker', kind: 'init-copy', path: '/layerfs/data/incoming/init-00112233aabbccdd', bytes: null, age: 60, id: 'docker:init-copy:00112233aabbccdd', fixable: false } },
    { severity: 'warning', entity: { kind: 'machine', name: 'docker' }, message: 'a named copy', fix: '`layerfs doctor fix docker:init-copy:ffeeddccbbaa0099` removes it an hour after that Init\'s deadline', leftover: { machine: 'docker', kind: 'init-copy', path: '/layerfs/data/incoming/init-ffeeddccbbaa0099', bytes: 12, age: 90, id: 'docker:init-copy:ffeeddccbbaa0099', fixable: true, not_before: 1794780000000 } },
  ],
  leftovers: [{ machine: 'native', complete: true, image_locks: 3, unmount_markers: 0 }, { machine: 'docker', complete: false, image_locks: 0, unmount_markers: 2 }],
}

test('doctor route: leftovers pass through with a CLI that has doctor.fix, and the page is as before without it', async () => {
  const run = async (calls, report) => {
    const f = fixture(viewLfs(), calls)
    f.groups.storage.doctorCall = async () => report
    try { return (await f.http('GET', '/api/doctor')).body } finally { f.close() }
  }
  const got = await run(OBSERVE, REPORT)
  assert.equal(got.ok, true); assert.equal(got.findings.length, 4)
  assert.ok(!('leftover' in got.findings[0]), 'an ordinary finding has none')
  assert.deepEqual(got.findings[1].leftover, { machine: 'native', kind: 'run-folder', path: '/h/machine/native/run/lfs-1-sb1', bytes: 4096, age: 7200, id: 'native:run-folder:lfs-1-sb1', fixable: true })
  assert.deepEqual(got.findings[2].leftover, { machine: 'docker', kind: 'init-copy', path: '/layerfs/data/incoming/init-00112233aabbccdd', bytes: null, age: 60, id: 'docker:init-copy:00112233aabbccdd', fixable: false }, 'a size that was not measured stays null')
  assert.equal(got.findings[3].leftover.notBefore, 1794780000000)
  assert.deepEqual(got.leftovers, [{ machine: 'native', complete: true, imageLocks: 3, unmountMarkers: 0 }, { machine: 'docker', complete: false, imageLocks: 0, unmountMarkers: 2 }])
  assert.equal(got.findings[1].fix, REPORT.findings[1].fix, 'LayerFS\'s words are kept')
  // a CLI without doctor.fix: today's answer, whatever the report holds
  const old = await run(BASE, REPORT)
  assert.deepEqual(Object.keys(old).sort(), ['at', 'findings', 'ok'])
  for (const finding of old.findings) assert.deepEqual(Object.keys(finding).sort(), ['entity', 'fix', 'message', 'severity'])
  // a report that walked no machine has no `leftovers`
  const empty = await run(OBSERVE, { ok: true, findings: [] })
  assert.ok(!('leftovers' in empty))
  // a leftover without an id is dropped (a row without a command would be a dead end)
  const bad = await run(OBSERVE, { ok: true, findings: [{ severity: 'warning', entity: { kind: 'machine', name: 'native' }, message: 'm', fix: 'f', leftover: { kind: 'run-folder', path: '/x' } }], leftovers: [] })
  assert.ok(!('leftover' in bad.findings[0]))
})

test('log route: a log that does not exist yet answers a cursor (c1.0.0.0.0), and reads from it follow the file once it is there', async () => {
  const LOGS = [...OBSERVE, entry('logs', 'machine', ['cursor', 'before', 'limit'])]
  const asked = []
  let lines = []
  const f = fixture({ ...viewLfs(), logs: { machine: async (_name, options) => {
    asked.push({ cursor: options.cursor ?? null })
    if (!options.cursor) return { lines: [], cursor: 'c1.0.0.0.0', has_more: false }
    if (options.cursor === 'c1.0.0.0.0') return lines.length ? { lines, cursor: 'c1.0.2a.9f.40', has_more: false } : { lines: [], cursor: 'c1.0.0.0.0', has_more: false }
    return { lines: [], cursor: options.cursor, has_more: false }
  } } }, LOGS)
  try {
    const tail = (await f.http('GET', '/api/machines/docker/log')).body
    assert.deepEqual([tail.lines, tail.cursor, tail.before, tail.stale], [[], 'c1.0.0.0.0', null, false])
    const still = (await f.http('GET', '/api/machines/docker/log?cursor=c1.0.0.0.0')).body
    assert.deepEqual([still.lines, still.cursor, still.stale], [[], 'c1.0.0.0.0', false])
    lines = [{ text: 'worker started' }, { text: 'ready' }]
    const first = (await f.http('GET', '/api/machines/docker/log?cursor=c1.0.0.0.0')).body
    assert.deepEqual(first.lines.map((l) => l.text), ['worker started', 'ready']); assert.equal(first.cursor, 'c1.0.2a.9f.40'); assert.equal(first.stale, false)
    assert.deepEqual(asked.map((a) => a.cursor), [null, 'c1.0.0.0.0', 'c1.0.0.0.0'])
    // the kept tail followed the cursor: a later refused tail read answers those lines
    assert.deepEqual(f.groups.machines.reads.last('log:machine:docker').value.lines.map((l) => l.text), ['worker started', 'ready'])
  } finally { f.close() }
})

// ---------------------------------------------------------------- page: the stats poller

/** A clock a test moves by hand. */
function fakeClock() {
  let now = 1_000_000, id = 0
  const timers = new Map()
  return {
    now: () => now,
    setTimeout: (run, ms) => { timers.set(++id, { at: now + ms, run }); return id },
    clearTimeout: (timer) => { timers.delete(timer) },
    /** Move time on, running the timers that come due, oldest first. */
    async advance(ms) {
      const end = now + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0]); now = Math.max(now, due[1].at); due[1].run()
        await settle()
      }
      now = end
      await settle()
    },
    pending: () => timers.size,
  }
}
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
const stats = (n) => ({ ...R.inspect && {}, platform: 'docker', observedAt: n, worker: null, resources: { cpus: n, memoryTotal: 1, memoryUsed: 1, diskTotal: 10, diskUsed: n, diskFree: 1, scope: 'vm', reason: null }, dataDisk: { path: '/', fs: 'ext4', scope: 'volume', volume: null, inodesFree: 1 }, stores: [], sandboxes: { recorded: 0, live: 0 }, complete: true, reason: null })
const good = (name, n, at) => ({ machine: name, readAt: at, at, stats: stats(n), stale: false })

test('poller: one read at a time, each machine at its interval, the shortest watcher wins', async () => {
  const clock = fakeClock()
  const started = [], open = []
  const poller = new S.StatsPoller((name) => new Promise((resolve) => { started.push(name); open.push(() => resolve(good(name, started.length, clock.now()))) }), () => true, clock)
  const offA = poller.watch('a', 30_000), offB = poller.watch('b', 30_000)
  await settle()
  assert.deepEqual(started, ['a'], 'the second machine waits for the first read')
  assert.equal(poller.getSnapshot().a.reading, true); assert.equal(poller.getSnapshot().a.stats, null)
  open.shift()(); await settle()
  assert.deepEqual(started, ['a', 'b'])
  assert.equal(poller.getSnapshot().a.reading, false); assert.equal(poller.getSnapshot().a.stats.resources.cpus, 1); assert.equal(poller.getSnapshot().a.loaded, true)
  open.shift()(); await settle()
  // nothing more until an interval has passed
  await clock.advance(29_000)
  assert.deepEqual(started, ['a', 'b'])
  await clock.advance(1_100)
  assert.deepEqual(started, ['a', 'b', 'a'])
  open.shift()(); await settle()
  assert.deepEqual(started, ['a', 'b', 'a', 'b'])
  open.shift()(); await settle()
  // a page opens machine a: 10 s wins over the board's 30 s
  const offPage = poller.watch('a', S.STATS_PAGE_MS)
  await clock.advance(10_100)
  assert.deepEqual(started.slice(4), ['a'])
  open.shift()(); await settle()
  offPage()
  await clock.advance(10_100)
  assert.deepEqual(started.slice(5), [], 'back to 30 s once the page has gone')
  offA(); offB()
  await clock.advance(120_000)
  assert.deepEqual(started.slice(5), [], 'nothing is read for a machine nobody watches')
  assert.equal(poller.getSnapshot().a.stats.resources.cpus, 5, 'the last values stay for the next watcher')
  assert.equal(S.STATS_PAGE_MS, 10_000); assert.equal(S.STATS_BOARD_MS, 30_000)
})

test('poller: no read while the page is not on screen; it reads when it is again', async () => {
  const clock = fakeClock()
  let visible = false, reads = 0
  const poller = new S.StatsPoller(async (name) => { reads++; return good(name, reads, clock.now()) }, () => visible, clock)
  poller.watch('a', 10_000)
  await clock.advance(60_000)
  assert.equal(reads, 0)
  assert.equal(poller.getSnapshot().a, undefined)
  visible = true
  poller.wake(); await settle()
  assert.equal(reads, 1)
  visible = false
  await clock.advance(60_000)
  assert.equal(reads, 1)
  visible = true
  await clock.advance(S.STATS_IDLE_MS + 100)
  assert.equal(reads, 2, 'it looks again by itself within STATS_IDLE_MS')
})

test('poller: a slow read shows the last values, a refused or lost one keeps them and says so; null is not zero', async () => {
  const clock = fakeClock()
  let answer = null
  const poller = new S.StatsPoller((name) => answer(name), () => true, clock)
  answer = async (name) => good(name, 7, clock.now())
  poller.watch('a', 10_000); await settle()
  const first = poller.getSnapshot().a
  assert.equal(first.stats.resources.diskUsed, 7); assert.equal(first.stale, null); assert.equal(first.reading, false)
  // in progress: the values read before stay while the next read runs
  let finish
  answer = () => new Promise((resolve) => { finish = resolve })
  await clock.advance(10_100)
  const during = poller.getSnapshot().a
  assert.equal(during.reading, true); assert.equal(during.stats.resources.diskUsed, 7); assert.equal(during.at, first.at)
  // refused by LayerFS (the host answers stale with what it kept)
  finish({ machine: 'a', readAt: clock.now(), at: first.at, stats: stats(7), stale: { at: first.at, code: 'Busy', message: '2 inspect reads are running' } }); await settle()
  const busy = poller.getSnapshot().a
  assert.equal(busy.reading, false); assert.equal(busy.stale.code, 'Busy'); assert.equal(busy.stats.resources.diskUsed, 7); assert.equal(busy.at, first.at)
  // refused with nothing kept on the host (it was restarted): the page's own values stay
  answer = async () => ({ machine: 'a', readAt: clock.now(), at: null, stats: null, stale: { at: null, code: 'Unavailable', message: 'the machine is stopped' } })
  await clock.advance(10_100)
  const down = poller.getSnapshot().a
  assert.equal(down.stale.code, 'Unavailable'); assert.equal(down.stats.resources.diskUsed, 7); assert.equal(down.at, first.at)
  // a read that never answers in time is thrown by the reader (Timeout): the same
  answer = async () => { throw Object.assign(new Error('No answer in 25 s'), { code: 'Timeout' }) }
  await clock.advance(10_100)
  const late = poller.getSnapshot().a
  assert.equal(late.stale.code, 'Timeout'); assert.equal(late.stats.resources.diskUsed, 7); assert.equal(late.loaded, true)
  // and a good answer clears it
  answer = async (name) => good(name, 9, clock.now())
  await clock.advance(10_100)
  assert.equal(poller.getSnapshot().a.stale, null); assert.equal(poller.getSnapshot().a.stats.resources.diskUsed, 9)
  // a first read that is refused: no values, the refusal, loaded
  const fresh = new S.StatsPoller(async () => ({ machine: 'b', readAt: 1, at: null, stats: null, stale: { at: null, code: 'Busy', message: 'busy' } }), () => true, fakeClock())
  fresh.watch('b', 10_000); await settle()
  assert.deepEqual(fresh.getSnapshot().b, { stats: null, at: null, stale: { at: null, code: 'Busy', message: 'busy' }, reading: false, loaded: true })
})

test('poller: the interval counts from the end of a read: a machine that takes 15 s to refuse is asked again 10 s later, not at once', async () => {
  const clock = fakeClock()
  const starts = []
  let finish
  const poller = new S.StatsPoller((name) => new Promise((resolve) => { starts.push(clock.now()); finish = () => resolve({ machine: name, readAt: clock.now(), at: null, stats: null, stale: { at: null, code: 'Timeout', message: 'no answer in 15 s' } }) }), () => true, clock)
  poller.watch('a', 10_000); await settle()
  assert.equal(starts.length, 1)
  await clock.advance(15_000)
  assert.equal(starts.length, 1, 'one read at a time')
  finish(); await settle()
  assert.equal(poller.getSnapshot().a.stale.code, 'Timeout')
  await clock.advance(9_900)
  assert.equal(starts.length, 1, 'not again before the interval has passed since it ended')
  await clock.advance(200)
  assert.equal(starts.length, 2)
  assert.equal(starts[1] - starts[0], 25_000, 'a machine that hangs costs one process per 25 s, and holds an inspect slot 15 s of them')
})

test('poller: a CLI that lost the call, or a machine that is gone, is not asked again until watched anew; refresh reads now', async () => {
  const clock = fakeClock()
  let reads = 0, code = 'Unsupported'
  const poller = new S.StatsPoller(async (name) => { reads++; if (code) throw Object.assign(new Error(code), { code }); return good(name, reads, clock.now()) }, () => true, clock)
  const off = poller.watch('a', 10_000); await settle()
  assert.equal(reads, 1)
  await clock.advance(60_000)
  assert.equal(reads, 1, 'Unsupported ends polling')
  off()
  code = null
  poller.watch('a', 10_000); await settle()
  assert.equal(reads, 2, 'a new watcher asks again')
  await clock.advance(3_000)
  poller.refresh('a'); await settle()
  assert.equal(reads, 3, 'refresh does not wait for the interval')
  poller.refresh('nobody'); await settle()
  assert.equal(reads, 3)
  poller.dispose()
  await clock.advance(60_000)
  assert.equal(reads, 3)
})

// ---------------------------------------------------------------- page: words

test('a stopped machine is never asked and reads "not observed (machine stopped)"; scopes and reasons in plain words', () => {
  const stopped = { name: 'dev', platform: 'lima', state: 'stopped' }
  assert.equal(S.statsAskable(stopped), false)
  assert.equal(S.statsAskable({ platform: 'native', state: 'ready' }), true, 'native answers in the caller\'s process')
  assert.equal(S.statsAskable({ platform: 'docker', state: 'running' }), true)
  assert.equal(S.statsAskable({ platform: 'docker', state: 'failed' }), false)
  assert.deepEqual(S.notObserved(stopped, undefined), { key: 'notObservedStopped' })
  // even with values kept from before it stopped
  assert.deepEqual(S.notObserved(stopped, { stats: stats(1), at: 1, stale: null, reading: false, loaded: true }), { key: 'notObservedStopped' })
  assert.deepEqual(S.notObserved({ platform: 'lima', state: 'creating' }, undefined), { key: 'notObservedState', values: { state: 'creating' } })
  const running = { platform: 'docker', state: 'running' }
  assert.deepEqual(S.notObserved(running, undefined), { key: 'notObservedYet' })
  assert.equal(S.notObserved(running, { stats: stats(1), at: 1, stale: { at: 1, code: 'Busy', message: 'm' }, reading: false, loaded: true }), null, 'values with a refusal are still values')
  assert.deepEqual(S.notObserved(running, { stats: null, at: null, stale: { at: null, code: 'Unavailable', message: 'm' }, reading: false, loaded: true }), { key: 'notObservedUnavailable' })
  assert.deepEqual(S.notObserved(running, { stats: null, at: null, stale: { at: null, code: 'Busy', message: 'two reads run' }, reading: false, loaded: true }), { key: 'notObservedRefused', values: { code: 'Busy', message: 'two reads run' } })
  assert.deepEqual([S.diskScopeWords('volume').key, S.diskScopeWords('vm_disk').key, S.diskScopeWords('host_fs').key], ['scopeVolume', 'scopeVmDisk', 'scopeHostFs'])
  assert.deepEqual([S.resourceScopeWords('host').key, S.resourceScopeWords('engine_host').key, S.resourceScopeWords('vm').key], ['scopeHost', 'scopeEngineHost', 'scopeVm'])
  assert.deepEqual(S.diskScopeWords('lun'), { key: 'raw', values: { text: 'lun' } }, 'a scope this page does not know is shown as it came')
  assert.equal(S.diskScopeWords(null), null)
  assert.deepEqual(S.reasonList('memory_not_read, disk_not_read').map((w) => w.key), ['reasonMemoryNotRead', 'reasonDiskNotRead'])
  assert.deepEqual(S.reasonList(null), [])
  assert.deepEqual(S.reasonWords('host_process'), { key: 'reasonHostProcess' })
  assert.deepEqual(S.reasonWords('something_new'), { key: 'raw', values: { text: 'something new' } })
  assert.deepEqual([S.staleWords({ at: 1, code: 'Timeout', message: '' }).key, S.staleWords({ at: 1, code: 'Busy', message: '' }).key, S.staleWords({ at: 1, code: 'Unknown', message: 'x' }).key], ['statsStaleTimeout', 'statsStaleBusy', 'statsStaleRefused'])
})

test('a Sandbox whose daemon is dead is not running; one that was not observed is not confirmed', () => {
  const look = (state) => ({ tone: state === 'running' ? 'success' : 'neutral', label: `state:${state}` })
  const tw = (words) => `${words.key}${words.values ? `(${Object.values(words.values).join(',')})` : ''}`
  const up = { state: 'running', live: true }, dead = { state: 'running', live: false }, unseen = { state: 'running', live: null, liveReason: 'machine_stopped' }, old = { state: 'running' }, closing = { state: 'closing', live: false }
  assert.deepEqual([up, dead, unseen, old, closing].map(S.sandboxRuns), [true, false, true, true, false])
  assert.deepEqual(S.sandboxLook(up, look), { tone: 'success', label: 'state:running' })
  assert.deepEqual(S.sandboxLook(old, look), { tone: 'success', label: 'state:running' }, 'without `live` the record\'s state shows, as before')
  assert.deepEqual(S.sandboxLook(dead, look), { tone: 'danger', label: 'stateDaemonDown', attention: true })
  assert.deepEqual(S.sandboxLook(unseen, look), { tone: 'neutral', label: 'state:running', dashed: true })
  assert.deepEqual(S.sandboxLook(closing, look), { tone: 'neutral', label: 'state:closing' }, 'only a Sandbox recorded running is judged by its daemon')
  assert.equal(S.liveNote(up, tw), null); assert.equal(S.liveNote(old, tw), null)
  assert.equal(S.liveNote(dead, tw), 'liveDown')
  assert.equal(S.liveNote(unseen, tw), 'liveUnknownBecause(reasonMachineStopped)')
  assert.equal(S.liveNote({ state: 'running', live: null }, tw), 'liveUnknown')
  assert.deepEqual(S.liveCounts([up, up, dead, unseen, closing]), { total: 5, running: 2, down: 1, unknown: 1, observed: true })
  assert.deepEqual(S.liveCounts([old, old, { state: 'gone' }]), { total: 3, running: 2, down: 0, unknown: 0, observed: false }, 'an older CLI: the records\' count, as before')
  assert.deepEqual(S.liveCounts([]), { total: 0, running: 0, down: 0, unknown: 0, observed: false })
})

test('CPU time in words', () => {
  assert.deepEqual([0, 250_000, 1_234_567, 42_000_000, 184_000_000, 7_500_000_000].map(S.cpuTime), ['0.00 s', '0.25 s', '1.2 s', '42 s', '3 min 4 s', '2 h 5 min'])
  assert.equal(S.cpuTime(null), '—')
})

// ---------------------------------------------------------------- page: leftovers

test('leftover rows: the command is the id, never a path; LayerFS\'s condition without the command; counted kinds have no command', () => {
  const l = { id: 'native:run-folder:lfs-1a2b3c4d-sb1' }
  assert.equal(L.fixCommand(l), 'layerfs doctor fix native:run-folder:lfs-1a2b3c4d-sb1')
  assert.equal(L.fixCondition('`layerfs doctor fix native:run-folder:lfs-1a2b3c4d-sb1` removes it when it has its `owner` marker', l), 'Removes it when it has its `owner` marker')
  assert.equal(L.fixCondition('report-only: `layerfs doctor fix` refuses it', l), 'Report-only: `layerfs doctor fix` refuses it', 'a sentence that does not start with the command is kept whole')
  assert.equal(L.fixCondition(`\`${L.fixCommand(l)}\``, l), null)
  assert.equal(L.fixCondition(null, l), null)
  const findings = [{ severity: 'warning', entity: null, message: 'a', fix: null }, { severity: 'warning', entity: null, message: 'b', fix: null, leftover: { id: 'x' } }, { severity: 'warning', entity: null, message: 'c', fix: null, leftover: { id: 'y' } }]
  assert.deepEqual(L.leftoverFindings(findings).map((f) => f.leftover.id), ['x', 'y'], 'each leftover is its own row, in LayerFS\'s order')
  const walks = [{ machine: 'a', complete: true, imageLocks: 0, unmountMarkers: 0 }, { machine: 'b', complete: true, imageLocks: 2, unmountMarkers: 0 }, { machine: 'c', complete: false, imageLocks: 0, unmountMarkers: 0 }, { machine: 'd', complete: true, imageLocks: 0, unmountMarkers: 1 }]
  assert.deepEqual(L.walksToShow(walks).map((w) => w.machine), ['b', 'c', 'd'])
  assert.deepEqual(L.walksToShow(undefined), [])
})
