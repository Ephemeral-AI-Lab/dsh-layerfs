/**
 * The Storage page's Overview tab: this LayerFS home at a glance, the global
 * center panel. Top to bottom: the head (the pinned runtime and the home
 * checks, each opening its detail, and one line of counts), what needs you
 * (only when something is wrong, each with its fix), then three card sections
 * (`HomeCards.tsx`): the projects in their Stores with each Store's backup,
 * the machines with the Stores on them, and the backup buckets. Every name
 * opens its editor tab.
 *
 * It reads `GET /api/storage` and the doctor (passed in), and the machines,
 * Sandboxes and runtime through the Machines controller. Nothing here starts
 * anything until a button is pressed. What the host does not serve (free disk
 * on the home, PostgreSQL sizes, Workspace counts a Sandbox list omits) shows
 * as not reported. A PostgreSQL Store's size is LayerFS's own measure of it
 * (`store.stats`: stored pack bodies plus metadata), read once per Store when
 * the tab opens and again on Refresh, since `GET /api/storage` sizes only
 * SQLite files.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, IconPlusOutlineRegular, IconRefreshOutlineRegular, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { enc, type LayerfsApi } from '../api.ts'
import { ago, bytes } from '../files/format.ts'
import type { Translate } from '../files/types.ts'
import type { Query } from '../files/use-query.ts'
import { useMachinesContext } from '../machines/context.tsx'
import { downReason, machineOrder, machineState, workerDown, type AvailableView } from '../machines/model.ts'
import { RuntimeCard } from '../machines/Runtime.tsx'
import { EmptyState } from '../files/States.tsx'
import { Card, LoadError, Loading, Refusal } from '../ui/index.tsx'
import { DoctorFindings } from './Doctor.tsx'
import { isOverviewTab, type OverviewTab, type TabId } from './tabs.ts'
import { BucketCards, MachineCards, ProjectCards, ProtectionList, StoreCards } from './HomeCards.tsx'
import { LayerfsGlyph } from '../overview/glyph.tsx'
import { projectDialog } from '../projects/dialog.ts'
import { HomeHero, panelId } from './HomeHero.tsx'
import type { StoreActions } from './StoreCard.tsx'
import type { StorageT } from './locale.ts'
import { attachmentsOf, bucketFiles, doingWords, endedWords, orderStores, shareOf } from './model.ts'
import { BucketGlyph, refusalLabels, StoreGlyph } from './parts.tsx'
import type { DoctorReport, PgAttachment, StorageJob, StorageView, StoreRow } from './types.ts'
import css from './HomeOverview.module.css'

export interface HomeOverviewProps {
  view: StorageView | undefined
  error: unknown
  t: StorageT
  now: number
  doctor: Query<DoctorReport>
  jobs: readonly StorageJob[]
  dismissed: ReadonlySet<string>
  onOpen: (id: TabId) => void
  onRefresh: () => void
  onCheckAgain: () => void
  onNewStore: () => void
  onNewMachine: () => void
  /** A machine's Add Store dialog. */
  onAddStore: (machine: string) => void
  /** New Sandbox on a machine. */
  onNewSandbox: (machine: string) => void
  /** Delete a project, through the page's confirm dialog. */
  onRemoveProject: (store: string, project: string) => void
  onRetry: (job: StorageJob) => void
  onDismiss: (job: StorageJob) => void
  onBackup: (store: string) => void
  onRecheck: (store: string, attachment: PgAttachment) => void
  /** A Store's actions (the Store menu, Back up, Attach), through the page's dialogs. */
  actionsFor: (store: StoreRow) => StoreActions
  onAddBucket: () => void
  /** Lists a bucket's files. */
  onListBucket: (bucket: string) => void
  /** Restores a bucket file not from this home as a new Store. */
  onRestore: (bucket: string, file: string) => void
  /** Bumps on Refresh and Check again: PostgreSQL sizes are read again. */
  refreshKey: number
  /** The section showing (the page owns it, so the breadcrumb can open one). */
  tab: OverviewTab
  onTab: (tab: OverviewTab) => void
  /** Lists every bucket's files. */
  onListAll: () => void
  /** Every bucket is being listed. */
  listingAll: boolean
}

