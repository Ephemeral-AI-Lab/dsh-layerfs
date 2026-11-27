/**
 * The history tree's model. Everything saved in a project takes one step along
 * the axis, in the order it was saved (the unit is the checkpoint, not the
 * clock), so nothing is folded and nothing is squeezed. Main rides lane 0; each
 * Branch takes a lane above or below it only while it runs.
 */
import type { CommitInfo, HistoryBranch, HistoryPage } from './types.ts'

/** One saved thing: a Layer on main, or a checkpoint (a merge is a checkpoint with a second parent). */
export interface TreeRow {
  id: string
  branch: string
  /** Its step along the axis, 0 first. */
  slot: number
  /** Null for a Layer known only by its id (main's head or a fork point not read yet). */
  commit: CommitInfo | null
  kind: 'layer' | 'checkpoint' | 'merge'
  /** A Layer's number on main, oldest 1; set once main is read in full. */
  n?: number
}

export interface TreeBranch {
  name: string
  /** 0 is main; negative lanes sit above it. */
  lane: number
  /** The lane it grows out of. */
  parentLane: number
  parent: string
  rows: TreeRow[]
  first: number
  last: number
  /** The step it leaves its parent at. */
  fork: number
  /** Earlier checkpoints are not read yet: the sprout to the fork point is a guess. */
  partial: boolean
  /** Something of it reached main (published, merged into, or forked into a Branch that was). */
  live: boolean
}

/** A merge into a checkpoint, or a publish into a Layer. */
export interface TreeLink { from: TreeRow, to: TreeRow, publish: boolean }

export interface TreeLayout {
  rows: TreeRow[]
  byId: Map<string, TreeRow>
  branches: TreeBranch[]
  byName: Map<string, TreeBranch>
  layers: TreeRow[]
  links: TreeLink[]
  /** Branches with nothing saved since their fork, by the row they hang from. */
  buds: Map<string, string[]>
  /** The furthest lane on either side of main. */
  reach: number
  /** Every Branch is read in full, so `live` is known. */
  settled: boolean
}

/** A 0x32-tagged saved id names a Layer on main. */
const isLayerId = (id: string): boolean => id.startsWith('32')

/**
 * A Branch whose head is still its fork point has nothing saved of its own:
 * the one row its History shows is the version it started from. Null for main,
 * for an unknown Branch, and for every Branch with a Commit of its own.
 */
export function forkBaseOf(branches: readonly HistoryBranch[], parents: ReadonlyMap<string, string | null>, branch: string): { base: string, source: string } | null {
  const b = branches.find((x) => x.name === branch)
  if (!b || b.name === 'main') return null
  const base = b.forkedFrom ?? b.base
  if (!base || !b.head || b.head !== base) return null
  return { base, source: parents.get(b.name) || 'main' }
}

/** Each Branch's parent Branch: the owner of its fork point, else main for a Layer, else null. */
export function branchParents(branches: readonly HistoryBranch[], pages: Readonly<Record<string, HistoryPage | undefined>>): Map<string, string | null> {
  const owners = new Map<string, string>()
  for (const [name, page] of Object.entries(pages)) for (const c of page?.items ?? []) owners.set(c.id, name)
  const main = branches.find((b) => b.name === 'main')
  const bases = new Set(branches.map((b) => b.base))
  const parents = new Map<string, string | null>()
  for (const b of branches) {
    const owner = b.forkedFrom ? owners.get(b.forkedFrom) : undefined
    parents.set(b.name, b.name === 'main' ? null : owner && owner !== b.name ? owner : b.forkedFrom && (bases.has(b.forkedFrom) || isLayerId(b.forkedFrom) || b.forkedFrom === main?.head) ? 'main' : null)
  }
  return parents
}

interface Draft { id: string, branch: string, commit: CommitInfo | null, at: number | null, deps: string[] }

/** Steps a lane stays taken after a Branch ends, and how long a Branch waits on its lane for its merge. */
const PAD = 14
const HOLD = 60
/** A sprout claims at most this many steps of its lane before the Branch's first checkpoint. */
const LEAD = 40

