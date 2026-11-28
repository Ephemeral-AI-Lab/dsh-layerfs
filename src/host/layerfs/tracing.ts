/**
 * Additive invocation receipts. Original DSH events and CLI streams are never
 * rewritten. Every CLI call made inside a project session's trace context gets
 * one receipt id and carries it to LayerFS as `LAYERFS_LOGS_TAG=dsh:<sessionId>:<receiptId>`
 * (docs/specs/layerfs-logs.md §4); the call log line with that tag is the
 * record a receipt is built from when the host did not see the result itself.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { isWrite, operationOf, type CallLine, type CallOutput, type SimulationStep } from '../../shared/logs.ts'
import { makeReceipt, renderCall, savedFields } from './call-words.ts'
import { RAW_DIR } from './call-output.ts'
import { displayKind, RECEIPT_META_FIELD, receiptAggregateLines, versionEffect, type ReceiptMeta } from '../../shared/trajectory.ts'
export { receiptAggregateLines, RECEIPT_META_FIELD, type ReadCount, type ReceiptMeta } from '../../shared/trajectory.ts'

export interface VersionLink { kind: 'Commit' | 'Layer'; id: string; effect: 'created' | 'unchanged' | 'referenced' }
/**
 * One receipt in a session sidecar (`layerfs.json`, `invocations[]`). It is
 * self-sufficient: the Logs page renders a call from it alone when this
 * machine's call log has no line for it (a session imported from another
 * machine, docs/specs/layerfs-logs.md §4). Older sidecars may lack the call
 * fields (`at` … `exit`) or hold `arguments`, `source`, `startedAt`,
 * `finishedAt` and `error`; they are read as they are and never written any more.
 */
export interface Invocation {
  id: string; origin: 'tool' | 'host'; sessionId: string; project: string; turn?: number; toolCallId?: string
  operation: string; outcome: 'success' | 'refusal' | 'unknown'; versions: VersionLink[]; captureGap?: string
  /** Wall-clock start (ms since the epoch) and duration (ms), as on the call log line. */
  at?: number; ms?: number
  /** The call as redacted CLI words ({@link portableArgv}): no secrets, no machine-local paths, bounded. */
  argv?: string[]
  /** The `LAYERFS_LOGS_TAG` the call carried (`dsh:<sessionId>:<id>`). */
  tag?: string
  /** The line's outcome code when not `ok` (refusal code, `Failed` or `Unknown`). */
  code?: string
  /** The result's `kind` (the line's `kind`). */
  kind?: string
  /** `workspace exec`: the exec id and the command's exit code (null: killed), when known. */
  execId?: string; exit?: number | null
  /** The simulation script step this tool call ran (`stepOfCall`). */
  step?: SimulationStep
  /** Arrived through a session store import: never in this machine's call log. */
  imported?: true
}
export interface TraceIdentity {
  origin: 'tool' | 'host'; sessionId: string; project: string; turn?: number; toolCallId?: string
  /** Machine-local execution handle, used only to verify workspace command targets. */
  workspace?: string
  /** Internal history writes are never project-file checkpoints. */
  internal?: boolean
  /** Prefix of this tool call's receipt ids (`<scope>.<random>`), see {@link toolScope}. */
  scope?: string
  /** The simulation script step this tool call runs, when scripted. */
  step?: SimulationStep
}
export interface TraceContext extends TraceIdentity {
  record: (invocation: Invocation) => Promise<void>
  /**
   * Fold a successful host read into the session's receipt counter instead of
   * `record`ing it (see {@link receiptDisposition}). Persistence implements it
   * (one counter per session, in the sidecar metadata); without it the read is
   * not counted.
   */
  aggregate?: (invocation: Invocation) => void | Promise<void>
  onError?: (error: unknown) => void
}
const context = new AsyncLocalStorage<TraceContext>()
export const withTraceContext = <T>(value: TraceContext, run: () => T): T => context.run(value, run)
/** Archive writes are session persistence, not project-file activity. */
export const withoutTraceContext = <T>(run: () => T): T => context.exit(run)

/** Exact allowlist; matching a family prefix would mislabel exec/read/lifecycle calls. */
export const CHECKPOINT_OPERATIONS = ['file.write', 'file.edit', 'file.apply', 'file.rm', 'file.mkdir', 'file.mv', 'file.cp', 'workspace.commit', 'branch.fork', 'branch.merge', 'branch.publish'] as const