/** A PostgreSQL Store's size as LayerFS measures it, or why it could not. */
type PgSize = { bytes: number | null } | { error: string }

/** `store.stats` for each PostgreSQL Store (`GET /api/stores/<name>/stats`): stored pack bodies plus metadata. */
function usePgSizes(api: LayerfsApi, names: readonly string[], refreshKey: number): ReadonlyMap<string, PgSize> {
  const [sizes, setSizes] = useState<ReadonlyMap<string, PgSize>>(new Map())
  const key = names.join('\n')
  useEffect(() => {
    let gone = false
    for (const name of names) {
      api.call<{ stored?: number | null, metadata?: number | null }>('GET', `/api/stores/${enc(name)}/stats`).then(
        (st) => {
          const n = (st?.stored ?? null) === null && (st?.metadata ?? null) === null ? null : (st.stored ?? 0) + (st.metadata ?? 0)
          if (!gone) setSizes((had) => new Map(had).set(name, { bytes: n }))
        },
        (e: unknown) => { if (!gone) setSizes((had) => new Map(had).set(name, { error: e instanceof Error ? e.message : String(e) })) },
      )
    }
    return () => { gone = true }
  }, [api, key, refreshKey])
  return sizes
}

/** One thing that needs you: how bad, what, why, and the one verb that fixes it. */
interface Need {
  key: string
  tone: 'danger' | 'warning' | 'neutral'
  rank: number
  title: ReactNode
  detail?: ReactNode
  action?: { label: string, run: () => void | Promise<unknown> } | undefined
  /** A second, quieter action (e.g. Stop beside Restart worker); runs and refuses like `action`. */
  secondary?: { label: string, title?: string, run: () => void | Promise<unknown> } | undefined
  extra?: ReactNode
}


