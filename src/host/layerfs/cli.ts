/**
 * The pinned LayerFS CLI as an SDK: `lfs.<family>.<call>(...positionals, options)`
 * runs `layerfs <family> <call> [flags] -- <positionals>` once per call (no
 * replay), answering its one JSON result or throwing a LayerFSError-shaped
 * {@link CliError}. The call table comes from the CLI's own `help --json`.
 * Ported from LayerFS Connect `host/cli/` (without the activity recorder).
 *
 * The LayerFS 2.0 call surface (call-surface-2-0 `calls.json`), in this one place:
 * - a refusal is one JSON line on stderr, `{ error, message, fix?, detail? }`,
 *   exit 125: {@link CliError} keeps `error` as its `code`, and `fix`;
 * - SDK options `detail: true` (`--detail`, the long form) and `with: [...]`
 *   (`--with a,b`, only values the call's row lists under `form.with`);
 * - progress is one JSON line per event on stderr, `{ phase, done, total }`
 *   (a doctor's also carries `node`, `workspace exec`'s start event `exec`),
 *   handed to `on_progress` as it comes;
 * - a secret option (kind `content` with a `shell` flag, e.g. `store
 *   connect --password-stdin`) goes on stdin under that flag, never in argv;
 * - `workspace exec` answers one result JSON like every call (no `--events`
 *   frames): its `stdout`/`stderr` are the command's output;
 * - discovery reads each row's `form` (short and long keys, `with`, paging,
 *   progress) as the table gives it.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { traceInvocation } from './tracing.ts'
import { loggable, renderCall } from './call-words.ts'
import { outputRecord, outputSink, saveOutput, type OutputSink } from './call-output.ts'
import { hostTag, OUTPUT_MAX, parseSimTag, simTag } from '../../shared/logs.ts'

/** How a call failed: `refusal` = LayerFS answered a refusal; others are transport outcomes. */
export type Transport = 'refusal' | 'transport-unknown' | 'unavailable' | 'usage-incompatible'

/**
 * A LayerFS refusal or a transport failure. A 2.0 refusal (`{ error, message,
 * fix?, detail? }`) keeps `error` as `code` (one of the 13 public codes) and its
 * `fix`, one runnable shell line when LayerFS gives one.
 */
export class CliError extends Error {
  readonly code: string
  readonly detail: unknown
  readonly transport: Transport
  readonly fix: string | null
  constructor(code: string, message: string, detail: unknown = null, transport: Transport = 'refusal', fix: string | null = null) {
    super(message)
    this.name = 'LayerFSError'
    this.code = code
    this.detail = detail
    this.transport = transport
    this.fix = fix
  }
}

/** The 13 public refusal codes of LayerFS 2.0 (`calls.json` `refusal_codes`). */
export const REFUSAL_CODES = ['NotFound', 'Exists', 'InUse', 'Busy', 'Unresolved', 'Conflict', 'Dirty', 'Capacity', 'InvalidInput', 'Unsupported', 'Unavailable', 'Failed', 'Unknown'] as const

/**
 * A 2.0 refusal line (`{ error, message, … }`), or null. The fields the next
 * call needs stand flat beside `error` (a Busy's `running` and `op`, an InUse's
 * `workspaces`, a Dirty's `changes`, a Conflict's `commit`): they are kept in
 * `detail` with the long form's own `detail` object, which wins on a clash.
 */
export function refusalOf(frame: unknown): { error: string, message: string, fix: string | null, detail: unknown } | null {
  const r = frame as { error?: unknown, message?: unknown, fix?: unknown, detail?: unknown } | null
  if (!r || typeof r !== 'object' || typeof r.error !== 'string' || typeof r.message !== 'string') return null
  const { error, message, fix, detail, ...extra } = r as Record<string, unknown>
  const own = detail && typeof detail === 'object' && !Array.isArray(detail) ? detail as Record<string, unknown> : null
  const merged = Object.keys(extra).length ? { ...extra, ...(own ?? (detail != null ? { detail } : {})) } : detail ?? null
  return { error: error as string, message: message as string, fix: typeof fix === 'string' && fix ? fix : null, detail: merged }
}

/** A refusal's `fix` line as a spread for an answer or a job's error record (`{}` without one). */
export const fixOf = (error: unknown): { fix?: string } => {
  const fix = (error as { fix?: unknown } | null)?.fix
  return typeof fix === 'string' && fix ? { fix } : {}
}

/** One progress event (`{ phase, done, total }`, a doctor's with `node`), or null. */
export interface ProgressEvent { phase: string, done: number, total: number, node?: unknown, exec?: string }
export function progressOf(frame: unknown): ProgressEvent | null {
  const p = frame as { phase?: unknown, done?: unknown, total?: unknown, node?: unknown, exec?: unknown } | null
  if (!p || typeof p !== 'object' || typeof p.phase !== 'string' || 'error' in p) return null
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'bigint' ? Number(v) : 0)
  return { phase: p.phase, done: n(p.done), total: n(p.total), ...(p.node !== undefined ? { node: p.node } : {}), ...(typeof p.exec === 'string' ? { exec: p.exec } : {}) }
}

/** Where the CLI is and which LayerFS home it serves. */
export interface CliSpec {
  /** Absolute pinned `layerfs` binary. */
  readonly cli: string
  /** Absolute LAYERFS_HOME. */
  readonly home: string
  /** Optional folder scope. */
  readonly scope?: { readonly project: string, readonly folder: string, readonly branch?: string }
  /** `false`: every read asks the CLI (no `KEPT_READS` answers), e.g. to count spawns per repetition. */
  readonly keepReads?: boolean
  /** The Linux bundle folder VM/container machines start workers from (LAYERFS_BUNDLE). */
  readonly bundle?: string | null
  /**
   * The XDG cache home LayerFS reads prepared machine OS images from
   * (`<cacheHome>/layerfs/machine-images`), passed as XDG_CACHE_HOME. Unset:
   * the CLI inherits the host's XDG_CACHE_HOME (else `~/.cache`).
   */
  readonly cacheHome?: string | null
  /**
   * `<state>/trace/outputs`. Set: every non-discovery call LayerFS's own call
   * log keeps ({@link loggable}) carries a `dsh:` tag (a session receipt, else
   * a host tag) and has its output kept there (docs/specs/layerfs-logs.md).
   */
  readonly outputs?: string | null
  /**
   * The home gate, awaited before every call but discovery and the `home`
   * family (and an `execute` given `gated`): it may set the home up first (a
   * read on a missing home) or refuse `Uninitialized` (an older LayerFS's
   * home, which is never converted). Unset: a read on a home without `layerfs.json` is refused
   * `Uninitialized`, so reads never create a home.
   */
  readonly gate?: (call: { readonly family: string, readonly call: string, readonly read: boolean }) => Promise<void>
}

