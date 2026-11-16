// The machine page's tabs (src/client/machines/machine-tabs.ts): which tabs a
// page has, the Sandboxes tab's cards (record + sampler values + disk, by
// filter and order) and what the Overview flags.
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

test('tabs: Overview, Sandboxes and Stores always; Images, Usage, Disk, Files and Worker log by what the machine and CLI have', () => {
  assert.deepEqual(T.machineTabs({ images: false, usage: false, disk: false, files: false, log: false }), ['overview', 'sandboxes', 'stores'])
  assert.deepEqual(T.machineTabs({ images: true, usage: true, disk: true, files: true, log: true }), ['overview', 'sandboxes', 'stores', 'images', 'usage', 'disk', 'files', 'log'])
  assert.deepEqual(T.machineTabs({ images: false, usage: false, disk: true, files: true, log: false }), ['overview', 'sandboxes', 'stores', 'disk', 'files'])
  assert.deepEqual(T.machineTabs({ images: true, usage: false, disk: false, files: false, log: false }), ['overview', 'sandboxes', 'stores', 'images'])
})

test('Sandbox cards: those that need you first, joined with sampler values and disk by name; counts per filter', () => {
  const records = [sb('a', 'running'), sb('b', 'gone'), sb('c', 'running'), sb('d', 'stopped')]
  const metrics = [{ name: 'a', closedAt: null, memory: 10 }, { name: 'z', closedAt: 1794824100000 }, { name: 'y', closedAt: 1794824200000 }, { name: 'c', closedAt: null, memory: 30 }]
  const space = [{ name: 'b', bytes: 261 * 2 ** 20 }, { name: 'a', bytes: 26 * 2 ** 20 }, { name: 'd', bytes: 90 * 2 ** 20 }]
  const all = T.sandboxCards(records, metrics, space, needsYou, 'all', 'listed')
  assert.deepEqual(all.cards.map((c) => c.name), ['b', 'a', 'c', 'd'], 'gone first, then as listed')
  assert.deepEqual(all.counts, { all: 4, running: 2, attention: 1, closed: 2 })
  assert.equal(all.cards[1].metrics.memory, 10)
  assert.equal(all.cards[0].space.bytes, 261 * 2 ** 20)
  assert.equal(all.cards[2].space, null, 'no disk row: null, never 0')
  assert.ok(all.cards.every((c) => c.record), 'All holds only recorded Sandboxes')
  assert.deepEqual(T.sandboxCards(records, metrics, space, needsYou, 'running', 'listed').cards.map((c) => c.name), ['a', 'c'])
  assert.deepEqual(T.sandboxCards(records, metrics, space, needsYou, 'attention', 'listed').cards.map((c) => c.name), ['b'])
  const closed = T.sandboxCards(records, metrics, space, needsYou, 'closed', 'name').cards
  assert.deepEqual(closed.map((c) => [c.name, c.record]), [['y', null], ['z', null]], 'closed: the most recently closed first')
  // without the calls: cards from the records alone
  assert.deepEqual(T.sandboxCards(records, [], null, needsYou, 'all', 'listed').cards.map((c) => [c.name, c.metrics, c.space]), [['b', null, null], ['a', null, null], ['c', null, null], ['d', null, null]])
})

test('Sandbox cards: orders keep those that need you first; an unknown size sorts last', () => {
  const records = [sb('c', 'running'), sb('a', 'running'), sb('g', 'gone'), sb('b', 'running')]
  const metrics = [{ name: 'a', closedAt: null, memory: 5 }, { name: 'b', closedAt: null, memory: null }, { name: 'c', closedAt: null, memory: 50 }]
  const space = [{ name: 'a', bytes: 300 }, { name: 'b', bytes: null, reason: 'deadline' }, { name: 'c', bytes: 100 }]
  const order = (sort) => T.sandboxCards(records, metrics, space, needsYou, 'all', sort).cards.map((c) => c.name)
  assert.deepEqual(order('listed'), ['g', 'c', 'a', 'b'])
  assert.deepEqual(order('name'), ['g', 'a', 'b', 'c'])
  assert.deepEqual(order('disk'), ['g', 'a', 'c', 'b'])
  assert.deepEqual(order('memory'), ['g', 'c', 'a', 'b'])
})