/** The receipt-id prefix of one tool call: stable for (session, call), so the shell and the host agree. */
export function toolScope(sessionId: string, callId: string): string {
  return createHash('sha256').update(`${sessionId}\0${callId}`).digest('hex').slice(0, 8)
}

/**
 * Decode 2.0 answers only: every saving call answers `commit` (66 hex), with
 * `unchanged` when nothing was made and a merge's `fast_forward` when it made
 * no Commit of its own. A bare successful exit or current head is insufficient.
 */
export function savedVersions(operation: string, result: any): VersionLink[] {
  const allowed: readonly string[] = CHECKPOINT_OPERATIONS
  if (!allowed.includes(operation) || !result || typeof result !== 'object') return []
  const id = result.commit
  if (typeof id !== 'string' || !/^[a-f0-9]{66}$/.test(id)) return []
  const unchanged = result.unchanged === true
  if (operation === 'branch.publish') return [{ kind: 'Layer', id, effect: unchanged ? 'unchanged' : 'created' }]
  if (operation === 'branch.fork') return [{ kind: 'Commit', id, effect: 'referenced' }]
  if (operation === 'branch.merge') return [{ kind: 'Commit', id, effect: unchanged || result.fast_forward === true ? 'referenced' : 'created' }]
  return [{ kind: 'Commit', id, effect: unchanged ? 'unchanged' : 'created' }]
}

/**
 * Versions a call log line names, in whichever vocabulary wrote its `kind`
 * (`committed`/`Committed` …; see {@link versionEffect}). A line has no
 * `fast_forward`, so a merge (`merged`/`Merged`) is created only when the
 * caller read `fastForward: false` from the call's stored answer
 * ({@link fastForwardOfOutput}), else referenced.
 */
export function lineVersions(line: Pick<CallLine, 'argv' | 'kind' | 'commit' | 'layer'>, fastForward?: boolean): VersionLink[] {
  const allowed: readonly string[] = CHECKPOINT_OPERATIONS
  if (!allowed.includes(operationOf(line.argv))) return []
  const effect = line.kind ? versionEffect(line.kind, fastForward) : undefined
  const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{66}$/.test(value)
  if (!effect) return []
  if (hex(line.commit)) return [{ kind: 'Commit', id: line.commit, effect }]
  if (hex(line.layer)) return [{ kind: 'Layer', id: line.layer, effect }]
  return []
}

const portable = (identity: TraceIdentity, id: string, project: string): Pick<Invocation, 'id' | 'origin' | 'sessionId' | 'project' | 'turn' | 'toolCallId' | 'step'> => ({
  id, origin: identity.origin === 'tool' ? 'tool' : 'host', sessionId: identity.sessionId, project,
  ...(Number.isInteger(identity.turn) ? { turn: identity.turn } : {}),
  ...(typeof identity.toolCallId === 'string' ? { toolCallId: identity.toolCallId } : {}),
  ...(typeof identity.step?.runId === 'string' && typeof identity.step?.stepKey === 'string' ? { step: { runId: identity.step.runId, stepKey: identity.step.stepKey } } : {}),
})

/** Receipt argv bounds: words kept, and the JSON size past which long words are cut to 40 characters. */
export const RECEIPT_ARGV_WORDS = 32
export const RECEIPT_ARGV_BYTES = 1024
/** Options whose value names a file or folder on the calling machine. */
const LOCAL_OPTIONS = ['from', 'source', 'dir', 'path', 'file', 'out', 'output', 'cwd', 'root']
const LOCAL_PATH = '<local path>'
let localRoots: string[] | undefined
/** An absolute path on this machine (home, temp, user and volume folders), never a project path. */
function isLocalPath(word: string): boolean {
  if (word.startsWith('~/') || word.startsWith('file://')) return true
  if (!word.startsWith('/')) return false
  localRoots ??= [...new Set([homedir(), tmpdir(), (() => { try { return realpathSync(tmpdir()) } catch { return tmpdir() } })(), '/private/', '/tmp/', '/var/folders/', '/Users/', '/home/', '/Volumes/', '/root/']
    .filter((root) => root && root !== '/').map((root) => root.endsWith('/') ? root : `${root}/`))]
  return localRoots.some((root) => word.startsWith(root) || `${word}/` === root)
}

