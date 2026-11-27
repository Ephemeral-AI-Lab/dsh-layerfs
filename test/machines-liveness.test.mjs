// B4: a machine's live probe is sampled by the metrics sampler, not awaited on
// `GET /api/machines`. The read answers from the last probe (and the record),
// a Docker machine that dies flips within one sampler window, the record's
// newer state is never overwritten by an older probe, a stopped machine is not
// probed every window, and the user's `?fresh=1` still probes.
//   node --test test/machines-liveness.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRoutes, testHost } from './routes-helper.mjs'

const R = await loadRoutes()
const iso = (ms) => new Date(ms).toISOString()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const probeCalls = (calls) => calls.filter((c) => c.call === 'machine.get')
const statsCalls = (calls) => calls.filter((c) => c.call === 'machine.stats')

/** A clock a test moves by hand (the sampler's, as in metrics.test.mjs). */
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
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

/** A fake LayerFS that records every call (name, arguments, options) and answers from `answers`. */
function fake(answers) {
  const calls = []
  const lfs = new Proxy({}, { get: (_, family) => new Proxy({}, { get: (__, name) => async (...args) => {
    const call = `${String(family)}.${String(name)}`
    calls.push({ call, args, options: args.at(-1) })
    const answer = answers[call]
    return answer ? answer(...args) : {}
  } }) })
  const dir = mkdtempSync(join(tmpdir(), 'dsh-b4-'))
  const t = testHost({ lfs, root: dir, home: join(dir, 'home'), discovery: discover })
  return { calls, host: t.host, close: () => rmSync(dir, { recursive: true, force: true }) }
}
const discover = async () => ({ identity: { version: '2.0.0-test', features: [] }, calls: [{ family: 'machine', call: 'stats', args: [], options: [] }], commands: [], switches: [] })
const machineRow = (state = 'ready', observed_at = null) => ({ machine: 'docker', platform: 'docker', state, stores: [], sandboxes: [], supports: ['sqlite'], ...(observed_at ? { observed_at } : {}) })
const probeAnswer = (state, at) => ({ machine: 'docker', platform: 'docker', state, observed_at: iso(at), ...(state === 'broken' ? { reason: 'engine_down', fix: 'open Docker' } : {}), live: { disk_free_bytes: state === 'ready' ? 500 : null, tool_version: 'docker 28', worker: null } })
const statsAnswer = (at) => ({ machine: 'docker', observed_at: iso(at), cpus: 4, memory_used_bytes: 1, memory_total_bytes: 2, disk_used_bytes: 3, disk_total_bytes: 4, disk_free_bytes: 6, data_disk: {}, stores: [], sandboxes: [] })

test('/api/machines answers from the records and the sampler without probing; fresh=1 probes, and the payload keeps its fields', async () => {
  const f = fake({
    'machine.list': async () => ({ items: [machineRow('ready', iso(1_000_000))] }),
    // a slow probe: a read that waited on it would take 200+ ms
    'machine.get': async (name) => { await sleep(200); return probeAnswer('ready', 1_000_000) },
    'store.list': async () => ({ items: [] }),
    'sandbox.list': async () => ({ items: [] }),
    'home.get': async () => ({ state: 'ready', version: '2.0.0', platforms: { host: 'linux', items: [] } }),
  })
  const groups = R.createGroups(f.host, async () => ({}))
  try {
    const t0 = performance.now()
    const read = await R.handle(groups, { method: 'GET', path: '/api/machines' })
    const ms = performance.now() - t0
    assert.equal(read.status, 200)
    assert.equal(probeCalls(f.calls).length, 0, 'no machine.get --with live on the read path')
    assert.ok(ms < 150, `the read does not wait on the probe (${Math.round(ms)} ms)`)
    assert.equal(read.body.machines[0].state, 'ready')
    // the live section keeps its fields; its values are "not observed" until a probe answers
    assert.deepEqual(Object.keys(read.body.live.docker).sort(), ['freeDisk', 'name', 'toolVersion', 'worker'])
    assert.equal(read.body.live.docker.freeDisk, null)
    // the machine's own fields are the ones the page read before
    for (const key of ['name', 'platform', 'state', 'op', 'reason', 'fix', 'message', 'observedAt', 'supports', 'cpus', 'memory', 'disk', 'stores', 'sandboxes', 'storesCount', 'sandboxesCount']) {
      assert.ok(key in read.body.machines[0], `machine.${key} is still answered`)
    }
    // the user's explicit ask probes now (the page's Check again / Refresh)
    const fresh = await R.handle(groups, { method: 'GET', path: '/api/machines?fresh=1' })
    assert.equal(probeCalls(f.calls).length, 1, 'fresh=1 probes')
    // its own budget: a fresh probe skips the SDK client's kept machine.get answer
    assert.deepEqual(probeCalls(f.calls)[0].options, { detail: true, with: ['live'], timeout_ms: R.cli.PROBE_TIMEOUT_MS })
    assert.equal(fresh.body.live.docker.freeDisk, 500)
    assert.equal(fresh.body.machines[0].observedAt, iso(1_000_000), 'the answer carries the liveness timestamp')
  } finally { f.close() }
})

