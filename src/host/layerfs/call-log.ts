/**
 * The plugin's stand-in for the LayerFS call log (docs/specs/layerfs-logs.md §3,
 * LayerFS #659 §4–§7): `$DSH_HOME/layerfs/trace/calls.jsonl`, one line per CLI
 * call this plugin makes while the pinned CLI has no `logs` family.
 *
 * `renderCall`, `savedFields`, `makeReceipt` and `appendCallLine` are
 * self-contained (no imports, no module references) because the managed
 * `agent-bin/layerfs` wrapper embeds their source.
 */
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { isWrite, operationOf, type CallLine, type LogsListArgs } from '../../shared/logs.ts'

/** Rotation threshold (#659 §6). */
export const ROTATE_BYTES = 16 * 1024 * 1024

/**
 * The call as canonical, redacted CLI words: family, call, positionals, then
 * `--options`; `--` dropped; front-end switches (`--json`, `--progress`,
 * `--events`, `--text`) dropped; Bool options as a bare `--name` when true and
 * nothing when false; content sent on stdin as `<N bytes>` after the
 * positionals. Values of `--message --old --new --password --url`, the
 * `workspace exec` command and `store|backup connect` URLs become `<N bytes>`;
 * other values are cut to 200 characters with `…`.
 */
export function renderCall(argv: readonly string[], inputBytes?: number | null, bools?: readonly string[]): string[] {
  const SWITCHES = ['--json', '--progress', '--events', '--text', '-h', '--help']
  const BOOLS = ['allow-missing', 'discard', 'force', 'include-attribution', 'include-encoding', 'include-storage', 'paths-only', 'stream', ...(bools ?? []).map((name) => name.replaceAll('_', '-'))]
  const SECRET = ['message', 'old', 'new', 'password', 'url', 'command']
  const size = (value: string) => `<${Buffer.byteLength(value, 'utf8')} bytes>`
  const cut = (value: string) => { const chars = Array.from(value); return chars.length > 200 ? `${chars.slice(0, 200).join('')}…` : value }
  const family = String(argv[0] ?? ''), call = String(argv[1] ?? '').replaceAll('_', '-')
  const positionals: string[] = [], options: string[] = []
  let rest = false
  for (let at = 2; at < argv.length; at++) {
    const word = String(argv[at])
    if (rest || word === '-' || !word.startsWith('-')) { positionals.push(word); continue }
    if (word === '--') { rest = true; continue }
    if (SWITCHES.includes(word)) continue
    let name: string, value: string | undefined, explicit = false
    if (word === '-m') name = 'message'
    else if (word.startsWith('--')) {
      const equal = word.indexOf('=')
      name = equal < 0 ? word.slice(2) : word.slice(2, equal)
      if (equal >= 0) { value = word.slice(equal + 1); explicit = true }
    } else { options.push(cut(word)); continue }
    name = name.replaceAll('_', '-')
    if (value === undefined) {
      if (BOOLS.includes(name) || at + 1 >= argv.length || String(argv[at + 1]).startsWith('--')) { options.push(`--${name}`); continue }
      value = String(argv[++at])
    }
    if ((explicit || BOOLS.includes(name)) && (value === 'true' || value === 'false')) { if (value === 'true') options.push(`--${name}`); continue }
    options.push(`--${name}`, SECRET.includes(name) ? size(value) : cut(value))
  }
  const secretAt = (family === 'workspace' && call === 'exec') || ((family === 'store' || family === 'backup') && call === 'connect') ? 1 : -1
  const words = positionals.map((word, index) => index === secretAt ? size(word) : cut(word))
  if (typeof inputBytes === 'number' && inputBytes >= 0) words.push(`<${inputBytes} bytes>`)
  return [family, call, ...words, ...options]
}

