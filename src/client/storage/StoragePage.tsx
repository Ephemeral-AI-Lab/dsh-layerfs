/**
 * The Storage page, shaped like an IDE: the explorer sidebar holds the
 * Stores-as-folders / projects-as-files outline with the backup buckets, and
 * every Store, project or bucket clicked opens as a tab in the editor. The
 * overview tab carries the board's summary, doctor and details. The view is
 * read again on the host's `storage` events, after each action and on a poll;
 * jobs move on `storage-job` events.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, IconCloseOutlineRegular, IconDatabaseOutlineRegular, IconPlusOutlineRegular, IconRefreshOutlineRegular, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { enc, type LayerfsApi } from '../api.ts'
import type { DoctorT } from '../doctor/locale.ts'
import { bytes } from '../files/format.ts'
import { useQuery, type Query } from '../files/use-query.ts'
import { LayerfsGlyph } from '../overview/glyph.tsx'
import { Empty, LoadError, Loading, Page, PageHead, Refusal, StateChip } from '../ui/index.tsx'
import { BucketPage } from './BucketPage.tsx'
import { StorageDetails } from './Details.tsx'
import { StorageDialogs, type StorageDialog } from './dialogs.tsx'
import { DoctorBadge, DoctorFindings } from './Doctor.tsx'
import { Explorer, FileGlyph, type TabId, type TreeKey } from './Explorer.tsx'
import { useHostEvents, useNow, useStorageJobs } from './hooks.ts'
import type { StorageT } from './locale.ts'
import { cardJob, groupOf, jobCounts, orderStores } from './model.ts'
import { BucketGlyph, refusalLabels, StoreGlyph } from './parts.tsx'
import { ProjectPage } from './ProjectPage.tsx'
import type { StoreActions } from './StoreCard.tsx'
import { StorePage } from './StorePage.tsx'
import type { DoctorReport, ProjectSummary, StorageJob, StorageView, StoreRow } from './types.ts'
import css from './Storage.module.css'

const POLL_MS = 15_000
const MACHINES_PANEL = 'layerfs-machines'

export interface StoragePageProps {
  api: LayerfsApi
  doctorT: DoctorT
  t: StorageT
}

export function StoragePage({ api, doctorT, t }: StoragePageProps): ReactNode {
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

  // The editor: the pages opened from the outline, and which is active.
  const [tabs, setTabs] = useState<TabId[]>(['overview'])
  const [active, setActive] = useState<TabId | null>('overview')
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(['g:home', 'g:machines', 'g:postgresql', 'g:backups']))

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
  // Machine groups open by default, but a machine you folded stays folded.
  const seenPlaces = useRef(new Set<string>())
  useEffect(() => {
    const fresh = (view?.machines ?? []).filter((m) => m.name !== 'native' && m.supports?.sqlite !== false && !seenPlaces.current.has(m.name))
    if (!fresh.length) return
    for (const m of fresh) seenPlaces.current.add(m.name)
    setExpanded((had) => {
      const next = new Set(had)
      for (const m of fresh) next.add(`m:${m.name}`)
      return next
    })
  }, [view?.machines])
  const catalog = useMemo(() => new Map((catalogRead.data ?? []).map((p) => [p.key, p])), [catalogRead.data])
  const [manual, setManual] = useState(false)
  useEffect(() => { if (!storage.loading) setManual(false) }, [storage.loading])
  const refresh = () => { reload(); setChecks((n) => n + 1) }

  /** The outline keys an opened page reveals (its place group, machine and folder). */
  const revealOf = (id: TabId): TreeKey[] => {
    if (id === 'overview') return []
    const body = id.slice(id.indexOf(':') + 1)
    const storeName = id.startsWith('project:') ? body.slice(0, body.indexOf('/')) : body
    if (id.startsWith('bucket:')) return ['g:backups', `b:${body}`]
    const s = view?.stores.find((x) => x.name === storeName)
    if (!s) return [`s:${storeName}`]
    const g = groupOf(s)
    return [`g:${g}` as TreeKey, ...(g === 'machines' && s.machine ? [`m:${s.machine}` as TreeKey] : []), `s:${s.name}`]
  }
  const open = (id: TabId) => {
    setTabs((had) => had.includes(id) ? had : [...had, id])
    setActive(id)
    const reveal = revealOf(id)
    if (reveal.length) setExpanded((had) => {
      const next = new Set(had)
      for (const k of reveal) next.add(k)
      return next
    })
  }
  const close = (id: TabId) => {
    const next = tabs.filter((x) => x !== id)
    setTabs(next)
    if (active === id) setActive(next[Math.min(tabs.indexOf(id), next.length - 1)] ?? null)
  }
  /** Every page of a Store: its own tab and its projects'. */
  const closeStore = (name: string) => {
    const gone = (id: TabId) => id === `store:${name}` || id.startsWith(`project:${name}/`)
    const next = tabs.filter((id) => !gone(id))
    setTabs(next)
    if (active && gone(active)) setActive(next[next.length - 1] ?? null)
  }
  const toggle = (key: TreeKey) => {
    const willOpen = !expanded.has(key)
    setExpanded((had) => { const next = new Set(had); if (willOpen) next.add(key); else next.delete(key); return next })
    // Expanding a bucket folder lists it once, so its files show.
    if (willOpen && key.startsWith('b:')) {
      const b = view?.buckets.find((x) => x.name === key.slice(2))
      if (b && b.files === null) listBucket(b.name)
    }
  }

  /** An action that answers at once (a job starts): its refusal shows on the page. */
  const act = (work: () => Promise<unknown>) => {
    setFailed(undefined)
    work().then((v) => { if (v && typeof v === 'object' && 'id' in v && 'kind' in v && 'store' in v) take([v as StorageJob]); reload() }, (e: unknown) => setFailed(e))
  }
  /** A Store dropped on a place in the explorer: the host picks the push, pull or move. */
  const place = (store: string, machine: string) => act(() => api.call('POST', `/api/machines/${enc(machine)}/stores`, { store }))
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
      run: () => api.call('DELETE', `/api/stores/${enc(s.name)}?confirm=${enc(s.name)}`).then(() => closeStore(s.name)),
    }),
    disconnect: () => setDialog({
      kind: 'confirm', title: t('confirmTitlePg', { name: s.name }), body: t('confirmPgBody'), action: t('disconnectAction'),
      run: () => api.call('POST', `/api/stores/${enc(s.name)}/disconnect`).then(() => closeStore(s.name)),
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

  /** The glyph and words a tab carries. */
  const tabOf = (id: TabId): { icon: ReactNode, label: string } => {
    if (id === 'overview') return { icon: <IconDatabaseOutlineRegular size={14} />, label: t('overview') }
    const body = id.slice(id.indexOf(':') + 1)
    if (id.startsWith('store:')) {
      const s = view?.stores.find((x) => x.name === body)
      return { icon: s ? <StoreGlyph kind={s.kind} size={14} /> : <FileGlyph />, label: body }
    }
    if (id.startsWith('project:')) return { icon: <LayerfsGlyph size={14} />, label: body.slice(body.indexOf('/') + 1) }
    return { icon: <BucketGlyph size={14} />, label: body }
  }

  const tabPage = (id: TabId): ReactNode => {
    if (id === 'overview') {
      return (
        <Page label={t('title')}>
          <Overview view={view} error={storage.error} t={t} api={api} doctorT={doctorT} now={now} doctor={doctor} doctorOpen={doctorOpen}
            jobs={jobs} dismissed={dismissed} manual={manual} onToggleDoctor={() => setDoctorOpen((o) => !o)}
            onRefresh={() => { setManual(true); refresh() }} onNewStore={() => setDialog({ kind: 'new-store' })}
            onOpenStore={(name) => open(`store:${name}`)} onOpenMachine={openMachine} retry={refresh} />
        </Page>
      )
    }
    if (id.startsWith('store:')) {
      const name = id.slice(6)
      const s = view?.stores.find((x) => x.name === name)
      if (!view) return <Page label={t('title')}><Loading label={t('readingStores')} /></Page>
      return (
        <Page label={t('title')}>
          <StorePage name={name} view={view} t={t} api={api} doctorT={doctorT} now={now} job={cardJob(jobs, name, dismissed, now)} jobs={jobs.filter((j) => j.store === name)}
            catalog={catalog} on={s ? actionsFor(s) : undefined} onOpenProject={(key) => open(`project:${key}`)} />
        </Page>
      )
    }
    if (id.startsWith('project:')) {
      const key = id.slice(8)
      const store = key.slice(0, key.indexOf('/'))
      return (
        <Page wide label={t('title')}>
          <ProjectPage api={api} t={t} project={key} onDialog={setDialog} onOpenStore={(store) => open(`store:${store}`)}
            onRemoved={() => { refresh(); setTabs((had) => had.filter((x) => x !== id)); open(`store:${store}`) }} />
        </Page>
      )
    }
    const name = id.slice(7)
    if (!view) return <Page label={t('title')}><Loading label={t('readingStores')} /></Page>
    return (
      <Page label={t('title')}>
        <BucketPage name={name} view={view} t={t} api={api} doctorT={doctorT} now={now} listing={listingAll || listing === name}
          onList={() => listBucket(name)}
          onRestore={(file, store) => setDialog({ kind: 'restore', bucket: name, file, store })}
          onBackup={(store, file) => act(() => api.call('POST', `/api/stores/${enc(store)}/backup`, { bucket: name, file }))}
          onDisconnect={() => setDialog({
            kind: 'confirm', title: t('confirmTitleBucket', { name }), body: t('confirmBucketBody'), action: t('disconnectAction'),
            run: () => api.call('DELETE', `/api/buckets/${enc(name)}`).then(() => close(`bucket:${name}`)),
          })}
          onOpenStore={(store) => open(`store:${store}`)} />
      </Page>
    )
  }

  const explorerView: StorageView = view ?? { machines: [], stores: [], buckets: [], jobs: [], at: 0 }
  return (
    <div className={css.ide}>
      <Explorer view={explorerView} t={t} now={now} jobs={jobs} dismissed={dismissed} active={active} expanded={expanded} query={query}
        refreshing={manual || storage.loading} listing={listing} listingAll={listingAll} onQuery={setQuery} onToggle={toggle} onOpen={open} onPlace={place}
        onRefresh={() => { setManual(true); refresh() }} onNewStore={() => setDialog({ kind: 'new-store' })} onListAll={listAll}
        onAddBucket={() => setDialog({ kind: 'bucket' })} />
      <div className={css.editor}>
        <div className={css.tabs} role="tablist" aria-label={t('openedTabs')}>
          {tabs.map((id) => {
            const { icon, label } = tabOf(id)
            return (
              <div key={id} className={css.tab} role="tab" aria-selected={active === id} data-active={active === id || undefined}
                tabIndex={0} title={id === 'overview' ? label : id.slice(id.indexOf(':') + 1)}
                onClick={() => setActive(id)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActive(id) } }}>
                <span className={css.tabIcon} aria-hidden="true">{icon}</span>
                <span className={css.tabLabel}>{label}</span>
                <button type="button" className={css.tabClose} aria-label={t('closeTab', { name: label })} tabIndex={-1}
                  onClick={(e) => { e.stopPropagation(); close(id) }}>
                  <IconCloseOutlineRegular size={12} />
                </button>
              </div>
            )
          })}
        </div>
        {refusal}
        <div className={css.panels}>
          {tabs.length === 0 ? (
            <div className={css.editorEmpty}>
              <Empty title={t('editorEmptyTitle')} icon={<StoreGlyph kind="sqlite" size={22} />}>{t('editorEmptyBody')}</Empty>
            </div>
          ) : tabs.map((id) => (
            <div key={id} className={css.tabBody} role="tabpanel" hidden={id !== active}>{tabPage(id)}</div>
          ))}
        </div>
      </div>
      {dialogs}
    </div>
  )
}

