/**
 * Pure model of the conversation views (docs/specs/conversation-views.md):
 * the root of a subagent tree, and the Sandbox map built from the session
 * binding and the agents' call log lines. No React, no host calls.
 */
import type { CallLine } from '../../shared/logs.ts'

/** The bits of a DSH session summary the views read (`ctx.sessions.list`'s `byId` rows). */
export interface SessionRow {
  sessionId?: string
  /** The direct parent (DSH's summary field; there is no `parentSessionId`). */
  parentId?: string
  origin?: 'subagent'
  running?: boolean
}

/** The project root of `sessionId`: walk subagent parents while they are known. */
export function rootOf(sessionId: string, byId: Readonly<Record<string, SessionRow | undefined>>): string {
  let id = sessionId
  const seen = new Set<string>()
  for (;;) {
    const row = byId[id]
    if (seen.has(id) || !row || row.origin !== 'subagent' || !row.parentId || !byId[row.parentId]) return id
    seen.add(id)
    id = row.parentId
  }
}

/** One agent of the tree, root first, each child after its parent. */
export interface MapAgent {
  id: string
  parent?: string
  depth: number
  running: boolean
}

/** `root` and every subagent below it, in tree order. */
export function agentTree(root: string, byId: Readonly<Record<string, SessionRow | undefined>>): MapAgent[] {
  const children = new Map<string, string[]>()
  for (const [id, row] of Object.entries(byId)) {
    if (!row || row.origin !== 'subagent' || !row.parentId) continue
    const list = children.get(row.parentId) ?? []
    list.push(id)
    children.set(row.parentId, list)
  }
  const out: MapAgent[] = []
  const seen = new Set<string>()
  const walk = (id: string, depth: number, parent?: string) => {
    if (seen.has(id)) return
    seen.add(id)
    out.push({ id, depth, running: !!byId[id]?.running, ...(parent ? { parent } : {}) })
    for (const child of children.get(id) ?? []) walk(child, depth + 1, id)
  }
  walk(root, 0)
  return out
}

/** What a call names, from its canonical CLI words (family, call, positionals, then `--options`). */
export interface CallTargets {
  branch?: string
  /** `<sandbox>:<name>`. */
  ws?: string
  sandbox?: string
  machine?: string
}

function split(argv: readonly string[]): { positionals: string[], options: Record<string, string | true> } {
  const positionals: string[] = []
  const options: Record<string, string | true> = {}
  for (let i = 2; i < argv.length; i++) {
    const word = String(argv[i])
    if (!word.startsWith('--')) { positionals.push(word); continue }
    const equal = word.indexOf('=')
    if (equal > 0) { options[word.slice(2, equal)] = word.slice(equal + 1); continue }
    const next = argv[i + 1]
    if (next !== undefined && !String(next).startsWith('--')) { options[word.slice(2)] = String(next); i++ } else options[word.slice(2)] = true
  }
  return { positionals, options }
}

const real = (value: string | undefined) => value && !value.startsWith('<') ? value : undefined

/** The branch, workspace and sandbox a call names (see the CLI's `help --json` argument order). */
export function targetsOf(argv: readonly string[]): CallTargets {
  const family = argv[0], call = String(argv[1] ?? '').replaceAll('_', '-')
  const { positionals: p, options } = split(argv)
  const out: CallTargets = {}
  const ws = (id: string | undefined) => {
    const value = real(id)
    if (!value) return
    out.ws = value
    const colon = value.indexOf(':')
    if (colon > 0) out.sandbox = value.slice(0, colon)
  }
  switch (family) {
    case 'file':
    case 'commit':
      if (real(p[1])) out.branch = p[1]
      break
    case 'branch':
      if (['get', 'commits', 'get-commit', 'publish', 'fork', 'merge'].includes(call) && real(p[1])) out.branch = p[1]
      break
    case 'sandbox':
      if (call === 'create') { if (real(p[1])) out.sandbox = p[1]; if (real(p[2])) out.machine = p[2] }
      else if (['get', 'close'].includes(call) && real(p[0])) out.sandbox = p[0]
      break
    case 'workspace':
      if (call === 'mount') {
        if (real(p[0])) out.sandbox = p[0]
        if (real(p[1])) out.branch = p[1]
        const name = typeof options.name === 'string' ? options.name : undefined
        if (out.sandbox && real(name)) out.ws = `${out.sandbox}:${name}`
      } else ws(p[0])
      break
  }
  return out
}

/** The binding fields the map reads (`session.state`). */
export interface MapBinding {
  project?: string
  branch?: string
  sandbox?: string
  ws?: string
  machine?: string
  state?: string
  executionState?: string
}

export interface MapWorkspace { id: string, name: string, branch?: string }
export interface MapSandbox { name: string, machine?: string, workspaces: MapWorkspace[], closed: boolean }