test('Overview: gone Sandboxes and what LayerFS measured for them; other Sandboxes that need you', () => {
  const records = [sb('a', 'running'), sb('b', 'gone'), sb('c', 'gone'), sb('d', 'failed')]
  assert.deepEqual(T.sandboxAttention(records, [{ name: 'b', bytes: 100 }, { name: 'c', bytes: null, reason: 'deadline' }], needsYou), { gone: 2, goneBytes: 100, needsYou: 1 })
  assert.deepEqual(T.sandboxAttention(records, null, needsYou), { gone: 2, goneBytes: null, needsYou: 1 }, 'without machine.space: counted, no size')
  assert.deepEqual(T.sandboxAttention([sb('a', 'running')], [], needsYou), { gone: 0, goneBytes: null, needsYou: 0 })
})

test('the Overview sparkline breaks at a gap, scales to the max and leaves out what is before the hour', () => {
  const paths = T.sparkPaths([{ t: 0, v: 9 }, { t: 100, v: 0 }, { t: 200, v: 50 }, { t: 300, v: null }, { t: 400, v: 100 }, { t: 500, v: 200 }], 100, 500, 100, 200, 42)
  assert.equal(paths.length, 2)
  assert.equal(paths[0].line, 'M0.0 41.0 L50.0 21.0')
  assert.equal(paths[0].area, 'M0.0 41.0 L50.0 21.0 L50.0 42 L0.0 42 Z')
  // above the max is drawn at the top, never past it
  assert.equal(paths[1].line, 'M150.0 1.0 L200.0 1.0')
  assert.deepEqual(T.sparkPaths([{ t: 10, v: 1 }], 0, 10, 1, 100, 10), [{ line: 'M100.0 1.0 h0.1', area: null }])
  assert.deepEqual(T.sparkPaths([{ t: 10, v: null }], 0, 10, 1, 100, 10), [])
  // two samples a minute apart in an hour: a line, no area (it would draw as a bar)
  assert.deepEqual(T.sparkPaths([{ t: 3540, v: 1 }, { t: 3600, v: 1 }], 0, 3600, 1, 200, 42), [{ line: 'M196.7 1.0 L200.0 1.0', area: null }])
})

test('the Overview peak and Sandbox memory count read values only', () => {
  assert.equal(T.peakSince([{ t: 0, v: 0.9 }, { t: 10, v: 0.2 }, { t: 20, v: null }, { t: 30, v: 0.4 }], 5), 0.4)
  assert.equal(T.peakSince([{ t: 10, v: null }], 0), null)
  const row = (memoryCurrent, extra = {}) => ({ gap: null, row: { live: true, usage: { memoryCurrent } }, ...extra })
  assert.equal(T.sandboxMemory([row(10), row(5), row(null), row(7, { gap: 'Timeout' }), { gap: null, row: { live: false, usage: { memoryCurrent: 99 } } }]), 15)
  assert.equal(T.sandboxMemory([row(null)]), null)
  assert.equal(T.sandboxMemory([]), null)
})

test('the Overview processor figure shows small shares exactly and scales its chart to the peak', () => {
  assert.equal(T.cpuShare(0), '0')
  assert.equal(T.cpuShare(0.0004), '<0.1')
  assert.equal(T.cpuShare(0.004), '0.4')
  assert.equal(T.cpuShare(0.0961), '9.6')
  assert.equal(T.cpuShare(0.234), '23')
  assert.equal(T.cpuShare(1.2), '100')
  assert.equal(T.cpuScale(null), 0.01)
  assert.equal(T.cpuScale(0.004), 0.01)
  assert.equal(T.cpuScale(0.03), 0.05)
  assert.equal(T.cpuScale(0.5), 0.5)
  assert.equal(T.cpuScale(0.73), 1)
})
