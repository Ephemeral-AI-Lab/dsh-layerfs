/**
 * The machine and Sandbox Files views without React (layerfs-project#178
 * "Files view"): the host's shapes, the read queue, paths, and what a row is.
 *
 * Reads. The page reaches the host over HTTP/1.1, so one tab has only about
 * four host requests in flight; a tree that opened many folders at once would
 * hold them all and stall the rest of the page. {@link ReadQueue} lets two
 * files reads run (the inspect lane's own width) and makes the others wait in
 * the page. A read nobody wants any more (its folder collapsed, its view was
 * left) is dropped: waiting, it is never sent; sent, the host is told
 * (`inspect.cancel`) so the read leaves the lane or its process ends.
 */
import { HostError, enc, q, type LayerfsApi } from '../api.ts'
import type { TreeEntry } from '../files/FileTree.tsx'
import type { DetailKind } from '../storage/tabs.ts'

// ---------- host shapes (routes/inspect.ts) ----------

export interface Stale { at: number | null, code: string, message: string }

/** One entry as LayerFS lists it; `kind` is passed as it came. */
export interface FileEntry {
  path: string
  depth: number
  kind: string
  size: number | null
  mode: number | null
  mtime: number | null
  role?: string
  target?: string
  workspace?: string
  fs?: string
  free?: number
}

export interface FolderView {
  kind: 'folder'
  path: string | null
  entries: FileEntry[]
  next: string | null
  hasMore: boolean
  reason: 'deadline' | 'limit' | null
  observedAt: number
  stale: false | Stale
}

export interface FileWindowView {
  kind: 'file'
  path: string
  size: number
  offset: number
  content: string
  binary: boolean
  next: number | null
  observedAt: number
  stale: false
}

export interface RefusedView { kind: 'refused', path: string | null, observedAt: number, stale: Stale }

export type FilesView = FolderView | FileWindowView | RefusedView

// ---------- the read queue ----------

/** A read that was dropped before its answer: nothing to show for it. */
export class Dropped extends Error {
  readonly code = 'Cancelled'
  constructor() { super('The read was dropped') }
}
export const isDropped = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'Cancelled'

/** How many files reads of one tab run at once (the host's inspect lane runs 2). */
export const READS_AT_ONCE = 2

interface Waiting { start: () => void, signal: AbortSignal | undefined, onAbort: () => void }

/** At most `limit` tasks at a time, the rest waiting in order; a waiting task whose signal aborts never starts. */
export class ReadQueue {
  private active = 0
  private readonly waiting: Waiting[] = []
  constructor(readonly limit = READS_AT_ONCE) {}

  /** Tasks running, and tasks waiting. */
  get running(): number { return this.active }
  get queued(): number { return this.waiting.length }

  /**
   * Run `task` when a slot is free.
   * @param signal - aborted while waiting: the task never starts and this rejects {@link Dropped}; later, `task` sees it.
   */
  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new Dropped())
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.active++
        let done = false
        const settle = () => { if (!done) { done = true; this.active--; this.next() } }
        let running: Promise<T>
        try { running = task() } catch (error) { settle(); reject(error); return }
        running.then((value) => { settle(); resolve(value) }, (error) => { settle(); reject(error) })
      }
      if (this.active < this.limit) { start(); return }
      const entry: Waiting = {
        start, signal,
        onAbort: () => {
          const at = this.waiting.indexOf(entry)
          if (at >= 0) this.waiting.splice(at, 1)
          reject(new Dropped())
        },
      }
      signal?.addEventListener('abort', entry.onAbort, { once: true })
      this.waiting.push(entry)
    })
  }

  private next(): void {
    while (this.active < this.limit) {
      const entry = this.waiting.shift()
      if (!entry) return
      entry.signal?.removeEventListener('abort', entry.onAbort)
      entry.start()
    }
  }
}

let requests = 0

/** What a files read asks: the roots without a path; a folder page by `cursor`; a file window by `offset`. */
export interface FilesAsk { path?: string | null, cursor?: string | null, depth?: number, limit?: number, offset?: number, length?: number }

/** The files route of a machine or a Sandbox. */
export const filesRoute = (kind: DetailKind, name: string): string => `/api/${kind === 'machine' ? 'machines' : 'sandboxes'}/${enc(name)}/files`

/**
 * One files read through `queue`. It resolves with the host's answer, a
 * refusal included (`refused`, or a kept folder marked `stale`); it rejects
 * {@link Dropped} when `signal` aborts first, and with the failure when the
 * request never reached the route.
 */
export function readFiles(api: Pick<LayerfsApi, 'call' | 'op'>, queue: ReadQueue, route: string, ask: FilesAsk, signal?: AbortSignal): Promise<FilesView> {
  return queue.run(() => new Promise<FilesView>((resolve, reject) => {
    const rid = `files-${Date.now().toString(36)}-${++requests}`
    let settled = false
    const gone = () => {
      if (settled) return
      settled = true
      // the host stops waiting too: queued, the read never becomes a process
      void api.op('inspect.cancel', { rid }).catch(() => {})
      reject(new Dropped())
    }
    if (signal?.aborted) { settled = true; reject(new Dropped()); return }
    signal?.addEventListener('abort', gone, { once: true })
    api.call<FilesView>('GET', `${route}${q({ path: ask.path ?? undefined, cursor: ask.cursor ?? undefined, depth: ask.depth, limit: ask.limit, offset: ask.offset, length: ask.length, rid })}`).then(
      (view) => { if (settled) return; settled = true; signal?.removeEventListener('abort', gone); resolve(view) },
      (error) => { if (settled) return; settled = true; signal?.removeEventListener('abort', gone); reject(isDropped(error) ? new Dropped() : error) },
    )
  }), signal)
}

