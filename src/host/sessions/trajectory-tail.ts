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
  /** Bytes read from the log to find the window (each growth or anchor attempt reads its span). */
  bytes: number
}

/** The receipts of a window's turns. */
export interface ReceiptsWindow {
  receipts: any[]
  /** Bytes read from `receipts.jsonl`. */
  bytes: number
}

/** A file a tail read touches: its path, a cheap identity and its size. */
export interface TailFile {
  path: string
  key: string
  size: number
}

/** `path`'s size and identity (`size:mtimeMs`), or undefined when it cannot be stat'ed. */
export function tailFile(path: string): TailFile | undefined {
  try {
    const info = statSync(path)
    return { path, key: `${info.size}:${info.mtimeMs}`, size: info.size }
  } catch {
    return undefined
  }
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
function lastLineWhere(path: string, needle: Buffer, before: number, accept: (line: any) => boolean): number | null | undefined {
  let end = before
  while (end > 0) {
    const start = Math.max(0, end - BACK_SCAN_BYTES)
    const buffer = readRange(path, start, end - start + needle.length)
    if (!buffer?.length) return undefined
    let at = buffer.length
    for (;;) {
      at = buffer.lastIndexOf(needle, at - 1)
      if (at < 0) break
      const offset = lineStartAt(path, start + at, 0)
      if (offset === undefined) return undefined
      if (offset < before && accept(lineAt(path, offset))) return offset
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
/** A compaction marker at the top of a receipts file is not a receipt. */
const RECEIPTS_MARKER = '$layerfsReceipts'

const isHeader = (event: any): boolean => event?.type === 'request/header' && !!event.data?.header
const isSystem = (event: any): boolean => event?.type === 'system/message' && !!event.data?.message
const isTurn = (event: any): boolean => event?.type === 'turn/start'

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
  const seqs = recordEventSeqs(events.slice(first))
  if (seqs.length < FIRST_PAGE_RECORDS) return { kind: 'grow' }
  const pageStart = seqs[seqs.length - FIRST_PAGE_RECORDS]!
  // Start at the turn the oldest kept record is in: everything before it would
  // be materialized and dropped (and would widen the receipts window), and the
  // turn itself stays complete. An anchored window keeps its whole span instead:
  // the prompt state it reached back for is the reason it was read that far.
  let trim = first
  if (trimWindow) {
    for (let i = first; i < events.length; i++) {
      if (events[i]!.seq > pageStart) break
      if (events[i]!.type === 'turn/start' && Number.isInteger(events[i]!.data?.turn)) trim = i
    }
  }
  const chunk = events.slice(trim)
  const fromSeq = chunk[0]!.seq
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
    if (prefix.length) return { kind: 'ok', window: { events: chunk, fromSeq, fromTurn: chunk[0]!.data.turn, prompt: promptOf(prefix[prefix.length - 1]) } }
    return { kind: 'seed', window: { events: chunk, fromSeq, fromTurn: chunk[0]!.data.turn } }
  }
  return { kind: 'ok', window: { events: chunk, fromSeq, fromTurn: chunk[0]!.data.turn } }
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
  return { kind: 'ok', window: { ...verdict.window, prompt: promptOf(line) } }
}

/**
 * The newest window of `path`, or undefined when the tail cannot be read
 * safely and the caller must parse the whole log. `size` is a stat the caller
 * already did. The window starts at {@link TAIL_START_BYTES}, doubles until it
 * holds the newest records, takes the predecessor header as a seed when the
 * page's first request needs one, and reaches back to the last system message
 * when the page itself needs the prompt text.
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
  let span = Math.min(total, limits.startBytes ?? TAIL_START_BYTES)
  let bytes = 0
  for (;;) {
    const offset = total - span
    // A window that reaches the file's start is the whole log: today's parse is
    // then no slower and gives the true totals, so it stays the answer.
    if (offset === 0) return undefined
    const buffer = readRange(path, offset, span)
    if (!buffer) return undefined
    bytes += buffer.length
    const events = parseChunk(buffer, 'fragment')
    const settled = events ? settle(path, events, offset) : undefined
    if (settled?.kind === 'ok') return { ...settled.window, bytes }
    if (settled?.kind === 'unsafe') return undefined
    if (settled?.kind === 'anchor') {
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
      return next?.kind === 'ok' ? { ...next.window, bytes } : undefined
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
  if (total === 0) return { receipts: [], bytes: 0 }
  const start = Math.max(0, receiptBoundary(path, fromTurn, total) - 64 * 1024)
  const buffer = readRange(path, start, total - start)
  if (!buffer) return undefined
  const parsed = parseReceipts(buffer, start)
  if (!parsed) return undefined
  return {
    receipts: parsed.receipts.filter((row) => Number.isInteger(row?.turn) && row.turn >= fromTurn),
    bytes: buffer.length,
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
  window: { fromSeq: number, fromTurn: number, logKey: string, prompt?: WindowPrompt }
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
    let window: TrajectoryWindow
    let logBytes = 0
    const keptLog = logs.get(id)
    if (keptLog !== undefined && keptLog.key === files.logKey) {
      window = keptLog.window
      remember(logs, id, keptLog)
    } else {
      const read = readTrajectoryWindow(files.logPath, files.logSize, limits)
      if (!read) return undefined
      window = read
      logBytes = read.bytes
      remember(logs, id, { key: files.logKey, window })
    }
    let invocations: any[] = []
    let receiptBytes = 0
    let receiptsCached = false
    if (files.receiptsPath !== undefined) {
      const keptReceipts = receipts.get(id)
      if (keptReceipts !== undefined && keptReceipts.key === files.receiptsKey && keptReceipts.fromTurn === window.fromTurn) {
        invocations = keptReceipts.rows
        remember(receipts, id, keptReceipts)
        receiptsCached = true
      } else {
        const read = readReceiptsWindow(files.receiptsPath, window.fromTurn, files.receiptsSize, limits)
        if (!read) return undefined
        invocations = read.receipts
        receiptBytes = read.bytes
        remember(receipts, id, { key: files.receiptsKey!, fromTurn: window.fromTurn, rows: invocations })
      }
    }
    return {
      events: window.events,
      invocations,
      window: { fromSeq: window.fromSeq, fromTurn: window.fromTurn, logKey: files.logKey, ...(window.prompt ? { prompt: window.prompt } : {}) },
      logBytes,
      receiptBytes,
      cached: logBytes === 0 && receiptsCached,
    }
  }
}
