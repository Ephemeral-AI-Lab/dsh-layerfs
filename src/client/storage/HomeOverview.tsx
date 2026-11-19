/**
 * The Storage page's Overview tab: this LayerFS home at a glance, the global
 * Home page. Top to bottom: the head, one row (the pinned runtime, what needs
 * you most with its fix, the Health and Logs pages and Settings (the Set up LayerFS modal) with Refresh
 * as icon buttons; anything else that needs you is only counted there), then
 * three card sections
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
import { useContext, useEffect, useState, type ReactNode } from 'react'
import { Button, IconAgentPresetOutlineRegular, IconInspectOutlineRegular, IconPlusOutlineRegular, MenuItemButton, IconRefreshOutlineRegular, IconSettingsOutlineRegular, IconShieldOutlineRegular, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { enc, type LayerfsApi } from '../api.ts'
import { ago, bytes } from '../files/format.ts'
import type { Translate } from '../files/types.ts'
import type { Query } from '../files/use-query.ts'
import { useMachinesContext } from '../machines/context.tsx'
import { downReason, machineOrder, machineState, recordOutdated, vmGone, workerDown, type AvailableView } from '../machines/model.ts'
import { machineBlock, stepReasons } from '../machines/needs.ts'
import type { SetupModalT } from '../setup/locale.ts'
import { SetupCard, unset } from '../setup/SetupCard.tsx'
import { missingWords } from '../setup/SetupDialog.tsx'
import { setupDialog, useSetupStatus } from '../setup/store.ts'
import { EmptyState } from '../files/States.tsx'
import { Card, FixContext, LoadError, Loading, MoreMenu, Refusal, resolveFix, usePressGuard } from '../ui/index.tsx'
import { isOverviewTab, type OverviewTab, type TabId } from './tabs.ts'
import { BucketCards } from './BucketCards.tsx'
import { HomeStores } from './MachineStores.tsx'
import { ProjectTable } from './ProjectTable.tsx'
import { ProjectFinderBar, useProjectFinder } from './ProjectFinder.tsx'
import { projectMatches } from './project-list.ts'
import { Board } from '../machines/Board.tsx'
import { useStartDoctor } from '../doctor/Doctor.tsx'
import { LayerfsGlyph } from '../overview/glyph.tsx'
import { projectDialog } from '../projects/dialog.ts'
import { LogsPanelIcon } from '../logs/index.tsx'
import { BrandLockup, HomeHero, panelId } from './HomeHero.tsx'
import { StoreMenu, type LoginActions, type StoreActions } from './StoreCard.tsx'
import { Signal } from './Signal.tsx'
import type { StorageT } from './locale.ts'
import { brokenWords, bucketFiles, doingWords, endedWords, failureSuperseded, holderTab, jobEnd, needsLogin, orderStores, pgStoreBytes, shareOf, type Reconnect } from './model.ts'
import { refusalLabels, StoreGlyph } from './parts.tsx'
import type { StoreStats } from './store-page.ts'
import type { StorageJob, StorageView, StoreRow } from './types.ts'
import type { DoctorCount } from '../../shared/doctor.ts'
import css from './HomeOverview.module.css'
import heroCss from './HomeHero.module.css'

export interface HomeOverviewProps {
  view: StorageView | undefined
  error: unknown
  t: StorageT
  /** The setup modal's copy (the setup cards Center shows). */
  setup: SetupModalT
  now: number
  doctor: Query<DoctorCount>
  jobs: readonly StorageJob[]
  dismissed: ReadonlySet<string>
  onOpen: (id: TabId) => void
  onRefresh: () => void
  onCheckAgain: () => void
  onNewStore: () => void
  /** Connect a database (a new PostgreSQL Store). */
  onConnect: () => void
  /** Opens a SQLite Store's Backups dialog. */
  onBackups: (store: string) => void
  onNewMachine: () => void
  /** Open the Presets dialog (sample libraries to build into this home). */
  onPresets: () => void
  /** "Try a preset", from the Presets copy. */
  presetsLabel: string
  /** A machine's Add Store dialog (move a SQLite Store there, or connect a PostgreSQL one). */
  onAddStore: (machine: string) => void
  /** Delete a project, through the page's confirm dialog. */
  onRemoveProject: (store: string, project: string) => void
  onRetry: (job: StorageJob) => void
  onDismiss: (job: StorageJob) => void
  onBackup: (store: string) => void
  /** A Store's actions (the Store menu, Back up, Edit connection), through the page's dialogs. */
  actionsFor: (store: StoreRow) => StoreActions
  /** A saved PostgreSQL login's own actions (the PostgreSQL tab's login headers). */
  loginActions: LoginActions
  /** The Sandboxes the Machines view knows: a Connected from chip counts the machine's Sandboxes of the Store. */
  sandboxes?: readonly { machine?: string | null, project?: string | null }[]
  onAddBucket: () => void
  /** Lists a bucket's files. */
  onListBucket: (bucket: string) => void
  /** Connect again… on a bucket whose key was refused. */
  onReconnect: (again: Reconnect) => void
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

