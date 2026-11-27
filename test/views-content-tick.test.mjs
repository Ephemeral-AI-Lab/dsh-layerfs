// The conversation views' two counters: `tick` (the session-state read behind the
// unsaved line) follows every LayerFS event, while `contentTick` (Files' tree,
// History's graph, Stats' storage) follows checkpoints and reconnects only.
// `useRootState` is driven through the hook runtime in mini-react.mjs.
//   node --test test/views-content-tick.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { miniReact } from './mini-react.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-views-content-tick-'))
await build({
  absWorkingDir: root,
  stdin: {
    contents: [
      "export { mount } from 'react'",
      "export { useRootState } from './src/client/views/hooks.ts'",
    ].join('\n'),
    resolveDir: root, loader: 'tsx',
  },
  outfile: join(out, 'content-tick.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24', logLevel: 'error',
  jsx: 'automatic', loader: { '.module.css': 'local-css', '.css': 'css' }, plugins: [miniReact],
})
const M = await import(pathToFileURL(join(out, 'content-tick.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

// The hook polls while the page is visible; this drives events only, so the 10 s
// poll never runs (and cannot hold the test process open) and visibility is safe.
const realSetInterval = globalThis.setInterval
globalThis.setInterval = (fn, ms, ...rest) => (ms === 10_000 ? 0 : realSetInterval(fn, ms, ...rest))
globalThis.document = { visibilityState: 'hidden' }
test.after(() => { globalThis.setInterval = realSetInterval; delete globalThis.document })

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const COALESCE = 560
const Probe = ({ api, sessionId }) => ({ type: 'probe', props: { state: M.useRootState(api, sessionId, undefined) } })

/** A fake LayerfsApi: `session.state` reads recorded, events emitted by name. */
function harness() {
  const listeners = new Map()
  const reads = []
  return {
    reads,
    api: {
      op: async (name, args) => { reads.push({ name, sessionId: args.sessionId }); return { sessionId: args.sessionId, binding: null, project: 'p', status: null } },
      onEvent: (name, fn) => {
        const set = listeners.get(name) ?? new Set()
        set.add(fn)
        listeners.set(name, set)
        return () => { set.delete(fn) }
      },
    },
    emit: (name, data) => { for (const fn of listeners.get(name) ?? []) fn({ data }) },
  }
}

test('an operation burst moves the session tick only; a checkpoint or reconnect moves contentTick too', async () => {
  const { api, reads, emit } = harness()
  const view = M.mount(Probe, { api, sessionId: 'session-1' })
  await view.settle()
  let state = view.tree.props.state
  assert.equal(state.root, 'session-1')
  assert.equal(state.tick, 0)
  assert.equal(state.contentTick, 0)
  assert.equal(reads.length, 1, 'the mount read session.state once')

  // An agent run: many operation events, one coalesced refresh.
  for (let i = 0; i < 5; i++) emit('layerfs-operation', { sessionId: 'session-1' })
  await wait(COALESCE)
  await view.settle()
  state = view.tree.props.state
  assert.equal(state.tick, 1, 'the session/unsaved line follows operations')
  assert.equal(state.contentTick, 0, 'operations alone never reread the tree, history or storage')
  assert.equal(reads.length, 2)

  // A checkpoint: both counters move, once for the burst.
  emit('layerfs-checkpoint', { sessionId: 'session-1' })
  emit('layerfs-checkpoint', { sessionId: 'session-1' })
  await wait(COALESCE)
  await view.settle()
  state = view.tree.props.state
  assert.equal(state.tick, 2, 'the session read still follows a checkpoint')
  assert.equal(state.contentTick, 1, 'a checkpoint rereads the content views, coalesced')
  assert.equal(reads.length, 3)

  // A reconnect may have missed checkpoints: reread content as well.
  emit('connection', undefined)
  await wait(COALESCE)
  await view.settle()
  state = view.tree.props.state
  assert.equal(state.tick, 3)
  assert.equal(state.contentTick, 2, 'a reconnect bumps contentTick')
  assert.equal(reads.length, 4)

  // Other sessions' events are not this root's.
  emit('layerfs-checkpoint', { sessionId: 'session-2' })
  emit('layerfs-operation', { sessionId: 'session-2' })
  await wait(COALESCE)
  await view.settle()
  state = view.tree.props.state
  assert.equal(state.tick, 3)
  assert.equal(state.contentTick, 2, 'another session\'s checkpoint is not this root\'s content')
  assert.equal(reads.length, 4)

  // layerfs-session still moves the session line, never the content.
  emit('layerfs-session', { sessionId: 'session-1' })
  await wait(COALESCE)
  await view.settle()
  state = view.tree.props.state
  assert.equal(state.tick, 4)
  assert.equal(state.contentTick, 2)
  assert.equal(reads.length, 5)
})
