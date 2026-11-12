/**
 * The Storage page, shaped like an IDE: the explorer sidebar holds the
 * machines (by type, each with its Stores and Sandboxes), the PostgreSQL
 * Stores and the backup buckets, and every machine, Sandbox, Store, project or
 * bucket clicked opens as a tab in the editor; the Machines head opens the
 * machines board. The overview tab carries the Stores' summary, doctor and
 * details. The view is read again on the host's `storage` events, after each
 * action and on a poll; jobs move on `storage-job` events. Machines and
 * Sandboxes come from the Machines controller, polled while the page shows.
 * A link from another page (`openStorage`) opens its tab here.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, IconCloseOutlineRegular, IconGaugeOutlineRegular, IconPlusOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { enc, type LayerfsApi } from '../api.ts'
import type { DoctorT } from '../doctor/locale.ts'
import { bytes } from '../files/format.ts'
import { useQuery, type Query } from '../files/use-query.ts'
import { LayerfsGlyph } from '../overview/glyph.tsx'
import { EmptyState } from '../files/States.tsx'
import { AddMachineDialog } from '../machines/AddMachineDialog.tsx'
import { Board } from '../machines/Board.tsx'
import { MachinesProvider, useMachinesContext, type MachinesPageProps, type Translate as MachinesT } from '../machines/context.tsx'
import { MachineGlyph, MachinesGlyph, SandboxGlyph } from '../machines/icons.tsx'
import { MachineDetail } from '../machines/MachineDetail.tsx'
import { BUILT_IN } from '../machines/model.ts'
import { SandboxDetail } from '../machines/SandboxDetail.tsx'
import { NewSandboxDialog } from '../machines/Sandboxes.tsx'
import { takeStorageRequest, useStorageRequest } from '../projects/navigation.ts'
import { Card, Empty, LoadError, Loading, Page, Refusal, StateChip } from '../ui/index.tsx'
import { BackupFilePage, BucketMark, BucketPage } from './BucketPage.tsx'
import { StorageDialogs, type StorageDialog } from './dialogs.tsx'
import { HomeOverview } from './HomeOverview.tsx'
import { Explorer, FileGlyph, isTabId, type StoreVerbs, type TabId, type TreeKey } from './Explorer.tsx'
import { useHostEvents, useNow, useStorageJobs } from './hooks.ts'
import type { StorageT } from './locale.ts'
import { cardJob, groupOf, jobCounts, orderStores } from './model.ts'
import { HomeGlyph, refusalLabels, StoreGlyph } from './parts.tsx'
import { PaneBar } from './PaneBar.tsx'
import { ProjectPage } from './ProjectPage.tsx'
import type { StoreActions } from './StoreCard.tsx'
import { StorePage } from './StorePage.tsx'
import type { DoctorReport, ProjectSummary, StorageJob, StorageView, StoreRow } from './types.ts'
import css from './Storage.module.css'

const POLL_MS = 15_000

/** The props the DSH `main` slot renderer gives the Storage page: Storage's `t`, and the Machines controller's face with its `t`. */
export interface StorageMainProps extends Omit<MachinesPageProps, 't'> {
  t: StorageT
  /** The Machines namespace's `t`, for machine and Sandbox pages. */
  tm: MachinesT
}

export function StoragePage(props: StorageMainProps): ReactNode {
  const { t, tm, api, doctorT, ...rest } = props
  // Machine pages open their links as tabs here; the ref reaches the editor's latest `open`.
  const openRef = useRef<(id: TabId) => void>(() => {})
  const machines = useMemo<MachinesPageProps>(() => ({
    ...rest, api, doctorT, t: tm, openTab: (id: string) => { if (isTabId(id)) openRef.current(id) },
  }), [props])
  return (
    <MachinesProvider props={machines}>
      <StorageIde api={api} doctorT={doctorT} t={t} openRef={openRef} />
    </MachinesProvider>
  )
}

