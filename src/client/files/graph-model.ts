/**
 * The history graph's model: nodes for the canvas, one stable lane per live
 * Branch around a centered main, and a left-to-right event-order layout.
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
  kind: 'layer' | 'checkpoint' | 'group' | 'fork'
  at: number | null
}

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
  const nodes: GraphNode[] = []
  const main = branches.find((b) => b.name === 'main')
  if (main?.head && !pages.main?.items.length) nodes.push({ id: main.head, branch: 'main', label: t('files_latestLayer'), commits: [], parent: null, source: null, second: null, kind: 'layer', at: null })
  for (const c of pages.main?.items ?? []) nodes.push({ id: c.id, branch: 'main', label: c.message || t('files_layer'), commits: [c], parent: c.parent, second: null, source: c.sourceCommit, kind: 'layer', at: c.at })
  const layerIds = new Set([...(main?.head ? [main.head] : []), ...(pages.main?.items ?? []).map((c) => c.id)])
  for (const b of branches) if (b.forkedFrom && isLayerId(b.forkedFrom) && !layerIds.has(b.forkedFrom)) {
    layerIds.add(b.forkedFrom)
    nodes.push({ id: b.forkedFrom, branch: 'main', label: t('files_earlierBaseLayer'), commits: [], parent: null, second: null, kind: 'layer', at: null })
  }
  for (const branch of branches.filter((b) => b.name !== 'main')) {
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

/** Event order runs left to right; main stays at the vertical center. */
export function layoutNodes(nodes: GraphNode[], lanes: ReadonlyMap<string, number>, availableWidth = 1000, availableHeight = 500) {
  const byCommit = new Map<string, GraphNode>()
  for (const n of nodes) {
    byCommit.set(n.id, n)
    for (const c of n.commits) byCommit.set(c.id, n)
  }
  const ordered = topological([...nodes].sort((a, b) => (a.at ?? 0) - (b.at ?? 0)), (n) => [n.parent, n.second, n.source].flatMap((id) => {
    const p = id && byCommit.get(id)
    return p && p !== n ? [p] : []
  }))
  const radius = Math.max(1, ...[...lanes.values()].map((v) => Math.abs(v)))
  const gap = 46
  const height = Math.max(availableHeight, 2 * (radius * gap + 64))
  const center = height / 2
  const step = Math.max(22, Math.min(48, (availableWidth - 220) / Math.max(14, ordered.length - 1)))
  const positioned = ordered.map((n, i) => ({ ...n, x: 60 + i * step, y: center + (lanes.get(n.branch) ?? 0) * gap }))
  const points = new Map<string, (typeof positioned)[number]>()
  for (const n of positioned) {
    points.set(n.id, n)
    for (const c of n.commits) points.set(c.id, n)
  }
  return { positioned, points, center, width: Math.max(availableWidth, 260 + Math.max(0, ordered.length - 1) * step), height }
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
