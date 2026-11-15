/**
 * Monitoring reads behind the Machines and Sandbox pages (layerfs-project#179
 * D, #178 "Host side"): a machine's worker log and a Sandbox's daemon log now,
 * their files later. What every such route shares lives here:
 *
 * - **One read per key at a time** ({@link InspectReads.read}). Callers asking
 *   the same thing share one CLI process; each may stop waiting on its own
 *   (an `AbortSignal`, or `cancel(rid)` from the page), and the read itself
 *   is dropped only when nobody waits for it any more: queued, it leaves the
 *   inspect lane without a process; running, its process group is ended.
 * - **The last good answer is kept** per target (memory only, bounded) and
 *   answered again, marked `stale` with the refusal, when a later read is
 *   refused. A refusal is an answer here (status 200), never an error of the
 *   page: it stays inside its own part.
 *
 * None of these reads joins the machines view's `Promise.all` or
 * `sandboxObservation`, clears a kept answer, or writes a call log line; the
 * SDK client runs them in the `inspect` lane (cli.ts `INSPECT_CALLS`).
 */
import { refuse } from './util.ts'

/** One log line as LayerFS answers it: a line longer than a 64 KiB chunk comes in pieces, each but the last `continued`. */
export interface LogLine { text: string, continued?: true }

/** Why a read was refused, and when this target last answered (null: never on this host). */
export interface Stale { at: number | null, code: string, message: string }

/** `GET /api/machines/:id/log` and `GET /api/sandboxes/:name/log`. */
export interface LogView {
  /** The lines of this read, oldest first; with `stale`, the last good tail kept for a tail read, else none. */
  lines: LogLine[]
  /** Where the next forward read starts (`?cursor=`); null when LayerFS gave none. */
  cursor: string | null
  /** Where earlier lines end (`?before=`); null when there are none before the first line. */
  before: string | null
  /** LayerFS's `has_more`: more lines in the direction read (after `cursor`, or before `before`). */
  hasMore: boolean
  observedAt: number
  /** This read was refused (`code`, `message`): what is shown is the last good answer. */
  stale: false | Stale
}

/** The `?cursor=&before=&limit=` of a log route. */
export interface LogQuery { cursor: string | null, before: string | null, limit: number | null }

/** The most lines one log read answers (LayerFS's own limit). */
export const LOG_LIMIT_MAX = 1000
/** The most a kept log tail holds, in lines and in characters of text. */
export const KEEP_LINES = 1000
export const KEEP_CHARS = 512 * 1024
/** How many targets keep a last good answer. */
export const KEEP_TARGETS = 64

const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)

/** A log route's query, checked: a cursor or a before (not both), a limit of 1 to 1000. */
export function logQuery(query: URLSearchParams): LogQuery {
  const cursor = query.get('cursor') || null, before = query.get('before') || null
  if (cursor && before) throw refuse(400, 'InvalidInput', 'A log read takes a cursor or a before, not both.')
  for (const value of [cursor, before]) if (value && (value.length > 1024 || /[\0\r\n]/.test(value))) throw refuse(400, 'InvalidInput', 'That is not a log cursor.')
  const raw = query.get('limit')
  let limit: number | null = null
  if (raw !== null && raw !== '') {
    limit = Number(raw)
    if (!Number.isInteger(limit) || limit < 1 || limit > LOG_LIMIT_MAX) throw refuse(400, 'InvalidInput', `A log read's limit is 1 to ${LOG_LIMIT_MAX}.`)
  }
  return { cursor, before, limit }
}

/** A `logs.machine` / `logs.sandbox` answer as the page reads it. */
export function logAnswer(answer: any): Omit<LogView, 'observedAt' | 'stale'> {
  const lines: LogLine[] = []
  for (const line of Array.isArray(answer?.lines) ? answer.lines : []) {
    if (typeof line === 'string') lines.push({ text: line })
    else if (line && typeof line.text === 'string') lines.push(line.continued === true ? { text: line.text, continued: true } : { text: line.text })
  }
  return { lines, cursor: text(answer?.cursor), before: text(answer?.before), hasMore: answer?.has_more === true }
}

/** A refusal as `stale`: its code and words, and when the target last answered. */
export function refusalOf(error: any, at: number | null): Stale {
  const message = error instanceof Error ? error.message : typeof error?.message === 'string' ? error.message : String(error)
  return { at, code: typeof error?.code === 'string' ? error.code : 'Unknown', message }
}

const cancelled = () => refuse(null, 'Cancelled', 'The read was dropped: nobody waits for its answer')

interface Flight { promise: Promise<unknown>, controller: AbortController, waiters: number }

/** Single-flight reads with per-caller cancellation, and the last good answer per target. */
export class InspectReads {
  private readonly flying = new Map<string, Flight>()
  private readonly kept = new Map<string, { at: number, value: unknown }>()
  private readonly requests = new Map<string, AbortController>()