/** `prefer` names the lane each Branch had in the last layout: it keeps it where that is still free. */
export function treeLayout(branches: readonly HistoryBranch[], pages: Readonly<Record<string, HistoryPage | undefined>>, prefer?: ReadonlyMap<string, number>): TreeLayout {
  const drafts = new Map<string, Draft>()
  const add = (d: Draft) => { if (!drafts.has(d.id)) drafts.set(d.id, d) }
  const main = branches.find((b) => b.name === 'main')
  const mainItems = [...(pages.main?.items ?? [])].reverse()
  for (const c of mainItems) add({ id: c.id, branch: 'main', commit: c, at: c.at ?? c.sourceTime ?? null, deps: [c.parent, c.sourceCommit].filter((x): x is string => !!x) })
  if (main?.head && !drafts.has(main.head)) add({ id: main.head, branch: 'main', commit: null, at: null, deps: mainItems.length ? [mainItems.at(-1)!.id] : [] })
  // Fork points older than what is read of main: Layers known by id only, before main's oldest read Layer.
  const early: string[] = []
  for (const b of branches) if (b.name !== 'main' && b.forkedFrom && isLayerId(b.forkedFrom) && !drafts.has(b.forkedFrom)) {
    add({ id: b.forkedFrom, branch: 'main', commit: null, at: null, deps: [] })
    early.push(b.forkedFrom)
  }
  const oldest = mainItems[0] ? drafts.get(mainItems[0].id) : main?.head ? drafts.get(main.head) : undefined
  if (oldest && !early.includes(oldest.id)) oldest.deps.push(...early)

  const firstOf = new Map<string, string>()
  const partial = new Set<string>()
  for (const b of branches) {
    if (b.name === 'main') continue
    const page = pages[b.name]
    const items = [...(page?.items ?? [])].reverse()
    const own = new Set(items.map((c) => c.id))
    let first = true
    for (const c of items) {
      if (drafts.has(c.id)) continue
      const parent = c.parent ?? b.forkedFrom
      const deps = [parent, c.merged].filter((x): x is string => !!x)
      // A run whose parent is on a page not read yet still hangs from the Branch's fork point.
      if (parent && !own.has(parent) && parent !== b.forkedFrom && b.forkedFrom) { deps.push(b.forkedFrom); partial.add(b.name) }
      if (first) { firstOf.set(b.name, c.id); first = false }
      add({ id: c.id, branch: b.name, commit: c, at: c.at, deps })
    }
    if (page && page.next !== null && items.length) partial.add(b.name)
  }

  // Saved order: by time, never before anything it was made from. An undated thing follows what it was made from.
  const waiting = new Map<string, number>()
  const unlocks = new Map<string, string[]>()
  for (const d of drafts.values()) {
    d.deps = [...new Set(d.deps)].filter((id) => id !== d.id && drafts.has(id))
    waiting.set(d.id, d.deps.length)
    for (const dep of d.deps) { const list = unlocks.get(dep); if (list) list.push(d.id); else unlocks.set(dep, [d.id]) }
  }
  const key = new Map<string, number>()
  const heap = new Heap()
  let seq = 0
  const ready = (d: Draft) => {
    let floor = -Infinity
    for (const dep of d.deps) floor = Math.max(floor, key.get(dep) ?? -Infinity)
    const k = d.at == null ? floor : Math.max(d.at, floor)
    key.set(d.id, k)
    heap.push(k, seq++, d.id)
  }
  for (const d of drafts.values()) if (!waiting.get(d.id)) ready(d)
  const rows: TreeRow[] = []
  const byId = new Map<string, TreeRow>()
  const place = (d: Draft) => {
    const row: TreeRow = { id: d.id, branch: d.branch, slot: rows.length, commit: d.commit, kind: d.branch === 'main' ? 'layer' : d.commit?.merged ? 'merge' : 'checkpoint' }
    rows.push(row)
    byId.set(d.id, row)
  }
  while (heap.size) {
    const d = drafts.get(heap.pop())!
    place(d)
    for (const next of unlocks.get(d.id) ?? []) {
      const left = waiting.get(next)! - 1
      waiting.set(next, left)
      if (!left) ready(drafts.get(next)!)
    }
  }
  // A cycle in bad data: what is left still gets a step.
  if (rows.length < drafts.size) for (const d of drafts.values()) if (!byId.has(d.id)) place(d)

  const layers = rows.filter((r) => r.branch === 'main')
  if (pages.main?.next === null && !early.length) layers.forEach((r, i) => { r.n = i + 1 })

  const links: TreeLink[] = []
  for (const r of rows) {
    const from = byId.get((r.branch === 'main' ? r.commit?.sourceCommit : r.commit?.merged) ?? '')
    if (from && from !== r && from.branch !== r.branch) links.push({ from, to: r, publish: r.branch === 'main' })
  }

  // Branches, and the Branches with nothing saved yet.
  const byName = new Map<string, TreeBranch>()
  const buds = new Map<string, string[]>()
  for (const r of rows) {
    if (r.branch === 'main') continue
    const b = byName.get(r.branch)
    if (b) { b.rows.push(r); b.last = r.slot } else byName.set(r.branch, { name: r.branch, lane: 0, parentLane: 0, parent: 'main', rows: [r], first: r.slot, last: r.slot, fork: r.slot - 1, partial: partial.has(r.branch), live: true })
  }
  const forkRow = new Map<string, TreeRow>()
  for (const b of branches) {
    if (b.name === 'main') continue
    const tb = byName.get(b.name)
    if (!tb) {
      const at = byId.get(b.forkedFrom ?? '') ?? byId.get(b.head ?? '')
      if (at) { const list = buds.get(at.id); if (list) list.push(b.name); else buds.set(at.id, [b.name]) }
      continue
    }
    const first = drafts.get(firstOf.get(b.name) ?? tb.rows[0].id)
    const parentId = first?.commit?.parent ?? b.forkedFrom
    const from = byId.get(parentId ?? '') ?? byId.get(b.forkedFrom ?? '')
    if (from && from.branch !== b.name) { tb.parent = from.branch; tb.fork = Math.min(from.slot, tb.first - 1); forkRow.set(b.name, from) }
  }

  // Lanes, in the order the Branches leave their parents.
  const holds = new Map<string, number>()
  for (const l of links) if (l.from.branch !== 'main') {
    const b = byName.get(l.from.branch)!
    holds.set(b.name, Math.max(holds.get(b.name) ?? 0, Math.min(l.to.slot, b.last + HOLD)))
  }
  const taken = new Map<number, [number, number, string][]>()
  const free = (lane: number, a: number, b: number, but?: string) => !taken.get(lane)?.some((c) => c[2] !== but && c[0] < b + PAD && a < c[1] + PAD)
  const load = [0, 0]
  let reach = 1
  const pending = [...byName.values()].sort((x, y) => x.fork - y.fork || x.first - y.first)
  const placed = new Set<string>(['main'])
  const span = (b: TreeBranch) => ({ start: Math.max(b.fork, b.first - LEAD), end: Math.max(b.last, holds.get(b.name) ?? 0) })
  /** Whether `b` can carry on along its parent's lane: nothing else runs there past its fork point. */
  const carriesOn = (b: TreeBranch, parent: TreeBranch, end: number) => !taken.get(parent.lane)?.some((c) => c[2] !== parent.name && c[1] > b.fork && c[0] < end + PAD)
  const settle = (b: TreeBranch, lane: number, from: number) => {
    const { start, end } = span(b)
    b.lane = lane
    b.parentLane = from
    const cells = taken.get(lane)
    const cell: [number, number, string] = [lane === from ? b.fork + 1 : start, end, b.name]
    if (cells) cells.push(cell); else taken.set(lane, [cell])
    load[lane < 0 ? 0 : 1] += b.rows.length
    reach = Math.max(reach, Math.abs(lane))
    placed.add(b.name)
  }
  // First the Branches that had a lane last time and can still have it, so a newcomer never takes it from them.
  if (prefer) for (let moved = true; moved;) {
    moved = false
    for (let i = 0; i < pending.length; i++) {
      const b = pending[i]
      const kept = prefer.get(b.name)
      const parent = byName.get(b.parent)
      if (!kept || (parent && !placed.has(parent.name))) continue
      const from = parent ? parent.lane : 0
      const { start, end } = span(b)
      if (from && Math.sign(kept) !== Math.sign(from)) continue
      if (kept === from ? !carriesOn(b, parent!, end) : !free(kept, start, end)) continue
      settle(b, kept, from)
      pending.splice(i--, 1)
      moved = true
    }
  }
  while (pending.length) {
    // A parent takes its lane before its children.
    let i = pending.findIndex((b) => placed.has(b.parent) || !byName.has(b.parent))
    if (i < 0) i = 0
    const b = pending.splice(i, 1)[0]
    const parent = byName.get(b.parent)
    const from = parent && placed.has(parent.name) ? parent.lane : 0
    const { start, end } = span(b)
    const pick = (sign: number): number => {
      for (let d = 0; ; d++) for (const lane of d ? [from - d, from + d] : [from]) {
        if (lane === from || Math.sign(lane) !== sign) continue
        if (free(lane, start, end)) return lane
      }
    }
    let lane: number
    // Forked from its parent's last checkpoint: it carries on along the parent's lane.
    if (parent && from && forkRow.get(b.name) === parent.rows.at(-1) && carriesOn(b, parent, end)) lane = from
    else if (from) lane = pick(Math.sign(from))
    else {
      const up = pick(-1)
      const down = pick(1)
      lane = Math.abs(up) !== Math.abs(down) ? (Math.abs(up) < Math.abs(down) ? up : down) : load[0] <= load[1] ? up : down
    }
    settle(b, lane, from)
  }

  const settled = pages.main?.next === null && branches.every((b) => b.name === 'main' || (!!b.head && b.head === b.forkedFrom) || pages[b.name]?.next === null)
  if (settled) {
    for (const b of byName.values()) b.live = false
    const mark = (name: string | null | undefined) => { const b = name ? byName.get(name) : undefined; if (b) b.live = true }
    for (const r of layers) mark(r.commit?.sourceBranch)
    for (const l of links) if (l.publish) mark(l.from.branch)
    for (let changed = true; changed;) {
      changed = false
      const lift = (name: string) => { const b = byName.get(name); if (b && !b.live) { b.live = true; changed = true } }
      for (const l of links) if (!l.publish && byName.get(l.to.branch)?.live) lift(l.from.branch)
      for (const b of byName.values()) if (b.live && b.parent !== 'main') lift(b.parent)
    }
  }
  return { rows, byId, branches: [...byName.values()], byName, layers, links, buds, reach, settled }
}

