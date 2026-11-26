/**
 * The LayerFS trajectory (docs/specs/layerfs-trajectory.md): the Trajectory tab
 * of a LayerFS project session, a lighter copy of DSH's that adds what each
 * tool call did in LayerFS. The host builds it from the DSH session log, the
 * session's `layerfs.json` receipts and its checkpoints; nothing is stored.
 *
 *   session.trajectory        {sessionId, since?, before?} → TrajectoryReply (a page of light
 *                             records; `{ unchanged: true }` when `since` is current)
 *   session.trajectory.record {sessionId, seq}  → TrajectoryDetail (one record in full)
 *   session.trajectory.prompt-diff {sessionId, seq} → PromptDiffAnswer (the system/tools line diff)
 */
import type { TraceCheckpoint, TraceEffect, TraceOp } from './trace.ts'

export type { TraceCheckpoint, TraceEffect, TraceOp, TraceVersion } from './trace.ts'

/** Characters kept in a record's preview. */
export const PREVIEW_MAX = 300
/** Characters a detail answer keeps per field (arguments, result, text, thinking, a tool catalog). */
export const DETAIL_MAX = 64 * 1024
/** Characters a request detail keeps of one tool's description. */
export const TOOL_DESCRIPTION_MAX = 400
/**
 * Records an older page carries (the newest of what is left). Older records
 * load on request (`{ before }`), so a long session stays bounded; a tab
 * opening reads the smaller {@link FIRST_PAGE_RECORDS} instead.
 */
export const MAX_RECORDS = 1500
/**
 * Records a tab opening carries: the newest few hundred. Older records load on
 * request, so the first paint is a fraction of a full page. A page also stops
 * at {@link FIRST_PAGE_BYTES}, whichever is smaller.
 */
export const FIRST_PAGE_RECORDS = 400
/**
 * Bytes a first page may serialize to (`JSON.stringify` of the answer). The
 * page sheds its oldest records until it fits; a page of very large records
 * (long LayerFS call lines, schemas) is therefore shorter than
 * {@link FIRST_PAGE_RECORDS}, and says so through `hasMore`/`olderBefore` and
 * each turn's `totalRecords`.
 */
export const FIRST_PAGE_BYTES = 250 * 1024
/**
 * A record's LayerFS calls one trajectory answer carries beyond the ones that
 * matter most: calls that wrote or named a version, and refusals, are always
 * kept; read-only calls are budgeted per answer (a shell loop can log
 * thousands) and the record's `opsTotal` says how many it made.
 */
export const MAX_OPS = 1200
/**
 * Calls one page carries for a tab opening (the first page only): the newest
 * read-only calls, so the first paint does not pay for a whole session's call
 * log. Calls past the budget stay out, and `opsTotal` reports them as not
 * loaded.
 */
export const FIRST_PAGE_OPS = 400
/**
 * Read-only calls one record carries at most. A single record (a subagent's
 * call, a shell loop) can log hundreds; the newest {@link MAX_RECORD_OPS} are
 * kept and `opsTotal` says how many it made. Saves, version-naming calls and
 * refusals are never dropped.
 */
export const MAX_RECORD_OPS = 64

/* ------------------------------------------------------------------ *
 * Receipt counter (docs: the receipt policy in src/host/layerfs/tracing.ts).
 * A session's sidecar keeps one small counter for the read-only host calls the
 * plugin makes itself instead of one receipt per poll; the Trajectory shows one
 * observation row for it and the inspector can list the busiest operations.
 * ------------------------------------------------------------------ */

/** One read-only operation's folded observations, as the sidecar metadata holds them. */
export interface ReadCount {
  /** Successful host reads folded into the counter. */
  count: number
  /** The newest observation's wall-clock time (ms since the epoch). */
  lastAt: number
  /** The newest observation's outcome (a refusal is recorded too, and noted here). */
  lastOutcome: 'success' | 'refusal' | 'unknown'
}

