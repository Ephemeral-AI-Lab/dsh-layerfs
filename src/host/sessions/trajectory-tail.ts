/**
 * B9-C: the newest windows of the log and the receipts, for a cold Trajectory
 * first page.
 *
 * A project session's log is JSONL: one header line, then one v4 event per line
 * with an explicit `seq` (the LayerFS backend stores it uncompressed). Its
 * receipts sit beside it in `receipts.jsonl`, one receipt per line, append-only
 * and in call order. The Trajectory's first page is capped at
 * {@link FIRST_PAGE_RECORDS} records and {@link FIRST_PAGE_BYTES}, so a cold
 * read needs neither file whole: the measured 47 MB session needs 1.97 MB /
 * 1,487 events for its 400 records. This module reads those tails directly;
 * whenever a file, a header or a line is not exactly what it expects it answers
 * `undefined` and the caller runs today's whole parse instead.
 *
 * A log window ends at EOF and starts at a `turn/start`, so every turn in it is
 * complete: record content, call/result pairing, step timing and per-turn
 * counts are exactly what a full parse gives for those turns. The page's first
 * `request/header` still compares its tool catalog with its predecessor before
 * the window, so the window carries that one header's seq and catalog as a
 * seed (one extra line read, not a second parse). A page `system/message` needs
 * the real previous prompt text instead, which cannot be seeded safely: the
 * window then reaches back to the last one, or the whole parse runs. What the
 * window cannot know is the rest of the history: the answer is labelled
 * `windowed`, its `recordTotal` and `counts` are window values, and an older
 * page pays the whole parse once.
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { FIRST_PAGE_RECORDS } from '../../shared/trajectory.ts'
import { recordEventSeqs } from './trace.ts'

/** A log at least this long is read by its tail for a cold first page (the one threshold). */
export const TAIL_LOG_BYTES = 8 * 1024 * 1024
/** The first tail read: the newest records of a long session fit in about this much. */
export const TAIL_START_BYTES = 2 * 1024 * 1024
/** A backward scan for a line type steps this far. */
const BACK_SCAN_BYTES = 256 * 1024
/** The longest prompt line the anchor scan reads (a request header's catalog can be large). */
const LINE_MAX_BYTES = 16 * 1024 * 1024

/** Limits a test can shrink; production uses {@link TAIL_LOG_BYTES} and {@link TAIL_START_BYTES}. */
export interface TailLimits {
  minBytes?: number
  startBytes?: number
}

/** The predecessor state a window seeds: the last request header before it. */
export interface WindowPrompt {
  /** That header's event seq (the page's `previousSeq` when it is the page's predecessor). */
  seq: number
  /** Its raw tool catalog, compared with the page's first request. */
  tools: readonly unknown[]
}

/** The newest readable part of a log: from a `turn/start` to EOF. */
export interface TrajectoryWindow {
  /** The log's events, oldest first, all from `fromSeq` on. */
  events: any[]
  /** The oldest event's seq: records before it are not in the window. */
  fromSeq: number
  /** The turn that event opens: receipts before it are not in the window. */
  fromTurn: number
  /** The last request header before the window, when the page's first request needs it. */
  prompt?: WindowPrompt
  /** Tool-call ids already logged before the window: their repeats are not window records. */
  seenCalls?: string[]
  /** Bytes read from the log to find the window (each growth or anchor attempt reads its span). */
  bytes: number
  /** The log identity the window was read from (a grown file is retried before it is answered). */
  key: string
}

/** The receipts of a window's turns. */
export interface ReceiptsWindow {
  receipts: any[]
  /** Bytes read from `receipts.jsonl`. */
  bytes: number
  /** The receipts identity the window was read from. */
  key: string
}

/** A file a tail read touches: its path, a cheap identity and its size. */
export interface TailFile {
  path: string
  key: string
  size: number
}

