/** Storage's live reads: the host's events, the jobs they move, and a clock. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { HostEvent, LayerfsApi } from '../api.ts'
import type { StorageJob } from './types.ts'

const DISMISSED_KEY = 'dsh-layerfs.storage.dismissed-jobs'

/** Run `listener` on each host event of `types` while mounted. */
export function useHostEvents(api: LayerfsApi, types: readonly string[], listener: (event: HostEvent) => void, { coalesceMs = 0 }: { coalesceMs?: number } = {}): void {
  const ref = useRef(listener)
  ref.current = listener
  const key = types.join(',')
  useEffect(() => {
    // With `coalesceMs`, a burst of events (many a second during a team run) is one
    // call with the burst's last event, `coalesceMs` after the burst's first.
    let timer: ReturnType<typeof setTimeout> | undefined
    let last: HostEvent | undefined
    const deliver = (e: HostEvent) => {
      if (!coalesceMs) return ref.current(e)
      last = e
      timer ??= setTimeout(() => { timer = undefined; if (last) ref.current(last) }, coalesceMs)
    }
    const offs = key.split(',').map((type) => api.onEvent(type, deliver))
    return () => { for (const off of offs) off(); clearTimeout(timer) }
  }, [api, key, coalesceMs])
}

/** The current time, ticking every `ms`. */
export function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}

/** A `storage-job` event's job, whichever way the host wrapped it. */
const jobOf = (e: HostEvent): StorageJob | null => {
  const d = e.data as { job?: StorageJob } & Partial<StorageJob> | undefined
  const job = d?.job ?? (d && typeof d.id === 'string' ? d as StorageJob : null)
  return job && typeof job.id === 'string' ? job : null
}

function readDismissed(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch (error) {
    // A missing or unreadable record means nothing was dismissed.
    void error
    return []
  }
}

/**
 * The jobs this page knows: what `storage-job` events said, merged with each
 * Storage read; and the ended ones dismissed from their Store (remembered).
 * @param api - the host API.
 * @param seed - the jobs the last Storage read answered.
 * @returns the jobs newest first, the dismissed ids, and dismiss.
 */
export function useStorageJobs(api: LayerfsApi, seed: readonly StorageJob[] | undefined) {
  const [jobs, setJobs] = useState<Map<string, StorageJob>>(() => new Map())
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set(readDismissed()))
  const take = useCallback((list: readonly StorageJob[]) => {
    setJobs((had) => {
      let next: Map<string, StorageJob> | null = null
      for (const j of list) {
        const old = had.get(j.id)
        if (old?.ended && !j.ended) continue
        if (old && old.ended === j.ended && old.phase === j.phase && old.done === j.done && old.half === j.half) continue
        next ??= new Map(had)
        next.set(j.id, j)
      }
      return next ?? had
    })
  }, [])
  useEffect(() => { if (seed) take(seed) }, [seed, take])
  useHostEvents(api, ['storage-job'], (e) => { const j = jobOf(e); if (j) take([j]) })
  const dismiss = useCallback((id: string) => {
    setDismissed((had) => {
      const next = new Set(had).add(id)
      try { localStorage.setItem(DISMISSED_KEY, JSON.stringify([...next].slice(-100))) } catch (error) { void error /* the dismissal is just not remembered */ }
      return next
    })
  }, [])
  const list = useMemo(() => [...jobs.values()].sort((a, b) => b.started - a.started), [jobs])
  return { jobs: list, dismissed, dismiss, take }
}
