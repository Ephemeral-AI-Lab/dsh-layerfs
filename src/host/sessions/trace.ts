/**
 * The LayerFS trajectory of one project session (docs/specs/layerfs-trajectory.md):
 * the session log's user, context and assistant records and tool calls by turn,
 * tool calls joined to the session's receipts (`layerfs.json` `invocations[]`)
 * by tool call id, checkpoints to their save by receipt id. Pure; the
 * `session.trajectory` and `session.trajectory.record` ops feed it.
 */
import type { TraceCheckpoint, TraceOp, TraceVersion } from '../../shared/trace.ts'
import {
  DETAIL_MAX, FIRST_PAGE_BYTES, FIRST_PAGE_OPS, FIRST_PAGE_RECORDS, MAX_OPS, MAX_RECORDS, MAX_RECORD_OPS,
  PREVIEW_MAX, TOOL_DESCRIPTION_MAX, displayKind, kindFamily,
  type AssistantRecord, type RequestRecord, type SystemRecord, type ToolRecord, type ToolsChange, type TrajectoryAnswer,
  type TrajectoryDetail, type TrajectoryRecord, type TrajectoryReply, type TrajectoryTool, type TrajectoryTurn, type TrajectoryUsage,
  type UserRecord, type ObservationRecord, type ReceiptMeta,
  RECEIPT_META_FIELD, receiptAggregateLines,
} from '../../shared/trajectory.ts'
import { isWrite } from '../../shared/logs.ts'
import { promptChanges } from './prompt-diff.ts'

export interface TrajectoryInput {
  sessionId: string
  project: string | null
  /** The session's current Branch. */
  branch: string | null
  /** The DSH session log (`snapshotEvents(0)`), or undefined when not loaded. */
  events?: readonly any[]
  /** Receipts from the sidecar, oldest first. */
  invocations: readonly any[]
  /** The sidecar's read-only receipt counter, when one was folded. */
  receipts?: ReceiptMeta
  /** Checkpoints, oldest first. */
  checkpoints: readonly any[]
}

/**
 * The counter an input carries: explicit, or attached (non-enumerably) to the
 * receipts array by persistence. `sessions/index.ts` hands the trajectory only
 * the array, so both channels are read; prefer the explicit field when a caller
 * can pass it.
 */
function receiptCounts(input: TrajectoryInput): ReceiptMeta | undefined {
  const attached = (input.invocations as any)?.[RECEIPT_META_FIELD] as ReceiptMeta | undefined
  const counts = input.receipts ?? attached
  return counts && typeof counts === 'object' ? counts : undefined
}

/**
 * A cheap identity of what `buildTrajectory` would read: the log's length and
 * last seq, the Branch, and the checkpoint and receipt tails. Reading it is
 * O(1) over the loaded log and metadata (no walk, no serialization), so an
 * unchanged `session.trajectory` is answered without building or sending the
 * records. Any new event, checkpoint or receipt, a Branch change, a different
 * project or a log that appeared or vanished changes it.
 */
export function trajectoryRevision(input: TrajectoryInput): string {
  const events = input.events
  const last = events?.length ? events[events.length - 1] : undefined
  const checkpoint = input.checkpoints.length ? input.checkpoints[input.checkpoints.length - 1] : undefined
  const receipt = input.invocations.length ? input.invocations[input.invocations.length - 1] : undefined
  const counts = receiptCounts(input)
  return [
    events ? 'log' : 'nolog',
    events?.length ?? 0,
    Number.isInteger(last?.seq) ? last.seq : '',
    last?.type ?? '',
    input.project ?? '',
    input.branch ?? '',
    input.checkpoints.length,
    checkpoint ? [checkpoint.kind, checkpoint.turn, checkpoint.changed, checkpoint.endSeq ?? '', checkpoint.commit ?? ''].join('.') : '',
    input.invocations.length,
    receipt && typeof receipt === 'object' ? (receipt.id ?? '') : '',
    // A folded poll writes no receipt, so the revision carries the counter too:
    // the observation row is never answered as `unchanged` while it moved.
    counts?.readsTotal ?? 0,
    counts?.dropped ?? 0,
    counts?.truncated ? 'truncated' : '',
  ].join(':')
}

/** Calls that are never dropped from a page: they wrote or named a version, or were refused. */
const essentialOp = (op: TraceOp): boolean =>
  op.versions.length > 0 || op.outcome !== 'success' || isWrite(op.argv?.length ? op.argv : op.operation.split('.'))

