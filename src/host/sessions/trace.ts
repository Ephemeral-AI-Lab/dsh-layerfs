/**
 * The LayerFS trajectory of one project session (docs/specs/layerfs-trajectory.md):
 * the session log's user, context and assistant records and tool calls by turn,
 * tool calls joined to the session's receipts (`layerfs.json` `invocations[]`)
 * by tool call id, checkpoints to their save by receipt id. Pure; the
 * `session.trajectory` and `session.trajectory.record` ops feed it.
 */
import type { TraceCheckpoint, TraceOp, TraceVersion } from '../../shared/trace.ts'
import {
  DETAIL_MAX, PREVIEW_MAX,
  type AssistantRecord, type ToolRecord, type TrajectoryAnswer, type TrajectoryDetail, type TrajectoryTurn, type UserRecord,
} from '../../shared/trajectory.ts'

export interface TrajectoryInput {
  sessionId: string
  project: string | null
  /** The session's current Branch. */
  branch: string | null
  /** The DSH session log (`snapshotEvents(0)`), or undefined when not loaded. */
  events?: readonly any[]
  /** Receipts from the sidecar, oldest first. */
  invocations: readonly any[]
  /** Checkpoints, oldest first. */
  checkpoints: readonly any[]
}

const SUMMARY_MAX = 200
/** Argument fields that best say what a call does, in order. */
const SUMMARY_KEYS = ['command', 'cmd', 'path', 'file_path', 'pattern', 'query', 'url', 'description', 'prompt']

