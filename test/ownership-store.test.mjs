// The one ownership store: one coalesced `sessions.places` batch, three states,
// a failed read that keeps the last answer, Retry, and a connection that reads
// every known id again.
//   node --test test/ownership-store.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { miniReact } from './mini-react.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-ownership-store-'))
await build({
  absWorkingDir: root,
  stdin: {
    contents: "export * from './src/client/session/ownership.ts'",
    resolveDir: root, loader: 'ts',
  },
  outfile: join(out, 'ownership.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24', logLevel: 'error',
  jsx: 'automatic', loader: { '.module.css': 'local-css', '.css': 'css' }, plugins: [miniReact],
})
const M = await import(pathToFileURL(join(out, 'ownership.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const WINDOW_MS = M.OWNERSHIP_COALESCE_MS

/** An api that records `sessions.places` calls, delivers events, and answers from `answer`. */
function fakeApi() {
  const calls = []
  const listeners = new Map()
  let answer = async () => ({ places: {} })
  const api = {
    op: (name, args) => { calls.push({ name, args }); return answer(name, args) },
    onEvent: (name, fn) => {
      const set = listeners.get(name) ?? new Set()
      set.add(fn)
      listeners.set(name, set)
      return () => { set.delete(fn) }
    },
  }
  return {
    api, calls,
    answer: (fn) => { answer = fn },
    emit: (name, data) => { for (const fn of listeners.get(name) ?? []) fn({ data }) },
    listeners: (name) => listeners.get(name)?.size ?? 0,
  }
}

test('one store per api, one subscription to each ownership event', () => {
  const h = fakeApi()
  const store = M.ownershipStore(h.api)
  assert.equal(M.ownershipStore(h.api), store, 'every consumer shares the api\'s one store')
  assert.equal(h.listeners('layerfs-session'), 1)
  assert.equal(h.listeners('connection'), 1)
  M.disposeOwnership(h.api)
  assert.notEqual(M.ownershipStore(h.api), store, 'a disposed store is replaced')
  M.disposeOwnership(h.api)
})

test('a burst of events shares one batch read in the next window', async () => {
  const h = fakeApi()
  h.answer(async () => ({ places: { a: { project: 'p' }, b: null } }))
  const store = new M.OwnershipStore(h.api)
  store.refresh(['a'])
  store.refresh(['a'])
  h.emit('layerfs-session', { sessionId: 'b' })
  assert.equal(h.calls.length, 0, 'nothing is read inside the window')
  await wait(WINDOW_MS / 2)
  assert.equal(h.calls.length, 0)
  await wait(WINDOW_MS / 2 + 100)
  assert.equal(h.calls.length, 1, 'the burst is one batch')
  assert.equal(h.calls[0].name, 'sessions.places')
  assert.deepEqual([...h.calls[0].args.sessionIds].sort(), ['a', 'b'])
  assert.equal(store.entry('a').state, 'project')
  assert.equal(store.entry('a').project, 'p')
  assert.equal(store.entry('b').state, 'notProject')
  store.dispose()
})

test('a refresh that arrives during a batch is queued, not dropped', async () => {
  let release
  const h = fakeApi()
  h.answer(() => new Promise((resolve) => { release = resolve }))
  const store = new M.OwnershipStore(h.api)
  store.refresh(['a', 'b'])
  await wait(WINDOW_MS + 100)
  assert.equal(h.calls.length, 1, 'one batch at a time')
  assert.deepEqual(h.calls[0].args.sessionIds, ['a', 'b'])
  h.emit('layerfs-session', { sessionId: 'c' })
  release({ places: { a: { project: 'p' }, b: null } })
  await wait(20)
  assert.equal(h.calls.length, 1, 'the pending refresh waits for the running batch')
  await wait(WINDOW_MS + 100)
  assert.equal(h.calls.length, 2, 'one more batch runs for it')
  assert.deepEqual(h.calls[1].args.sessionIds, ['c'])
  store.dispose()
})

test('a failed read is unknown with the last answer kept, Retry reads again, a connection reads every known id', async () => {
  const h = fakeApi()
  h.answer(async () => ({ places: { a: { project: 'p', projectId: 'pid' }, b: null } }))
  const store = new M.OwnershipStore(h.api)
  store.refresh(['a', 'b'])
  await wait(WINDOW_MS + 100)
  assert.deepEqual(store.entry('a'), { state: 'project', project: 'p', projectId: 'pid' })
  assert.equal(store.entry('b').state, 'notProject')

  const boom = new Error('host unavailable')
  h.answer(async () => { throw boom })
  h.emit('layerfs-session', { sessionId: 'a' })
  await wait(WINDOW_MS + 100)
  assert.equal(store.entry('a').state, 'unknown', 'a failed read is not an answer')
  assert.equal(store.entry('a').project, 'p', 'the last project stays for display')
  assert.equal(store.entry('a').projectId, 'pid')
  assert.equal(store.entry('a').error, boom)
  assert.equal(store.entry('b').state, 'notProject', 'only the named session was read again')

  h.answer(async () => ({ places: { a: { project: 'p2' } } }))
  store.retry('a')
  await wait(20)
  assert.equal(store.entry('a').state, 'project', 'Retry reads now')
  assert.equal(store.entry('a').project, 'p2')
  assert.equal(store.entry('a').error, undefined)

  h.answer(async () => ({ places: { a: { project: 'p2' }, b: null } }))
  const before = h.calls.length
  h.emit('connection', { connected: true })
  await wait(WINDOW_MS + 100)
  assert.equal(h.calls.length, before + 1)
  assert.deepEqual([...h.calls.at(-1).args.sessionIds].sort(), ['a', 'b'], 'every known id is read on a connection')
  store.dispose()
})