/**
 * The records and calls one page of this answer carries. `before` (a record
 * seq) selects the next older page; without it the page is the newest
 * {@link FIRST_PAGE_RECORDS} records, and at most {@link FIRST_PAGE_BYTES} of
 * JSON. Older pages carry {@link MAX_RECORDS}. Non-record content (checkpoints,
 * DSH's own calls, receipts without a call) rides with the turn it belongs to;
 * a turn that the record cut only partly keeps `totalRecords`, and tool records
 * that kept only some of their calls keep `opsTotal`. Calls that wrote, named a
 * version or were refused are always kept; the other calls are budgeted per
 * answer and per record, newest first, because a shell loop can log thousands
 * of reads under one call.
 */
export function pageTrajectory(answer: TrajectoryAnswer, before?: number): TrajectoryAnswer {
  const entries: { turn: number, record: TrajectoryRecord }[] = []
  answer.turns.forEach((turn, index) => { for (const record of turn.records) entries.push({ turn: index, record }) })
  let end = entries.length
  if (before !== undefined) {
    const at = entries.findIndex((entry) => entry.record.seq >= before)
    end = at < 0 ? entries.length : at
  }
  const first = before === undefined
  const cap = first ? FIRST_PAGE_RECORDS : MAX_RECORDS
  let count = Math.min(cap, end)
  let page = buildPage(answer, entries, end, count, first)
  if (!first) return page
  // A first page also stops at a byte budget: shed the oldest records until it
  // fits, rebuilding so its call budget is re-spent on what it keeps. A record
  // cut this way stays reachable through `hasMore`/`olderBefore` and its turn's
  // `totalRecords`, so it reads as not loaded, never as missing.
  let size = JSON.stringify(page).length
  for (let attempt = 0; size > FIRST_PAGE_BYTES && count > 1 && attempt < 8; attempt++) {
    const excess = size - FIRST_PAGE_BYTES
    let drop = 0
    let bytes = 0
    for (let i = 0; i < count && bytes < excess; i++) {
      bytes += JSON.stringify(entries[end - count + i]!.record).length + 1
      drop++
    }
    count -= Math.max(1, Math.min(drop || 1, count - 1))
    page = buildPage(answer, entries, end, count, first)
    size = JSON.stringify(page).length
  }
  return page
}

/** One page of at most `count` records ending at `end`, with the calls its records keep. */
function buildPage(answer: TrajectoryAnswer, entries: { turn: number, record: TrajectoryRecord }[], end: number, count: number, first: boolean): TrajectoryAnswer {
  const start = Math.max(0, end - count)
  const kept = entries.slice(start, end)
  const wanted = new Set(kept.map((entry) => entry.record))
  // Which calls each carried record and orphan call keeps. Newest first, so a
  // page keeps the calls closest to what just happened; essential calls always.
  const keepOp = new Map<TraceOp, boolean>()
  for (const { record } of kept) {
    if (record.kind === 'tool') for (const op of record.ops) if (essentialOp(op)) keepOp.set(op, true)
  }
  const pageTurns = kept.length ? { first: kept[0]!.turn, last: kept[kept.length - 1]!.turn } : undefined
  if (pageTurns) {
    for (let turn = pageTurns.first; turn <= pageTurns.last; turn++) {
      for (const call of answer.turns[turn]!.orphanCalls) for (const op of call.ops) if (essentialOp(op)) keepOp.set(op, true)
    }
  }
  let budget = first ? FIRST_PAGE_OPS : MAX_OPS
  const newerFirst = (ops: readonly TraceOp[]): void => {
    let keptHere = 0
    for (let i = ops.length - 1; i >= 0 && budget > 0; i--) {
      const op = ops[i]!
      if (keepOp.get(op)) continue
      if (keptHere >= MAX_RECORD_OPS) break
      keepOp.set(op, true)
      budget--
      keptHere++
    }
  }
  for (let i = kept.length - 1; i >= 0; i--) {
    const record = kept[i]!.record
    if (record.kind === 'tool') newerFirst(record.ops)
  }
  if (pageTurns) {
    for (let turn = pageTurns.last; turn >= pageTurns.first; turn--) {
      for (const call of answer.turns[turn]!.orphanCalls) newerFirst(call.ops)
    }
  }
  const prune = <T extends { ops: TraceOp[] }>(value: T): T => {
    const ops = value.ops.filter((op) => keepOp.get(op))
    return ops.length === value.ops.length ? value : { ...value, ops, opsTotal: value.ops.length }
  }
  // The first page starts at the turn its oldest kept record is in; an older
  // page covers every turn up to its newest kept one (checkpoint-only turns
  // included), so old turns load with their records.
  let from = 0
  let to = answer.turns.length - 1
  if (kept.length) {
    from = first ? kept[0]!.turn : 0
    to = first ? answer.turns.length - 1 : kept[kept.length - 1]!.turn
  } else if (!first) {
    from = answer.turns.length
    to = -1
  }
  const turns: TrajectoryTurn[] = []
  for (let i = from; i <= to; i++) {
    const turn = answer.turns[i]!
    const records = turn.records.filter((record) => wanted.has(record)).map((record) => record.kind === 'tool' ? prune(record) : record)
    const orphanCalls = turn.orphanCalls.map(prune)
    turns.push({
      ...turn, records, orphanCalls,
      // A first-page-only answer already knows the whole turn's count; a cut
      // here must keep it, not replace it with the page's smaller one.
      ...(records.length !== turn.records.length ? { totalRecords: turn.totalRecords ?? turn.records.length } : {}),
    })
  }
  const total = answer.recordTotal ?? entries.length
  const hasMore = start > 0 || (answer.recordTotal !== undefined && total > end && kept.length > 0)
  return {
    ...answer, turns,
    recordTotal: total,
    ...(hasMore && kept.length ? { hasMore: true, olderBefore: kept[0]!.record.seq } : {}),
  }
}

