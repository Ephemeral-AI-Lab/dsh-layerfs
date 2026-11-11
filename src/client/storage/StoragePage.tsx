/**
 * The Storage page: the board (Projects, Details, Backups), a Store's page or
 * a project's page, with their dialogs. Navigation is local. The view is read
 * again on the host's `storage` events, after each action and on a poll; jobs
 * move on `storage-job` events.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button, IconPlusOutlineRegular, IconRefreshOutlineRegular, IconSearchOutlineRegular, Input, SegmentedTabs, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { enc, type LayerfsApi } from '../api.ts'
import type { DoctorT } from '../doctor/locale.ts'
import { bytes } from '../files/format.ts'
import { useQuery } from '../files/use-query.ts'
import { Empty, LoadError, Loading, Page, PageHead, Refusal, Section, StateChip } from '../ui/index.tsx'
import { StorageBackups } from './Backups.tsx'
import { StorageDetails } from './Details.tsx'
import { StorageDialogs, type StorageDialog } from './dialogs.tsx'
import { DoctorBadge, DoctorFindings } from './Doctor.tsx'
import { useHostEvents, useNow, useStorageJobs } from './hooks.ts'
import type { StorageKey, StorageT } from './locale.ts'
import { attentionOf, cardJob, groupOf, jobCounts, orderStores } from './model.ts'
import { refusalLabels, StoreGlyph } from './parts.tsx'
import { ProjectPage } from './ProjectPage.tsx'
import { StoreCard, type StoreActions } from './StoreCard.tsx'
import { StorePage } from './StorePage.tsx'
import type { DoctorReport, ProjectSummary, StorageJob, StorageView, StoreRow } from './types.ts'
import css from './Storage.module.css'

/** Where the page is. */
type Nav = { kind: 'board' } | { kind: 'store', name: string } | { kind: 'project', key: string }
type BoardTab = 'projects' | 'details' | 'backups'

const POLL_MS = 15_000
const MACHINES_PANEL = 'layerfs-machines'

export interface StoragePageProps {
  api: LayerfsApi
  doctorT: DoctorT
  t: StorageT
}

