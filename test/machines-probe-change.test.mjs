// The machines view's live probes (routes/machines.ts): a probe that finds a
// changed state makes the next read build anew and tells the pages; a fresh
// read (Check again) asks after any probe already running instead of joining
// it, and skips the SDK client's kept answer; a probe the record outdates
// leaves no state, time or live section behind. The Machines page rereads on
// the probe event.
//   node --test test/machines-probe-change.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { loadRoutes, testHost } from './routes-helper.mjs'

const R = await loadRoutes()
const iso = (ms) => new Date(ms).toISOString()
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
const probeCalls = (calls) => calls.filter((c) => c.call === 'machine.get')

/** A clock a test moves by hand (the sampler's). */
function fakeClock(start = 1_000_000) {
  let now = start, id = 0
  const timers = new Map()
  return {
    now: () => now,
    setTimeout: (run, ms) => { timers.set(++id, { at: now + ms, run }); return id },
    clearTimeout: (timer) => { timers.delete(timer) },
    async advance(ms) {
      const end = now + ms
      for (;;) {
        await settle()
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0]); now = Math.max(now, due[1].at); due[1].run()
      }
      now = end
      await settle()
    },
  }
}

/** A fake LayerFS that records every call and answers from `answers`; `events` are the host's emits. */
function fake(answers) {
  const calls = []
  const lfs = new Proxy({}, { get: (_, family) => new Proxy({}, { get: (__, name) => async (...args) => {
    const call = `${String(family)}.${String(name)}`
    calls.push({ call, args, options: args.at(-1), at: calls.length })
    const answer = answers[call]
    return answer ? answer(...args) : {}
  } }) })
  const dir = mkdtempSync(join(tmpdir(), 'dsh-probe-change-'))
  const t = testHost({ lfs, root: dir, home: join(dir, 'home'), discovery: async () => ({ identity: { version: '2.0.0-test', features: [] }, calls: [{ family: 'machine', call: 'stats', args: [], options: [] }], commands: [], switches: [] }) })
  return { calls, events: t.events, host: t.host, close: () => rmSync(dir, { recursive: true, force: true }) }
}
const machineRow = (state = 'ready', observed_at = null) => ({ machine: 'docker', platform: 'docker', state, stores: [], sandboxes: [], supports: ['sqlite'], ...(observed_at ? { observed_at } : {}) })
const probeAnswer = (state, at) => ({ machine: 'docker', platform: 'docker', state, observed_at: iso(at), ...(state === 'broken' ? { reason: 'engine_down', fix: 'open Docker' } : {}), live: { disk_free_bytes: state === 'ready' ? 500 : null, tool_version: 'docker 28', worker: null } })
const statsAnswer = (at) => ({ machine: 'docker', observed_at: iso(at), cpus: 4, memory_used_bytes: 1, memory_total_bytes: 2, disk_used_bytes: 3, disk_total_bytes: 4, disk_free_bytes: 6, data_disk: {}, stores: [], sandboxes: [] })
const quiet = { 'store.list': async () => ({ items: [] }), 'sandbox.list': async () => ({ items: [] }), 'home.get': async () => ({ platforms: { host: 'linux', items: [] } }) }

test('a sampler probe that finds a changed state shows on the very next read and emits machine-progress', async () => {
  const clock = fakeClock()
  let alive = true
  const f = fake({
    'machine.list': async () => ({ items: [machineRow('ready')] }),
    'machine.get': async () => probeAnswer(alive ? 'ready' : 'broken', clock.now()),
    'machine.stats': async () => statsAnswer(clock.now()),
    ...quiet,
  })
  const machines = new R.machinesModule.Machines(f.host, null, { clock })
  try {
    machines.metrics.start()
    await clock.advance(0)
    assert.equal((await machines.view()).machines[0].state, 'ready')
    const probes = () => f.events.filter((e) => e.type === 'machine-progress' && e.data?.kind === 'probe')
    assert.equal(probes().length, 0, 'an unchanged probe announces nothing')
    alive = false
    await clock.advance(15_000)
    // still inside the view's 5 s keep (Date.now is not moved): the changed probe must not be hidden by it
    const down = await machines.view()
    assert.equal(down.machines[0].state, 'broken', 'the dead machine reads broken at once, not after the kept view expires')
    assert.equal(probes().length, 1, 'one machine-progress probe event')
    assert.deepEqual(probes()[0].data, { type: 'machine-progress', name: 'docker', kind: 'probe', progress: { stage: 'probe', state: 'broken' } })
    // the next unchanged window announces nothing more
    await clock.advance(15_000)
    assert.equal(probes().length, 1)
  } finally {
    machines.metrics.stop()
    f.close()
  }
})