/**
 * `session.trajectory` reads over one host: memoise the built answer per
 * session keyed by its revision (the newest `memo` sessions kept), answer an
 * unchanged `since` with `{ unchanged: true }` without building, and return a
 * page otherwise. Callers without `since` (a tab opening) build only the first
 * page — its newest records, with the whole input's totals and counts — and
 * only a `{ before }` read builds the whole answer. Either way at most one
 * build happens between changes.
 */
export function trajectoryReader(memo = 8, build: (input: TrajectoryInput, scope?: TrajectoryBuildScope) => TrajectoryAnswer = buildTrajectory) {
  const answers = new Map<string, { revision: string, answer: TrajectoryAnswer, partial: boolean }>()
  return (input: TrajectoryInput, options: { since?: string, before?: number } = {}): TrajectoryReply => {
    const revision = trajectoryRevision(input)
    if (options.before === undefined && options.since !== undefined && options.since === revision) {
      return { sessionId: input.sessionId, revision, unchanged: true }
    }
    const kept = answers.get(input.sessionId)
    // A first page can reuse the partial answer a tab already has; an older
    // page needs the whole log, so a partial one is rebuilt in full.
    const reusable = kept?.revision === revision && !(kept.partial && options.before !== undefined)
    let answer: TrajectoryAnswer
    if (reusable) {
      answer = kept!.answer
      answers.delete(input.sessionId)
      answers.set(input.sessionId, kept!)
    } else {
      // Drop the stale answer before building: a long session's is tens of MB,
      // and the new one is built while the old would still be held.
      answers.delete(input.sessionId)
      answer = options.before === undefined ? build(input, { newest: FIRST_PAGE_RECORDS }) : build(input)
      answers.set(input.sessionId, { revision, answer, partial: answer.recordTotal !== undefined })
      while (answers.size > memo) answers.delete(answers.keys().next().value!)
    }
    return pageTrajectory(answer, options.before)
  }
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

/** DSH's `TokenUsage` (assistant/message) under the record's compact names; absent fields stay absent. */
export function usageOf(value: unknown): TrajectoryUsage | undefined {
  if (!value || typeof value !== 'object') return undefined
  const usage = value as Record<string, unknown>
  const out: TrajectoryUsage = {}
  if (finite(usage.inputTokens) !== undefined) out.input = usage.inputTokens as number
  if (finite(usage.outputTokens) !== undefined) out.output = usage.outputTokens as number
  if (finite(usage.cacheReadTokens) !== undefined) out.cacheRead = usage.cacheReadTokens as number
  if (finite(usage.cacheWriteTokens) !== undefined) out.cacheWrite = usage.cacheWriteTokens as number
  return Object.keys(out).length ? out : undefined
}

/** One line of a `request/header`: the model route and how many tools it declares. */
function requestSummary(provider: string | undefined, model: string | undefined, tools: number): string {
  const route = provider && model ? `${provider}/${model}` : model ?? provider ?? 'unknown model'
  return clip(`${route} · ${tools} ${tools === 1 ? 'tool' : 'tools'}`)
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
    ...(text(receipt.kind) ? { kind: displayKind(receipt.kind) } : {}),
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

// ------------------------------------------------------- a request's tool catalog

/** An object's keys sorted at every level, so equal structures serialize equally. */
function sortedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedValue)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    const source = value as Record<string, unknown>
    for (const key of Object.keys(source).sort()) out[key] = sortedValue(source[key])
    return out
  }
  return value
}

