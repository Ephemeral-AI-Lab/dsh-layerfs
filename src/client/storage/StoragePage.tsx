/**
 * The Storage page: one page at a time under a navigation bar (`Nav.tsx`).
 * The Overview is home; every machine, Sandbox, Store, project, bucket or
 * backup file it links to opens in its place, Back and Forward walk the pages
 * visited, the breadcrumb leads back up (and sideways through its switchers),
 * and Jump to opens anything by name. There is no sidebar: what the tree did
 * lives on the pages (Store menus push, pull and move; machine cards power and
 * add Sandboxes) and in the bar (running transfers, Refresh, Add).
 * The view is read again on the host's `storage` events, after each action
 * and on a poll; jobs move on `storage-job` events. Machines and
 * Sandboxes come from the Machines controller, polled while the page shows.
 * A link from another page (`openStorage`) opens its page here.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { enc, type LayerfsApi } from '../api.ts'
import type { DoctorT } from '../doctor/locale.ts'
import { useQuery } from '../files/use-query.ts'
import { AddMachineDialog } from '../machines/AddMachineDialog.tsx'
import { Board } from '../machines/Board.tsx'
import { MachinesProvider, useMachinesContext, type MachinesPageProps, type Translate as MachinesT } from '../machines/context.tsx'
import { MachineDetail } from '../machines/MachineDetail.tsx'
import { shortSandbox } from '../machines/model.ts'
import { SandboxDetail } from '../machines/SandboxDetail.tsx'
import { NewSandboxDialog } from '../machines/Sandboxes.tsx'
import { projectDialog } from '../projects/dialog.ts'
import { takeStorageRequest, useStorageRequest } from '../projects/navigation.ts'
import { Loading, Page, Refusal } from '../ui/index.tsx'
import { BackupFilePage, BucketPage, providerWords } from './BucketPage.tsx'
import { StorageDialogs, type StorageDialog } from './dialogs.tsx'
import { HomeOverview } from './HomeOverview.tsx'
import { useHostEvents, useNow, useStorageJobs } from './hooks.ts'
import type { StorageT } from './locale.ts'
import { attachmentsOf, bucketFiles, cardJob, inHome, orderStores } from './model.ts'
import { NavBar, useNavHistory, type AddItem, type Crumb, type JumpItem, type Sibling } from './Nav.tsx'
import { refusalLabels } from './parts.tsx'
import { ProjectPage } from './ProjectPage.tsx'
import type { ProjectMapShare } from './ProjectSandboxes.tsx'
import type { StoreActions } from './StoreCard.tsx'
import { StorePage } from './StorePage.tsx'
import { isTabId, readOverviewTab, writeOverviewTab, type OverviewTab, type TabId } from './tabs.ts'
import type { DoctorReport, ProjectSummary, StorageJob, StorageView, StoreRow } from './types.ts'
import css from './Storage.module.css'

const POLL_MS = 15_000

/** The props the DSH `main` slot renderer gives the Storage page: Storage's `t`, and the Machines controller's face with its `t`. */
export interface StorageMainProps extends Omit<MachinesPageProps, 't'> {
  t: StorageT
  /** The Machines namespace's `t`, for machine and Sandbox pages. */
  tm: MachinesT
  /** What a project's Sandboxes map needs of the conversation views. */
  map: ProjectMapShare
}

export function StoragePage(props: StorageMainProps): ReactNode {
  const { t, tm, api, doctorT, map, ...rest } = props
  // Machine pages open their links here; the ref reaches the page's latest `open`.
  const openRef = useRef<(id: TabId) => void>(() => {})
  const machines = useMemo<MachinesPageProps>(() => ({
    ...rest, api, doctorT, t: tm, openTab: (id: string) => { if (isTabId(id)) openRef.current(id) },
  }), [props])
  return (
    <MachinesProvider props={machines}>
      <StorageIde api={api} doctorT={doctorT} t={t} openRef={openRef} map={map} />
    </MachinesProvider>
  )
}

