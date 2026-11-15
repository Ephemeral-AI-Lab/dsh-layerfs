#!/Users/yifanxu/.nvm/versions/node/v24.21.0/bin/node
// STAND-IN, not LayerFS: a pinned-CLI wrapper that ANSWERS `logs machine` and
// `logs sandbox` for a CLI that does not have the calls yet (layerfs-project#178
// step 1), so the dsh-layerfs log views can be built and checked before the real
// calls exist. A run against it shows that the UI follows the SPEC as read here;
// it is never a pass on a real machine. Runs against a real build do not use it.
//
// It answers, from fixture files, what #178 "Design > Calls" describes:
//   layerfs logs machine <machine> [--cursor <c> | --before <c>] [--limit <n>]
//   layerfs logs sandbox <sandbox> [--cursor <c> | --before <c>] [--limit <n>]
//   -> { lines: [{ text, continued? }], cursor, before?, has_more }
// - no cursor: the last `limit` lines (default 200, at most 1000) of the last
//   64 KiB, oldest first; `cursor`: lines written after it; `before`: earlier
//   lines, back through the file, then its `.1`. One 64 KiB chunk per call.
// - a line longer than a chunk comes in pieces, each but the last `continued`;
//   a partial last line is held back; control characters are escaped.
// - the cursor carries the file's identity (inode and first-line hash): after
//   the file is replaced or rotated, an old cursor is refused `InvalidInput`.
// - `before` is given with every answer that has an earlier line to page to
//   (this stand-in's reading of `before?`), and `has_more` means "more in the
//   direction read": after `cursor` for tail and forward reads, before
//   `before` for earlier reads.
// It also lists the two calls in `help --json` (what `featuresOf` reads), adds
// `supports.log` to `machine list` / `machine get`, and passes every other
// call through to $LFS_REAL_CLI with the same arguments, stdin and environment.
//
//   LFS_REAL_CLI      the real pinned CLI (required)
//   LFS_INSPECT_DIR   the fixture folder (required):
//     machine/<name>.log, machine/<name>.1.log     a machine's worker log and its rotated file
//     sandbox/<name>.log, sandbox/<name>.1.log     a Sandbox's daemon log
//     control.json      read on every call (all keys optional):
//       { "refuse":       { "machine:<name>" | "sandbox:<name>" | "machine:*" | "sandbox:*": { "code", "message" } },
//         "delay_ms":     { "machine:<name>" | "sandbox:<name>" | "call:<family>.<call>" | "call:<family>.<call>:<first positional>": <ms> },
//         "supports_log": { "<machine>": false },   default: true for every machine
//         "calls":        ["logs.machine", "logs.sandbox"] }   the calls listed and answered (default both)
//     spawns.log        appended: one line `<epoch ms> <argv as JSON>` per CLI process (help and --version too)
// A target with no log file has an empty log. A delay holds the process (an
// inspect read, or the named pass-through call) before it answers; the host's
// own time budget or an abort ends it.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, fstatSync, openSync, readFileSync, readSync, writeSync } from 'node:fs'
import { join } from 'node:path'

const real = process.env.LFS_REAL_CLI, dir = process.env.LFS_INSPECT_DIR
const args = process.argv.slice(2)
if (!real || !dir) { process.stderr.write('cli-inspect-logs: set LFS_REAL_CLI and LFS_INSPECT_DIR\n'); process.exit(2) }

const CHUNK = 64 * 1024, DEFAULT_LIMIT = 200, MAX_LIMIT = 1000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const control = (() => { try { return JSON.parse(readFileSync(join(dir, 'control.json'), 'utf8')) } catch { return {} } })()
const answered = new Set(Array.isArray(control.calls) ? control.calls : ['logs.machine', 'logs.sandbox'])
try { appendFileSync(join(dir, 'spawns.log'), `${Date.now()} ${JSON.stringify(args)}\n`) } catch { /* the fixture folder is gone: still answer */ }

