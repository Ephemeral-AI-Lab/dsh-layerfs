/**
 * The Machines tab: one block per machine (those that need you first), each
 * its header (name, state, disk, power, menu) over its Stores and its
 * Sandboxes. A block's name or "Show all" opens the machine's tab.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { Button, IconPlusOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { DoctorAction } from '../doctor/Doctor.tsx'
import { Card, Empty, LoadError, Loading, Meter, Notice, Page, PageHead, Refusal } from '../ui/index.tsx'
import { AddMachineDialog } from './AddMachineDialog.tsx'
import { useMachinesContext } from './context.tsx'
import { MachineGlyph, MachinesGlyph } from './icons.tsx'
import type { View } from './context.tsx'
import { Inventory, useMachineTitle } from './Inventory.tsx'
import {
  RANK, downReason, gib, machineOrder, machineState, runtimeOf,
  type AvailableView, type MachineInfo,
} from './model.ts'
import { machineBlock, nativeGlyphOs, nativeNameKey, osOfView, type Readiness } from './needs.ts'
import { MachineDialogs, MachineMenu, MachineProgress, MachineStateChip, PowerButton, useMachineRun } from './parts.tsx'
import { Blocked } from './Readiness.tsx'
import css from './machines.module.css'

/** Rows each list shows on this tab before "Show all". */
const ROWS = 4

export function Board({ go }: { go: (view: View) => void }): ReactNode {
  const { t, api, doctorT, useMachines, useStartups, reload, refusal } = useMachinesContext()
  const read = useMachines((s) => s)
  const startups = useStartups((s) => s)
  const [adding, setAdding] = useState(false)
  const view = read.data
  const available = view?.available ? view : null
  const starting = useMemo(() => new Set(Object.values(startups).filter((s) => s.status === 'running').map((s) => s.name)), [startups])
  const machines = useMemo(() => {
    if (!available) return []
    const rank = (m: MachineInfo) => (starting.has(m.name) ? RANK.busy : RANK[machineState(m, available.status[m.name]).key])
    return machineOrder(available.machines).sort((a, b) => rank(a) - rank(b))
  }, [available, starting])

  return (
    <Page wide label={t('panel')}>
      <PageHead
        title={t('panel')}
        hideTitle
        actions={(
          <>
            <DoctorAction api={api} t={doctorT} target="host" label={doctorT('diagnoseHost')} />
            {available && <Button variant="primary" size="sm" icon={<IconPlusOutlineRegular size={13} />} onClick={() => setAdding(true)}>{t('newMachine')}</Button>}
          </>
        )}
      />
      {view && read.error != null && (
        <Notice tone="warning" role="status">
          <p>{t('staleRead', { time: read.observedAt ? new Date(read.observedAt).toLocaleTimeString() : '—' })}</p>
          <Refusal error={read.error} labels={refusal} compact />
        </Notice>
      )}
      {!view
        ? read.status === 'error'
          ? <LoadError title={t('readMachinesFailed')} error={read.error} labels={refusal} retryLabel={t('retry')} onRetry={reload} />
          : <Loading label={t('readingMachines')} />
        : !available
          ? <Empty icon={<MachinesGlyph size={20} />} title={t('noMachinesTitle')}>{t('noMachinesBody', { version: view.layerfs ?? '1.x' })}</Empty>
          : (
            <>
              {Object.entries(available.readErrors ?? {}).map(([part, e]) => (
                <Notice key={part} tone="danger" role="status">
                  <p>{t('partUnread', { part, time: new Date(e.at).toLocaleTimeString(), code: e.error.code, message: e.error.message })}</p>
                </Notice>
              ))}
              <div className={css.blocks}>
                {machines.map((m) => (
                  <MachineBlock key={m.name} m={m} view={available} onOpen={() => go({ kind: 'machine', name: m.name })} />
                ))}
              </div>
              {adding && <AddMachineDialog view={available} onClose={() => setAdding(false)} onMade={(name) => go({ kind: 'machine', name })} platforms={available.platforms} />}
            </>
          )}
    </Page>
  )
}

/** How much a machine needs you: failed, missing or unresolved (danger); its platform not ready here, or stopped while it holds Stores (warning). */
export function attentionOf(m: MachineInfo, view: AvailableView): 'danger' | 'warning' | null {
  // a machine that cannot run here is a fix to make, not a failure; its record may still say failed or unreachable
  if (blockedOf(m, view)) return 'warning'
  if (machineState(m, view.status[m.name]).key === 'needs') return 'danger'
  return m.state === 'stopped' && m.stores.length > 0 ? 'warning' : null
}