const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined
const finite = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined
const clip = (value: string): string => {
  const line = value.replace(/\s+/g, ' ').trim()
  return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX - 1)}…` : line
}

/** One line of a tool call's arguments: its command, path or first text field. */
export function summarize(args: unknown): string | undefined {
  if (typeof args !== 'string' || !args.trim()) return undefined
  let value: any
  try { value = JSON.parse(args) } catch { return clip(args) }
  if (!value || typeof value !== 'object') return text(String(value)) ? clip(String(value)) : undefined
  for (const key of SUMMARY_KEYS) if (text(value[key])) return clip(value[key])
  for (const field of Object.values(value)) if (text(field)) return clip(field as string)
  return undefined
}

/** A positional CLI word that names something (not a redaction placeholder). */
const word = (value: unknown): string | undefined => {
  const w = text(value)
  return w && !w.startsWith('<') && !w.startsWith('-') ? w : undefined
}

/**
 * The Branch to open a version on. Receipts written before versions carried a
 * Branch are read through their call: `file.*` name it, `branch merge|fork`
 * name the new one (a fork's referenced Commit sits on its source), a Layer is
 * on `main`, and a `workspace commit` saves to the session's Branch at that time
 * (the checkpoint it made, else the last checkpoint before it, else the current one).
 */
export function versionBranch(version: { kind: string, branch?: unknown }, receipt: any, checkpoints: readonly any[], current: string | null): string | undefined {
  if (word(version.branch)) return version.branch as string
  if (version.kind === 'Layer') return 'main'
  const argv: unknown[] = Array.isArray(receipt?.argv) ? receipt.argv : []
  const operation = String(receipt?.operation ?? '')
  if (operation.startsWith('file.')) return word(argv[3])
  if (operation === 'branch.merge') return word(argv[3])
  if (operation === 'branch.fork') return word(argv[4]) ?? word(argv[3])
  const own = checkpoints.find((c) => c?.receipt && c.receipt === receipt?.id)
  if (word(own?.branch)) return own.branch
  const at = finite(receipt?.at) ?? Number.POSITIVE_INFINITY
  let before: string | undefined
  for (const c of checkpoints) if (word(c?.branch) && finite(c?.at) !== undefined && c.at <= at) before = c.branch
  return before ?? current ?? undefined
}

export function toOp(receipt: any, checkpoints: readonly any[], current: string | null): TraceOp {
  const versions: TraceVersion[] = []
  for (const v of Array.isArray(receipt?.versions) ? receipt.versions : []) {
    if (!v || (v.kind !== 'Commit' && v.kind !== 'Layer') || !text(v.id) || !['created', 'unchanged', 'referenced'].includes(v.effect)) continue
    const branch = versionBranch(v, receipt, checkpoints, current)
    versions.push({ kind: v.kind, id: v.id, effect: v.effect, ...(branch ? { branch } : {}) })
  }
  return {
    id: String(receipt.id),
    origin: receipt.origin === 'host' ? 'host' : 'tool',
    operation: text(receipt.operation) ?? '?',
    ...(Array.isArray(receipt.argv) ? { argv: receipt.argv.filter((w: unknown) => typeof w === 'string') } : {}),
    outcome: receipt.outcome === 'success' || receipt.outcome === 'refusal' ? receipt.outcome : 'unknown',
    ...(text(receipt.code) ? { code: receipt.code } : {}),
    ...(text(receipt.kind) ? { kind: receipt.kind } : {}),
    ...(finite(receipt.at) !== undefined ? { at: receipt.at } : {}),
    ...(finite(receipt.ms) !== undefined ? { ms: receipt.ms } : {}),
    ...(receipt.exit === null || Number.isInteger(receipt.exit) ? { exit: receipt.exit } : {}),
    versions,
  }
}

/** Text blocks of a message's content, in order. */
function blocks(content: unknown, type: 'text' | 'reasoning'): string[] {
  const out: string[] = []
  if (Array.isArray(content)) for (const b of content) if (b?.type === type && typeof b.text === 'string') out.push(b.text)
  return out
}

/**
 * One line of `parts` (whitespace runs collapsed to one space, ends trimmed),
 * at most {@link PREVIEW_MAX} characters. Reads only as far as the preview
 * reaches, so a huge result costs no more than a short one.
 */
function preview(parts: readonly string[]): { text: string, truncated: boolean } {
  let out = ''
  let space = false
  for (const part of parts) {
    // Parts are joined by whitespace.
    if (out) space = true
    for (let i = 0; i < part.length; i++) {
      const ch = part[i]!
      if (/\s/.test(ch)) { if (out) space = true; continue }
      if (space) { out += ' '; space = false }
      out += ch
      if (out.length > PREVIEW_MAX) return { text: `${out.slice(0, PREVIEW_MAX - 1)}…`, truncated: true }
    }
  }
  return { text: out, truncated: false }
}

const stepKey = (turn: unknown, step: unknown): string => `${turn}:${step}`
const integer = (value: unknown): number | undefined => Number.isInteger(value) ? value as number : undefined

type ToolEntry = ToolRecord & { turn: number }

/**
 * The session's trajectory, one pass over the log. Turn attribution: assistant,
 * tool and step events carry their `turn`. A `user/message` carries none: it
 * belongs to the turn open at that point (between its `turn/start` and
 * `turn/end`; DSH logs a turn's input right after its `turn/start`). One logged
 * outside any open turn belongs to the next turn to open; at the log's end, with
 * no next `turn/start` yet, that is the last logged turn + 1 (turn 1 when none).
 */
export function buildTrajectory(input: TrajectoryInput): TrajectoryAnswer {
  const { checkpoints, branch } = input
  const turns = new Map<number, TrajectoryTurn>()
  const turn = (n: number): TrajectoryTurn => {
    let t = turns.get(n)
    if (!t) turns.set(n, t = { turn: n, records: [], orphanCalls: [], hostOps: [], checkpoints: [] })
    return t
  }
  const tools = new Map<string, ToolEntry>()
  const stepStarts = new Map<string, number>()
  let open: number | undefined
  let last: number | undefined
  let pending: UserRecord[] = []
  for (const event of input.events ?? []) {
    const type = event?.type
    const data = event?.data
    const seq = integer(event?.seq)
    const at = finite(event?.time)
    if (type === 'turn/start') {
      const n = integer(data?.turn)
      if (n === undefined) continue
      const t = turn(n)
      t.at ??= at
      open = last = n
      if (pending.length) { for (const r of pending) { r.turn = n; t.records.push(r) } pending = [] }
    } else if (type === 'turn/end') {
      const n = integer(data?.turn)
      if (n === undefined) continue
      const t = turn(n)
      if (at !== undefined) t.endAt = at
      if (open === n) open = undefined
      last = Math.max(last ?? n, n)
    } else if (type === 'step/start') {
      if (at !== undefined && integer(data?.turn) !== undefined) stepStarts.set(stepKey(data.turn, data.step), at)
    } else if (type === 'user/message') {
      if (seq === undefined || !data) continue
      const kind = text(data.source?.kind) ?? 'unknown'
      const p = preview(blocks(data.content, 'text'))
      const record: UserRecord = {
        kind: kind === 'user' ? 'user' : 'context', seq, turn: open ?? 0, source: kind,
        ...(at !== undefined ? { at } : {}), text: p.text, ...(p.truncated ? { truncated: true } : {}),
      }
      if (open !== undefined) turn(open).records.push(record)
      else pending.push(record)
    } else if (type === 'assistant/message') {
      const n = integer(data?.turn)
      if (seq === undefined || n === undefined) continue
      const content = data.message?.content
      const p = preview(blocks(content, 'text'))
      const toolCalls = Array.isArray(content) ? content.filter((b: any) => b?.type === 'tool-call').length : 0
      const step = integer(data.step)
      const startedAt = step !== undefined ? stepStarts.get(stepKey(n, step)) : undefined
      const record: AssistantRecord = {
        kind: 'assistant', seq, turn: n, ...(step !== undefined ? { step } : {}), ...(at !== undefined ? { at } : {}),
        text: p.text, ...(p.truncated ? { truncated: true } : {}),
        ...(blocks(content, 'reasoning').length ? { thinking: true } : {}),
        toolCalls, ...(startedAt !== undefined ? { startedAt } : {}), ...(data.interrupted === true ? { interrupted: true } : {}),
      }
      turn(n).records.push(record)
    } else if (type === 'tool/call') {
      const n = integer(data?.turn)
      if (seq === undefined || n === undefined || !text(data.callId) || tools.has(data.callId)) continue
      const step = integer(data.step)
      const summary = summarize(data.arguments)
      const record: ToolEntry = {
        kind: 'tool', seq, turn: n, ...(step !== undefined ? { step } : {}), ...(at !== undefined ? { at } : {}),
        callId: data.callId, name: text(data.name) ?? '?', ...(summary ? { summary } : {}), ops: [],
      }
      tools.set(data.callId, record)
      turn(n).records.push(record)
    } else if (type === 'tool/result') {
      const record = tools.get(data?.message?.toolCallId)
      if (!record || record.resultSeq !== undefined) continue
      const p = preview(blocks(data.message.content, 'text'))
      record.result = p.text
      if (p.truncated) record.resultTruncated = true
      if (data.message.isError === true) record.isError = true
      if (seq !== undefined) record.resultSeq = seq
      if (at !== undefined) record.endedAt = at
    }
  }
  if (pending.length) {
    const n = (last ?? 0) + 1
    const t = turn(n)
    for (const r of pending) { r.turn = n; t.records.push(r) }
  }

  const byReceipt = new Map<string, TraceCheckpoint>()
  for (const c of checkpoints) {
    if (!c || !Number.isInteger(c.turn)) continue
    const checkpoint: TraceCheckpoint = {
      kind: c.kind, commit: text(c.commit) ?? null, branch: text(c.branch) ?? null, changed: Number(c.changed) || 0,
      message: String(c.message ?? ''), at: Number(c.at) || 0,
      ...(c.error && text(c.error.code) ? { error: { code: c.error.code, message: String(c.error.message ?? '') } } : {}),
    }
    turn(c.turn).checkpoints.push(checkpoint)
    if (text(c.receipt)) byReceipt.set(c.receipt, checkpoint)
  }
  const orphans = new Map<string, { callId: string, ops: TraceOp[] }>()
  for (const receipt of input.invocations) {
    if (!receipt || typeof receipt !== 'object' || !text(receipt.id)) continue
    if (text(receipt.sessionId) && receipt.sessionId !== input.sessionId) continue
    const op = toOp(receipt, checkpoints, branch)
    const n = integer(receipt.turn) ?? 0
    if (text(receipt.toolCallId)) {
      const record = tools.get(receipt.toolCallId)
      if (record) { record.ops.push(op); continue }
      let orphan = orphans.get(receipt.toolCallId)
      if (!orphan) {
        orphans.set(receipt.toolCallId, orphan = { callId: receipt.toolCallId, ops: [] })
        turn(n).orphanCalls.push(orphan)
      }
      orphan.ops.push(op)
      continue
    }
    const checkpoint = byReceipt.get(op.id)
    if (checkpoint) checkpoint.op = op
    else turn(n).hostOps.push(op)
  }

  const created = new Set<string>()
  let callsWithVersions = 0
  const count = (ops: readonly TraceOp[]): void => {
    let any = false
    for (const op of ops) for (const v of op.versions) if (v.effect === 'created') { created.add(v.id); any = true }
    if (any) callsWithVersions++
  }
  for (const record of tools.values()) count(record.ops)
  for (const orphan of orphans.values()) count(orphan.ops)

  return {
    sessionId: input.sessionId, project: input.project, branch,
    turns: [...turns.values()].sort((a, b) => a.turn - b.turn),
    logLoaded: input.events !== undefined,
    counts: { versionsCreated: created.size, callsWithVersions },
  }
}

/** `value` cut at {@link DETAIL_MAX}; `field` noted in `cut` when it was. */
function full<F extends string>(value: string, field: F, cut: F[]): string {
  if (value.length <= DETAIL_MAX) return value
  cut.push(field)
  return value.slice(0, DETAIL_MAX)
}

/**
 * One record in full: `seq` is a `user/message` or `assistant/message` seq, or
 * a tool record's `tool/call` seq. Undefined when the log holds no such record.
 */
export function trajectoryDetail(events: readonly any[] | undefined, seq: number): TrajectoryDetail | undefined {
  if (!events || !Number.isInteger(seq)) return undefined
  let call: any
  for (const event of events) {
    if (call) {
      if (event?.type === 'tool/result' && event.data?.message?.toolCallId === call.callId) {
        const cut: ('args' | 'result')[] = []
        const args = full(typeof call.arguments === 'string' ? call.arguments : '', 'args', cut)
        const result = full(blocks(event.data.message.content, 'text').join('\n'), 'result', cut)
        return { seq, kind: 'tool', args, result, ...(cut.length ? { truncated: cut } : {}) }
      }
      continue
    }
    if (event?.seq !== seq) continue
    const data = event.data
    if (event.type === 'user/message' && data) {
      const cut: 'text'[] = []
      const value = full(blocks(data.content, 'text').join('\n'), 'text', cut)
      return { seq, kind: data.source?.kind === 'user' ? 'user' : 'context', text: value, ...(cut.length ? { truncated: cut } : {}) }
    }
    if (event.type === 'assistant/message' && Number.isInteger(data?.turn)) {
      const cut: ('text' | 'thinking')[] = []
      const value = full(blocks(data.message?.content, 'text').join('\n'), 'text', cut)
      const reasoning = blocks(data.message?.content, 'reasoning')
      const thinking = reasoning.length ? full(reasoning.join('\n'), 'thinking', cut) : undefined
      return { seq, kind: 'assistant', text: value, ...(thinking !== undefined ? { thinking } : {}), ...(cut.length ? { truncated: cut } : {}) }
    }
    if (event.type === 'tool/call' && text(data?.callId) && Number.isInteger(data?.turn)) { call = data; continue }
    return undefined
  }
  if (!call) return undefined
  // Still running: arguments only.
  const cut: 'args'[] = []
  const args = full(typeof call.arguments === 'string' ? call.arguments : '', 'args', cut)
  return { seq, kind: 'tool', args, ...(cut.length ? { truncated: cut } : {}) }
}

