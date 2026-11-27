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
import { filesApi } from '../files/api.ts'
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
  /** What the filesystem of the `data` root has left (machine.files), as LayerFS names it. */
  free_bytes?: number
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
export interface FilesAsk {
  path?: string | null, cursor?: string | null, depth?: number, limit?: number, offset?: number, length?: number
  /** The caller wants a file window (the file viewer): a saved-files read skips its folder probe. */
  file?: boolean
}

/** The files route of a machine or a Sandbox. */
export const filesRoute = (kind: DetailKind, name: string): string => `/api/${kind === 'machine' ? 'machines' : 'sandboxes'}/${enc(name)}/files`

/** One host read another caller with the same route and ask can join. */
interface SharedRead {
  readonly rid: string
  readonly waiters: Set<ReadWaiter>
}
interface ReadWaiter {
  readonly resolve: (view: FilesView) => void
  readonly reject: (error: unknown) => void
  readonly signal: AbortSignal | undefined
  readonly onAbort: () => void
}
/** Identical first-page reads in flight: a tab's remount (or a second view of the same roots) joins one request. */
const sharedReads = new Map<string, SharedRead>()
/** A read's query, without the request's own `rid` when the key is built. */
const askQuery = (ask: FilesAsk, rid?: string): string => q({ path: ask.path ?? undefined, cursor: ask.cursor ?? undefined, depth: ask.depth, limit: ask.limit, offset: ask.offset, length: ask.length, rid })

/**
 * One files read through `queue`. It resolves with the host's answer, a
 * refusal included (`refused`, or a kept folder marked `stale`); it rejects
 * {@link Dropped} when `signal` aborts first, and with the failure when the
 * request never reached the route.
 *
 * Identical reads are shared: the same route and ask asked twice while the
 * first is on the wire is one request with its own `rid`, and the first
 * caller's abort does not drop the answer the second is waiting for. Only
 * when the last waiter has gone is the host told `inspect.cancel`; the check
 * waits one microtask so a remount that immediately asks again joins instead
 * of issuing the identical roots request a second time.
 */
export function readFiles(api: Pick<LayerfsApi, 'call' | 'op'>, queue: ReadQueue, route: string, ask: FilesAsk, signal?: AbortSignal): Promise<FilesView> {
  if (signal?.aborted) return Promise.reject(new Dropped())
  const key = `${route}${askQuery(ask)}`
  return queue.run(() => new Promise<FilesView>((resolve, reject) => {
    if (signal?.aborted) { reject(new Dropped()); return }
    let flight = sharedReads.get(key)
    if (!flight) {
      const rid = `files-${Date.now().toString(36)}-${++requests}`
      const started: SharedRead = { rid, waiters: new Set() }
      flight = started
      sharedReads.set(key, started)
      const settle = (view: FilesView | null, error?: unknown): void => {
        if (sharedReads.get(key) !== started) return
        sharedReads.delete(key)
        for (const waiter of [...started.waiters]) {
          waiter.signal?.removeEventListener('abort', waiter.onAbort)
          started.waiters.delete(waiter)
          if (view) waiter.resolve(view)
          else waiter.reject(error)
        }
      }
      api.call<FilesView>('GET', `${route}${askQuery(ask, rid)}`).then(
        (view) => settle(view),
        (error) => settle(null, isDropped(error) ? new Dropped() : error),
      )
    }
    const running = flight
    const waiter: ReadWaiter = {
      resolve, reject, signal,
      onAbort: () => {
        if (!running.waiters.delete(waiter)) return
        signal?.removeEventListener('abort', waiter.onAbort)
        reject(new Dropped())
        if (running.waiters.size) return
        // One microtask of grace: a remount's read joins this request instead
        // of sending the identical one again.
        queueMicrotask(() => {
          if (running.waiters.size || sharedReads.get(key) !== running) return
          sharedReads.delete(key)
          // the host stops waiting too: queued, the read never becomes a process
          void api.op('inspect.cancel', { rid: running.rid }).catch(() => {})
        })
      },
    }
    running.waiters.add(waiter)
    signal?.addEventListener('abort', waiter.onAbort, { once: true })
  }), signal)
}

/**
 * Where a Workspace's files are read. LayerFS never lists a Workspace mount
 * through `sandbox.files` (its live files are reached only by its commands),
 * so the Files tab lists what the Workspace was mounted from: its Branch at its
 * base Commit, under the mount's own path. Changes not yet committed are not in it.
 */
export interface WorkspaceSource {
  /** The mount's path (`workspaces[].path`): every path under it is read here. */
  root: string
  /** The project key, `<store>/<project>`. */
  project: string
  branch: string
  /** The Commit the Workspace was mounted at. */
  base: string
}