/** What keeps `m` from running here (needs.ts machineBlock). */
export const blockedOf = (m: MachineInfo, view: AvailableView): Readiness | null => machineBlock(m, view)

/** The machine's mark: the native machine's is this computer's OS. */
export const glyphOs = (m: MachineInfo, view: AvailableView) => (m.platform === 'native' ? nativeGlyphOs(osOfView(view)) : undefined)

/** A machine's free disk in words, with a meter when its size is known. */
export function DiskLine({ m, view }: { m: MachineInfo, view: AvailableView }): ReactNode {
  const { t } = useMachinesContext()
  const live = view.status[m.name]
  const used = m.disk && live?.freeDisk != null ? Math.max(0, m.disk - live.freeDisk) : null
  const share = used !== null && m.disk ? used / m.disk : null
  if (live?.freeDisk == null) {
    return <span className={css.muted}>{t(m.platform === 'native' ? 'diskShared' : m.platform === 'docker' ? 'resourcesDocker' : m.state === 'running' ? 'diskUnreported' : 'diskWhileStopped')}</span>
  }
  return (
    <span className={css.diskLine}>
      {share !== null && <Meter share={share} label={t('diskUse')} className={css.diskMeter} />}
      <span>{m.disk != null ? t('diskFreeOf', { free: gib(live.freeDisk), total: gib(m.disk) }) : t('diskFree', { free: gib(live.freeDisk) })}</span>
    </span>
  )
}

function MachineBlock({ m, view, onOpen }: { m: MachineInfo, view: AvailableView, onOpen: () => void }): ReactNode {
  const { t, tw, kind, api, doctorT, useStartups, refusal } = useMachinesContext()
  const title = useMachineTitle()
  const startup = useStartups((all) => all[m.name])
  const live = view.status[m.name]
  const startingNow = startup?.status === 'running'
  const reason = startingNow ? null : downReason(m, live)
  const attention = startingNow ? null : attentionOf(m, view)
  const block = startingNow ? null : blockedOf(m, view)
  const { run, pending: localPending, error } = useMachineRun()
  const pending = localPending ?? (startingNow ? startup.kind : null)
  const [dialog, setDialog] = useState<'settings' | 'remove' | 'force-stop' | null>(null)
  const name = title(m)
  return (
    <Card tone={attention === 'danger' ? 'danger' : undefined} className={css.block} data-machine={m.name} aria-label={name}>
      <header className={css.blockHead}>
        <span className={css.blockIdentity}>
          <span className={css.blockGlyph} aria-hidden="true"><MachineGlyph platform={m.platform} os={glyphOs(m, view)} size={16} /></span>
          <span className={css.blockNames}>
            <button type="button" className={css.blockName} onClick={onOpen} title={t('openMachine', { name })}>{name}</button>
            <span className={css.blockSub}>{kind(m.platform)} · {tw(runtimeOf(m))}</span>
          </span>
        </span>
        <MachineStateChip m={m} live={live} pending={pending} blocked={!!block} />
        <DiskLine m={m} view={view} />
        <span className={css.blockActions}>
          {m.platform === 'native' ? <span className={css.muted}>{t(nativeNameKey(osOfView(view)))}</span> : block ? null : <PowerButton m={m} pending={pending} run={run} />}
          <MachineMenu m={m} pending={pending} run={run} onOpen={onOpen} onDialog={setDialog} />
        </span>
      </header>
      {block && <Blocked m={m} block={block} />}
      {!block && (reason || attention === 'danger') && (
        <div className={css.blockReason}>
          <span className={css.blockReasonText} title={reason ?? undefined}>{reason ?? t('needsInspect', { state: t(machineState(m, live).label ?? 'stateUnknown') })}</span>
          {attention === 'danger' && <DoctorAction api={api} t={doctorT} target="machine" name={m.name} label={doctorT('runDiagnostics')} />}
        </div>
      )}
      {error !== null && <div className={css.blockReason}><Refusal error={error} labels={refusal} compact /></div>}
      {startingNow && <div className={css.blockProgress}><MachineProgress name={m.name} compact /></div>}
      <Inventory m={m} view={view} limit={ROWS} onMore={onOpen} />
      <MachineDialogs m={m} dialog={dialog} onClose={() => setDialog(null)} pending={pending} run={run} />
    </Card>
  )
}
