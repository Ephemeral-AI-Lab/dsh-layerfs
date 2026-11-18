// Sandbox creations run in the background (src/host/routes/sandbox-creates.ts,
// docs/specs/sandbox-images.md §4.1 and D10): `background: true` answers 202
// with the job, `sandbox-progress { creation }` events, the job list, failed
// jobs kept and dismissed, byte updates coalesced to one event per 500 ms.
//   node --test test/sandbox-creates.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRoutes, testHost } from './routes-helper.mjs'

const R = await loadRoutes()

class Refusal extends Error {
  constructor(code, message, detail = null) { super(message); Object.assign(this, { code, detail, transport: 'refusal' }) }
}

const PINNED = [{ family: 'sandbox', call: 'create', args: [], options: [{ name: 'image', kind: 'text' }] }]
const KEY = encodeURIComponent('s1/p')
const DIG = `sha256:${'a'.repeat(64)}`

/** A fake home whose sandbox.create waits for `release(name)` (or fails with `fail(name, error)`). */
function fixture() {
  const waits = new Map()
  const order = []
  const lfs = {
    project: { get: async (key) => ({ project: key, store: 's1', machine: 'lima1', engine: 'sqlite' }) },
    // a sqlite project's Sandboxes run on its Store's machine (2.0 `store get`)
    store: { get: async (name) => ({ store: name, engine: 'sqlite', machine: 'lima1', state: 'ready' }) },
    machine: { start: async (name, { on_progress }) => { order.push(`start ${name}`); on_progress({ stage: 'boot' }); return { name } } },
    sandbox: {
      // 2.0 `sandbox create <project> <sandbox>`: the machine is the Store's (no option for a sqlite project)
      create: (project, name, options) => {
        order.push(`create ${name}${options.machine ? ` on ${options.machine}` : ''}`)
        return new Promise((resolve, reject) => waits.set(name, { resolve: () => resolve({ ok: true }), reject }))
      },
    },
  }
  const root = mkdtempSync(join(tmpdir(), 'dsh-sandbox-creates-'))
  const t = testHost({ lfs, root, home: join(root, 'home'), discovery: async () => ({ identity: { version: '2.0.0-test', features: [] }, calls: PINNED }) })
  const groups = R.createGroups(t.host, async () => ({}))
  const tick = () => new Promise((r) => setImmediate(r))
  return {
    groups, events: t.events, order, logs: t.logs,
    progress: () => t.events.filter((e) => e.type === 'sandbox-progress').map((e) => e.data.creation),
    http: (method, path, body) => R.handle(groups, { method, path, body }),
    release: async (name) => { await tick(); waits.get(name).resolve(); await tick(); await tick() },
    fail: async (name, error) => { await tick(); waits.get(name).reject(error); await tick(); await tick() },
    close: () => rmSync(root, { recursive: true, force: true }),
  }
}

test('background: 202 with the queued job, listed while it runs, events through machine to done, then gone', async () => {
  const f = fixture()
  try {
    const admitted = await f.http('POST', `/api/projects/${KEY}/sandboxes`, { name: 'b1', image: DIG, start: true, background: true })
    assert.equal(admitted.status, 202)
    const job = admitted.body.creation
    assert.match(job.id, /^c-[0-9a-z]+-[0-9a-f]{4}$/)
    assert.deepEqual({ ...job, id: '', startedAt: 0, updatedAt: 0 }, { id: '', input: { project: 's1/p', name: 'b1', machine: 'lima1', image: DIG, start: true }, phase: 'queued', startedAt: 0, updatedAt: 0 })
    const listed = await f.http('GET', '/api/sandbox-creates')
    assert.equal(listed.status, 200)
    assert.deepEqual(listed.body.creations.map((c) => c.id), [job.id])
    // a running job is not dismissed (closing the dialog cancels nothing)
    assert.equal((await f.http('DELETE', `/api/sandbox-creates/${job.id}`)).status, 409)
    await f.release('b1')
    assert.deepEqual(f.order, ['start lima1', 'create b1'], 'the machine starts first')
    assert.deepEqual(f.progress().map((c) => c.phase), ['queued', 'machine', 'queued', 'done'])
    assert.ok(f.progress().every((c) => c.id === job.id))
    assert.ok(f.events.some((e) => e.type === 'machine-progress' && e.data.name === 'lima1'))
    assert.deepEqual((await f.http('GET', '/api/sandbox-creates')).body.creations, [])
  } finally { f.close() }
})