/** The keys of one answer form: those always there and those there sometimes (short), or every key (long). */
export interface FormKeys { readonly always: readonly string[], readonly sometimes: readonly string[] }

/** A 2.0 row's answer form (`help --json` `form`): short and long keys, `--with` sections, paging and progress. */
export interface CallForm {
  readonly short?: FormKeys
  readonly long?: readonly string[]
  /** `--with` sections by value: where the section goes (`own` key, or each `item`) and its keys. */
  readonly with?: Readonly<Record<string, { readonly where?: string, readonly keys?: readonly string[] }>>
  /** `cursor` (`--limit`/`--cursor` in, `items`/`next_cursor` out), else null. */
  readonly paging?: string | null
  /** The call sends progress events with `--progress`. */
  readonly progress?: boolean
  readonly quiet?: boolean
  readonly parts?: Readonly<Record<string, unknown>>
}

/** One `help --json` call table row. */
export interface CallEntry {
  readonly family: string
  readonly call: string
  readonly args: readonly { readonly name: string, readonly kind: string, readonly optional?: boolean }[]
  /** `shell`: a secret option's stdin flag (`--password-stdin`); `repeat`: given once per value; `required` (with `optional: false`): the call needs it. */
  readonly options: readonly { readonly name: string, readonly kind: string, readonly shell?: string, readonly repeat?: boolean, readonly optional?: boolean, readonly required?: boolean }[]
  /** The 2.0 answer form; absent from a table before 2.0. */
  readonly form?: CallForm
}

/** The `--with` values a call's row lists (2.0 `form.with`), none for a row without them. */
export const withValues = (entry: Pick<CallEntry, 'form'> | undefined): string[] => Object.keys(entry?.form?.with ?? {})

/** `help --json` plus `--version --json`. */
export interface Discovery {
  readonly identity: { readonly version: string, readonly commit: string, readonly dirty: boolean, readonly features: readonly string[], readonly formats?: Readonly<Record<string, number>> }
  readonly calls: readonly CallEntry[]
  readonly commands: readonly unknown[]
  readonly switches: readonly { readonly name: string, readonly calls: readonly string[] }[]
}

/**
 * The calls dsh-layerfs relies on, by their LayerFS 2.0 names; a CLI missing
 * one is refused at discovery (the platforms come from `home.get --with platforms`;
 * `home.log` and `home.clear_log` are LayerFS's own call log, the Logs page's only source).
 */
export const REQUIRED_CALLS = [
  'project.init', 'project.list', 'project.get', 'project.export', 'branch.fork', 'branch.list', 'commit.list', 'commit.diff',
  'file.read', 'file.list', 'file.apply', 'sandbox.create', 'sandbox.list', 'sandbox.get', 'sandbox.remove',
  'workspace.mount', 'workspace.commit', 'workspace.status', 'workspace.unmount', 'workspace.exec', 'workspace.cancel',
  'store.list', 'store.get', 'store.create',
  'home.get', 'home.log', 'home.clear_log', 'machine.list', 'machine.get',
] as const

/** `--with` values a required call must list (2.0 `form.with`). */
export const REQUIRED_WITH: Readonly<Record<string, readonly string[]>> = { 'home.get': ['platforms'] }

// ---------------------------------------------------------------- values

/** CLI integers stay exact: unsafe integers become bigint (Node 24 JSON source). */
export function parse(text: string): any {
  return JSON.parse(text, function (_key: string, value: any, context?: { source?: string }) {
    if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
      if (!context?.source || !/^-?\d+$/.test(context.source)) throw new Error('CLI integers require Node 24 JSON source support')
      return BigInt(context.source)
    }
    return value
  } as never)
}

/** JSON for the wire: bigint becomes its decimal string. */
export function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_k, v) => typeof v === 'bigint' ? (Number.isSafeInteger(Number(v)) ? Number(v) : String(v)) : v))
}

/** Bytes of an exec output frame. */
export const bytes = (value: unknown): Buffer => typeof value === 'string'
  ? Buffer.from(value)
  : value && typeof (value as { base64?: unknown }).base64 === 'string'
    ? Buffer.from((value as { base64: string }).base64, 'base64')
    : Buffer.alloc(0)

function lines(onLine: (line: string) => void) {
  const decoder = new StringDecoder('utf8')
  let pending = ''
  const consume = (text: string) => {
    pending += text
    let end
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end)
      pending = pending.slice(end + 1)
      if (line.trim()) onLine(line)
    }
  }
  return {
    write: (chunk: Buffer) => consume(decoder.write(chunk)),
    end: () => { consume(decoder.end()); if (pending.trim()) onLine(pending); pending = '' },
  }
}

function outcome(o: { code: number | null, signal: NodeJS.Signals | null, result: unknown, refusal: any, error?: unknown, malformed: boolean, exec?: boolean }): unknown {
  if (o.error) throw new CliError('CliUnavailable', 'The configured LayerFS CLI could not be started', null, 'unavailable')
  if (o.signal || o.malformed) throw new CliError('Unknown', 'LayerFS ended without a complete result; inspect state before another action', { signal: o.signal }, 'transport-unknown')
  if (o.code === 0 && o.result !== undefined && !o.refusal) return o.result
  // 2.0 `workspace exec` exits with the command's own code beside its one result JSON. LayerFS's
  // refusal is exit 125 *with* `{error…}` on stderr and nothing on stdout: a 125 with a result and
  // no refusal is the command's own 125.
  if (o.exec && !o.refusal && (o.result as any)?.exit_code === o.code) return o.result
  const refusal = o.code === 125 ? refusalOf(o.refusal) : null
  if (refusal) throw new CliError(refusal.error, refusal.message, refusal.detail, 'refusal', refusal.fix)
  if (o.code === 2) throw new CliError('CliIncompatible', 'LayerFS rejected the command syntax; check the selected binary and capabilities', null, 'usage-incompatible')
  throw new CliError('Unknown', 'LayerFS returned no valid final result; inspect state before another action', { exit: o.code }, 'transport-unknown')
}