/** `store get --with stats` for each PostgreSQL Store (`GET /api/stores/<name>/stats`), measured by pgStoreBytes. */
function usePgSizes(api: LayerfsApi, names: readonly string[], refreshKey: number): ReadonlyMap<string, PgSize> {
  const [sizes, setSizes] = useState<ReadonlyMap<string, PgSize>>(new Map())
  const key = names.join('\n')
  useEffect(() => {
    let gone = false
    for (const name of names) {
      api.call<StoreStats>('GET', `/api/stores/${enc(name)}/stats`).then(
        (st) => { if (!gone) setSizes((had) => new Map(had).set(name, { bytes: pgStoreBytes(st) })) },
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
  secondary?: { label: string, title?: string, run: () => void | Promise<unknown>, confirm?: string } | undefined
  extra?: ReactNode
}


export function HomeOverview(props: HomeOverviewProps): ReactNode {
  const { view, error, t, now, doctor, onRefresh } = props
  const fixes = useContext(FixContext)
  const mc = useMachinesContext()
  const fleetRead = mc.useMachines((s) => s)
  const runtime = mc.useRuntime((s) => s)
  const startups = mc.useStartups((s) => s)
  const fleet: AvailableView | null = fleetRead.data?.available ? fleetRead.data : null
  const setupRead = useSetupStatus(mc.api)
  const setup = setupRead.data
  const startDoctor = useStartDoctor(mc.api)
  const tab = props.tab
  const setTab = (key: string) => { if (isOverviewTab(key)) props.onTab(key) }
  const pgNames = (view?.stores ?? []).filter((s) => s.kind === 'postgresql').map((s) => s.name).sort()
  const pgSizes = usePgSizes(mc.api, pgNames, props.refreshKey)
  const finder = useProjectFinder(view?.stores ?? [], props.refreshKey)

  if (!view) {
    return (
      <div className={css.page}>
        {setup && unset(setup)
          ? <SetupCard s={setup} t={props.setup} first />
          : error
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
  const searching = finder.query.trim() !== ''
  const projectsShown = searching ? stores.reduce((n, s) => n + s.projects.filter((p) => projectMatches(s.name, p, finder.query)).length, 0) : projectCount
  const pgBytesOf = (name: string): number | null => { const z = pgSizes.get(name); return z && 'bytes' in z ? z.bytes : null }
  const machines = fleet ? machineOrder(fleet.machines) : []
  const runningJobs = props.jobs.filter((j) => !j.ended)

  // ---------- what needs you, most pressing first ----------
  const needs: Need[] = []
  for (const j of props.jobs) {
    if (!j.ended || props.dismissed.has(j.id)) continue
    if (!j.error && j.outcome !== 'failed' && j.outcome !== 'interrupted' && j.outcome !== 'unknown') continue
    // a later success on the same Store, or the Store gone, ends the failure's notice (UI pass 3 F11)
    if (failureSuperseded(j, props.jobs, view.stores)) continue
    // the card's word is how the job ended; LayerFS's own words are the tip (UI rule: no raw errors on cards);
    // its fix line, where the page runs it, is the one action, else Retry
    const fix = fixes ? resolveFix(fixes, j.error?.fix)?.fix ?? null : null
    // in use (F10): the tip names what holds the Store (its Sandboxes), the one action opens the first of them
    const { holders: [holder], tip } = jobEnd(j, fleet?.sandboxes ?? [], t, fixes ? (line) => fixes.tip(line) : undefined)
    needs.push({
      key: `job:${j.id}`, tone: 'danger', rank: 0,
      title: <StoreLink name={j.store} onOpen={props.onOpen}>{endedWords(j, t, bytes)}</StoreLink>,
      detail: <span title={tip}>{ago(j.ended, now, t as Translate)}</span>,
      action: fix && fixes ? { label: fixes.label(fix), run: () => fixes.run(fix) }
        : holder ? { label: t('jobOpenSandbox', { name: holder.name }), run: () => props.onOpen(holderTab(holder)) }
          : { label: t('jobRetry'), run: () => props.onRetry(j) },
      extra: <Button variant="ghost" size="sm" onClick={() => props.onDismiss(j)}>{t('dismiss')}</Button>,
    })
  }
  // Machines whose worker does not answer: one need each, with the fix, standing in for their Stores' "down".
  // A machine whose platform is not ready here (Docker quit, Lima removed): its fix, not a worker restart that would fail.
  const blocked = new Map(fleet ? machines.flatMap((m) => { const b = machineBlock(m, fleet); return b ? [[m.name, b] as const] : [] }) : [])
  const unreachable = new Set(machines.filter((m) => !blocked.has(m.name) && workerDown(m, fleet?.live[m.name])).map((m) => m.name))
  for (const m of machines) {
    const look = machineState(m, fleet?.live[m.name])
    const block = blocked.get(m.name)
    if (block) {
      needs.push({
        key: `unavailable:${m.name}`, tone: 'warning', rank: 1,
        title: <Link onClick={() => props.onOpen(`machine:${m.name}`)}>{mc.t('unavailableWhy', { kind: place(m.name), reason: stepReasons(block, mc.tw) })}</Link>,
        detail: m.stores.length ? m.stores.join(', ') : undefined,
        action: { label: t('ovOpen'), run: () => props.onOpen(`machine:${m.name}`) },
      })
    } else if (unreachable.has(m.name)) {
      needs.push({
        key: `unreachable:${m.name}`, tone: 'danger', rank: 1,
        title: <Link onClick={() => props.onOpen(`machine:${m.name}`)}>{m.stores.length
          ? t('ovWorkerDownStores', { machine: place(m.name), stores: m.stores.join(', ') })
          : t('ovWorkerDown', { machine: place(m.name) })}</Link>,
        detail: downReason(m, fleet?.live[m.name]) ?? undefined,
        // the head's one slot changes with what is most pressing: it never starts a machine,
        // it opens that machine's page, where its own Start (or fix) is pressed (UI pass 2 audit);
        // Stop <machine> beside it stays a press that names the machine (RV4 NOTE 14)
        action: { label: t('ovOpen'), run: () => props.onOpen(`machine:${m.name}`) },
        // a power action from the head asks a second press that names the machine (UI pass 3 F6): a stray click never stops it
        secondary: { label: t('ovStopUnreachable', { machine: place(m.name) }), title: t('ovStopUnreachableTitle', { machine: place(m.name) }), confirm: t('ovStopConfirm', { machine: place(m.name) }), run: () => mc.act({ kind: 'stop', name: m.name }) },
      })
    } else if (vmGone(m)) {
      // its VM is gone (LayerFS `missing`, M FAIL 9): not "not answering", no Stop or Restart; LayerFS's fix is the one action
      const fix = fixes ? resolveFix(fixes, m.fix)?.fix ?? null : null
      needs.push({
        key: `gone:${m.name}`, tone: 'danger', rank: 1,
        title: <Link onClick={() => props.onOpen(`machine:${m.name}`)}>{m.stores.length
          ? t('ovVmGoneStores', { machine: place(m.name), stores: m.stores.join(', ') })
          : t('ovVmGone', { machine: place(m.name) })}</Link>,
        detail: <span title={[m.message, m.fix].filter(Boolean).join('\n') || undefined}>{mc.stateWord(look)}</span>,
        action: fix && fixes ? { label: fixes.label(fix), run: () => fixes.run(fix) } : { label: t('ovOpen'), run: () => props.onOpen(`machine:${m.name}`) },
      })
    } else if (recordOutdated(m)) {
      // an outdated record no call repairs (UI pass 3 R FAIL 2): not a worker that does not answer, and no Stop;
      // its fix (remove, after its Stores) runs behind a confirm on the machine's page, so the head opens it
      needs.push({
        key: `record:${m.name}`, tone: 'danger', rank: 1,
        title: <Link onClick={() => props.onOpen(`machine:${m.name}`)}>{m.stores.length
          ? t('ovRecordOutdatedStores', { machine: place(m.name), stores: m.stores.join(', ') })
          : t('ovRecordOutdated', { machine: place(m.name) })}</Link>,
        detail: m.message ?? m.fix ?? undefined,
        action: { label: t('ovOpen'), run: () => props.onOpen(`machine:${m.name}`) },
      })
    } else if (look.key === 'needs') {
      needs.push({
        key: `needs:${m.name}`, tone: 'danger', rank: 1,
        title: <Link onClick={() => props.onOpen(`machine:${m.name}`)}>{t('ovMachineNeeds', { machine: place(m.name) })}</Link>,
        detail: downReason(m, fleet?.live[m.name]) ?? mc.stateWord(look),
        action: { label: t('ovOpen'), run: () => props.onOpen(`machine:${m.name}`) },
      })
    } else if (look.key === 'stopped' && m.stores.length > 0 && startups[m.name]?.status !== 'running') {
      needs.push({
        key: `stopped:${m.name}`, tone: 'warning', rank: 3,
        title: <Link onClick={() => props.onOpen(`machine:${m.name}`)}>{t('ovMachineStoppedStores', { machine: place(m.name), stores: m.stores.join(', ') })}</Link>,
        detail: t('ovMachineStoppedBody'),
        action: { label: t('ovOpen'), run: () => props.onOpen(`machine:${m.name}`) },
      })
    }
  }
  for (const s of stores) {
    // a broken Store (2.0): its word, its fix line as the detail; a machine already listed above is not repeated
    if (s.state === 'broken' && !(s.kind === 'sqlite' && unreachable.has(s.machine ?? ''))) {
      const pgDown = s.kind === 'postgresql' && s.reason === 'unreachable'
      // a PostgreSQL Store that is only outdated or names a missing login is reachable: it needs its update, not "down" (R1 F1);
      // its state word with LayerFS's fix as the tip, and that fix as the one action where the page runs it
      const needsKey = s.kind !== 'postgresql' ? null : needsLogin(s) || s.reason === 'missing' ? 'ovStoreNeedsLogin' : s.reason === 'outdated' ? 'ovStoreNeedsUpdate' : null
      const fix = needsKey && fixes ? resolveFix(fixes, s.fix)?.fix ?? null : null
      needs.push({
        key: `${pgDown ? 'pg' : needsKey ? 'update' : 'down'}:${s.name}`, tone: needsKey ? 'warning' : 'danger', rank: 2,
        title: <Link onClick={() => props.onOpen(`store:${s.name}`)}>{t(pgDown ? 'ovPgUnreachable' : needsKey ?? 'ovStoreDown', { store: s.name })}</Link>,
        detail: needsKey ? <span title={s.fix ?? undefined}>{brokenWords(s, t)}</span> : s.fix ?? (pgDown ? s.postgresql?.target ?? undefined : undefined),
        action: fix && fixes ? { label: fixes.label(fix), run: () => fixes.run(fix) } : { label: t('ovOpen'), run: () => props.onOpen(`store:${s.name}`) },
      })
    }
  }
  // The doctors' open findings are not a row here: the head's Doctor button counts
  // them (red when one is an error) and opens the Doctor page that lists them.
  const findings = doctor.data?.findings ?? []
  const findingErrors = findings.some((f) => f.severity === 'error')
  // Setup still missing something required (after Later): the head's first need, with Set up LayerFS… (one place, no second card).
  const setupLeft = setup && setup.needs.length ? missingWords(setup, props.setup) : null
  if (setupLeft) {
    needs.push({
      key: 'setup', tone: 'warning', rank: -1, title: props.setup('cardFinishTitle'), detail: setupLeft,
      action: { label: props.setup('openSetup'), run: () => setupDialog.open(setup!.needs.includes('folder') && setup!.runtime.ok ? 'folder' : 'runtime') },
    })
  }
  // A Store never backed up is not a problem: its card says so quietly.
  needs.sort((a, b) => a.rank - b.rank)

  // ---------- head ----------
  const rt = runtime.data
  const runtimeWords = !rt ? t('ovRuntimeChecking') : rt.ok && rt.version ? t('ovRuntimeReady', { version: rt.version }) : t('ovRuntimeDown')
  const runtimeTone = !rt ? undefined : rt.ok ? 'success' : 'danger'
  // The head names the most pressing need and carries its fix, and counts the rest (their cards and tabs carry their signals).
  const top = needs[0]
  const rest = needs.slice(1)
  // A tab's dot: the worst state among what it shows.
  const storeTrouble = stores.some((x) => x.state === 'broken')
  const storeTone = storeTrouble ? 'danger' : undefined
  const machineTone = machines.some((m) => !blocked.has(m.name) && machineState(m, fleet?.live[m.name]).key === 'needs') ? 'danger'
    : blocked.size > 0 ? 'warning'
    : machines.some((m) => machineState(m, fleet?.live[m.name]).key === 'stopped' && m.stores.length > 0) ? 'warning' : undefined
  const refreshAll = () => { onRefresh(); props.onCheckAgain() }
  const newProject = () => projectDialog.open({ mode: 'new' })
  // The selected tab's actions, at the right end of the tab bar (an empty tab carries its own call to action instead).
  const plus = <IconPlusOutlineRegular size={12} />
  const tabActions = tab === 'projects' ? (projectCount > 0 ? <Button variant="outline" size="sm" icon={plus} onClick={newProject}>{t('newProject')}</Button> : null)
    : tab === 'machines' ? (
      <>
        {fleet?.platforms.some((p) => p.how === 'created') ? <Button variant="outline" size="sm" icon={plus} onClick={props.onNewMachine}>{t('newMachine')}</Button> : null}
        <MoreMenu label={mc.t('moreMachines')}>
          {(close) => (
            <MenuItemButton icon={<IconInspectOutlineRegular size={14} />} onSelect={() => { close(); void startDoctor('host').catch(() => props.onOpen('health')) }}>{mc.doctorT('diagnoseHost')}</MenuItemButton>
          )}
        </MoreMenu>
      </>
    )
    : null
  // SQLite's second view: the backup buckets (once the Backups tab). PostgreSQL has one view: its databases under their server.
  const storesAlt = {
    main: { label: t('hsViewStores'), count: sqlite.length },
    other: { label: t('hsViewBuckets'), count: view.buckets.length },
    view: <BucketCards view={view} t={t} now={now} jobs={runningJobs} onOpen={props.onOpen} onAddBucket={props.onAddBucket} onList={props.onListBucket} onReconnect={props.onReconnect} onRestore={props.onRestore} />,
    add: (
      <>
        {view.buckets.length > 0 ? <Button variant="outline" size="sm" disabled={props.listingAll} onClick={props.onListAll}>{t('ovListBuckets')}</Button> : null}
        <Button variant="outline" size="sm" icon={plus} onClick={props.onAddBucket}>{t('ovAddBucket')}</Button>
      </>
    ),
  }
  // A Store row's menu on the board: the Store card's own menu (a PostgreSQL Store's checks from this machine).
  const storeMenuOn = (machine: string) => ({ name }: { name: string }) => {
    const s = stores.find((x) => x.name === name)
    return s ? <StoreMenu store={s} on={props.actionsFor(s)} t={t} machine={s.kind === 'postgresql' ? machine : undefined} /> : null
  }
  const checked = doctor.data?.at ? t('ovChecked', { ago: ago(doctor.data.at, now, t as Translate) }) : null

  return (
    <div className={css.page}>
      <HomeHero
        identity={(
          <>
            <span className={heroCss.name} title={[rt?.home, rt?.preparedImages != null ? t('ovPreparedImages', { n: rt.preparedImages }) : null].filter(Boolean).join(' · ')}><BrandLockup /></span>
            <button type="button" className={heroCss.runtime} data-tone={runtimeTone} aria-label={runtimeWords} title={t('ovRuntimeToggle')}
              onClick={() => setupDialog.open()}>
              {!rt ? <StateDot state="ongoing" size={9} /> : rt.ok ? null : <StateDot state="error" size={6} />}
              <span>{rt?.ok && rt.version ? rt.version : runtimeWords}</span>
              {rt?.commit ? <span>· {rt.commit.slice(0, 8)}</span> : null}
            </button>
          </>
        )}
        signal={top
          ? <Signal state={top.tone === 'danger' ? 'error' : top.tone === 'warning' ? 'warning' : 'idle'} title={top.tone === 'danger' ? t('ovSignalProblem') : top.tone === 'warning' ? t('ovSignalWarning') : t('ovSignalNote')} detail={top.detail} />
          : <StateDot state="done" size={8} />}
        headline={top ? top.title : t('ovHealthAllGood')}
        actions={top ? (
          <NeedActions key={top.key} need={top} labels={refusalLabels(t)} role={top.tone === 'danger' ? 'alert' : undefined}
            more={rest.length ? <span className={heroCss.more}>{t('ovMoreProjects', { n: rest.length })}</span> : null} />
        ) : null}
        toolsLabel={t('ovToolsLabel')}
        tools={(
          <>
            <Button variant="ghost" size="sm" icon={<IconShieldOutlineRegular size={15} />} onClick={() => props.onOpen('health')}
              aria-label={t('navHealth')} title={findings.length ? t('navHealthFindings', { n: findings.length }) : t('navHealth')}>
              {findings.length ? <span className={heroCss.toolCount} data-tone={findingErrors ? 'danger' : 'warning'}>{findings.length}</span> : null}
            </Button>
            <Button variant="ghost" size="sm" icon={<LogsPanelIcon size={15} />} onClick={() => props.onOpen('logs')} aria-label={t('navLogs')} title={t('navLogs')} />
            <Button variant="ghost" size="sm" icon={<IconAgentPresetOutlineRegular size={15} />} onClick={props.onPresets} aria-label={props.presetsLabel} title={props.presetsLabel} />
            <Button variant="ghost" size="sm" icon={<IconSettingsOutlineRegular size={15} />} onClick={() => setupDialog.open()} aria-label={t('navSettings')} title={t('navSettings')} />
            <Button variant="ghost" size="sm" icon={doctor.loading ? <StateDot state="ongoing" size={13} /> : <IconRefreshOutlineRegular size={15} />}
              disabled={doctor.loading} onClick={refreshAll} aria-label={t('refresh')} title={[t('ovRefreshTitle'), checked].filter(Boolean).join(' · ')} />
          </>
        )}
        tabs={[
          { key: 'projects', label: t('ovProjects'), count: searching ? t('ovCountOf', { n: projectsShown, total: projectCount }) : projectCount, tone: storeTrouble ? 'danger' : undefined },
          { key: 'stores', label: t('ovStores'), count: stores.length, tone: storeTone },
          { key: 'machines', label: t('ovMachines'), count: fleet ? machines.length : '—', tone: machineTone },
        ]}
        active={tab} onSelect={setTab} tabsLabel={t('ovTabs')} tabActions={tabActions} />

      {/* ---------- 1. projects, each with its Store and machines ---------- */}
      {tab === 'projects' ? (
        <section id={panelId('projects')} role="tabpanel" className={css.section} aria-label={t('ovProjects')}>
          {projectCount === 0 ? (
            <Card>
              <EmptyState title={t('ovNoProjects')} icon={<LayerfsGlyph size={20} />}
                action={(
                  <>
                    <Button variant="primary" size="sm" icon={<IconPlusOutlineRegular size={13} />} onClick={newProject}>{t('newProject')}</Button>
                    <Button variant="outline" size="sm" icon={<IconAgentPresetOutlineRegular size={13} />} onClick={props.onPresets}>{props.presetsLabel}</Button>
                  </>
                )}>
                {t('ovNoProjectsBody')}
              </EmptyState>
            </Card>
          ) : (
            <>
              <ProjectFinderBar finder={finder} t={t} />
              <ProjectTable api={mc.api} now={now} tick={props.refreshKey} query={finder.query} sort={finder.sort} frozen={finder.frozen} onClearSearch={() => finder.setQuery('')} stores={stores} view={view} fleet={fleet} t={t} jobs={runningJobs} place={place} onOpen={props.onOpen} onRemove={props.onRemoveProject}
              onRestart={(m) => mc.act({ kind: 'start', name: m.name, platform: m.platform })} />
            </>
          )}
        </section>
      ) : null}

      {/* ---------- 2. Stores, each with its projects ---------- */}
      {tab === 'stores' ? (
        <section id={panelId('stores')} role="tabpanel" className={css.section} aria-label={t('ovStores')}>
          {stores.length === 0 && view.buckets.length === 0 ? (
            <Card>
              <EmptyState title={t('noStores')} icon={<StoreGlyph kind="sqlite" size={20} />}
                action={<Button variant="primary" size="sm" icon={<IconPlusOutlineRegular size={13} />} onClick={props.onNewStore}>{t('newStore')}</Button>}>
                {t('noStoresBody')}
              </EmptyState>
            </Card>
          ) : (
            <HomeStores api={mc.api} stores={stores} view={view} t={t} now={now} jobs={props.jobs} dismissed={props.dismissed} actionsFor={props.actionsFor} loginActions={props.loginActions} sandboxes={props.sandboxes}
              onOpenStore={(name) => props.onOpen(`store:${name}`)} onOpenProject={(key) => props.onOpen(`project:${key}`)} onBackups={props.onBackups}
              onNewStore={props.onNewStore} onConnect={props.onConnect} alt={storesAlt} />
          )}
        </section>
      ) : null}

      {/* ---------- 3. machines: the board, each over its Stores and Sandboxes ---------- */}
      {tab === 'machines' ? (
        <section id={panelId('machines')} role="tabpanel" className={css.section} aria-label={t('ovMachines')}>
          <Board go={mc.go} onAddStore={props.onAddStore} storeMenu={storeMenuOn} />
        </section>
      ) : null}

    </div>
  )
}

/** The head's need: the verb that fixes it, how many more there are, and a refusal on its own line. */
function NeedActions({ need: n, labels, more, role }: { need: Need, labels: ReturnType<typeof refusalLabels>, more: ReactNode, role: 'alert' | undefined }): ReactNode {
  // one action at a time; a refusal stays until the next try
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [armed, setArmed] = useState(false)
  // click safety (UI pass 3 F6): presses are keyed to this need and dropped while its buttons have just appeared or changed
  const guard = usePressGuard(`${n.key}:${n.action?.label ?? ''}:${n.secondary?.label ?? ''}`)
  const go = (run: () => void | Promise<unknown>) => {
    setBusy(true); setError(null); setArmed(false)
    void Promise.resolve().then(run).catch(setError).finally(() => setBusy(false))
  }
  return (
    <>
      <span className={heroCss.acts} role={role}>
        {n.action ? <Button variant="outline" size="sm" disabled={busy || guard.settling} aria-disabled={guard.settling || undefined} onClick={guard(() => go(n.action!.run))}>{n.action.label}</Button> : null}
        {n.secondary ? (
          <Button variant={armed ? 'primary' : 'ghost'} size="sm" disabled={busy || guard.settling} aria-disabled={guard.settling || undefined} title={n.secondary.title}
            onClick={guard(() => { if (n.secondary!.confirm && !armed) setArmed(true); else go(n.secondary!.run) })}>
            {armed && n.secondary.confirm ? n.secondary.confirm : n.secondary.label}
          </Button>
        ) : null}
        {n.extra}
      </span>
      {more}
      {error != null ? <Refusal error={error} labels={labels} className={heroCss.refusal} /> : null}
    </>
  )
}

function Link({ children, onClick }: { children: ReactNode, onClick: () => void }): ReactNode {
  return <button type="button" className={css.link} onClick={(e) => { e.stopPropagation(); onClick() }}>{children}</button>
}

function StoreLink({ name, onOpen, children }: { name: string, onOpen: (id: TabId) => void, children: ReactNode }): ReactNode {
  return <Link onClick={() => onOpen(`store:${name}`)}>{children}</Link>
}