test('background: a failed job keeps its refusal 10 minutes, until dismissed or the same name is created again', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const f = fixture()
  try {
    const a = (await f.http('POST', `/api/projects/${KEY}/sandboxes`, { name: 'b1', background: true })).body.creation
    await f.fail('b1', new Refusal('Capacity', 'not enough space', { needed_bytes: 10, free_bytes: 1, path: '/var' }))
    const failed = (await f.http('GET', '/api/sandbox-creates')).body.creations
    assert.deepEqual(failed.map((c) => [c.id, c.phase, c.error]), [[a.id, 'failed', { code: 'Capacity', message: 'not enough space', detail: { needed_bytes: 10, free_bytes: 1, path: '/var' } }]])
    assert.deepEqual(f.progress().at(-1).phase, 'failed')
    // retry: the client re-sends the input as a new job; the failed one leaves the list
    const b = (await f.http('POST', `/api/projects/${KEY}/sandboxes`, { name: 'b1', background: true })).body.creation
    assert.notEqual(b.id, a.id)
    assert.deepEqual((await f.http('GET', '/api/sandbox-creates')).body.creations.map((c) => c.id), [b.id])
    await f.fail('b1', new Refusal('Unavailable', 'machine lima1 is stopped'))
    // dismiss
    const dismissed = await f.http('DELETE', `/api/sandbox-creates/${b.id}`)
    assert.equal(dismissed.status, 200)
    assert.deepEqual(dismissed.body.creations, [])
    assert.equal((await f.http('DELETE', `/api/sandbox-creates/${b.id}`)).status, 404)
    // expiry after 10 minutes
    const c = (await f.http('POST', `/api/projects/${KEY}/sandboxes`, { name: 'b2', background: true })).body.creation
    await f.fail('b2', new Error('boom'))
    t.mock.timers.tick(R.creates.FAILED_KEEP_MS - 1)
    assert.deepEqual((await f.http('GET', '/api/sandbox-creates')).body.creations.map((x) => [x.id, x.error.code]), [[c.id, 'Unknown']])
    t.mock.timers.tick(1)
    assert.deepEqual((await f.http('GET', '/api/sandbox-creates')).body.creations, [])
    // a create that succeeds without background drops a failed job of the same name too
    await f.http('POST', `/api/projects/${KEY}/sandboxes`, { name: 'b3', background: true })
    await f.fail('b3', new Error('boom'))
    const direct = f.http('POST', `/api/projects/${KEY}/sandboxes`, { name: 'b3' })
    await f.release('b3')
    assert.equal((await direct).status, 200)
    assert.deepEqual((await f.http('GET', '/api/sandbox-creates')).body.creations, [])
    assert.deepEqual(f.logs, [], 'no request failed')
  } finally { f.close() }
})

test('background: the Stage-0 guard refuses before admission; no job, no event', async () => {
  const f = fixture()
  try {
    const refused = await f.http('POST', `/api/projects/${KEY}/sandboxes`, { name: 'b1', image: 'postgres:17', background: true })
    assert.equal(refused.status, 501)
    assert.equal(refused.body.detail.need, 'image-refs')
    assert.deepEqual(f.progress(), [])
    assert.deepEqual(f.order, [])
  } finally { f.close() }
})

test('progress: phase changes go out at once, byte updates coalesced to one event per 500 ms', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 5_000 })
  const events = []
  const jobs = new R.creates.SandboxCreates((type, data) => events.push({ type, data }))
  let report
  let finish
  jobs.admit({ project: 's1/p', name: 'b1', machine: 'lima1' }, (r) => { report = r; return new Promise((resolve) => { finish = resolve }) })
  await new Promise((r) => setImmediate(r))
  const phases = () => events.map((e) => [e.data.creation.phase, e.data.creation.done ?? null])
  assert.deepEqual(phases(), [['queued', null]])
  report({ phase: 'send', done: 0, total: 100 })
  assert.deepEqual(phases().at(-1), ['send', 0], 'a new phase at once')
  report({ phase: 'send', done: 10, total: 100 })
  report({ phase: 'send', done: 20, total: 100 })
  assert.equal(events.length, 2, 'bytes within 500 ms are held')
  t.mock.timers.tick(499)
  assert.equal(events.length, 2)
  t.mock.timers.tick(1)
  assert.deepEqual(phases().at(-1), ['send', 20], 'one event with the latest bytes')
  report({ phase: 'send', done: 30, total: 100 })
  report({ phase: 'unpack' })
  assert.deepEqual(phases().slice(-1), [['unpack', null]], 'a phase change goes at once and replaces the held bytes')
  t.mock.timers.tick(1000)
  assert.equal(events.filter((e) => e.data.creation.phase === 'send').length, 2, 'the held byte update was dropped')
  assert.ok(events.every((e) => e.type === 'sandbox-progress' && e.data.type === 'sandbox-progress'))
  finish()
  t.mock.timers.reset()
  await new Promise((r) => setImmediate(r))
  assert.equal(events.at(-1).data.creation.phase, 'done')
  assert.deepEqual(jobs.list().creations, [])
})

test('progress: within the copy the last bytes carry over (no bare "Copying image", no bar backwards); unpack has its own', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 5_000 })
  const events = []
  const jobs = new R.creates.SandboxCreates((type, data) => events.push({ type, data }))
  let report
  let finish
  jobs.admit({ project: 's1/p', name: 'b1', machine: 'lima1' }, (r) => { report = r; return new Promise((resolve) => { finish = resolve }) })
  await new Promise((r) => setImmediate(r))
  const last = () => { const c = events.at(-1).data.creation; return [c.phase, c.done ?? null, c.total ?? null] }
  report({ phase: 'inspect' })
  assert.deepEqual(last(), ['inspect', null, null], 'no bytes yet')
  report({ phase: 'send', done: 450, total: 485 })
  assert.deepEqual(last(), ['send', 450, 485])
  t.mock.timers.tick(500)
  report({ phase: 'export' })
  t.mock.timers.tick(500)
  assert.deepEqual(last(), ['export', 450, 485], 'an export step without bytes keeps the copy\'s')
  report({ phase: 'send', done: 400, total: 485 })
  t.mock.timers.tick(500)
  assert.deepEqual(last(), ['send', 450, 485], 'done never goes back for the same total')
  report({ phase: 'unpack' })
  assert.deepEqual(last(), ['unpack', null, null], 'unpack goes out at once with its own (no) bytes')
  report({ phase: 'start' })
  assert.deepEqual(last(), ['start', null, null])
  assert.deepEqual(R.creates.bytesAfter({ phase: 'send', done: 5, total: 10 }, { phase: 'unpack', done: 1, total: 4 }), { done: 1, total: 4 })
  assert.deepEqual(R.creates.bytesAfter({ phase: 'send', done: 5, total: 10 }, { phase: 'send', done: 2, total: 20 }), { done: 2, total: 20 }, 'a new total starts over')
  finish()
  t.mock.timers.reset()
  await new Promise((r) => setImmediate(r))
})