// ---------------------------------------------------------------- spawning

interface ExecuteOptions {
  input?: string | Buffer
  read?: boolean
  /** The home gate already ran, or must not (the service's own set up of a missing home). */
  gated?: boolean
  storeRead?: string
  discovery?: boolean
  timeout?: number
  env?: Record<string, string>
  onProgress?: (progress: unknown) => void
  onSpawn?: (child: ChildProcess) => void
  /** Recheck cancellation after admission, immediately before starting a process. */
  beforeSpawn?: () => void
  /** A separate admission lane (name and limit) for bulk callers, so page reads are not queued behind them. */
  lane?: Lane
  /**
   * Ends the call for a caller that stopped waiting: a call still queued leaves
   * its lane and never starts a process; a running one has its process group
   * ended. Either way it is refused `Cancelled`.
   */
  signal?: AbortSignal
  /**
   * `LAYERFS_LOGS_TAG` for this call. {@link execute} sets it from the trace
   * context; outside one a caller may pass a `dsh-sim:<runId>:<stepKey>` tag
   * (simulation setup/verification), other values are replaced by a host tag.
   */
  tag?: string
  /** Where the call's output is collected for the output store (set by {@link logged}). */
  capture?: Capture
  /** Filled by {@link logged} with the call's start and duration (ms). */
  timing?: Timing
}

interface Timing { at?: number, ms?: number }

/** One call's output as it arrives: bounded stdout/stderr, the refusal, the exit. */
interface Capture { stdout: OutputSink, stderr: OutputSink, refusal?: unknown, exit?: number | null }

const lanes = new Map<string, { active: number, waiting: (() => void)[] }>()
/** Exclusive lanes held by the current async chain; a hold ends when its `run` settles.
 * Work started inside `run` without being awaited inherits the hold while it lasts,
 * so it must not run a CLI call on the same Store concurrently with the holder. */
const holding = new AsyncLocalStorage<readonly { key: string, live: boolean }[]>()
async function admit<T>(key: string, limit: number, run: () => Promise<T>, signal?: AbortSignal, queue?: { most: number, full: () => Error }): Promise<T> {
  // Re-entrant: work awaited inside an exclusive hold (a hook nested in a held tool call)
  // runs in that hold instead of queueing behind itself.
  const outer = holding.getStore()?.filter(hold => hold.live) ?? []
  if (limit === 1 && outer.some(hold => hold.key === key)) return run()
  signal?.throwIfAborted()
  let lane = lanes.get(key)
  // A bounded queue (the inspect lane): one more waiter than it holds is refused now, not queued.
  if (queue && lane && lane.active >= limit && lane.waiting.length >= queue.most) throw queue.full()
  if (!lane) lanes.set(key, lane = { active: 0, waiting: [] })
  if (lane.active >= limit) {
    const current = lane
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        const index = current.waiting.indexOf(wake)
        // Already handed the lane: proceed, `run` sees the abort itself.
        if (index < 0) return
        current.waiting.splice(index, 1)
        reject(signal!.reason)
      }
      const wake = () => { signal?.removeEventListener('abort', abort); resolve() }
      current.waiting.push(wake)
      signal?.addEventListener('abort', abort, { once: true })
    })
  } else lane.active++
  const hold = { key, live: true }
  try { return await (limit === 1 ? holding.run([...outer, hold], run) : run()) } finally {
    hold.live = false
    const next = lane.waiting.shift()
    if (next) next()
    else if (--lane.active === 0) lanes.delete(key)
  }
}

/** Wait for, then hold, this host's one-process-per-Store lane (the lane `execute`
 * uses) around `run`. Re-entrant within `run`'s own async chain; waiting ends with
 * `signal`'s reason when it aborts first. */
export function admitStore<T>(home: string, store: string, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return admit(JSON.stringify(['store', home, store]), 1, run, signal)
}

/**
 * The Store a call opens, or undefined. Calls on a project (`<store>/<project>`)
 * and `store get --with stats` open the Store in their own process and take its
 * lease (`store/<name>/open/<pid>`); `store get` without it and `store list`
 * read records.
 * Accepts both argv shapes: SDK words (`family call [--flags] -- positionals`)
 * and the preset driver's (`family call positionals [--flags]`).
 */
export function storeOfCall(argv: readonly string[]): string | undefined {
  const [family, call] = argv
  const at = argv.indexOf('--with')
  const stats = family === 'store' && call === 'get' && at >= 0 && String(argv[at + 1] ?? '').split(',').includes('stats')
  if (!(['file', 'branch', 'commit', 'project'].includes(family!) || stats)) return undefined
  const dash = argv.indexOf('--')
  const first = dash >= 0 ? argv[dash + 1] : argv[2]
  if (!first || first.startsWith('--')) return undefined
  return first.split('/')[0] || undefined
}

/** Live CLI children, for shutdown. Each runs in its own process group, and its
 * `kill` signals the whole group (a CLI's helpers included). */
export const children = new Set<ChildProcess>()

/** After SIGTERM, how long a timed-out call's process group has before SIGKILL. */
export const KILL_GRACE_MS = 2000
/** After the CLI exits, how long its stdout/stderr may stay open (held by a helper it left behind). */
export const EXIT_GRACE_MS = 2000
/** The default budget of an SDK read call; `timeout_ms` overrides it (0: none). */
export const READ_TIMEOUT_MS = 120_000
/**
 * The default budget of a machine probe ({@link PROBES}). A healthy machine
 * answers in well under a second; one whose VM died while its Lima host agent
 * lives on (`limactl list` still says Running) holds the probe on an SSH that
 * never connects, so the page learns it is unreachable in seconds, not minutes.
 */
