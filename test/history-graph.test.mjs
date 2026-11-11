// The history graph's model (src/client/files/graph-model.ts): pin and group
// rules, per-branch lane assignment and the event-order layout, including a
// deep history that must not overflow the call stack.
//   node --test test/history-graph.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = new URL('..', import.meta.url).pathname
const out = mkdtempSync(join(tmpdir(), 'dsh-history-graph-'))
await build({
  absWorkingDir: root, entryPoints: { graph: 'src/client/files/graph-model.ts' }, outdir: out,
  bundle: true, format: 'esm', platform: 'node', target: 'node24', logLevel: 'warning', outExtension: { '.js': '.mjs' },
})
const { graphNodes, branchLanes, layoutNodes } = await import(pathToFileURL(join(out, 'graph.mjs')).href)
process.on('exit', () => rmSync(out, { recursive: true, force: true }))

const t = (key, params = {}) => (params.count !== undefined ? `${key}:${params.count}` : key)
const noSources = new Map()
const branch = (name, head, forkedFrom = null, base = 'main') => ({ name, head, base, forkedFrom })
const commit = (id, branchName, parent, extra = {}) => ({ id, branch: branchName, message: `m-${id}`, at: Number(id.replace(/\D/g, '')) || 0, parent, ...extra })
const page = (items, next = null, head = null) => ({ items, next, head })
const byId = (nodes) => new Map(nodes.map((n) => [n.id, n]))

test('graphNodes: main layers and a collapsed linear run', () => {
  const branches = [branch('main', 'l3'), branch('work', 'c6', 'l2')]
  const pages = {
    main: page([commit('l3', 'main', 'l2'), commit('l2', 'main', 'l1'), commit('l1', 'main', null)], null, 'l3'),
    // Newest first on the wire; c6 (the head) stays pinned, c5…c2 collapse.
    work: page([commit('c6', 'work', 'c5'), commit('c5', 'work', 'c4'), commit('c4', 'work', 'c3'), commit('c3', 'work', 'c2'), commit('c2', 'work', 'l2')], null, 'c6'),
  }
  const nodes = graphNodes(branches, pages, noSources, new Set(), null, t)
  const map = byId(nodes)
  assert.equal(nodes.filter((n) => n.branch === 'main').length, 3)
  assert.equal(nodes.every((n) => n.branch !== 'main' || n.kind === 'layer'), true)
  const group = nodes.find((n) => n.kind === 'group')
  assert.ok(group, 'a collapsed group exists for the linear run')
  assert.deepEqual(group.commits.map((c) => c.id), ['c2', 'c3', 'c4', 'c5'])
  assert.equal(group.parent, 'l2')
  assert.equal(map.get('c6').kind, 'checkpoint', 'the branch head stays a node')
  assert.equal(map.get('c6').parent, 'c5')
})

test('graphNodes: merge endpoints stay addressable and expand groups', () => {
  const branches = [branch('main', 'l2'), branch('work', 'c6', 'l1')]
  const pages = {
    main: page([commit('l2', 'main', 'l1'), commit('l1', 'main', null)], null, 'l2'),
    // c5 merges x9; the merge also pins its own parent c4, so c1…c3 collapse.
    work: page([commit('c6', 'work', 'c5'), commit('c5', 'work', 'c4', { merged: 'x9' }), commit('c4', 'work', 'c3'), commit('c3', 'work', 'c2'), commit('c2', 'work', 'c1'), commit('c1', 'work', 'l1')], null, 'c6'),
  }
  const nodes = graphNodes(branches, pages, noSources, new Set(), null, t)
  const map = byId(nodes)
  assert.equal(map.get('c5').second, 'x9', 'the merge commit keeps its second parent')
  assert.equal(map.get('c5').kind, 'checkpoint')
  const groupId = 'group:work:c1'
  assert.ok(nodes.some((n) => n.id === groupId && n.commits.length === 3), 'c1…c3 collapse behind the merge')
  assert.equal(map.get('c4').kind, 'checkpoint', 'the merge\'s parent stays a node')
  const expanded = graphNodes(branches, pages, noSources, new Set([groupId]), null, t)
  for (const id of ['c1', 'c2', 'c3']) assert.ok(byId(expanded).has(id), `an expanded group shows ${id}`)
})

test('graphNodes: the selected commit is pinned out of its group', () => {
  const branches = [branch('main', 'l1'), branch('work', 'c4', 'l1')]
  const pages = {
    main: page([commit('l1', 'main', null)], null, 'l1'),
    work: page([commit('c4', 'work', 'c3'), commit('c3', 'work', 'c2'), commit('c2', 'work', 'c1'), commit('c1', 'work', 'l1')], null, 'c4'),
  }
  const nodes = graphNodes(branches, pages, noSources, new Set(), 'c2', t)
  const map = byId(nodes)
  assert.equal(map.get('c2').kind, 'checkpoint', 'the selection survives as its own node')
  assert.equal(nodes.some((n) => n.kind === 'group'), false, 'a run broken by two pins leaves no group')
  for (const id of ['c1', 'c3', 'c4']) assert.ok(map.has(id), `${id} stays a node around the pins`)
})

