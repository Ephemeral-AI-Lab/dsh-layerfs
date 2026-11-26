import { useCallback, useEffect, useRef, useState } from 'react'
import { afterFirstPaint } from './first-paint.ts'

/** One host read: its last answer (kept while a reload runs), its refusal, and whether it runs now. */
export interface Query<T> {
  data: T | undefined
  error: unknown
  loading: boolean
  reload: () => void
}

export interface QueryOptions {
  /**
   * Values whose change means "read again" (an event tick, a retry). Unlike `deps`,
   * a change while a read runs never drops that read: one more read is queued and
   * runs when it ends, so a steady stream of events cannot starve the view.
   */
  refresh?: readonly unknown[]
  /** Keeps the last answer under this key across remounts (a tab switch draws at once, then reads again). */
  cache?: string | undefined
  /**
   * Also keeps it in `sessionStorage`, so a page reload draws it at once too. Only for
   * small answers (a few KB); the stored copy is a hint, always followed by a fresh read.
   */
  persist?: boolean
}

interface Kept { value: unknown, at: number }
const answers = new Map<string, Kept>()
const CACHE_SIZE = 64
function remember(key: string, value: unknown, at = Date.now()): void {
  answers.delete(key)
  if (answers.size >= CACHE_SIZE) answers.delete(answers.keys().next().value!)
  answers.set(key, { value, at })
}

/**
 * Answers a prefetch already holds, for the first render after the click. They
 * are not a cache: an entry is used by one consumer, only while it is younger
 * than {@link PREFETCH_PAINT_MAX_AGE_MS}, and never in place of a newer cached
 * answer. The read on mount still starts (and joins a prefetch in flight).
 */
const prefetched = new Map<string, Kept>()
export const PREFETCH_PAINT_MAX_AGE_MS = 30_000
const PREFETCHED_SIZE = 16

/** Keep an answer for the next mount's first render (the prefetch's job); `at` is when its read started. */
export function keepPrefetched(key: string, value: unknown, at = Date.now()): void {
  prefetched.delete(key)
  if (prefetched.size >= PREFETCHED_SIZE) prefetched.delete(prefetched.keys().next().value!)
  prefetched.set(key, { value, at })
}

/** Take the prefetched answer for `key`, if it is fresh enough; always consumes it. */
function takePrefetched(key: string): Kept | undefined {
  const held = prefetched.get(key)
  if (!held) return undefined
  prefetched.delete(key)
  return Date.now() - held.at <= PREFETCH_PAINT_MAX_AGE_MS ? held : undefined
}

const STORED = 'dsh-layerfs:answer:'
function store(key: string, value: unknown): void {
  try { sessionStorage.setItem(STORED + key, JSON.stringify(value)) } catch { /* full, blocked or not serializable */ }
}
function stored(key: string): unknown {
  try { const text = sessionStorage.getItem(STORED + key); return text === null ? undefined : JSON.parse(text) } catch { return undefined }
}

/** The answer a `cache` key holds, if any (for state that starts from it); `persist` also looks in `sessionStorage`. */
export function cachedAnswer<T>(key: string | undefined, persist = false): T | undefined {
  if (key === undefined) return undefined
  const early = takePrefetched(key)
  const kept = answers.get(key)
  if (early && (!kept || early.at > kept.at)) { remember(key, early.value, early.at); return early.value as T }
  if (kept) return kept.value as T
  if (!persist) return undefined
  const value = stored(key)
  if (value !== undefined) remember(key, value)
  return value as T | undefined
}

/**
 * Run `load` whenever `deps` change, `options.refresh` changes or `reload` is
 * called. One read runs at a time: a change of `deps` replaces the running read
 * (its answer is dropped), while `refresh` and `reload` queue one more read after
 * it. The previous answer stays until the next arrives.
 * @param load - the read.
 * @param deps - what the read depends on.
 * @param options - refresh values and a cache key.
 * @returns the read's state.
 */
export function useQuery<T>(load: () => Promise<T>, deps: readonly unknown[], options: QueryOptions = {}): Query<T> {
  const { refresh = [], cache, persist = false } = options
  const [data, setData] = useState<T | undefined>(() => cachedAnswer<T>(cache, persist))
  const [error, setError] = useState<unknown>(undefined)
  const [loading, setLoading] = useState(true)
  const [bump, setBump] = useState(0)
  const loader = useRef(load)
  loader.current = load
  const cacheKey = useRef(cache)
  cacheKey.current = cache
  const persisted = useRef(persist)
  persisted.current = persist
  /** Goes up when `deps` change: an answer read for older deps is dropped. */
  const identity = useRef(0)
  const flight = useRef<object | null>(null)
  const queued = useRef(false)

  const run = () => {
    const id = identity.current, token = {}
    flight.current = token
    queued.current = false
    setLoading(true)
    loader.current().then(
      (value) => {
        if (id !== identity.current) return
        setData(value)
        setError(undefined)
        if (cacheKey.current !== undefined) {
          remember(cacheKey.current, value)
          if (persisted.current) store(cacheKey.current, value)
        }
      },
      (e: unknown) => { if (id === identity.current) setError(e) },
    ).finally(() => {
      if (flight.current !== token) return
      flight.current = null
      if (id !== identity.current) return
      if (queued.current) run()
      else setLoading(false)
    })
  }

  useEffect(() => {
    identity.current++
    const had = cachedAnswer<T>(cacheKey.current, persisted.current)
    if (had !== undefined) setData(had)
    run()
    return () => { identity.current++ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  const started = useRef(false)
  useEffect(() => {
    if (!started.current) { started.current = true; return }
    if (flight.current) queued.current = true
    else run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...refresh, bump])
  const reload = useCallback(() => setBump((n) => n + 1), [])
  return { data, error, loading, reload }
}

/**
 * `useQuery` whose first read starts after {@link afterFirstPaint}: for the
 * reads that only decorate the first card or row (sizes, exports, the second
 * setup check). Freshness is exactly `useQuery`'s: the read still starts on
 * mount and reads the host once; only its start waits for the frame. Later
 * reloads are immediate, and no answer is reused or kept by time.
 * @param load - the read.
 * @param deps - what the read depends on.
 * @param options - refresh values, cache key and persistence, as `useQuery`.
 * @returns the read's state.
 */
export function useDeferredQuery<T>(load: () => Promise<T>, deps: readonly unknown[], options: QueryOptions = {}): Query<T> {
  return useQuery<T>(() => afterFirstPaint().then(load), deps, options)
}

/** A refusal's words: a HostError's message, else the thrown value. */
export function errorText(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof (error as Error).message === 'string') return (error as Error).message
  return String(error)
}

/** A refusal's LayerFS code, when it carries one. */
export function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof (error as { code: unknown }).code === 'string' ? (error as { code: string }).code : undefined
}
