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
import { isDshTag, TAG_MAX, type CallOutput, type LogsOutputAnswer } from '../../shared/logs.ts'

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

/** Whether a tag has a stored output. */
export function hasOutput(dir: string, tag: string | undefined): boolean {
  return validOutputTag(tag) && fs.existsSync(join(dir, outputName(createHash, tag)))
}

/** `logs.output {tag}`: the stored record, or `{ missing: true }`. */
export function readOutput(dir: string, tag: string): LogsOutputAnswer {
  try {
    const record = JSON.parse(fs.readFileSync(join(dir, outputName(createHash, tag)), 'utf8'))
    if (record && typeof record === 'object' && record.tag === tag && record.bytes && typeof record.bytes === 'object') return record as CallOutput
  } catch { /* missing, pruned or torn */ }
  return { missing: true }
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