/** The `receipts` metadata one session's sidecar carries. */
export interface ReceiptMeta {
  version: 1
  /** Folded reads by operation (`workspace.status`, `home.log`, …). */
  reads: Record<string, ReadCount>
  /** Successful reads folded; the sum of `reads[*].count`. */
  readsTotal: number
  /** Earliest and newest folded read time, when one was folded. */
  firstAt?: number
  lastAt?: number
  /** Receipts a compaction dropped past the cap, cumulative. */
  dropped: number
  /** The cap in force. */
  cap: number
  /** `dropped > 0`. */
  truncated: boolean
  /** The newest legacy receipt a migration folded (crash-retry watermark). */
  foldedThrough?: string
}

/**
 * The aggregated line the Trajectory and inspector show instead of the folded
 * receipts: one compact summary, then the busiest operations (at most six).
 * Empty when nothing was folded, so a write-only session shows no line.
 */
export function receiptAggregateLines(meta: ReceiptMeta | undefined): string[] {
  if (!meta || !Number.isFinite(meta.readsTotal) || meta.readsTotal < 1) return []
  const rows = Object.entries(meta.reads ?? {})
    .filter(([, read]) => read && Number.isFinite(read.count) && read.count > 0)
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
  const total = rows.reduce((sum, [, read]) => sum + read.count, 0)
  if (total < 1) return []
  return [
    `polled ${total.toLocaleString('en-US')} times across ${rows.length} read-only operation${rows.length === 1 ? '' : 's'}`,
    ...rows.slice(0, 6).map(([operation, read]) => `${operation.replaceAll('.', ' ')}: ${read.count.toLocaleString('en-US')}${read.lastOutcome === 'success' ? '' : ` (last ${read.lastOutcome})`}`),
  ]
}

/** The property a receipts array carries its sidecar's counter under (non-enumerable). */
export const RECEIPT_META_FIELD = 'receipts'

interface RecordBase {
  /** The record's own session event seq (a tool record: its `tool/call`). Unique; the record's id. */
  seq: number
  turn: number
  step?: number
  /** Event time, ms since the epoch. */
  at?: number
}

/**
 * A `user/message`: `user` when a person wrote it (`source.kind === 'user'`),
 * else `context` (reminders, runtime context, instructions), `source` naming it.
 * Its turn is the one open when it was logged; one logged between turns belongs
 * to the next turn (at the log's end: the last turn + 1).
 */
export interface UserRecord extends RecordBase {
  kind: 'user' | 'context'
  source: string
  /** Text blocks joined, one line, at most {@link PREVIEW_MAX} characters. */
  text: string
  truncated?: boolean
}

/** A step's token accounting, mapped from DSH `TokenUsage`; absent fields were not reported. Counts are disjoint. */
export interface TrajectoryUsage {
  /** Uncached input tokens. */
  input?: number
  /** Output tokens, reasoning included. */
  output?: number
  /** Input tokens read from the provider cache. */
  cacheRead?: number
  /** Input tokens written to the provider cache. */
  cacheWrite?: number
}

/** An `assistant/message`: one model step's output. */
export interface AssistantRecord extends RecordBase {
  kind: 'assistant'
  /** Visible text preview (reasoning excluded); empty for a tool-call-only step. */
  text: string
  truncated?: boolean
  /** The step had reasoning blocks. */
  thinking?: boolean
  /** Tool calls the step made. */
  toolCalls: number
  /** `step/start` time of this step, when logged (the model lane's start). */
  startedAt?: number
  interrupted?: boolean
  /** The step's reported token usage; absent when the adapter reported none. */
  usage?: TrajectoryUsage
}