export function HomeOverview(props: HomeOverviewProps): ReactNode {
  const { view, error, t, now, doctor, onRefresh } = props
  const mc = useMachinesContext()
  const fleetRead = mc.useMachines((s) => s)
  const runtime = mc.useRuntime((s) => s)
  const startups = mc.useStartups((s) => s)
  const fleet: AvailableView | null = fleetRead.data?.available ? fleetRead.data : null
  const [doctorOpen, setDoctorOpen] = useState(false)
  const [runtimeOpen, setRuntimeOpen] = useState(false)
  const tab = props.tab
  const setTab = (key: string) => { if (isOverviewTab(key)) props.onTab(key) }
  const pgNames = (view?.stores ?? []).filter((s) => s.kind === 'postgresql').map((s) => s.name).sort()
  const pgSizes = usePgSizes(mc.api, pgNames, props.refreshKey)
  const needsRef = useRef<HTMLDivElement>(null)

  if (!view) {
    return (
      <div className={css.page}>
        {error
          ? <LoadError title={t('storageFailed')} error={error} labels={refusalLabels(t)} retryLabel={t('retry')} onRetry={onRefresh} />
          : <Loading label={t('readingStores')} />}
      </div>
    )
  }

  const place = (machine: string | null | undefined) => (machine === 'native' ? t('groupHome') : machine ?? '?')
  const stores = orderStores(view.stores)
  const sqlite = stores.filter((s) => s.kind === 'sqlite')
  const pg = stores.filter((s) => s.kind === 'postgresql')
  const projectCount = stores.reduce((n, s) => n + s.projects.length, 0)
  const pgBytesOf = (name: string): number | null => { const z = pgSizes.get(name); return z && 'bytes' in z ? z.bytes : null }
  const machines = fleet ? machineOrder(fleet.machines) : []
  const running = machines.filter((m) => machineState(m, fleet?.status[m.name]).key === 'running')
  const runningJobs = props.jobs.filter((j) => !j.ended)

  // ---------- what needs you, most pressing first ----------
  const needs: Need[] = []
  for (const j of props.jobs) {
    if (!j.ended || props.dismissed.has(j.id)) continue
    if (!j.error && j.outcome !== 'failed' && j.outcome !== 'interrupted' && j.outcome !== 'unknown') continue
    needs.push({
      key: `job:${j.id}`, tone: 'danger', rank: 0,
      title: <StoreLink name={j.store} onOpen={props.onOpen}>{endedWords(j, t)}</StoreLink>,
      detail: j.error ? <>{j.error.message} · {ago(j.ended, now, t as Translate)}</> : ago(j.ended, now, t as Translate),
      action: { label: t('jobRetry'), run: () => props.onRetry(j) },
      extra: <Button variant="ghost" size="sm" onClick={() => props.onDismiss(j)}>{t('dismiss')}</Button>,
    })
  }
  // Machines whose worker does not answer: one need each, with the fix, standing in for their Stores' "down".
  const unreachable = new Set(machines.filter((m) => workerDown(m, fleet?.status[m.name])).map((m) => m.name))
  for (const m of machines) {
    const look = machineState(m, fleet?.status[m.name])
    if (unreachable.has(m.name)) {
      needs.push({
        key: `unreachable:${m.name}`, tone: 'danger', rank: 1,
        title: <Link onClick={() => props.onOpen(`machine:${m.name}`)}>{m.stores.length
          ? t('ovWorkerDownStores', { machine: place(m.name), stores: m.stores.join(', ') })
          : t('ovWorkerDown', { machine: place(m.name) })}</Link>,
        detail: downReason(m, fleet?.status[m.name]) ?? undefined,
        action: { label: t('ovRestartWorker'), run: () => mc.act({ kind: 'start', name: m.name, platform: m.platform }) },
        secondary: { label: t('ovStopUnreachable'), title: t('ovStopUnreachableTitle', { machine: place(m.name) }), run: () => mc.act({ kind: 'stop', name: m.name }) },
      })
    } else if (look.key === 'needs') {
      needs.push({
        key: `needs:${m.name}`, tone: 'danger', rank: 1,
        title: <Link onClick={() => props.onOpen(`machine:${m.name}`)}>{t('ovMachineNeeds', { machine: place(m.name) })}</Link>,
        detail: downReason(m, fleet?.status[m.name]) ?? mc.stateWord(look),
        action: { label: t('ovOpen'), run: () => props.onOpen(`machine:${m.name}`) },
      })
    } else if (look.key === 'stopped' && m.stores.length > 0 && startups[m.name]?.status !== 'running') {
      needs.push({
        key: `stopped:${m.name}`, tone: 'warning', rank: 3,
        title: <Link onClick={() => props.onOpen(`machine:${m.name}`)}>{t('ovMachineStoppedStores', { machine: place(m.name), stores: m.stores.join(', ') })}</Link>,
        detail: t('ovMachineStoppedBody'),
        action: { label: t('ovStart'), run: () => mc.act({ kind: 'start', name: m.name, platform: m.platform }) },
      })
    }
  }
  for (const s of stores) {
    for (const a of attachmentsOf(s)) {
      if (!a.lastError) continue
      needs.push({
        key: `attach:${s.name}:${a.machine}`, tone: 'danger', rank: 2,
        title: <Link onClick={() => props.onOpen(`store:${s.name}`)}>{t('ovAttachBroken', { store: s.name, machine: place(a.machine) })}</Link>,
        detail: a.lastError.message,
        action: { label: t('ovRecheck'), run: () => props.onRecheck(s.name, a) },
      })
    }
    if (s.kind === 'postgresql' && s.postgresql?.reachable === false) {
      needs.push({
        key: `pg:${s.name}`, tone: 'danger', rank: 2,
        title: <Link onClick={() => props.onOpen(`store:${s.name}`)}>{t('ovPgUnreachable', { store: s.name })}</Link>,
        detail: s.postgresql.error ?? s.postgresql.target ?? undefined,
        action: { label: t('ovOpen'), run: () => props.onOpen(`store:${s.name}`) },
      })
    }
    if (s.kind === 'sqlite' && s.state === 'down' && !unreachable.has(s.machine ?? '')) {
      needs.push({
        key: `down:${s.name}`, tone: 'danger', rank: 2,
        title: <Link onClick={() => props.onOpen(`store:${s.name}`)}>{t('ovStoreDown', { store: s.name })}</Link>,
        detail: s.down ?? undefined,
        action: { label: t('ovOpen'), run: () => props.onOpen(`store:${s.name}`) },
      })
    }
  }
  // The doctor's findings are one need: they are listed in full by the
  // doctor card (the hero's Doctor pill), so the list only says how many.
  const findings = doctor.data?.findings ?? []
  if (findings.length) {
    const errors = findings.filter((f) => f.severity === 'error').length
    const warnings = findings.length - errors
    const kinds = [...new Set(findings.map((f) => f.entity?.kind).filter((k): k is string => !!k))]
    needs.push({
      key: 'doctor', tone: errors ? 'danger' : 'warning', rank: errors ? 2 : 4,
      title: errors
        ? (errors === 1 ? t('ovDoctorNeedError') : t('ovDoctorNeedErrors', { n: errors }))
        : (warnings === 1 ? t('ovDoctorNeedWarning') : t('ovDoctorNeedWarnings', { n: warnings })),
      detail: kinds.length ? t('ovDoctorNeedAbout', { kinds: kinds.join(', ') }) : undefined,
      action: { label: doctorOpen ? t('ovDoctorHide') : t('ovDoctorShow'), run: () => setDoctorOpen((o) => !o) },
    })
  }
  // A Store never backed up is not a problem: its card says so quietly.
  needs.sort((a, b) => a.rank - b.rank)

  // ---------- head ----------
  const rt = runtime.data
  const runtimeWords = !rt ? t('ovRuntimeChecking') : rt.ok && rt.version ? t('ovRuntimeReady', { version: rt.version }) : t('ovRuntimeDown')
  const runtimeTone = !rt ? undefined : rt.ok ? 'success' : 'danger'
  const urgent = needs.filter((n) => n.tone === 'danger').length
  // Backups are optional: a Store without one is not a problem, so it never colors the headline or a tab.
  const headline = urgent ? (urgent === 1 ? t('ovHealthOneNeed') : t('ovHealthNeeds', { n: urgent }))
    : needs.length ? (needs.length === 1 ? t('ovHealthOneNeed') : t('ovHealthNeeds', { n: needs.length }))
      : t('ovHealthAllGood')
  const headTone = urgent ? 'danger' : needs.length ? 'warning' : 'success'
  // A tab's dot: the worst state among what it shows.
  const storeTrouble = stores.some((x) => x.state === 'down' || x.state === 'unresolved' || x.postgresql?.reachable === false || attachmentsOf(x).some((a) => a.lastError))
  const storeTone = storeTrouble ? 'danger' : undefined
  const machineTone = machines.some((m) => machineState(m, fleet?.status[m.name]).key === 'needs') ? 'danger'
    : machines.some((m) => machineState(m, fleet?.status[m.name]).key === 'stopped' && m.stores.length > 0) ? 'warning' : undefined
  const refreshAll = () => { onRefresh(); props.onCheckAgain() }
  const newProject = () => projectDialog.open({ mode: 'new' })
  /** The headline's count jumps to the list it counts. */
  const toNeeds = () => {
    const el = needsRef.current
    if (!el) return
    el.scrollIntoView({ block: 'nearest' })
    el.focus({ preventScroll: true })
  }

  return (
    <div className={css.page}>
      <HomeHero
        eyebrow={(
          <>
            <span className={css.eyebrowName} title={[rt?.home, rt?.preparedImages != null ? t('ovPreparedImages', { n: rt.preparedImages }) : null].filter(Boolean).join(' · ')}>{t('ovTitle')}</span>
            <button type="button" className={css.pill} data-tone={runtimeTone} aria-expanded={runtimeOpen} title={t('ovRuntimeToggle')}
              onClick={() => setRuntimeOpen((o) => !o)}>
              {rt ? <StateDot state={rt.ok ? 'done' : 'error'} size={8} /> : <StateDot state="ongoing" size={11} />}
              <span>{runtimeWords}</span>
              {rt?.commit ? <span className={css.mono}>{rt.commit.slice(0, 8)}</span> : null}
            </button>
          </>
        )}
        headline={headline}
        onHeadline={needs.length ? toNeeds : undefined}
        tone={headTone}
        sub={[
          t('ovSumProjects', {
            projects: projectCount === 1 ? t('ovProjectCount') : t('ovProjectsCount', { n: projectCount }),
            stores: stores.length === 1 ? t('ovStoreCount') : t('ovStoresCount', { n: stores.length }),
          }),
          fleet ? t('ovSumMachines', { running: running.length, total: machines.length }) : null,
        ].filter(Boolean).join(' · ')}
        actions={(
          <>
            <Button variant="outline" size="sm" icon={<IconRefreshOutlineRegular size={13} />} disabled={doctor.loading} onClick={refreshAll}
              title={t('ovRefreshTitle')}>{t('refresh')}</Button>
          </>
        )}
        banner={(
          <>
            {runtimeOpen ? <RuntimeCard /> : null}
            {doctorOpen ? <DoctorFindings read={doctor} t={t} now={now} /> : null}
            {needs.length ? (
              <Card>
                <div ref={needsRef} id="ov-needs" className={css.needs} role="region" aria-label={t('ovNeedsYou')} tabIndex={-1}>
                  {needs.map((n) => <NeedRow key={n.key} need={n} labels={refusalLabels(t)} />)}
                </div>
              </Card>
            ) : null}
          </>
        )}
        tabs={[
          { key: 'projects', label: t('ovProjects'), count: projectCount, tone: storeTrouble ? 'danger' : undefined },
          { key: 'stores', label: t('ovStores'), count: stores.length, tone: storeTone },
          { key: 'machines', label: t('ovMachines'), count: fleet ? `${running.length}/${machines.length}` : '—', tone: machineTone },
          { key: 'backups', label: t('ovBackups'), count: view.buckets.length },
        ]}
        active={tab} onSelect={setTab} tabsLabel={t('ovTabs')} />

      {/* ---------- 1. projects, each with its Store and machines ---------- */}
      {tab === 'projects' ? (
        <section id={panelId('projects')} role="tabpanel" className={css.section} aria-label={t('ovProjects')}>
          {projectCount > 0 ? (
            <SectionHead
              actions={<Button variant="outline" size="sm" icon={<IconPlusOutlineRegular size={12} />} onClick={newProject}>{t('newProject')}</Button>} />
          ) : null}
          {projectCount === 0 ? (
            <Card>
              <EmptyState title={t('ovNoProjects')} icon={<LayerfsGlyph size={20} />}
                action={<Button variant="primary" size="sm" icon={<IconPlusOutlineRegular size={13} />} onClick={newProject}>{t('newProject')}</Button>}>
                {t('ovNoProjectsBody')}
              </EmptyState>
            </Card>
          ) : (
            <ProjectCards stores={stores} view={view} fleet={fleet} machines={machines} t={t} jobs={runningJobs} place={place} onOpen={props.onOpen} onRemove={props.onRemoveProject}
              onRestart={(m) => mc.act({ kind: 'start', name: m.name, platform: m.platform })} />
          )}
        </section>
      ) : null}

      {/* ---------- 2. Stores, each with its projects ---------- */}
      {tab === 'stores' ? (
        <section id={panelId('stores')} role="tabpanel" className={css.section} aria-label={t('ovStores')}>
          {stores.length > 0 ? (
            <SectionHead
              actions={<Button variant="outline" size="sm" icon={<IconPlusOutlineRegular size={12} />} onClick={props.onNewStore}>{t('newStore')}</Button>} />
          ) : null}
          {stores.length === 0 ? (
            <Card>
              <EmptyState title={t('noStores')} icon={<StoreGlyph kind="sqlite" size={20} />}
                action={<Button variant="primary" size="sm" icon={<IconPlusOutlineRegular size={13} />} onClick={props.onNewStore}>{t('newStore')}</Button>}>
                {t('noStoresBody')}
              </EmptyState>
            </Card>
          ) : (
            <StoreCards stores={stores} view={view} fleet={fleet} machines={machines} t={t} now={now} jobs={runningJobs} place={place} pgSize={pgBytesOf}
              onOpen={props.onOpen} actionsFor={props.actionsFor} onAddBucket={props.onAddBucket} />
          )}
        </section>
      ) : null}

      {/* ---------- 3. machines, with their Stores ---------- */}
      {tab === 'machines' ? (
        <section id={panelId('machines')} role="tabpanel" className={css.section} aria-label={t('ovMachines')}>
          <SectionHead
            actions={(
              <>
                <Button variant="outline" size="sm" onClick={() => props.onOpen('machines')}>{t('ovOpenBoard')}</Button>
                {fleet?.platforms.some((p) => p.how === 'created') ? <Button variant="outline" size="sm" icon={<IconPlusOutlineRegular size={12} />} onClick={props.onNewMachine}>{t('newMachine')}</Button> : null}
              </>
            )} />
          {fleet
            ? <MachineCards machines={machines} fleet={fleet} stores={stores} t={t} jobs={runningJobs} place={place} pgSize={pgBytesOf} onOpen={props.onOpen} onAddStore={props.onAddStore} onNewSandbox={props.onNewSandbox} />
            : <Loading label={t('readingMachines')} />}
        </section>
      ) : null}

      {/* ---------- 4. backups ---------- */}
      {tab === 'backups' ? (
        <section id={panelId('backups')} role="tabpanel" className={css.section} aria-label={t('ovBackups')}>
          <SectionHead
            actions={(
              <>
                {view.buckets.length > 0 ? <Button variant="outline" size="sm" disabled={props.listingAll} onClick={props.onListAll}>{t('ovListBuckets')}</Button> : null}
                <Button variant="outline" size="sm" icon={<IconPlusOutlineRegular size={12} />} onClick={props.onAddBucket}>{t('ovAddBucket')}</Button>
              </>
            )} />
          <ProtectionList stores={stores} view={view} t={t} now={now} jobs={runningJobs} onOpen={props.onOpen} actionsFor={props.actionsFor} onAddBucket={props.onAddBucket} />
          <BucketCards view={view} t={t} now={now} jobs={runningJobs} onOpen={props.onOpen} onAddBucket={props.onAddBucket} onList={props.onListBucket} onRestore={props.onRestore} />
        </section>
      ) : null}
    </div>
  )
}

