/**
 * The machine page's Overview tab (MachineDetail.tsx picks the tab): two
 * cards, so the page fits on one screen. Sandboxes, Stores and images have
 * their own tabs.
 *
 * - Usage, from the sampler (machine.stats): processor and memory now with
 *   their last hour as a chart, and the data disk as free of total with one
 *   bar split into LayerFS, not LayerFS and free (machine.space, when
 *   offered). Its head says "Healthy" while nothing needs you; otherwise the
 *   notices that say what does stand above it, each linking to the tab that
 *   fixes it. A value LayerFS did not read says "Not read" and why, with no
 *   chart; without machine.stats the page's fact row stands in (`fallback`).
 * - Details (Spec.tsx): the machine's facts in a grid of three groups.
 *
 * Then, for a created VM, Remove.
 */
import { useMemo, type ReactNode } from 'react'
import { IconCheckCircleOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { Card, LinkButton } from '../ui/index.tsx'
import { useMachinesContext } from './context.tsx'
import { sandboxNeedsYou } from './Inventory.tsx'
import { useMetrics } from './MachineStats.tsx'
import { cpuScale, cpuShare, peakSince, sandboxAttention, sandboxMemory, sparkPaths, type MachineTab, type SparkSample } from './machine-tabs.ts'
import { OverviewAttention } from './MachineTabs.tsx'
import { HOUR_MS, latest, machineCpu, machineMemory, percent, sandboxTable } from './metrics.ts'
import { useWords } from './MetricsViews.tsx'
import { gib, sandboxesOn, type AvailableView, type MachineInfo, type MachineLive } from './model.ts'
import { spaceSize } from './space.ts'
import { SpaceBar, useDiskLevel, useMachineSpace } from './SpaceViews.tsx'
import { DangerZone, MachineDetailsCard } from './Spec.tsx'
import { diskScopeWords, resourceScopeWords, statsAskable } from './stats.ts'
import css from './machines.module.css'

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
      {read ? <UsageCard m={m} healthy={clear} onDisk={onDisk} /> : fallback}
      <MachineDetailsCard m={m} live={live} view={view} actions={actions} onTab={onTab} />
      <DangerZone m={m} pending={pending} onRemove={onRemove} />
    </div>
  )
}

// ---------------------------------------------------------------- usage

const CHART_W = 200
const CHART_H = 64

/** The hour as a chart with its top value on a faint top line; nothing when no value in it was read. */
function HourChart({ samples, max, maxText, from, to, label }: { samples: readonly SparkSample[], max: number, maxText: string, from: number, to: number, label: string }): ReactNode {
  const paths = sparkPaths(samples, from, to, max, CHART_W, CHART_H)
  if (!paths.length) return null
  return (
    <div className={css.ovSparkBox}>
      <span className={css.ovSparkMax} data-ov-spark-max>{maxText}</span>
      <svg className={css.ovChart} viewBox={`0 0 ${CHART_W} ${CHART_H}`} preserveAspectRatio="none" role="img" aria-label={label} data-ov-spark>
        <line className={css.ovSparkTop} x1={0} x2={CHART_W} y1={0.5} y2={0.5} />
        {paths.map((p, i) => (
          <g key={i}>
            {p.area && <path className={css.ovSparkArea} d={p.area} />}
            <path className={css.ovSparkLine} d={p.line} />
          </g>
        ))}
      </svg>
    </div>
  )
}

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

/** Processor, memory and data disk side by side, processor and memory over the last hour. */
function UsageCard({ m, healthy, onDisk }: { m: MachineInfo, healthy: boolean, onDisk: (() => void) | null }): ReactNode {
  const { t, tw } = useMachinesContext()
  const w = useWords()
  const { snapshot } = useMetrics(m.name)
  const space = useMachineSpace(m)
  const { level } = useDiskLevel(m)
  const entry = snapshot.machines[m.name]
  const cpu = useMemo(() => (entry ? machineCpu(entry.points, snapshot.tick) : []), [entry, snapshot.tick])
  const memory = useMemo(() => (entry ? machineMemory(entry.points) : []), [entry])
  const sandboxes = useMemo(() => sandboxMemory(sandboxTable(snapshot, m.name)), [snapshot, m.name])
  const stats = entry?.latest?.stats
  if (!stats) return null
  const r = stats.resources, d = stats.dataDisk
  const to = snapshot.now ?? Date.now(), from = to - HOUR_MS
  const at = entry.points.at(-1)?.t ?? null
  const scope = resourceScopeWords(r.scope), diskScope = diskScopeWords(d.scope)
  const notRead = w.reasons(r.reason) || w.reason(null)
  const cpuNow = latest(cpu)
  // under "Not read" the reason alone: a second sample still to come, or why LayerFS did not read it
  const cpuWhy = cpuNow?.reason ? (cpuNow.reason === 'first_sample' ? t('mxNeedsSecond') : w.reason(cpuNow.reason)) : r.cpuBusyUsec == null ? notRead : t('mxNeedsSecond')
  const cpuPeak = peakSince(cpu, from)
  const cpuTop = cpuScale(cpuPeak)
  const disk = space.offered ? space.read.data?.space ?? null : null
  const diskTotal = disk?.disk.total ?? r.diskTotal
  const diskFree = disk?.disk.free ?? r.diskFree
  const hasCpu = 'cpuBusyUsec' in r
  return (
    <Card className={css.ovUsage} tone={level === 'critical' ? 'danger' : level === 'low' ? 'warning' : undefined} data-ov-usage={m.name}>
      <header className={css.ovUsageHead}>
        <h3 className={css.columnTitle}>{t('ovUsage')}</h3>
        <span className={css.columnCount}>{t('ovHourNote')}</span>
        <span className={css.columnSpacer} />
        {healthy && <span className={css.ovHealthy} role="status" data-overview-status="healthy"><IconCheckCircleOutlineRegular size={13} />{t('ovHealthy')}</span>}
        {at != null && <span className={css.columnCount}>{t('ovReadAt', { time: new Date(at).toLocaleTimeString() })}</span>}
      </header>
      <div className={css.ovCols} data-cols={hasCpu ? 3 : 2}>
        {hasCpu && (
          <Column label={t('mxProcessor')} aside={r.cpus != null ? t('mxProcessorsMax', { n: String(r.cpus) }) : scope ? tw(scope) : null} data-ov-tile="cpu">
            {cpuNow && cpuNow.v != null ? <div className={css.ovValue} data-ov-cpu>{cpuShare(cpuNow.v)}<span className={css.ovUnit}>%</span></div>
              : <NotRead why={cpuWhy} />}
            <HourChart samples={cpu} max={cpuTop} maxText={`${Math.round(cpuTop * 100)} %`} from={from} to={to} label={t('mxProcessor')} />
            {cpuPeak != null && <div className={css.ovFoot}><span>{t('mxHourAgo')}</span><span>{t('ovPeak', { value: `${cpuShare(cpuPeak)} %` })}</span><span>{t('mxNow')}</span></div>}
          </Column>
        )}
        <Column label={t('memory')} aside={scope ? tw(scope) : null} data-ov-tile="memory">
          {r.memoryTotal != null && r.memoryUsed != null ? (
            <>
              <div className={css.ovValue}>{gib(r.memoryUsed)}<span className={css.ovValueOf}>{t('ovOfTotal', { total: gib(r.memoryTotal) })}</span></div>
              <HourChart samples={memory} max={r.memoryTotal} maxText={gib(r.memoryTotal)} from={from} to={to} label={t('memory')} />
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