/**
 * A file's identity: size, mtime, inode and ctime. An append moves the size and
 * mtime, an atomic replacement moves the inode; a same-size rewrite cannot keep
 * all four in the same millisecond, so a cached window is never served for
 * different bytes.
 */
function identityOf(path: string): { key: string, size: number } | undefined {
  try {
    const info = statSync(path)
    return { key: `${info.size}:${info.mtimeMs}:${info.ino}:${info.ctimeMs}`, size: info.size }
  } catch {
    return undefined
  }
}

/** `path`'s size and identity, or undefined when it cannot be stat'ed. */
export function tailFile(path: string): TailFile | undefined {
  const identity = identityOf(path)
  return identity ? { path, key: identity.key, size: identity.size } : undefined
}

/**
 * When a cold first page may read only the tails: an unloaded session, a long
 * log, and split receipts (a legacy combined sidecar cannot be bounded and is
 * left to the whole parse). A whole-log parse cached by an earlier record or
 * older-page read does not change the answer: the window stays the first page's
 * input, so its revision — and a `since` poll — does not move when that cache
 * appears.
 */
export function mayReadTail(
  size: number, state: { loaded: boolean, splitReceipts?: boolean }, minBytes = TAIL_LOG_BYTES,
): boolean {
  return !state.loaded && !!state.splitReceipts && size >= minBytes
}

/** Read `length` bytes at `offset`; undefined when the file cannot be read. */
function readRange(path: string, offset: number, length: number): Buffer | undefined {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return undefined
  }
  try {
    const buffer = Buffer.allocUnsafe(length)
    let filled = 0
    while (filled < length) {
      const n = readSync(fd, buffer, filled, length - filled, offset + filled)
      if (n <= 0) break
      filled += n
    }
    return buffer.subarray(0, filled)
  } catch {
    return undefined
  } finally {
    closeSync(fd)
  }
}

/** The line at `offset`, in chunks up to {@link LINE_MAX_BYTES}; undefined when it does not parse. */
function lineAt(path: string, offset: number): any | undefined {
  const parts: Buffer[] = []
  for (let at = 0; at < LINE_MAX_BYTES; at += 64 * 1024) {
    const buffer = readRange(path, offset + at, 64 * 1024)
    if (!buffer?.length) return undefined
    const newline = buffer.indexOf(10)
    parts.push(newline < 0 ? buffer : buffer.subarray(0, newline))
    if (newline < 0) continue
    try {
      return JSON.parse(Buffer.concat(parts).toString('utf8'))
    } catch {
      return undefined
    }
  }
  return undefined
}

/** The log's first line: the v4 header this reader requires. */
function headerOf(path: string): any | undefined {
  const header = lineAt(path, 0)
  return header?.type === 'session' && header.version === 4 ? header : undefined
}

/** The byte offset of the start of the line containing `at`, searching back to `floor`. */
function lineStartAt(path: string, at: number, floor: number): number | undefined {
  let end = at
  while (end > floor) {
    const start = Math.max(floor, end - 4096)
    const buffer = readRange(path, start, end - start)
    if (!buffer?.length) return undefined
    const newline = buffer.lastIndexOf(10)
    if (newline >= 0) return start + newline + 1
    end = start
  }
  return undefined
}

/**
 * The byte offset of the last line before `before` containing `needle` (a JSON
 * fragment such as `"type":"turn/start"`, so key order does not matter) and
 * accepted by `accept`. `null` when the scan reached the file's start without
 * one; `undefined` when the file could not be read or a line was too long.
 */
function lastLineWhere(path: string, needle: Buffer, before: number, accept: (line: any) => boolean, floor = 0): number | null | undefined {
  let end = before
  while (end > floor) {
    const start = Math.max(floor, end - BACK_SCAN_BYTES)
    const buffer = readRange(path, start, end - start + needle.length)
    if (!buffer?.length) return undefined
    let at = buffer.length
    for (;;) {
      at = buffer.lastIndexOf(needle, at - 1)
      if (at < 0) break
      const offset = lineStartAt(path, start + at, 0)
      if (offset === undefined) return undefined
      if (offset < before && offset > floor && accept(lineAt(path, offset))) return offset
      at -= 1
    }
    end = start
  }
  return null
}

