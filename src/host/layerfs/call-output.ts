/**
 * What a call printed (docs/specs/layerfs-logs.md "Outputs"): one JSON file per
 * call this plugin made with a `dsh:` tag, in `$DSH_HOME/layerfs/trace/outputs/`
 * (directory 0700, files 0600), named by a hash of the tag and holding a
 * {@link CallOutput}. LayerFS's own call log never stores output; this store is
 * local to this machine, bounded, and cleared by Reset.
 *
 * `outputSink`, `outputRecord`, `outputName` and `writeOutput` are
 * self-contained (no imports, no module references) because the managed
 * `agent-bin/layerfs` wrapper embeds their source.
 */
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { dirname, join } from 'node:path'
import { isDshTag, OUTPUT_MAX, TAG_MAX, type CallOutput, type LogsOutputAnswer } from '../../shared/logs.ts'

/** Store bounds: at most this many files and bytes, oldest pruned first. */
export const OUTPUT_FILES = 2000
export const OUTPUT_BYTES = 64 * 1024 * 1024
/** One write in this many (on average) checks the bounds. */
export const PRUNE_EVERY = 50

export interface OutputBounds { files: number, bytes: number, every: number }

/**
 * A bounded byte collector: keeps the first (`head`) or last (`tail`) `max`
 * bytes of everything pushed and counts all of it. Memory stays within `max`
 * plus one chunk.
 */
export function outputSink(max: number, keep: 'head' | 'tail') {
  const chunks: Buffer[] = []
  let held = 0, total = 0
  return {
    push(chunk: Buffer | string) {
      const data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      total += data.length
      if (keep === 'head') {
        if (held >= max) return
        const part = Buffer.from(data.subarray(0, max - held))
        chunks.push(part); held += part.length
        return
      }
      chunks.push(Buffer.from(data)); held += data.length
      while (chunks.length > 1 && held - chunks[0].length >= max) held -= chunks.shift()!.length
    },
    total: () => total,
    bytes(): Buffer {
      const all = Buffer.concat(chunks)
      return keep === 'head' ? all.subarray(0, max) : all.subarray(Math.max(0, all.length - max))
    },
  }
}
export type OutputSink = ReturnType<typeof outputSink>

/**
 * The stored record of one call. `stdout` keeps its head and `stderr` its tail,
 * each within `max` bytes, cut on UTF-8 character boundaries. `final` (the
 * `--events` result or refusal frame) is appended to stdout as its last line
 * and always kept when it fits. `refusal` only for a refused call (exit 125).
 */
export function outputRecord(o: { tag: string, exit: number | null | undefined, stdout: OutputSink, stderr: OutputSink, final?: string, refusal?: any, max: number }): CallOutput {
  const head = (buffer: Buffer): Buffer => {
    let at = buffer.length - 1, back = 0
    while (at >= 0 && back < 3 && (buffer[at] & 0xc0) === 0x80) { at--; back++ }
    if (at < 0) return buffer
    const lead = buffer[at], need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
    return buffer.length - at < need ? buffer.subarray(0, at) : buffer
  }
  const tail = (buffer: Buffer): Buffer => {
    let at = 0
    while (at < 3 && at < buffer.length && (buffer[at] & 0xc0) === 0x80) at++
    return buffer.subarray(at)
  }
  let out = o.stdout.bytes(), outTotal = o.stdout.total()
  if (typeof o.final === 'string' && o.final) {
    const sep = out.length && out[out.length - 1] !== 0x0a ? '\n' : ''
    const last = Buffer.from(`${sep}${o.final}\n`)
    outTotal += last.length
    out = last.length >= o.max ? head(Buffer.concat([out, last]).subarray(0, o.max)) : Buffer.concat([head(out.subarray(0, o.max - last.length)), last])
  } else out = head(out)
  const err = tail(o.stderr.bytes()), errTotal = o.stderr.total()
  const truncated = { ...(out.length < outTotal ? { stdout: true } : {}), ...(err.length < errTotal ? { stderr: true } : {}) }
  const refusal = o.exit === 125 && o.refusal && typeof o.refusal.code === 'string' ? {
    code: o.refusal.code.slice(0, 64),
    ...(typeof o.refusal.message === 'string' ? { message: o.refusal.message } : {}),
    ...(o.refusal.detail !== undefined && o.refusal.detail !== null ? { detail: o.refusal.detail } : {}),
  } : undefined
  return {
    tag: o.tag,
    ...(o.exit !== undefined ? { exit: o.exit } : {}),
    ...(out.length ? { stdout: out.toString('utf8') } : {}),
    ...(err.length ? { stderr: err.toString('utf8') } : {}),
    bytes: { stdout: outTotal, stderr: errTotal },
    ...(Object.keys(truncated).length ? { truncated } : {}),
    ...(refusal ? { refusal } : {}),
  }
}

/** The file of a tag: a hash, so no tag text reaches the filesystem. */
export function outputName(hash: (algorithm: string) => any, tag: string): string {
  return `${hash('sha256').update(tag, 'utf8').digest('hex').slice(0, 40)}.json`
}

