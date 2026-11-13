/**
 * The LayerFS trajectory's pure geometry (docs/specs/layerfs-trajectory.md):
 * filters, search, the timeline's lanes and the table's rows, kept free of
 * React so they are unit tested (test/trajectory-model.test.mjs).
 */
import { isWrite, shellCommand } from '../../shared/logs.ts'
import type {
  ToolRecord, TraceCheckpoint, TraceOp, TraceVersion, TrajectoryAnswer, TrajectoryRecord, TrajectoryTurn,
} from '../../shared/trajectory.ts'

/** Turns open by default: the newest few (older ones collapse so long sessions stay fast). */
export const OPEN_RECENT_TURNS = 3
/** Rows rendered before "Show more". */
export const ROW_PAGE = 400

// ---------------------------------------------------------------- selection

/** What the inspector shows: a record by seq, a checkpoint, an orphan call or a turn's host calls. */
export type Selection = `r:${number}` | `c:${number}:${number}` | `o:${string}` | `h:${number}`

export const recordKey = (seq: number): Selection => `r:${seq}`
export const checkpointKey = (turn: number, index: number): Selection => `c:${turn}:${index}`
export const orphanKey = (callId: string): Selection => `o:${callId}`
export const hostKey = (turn: number): Selection => `h:${turn}`

/** The tool record a focus request names: a bare call id (Chat's inspect), or JSON `{callId}` / `{seq}`. */
export function focusTarget(answer: TrajectoryAnswer, focus: string): { turn: number, record: TrajectoryRecord } | null {
  let callId: string | undefined = focus
  let seq: number | undefined
  if (focus.startsWith('{')) {
    try {
      const value = JSON.parse(focus) as { callId?: unknown, seq?: unknown }
      callId = typeof value.callId === 'string' ? value.callId : undefined
      seq = typeof value.seq === 'number' ? value.seq : undefined
    } catch { /* a bare id after all */ }
  }
  for (const turn of answer.turns) {
    for (const record of turn.records) {
      if (seq !== undefined ? record.seq === seq : record.kind === 'tool' && record.callId === callId) return { turn: turn.turn, record }
    }
  }
  return null
}

// ---------------------------------------------------------------- ops

/** A LayerFS call that wrote or named a version (reads without versions do not). */
export function opWrites(op: TraceOp): boolean {
  if (op.versions.length > 0) return true
  return isWrite(op.argv?.length ? op.argv : op.operation.split('.'))
}

/** DSH's own calls worth listing: writes, refusals and any call that named a version; reads are counted. */
export const shownHostOp = (op: TraceOp): boolean => op.outcome !== 'success' || opWrites(op)

/** The call as words: the redacted CLI argv, else `layerfs <family> <call>`. */
export const opCommand = (op: TraceOp): string =>
  op.argv?.length ? shellCommand(op.argv) : `layerfs ${op.operation.replace('.', ' ').replaceAll('_', '-')}`

export const opCreated = (op: TraceOp): boolean => op.versions.some((v) => v.effect === 'created')

/** Checkpoints that save the workspace (a start or restore only points at a version). */
export const SAVES: ReadonlySet<TraceCheckpoint['kind']> = new Set(['turn', 'manual', 'idle'])

/** A checkpoint's commit as a version chip, or null without one. */
export function checkpointVersion(checkpoint: TraceCheckpoint): TraceVersion | null {
  if (!checkpoint.commit) return null
  const effect = checkpoint.kind === 'restore' || checkpoint.kind === 'base' ? 'referenced' : checkpoint.changed > 0 ? 'created' : 'unchanged'
  return {
    kind: /^32[0-9a-f]{64}$/.test(checkpoint.commit) ? 'Layer' : 'Commit',
    id: checkpoint.commit, effect,
    ...(checkpoint.branch ? { branch: checkpoint.branch } : {}),
  }
}

// ---------------------------------------------------------------- filters

