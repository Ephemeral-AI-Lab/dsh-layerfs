/**
 * The pinned LayerFS CLI as an SDK: `lfs.<family>.<call>(...positionals, options)`
 * runs `layerfs <family> <call> [flags] -- <positionals>` once per call (no
 * replay), answering its one JSON result or throwing a LayerFSError-shaped
 * {@link CliError}. The call table comes from the CLI's own `help --json`.
 * Ported from LayerFS Connect `host/cli/` (without the activity recorder).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { traceInvocation } from './tracing.ts'
import { appendCall, callLine, loggable, renderCall } from './call-log.ts'
import { outputRecord, outputsDir, outputSink, saveOutput, type OutputSink } from './call-output.ts'
import { hostTag, OUTPUT_MAX, parseSimTag, simTag } from '../../shared/logs.ts'

/** How a call failed: `refusal` = LayerFS answered a refusal; others are transport outcomes. */
export type Transport = 'refusal' | 'transport-unknown' | 'unavailable' | 'usage-incompatible'

/** A LayerFS refusal (`{ code, message, detail }`) or a transport failure. */
export class CliError extends Error {
  readonly code: string
  readonly detail: unknown
  readonly transport: Transport
  constructor(code: string, message: string, detail: unknown = null, transport: Transport = 'refusal') {
    super(message)
    this.name = 'LayerFSError'
    this.code = code
    this.detail = detail
    this.transport = transport
  }
}

/** Where the CLI is and which LayerFS home it serves. */
export interface CliSpec {
  /** Absolute pinned `layerfs` binary. */
  readonly cli: string
  /** Absolute LAYERFS_HOME. */
  readonly home: string
  /** Optional folder scope. */
  readonly scope?: { readonly project: string, readonly folder: string, readonly branch?: string }
  /** The Linux bundle folder VM/container machines start workers from (LAYERFS_BUNDLE). */
  readonly bundle?: string | null
  /**
   * The XDG cache home LayerFS reads prepared machine OS images from
   * (`<cacheHome>/layerfs/machine-images`), passed as XDG_CACHE_HOME. Unset:
   * the CLI inherits the host's XDG_CACHE_HOME (else `~/.cache`).
   */
  readonly cacheHome?: string | null
  /**
   * The plugin's stand-in call log (`$DSH_HOME/layerfs/trace/calls.jsonl`).
   * Set: every non-discovery call appends one line there unless the pinned
   * CLI writes LayerFS's own call log (docs/specs/layerfs-logs.md §3), carries
   * a `dsh:` tag (a session receipt, else a host tag), and has its output kept
   * in `trace/outputs/` next to it in both modes.
   */
  readonly callLog?: string | null
  /** Whether the CLI has the native `logs` family; undefined: detect from its call table. */
  readonly nativeLogs?: boolean
}

/** One `help --json` call table row. */
export interface CallEntry {
  readonly family: string
  readonly call: string
  readonly args: readonly { readonly name: string, readonly kind: string, readonly optional?: boolean }[]
  readonly options: readonly { readonly name: string, readonly kind: string }[]
}

/** `help --json` plus `--version --json`. */
export interface Discovery {
  readonly identity: { readonly version: string, readonly commit: string, readonly dirty: boolean, readonly features: readonly string[] }
  readonly calls: readonly CallEntry[]
  readonly commands: readonly unknown[]
  readonly switches: readonly { readonly name: string, readonly calls: readonly string[] }[]
}

/** The calls dsh-layerfs relies on; a CLI missing one is refused at discovery. */
export const REQUIRED_CALLS = [
  'project.init', 'project.list', 'project.get', 'project.export', 'branch.fork', 'branch.list', 'branch.commits', 'commit.diff',
  'file.read', 'file.list', 'file.apply', 'sandbox.create', 'sandbox.get', 'sandbox.close',
  'workspace.mount', 'workspace.commit', 'workspace.status', 'workspace.unmount', 'workspace.exec',
  'machine.list', 'machine.platforms', 'store.list', 'store.create',
] as const

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