export function StoragePage({ api, doctorT, t }: StoragePageProps): ReactNode {
  const [nav, setNav] = useState<Nav>({ kind: 'board' })
  const [tab, setTab] = useState<BoardTab>('projects')
  const [tick, setTick] = useState(0)
  const [checks, setChecks] = useState(0)
  const reload = () => setTick((n) => n + 1)
  const storage = useQuery(() => api.call<StorageView>('GET', '/api/storage'), [api, tick])
  const catalogRead = useQuery(() => api.call<ProjectSummary[]>('GET', '/api/projects'), [api, tick])
  const doctor = useQuery(() => api.call<DoctorReport>('GET', '/api/doctor'), [api, checks])
  const { jobs, dismissed, dismiss, take } = useStorageJobs(api, storage.data?.jobs)
  const now = useNow(10_000)
  const [dialog, setDialog] = useState<StorageDialog | null>(null)
  const [failed, setFailed] = useState<unknown>(undefined)
  const [doctorOpen, setDoctorOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [listing, setListing] = useState<string | null>(null)
  const [listingAll, setListingAll] = useState(false)

  useHostEvents(api, ['storage', 'projects', 'projects-changed', 'connection'], (e) => {
    if (e.type !== 'connection' || (e.data as { connected?: boolean } | undefined)?.connected) reload()
  })
  useEffect(() => {
    const id = setInterval(() => { if (document.visibilityState === 'visible') reload() }, POLL_MS)
    return () => clearInterval(id)
  }, [])
  // A job that ended changed the Stores.
  const endedCount = jobs.filter((j) => j.ended).length
  useEffect(() => { if (endedCount) reload() }, [endedCount])

  const view = storage.data
  const catalog = useMemo(() => new Map((catalogRead.data ?? []).map((p) => [p.key, p])), [catalogRead.data])
  const [manual, setManual] = useState(false)
  useEffect(() => { if (!storage.loading) setManual(false) }, [storage.loading])
  const refresh = () => { reload(); setChecks((n) => n + 1) }
  /** An action that answers at once (a job starts): its refusal shows on the page. */
  const act = (work: () => Promise<unknown>) => {
    setFailed(undefined)
    work().then((v) => { if (v && typeof v === 'object' && 'id' in v && 'kind' in v && 'store' in v) take([v as StorageJob]); reload() }, (e: unknown) => setFailed(e))
  }
  const retry = (j: StorageJob): Promise<unknown> => {
    if (j.kind === 'push' || (j.kind === 'move' && j.error?.note === 'pulled')) return api.call('POST', `/api/stores/${enc(j.store)}/push`, { machine: j.target })
    if (j.kind === 'pull') return api.call('POST', `/api/stores/${enc(j.store)}/pull`)
    if (j.kind === 'move') return api.call('POST', `/api/stores/${enc(j.store)}/move`, { machine: j.target })
    if (j.kind === 'backup') return api.call('POST', `/api/stores/${enc(j.store)}/backup`, { bucket: j.target, ...(j.file ? { file: j.file } : {}) })
    return api.call('POST', `/api/buckets/${enc(j.target)}/restore`, { store: j.store, ...(j.file ? { file: j.file } : {}) })
  }
  const openMachine = (_name: string) => api.openPanel(MACHINES_PANEL)
  const actionsFor = (s: StoreRow): StoreActions => ({
    push: () => setDialog({ kind: 'push', store: s }),
    pull: () => act(() => api.call('POST', `/api/stores/${enc(s.name)}/pull`)),
    move: () => setDialog({ kind: 'move', store: s }),
    backup: () => setDialog({ kind: 'backup', store: s }),
    backupTo: (l) => act(() => api.call('POST', `/api/stores/${enc(s.name)}/backup`, { bucket: l.bucket, file: l.file })),
    restore: (bucket, file) => setDialog({ kind: 'restore', bucket, file, store: s.name }),
    remove: () => setDialog({
      kind: 'confirm', title: t('confirmTitleRemove', { name: s.name }), body: t('confirmRemoveBody', { n: s.projects.length }), action: t('removeAction'), name: s.name,
      run: () => api.call('DELETE', `/api/stores/${enc(s.name)}?confirm=${enc(s.name)}`).then(() => setNav({ kind: 'board' })),
    }),
    disconnect: () => setDialog({
      kind: 'confirm', title: t('confirmTitlePg', { name: s.name }), body: t('confirmPgBody'), action: t('disconnectAction'),
      run: () => api.call('POST', `/api/stores/${enc(s.name)}/disconnect`).then(() => setNav({ kind: 'board' })),
    }),
    start: () => act(() => api.call('POST', `/api/machines/${enc(s.machine ?? '')}/start`)),
    addProject: () => setDialog({ kind: 'add-project', store: s.name }),
    retry: (j) => { dismiss(j.id); act(() => retry(j)) },
    dismiss: (j) => dismiss(j.id),
    openMachine,
  })
  const listBucket = (name: string) => {
    setListing(name)
    api.call('GET', `/api/buckets/${enc(name)}/files`).catch(setFailed).finally(() => { setListing(null); reload() })
  }
  const listAll = () => {
    setListingAll(true)
    api.call('POST', '/api/storage/check', {}).catch(setFailed).finally(() => { setListingAll(false); reload() })
  }

  const dialogs = <StorageDialogs api={api} t={t} dialog={dialog} view={view} onClose={() => setDialog(null)} done={refresh} />
  const refusal = failed !== undefined ? (
    <div className={css.refusalBar}>
      <Refusal error={failed} labels={refusalLabels(t)} />
      <Button variant="ghost" size="sm" onClick={() => setFailed(undefined)}>{t('dismiss')}</Button>
    </div>
  ) : null

  if (nav.kind === 'project') {
    return (
      <Page wide label={t('title')}>
        <ProjectPage api={api} t={t} project={nav.key} onStorage={() => setNav({ kind: 'board' })}
          onStore={(name) => setNav({ kind: 'store', name })} onDialog={setDialog}
          onRemoved={() => { refresh(); setNav({ kind: 'store', name: nav.key.slice(0, nav.key.indexOf('/')) }) }} />
        {dialogs}
      </Page>
    )
  }

  if (nav.kind === 'store' && view) {
    const s = view.stores.find((x) => x.name === nav.name)
    return (
      <Page label={t('title')}>
        {refusal}
        <StorePage name={nav.name} view={view} t={t} api={api} doctorT={doctorT} now={now} job={cardJob(jobs, nav.name, dismissed, now)} jobs={jobs.filter((j) => j.store === nav.name)}
          catalog={catalog} on={s ? actionsFor(s) : undefined} onBack={() => setNav({ kind: 'board' })} onOpenProject={(key) => setNav({ kind: 'project', key })} />
        {dialogs}
      </Page>
    )
  }

  const stores = orderStores(view?.stores ?? [])
  const counts = jobCounts(jobs, dismissed)
  const sqlite = stores.filter((s) => s.kind === 'sqlite')
  const projectCount = stores.reduce((n, s) => n + s.projects.length, 0)
  const q = query.trim().toLowerCase()
  const shown = stores.map((s) => {
    const storeHit = !q || `${s.name} ${s.kind} ${s.machine ?? ''} ${s.postgresql?.target ?? ''}`.toLowerCase().includes(q)
    const projects = [...s.projects].sort().filter((p) => storeHit || p.toLowerCase().includes(q))
    return { s, projects, searching: !storeHit, show: storeHit || projects.length > 0 }
  }).filter((x) => x.show)
  const groups: { id: 'home' | 'machines' | 'postgresql', title: StorageKey }[] = [
    { id: 'home', title: 'groupHome' }, { id: 'machines', title: 'groupMachines' }, { id: 'postgresql', title: 'groupPostgresql' },
  ]
  const findingsFor = (name: string) => (doctor.data?.findings ?? []).filter((f) => f.entity?.kind === 'store' && f.entity.name === name)
  const summary = [
    stores.length === 1 ? t('summaryStore') : t('summaryStores', { n: stores.length }),
    projectCount === 1 ? t('summaryProject') : t('summaryProjects', { n: projectCount }),
    sqlite.length ? t('summarySqlite', { size: bytes(sqlite.reduce((n, s) => n + (s.size?.bytes ?? 0), 0)) }) : null,
  ].filter(Boolean).join(' · ')

  return (
    <Page label={t('title')}>
      <PageHead title={t('title')} intro={t('intro')}
        badge={view ? (
          <>
            {counts.running ? <StateChip tone="info" live label={t('jobsRunning', { n: counts.running })} /> : null}
            {counts.failed ? <StateChip tone="danger" label={t('jobsFailed', { n: counts.failed })} /> : null}
          </>
        ) : undefined}
        actions={(
          <>
            <Button variant="outline" size="sm" className={css.toolbarButton} aria-label={t('refresh')} disabled={manual}
              icon={manual ? <StateDot state="ongoing" size={13} /> : <IconRefreshOutlineRegular size={13} />} onClick={() => { setManual(true); refresh() }}>
              <span className={css.toolbarLabel}>{t('refresh')}</span>
            </Button>
            <Button variant="primary" size="sm" className={css.toolbarButton} icon={<IconPlusOutlineRegular size={13} />} onClick={() => setDialog({ kind: 'new-store' })}>
              <span className={css.toolbarLabel}>{t('newStore')}</span>
            </Button>
          </>
        )} />
      {!view ? (
        storage.error ? <LoadError title={t('storageFailed')} error={storage.error} labels={refusalLabels(t)} retryLabel={t('retry')} onRetry={refresh} /> : <Loading label={t('readingStores')} />
      ) : (
        <>
          {refusal}
          <div className={css.summary}>
            <span>{summary}</span>
            <DoctorBadge read={doctor} open={doctorOpen} onToggle={() => setDoctorOpen((o) => !o)} t={t} now={now} />
          </div>
          {doctorOpen ? <DoctorFindings read={doctor} t={t} now={now} /> : null}
          <div className={css.tabBar}>
            <SegmentedTabs size="sm" className={css.tabList} label={t('tabsLabel')} value={tab} onChange={setTab}
              items={[
                { value: 'projects', label: t('tabProjects'), id: 'lfs-storage-projects', panelId: 'lfs-storage-projects-panel' },
                { value: 'details', label: t('tabDetails'), id: 'lfs-storage-details', panelId: 'lfs-storage-details-panel' },
                { value: 'backups', label: t('tabBackups'), id: 'lfs-storage-backups', panelId: 'lfs-storage-backups-panel' },
              ]} />
            {tab === 'projects' && stores.length > 0 ? (
              <Input className={css.search} icon={<IconSearchOutlineRegular size={14} />} placeholder={t('searchPlaceholder')} aria-label={t('searchPlaceholder')}
                value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.preventDefault(); setQuery('') } }} />
            ) : null}
          </div>
          <div role="tabpanel" id={`lfs-storage-${tab}-panel`} aria-labelledby={`lfs-storage-${tab}`} className={css.tabPanel}>
            {tab === 'details' ? (
              <StorageDetails view={view} t={t} now={now} onOpenStore={(name) => setNav({ kind: 'store', name })} onOpenMachine={openMachine} />
            ) : tab === 'backups' ? (
              <StorageBackups view={view} t={t} api={api} doctorT={doctorT} now={now} listing={listing} listingAll={listingAll} onList={listBucket} onListAll={listAll}
                onRestore={(bucket, file, store) => setDialog({ kind: 'restore', bucket, file, store })}
                onBackup={(store, bucket, file) => act(() => api.call('POST', `/api/stores/${enc(store)}/backup`, { bucket, file }))}
                onAdd={() => setDialog({ kind: 'bucket' })} onOpenStore={(name) => setNav({ kind: 'store', name })}
                onDisconnect={(name) => setDialog({
                  kind: 'confirm', title: t('confirmTitleBucket', { name }), body: t('confirmBucketBody'), action: t('disconnectAction'),
                  run: () => api.call('DELETE', `/api/buckets/${enc(name)}`),
                })} />
            ) : stores.length === 0 ? (
              <Empty title={t('noStores')} icon={<StoreGlyph kind="sqlite" size={20} />}>{t('noStoresBody')}</Empty>
            ) : shown.length === 0 ? (
              <Empty title={t('nothingMatches')}>{t('nothingMatchesBody', { query: query.trim() })}</Empty>
            ) : groups.map((g) => {
              const members = shown.filter((x) => groupOf(x.s) === g.id)
              if (!members.length) return null
              return (
                <Section key={g.id} title={t(g.title)} count={String(members.length)}>
                  <div className={css.cards}>
                    {members.map(({ s, projects, searching }) => {
                      const machineState = view.machines.find((m) => m.name === s.machine)?.state
                      const job = cardJob(jobs, s.name, dismissed, now)
                      return (
                        <StoreCard key={s.name} store={s} t={t} now={now} machineState={machineState}
                          attention={job?.ended && job.error ? 'danger' : attentionOf(s, machineState, view.buckets)}
                          job={job} findings={findingsFor(s.name)} projects={projects} catalog={catalog} searching={searching}
                          on={actionsFor(s)} onOpen={() => setNav({ kind: 'store', name: s.name })} onOpenProject={(key) => setNav({ kind: 'project', key })} />
                      )
                    })}
                  </div>
                </Section>
              )
            })}
          </div>
        </>
      )}
      {dialogs}
    </Page>
  )
}