function StorageIde({ api, doctorT, t, openRef, map }: { api: LayerfsApi, doctorT: DoctorT, t: StorageT, openRef: { current: (id: TabId) => void }, map: ProjectMapShare }): ReactNode {
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
  const [listing, setListing] = useState<string | null>(null)
  const [listingAll, setListingAll] = useState(false)
  const [newMachine, setNewMachine] = useState(false)
  const [newSandbox, setNewSandbox] = useState<string | null>(null)

  // One page at a time: Back and Forward over the pages visited, and the Overview's section.
  const history = useNavHistory('overview')
  const active = history.current
  const [section, setSectionState] = useState<OverviewTab>(readOverviewTab)
  const setSection = (next: OverviewTab) => { setSectionState(next); writeOverviewTab(next) }

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

  const open = history.open
  openRef.current = open
  // A link from another page asked for a page: open it once.
  const request = useStorageRequest(api)
  useEffect(() => {
    if (request === null) return
    // `machines:new`: the machines board with Add machine open (the Setup card's New machine…).
    if (request === 'machines:new') { open('machines'); setNewMachine(true) }
    else if (isTabId(request)) open(request)
    takeStorageRequest(api)
  }, [request])
  // A page that went away (a removed Store, bucket or project) leaves the history; the one before it shows.
  const close = (id: TabId) => history.forget((x) => x === id)
  const closeStore = (name: string) => history.forget((id) => id === `store:${name}` || id.startsWith(`project:${name}/`))

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
  const openMachine = (name: string) => open(`machine:${name}`)
  const storeNamed = (name: string) => view?.stores.find((x) => x.name === name)
  const actionsFor = (s: StoreRow): StoreActions => ({
    push: () => setDialog({ kind: 'push', store: s }),
    pull: () => act(() => api.call('POST', `/api/stores/${enc(s.name)}/pull`)),
    move: () => setDialog({ kind: 'move', store: s }),
    // With no bucket yet there is nowhere to back up to: add one first.
    backup: () => setDialog(view && view.buckets.length === 0 ? { kind: 'bucket' } : { kind: 'backup', store: s }),
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

  // ---------- what the bar shows: crumbs, Jump to, Add ----------

  const machineWord = (name: string) => (name === 'native' ? t('groupHome') : name)
  /** Every machine once: the home, Docker, then created machines by name. */
  const places = useMemo(() => {
    const byName = new Map<string, string>()
    for (const m of view?.machines ?? []) byName.set(m.name, m.platform)
    for (const m of fleet?.machines ?? []) byName.set(m.name, m.platform)
    const rank = (name: string, platform: string) => (name === 'native' || platform === 'native' ? 0 : platform === 'docker' ? 1 : 2)
    return [...byName].map(([name, platform]) => ({ name, platform }))
      .sort((a, b) => rank(a.name, a.platform) - rank(b.name, b.platform) || a.name.localeCompare(b.name))
  }, [view?.machines, fleet?.machines])
  const kindWord = (s: StoreRow) => (s.kind === 'postgresql' ? 'PostgreSQL' : 'SQLite')
  /** Where a Store lives: its machine (SQLite), or the machines it is attached to (PostgreSQL). */
  const storeWhere = (s: StoreRow): string => s.kind === 'postgresql'
    ? t('jumpAttached', { machines: attachmentsOf(s).map((a) => machineWord(a.machine)).join(', ') })
    : machineWord(inHome(s) ? 'native' : s.machine ?? '')
  const stores = orderStores(view?.stores ?? [])
  const sandboxes = fleet?.sandboxes ?? []

  const root: Crumb = { key: 'root', label: t('title'), go: () => open('overview') }
  const sectionCrumb = (key: OverviewTab, label: string): Crumb => ({ key: `section:${key}`, label, go: () => { setSection(key); open('overview') } })
  const machineSiblings: Sibling[] = places.map((p) => ({ id: `machine:${p.name}`, label: machineWord(p.name), meta: mc.kind(p.platform) }))
  const storeSiblings: Sibling[] = stores.map((s) => ({ id: `store:${s.name}`, label: s.name, meta: `${kindWord(s)} · ${storeWhere(s)}`, group: s.kind }))
  const bucketSiblings: Sibling[] = (view?.buckets ?? []).map((b) => ({ id: `bucket:${b.name}`, label: b.name, meta: providerWords(b.provider, t) }))
  const crumbsOf = (id: TabId): Crumb[] => {
    if (id === 'overview') return [{ key: 'root', label: t('title') }]
    if (id === 'machines') return [root, sectionCrumb('machines', t('ovMachines')), { key: 'board', label: t('machinesBoard') }]
    const body = id.slice(id.indexOf(':') + 1)
    const machineCrumb = (name: string, here: boolean): Crumb => ({
      key: `machine:${name}`, label: machineWord(name), id: `machine:${name}`, siblings: machineSiblings, ...(here ? {} : { go: () => openMachine(name) }),
    })
    if (id.startsWith('machine:')) return [root, sectionCrumb('machines', t('ovMachines')), machineCrumb(body, true)]
    if (id.startsWith('sandbox:')) {
      const machine = body.slice(0, body.indexOf('/'))
      const name = body.slice(body.indexOf('/') + 1)
      const beside: Sibling[] = sandboxes.filter((b) => (b.machine ?? '') === machine)
        .map((b) => ({ id: `sandbox:${machine}/${b.name}`, label: shortSandbox(b.name), meta: b.project ? t('jumpBound', { project: b.project }) : undefined }))
      return [root, sectionCrumb('machines', t('ovMachines')), machineCrumb(machine, false), { key: id, label: shortSandbox(name), id, siblings: beside }]
    }
    if (id.startsWith('store:') || id.startsWith('project:')) {
      const storeName = id.startsWith('project:') ? body.slice(0, body.indexOf('/')) : body
      const storeCrumb: Crumb = { key: `store:${storeName}`, label: storeName, id: `store:${storeName}`, siblings: storeSiblings }
      if (id.startsWith('store:')) return [root, sectionCrumb('stores', t('ovStores')), storeCrumb]
      const project = body.slice(body.indexOf('/') + 1)
      const beside: Sibling[] = (storeNamed(storeName)?.projects ?? []).map((p) => ({ id: `project:${storeName}/${p}`, label: p }))
      return [root, sectionCrumb('stores', t('ovStores')), { ...storeCrumb, go: () => open(`store:${storeName}`) }, { key: id, label: project, id, siblings: beside }]
    }
    const bucket = id.startsWith('backup:') ? body.slice(0, body.indexOf('/')) : body
    const bucketCrumb: Crumb = { key: `bucket:${bucket}`, label: bucket, id: `bucket:${bucket}`, siblings: bucketSiblings }
    if (id.startsWith('bucket:')) return [root, sectionCrumb('backups', t('ovBackups')), bucketCrumb]
    const file = body.slice(body.indexOf('/') + 1)
    const b = view?.buckets.find((x) => x.name === bucket)
    const files = b ? [...new Set(bucketFiles(b, view?.stores ?? []).map((r) => r.file))] : []
    const beside: Sibling[] = files.map((f) => ({ id: `backup:${bucket}/${f}`, label: f }))
    return [root, sectionCrumb('backups', t('ovBackups')), { ...bucketCrumb, go: () => open(`bucket:${bucket}`) }, { key: id, label: file, id, siblings: beside }]
  }

  const jump: JumpItem[] = [
    ...stores.flatMap((s) => s.projects.map((p) => ({ id: `project:${s.name}/${p}` as TabId, group: t('jumpProjects'), label: p, where: `${s.name} · ${storeWhere(s)}` }))),
    ...stores.map((s) => ({ id: `store:${s.name}` as TabId, group: t('jumpStores'), label: s.name, where: `${kindWord(s)} · ${storeWhere(s)}` })),
    ...places.map((p) => ({ id: `machine:${p.name}` as TabId, group: t('jumpMachines'), label: machineWord(p.name), where: mc.kind(p.platform) })),
    ...sandboxes.map((b) => ({
      id: `sandbox:${b.machine ?? ''}/${b.name}` as TabId, group: t('jumpSandboxes'), label: b.name,
      where: [machineWord(b.machine ?? ''), b.project ? t('jumpBound', { project: b.project }) : null].filter(Boolean).join(' · '),
    })),
    ...(view?.buckets ?? []).map((b) => ({ id: `bucket:${b.name}` as TabId, group: t('jumpBuckets'), label: b.name, where: providerWords(b.provider, t) })),
  ]

  const canCreate = !!fleet && fleet.platforms.some((x) => x.how === 'created')
  const add: AddItem[] = [
    { id: 'project', label: t('newProject'), run: () => projectDialog.open({ mode: 'new' }) },
    { id: 'store', label: t('newStore'), run: () => setDialog({ kind: 'new-store' }) },
    { id: 'database', label: t('connectDatabaseRow'), run: () => setDialog({ kind: 'new-store', postgresql: true }) },
    ...(canCreate ? [{ id: 'machine', label: t('newMachine'), run: () => setNewMachine(true) }] : []),
    { id: 'bucket', label: t('addBucket'), run: () => setDialog({ kind: 'bucket' }) },
  ]

  const sandboxMachine = newSandbox !== null ? fleet?.machines.find((m) => m.name === newSandbox) : undefined
  const dialogs = (
    <>
      <StorageDialogs api={api} t={t} dialog={dialog} view={view} onClose={() => setDialog(null)} done={refresh} onOpenStore={(name) => open(`store:${name}`)} onDialog={setDialog} />
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

  const pageOf = (id: TabId): ReactNode => {
    if (id === 'machines') return <Board go={mc.go} />
    if (id.startsWith('machine:')) return <MachineDetail key={id} name={id.slice(8)} go={mc.go} onAddStore={(machine) => setDialog({ kind: 'to-machine', machine })} />
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
            onAddStore={(machine) => setDialog({ kind: 'to-machine', machine })} onNewSandbox={setNewSandbox}
            onRemoveProject={(store, project) => setDialog({
              kind: 'confirm', title: t('removeProjectTitle', { name: project }), body: t('removeProjectBody'), action: t('deleteAction'), name: project,
              run: () => api.call('DELETE', `/api/projects/${enc(`${store}/${project}`)}`).then(() => { refresh(); close(`project:${store}/${project}`) }),
            })}
            onRetry={(j) => { dismiss(j.id); act(() => retry(j)) }} onDismiss={(j) => dismiss(j.id)}
            onBackup={(name) => { const s = storeNamed(name); if (s) setDialog({ kind: 'backup', store: s }) }}
            onRecheck={(name, a) => { const s = storeNamed(name); if (s) actionsFor(s).recheck(a) }}
            actionsFor={actionsFor} onAddBucket={() => setDialog({ kind: 'bucket' })} onListBucket={listBucket} onRestore={(bucket, file) => setDialog({ kind: 'restore', bucket, file, store: null })} refreshKey={checks}
            tab={section} onTab={setSection} onListAll={listAll} listingAll={listingAll} />
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
          <ProjectPage api={api} t={t} map={map} project={key} onDialog={setDialog} onOpenStore={(store) => open(`store:${store}`)}
            onRemoved={() => { refresh(); open(`store:${store}`); close(id) }} />
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

  return (
    <div className={css.shell}>
      <NavBar t={t} history={history} crumbs={crumbsOf(active)} jump={jump} jobs={jobs} refreshing={manual || storage.loading}
        onRefresh={() => { setManual(true); refresh() }} add={add} onOpen={open} />
      {refusal}
      <div className={css.panels}>
        <div key={active} className={css.tabBody} data-storage-page={active}>{pageOf(active)}</div>
      </div>
      {dialogs}
    </div>
  )
}
