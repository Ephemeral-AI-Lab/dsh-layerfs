/**
 * The history graph's model: nodes for the canvas, one stable lane per live
 * Branch around a centered main, and a left-to-right tree layout in commit order.
 * Ported from LayerFS Connect's `components/history/model.ts`; its Trace
 * `Source` rows collapse here to a producer key per Commit (empty for now).
 */
import type { CommitInfo, HistoryBranch, HistoryPage, Translate } from './types.ts'

export type { HistoryBranch, HistoryPage }

export interface GraphNode {
  id: string
  branch: string
  label: string
  commits: CommitInfo[]
  parent: string | null
  second: string | null
  source?: string | null
  /** The fork point a run hangs from when its own parent is on a page not read yet. */
  anchor?: string | null
  kind: 'layer' | 'checkpoint' | 'group' | 'fork'
  at: number | null
}

/** Main folds a quiet run of at least this many Layers. */
const MAIN_FOLD = 4

/** A 0x32-tagged saved id names a Layer on main. */
const isLayerId = (id: string): boolean => id.startsWith('32')

/**
 * Collapse only linear runs; every fork/merge endpoint and head remains
 * addressable. `sources` maps a Commit to its producer's key (e.g. a session
 * id); runs break when the producer changes.
 */
export function graphNodes(branches: HistoryBranch[], pages: Record<string, HistoryPage | undefined>, sources: ReadonlyMap<string, string>, expanded: ReadonlySet<string>, selected: string | null, t: Translate): GraphNode[] {
  const pins = new Set<string>()
  for (const b of branches) for (const id of [b.head, b.forkedFrom]) if (id) pins.add(id)
  for (const page of Object.values(pages)) for (const c of page?.items ?? []) if (c.merged) {
    pins.add(c.id)
    if (c.parent) pins.add(c.parent)
    pins.add(c.merged)
  }
  if (selected) pins.add(selected)
  // A publish pins its Layer only while the source checkpoint is on the canvas to draw the edge from.
  const loaded = new Set<string>()
  for (const [name, page] of Object.entries(pages)) if (name !== 'main') for (const c of page?.items ?? []) loaded.add(c.id)
  const nodes: GraphNode[] = []
  const main = branches.find((b) => b.name === 'main')
  if (main?.head && !pages.main?.items.length) nodes.push({ id: main.head, branch: 'main', label: t('files_latestLayer'), commits: [], parent: null, source: null, second: null, kind: 'layer', at: null })
  // Main's quiet stretches (no fork, publish or head) fold like a branch's checkpoint runs, so the trunk stays short.
  // An undated Layer takes its publish source's time.
  const layer = (c: CommitInfo): GraphNode => ({ id: c.id, branch: 'main', label: c.message || t('files_layer'), commits: [c], parent: c.parent, second: null, source: c.sourceCommit, kind: 'layer', at: c.at ?? c.sourceTime ?? null })
  let layers: CommitInfo[] = []
  const flushLayers = () => {
    const id = layers.length ? `group:main:${layers[0].id}` : ''
    if (layers.length < MAIN_FOLD || expanded.has(id)) for (const c of layers) nodes.push(layer(c))
    else nodes.push({ id, branch: 'main', label: t('files_layerCount', { count: layers.length }), commits: layers, parent: layers[0].parent, second: null, kind: 'group', at: layers[0].at ?? layers[0].sourceTime ?? null })
    layers = []
  }
  for (const c of [...(pages.main?.items ?? [])].reverse()) {
    if (pins.has(c.id) || (c.sourceCommit && loaded.has(c.sourceCommit))) {
      flushLayers()
      nodes.push(layer(c))
      continue
    }
    if (layers.length && (c.parent !== layers.at(-1)!.id || layers.length >= 100)) flushLayers()
    layers.push(c)
  }
  flushLayers()
  // Fork points older than main's loaded page: before its oldest Layer, in the order their forks first ran.
  const layerIds = new Set([...(main?.head ? [main.head] : []), ...(pages.main?.items ?? []).map((c) => c.id)])
  const earlier = new Map<string, number>()
  for (const b of branches) if (b.forkedFrom && isLayerId(b.forkedFrom) && !layerIds.has(b.forkedFrom)) {
    const first = Math.min(...(pages[b.name]?.items ?? []).map((c) => c.at ?? Infinity))
    earlier.set(b.forkedFrom, Math.min(earlier.get(b.forkedFrom) ?? Infinity, first))
  }
  const oldest = Math.min(...(pages.main?.items ?? []).map((c) => c.at ?? c.sourceTime ?? Infinity))
  const bases = [...earlier.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
  bases.forEach(([id, first], i) => {
    // A second before its first fork ran, and before main's oldest loaded Layer.
    // With none of its forks read there is no time to go by: undated, it opens the trunk.
    const at = Number.isFinite(first) ? Math.min(first - 1000, Number.isFinite(oldest) ? oldest - (bases.length - i) : Infinity) : null
    nodes.push({ id, branch: 'main', label: t('files_earlierBaseLayer'), commits: [], parent: null, second: null, kind: 'layer', at })
  })
  for (const branch of branches.filter((b) => b.name !== 'main')) {
    const start = nodes.length
    const raw = [...(pages[branch.name]?.items ?? [])].reverse().map((c) => ({ ...c, parent: c.parent ?? branch.forkedFrom }))
    const own = new Map(raw.map((c) => [c.id, c]))
    const items = topological(raw, (c) => (c.parent && own.has(c.parent) ? [own.get(c.parent)!] : []))
    let run: CommitInfo[] = []
    const flush = () => {
      if (!run.length) return
      const id = `group:${branch.name}:${run[0].id}`
      if (run.length === 1 || expanded.has(id)) for (const c of run) nodes.push(node(c, t))
      else nodes.push({ id, branch: branch.name, label: t('files_checkpointCount', { count: run.length }), commits: run, parent: run[0].parent, second: null, kind: 'group', at: run[0].at })
      run = []
    }
    for (const c of items) {
      const previous = run.at(-1)
      if (pins.has(c.id) || c.merged) {
        flush()
        nodes.push(node(c, t))
        continue
      }
      if (previous && (c.parent !== previous.id || sources.get(c.id) !== sources.get(previous.id) || run.length >= 100)) flush()
      run.push(c)
    }
    flush()
    for (const n of nodes.slice(start)) if (n.parent && !own.has(n.parent) && n.parent !== branch.forkedFrom) n.anchor = branch.forkedFrom
    if (!items.length) nodes.push({ id: `branch:${branch.name}`, branch: branch.name, label: t('files_branchHead'), commits: [], parent: branch.forkedFrom, second: null, kind: 'fork', at: null })
  }
  return nodes
}

function node(c: CommitInfo, t: Translate): GraphNode {
  return { id: c.id, branch: c.branch, label: c.kind === 'merge' || c.merged ? t('files_merge') : c.message || t('files_checkpoint'), commits: [c], parent: c.parent, second: c.merged ?? null, kind: 'checkpoint', at: c.at }
}

/** Each live branch gets its own stable lane; descendants stay on their parent's side. */
export function branchLanes(branches: HistoryBranch[], pages: Record<string, HistoryPage | undefined>, saved: Map<string, number>): { lanes: Map<string, number>, parents: Map<string, string | null> } {
  const owners = new Map<string, string>()
  for (const [name, page] of Object.entries(pages)) for (const c of page?.items ?? []) owners.set(c.id, name)
  const main = branches.find((b) => b.name === 'main')
  const bases = new Set(branches.map((b) => b.base))
  const parents = new Map<string, string | null>()
  for (const b of branches) {
    const owner = b.forkedFrom ? owners.get(b.forkedFrom) : undefined
    parents.set(b.name, b.name === 'main' ? null : owner && owner !== b.name ? owner : b.forkedFrom && (bases.has(b.forkedFrom) || isLayerId(b.forkedFrom) || b.forkedFrom === main?.head) ? 'main' : null)
  }
  const lanes = new Map<string, number>([['main', 0]])
  const used = new Set<number>([0])
  // Ignore duplicate lane assignments left by the earlier layout.
  for (const b of branches) {
    const lane = saved.get(b.name)
    if (b.name !== 'main' && lane && !used.has(lane)) {
      lanes.set(b.name, lane)
      used.add(lane)
    }
  }
  const children = new Map<string, string[]>()
  for (const b of branches) if (b.name !== 'main') {
    const parent = parents.get(b.name) ?? 'main'
    children.set(parent, [...(children.get(parent) ?? []), b.name])
  }
  const weights = new Map<string, number>()
  const weight = (name: string, seen = new Set<string>()): number => {
    if (seen.has(name)) return 0
    if (weights.has(name)) return weights.get(name)!
    seen.add(name)
    const total = 1 + (children.get(name) ?? []).reduce((n, c) => n + weight(c, new Set(seen)), 0)
    weights.set(name, total)
    return total
  }
  const loads = [0, 0]
  const roots = [...(children.get('main') ?? [])].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b))
  for (const name of roots) if (lanes.has(name)) loads[lanes.get(name)! < 0 ? 0 : 1] += weight(name)
  const pending = [...roots]
  while (pending.length) {
    const name = pending.shift()!
    const parent = parents.get(name) ?? 'main'
    const parentLane = lanes.get(parent) ?? 0
    if (!lanes.has(name)) {
      const side = Math.sign(parentLane) || (loads[0] <= loads[1] ? -1 : 1)
      let lane = parentLane + side
      while (used.has(lane)) lane += side
      lanes.set(name, lane)
      used.add(lane)
      saved.set(name, lane)
      if (parent === 'main') loads[side < 0 ? 0 : 1] += weight(name)
    }
    pending.push(...(children.get(name) ?? []))
  }
  // A missing parent remains unresolved instead of inventing an ancestry edge.
  for (const b of branches) if (!lanes.has(b.name)) {
    let lane = 1
    while (used.has(lane)) lane++
    lanes.set(b.name, lane)
    used.add(lane)
    saved.set(b.name, lane)
  }
  return { lanes, parents }
}

