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
export function graphNodes(branches: HistoryBranch[], pages: Record<string, HistoryPage | undefined>, sources: ReadonlyMap<string, string>, expandedIds: ReadonlySet<string>, selected: string | null, t: Translate, all = false): GraphNode[] {
  // Show all: every run and every quiet stretch of main is drawn one by one.
  const expanded = all ? { has: () => true } : expandedIds
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

/**
 * A Branch's new first page joined to what was loaded at its old head: the new Commits above
 * the old head, then the old pages (or the new page's own tail when it reads deeper). Undefined
 * when the new page does not reach the old head (the caller reads on, or keeps the new page).
 */
export function extendPage(fresh: HistoryPage, old: HistoryPage): HistoryPage | undefined {
  const oldHead = old.items[0]?.id ?? old.head
  if (!oldHead || fresh.head === old.head) return old.items.length >= fresh.items.length ? old : fresh
  const at = fresh.items.findIndex((c) => c.id === oldHead)
  if (at < 0) return undefined
  const deeper = old.items.length >= fresh.items.length - at
  return { items: [...fresh.items.slice(0, at), ...(deeper ? old.items : fresh.items.slice(at))], next: deeper ? old.next : fresh.next, head: fresh.head }
}

/**
 * A side Branch's Commit count without a read, when the loaded page tells it: unchanged head,
 * nothing since the fork, a complete page, or a new page that reaches the last counted head.
 * Null when only the host can count it.
 */
export function movedCount(known: { head: string | null, count: number } | undefined, page: HistoryPage | undefined, branch: HistoryBranch): number | null {
  if (known && known.head === (branch.head ?? null)) return known.count
  if (branch.head && branch.head === branch.forkedFrom) return 0
  if (!page || page.head !== branch.head) return null
  if (page.next === null) return page.items.length
  if (!known?.head) return null
  const at = page.items.findIndex((c) => c.id === known.head)
  return at < 0 ? null : known.count + at
}

/**
 * The Commit total of `branches` once each has a count at its current head, else null. A
 * Branch without a head yet (a new session Branch) is not counted until its count arrives.
 */
export function countedTotal(branches: HistoryBranch[], counts: Readonly<Record<string, { head: string | null, count: number } | undefined>>): number | null {
  let total = 0
  for (const b of branches) {
    const known = counts[b.name]
    if (!known || known.head !== (b.head ?? null)) return null
    total += known.count
  }
  return branches.length ? total : null
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
/** A collapsed run's width: room for its three dots, growing a step per doubling of its count up to six steps, so a long run never stretches its lane. */
const runWidth = (count: number): number => STEP * Math.min(6, Math.max(2, Math.ceil(Math.log2(count))))
const SPROUT = 40
/** A sprout leaves its parent at most this far (plus a step) before the branch's first commit; before that it runs along the parent. Short, so in a packed run of branches a sprout leaves after its neighbours' lines end. */
const BEND_ROOM = 56
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
 * step past its own parent, so a branch is as long as its own nodes (a
 * collapsed run takes a short width that grows with the log of its count) and branches running at the same time
 * share columns; a branch starts past every commit saved before its first
 * one, so branches that ran one after another sit end to end and a quiet
 * stretch takes no room. Main rides the vertical center. A branch sprouts
 * from its fork point and bends out about 45° into its own lane, then runs to
 * a knot just before its first commit; a branch that starts long after its
 * fork point runs along its parent first and leaves it shortly before its
 * work, so it holds a lane only while it is going. Branches take lanes in
 * the order they leave: each the free lane nearest its parent on its parent's
 * side of main, inward or outward, and a lane frees once a branch and its name
 * tag are behind, so the tree stays balanced around main and a chain of
 * branches zigzags between two lanes instead of climbing. Main's children go to
 * the lighter side. A sprout crosses another branch only when no lane avoids
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
    // A collapsed run takes a short width, its mark in the middle; its commits' times spread across it.
    const width = n.kind === 'group' ? runWidth(n.commits.length) : 0
    const end = start + width
    xs.set(n.id, n.kind === 'group' ? (start + end) / 2 : start)
    ends.set(n.id, end)
    ts.forEach((at, i) => record(rank.get(at)!, start + (ts.length > 1 ? (i / (ts.length - 1)) * width : 0)))
    if (n.branch === 'main') trunkEnd = end
  }
  const xOf = (n: GraphNode) => xs.get(n.id)!

  const members = new Map<string, GraphNode[]>()
  for (const n of ordered) if (n.branch !== 'main') {
    const list = members.get(n.branch)
    if (list) list.push(n)
    else members.set(n.branch, [n])
  }
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
  }
  /** A group's run begins at its first step, not at its mark. */
  function n0(n: GraphNode) { return n.kind === 'group' ? xOf(n) - (ends.get(n.id)! - xOf(n)) : xOf(n) }
  const earlier = (p: Span, q: Span) => p.leave - q.leave || p.first - q.first || p.name.localeCompare(q.name)

  const occ = new Map<number, Cell[]>()
  const free = (lane: number, a: number, b: number) => !occ.get(lane)?.some((c) => c.a < b + PAD && a < c.b + PAD)
  /** A sprout may pass behind a name tag, never through a line. */
  const unlined = (lane: number, a: number, b: number) => !occ.get(lane)?.some((c) => c.a < b + PAD && a < c.l + PAD)
  const add = (cell: Cell) => {
    const list = occ.get(cell.lane)
    if (list) list.push(cell)
    else occ.set(cell.lane, [cell])
  }
  const lanes = new Map<string, number>([['main', 0]])
  const load = new Map<number, number>([[1, 0], [-1, 0]])
  /** Whether `span` fits on `lane` from a parent on `from`, and whether its sprout crosses no line on the way. */
  const test = (span: Span, from: number, lane: number) => {
    // Its own lane is taken from where its bend arrives there.
    const to = span.leave + bendOf((lane - from) * GAP, span.first - span.leave)
    if (!free(lane, to, span.end)) return null
    const step = Math.sign(lane - from)
    let clean = true
    for (let k = from + step; k !== lane; k += step) if (k !== 0 && !unlined(k, span.leave, to)) clean = false
    return { lane, clean, to }
  }
  /**
   * The free lane nearest the parent on one side of main (inward or outward, so a
   * finished parent's neighbour is reused and a chain of branches zigzags instead of
   * climbing): the nearest whose sprout crosses no line, else the nearest that fits.
   */
  const pick = (span: Span, from: number, sign: number) => {
    const outer = Math.max(Math.abs(from), ...[...occ.keys()].map((l) => l * sign)) + 1
    const order = Array.from({ length: outer }, (_, i) => sign * (i + 1)).filter((l) => l !== from).sort((a, b) => Math.abs(a - from) - Math.abs(b - from) || Math.abs(a) - Math.abs(b))
    let fallback: ReturnType<typeof test> = null
    for (const lane of order) {
      const fit = test(span, from, lane)
      if (fit?.clean) return fit
      fallback ??= fit
    }
    return fallback ?? test(span, from, sign * (outer + 1))!
  }
  // Branches take lanes in the order they leave their parents (a parent always first), so a lane frees behind a finished branch.
  const pending = [...spans.values()].sort(earlier)
  while (pending.length) {
    const i = Math.max(0, pending.findIndex((sp) => lanes.has(sp.parent) || !spans.has(sp.parent)))
    const span = pending.splice(i, 1)[0]
    const from = lanes.get(span.parent) ?? 0
    let fit
    if (from) fit = pick(span, from, Math.sign(from))
    else {
      // Main's children: the side whose sprout crosses nothing, then the nearer, then a remembered side, then the lighter.
      const up = pick(span, 0, -1)
      const down = pick(span, 0, 1)
      const remembered = Math.sign(sides.get(span.name) ?? 0)
      const lighter = load.get(-1)! <= load.get(1)! ? up : down
      fit = up.clean !== down.clean ? (up.clean ? up : down) : Math.abs(up.lane) !== Math.abs(down.lane) ? (Math.abs(up.lane) < Math.abs(down.lane) ? up : down) : load.get(-1) !== load.get(1) ? lighter : remembered ? (remembered < 0 ? up : down) : lighter
    }
    const sign = Math.sign(fit.lane)
    load.set(sign, load.get(sign)! + 1)
    lanes.set(span.name, fit.lane)
    // the stretch it runs along its parent first, the lanes its bend crosses, then its own line and name tag
    if (span.leave > span.start) add({ lane: from, a: span.start, b: span.leave, l: span.leave })
    const step = Math.sign(fit.lane - from)
    for (let k = from + step; k !== fit.lane; k += step) if (k) add({ lane: k, a: span.leave, b: fit.to, l: fit.to })
    add({ lane: fit.lane, a: fit.to, b: span.end, l: span.line, branch: span.name })
  }
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