test('a Docker machine that dies reads broken within one sampler window; the read itself never probes', async () => {
  const clock = fakeClock()
  let alive = true
  const f = fake({
    // the record never changes: the live probe is the only signal that Docker died
    'machine.list': async () => ({ items: [machineRow('ready')] }),
    'machine.get': async () => probeAnswer(alive ? 'ready' : 'broken', clock.now()),
    'machine.stats': async () => statsAnswer(clock.now()),
    'store.list': async () => ({ items: [] }),
    'sandbox.list': async () => ({ items: [] }),
    'home.get': async () => ({ platforms: { host: 'linux', items: [] } }),
  })
  const machines = new R.machinesModule.Machines(f.host, null, { clock })
  const realNow = Date.now
  try {
    machines.metrics.start()
    await clock.advance(0)
    const up = await machines.view()
    assert.equal(up.machines[0].state, 'ready')
    assert.equal(up.live.docker.freeDisk, 500)
    assert.equal(probeCalls(f.calls).length, 1, 'the sampler took the first probe')
    alive = false
    const before = probeCalls(f.calls).length
    await clock.advance(15_000)
    // read after the view's 5 s keep expired, without a fresh probe
    Date.now = () => realNow() + 5001
    const down = await machines.view()
    Date.now = realNow
    assert.equal(probeCalls(f.calls).length, before + 1, 'one more probe: the sampler window')
    assert.equal(down.machines[0].state, 'broken', 'the board and readiness see the dead machine')
    assert.equal(down.machines[0].reason, 'engine_down')
    assert.equal(down.live.docker.freeDisk, null)
    assert.equal(probeCalls(f.calls).length, before + 1, 'the read added no probe')
    // the next window's probe is the newer word again
    alive = true
    await clock.advance(15_000)
    Date.now = () => realNow() + 12_000
    const back = await machines.view()
    Date.now = realNow
    assert.equal(back.machines[0].state, 'ready')
  } finally {
    Date.now = realNow
    machines.metrics.stop()
    f.close()
  }
})

test('only a ready/unknown machine is probed every window: a stopped one gets one probe at its state change', async () => {
  const clock = fakeClock()
  let state = 'ready'
  const f = fake({
    'machine.list': async () => ({ items: [machineRow(state)] }),
    'machine.get': async () => probeAnswer(state, clock.now()),
    'machine.stats': async () => statsAnswer(clock.now()),
    'store.list': async () => ({ items: [] }),
    'sandbox.list': async () => ({ items: [] }),
    'home.get': async () => ({ platforms: { host: 'linux', items: [] } }),
  })
  const machines = new R.machinesModule.Machines(f.host, null, { clock })
  try {
    machines.metrics.start()
    await clock.advance(0)
    assert.equal(probeCalls(f.calls).length, 1, 'ready: probed')
    await clock.advance(15_000)
    assert.equal(probeCalls(f.calls).length, 2, 'ready: probed again next window')
    state = 'stopped'
    await clock.advance(15_000)
    assert.equal(probeCalls(f.calls).length, 3, 'a changed state asks once more')
    await clock.advance(30_000)
    assert.equal(probeCalls(f.calls).length, 3, 'a stopped machine is not probed every window')
    state = 'unknown'
    await clock.advance(15_000)
    assert.equal(probeCalls(f.calls).length, 4, 'unknown is probed: it is how it becomes known')
    await clock.advance(15_000)
    assert.equal(probeCalls(f.calls).length, 5, 'still unknown: probed again')
    assert.equal(statsCalls(f.calls).filter((c) => c.args[0] === 'docker').length < 7, true, 'stats turns stay on the sampler cadence')
  } finally {
    machines.metrics.stop()
    f.close()
  }
})