/** One thing that needs you: its tone, what and why, and the verb that fixes it. Only a danger row is announced. */
function NeedRow({ need: n, labels }: { need: Need, labels: ReturnType<typeof refusalLabels> }): ReactNode {
  // one action at a time; a refusal stays on the row until the next try
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const go = (run: () => void | Promise<unknown>) => {
    setBusy(true); setError(null)
    void Promise.resolve().then(run).catch(setError).finally(() => setBusy(false))
  }
  return (
    <div className={css.need} role={n.tone === 'danger' ? 'alert' : undefined}>
      <StateDot state={n.tone === 'danger' ? 'error' : n.tone === 'warning' ? 'warning' : 'idle'} size={8} className={css.needMark} />
      <div className={css.needBody}>
        <p className={css.needTitle}>{n.title}</p>
        {n.detail ? <p className={css.needDetail}>{n.detail}</p> : null}
        {error != null ? <Refusal error={error} labels={labels} className={css.needDetail} /> : null}
      </div>
      {n.action || n.secondary || n.extra ? (
        <span className={css.needActions}>
          {n.action ? <Button variant="outline" size="sm" disabled={busy} onClick={() => go(n.action!.run)}>{n.action.label}</Button> : null}
          {n.secondary ? <Button variant="ghost" size="sm" disabled={busy} title={n.secondary.title} onClick={() => go(n.secondary!.run)}>{n.secondary.label}</Button> : null}
          {n.extra}
        </span>
      ) : null}
    </div>
  )
}

/** A tab's actions as small buttons at the end (the tab itself names the section and its count). */
function SectionHead({ actions }: { actions: ReactNode }): ReactNode {
  return (
    <div className={css.sectionHead}>
      <span className={css.sectionActions}>{actions}</span>
    </div>
  )
}

function Link({ children, onClick }: { children: ReactNode, onClick: () => void }): ReactNode {
  return <button type="button" className={css.link} onClick={(e) => { e.stopPropagation(); onClick() }}>{children}</button>
}

function StoreLink({ name, onOpen, children }: { name: string, onOpen: (id: TabId) => void, children: ReactNode }): ReactNode {
  return <Link onClick={() => onOpen(`store:${name}`)}>{children}</Link>
}