/**
 * Call log words (already redacted by {@link renderCall}) made portable for a
 * receipt that travels with the session: values naming local files
 * (`--from`, `project init|import` sources, absolute home/temp paths) become
 * `<local path>`; at most {@link RECEIPT_ARGV_WORDS} words (then `<N more>`);
 * past {@link RECEIPT_ARGV_BYTES} of JSON, words beyond 40 characters are cut.
 */
export function portableArgv(words: readonly string[]): string[] {
  const kept = words.slice(0, RECEIPT_ARGV_WORDS).map((raw, index, all) => {
    const word = String(raw)
    if (index < 2 || /^<\d+ bytes>$/.test(word)) return word
    const option = index > 2 && all[index - 1]!.startsWith('--') && !word.startsWith('--') ? all[index - 1]!.slice(2) : undefined
    const source = all[0] === 'project' && (all[1] === 'init' || all[1] === 'import') && index === 3 && !word.startsWith('--')
    return (option && LOCAL_OPTIONS.includes(option)) || source || isLocalPath(word) ? LOCAL_PATH : word
  })
  if (words.length > RECEIPT_ARGV_WORDS) kept.push(`<${words.length - RECEIPT_ARGV_WORDS} more>`)
  return Buffer.byteLength(JSON.stringify(kept), 'utf8') <= RECEIPT_ARGV_BYTES ? kept
    : kept.map((word, index) => index < 2 || Array.from(word).length <= 40 ? word : `${Array.from(word).slice(0, 40).join('')}…`)
}

const shortText = (value: unknown): string | undefined => typeof value === 'string' && value && value.length <= 64 ? value : undefined

/** `workspace exec` facts: an exit code and LayerFS's exec id, when known (2.0 has no caller-chosen id: it is in the answer). */
function execFacts(operation: string, exit: unknown, execId?: unknown): Pick<Invocation, 'execId' | 'exit'> {
  if (operation !== 'workspace.exec') return {}
  return {
    ...(exit === null || (typeof exit === 'number' && Number.isInteger(exit)) ? { exit } : {}),
    ...(shortText(execId) ? { execId: execId as string } : {}),
  }
}

/**
 * The exec exit code from a stored output: the 2.0 result JSON's `exit_code`
 * (stdout is the one result line). A `--stream` call (`streamed`) prints the
 * command's raw output and exits with the command's own code, so its process
 * exit is the answer, except a 125 with a refusal (LayerFS itself refused).
 */
export function exitOfOutput(output: CallOutput | { missing: true } | undefined, streamed = false): number | undefined {
  if (!output || 'missing' in output) return undefined
  if (!streamed && typeof output.stdout === 'string') {
    const last = output.stdout.trimEnd().split('\n').at(-1)
    try { const code = JSON.parse(last ?? '')?.exit_code; if (Number.isInteger(code)) return code } catch { /* not the result */ }
  }
  return streamed && Number.isInteger(output.exit) && (output.exit !== 125 || !output.refusal) ? output.exit as number : undefined
}

/**
 * `branch merge`: the answer's `fast_forward` from a stored output (stdout is
 * the JSON answer). A cut answer is searched in its head, where the top-level
 * field sits; `--text` answers and missing outputs give undefined.
 */
