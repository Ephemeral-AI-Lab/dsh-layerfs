/**
 * One machine's page: its head (identity, state, power, settings, menu),
 * resources, startup progress and notices, then three tabs: its Sandboxes
 * with their Workspaces, the Stores its Sandboxes use, and its spec.
 */
import { useId, useState, type ReactNode } from 'react'
import { Button, IconRightUpOutlineRegular, IconSettingsOutlineRegular, SegmentedTabs } from '@deepseek-ai/dsh-client-ui-primitives'
import { DoctorAction } from '../doctor/Doctor.tsx'
import { Empty, Meter, Notice, Page, PageHead, Refusal } from '../ui/index.tsx'
import { attentionOf, STORAGE_PANEL } from './Board.tsx'
import { useMachinesContext } from './context.tsx'
import { MachineGlyph } from './icons.tsx'
import type { View } from './MachinesPage.tsx'
import { BUILT_IN, clearingCall, downReason, gib, machineState, sandboxesOn, sizeOf, storesOn, type AvailableView } from './model.ts'
import { MachineDialogs, MachineMenu, MachineProgress, MachineStateChip, PowerButton, useMachineRun } from './parts.tsx'
import { NewSandboxDialog, SandboxList } from './Sandboxes.tsx'
import { SpecTab } from './Spec.tsx'
import { StoresTab, storeCount } from './Stores.tsx'
import css from './machines.module.css'

type Tab = 'sandboxes' | 'stores' | 'spec'

export function MachineDetail({ name, initialTab, go }: { name: string, initialTab?: Tab | undefined, go: (view: View) => void }): ReactNode {
  const { t, useMachines, refusal } = useMachinesContext()
  const read = useMachines((s) => s)
  const view = read.data?.available ? read.data : null
  const back = { label: t('panel'), ariaLabel: t('backToMachines'), onClick: () => go({ kind: 'board' }) }
  if (!view) {
    return (
      <Page wide label={name}>
        <PageHead title={name} crumbs={[back]} current={name} />
        {read.status === 'error' ? <Refusal error={read.error} labels={refusal} /> : <p className={css.muted}>{t('readingMachines')}</p>}
      </Page>
    )
  }
  const m = view.machines.find((x) => x.name === name)
  if (!m) {
    return (
      <Page wide label={name}>
        <PageHead title={name} crumbs={[back]} current={name} />
        <Empty title={t('noSuchMachine', { name })}>{t('noSuchMachineBody')}</Empty>
      </Page>
    )
  }
  return <MachineView key={m.name} view={view} name={name} initialTab={initialTab ?? 'sandboxes'} go={go} back={back} />
}