test('a fresh read starts its own probe after one already running, with its own budget (no kept answer)', async () => {
  const clock = fakeClock()
  let release
  const held = new Promise((resolve) => { release = resolve })
  let fixed = false
  const f = fake({
    'machine.list': async () => ({ items: [machineRow('ready')] }),
    // the sampler's probe began before the fix and answers what it saw then
    'machine.get': async () => {
      const sawFixed = fixed
      if (probeCalls(f.calls).length === 1) await held
      return probeAnswer(sawFixed ? 'ready' : 'broken', clock.now())
    },
    'machine.stats': async () => statsAnswer(clock.now()),
    ...quiet,
  })
  const machines = new R.machinesModule.Machines(f.host, null, { clock })
  try {
    machines.metrics.start()
    await clock.advance(0)
    assert.equal(probeCalls(f.calls).length, 1, 'the sampler probe is in flight')
    fixed = true
    const checking = machines.view(true)
    await settle()
    assert.equal(probeCalls(f.calls).length, 1, 'the fresh probe waits for the running one, it does not overlap it')
    release()
    const view = await checking
    assert.equal(probeCalls(f.calls).length, 2, 'Check again asked LayerFS itself')
    assert.equal(view.machines[0].state, 'ready', 'the answer after the fix, not the older probe\'s')
    assert.equal(probeCalls(f.calls)[1].options.timeout_ms, R.cli.PROBE_TIMEOUT_MS, 'a call with its own budget skips KEPT_READS (cli.ts)')
    assert.equal(probeCalls(f.calls)[0].options.timeout_ms, undefined, 'the sampler keeps the shared, kept read')
  } finally {
    machines.metrics.stop()
    f.close()
  }
})

test('a probe the record outdates leaves no live section or liveness time behind', async () => {
  const probedAt = 1_000_000, stoppedAt = 1_005_000
  let record = machineRow('ready', iso(probedAt - 1000))
  const f = fake({
    'machine.list': async () => ({ items: [record] }),
    'machine.get': async () => probeAnswer('ready', probedAt),
    ...quiet,
  })
  const machines = new R.machinesModule.Machines(f.host, null)
  try {
    const running = await machines.view(true)
    assert.equal(running.machines[0].state, 'ready')
    assert.equal(running.live.docker.freeDisk, 500)
    assert.equal(running.machines[0].observedAt, iso(probedAt))
    // a Stop since the probe: the record is newer than it
    record = machineRow('stopped', iso(stoppedAt))
    machines.changed()
    const stopped = await machines.view()
    assert.equal(stopped.machines[0].state, 'stopped', 'the record\'s newer state stands')
    assert.equal(stopped.live.docker.freeDisk, null, 'not the running machine\'s free disk')
    assert.equal(stopped.live.docker.toolVersion, null)
    assert.equal(stopped.machines[0].observedAt, iso(stoppedAt), 'the record\'s time, not the discarded probe\'s')
  } finally { f.close() }
})

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-probe-change-'))
await build({
  stdin: { contents: "export { MachinesController } from './src/client/machines/controller.ts'\n", resolveDir: root, loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', target: 'node24', outfile: join(out, 'machines.mjs'), absWorkingDir: root, logLevel: 'warning',
})
const M = await import(pathToFileURL(join(out, 'machines.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

test('the Machines page reads the view again on a probe event while it is shown', async (t) => {
  globalThis.requestAnimationFrame = (cb) => { cb(); return 1 }
  globalThis.requestIdleCallback = (cb) => { cb(); return 1 }
  t.after(() => { delete globalThis.requestAnimationFrame; delete globalThis.requestIdleCallback })
  const listeners = new Map()
  const reads = []
  const api = {
    connected: () => true,
    onEvent: (type, listener) => { listeners.set(type, [...(listeners.get(type) ?? []), listener]); return () => {} },
    call: async (method, path) => { if (path === '/api/machines') reads.push(path); return path.startsWith('/api/machines') ? { available: false, machines: [], sandboxes: [] } : {} },
    op: async () => ({}),
  }
  const controller = new M.MachinesController(api, () => true)
  t.after(() => controller.dispose())
  const release = controller.face().activate()
  t.after(release)
  await new Promise((resolve) => setTimeout(resolve, 0))
  const before = reads.length
  for (const listener of listeners.get('machine-progress') ?? []) listener({ type: 'machine-progress', data: { name: 'docker', kind: 'probe', progress: { stage: 'probe', state: 'broken' } } })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(reads.length, before + 1, 'one more machines read')
})