export function fastForwardOfOutput(output: CallOutput | { missing: true } | undefined): boolean | undefined {
  if (!output || 'missing' in output || typeof output.stdout !== 'string') return undefined
  if (!output.truncated?.stdout) {
    try { const value = JSON.parse(output.stdout)?.fast_forward; return typeof value === 'boolean' ? value : undefined } catch { return undefined }
  }
  const match = /^\s*\{[^{}]*?"fast_forward"\s*:\s*(true|false)/.exec(output.stdout.slice(0, 4096))
  return match ? match[1] === 'true' : undefined
}


/**
 * A receipt from a call log line made inside `identity`'s trace context.
 * `workspace commit` links versions only when its Workspace is the bound one.
 * `exit` is the exec exit code and `fastForward` a merge's `fast_forward`, both
 * from the call's stored output, when the caller has it.
 */
export function receiptFromLine(line: CallLine, identity: TraceIdentity, id: string, exit?: number, fastForward?: boolean): Invocation {
  const operation = operationOf(line.argv)
  const targetKnown = operation !== 'workspace.commit' || (!!identity.workspace && line.argv[2] === identity.workspace)
  const project = !targetKnown ? '' : ['file', 'branch'].includes(line.argv[0]) && line.argv[2] ? line.argv[2] : identity.project
  const outcome = line.outcome === 'ok' ? 'success' : line.outcome === 'Unknown' ? 'unknown' : 'refusal'
  const allowed: readonly string[] = CHECKPOINT_OPERATIONS
  const captureGap = !targetKnown ? 'target-workspace-unconfirmed'
    : outcome === 'success' && allowed.includes(operation) && !line.kind ? 'structured-result-unavailable' : undefined
  const code = line.outcome === 'ok' ? undefined : shortText(line.outcome), rawKind = shortText(line.kind), kind = rawKind ? displayKind(rawKind) : undefined
  return {
    ...portable(identity, id, project), operation, outcome,
    versions: outcome === 'success' && targetKnown && !identity.internal ? lineVersions(line, fastForward) : [],
    ...(captureGap ? { captureGap } : {}),
    at: line.at, ms: line.ms, argv: portableArgv(line.argv),
    ...(line.tag ? { tag: line.tag } : {}), ...(code ? { code } : {}), ...(kind ? { kind } : {}),
    ...execFacts(operation, exit),
  }
}

/* ------------------------------------------------------------------------- *
 * Receipt policy: a write is history, an observation is a counter.
 *
 * A session's sidecar used to grow by one receipt per traced call whatever the
 * operation: a real one reached 83,250 receipts / 55.2 MB, and 92% of them were
 * read-only calls the plugin makes itself (the Observe view's polls, store and
 * branch listings, log reads). No history row was needed for those: the
 * Trajectory already budgets read-only calls away past 64 per record, so their
 * detail was parsed from disk and then never shown.
 *
 * The policy here records a call only when it is history — a mutation, any
 * refusal or unknown outcome, or an agent command — and folds the observation
 * into a per-session counter kept in the sidecar metadata (see
 * {@link receiptDisposition}); {@link compactInvocations} only trims the oldest
 * receipts past the cap.
 *
 * "Agent command" is a receipt's *producer*, not its async context: a receipt
 * built from a tool's tagged call-log line ({@link receiptFromLine}, the agent's
 * own shell) is history; a receipt built by {@link traceInvocation} is the host
 * process making a call, even when it runs inside a tool's async context, and a
 * successful host read is exactly the polling to count. Classifying by the
 * ambient `origin` would count the plugin's own work during a tool call as the
 * agent's.
 * ------------------------------------------------------------------------- */

/** Receipts kept per session; a compaction trims the oldest past this and counts them. */
export const RECEIPT_CAP = 5000
/** Sidecar metadata key of one session's receipt counter ({@link ReceiptMeta}). */
export const RECEIPT_META = 'receipts'

/** An empty counter for one session (or a cap under test). */
export function emptyReceiptMeta(cap = RECEIPT_CAP): ReceiptMeta {
  return { version: 1, reads: {}, readsTotal: 0, dropped: 0, cap, truncated: false }
}

const isRecord = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value)
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const outcomeOf = (value: unknown): Invocation['outcome'] => value === 'refusal' || value === 'unknown' ? value : 'success'

/** A counter from whatever a sidecar held: never trust it, never grow it. */
function normalizeMeta(raw: unknown, cap: number): ReceiptMeta {
  const meta = emptyReceiptMeta(cap)
  if (!isRecord(raw)) return meta
  if (isCount(raw.cap) && raw.cap > 0) meta.cap = Math.trunc(raw.cap)
  if (isCount(raw.dropped)) meta.dropped = Math.trunc(raw.dropped)
  meta.truncated = raw.truncated === true || meta.dropped > 0
  if (Number.isFinite(raw.firstAt)) meta.firstAt = raw.firstAt
  if (Number.isFinite(raw.lastAt)) meta.lastAt = raw.lastAt
  if (isRecord(raw.reads)) {
    for (const [operation, value] of Object.entries(raw.reads)) {
      if (!operation || !isRecord(value) || !isCount(value.count) || value.count < 1) continue
      meta.reads[operation] = {
        count: Math.trunc(value.count),
        lastAt: Number.isFinite(value.lastAt) ? value.lastAt : 0,
        lastOutcome: outcomeOf(value.lastOutcome),
      }
      meta.readsTotal += Math.trunc(value.count)
    }
  }
  return meta
}