/** The overview tab: the board's head, doctor, coverage and details. */
function Overview({ view, error, t, api, doctorT, now, doctor, doctorOpen, jobs, dismissed, manual, onToggleDoctor, onRefresh, onNewStore, onOpenStore, onOpenMachine, retry: onRetry }: {
  view: StorageView | undefined
  error: unknown
  t: StorageT
  api: LayerfsApi
  doctorT: DoctorT
  now: number
  doctor: Query<DoctorReport>
  doctorOpen: boolean
  jobs: readonly StorageJob[]
  dismissed: ReadonlySet<string>
  manual: boolean
  onToggleDoctor: () => void
  onRefresh: () => void
  onNewStore: () => void
  onOpenStore: (name: string) => void
  onOpenMachine: (name: string) => void
  retry: () => void
}): ReactNode {
  const counts = jobCounts(jobs, dismissed)
  if (!view) {
    return error
      ? <LoadError title={t('storageFailed')} error={error} labels={refusalLabels(t)} retryLabel={t('retry')} onRetry={onRetry} />
      : <Loading label={t('readingStores')} />
  }
  const stores = orderStores(view.stores)
  const sqlite = stores.filter((s) => s.kind === 'sqlite')
  const projectCount = stores.reduce((n, s) => n + s.projects.length, 0)
  const summary = [
    stores.length === 1 ? t('summaryStore') : t('summaryStores', { n: stores.length }),
    projectCount === 1 ? t('summaryProject') : t('summaryProjects', { n: projectCount }),
    sqlite.length ? t('summarySqlite', { size: bytes(sqlite.reduce((n, s) => n + (s.size?.bytes ?? 0), 0)) }) : null,
  ].filter(Boolean).join(' · ')
  return (
    <>
      <PageHead title={t('title')} intro={t('intro')}
        badge={(
          <>
            {counts.running ? <StateChip tone="info" live label={t('jobsRunning', { n: counts.running })} /> : null}
            {counts.failed ? <StateChip tone="danger" label={t('jobsFailed', { n: counts.failed })} /> : null}
          </>
        )}
        actions={(
          <>
            <Button variant="outline" size="sm" className={css.toolbarButton} aria-label={t('refresh')} disabled={manual}
              icon={manual ? <StateDot state="ongoing" size={13} /> : <IconRefreshOutlineRegular size={13} />} onClick={onRefresh}>
              <span className={css.toolbarLabel}>{t('refresh')}</span>
            </Button>
            <Button variant="primary" size="sm" className={css.toolbarButton} icon={<IconPlusOutlineRegular size={13} />} onClick={onNewStore}>
              <span className={css.toolbarLabel}>{t('newStore')}</span>
            </Button>
          </>
        )} />
      <div className={css.summary}>
        <span>{summary}</span>
        <DoctorBadge read={doctor} open={doctorOpen} onToggle={onToggleDoctor} t={t} now={now} />
      </div>
      {doctorOpen ? <DoctorFindings read={doctor} t={t} now={now} /> : null}
      {stores.length === 0 && view.buckets.length === 0
        ? <Empty title={t('noStores')} icon={<StoreGlyph kind="sqlite" size={20} />}>{t('noStoresBody')}</Empty>
        : <StorageDetails view={view} t={t} now={now} onOpenStore={onOpenStore} onOpenMachine={onOpenMachine} />}
    </>
  )
}
