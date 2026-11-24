// DSH's tab row renders every `conversation.view` entry of an id, shadowed ones
// included. When the stock Trajectory's `Entry.update({disabled:true})` rejects,
// the plugin must take its own shadowed Trajectory entry back: otherwise there
// are two Trajectory tabs. The other four tabs stay.
//   node --test test/views-suspend-guard.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { miniReact } from './mini-react.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-views-suspend-guard-'))
await build({
  absWorkingDir: root,
  stdin: {
    contents: [
      "export { registerViews, TRAJECTORY_VIEW, FILES_VIEW, HISTORY_VIEW, SANDBOX_VIEW, STATS_VIEW } from './src/client/views/index.tsx'",
      "export { stockTrajectory } from './src/client/views/stock-trajectory.ts'",
    ].join('\n'),
    resolveDir: root, loader: 'tsx',
  },
  outfile: join(out, 'suspend-guard.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24', logLevel: 'error',
  jsx: 'automatic', loader: { '.module.css': 'local-css', '.css': 'css' }, plugins: [miniReact],
})
const M = await import(pathToFileURL(join(out, 'suspend-guard.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

const STOCK = '@deepseek-ai/dsh-client-ui-trajectory'
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A ctx whose slot registrations are recorded (with their disposers) and never installed. */
function fakeCtx(entries) {
  const registrations = []
  const warnings = []
  const ctx = {
    effect: (fn) => fn() ?? (() => {}),
    get: (name) => (name === 'loader' ? { entries: () => entries } : undefined),
    logger: { warn: (...args) => warnings.push(args) },
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
  return { ctx, registrations, warnings }
}

/** `registerViews` in LayerFS mode; the presence header reports one session and the mode settles. */
async function viewsOf(entries) {
  const harness = fakeCtx(entries)
  M.registerViews(harness.ctx, { op: async () => ({ place: { project: 'proj' } }), onEvent: () => () => {} })
  const header = harness.registrations.find((r) => r.options.name === 'conversation.session.header.actions')
  header.options.inject('session-1').report('session-1')
  await wait(300)
  return harness
}
const viewRegs = (registrations) => registrations.filter((r) => r.options.name === 'conversation.view')

test('a failed suspension takes back only the plugin\'s Trajectory entry; the four tabs stay', async () => {
  const entry = { options: { name: STOCK }, disabled: false, update: async () => { throw new Error('loader refused') } }
  const { registrations, warnings } = await viewsOf([entry])
  const all = viewRegs(registrations)
  assert.equal(all.length, 5, 'all five views register before the stock one is suspended')
  const own = all.filter((r) => r.options.id === M.TRAJECTORY_VIEW)
  assert.equal(own.length, 1)
  assert.equal(own[0].disposed, 1, 'the shadowed Trajectory is taken back')
  const kept = all.filter((r) => r.disposed === 0)
  assert.equal(kept.length, 4)
  assert.deepEqual(kept.map((r) => r.options.id).sort(), [M.FILES_VIEW, M.HISTORY_VIEW, M.SANDBOX_VIEW, M.STATS_VIEW].sort())
  assert.equal(warnings.length, 1, 'the refusal is logged, not silent')
  assert.match(String(warnings[0][0]), /stock Trajectory not suspended/)
})

test('no stock entry: five views, nothing suspended or taken back', async () => {
  const { registrations, warnings } = await viewsOf([])
  const all = viewRegs(registrations)
  assert.equal(all.length, 5)
  assert.deepEqual(all.map((r) => r.disposed), [0, 0, 0, 0, 0])
  assert.equal(warnings.length, 0)
})

test('suspend answers true when there is nothing to suspend, and lets a failed update reject', async () => {
  assert.equal(await M.stockTrajectory(fakeCtx([]).ctx).suspend(), true, 'no entry: the stock tab is not rendering')
  const disabled = { options: { name: STOCK }, disabled: true, update: async () => { throw new Error('must not be called') } }
  assert.equal(await M.stockTrajectory(fakeCtx([disabled]).ctx).suspend(), true, 'already disabled: not ours to toggle')
  const failing = { options: { name: STOCK }, disabled: false, update: async () => { throw new Error('refused') } }
  await assert.rejects(() => M.stockTrajectory(fakeCtx([failing]).ctx).suspend(), /refused/)
})