/** One tool of a request header's catalog, parsed for the detail: a description preview, a parameter count and the schema. */
export interface TrajectoryTool {
  /** The tool's name as declared. */
  name: string
  /** One line, at most {@link TOOL_DESCRIPTION_MAX} characters. */
  description?: string
  /** The description was cut at {@link TOOL_DESCRIPTION_MAX}. */
  descriptionTruncated?: boolean
  /** Top-level properties its parameter schema declares. */
  parameterCount?: number
  /** The JSON-schema object as logged (not a string). */
  parameters?: unknown
}

/** What a recorded prompt change changed: the system prompt, or the request's tool catalog. */
export type PromptChangeKind = 'system' | 'tools'

/** One line of a prompt diff in DSH's stock shape: a hunk header, context, added or removed. */
export interface PromptDiffLine {
  kind: 'meta' | 'context' | 'added' | 'removed'
  /** The rendered line, prefix included (`@@ … @@`, `+…`, `-…`, ` …`). */
  text: string
}

/** One side of the stock prompt diff, as unified hunks with 3 lines of context. */
export interface PromptDiffSection {
  lines: PromptDiffLine[]
  /** The section was cut at the diff display caps. */
  truncated?: boolean
}

/** A record's prompt diff, read on demand by the Diff tab. */
export interface PromptDiffAnswer {
  /** The trajectory record's seq the diff belongs to. */
  seq: number
  /** Present when the effective system prompt changed. */
  system?: PromptDiffSection
  /** Present when the raw tool catalog (pretty JSON) changed. */
  tools?: PromptDiffSection
  /** The seq of the recorded prompt state this diff is against. */
  before?: { seq: number }
  /** The seq of the prompt state this diff reaches (the record's seq). */
  after: { seq: number }
  /** A section was cut at the diff display caps. */
  truncated?: boolean
}

/** Tool names that differ from the session's previous request. */
export interface ToolsChange {
  /** In this request but not the previous one. */
  added: string[]
  /** In the previous request but not this one. */
  removed: string[]
  /** In both, with a different description or parameters (compared as sorted JSON). */
  changed: string[]
}

/** A `system/message`: the rendered system prompt (or a later prompt change) at a step. */
export interface SystemRecord extends RecordBase {
  kind: 'system'
  /** Text blocks joined, one line, at most {@link PREVIEW_MAX} characters. */
  text: string
  truncated?: boolean
  /** The source's `name` when logged, else its `kind` (`system-prompt`). */
  source?: string
  /** This record is where the recorded prompt changed; absent when it did not. */
  promptChanged?: PromptChangeKind
  /** The seq of the recorded prompt state this change is against. */
  previousSeq?: number
}

/** A `request/header`: the resolved call config and tool set of the request before a step. */
export interface RequestRecord extends RecordBase {
  kind: 'request'
  /** Provider route as logged. */
  provider?: string
  /** Model id as logged. */
  model?: string
  /** Assembled tool schemas in the header. */
  tools: number
  /** What differs from the session's previous request; absent for the first one. Names only (the catalog stays in the detail). */
  toolsChanged?: ToolsChange
  /** Why the header was logged (`initial`, `resume`, `change`, `series`). */
  reason?: string
  /** One line, at most {@link PREVIEW_MAX} characters: the model and tool count. */
  summary: string
  /** This record is where the recorded prompt changed; absent when it did not. */
  promptChanged?: PromptChangeKind
  /** The seq of the recorded prompt state this change is against. */
  previousSeq?: number
}

/** A `tool/call` and its `tool/result`, with the LayerFS calls it made. */
export interface ToolRecord extends RecordBase {
  kind: 'tool'
  callId: string
  name: string
  /** One line of the arguments (a command, a path …). */
  summary?: string
  /** The result's text, one line, at most {@link PREVIEW_MAX} characters; absent while running. */
  result?: string
  resultTruncated?: boolean
  isError?: boolean
  /** `tool/result` seq and time; absent while the call runs. */
  resultSeq?: number
  endedAt?: number
  /** The receipts whose `toolCallId` is this call, in order. */
  ops: TraceOp[]
  /** Calls the whole log holds for this call; present when `ops` carries only some (writes, versions and refusals are never dropped). */
  opsTotal?: number
}

