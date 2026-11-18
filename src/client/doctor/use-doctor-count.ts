/**
 * The Overview's Doctor count: the open findings of the doctors' last reports
 * (`GET /api/doctor/results`, followed through `doctor-run` events). The home
 * doctor (`layerfs home doctor --detail --progress`) runs once when the host
 * holds no home report yet, and again on each Check again; one attempt each.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { LayerfsApi } from '../api.ts'
import { useHostEvents } from '../storage/hooks.ts'
import type { Query } from '../ui/use-query.ts'
import { openFindings, type DoctorCount, type DoctorResults, type DoctorRun } from '../../shared/doctor.ts'

const ENDED = ['done', 'failed', 'stopped']
const newId = (): string => {
  const c = globalThis.crypto
  return typeof c?.randomUUID === 'function' ? c.randomUUID().replaceAll('-', '') : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`.padEnd(16, '0')
}

/** @param checks - a counter the page bumps for Check again: each change after the first runs the home doctor. */
export function useDoctorCount(api: LayerfsApi, checks: number): Query<DoctorCount> {
  const [data, setData] = useState<DoctorCount | undefined>(undefined)
  const [error, setError] = useState<unknown>(undefined)
  const [homeRunning, setHomeRunning] = useState(false)
  const [reading, setReading] = useState(true)
  const first = useRef(true)

  const read = useCallback(async (): Promise<DoctorResults | null> => {
    setReading(true)
    try {
      const held = await api.call<DoctorResults>('GET', '/api/doctor/results')
      setData(openFindings(held.last ?? []))
      setHomeRunning((held.running ?? []).some((r) => r.kind === 'home'))
      setError(undefined)
      return held
    } catch (e) { setError(e); return null } finally { setReading(false) }
  }, [api])

  const runHome = useCallback(async () => {
    setHomeRunning(true)
    try { await api.call('POST', '/api/doctor/runs', { runs: [{ id: newId(), kind: 'home' }] }) } catch (e) { setError(e); setHomeRunning(false) }
  }, [api])

  useEffect(() => {
    const again = !first.current
    first.current = false
    void read().then((held) => {
      if (!held) return
      const homeHeld = held.last.some((r) => r.kind === 'home') || held.running.some((r) => r.kind === 'home')
      if (again || !homeHeld) void runHome()
    })
  }, [read, runHome, checks])

  useHostEvents(api, ['doctor-run'], (e) => {
    const run = e.data as DoctorRun | undefined
    if (run && typeof run.id === 'string' && ENDED.includes(run.state)) void read()
  })

  return { data, error, loading: reading || homeRunning, reload: () => { void read() } }
}