/** One step per commit in order; the least room a fork's sprout gets; the distance between lanes. */
export const STEP = 14
const SPROUT = 40
/** A sprout leaves its parent at most this far (plus a step) before the branch's first commit; before that it runs along the parent. */
const BEND_ROOM = 96
export const GAP = 34
/** Clear space kept between two branches that share a lane. */
const PAD = 16
/** A bend runs about as far along the order as the lanes it crosses (near 45°): never a long diagonal, never a sheer drop. */
export const bendOf = (dy: number, span: number): number => Math.min(span, Math.max(18, Math.min(220, Math.abs(dy) * 1.1)))

/** A stretch of one lane a branch (or its sprout) occupies; its line ends at `l` (its name tag runs on to `b`). */
interface Cell { lane: number, a: number, b: number, l: number, branch?: string }
/** A branch along the order: forked at `start`, leaves its parent at `leave`, first node at `first`, line ends at `line`, label at `end`. */
interface Span { name: string, parent: string, start: number, leave: number, first: number, line: number, end: number }
/** A branch's sprout: its fork point (`base`), where it leaves the parent's lane, how far it bends, and the knot where the branch begins. */
export interface Fork { base: number, leave: number, bend: number, knot: number }

/**
 * The tree layout. x counts commits, not the wall clock: a commit sits one
 * step past its own parent, so a branch is as long as its own commits (a
 * collapsed run keeps their length) and branches running at the same time
 * share columns; a branch starts past every commit saved before its first
 * one, so branches that ran one after another sit end to end and a quiet
 * stretch takes no room. Main rides the vertical center. A branch sprouts
 * from its fork point and bends out about 45° into its own lane, then runs to
 * a knot just before its first commit; a branch that starts long after its
 * fork point runs along its parent first and leaves it shortly before its
 * work, so it holds a lane only while it is going. It takes the free lane nearest its parent, on its
 * parent's side, and the lane frees once it and its name tag are behind. A
 * subtree packs into a band beyond its parent, taking lanes in the order its
 * branches leave; a sprout crosses another branch only when no lane avoids
 * it. `sides` only breaks ties for main's children (a remembered side).
 */