/** `kind` and the saved version a result names (#659 §4.2); only 66-hex ids. */
export function savedFields(argv: readonly string[], result: any): { kind?: string, commit?: string, layer?: string } {
  const out: { kind?: string, commit?: string, layer?: string } = {}
  if (!result || typeof result !== 'object' || Array.isArray(result)) return out
  if (typeof result.kind === 'string' && result.kind.length <= 64) out.kind = result.kind
  const id = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{66}$/.test(value) ? value : undefined
  const operation = `${argv[0] ?? ''}.${String(argv[1] ?? '').replaceAll('-', '_')}`
  const saves = ['file.write', 'file.edit', 'file.apply', 'file.rm', 'file.mkdir', 'file.mv', 'file.cp', 'workspace.commit']
  let commit: string | undefined, layer: string | undefined
  if (saves.includes(operation)) {
    if (result.kind === 'Committed') commit = id(result.commit?.id ?? result.head)
    else if (result.kind === 'UpToDate') { if (result.head) commit = id(result.head); else layer = id(result.base) }
  } else if (operation === 'branch.fork' && result.kind === 'Forked') {
    if (result.head) commit = id(result.head); else layer = id(result.base)
  } else if (operation === 'branch.merge' && result.kind === 'Merged') commit = id(result.head)
  else if (operation === 'branch.publish') {
    if (result.kind === 'Added') layer = id((result.published_layer ?? result.publishedLayer)?.id)
    else if (result.kind === 'UpToDate') layer = id(result.layer)
    else if (result.kind === 'NoChanges') layer = id(result.head_layer ?? result.headLayer)
  }
  if (commit) out.commit = commit
  if (layer) out.layer = layer
  return out
}

/**
 * One receipt id and its tag `dsh:<sessionId>:<receiptId>`. The id is
 * `<scope>.<random>` inside a tool call (scope names the call) and `<random>`
 * otherwise. The random part shrinks to keep the tag within 128 bytes; a tag
 * that still does not fit, or holds control characters, is left out.
 */
export function makeReceipt(sessionId: string, scope: string | undefined, random: string): { id: string, tag?: string } {
  const prefix = `dsh:${sessionId}:${scope ? `${scope}.` : ''}`
  const room = 128 - Buffer.byteLength(prefix, 'utf8')
  const id = `${scope ? `${scope}.` : ''}${random.slice(0, Math.max(8, Math.min(random.length, room)))}`
  const tag = `dsh:${sessionId}:${id}`
  // eslint-disable-next-line no-control-regex
  return Buffer.byteLength(tag, 'utf8') <= 128 && !/[\u0000-\u001f\u007f]/.test(tag) ? { id, tag } : { id }
}

/**
 * Append one line (O_APPEND, 0600; directory 0700), then rotate past `max`
 * bytes to `<base>.1.jsonl` under a best-effort exclusive lock file. Never throws.
 */
export function appendCallLine(fsm: any, path: string, line: object, max = 16 * 1024 * 1024): boolean {
  try {
    const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
    fsm.mkdirSync(path.slice(0, cut), { recursive: true, mode: 0o700 })
    let text = JSON.stringify(line)
    if (Buffer.byteLength(text, 'utf8') > 4000 && Array.isArray((line as any).argv)) {
      text = JSON.stringify({ ...line, argv: (line as any).argv.map((word: string, index: number) => index < 2 || word.length <= 40 ? word : `${Array.from(word).slice(0, 40).join('')}…`) })
    }
    const fd = fsm.openSync(path, 'a', 0o600)
    let size = 0
    try { fsm.writeSync(fd, `${text}\n`); size = fsm.fstatSync(fd).size } finally { fsm.closeSync(fd) }
    if (size > max) {
      const base = path.replace(/\.jsonl$/, ''), lock = `${base}.lock`
      let held: number | undefined
      try { held = fsm.openSync(lock, 'wx', 0o600) } catch (error: any) {
        if (error?.code === 'EEXIST') { try { if (Date.now() - fsm.statSync(lock).mtimeMs > 30_000) fsm.unlinkSync(lock) } catch { /* raced */ } }
      }
      if (held !== undefined) {
        try { if (fsm.statSync(path).size > max) fsm.renameSync(path, `${base}.1.jsonl`) } catch { /* best effort */ } finally {
          fsm.closeSync(held)
          try { fsm.unlinkSync(lock) } catch { /* broken as stale */ }
        }
      }
    }
    return true
  } catch { return false }
}

