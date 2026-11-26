// The client's one host seam (src/client/api.ts) admits a bounded number of
// sends, runs interactive reads before decoration, never starves decoration,
// releases a slot on a refusal, and shares an identical read already in flight.
//   node --test test/client-admission.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-client-admission-'))
await build({
  stdin: { contents: "export * from './src/client/api.ts'\n", resolveDir: root, loader: 'ts' },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  outfile: join(out, 'admission.mjs'),
  absWorkingDir: root,
  logLevel: 'warning',
})
const A = await import(pathToFileURL(join(out, 'admission.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** A host that starts every admitted call and holds its answer until the test settles it. */
function fakeHost() {
  const state = { calls: [], held: [], active: 0, peak: 0 }
  const remote = {
    call(request) {
      state.active++
      state.peak = Math.max(state.peak, state.active)
      state.calls.push(request)
      return new Promise((resolve, reject) => {
        state.held.push({
          request,
          settle(ok, value) {
            state.active--
            if (ok) resolve({ ok: true, value })
            else reject(new Error('refused'))
          },
        })
      })
    },
    events() {
      // The event stream stays open without delivering anything.
      return { [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}) } }, dispose() {} }
    },
  }
  return { state, remote: () => remote }
}

async function newApi(t) {
  const host = fakeHost()
  const api = A.createApi(host.remote, {
    createSession: async () => 'session-x',
    openPanel() {},
    openWorkspace: async () => {},
    openSession() {},
  }, () => undefined)
  t.after(() => api.dispose())
  await flush()
  return { api, state: host.state }
}

/** Settle held answers, letting queued calls start, until `done` and nothing is left in flight. */
async function drain(state, done = () => false) {
  for (let guard = 0; guard < 200; guard++) {
    while (state.held.length) state.held.shift().settle(true, { status: 200, body: {} })
    await flush()
    if (done() && state.held.length === 0) return
  }
}

test('at most HOST_IN_FLIGHT_LIMIT sends are in flight, and every call is admitted', async (t) => {
  assert.ok(A.HOST_IN_FLIGHT_LIMIT >= 4 && A.HOST_IN_FLIGHT_LIMIT <= 6, 'the live A/B tunes the one constant inside 4–6')
  const { api, state } = await newApi(t)
  const calls = Array.from({ length: 12 }, (_, i) => api.op('probe', { i }))
  await flush()
  assert.equal(state.calls.length, A.HOST_IN_FLIGHT_LIMIT, 'the queue is bounded')
  assert.equal(state.peak, A.HOST_IN_FLIGHT_LIMIT)
  let settled = 0
  for (const call of calls) call.then(() => { settled++ })
  await drain(state, () => settled === calls.length)
  await Promise.all(calls)
  assert.equal(state.calls.length, 12, 'none was dropped')
  assert.equal(state.peak, A.HOST_IN_FLIGHT_LIMIT, 'the cap held for the whole run')
})

test('interactive reads are admitted before queued background reads', async (t) => {
  const { api, state } = await newApi(t)
  const held = Array.from({ length: A.HOST_IN_FLIGHT_LIMIT }, () => api.op('probe', { tag: 'bg-first' }, { priority: 'background' }))
  await flush()
  const waiting = [api.op('probe', { tag: 'bg-wait' }, { priority: 'background' }), api.op('probe', { tag: 'bg-wait2' }, { priority: 'background' })]
  const ui = api.op('probe', { tag: 'ui' })
  const all = [...held, ...waiting, ui]
  await drain(state, () => state.calls.length === A.HOST_IN_FLIGHT_LIMIT + 3)
  const order = state.calls.map((call) => call.args.tag)
  assert.deepEqual(order.slice(A.HOST_IN_FLIGHT_LIMIT), ['ui', 'bg-wait', 'bg-wait2'], 'the interactive read jumped the background queue')
  await Promise.all(all)
})

test('background work is not starved by a stream of interactive reads', async (t) => {
  const { api, state } = await newApi(t)
  const first = Array.from({ length: A.HOST_IN_FLIGHT_LIMIT }, () => api.op('probe', { tag: 'ui-first' }))
  await flush()
  const background = api.op('probe', { tag: 'bg' }, { priority: 'background' })
  const rest = Array.from({ length: 24 }, () => api.op('probe', { tag: 'ui' }))
  const all = [...first, background, ...rest]
  let settled = 0
  for (const call of all) call.then(() => { settled++ })
  await drain(state, () => state.calls.length === all.length)
  await Promise.all(all)
  const at = state.calls.findIndex((call) => call.args.tag === 'bg')
  assert.ok(at >= A.HOST_IN_FLIGHT_LIMIT, 'the background read waited for a slot')
  assert.ok(at < A.HOST_IN_FLIGHT_LIMIT + A.BACKGROUND_TURN_EVERY + 1,
    `the background read got a turn after ${at} starts, not after every interactive read`)
})

test('a rejected send releases its slot', async (t) => {
  const { api, state } = await newApi(t)
  const refused = Array.from({ length: A.HOST_IN_FLIGHT_LIMIT }, (_, i) => api.op('probe', { i }))
  const refusedCheck = assert.rejects(refused[0], /refused/)
  const after = api.op('probe', { tag: 'after' })
  await flush()
  assert.equal(state.calls.length, A.HOST_IN_FLIGHT_LIMIT)
  // Refuse one answer: its slot must free for the queued call.
  state.held.shift().settle(false)
  await flush()
  assert.equal(state.calls.length, A.HOST_IN_FLIGHT_LIMIT + 1, 'the next call was admitted')
  assert.equal(state.calls.at(-1).args.tag, 'after')
  // Settle what is left: the refusal stays a refusal, the later call answers.
  while (state.held.length) state.held.shift().settle(true, { status: 200, body: {} })
  await flush()
  await refusedCheck
  assert.deepEqual(await after, { status: 200, body: {} })
})

test('an identical storage read already in flight answers both callers, then reads anew', async (t) => {
  const { api, state } = await newApi(t)
  const one = api.call('GET', '/api/storage', undefined, { share: true })
  const two = api.call('GET', '/api/storage', undefined, { share: true })
  await flush()
  assert.equal(state.calls.length, 1, 'the second mount joined the first read')
  state.held.shift().settle(true, { status: 200, body: { stores: ['one'] } })
  assert.deepEqual(await one, { stores: ['one'] })
  assert.deepEqual(await two, { stores: ['one'] })
  // Once it has settled, a later mount reads again: no answer is kept by time.
  const three = api.call('GET', '/api/storage', undefined, { share: true })
  await flush()
  assert.equal(state.calls.length, 2)
  state.held.shift().settle(true, { status: 200, body: { stores: ['two'] } })
  assert.deepEqual(await three, { stores: ['two'] })
})

test('the boot catalog op shares while in flight too', async (t) => {
  const { api, state } = await newApi(t)
  const one = api.op('projects.catalog', undefined, { share: true })
  const two = api.op('projects.catalog', undefined, { share: true })
  await flush()
  assert.equal(state.calls.length, 1)
  state.held.shift().settle(true, { rows: [], scratchKey: null })
  assert.deepEqual(await one, { rows: [], scratchKey: null })
  assert.deepEqual(await two, { rows: [], scratchKey: null })
})