export const PROBE_TIMEOUT_MS = 15_000
/** Machine reads that pages poll: their own lane and the shorter budget. */
export const PROBES = new Set(['machine.get', 'machine.list', 'machine.images'])
/**
 * Reads whose answer is reused for this many ms (state polls; machine probes take seconds
 * each). A write through the same client clears them all, and a read that was running
 * when a write began or ended keeps nothing.
 */
export const KEPT_READS = new Map<string, number>([
  ['store.get', 2000], ['store.list', 2000], ['project.get', 2000], ['project.list', 2000], ['branch.list', 2000],
  ['machine.get', 2000], ['machine.list', 5000], ['machine.images', 5000], ['home.get', 2000],
])

/** An admission lane: at most `limit` processes at once; with `queue`, at most that many waiting (one more is refused `Busy`). */
export interface Lane { readonly name: string, readonly limit: number, readonly queue?: number }

/**
 * Monitoring reads (layerfs-project#179 D, #178, #164): a machine's worker
 * log (`machine.log`), a Sandbox's daemon log, the files of either, and a
 * machine's observed resources (`machine.stats`: one worker request, polled by
 * the Machines pages; with `--with space` also where its data disk goes, one
 * bounded walk read about once a minute while a page shows it). Named with
 * their family, and checked before {@link READS}: none of
 * them opens a Store. Each is a read in its own {@link INSPECT_LANE}, never in
 * `calls` (mount, Commit, unmount) or `probes`; it runs once,
 * for at most {@link INSPECT_TIMEOUT_MS}; it clears no kept answer, writes no
 * call log line and keeps no output.
 */
export const INSPECT_CALLS = new Set(['machine.log', 'sandbox.log', 'sandbox.files', 'machine.files', 'machine.stats'])
/** The inspect lane: 2 reads run, 4 wait; one more is refused `Busy` at once (admission, not a retry). */
export const INSPECT_LANE: Lane = { name: 'inspect', limit: 2, queue: 4 }
/** The most an inspect read may take (LayerFS's own budget is connect 2 s, hello 2 s, answer 8 s). */
export const INSPECT_TIMEOUT_MS = 15_000

/**
 * The admission lane a call takes when its caller names none. Short calls share
 * `calls`; calls that run as long as their work (VM create/start, Store
 * push/pull, backups, project init/export, Doctor, connection checks) take
 * `jobs`; Workspace commands (terminals) take `exec`; `workspace cancel` its own;
 * machine probes ({@link PROBES}) take `probes`; monitoring reads
 * ({@link INSPECT_CALLS}) take `inspect`. So a page's short reads are
 * never queued behind long work or behind probes of an unreachable machine,
 * terminals never starve jobs or the other way round, and a hung log or files
 * read holds nothing else.
 */
export function laneOf(argv: readonly string[]): Lane {
  const family = argv[0] ?? '', call = String(argv[1] ?? '').replaceAll('-', '_')
  if (INSPECT_CALLS.has(`${family}.${call}`)) return INSPECT_LANE
  if (family === 'workspace' && call === 'cancel') return { name: 'cancel', limit: 4 }
  if (family === 'workspace' && call === 'exec') return { name: 'exec', limit: 8 }
  if (family === 'doctor' || LONG_CALLS.has(`${family}.${call}`)) return { name: 'jobs', limit: 4 }
  if (PROBES.has(`${family}.${call}`)) return { name: 'probes', limit: 4 }
  return { name: 'calls', limit: 4 }
}
const LONG_CALLS = new Set([
  'project.init', 'project.export',
  'machine.create', 'machine.start', 'machine.stop', 'machine.update', 'machine.remove', 'machine.load_image', 'machine.prune',
  'store.move', 'store.connect', 'store.attach', 'store.detach', 'store.doctor', 'store.compact', 'store.upgrade',
  'backup.connect', 'backup.create', 'backup.restore',
  'sandbox.create', 'sandbox.remove',
])

/** Signal a CLI's whole process group (it was spawned detached), else the process itself. */
function signalGroup(child: ChildProcess, kill: (signal: NodeJS.Signals) => boolean, signal: NodeJS.Signals): boolean {
  if (child.pid) {
    try { process.kill(-child.pid, signal); return true } catch { /* no such group: the process alone */ }
  }
  try { return kill(signal) } catch { return false }
}

let exitHook = false
/** On host exit, end what is still running (detached children do not get the terminal's signals). */
function killOnExit(): void {
  if (exitHook) return
  exitHook = true
  process.on('exit', () => { for (const child of children) { try { child.kill('SIGTERM') } catch { /* gone */ } } })
}

/**
 * Run one CLI command once.
 * @param spec - binary and home.
 * @param argv - words after the binary.
 * @param options - input, framing and callbacks.
 * @returns the parsed final result.
 */
export function execute(spec: CliSpec, argv: readonly string[], options: ExecuteOptions = {}): Promise<any> {
  if (options.discovery) return executeRaw(spec, argv, options)
  const target = ['file', 'branch'].includes(argv[0]) || (argv[0] === 'workspace' && argv[1] === 'commit') ? renderCall(argv)[2] : undefined
  // A session receipt's tag wins; else the caller's own `dsh-sim:` tag (simulation setup and verification).
  // The receipt takes the call's own start and duration when its output is kept.
  const timing: Timing = {}
  return traceInvocation(argv.slice(0, 2).join('.').replaceAll('-', '_'), (tag) => logged(spec, argv, { ...options, tag: tag ?? callerTag(options.tag), timing }),
    argv[0] === 'workspace' ? undefined : target, argv[0] === 'workspace' ? target : undefined,
    () => ({ argv, input: options.input ?? null, bools: boolOptions(spec.cli), ...timing }))
}

/** A caller-supplied tag outside a trace context: only a valid `dsh-sim:` tag, else none (a host tag is made). */
function callerTag(tag: string | undefined): string | undefined {
  const sim = parseSimTag(tag)
  return sim && simTag(sim.runId, sim.stepKey) === tag ? tag : undefined
}