// ------------------------------------------------------------ host only

/** Build one stand-in line. */
export function callLine(o: { at: number, ms: number, argv: readonly string[], input?: string | Buffer | null, outcome: string, result?: unknown, tag?: string, bools?: readonly string[] }): CallLine {
  const inputBytes = o.input === undefined || o.input === null ? null : Buffer.byteLength(o.input)
  const argv = renderCall(o.argv, inputBytes, o.bools)
  return {
    v: 1, at: o.at, ms: Math.max(0, Math.round(o.ms)), client: 'cli', argv, outcome: o.outcome,
    ...(o.outcome === 'ok' ? savedFields(argv, o.result) : {}),
    ...(o.tag ? { tag: o.tag } : {}),
  }
}

/** Calls that are not table calls write no line (#659 L1, L10). */
export function loggable(argv: readonly string[]): boolean {
  return argv.length >= 2 && /^[a-z][a-z_]*$/.test(argv[0] ?? '') && /^[a-z][a-z_-]*$/.test(argv[1] ?? '') && argv[0] !== 'help' && argv[0] !== 'logs'
}

const listeners = new Map<string, Set<() => void>>()
/** Run `fn` after this process appends to `path` (or says lines may have been added). */
export function onCallLogAppend(path: string, fn: () => void): () => void {
  let set = listeners.get(path)
  if (!set) listeners.set(path, set = new Set())
  set.add(fn)
  return () => { set!.delete(fn); if (!set!.size) listeners.delete(path) }
}
export function notifyCallLog(path: string): void {
  for (const fn of listeners.get(path) ?? []) { try { fn() } catch { /* listener */ } }
}

/** Append a stand-in line and notify listeners. */
export function appendCall(path: string, line: CallLine, max = ROTATE_BYTES): void {
  if (appendCallLine(fs, path, line, max)) notifyCallLog(path)
}

const rotatedOf = (path: string) => `${path.replace(/\.jsonl$/, '')}.1.jsonl`
const lockOf = (path: string) => `${path.replace(/\.jsonl$/, '')}.lock`
const invalid = (message: string) => Object.assign(new Error(message), { code: 'InvalidInput' })

interface Cursor { v: 1, f: 0 | 1, o: number, a: number, b: number, h: string }
function identity(path: string): { ino: number, size: number, head: string } {
  try {
    const stat = fs.statSync(path)
    const fd = fs.openSync(path, 'r'), buffer = Buffer.alloc(Math.min(256, stat.size))
    try { fs.readSync(fd, buffer, 0, buffer.length, 0) } finally { fs.closeSync(fd) }
    return { ino: stat.ino, size: stat.size, head: createHash('sha1').update(buffer).digest('hex').slice(0, 16) }
  } catch { return { ino: 0, size: 0, head: '' } }
}

/** A parsed line, or undefined when it is not a v1 call line. */
export function parseLine(text: string): CallLine | undefined {
  try {
    const line = JSON.parse(text)
    if (!line || typeof line !== 'object' || line.v !== 1 || typeof line.at !== 'number' || typeof line.ms !== 'number'
      || typeof line.client !== 'string' || !Array.isArray(line.argv) || !line.argv.every((w: unknown) => typeof w === 'string') || typeof line.outcome !== 'string') return undefined
    return line as CallLine
  } catch { return undefined }
}

/** The project a line names: the first `<store>/<name>` word after family and call. */
export function projectOf(argv: readonly string[]): string | undefined {
  return argv.slice(2).find((word) => /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/.test(word))
}

/** Whether a line passes the `LogsListArgs` filters (`project`: case-insensitive substring). */
export function matches(line: CallLine, args: LogsListArgs): boolean {
  if (args.op) {
    const op = args.op.replaceAll('-', '_')
    if (op.includes('.') ? operationOf(line.argv) !== op : line.argv[0] !== op) return false
  }
  if (args.project) {
    const project = projectOf(line.argv)
    if (!project || !project.toLowerCase().includes(args.project.toLowerCase())) return false
  }
  if (args.client && line.client !== args.client) return false
  if (args.tag && !(args.tag.endsWith(':') ? line.tag?.startsWith(args.tag) : line.tag === args.tag)) return false
  if (args.outcome && line.outcome !== args.outcome) return false
  if (typeof args.since === 'number' && line.at < args.since) return false
  if (args.writes && !isWrite(line.argv)) return false
  return true
}

