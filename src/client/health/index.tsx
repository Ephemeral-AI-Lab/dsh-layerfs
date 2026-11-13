/**
 * Health area of dsh-layerfs: the Health page, a Center page opened from the
 * Center bar (every `layerfs doctor` diagnosis of this home, see
 * ../doctor/Health.tsx). The page reads `GET /api/storage`, the
 * no-target home sweep (`GET /api/doctor`) and the machines through the
 * Machines controller; opening it launches nothing.
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { LayerfsApi } from '../api.ts'
import { HealthPage } from '../doctor/Health.tsx'
import type { DoctorT } from '../doctor/locale.ts'
import { useQuery } from '../files/use-query.ts'
import { useMachinesContext } from '../machines/context.tsx'
import { useHostEvents, useNow } from '../storage/hooks.ts'
import type { StorageT } from '../storage/locale.ts'
import type { DoctorReport, StorageView } from '../storage/types.ts'
import { Page } from '../ui/index.tsx'

/**
 * The Health page's body, shown as a Center page (`health`). It reads the
 * machines through the Machines context the Center page provides.
 */
export function HealthView({ api, t, ts }: { api: LayerfsApi, t: DoctorT, ts: StorageT }): ReactNode {
  const { activate } = useMachinesContext()
  useEffect(() => activate(), [activate])
  const [tick, setTick] = useState(0)
  const [sweeps, setSweeps] = useState(0)
  const storage = useQuery(() => api.call<StorageView>('GET', '/api/storage'), [api], { refresh: [tick], cache: 'GET /api/storage' })
  const sweep = useQuery(() => api.call<DoctorReport>('GET', '/api/doctor'), [api, sweeps])
  const now = useNow(10_000)
  useHostEvents(api, ['storage', 'projects-changed', 'connection'], (e) => {
    if (e.type !== 'connection' || (e.data as { connected?: boolean } | undefined)?.connected) setTick((n) => n + 1)
  })
  return (
    <Page wide label={t('healthTitle')}>
      <HealthPage api={api} t={t} ts={ts} storage={storage.data} sweep={sweep} onSweep={() => setSweeps((n) => n + 1)} now={now} />
    </Page>
  )
}
