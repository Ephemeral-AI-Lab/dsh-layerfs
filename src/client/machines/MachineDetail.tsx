/**
 * One machine's tab: its head (name as the tree shows it, state, power,
 * menu), a line of facts, startup progress and notices, then its Stores and
 * its Sandboxes side by side, all of them, and the full spec folded under
 * Details.
 */
import { useState, type ReactNode } from 'react'
import { Button, IconChevronRightOutlineRegular, IconPlusOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { DoctorAction } from '../doctor/Doctor.tsx'
import { Card, Empty, Notice, Page, PageHead, Refusal } from '../ui/index.tsx'
import { DiskLine, attentionOf, blockedOf, glyphOs } from './Board.tsx'
import { useMachinesContext } from './context.tsx'
import { MachineGlyph } from './icons.tsx'
import type { View } from './context.tsx'
import { Inventory, useMachineTitle } from './Inventory.tsx'
import { clearingCall, downReason, gib, machineState, runtimeOf, sandboxesOn, storesOn, type AvailableView, type MachineInfo } from './model.ts'
import { MachineDialogs, MachineMenu, MachineProgress, MachineStateChip, PowerButton, useMachineRun } from './parts.tsx'
import { stepReasons } from './needs.ts'
import { FixPanel } from './Readiness.tsx'
import { NewSandboxDialog } from './Sandboxes.tsx'
import { SpecTab } from './Spec.tsx'
import css from './machines.module.css'

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

/** CPU and memory in words: shared for the native machine, Docker's own for docker, else the allocation. */
function resourcesOf(m: MachineInfo, t: ReturnType<typeof useMachinesContext>['t']): string {
  if (m.platform === 'native') return t('resourcesShared')
  if (m.cpus == null && m.memory == null) return m.platform === 'docker' ? t('resourcesDocker') : t('notReported')
  const cpu = m.cpus != null ? t(m.cpus === 1 ? 'coresOne' : 'cores', { n: String(m.cpus) }) : t('notReported')
  return `${cpu} · ${m.memory != null ? gib(m.memory) : t('notReported')}`
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
  const canSandbox = pending === null && state.key === 'running'
  const name = title(m)
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

      <dl className={css.factRow} aria-label={t('resources')}>
        <div><dt>{t('freeDisk')}</dt><dd><DiskLine m={m} view={view} /></dd></div>
        <div><dt>{t('cpuMemory')}</dt><dd>{resourcesOf(m, t)}</dd></div>
        {live?.toolVersion && <div><dt>{t('toolVersionOf', { kind: kind(m.platform) })}</dt><dd className={css.mono}>{live.toolVersion}</dd></div>}
      </dl>

      <MachineProgress name={m.name} />
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
        </Notice>
      )}

      <Card className={css.block}>
        <Inventory m={m} view={view}
          storeAction={onAddStore ? (
            <Button variant="outline" size="sm" icon={<IconPlusOutlineRegular size={12} />} onClick={() => onAddStore(m.name)}>
              {t('addStore')}
            </Button>
          ) : undefined}
          sandboxAction={(
            <Button variant="outline" size="sm" icon={<IconPlusOutlineRegular size={12} />} disabled={!canSandbox}
              title={canSandbox ? undefined : t('startBeforeSandbox')} onClick={() => setCreating(true)}>
              {t('newSandbox')}
            </Button>
          )} />
      </Card>

      <details className={css.details}>
        <summary className={css.detailsSummary}>
          <IconChevronRightOutlineRegular size={12} className={css.detailsChevron} />
          <span>{t('details')}</span>
        </summary>
        <div className={css.detailsBody}>
          <div className={css.detailsActions}><DoctorAction api={api} t={doctorT} target="machine" name={m.name} label={doctorT('runDiagnostics')} /></div>
          <SpecTab m={m} live={live} view={view} sandboxes={sandboxesOn(view, m)} stores={storesOn(view, m)} pending={pending}
            onSettings={() => setDialog('settings')} onRemove={() => setDialog('remove')} />
        </div>
      </details>

      {creating && <NewSandboxDialog machine={m} taken={view.sandboxes.map((b) => b.name)} onClose={() => setCreating(false)} />}
      <MachineDialogs m={m} dialog={dialog} onClose={() => setDialog(null)} pending={pending} run={run} onRemoved={() => go({ kind: 'board' })} />
    </Page>
  )
}