export interface TrajectoryFilter {
  /** Keep only tool calls (and orphan calls) with a LayerFS call that wrote or named a version. */
  onlyWrites: boolean
  /** Case-insensitive text match on records, LayerFS commands and checkpoint messages. */
  query: string
}

const norm = (s: string) => s.trim().toLowerCase()

/** True when a record's own words (text, name, summary, result) or its calls' commands contain `q`. */
export function recordMatches(record: TrajectoryRecord, q: string): boolean {
  if (!q) return true
  const has = (s: string | undefined) => !!s && s.toLowerCase().includes(q)
  if (record.kind === 'tool') return has(record.name) || has(record.summary) || has(record.result) || has(record.callId) || record.ops.some((op) => has(opCommand(op)))
  if (record.kind === 'user' || record.kind === 'context') return has(record.text) || (record.kind === 'context' && has(record.source))
  return has(record.text)
}

const toolWrites = (record: ToolRecord) => record.ops.some(opWrites)

/** The turns with only what the filter keeps; turns left empty are dropped. Unfiltered turns are returned as is. */
export function filterTurns(turns: readonly TrajectoryTurn[], filter: TrajectoryFilter): TrajectoryTurn[] {
  const q = norm(filter.query)
  if (!q && !filter.onlyWrites) return turns.slice()
  const out: TrajectoryTurn[] = []
  for (const turn of turns) {
    const records = turn.records.filter((r) => (!filter.onlyWrites || (r.kind === 'tool' && toolWrites(r))) && recordMatches(r, q))
    const orphanCalls = turn.orphanCalls.filter((c) => (!filter.onlyWrites || c.ops.some(opWrites))
      && (!q || c.callId.toLowerCase().includes(q) || c.ops.some((op) => opCommand(op).toLowerCase().includes(q))))
    const hostOps = turn.hostOps.filter((op) => (!filter.onlyWrites || shownHostOp(op)) && (!q || opCommand(op).toLowerCase().includes(q)))
    const checkpoints = turn.checkpoints.filter((c) => !q || c.message.toLowerCase().includes(q) || c.kind.includes(q))
    if (records.length || orphanCalls.length || hostOps.length || checkpoints.length) out.push({ ...turn, records, orphanCalls, hostOps, checkpoints })
  }
  return out
}

// ---------------------------------------------------------------- timeline

export type Lane = 'input' | 'model' | 'tools' | 'layerfs'
export const LANES: readonly Lane[] = ['input', 'model', 'tools', 'layerfs']

export interface LaneItem {
  lane: Lane
  /** Unique within the strip. */
  key: string
  /** What clicking it selects; absent when nothing can be shown for it. */
  select?: Selection
  start: number
  /** Equal to `start` for a point. */
  end: number
  /** `created`: a new version; `refused`: a refused call or a failed tool; `running`: still open. */
  tone?: 'created' | 'refused' | 'running'
  /** One line for its tooltip. */
  label: string
}

/** Every time the answer holds, plus `now` when something is still running. */
export function timeSpan(turns: readonly TrajectoryTurn[], now: number): { start: number, end: number } | null {
  let start = Infinity, end = -Infinity
  const see = (at: number | undefined) => { if (typeof at === 'number' && Number.isFinite(at)) { if (at < start) start = at; if (at > end) end = at } }
  for (const turn of turns) {
    see(turn.at); see(turn.endAt)
    for (const r of turn.records) {
      see(r.at)
      if (r.kind === 'assistant') see(r.startedAt)
      if (r.kind === 'tool') { see(r.endedAt); if (r.endedAt === undefined && r.at !== undefined) see(now); r.ops.forEach((op) => see(op.at)) }
    }
    turn.orphanCalls.forEach((c) => c.ops.forEach((op) => see(op.at)))
    turn.hostOps.forEach((op) => see(op.at))
    turn.checkpoints.forEach((c) => see(c.at))
  }
  if (start === Infinity) return null
  // A single instant still needs a width.
  if (end - start < 1000) end = start + 1000
  return { start, end }
}

