/**
 * What the log pane holds and how it follows a log (layerfs-project#178 "Log
 * pane", "Polling"): the lines loaded in the browser as a bounded, contiguous
 * window of the log; pieces of a long line joined into one visual line; a
 * "log replaced" divider; and the poll interval, which backs off while
 * nothing is new or a read is refused. Pure: no React, no host calls.
 */

/** One line of a log read (host `LogLine`). */
export interface LogLine { text: string, continued?: boolean }

/** Why a read was refused, and when the host last had a good answer for this log (null: never). */
export interface LogStale { at: number | null, code: string, message: string }

/** `GET /api/machines/:id/log` and `GET /api/sandboxes/:name/log` (host `LogView`). */
export interface LogView {
  lines: LogLine[]
  cursor: string | null
  before: string | null
  hasMore: boolean
  observedAt: number
  stale: false | LogStale
}

/** One visual line: a log line (its pieces joined), or the divider where a replaced log starts. */
export interface LogRow {
  id: number
  kind: 'line' | 'replaced'
  text: string
  /** The line's next piece has not arrived yet. */
  open?: boolean
}

export interface LogState {
  rows: LogRow[]
  /** Where the next forward read starts; null: the next read is a tail. */
  cursor: string | null
  /** Where the lines before `rows[0]` end; null: none, or not known any more. */
  before: string | null
  /** `rows` reach the log's end, so new lines can be appended. False after earlier lines pushed the end out of the window. */
  live: boolean
  /** The first answer has arrived (a refusal counts). */
  loaded: boolean
  /** The last read was refused: what is shown is what was read before. */
  stale: LogStale | null
  /** When the lines shown were last read successfully. */
  readAt: number | null
  /** Older lines were dropped from the top with no cursor left to read them again. */
  cutTop: boolean
  /** A cursor for the lines before a row, by row id: a forward answer's `before`, kept so a cut top can still page back. */
  marks: { row: number, before: string }[]
  nextId: number
}

/** The most visual lines the pane keeps (#178: a bounded client buffer). */
export const MAX_ROWS = 5000
/** The most characters it keeps (a few long lines must not hold megabytes each). */
export const MAX_CHARS = 4 * 1024 * 1024
/** How many lines a forward read and an "Earlier lines" read ask for. */
export const FORWARD_LIMIT = 1000
export const EARLIER_LIMIT = 500

export const emptyLog = (): LogState => ({ rows: [], cursor: null, before: null, live: true, loaded: false, stale: null, readAt: null, cutTop: false, marks: [], nextId: 1 })

/** Join a read's pieces into visual lines; a piece after an open row continues it. */
function joined(lines: readonly LogLine[], nextId: number, tail?: LogRow): { rows: LogRow[], merged: LogRow | null, nextId: number } {
  const rows: LogRow[] = []
  let merged: LogRow | null = null
  let last: LogRow | undefined = tail?.open ? tail : undefined
  for (const line of lines) {
    if (last?.open) {
      const next: LogRow = { ...last, text: last.text + line.text, ...(line.continued ? { open: true } : { open: false }) }
      if (last === tail || last === merged) merged = next
      else rows[rows.length - 1] = next
      last = next
    } else {
      last = { id: nextId++, kind: 'line', text: line.text, ...(line.continued ? { open: true } : {}) }
      rows.push(last)
    }
  }
  return { rows, merged, nextId }
}

const chars = (rows: readonly LogRow[]): number => rows.reduce((n, r) => n + r.text.length, 0)

/** Cut the window to its bounds from the top: at a mark when one fits (earlier lines stay reachable), else anywhere. */
function boundTop(state: LogState): LogState {
  let drop = Math.max(0, state.rows.length - MAX_ROWS)
  let size = chars(state.rows)
  for (let i = 0; i < drop; i++) size -= state.rows[i].text.length
  while (size > MAX_CHARS && drop < state.rows.length - 1) size -= state.rows[drop++].text.length
  if (!drop) return state
  const index = new Map(state.rows.map((r, i) => [r.id, i]))
  // the first mark at or past the cut, not so far past it that the window halves
  const mark = state.marks.find((m) => { const at = index.get(m.row); return at !== undefined && at >= drop && at <= drop + state.rows.length / 2 })
  const at = mark ? index.get(mark.row)! : drop
  const rows = state.rows.slice(at)
  const kept = new Set(rows.map((r) => r.id))
  return { ...state, rows, before: mark ? mark.before : null, cutTop: !mark, marks: state.marks.filter((m) => m !== mark && kept.has(m.row)) }
}

/** Cut the window from the bottom (earlier lines were added): it no longer reaches the log's end. */
function boundBottom(state: LogState): LogState {
  let keep = Math.min(state.rows.length, MAX_ROWS)
  let size = 0
  for (let i = 0; i < keep; i++) size += state.rows[i].text.length
  while (size > MAX_CHARS && keep > 1) size -= state.rows[--keep].text.length
  if (keep === state.rows.length) return state
  const rows = state.rows.slice(0, keep)
  const kept = new Set(rows.map((r) => r.id))
  return { ...state, rows, live: false, cursor: null, marks: state.marks.filter((m) => kept.has(m.row)) }
}

/** A tail read (no cursor): it replaces the window. */
export function applyTail(state: LogState, view: LogView): LogState {
  const { rows, nextId } = joined(view.lines, state.nextId)
  return boundTop({ rows, cursor: view.cursor, before: view.before, live: true, loaded: true, stale: null, readAt: view.observedAt, cutTop: false, marks: [], nextId })
}

