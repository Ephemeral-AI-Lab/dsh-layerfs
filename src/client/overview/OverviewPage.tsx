/**
 * The LayerFS page: the pinned runtime (with Change…), what `layerfs doctor`
 * finds in the home, and one card each for Machines and Storage that opens
 * that page. It reads the runtime and machines through the Machines
 * controller and Storage through `GET /api/storage`; reading starts nothing.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button, IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import { DoctorAction } from '../doctor/Doctor.tsx'
import type { DoctorT } from '../doctor/locale.ts'
import { bytes } from '../files/format.ts'
import { useQuery, type Query } from '../files/use-query.ts'
import { MachinesProvider, useMachinesContext, type MachinesPageProps, type Translate } from '../machines/context.tsx'
import { MachinesGlyph } from '../machines/icons.tsx'
import { PANEL_ID as MACHINES_PANEL } from '../machines/index.tsx'
import { factsOf } from '../machines/model.ts'
import { RuntimeCard } from '../machines/Runtime.tsx'
import { DoctorBadge, DoctorFindings } from '../storage/Doctor.tsx'
import { useHostEvents, useNow, useStorageJobs } from '../storage/hooks.ts'
import { PANEL_ID as STORAGE_PANEL, StoragePanelIcon } from '../storage/index.tsx'
import type { StorageT } from '../storage/locale.ts'
import { jobCounts } from '../storage/model.ts'
import type { DoctorReport, StorageView } from '../storage/types.ts'
import { Card, Page, PageHead, Section, StateChip } from '../ui/index.tsx'
import { LayerfsGlyph } from './glyph.tsx'
import type { OverviewT } from './locale.ts'
import css from './overview.module.css'

const POLL_MS = 15_000

/** The props the DSH `main` slot renderer gives the LayerFS page. */
export interface OverviewPageProps extends Omit<MachinesPageProps, 't'> {
  t: OverviewT
  /** The Machines namespace's `t`, for the runtime card and machine facts. */
  tm: Translate
  /** The Storage namespace's `t`, for doctor findings and Store facts. */
  ts: StorageT
  api: LayerfsApi
}

export function OverviewPage(props: OverviewPageProps): ReactNode {
  const { t, tm, ts, api, doctorT, ...rest } = props
  const machines = useMemo<MachinesPageProps>(() => ({ ...rest, api, doctorT, t: tm }), [props])
  return (
    <MachinesProvider props={machines}>
      <Overview t={t} ts={ts} api={api} doctorT={doctorT} />
    </MachinesProvider>
  )
}

function Overview({ t, ts, api, doctorT }: { t: OverviewT, ts: StorageT, api: LayerfsApi, doctorT: DoctorT }): ReactNode {
  const { activate, reload: reloadMachines, reloadRuntime, openPanel } = useMachinesContext()
  useEffect(() => activate(), [activate])
  const [tick, setTick] = useState(0)
  const [checks, setChecks] = useState(0)
  const [findingsOpen, setFindingsOpen] = useState(true)
  const storage = useQuery(() => api.call<StorageView>('GET', '/api/storage'), [api, tick])
  const doctor = useQuery(() => api.call<DoctorReport>('GET', '/api/doctor'), [api, checks])
  const now = useNow(10_000)
  useHostEvents(api, ['storage', 'projects-changed', 'runtime-changed', 'connection'], (e) => {
    if (e.type !== 'connection' || (e.data as { connected?: boolean } | undefined)?.connected) setTick((n) => n + 1)
  })
  useEffect(() => {
    const id = setInterval(() => { if (document.visibilityState === 'visible') setTick((n) => n + 1) }, POLL_MS)
    return () => clearInterval(id)
  }, [])
  const refresh = () => { reloadMachines(); reloadRuntime(); setTick((n) => n + 1); setChecks((n) => n + 1) }
  return (
    <Page label={t('panel')}>
      <PageHead title={t('panel')} intro={t('intro')} icon={<LayerfsGlyph size={22} />}
        actions={<Button variant="outline" size="sm" icon={<IconRefreshOutlineRegular size={13} />} onClick={refresh}>{t('refresh')}</Button>} />
      <Section title={t('runtime')}>
        <RuntimeCard />
      </Section>
      <Section title={t('health')}
        actions={(
          <>
            <DoctorAction api={api} t={doctorT} target="host" label={doctorT('diagnoseHost')} />
            <Button variant="ghost" size="sm" disabled={doctor.loading} onClick={() => setChecks((n) => n + 1)}>{t('checkAgain')}</Button>
          </>
        )}>
        <div className={css.health}>
          <DoctorBadge read={doctor} open={findingsOpen} onToggle={() => setFindingsOpen((o) => !o)} t={ts} now={now} />
        </div>
        {findingsOpen ? <DoctorFindings read={doctor} t={ts} now={now} /> : null}
      </Section>
      <Section title={t('resources')}>
        <div className={css.grid}>
          <MachinesCard t={t} onOpen={() => openPanel(MACHINES_PANEL)} />
          <StorageCard t={t} ts={ts} api={api} read={storage} onOpen={() => openPanel(STORAGE_PANEL)} />
        </div>
      </Section>
    </Page>
  )
}