const opTone = (op: TraceOp): LaneItem['tone'] => opCreated(op) ? 'created' : op.outcome !== 'success' ? 'refused' : undefined

/** The strip's marks: user records, model steps, tool calls, and one tick per LayerFS call or checkpoint. */
export function laneItems(turns: readonly TrajectoryTurn[], now: number): LaneItem[] {
  const items: LaneItem[] = []
  const tick = (key: string, at: number | undefined, tone: LaneItem['tone'], label: string, select?: Selection) => {
    if (at === undefined) return
    items.push({ lane: 'layerfs', key, start: at, end: at, label, ...(tone ? { tone } : {}), ...(select ? { select } : {}) })
  }
  for (const turn of turns) {
    for (const r of turn.records) {
      const select = recordKey(r.seq)
      if (r.at === undefined) continue
      if (r.kind === 'user') items.push({ lane: 'input', key: `r${r.seq}`, select, start: r.at, end: r.at, label: r.text })
      else if (r.kind === 'assistant') items.push({ lane: 'model', key: `r${r.seq}`, select, start: Math.min(r.startedAt ?? r.at, r.at), end: r.at, label: r.text })
      else if (r.kind === 'tool') {
        const running = r.endedAt === undefined && r.result === undefined
        const end = r.endedAt ?? (running ? Math.max(now, r.at) : r.at)
        items.push({ lane: 'tools', key: `r${r.seq}`, select, start: r.at, end, label: r.summary ? `${r.name} ${r.summary}` : r.name, ...(running ? { tone: 'running' as const } : r.isError ? { tone: 'refused' as const } : {}) })
        for (const op of r.ops) tick(`op${op.id}`, op.at, opTone(op), opCommand(op), select)
      }
    }
    for (const call of turn.orphanCalls) for (const op of call.ops) tick(`op${op.id}`, op.at, opTone(op), opCommand(op), orphanKey(call.callId))
    for (const op of turn.hostOps) tick(`op${op.id}`, op.at, opTone(op), opCommand(op), hostKey(turn.turn))
    turn.checkpoints.forEach((c, i) => {
      const v = checkpointVersion(c)
      tick(`cp${turn.turn}:${i}`, c.at, c.error ? 'refused' : v?.effect === 'created' ? 'created' : undefined, c.message, checkpointKey(turn.turn, i))
    })
  }
  return items
}

/** Left and width of an item, in percent of the span (a point gets width 0). */
export function place(item: { start: number, end: number }, span: { start: number, end: number }): { left: number, width: number } {
  const total = span.end - span.start || 1
  const clamp = (v: number) => Math.min(100, Math.max(0, v))
  const left = clamp(((item.start - span.start) / total) * 100)
  const right = clamp(((item.end - span.start) / total) * 100)
  return { left, width: Math.max(0, right - left) }
}

// ---------------------------------------------------------------- rows

export type Row =
  | { type: 'turn', key: string, turn: TrajectoryTurn, open: boolean }
  | { type: 'contextToggle', key: string, turn: number, count: number, open: boolean }
  | { type: 'record', key: Selection, turn: number, record: TrajectoryRecord, open: boolean }
  | { type: 'op', key: string, turn: number, op: TraceOp, parent: Selection }
  | { type: 'orphan', key: Selection, turn: number, callId: string, ops: TraceOp[] }
  | { type: 'host', key: Selection, turn: number, shown: TraceOp[], reads: number }
  | { type: 'checkpoint', key: Selection, turn: number, checkpoint: TraceCheckpoint }

export interface Expansion {
  /** Whether a turn's rows show. */
  turnOpen: (turn: number) => boolean
  /** Whether a tool call's LayerFS sub-rows show. */
  callOpen: (record: ToolRecord) => boolean
  /** Whether a turn's context messages show. */
  contextOpen: (turn: number) => boolean
}