/** Lines of one file from the newest, below byte offset `end`. */
function* backwards(buffer: Buffer, end: number): Generator<{ start: number, text: string }> {
  let stop = Math.min(end, buffer.length)
  while (stop > 0) {
    const lineEnd = buffer[stop - 1] === 0x0a ? stop - 1 : stop
    let start = lineEnd
    while (start > 0 && buffer[start - 1] !== 0x0a) start--
    const text = buffer.toString('utf8', start, lineEnd)
    if (text.trim()) yield { start, text }
    stop = start
  }
}

/** `logs.list` over the stand-in (newest first across both files). */
export function listCalls(path: string, args: LogsListArgs = {}): { lines: CallLine[], next?: string, has_more: boolean, skipped: number } {
  const limit = Math.max(1, Math.min(1000, Math.floor(Number(args.limit ?? 100)) || 100))
  const files = [path, rotatedOf(path)]
  const ids = files.map(identity)
  let from: Cursor | undefined
  if (args.cursor) {
    try { from = JSON.parse(Buffer.from(args.cursor, 'base64url').toString('utf8')) } catch { throw invalid('The log cursor is not valid; list from the start') }
    const ok = from && from.v === 1 && (from.f === 0 || from.f === 1) && Number.isInteger(from.o)
      && from.a === ids[0].ino && from.b === ids[1].ino && from.h === (ids[0].head || ids[1].head) && (from.f !== 0 || from.o <= ids[0].size)
    if (!ok) throw invalid('The log changed since this cursor (rotated or reset); list from the start')
  }
  const lines: CallLine[] = []
  let skipped = 0, pending = 0, next: Cursor | undefined, more = false
  scan: for (let f = from?.f ?? 0; f < 2; f++) {
    let buffer: Buffer
    try { buffer = fs.readFileSync(files[f]) } catch { continue }
    for (const { start, text } of backwards(buffer, f === from?.f ? from.o : Infinity)) {
      const line = parseLine(text)
      if (!line) { pending++; continue }
      if (!matches(line, args)) continue
      if (lines.length === limit) { more = true; break scan }
      lines.push(line)
      skipped += pending; pending = 0
      next = { v: 1, f: f as 0 | 1, o: start, a: ids[0].ino, b: ids[1].ino, h: ids[0].head || ids[1].head }
    }
  }
  if (!more) skipped += pending
  return { lines, ...(more && next ? { next: Buffer.from(JSON.stringify(next)).toString('base64url') } : {}), has_more: more, skipped }
}

/** `logs.reset` over the stand-in: truncate `calls.jsonl`, remove `calls.1.jsonl`. */
export function resetCalls(path: string): { removed: number } {
  const lock = lockOf(path)
  fs.mkdirSync(path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + 10_000, pause = new Int32Array(new SharedArrayBuffer(4))
  let held: number | undefined
  while (held === undefined) {
    try { held = fs.openSync(lock, 'wx', 0o600) } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) { fs.unlinkSync(lock); continue } } catch { continue }
      if (Date.now() > deadline) throw Object.assign(new Error('The call log is busy; try again'), { code: 'Busy' })
      Atomics.wait(pause, 0, 0, 10)
    }
  }
  try {
    let removed = 0
    for (const file of [path, rotatedOf(path)]) {
      try { removed += fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).length } catch { /* missing */ }
    }
    if (fs.existsSync(path)) fs.truncateSync(path, 0)
    fs.rmSync(rotatedOf(path), { force: true })
    notifyCallLog(path)
    return { removed }
  } finally {
    fs.closeSync(held)
    try { fs.unlinkSync(lock) } catch { /* broken as stale */ }
  }
}