const [family, rawCall] = args
const call = String(rawCall ?? '').replace(/-/g, '_')
const dash = args.indexOf('--')
const positionals = dash >= 0 ? args.slice(dash + 1) : args.slice(2).filter((a) => !a.startsWith('--'))
const flags = {}
for (let i = 2; i < (dash >= 0 ? dash : args.length); i++) {
  const word = args[i]
  if (!word.startsWith('--')) continue
  const eq = word.indexOf('=')
  if (eq > 0) flags[word.slice(2, eq)] = word.slice(eq + 1)
  else if (i + 1 < args.length && !args[i + 1].startsWith('--')) flags[word.slice(2)] = args[++i]
  else flags[word.slice(2)] = true
}

/** Write all of `text` to `fd` before going on (process.exit drops what a pipe has not taken yet). */
function emit(fd, text) {
  const data = Buffer.from(text)
  for (let done = 0; done < data.length;) {
    try { done += writeSync(fd, data, done) } catch (error) {
      if (error?.code !== 'EAGAIN') throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
    }
  }
}
const refuse = (code, message) => { emit(2, `${JSON.stringify({ code, message, detail: null })}\n`); process.exit(125) }
const answer = (value) => { emit(1, `${JSON.stringify(value)}\n`); process.exit(0) }

// ---------------------------------------------------------------- the log reader

/** Control characters escaped, as the answer's text carries them. */
const escaped = (buffer) => buffer.toString('utf8').replace(/[\u0000-\u001f\u007f]/g, (c) => (c === '\t' ? '\\t' : c === '\r' ? '\\r' : `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`))

function open(path) {
  let fd
  try { fd = openSync(path, 'r') } catch { return null }
  const st = fstatSync(fd)
  const head = Buffer.alloc(Math.min(st.size, 4096))
  readSync(fd, head, 0, head.length, 0)
  const nl = head.indexOf(10)
  // the first line's hash once that line is whole; empty before
  const hash = nl >= 0 ? createHash('sha1').update(head.subarray(0, nl)).digest('hex').slice(0, 12) : ''
  return { fd, size: st.size, ino: String(st.ino), hash, read: (from, to) => { const b = Buffer.alloc(Math.max(0, to - from)); readSync(fd, b, 0, b.length, from); return b } }
}
const cursorText = (index, offset, file) => `s1.${index}.${offset}.${file.ino}.${file.hash || '-'}`
/**
 * The cursor of a log file that is not there yet. A real `logs.*` answer always
 * carries a cursor: a missing file answers this one, and a read after it reads
 * the file from its start once it is there.
 */
const NO_FILE = 'c1.0.0.0.0'
function cursorOf(text) {
  const m = /^s1\.([01])\.(\d+)\.(\d+)\.([0-9a-f]{12}|-)$/.exec(String(text))
  return m ? { index: Number(m[1]), offset: Number(m[2]), ino: m[3], hash: m[4] === '-' ? '' : m[4] } : null
}
const stale = () => refuse('InvalidInput', 'the log was rotated or replaced since this cursor was given; read its tail again without a cursor')
/** A cursor still names `file`: same inode, same first line (or it was given before the first line was whole), not past its end. */
const names = (cursor, file) => !!file && cursor.ino === file.ino && (cursor.hash === '' || cursor.hash === file.hash) && cursor.offset <= file.size

/** The whole lines of `buffer` (which starts at a line start), each with its offset; `rest` is where the partial last line starts. */
function wholeLines(buffer, base) {
  const lines = []
  let pos = 0
  for (let nl; (nl = buffer.indexOf(10, pos)) >= 0; pos = nl + 1) lines.push({ at: base + pos, text: escaped(buffer.subarray(pos, nl)) })
  return { lines, rest: pos }
}
/** A cut of at most `size` bytes that does not split a UTF-8 character. */
function cut(buffer, size) {
  let end = Math.min(size, buffer.length)
  while (end > 0 && end < buffer.length && (buffer[end] & 0xc0) === 0x80) end--
  return end
}