/**
 * The session-level observation line: the read-only host calls folded into the
 * receipt counter, so no diagnostic silently disappears when its per-call
 * receipts are not kept. It sits once, after the newest record of the session.
 */
export interface ObservationRecord extends RecordBase {
  kind: 'observation'
  /** One compact line: `polled 82,726 times across 20 read-only operations`. */
  text: string
  /** The busiest folded operations, compact: `workspace status: 31,593`. */
  top: string[]
  /** Successful host reads folded into the counter. */
  reads: number
  /** The receipt cap dropped older receipts (the counter survives them). */
  truncated?: boolean
}

export type TrajectoryRecord = UserRecord | AssistantRecord | ToolRecord | SystemRecord | RequestRecord | ObservationRecord

export interface TrajectoryTurn {
  turn: number
  /** `turn/start` and `turn/end` times. */
  at?: number
  endAt?: number
  /** In log order. Turn 0 holds what came before the first turn (none, usually). */
  records: TrajectoryRecord[]
  /** Records this turn has in the whole log; present when `records` carries only the newest ones. */
  totalRecords?: number
  /**
   * Calls for receipts whose tool call is not in the loaded log: the log was
   * not loaded, or the call fell outside it. No name; `ops` only.
   */
  orphanCalls: { callId: string, ops: TraceOp[], opsTotal?: number }[]
  /** DSH's own LayerFS calls outside any tool call that are not a checkpoint's save. */
  hostOps: TraceOp[]
  checkpoints: TraceCheckpoint[]
}

/**
 * One checkpoint at the answer's top level. A page cuts records by turn, but
 * every checkpoint is small and navigationally useful, so the whole set rides
 * with every page instead of only the checkpoints of the turns a page keeps.
 */
export interface TraceCheckpointRow extends TraceCheckpoint {
  /** The turn whose save it records; 0 for the base checkpoint. */
  turn: number
}

export interface TrajectoryAnswer {
  sessionId: string
  project: string | null
  /** The session's current Branch. */
  branch: string | null
  /** Oldest first; turn 0 (bind, start checkpoint) first when present. */
  turns: TrajectoryTurn[]
  /**
   * Every checkpoint the session has, oldest first, independent of the page's
   * turns: a first page keeps its newest records, and an older page carries
   * the same full set so the strip and LayerFS lane never lose a checkpoint.
   */
  checkpoints: TraceCheckpointRow[]
  /** False when the session log was not loaded: records are empty, calls come from receipts. */
  logLoaded: boolean
  /** Distinct versions the session created (tool calls, its own calls and its turns' checkpoints), and the tool calls that created any. */
  counts: { versionsCreated: number, callsWithVersions: number }
  /**
   * Cheap identity of everything this answer was built from: the log length
   * and last seq, the Branch, and the checkpoint and receipt tails. A client
   * passes it back as `since`; an unchanged read answers `{ unchanged: true }`
   * instead of these turns.
   */
  revision: string
  /** Records the whole log holds; `turns` carries at most {@link MAX_RECORDS} of them (the newest). */
  recordTotal?: number
  /** Older records exist beyond this answer; read them with `{ before: olderBefore }`. */
  hasMore?: boolean
  /** The oldest record seq this answer carries: the cursor that reads the older page. */
  olderBefore?: number
}

/** The answer to `session.trajectory { sessionId, since }` when nothing moved since `since`. */
export interface TrajectoryUnchanged {
  sessionId: string
  revision: string
  unchanged: true
}

/** What `session.trajectory` answers: a page of the trajectory, or `unchanged`. */
export type TrajectoryReply = TrajectoryAnswer | TrajectoryUnchanged