/**
 * Write one record (temp file + rename, 0600; directory 0700). One write in
 * `bounds.every` then prunes oldest first to `bounds.files` files and
 * `bounds.bytes` bytes. Never throws.
 */
export function writeOutput(fsm: any, dir: string, name: string, record: object, bounds: { files: number, bytes: number, every: number }): boolean {
  try {
    fsm.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const path = `${dir}/${name}`, tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
    fsm.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 })
    try { fsm.renameSync(tmp, path) } catch (error) { try { fsm.unlinkSync(tmp) } catch { /* gone */ } throw error }
    if (Math.random() * Math.max(1, bounds.every) < 1) {
      const files: { path: string, size: number, at: number }[] = []
      for (const entry of fsm.readdirSync(dir)) {
        const file = `${dir}/${entry}`
        try {
          const stat = fsm.statSync(file)
          // Stray temp files older than a minute are leftovers of a crashed writer.
          if (entry.endsWith('.tmp')) { if (Date.now() - stat.mtimeMs > 60_000) fsm.unlinkSync(file); continue }
          if (entry.endsWith('.json')) files.push({ path: file, size: stat.size, at: stat.mtimeMs })
        } catch { /* raced */ }
      }
      files.sort((a, b) => a.at - b.at)
      let count = files.length, bytes = files.reduce((sum, file) => sum + file.size, 0)
      for (const file of files) {
        if (count <= bounds.files && bytes <= bounds.bytes) break
        try { fsm.unlinkSync(file.path) } catch { /* raced */ }
        count--; bytes -= file.size
      }
    }
    return true
  } catch { return false }
}

// ------------------------------------------------------------ host only

export const DEFAULT_BOUNDS: OutputBounds = { files: OUTPUT_FILES, bytes: OUTPUT_BYTES, every: PRUNE_EVERY }

/** `<root>/trace/outputs`, next to the stand-in call log `<root>/trace/calls.jsonl`. */
export const outputsDir = (callLog: string): string => join(dirname(callLog), 'outputs')

/** Whether a tag may name a stored output: a `dsh:` tag of at most 128 bytes, no control characters. */
export function validOutputTag(tag: unknown): tag is string {
  // eslint-disable-next-line no-control-regex
  return typeof tag === 'string' && isDshTag(tag) && Buffer.byteLength(tag, 'utf8') <= TAG_MAX && !/[\u0000-\u001f\u007f]/.test(tag)
}

/** Store one call's output (best effort). */
export function saveOutput(dir: string, record: CallOutput, bounds: OutputBounds = DEFAULT_BOUNDS): boolean {
  return validOutputTag(record.tag) && writeOutput(fs, dir, outputName(createHash, record.tag), record, bounds)
}

/** Whether a tag has a stored output (a record, or a native-mode call's raw files). */
export function hasOutput(dir: string, tag: string | undefined): boolean {
  return validOutputTag(tag) && (fs.existsSync(join(dir, outputName(createHash, tag))) || fs.existsSync(`${rawBase(dir, tag)}.out`))
}

/** `logs.output {tag}`: the stored record, else the raw files of a native-mode shell call, else `{ missing: true }`. */
export function readOutput(dir: string, tag: string): LogsOutputAnswer {
  try {
    const record = JSON.parse(fs.readFileSync(join(dir, outputName(createHash, tag)), 'utf8'))
    if (record && typeof record === 'object' && record.tag === tag && record.bytes && typeof record.bytes === 'object') return record as CallOutput
  } catch { /* missing, pruned or torn */ }
  return readRaw(dir, tag) ?? { missing: true }
}

// ------------------------------------------------- raw outputs (native mode)

/**
 * With LayerFS's own call log the agent's `layerfs` is a bash script, not node
 * (`managedCli`): it tees the CLI's stdout and stderr to `<dir>/raw/<tag>.out`
 * and `.err` and writes the exit code to `.exit` when the call ends, the tag
 * with every character outside `[A-Za-z0-9._-]` as `_`. `readOutput` reads
 * those files until `compactRaw` turns a finished call into its record.
 */
export const RAW_DIR = 'raw'
/** Raw files of finished calls older than this are compacted into records. */
export const RAW_SETTLE_MS = 5000
/** Raw bytes kept at most (in-flight calls included), oldest calls removed first. */
export const RAW_BYTES = 256 * 1024 * 1024

/** The raw files' common path of a tag (no extension). */
export const rawBase = (dir: string, tag: string): string => join(dir, RAW_DIR, tag.replace(/[^A-Za-z0-9._-]/g, '_'))

function readPart(path: string, max: number, keep: 'head' | 'tail'): { bytes: Buffer, total: number } | undefined {
  let fd: number | undefined
  try {
    fd = fs.openSync(path, 'r')
    const total = fs.fstatSync(fd).size, length = Math.min(total, max), buffer = Buffer.alloc(length)
    fs.readSync(fd, buffer, 0, length, keep === 'head' ? 0 : total - length)
    return { bytes: buffer, total }
  } catch { return undefined } finally { if (fd !== undefined) try { fs.closeSync(fd) } catch { /* closed */ } }
}

