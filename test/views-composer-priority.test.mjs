// The hidden composer of the LayerFS conversation views must not swallow DSH's
// approval and question takeovers: `conversation.composer` chains elect in
// ASCENDING priority (first non-null select wins), so the entry that renders
// nothing has to be registered above approval (1), user questions (0) and the
// subagent read-only composer (-10).
//   node --test test/views-composer-priority.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { miniReact } from './mini-react.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-views-composer-priority-'))
await build({
  absWorkingDir: root,
  stdin: {
    contents: [
      "export { registerViews, FILES_VIEW } from './src/client/views/index.tsx'",
    ].join('\n'),
    resolveDir: root, loader: 'tsx',
  },
  outfile: join(out, 'composer.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24', logLevel: 'error',
  jsx: 'automatic', loader: { '.module.css': 'local-css', '.css': 'css' }, plugins: [miniReact],
})
const M = await import(pathToFileURL(join(out, 'composer.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A ctx whose slot registrations are recorded instead of installed. */
function fakeCtx() {
  const registrations = []
  return {
    registrations,
    ctx: {
      effect: (fn) => fn() ?? (() => {}),
      get: () => undefined,
      logger: { warn: () => {} },
      locale: { register: () => () => {}, bind: () => (key) => key },
      slots: {
        register(options, component) { registrations.push({ options, component }); return () => {} },
        inject(_name, fn) { return fn() },
      },
    },
  }
}

/** `registerViews` for one project session; returns the registered options by slot. */
async function viewsOf() {
  const { ctx, registrations } = fakeCtx()
  M.registerViews(ctx, { op: async () => ({ place: { project: 'proj' } }), onEvent: () => () => {} })
  // The presence header reports the conversation on screen; after the mode settles
  // `registerViews` registers its views and each view's `inject` hands out `hideComposer`.
  const header = registrations.find((r) => r.options.name === 'conversation.session.header.actions')
  header.options.inject('session-1').report('session-1')
  await wait(300)
  return { registrations, views: registrations.filter((r) => r.options.name === 'conversation.view') }
}

test('the hidden composer is above every takeover and still matches its own session only', async () => {
  const { registrations, views } = await viewsOf()
  assert.equal(views.length, 5, 'the LayerFS views registered for a project session')
  const files = views.find((r) => r.options.id === M.FILES_VIEW)
  assert.ok(files, 'the Files view is registered')
  const injected = files.options.inject('session-1')
  injected.hideComposer()
  const hidden = registrations.filter((r) => r.options.name === 'conversation.composer')
  assert.equal(hidden.length, 1, 'one hidden composer entry')
  const entry = hidden[0]
  assert.ok(entry.options.priority > 1, `above approval (1), user questions (0) and subagent (-10); got ${entry.options.priority}`)
  assert.equal(entry.options.priority, 100)
  assert.equal(entry.options.select({ sessionId: 'session-1' }), true)
  assert.equal(entry.options.select({ sessionId: 'session-2' }), null, 'another session is not this entry\'s')
  assert.equal(entry.options.select({}), null, 'an owner without a session is not this entry\'s')
  assert.equal(entry.component({ sessionId: 'session-1' }), null, 'it renders nothing')

  // The real chain election: DSH's own SlotCore sorts ascending and the first
  // non-null select wins. Register the three takeovers at DSH's priorities and
  // the recorded hidden entry, then elect for each owner.
  const core = new SlotCore()
  core.register({ name: 'root', children: { 'conversation.composer': { kind: 'chain', scope: 'session' } } }, () => null)
  const none = () => null
  core.register({ name: 'conversation.composer', priority: 1, select: ({ pendingInteraction }) => pendingInteraction?.kind === 'approval' ? pendingInteraction : null }, none)
  core.register({ name: 'conversation.composer', select: ({ pendingInteraction }) => pendingInteraction?.kind === 'question' ? pendingInteraction : null }, none)
  core.register({ name: 'conversation.composer', priority: -10, select: ({ readOnlyComposer }) => (readOnlyComposer ? readOnlyComposer : null) }, none)
  core.register(entry.options, entry.component)
  const elect = (owner) => {
    for (const registered of core.entriesOfSlot('conversation.composer')) {
      const matched = registered.select(owner)
      if (matched !== null) return { priority: registered.options.priority ?? 0, matched }
    }
    return null
  }
  const approval = { sessionId: 'session-1', pendingInteraction: { kind: 'approval' } }
  const question = { sessionId: 'session-1', pendingInteraction: { kind: 'question' } }
  const readOnly = { sessionId: 'session-1', readOnlyComposer: { readOnly: true } }
  assert.equal(elect(approval).priority, 1, 'an approval is shown while the Files tab is open')
  assert.equal(elect(question).priority, 0, 'a pending question is shown')
  assert.equal(elect(readOnly).priority, -10, 'a subagent\'s read-only composer is shown')
  assert.deepEqual(elect({ sessionId: 'session-1' }), { priority: 100, matched: true }, 'with nothing pending the hidden composer wins')
  assert.equal(elect({ sessionId: 'session-2' }), null, 'another session falls through to the stock composer')
})
