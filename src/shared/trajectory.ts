/**
 * The LayerFS trajectory (docs/specs/layerfs-trajectory.md): the Trajectory tab
 * of a LayerFS project session, a lighter copy of DSH's that adds what each
 * tool call did in LayerFS. The host builds it from the DSH session log, the
 * session's `layerfs.json` receipts and its checkpoints; nothing is stored.
 *
 *   session.trajectory        {sessionId}       → TrajectoryAnswer (light records, previews)
 *   session.trajectory.record {sessionId, seq}  → TrajectoryDetail (one record in full)
 *   session.trajectory.prompt-diff {sessionId, seq} → PromptDiffAnswer (the system/tools line diff)
 */
import type { TraceCheckpoint, TraceOp } from './trace.ts'

export type { TraceCheckpoint, TraceEffect, TraceOp, TraceVersion } from './trace.ts'

/** Characters kept in a record's preview. */
export const PREVIEW_MAX = 300
/** Characters a detail answer keeps per field (arguments, result, text, thinking, a tool catalog). */
export const DETAIL_MAX = 64 * 1024
/** Characters a request detail keeps of one tool's description. */
export const TOOL_DESCRIPTION_MAX = 400

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
}

export type TrajectoryRecord = UserRecord | AssistantRecord | ToolRecord | SystemRecord | RequestRecord

export interface TrajectoryTurn {
  turn: number
  /** `turn/start` and `turn/end` times. */
  at?: number
  endAt?: number
  /** In log order. Turn 0 holds what came before the first turn (none, usually). */
  records: TrajectoryRecord[]
  /**
   * Calls for receipts whose tool call is not in the loaded log: the log was
   * not loaded, or the call fell outside it. No name; `ops` only.
   */
  orphanCalls: { callId: string, ops: TraceOp[] }[]
  /** DSH's own LayerFS calls outside any tool call that are not a checkpoint's save. */
  hostOps: TraceOp[]
  checkpoints: TraceCheckpoint[]
}

export interface TrajectoryAnswer {
  sessionId: string
  project: string | null
  /** The session's current Branch. */
  branch: string | null
  /** Oldest first; turn 0 (bind, start checkpoint) first when present. */
  turns: TrajectoryTurn[]
  /** False when the session log was not loaded: records are empty, calls come from receipts. */
  logLoaded: boolean
  /** Distinct versions the session created (tool calls, its own calls and its turns' checkpoints), and the tool calls that created any. */
  counts: { versionsCreated: number, callsWithVersions: number }
}

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