/**
 * Run a call with a `dsh:` tag (the session receipt's, else a host tag) and
 * keep its output in `trace/outputs/` before answering. Keeping it never
 * changes the call's outcome.
 */
async function logged(spec: CliSpec, argv: readonly string[], options: ExecuteOptions): Promise<any> {
  if (!spec.outputs || !loggable(argv)) return executeRaw(spec, argv, options)
  const tag = options.tag ?? hostTag(randomUUID().replaceAll('-', ''))
  const capture: Capture = { stdout: outputSink(OUTPUT_MAX, 'head'), stderr: outputSink(OUTPUT_MAX, 'tail') }
  const at = Date.now(), started = performance.now()
  let error: any, spawned = false
  const onSpawn = (child: ChildProcess) => { spawned = true; options.onSpawn?.(child) }
  try { return await executeRaw(spec, argv, { ...options, tag, capture, onSpawn }) } catch (e) { error = e; throw e } finally {
    // A call refused before the CLI started, or whose syntax it rejected, has no line (#659 §10).
    const ran = spawned && (!error || !['unavailable', 'usage-incompatible'].includes(error?.transport))
    if (ran) {
      try { saveOutput(spec.outputs, outputRecord({ tag, exit: capture.exit, stdout: capture.stdout, stderr: capture.stderr, refusal: capture.refusal, max: OUTPUT_MAX })) } catch { /* best effort */ }
      if (options.timing) Object.assign(options.timing, { at, ms: Math.max(0, Math.round(performance.now() - started)) })
    }
  }
}

/** `Uninitialized`: the home is not set up (missing, or an older LayerFS's); answered 503, expected. */
export const uninitialized = (home: string, message?: string): CliError => new CliError('Uninitialized',
  message ?? `The LayerFS folder ${home} is not set up yet; open Set up LayerFS (Center) to create it`, { missing: [`home:${home}`] })

/**
 * The home gate a call waits on before it is admitted, or null when it has
 * none: discovery, the `home` family and a call already gated pass; a spec without a gate refuses reads on a home without
 * `layerfs.json` (reads never create a home).
 */
function gateOf(spec: CliSpec, argv: readonly string[], options: ExecuteOptions): Promise<void> | null {
  if (options.gated || options.discovery || !spec.home || argv[0] === 'home') return null
  if (spec.gate) return spec.gate({ family: argv[0] ?? '', call: argv[1] ?? '', read: !!options.read })
  if (options.read && !existsSync(join(spec.home, 'layerfs.json'))) return Promise.reject(uninitialized(spec.home))
  return null
}