/** A forward read (from `cursor`): its lines are appended. */
export function applyForward(state: LogState, view: LogView): LogState {
  const last = state.rows.at(-1)
  const { rows, merged, nextId } = joined(view.lines, state.nextId, last)
  const base = merged ? [...state.rows.slice(0, -1), merged] : state.rows
  const first = rows[0] ?? null
  // the answer's `before` is the cursor for the lines before its first line: only a line that starts in this answer has one
  const marks = view.before && first && !merged ? [...state.marks, { row: first.id, before: view.before }] : state.marks
  return boundTop({ ...state, rows: rows.length ? [...base, ...rows] : base, cursor: view.cursor ?? state.cursor, loaded: true, stale: null, readAt: view.observedAt, marks, nextId })
}

/** An "Earlier lines" read (before `before`): its lines are put in front. */
export function applyEarlier(state: LogState, view: LogView): LogState {
  const page = joined(view.lines, state.nextId)
  let rows = page.rows
  let rest = state.rows
  // the page's last piece continues into the first line already shown
  const lastPiece = rows.at(-1)
  if (lastPiece?.open && rest[0]?.kind === 'line') {
    rest = [{ ...rest[0], text: lastPiece.text + rest[0].text }, ...rest.slice(1)]
    rows = rows.slice(0, -1)
  } else if (lastPiece?.open) rows = [...rows.slice(0, -1), { ...lastPiece, open: false }]
  return boundBottom({ ...state, rows: [...rows, ...rest], before: view.before, cutTop: false, stale: null, readAt: state.readAt ?? view.observedAt, nextId: page.nextId })
}

/**
 * The log was rotated or replaced (the cursor was refused `InvalidInput`) and
 * its tail was read anew: a divider, then the new log's lines. The lines of
 * the old log stay above it; nothing is shown twice, since the new file's
 * lines were never read. Earlier paging now belongs to the new file.
 */
export function applyReplaced(state: LogState, view: LogView): LogState {
  const closed = state.rows.map((r) => (r.open ? { ...r, open: false } : r))
  const divider: LogRow = { id: state.nextId, kind: 'replaced', text: '' }
  const { rows, nextId } = joined(view.lines, state.nextId + 1)
  // above the divider is another file: its `before` and marks no longer page this window's top
  return boundTop({ ...state, rows: [...closed, divider, ...rows], cursor: view.cursor, before: null, live: true, loaded: true, stale: null, readAt: view.observedAt, marks: [], nextId })
}

/**
 * A refused read: what is shown stays, marked stale. A first read that was
 * refused shows the host's last good tail (the answer's lines) when it has one.
 */
export function applyRefused(state: LogState, view: LogView): LogState {
  const stale = view.stale || { at: null, code: 'Unknown', message: '' }
  if (!state.loaded && view.lines.length) {
    const { rows, nextId } = joined(view.lines, state.nextId)
    return boundTop({ ...state, rows, cursor: view.cursor, before: view.before, live: true, loaded: true, stale, readAt: stale.at, nextId })
  }
  return { ...state, loaded: true, stale, readAt: state.readAt ?? stale.at }
}

/** Refusals after which polling stops: nothing the page can wait for will change them. */
const FINAL = new Set(['Unsupported', 'NotFound', 'NoSuchSandbox', 'NoSuchMachine', 'CliIncompatible'])
/** Whether a refusal ends polling (`final`: the target is lost or gone, so any refusal does). */
export const stopsPolling = (code: string, final = false): boolean => final || FINAL.has(code)

/** Poll every 2 s; back off to 10 s while nothing is new or a read was refused; a read with more to come follows at once. */
export const POLL_MS = 2000
export const POLL_MAX_MS = 10_000
export const MORE_MS = 150
/** The next interval after a read: `fresh` (it brought lines) starts over at 2 s, else the interval doubles up to 10 s. */
export const nextInterval = (current: number, fresh: boolean): number => (fresh ? POLL_MS : Math.min(POLL_MAX_MS, Math.max(POLL_MS, current * 2)))

/** The rows whose text holds `needle` (case-insensitive), as row indexes. */
export function findRows(rows: readonly LogRow[], needle: string): number[] {
  const q = needle.toLowerCase()
  if (!q) return []
  const found: number[] = []
  for (let i = 0; i < rows.length; i++) if (rows[i].kind === 'line' && rows[i].text.toLowerCase().includes(q)) found.push(i)
  return found
}

/** `text` cut where `needle` occurs (case-insensitive): alternating plain and matching parts. */
export function matchParts(text: string, needle: string): { text: string, hit: boolean }[] {
  const q = needle.toLowerCase()
  if (!q) return [{ text, hit: false }]
  const lower = text.toLowerCase()
  const parts: { text: string, hit: boolean }[] = []
  let at = 0
  // a line with very many matches is not cut into thousands of spans
  for (let i = lower.indexOf(q); i >= 0 && parts.length < 400; i = lower.indexOf(q, at)) {
    if (i > at) parts.push({ text: text.slice(at, i), hit: false })
    parts.push({ text: text.slice(i, i + q.length), hit: true })
    at = i + q.length
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false })
  return parts
}

/** The loaded lines as text (Copy all): one visual line per line; the divider as its words. */
export const logText = (rows: readonly LogRow[], replaced: string): string => rows.map((r) => (r.kind === 'replaced' ? `--- ${replaced} ---` : r.text)).join('\n')
