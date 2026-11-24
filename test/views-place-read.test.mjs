// A failed `session.place` read is not an answer: it must not drop the
// conversation views or pin the session as "not a project". The next
// `layerfs-session` event (or a reconnect) reads again; only a real place
// answer changes the tabs.
//   node --test test/views-place-read.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { miniReact } from './mini-react.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-views-place-read-'))
await build({
  absWorkingDir: root,
  stdin: {
    contents: [
      "export { registerViews } from './src/client/views/index.tsx'",
    ].join('\n'),
    resolveDir: root, loader: 'tsx',
  },
  outfile: join(out, 'place-read.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24', logLevel: 'error',
  jsx: 'automatic', loader: { '.module.css': 'local-css', '.css': 'css' }, plugins: [miniReact],
})
const M = await import(pathToFileURL(join(out, 'place-read.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A ctx whose slot registrations and disposers are recorded, and a mutable `session.place` answer. */
function harness() {
  const registrations = []
  const listeners = new Map()
  const calls = []
  let answer = async () => ({ place: { project: 'proj' } })
  const api = {
    op: (name, args) => { calls.push({ name, sessionId: args?.sessionId }); return answer() },
    onEvent: (name, fn) => {
      const set = listeners.get(name) ?? new Set()
      set.add(fn)
      listeners.set(name, set)
      return () => { set.delete(fn) }
    },
  }
  const ctx = {
    effect: (fn) => fn() ?? (() => {}),
    get: () => undefined,
    logger: { warn: () => {} },
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: {
      register(options, component) {
        const record = { options, component, disposed: 0 }
        registrations.push(record)
        return () => { record.disposed++ }
      },
      inject(_name, fn) { return fn() },
    },
  }
  return {
    api, ctx, registrations, calls,
    answer: (fn) => { answer = fn },
    emit: (name, data) => { for (const fn of listeners.get(name) ?? []) fn({ data }) },
  }
}

const viewRegs = (registrations) => registrations.filter((r) => r.options.name === 'conversation.view')

test('a failed session.place read keeps the tabs; the next event retries and a "not a project" answer drops them', async () => {
  const h = harness()
  M.registerViews(h.ctx, h.api)
  const header = h.registrations.find((r) => r.options.name === 'conversation.session.header.actions')
  header.options.inject('session-1').report('session-1')
  await wait(300)
  assert.equal(viewRegs(h.registrations).length, 5, 'the project session shows the five views')
  assert.equal(h.calls.length, 1, 'the presence header asked for the place once')

  // A host blip: the read rejects. It is not an answer, so no view is disposed.
  h.answer(() => Promise.reject(new Error('host unavailable')))
  h.emit('layerfs-session', { sessionId: 'session-1' })
  await wait(300)
  assert.equal(h.calls.length, 2, 'the event asked again')
  assert.equal(viewRegs(h.registrations).length, 5)
  assert.deepEqual(viewRegs(h.registrations).map((r) => r.disposed), [0, 0, 0, 0, 0], 'a failed read is not an answer')

  // The next event reads again; now the answer is "not a project".
  h.answer(async () => ({ place: null }))
  h.emit('layerfs-session', { sessionId: 'session-1' })
  await wait(300)
  assert.equal(h.calls.length, 3, 'the next event retried')
  assert.deepEqual(viewRegs(h.registrations).map((r) => r.disposed), [1, 1, 1, 1, 1], 'a real answer drops the tabs')
})