/**
 * A parsed log chunk. `header`: at the file's start, the first line is the
 * header; `fragment`: at an offset, the first line is dropped; `line`: the
 * offset is a known line start, so every line is an event. Any line that does
 * not parse or carry an increasing integer `seq` makes the chunk unusable; the
 * last non-empty line alone may be a torn append and is dropped.
 */
function parseChunk(buffer: Buffer, mode: 'header' | 'fragment' | 'line'): any[] | undefined {
  let lines = buffer.toString('utf8').split('\n')
  if (mode === 'header') {
    let parsed: any
    try {
      parsed = JSON.parse(lines.shift() ?? '')
    } catch {
      return undefined
    }
    if (parsed?.type !== 'session' || parsed.version !== 4) return undefined
  } else if (mode === 'fragment') {
    lines = lines.slice(1)
  }
  const events: any[] = []
  let previous = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (!line) continue
    let event: any
    try {
      event = JSON.parse(line)
    } catch {
      if (lines.slice(i + 1).some((rest) => rest)) return undefined
      break
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)) return undefined
    if (typeof event.type !== 'string' || !Number.isInteger(event.seq) || event.seq <= previous) return undefined
    previous = event.seq
    events.push(event)
  }
  return events
}

const HEADER = Buffer.from('"type":"request/header"')
const SYSTEM = Buffer.from('"type":"system/message"')
const TURN = Buffer.from('"type":"turn/start"')
const REPLACE = Buffer.from('"surfaceOp":{')
/** A compaction marker at the top of a receipts file is not a receipt. */
const RECEIPTS_MARKER = '$layerfsReceipts'

const isHeader = (event: any): boolean => event?.type === 'request/header' && !!event.data?.header
const isSystem = (event: any): boolean => event?.type === 'system/message' && !!event.data?.message
const isTurn = (event: any): boolean => event?.type === 'turn/start'
const isPromptReplace = (event: any): boolean => !!event?.surfaceOp && typeof event?.surfaceOp === 'object'

/** The turn a page's records start in: the last `turn/start` at or before `pageStart`. */
function trimIndexOf(events: any[], first: number, pageStart: number): number {
  let trim = first
  for (let i = first; i < events.length; i++) {
    if (events[i]!.seq > pageStart) break
    if (events[i]!.type === 'turn/start' && Number.isInteger(events[i]!.data?.turn)) trim = i
  }
  return trim
}

/** The tool-call ids logged in `events[0..end)`: the window must not repeat them as records. */
function callsBefore(events: any[], end: number): Set<string> {
  const calls = new Set<string>()
  for (let i = 0; i < end; i++) {
    const event = events[i]!
    if (event.type === 'tool/call' && Number.isInteger(event.data?.turn) && typeof event.data?.callId === 'string') calls.add(event.data.callId)
  }
  return calls
}

/** The seed one header event carries. */
const promptOf = (event: any): WindowPrompt => ({ seq: event.seq, tools: Array.isArray(event.data?.header?.tools) ? event.data.header.tools : [] })

/** What a parsed chunk can become. */
type Verdict =
  | { kind: 'ok', window: { events: any[], fromSeq: number, fromTurn: number, prompt?: WindowPrompt } }
  | { kind: 'seed', window: { events: any[], fromSeq: number, fromTurn: number } }
  | { kind: 'anchor' }
  | { kind: 'grow' }
  | { kind: 'unsafe' }

/**
 * Whether a chunk can stand alone as a first-page window. The newest
 * {@link FIRST_PAGE_RECORDS} records must all be in it; a page
 * `request/header` whose predecessor is before the chunk takes it from a seed
 * (`seed`); a page `system/message` whose predecessor is before the chunk
 * cannot be seeded and asks for an anchor. A surface replacement reaching past
 * the window is unsafe once the window has shown a prompt state it would reset.
 */