/** A refusal as the error a tree folder or the file view shows: LayerFS's code and words. */
export const refusalError = (stale: Stale): HostError => new HostError(stale.code, stale.message, 200)

// ---------- paths ----------

/** The key of the roots answer among the folders read (no path is `\0roots`: it can never be a path). */
export const ROOTS = '\u0000roots'

/** The folder a path is in; `/` for a top entry, null for `/` itself. */
export function parentOf(path: string): string | null {
  if (path === '/' || !path.startsWith('/')) return null
  const at = path.lastIndexOf('/')
  return at === 0 ? '/' : path.slice(0, at)
}

export const baseName = (path: string): string => (path === '/' ? '/' : path.slice(path.lastIndexOf('/') + 1))

/** Whether `path` is `base` or under it. */
export const isUnder = (path: string, base: string): boolean => path === base || base === '/' || path.startsWith(`${base}/`)

/**
 * A path as typed or pasted from a terminal, made into the absolute path the
 * calls take: surrounding blanks and quotes off, a trailing slash off, runs of
 * slashes one. Null when it is not absolute (the calls take no other) or
 * holds what no path holds.
 */
export function pastedPath(text: string): string | null {
  let s = text.trim()
  if ((s.startsWith('"') && s.endsWith('"') && s.length > 1) || (s.startsWith('\'') && s.endsWith('\'') && s.length > 1)) s = s.slice(1, -1)
  // a shell's escaped blanks
  s = s.replace(/\\ /g, ' ')
  if (!s.startsWith('/') || s.includes('\0') || /[\r\n]/.test(s) || s.length > 4096) return null
  s = s.replace(/\/{2,}/g, '/')
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1)
  return s
}

/** The folders from `from` (not included; null: from `/`, included) down to `path`, for a breadcrumb. */
export function crumbsOf(path: string, from: string | null): { name: string, path: string }[] {
  const out: { name: string, path: string }[] = []
  for (let at: string | null = path; at !== null && at !== from; at = parentOf(at)) out.unshift({ name: baseName(at), path: at })
  return out
}

// ---------- rows ----------

/** A tree row: the entry LayerFS listed, with the kind the tree draws (`dir` opens as a folder). */
export interface InspectEntry extends TreeEntry {
  /** LayerFS's kind, as it came. */
  raw: string
  entry: FileEntry
}

/** A listed entry as a tree row; its name is its last part (a root's own row names it by role). */
export const rowOf = (entry: FileEntry): InspectEntry => ({ name: baseName(entry.path), path: entry.path, kind: entry.kind === 'folder' ? 'dir' : entry.kind, size: entry.size, raw: entry.kind, entry })

/**
 * A folder answer's entries by the folder each is in. The answer is a flat
 * list in tree order (`depth` 1 is the folder read); deeper entries, when a
 * read asked for them, go under their own folder.
 * @param root - the key of the folder read (its path, or {@link ROOTS}).
 */
export function groupEntries(entries: readonly FileEntry[], root: string): Map<string, InspectEntry[]> {
  const out = new Map<string, InspectEntry[]>([[root, []]])
  for (const entry of entries) {
    const key = entry.depth <= 1 || root === ROOTS ? root : parentOf(entry.path) ?? root
    const list = out.get(key)
    if (list) list.push(rowOf(entry))
    else out.set(key, [rowOf(entry)])
  }
  return out
}

/** The entry `/` a roots answer offers as the second view (role `machine` or `root`), if any. */
export const wholeOf = (entries: readonly FileEntry[]): FileEntry | undefined => entries.find((e) => e.path === '/' && (e.role === 'machine' || e.role === 'root'))

/** How a row acts, from LayerFS's kind: `open` a folder, `read` a file, or only listed. */
export type RowAct = 'open' | 'read' | 'restricted' | 'unreadable' | 'system' | 'mount' | 'symlink' | 'other'

export function actOf(kind: string): RowAct {
  if (kind === 'folder') return 'open'
  if (kind === 'file') return 'read'
  return kind === 'restricted' || kind === 'unreadable' || kind === 'system' || kind === 'mount' || kind === 'symlink' ? kind : 'other'
}

/** An `mtime` as epoch ms, whether LayerFS gave seconds or ms. */
export const mtimeMs = (mtime: number | null | undefined): number | null => (typeof mtime === 'number' && mtime > 0 ? (mtime < 1e12 ? mtime * 1000 : mtime) : null)

/** Seconds a read has been going, once it is worth showing (1 s). */
export const waitedSeconds = (since: number, now: number): number | null => (now - since >= 1000 ? Math.floor((now - since) / 1000) : null)
