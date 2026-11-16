/**
 * One machine's page: its head (name as the tree shows it, state, power,
 * menu), startup progress and notices, then its tabs (MachineTabs.tsx).
 * Overview (Overview.tsx) is a status line or what needs you, processor,
 * memory and disk tiles with their hour, what is on the machine and its
 * Details. Sandboxes and Stores list them all, with New Sandbox
 * and Add Store. Disk (where the disk goes) is there only
 * with machine.space, Files (InspectFiles.tsx) only with machine.files, and
 * Worker log (LogPane.tsx) only with logs.machine and a machine LayerFS says
 * has a worker log (`supports.log`).
 */
import { useId, useState, type ReactNode } from 'react'
import { Button, IconSettingsOutlineRegular, SegmentedTabs } from '@deepseek-ai/dsh-client-ui-primitives'
import { DoctorAction } from '../doctor/Doctor.tsx'
import { Empty, LinkButton, Notice, Page, PageHead, Refusal } from '../ui/index.tsx'
import { DiskLine, attentionOf, blockedOf, glyphOs } from './Board.tsx'
import { useMachinesContext } from './context.tsx'
import { MachineGlyph } from './icons.tsx'
import { useDetailTab } from './detail-tabs.ts'
import { InspectFiles } from './InspectFiles.tsx'
import { sandboxOfRunFolder } from './inspect-files.ts'
import { LogPane } from './LogPane.tsx'
import type { View } from './context.tsx'
import { useMachineTitle } from './Inventory.tsx'
import { BUILT_IN, clearingCall, downReason, gib, machineState, runtimeOf, sandboxesOn, type AvailableView, type MachineInfo } from './model.ts'
import { MachineDialogs, MachineMenu, MachineProgress, MachineStateChip, PowerButton, hasSettings, useMachineRun } from './parts.tsx'
import { stepReasons } from './needs.ts'
import { FixPanel } from './Readiness.tsx'
import { NewSandboxDialog } from './Sandboxes.tsx'
import { MachineOverview } from './Overview.tsx'
import { ObservedCpuMemory, useMachineStats, workerLine } from './MachineStats.tsx'
import { machineTabs, type MachineTab } from './machine-tabs.ts'
import { DiskTab, SandboxesTab, StoresTab } from './MachineTabs.tsx'
import { useSpaceOffered } from './SpaceViews.tsx'
import { storeLines } from './Inventory.tsx'
import css from './machines.module.css'
import logCss from './log.module.css'

/** `onAddStore`: the page's Add Store for this machine (Storage's dialog); without it the Stores column has no action. */
export function MachineDetail({ name, go, onAddStore }: { name: string, go: (view: View) => void, onAddStore?: ((machine: string) => void) | undefined }): ReactNode {
  const { t, useMachines, refusal } = useMachinesContext()
  const title = useMachineTitle()
  const read = useMachines((s) => s)
  const view = read.data?.available ? read.data : null
  const m = view?.machines.find((x) => x.name === name)
  const label = title({ name, platform: m?.platform ?? (name === 'native' ? 'native' : '') })
  if (!view) {
    return (
      <Page wide label={label}>
        <PageHead title={label} />
        {read.status === 'error' ? <Refusal error={read.error} labels={refusal} /> : <p className={css.muted}>{t('readingMachines')}</p>}
      </Page>
    )
  }
  if (!m) {
    return (
      <Page wide label={label}>
        <PageHead title={label} />
        <Empty title={t('noSuchMachine', { name })}>{t('noSuchMachineBody')}</Empty>
      </Page>
    )
  }
  return <MachineView key={m.name} view={view} m={m} go={go} onAddStore={onAddStore} />
}

/** CPU and memory in words when nothing was observed: the size the record was created with, labelled "allocated" (keyed on what is there, never on the platform). */
function resourcesOf(m: MachineInfo, t: ReturnType<typeof useMachinesContext>['t']): string {
  if (m.cpus == null && m.memory == null) return t('notReported')
  const cpu = m.cpus != null ? t(m.cpus === 1 ? 'coresOne' : 'cores', { n: String(m.cpus) }) : t('notReported')
  return t('mxAllocated', { size: `${cpu} · ${m.memory != null ? gib(m.memory) : t('notReported')}` })
}