const savedKind = (kind: string): string => (kind === 'dir' ? 'folder' : kind === 'file' || kind === 'symlink' ? kind : 'other')

/**
 * A files read under a Workspace's mount, answered from its saved files: a
 * folder page (`cursor` is the page position), or with `offset` a file window
 * (`offset` and `next` are line numbers). A path read without `offset` that is
 * not a folder is read as a file (Go to path).
 */
export function readWorkspace(api: Pick<LayerfsApi, 'call'>, queue: ReadQueue, source: WorkspaceSource, ask: FilesAsk, signal?: AbortSignal): Promise<FilesView> {
  const path = ask.path ?? source.root
  const rel = path.length > source.root.length ? path.slice(source.root.length) : '/'
  const file = (line: number): Promise<FileWindowView> => filesApi.file(api as LayerfsApi, source.project, source.branch, rel, source.base, line).then((w) => ({
    kind: 'file', path, size: w.size, offset: line, content: w.text ?? '', binary: w.binary, next: w.next_line ?? null, observedAt: Date.now(), stale: false,
  }))
  const folder = (): Promise<FolderView> => filesApi.list(api as LayerfsApi, source.project, source.branch, rel, source.base, ask.cursor ? Number(ask.cursor) : 0).then((page) => ({
    kind: 'folder', path,
    entries: page.items.map((item): FileEntry => ({ path: item.path === '/' ? source.root : `${source.root}${item.path}`, depth: 1, kind: savedKind(item.kind), size: item.size, mode: item.mode ?? null, mtime: null })),
    next: page.next != null ? String(page.next) : null, hasMore: page.next != null, reason: null, observedAt: Date.now(), stale: false,
  }))
  return queue.run(async () => {
    if (signal?.aborted) throw new Dropped()
    const answer: FilesView = ask.offset !== undefined || ask.file ? await file(ask.offset ?? 1)
      : rel === '/' || ask.cursor ? await folder()
      : await folder().catch((error: unknown) => file(1).catch(() => { throw error }))
    if (signal?.aborted) throw new Dropped()
    return answer
  }, signal)
}

/** A refusal as the error a tree folder or the file view shows: LayerFS's code and words. */
export const refusalError = (stale: Stale): HostError => new HostError(stale.code, stale.message, 200)

// ---------- paths ----------

/** The key of the roots answer among the folders read (no path is `\0roots`: it can never be a path). */
export const ROOTS = '\u0000roots'
/** A Sandbox's views over its roots answer: its Workspaces, and its other roots (home, log) when LayerFS offers no `/`. */
export const WS_ROOTS = '\u0000workspaces'
export const SB_ROOTS = '\u0000sandbox'
/** The folder read for a tree key: both Sandbox views are the roots answer. */
export const readKey = (key: string): string => (key === WS_ROOTS || key === SB_ROOTS ? ROOTS : key)

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
/** A Workspace's mount among a Sandbox's roots. */
export const isWorkspaceEntry = (entry: FileEntry): boolean => entry.role === 'workspace' || (actOf(entry.kind) === 'mount' && !!entry.workspace)

export const wholeOf = (entries: readonly FileEntry[]): FileEntry | undefined => entries.find((e) => e.path === '/' && (e.role === 'machine' || e.role === 'root'))

/**
 * Whether an entry is a LayerFS folder listed where it is not entered: it has
 * a `role` and is met in the Whole filesystem view, or on a mount of its own
 * (machine.files lists it there and reads it by its own path). A Workspace
 * and a log have rows of their own.
 */
export const isLinkedRole = (entry: FileEntry, view: 'layerfs' | 'whole'): boolean =>
  !!entry.role && entry.role !== 'workspace' && entry.role !== 'log' && entry.path !== '/' && (entry.kind === 'folder' || entry.kind === 'mount') && (view === 'whole' || entry.kind === 'mount')

/** A worker log as machine.files lists it: `worker.log` and its rotated part `worker.1.log`. */
export const isWorkerLog = (path: string): boolean => /^worker(\.\d+)?\.log$/.test(baseName(path))

/**
 * The Sandbox a run folder is of, by the folder's name (`layerfs-<id8>-<name>`,
 * or `lfs-<id8>-<name>` from before the rename); null when the name is not one.
 */
export function sandboxOfRunFolder(folder: string): string | null {
  const m = /^(?:layerfs|lfs)-[0-9a-f]{8}-(.+)$/.exec(folder)
  return m ? m[1]! : null
}

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