function executeRaw(spec: CliSpec, argv: readonly string[], options: ExecuteOptions): Promise<any> {
  if (!spec.cli || !isAbsolute(spec.cli) || !existsSync(spec.cli)) {
    return Promise.reject(new CliError('CliUnavailable', 'No LayerFS runtime is chosen yet. Open Set up LayerFS in Center, or set DSH_LAYERFS_CLI', null, 'unavailable'))
  }
  const own = laneOf(argv)
  // workspace cancel and monitoring reads keep their own lane whatever the caller names
  const chosen = own.name === 'cancel' || own.name === 'inspect' ? own : options.lane ?? own
  const signal = options.signal
  const full = chosen.queue === undefined ? undefined : {
    most: chosen.queue,
    full: () => new CliError('Busy', `${chosen.limit} ${chosen.name} reads are running and ${chosen.queue} are waiting on this host; read again in a moment`, { lane: chosen.name, running: chosen.limit, queued: chosen.queue }),
  }
  const cancelled = () => new CliError('Cancelled', 'The read was dropped: nobody waits for its answer')
  const gated = gateOf(spec, argv, options)
  if (gated) return gated.then(() => executeRaw(spec, argv, { ...options, gated: true }))
  const launch = () => admit(`${spec.cli}:${chosen.name}`, chosen.limit, () => new Promise<unknown>((resolve, reject) => {
    if (!options.discovery && !spec.home) return reject(new CliError('InvalidInput', 'LayerFS requires an explicit home'))
    let result: unknown, refusal: any, spawnError: unknown, malformed = false, finals = 0
    const capture = options.capture
    // stdout: the one result JSON line
    const stdout = lines((line) => {
      try {
        const frame = parse(line)
        if (++finals !== 1) throw new Error('Extra result')
        result = frame
      } catch { malformed = true }
    })
    // stderr: progress events (`{ phase, done, total }`, one per line) and at most one refusal (`{ error, message, … }`)
    const stderr = lines((line) => {
      try {
        const frame = parse(line)
        const progress = progressOf(frame)
        if (progress) options.onProgress?.(progress)
        else if (refusalOf(frame)) { if (refusal) malformed = true; refusal ??= frame }
        else malformed = true
      } catch { /* plain-text usage; exit 2 classifies it */ }
    })
    try { options.beforeSpawn?.() } catch (error) { reject(error); return }
    // Dropped while it waited for the lane (the waiter was already woken): no process starts.
    if (signal?.aborted) { reject(cancelled()); return }
    // Its own process group, so a timeout or shutdown ends the CLI's helpers with it;
    // `child.kill` signals that group for every holder (shutdown, simulation cancel).
    const child = spawn(spec.cli, [...argv], {
      shell: false, stdio: ['pipe', 'pipe', 'pipe'], detached: true,
      env: { ...tagged(options), ...(spec.home ? { LAYERFS_HOME: spec.home } : {}), ...(spec.bundle ? { LAYERFS_BUNDLE: spec.bundle } : {}), ...(spec.cacheHome ? { XDG_CACHE_HOME: spec.cacheHome } : {}), LAYERFS_PROGRESS_JSON: '1' },
    })
    const kill = child.kill.bind(child)
    child.kill = ((signal: NodeJS.Signals | number = 'SIGTERM') => signalGroup(child, kill, signal as NodeJS.Signals)) as typeof child.kill
    children.add(child)
    killOnExit()
    child.once('error', (error) => { spawnError = error })
    child.stdin?.on('error', () => {})
    child.stdout?.on('data', (data: Buffer) => { capture?.stdout.push(data); stdout.write(data) })
    child.stderr?.on('data', (data: Buffer) => { capture?.stderr.push(data); stderr.write(data) })
    let deadline: NodeJS.Timeout | undefined, exitGrace: NodeJS.Timeout | undefined, giveUp: NodeJS.Timeout | undefined
    let timedOut = false, dropped = false, exited = false, done = false
    const unclose = () => { child.stdout?.destroy(); child.stderr?.destroy() }
    /** End the process group now and settle even if a helper of it survives SIGTERM. */
    const stop = () => {
      child.kill('SIGTERM')
      // Escalate even after the CLI itself is gone: a helper of its group may ignore SIGTERM.
      setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref()
      giveUp = setTimeout(() => { unclose(); settle(null, null) }, 2 * KILL_GRACE_MS)
    }
    const drop = () => { if (done || timedOut || dropped) return; dropped = true; clearTimeout(deadline); stop() }
    const settle = (code: number | null, signal: NodeJS.Signals | null) => {
      if (done) return
      done = true
      clearTimeout(deadline); clearTimeout(exitGrace); clearTimeout(giveUp)
      options.signal?.removeEventListener('abort', drop)
      // A process that outlived even SIGKILL stays listed until it exits, for shutdown.
      if (exited || !(timedOut || dropped)) children.delete(child)
      stdout.end(); stderr.end()
      if (capture) { capture.exit = code; capture.refusal = refusal }
      if (dropped) { reject(cancelled()); return }
      if (timedOut) {
        reject(new CliError('Unknown', 'LayerFS did not answer in time and was stopped; inspect state before another action', { signal, timeout: options.timeout }, 'transport-unknown'))
        return
      }
      try { resolve(outcome({ code, signal, result, refusal, error: spawnError, malformed, exec: argv[0] === 'workspace' && argv[1] === 'exec' })) } catch (error) { reject(error) }
    }
    if (options.timeout) {
      deadline = setTimeout(() => {
        if (dropped) return
        timedOut = true
        stop()
      }, options.timeout)
    }
    signal?.addEventListener('abort', drop, { once: true })
    child.once('exit', (code, signal) => {
      exited = true
      clearTimeout(deadline)
      if (done) { children.delete(child); return }
      // Normally 'close' follows at once; a helper holding stdout/stderr must not keep the call open.
      exitGrace = setTimeout(() => { unclose(); settle(code, signal) }, EXIT_GRACE_MS)
    })
    child.once('close', (code, signal) => settle(code, signal))
    try { options.onSpawn?.(child) } catch { malformed = true; child.kill('SIGTERM') }
    child.stdin?.end(options.input)
  }), signal, full).catch((error) => {
    // A waiter dropped from the queue is refused like a dropped running read.
    if (signal?.aborted && !(error instanceof CliError)) throw cancelled()
    throw error
  })
  // One CLI process per Store at a time, reads and writes alike, for every caller in this host
  // (presets, routes, sessions). Two processes on one Store fail in LayerFS: a lease claim deletes a
  // neighbour's lease file that its exiting owner already removed (`Os NotFound`), and on macOS a
  // second SQLite opener meets `Busy` with no writer lane or busy handler (some after an effect).
  const store = options.storeRead ?? storeOfCall(argv)
  return store ? admit(JSON.stringify(['store', spec.home, store]), 1, launch) : launch()
}

/** The child's environment: inherited, without an inherited log tag, plus the call's own tag. */
function tagged(options: ExecuteOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.LAYERFS_LOGS_TAG
  Object.assign(env, options.env)
  if (options.tag) env.LAYERFS_LOGS_TAG = options.tag
  return env
}

// ---------------------------------------------------------------- discovery

const known = new Map<string, Promise<Discovery>>()
const settled = new Map<string, Discovery>()
/** The identity (`--version --json`) of an already discovered CLI, without waiting. */
export function knownIdentity(cli: string): Discovery['identity'] | undefined { return settled.get(cli)?.identity }

/** Bool option names of an already discovered call table (rendering only). */
export function boolOptions(cli: string): string[] | undefined {
  const d = settled.get(cli)
  return d ? [...new Set(d.calls.flatMap((c) => c.options.filter((o) => o.kind === 'bool').map((o) => o.name)))] : undefined
}

/**
 * Discover the CLI's identity and call table once per binary path.
 * @param spec - the binary (home unused).
 * @param fresh - forget a cached discovery (after a pin change).
 */
export function discover(spec: Pick<CliSpec, 'cli'>, fresh = false): Promise<Discovery> {
  if (fresh) { known.delete(spec.cli); settled.delete(spec.cli) }
  if (!known.has(spec.cli)) {
    const pending = (async () => {
      const s = { cli: spec.cli, home: '' }
      const identity = await execute(s, ['--version', '--json'], { discovery: true, timeout: 15000 })
      const help = await execute(s, ['help', '--json'], { discovery: true, timeout: 15000 })
      if (!identity || !/^[a-f0-9]{40}$/.test(identity.commit ?? '') || !Array.isArray(help?.calls)) {
        throw new CliError('CliIncompatible', 'The selected LayerFS CLI has no compatible JSON discovery', null, 'usage-incompatible')
      }
      for (const name of REQUIRED_CALLS) {
        if (!help.calls.some((c: CallEntry) => `${c.family}.${c.call}` === name)) throw new CliError('CliIncompatible', `The selected LayerFS CLI lacks ${name}`, null, 'usage-incompatible')
      }
      for (const [name, values] of Object.entries(REQUIRED_WITH)) {
        const have = withValues(help.calls.find((c: CallEntry) => `${c.family}.${c.call}` === name))
        for (const v of values) if (!have.includes(v)) throw new CliError('CliIncompatible', `The selected LayerFS CLI lacks ${name} --with ${v} (a LayerFS 2.0 runtime is needed)`, null, 'usage-incompatible')
      }
      return { identity, calls: help.calls, commands: help.commands ?? [], switches: help.switches ?? [] } as Discovery
    })()
    pending.then((d) => { if (known.get(spec.cli) === pending) settled.set(spec.cli, d) }, () => known.delete(spec.cli))
    known.set(spec.cli, pending)
  }
  return known.get(spec.cli)!
}

