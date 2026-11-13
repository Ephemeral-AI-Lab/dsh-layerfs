/**
 * The LayerFS call log as both faces see it (docs/specs/layerfs-logs.md).
 * A line is LayerFS #659 §4 verbatim; `dsh` is this plugin's label, added by
 * the host's `logs.list` from the session sidecars and never stored in a line.
 */

/** Who made the call. This plugin always spawns the CLI, so its own lines are `cli`. */
export type CallClient = 'cli' | 'node' | 'python' | 'rust'

/** One call (LayerFS #659 §4.1). */
export interface CallLine {
  v: 1
  /** Wall-clock start, ms since the epoch. */
  at: number
  /** Duration in ms. */
  ms: number
  client: CallClient
  /** The call as CLI words, redacted (#659 §5). `argv[0]`/`argv[1]` are family and call. */
  argv: string[]
  /** `'ok'` or the refusal code. */
  outcome: string
  kind?: string
  commit?: string
  layer?: string
  tag?: string
}

/** What a line means to a project session, when its tag or commit maps to one. */
export interface CallLabel {
  sessionId: string
  /** Session title when known, for display. */
  title?: string
  origin?: 'tool' | 'host'
  turn?: number
  toolCallId?: string
  /** `tag`: the line carries this session's receipt; `commit`: matched by commit only. */
  match: 'tag' | 'commit'
  /** The simulation script step this call ran for (from the receipt). */
  step?: SimulationStep
  checkpoint?: {
    kind: string
    turn: number
    changed: number
    /** True only for a tag match on a checkpoint whose save created a version. */
    saved: boolean
  }
}

/** A simulation script step: the run and the step key (`setup.store`, `verify`, …). */
export interface SimulationStep { runId: string, stepKey: string }

export interface LabeledLine extends CallLine {
  dsh?: CallLabel
  /** A simulation's own host call (`dsh-sim:<runId>:<stepKey>`), with the run's root session when known. */
  sim?: SimulationStep & { sessionId?: string }
  /** True when `logs.output {tag}` has this call's output. */
  output?: boolean
  /**
   * `receipt`: rebuilt from the session sidecar's receipt because this
   * machine's log has no line for it (a session imported from another machine);
   * its output is never on this machine.
   */
  source?: 'receipt'
}

export interface LogsListArgs {
  /** `next` of a previous page. */
  cursor?: string
  /** Default 100, at most 1000. */
  limit?: number
  /** `family` or `family.call`. */
  op?: string
  /** `<store>/<project>`. */
  project?: string
  client?: CallClient
  /** Exact tag, or a prefix ending in `:`. */
  tag?: string
  outcome?: string
  /** Lines with `at >= since`. */
  since?: number
  /** Hide read-only calls (see `isWrite`). */
  writes?: boolean
}

export interface LogsListAnswer {
  /** Newest first. */
  lines: LabeledLine[]
  next?: string
  has_more: boolean
  /** Lines that did not parse. */
  skipped: number
  /** `layerfs`: the pinned CLI's native log (every client of the home); `plugin`: this plugin's stand-in. */
  source: 'layerfs' | 'plugin'
}

/** `logs.project {project, sandboxes?, limit?}`: one project's calls, newest first. */
export interface LogsProjectAnswer {
  lines: LabeledLine[]
  source: 'layerfs' | 'plugin'
  /** Lines read to find them. */
  scanned: number
  /** True when older lines were left unread. */
  has_more: boolean
}

export interface LogsResetAnswer { removed: number }

/** Host event after new lines may exist (coalesced). */
export const LOGS_EVENT = 'logs'

export const TAG_PREFIX = 'dsh:'
/** Longest tag LayerFS accepts (#659 §8). */
export const TAG_MAX = 128

/** `dsh:<sessionId>:<receiptId>`. */
export function sessionTag(sessionId: string, receiptId: string): string {
  return `${TAG_PREFIX}${sessionId}:${receiptId}`
}

/** Session id slot of a tag for a plugin call made outside any project session. */
export const HOST_SESSION = '-'

/** `dsh:-:<callId>`: a plugin call outside any session (pages, presets, discovery-free host calls). */
export function hostTag(callId: string): string {
  return `${TAG_PREFIX}${HOST_SESSION}:${callId}`
}