function outcome(o: { code: number | null, signal: NodeJS.Signals | null, result: unknown, refusal: any, error?: unknown, malformed: boolean }): unknown {
  if (o.error) throw new CliError('CliUnavailable', 'The configured LayerFS CLI could not be started', null, 'unavailable')
  if (o.signal || o.malformed) throw new CliError('Unknown', 'LayerFS ended without a complete result; inspect state before another action', { signal: o.signal }, 'transport-unknown')
  if (o.code === 0 && o.result !== undefined && !o.refusal) return o.result
  if (o.code === 125 && o.refusal && typeof o.refusal.code === 'string' && typeof o.refusal.message === 'string') {
    throw new CliError(o.refusal.code, o.refusal.message, o.refusal.detail ?? null, 'refusal')
  }
  if (o.code === 2) throw new CliError('CliIncompatible', 'LayerFS rejected the command syntax; check the selected binary and capabilities', null, 'usage-incompatible')
  throw new CliError('Unknown', 'LayerFS returned no valid final result; inspect state before another action', { exit: o.code }, 'transport-unknown')
}

// ---------------------------------------------------------------- spawning

interface ExecuteOptions {
  input?: string | Buffer
  read?: boolean
  storeRead?: string
  events?: boolean
  discovery?: boolean
  timeout?: number
  env?: Record<string, string>
  onProgress?: (progress: unknown) => void
  onFrame?: (frame: { stream?: 'stdout' | 'stderr', bytes?: unknown }) => void
  onSpawn?: (child: ChildProcess) => void
  /** Recheck cancellation after admission, immediately before starting a process. */
  beforeSpawn?: () => void
  /** A separate admission lane (name and limit) for bulk callers, so page reads are not queued behind them. */
  lane?: { name: string, limit: number }
  /**
   * `LAYERFS_LOGS_TAG` for this call. {@link execute} sets it from the trace
   * context; outside one a caller may pass a `dsh-sim:<runId>:<stepKey>` tag
   * (simulation setup/verification), other values are replaced by a host tag.
   */
  tag?: string
  /** Where the call's output is collected for the output store (set by {@link logged}). */
  capture?: Capture
  /** Filled by {@link logged} with the call log line's `at` and `ms`. */
  timing?: Timing
}

interface Timing { at?: number, ms?: number }

/** One call's output as it arrives: bounded stdout/stderr, the `--events` final frame, the exit. */
interface Capture { stdout: OutputSink, stderr: OutputSink, final?: string, refusal?: unknown, exit?: number | null }

const lanes = new Map<string, { active: number, waiting: (() => void)[] }>()
async function admit<T>(key: string, limit: number, run: () => Promise<T>): Promise<T> {
  let lane = lanes.get(key)
  if (!lane) lanes.set(key, lane = { active: 0, waiting: [] })
  if (lane.active >= limit) await new Promise<void>((resolve) => lane!.waiting.push(resolve))
  else lane.active++
  try { return await run() } finally {
    const next = lane.waiting.shift()
    if (next) next()
    else if (--lane.active === 0) lanes.delete(key)
  }
}

/** Wait for, then hold, this host's one-process-per-Store lane (the lane `execute`
 * uses) around `run`; with an empty `run` it waits until the lane is free. */
export function admitStore<T>(home: string, store: string, run: () => Promise<T>): Promise<T> {
  return admit(JSON.stringify(['store', home, store]), 1, run)
}

/**
 * The Store a call opens, or undefined. Calls on a project (`<store>/<project>`)
 * and `store stats` open the Store in their own process and take its lease
 * (`store/<name>/open/<pid>`); `store status`/`list` only read leases.
 * Accepts both argv shapes: SDK words (`family call [--flags] -- positionals`)
 * and the preset driver's (`family call positionals [--flags]`).
 */
export function storeOfCall(argv: readonly string[]): string | undefined {
  const [family, call] = argv
  if (!(['file', 'branch', 'commit', 'project'].includes(family!) || (family === 'store' && call === 'stats'))) return undefined
  const dash = argv.indexOf('--')
  const first = dash >= 0 ? argv[dash + 1] : argv[2]
  if (!first || first.startsWith('--')) return undefined
  return first.split('/')[0] || undefined
}

