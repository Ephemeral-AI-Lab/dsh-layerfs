import { useCallback, useEffect, useRef, useState } from 'react'

/** One host read: its last answer (kept while a reload runs), its refusal, and whether it runs now. */
export interface Query<T> {
  data: T | undefined
  error: unknown
  loading: boolean
  reload: () => void
}

/**
 * Run `load` whenever `deps` change or `reload` is called. A read that a newer
 * one replaced is dropped; the previous answer stays until the next arrives.
 * @param load - the read.
 * @param deps - what the read depends on.
 * @returns the read's state.
 */
export function useQuery<T>(load: () => Promise<T>, deps: readonly unknown[]): Query<T> {
  const [data, setData] = useState<T | undefined>(undefined)
  const [error, setError] = useState<unknown>(undefined)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  const generation = useRef(0)
  const loader = useRef(load)
  loader.current = load
  useEffect(() => {
    const mine = ++generation.current
    setLoading(true)
    loader.current().then(
      (value) => { if (mine === generation.current) { setData(value); setError(undefined); setLoading(false) } },
      (e: unknown) => { if (mine === generation.current) { setError(e); setLoading(false) } },
    )
    return () => { if (generation.current === mine) generation.current++ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])
  const reload = useCallback(() => setTick((n) => n + 1), [])
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