/** `dsh-sim:<runId>:<stepKey>`: a simulation's setup or verification call (no session context). */
export const SIM_TAG_PREFIX = 'dsh-sim:'

/** The tag of a simulation host call, or undefined when it would not be a valid tag. */
export function simTag(runId: string, stepKey: string): string | undefined {
  const tag = `${SIM_TAG_PREFIX}${runId}:${stepKey}`
  // eslint-disable-next-line no-control-regex
  return !!runId && !!stepKey && !runId.includes(':') && new TextEncoder().encode(tag).length <= TAG_MAX && !/[\u0000-\u001f\u007f]/.test(tag) ? tag : undefined
}

/** The run and step a `dsh-sim:` tag names, or undefined. */
export function parseSimTag(tag: string | undefined): SimulationStep | undefined {
  if (!tag?.startsWith(SIM_TAG_PREFIX)) return undefined
  const rest = tag.slice(SIM_TAG_PREFIX.length), at = rest.indexOf(':')
  if (at <= 0 || at === rest.length - 1) return undefined
  return { runId: rest.slice(0, at), stepKey: rest.slice(at + 1) }
}

/** True for any tag this plugin set (session, host or simulation); such calls may have a stored output. */
export function isDshTag(tag: string | undefined): boolean {
  return !!tag?.startsWith(TAG_PREFIX) || !!tag?.startsWith(SIM_TAG_PREFIX)
}

/** The session and receipt a session `dsh:` tag names, or undefined (also for host tags). */
export function parseTag(tag: string | undefined): { sessionId: string, receiptId: string } | undefined {
  if (!tag?.startsWith(TAG_PREFIX)) return undefined
  const rest = tag.slice(TAG_PREFIX.length), at = rest.lastIndexOf(':')
  if (at <= 0 || at === rest.length - 1) return undefined
  const sessionId = rest.slice(0, at)
  if (sessionId === HOST_SESSION) return undefined
  return { sessionId, receiptId: rest.slice(at + 1) }
}

/**
 * What a call printed, kept by this plugin for calls it made (LayerFS's own
 * log never stores output). Local to this machine, bounded, cleared by Reset.
 */
export interface CallOutput {
  tag: string
  /** Process exit code, when the CLI ran; null when killed by a signal. */
  exit?: number | null
  /** The answer (stdout), at most `OUTPUT_MAX` bytes. JSON text for most calls. */
  stdout?: string
  /** stderr, at most `OUTPUT_MAX` bytes (refusal JSON, progress, exec stderr). */
  stderr?: string
  /** Full sizes before truncation. */
  bytes: { stdout: number, stderr: number }
  truncated?: { stdout?: boolean, stderr?: boolean }
  /** The refusal parsed from the answer, when the call was refused. */
  refusal?: { code: string, message?: string, detail?: unknown }
}

/** Bytes kept per stream per call. */
export const OUTPUT_MAX = 64 * 1024

/** `logs.output {tag}` → the stored output, or `{ missing: true }` when none is kept. */
export type LogsOutputAnswer = CallOutput | { missing: true }

/** `family.call` of a line. */
export function operationOf(argv: readonly string[]): string {
  return `${argv[0] ?? ''}.${(argv[1] ?? '').replaceAll('-', '_')}`
}

/** Read-only calls hidden by `writes` until LayerFS #659 Q1 adds a read/write bit. */
const READ_CALLS = new Set(['list', 'get', 'status', 'read', 'stat', 'diff', 'commits', 'blame', 'revision', 'images', 'search', 'glob', 'grep', 'log', 'platforms', 'show', 'tree', 'history', 'stats', 'info', 'check', 'capabilities'])
/** Families that only read and have no call word (`layerfs doctor`, `layerfs help`). */
const READ_FAMILIES = new Set(['logs', 'doctor', 'help'])
export function isWrite(argv: readonly string[]): boolean {
  if (READ_FAMILIES.has(argv[0] ?? '') || argv[0]?.startsWith('-')) return false
  const call = (argv[1] ?? '').replaceAll('-', '_')
  return !READ_CALLS.has(call) && !call.startsWith('get_') && !call.startsWith('list_')
}

/** The argv as one shell command for display (`layerfs file write 'a b' …`). */
export function shellCommand(argv: readonly string[]): string {
  const quote = (word: string) => /^[\w@%+=:,./<>-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`
  return ['layerfs', ...argv.map(quote)].join(' ')
}