/** A tool's comparable form: its description and parameters, key order ignored. */
function toolFingerprint(tool: any): string {
  try {
    return JSON.stringify(sortedValue({ description: tool?.description ?? null, parameters: tool?.parameters ?? null })) ?? ''
  } catch {
    return ''
  }
}

/** One header's catalog as name → fingerprint, in header order. */
function toolFingerprints(tools: unknown): Map<string, string> {
  const out = new Map<string, string>()
  if (!Array.isArray(tools)) return out
  for (const tool of tools) {
    const name = text(tool?.name)
    if (name) out.set(name, toolFingerprint(tool))
  }
  return out
}

/** What a catalog gained, lost and kept changed from the previous request to this one. */
function toolsChangeOf(before: Map<string, string>, after: Map<string, string>): ToolsChange {
  const added: string[] = []
  const removed: string[] = []
  const changed: string[] = []
  for (const [name, fingerprint] of after) {
    const was = before.get(name)
    if (was === undefined) added.push(name)
    else if (was !== fingerprint) changed.push(name)
  }
  for (const name of before.keys()) if (!after.has(name)) removed.push(name)
  return { added, removed, changed }
}

/** A tool's description as one preview line: whitespace collapsed, at most {@link TOOL_DESCRIPTION_MAX} characters. */
function descriptionPreview(value: unknown): { text: string, truncated: boolean } | undefined {
  if (typeof value !== 'string') return undefined
  const line = value.replace(/\s+/g, ' ').trim()
  if (!line) return undefined
  if (line.length <= TOOL_DESCRIPTION_MAX) return { text: line, truncated: false }
  return { text: `${line.slice(0, TOOL_DESCRIPTION_MAX - 1)}…`, truncated: true }
}

/** Top-level properties a parameter schema declares; 0 for a schema without any. */
function parameterCount(parameters: unknown): number | undefined {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return undefined
  const properties = (parameters as Record<string, unknown>).properties
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return 0
  return Object.keys(properties).length
}

/** Serialized size, or Infinity for a value JSON cannot hold. */
function jsonSize(value: unknown): number {
  try { return JSON.stringify(value)?.length ?? 0 } catch { return Number.POSITIVE_INFINITY }
}

/**
 * A request header's parsed tool catalog for the detail, descriptions previewed
 * and schemas kept as logged. It is packed into {@link DETAIL_MAX} serialized
 * characters: tools are dropped from the end when they no longer fit, and a
 * tool whose own schema is too big keeps its name, description and count
 * without it. `cut` reports either loss so the detail can say `tools`.
 */
function toolCatalog(tools: unknown): { tools: TrajectoryTool[], cut: boolean } {
  const out: TrajectoryTool[] = []
  if (!Array.isArray(tools)) return { tools: out, cut: false }
  const budget = DETAIL_MAX
  let used = 2 // the array's brackets
  let cut = false
  for (const raw of tools) {
    const tool = raw && typeof raw === 'object' ? raw as Record<string, unknown> : undefined
    const description = descriptionPreview(tool?.description)
    const parameters = tool?.parameters
    const count = parameterCount(parameters)
    const entry: TrajectoryTool = {
      name: text(tool?.name) ?? '?',
      ...(description ? { description: description.text, ...(description.truncated ? { descriptionTruncated: true } : {}) } : {}),
      ...(count !== undefined ? { parameterCount: count } : {}),
      ...(parameters !== undefined ? { parameters } : {}),
    }
    const lean: TrajectoryTool = { ...entry }
    delete lean.parameters
    const comma = out.length ? 1 : 0
    const withSchema = jsonSize(entry) + comma
    if (used + withSchema <= budget) { out.push(entry); used += withSchema; continue }
    const without = jsonSize(lean) + comma
    cut = true
    if (used + without > budget || !Number.isFinite(without)) break
    out.push(lean)
    used += without
  }
  return { tools: out, cut }
}

type ToolEntry = ToolRecord & { turn: number }