/**
 * Fold one observation into a counter. With `count: true` it is a successful
 * host read (the default for a success); otherwise only the last time and
 * outcome move, which a recorded refusal contributes without being counted.
 */
export function noteRead(meta: ReceiptMeta, read: { operation: string, at: number, outcome?: Invocation['outcome'] }, options: { count?: boolean } = {}): void {
  if (!read.operation) return
  const outcome = read.outcome ?? 'success'
  const counted = options.count ?? outcome === 'success'
  const at = Number.isFinite(read.at) ? read.at : 0
  const current = meta.reads[read.operation]
  if (!current && !counted) return
  if (!current) meta.reads[read.operation] = { count: 1, lastAt: at, lastOutcome: outcome }
  else {
    if (counted) current.count++
    if (at >= current.lastAt) { current.lastAt = at; current.lastOutcome = outcome }
  }
  if (counted) {
    meta.readsTotal++
    if (meta.firstAt === undefined || at < meta.firstAt) meta.firstAt = at
  }
  if (meta.lastAt === undefined || at >= meta.lastAt) meta.lastAt = at
}

/** Fold one observation into a raw sidecar counter (normalized first); the write side's entry point. */
export function foldRead(meta: unknown, read: { operation: string, at: number, outcome?: Invocation['outcome'] }, options: { cap?: number, count?: boolean } = {}): ReceiptMeta {
  const next = normalizeMeta(meta, options.cap ?? RECEIPT_CAP)
  noteRead(next, read, options)
  return next
}

/**
 * Attach a session's counter to the receipts array a caller already holds: the
 * trajectory input carries the array, not the sidecar, so this keeps the
 * counter beside it without copying. Non-enumerable, so JSON of the receipts
 * is unchanged.
 */
export function withReceiptMeta<T extends readonly any[]>(rows: T, meta: ReceiptMeta | undefined): T {
  if (meta && typeof meta === 'object') Object.defineProperty(rows, RECEIPT_META_FIELD, { value: meta, enumerable: false, configurable: true })
  return rows
}

/** The counter attached to a receipts array by {@link withReceiptMeta}, when there is one. */
export function receiptMetaOf(rows: unknown): ReceiptMeta | undefined {
  const meta = (rows as any)?.[RECEIPT_META_FIELD]
  return meta && typeof meta === 'object' ? meta as ReceiptMeta : undefined
}

/** Calls that are history whatever their outcome: they changed or saved something. */
const HISTORY_OPERATIONS = new Set([
  'file.write', 'file.edit', 'file.apply', 'file.rm', 'file.mkdir', 'file.mv', 'file.cp',
  'workspace.commit', 'branch.fork', 'branch.merge', 'branch.publish', 'branch.remove',
  'sandbox.create', 'sandbox.remove', 'project.init', 'project.import',
])
/** Operations the receipt policy always records; `store.*` is history except the one read named below. */
export function historyOperation(operation: string): boolean {
  if (HISTORY_OPERATIONS.has(operation)) return true
  return operation.startsWith('store.') && operation !== 'store.get'
}

/** Whether a call only reads, from its argv when there is one, else from its operation name. */
export function readOnlyOperation(operation: string, argv?: readonly string[]): boolean {
  const words = argv && argv.length >= 2 ? argv : operation.split('.')
  return !isWrite(words)
}

/** Who produced a receipt: the agent's own command (a tagged call-log line) or the host process. */
export type ReceiptProducer = 'tool' | 'host'

/**
 * What the receipt policy does with one receipt. A `tool` producer is an agent
 * command and always keeps its receipt; a `host` producer keeps mutations,
 * version-naming calls, refusals/unknowns and `store.*`, and folds a successful
 * read-only call into the counter.
 */
export function receiptDisposition(receipt: Pick<Invocation, 'operation' | 'outcome' | 'argv' | 'versions'>, producer: ReceiptProducer): 'keep' | 'aggregate' {
  if (producer === 'tool') return 'keep'
  if (receipt.outcome !== 'success') return 'keep'
  if (Array.isArray(receipt.versions) && receipt.versions.length > 0) return 'keep'
  if (historyOperation(receipt.operation)) return 'keep'
  return readOnlyOperation(receipt.operation, receipt.argv) ? 'aggregate' : 'keep'
}