test('graphNodes: an empty branch still shows its fork head placeholder', () => {
  const branches = [branch('main', 'l1'), branch('fresh', null, 'l1')]
  const pages = { main: page([commit('l1', 'main', null)], null, 'l1') }
  const nodes = graphNodes(branches, pages, noSources, new Set(), null, t)
  const placeholder = nodes.find((n) => n.id === 'branch:fresh')
  assert.ok(placeholder && placeholder.kind === 'fork' && placeholder.parent === 'l1')
})

test('branchLanes: main is centered, descendants stay on their parent\'s side', () => {
  const saved = new Map()
  const branches = [branch('main', 'l3'), branch('a', 'a2', 'l2'), branch('b', 'b2', 'l1'), branch('a-nested', 'n1', 'a1')]
  const pages = {
    main: page([commit('l3', 'main', 'l2'), commit('l2', 'main', 'l1'), commit('l1', 'main', null)]),
    a: page([commit('a2', 'a', 'a1'), commit('a1', 'a', 'l2')]),
    b: page([commit('b2', 'b', 'b1'), commit('b1', 'b', 'l1')]),
    'a-nested': page([commit('n1', 'a-nested', 'a1')]),
  }
  const { lanes, parents } = branchLanes(branches, pages, saved)
  assert.equal(lanes.get('main'), 0)
  assert.notEqual(Math.sign(lanes.get('a')), Math.sign(lanes.get('b')), 'the two main children balance across sides')
  assert.equal(Math.sign(lanes.get('a-nested')), Math.sign(lanes.get('a')), 'a grandchild keeps its parent\'s side')
  assert.equal(parents.get('a-nested'), 'a')
  assert.equal(parents.get('a'), 'main')
  assert.equal(saved.get('a'), lanes.get('a'), 'lanes are written back for stability')
  const again = branchLanes(branches, pages, saved)
  assert.equal(again.lanes.get('a'), lanes.get('a'), 'a second pass keeps the same lane')
})

test('layoutNodes: parents precede children and every member commit resolves', () => {
  const branches = [branch('main', 'l2'), branch('work', 'c3', 'l1')]
  const pages = {
    main: page([commit('l2', 'main', 'l1'), commit('l1', 'main', null)]),
    work: page([commit('c3', 'work', 'c2'), commit('c2', 'work', 'c1'), commit('c1', 'work', 'l1')]),
  }
  const saved = new Map()
  const { lanes } = branchLanes(branches, pages, saved)
  const nodes = graphNodes(branches, pages, noSources, new Set(), null, t)
  const layout = layoutNodes(nodes, lanes)
  const order = new Map(layout.positioned.map((n, i) => [n.id, i]))
  for (const n of layout.positioned) {
    if (n.parent && layout.points.has(n.parent)) assert.ok(order.get(layout.points.get(n.parent).id) <= order.get(n.id), `${n.id} after parent ${n.parent}`)
    if (n.second && layout.points.has(n.second)) assert.ok(order.get(layout.points.get(n.second).id) <= order.get(n.id))
  }
  const xs = layout.positioned.map((n) => n.x)
  assert.deepEqual([...xs].sort((a, b) => a - b), xs, 'x strictly follows event order')
  const group = layout.positioned.find((n) => n.kind === 'group')
  if (group) for (const c of group.commits) assert.equal(layout.points.get(c.id).id, group.id, 'group members resolve to the group')
  assert.equal(layout.positioned.find((n) => n.branch === 'main').y, layout.center, 'main rides the vertical center')
  assert.ok(layout.positioned.find((n) => n.branch === 'work').y !== layout.center)
})

test('graphNodes + layoutNodes: a deep history does not overflow the stack', () => {
  const count = 20000
  const items = []
  for (let i = count; i >= 1; i--) items.push(commit(`c${i}`, 'work', i === 1 ? 'l1' : `c${i - 1}`))
  const branches = [branch('main', 'l1'), branch('work', `c${count}`, 'l1')]
  const pages = { main: page([commit('l1', 'main', null)]), work: page(items) }
  const saved = new Map()
  const { lanes } = branchLanes(branches, pages, saved)
  const nodes = graphNodes(branches, pages, noSources, new Set(), null, t)
  assert.ok(nodes.length > 150 && nodes.length < count, 'the run collapses into bounded groups')
  const layout = layoutNodes(nodes, lanes)
  assert.equal(layout.positioned.length, nodes.length)
})