function StorageIde({ api, doctorT, t, openRef }: { api: LayerfsApi, doctorT: DoctorT, t: StorageT, openRef: { current: (id: TabId) => void } }): ReactNode {
  const mc = useMachinesContext()
  useEffect(() => mc.activate(), [mc.activate])
  const fleetRead = mc.useMachines((s) => s)
  const fleet = fleetRead.data?.available ? fleetRead.data : null
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
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(['g:machines', 'm:native', 'y:native', 'x:native', 'g:postgresql', 'g:backups']))
  const [newMachine, setNewMachine] = useState(false)
  const [newSandbox, setNewSandbox] = useState<string | null>(null)

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
  /** A machine's platform, from the controller or Storage's places. */
  const platformOf = (name: string): string => fleet?.machines.find((m) => m.name === name)?.platform ?? view?.machines.find((m) => m.name === name)?.platform ?? (name === 'native' ? 'native' : '')
  /** The type folder a machine sits under, if any (created machines; the home and Docker stand alone). */
  const typeKeyOf = (name: string): TreeKey[] => {
    const platform = platformOf(name)
    return platform && !BUILT_IN.has(platform) ? [`t:${platform}`] : []
  }
  // Machines, their types and their Stores and Sandboxes open by default, but a folder you folded stays folded.
  const seenPlaces = useRef(new Set<string>())
  const placeNames = [...new Set([...(fleet?.machines ?? []), ...(view?.machines ?? [])].map((m) => m.name))].sort().join('\n')
  useEffect(() => {
    const fresh = placeNames.split('\n').filter((name) => name && name !== 'native' && !seenPlaces.current.has(name))
    if (!fresh.length) return
    for (const name of fresh) seenPlaces.current.add(name)
    setExpanded((had) => {
      const next = new Set(had)
      for (const name of fresh) for (const k of [...typeKeyOf(name), `m:${name}`, `y:${name}`, `x:${name}`]) next.add(k)
      return next
    })
  }, [placeNames])
  const catalog = useMemo(() => new Map((catalogRead.data ?? []).map((p) => [p.key, p])), [catalogRead.data])
  const [manual, setManual] = useState(false)
  useEffect(() => { if (!storage.loading) setManual(false) }, [storage.loading])
  const refresh = () => { reload(); setChecks((n) => n + 1) }

  /** The outline keys an opened page reveals (its group, machine type, machine and folders). */
  const revealOf = (id: TabId): TreeKey[] => {
    if (id === 'overview') return []
    if (id === 'machines') return ['g:machines']
    const body = id.slice(id.indexOf(':') + 1)
    const machineKeys = (name: string): TreeKey[] => ['g:machines', ...typeKeyOf(name), `m:${name}`]
    if (id.startsWith('machine:')) return machineKeys(body)
    if (id.startsWith('sandbox:')) {
      const machine = body.slice(0, body.indexOf('/'))
      return [...machineKeys(machine), `x:${machine}`]
    }
    const storeName = id.startsWith('project:') ? body.slice(0, body.indexOf('/')) : body
    if (id.startsWith('bucket:') || id.startsWith('backup:')) {
      const bucket = id.startsWith('backup:') ? body.slice(0, body.indexOf('/')) : body
      const provider = view?.buckets.find((x) => x.name === bucket)?.provider
      return ['g:backups', `p:${provider === 'r2' || provider === 'minio' ? provider : 'other'}`, `b:${bucket}`]
    }
    const s = view?.stores.find((x) => x.name === storeName)
    if (!s) return [`s:${storeName}`]
    // A SQLite Store sits in its machine's Stores folder (the home is `native`); a PostgreSQL Store in its group.
    const g = groupOf(s)
    if (g === 'postgresql') return ['g:postgresql', `s:${s.name}`]
    const machine = g === 'home' ? 'native' : s.machine ?? ''
    return [...machineKeys(machine), `y:${machine}`, `s:${s.name}`]
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
  openRef.current = open
  // A link from another page asked for a tab: open it once.
  const request = useStorageRequest(api)
  useEffect(() => {
    if (request === null) return
    if (isTabId(request)) open(request)
    takeStorageRequest(api)
  }, [request])
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
  const openMachine = (name: string) => open(`machine:${name}`)
  const storeNamed = (name: string) => view?.stores.find((x) => x.name === name)
  const verbs: StoreVerbs = {
    push: (name) => { const s = storeNamed(name); if (s) setDialog({ kind: 'push', store: s }) },
    pull: (name) => act(() => api.call('POST', `/api/stores/${enc(name)}/pull`)),
    attach: (name, machine) => setDialog({ kind: 'attach', store: name, ...(machine ? { machine } : {}) }),
    detach: (name, machine) => { const s = storeNamed(name); if (s) actionsFor(s).detach(machine) },
  }
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
    attach: (machine, edit) => setDialog({ kind: 'attach', store: s.name, ...(machine ? { machine } : {}), ...(edit ? { edit } : {}) }),
    recheck: (a) => act(() => api.call('POST', `/api/stores/${enc(s.name)}/attach`, { machine: a.machine, ...(a.url ? { url: a.url } : {}), ...(a.password ? { password: a.password } : {}) })),
    detach: (machine) => setDialog({
      kind: 'confirm', title: t('detachTitle', { store: s.name, machine: machine === 'native' ? t('layerfsHome') : machine }),
      body: t('detachBody', { machine: machine === 'native' ? t('layerfsHome') : machine }), action: t('detach'),
      run: () => api.call('POST', `/api/stores/${enc(s.name)}/detach`, { machine }),
    }),
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

  const sandboxMachine = newSandbox !== null ? fleet?.machines.find((m) => m.name === newSandbox) : undefined
  const dialogs = (
    <>
      <StorageDialogs api={api} t={t} dialog={dialog} view={view} onClose={() => setDialog(null)} done={refresh} onOpenStore={(name) => open(`store:${name}`)} />
      {newMachine && fleet ? (
        <AddMachineDialog view={fleet} platforms={fleet.platforms} onClose={() => setNewMachine(false)} onMade={(name) => { setNewMachine(false); open(`machine:${name}`) }} />
      ) : null}
      {sandboxMachine && fleet ? (
        <NewSandboxDialog machine={sandboxMachine} taken={fleet.sandboxes.map((b) => b.name)} onClose={() => setNewSandbox(null)} />
      ) : null}
    </>
  )
  const refusal = failed !== undefined ? (
    <div className={css.refusalBar}>
      <Refusal error={failed} labels={refusalLabels(t)} />
      <Button variant="ghost" size="sm" onClick={() => setFailed(undefined)}>{t('dismiss')}</Button>
    </div>
  ) : null

  /** The glyph and words a tab carries. */
  const tabOf = (id: TabId): { icon: ReactNode, label: string } => {
    if (id === 'overview') return { icon: <IconGaugeOutlineRegular size={14} />, label: t('overview') }
    if (id === 'machines') return { icon: <MachinesGlyph size={14} />, label: t('machinesTab') }
    const body = id.slice(id.indexOf(':') + 1)
    if (id.startsWith('machine:')) {
      return body === 'native'
        ? { icon: <HomeGlyph size={14} />, label: t('groupHome') }
        : { icon: <MachineGlyph platform={platformOf(body)} size={14} mono />, label: body }
    }
    if (id.startsWith('sandbox:')) return { icon: <SandboxGlyph size={14} />, label: body.slice(body.indexOf('/') + 1) }
    if (id.startsWith('store:')) {
      const s = view?.stores.find((x) => x.name === body)
      return { icon: s ? <StoreGlyph kind={s.kind} size={14} /> : <FileGlyph />, label: body }
    }
    if (id.startsWith('project:')) return { icon: <LayerfsGlyph size={14} />, label: body.slice(body.indexOf('/') + 1) }
    if (id.startsWith('backup:')) return { icon: <FileGlyph />, label: body.slice(body.indexOf('/') + 1) }
    return { icon: <BucketMark provider={view?.buckets.find((x) => x.name === body)?.provider} size={14} />, label: body }
  }

  const tabPage = (id: TabId): ReactNode => {
    if (id === 'machines') return <Board go={mc.go} />
    if (id.startsWith('machine:')) return <MachineDetail key={id} name={id.slice(8)} go={mc.go} />
    if (id.startsWith('sandbox:')) {
      const body = id.slice(8)
      return <SandboxDetail key={id} machine={body.slice(0, body.indexOf('/'))} name={body.slice(body.indexOf('/') + 1)} go={mc.go} />
    }
    if (id === 'overview') {
      return (
        <Page wide label={t('title')}>
          <HomeOverview view={view} error={storage.error} t={t} now={now} doctor={doctor} jobs={jobs} dismissed={dismissed}
            onOpen={open} onRefresh={refresh} onCheckAgain={() => setChecks((n) => n + 1)}
            onNewStore={() => setDialog({ kind: 'new-store' })} onNewMachine={() => setNewMachine(true)}
            onRetry={(j) => { dismiss(j.id); act(() => retry(j)) }} onDismiss={(j) => dismiss(j.id)}
            onBackup={(name) => { const s = storeNamed(name); if (s) setDialog({ kind: 'backup', store: s }) }}
            onRecheck={(name, a) => { const s = storeNamed(name); if (s) actionsFor(s).recheck(a) }}
            actionsFor={actionsFor} onAddBucket={() => setDialog({ kind: 'bucket' })} onListBucket={listBucket} onRestore={(bucket, file) => setDialog({ kind: 'restore', bucket, file, store: null })} refreshKey={checks} />
        </Page>
      )
    }
    if (id.startsWith('store:')) {
      const name = id.slice(6)
      const s = view?.stores.find((x) => x.name === name)
      if (!view) return <Page label={t('title')}><Loading label={t('readingStores')} /></Page>
      return (
        <Page wide label={t('title')}>
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
    if (id.startsWith('backup:')) {
      const body = id.slice(7)
      const bucket = body.slice(0, body.indexOf('/'))
      const file = body.slice(body.indexOf('/') + 1)
      if (!view) return <Page label={t('title')}><Loading label={t('readingStores')} /></Page>
      return (
        <Page label={t('title')}>
          <BackupFilePage bucket={bucket} file={file} view={view} t={t} now={now} listing={listingAll || listing === bucket}
            onList={() => listBucket(bucket)}
            onRestore={(f, store) => setDialog({ kind: 'restore', bucket, file: f, store })}
            onBackup={(store, f) => act(() => api.call('POST', `/api/stores/${enc(store)}/backup`, { bucket, file: f }))}
            onOpenStore={(store) => open(`store:${store}`)} onOpenProject={(key) => open(`project:${key}`)}
            onOpenBucket={() => open(`bucket:${bucket}`)} />
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
          onOpenStore={(store) => open(`store:${store}`)} onOpenFile={(file) => open(`backup:${name}/${file}`)} />
      </Page>
    )
  }

  const explorerView: StorageView = view ?? { machines: [], stores: [], buckets: [], jobs: [], at: 0 }
  return (
    <div className={css.ide}>
      <Explorer view={explorerView} t={t} now={now} jobs={jobs} dismissed={dismissed} active={active} expanded={expanded} query={query}
        refreshing={manual || storage.loading} listing={listing} listingAll={listingAll} onQuery={setQuery} onToggle={toggle} onOpen={open} onPlace={place}
        onRefresh={() => { setManual(true); refresh() }} onNewStore={() => setDialog({ kind: 'new-store' })} onListAll={listAll}
        onAddBucket={() => setDialog({ kind: 'bucket' })} onConnectDatabase={() => setDialog({ kind: 'new-store', postgresql: true })}
        onAttach={(store, machine) => setDialog({ kind: 'attach', store, machine })}
        verbs={verbs} onNewMachine={() => setNewMachine(true)} onNewSandbox={setNewSandbox} />
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
