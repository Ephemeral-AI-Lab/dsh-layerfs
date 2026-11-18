/**
 * The Diagnose buttons of the Machines and Storage pages. LayerFS 2.0 has one
 * doctor per kind of thing (`home|machine|store|sandbox|backup doctor`), and
 * the Doctor page is where their reports show: a button starts that thing's
 * doctor (`POST /api/doctor/runs`, one attempt) and opens the Doctor page,
 * which follows the run through its `doctor-run` events.
 */
import { useState, type ReactNode } from 'react'
import { Button, IconInspectOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import { useMachinesContext } from '../machines/context.tsx'
import type { ThingKind } from '../../shared/doctor.ts'
import type { DoctorT } from './locale.ts'

/** What a Diagnose button checks: the home, or one machine, Sandbox, Store or bucket. */
export type DoctorTarget = 'host' | 'machine' | 'sandbox' | 'store.integrity' | 'store.connection' | 'backup.connection'

const KIND: Record<DoctorTarget, ThingKind> = {
  host: 'home', machine: 'machine', sandbox: 'sandbox', 'store.integrity': 'store', 'store.connection': 'store', 'backup.connection': 'bucket',
}

const newId = (): string => {
  const c = globalThis.crypto
  return typeof c?.randomUUID === 'function' ? c.randomUUID().replaceAll('-', '') : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`.padEnd(16, '0')
}

/** Starts the doctor of one thing and opens the Doctor page; resolves when the host has taken the run. */
export function useStartDoctor(api: LayerfsApi): (target: DoctorTarget, name?: string) => Promise<void> {
  const { openStorageTab } = useMachinesContext()
  return async (target, name) => {
    const kind = KIND[target]
    await api.call('POST', '/api/doctor/runs', { runs: [{ id: newId(), kind, ...(kind === 'home' || !name ? {} : { name }) }] })
    openStorageTab('health')
  }
}

/** A Diagnose button: the thing's doctor, read on the Doctor page. */
export function DoctorAction({ api, target, name, label }: { api: LayerfsApi, t: DoctorT, target: DoctorTarget, name?: string | undefined, label: string }): ReactNode {
  const start = useStartDoctor(api)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const press = () => {
    setBusy(true); setFailed(null)
    start(target, name).catch((e) => setFailed((e as { message?: string })?.message ?? String(e))).finally(() => setBusy(false))
  }
  return (
    <Button variant="outline" size="sm" icon={<IconInspectOutlineRegular size={13} />} disabled={busy} onClick={press} title={failed ?? undefined}>{label}</Button>
  )
}