function read(kind, name) {
  const base = join(dir, kind, name)
  const files = [`${base}.log`, `${base}.1.log`]
  const limit = flags.limit === undefined ? DEFAULT_LIMIT : Number(flags.limit)
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) refuse('InvalidInput', `logs.${kind}: \`limit\` is 1 to ${MAX_LIMIT}`)
  if (flags.cursor !== undefined && flags.before !== undefined) refuse('InvalidInput', `logs.${kind}: give \`cursor\` or \`before\`, not both`)
  const current = open(files[0])
  const rotated = () => open(files[1])
  /** The cursor for lines before `offset` of file `index`: there, else the end of the rotated file, else none. */
  const beforeOf = (index, offset, file) => {
    if (offset > 0) return cursorText(index, offset, file)
    if (index === 0) { const old = rotated(); if (old && old.size > 0) return cursorText(1, old.size, old) }
    return undefined
  }
  const out = (lines, cursor, before, more) => answer({ lines: lines.map((l) => (l.continued ? { text: l.text, continued: true } : { text: l.text })), cursor, ...(before ? { before } : {}), has_more: more })

  // earlier lines
  if (flags.before !== undefined) {
    const cursor = cursorOf(flags.before)
    if (!cursor) stale()
    const file = cursor.index === 0 ? current : rotated()
    if (!names(cursor, file)) stale()
    const end = cursor.offset, start = Math.max(0, end - CHUNK)
    const buffer = file.read(start, end)
    // skip the partial first line of the chunk; a chunk with no line start in it is a piece of one long line
    let from = 0
    if (start > 0) {
      const nl = buffer.indexOf(10)
      from = nl >= 0 && nl < buffer.length - 1 ? nl + 1 : -1
    }
    if (from < 0) {
      const whole = buffer[buffer.length - 1] === 10
      const before = cursorText(cursor.index, start, file)
      return out([{ text: escaped(whole ? buffer.subarray(0, buffer.length - 1) : buffer), continued: !whole }], current ? cursorText(0, current.size, current) : NO_FILE, before, true)
    }
    const body = buffer.subarray(from)
    const { lines, rest } = wholeLines(body, start + from)
    // what follows the last newline joins the piece answered before it
    if (rest < body.length) lines.push({ at: start + from + rest, text: escaped(body.subarray(rest)), continued: true })
    const page = lines.slice(-limit)
    const first = page.length ? page[0].at : end
    const before = beforeOf(cursor.index, first, file)
    return out(page, current ? cursorText(0, current.size, current) : NO_FILE, before, !!before)
  }

  // lines after a cursor
  if (flags.cursor !== undefined) {
    if (flags.cursor === NO_FILE && !current) return out([], NO_FILE, undefined, false)
    const cursor = flags.cursor === NO_FILE ? { index: 0, offset: 0, ino: current.ino, hash: '' } : cursorOf(flags.cursor)
    if (!cursor || cursor.index !== 0 || !names(cursor, current)) stale()
    const buffer = current.read(cursor.offset, Math.min(current.size, cursor.offset + CHUNK))
    let { lines, rest } = wholeLines(buffer, cursor.offset)
    if (lines.length > limit) { rest = lines[limit].at - cursor.offset; lines = lines.slice(0, limit) }
    // a full chunk with no line end: one piece of a long line
    if (!lines.length && buffer.length === CHUNK) {
      const end = cut(buffer, CHUNK)
      lines = [{ at: cursor.offset, text: escaped(buffer.subarray(0, end)), continued: true }]
      rest = end
    }
    const next = cursor.offset + rest
    const ahead = current.read(next, Math.min(current.size, next + CHUNK))
    const more = ahead.length === CHUNK || ahead.indexOf(10) >= 0
    const before = lines.length ? beforeOf(0, lines[0].at, current) : undefined
    return out(lines, cursorText(0, next, current), before, more)
  }

  // the tail
  if (!current) return out([], NO_FILE, undefined, false)
  const start = Math.max(0, current.size - CHUNK)
  const buffer = current.read(start, current.size)
  let from = 0
  if (start > 0) {
    const nl = buffer.indexOf(10)
    if (nl < 0) return out([{ at: start, text: escaped(buffer.subarray(0, cut(buffer, CHUNK))), continued: true }], cursorText(0, current.size, current), cursorText(0, start, current), false)
    from = nl + 1
  }
  const { lines, rest } = wholeLines(buffer.subarray(from), start + from)
  const page = lines.slice(-limit)
  // the partial last line is held back: the cursor stops before it
  const end = start + from + rest
  const before = page.length ? beforeOf(0, page[0].at, current) : beforeOf(0, end, current)
  return out(page, cursorText(0, end, current), before, false)
}