/** The record of a raw call: running (no `exit`) until its `.exit` file exists. `undefined` when there are no raw files. */
export function readRaw(dir: string, tag: string, max = OUTPUT_MAX): CallOutput | undefined {
  if (!validOutputTag(tag)) return undefined
  const base = rawBase(dir, tag)
  const out = readPart(`${base}.out`, max, 'head'), err = readPart(`${base}.err`, max, 'tail')
  if (!out && !err) return undefined
  let exit: number | undefined
  try { const text = fs.readFileSync(`${base}.exit`, 'utf8').trim(); if (/^\d{1,3}$/.test(text)) exit = Number(text) } catch { /* still running */ }
  const sink = (part: { bytes: Buffer, total: number } | undefined) => ({ push() {}, total: () => part?.total ?? 0, bytes: () => part?.bytes ?? Buffer.alloc(0) })
  let refusal: any
  if (exit === 125 && err) for (const line of err.bytes.toString('utf8').trim().split('\n').reverse()) {
    try { const frame = JSON.parse(line); if (frame && typeof frame.code === 'string') { refusal = frame; break } } catch { /* not a frame */ }
  }
  return outputRecord({ tag, exit, stdout: sink(out), stderr: sink(err), refusal, max })
}

/**
 * Keep the raw folder small: turn each finished call (its `.exit` older than
 * `RAW_SETTLE_MS`) into its record, remove raw files of calls whose record
 * exists, and past `RAW_BYTES` remove the oldest calls' files. Never throws.
 */
export function compactRaw(dir: string, bounds: OutputBounds = DEFAULT_BOUNDS, now = Date.now()): number {
  const folder = join(dir, RAW_DIR)
  let entries: string[]
  try { entries = fs.readdirSync(folder) } catch { return 0 }
  const calls = new Map<string, { files: { path: string, size: number, at: number }[], exitAt?: number }>()
  for (const entry of entries) {
    // The wrapper's named pipes (`.po`, `.pe`) outlive it only if it was killed: remove them after an hour.
    if (/\.(po|pe)$/.test(entry)) { try { const path = join(folder, entry); if (now - fs.statSync(path).mtimeMs > 3_600_000) fs.unlinkSync(path) } catch { /* raced */ } continue }
    const match = /^(.+)\.(out|err|exit)$/.exec(entry)
    if (!match) continue
    try {
      const path = join(folder, entry), stat = fs.statSync(path)
      const call = calls.get(match[1]) ?? { files: [] }
      call.files.push({ path, size: stat.size, at: stat.mtimeMs })
      if (match[2] === 'exit') call.exitAt = stat.mtimeMs
      calls.set(match[1], call)
    } catch { /* raced */ }
  }
  let compacted = 0
  const remove = (call: { files: { path: string }[] }) => { for (const file of call.files) try { fs.unlinkSync(file.path) } catch { /* raced */ } }
  for (const [safe, call] of [...calls]) {
    if (call.exitAt === undefined || now - call.exitAt < RAW_SETTLE_MS) continue
    // The raw name keeps a valid tag's characters (`dsh:` → `dsh_`); the record needs the tag itself.
    const tag = rawTag(safe)
    const record = tag ? readRaw(dir, tag) : undefined
    if (record && tag) { if (saveOutput(dir, record, bounds)) compacted++ }
    remove(call); calls.delete(safe)
  }
  const live = [...calls.values()].map((call) => ({ call, at: Math.min(...call.files.map((f) => f.at)), size: call.files.reduce((s, f) => s + f.size, 0) })).sort((a, b) => a.at - b.at)
  let bytes = live.reduce((s, c) => s + c.size, 0)
  for (const entry of live) { if (bytes <= RAW_BYTES) break; remove(entry.call); bytes -= entry.size }
  return compacted
}

/**
 * The tag of a raw file name: the wrapper writes `dsh:<sessionId>:<id>` with
 * each `:` as `_`; session ids (`session-<uuid>`, subagent UUIDs) and receipt
 * ids (`<scope>.<hex>`) hold no `_`, so the two `_` are the colons.
 */
function rawTag(safe: string): string | undefined {
  const match = /^dsh_([A-Za-z0-9.-]+)_([A-Za-z0-9.-]+)$/.exec(safe)
  if (!match) return undefined
  const tag = `dsh:${match[1]}:${match[2]}`
  return validOutputTag(tag) ? tag : undefined
}

/** Remove every stored output (Reset). */
export function clearOutputs(dir: string): number {
  let removed = 0
  let entries: string[]
  try { entries = fs.readdirSync(dir) } catch { return 0 }
  for (const entry of entries) {
    try { fs.rmSync(join(dir, entry), { force: true, recursive: true }); if (entry.endsWith('.json')) removed++ } catch { /* raced */ }
  }
  return removed
}