/** A min-heap of ids by (key, sequence): no recursion, so a history of any depth is fine. */
class Heap {
  private keys: number[] = []
  private seqs: number[] = []
  private ids: string[] = []
  get size(): number { return this.ids.length }
  private less(a: number, b: number): boolean { return this.keys[a] < this.keys[b] || (this.keys[a] === this.keys[b] && this.seqs[a] < this.seqs[b]) }
  private swap(a: number, b: number): void {
    for (const list of [this.keys, this.seqs, this.ids] as unknown[][]) { const x = list[a]; list[a] = list[b]; list[b] = x }
  }
  push(key: number, seq: number, id: string): void {
    this.keys.push(key); this.seqs.push(seq); this.ids.push(id)
    for (let i = this.ids.length - 1; i > 0;) {
      const up = (i - 1) >> 1
      if (!this.less(i, up)) break
      this.swap(i, up)
      i = up
    }
  }
  pop(): string {
    const top = this.ids[0]
    const last = this.ids.length - 1
    this.swap(0, last)
    this.keys.pop(); this.seqs.pop(); this.ids.pop()
    for (let i = 0; ;) {
      const l = 2 * i + 1
      const r = l + 1
      let min = i
      if (l < last && this.less(l, min)) min = l
      if (r < last && this.less(r, min)) min = r
      if (min === i) break
      this.swap(i, min)
      i = min
    }
    return top
  }
}