/** Live CLI children, for shutdown. */
export const children = new Set<ChildProcess>()

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
  // The receipt takes the line's own start and duration when a line is written.
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
 * Run a call with a `dsh:` tag (the session receipt's, else a host tag); keep
 * its output in `trace/outputs/` and, in stand-in mode, append its call log
 * line, both before answering. Neither ever changes the call's outcome.
 */
async function logged(spec: CliSpec, argv: readonly string[], options: ExecuteOptions): Promise<any> {
  if (!spec.callLog || !loggable(argv)) return executeRaw(spec, argv, options)
  const tag = options.tag ?? hostTag(randomUUID().replaceAll('-', ''))
  const capture: Capture = { stdout: outputSink(OUTPUT_MAX, 'head'), stderr: outputSink(OUTPUT_MAX, 'tail') }
  const at = Date.now(), started = performance.now()
  let result: unknown, error: any, spawned = false
  const onSpawn = (child: ChildProcess) => { spawned = true; options.onSpawn?.(child) }
  try { result = await executeRaw(spec, argv, { ...options, tag, capture, onSpawn }); return result } catch (e) { error = e; throw e } finally {
    // A call refused before the CLI started, or whose syntax it rejected, writes no line (#659 §10).
    const ran = spawned && (!error || !['unavailable', 'usage-incompatible'].includes(error?.transport))
    if (ran) {
      // The output first, so a page reloading on the new line already sees it.
      try { saveOutput(outputsDir(spec.callLog), outputRecord({ tag, exit: capture.exit, stdout: capture.stdout, stderr: capture.stderr, final: capture.final, refusal: capture.refusal, max: OUTPUT_MAX })) } catch { /* best effort */ }
      const ms = performance.now() - started
      if (options.timing) Object.assign(options.timing, { at, ms: Math.max(0, Math.round(ms)) })
      if (!(spec.nativeLogs ?? await hasNativeLogs(spec.cli))) {
        appendCall(spec.callLog, callLine({
          at, ms, argv, input: options.input ?? null, result, tag,
          outcome: error ? typeof error.code === 'string' && error.code.length <= 64 ? error.code : 'Failed' : 'ok',
          bools: boolOptions(spec.cli),
        }))
      }
    }
  }
}

function executeRaw(spec: CliSpec, argv: readonly string[], options: ExecuteOptions): Promise<any> {
  if (!spec.cli || !isAbsolute(spec.cli) || !existsSync(spec.cli)) {
    return Promise.reject(new CliError('CliUnavailable', 'Pin an absolute LayerFS CLI (Settings → LayerFS or DSH_LAYERFS_CLI)', null, 'unavailable'))
  }
  const lane = argv[0] === 'workspace' && argv[1] === 'exec-cancel' ? `${spec.cli}:cancel` : options.lane ? `${spec.cli}:${options.lane.name}` : `${spec.cli}:calls`
  const launch = () => admit(lane, options.lane?.limit ?? 4, () => new Promise<unknown>((resolve, reject) => {
    if (!options.discovery && !spec.home) return reject(new CliError('InvalidInput', 'LayerFS requires an explicit home'))
    if (options.read && !existsSync(join(spec.home, 'layerfs.json'))) return reject(new CliError('Unavailable', 'LayerFS home is not initialized; reads will not create it'))
    let result: unknown, refusal: any, spawnError: unknown, malformed = false, finals = 0
    const events = options.events || argv.includes('--events')
    const capture = options.capture
    const stdout = lines((line) => {
      try {
        const frame = parse(line)
        if (!events) { if (++finals !== 1) throw new Error('Extra result'); result = frame; return }
        if (finals) throw new Error('Frame after final')
        if ('result' in frame || 'refusal' in frame) { finals++; result = frame.result; refusal = frame.refusal; if (capture) capture.final = line }
        else if ('progress' in frame) options.onProgress?.(frame.progress)
        else if (!['stdout', 'stderr'].includes(frame.stream) || !('bytes' in frame)) throw new Error('Unknown event')
        else capture?.[frame.stream as 'stdout' | 'stderr'].push(bytes(frame.bytes))
        options.onFrame?.(frame)
      } catch { malformed = true }
    })
    const stderr = lines((line) => {
      try {
        const frame = parse(line)
        if ('progress' in frame) options.onProgress?.(frame.progress)
        else if (!events && typeof frame.code === 'string') { if (refusal) malformed = true; refusal = frame }
        else malformed = true
      } catch { /* plain-text usage; exit 2 classifies it */ }
    })
    try { options.beforeSpawn?.() } catch (error) { reject(error); return }
    const child = spawn(spec.cli, [...argv], {
      shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...tagged(options), ...(spec.home ? { LAYERFS_HOME: spec.home } : {}), ...(spec.bundle ? { LAYERFS_BUNDLE: spec.bundle } : {}), ...(spec.cacheHome ? { XDG_CACHE_HOME: spec.cacheHome } : {}), LAYERFS_PROGRESS_JSON: '1' },
    })
    children.add(child)
    child.once('error', (error) => { spawnError = error })
    child.stdin?.on('error', () => {})
    // `--events` stdout is frames: the capture keeps their decoded exec bytes and the final frame instead.
    child.stdout?.on('data', (data: Buffer) => { if (capture && !events) capture.stdout.push(data); stdout.write(data) })
    child.stderr?.on('data', (data: Buffer) => { capture?.stderr.push(data); stderr.write(data) })
    let deadline: NodeJS.Timeout | undefined
    if (options.timeout) deadline = setTimeout(() => child.kill('SIGTERM'), options.timeout)
    child.once('close', (code, signal) => {
      clearTimeout(deadline)
      children.delete(child)
      stdout.end(); stderr.end()
      if (capture) { capture.exit = code; capture.refusal = refusal }
      try { resolve(outcome({ code, signal, result, refusal, error: spawnError, malformed: malformed || (events && finals !== 1) })) } catch (error) { reject(error) }
    })
    try { options.onSpawn?.(child) } catch { malformed = true; child.kill('SIGTERM') }
    child.stdin?.end(options.input)
  }))
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
const nativeLogs = new Map<string, Promise<boolean>>()
const nativeKnown = new Map<string, boolean>()

/** Whether a call table has LayerFS's own call log (#659: the `logs` family). */
export const tableHasLogs = (calls: readonly CallEntry[]): boolean =>
  calls.some((c) => c.family === 'logs' && c.call === 'list') && calls.some((c) => c.family === 'logs' && c.call === 'reset')

/**
 * Whether the pinned CLI writes LayerFS's own call log: the `logs` family in
 * its discovered call table (no extra process; cached with the discovery,
 * refreshed when the pin changes). A failed discovery answers false and is
 * retried after a minute.
 */
export function hasNativeLogs(cli: string): Promise<boolean> {
  let pending = nativeLogs.get(cli)
  if (!pending) {
    pending = discover({ cli }).then((d) => tableHasLogs(d.calls), () => {
      setTimeout(() => { if (nativeLogs.get(cli) === pending) nativeLogs.delete(cli) }, 60_000).unref()
      return false
    })
    nativeLogs.set(cli, pending)
    void pending.then((value) => { if (nativeLogs.get(cli) === pending) nativeKnown.set(cli, value) })
  }
  return pending
}

/** {@link hasNativeLogs} without waiting: undefined until it is known. */
export function knownNativeLogs(cli: string): boolean | undefined { return nativeKnown.get(cli) }

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
  if (fresh) { known.delete(spec.cli); settled.delete(spec.cli); nativeLogs.delete(spec.cli); nativeKnown.delete(spec.cli) }
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
      return { identity, calls: help.calls, commands: help.commands ?? [], switches: help.switches ?? [] } as Discovery
    })()
    pending.then((d) => { if (known.get(spec.cli) === pending) settled.set(spec.cli, d) }, () => known.delete(spec.cli))
    known.set(spec.cli, pending)
  }
  return known.get(spec.cli)!
}