/** One compaction's result: the counter, the receipts kept, and what moved. */
export interface ReceiptCompaction {
  meta: ReceiptMeta
  /** Receipts kept, in their original order (the oldest trimmed past the cap). */
  invocations: any[]
  /** Receipt objects the compaction saw. */
  before: number
  /** Receipts kept. */
  after: number
  /** Receipts this run trimmed past the cap. */
  dropped: number
}

/**
 * Keep a session's receipts within the cap: the oldest past it are trimmed and
 * counted in `meta.dropped`. Pure: the caller writes both halves. Reads were
 * already folded into the counter when they were made ({@link receiptDisposition}),
 * so every receipt here is history and none is folded again.
 */
export function compactInvocations(meta: unknown, invocations: readonly unknown[], options: { cap?: number } = {}): ReceiptCompaction {
  const next = normalizeMeta(meta, options.cap ?? RECEIPT_CAP)
  const cap = options.cap ?? next.cap
  const kept = invocations.filter((row): row is any => !!row && typeof row === 'object' && !Array.isArray(row))
  const before = kept.length
  next.cap = cap
  let dropped = 0
  if (kept.length > cap) { dropped = kept.length - cap; kept.splice(0, dropped) }
  if (dropped > 0) { next.dropped += dropped; next.truncated = true }
  return { meta: next, invocations: kept, before, after: kept.length, dropped }
}

/** The call an SDK invocation makes, for its receipt (computed only inside a trace context). */
export interface CallDescription { argv: readonly string[], input?: string | Buffer | null, bools?: readonly string[], at?: number, ms?: number }

/**
 * Capture an SDK invocation once, preserving result/throw behavior and async
 * caller identity. `run` gets the call's log tag (none outside a trace context).
 */
export async function traceInvocation<T>(operation: string, run: (tag?: string) => Promise<T>, targetProject?: string, targetWorkspace?: string, describe?: () => CallDescription): Promise<T> {
  const trace = context.getStore()
  if (!trace) return run(undefined)
  const { id, tag } = makeReceipt(trace.sessionId, trace.scope, randomUUID().replaceAll('-', ''))
  const at = Date.now(), started = performance.now()
  let result: T | undefined, error: any
  try { result = await run(tag); return result } catch (e) { error = e; throw e } finally {
    const targetKnown = operation !== 'workspace.commit' || !!trace.workspace && targetWorkspace === trace.workspace
    let words: string[] | undefined, call: CallDescription | undefined
    try {
      call = describe?.()
      if (call) words = renderCall(call.argv, call.input === undefined || call.input === null ? null : Buffer.byteLength(call.input), call.bools)
    } catch { /* receipt argv is best effort */ }
    // the kind is this log's own word for a 2.0 answer (as the call log line's), else the answer's own `kind`
    const code = error ? shortText(error.code) ?? 'Failed' : undefined
    const rawKind = error ? undefined : savedFields(words ?? operation.split('.'), result).kind ?? shortText((result as any)?.kind)
    const kind = rawKind ? displayKind(rawKind) : undefined
    const receipt: Invocation = {
      ...portable(trace, id, !targetKnown ? '' : targetProject ?? trace.project), operation,
      outcome: error ? error.transport === 'refusal' ? 'refusal' : 'unknown' : 'success',
      versions: error || trace.internal || !targetKnown ? [] : savedVersions(operation, result),
      ...(!targetKnown ? { captureGap: 'target-workspace-unconfirmed' } : {}),
      at: Number.isFinite(call?.at) ? call!.at! : at, ms: Number.isFinite(call?.ms) ? call!.ms! : Math.max(0, Math.round(performance.now() - started)),
      ...(words ? { argv: portableArgv(words) } : {}),
      ...(tag ? { tag } : {}), ...(code ? { code } : {}), ...(kind ? { kind } : {}),
      ...execFacts(operation, error ? undefined : (result as any)?.exit_code, error ? undefined : (result as any)?.exec),
    }
    // History first: a mutation, any refusal/unknown, and every agent command get
    // their receipt. A successful host read is observation: it folds into the
    // session's counter, so 31,597 polls cost 31,597 increments, not 31,597 rows.
    const aggregate = trace.aggregate
    if (receiptDisposition(receipt, 'host') === 'aggregate') {
      if (aggregate) {
        try { await aggregate(receipt) } catch (aggregateError) { trace.onError?.(aggregateError) }
      }
    } else {
      // A refused read is history (its receipt follows) and also moves the
      // counter's last outcome, so the aggregate line stays truthful.
      if (receipt.outcome !== 'success' && readOnlyOperation(receipt.operation, receipt.argv)) {
        if (aggregate) {
          try { await aggregate(receipt) } catch (aggregateError) { trace.onError?.(aggregateError) }
        }
      }
      // The mutation has already run; never retry it. A tool call's receipt is
      // rebuilt from its tagged call log line when this write fails.
      try { await trace.record(receipt) } catch (recordError) { trace.onError?.(recordError) }
    }
  }
}