/** One number and its label. */
interface Stat { readonly label: string, readonly value: string }

/** A card that opens a page: its glyph, title, a line of state, and three numbers. */
function SummaryCard({ icon, title, openLabel, line, stats, tone, chips, onOpen }: {
  icon: ReactNode
  title: string
  openLabel: string
  line: string
  stats: readonly Stat[]
  tone?: 'danger' | 'warning' | undefined
  chips?: ReactNode
  onOpen: () => void
}): ReactNode {
  return (
    <Card tone={tone} className={css.card}>
      <header className={css.cardHead}>
        <span className={css.tile} aria-hidden="true">{icon}</span>
        <div className={css.cardTitleBlock}>
          <h3 className={css.cardTitle}>
            <button type="button" className={css.cardOpen} onClick={onOpen} title={openLabel} aria-label={openLabel}>{title}</button>
          </h3>
          <p className={css.cardLine}>{line}</p>
        </div>
        {chips ? <div className={css.chips}>{chips}</div> : null}
      </header>
      <dl className={css.stats}>
        {stats.map((s) => <div key={s.label}><dd>{s.value}</dd><dt>{s.label}</dt></div>)}
      </dl>
    </Card>
  )
}

function MachinesCard({ t, onOpen }: { t: OverviewT, onOpen: () => void }): ReactNode {
  const { t: tm, useMachines } = useMachinesContext()
  const read = useMachines((s) => s)
  const view = read.data
  const title = t('machines')
  const openLabel = t('open', { name: title })
  if (!view?.available) {
    const line = !view ? (read.status === 'error' ? t('unreadable') : t('reading')) : tm('noMachinesTitle')
    return <SummaryCard icon={<MachinesGlyph size={18} />} title={title} openLabel={openLabel} line={line} onOpen={onOpen}
      tone={read.status === 'error' && !view ? 'danger' : undefined}
      stats={[{ label: t('machines'), value: '—' }, { label: t('sandboxes'), value: '—' }, { label: t('workspaces'), value: '—' }]} />
  }
  const f = factsOf(view)
  const n = (k: number) => String(k)
  const line = [
    tm('factRunning', { n: n(f.running) }),
    tm('factStopped', { n: n(f.stopped) }),
    ...f.needs > 0 ? [tm(f.needs === 1 ? 'factNeedsOne' : 'factNeeds', { n: n(f.needs) })] : [],
  ].join(' · ')
  return (
    <SummaryCard icon={<MachinesGlyph size={18} />} title={title} openLabel={openLabel} line={line} onOpen={onOpen}
      tone={f.needs > 0 ? 'danger' : undefined}
      chips={f.ops > 0 ? <StateChip tone="info" live label={tm(f.ops === 1 ? 'factOpOne' : 'factOps', { n: n(f.ops) })} /> : undefined}
      stats={[
        { label: t('machines'), value: n(view.machines.length) },
        { label: t('sandboxes'), value: n(f.sandboxes) },
        { label: t('workspaces'), value: f.workspacesKnown ? n(f.workspaces) : '—' },
      ]} />
  )
}

function StorageCard({ t, ts, api, read, onOpen }: { t: OverviewT, ts: StorageT, api: LayerfsApi, read: Query<StorageView>, onOpen: () => void }): ReactNode {
  const view = read.data
  const { jobs, dismissed } = useStorageJobs(api, view?.jobs)
  const title = t('storage')
  const openLabel = t('open', { name: title })
  if (!view) {
    return <SummaryCard icon={<StoragePanelIcon size={18} />} title={title} openLabel={openLabel} onOpen={onOpen}
      line={read.error !== undefined ? t('unreadable') : t('reading')} tone={read.error !== undefined ? 'danger' : undefined}
      stats={[{ label: t('stores'), value: '—' }, { label: t('projects'), value: '—' }, { label: t('buckets'), value: '—' }]} />
  }
  const projects = view.stores.reduce((n, s) => n + s.projects.length, 0)
  const sqlite = view.stores.filter((s) => s.kind === 'sqlite')
  const counts = jobCounts(jobs, dismissed)
  const line = [
    view.stores.length === 1 ? ts('summaryStore') : ts('summaryStores', { n: view.stores.length }),
    sqlite.length ? ts('summarySqlite', { size: bytes(sqlite.reduce((n, s) => n + (s.size?.bytes ?? 0), 0)) }) : null,
  ].filter(Boolean).join(' · ')
  return (
    <SummaryCard icon={<StoragePanelIcon size={18} />} title={title} openLabel={openLabel} line={line} onOpen={onOpen}
      tone={counts.failed ? 'danger' : undefined}
      chips={(counts.running || counts.failed) ? (
        <>
          {counts.running ? <StateChip tone="info" live label={ts('jobsRunning', { n: counts.running })} /> : null}
          {counts.failed ? <StateChip tone="danger" label={ts('jobsFailed', { n: counts.failed })} /> : null}
        </>
      ) : undefined}
      stats={[
        { label: t('stores'), value: String(view.stores.length) },
        { label: t('projects'), value: String(projects) },
        { label: t('buckets'), value: String(view.buckets.length) },
      ]} />
  )
}
