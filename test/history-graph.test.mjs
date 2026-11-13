// The history graph's model (src/client/files/graph-model.ts): pin and group
// rules, per-branch lane assignment and the per-branch-step tree layout, including a
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
  for (const n of layout.positioned) for (const id of [n.parent, n.second]) {
    const p = id && layout.points.get(id)
    if (p && p !== n) assert.ok(p.x < n.x, `${n.id} grows right of ${p.id}`)
  }
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

test('layoutNodes: the tree grows long, not tall: rollouts in sequence reuse lanes', () => {
  // Eight rollouts of twelve checkpoints from l2, one after another; r0 has a nested rollout.
  const min = 60000
  const names = Array.from({ length: 8 }, (_, i) => `r${i}`)
  const ks = Array.from({ length: 12 }, (_, i) => 12 - i)
  const branches = [branch('main', 'l2'), ...names.map((n) => branch(n, `${n}c12`, 'l2')), branch('r0-sub', 's1', 'r0c1')]
  const pages = { main: page([commit('l2', 'main', 'l1', { at: 1 }), commit('l1', 'main', null, { at: 0 })]), 'r0-sub': page([commit('s1', 'r0-sub', 'r0c1', { at: 1500 })]) }
  names.forEach((n, i) => { pages[n] = page(ks.map((k) => commit(`${n}c${k}`, n, k === 1 ? 'l2' : `${n}c${k - 1}`, { at: i * 2 * min + k * 1000 }))) })
  const nodes = graphNodes(branches, pages, noSources, new Set(), null, t)
  const layout = layoutNodes(nodes, new Map())
  const lane = (name) => layout.lanes.get(name)
  assert.equal(layout.points.get('l2').y, layout.center, 'main rides the middle line')
  assert.ok(Math.max(...[...layout.lanes.values()].map(Math.abs)) <= 3, 'nine branches fit in a few lanes')
  for (let i = 1; i < 8; i++) assert.ok(layout.points.get(`r${i}c1`).x > layout.points.get(`r${i - 1}c1`).x, 'later rollouts sit further right')
  assert.equal(Math.sign(lane('r0-sub')), Math.sign(lane('r0')), 'a nested rollout stays on its parent\'s side')
  assert.ok(Math.abs(lane('r0-sub')) > Math.abs(lane('r0')), 'and grows outward from it')
  for (const [name, fork] of layout.forks) {
    const first = layout.positioned.filter((n) => n.branch === name).sort((a, b) => a.x - b.x)[0]
    assert.ok(fork.base <= fork.leave && fork.leave < fork.knot && fork.knot <= first.x, `${name}: fork point, leave, knot, first commit in order`)
  }
  // No sprout crosses another branch: lanes between a branch and its parent are free where it bends.
  const extent = (name) => {
    const ns = layout.positioned.filter((n) => n.branch === name).sort((a, b) => a.x - b.x)
    return { from: layout.forks.get(name).leave, to: ns.at(-1).x }
  }
  for (const [name, l] of layout.lanes) {
    if (name === 'main') continue
    const fork = layout.forks.get(name)
    const first = layout.positioned.filter((n) => n.branch === name).sort((a, b) => a.x - b.x)[0]
    const from = lane(layout.points.get(first.parent).branch)
    for (const [other, ol] of layout.lanes) {
      if (other === name || other === 'main' || !(Math.min(from, l) < ol && ol < Math.max(from, l))) continue
      const e = extent(other)
      if (e.from === fork.leave) continue // siblings fan out of one point
      assert.ok(e.to < fork.leave || e.from > fork.leave + fork.bend, `${name}'s sprout crosses ${other}`)
    }
  }
})

test('layoutNodes: x is commit order, not the clock', () => {
  const hour = 3600000
  const branches = [branch('main', 'l1'), branch('w', 'w3', 'l1')]
  const pages = { main: page([commit('l1', 'main', null, { at: 0 })]), w: page([commit('w3', 'w', 'w2', { at: 9 * hour }), commit('w2', 'w', 'w1', { at: 5 * hour }), commit('w1', 'w', 'l1', { at: 1 })]) }
  const layout = layoutNodes(graphNodes(branches, pages, noSources, new Set(['group:w:w1']), null, t), new Map())
  const x = (id) => layout.points.get(id).x
  assert.equal(x('w3') - x('w2'), x('w2') - x('w1'), 'a four-hour gap and a five-hour gap take one step each')
  assert.ok(x('w3') - x('w2') < 30)
})

test('layoutNodes: a collapsed run keeps the length of its commits', () => {
  const items = []
  for (let i = 12; i >= 1; i--) items.push(commit(`c${i}`, 'w', i === 1 ? 'l1' : `c${i - 1}`, { at: i * 1000 }))
  const branches = [branch('main', 'l1'), branch('w', 'c12', 'l1')]
  const pages = { main: page([commit('l1', 'main', null, { at: 0 })]), w: page(items) }
  const layout = layoutNodes(graphNodes(branches, pages, noSources, new Set(), null, t), new Map())
  const group = layout.positioned.find((n) => n.kind === 'group')
  assert.equal(group.commits.length, 11)
  assert.ok(layout.points.get('c12').x - group.x > 5 * 14, 'the head sits past the whole run, not one step past a dot')
})

