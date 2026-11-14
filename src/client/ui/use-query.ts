import { useCallback, useEffect, useRef, useState } from 'react'

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

const answers = new Map<string, unknown>()
const CACHE_SIZE = 64
function remember(key: string, value: unknown): void {
  answers.delete(key)
  if (answers.size >= CACHE_SIZE) answers.delete(answers.keys().next().value!)
  answers.set(key, value)
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
  if (answers.has(key)) return answers.get(key) as T
  if (!persist) return undefined
  const value = stored(key)
  if (value !== undefined) answers.set(key, value)
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

/** A refusal's words: a HostError's message, else the thrown value. */
export function errorText(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof (error as Error).message === 'string') return (error as Error).message
  return String(error)
}

/** A refusal's LayerFS code, when it carries one. */
export function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof (error as { code: unknown }).code === 'string' ? (error as { code: string }).code : undefined
}