function verdictOf(events: any[], trimWindow = true): Verdict {
  let first = -1
  for (let i = 0; i < events.length; i++) {
    if (events[i]!.type === 'turn/start' && Number.isInteger(events[i]!.data?.turn)) { first = i; break }
  }
  if (first < 0) return { kind: 'grow' }
  // A repeated tool call in the chunk is not a record: the dropped prefix's
  // call ids seed the count, and the trim and the seed settle each other in a
  // pass or two (one duplicate moves the oldest kept record by one).
  let trim = first
  let seed = new Set<string>()
  let seqs = recordEventSeqs(events.slice(first))
  if (seqs.length < FIRST_PAGE_RECORDS) return { kind: 'grow' }
  for (let pass = 0; pass < 3; pass++) {
    const pageStart = seqs[seqs.length - FIRST_PAGE_RECORDS]!
    // Start at the turn the oldest kept record is in: everything before it
    // would be materialized and dropped (and would widen the receipts window),
    // and the turn itself stays complete. An anchored window keeps its whole
    // span instead: the prompt state it reached back for is why it was read.
    const nextTrim = trimWindow ? trimIndexOf(events, first, pageStart) : first
    const nextSeed = callsBefore(events, nextTrim)
    const nextSeqs = recordEventSeqs(events.slice(first), nextSeed)
    if (nextSeqs.length < FIRST_PAGE_RECORDS) return { kind: 'grow' }
    const done = nextTrim === trim && nextSeqs.length === seqs.length
    trim = nextTrim
    seed = nextSeed
    seqs = nextSeqs
    if (done) break
  }
  const pageStart = seqs[seqs.length - FIRST_PAGE_RECORDS]!
  const chunk = events.slice(trim)
  const fromSeq = chunk[0]!.seq
  const fromTurn = chunk[0]!.data.turn
  const windowOf = (prompt?: WindowPrompt): { events: any[], fromSeq: number, fromTurn: number, prompt?: WindowPrompt, seenCalls?: string[] } => ({
    events: chunk, fromSeq, fromTurn,
    ...(prompt ? { prompt } : {}),
    ...(seed.size ? { seenCalls: [...seed] } : {}),
  })
  let firstHeader = -1
  let firstSystem = -1
  let promptState = false
  for (let i = 0; i < chunk.length; i++) {
    const event = chunk[i]!
    const op = event.surfaceOp
    if (op && typeof op === 'object') {
      const start = op.startSeq
      const end = op.endSeq
      const old = !Number.isInteger(start) || start < fromSeq || (Number.isInteger(end) && end < fromSeq)
      // A replacement reaching past the window resets the prompt state; that is
      // only observable once this window has shown a prompt state to reset.
      if (old && promptState) return { kind: 'unsafe' }
    }
    if (isHeader(event)) {
      promptState = true
      if (firstHeader < 0 && event.seq >= pageStart) firstHeader = i
    }
    if (isSystem(event)) {
      promptState = true
      if (firstSystem < 0 && event.seq >= pageStart) firstSystem = i
    }
  }
  if (firstSystem >= 0 && !chunk.slice(0, firstSystem).some(isSystem)) return { kind: 'anchor' }
  if (firstHeader >= 0 && !chunk.slice(0, firstHeader).some(isHeader)) {
    // A header in the dropped prefix (the tail of the turn before the window's
    // first) is still a true predecessor and can seed the page.
    const prefix = events.slice(0, trim).filter(isHeader)
    if (prefix.length) return { kind: 'ok', window: windowOf(promptOf(prefix[prefix.length - 1])) }
    // A prompt change in that prefix (a system message or a surface
    // replacement) would change the page's first request, and the header seed
    // carries no system text: the window cannot be trusted.
    if (events.slice(0, trim).some((event) => isSystem(event) || isPromptReplace(event))) return { kind: 'unsafe' }
    return { kind: 'seed', window: windowOf() }
  }
  return { kind: 'ok', window: windowOf() }
}

