// Two client guards (src/client/views/index.tsx, src/client/session/index.tsx):
// - unloading the plugin while LayerFS mode is still suspending DSH's stock
//   Trajectory gives the stock tab back once the suspension lands, and a
//   suspension refused after the unload throws nothing;
// - the Workspace list's LayerFS mark stays on a project session's row while a
//   read fails (`unknown` keeps the last project answer), and shows nothing for
//   an unknown read with no answer yet.
//   node --test test/views-unload-rowmark.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { miniReact } from './mini-react.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-views-unload-rowmark-'))
await build({
  absWorkingDir: root,
  stdin: {
    contents: [
      "export { mount } from 'react'",
      "export { registerViews } from './src/client/views/index.tsx'",
      "export { registerSession } from './src/client/session/index.tsx'",
      "export { ownershipStore, disposeOwnership } from './src/client/session/ownership.ts'",
    ].join('\n'),
    resolveDir: root, loader: 'tsx',
  },
  outfile: join(out, 'guards.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24', logLevel: 'error',
  jsx: 'automatic', loader: { '.module.css': 'local-css', '.css': 'css' }, plugins: [miniReact],
})
const M = await import(pathToFileURL(join(out, 'guards.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

const STOCK = '@deepseek-ai/dsh-client-ui-trajectory'
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A ctx that records slot registrations, keeps effect cleanups for an unload, and seats inspection targets. */
function fakeCtx(entries, { skip = [] } = {}) {
  const cleanups = []
  const registrations = []
  const targets = { seated: 0, removed: 0 }
  const ctx = {
    effect(fn, name) {
      if (skip.includes(name)) return
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    },
    get: (name) => name === 'loader' ? { entries: () => entries }
      : name === 'uiConversation' ? { views: { register: () => { targets.seated++; return () => { targets.removed++ } } } }
        : undefined,
    logger: { warn() {} },
    locale: { register: () => () => {}, bind: () => (key, vars) => (vars ? `${key} ${Object.values(vars).join(' ')}` : key) },
    slots: {
      register(options, component) {
        const record = { options, component, disposed: 0 }
        registrations.push(record)
        return () => { record.disposed++ }
      },
      inject(_name, fn) { return fn() },
    },
  }
  const unload = () => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() }
  return { ctx, registrations, targets, unload }
}

/** A stock entry whose `update` waits until the test settles it. */
function heldEntry() {
  const updates = []
  const pending = []
  const entry = {
    options: { name: STOCK },
    disabled: false,
    update(options) {
      updates.push(options.disabled)
      return new Promise((resolve, reject) => pending.push({
        resolve: () => { entry.disabled = options.disabled === true; resolve() },
        reject,
      }))
    },
  }
  return { entry, updates, pending }
}

/** Load the views, put a project session on screen, and wait until the stock suspension is in flight. */
async function suspending(entry) {
  const harness = fakeCtx([entry.entry])
  const api = {
    op: async (op) => (op === 'sessions.places' ? { places: { 'session-1': { project: 'proj' } } } : {}),
    onEvent: () => () => {},
  }
  M.registerViews(harness.ctx, api)
  const header = harness.registrations.find((r) => r.options.name === 'conversation.session.header.actions')
  header.options.inject('session-1').report('session-1')
  for (let i = 0; i < 40 && entry.pending.length === 0; i++) await wait(50)
  assert.deepEqual(entry.updates, [true], 'the stock Trajectory is being suspended')
  return { ...harness, api }
}

test('an unload during the suspension gives DSH its Trajectory back when the suspension lands', async () => {
  const stock = heldEntry()
  const { unload, registrations, targets, api } = await suspending(stock)
  unload()
  const views = registrations.filter((r) => r.options.name === 'conversation.view')
  assert.ok(views.length > 0 && views.every((r) => r.disposed === 1), 'the unload takes every view back at once')
  stock.pending.shift().resolve()
  for (let i = 0; i < 20 && stock.pending.length === 0; i++) await wait(10)
  assert.deepEqual(stock.updates, [true, null], 'the late suspension is undone')
  stock.pending.shift()?.resolve()
  await wait(20)
  assert.equal(stock.entry.disabled, false, 'the stock tab is back')
  assert.equal(targets.seated, targets.removed, 'no inspection target outlives the plugin')
  assert.equal(stock.pending.length, 0, 'nothing else runs after the unload')
  M.disposeOwnership(api)
})

test('a suspension refused after the unload throws nothing and changes nothing', async () => {
  const stock = heldEntry()
  const { unload, api } = await suspending(stock)
  const unhandled = []
  const onUnhandled = (reason) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    unload()
    stock.pending.shift().reject(new Error('loader refused'))
    await wait(50)
    assert.deepEqual(unhandled.map(String), [], 'no TypeError from a taken-back entry list')
    assert.deepEqual(stock.updates, [true], 'nothing was suspended, nothing to resume')
  } finally {
    process.off('unhandledRejection', onUnhandled)
    M.disposeOwnership(api)
  }
})

test('the row mark stays through a failed read and needs a project answer to show', async () => {
  const harness = fakeCtx([], { skip: ['dsh-layerfs: session row probe'] })
  let fail = false
  const api = {
    op: async () => { if (fail) throw new Error('host unavailable'); return { places: { 's-1': { project: 'demo/app' } } } },
    onEvent: () => () => {},
  }
  M.registerSession(harness.ctx, api)
  const slot = harness.registrations.find((r) => r.options.name === 'sidebar.session.row.trailing')
  const props = slot.options.inject('s-1')
  const view = M.mount(slot.component, props)
  assert.equal(view.tree, null, 'no answer yet: no mark')
  const store = M.ownershipStore(api)
  store.retry('s-1')
  await wait(10)
  assert.equal(store.entry('s-1').state, 'project')
  assert.ok(view.render(), 'a project session has the mark')
  fail = true
  store.retry('s-1')
  await wait(10)
  assert.equal(store.entry('s-1').state, 'unknown', 'the read failed')
  const kept = view.render()
  assert.ok(kept, 'an unknown read keeps the mark of the last answer')
  assert.match(kept.props.title, /demo\/app/)
  harness.unload()
  view.unmount()
  M.disposeOwnership(api)
})