/** Default turn state: the newest {@link OPEN_RECENT_TURNS} turns open. */
export function recentTurns(turns: readonly TrajectoryTurn[]): Set<number> {
  return new Set(turns.slice(-OPEN_RECENT_TURNS).map((t) => t.turn))
}

/**
 * The table's rows, in order: per turn its header, then (when open) its records
 * with each tool call's LayerFS calls, its orphan calls, DSH's own calls and
 * its checkpoints. Context messages fold behind one toggle per turn, placed
 * where the first one is; `revealContext` (a search) shows them in place.
 */
export function flattenRows(turns: readonly TrajectoryTurn[], expansion: Expansion, revealContext = false): Row[] {
  const rows: Row[] = []
  for (const turn of turns) {
    const open = expansion.turnOpen(turn.turn)
    rows.push({ type: 'turn', key: `t:${turn.turn}`, turn, open })
    if (!open) continue
    const contexts = turn.records.filter((r) => r.kind === 'context').length
    const contextOpen = revealContext || expansion.contextOpen(turn.turn)
    let toggled = false
    for (const record of turn.records) {
      if (record.kind === 'context' && !revealContext) {
        if (!toggled) { rows.push({ type: 'contextToggle', key: `x:${turn.turn}`, turn: turn.turn, count: contexts, open: contextOpen }); toggled = true }
        if (!contextOpen) continue
      }
      const key = recordKey(record.seq)
      const callOpen = record.kind === 'tool' && record.ops.length > 0 && expansion.callOpen(record)
      rows.push({ type: 'record', key, turn: turn.turn, record, open: callOpen })
      if (callOpen && record.kind === 'tool') for (const op of record.ops) rows.push({ type: 'op', key: `${key}:${op.id}`, turn: turn.turn, op, parent: key })
    }
    for (const call of turn.orphanCalls) rows.push({ type: 'orphan', key: orphanKey(call.callId), turn: turn.turn, callId: call.callId, ops: call.ops })
    if (turn.hostOps.length) {
      const shown = turn.hostOps.filter(shownHostOp)
      rows.push({ type: 'host', key: hostKey(turn.turn), turn: turn.turn, shown, reads: turn.hostOps.length - shown.length })
    }
    turn.checkpoints.forEach((checkpoint, i) => rows.push({ type: 'checkpoint', key: checkpointKey(turn.turn, i), turn: turn.turn, checkpoint }))
  }
  return rows
}

// ---------------------------------------------------------------- formatting

/** A duration as a unit and its numbers, for the caller's words: `ms` <1 s, `s` <60 s, else `m` (minutes, seconds). */
export function durationParts(ms: number): { unit: 'ms', n: number } | { unit: 's', n: string } | { unit: 'm', m: number, s: number } {
  const v = Math.max(0, Math.round(ms))
  if (v < 1000) return { unit: 'ms', n: v }
  if (v < 60_000) return { unit: 's', n: (v / 1000).toFixed(v < 10_000 ? 1 : 0) }
  const total = Math.round(v / 1000)
  return { unit: 'm', m: Math.floor(total / 60), s: total % 60 }
}

/** Arguments pretty-printed when they are JSON, else as sent. */
export function prettyArgs(raw: string | undefined): string {
  if (!raw) return ''
  try { return JSON.stringify(JSON.parse(raw), null, 2) } catch { return raw }
}

/** Where a selection lives, for opening its turn. */
export function selectionTurn(answer: TrajectoryAnswer, key: Selection): number | null {
  const [kind, a] = key.split(':')
  if (kind === 'c' || kind === 'h') return Number(a)
  for (const turn of answer.turns) {
    if (kind === 'r' && turn.records.some((r) => r.seq === Number(a))) return turn.turn
    if (kind === 'o' && turn.orphanCalls.some((c) => c.callId === key.slice(2))) return turn.turn
  }
  return null
}
