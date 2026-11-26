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

test('an identical storage read answers both callers, then a forced read reads anew', async (t) => {
  const { api, state } = await newApi(t)
  const one = api.call('GET', '/api/storage', undefined, { share: true })
  const two = api.call('GET', '/api/storage', undefined, { share: true })
  await flush()
  assert.equal(state.calls.length, 1, 'the second mount joined the first read')
  state.held.shift().settle(true, { status: 200, body: { stores: ['one'] } })
  assert.deepEqual(await one, { stores: ['one'] })
  assert.deepEqual(await two, { stores: ['one'] })
  // B3's in-flight answer is now also a recent answer, so a staggered mount
  // reuses it; only a forced read (the page's Refresh) reads the host again.
  const three = api.call('GET', '/api/storage', undefined, { share: true })
  await flush()
  assert.equal(state.calls.length, 1)
  assert.deepEqual(await three, { stores: ['one'] })
  const four = api.call('GET', '/api/storage', undefined, { share: true, fresh: true })
  await flush()
  assert.equal(state.calls.length, 2)
  state.held.shift().settle(true, { status: 200, body: { stores: ['two'] } })
  assert.deepEqual(await four, { stores: ['two'] })
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

// ---------------------------------------------------------------- shared recent answers
/** A host that answers at once and lets the test push host events. */
function liveHost() {
  const state = { calls: [], events: [] }
  let wake = null
  const remote = {
    call(request) {
      state.calls.push(request)
      return Promise.resolve({ ok: true, value: { answer: state.calls.length } })
    },
    events() {
      return {
        [Symbol.asyncIterator]() {
          return {
            next() {
              if (state.events.length) return Promise.resolve({ value: state.events.shift() })
              return new Promise((resolve) => { wake = () => resolve({ value: state.events.shift() }) })
            },
          }
        },
        dispose() {},
      }
    },
  }
  const emit = (event) => {
    state.events.push(event)
    const resume = wake
    wake = null
    resume?.()
  }
  return { state, remote: () => remote, emit }
}

async function newLiveApi(t) {
  const host = liveHost()
  const api = A.createApi(host.remote, {
    createSession: async () => 'session-x',
    openPanel() {},
    openWorkspace: async () => {},
    openSession() {},
  }, () => undefined)
  t.after(() => api.dispose())
  await flush()
  return { api, state: host.state, emit: host.emit }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('a shared answer serves the staggered mount, then ages out', async (t) => {
  assert.ok(A.SHARE_MAX_AGE_MS >= 250 && A.SHARE_MAX_AGE_MS <= 2_000, 'the answer age stays a burst, never a TTL')
  const { api, state } = await newLiveApi(t)
  const one = await api.call('GET', '/api/machines', undefined, { share: true })
  const two = await api.call('GET', '/api/machines', undefined, { share: true })
  assert.equal(state.calls.length, 1, 'the second surface of the visit reused the answer')
  assert.deepEqual(two, one)
  // Its own bounded age: once past it, the host is read again.
  const quick = { share: { maxAgeMs: 20 } }
  await api.call('GET', '/api/machines/recent', undefined, quick)
  await sleep(35)
  await api.call('GET', '/api/machines/recent', undefined, quick)
  assert.equal(state.calls.length, 3, 'past its age, a shared read sends')
})

test('the events that change a view drop the shared answer', async (t) => {
  const { api, state, emit } = await newLiveApi(t)
  const machine = () => api.call('GET', '/api/machines', undefined, { share: true })
  await machine()
  await machine()
  assert.equal(state.calls.length, 1)
  emit({ type: 'machine-progress', data: { name: 'docker' } })
  await flush()
  await machine()
  assert.equal(state.calls.length, 2, 'machine-progress invalidates the machines answer')
  emit({ type: 'sandbox-progress', data: {} })
  await flush()
  await machine()
  assert.equal(state.calls.length, 2, 'an unrelated event keeps it')
  emit({ type: 'storage', data: {} })
  await flush()
  await machine()
  assert.equal(state.calls.length, 3, 'storage invalidates the machines answer')

  const catalog = () => api.op('projects.catalog', undefined, { share: true })
  await catalog()
  await catalog()
  assert.equal(state.calls.length, 4)
  emit({ type: 'projects-changed', data: {} })
  await flush()
  await catalog()
  assert.equal(state.calls.length, 5, 'projects-changed invalidates the catalog answer')

  const setup = () => api.op('setup.status', undefined, { share: true })
  await setup()
  await setup()
  assert.equal(state.calls.length, 6)
  emit({ type: 'setup-changed', data: {} })
  await flush()
  await setup()
  assert.equal(state.calls.length, 7, 'setup-changed invalidates the setup answer')

  emit({ type: 'connection', data: { connected: false } })
  await flush()
  await machine()
  await catalog()
  await setup()
  assert.equal(state.calls.length, 10, 'a reconnect drops every answer')
})

test('a forced refresh bypasses the shared answer', async (t) => {
  const { api, state } = await newLiveApi(t)
  await api.call('GET', '/api/machines', undefined, { share: true })
  await api.call('GET', '/api/machines', undefined, { share: true })
  assert.equal(state.calls.length, 1)
  await api.call('GET', '/api/machines', undefined, { share: true, fresh: true })
  assert.equal(state.calls.length, 2, 'the Refresh button reads the host even right after a shared answer')
  await api.call('GET', '/api/machines?fresh=1', undefined, { share: true })
  assert.equal(state.calls.length, 3, '?fresh=1 has its own key and also reads')
})

test('a write drops the recent answers it may invalidate', async (t) => {
  const { api, state } = await newLiveApi(t)
  await api.call('GET', '/api/machines', undefined, { share: true })
  await api.call('GET', '/api/machines', undefined, { share: true })
  assert.equal(state.calls.length, 1)
  await api.call('POST', '/api/machines/docker/start')
  await api.call('GET', '/api/machines', undefined, { share: true })
  assert.equal(state.calls.length, 3, 'the write and the reread both reached the host')
})

test('an answer that an event invalidated while in flight is not kept', async (t) => {
  const state = { calls: [], held: [], events: [] }
  let wake = null
  const remote = {
    call(request) {
      state.calls.push(request)
      return new Promise((resolve, reject) => { state.held.push({ request, resolve, reject }) })
    },
    events() {
      return {
        [Symbol.asyncIterator]() {
          return {
            next() {
              if (state.events.length) return Promise.resolve({ value: state.events.shift() })
              return new Promise((resolve) => { wake = () => resolve({ value: state.events.shift() }) })
            },
          }
        },
        dispose() {},
      }
    },
  }
  const api = A.createApi(() => remote, {
    createSession: async () => 'session-x',
    openPanel() {},
    openWorkspace: async () => {},
    openSession() {},
  }, () => undefined)
  t.after(() => api.dispose())
  await flush()
  const first = api.call('GET', '/api/machines', undefined, { share: true })
  await flush()
  assert.equal(state.calls.length, 1)
  // The event lands while the host read is still in flight.
  state.events.push({ type: 'machine-progress', data: {} })
  const resume = wake
  wake = null
  resume?.()
  await flush()
  state.held.shift().resolve({ ok: true, value: { status: 200, body: { before: true } } })
  assert.deepEqual(await first, { before: true })
  const second = api.call('GET', '/api/machines', undefined, { share: true })
  await flush()
  assert.equal(state.calls.length, 2, 'the invalidated in-flight answer is not reused')
  state.held.shift().resolve({ ok: true, value: { status: 200, body: { after: true } } })
  assert.deepEqual(await second, { after: true })
})