// ---------------------------------------------------------------- client

/**
 * One monitoring read ({@link INSPECT_CALLS}): one process in the inspect
 * lane, once, for at most {@link INSPECT_TIMEOUT_MS}. It bypasses the call log,
 * the output store and session receipts (a 2 s poll would flood all three), and
 * a read that outlives its budget is refused `Timeout`, not `Unknown`: it
 * writes nothing, so there is no state to inspect before reading again.
 */
export function inspectRead(spec: CliSpec, argv: readonly string[], options: { timeout?: number, signal?: AbortSignal, onSpawn?: (child: ChildProcess) => void } = {}): Promise<any> {
  const timeout = Math.min(options.timeout && options.timeout > 0 ? options.timeout : INSPECT_TIMEOUT_MS, INSPECT_TIMEOUT_MS)
  return executeRaw(spec, argv, { read: true, timeout, signal: options.signal, onSpawn: options.onSpawn }).catch((error) => {
    if (error instanceof CliError && error.transport === 'transport-unknown' && (error.detail as any)?.timeout) {
      throw new CliError('Timeout', `LayerFS did not answer the read in ${Math.round(timeout / 1000)} s; it was stopped`, { timeout }, 'transport-unknown')
    }
    throw error
  })
}

const READS = new Set(['list', 'get', 'status', 'images', 'stats', 'read', 'stat', 'glob', 'grep', 'blame', 'diff', 'history', 'log'])
const invalid = (message: string) => new CliError('InvalidInput', message)
const isPlain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v)

/**
 * LayerFS's refusal when two processes open one Store at once: a lease claim
 * meets a neighbour's lease file its exiting owner already removed
 * (`Failed`, `Os { code: 2, kind: NotFound, … }`). This host serializes its own
 * calls per Store, but agents' CLIs and other processes do not.
 */
export const storeRace = (error: unknown): boolean => error instanceof CliError && error.transport === 'refusal'
  && error.code === 'Failed' && /\bNotFound\b/.test(error.message)


/** `lfs.family.call(...)`; every call answers a Promise. */
export type Lfs = { readonly spec: CliSpec } & Record<string, Record<string, (...args: any[]) => Promise<any>>>

/**
 * Build the SDK-shaped client for one spec. Identical concurrent reads share one process.
 * @param spec - binary, home and optional scope.
 */