function MachineView({ view, m, go, onAddStore }: { view: AvailableView, m: MachineInfo, go: (view: View) => void, onAddStore?: ((machine: string) => void) | undefined }): ReactNode {
  const { t, tw, kind, api, doctorT, useStartups, refusal } = useMachinesContext()
  const title = useMachineTitle()
  const startup = useStartups((all) => all[m.name])
  const { run, pending: localPending, error } = useMachineRun()
  const pending = localPending ?? (startup?.status === 'running' ? startup.kind : null)
  const [dialog, setDialog] = useState<'settings' | 'remove' | 'force-stop' | null>(null)
  const [creating, setCreating] = useState(false)
  const live = view.status[m.name]
  const state = machineState(m, live)
  const reason = startup?.status === 'running' ? null : downReason(m, live)
  const attention = startup?.status === 'running' ? null : attentionOf(m, view)
  const block = startup?.status === 'running' ? null : blockedOf(m, view)
  const calls = clearingCall('machine', m.name, state.op)
  // New Sandbox also works on a stopped machine (Start and create); it waits only while a power action runs
  const canSandbox = pending === null
  const name = title(m)
  // Worker log: the pinned CLI has the call, and LayerFS says this machine has a worker log (no platform test here)
  const hasLog = view.features?.inspect?.machineLog === true && m.supports?.log === true
  // Files: the pinned CLI has machine.files (which views it has is LayerFS's answer, never a platform test here)
  const hasFiles = view.features?.inspect?.machineFiles === true
  // observed values (machine.stats), read every 10 s while this page is on screen; without the call the facts are the record's, as before
  const observed = useMachineStats(m)
  const hasDisk = useSpaceOffered()
  const sandboxCount = sandboxesOn(view, m).length
  const storeCount = storeLines(view, m).length
  const labels: Record<MachineTab, string> = {
    overview: t('tabOverview'), sandboxes: t('tabSandboxes', { n: String(sandboxCount) }), stores: t('tabStores', { n: String(storeCount) }),
    disk: t('tabDisk'), files: t('tabFiles'), log: t('tabWorkerLog'),
  }
  const tabs = machineTabs({ disk: hasDisk, files: hasFiles, log: hasLog }).map((value) => ({ value, label: labels[value] }))
  const [tab, setTab] = useDetailTab<MachineTab>('machine', m.name, tabs.map((x) => x.value), 'overview')
  const ids = useId()
  const worker = observed.offered ? workerLine(observed.read?.stats, t) : null
  const logLink = hasLog && tab !== 'log' ? <LinkButton onClick={() => setTab('log')}>{t('openWorkerLog')}</LinkButton> : null
  // startup progress and notices: on every tab, where today's page has them
  const notices = (
    <>
      <MachineProgress name={m.name} failedAction={logLink} />
      {block && (
        <Notice tone="warning">
          <p>{t('unavailableWhy', { kind: kind(m.platform), reason: stepReasons(block, tw) })}</p>
          {m.stores.length > 0 && <p>{t(m.stores.length === 1 ? 'storeBlockedOne' : 'storesBlocked', { n: String(m.stores.length) })}</p>}
          <FixPanel fixes={block.fixes} className={css.blockedHelp} />
        </Notice>
      )}
      {(reason || error !== null || state.state === 'unresolved') && (
        <Notice tone={attention === 'danger' || error !== null ? 'danger' : undefined}>
          {reason && <p>{reason}</p>}
          {state.state === 'unresolved' && <p><code>{t('clearingCall', { status: calls.status, clear: calls.clear })}</code></p>}
          {m.stores.length > 0 && attention === 'danger' && <p>{t(m.stores.length === 1 ? 'storeBlockedOne' : 'storesBlocked', { n: String(m.stores.length) })}</p>}
          {error !== null && <Refusal error={error} labels={refusal} />}
          {logLink && (reason || state.state === 'unresolved') ? <p>{logLink}</p> : null}
        </Notice>
      )}
    </>
  )
  return (
    <Page wide label={name}>
      <PageHead
        icon={<MachineGlyph platform={m.platform} os={glyphOs(m, view)} size={22} />}
        title={name}
        badge={<MachineStateChip m={m} live={live} pending={pending} blocked={!!block} />}
        intro={`${kind(m.platform)} · ${tw(runtimeOf(m))}`}
        actions={(
          <>
            {!block && <PowerButton m={m} pending={pending} run={run} />}
            <MachineMenu m={m} pending={pending} run={run} onDialog={setDialog} />
          </>
        )}
      />

      <SegmentedTabs size="sm" className={logCss.tabs} label={t('machineTabs', { name })} value={tab} onChange={setTab}
        items={tabs.map((x) => ({ value: x.value, label: x.label, id: `${ids}-${x.value}`, panelId: `${ids}-${x.value}-panel` })) as [never, ...never[]]} />

      {tab === 'files' ? (
        <div className={logCss.tabPanel} role="tabpanel" id={`${ids}-files-panel`} aria-labelledby={`${ids}-files`}>
          {notices}
          <InspectFiles kind="machine" name={m.name} label={t('filesOf', { name })} onOpenLog={hasLog ? () => setTab('log') : undefined} logTab={hasLog ? t('tabWorkerLog') : undefined}
            onOpenSandboxLog={view.features?.inspect?.sandboxLog === true ? (folder) => {
              // a daemon.log in a run folder: the Daemon log tab of the Sandbox that folder is of, when this machine has it
              const sandbox = sandboxOfRunFolder(folder)
              return sandbox && sandboxesOn(view, m).some((sb) => sb.name === sandbox) ? () => go({ kind: 'sandbox', machine: m.name, name: sandbox, tab: 'log' }) : null
            } : undefined}
            unavailableAction={state.state === 'stopped' && !block ? <PowerButton m={m} pending={pending} run={run} /> : undefined} />
        </div>
      ) : tab === 'log' ? (
        <div className={logCss.tabPanel} role="tabpanel" id={`${ids}-log-panel`} aria-labelledby={`${ids}-log`}>
          {notices}
          <LogPane kind="machine" name={m.name} label={t('workerLogOf', { name })}
            unavailable={state.state === 'stopped' ? { message: t('logMachineStopped'), action: block ? undefined : <PowerButton m={m} pending={pending} run={run} /> } : null} />
        </div>
      ) : tab !== 'overview' ? (
        <div className={logCss.tabPanel} role="tabpanel" id={`${ids}-${tab}-panel`} aria-labelledby={`${ids}-${tab}`}>
          {notices}
          {tab === 'sandboxes' ? <SandboxesTab m={m} view={view} canCreate={canSandbox} onCreate={() => setCreating(true)} />
            : tab === 'stores' ? <StoresTab m={m} view={view} onAddStore={onAddStore} />
              : <DiskTab m={m} />}
        </div>
      ) : (
      <div className={logCss.tabPanel} role="tabpanel" id={`${ids}-overview-panel`} aria-labelledby={`${ids}-overview`}>
        <MachineOverview m={m} view={view} live={live} pending={pending} onTab={setTab} hasDiskTab={hasDisk}
          troubled={!!(reason || block || error !== null || state.state === 'unresolved')}
          notices={notices}
          fallback={(
            // without the sampler's read (no machine.stats, or not read yet): the facts as the record has them
            <dl className={css.factRow} aria-label={t('resources')}>
              <div><dt>{t(observed.offered ? 'disk' : 'freeDisk')}</dt><dd><DiskLine m={m} view={view} /></dd></div>
              <div><dt>{t('cpuMemory')}</dt><dd>{observed.offered && observed.read?.stats ? <ObservedCpuMemory read={observed.read} /> : resourcesOf(m, t)}</dd></div>
              {live?.toolVersion && <div><dt>{t('toolVersionOf', { kind: kind(m.platform) })}</dt><dd className={css.mono}>{live.toolVersion}</dd></div>}
              {worker && <div><dt>{t('worker')}</dt><dd data-worker-line>{worker}</dd></div>}
            </dl>
          )}
          actions={(
            <>
              <DoctorAction api={api} t={doctorT} target="machine" name={m.name} label={doctorT('runDiagnostics')} />
              {BUILT_IN.has(m.platform) && hasSettings(m) && (
                <Button size="sm" variant="outline" icon={<IconSettingsOutlineRegular size={13} />} onClick={() => setDialog('settings')}>{t('updateSettings')}</Button>
              )}
            </>
          )}
          onRemove={() => setDialog('remove')} />
      </div>
      )}

      {creating && <NewSandboxDialog machine={m} taken={view.sandboxes.map((b) => b.name)} onClose={() => setCreating(false)} />}
      <MachineDialogs m={m} dialog={dialog} onClose={() => setDialog(null)} pending={pending} run={run} onRemoved={() => go({ kind: 'board' })} />
    </Page>
  )
}
