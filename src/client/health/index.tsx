/**
 * Health area of dsh-layerfs: the sidebar's Health row under LayerFS and the
 * page it opens in the main column (every `layerfs doctor` diagnosis of this
 * home, see ../doctor/Health.tsx). The page reads `GET /api/storage`, the
 * no-target home sweep (`GET /api/doctor`) and the machines through the
 * Machines controller; opening it launches nothing.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { IconShieldOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import { HealthPage } from '../doctor/Health.tsx'
import { NS as DOCTOR_NS, type DoctorT } from '../doctor/locale.ts'
import { useQuery } from '../files/use-query.ts'
import { MachinesProvider, useMachinesContext, type MachinesPageProps, type Translate } from '../machines/context.tsx'
import type { MachinesShare } from '../machines/index.tsx'
import { ChildGlyph } from '../overview/child.tsx'
import type { SidebarGroup } from '../overview/group.ts'
import { useHostEvents, useNow } from '../storage/hooks.ts'
import { NS as STORAGE_NS, type StorageT } from '../storage/locale.ts'
import type { DoctorReport, StorageView } from '../storage/types.ts'
import { Page } from '../ui/index.tsx'

/** The id shared by the sidebar row and the main panel it opens. */
export const PANEL_ID = 'layerfs-health'

interface HealthMainProps extends Omit<MachinesPageProps, 't'> {
  tm: Translate
  ts: StorageT
  api: LayerfsApi
}

function HealthMain(props: HealthMainProps): ReactNode {
  const { tm, ts, api, doctorT, ...rest } = props
  const machines = useMemo<MachinesPageProps>(() => ({ ...rest, api, doctorT, t: tm }), [props])
  return (
    <MachinesProvider props={machines}>
      <HealthBody api={api} t={doctorT} ts={ts} />
    </MachinesProvider>
  )
}

function HealthBody({ api, t, ts }: { api: LayerfsApi, t: DoctorT, ts: StorageT }): ReactNode {
  const { activate } = useMachinesContext()
  useEffect(() => activate(), [activate])
  const [tick, setTick] = useState(0)
  const [sweeps, setSweeps] = useState(0)
  const storage = useQuery(() => api.call<StorageView>('GET', '/api/storage'), [api, tick])
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

function HealthSidebarIcon({ size }: { size?: number }): ReactNode {
  return <ChildGlyph><IconShieldOutlineRegular size={size ?? 16} /></ChildGlyph>
}

/**
 * Register the Health page and its sidebar row under LayerFS.
 * @param ctx - the plugin's client context (slots, locale).
 * @param api - the host API the page reads through.
 * @param group - the LayerFS sidebar group the row shows under.
 * @param machines - the Machines controller's face and `t`.
 */
export function registerHealth(ctx: any, api: LayerfsApi, group: SidebarGroup, machines: MachinesShare): void {
  const doctorT = ctx.locale.bind(DOCTOR_NS)
  const ts = ctx.locale.bind(STORAGE_NS)
  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: DOCTOR_NS,
    inject: () => ({ ...machines.face, tm: machines.t, ts, api, doctorT }),
  }, HealthMain)), 'dsh-layerfs: health page')
  ctx.effect(() => group.whileExpanded(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 9.25,
    label: () => doctorT('healthTitle'),
    locale: DOCTOR_NS,
  }, HealthSidebarIcon))), 'dsh-layerfs: health entry')
}
