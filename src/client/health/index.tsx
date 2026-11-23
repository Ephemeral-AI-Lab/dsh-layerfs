/**
 * Health area of dsh-layerfs: the Center's Health page is the Doctor page
 * (../doctor/DoctorPage.tsx): the home as one tree from records
 * (`GET /api/doctor/tree`), with what the LayerFS 2.0 doctors last said about
 * each thing (`/api/doctor/runs`, `/api/doctor/results`). Opening it runs no
 * doctor.
 */
import type { ReactNode } from 'react'
import type { LayerfsApi } from '../api.ts'
import { DoctorPage } from '../doctor/DoctorPage.tsx'
import type { DoctorT } from '../doctor/locale.ts'
import type { StorageT } from '../storage/locale.ts'
import type { StorageJob } from '../storage/types.ts'

/** The Health page's body, shown as a Center page (`health`). */
export function HealthView({ api, t, ts, refreshKey, jobs, dismissed, now, onRetry, onDismiss }: {
  api: LayerfsApi
  t: DoctorT
  ts: StorageT
  refreshKey?: number
  jobs?: readonly StorageJob[]
  dismissed?: ReadonlySet<string>
  now?: number
  onRetry?: (job: StorageJob) => void
  onDismiss?: (job: StorageJob) => void
}): ReactNode {
  return <DoctorPage api={api} t={t} ts={ts} refreshKey={refreshKey ?? 0} jobs={jobs} dismissed={dismissed} jobNow={now} onJobRetry={onRetry} onJobDismiss={onDismiss} />
}