// ---------------------------------------------------------------- dispatch

const key = `${family}.${call}`
const delayOf = (...keys) => keys.map((k) => Number(control.delay_ms?.[k])).find((ms) => Number.isFinite(ms) && ms > 0) ?? 0

if (family === 'logs' && (call === 'machine' || call === 'sandbox') && answered.has(key)) {
  const name = positionals[0]
  if (!name) { process.stderr.write(`usage: layerfs logs ${call} <${call}> [--cursor <c> | --before <c>] [--limit <n>]\n`); process.exit(2) }
  const delay = delayOf(`${call}:${name}`, `${call}:*`)
  if (delay) await sleep(delay)
  const refusal = control.refuse?.[`${call}:${name}`] ?? control.refuse?.[`${call}:*`]
  if (refusal) refuse(String(refusal.code), String(refusal.message ?? refusal.code))
  if (call === 'machine' && control.supports_log?.[name] === false) refuse('Unsupported', `machine ${name} has no worker log: its calls run in this process`)
  read(call, name)
}

if (family === 'help' && args.includes('--json') && args.length === 2) {
  const r = spawnSync(real, args, { encoding: 'utf8', maxBuffer: 1 << 28 })
  let out = r.stdout
  try {
    const help = JSON.parse(out)
    const has = (f, c) => (help.calls ?? []).some((x) => x.family === f && x.call === c)
    const options = [{ name: 'cursor', kind: 'text', optional: true }, { name: 'before', kind: 'text', optional: true }, { name: 'limit', kind: 'int', optional: true }]
    const added = []
    if (answered.has('logs.machine') && !has('logs', 'machine')) added.push({ family: 'logs', call: 'machine', args: [{ name: 'machine', kind: 'name', optional: false }], options, help: 'STAND-IN: a machine\'s worker log, followed by cursor' })
    if (answered.has('logs.sandbox') && !has('logs', 'sandbox')) added.push({ family: 'logs', call: 'sandbox', args: [{ name: 'sandbox', kind: 'name', optional: false }], options, help: 'STAND-IN: a Sandbox daemon\'s log, followed by cursor' })
    out = JSON.stringify({ ...help, calls: [...(help.calls ?? []), ...added] })
  } catch { /* not JSON: pass through */ }
  emit(1, out ?? '')
  emit(2, r.stderr ?? '')
  process.exit(r.status ?? 1)
}

const hold = delayOf(`call:${key}:${positionals[0] ?? ''}`, `call:${key}`)
if (hold) await sleep(hold)

if (family === 'machine' && (call === 'list' || call === 'get')) {
  const r = spawnSync(real, args, { encoding: 'utf8', maxBuffer: 1 << 28 })
  let out = r.stdout
  try {
    if (r.status === 0) {
      const patch = (m) => (m && typeof m === 'object' && m.supports && typeof m.supports === 'object' ? { ...m, supports: { ...m.supports, log: control.supports_log?.[m.name] !== false } } : m)
      const j = JSON.parse(out)
      out = `${JSON.stringify(call === 'list' ? { ...j, machines: (j.machines ?? []).map(patch) } : patch(j))}\n`
    }
  } catch { /* not JSON: pass through */ }
  emit(1, out ?? '')
  emit(2, r.stderr ?? '')
  process.exit(r.status ?? 1)
}

const r = spawnSync(real, args, { stdio: 'inherit' })
process.exit(r.status ?? 1)
