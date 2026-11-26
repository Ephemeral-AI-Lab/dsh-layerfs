/**
 * The machine page's Overview tab (MachineDetail.tsx picks the tab): two
 * cards, so the page fits on one screen. Sandboxes, Stores and images have
 * their own tabs.
 *
 * - Usage, from the sampler's last read (machine.stats): processor, memory
 *   and data disk as they are now, each a figure over one bar, no history.
 *   The data disk's bar is split into LayerFS, not LayerFS and free
 *   (machine stats --with space, when offered). A processor LayerFS cannot read on this
 *   system (`cpu_unsupported`, macOS) has no column. Its head says "Healthy" while nothing needs you; otherwise the
 *   notices that say what does stand above it, each linking to the tab that
 *   fixes it. A value LayerFS did not read says "Not read" and why;
 *   without machine.stats the page's fact row stands in (`fallback`).
 * - Details (Spec.tsx): the machine's facts in a grid of three groups.
 *
 * Then, for a created VM, Remove.
 */
import { useMemo, type ReactNode } from 'react'
import { IconCheckCircleOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { Card, LinkButton, Meter } from '../ui/index.tsx'
import { useMachinesContext } from './context.tsx'
import { sandboxNeedsYou } from './Inventory.tsx'
import { useMetrics } from './MachineStats.tsx'
import { cpuShare, sandboxAttention, sandboxMemory, type MachineTab } from './machine-tabs.ts'
import { OverviewAttention } from './MachineTabs.tsx'
import { latest, machineCpu, percent, sandboxTable } from './metrics.ts'
import { useWords } from './MetricsViews.tsx'
import { gib, sandboxesOn, type AvailableView, type MachineInfo, type MachineLive } from './model.ts'
import { spaceSize } from './space.ts'
import { SpaceBar, useDiskLevel, useMachineSpace } from './SpaceViews.tsx'
import { DangerZone, MachineDetailsCard } from './Spec.tsx'
import { diskScopeWords, resourceScopeWords, statsAskable } from './stats.ts'
import css from './machines.module.css'
import { clockTime } from '../ui/locale-sync.ts'

/**
 * `troubled`: the page already shows a notice of the machine's own (down,
 * blocked, a refused action), so the Usage head does not call it healthy.
 * `fallback`: the facts shown when the sampler has not read the machine.
 * `onDisk`: where "Where it goes" leads; without it the link is not drawn.
 */
export function MachineOverview({ m, view, live, troubled, notices, fallback, actions, pending, onTab, onDisk, onRemove }: {
  m: MachineInfo
  view: AvailableView
  live: MachineLive | undefined
  troubled: boolean
  notices: ReactNode
  fallback: ReactNode
  actions: ReactNode
  pending: string | null
  onTab: (tab: MachineTab) => void
  onDisk: (() => void) | null
  onRemove: () => void
}): ReactNode {
  const { offered, snapshot } = useMetrics(m.name)
  const space = useMachineSpace(m)
  const { level } = useDiskLevel(m)
  const attention = sandboxAttention(sandboxesOn(view, m), space.read.data?.space?.sandboxes ?? null, sandboxNeedsYou)
  const read = offered && statsAskable(m) && !!snapshot.machines[m.name]?.latest?.stats
  const clear = !troubled && level !== 'low' && level !== 'critical' && attention.gone === 0 && attention.needsYou === 0
  return (
    <div className={css.ovStack} data-machine-overview={m.name}>
      {notices}
      {!clear && <OverviewAttention m={m} view={view} onTab={onTab} onDisk={onDisk} />}
      {read ? <UsageCard m={m} healthy={clear} onDisk={onDisk} space={space} /> : fallback}
      <MachineDetailsCard m={m} live={live} view={view} actions={actions} onTab={onTab} />
      <DangerZone m={m} pending={pending} onRemove={onRemove} />
    </div>
  )
}

// ---------------------------------------------------------------- usage

/** One column of the Usage card: its label (and what it is of), then what the caller draws. */
function Column({ label, aside, asideTitle, children, ...data }: { label: string, aside?: string | null, asideTitle?: string | null, children: ReactNode } & Record<`data-${string}`, string | undefined>): ReactNode {
  return (
    <div className={css.ovCol} {...data}>
      <div className={css.ovColHead} title={asideTitle ?? aside ?? undefined}>{aside ? `${label} · ${aside}` : label}</div>
      {children}
    </div>
  )
}

/** "Not read" and why, in a column's value place. */
function NotRead({ why }: { why: string }): ReactNode {
  const { t } = useMachinesContext()
  return <><div className={css.ovNotRead}>{t('ovNotRead')}</div><div className={css.ovWhy} title={why}>{why}</div></>
}

/** Processor, memory and data disk side by side, as the last read found them. */
function UsageCard({ m, healthy, onDisk, space }: { m: MachineInfo, healthy: boolean, onDisk: (() => void) | null, space: ReturnType<typeof useMachineSpace> }): ReactNode {
  const { t, tw } = useMachinesContext()
  const w = useWords()
  const { snapshot } = useMetrics(m.name)
  // The overview reads the space once and hands the one answer to both cards.
  const { level } = useDiskLevel(m)
  const entry = snapshot.machines[m.name]
  const cpu = useMemo(() => (entry ? machineCpu(entry.points, snapshot.tick) : []), [entry, snapshot.tick])
  const sandboxes = useMemo(() => sandboxMemory(sandboxTable(snapshot, m.name)), [snapshot, m.name])
  const stats = entry?.latest?.stats
  if (!stats) return null
  const r = stats.resources, d = stats.dataDisk
  const at = entry.points.at(-1)?.t ?? null
  const scope = resourceScopeWords(r.scope), diskScope = diskScopeWords(d.scope)
  const notRead = w.reasons(r.reason) || w.reason(null)
  const cpuNow = latest(cpu)
  // under "Not read" the reason alone: a second sample still to come, or why LayerFS did not read it
  const cpuWhy = cpuNow?.reason ? (cpuNow.reason === 'first_sample' ? t('mxNeedsSecond') : w.reason(cpuNow.reason)) : r.cpuBusyUsec == null ? notRead : t('mxNeedsSecond')
  const disk = space.offered ? space.read.data?.space ?? null : null
  const diskTotal = disk?.disk.total ?? r.diskTotal
  const diskFree = disk?.disk.free ?? r.diskFree
  // absent from an older build's answer, and never readable on macOS: no column
  const hasCpu = 'cpuBusyUsec' in r && !(r.reason ?? '').split(',').some((x) => x.trim() === 'cpu_unsupported')
  return (
    <Card className={css.ovUsage} tone={level === 'critical' ? 'danger' : level === 'low' ? 'warning' : undefined} data-ov-usage={m.name}>
      <header className={css.ovUsageHead}>
        <h3 className={css.columnTitle}>{t('ovUsage')}</h3>
        <span className={css.columnSpacer} />
        {healthy && <span className={css.ovHealthy} role="status" data-overview-status="healthy"><IconCheckCircleOutlineRegular size={13} />{t('ovHealthy')}</span>}
        {at != null && <span className={css.columnCount}>{t('ovReadAt', { time: clockTime(at) })}</span>}
      </header>
      <div className={css.ovCols} data-cols={hasCpu ? 3 : 2}>
        {hasCpu && (
          <Column label={t('mxProcessor')} aside={r.cpus != null ? t('mxProcessorsMax', { n: String(r.cpus) }) : scope ? tw(scope) : null} data-ov-tile="cpu">
            {cpuNow && cpuNow.v != null ? (
              <>
                <div className={css.ovValue} data-ov-cpu>{cpuShare(cpuNow.v)}<span className={css.ovUnit}>%</span></div>
                <Meter share={cpuNow.v} label={t('mxProcessor')} tone="neutral" className={css.ovBar} />
              </>
            ) : <NotRead why={cpuWhy} />}
          </Column>
        )}
        <Column label={t('memory')} aside={scope ? tw(scope) : null} data-ov-tile="memory">
          {r.memoryTotal != null && r.memoryUsed != null ? (
            <>
              <div className={css.ovValue}>{gib(r.memoryUsed)}<span className={css.ovValueOf}>{t('ovOfTotal', { total: gib(r.memoryTotal) })}</span></div>
              <Meter share={r.memoryTotal > 0 ? r.memoryUsed / r.memoryTotal : 0} label={t('memoryUse')} tone="neutral" className={css.ovBar} />
              <div className={css.ovFoot}>
                <span>{t('ovUsedShare', { share: percent(r.memoryTotal > 0 ? r.memoryUsed / r.memoryTotal : 0) })}</span>
                {sandboxes != null && <span>{t('ovSandboxesUse', { size: gib(sandboxes) })}</span>}
              </div>
            </>
          ) : <NotRead why={notRead} />}
        </Column>
        <Column label={t('ovDataDisk')} aside={disk?.disk.fs ?? null} asideTitle={diskScope ? tw(diskScope) : null} data-ov-tile="disk">
          {diskTotal != null && diskFree != null ? (
            <>
              <div className={css.ovValue}>{gib(diskFree)}<span className={css.ovValueOf}>{t('ovFreeOf', { total: gib(diskTotal) })}</span></div>
              {disk ? <SpaceBar space={disk} className={css.ovDiskBar} />
                : <span className={css.ovDiskMeter} data-ov-disk-meter><span style={{ width: `${Math.max(0, Math.min(100, (1 - diskFree / diskTotal) * 100))}%` }} /></span>}
              {disk && (
                <div className={css.ovKeys}>
                  <span><i className={css.ovKey} data-part="layerfs" />{`LayerFS ${spaceSize(disk.layerfs)}`}</span>
                  {disk.outside != null && <span><i className={css.ovKey} data-part="outside" />{t('ovNotLayerfs', { size: spaceSize(disk.outside) })}</span>}
                </div>
              )}
              <div className={css.ovFoot}>
                <span>{d.inodesFree != null ? t('mxInodesFree', { n: d.inodesFree.toLocaleString() }) : null}</span>
                {onDisk && <LinkButton onClick={onDisk}>{t('ovWhereItGoes')}</LinkButton>}
              </div>
            </>
          ) : <NotRead why={notRead} />}
        </Column>
      </div>
    </Card>
  )
}