/**
 * Receipts merged by id (a store import into an existing sidecar): local
 * receipts stay in order, an incoming receipt with a known id updates it
 * field by field, new ones are appended marked `imported`.
 */
export function mergeInvocations(local: unknown, incoming: unknown): any[] {
  const out: any[] = Array.isArray(local) ? local.filter((row) => row && typeof row === 'object') : []
  const index = new Map<string, number>()
  out.forEach((row, at) => { if (typeof row.id === 'string') index.set(row.id, at) })
  for (const row of Array.isArray(incoming) ? incoming : []) {
    if (!row || typeof row !== 'object' || typeof row.id !== 'string') continue
    const at = index.get(row.id)
    if (at === undefined) { index.set(row.id, out.length); out.push({ ...row, imported: true }) } else out[at] = { ...out[at], ...row }
  }
  return out
}

/** Only serializable provenance crosses into a shell. No shared current-tool variable. */
export function traceEnvironment(identity: TraceIdentity): string { return JSON.stringify(identity) }

export interface ManagedCliOptions {
  root: string; cli: string; home: string; bundle?: string | null; cacheHome?: string | null
  /** `<state>/trace/outputs`: a tagged call's output goes to its `raw/`; without it outputs are not kept. */
  outputs?: string | null
}

/**
 * Generate the managed CLI, `<root>/bin/layerfs`: a bash script ({@link nativeWrapper})
 * that sets `LAYERFS_LOGS_TAG` from the shell's `DSH_LAYERFS_TRACE_CONTEXT` with a
 * new receipt id per invocation (removing an inherited tag otherwise) and keeps a
 * tagged call's output in `trace/outputs/raw/`. LayerFS writes the call log line
 * itself. Bypassing this entry point is outside capture coverage.
 */
export function managedCli(options: ManagedCliOptions): string {
  const file = join(options.root, 'bin', 'layerfs')
  const pinned = canonicalPath(options.cli)
  // Never overwrite or recursively invoke the pin, even through a symlinked
  // root, output directory, CLI alias, or existing hardlink. Refuse before writes.
  const samePath = canonicalPath(file) === pinned
  const sameInode = existsSync(options.cli) && existsSync(file) && (() => {
    const source = statSync(options.cli), destination = statSync(file)
    return source.dev === destination.dev && source.ino === destination.ino
  })()
  if (samePath || sameInode) throw new Error('Managed CLI self-reference: select the installed LayerFS binary instead of the managed CLI entry point')
  const outputs = options.outputs ?? null
  mkdirSync(join(options.root, 'bin'), { recursive: true })
  if (outputs) mkdirSync(outputs, { recursive: true, mode: 0o700 })
  writeIfChanged(file, nativeWrapper({ cli: options.cli, home: options.home, bundle: options.bundle ?? null, cacheHome: options.cacheHome ?? null, raw: outputs ? join(outputs, RAW_DIR) : null }))
  chmodSync(file, 0o700)
  return file
}

function writeIfChanged(path: string, text: string): void {
  if (existsSync(path) && readFileSync(path, 'utf8') === text) return
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, text, { mode: 0o700 })
  renameSync(tmp, path)
}

/**
 * The managed CLI's text: a bash script, since starting node for every call
 * cost about 45 ms. It sets `LAYERFS_LOGS_TAG` to `dsh:<sessionId>:<scope>.<random>` (the
 * `makeReceipt` shape) from `DSH_LAYERFS_TRACE_CONTEXT`, removing an inherited
 * tag otherwise, and keeps a tagged call's output: stdout and stderr are teed
 * to `raw/<tag>.out` and `.err` while passing through, and the exit code goes
 * to `.exit` when the call ends (`readRaw`, `compactRaw`). stdin, the exit code
 * and INT/TERM/HUP pass through; a call killed by a signal re-raises it. Usage
 * and help words, `logs` calls and untagged shells run the CLI directly.
 */