// ---------------------------------------------------------------- client

const READS = new Set(['list', 'get', 'status', 'platforms', 'images', 'stats', 'storage_report', 'commits', 'get_commit', 'read', 'stat', 'glob', 'grep', 'blame', 'diff', 'revision'])
const invalid = (message: string) => new CliError('InvalidInput', message)
const isPlain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v)

/** `lfs.family.call(...)`; every call answers a Promise. */
export type Lfs = { readonly spec: CliSpec } & Record<string, Record<string, (...args: any[]) => Promise<any>>>

/**
 * Build the SDK-shaped client for one spec. Identical concurrent reads share one process.
 * @param spec - binary, home and optional scope.
 */
export function client(spec: CliSpec): Lfs {
  const flying = new Map<string, Promise<unknown>>()
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
            if (family === 'sandbox' && call === 'create' && isPlain(options.image)) {
              const { archive, digest, ...extra } = options.image as Record<string, unknown>
              if (Object.keys(extra).length || typeof archive !== 'string' || !isAbsolute(archive)) throw invalid('image.archive must be an absolute caller-local path')
              if (digest !== undefined && (typeof digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(digest))) throw invalid('image.digest must be a full sha256 digest')
              options = { ...options, image_archive: archive, image: digest }
            }
            if (!isPlain(options) || args.length > entry.args.length) throw invalid('Invalid LayerFS arguments')
            const local = new Set(['on_spawn'])
            for (const name of Object.keys(options)) {
              if (!local.has(name) && !entry.options.some((o) => o.name === name)) throw invalid(`${family}.${call}: unknown option ${name}`)
            }
            for (const [name, value] of Object.entries(options)) {
              const option = entry.options.find((o) => o.name === name)
              if (option?.kind === 'bool' && value !== undefined && typeof value !== 'boolean') throw invalid(`${name} must be true or false`)
              if ((option?.kind === 'function' || local.has(name)) && value !== undefined && typeof value !== 'function') throw invalid(`${name} must be a function`)
              if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) throw invalid(`${name} must preserve exact numeric values`)
            }
            const words = [family, call.replaceAll('_', '-')]
            const positionals: string[] = []
            let input: string | undefined
            for (let i = 0; i < entry.args.length; i++) {
              const arg = entry.args[i], value = args[i]
              if (value === undefined || value === null) { if (!arg.optional) throw invalid(`${arg.name} is required`); continue }
              if (arg.kind === 'content' || arg.kind === 'json') input = arg.kind === 'json' ? JSON.stringify(value) : String(value)
              else positionals.push(String(value))
            }
            const events = family === 'workspace' && call === 'exec'
            for (const [name, value] of Object.entries(options)) {
              if (value === undefined || typeof value === 'function' || (name === 'stream' && events)) continue
              if ((name === 'password' || name === 'key') && (typeof value !== 'string' || !/^(env:[A-Za-z_][A-Za-z0-9_]*|file:\/.+)$/.test(value))) {
                throw invalid(`${name} requires an env: or file: reference`)
              }
              const flag = `--${name.replaceAll('_', '-')}`
              if (entry.options.find((o) => o.name === name)?.kind === 'bool') words.push(`${flag}=${value}`)
              else words.push(flag, typeof value === 'object' ? JSON.stringify(value) : String(value))
            }
            if (events) words.push('--events')
            else if (options.on_progress || (((family === 'machine' && ['start', 'create'].includes(call)) || (family === 'sandbox' && call === 'create')) && entry.options.some((o) => o.name === 'on_progress'))) words.push('--progress')
            if (spec.scope) words.push('--scope', spec.scope.folder, '--scope-project', spec.scope.project, ...(spec.scope.branch ? ['--scope-branch', spec.scope.branch] : []))
            words.push('--', ...positionals)
            const read = READS.has(call)
            const storeRead = read && args[0] && (entry.args[0]?.kind === 'project' || family === 'store') ? String(args[0]).split('/')[0] : undefined
            const opts: any = options
            const invoke = () => execute(spec, words, {
              input, read, storeRead, events,
              onProgress: opts.on_progress,
              onSpawn: (child) => opts.on_spawn?.(child.pid),
              onFrame: (frame) => { if (frame.stream) opts[frame.stream]?.(bytes(frame.bytes)) },
            })
            if (!read) return invoke()
            const key = JSON.stringify([words, input ?? null])
            if (!flying.has(key)) {
              const pending = invoke()
              flying.set(key, pending)
              pending.finally(() => flying.delete(key)).catch(() => {})
            }
            return flying.get(key)
          }
        },
      }) as never)
      return families.get(family)
    },
  })
}

/** The largest page a list call takes. */
export const PAGE = 1000

/** Every item of a paged list (`items` + `next_page_pos`). */
export async function pages<T = any>(read: (paging: { page_size: number, page_pos: number }) => Promise<any>, most = Infinity): Promise<T[]> {
  const all: T[] = []
  for (let pos: number | null = 0; pos !== null && all.length < most;) {
    const page = await read({ page_size: PAGE, page_pos: pos })
    all.push(...(page.items ?? []))
    pos = page.next_page_pos ?? null
  }
  return all
}

/** A Sandbox's Workspaces: every page of `sandbox.get` (pages hold `workspaces`). */
export async function sandboxWorkspaces(lfs: Lfs, sandbox: string): Promise<any> {
  const all: unknown[] = []
  let first: any
  for (let pos: number | null = 0; pos !== null;) {
    const page = await lfs.sandbox.get(sandbox, { page_size: PAGE, page_pos: pos })
    first ??= page
    all.push(...(page.workspaces ?? []))
    pos = page.next_page_pos ?? null
  }
  return { ...first, workspaces: all }
}