/** One call placed on the replay clock (seconds). */
export interface MapEvent {
  id: string
  agent: string
  method: string
  outcome: string
  at: number
  ms: number
  start: number
  end: number
  branch?: string
  ws?: string
  sandbox?: string
  turn?: number
  /** The call as CLI words (redacted), for the inspector. */
  argv: string[]
  /** The call's `dsh:` tag, when `logs.output` may hold what it printed. */
  tag?: string
  output?: boolean
}

export interface SandboxMapModel {
  agents: MapAgent[]
  branches: string[]
  sandboxes: MapSandbox[]
  events: MapEvent[]
  /** Replay length in seconds. */
  duration: number
}

/** Idle gaps longer than this (ms) are shortened to it on the replay clock. */
export const MAX_GAP_MS = 1000
/** Shortest replay window of a call, seconds: one request lap plus its result. */
export const MIN_CALL_S = 1.4
/** Longest replay window of a call, seconds: a ten-minute build does not hold the replay. */
export const MAX_CALL_S = 6
/** Pause between one agent's back-to-back calls on the replay clock, seconds. */
export const CALL_GAP_S = 0.25

/**
 * Replay clock: real time minus the part of each idle gap beyond MAX_GAP_MS.
 * @returns seconds since the first call for each `[at, end]`.
 */
export function replayClock(calls: readonly { at: number, ms: number }[]): (time: number) => number {
  if (!calls.length) return () => 0
  const spans = calls.map((c) => [c.at, c.at + Math.max(0, c.ms)] as const).sort((a, b) => a[0] - b[0])
  const t0 = spans[0][0]
  const cuts: { from: number, to: number, saved: number }[] = []
  let edge = spans[0][1]
  for (const [start, end] of spans.slice(1)) {
    if (start > edge + MAX_GAP_MS) cuts.push({ from: edge, to: start, saved: start - edge - MAX_GAP_MS })
    edge = Math.max(edge, end)
  }
  return (time: number) => {
    let saved = 0
    for (const cut of cuts) {
      if (time >= cut.to) saved += cut.saved
      else if (time > cut.from + MAX_GAP_MS) saved += time - cut.from - MAX_GAP_MS
    }
    return Math.max(0, (time - t0 - saved) / 1000)
  }
}

const methodOf = (argv: readonly string[]) => `${argv[0] ?? '?'}.${String(argv[1] ?? '?').replaceAll('_', '-')}`

/** Reads that only poll state (this plugin's own pages and checks among them); kept out of the map so the wires show work. */
const QUIET = new Set(['project.get', 'branch.get', 'file.list', 'file.stat', 'workspace.list', 'workspace.status', 'sandbox.list', 'sandbox.get', 'machine.list', 'machine.status', 'machine.get', 'store.status', 'store.stats', 'store.list', 'project.list', 'branch.list'])

/**
 * The Sandbox map: agents, the branches and sandboxes they touched and their
 * calls on the replay clock.
 * @param agents - `agentTree` of the root.
 * @param binding - the root's binding (its branch and workspace are always shown).
 * @param calls - each agent's call log lines.
 */
