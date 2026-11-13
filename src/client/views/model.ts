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
  /** A depth-0 agent listed in this head's group instead of heading its own. */
  joins?: string
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
/** The Sandboxes open at `at` (a project's `/api/projects/<key>/sandboxes`, read then), as the map reads them. */
export interface LiveSandboxes {
  /** When the list was read, ms since the epoch. */
  at: number
  sandboxes: readonly { name: string, machine?: string | null, workspaces: readonly { id: string, branch?: string }[] }[]
}
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
 * @param live - the Sandboxes open now, when known (a project's page): they
 *   and their workspaces are always shown, and a Sandbox the calls name that
 *   is not among them is closed, unless a call on it is newer than the list.
 */
export function buildSandboxMap(agents: MapAgent[], binding: MapBinding | null, calls: Readonly<Record<string, readonly (CallLine & { dsh?: { turn?: number } })[]>>, live?: LiveSandboxes): SandboxMapModel {
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
  for (const open of live?.sandboxes ?? []) {
    const box = sandbox(open.name)
    if (open.machine) box.machine = open.machine
    for (const ws of open.workspaces) workspace(ws.id, ws.branch)
  }

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
    if (line.outcome === 'ok' && target.sandbox && (method === 'sandbox.close' || method === 'sandbox.create')) sandbox(target.sandbox).closed = method === 'sandbox.close'
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
  if (live) {
    const open = new Set(live.sandboxes.map((b) => b.name))
    const newest = new Map<string, number>()
    for (const e of events) if (e.sandbox) newest.set(e.sandbox, Math.max(newest.get(e.sandbox) ?? 0, e.at))
    for (const box of sandboxes.values()) if (!open.has(box.name) && (newest.get(box.name) ?? 0) < live.at) box.closed = true
  }
  return { agents, branches: [...branches], sandboxes: [...sandboxes.values()], events, duration: events.length ? duration + TAIL_S : 0 }
}

/** How long a result travels back along the wires after a call ends, seconds. */
export const RESULT_S = 0.9
/** How long a chain keeps its result colour (fading) once the result is home, seconds. */
export const FLASH_S = 1.5
/** The replay's tail after the last call, so it ends at rest. */
export const TAIL_S = RESULT_S + FLASH_S
/** How long an arrival ripple lasts, seconds. */
export const RIPPLE_S = 0.8

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
/** Cubic ease in and out on [0, 1]. */
export const easeInOut = (k: number) => k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2
/** Cubic ease out on [0, 1]. */
export const easeOut = (k: number) => 1 - (1 - k) ** 3

/** How long a request takes to reach its target: long enough to read, never more than half the call. */
export function requestS(e: Pick<MapEvent, 'start' | 'end'>, reduced = false): number {
  return reduced ? 0 : clamp((e.end - e.start) * 0.4, 0.55, 1.05)
}

/** Where a call is at replay time `t`. */
export type Phase =
  /** Travelling out: `u` 0→1 along the call's chain. */
  | { kind: 'request', u: number }
  /** Arrived; the call runs. `since` is the time since arrival. */
  | { kind: 'held', u: 1, since: number }
  /** The result travels back: `u` 1→0. */
  | { kind: 'result', u: number }
  /** The result is home; its colour fades (`f` 1→0). */
  | { kind: 'flash', u: 0, f: number }

/**
 * The phase of a call at replay time `t`, or null before it starts and after
 * its flash. Each call travels once: a request goes out, holds while the call
 * runs, its result comes back, and the chain fades. With reduced motion there
 * is no travel and no fade: the chain shows its result colour for the tail.
 */
export function phaseOf(e: Pick<MapEvent, 'start' | 'end'>, t: number, reduced = false): Phase | null {
  if (t < e.start) return null
  const arrive = e.start + requestS(e, reduced)
  if (t < arrive) return { kind: 'request', u: easeInOut((t - e.start) / (arrive - e.start)) }
  if (t < e.end) return { kind: 'held', u: 1, since: t - arrive }
  if (reduced) return t < e.end + TAIL_S ? { kind: 'flash', u: 0, f: 1 } : null
  if (t < e.end + RESULT_S) return { kind: 'result', u: 1 - easeInOut((t - e.end) / RESULT_S) }
  if (t < e.end + TAIL_S) return { kind: 'flash', u: 0, f: 1 - (t - e.end - RESULT_S) / FLASH_S }
  return null
}

/** A ripple started at `at`: its progress in [0, 1), or null outside it. */
export function rippleAt(t: number, at: number): number | null {
  const k = (t - at) / RIPPLE_S
  return k >= 0 && k < 1 ? k : null
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

/**
 * Whether workspace `ws` is on the map at replay time `t`: from the start of
 * its latest mount at or before `t` (always, when no mount is in the calls)
 * until an unmount after that mount ends.
 */
export function mountedAt(events: readonly MapEvent[], ws: string, t: number): boolean {
  let mount: MapEvent | undefined, unmount: MapEvent | undefined, firstMount: MapEvent | undefined
  for (const e of events) {
    if (e.ws !== ws || e.outcome !== 'ok') continue
    if (e.method === 'workspace.mount') { firstMount ??= e; if (e.start <= t) mount = e }
    else if (e.method === 'workspace.unmount' && e.end <= t) unmount = e
  }
  if (firstMount && !mount) return false
  return !unmount || (!!mount && mount.start > unmount.start)
}

/** m:ss of replay seconds. */
export function stamp(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * What ran in the workspace, when the tool call is one plain `layerfs
 * workspace exec <ws> '<command>'`: the inner command (the CLI and workspace
 * words are the same on every line). Anything else stays as typed.
 */
export function innerCommand(command: string): string {
  const m = /^\s*(?:"\$\{?DSH_LAYERFS_CLI\}?"|\$\{?DSH_LAYERFS_CLI\}?|layerfs)\s+workspace\s+exec\s+(?:"[^"]*"|'[^']*'|\S+)\s+(?:--\s+)?('(?:[^']|'\\'')*'|"(?:[^"\\]|\\.)*")(?:\s+--stream)?\s*$/.exec(command)
  if (!m) return command
  const q = m[1]
  return q.startsWith("'") ? q.slice(1, -1).replaceAll("'\\''", "'") : q.slice(1, -1).replace(/\\(.)/g, '$1')
}

const CLI_VAR = /"\$\{?DSH_LAYERFS_CLI\}?"|\$\{?DSH_LAYERFS_CLI\}?/g
const WS_VAR = /"\$\{?DSH_LAYERFS_WS\}?"|\$\{?DSH_LAYERFS_WS\}?/g

/**
 * A command as a terminal should show it: each plain `workspace exec`
 * reduced to what it ran ({@link innerCommand}), the plugin's variables
 * replaced (`$DSH_LAYERFS_CLI` → `layerfs`, `$DSH_LAYERFS_WS` → the
 * workspace's name) and `--stream` dropped.
 */
export function sanitizeCommand(command: string, wsName: string): string {
  return command.split('\n').map((line) => topLevelAnd(line)
    // The plugin's own guard that the workspace is set says nothing about what ran.
    .filter((part) => !/^test\s+-n\s+("\$\{?DSH_LAYERFS_WS\}?"|\$\{?DSH_LAYERFS_WS\}?)$/.test(part))
    .map((part) => {
      const inner = innerCommand(part)
      return inner !== part ? inner : part.replace(CLI_VAR, 'layerfs').replace(WS_VAR, wsName).replace(/\s+--stream(?=\s|$)/g, '')
    })
    .join(' && ')).join('\n').trim()
}

/** A shell line split at `&&` outside quotes, each part trimmed. */
function topLevelAnd(line: string): string[] {
  const parts: string[] = []
  let quote: string | null = null, start = 0
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) { if (c === quote) quote = null; else if (c === '\\' && quote === '"') i++; continue }
    if (c === "'" || c === '"') quote = c
    else if (c === '\\') i++
    else if (c === '&' && line[i + 1] === '&') { parts.push(line.slice(start, i).trim()); start = i + 2; i++ }
  }
  parts.push(line.slice(start).trim())
  return parts.filter(Boolean)
}

/** The command words of a logged `workspace exec`, or null when the log redacted them. */
export function execWords(argv: readonly string[]): string | null {
  const words = argv.slice(3).filter((w) => w !== '--' && w !== '--stream')
  return words.length && !words.some((w) => w.startsWith('<')) ? words.join(' ') : null
}