/**
 * What a parsed chunk settles to: a window (with a seeded predecessor when the
 * page's first request needs one), a request for an anchor (the page needs a
 * prompt state the chunk does not hold), growth or an unsafe tail.
 */
type Settled =
  | { kind: 'ok', window: { events: any[], fromSeq: number, fromTurn: number, prompt?: WindowPrompt } }
  | { kind: 'anchor' }
  | { kind: 'grow' }
  | { kind: 'unsafe' }

/** Resolve a parsed chunk at `offset`, reading at most one line for a seed. */
function settle(path: string, events: any[], offset: number, trim = true): Settled {
  const verdict = verdictOf(events, trim)
  if (verdict.kind === 'ok' || verdict.kind === 'grow' || verdict.kind === 'unsafe') return verdict
  if (verdict.kind === 'anchor') return { kind: 'anchor' }
  const anchor = lastLineWhere(path, HEADER, offset, isHeader)
  if (anchor === undefined) return { kind: 'unsafe' }
  // No header before the window: the page's first request has no predecessor
  // in the whole log either, so there is nothing to seed.
  if (anchor === null) return { kind: 'ok', window: verdict.window }
  const line = lineAt(path, anchor)
  if (!line || !isHeader(line)) return { kind: 'unsafe' }
  // A prompt state change after that header and before the window (a system
  // message or a surface replacement) changes what the page's first request
  // reports; the seed carries a tool catalog, not the system text, so the
  // window cannot stand in for it. `lineAt` also gives up on a line past
  // LINE_MAX_BYTES, which lands here as a fallback rather than a guess.
  const changed = lastLineWhere(path, SYSTEM, offset, isSystem, anchor)
  if (changed !== null) return { kind: 'unsafe' }
  const replaced = lastLineWhere(path, REPLACE, offset, isPromptReplace, anchor)
  if (replaced !== null) return { kind: 'unsafe' }
  return { kind: 'ok', window: { ...verdict.window, prompt: promptOf(line) } }
}

/** The log's first event seq (the line after the header). */
function firstEventSeqOf(path: string): number | undefined {
  const buffer = readRange(path, 0, 64 * 1024)
  if (!buffer?.length) return undefined
  const head = buffer.indexOf(10)
  if (head < 0) return undefined
  let rest = buffer.subarray(head + 1)
  if (rest.indexOf(10) < 0) rest = readRange(path, head + 1, 64 * 1024) ?? rest
  const end = rest.indexOf(10)
  try {
    const event = JSON.parse((end < 0 ? rest : rest.subarray(0, end)).toString('utf8'))
    return Number.isInteger(event?.seq) ? event.seq : undefined
  } catch {
    return undefined
  }
}

/** Whether the preamble before the first turn holds a record (a user message logged before it). */
function preambleHasRecord(path: string): boolean {
  const buffer = readRange(path, 0, 64 * 1024)
  if (!buffer?.length) return false
  const lines = buffer.toString('utf8').split('\n').slice(1)
  const events: any[] = []
  for (const line of lines) {
    if (!line) continue
    try {
      const event = JSON.parse(line)
      if (event?.type === 'turn/start') break
      events.push(event)
    } catch {
      break
    }
  }
  return recordEventSeqs(events).length > 0
}

/**
 * The newest window of `path`, or undefined when the tail cannot be read
 * safely and the caller must parse the whole log. `size` is a stat the caller
 * already did; the file is re-stat'ed before and after each read, and a file
 * that grew meanwhile is read again (up to three times, then the whole parse),
 * so the window and its revision always describe the bytes actually read. The
 * window starts at {@link TAIL_START_BYTES}, doubles until it holds the newest
 * records, takes the predecessor header as a seed when the page's first request
 * needs one, and reaches back to the last system message when the page itself
 * needs the prompt text. A window that would cover the whole log is answered
 * whole instead.
 */