/** A record-producing event's seq, in log order; a repeated tool call counts once. */
function recordEventSeqs(events: readonly any[] | undefined): number[] {
  const out: number[] = []
  if (!events) return out
  const calls = new Set<string>()
  for (const event of events) {
    const type = event?.type
    const data = event?.data
    const seq = integer(event?.seq)
    if (seq === undefined) continue
    if (type === 'user/message') { if (data) out.push(seq) }
    else if (type === 'assistant/message') { if (integer(data?.turn) !== undefined) out.push(seq) }
    else if (type === 'system/message') { if (data?.message && integer(data?.turn) !== undefined) out.push(seq) }
    else if (type === 'request/header') { if (data?.header) out.push(seq) }
    else if (type === 'tool/call') {
      if (integer(data?.turn) !== undefined && text(data.callId) && !calls.has(data.callId)) {
        calls.add(data.callId)
        out.push(seq)
      }
    }
  }
  return out
}

/** What a build keeps: a first page keeps only the newest records, with the whole input's totals and counts. */
export interface TrajectoryBuildScope {
  /** Keep only the newest `newest` records (a first page); totals, counts and the revision still cover the whole input. */
  newest?: number
}

/**
 * The session's trajectory, one pass over the log. Turn attribution: assistant,
 * tool and step events carry their `turn`. A `user/message` carries none: it
 * belongs to the turn open at that point (between its `turn/start` and
 * `turn/end`; DSH logs a turn's input right after its `turn/start`). One logged
 * outside any open turn belongs to the next turn to open; at the log's end, with
 * no next `turn/start` yet, that is the last logged turn + 1 (turn 1 when none).
 *
 * With `scope.newest`, only those records are materialized (previews, calls and
 * result text are left unread for the rest), so a tab opening does not pay for
 * a whole session; `recordTotal`, `counts` and the revision still cover it all.
 */