function MachineView({ view, name, initialTab, go, back }: { view: AvailableView, name: string, initialTab: Tab, go: (view: View) => void, back: { label: string, ariaLabel: string, onClick: () => void } }): ReactNode {
  const { t, tw, kind, api, doctorT, useStartups, refusal, openPanel } = useMachinesContext()
  const m = view.machines.find((x) => x.name === name)!
  const startup = useStartups((all) => all[m.name])
  const { run, pending: localPending, error } = useMachineRun()
  const pending = localPending ?? (startup?.status === 'running' ? startup.kind : null)
  const [dialog, setDialog] = useState<'settings' | 'remove' | null>(null)
  const [tab, setTab] = useState<Tab>(initialTab)
  const [creating, setCreating] = useState(false)
  const tabsId = useId()
  const live = view.status[m.name]
  const state = machineState(m, live)
  const reason = startup?.status === 'running' ? null : downReason(m, live)
  const stores = storesOn(view, m)
  const sandboxes = sandboxesOn(view, m)
  const attention = startup?.status === 'running' ? null : attentionOf(m, view)
  const calls = clearingCall('machine', m.name, state.op)
  const used = m.disk && live?.freeDisk != null ? Math.max(0, m.disk - live.freeDisk) : null
  const share = used !== null && m.disk ? used / m.disk : null
  const canSandbox = pending === null && state.key === 'running'
  const items = [
    { value: 'sandboxes' as const, label: <TabLabel text={t('sandboxes')} count={sandboxes.length} />, id: `${tabsId}-sandboxes`, panelId: `${tabsId}-sandboxes-panel` },
    { value: 'stores' as const, label: <TabLabel text={t('stores')} count={storeCount(m, stores, view.postgresql ?? [])} />, id: `${tabsId}-stores`, panelId: `${tabsId}-stores-panel` },
    { value: 'spec' as const, label: t('spec'), id: `${tabsId}-spec`, panelId: `${tabsId}-spec-panel` },
  ] as const
  const current = items.find((i) => i.value === tab)!
  return (
    <Page wide label={m.name}>
      <PageHead
        crumbs={[back]}
        current={m.name}
        icon={<MachineGlyph platform={m.platform} os={m.backend === 'namespaces' ? 'linux' : m.backend == null ? 'pc' : undefined} size={22} />}
        title={m.name}
        badge={<MachineStateChip m={m} live={live} pending={pending} />}
        intro={`${kind(m.platform)} · ${tw(sizeOf(m, live))}`}
        actions={(
          <>
            <PowerButton m={m} pending={pending} run={run} />
            {BUILT_IN.has(m.platform) && (
              <Button variant="outline" size="sm" icon={<IconSettingsOutlineRegular size={13} />} disabled={pending !== null} onClick={() => setDialog('settings')}>{t('settings')}</Button>
            )}
            <MachineMenu m={m} pending={pending} run={run} onDialog={setDialog} />
          </>
        )}
      />

      <dl className={css.resources} aria-label={t('resources')}>
        {m.platform === 'native'
          ? <div><dt>{t('resources')}</dt><dd>{t('resourcesShared')}</dd></div>
          : m.platform === 'docker' && m.cpus == null && m.memory == null && m.disk == null
            ? <div><dt>{t('resources')}</dt><dd>{t('resourcesDocker')}</dd></div>
            : (
              <>
                <div><dt>{t('cpu')}</dt><dd>{m.cpus ?? t('notReported')}</dd></div>
                <div><dt>{t('memory')}</dt><dd>{m.memory != null ? gib(m.memory) : t('notReported')}</dd></div>
                <div><dt>{t('disk')}</dt><dd>{m.disk != null ? gib(m.disk) : t('notReported')}</dd></div>
              </>
            )}
        {live?.freeDisk != null && (
          <div>
            <dt>{t('freeDisk')}</dt>
            <dd>
              {share !== null && <Meter share={share} label={t('diskUse')} />}
              <span>{share !== null ? t('diskFreeOf', { free: gib(live.freeDisk), total: gib(m.disk!) }) : gib(live.freeDisk)}</span>
            </dd>
          </div>
        )}
      </dl>

      <MachineProgress name={m.name} />
      {(reason || error !== null || state.state === 'unresolved') && (
        <Notice tone={attention === 'danger' || error !== null ? 'danger' : undefined}>
          {reason && <p>{reason}</p>}
          {state.state === 'unresolved' && <p><code>{t('clearingCall', { status: calls.status, clear: calls.clear })}</code></p>}
          {m.stores.length > 0 && attention === 'danger' && <p>{t(m.stores.length === 1 ? 'storeBlockedOne' : 'storesBlocked', { n: String(m.stores.length) })}</p>}
          {error !== null && <Refusal error={error} labels={refusal} />}
        </Notice>
      )}

      <div className={css.tabBar}>
        <SegmentedTabs size="sm" className={css.tabs} label={t('machineViews', { name: m.name })} value={tab} onChange={setTab} items={items as never} />
        <div className={css.tabAction}>
          {tab === 'sandboxes'
            ? (
              <Button variant="outline" size="sm" disabled={!canSandbox} title={canSandbox ? undefined : t('startBeforeSandbox')} onClick={() => setCreating(true)}>
                {t('newSandbox')}
              </Button>
            )
            : tab === 'stores'
              ? <Button variant="outline" size="sm" icon={<IconRightUpOutlineRegular size={13} />} onClick={() => openPanel(STORAGE_PANEL)}>{t('openStorage')}</Button>
              : <DoctorAction api={api} t={doctorT} target="machine" name={m.name} label={doctorT('runDiagnostics')} />}
        </div>
      </div>

      <div role="tabpanel" id={current.panelId} aria-labelledby={current.id} className={css.panel}>
        {tab === 'sandboxes'
          ? sandboxes.length === 0
            ? <p className={css.emptyLine}>{t(state.key !== 'running' ? 'noSandboxesStart' : 'noSandboxes')}</p>
            : <SandboxList sandboxes={sandboxes} onOpen={(sandbox) => go({ kind: 'sandbox', machine: m.name, name: sandbox })} />
          : tab === 'stores'
            ? <StoresTab m={m} sqlite={stores} postgresql={view.postgresql ?? []} sandboxes={sandboxes} />
            : <SpecTab m={m} live={live} view={view} sandboxes={sandboxes} stores={stores} pending={pending} onSettings={() => setDialog('settings')} onRemove={() => setDialog('remove')} />}
      </div>

      {creating && <NewSandboxDialog machine={m} taken={view.sandboxes.map((b) => b.name)} onClose={() => setCreating(false)} />}
      <MachineDialogs m={m} dialog={dialog} onClose={() => setDialog(null)} pending={pending} run={run} onRemoved={() => go({ kind: 'board' })} />
    </Page>
  )
}

function TabLabel({ text, count }: { text: string, count: number }): ReactNode {
  return <span className={css.tabLabel}>{text}<span className={css.tabCount}>{count}</span></span>
}