export function readTrajectoryWindow(path: string, size?: number, limits: TailLimits = {}): TrajectoryWindow | undefined {
  const minBytes = limits.minBytes ?? TAIL_LOG_BYTES
  let total: number
  try {
    total = size ?? statSync(path).size
  } catch {
    return undefined
  }
  if (total < minBytes || !headerOf(path)) return undefined
  const firstSeq = firstEventSeqOf(path)
  // A window that reaches the log's first event is the whole log: today's parse
  // then gives the same page with true totals, so it stays the answer. The
  // preamble check covers a first turn whose events start after a few
  // session-setup events: with no record before that turn, the window is the
  // whole record set too.
  const wholeLog = (window: { events: any[], fromSeq: number, fromTurn: number, prompt?: WindowPrompt, seenCalls?: string[] }, bytes: number): TrajectoryWindow | undefined =>
    window.fromSeq <= (firstSeq ?? Number.NEGATIVE_INFINITY) || (window.fromTurn === 1 && !preambleHasRecord(path))
      ? undefined
      : { ...window, bytes, key: identityOf(path)?.key ?? '' }
  let span = Math.min(total, limits.startBytes ?? TAIL_START_BYTES)
  let bytes = 0
  for (let attempt = 0; ; attempt++) {
    // A stat is a point in time: read only after confirming its size, and again
    // confirm it after the read, so a log that grew meanwhile is not sliced at
    // the old end (its newest events would be missing and the revision stale).
    const live = identityOf(path)
    if (!live) return undefined
    if (live.size !== total) {
      total = live.size
      span = Math.min(total, limits.startBytes ?? TAIL_START_BYTES)
      if (attempt > 3) return undefined
      continue
    }
    const offset = total - span
    // A window that reaches the file's start is the whole log: today's parse is
    // then no slower and gives the true totals, so it stays the answer.
    if (offset === 0) return undefined
    const buffer = readRange(path, offset, span)
    if (!buffer) return undefined
    bytes += buffer.length
    const events = parseChunk(buffer, 'fragment')
    const settled = events ? settle(path, events, offset) : undefined
    if (settled !== undefined) {
      const after = identityOf(path)
      if (!after) return undefined
      if (after.size !== total) {
        total = after.size
        span = Math.min(total, limits.startBytes ?? TAIL_START_BYTES)
        if (attempt > 3) return undefined
        continue
      }
      if (settled.kind === 'ok') return wholeLog(settled.window, bytes)
      if (settled.kind === 'unsafe') return undefined
      if (settled.kind === 'anchor') {
        // The page needs a system prompt state from before the window: anchor at
        // the turn that opens the last system message before it.
        const anchor = lastLineWhere(path, SYSTEM, offset, isSystem)
        if (anchor === undefined || anchor === null) return undefined
        const turnStart = lastLineWhere(path, TURN, anchor, isTurn)
        if (turnStart === undefined || turnStart === null) return undefined
        const anchored = readRange(path, turnStart, total - turnStart)
        if (!anchored) return undefined
        bytes += anchored.length
        const tail = parseChunk(anchored, 'line')
        const next = tail ? settle(path, tail, turnStart, false) : undefined
        return next?.kind === 'ok' ? wholeLog(next.window, bytes) : undefined
      }
    }
    span = Math.min(total, span * 2)
  }
}

/**
 * A parsed receipts chunk: rows with object ids de-duplicated (the last value
 * wins, its first place kept, as the whole-file reader does), a compaction
 * marker skipped, and the last line allowed to be torn. Any other unparsable
 * line is unsafe (the whole-file reader skips it; a window must not silently
 * lose a receipt).
 */
