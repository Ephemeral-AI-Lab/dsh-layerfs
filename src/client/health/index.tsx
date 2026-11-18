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

/** The Health page's body, shown as a Center page (`health`). */
export function HealthView({ api, t, ts }: { api: LayerfsApi, t: DoctorT, ts: StorageT }): ReactNode {
  return <DoctorPage api={api} t={t} ts={ts} />
}