export function buildTrajectory(input: TrajectoryInput, scope: TrajectoryBuildScope = {}): TrajectoryAnswer {
  const { checkpoints, branch } = input
  // A first-page build reads the whole log for totals but materializes only the
  // newest records: `keepSeqs` is their event seqs. A short log (or a full
  // build) keeps everything.
  const allSeqs = scope.newest !== undefined && scope.newest > 0 ? recordEventSeqs(input.events) : undefined
  const keepSeqs = allSeqs && allSeqs.length > scope.newest! ? new Set(allSeqs.slice(-scope.newest!)) : undefined
  const keep = (seq: number): boolean => keepSeqs === undefined || keepSeqs.has(seq)
  // The recorded prompt changes (docs/specs/layerfs-trajectory.md): a system or
  // request record gains only a hint and its predecessor's seq here; the diff
  // text itself stays behind `session.trajectory.prompt-diff`.
  const prompt = promptChanges(input.events)
  const turns = new Map<number, TrajectoryTurn>()
  const turn = (n: number): TrajectoryTurn => {
    let t = turns.get(n)
    if (!t) turns.set(n, t = { turn: n, records: [], orphanCalls: [], hostOps: [], checkpoints: [] })
    return t
  }
  const tools = new Map<string, ToolEntry>()
  const stepStarts = new Map<string, number>()
  /** Usage logged on `step/end` (older fixtures and parity notes); the message's own usage wins. */
  const stepUsages = new Map<string, TrajectoryUsage>()
  let open: number | undefined
  let last: number | undefined
  /** The last event seq: the observation row sits just after it, once per session. */
  let lastSeq: number | undefined
  /** The previous request header's catalog, for this request's change marks. */
  let previousTools: Map<string, string> | undefined
  /** The step currently open between `step/start` and `step/end`. */
  let openStep: { turn: number, step: number } | undefined
  let pending: UserRecord[] = []
  for (const event of input.events ?? []) {
    const type = event?.type
    const data = event?.data
    const seq = integer(event?.seq)
    if (seq !== undefined) lastSeq = seq
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
      const n = integer(data?.turn)
      const step = integer(data?.step)
      if (at !== undefined && n !== undefined && step !== undefined) stepStarts.set(stepKey(n, step), at)
      openStep = n !== undefined && step !== undefined ? { turn: n, step } : undefined
    } else if (type === 'step/end') {
      const n = integer(data?.turn)
      const step = integer(data?.step)
      if (n !== undefined && step !== undefined) {
        const usage = usageOf(data?.usage)
        if (usage) stepUsages.set(stepKey(n, step), usage)
        if (openStep?.turn === n && openStep.step === step) openStep = undefined
      }
    } else if (type === 'user/message') {
      if (seq === undefined || !data) continue
      const kind = text(data.source?.kind) ?? 'unknown'
      const p = keep(seq) ? preview(blocks(data.content, 'text')) : undefined
      const record: UserRecord = {
        kind: kind === 'user' ? 'user' : 'context', seq, turn: open ?? 0, source: kind,
        ...(at !== undefined ? { at } : {}), text: p?.text ?? '', ...(p?.truncated ? { truncated: true } : {}),
      }
      if (open !== undefined) turn(open).records.push(record)
      else pending.push(record)
    } else if (type === 'assistant/message') {
      const n = integer(data?.turn)
      if (seq === undefined || n === undefined) continue
      const content = data.message?.content
      const p = keep(seq) ? preview(blocks(content, 'text')) : undefined
      const toolCalls = Array.isArray(content) ? content.filter((b: any) => b?.type === 'tool-call').length : 0
      const step = integer(data.step)
      const startedAt = step !== undefined ? stepStarts.get(stepKey(n, step)) : undefined
      const usage = usageOf(data.usage)
      const record: AssistantRecord = {
        kind: 'assistant', seq, turn: n, ...(step !== undefined ? { step } : {}), ...(at !== undefined ? { at } : {}),
        text: p?.text ?? '', ...(p?.truncated ? { truncated: true } : {}),
        ...(blocks(content, 'reasoning').length ? { thinking: true } : {}),
        toolCalls, ...(startedAt !== undefined ? { startedAt } : {}), ...(data.interrupted === true ? { interrupted: true } : {}),
        ...(usage ? { usage } : {}),
      }
      turn(n).records.push(record)
    } else if (type === 'system/message') {
      if (seq === undefined || !data?.message) continue
      const n = integer(data?.turn)
      if (n === undefined) continue
      const step = integer(data?.step)
      const p = keep(seq) ? preview(blocks(data.message.content, 'text')) : undefined
      const source = text(data.message.source?.name) ?? text(data.message.source?.kind)
      const changed = prompt.flags.get(seq)
      const record: SystemRecord = {
        kind: 'system', seq, turn: n, ...(step !== undefined ? { step } : {}), ...(at !== undefined ? { at } : {}),
        text: p?.text ?? '', ...(p?.truncated ? { truncated: true } : {}), ...(source ? { source } : {}),
        ...(changed ? { promptChanged: changed.promptChanged, previousSeq: changed.previousSeq } : {}),
      }
      turn(n).records.push(record)
    } else if (type === 'request/header') {
      if (seq === undefined || !data?.header) continue
      // `request/header` names no position: the step it was logged inside is the
      // assistant step that follows it. Without one, keep the turn it was logged in.
      const n = openStep?.turn ?? open ?? last ?? 0
      const step = openStep?.step
      const header = data.header
      const provider = text(header?.config?.provider)
      const model = text(header?.config?.model)
      const tools = Array.isArray(header?.tools) ? header.tools.length : 0
      const reason = text(data.reason)
      const catalog = toolFingerprints(header?.tools)
      const changed = prompt.flags.get(seq)
      const record: RequestRecord = {
        kind: 'request', seq, turn: n, ...(step !== undefined ? { step } : {}), ...(at !== undefined ? { at } : {}),
        ...(provider ? { provider } : {}), ...(model ? { model } : {}), tools,
        ...(previousTools ? { toolsChanged: toolsChangeOf(previousTools, catalog) } : {}),
        ...(reason ? { reason } : {}),
        summary: requestSummary(provider, model, tools),
        ...(changed ? { promptChanged: changed.promptChanged, previousSeq: changed.previousSeq } : {}),
      }
      previousTools = catalog
      turn(n).records.push(record)
    } else if (type === 'tool/call') {
      const n = integer(data?.turn)
      if (seq === undefined || n === undefined || !text(data.callId) || tools.has(data.callId)) continue
      const step = integer(data.step)
      const summary = keep(seq) ? summarize(data.arguments) : undefined
      const record: ToolEntry = {
        kind: 'tool', seq, turn: n, ...(step !== undefined ? { step } : {}), ...(at !== undefined ? { at } : {}),
        callId: data.callId, name: text(data.name) ?? '?', ...(summary ? { summary } : {}), ops: [],
      }
      tools.set(data.callId, record)
      turn(n).records.push(record)
    } else if (type === 'tool/result') {
      const record = tools.get(data?.message?.toolCallId)
      if (!record || record.resultSeq !== undefined) continue
      const p = keep(record.seq) ? preview(blocks(data.message.content, 'text')) : undefined
      if (p) {
        record.result = p.text
        if (p.truncated) record.resultTruncated = true
      }
      if (data.message.isError === true) record.isError = true
      if (seq !== undefined) record.resultSeq = seq
      if (at !== undefined) record.endedAt = at
    }
  }
  // DSH logs a step's usage on its `assistant/message`; the parity note calls it
  // step usage. A log that also stamps `step/end` covers a message without one.
  if (stepUsages.size) {
    for (const t of turns.values()) {
      for (const record of t.records) {
        if (record.kind !== 'assistant' || record.usage || record.step === undefined) continue
        const usage = stepUsages.get(stepKey(record.turn, record.step))
        if (usage) record.usage = usage
      }
    }
  }
  if (pending.length) {
    const n = (last ?? 0) + 1
    const t = turn(n)
    for (const r of pending) { r.turn = n; t.records.push(r) }
  }

  const allCheckpoints: TraceCheckpoint[] = []
  const byReceipt = new Map<string, TraceCheckpoint>()
  for (const c of checkpoints) {
    if (!c || !Number.isInteger(c.turn)) continue
    const checkpoint: TraceCheckpoint = {
      kind: c.kind, commit: text(c.commit) ?? null, branch: text(c.branch) ?? null, changed: Number(c.changed) || 0,
      message: String(c.message ?? ''), at: Number(c.at) || 0,
      ...(c.error && text(c.error.code) ? { error: { code: c.error.code, message: String(c.error.message ?? '') } } : {}),
    }
    turn(c.turn).checkpoints.push(checkpoint)
    allCheckpoints.push(checkpoint)
    if (text(c.receipt)) byReceipt.set(c.receipt, checkpoint)
  }

  const created = new Set<string>()
  let unnamed = 0
  let callsWithVersions = 0
  /** The versions (and the unnamed kind) a receipt contributes, without building its `TraceOp`. */
  const receiptMade = (receipt: any): boolean => {
    let any = false
    for (const v of Array.isArray(receipt?.versions) ? receipt.versions : []) {
      if (!v || (v.kind !== 'Commit' && v.kind !== 'Layer') || !text(v.id) || !['created', 'unchanged', 'referenced'].includes(v.effect)) continue
      if (v.effect === 'created') { created.add(v.id); any = true }
    }
    const kind = text(receipt?.kind)
    if (!any && receipt?.outcome === 'success' && kind && kindFamily(displayKind(kind)) === 'created') { unnamed++; any = true }
    return any
  }
  const orphans = new Map<string, { callId: string, ops: TraceOp[] }>()
  /** A checkpoint's receipt did create a version (counted while the receipts are read). */
  const checkpointMade = new Map<TraceCheckpoint, boolean>()
  /** Tool calls whose receipts created a version (the page may not carry their call lines). */
  const callMade = new Set<string>()
  for (const receipt of input.invocations) {
    if (!receipt || typeof receipt !== 'object' || !text(receipt.id)) continue
    if (text(receipt.sessionId) && receipt.sessionId !== input.sessionId) continue
    const n = integer(receipt.turn) ?? 0
    if (keepSeqs) {
      // A first page: count every receipt, but build the call line only for a
      // record (or host/checkpoint call) the page keeps.
      const made = receiptMade(receipt)
      const callId = text(receipt.toolCallId)
      if (callId) {
        if (made) callMade.add(callId)
        const record = tools.get(callId)
        if (record) {
          if (keepSeqs.has(record.seq)) record.ops.push(toOp(receipt, checkpoints, branch))
          continue
        }
        let orphan = orphans.get(callId)
        if (!orphan) {
          orphans.set(callId, orphan = { callId, ops: [] })
          turn(n).orphanCalls.push(orphan)
        }
        orphan.ops.push(toOp(receipt, checkpoints, branch))
        continue
      }
      const op = toOp(receipt, checkpoints, branch)
      const checkpoint = byReceipt.get(op.id)
      if (checkpoint) { checkpoint.op = op; checkpointMade.set(checkpoint, made) }
      else turn(n).hostOps.push(op)
      continue
    }
    const op = toOp(receipt, checkpoints, branch)
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

  // A first page keeps only its newest records: drop the older turns, and say
  // how many records each cut turn holds in the whole log. The rest stays
  // reachable through `olderBefore`, so a cut record reads as not loaded rather
  // than missing.
  let firstPageTotal: number | undefined
  if (keepSeqs) {
    firstPageTotal = allSeqs!.length
    let boundary = Number.POSITIVE_INFINITY
    for (const t of turns.values()) {
      const full = t.records.length
      const records = t.records.filter((record) => keepSeqs.has(record.seq))
      if (records.length !== full) {
        t.records = records
        if (records.length) t.totalRecords = full
      }
      if (records.length && t.turn < boundary) boundary = t.turn
    }
    if (boundary !== Number.POSITIVE_INFINITY) for (const n of [...turns.keys()]) if (n < boundary) turns.delete(n)
  }

  // The session-level observation row: one line for the read-only host calls the
  // receipt counter folded, after the newest record (the same place in a whole
  // build and a first-page build). It is a record like any other, so a page's
  // byte budget and count include it; when it is kept in both builds, it is
  // identical. No counters: a write-only session shows no row.
  const counts = receiptCounts(input)
  const observation = receiptAggregateLines(counts)
  if (observation.length) {
    const target = last ?? 0
    const record: ObservationRecord = {
      kind: 'observation',
      seq: (lastSeq ?? 0) + 1,
      turn: target,
      ...(finite(counts?.lastAt) !== undefined ? { at: counts!.lastAt } : {}),
      text: observation[0]!,
      top: observation.slice(1),
      reads: counts!.readsTotal,
      ...(counts!.truncated ? { truncated: true } : {}),
    }
    turn(target).records.push(record)
    // The first-page total counts every record the whole log holds; the
    // observation is one of them (and is always among the newest kept).
    if (keepSeqs) firstPageTotal = (firstPageTotal ?? allSeqs!.length) + 1
  }

  // B2 #3: every version the session made (its turns' checkpoints too), and the tool calls that made one. A saving
  // call whose version is not linked (a commit of a Workspace other than the bound one) still counts, by its kind.
  if (keepSeqs) {
    // The first page already counted every receipt; only the checkpoint's own
    // commit can still add a version when its call created none.
    callsWithVersions = callMade.size
    for (const c of allCheckpoints) {
      const linked = checkpointMade.get(c) ?? false
      if (!linked && c.commit && !c.error && c.changed > 0) created.add(c.commit)
    }
  } else {
    const madeBy = (op: TraceOp): boolean => {
      let any = false
      for (const v of op.versions) if (v.effect === 'created') { created.add(v.id); any = true }
      if (!any && op.outcome === 'success' && kindFamily(op.kind) === 'created') { unnamed++; any = true }
      return any
    }
    const count = (ops: readonly TraceOp[]): void => { if (ops.map(madeBy).some(Boolean)) callsWithVersions++ }
    for (const record of tools.values()) count(record.ops)
    for (const orphan of orphans.values()) count(orphan.ops)
    for (const t of turns.values()) {
      for (const op of t.hostOps) madeBy(op)
      for (const c of t.checkpoints) {
        const linked = c.op ? madeBy(c.op) : false
        if (!linked && c.commit && !c.error && c.changed > 0) created.add(c.commit)
      }
    }
  }

  return {
    sessionId: input.sessionId, project: input.project, branch,
    turns: [...turns.values()].sort((a, b) => a.turn - b.turn),
    logLoaded: input.events !== undefined,
    counts: { versionsCreated: created.size + unnamed, callsWithVersions },
    revision: trajectoryRevision(input),
    ...(firstPageTotal !== undefined ? { recordTotal: firstPageTotal } : {}),
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
  /** The last request header before the target: the catalog a change is read against. */
  let previousRequestSeq: number | undefined
  for (const event of events) {
    if (event?.type === 'request/header' && event?.data?.header && Number.isInteger(event.seq)) {
      if (event.seq === seq) {
        const cut: ('header' | 'tools')[] = []
        const value = full(JSON.stringify(event.data.header, null, 2) ?? '', 'header', cut)
        const catalog = toolCatalog(event.data.header?.tools)
        if (catalog.cut) cut.push('tools')
        return {
          seq, kind: 'request', header: value,
          ...(Array.isArray(event.data.header?.tools) ? { tools: catalog.tools } : {}),
          ...(previousRequestSeq !== undefined ? { previousRequestSeq } : {}),
          ...(cut.length ? { truncated: cut } : {}),
        }
      }
      if (event.seq < seq) previousRequestSeq = event.seq
    }
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
    if (event.type === 'system/message' && data?.message) {
      const cut: 'text'[] = []
      const value = full(blocks(data.message.content, 'text').join('\n'), 'text', cut)
      return { seq, kind: 'system', text: value, ...(cut.length ? { truncated: cut } : {}) }
    }
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