function parseReceipts(buffer: Buffer, offset: number): { receipts: any[], firstTurn: number | undefined } | undefined {
  let text = buffer.toString('utf8')
  if (offset > 0) {
    const newline = text.indexOf('\n')
    if (newline < 0) return undefined
    text = text.slice(newline + 1)
  }
  const lines = text.split('\n')
  const out: any[] = []
  const at = new Map<string, number>()
  let firstTurn: number | undefined
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (!line) continue
    let row: any
    try {
      row = JSON.parse(line)
    } catch {
      // Only the final non-empty line may be torn (an append in progress).
      if (lines.slice(i + 1).some((rest) => rest)) return undefined
      break
    }
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    if (row[RECEIPTS_MARKER]) continue
    if (firstTurn === undefined) firstTurn = Number.isInteger(row.turn) ? row.turn : -1
    if (typeof row.id !== 'string') { out.push(row); continue }
    const kept = at.get(row.id)
    if (kept !== undefined) { out[kept] = row; continue }
    at.set(row.id, out.length)
    out.push(row)
  }
  return { receipts: out, firstTurn }
}

/** The `turn` of the first complete receipt at `offset`; null when none (a fragment); undefined on a read error. */
function receiptTurnAt(path: string, offset: number): number | null | undefined {
  const buffer = readRange(path, offset, 64 * 1024)
  if (!buffer?.length) return undefined
  let lines = buffer.toString('utf8').split('\n')
  if (offset > 0) lines = lines.slice(1)
  for (const line of lines) {
    if (!line) continue
    let row: any
    try {
      row = JSON.parse(line)
    } catch {
      return null
    }
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    if (row[RECEIPTS_MARKER]) continue
    return Number.isInteger(row.turn) ? row.turn : -1
  }
  return null
}

/**
 * The receipts a window's turns need: every row with a `turn` at or after
 * `fromTurn`. The file appends in call order, so a binary search over byte
 * offsets (one head probe per step) finds where that turn begins, and only the
 * needed span is read and parsed once. Undefined when the tail cannot be read
 * safely; the caller then parses the whole file.
 */
export function readReceiptsWindow(path: string, fromTurn: number, size?: number, limits: TailLimits = {}): ReceiptsWindow | undefined {
  let total: number
  try {
    total = size ?? statSync(path).size
  } catch {
    return undefined
  }
  if (total === 0) return { receipts: [], bytes: 0, key: identityOf(path)?.key ?? '' }
  for (let attempt = 0; ; attempt++) {
    const live = identityOf(path)
    if (!live) return undefined
    if (live.size !== total) {
      // The file grew after the caller's stat: read to its current end, so the
      // window holds the newest receipts and the revision describes this read.
      total = live.size
      if (attempt > 3) return undefined
      continue
    }
    const start = Math.max(0, receiptBoundary(path, fromTurn, total) - 64 * 1024)
    const buffer = readRange(path, start, total - start)
    if (!buffer) return undefined
    const after = identityOf(path)
    if (!after) return undefined
    if (after.size !== total) {
      total = after.size
      if (attempt > 3) return undefined
      continue
    }
    const parsed = parseReceipts(buffer, start)
    if (!parsed) return undefined
    return {
      // A receipt without a `turn` (a pre-session host op) is not part of any
      // window's turns; DSH stamps `turn` on every tool receipt, so a window
      // call's ops are never dropped this way. The whole build still attaches
      // such a receipt at turn 0, outside every page.
      receipts: parsed.receipts.filter((row) => Number.isInteger(row?.turn) && row.turn >= fromTurn),
      bytes: buffer.length,
      key: after.key,
    }
  }
}

/**
 * A byte offset inside the first receipt whose `turn` is at or after
 * `fromTurn`, found by binary search with one 64 KB head probe per step.
 */