/** True for the `unchanged` answer, so the caller can keep the answer it holds. */
export const isUnchanged = (reply: TrajectoryReply): reply is TrajectoryUnchanged => (reply as TrajectoryUnchanged).unchanged === true

/** One record in full, read when the inspector opens it. */
export interface TrajectoryDetail {
  seq: number
  kind: TrajectoryRecord['kind']
  /** Tool: raw `arguments` JSON as the model sent it. */
  args?: string
  /** Tool: the result's text blocks joined. */
  result?: string
  /** User, context or assistant: text blocks joined. */
  text?: string
  /** Assistant: reasoning blocks joined. */
  thinking?: string
  /** Request: the logged header, pretty-printed JSON. */
  header?: string
  /** Request: the header's tool catalog, parsed; descriptions are previews. */
  tools?: TrajectoryTool[]
  /** Request: the seq of the previous request record in this session, when this one follows another. */
  previousRequestSeq?: number
  /** Fields cut at {@link DETAIL_MAX}. */
  truncated?: ('args' | 'result' | 'text' | 'thinking' | 'header' | 'tools')[]
}

/**
 * The call log's `kind` vocabulary (docs/specs/layerfs-logs.md §4): the pinned
 * CLI names a save's result in lower case (`committed`, `unchanged`, `forked`,
 * …; its `home log --detail` reports it as `outcome`), while the plugin's
 * stand-in wrote the same word capitalized (`Committed`, `UpToDate`, `Forked`,
 * …). The families are the same, so every reader normalizes before comparing
 * and displays {@link displayKind}'s canonical word.
 *
 * Normalization: camel-case is split, then case is dropped and separators
 * (`-`, `_`, spaces) become one `-`; `uptodate`/`nochanges` fold to the same
 * spellings. An unknown kind normalizes to itself and is displayed as given.
 */
export function normalizeKind(kind: string): string {
  const normalized = kind
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase()
  return normalized === 'uptodate' ? 'up-to-date' : normalized === 'nochanges' ? 'no-changes' : normalized
}

/** What a call log `kind` says the call did to a version. */
export type KindFamily = 'created' | 'unchanged' | 'forked'

const KIND_FAMILIES: Readonly<Record<string, KindFamily>> = {
  committed: 'created',
  added: 'created',
  merged: 'created',
  'up-to-date': 'unchanged',
  'no-changes': 'unchanged',
  unchanged: 'unchanged',
  forked: 'forked',
}

/** The family a `kind` belongs to, in any vocabulary; an unknown kind has none. */
export function kindFamily(kind: string | undefined): KindFamily | undefined {
  return kind ? KIND_FAMILIES[normalizeKind(kind)] : undefined
}

const KIND_WORDS: Readonly<Record<string, string>> = {
  committed: 'Committed',
  added: 'Added',
  merged: 'Merged',
  forked: 'Forked',
  'up-to-date': 'UpToDate',
  'no-changes': 'NoChanges',
  unchanged: 'Unchanged',
}

/** The canonical word for a known kind, else the kind exactly as the CLI gave it. */
export function displayKind(kind: string): string {
  const raw = kind.trim()
  return raw ? KIND_WORDS[normalizeKind(raw)] ?? raw : raw
}

/**
 * The effect a line's `kind` names on its version: a save created it
 * (`committed`/`added`), nothing changed (`up-to-date`/`no-changes`/
 * `unchanged`), or the call only referenced it (`forked`; `merged` when the
 * caller knows it was not a fast-forward). Unknown: undefined.
 */
export function versionEffect(kind: string, fastForward?: boolean): TraceEffect | undefined {
  const normalized = normalizeKind(kind)
  if (normalized === 'committed' || normalized === 'added') return 'created'
  if (normalized === 'up-to-date' || normalized === 'no-changes' || normalized === 'unchanged') return 'unchanged'
  if (normalized === 'forked') return 'referenced'
  if (normalized === 'merged') return fastForward === false ? 'created' : 'referenced'
  return undefined
}
