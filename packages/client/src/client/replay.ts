// A project's LayerFS state as the view model, with Files read on demand
// (a session's trace lines are played by playback.ts).
import * as X from '../../../model/src/index.js'
import { createFilesSource } from '../../../view/src/index.js'
import { api, type ProjectState } from './api.ts'

/** The Files pane's reads on demand (view/src/filesource.js), kept across rebuilds: a saved id never changes. */
export type FilesSource = ReturnType<typeof createFilesSource>

/**
 * A project's view model from its LayerFS state (no session): the Host's
 * labelled mirror, with Files read on demand and each node's author.
 */
export function projectModel(state: ProjectState, files: FilesSource, onchange: () => void) {
  const engine: any = new X.ReplayEngine({ project: state.s.project?.name ?? 'project', files })
  seedEngine(engine, state)
  engine.onchange = onchange
  return X.derive(attribute(X.storyView(engine, { lead: 'main' }), state))
}

/**
 * Starts a replay engine from the project's state: every Branch, Commit and
 * Layer under the Host's labels, in the order they happened. A session's
 * calls then replay on top (LayerFsView): a node the state already has keeps
 * its label, and a new one is labelled after the state's. `workspaces: false`
 * leaves Sandboxes to the calls.
 */
export function seedEngine(engine: any, state: ProjectState, { workspaces = true } = {}) {
  const m = engine.m
  m.s = { ...structuredClone(state.s), roots: {}, ...(workspaces ? {} : { sandboxes: {}, sandboxOrder: [] }) }
  for (const [real, label] of Object.entries(state.labels)) {
    m.toLabel.set(real, label)
    m.toReal.set(label, real)
    const n = /^([CLR])(\d+)$/.exec(label)
    if (n) m.next[n[1]] = Math.max(m.next[n[1]], Number(n[2]) + 1)
  }
  for (const node of [...Object.values(m.s.commits), ...Object.values(m.s.layers)] as any[]) node.root = node.id
  chronological(m.s, state)
  const slots = [...Object.values(m.s.commits), ...Object.values(m.s.layers), ...Object.values(m.s.branches)].map(
    (x: any) => x.slot ?? 0,
  )
  m.slot = Math.max(m.slot, ...slots, -1) + 1
  engine.seeded = true
}

/** Who made each node of the state, on the view (History's avatars). */
export function attribute(W: any, state: ProjectState) {
  for (const [real, agent] of Object.entries(state.authors ?? {})) {
    const label = state.labels[real]
    if (label) W.attrib[label] = agent
  }
  return W
}

/**
 * Orders a snapshot's nodes by when they happened, as History draws them
 * (by slot). Commits carry their time; Layers and fork points do not, so
 * the journals' times are used, else a Layer follows its source Commit and
 * parent Layer, and a fork point follows the node it forked from and comes
 * before its Branch's first Commit.
 */
function chronological(s: any, state: ProjectState) {
  const at = new Map<string, number>()
  for (const c of Object.values(s.commits) as any[]) at.set(c.id, c.time)
  const realOf = new Map(Object.entries(state.labels).map(([r, label]) => [label, r]))
  const layers = Object.values(s.layers as Record<string, any>).sort((a, b) => a.slot - b.slot)
  for (const l of layers) {
    const after = Math.max(at.get(l.parent) ?? -Infinity, at.get(l.sourceCommit) ?? -Infinity)
    const known = state.times[realOf.get(l.id) ?? '']
    at.set(l.id, known ?? (after === -Infinity ? 0 : after + 1))
  }
  const branches = s.branchOrder.map((name: string) => s.branches[name])
  for (const b of branches) {
    const first = Math.min(...(Object.values(s.commits) as any[]).filter((c) => c.branch === b.name).map((c) => c.time))
    const after = (at.get(b.from) ?? 0) + 0.5
    at.set(`fork:${b.name}`, Math.min(state.forks[b.name] ?? after, first - 0.5))
  }
  const rank = (id: string) => (id.startsWith('fork:') ? 0 : s.commits[id] ? 1 : 2)
  const order = [...at.keys()].sort((x, y) => at.get(x)! - at.get(y)! || rank(x) - rank(y))
  order.forEach((id, slot) => {
    if (id.startsWith('fork:')) s.branches[id.slice(5)].slot = slot
    else (s.commits[id] ?? s.layers[id]).slot = slot
  })
}