  /**
   * Run `run` once for every caller asking `key` at the same time. `signal`
   * ends this caller's wait (`Cancelled`); the read is aborted (its own
   * signal, handed to `run`) when its last caller has gone.
   */
  read<T>(key: string, run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(cancelled())
    let flight = this.flying.get(key)
    if (!flight) {
      const controller = new AbortController()
      const made: Flight = { controller, waiters: 0, promise: Promise.resolve().then(() => run(controller.signal)).finally(() => { if (this.flying.get(key) === made) this.flying.delete(key) }) }
      // every caller may have gone before it settles
      made.promise.catch(() => {})
      this.flying.set(key, flight = made)
    }
    const joined = flight
    joined.waiters++
    if (!signal) return joined.promise as Promise<T>
    return new Promise<T>((resolve, reject) => {
      let left = false
      const leave = () => {
        if (left) return
        left = true
        signal.removeEventListener('abort', gone)
        if (--joined.waiters === 0 && this.flying.get(key) === joined) { this.flying.delete(key); joined.controller.abort() }
      }
      const gone = () => { leave(); reject(cancelled()) }
      signal.addEventListener('abort', gone, { once: true })
      joined.promise.then((value) => { if (!left) { left = true; signal.removeEventListener('abort', gone); resolve(value as T) } }, (error) => { if (!left) { left = true; signal.removeEventListener('abort', gone); reject(error) } })
    })
  }

  /** How many reads are in flight (tests). */
  get flights(): number { return this.flying.size }

  /**
   * A signal for one page request named `rid`: aborted by `outer` (the
   * connection that asked) or by {@link cancel}. `done` forgets it.
   */
  request(rid: string | null | undefined, outer?: AbortSignal): { signal: AbortSignal | undefined, done: () => void } {
    if (!rid) return { signal: outer, done: () => {} }
    const controller = new AbortController()
    const abort = () => controller.abort()
    if (outer?.aborted) controller.abort()
    else outer?.addEventListener('abort', abort, { once: true })
    this.requests.get(rid)?.abort()
    this.requests.set(rid, controller)
    return { signal: controller.signal, done: () => { outer?.removeEventListener('abort', abort); if (this.requests.get(rid) === controller) this.requests.delete(rid) } }
  }

  /** The page stopped waiting for request `rid` (a left view, a collapsed folder). True when it was still open. */
  cancel(rid: unknown): boolean {
    const controller = typeof rid === 'string' ? this.requests.get(rid) : undefined
    if (!controller) return false
    this.requests.delete(rid as string)
    controller.abort()
    return true
  }

  /** The last good answer kept for `target`. */
  last<T>(target: string): { at: number, value: T } | undefined { return this.kept.get(target) as { at: number, value: T } | undefined }

  /** Keep `value` as `target`'s last good answer (the oldest target goes past {@link KEEP_TARGETS}). */
  keep(target: string, value: unknown, at = Date.now()): void {
    this.kept.delete(target)
    if (this.kept.size >= KEEP_TARGETS) this.kept.delete(this.kept.keys().next().value!)
    this.kept.set(target, { at, value })
  }

  /** Forget what is kept for `target` (it was removed or replaced). */
  forget(target: string): void { this.kept.delete(target) }

  /**
   * One log read for `target` (`machine:<name>` or `sandbox:<name>`).
   * A tail read (no cursor, no before) is kept whole; a forward read extends
   * the kept tail (bounded by {@link KEEP_LINES} and {@link KEEP_CHARS}; once
   * its start is cut, its `before` is gone). A refused read answers `stale`:
   * with the kept tail for a tail read, else with no lines and the cursors it
   * was asked with, so the page keeps what it already shows.
   * @param call - the LayerFS call: `(options) => lfs.logs.machine(name, options)`.
   */
  async log(target: string, query: LogQuery, call: (options: Record<string, unknown>) => Promise<unknown>, signal?: AbortSignal): Promise<LogView> {
    const tail = !query.cursor && !query.before
    const key = `log:${target}:${query.cursor ?? ''}:${query.before ?? ''}:${query.limit ?? ''}`
    const observedAt = Date.now()
    let answer: unknown
    try {
      answer = await this.read(key, (inner) => call({
        ...(query.cursor ? { cursor: query.cursor } : {}), ...(query.before ? { before: query.before } : {}), ...(query.limit ? { limit: query.limit } : {}), signal: inner,
      }), signal)
    } catch (error: any) {
      // nobody waits for it: there is no page part to show a stale answer in
      if (error?.code === 'Cancelled') throw error
      const kept = this.last<Omit<LogView, 'observedAt' | 'stale'>>(`log:${target}`)
      const stale = refusalOf(error, kept?.at ?? null)
      if (tail && kept) return { ...kept.value, observedAt, stale }
      return { lines: [], cursor: query.cursor, before: query.before, hasMore: false, observedAt, stale }
    }
    const view = logAnswer(answer)
    if (tail) this.keep(`log:${target}`, bounded(view), observedAt)
    else if (query.cursor) {
      const kept = this.last<Omit<LogView, 'observedAt' | 'stale'>>(`log:${target}`)
      // only the tail this read continues: another reader's cursor leaves the kept answer alone
      if (kept && kept.value.cursor === query.cursor) this.keep(`log:${target}`, bounded({ ...kept.value, lines: [...kept.value.lines, ...view.lines], cursor: view.cursor, hasMore: view.hasMore }), observedAt)
    }
    return { ...view, observedAt, stale: false }
  }
}

/** A log answer cut to what is kept: the newest lines; a cut start has no `before`. */
function bounded(view: Omit<LogView, 'observedAt' | 'stale'>): Omit<LogView, 'observedAt' | 'stale'> {
  let from = Math.max(0, view.lines.length - KEEP_LINES), chars = 0
  for (let i = view.lines.length - 1; i >= from; i--) {
    chars += view.lines[i].text.length
    if (chars > KEEP_CHARS) { from = i + 1; break }
  }
  // never start inside a long line's pieces
  while (from > 0 && from < view.lines.length && view.lines[from - 1].continued) from++
  return from === 0 ? view : { ...view, lines: view.lines.slice(from), before: null }
}
