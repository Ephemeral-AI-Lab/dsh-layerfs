// The machine page's tabs (src/client/machines/machine-tabs.ts): which tabs a
// page has, the Sandboxes tab's rows (record + sampler values + disk, closed
// ones only on request) and what the Overview flags.
//   node --test test/machine-tabs.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = new URL('..', import.meta.url).pathname
const out = mkdtempSync(join(root, 'lib', '.test-machine-tabs-'))
await build({ absWorkingDir: root, stdin: { contents: "export * from './src/client/machines/machine-tabs.ts'", resolveDir: root, loader: 'ts' }, outfile: join(out, 'tabs.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24', logLevel: 'warning' })
const T = await import(pathToFileURL(join(out, 'tabs.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

const sb = (name, state, extra = {}) => ({ name, state, machine: 'docker', project: 'qv2-store/qv2-probe', workspaces: 0, ...extra })
const needsYou = (b) => b.state === 'failed' || b.state === 'gone'

test('tabs: Overview, Sandboxes and Stores always; Usage, Disk, Files and Worker log by what the CLI has', () => {
  assert.deepEqual(T.machineTabs({ usage: false, disk: false, files: false, log: false }), ['overview', 'sandboxes', 'stores'])
  assert.deepEqual(T.machineTabs({ usage: true, disk: true, files: true, log: true }), ['overview', 'sandboxes', 'stores', 'usage', 'disk', 'files', 'log'])
  assert.deepEqual(T.machineTabs({ usage: false, disk: true, files: true, log: false }), ['overview', 'sandboxes', 'stores', 'disk', 'files'])
})

test('Sandboxes tab rows: those that need you first, joined with sampler values and disk by name; closed ones only on request', () => {
  const records = [sb('a', 'running'), sb('b', 'gone'), sb('c', 'running')]
  const metrics = [{ name: 'a', closedAt: null, mem: 1 }, { name: 'z', closedAt: 1794824100000 }, { name: 'c', closedAt: null }]
  const space = [{ name: 'b', bytes: 261 * 2 ** 20 }, { name: 'a', bytes: 26 * 2 ** 20 }]
  const hidden = T.sandboxTabRows(records, metrics, space, needsYou, false)
  assert.deepEqual(hidden.rows.map((r) => r.name), ['b', 'a', 'c'], 'gone first')
  assert.equal(hidden.closed, 1)
  assert.equal(hidden.rows[1].metrics.mem, 1)
  assert.equal(hidden.rows[0].space.bytes, 261 * 2 ** 20)
  assert.equal(hidden.rows[2].space, null, 'no disk row: null, never 0')
  const shown = T.sandboxTabRows(records, metrics, space, needsYou, true)
  assert.deepEqual(shown.rows.map((r) => [r.name, r.record === null]), [['b', false], ['a', false], ['c', false], ['z', true]])
  // without the calls: rows from the records alone
  assert.deepEqual(T.sandboxTabRows(records, [], null, needsYou, true).rows.map((r) => [r.name, r.metrics, r.space]), [['b', null, null], ['a', null, null], ['c', null, null]])
})

test('Overview: gone Sandboxes and what LayerFS measured for them; other Sandboxes that need you', () => {
  const records = [sb('a', 'running'), sb('b', 'gone'), sb('c', 'gone'), sb('d', 'failed')]
  assert.deepEqual(T.sandboxAttention(records, [{ name: 'b', bytes: 100 }, { name: 'c', bytes: null, reason: 'deadline' }], needsYou), { gone: 2, goneBytes: 100, needsYou: 1 })
  assert.deepEqual(T.sandboxAttention(records, null, needsYou), { gone: 2, goneBytes: null, needsYou: 1 }, 'without machine.space: counted, no size')
  assert.deepEqual(T.sandboxAttention([sb('a', 'running')], [], needsYou), { gone: 0, goneBytes: null, needsYou: 0 })
})