export function nativeWrapper(o: { cli: string, home: string, bundle: string | null, cacheHome: string | null, raw: string | null }): string {
  return [
    '#!/bin/bash',
    '# dsh-layerfs managed LayerFS CLI. Generated; do not edit.',
    'umask 077',
    `export LAYERFS_HOME=${shellQuote(o.home)}`,
    ...(o.bundle ? [`export LAYERFS_BUNDLE=${shellQuote(o.bundle)}`] : []),
    ...(o.cacheHome ? [`export XDG_CACHE_HOME=${shellQuote(o.cacheHome)}`] : []),
    'unset LAYERFS_LOGS_TAG',
    `cli=${shellQuote(o.cli)}`,
    `raw=${shellQuote(o.raw ?? '')}`,
    'ctx=${DSH_LAYERFS_TRACE_CONTEXT-}',
    'case "${1-}" in \'\'|-*|help|logs) exec "$cli" "$@" ;; esac',
    'case "${2-}" in \'\'|-*) exec "$cli" "$@" ;; esac',
    '[[ $1 =~ ^[a-z][a-z_]*$ && $2 =~ ^[a-z][a-z_-]*$ ]] || exec "$cli" "$@"',
    '[[ $ctx =~ \\"sessionId\\":\\"([A-Za-z0-9.-]{1,100})\\" ]] || exec "$cli" "$@"',
    'tag="dsh:${BASH_REMATCH[1]}:"',
    '[[ $ctx =~ \\"scope\\":\\"([a-f0-9]{1,16})\\" ]] && tag="$tag${BASH_REMATCH[1]}."',
    'id=$(LC_ALL=C od -An -N16 -tx1 /dev/urandom 2>/dev/null); id=${id//[^0-9a-f]/}',
    'room=$((128 - ${#tag})); [ "$room" -gt 32 ] && room=32',
    '[ "$room" -ge 8 ] && [ ${#id} -ge 8 ] || exec "$cli" "$@"',
    'export LAYERFS_LOGS_TAG="$tag${id:0:$room}"',
    '[ -n "$raw" ] || exec "$cli" "$@"',
    '[ -d "$raw" ] || mkdir -p "$raw" 2>/dev/null || exec "$cli" "$@"',
    'out="$raw/${LAYERFS_LOGS_TAG//[^A-Za-z0-9._-]/_}"',
    // Named pipes, not `>(…)`: DSH's command sandbox denies /dev/fd. The CLI runs in the
    // background with stdin given explicitly (an async command's stdin is /dev/null
    // otherwise), so signals can be forwarded to it.
    'mkfifo "$out.po" "$out.pe" 2>/dev/null || exec "$cli" "$@"',
    'tee "$out.out" < "$out.po" &',
    'tee "$out.err" < "$out.pe" >&2 &',
    '"$cli" "$@" <&0 > "$out.po" 2> "$out.pe" &',
    'pid=$!',
    'for s in INT TERM HUP; do trap "kill -$s $pid 2>/dev/null" $s; done',
    'while :; do wait "$pid"; code=$?; kill -0 "$pid" 2>/dev/null || break; done',
    'wait',
    'rm -f "$out.po" "$out.pe"',
    'printf \'%s\\n\' "$code" > "$out.exit" 2>/dev/null',
    'if [ "$code" -gt 128 ] && [ "$code" -lt 160 ]; then trap - INT TERM HUP; kill -$((code - 128)) $$; fi',
    'exit "$code"',
    '',
  ].join('\n')
}

/** Resolve existing aliases and missing output leaves without hiding broken symlinks. */
function canonicalPath(value: string, depth = 0): string {
  if (depth > 40) throw new Error('The managed CLI path contains a symlink cycle')
  const path = resolve(value)
  try { return realpathSync(path) } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error
    try {
      if (lstatSync(path).isSymbolicLink()) return canonicalPath(resolve(dirname(path), readlinkSync(path)), depth + 1)
    } catch (linkError: any) { if (linkError?.code !== 'ENOENT') throw linkError }
    const parent = dirname(path)
    return parent === path ? path : join(canonicalPath(parent, depth + 1), basename(path))
  }
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }
