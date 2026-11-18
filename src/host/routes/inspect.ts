/**
 * Monitoring reads behind the Machines and Sandbox pages (layerfs-project#179
 * D, #178 "Host side"): a machine's worker log, a Sandbox's daemon log, and
 * the files of both. What every such route shares lives here:
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

/**
 * A log answer as the page reads it: 2.0's `machine log` and `sandbox log`,
 * `items` (oldest first) and `next_cursor`, the lines before them (a 2.0 log
 * pages backwards only: it is `before`, and there is no forward cursor).
 */
export function logAnswer(answer: any): Omit<LogView, 'observedAt' | 'stale'> {
  const lines: LogLine[] = []
  for (const line of Array.isArray(answer?.items) ? answer.items : []) if (line && typeof line.text === 'string') lines.push(line.continued === true ? { text: line.text, continued: true } : { text: line.text })
  const before = text(answer?.next_cursor)
  return { lines, cursor: null, before, hasMore: !!before }
}

/** A refusal as `stale`: its code and words, and when the target last answered. */
export function refusalOf(error: any, at: number | null): Stale {
  const message = error instanceof Error ? error.message : typeof error?.message === 'string' ? error.message : String(error)
  return { at, code: typeof error?.code === 'string' ? error.code : 'Unknown', message }
}

// ---------------------------------------------------------------- files

/**
 * One entry of a folder as LayerFS lists it (`sandbox.files`, `machine.files`).
 * `kind`: `file`, `folder`, `symlink` (its `target`, never followed), `mount`
 * (its `fs`; a Workspace's carries `workspace`), `restricted` (kept private by
 * LayerFS), `system`, `unreadable` (not world-readable) or `other`; a kind
 * this host does not know is passed as it came. A root carries its `role`.
 */
export interface FileEntry {
  path: string
  /** 1 for an entry of the folder read; deeper ones only with `?depth=`. */
  depth: number
  kind: string
  size: number | null
  mode: number | null
  mtime: number | null
  role?: string
  target?: string
  workspace?: string
  fs?: string
  /** What the filesystem of the `data` root has left (`machine.files` roots), under LayerFS's own name. */
  free_bytes?: number
}

/** A folder page, or the roots (no path). `reason` says why a page ended early: its time budget (`deadline`) or its size (`limit`). */
export interface FolderView {
  kind: 'folder'
  /** The folder read; null for the roots answer. */
  path: string | null
  entries: FileEntry[]
  /** Where the next page starts (`?cursor=`); null at the end. */
  next: string | null
  hasMore: boolean
  reason: 'deadline' | 'limit' | null
  observedAt: number
  /** This read was refused: what is shown is the folder's last good first page. */
  stale: false | Stale
}

/** One window of a file. */
export interface FileWindowView {
  kind: 'file'
  path: string
  size: number
  offset: number
  /** The window's text; not shown when `binary`. */
  content: string
  /** The first window holds a NUL: the page shows the size instead of text. */
  binary: boolean
  /** The byte offset of the next window (`?offset=`); null at the end. */
  next: number | null
  observedAt: number
  stale: false
}

/** A read LayerFS refused, with nothing kept to show for it. */
export interface RefusedView {
  kind: 'refused'
  path: string | null
  observedAt: number
  stale: Stale
}

/** `GET /api/machines/:id/files` and `GET /api/sandboxes/:name/files`. */
export type FilesView = FolderView | FileWindowView | RefusedView

/** The `?path=&depth=&cursor=&limit=&offset=&length=` of a files route. */
export interface FilesQuery { path: string | null, depth: number | null, cursor: string | null, limit: number | null, offset: number | null, length: number | null }

/** The most entries one folder page answers, the deepest walk asked for, and the largest file window (LayerFS's own limits). */
export const FILES_LIMIT_MAX = 1000
export const FILES_DEPTH_MAX = 32
export const FILES_LENGTH_MAX = 1024 * 1024
/** How many folders (first pages, and each target's roots) keep a last good answer. */
export const KEEP_FOLDERS = 128

/** A files route's query, checked before any call: an absolute path, whole numbers in LayerFS's ranges. */
export function filesQuery(query: URLSearchParams): FilesQuery {
  const path = query.get('path') || null
  if (path !== null && (!path.startsWith('/') || path.length > 4096 || path.includes('\0'))) throw refuse(400, 'InvalidInput', 'A path here is absolute: it starts with /.')
  const cursor = query.get('cursor') || null
  if (cursor !== null && (cursor.length > 8192 || cursor.includes('\0'))) throw refuse(400, 'InvalidInput', 'That is not a folder cursor.')
  const whole = (name: string, min: number, max: number): number | null => {
    const raw = query.get(name)
    if (raw === null || raw === '') return null
    const n = Number(raw)
    if (!Number.isSafeInteger(n) || n < min || n > max) throw refuse(400, 'InvalidInput', `A files read's ${name} is ${min} to ${max}.`)
    return n
  }
  const q: FilesQuery = { path, cursor, depth: whole('depth', 1, FILES_DEPTH_MAX), limit: whole('limit', 1, FILES_LIMIT_MAX), offset: whole('offset', 0, Number.MAX_SAFE_INTEGER), length: whole('length', 1, FILES_LENGTH_MAX) }
  if (path === null && (q.cursor !== null || q.offset !== null || q.length !== null)) throw refuse(400, 'InvalidInput', 'The roots are read without a cursor, offset or length.')
  if (q.cursor !== null && (q.offset !== null || q.length !== null)) throw refuse(400, 'InvalidInput', 'A folder page takes a cursor, a file window an offset and length, not both.')
  return q
}

const count = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null)

/** A file mode as LayerFS 2.0 spells it (`"0644"`), or today's number. */
const modeOf = (value: unknown): number | null => (typeof value === 'string' && /^[0-7]{3,6}$/.test(value) ? parseInt(value, 8) : count(value))
/** An ISO time (2.0 `modified_at`) as epoch ms. */
const msOf = (value: unknown): number | null => { const at = typeof value === 'string' ? Date.parse(value) : NaN; return Number.isFinite(at) ? at : null }

/**
 * A 2.0 `machine files --detail` entry's kind as the page acts on it: what
 * LayerFS lists and does not read (`not_read`: system, mount, unreadable,
 * restricted) by that word, else its `type` (`dir` is a folder).
 */
export const entryKind = (type: unknown, notRead: unknown): string =>
  text(notRead) ?? (type === 'dir' ? 'folder' : type === 'file' || type === 'symlink' ? type : 'other')

/**
 * A 2.0 `machine files --detail` answer: a folder (`items`, `next_cursor`,
 * `type: dir`) or a file window (`text` with `next_byte_offset` while more
 * remains, or `binary: true` with its `size`). `offset` is the window asked for.
 */
export function machineFilesAnswer(answer: any, path: string | null, offset: number | null): Omit<FolderView, 'observedAt' | 'stale'> | Omit<FileWindowView, 'observedAt' | 'stale'> {
  if (answer?.type === 'file' || typeof answer?.text === 'string' || answer?.binary === true) {
    const next = count(answer.next_byte_offset)
    return { kind: 'file', path: path ?? '', size: count(answer.size) ?? 0, offset: offset ?? 0, content: typeof answer.text === 'string' ? answer.text : '', binary: answer.binary === true, next: next !== null && Number.isSafeInteger(next) ? next : null }
  }
  if (!Array.isArray(answer?.items)) throw refuse(null, 'Unknown', 'LayerFS answered neither a folder nor a file.')
  const entries: FileEntry[] = []
  for (const e of answer.items) {
    if (!e || typeof e.path !== 'string' || !e.path) continue
    entries.push({
      path: e.path, depth: Number.isSafeInteger(e.depth) && e.depth > 0 ? e.depth : 1, kind: entryKind(e.type, e.not_read),
      size: count(e.size), mode: modeOf(e.mode), mtime: msOf(e.modified_at),
      ...(text(e.role) ? { role: e.role } : {}), ...(text(e.target) ? { target: e.target } : {}), ...(text(e.workspace) ? { workspace: e.workspace } : {}), ...(text(e.fs) ? { fs: e.fs } : {}),
      ...(count(e.disk_free_bytes) !== null ? { free_bytes: count(e.disk_free_bytes)! } : {}),
    })
  }
  const next = text(answer.next_cursor)
  return { kind: 'folder', path, entries, next, hasMore: !!next, reason: null }
}

/** A 2.0 `machine files` or `sandbox files` answer (one shape for both), as the page reads it. */
export function filesAnswer(answer: any, path: string | null, offset: number | null = null): Omit<FolderView, 'observedAt' | 'stale'> | Omit<FileWindowView, 'observedAt' | 'stale'> {
  if (!answer || typeof answer !== 'object') throw refuse(null, 'Unknown', 'LayerFS answered neither a folder nor a file.')
  return machineFilesAnswer(answer, path, offset)
}

const cancelled = () => refuse(null, 'Cancelled', 'The read was dropped: nobody waits for its answer')

interface Flight { promise: Promise<unknown>, controller: AbortController, waiters: number }

/** Single-flight reads with per-caller cancellation, and the last good answer per target. */
export class InspectReads {
  private readonly flying = new Map<string, Flight>()
  private readonly kept = new Map<string, { at: number, value: unknown }>()
  private readonly requests = new Map<string, AbortController>()
  private readonly keptFolders = new Map<string, { at: number, value: Omit<FolderView, 'observedAt' | 'stale'> }>()

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

  /**
   * One files read for `target` (`machine:<name>` or `sandbox:<name>`): the
   * roots (no path), a folder page, or a file window; LayerFS says which a
   * path is. A folder's first page (and the roots) is kept; when a later read
   * of it is refused, the kept page answers again marked `stale`. Any other
   * refused read answers `refused` with the refusal: a refusal stays inside
   * the folder or file it is about, and never fails the page's request.
   * @param call - the LayerFS call: `(path, options) => lfs.machine.files(name, path, options)`.
   */
  async files(target: string, query: FilesQuery, call: (path: string | undefined, options: Record<string, unknown>) => Promise<unknown>, signal?: AbortSignal): Promise<FilesView> {
    const key = `files:${target}:${JSON.stringify([query.path, query.depth, query.cursor, query.limit, query.offset, query.length])}`
    const first = query.cursor === null && query.offset === null && query.length === null
    const keptKey = `${target}\0${query.path ?? ''}\0${query.depth ?? ''}\0${query.limit ?? ''}`
    const observedAt = Date.now()
    let answer: unknown
    try {
      answer = await this.read(key, (inner) => call(query.path ?? undefined, {
        ...(query.depth !== null ? { depth: query.depth } : {}), ...(query.cursor !== null ? { cursor: query.cursor } : {}), ...(query.limit !== null ? { limit: query.limit } : {}),
        ...(query.offset !== null ? { offset: query.offset } : {}), ...(query.length !== null ? { length: query.length } : {}), signal: inner,
      }), signal)
    } catch (error: any) {
      if (error?.code === 'Cancelled') throw error
      const kept = first ? this.keptFolders.get(keptKey) : undefined
      const stale = refusalOf(error, kept?.at ?? null)
      if (kept) return { ...kept.value, observedAt, stale }
      return { kind: 'refused', path: query.path, observedAt, stale }
    }
    let view: ReturnType<typeof filesAnswer>
    try { view = filesAnswer(answer, query.path, query.offset) } catch (error) { return { kind: 'refused', path: query.path, observedAt, stale: refusalOf(error, null) } }
    if (view.kind === 'folder' && first) {
      this.keptFolders.delete(keptKey)
      if (this.keptFolders.size >= KEEP_FOLDERS) this.keptFolders.delete(this.keptFolders.keys().next().value!)
      this.keptFolders.set(keptKey, { at: observedAt, value: view })
    } else if (view.kind === 'file' && first) this.keptFolders.delete(keptKey)
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