export function buildSandboxMap(agents: MapAgent[], binding: MapBinding | null, calls: Readonly<Record<string, readonly (CallLine & { dsh?: { turn?: number } })[]>>): SandboxMapModel {
  const branches = new Set<string>()
  const sandboxes = new Map<string, MapSandbox>()
  const sandbox = (name: string) => {
    let box = sandboxes.get(name)
    if (!box) { box = { name, workspaces: [], closed: false }; sandboxes.set(name, box) }
    return box
  }
  const workspace = (id: string, branch?: string) => {
    const colon = id.indexOf(':')
    const box = sandbox(colon > 0 ? id.slice(0, colon) : id)
    let ws = box.workspaces.find((w) => w.id === id)
    if (!ws) { ws = { id, name: colon > 0 ? id.slice(colon + 1) : id }; box.workspaces.push(ws) }
    if (branch && !ws.branch) ws.branch = branch
    return ws
  }
  if (binding?.branch) branches.add(binding.branch)
  if (binding?.sandbox) { const box = sandbox(binding.sandbox); if (binding.machine) box.machine = binding.machine }
  if (binding?.ws) workspace(binding.ws, binding.branch)

  const flat = agents.flatMap((agent) => (calls[agent.id] ?? [])
    .filter((line) => !QUIET.has(methodOf(line.argv)))
    .map((line) => ({ agent: agent.id, line })))
  flat.sort((a, b) => a.line.at - b.line.at)
  const clock = replayClock(flat.map(({ line }) => line))
  const events: MapEvent[] = []
  let duration = 0
  // Replay pacing: every call keeps its place in real order but gets a window
  // long enough to watch (MIN_CALL_S..MAX_CALL_S). One agent's calls that did
  // not overlap in reality do not overlap on the replay either; the push this
  // costs delays everything after it, so order across agents is kept.
  let shift = 0
  const lastOf = new Map<string, { realEnd: number, end: number }>()
  flat.forEach(({ agent, line }, index) => {
    const method = methodOf(line.argv)
    const target = targetsOf(line.argv)
    // Only an answered call adds a node: a refused `sandbox create` or mount
    // made nothing. A refused call still names (and lights) the nodes that exist.
    if (line.outcome === 'ok') {
      if (target.sandbox) { const box = sandbox(target.sandbox); if (target.machine) box.machine = target.machine }
      if (target.ws) workspace(target.ws, method === 'workspace.mount' ? target.branch : undefined)
      if (target.branch) branches.add(target.branch)
    } else {
      if (target.ws && !sandboxes.get(target.ws.split(':')[0])?.workspaces.some((w) => w.id === target.ws)) delete target.ws
      if (target.sandbox && !sandboxes.has(target.sandbox)) delete target.sandbox
      if (target.branch && !branches.has(target.branch)) delete target.branch
    }
    if (target.ws && !target.branch) {
      const ws = sandboxes.get(target.ws.split(':')[0])?.workspaces.find((w) => w.id === target.ws)
      if (ws?.branch) target.branch = ws.branch
    }
    if (method === 'sandbox.close' && line.outcome === 'ok' && target.sandbox) sandbox(target.sandbox).closed = true
    const ms = Math.max(0, line.ms)
    let start = clock(line.at) + shift
    const prev = lastOf.get(agent)
    if (prev && prev.realEnd <= line.at && start < prev.end + CALL_GAP_S) {
      shift += prev.end + CALL_GAP_S - start
      start = prev.end + CALL_GAP_S
    }
    const end = start + Math.min(MAX_CALL_S, Math.max(MIN_CALL_S, clock(line.at + ms) - clock(line.at)))
    lastOf.set(agent, { realEnd: line.at + ms, end })
    duration = Math.max(duration, end)
    events.push({
      id: `${agent}:${line.at}:${index}`, agent, method, outcome: line.outcome, at: line.at, ms: line.ms, start, end, argv: [...line.argv],
      ...(target.branch ? { branch: target.branch } : {}), ...(target.ws ? { ws: target.ws } : {}),
      ...(target.sandbox ? { sandbox: target.sandbox } : {}), ...(typeof line.dsh?.turn === 'number' ? { turn: line.dsh.turn } : {}),
      ...(line.tag ? { tag: line.tag } : {}), ...((line as { output?: boolean }).output ? { output: true } : {}),
    })
  })
  // The binding's workspace may have been mounted before the calls shown.
  for (const box of sandboxes.values()) for (const ws of box.workspaces) if (!ws.branch && ws.id === binding?.ws && binding.branch) ws.branch = binding.branch
  return { agents, branches: [...branches], sandboxes: [...sandboxes.values()], events, duration: events.length ? duration + FLASH_S : 0 }
}

/** How long a result travels back along the wires after a call ends, seconds. */
export const RESULT_S = 0.9
/** How long a wire stays green (or red) after its call; also the replay's tail, so it ends at rest. */
export const FLASH_S = 1.5
/** One lap of a request packet along its wires, seconds. */
export const LAP_S = 1.2

/**
 * Where a packet is at replay time `t` on a call's chain of wires, or null.
 * A request loops forward over the chain while the call runs; when it ends a
 * result runs the chain backwards once.
 * @returns the hop index (0-based, forward order), the fraction along that hop, and which kind of packet.
 */
export function packetAt(e: Pick<MapEvent, 'start' | 'end'>, t: number, hops: number): { hop: number, at: number, kind: 'request' | 'result' } | null {
  if (hops <= 0 || t < e.start) return null
  if (t < e.end) {
    const lap = ((t - e.start) / LAP_S) % 1
    const along = lap * hops
    const hop = Math.min(hops - 1, Math.floor(along))
    return { hop, at: along - hop, kind: 'request' }
  }
  if (t >= e.end + RESULT_S) return null
  const back = ((t - e.end) / RESULT_S) * hops
  const fromEnd = Math.min(hops - 1, Math.floor(back))
  return { hop: hops - 1 - fromEnd, at: 1 - (back - fromEnd), kind: 'result' }
}

/** The state of a map node at replay time `t`. */
export function activeAt(events: readonly MapEvent[], t: number): MapEvent[] {
  return events.filter((e) => e.start <= t && t < e.end)
}

/** The call that ended within `window` seconds before `t` and matches `match`. */
export function justEnded(events: readonly MapEvent[], t: number, match: (e: MapEvent) => boolean, window = 1.5): MapEvent | undefined {
  let found: MapEvent | undefined
  for (const e of events) if (e.end <= t && t - e.end < window && match(e) && (!found || e.end > found.end)) found = e
  return found
}

/** m:ss of replay seconds. */
export function stamp(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
