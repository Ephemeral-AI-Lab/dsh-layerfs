/**
 * The pinned LayerFS CLI as an SDK: `lfs.<family>.<call>(...positionals, options)`
 * runs `layerfs <family> <call> [flags] -- <positionals>` once per call (no
 * replay), answering its one JSON result or throwing a LayerFSError-shaped
 * {@link CliError}. The call table comes from the CLI's own `help --json`.
 * Ported from LayerFS Connect `host/cli/` (without the activity recorder).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

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
  'project.init', 'project.list', 'project.get', 'branch.fork', 'branch.list', 'branch.commits', 'commit.diff',
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
}

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
  if (!spec.cli || !isAbsolute(spec.cli) || !existsSync(spec.cli)) {
    return Promise.reject(new CliError('CliUnavailable', 'Pin an absolute LayerFS CLI (Settings → LayerFS or DSH_LAYERFS_CLI)', null, 'unavailable'))
  }
  const lane = argv[0] === 'workspace' && argv[1] === 'exec-cancel' ? `${spec.cli}:cancel` : `${spec.cli}:calls`
  const launch = () => admit(lane, 4, () => new Promise<unknown>((resolve, reject) => {
    if (!options.discovery && !spec.home) return reject(new CliError('InvalidInput', 'LayerFS requires an explicit home'))
    if (options.read && !existsSync(join(spec.home, 'layerfs.json'))) return reject(new CliError('Unavailable', 'LayerFS home is not initialized; reads will not create it'))
    let result: unknown, refusal: any, spawnError: unknown, malformed = false, finals = 0
    const events = options.events || argv.includes('--events')
    const stdout = lines((line) => {
      try {
        const frame = parse(line)
        if (!events) { if (++finals !== 1) throw new Error('Extra result'); result = frame; return }
        if (finals) throw new Error('Frame after final')
        if ('result' in frame || 'refusal' in frame) { finals++; result = frame.result; refusal = frame.refusal }
        else if ('progress' in frame) options.onProgress?.(frame.progress)
        else if (!['stdout', 'stderr'].includes(frame.stream) || !('bytes' in frame)) throw new Error('Unknown event')
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
    const child = spawn(spec.cli, [...argv], {
      shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...options.env, ...(spec.home ? { LAYERFS_HOME: spec.home } : {}), ...(spec.bundle ? { LAYERFS_BUNDLE: spec.bundle } : {}), LAYERFS_PROGRESS_JSON: '1' },
    })
    children.add(child)
    child.once('error', (error) => { spawnError = error })
    child.stdin?.on('error', () => {})
    child.stdout?.on('data', (data: Buffer) => stdout.write(data))
    child.stderr?.on('data', (data: Buffer) => stderr.write(data))
    let deadline: NodeJS.Timeout | undefined
    if (options.timeout) deadline = setTimeout(() => child.kill('SIGTERM'), options.timeout)
    child.once('close', (code, signal) => {
      clearTimeout(deadline)
      children.delete(child)
      stdout.end(); stderr.end()
      try { resolve(outcome({ code, signal, result, refusal, error: spawnError, malformed: malformed || (events && finals !== 1) })) } catch (error) { reject(error) }
    })
    try { options.onSpawn?.(child) } catch { malformed = true; child.kill('SIGTERM') }
    child.stdin?.end(options.input)
  }))
  // Saved reads of one Store are serialized: the CLI can race opening/closing one Store from separate processes.
  return options.storeRead ? admit(JSON.stringify(['store-read', spec.home, options.storeRead]), 1, launch) : launch()
}

// ---------------------------------------------------------------- discovery

const known = new Map<string, Promise<Discovery>>()

/**
 * Discover the CLI's identity and call table once per binary path.
 * @param spec - the binary (home unused).
 * @param fresh - forget a cached discovery (after a pin change).
 */
export function discover(spec: Pick<CliSpec, 'cli'>, fresh = false): Promise<Discovery> {
  if (fresh) known.delete(spec.cli)
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
    pending.catch(() => known.delete(spec.cli))
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