test('layoutNodes: rollouts saved at the same moments take separate lanes', () => {
  const branches = [branch('main', 'l1'), ...['a', 'b', 'c'].map((n) => branch(n, `${n}2`, 'l1'))]
  const pages = { main: page([commit('l1', 'main', null, { at: 0 })]) }
  for (const n of ['a', 'b', 'c']) pages[n] = page([commit(`${n}2`, n, `${n}1`, { at: 20000 }), commit(`${n}1`, n, 'l1', { at: 10000 })])
  const layout = layoutNodes(graphNodes(branches, pages, noSources, new Set(), null, t), new Map())
  assert.equal(new Set(['a', 'b', 'c'].map((n) => layout.lanes.get(n))).size, 3)
  assert.equal(new Set(['a', 'b', 'c'].map((n) => layout.points.get(`${n}2`).x)).size, 1, 'same moment, same step')
})

test('graphNodes: main folds a quiet run of layers but keeps fork points', () => {
  const ids = Array.from({ length: 8 }, (_, i) => `l${i + 1}`)
  const branches = [branch('main', 'l8'), branch('work', 'w1', 'l6')]
  const pages = { main: page(ids.map((id, i) => commit(id, 'main', i ? ids[i - 1] : null)).reverse()), work: page([commit('w1', 'work', 'l6')]) }
  const nodes = graphNodes(branches, pages, noSources, new Set(), null, t)
  const group = nodes.find((n) => n.branch === 'main' && n.kind === 'group')
  assert.deepEqual(group.commits.map((c) => c.id), ['l1', 'l2', 'l3', 'l4', 'l5'])
  assert.equal(group.label, 'files_layerCount:5')
  assert.ok(nodes.some((n) => n.id === 'l6' && n.kind === 'layer'), 'the fork point stays a layer')
  const open = graphNodes(branches, pages, noSources, new Set([group.id]), null, t)
  assert.equal(open.filter((n) => n.branch === 'main').length, 8, 'expanding the group shows every layer')
})

test('layoutNodes: fork points older than main\'s page line up before it instead of stacking', () => {
  const branches = [branch('main', 'l9'), branch('a', 'a1', '32old1'), branch('b', 'b1', '32old2')]
  const pages = {
    main: page([commit('l9', 'main', 'l8', { at: 900 }), commit('l8', 'main', null, { at: 800 })]),
    a: page([commit('a1', 'a', '32old1', { at: 300 })]),
    b: page([commit('b1', 'b', '32old2', { at: 200 })]),
  }
  const nodes = graphNodes(branches, pages, noSources, new Set(), null, t)
  const layout = layoutNodes(nodes, new Map())
  const x = (id) => layout.points.get(id).x
  assert.ok(x('32old2') < x('32old1'), 'ordered by when their forks first ran')
  assert.ok(x('32old1') < x('l8'), 'both before main\'s oldest loaded layer')
  assert.ok(x('l8') < x('l9'))
})

test('layoutNodes: a run whose earlier checkpoints are unread still grows from its fork point', () => {
  const branches = [branch('main', 'l2'), branch('deep', 'c9', 'l1')]
  // Only the newest page is read: c7's parent c6 is on a later page.
  const pages = { main: page([commit('l2', 'main', 'l1'), commit('l1', 'main', null)]), deep: page([commit('c9', 'deep', 'c8'), commit('c8', 'deep', 'c7'), commit('c7', 'deep', 'c6')], 'next') }
  const nodes = graphNodes(branches, pages, noSources, new Set(), null, t)
  const first = nodes.find((n) => n.branch === 'deep' && n.parent === 'c6')
  assert.equal(first.anchor, 'l1', 'the run hangs from the branch\'s fork point')
  const layout = layoutNodes(nodes, new Map())
  assert.ok(layout.points.get(first.id).x > layout.points.get('l1').x, 'and sits right of it')
  assert.notEqual(layout.lanes.get('deep'), 0)
})

test('layoutNodes: a branch is as long as its own commits, running ones share columns, later ones follow', () => {
  // a and b run at the same time, interleaved; c starts after both finish.
  const branches = [branch('main', 'l1'), branch('a', 'a6', 'l1'), branch('b', 'b6', 'l1'), branch('c', 'c3', 'l1')]
  const pages = { main: page([commit('l1', 'main', null, { at: 0 })]) }
  for (const [n, off] of [['a', 0], ['b', 1]]) pages[n] = page(Array.from({ length: 6 }, (_, i) => commit(`${n}${6 - i}`, n, 5 - i === 0 ? 'l1' : `${n}${5 - i}`, { at: 1000 + (5 - i) * 2 + off })))
  pages.c = page([commit('c3', 'c', 'c2', { at: 2000 }), commit('c2', 'c', 'c1', { at: 1999 }), commit('c1', 'c', 'l1', { at: 1998 })])
  const all = new Set(['group:a:a1', 'group:b:b1', 'group:c:c1'])
  const nodes = graphNodes(branches, pages, noSources, all, null, t)
  const s = layoutNodes(nodes, new Map())
  const len = (n) => s.points.get(`${n}6`).x - s.points.get(`${n}1`).x
  assert.equal(len('a'), 5 * 14, 'six commits, five steps: b\'s interleaved commits do not stretch a')
  assert.equal(len('b'), 5 * 14)
  assert.ok(Math.abs(s.points.get('a1').x - s.points.get('b1').x) <= 14, 'a and b run side by side')
  assert.ok(s.points.get('c1').x > Math.max(s.points.get('a6').x, s.points.get('b6').x), 'c starts past everything saved before it')
})