export function client(spec: CliSpec): Lfs {
  const flying = new Map<string, Promise<unknown>>()
  // Answers of polling reads, kept briefly: pages, tabs and every agent step ask these many
  // times a second during a team run, each a CLI process in the Store's queue. Any write
  // through this client clears them, so what it changed is read fresh.
  const recent = new Map<string, { until: number, value: unknown }>()
  // Writes through this client, counted at their start and their end: a read keeps its
  // answer (and is shared) only within the count it started under, so a read that was
  // already running when a write began or ended never serves what that write changed.
  let writes = 0
  const families = new Map<string, Record<string, (...a: any[]) => Promise<any>>>()
  return new Proxy({ spec } as Lfs, {
    get(target, family: string | symbol) {
      if (family in target) return (target as any)[family]
      if (typeof family !== 'string' || family === 'then') return undefined
      if (!families.has(family)) families.set(family, new Proxy({}, {
        get(_unused, call: string | symbol) {
          if (typeof call !== 'string' || call === 'then') return undefined
          return async (...given: unknown[]) => {
            const help = await discover(spec)
            const entry = help.calls.find((c) => c.family === family && c.call === call)
            if (!entry) throw invalid(`No LayerFS call ${family}.${call}`)
            const args = [...given]
            let options: any = {}
            const last = args.at(-1), slot = entry.args[args.length - 1]
            if (args.length > entry.args.length || (isPlain(last) && slot?.kind !== 'json')) options = args.pop() ?? {}
            if (!isPlain(options) || args.length > entry.args.length) throw invalid('Invalid LayerFS arguments')
            // SDK-only options, never CLI flags: the spawn callback, the call's time budget, and (monitoring reads) the caller's abort signal.
            const inspect = INSPECT_CALLS.has(`${family}.${call}`)
            const local = new Set(inspect ? ['on_spawn', 'timeout_ms', 'signal'] : ['on_spawn', 'timeout_ms'])
            // the 2.0 global options: `detail` (the long form) and `with` (sections the row lists)
            const { detail, with: sections, ...own } = options
            options = own
            if (detail != null && typeof detail !== 'boolean') throw invalid('detail must be true or false')
            const withList: string[] = sections == null ? [] : Array.isArray(sections) ? sections.map(String) : [String(sections)]
            const offered = withValues(entry)
            for (const v of withList) if (!offered.includes(v)) throw invalid(`${family}.${call} takes no --with ${v}${offered.length ? ` (it takes ${offered.join(', ')})` : ''}`)
            for (const name of Object.keys(options)) {
              if (!local.has(name) && !entry.options.some((o) => o.name === name)) throw invalid(`${family}.${call}: unknown option ${name}`)
            }
            // an option the row marks required (`required`, `optional: false`) is a usage error when left out: say so before spawning
            for (const o of entry.options) if ((o.required === true || o.optional === false) && o.kind !== 'function' && (options[o.name] === undefined || options[o.name] === null)) throw invalid(`${family}.${call}: ${o.name} is required`)
            for (const [name, value] of Object.entries(options)) {
              const option = entry.options.find((o) => o.name === name)
              if (option?.kind === 'bool' && value != null && typeof value !== 'boolean') throw invalid(`${name} must be true or false`)
              if (name === 'timeout_ms') { if (value != null && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)) throw invalid('timeout_ms must be a nonnegative integer'); continue }
              if (name === 'signal' && inspect) { if (value != null && !(value instanceof AbortSignal)) throw invalid('signal must be an AbortSignal'); continue }
              if ((option?.kind === 'function' || local.has(name)) && value != null && typeof value !== 'function') throw invalid(`${name} must be a function`)
              if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) throw invalid(`${name} must preserve exact numeric values`)
              // 2.0 (CUT): an exec's env is an object of names to text; a list of `K=V` or a text is refused, so it is not sent
              if (family === 'workspace' && call === 'exec' && name === 'env' && value != null && (!isPlain(value) || !Object.values(value).every((v) => typeof v === 'string'))) throw invalid('env is an object of names to text')
            }
            const words = [family, call.replaceAll('_', '-')]
            const positionals: string[] = []
            let input: string | undefined
            let omitted: string | undefined
            for (let i = 0; i < entry.args.length; i++) {
              const arg = entry.args[i], value = args[i]
              if (value === undefined || value === null) { if (!arg.optional) throw invalid(`${arg.name} is required`); if (arg.kind !== 'content' && arg.kind !== 'json') omitted ??= arg.name; continue }
              if (arg.kind === 'content' || arg.kind === 'json') input = arg.kind === 'json' ? JSON.stringify(value) : String(value)
              // Positionals have no names: a later one after an omitted one would take its place.
              else if (omitted) throw invalid(`${arg.name} cannot be given without ${omitted}`)
              else positionals.push(String(value))
            }
            for (const [name, value] of Object.entries(options)) {
              if (value === undefined || value === null || local.has(name) || typeof value === 'function') continue
              const option = entry.options.find((o) => o.name === name)
              const flag = `--${name.replaceAll('_', '-')}`
              // a secret (a password, a bucket's secret key): on stdin under the row's shell flag, never in argv
              if (option?.kind === 'content') {
                if (input !== undefined) throw invalid(`${family}.${call}: one stdin input per call`)
                if (typeof value !== 'string' || !value) throw invalid(`${name} must be a non-empty string`)
                input = value
                words.push(option.shell ?? `${flag}-stdin`)
              } else if (option?.kind === 'bool') words.push(`${flag}=${value}`)
              // a repeated option (`--env K=V`): an object is one `K=V` per key, a list one value each
              else if (option?.repeat && isPlain(value)) for (const [k, v] of Object.entries(value)) words.push(flag, `${k}=${v}`)
              else if (option?.repeat && Array.isArray(value)) for (const v of value) words.push(flag, String(v))
              else words.push(flag, typeof value === 'object' ? JSON.stringify(value) : String(value))
            }
            if (detail) words.push('--detail')
            if (withList.length) words.push('--with', [...new Set(withList)].join(','))
            if (options.on_progress || (((family === 'machine' && ['start', 'create'].includes(call)) || (family === 'sandbox' && call === 'create')) && entry.options.some((o) => o.name === 'on_progress'))) words.push('--progress')
            if (spec.scope) words.push('--scope', spec.scope.folder, '--scope-project', spec.scope.project, ...(spec.scope.branch ? ['--scope-branch', spec.scope.branch] : []))
            words.push('--', ...positionals)
            // Monitoring reads first: their own lane and budget, one attempt, nothing kept and nothing cleared.
            if (inspect) return inspectRead(spec, words, { timeout: (options as any).timeout_ms || undefined, signal: (options as any).signal ?? undefined, onSpawn: (child) => (options as any).on_spawn?.(child.pid) })
            const read = READS.has(call)
            // Reads get a generous default budget (machine probes a short one); writes and long work (exec, jobs) none unless asked.
            const opts: any = options
            const timeout: number | undefined = opts.timeout_ms ?? (!read ? undefined : PROBES.has(`${family}.${call}`) ? PROBE_TIMEOUT_MS : READ_TIMEOUT_MS)
            const storeRead = read && args[0] && (entry.args[0]?.kind === 'project' || family === 'store') ? String(args[0]).split('/')[0] : undefined
            const invoke = () => execute(spec, words, {
              input, read, storeRead, timeout: timeout || undefined,
              onProgress: opts.on_progress,
              onSpawn: (child) => opts.on_spawn?.(child.pid),
            })
            if (!read) {
              writes++
              recent.clear()
              return invoke().finally(() => { writes++; recent.clear() })
            }
            const key = JSON.stringify([words, input ?? null])
            const started = writes
            // A call with its own budget is a deliberate probe: it always asks.
            const keep = opts.timeout_ms === undefined && spec.keepReads !== false ? KEPT_READS.get(`${family}.${call}`) : undefined
            const kept = keep ? recent.get(key) : undefined
            if (kept && kept.until > Date.now()) return Promise.resolve(kept.value)
            // shared only with an identical read started under the same write count
            const share = JSON.stringify([started, key])
            if (!flying.has(share)) {
              // one attempt: a refusal (a Store race included) passes through as it came
              const pending = invoke()
              flying.set(share, pending)
              pending.then((value) => {
                if (!keep || writes !== started) return
                if (recent.size > 500) recent.clear()
                recent.set(key, { until: Date.now() + keep, value })
              }, () => {}).finally(() => flying.delete(share)).catch(() => {})
            }
            return flying.get(share)
          }
        },
      }) as never)
      return families.get(family)
    },
  })
}

/** The largest page a list call takes (2.0 `list_shape.max_limit`). */
export const PAGE = 1000

/** Every item of a 2.0 paged list: `--limit`/`--cursor` in, `items` + `next_cursor` out. */
export async function pages<T = any>(read: (paging: { limit: number, cursor?: string }) => Promise<any>, most = Infinity): Promise<T[]> {
  const all: T[] = []
  for (let cursor: string | null | undefined = undefined; all.length < most;) {
    const page = await read({ limit: PAGE, ...(cursor ? { cursor } : {}) })
    all.push(...(page.items ?? []))
    cursor = typeof page.next_cursor === 'string' && page.next_cursor ? page.next_cursor : null
    if (!cursor) break
  }
  return all
}

/** A Sandbox and its Workspaces: one `sandbox get --detail` (2.0: unpaged, at most 16 Workspaces). */
export function sandboxWorkspaces(lfs: Lfs, sandbox: string): Promise<any> {
  return lfs.sandbox.get(sandbox, { detail: true })
}