function receiptBoundary(path: string, fromTurn: number, total: number): number {
  let lo = 0
  let hi = total
  while (hi - lo > 64 * 1024) {
    const mid = Math.floor((lo + hi) / 2)
    const turn = receiptTurnAt(path, mid)
    if (turn !== undefined && turn !== null && turn >= fromTurn) hi = mid
    else lo = mid
  }
  return lo
}

/** The two files a cold first page reads, with the identities that make a cached window reusable. */
export interface TailFiles {
  logPath: string
  logKey: string
  logSize: number
  receiptsPath?: string
  receiptsKey?: string
  receiptsSize?: number
}

/** A cold first page's inputs: the log window, its receipts, and what they cost. */
export interface TailPage {
  events: any[]
  invocations: any[]
  window: { fromSeq: number, fromTurn: number, logKey: string, prompt?: WindowPrompt, seenCalls?: string[] }
  /** Bytes the log's tail read consumed on this call (0 on a cached window). */
  logBytes: number
  /** Bytes the receipts' tail read consumed on this call (0 on a cached window). */
  receiptBytes: number
  /** Both windows came from the previous read of the same identities. */
  cached: boolean
}

/**
 * A small per-session cache of the last cold first page's windows. A
 * `session.trajectory { since }` poll stats the two files, finds the same
 * identities and answers unchanged from here, without reading the tails again.
 * Bounded: a window is a few MB of parsed events.
 */
export function tailPageReader(limit = 2, limits: TailLimits = {}) {
  const logs = new Map<string, { key: string, window: TrajectoryWindow }>()
  const receipts = new Map<string, { key: string, fromTurn: number, rows: any[] }>()
  const remember = <T>(map: Map<string, T>, id: string, value: T): void => {
    map.delete(id)
    map.set(id, value)
    while (map.size > limit) map.delete(map.keys().next().value!)
  }
  return (id: string, files: TailFiles): TailPage | undefined => {
    // The caller's stat is a hint; this read takes its own, so a file that grew
    // in between is read at its current end and cached under what it read.
    const liveLog = tailFile(files.logPath)
    const logKey = liveLog?.key ?? files.logKey
    let window: TrajectoryWindow
    let logBytes = 0
    const keptLog = logs.get(id)
    if (keptLog !== undefined && keptLog.key === logKey) {
      window = keptLog.window
      remember(logs, id, keptLog)
    } else {
      const read = readTrajectoryWindow(files.logPath, liveLog?.size ?? files.logSize, limits)
      if (!read) return undefined
      window = read
      logBytes = read.bytes
      remember(logs, id, { key: read.key, window })
    }
    let invocations: any[] = []
    let receiptBytes = 0
    let receiptsCached = false
    if (files.receiptsPath !== undefined) {
      const liveReceipts = tailFile(files.receiptsPath)
      // A vanished file keeps the caller's key so a cached window still answers
      // (the `since` poll must not depend on the file being re-readable).
      const receiptsKey = liveReceipts?.key ?? files.receiptsKey
      const keptReceipts = receipts.get(id)
      if (keptReceipts !== undefined && keptReceipts.key === receiptsKey && keptReceipts.fromTurn === window.fromTurn) {
        invocations = keptReceipts.rows
        remember(receipts, id, keptReceipts)
        receiptsCached = true
      } else {
        const read = readReceiptsWindow(files.receiptsPath, window.fromTurn, liveReceipts?.size ?? files.receiptsSize, limits)
        if (!read) return undefined
        invocations = read.receipts
        receiptBytes = read.bytes
        remember(receipts, id, { key: read.key, fromTurn: window.fromTurn, rows: invocations })
      }
    }
    return {
      events: window.events,
      invocations,
      window: {
        fromSeq: window.fromSeq, fromTurn: window.fromTurn, logKey: window.key,
        ...(window.prompt ? { prompt: window.prompt } : {}),
        ...(window.seenCalls ? { seenCalls: window.seenCalls } : {}),
      },
      logBytes,
      receiptBytes,
      cached: logBytes === 0 && receiptsCached,
    }
  }
}