export function layoutNodes(nodes: GraphNode[], sides: ReadonlyMap<string, number>, labelWidth: (branch: string) => number = (name) => name.length * 6.3 + 80) {
  const byCommit = new Map<string, GraphNode>()
  for (const n of nodes) {
    byCommit.set(n.id, n)
    for (const c of n.commits) byCommit.set(c.id, n)
  }
  const resolve = (id: string | null | undefined) => (id ? byCommit.get(id) : undefined)
  /** The node a run grows from: its parent, else the fork point it hangs from. */
  const origin = (n: GraphNode) => {
    const p = resolve(n.parent) ?? resolve(n.anchor)
    return p && p !== n ? p : undefined
  }
  const deps = (n: GraphNode) => [origin(n), resolve(n.second), resolve(n.source)].flatMap((p) => (p && p !== n ? [p] : []))
  const ordered = topological([...nodes].sort((a, b) => (a.at ?? 0) - (b.at ?? 0)), deps)
  // Time only says what was saved before a branch began (a slot per distinct commit time; a Layer's is its publish source's).
  const timesOf = (n: GraphNode) => (n.commits.length ? n.commits.flatMap((c) => { const at = c.at ?? c.sourceTime; return at == null ? [] : [at] }) : n.at == null ? [] : [n.at])
  const slots = [...new Set(nodes.flatMap(timesOf))].sort((a, b) => a - b)
  const rank = new Map(slots.map((at, i) => [at, i]))
  const xs = new Map<string, number>()
  const ends = new Map<string, number>()
  let trunkEnd = -Infinity
  // The furthest step of any commit saved before a time: a max Fenwick tree over time slots.
  const tree = new Float64Array(slots.length + 1).fill(-Infinity)
  const record = (slot: number, x: number) => { for (let i = slot + 1; i <= slots.length; i += i & -i) if (tree[i] < x) tree[i] = x }
  const before = (slot: number) => { let m = -Infinity; for (let i = slot; i > 0; i -= i & -i) if (tree[i] > m) m = tree[i]; return m }
  for (const n of ordered) {
    const ts = timesOf(n).sort((a, b) => a - b)
    const root = origin(n)
    const opens = n.branch !== 'main' && (!root || root.branch !== n.branch)
    let start = 60
    for (const p of deps(n)) start = Math.max(start, ends.get(p.id)! + (p === root && opens ? SPROUT : STEP))
    // A branch begins past everything saved before its first commit.
    if (opens && ts.length) start = Math.max(start, before(rank.get(ts[0])!) + STEP)
    if (n.branch === 'main') start = Math.max(start, trunkEnd + STEP)
    // A collapsed run takes a step per commit, its mark in the middle.
    const steps = Math.max(1, n.commits.length)
    const end = start + (steps - 1) * STEP
    xs.set(n.id, n.kind === 'group' ? (start + end) / 2 : start)
    ends.set(n.id, end)
    ts.forEach((at, i) => record(rank.get(at)!, start + Math.min(i, steps - 1) * STEP))
    if (n.branch === 'main') trunkEnd = end
  }
  const xOf = (n: GraphNode) => xs.get(n.id)!

  const members = new Map<string, GraphNode[]>()
  for (const n of ordered) if (n.branch !== 'main') {
    const list = members.get(n.branch)
    if (list) list.push(n)
    else members.set(n.branch, [n])
  }
  const children = new Map<string, Span[]>()
  const spans = new Map<string, Span>()
  for (const [name, ns] of members) {
    const first = ns.reduce((m, n) => (xOf(n) < xOf(m) ? n : m))
    const head = ns.reduce((m, n) => (xOf(n) >= xOf(m) ? n : m))
    const root = origin(first)
    const from = root && root.branch !== name ? root : undefined
    const firstX = n0(first)
    const start = from ? xOf(from) : firstX - SPROUT
    const line = Math.max(ends.get(head.id)!, xOf(head))
    const span = { name, parent: from?.branch ?? 'main', start, leave: Math.max(start, firstX - STEP - BEND_ROOM), first: firstX, line, end: line + labelWidth(name) }
    spans.set(name, span)
    const siblings = children.get(span.parent)
    if (siblings) siblings.push(span)
    else children.set(span.parent, [span])
  }
  /** A group's run begins at its first step, not at its mark. */
  function n0(n: GraphNode) { return n.kind === 'group' ? xOf(n) - (ends.get(n.id)! - xOf(n)) : xOf(n) }
  /** Branches take lanes in the order they leave their parents, so a lane frees behind a finished branch. */
  const earlier = (p: Span, q: Span) => p.leave - q.leave || p.first - q.first || p.name.localeCompare(q.name)

  const free = (occ: Map<number, Cell[]>, lane: number, a: number, b: number) => !occ.get(lane)?.some((c) => c.a < b + PAD && a < c.b + PAD)
  /** A sprout may pass behind a name tag, never through a line. */
  const unlined = (occ: Map<number, Cell[]>, lane: number, a: number, b: number) => !occ.get(lane)?.some((c) => c.a < b + PAD && a < c.l + PAD)
  const add = (occ: Map<number, Cell[]>, cell: Cell) => {
    const list = occ.get(cell.lane)
    if (list) list.push(cell)
    else occ.set(cell.lane, [cell])
  }
  const fits = (occ: Map<number, Cell[]>, shape: Cell[], sign: number, o: number) => shape.every((c) => free(occ, sign * (o + c.lane), c.a, c.b))
  const sprout = (span: Span, o: number) => span.leave + bendOf(o * GAP, span.first - span.leave)
  const clear = (occ: Map<number, Cell[]>, span: Span, sign: number, o: number) => {
    for (let k = 1; k < o; k++) if (!unlined(occ, sign * k, span.leave, sprout(span, o))) return false
    return true
  }
  /** The nearest offset whose sprout crosses no line, else the nearest that fits at all (`clean` says which). */
  const reach = (occ: Map<number, Cell[]>, shape: Cell[], span: Span, sign: number) => {
    const outer = Math.max(0, ...[...occ.keys()].map((l) => l * sign))
    for (let o = 1; o <= outer + 1; o++) if (fits(occ, shape, sign, o) && clear(occ, span, sign, o)) return { o, clean: true }
    let o = 1
    while (!fits(occ, shape, sign, o)) o++
    return { o, clean: false }
  }
  const offset = (occ: Map<number, Cell[]>, shape: Cell[], span: Span, sign: number) => reach(occ, shape, span, sign).o
  const place = (occ: Map<number, Cell[]>, shape: Cell[], span: Span, sign: number, o: number) => {
    // the stretch it runs along its parent first, then the lanes its bend crosses
    if (span.leave > span.start) add(occ, { lane: 0, a: span.start, b: span.leave, l: span.leave })
    for (let k = 1; k < o; k++) add(occ, { lane: sign * k, a: span.leave, b: sprout(span, o), l: sprout(span, o) })
    for (const c of shape) add(occ, { ...c, lane: sign * (o + c.lane) })
  }
  /** A branch and its descendants, with the branch on lane 0 and descendants on positive lanes. */
  const shapeOf = (span: Span): Cell[] => {
    const occ = new Map<number, Cell[]>()
    add(occ, { lane: 0, a: span.leave, b: span.end, l: span.line, branch: span.name })
    for (const kid of [...(children.get(span.name) ?? [])].sort(earlier)) {
      const shape = shapeOf(kid)
      place(occ, shape, kid, 1, offset(occ, shape, kid, 1))
    }
    return [...occ.values()].flat()
  }
  const trunk = new Map<number, Cell[]>()
  const load = new Map<number, number>([[1, 0], [-1, 0]])
  for (const kid of [...(children.get('main') ?? [])].sort(earlier)) {
    const shape = shapeOf(kid)
    // The side where its sprout crosses nothing, then the nearer, then a remembered side, then the lighter.
    const up = reach(trunk, shape, kid, -1)
    const down = reach(trunk, shape, kid, 1)
    const remembered = Math.sign(sides.get(kid.name) ?? 0)
    const sign = up.clean !== down.clean ? (up.clean ? -1 : 1) : up.o !== down.o ? (up.o < down.o ? -1 : 1) : remembered || (load.get(-1)! <= load.get(1)! ? -1 : 1)
    place(trunk, shape, kid, sign, sign < 0 ? up.o : down.o)
    load.set(sign, load.get(sign)! + shape.length)
  }
  const lanes = new Map<string, number>([['main', 0]])
  for (const list of trunk.values()) for (const c of list) if (c.branch) lanes.set(c.branch, c.lane)
  // Each sprout bends across the lanes it actually crosses, and knots just before the branch's first commit.
  const forks = new Map<string, Fork>()
  for (const [name, span] of spans) {
    const bend = bendOf(((lanes.get(name) ?? 0) - (lanes.get(span.parent) ?? 0)) * GAP, span.first - span.leave)
    forks.set(name, { base: span.start, leave: span.leave, bend, knot: Math.min(span.first, Math.max(span.leave + bend, span.first - STEP)) })
  }

  const radius = Math.max(1, ...[...lanes.values()].map((v) => Math.abs(v)))
  const height = 2 * (radius * GAP + 64)
  const center = height / 2
  const positioned = ordered.map((n) => ({ ...n, x: xOf(n), end: ends.get(n.id)!, y: center + (lanes.get(n.branch) ?? 0) * GAP }))
  const points = new Map<string, (typeof positioned)[number]>()
  let right = 260
  for (const n of positioned) {
    points.set(n.id, n)
    for (const c of n.commits) points.set(c.id, n)
    right = Math.max(right, n.end + labelWidth(n.branch) + 60)
  }
  return { positioned, points, center, width: right, height, lanes, forks }
}

/** Iterative DFS also handles an expanded history with tens of thousands of nodes. */
function topological<T extends { id: string }>(items: T[], parents: (item: T) => T[]): T[] {
  const ordered: T[] = []
  const done = new Set<string>()
  const visiting = new Set<string>()
  for (const first of items) {
    const stack: { item: T, finish: boolean }[] = [{ item: first, finish: false }]
    while (stack.length) {
      const { item, finish } = stack.pop()!
      if (done.has(item.id)) continue
      if (finish) {
        visiting.delete(item.id)
        done.add(item.id)
        ordered.push(item)
        continue
      }
      if (visiting.has(item.id)) continue
      visiting.add(item.id)
      stack.push({ item, finish: true })
      for (const parent of parents(item).reverse()) if (!done.has(parent.id) && !visiting.has(parent.id)) stack.push({ item: parent, finish: false })
    }
  }
  return ordered
}
