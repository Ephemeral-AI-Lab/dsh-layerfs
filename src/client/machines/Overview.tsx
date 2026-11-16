/**
 * The machine page's Overview tab (MachineDetail.tsx picks the tab):
 *
 * - a status line ("Healthy · 2 of 2 Sandboxes running · 79 % of the disk
 *   free · worker up 5 min") while nothing needs you, else the notices that
 *   say what does, each linking to the tab that fixes it;
 * - three resource tiles from the sampler (machine.stats): processor and
 *   memory now with their last hour as a sparkline, and the data disk as one
 *   bar split into LayerFS, not LayerFS and free (machine.space, when
 *   offered). A value LayerFS did not read says "Not read" and why, with no
 *   chart; without machine.stats the page's fact row stands in (`fallback`);
 * - what is on the machine: its busiest Sandboxes with memory and disk, its
 *   Stores and the image cache, each list linking to its tab;
 * - the Details card (Spec.tsx) and, for a created VM, Remove.
 */
import { useMemo, type ReactNode } from 'react'
import { IconCheckCircleOutlineRegular, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { Card, LinkButton, Meter } from '../ui/index.tsx'
import { useMachinesContext } from './context.tsx'
import { SandboxGlyph } from './icons.tsx'
import { ColumnHead, StoreRows, sandboxNeedsYou, useStoreRows } from './Inventory.tsx'
import { useMetrics } from './MachineStats.tsx'
import { peakSince, sandboxAttention, sandboxMemory, sandboxTabRows, sparkPaths, type MachineTab, type SparkSample } from './machine-tabs.ts'
import { OverviewAttention } from './MachineTabs.tsx'
import { HOUR_MS, latest, machineCpu, machineMemory, percent, sandboxTable, upTime } from './metrics.ts'
import { useWords } from './MetricsViews.tsx'
import { gib, projectRef, sandboxesOn, shortSandbox, type AvailableView, type MachineInfo, type MachineLive } from './model.ts'
import { spaceSize } from './space.ts'
import { SpaceBar, useDiskLevel, useMachineSpace } from './SpaceViews.tsx'
import { DangerZone, MachineDetailsCard } from './Spec.tsx'
import { diskScopeWords, liveCounts, resourceScopeWords, statsAskable } from './stats.ts'
import css from './machines.module.css'

const SANDBOX_ROWS = 5
const STORE_ROWS = 4

/**
 * `troubled`: the page already shows a notice of the machine's own (down,
 * blocked, a refused action), so the status line does not call it healthy.
 * `fallback`: the facts shown when the sampler has not read the machine.
 */
export function MachineOverview({ m, view, live, troubled, notices, fallback, actions, pending, onTab, hasDiskTab, onRemove }: {
  m: MachineInfo
  view: AvailableView
  live: MachineLive | undefined
  troubled: boolean
  notices: ReactNode
  fallback: ReactNode
  actions: ReactNode
  pending: string | null
  onTab: (tab: MachineTab) => void
  hasDiskTab: boolean
  onRemove: () => void
}): ReactNode {
  const { t } = useMachinesContext()
  const { offered, snapshot } = useMetrics(m.name)
  const space = useMachineSpace(m)
  const { level } = useDiskLevel(m)
  const records = sandboxesOn(view, m)
  const attention = sandboxAttention(records, space.read.data?.space?.sandboxes ?? null, sandboxNeedsYou)
  const read = offered && statsAskable(m) && !!snapshot.machines[m.name]?.latest?.stats
  const clear = !troubled && level !== 'low' && level !== 'critical' && attention.gone === 0 && attention.needsYou === 0
  return (
    <div className={css.ovStack} data-machine-overview={m.name}>
      {notices}
      {clear ? (read && <StatusLine m={m} view={view} />) : <OverviewAttention m={m} view={view} onTab={onTab} />}
      {read ? <ResourceTiles m={m} onTab={hasDiskTab ? onTab : null} /> : fallback}
      <section className={css.ovLower} aria-label={t('ovContents')}>
        <Contents m={m} view={view} onTab={onTab} />
        <MachineDetailsCard m={m} live={live} view={view} actions={actions} />
      </section>
      <DangerZone m={m} pending={pending} onRemove={onRemove} />
    </div>
  )
}

// ---------------------------------------------------------------- status line

/** "Healthy · 2 of 2 Sandboxes running · 79 % of the disk free · worker up 5 min", and when the sampler last read the machine. */
function StatusLine({ m, view }: { m: MachineInfo, view: AvailableView }): ReactNode {
  const { t } = useMachinesContext()
  const { snapshot } = useMetrics(m.name)
  const entry = snapshot.machines[m.name]
  const stats = entry?.latest?.stats
  if (!stats) return null
  const counts = liveCounts(sandboxesOn(view, m))
  const r = stats.resources
  const now = snapshot.now ?? Date.now()
  const at = entry.points.at(-1)?.t ?? null
  const parts = [
    counts.total ? t('ovRunning', { running: String(counts.running), total: String(counts.total) }) : t('ovNoSandboxes'),
    r.diskFree != null && r.diskTotal ? t('ovDiskFreeShare', { share: percent(r.diskFree / r.diskTotal) }) : null,
    stats.worker?.startedAt != null ? t('ovWorkerUp', { time: upTime(stats.worker.startedAt, now) }) : null,
  ].filter(Boolean)
  return (
    <div className={css.ovStatus} role="status" data-overview-status="healthy">
      <span className={css.ovStatusTitle}><IconCheckCircleOutlineRegular size={14} />{t('ovHealthy')}</span>
      {parts.map((p) => <span key={p}>{p}</span>)}
      {at != null && <span className={css.ovStatusTime}>{t('ovReadAt', { time: new Date(at).toLocaleTimeString() })}</span>}
    </div>
  )
}

// ---------------------------------------------------------------- resource tiles

const SPARK_W = 200
const SPARK_H = 40

/** The hour as a sparkline; nothing when no value in it was read. */
function Spark({ samples, max, from, to, label }: { samples: readonly SparkSample[], max: number, from: number, to: number, label: string }): ReactNode {
  const paths = sparkPaths(samples, from, to, max, SPARK_W, SPARK_H)
  if (!paths.length) return null
  return (
    <svg className={css.ovSpark} viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none" role="img" aria-label={label} data-ov-spark>
      {paths.map((p, i) => (
        <g key={i}>
          {p.area && <path className={css.ovSparkArea} d={p.area} />}
          <path className={css.ovSparkLine} d={p.line} />
        </g>
      ))}
    </svg>
  )
}

/** One tile: a label and its scope in the head, the value, then what the caller draws under it. */
function Tile({ label, aside, asideTitle, tone, children, ...data }: { label: string, aside?: string | null, asideTitle?: string | null, tone?: 'warning' | 'danger' | undefined, children: ReactNode } & Record<`data-${string}`, string | undefined>): ReactNode {
  return (
    <Card className={css.ovTile} tone={tone} {...data}>
      <div className={css.ovTileHead}><span>{label}</span>{aside && <span title={asideTitle ?? aside}>{aside}</span>}</div>
      {children}
    </Card>
  )
}

/** "Not read" and why, in a tile's value place. */
function NotRead({ why }: { why: string }): ReactNode {
  const { t } = useMachinesContext()
  return <><div className={css.ovNotRead}>{t('ovNotRead')}</div><div className={css.ovWhy} title={why}>{why}</div></>
}

/** Processor, memory and data disk, each now and (processor, memory) over the last hour. */
function ResourceTiles({ m, onTab }: { m: MachineInfo, onTab: ((tab: MachineTab) => void) | null }): ReactNode {
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
  const scope = resourceScopeWords(r.scope), diskScope = diskScopeWords(d.scope)
  const notRead = w.reasons(r.reason) || w.reason(null)
  const cpuNow = latest(cpu)
  // under "Not read" the reason alone: a second sample still to come, or why LayerFS did not read it
  const cpuWhy = cpuNow?.reason ? (cpuNow.reason === 'first_sample' ? t('mxNeedsSecond') : w.reason(cpuNow.reason)) : r.cpuBusyUsec == null ? notRead : t('mxNeedsSecond')
  const cpuPeak = peakSince(cpu, from)
  const disk = space.offered ? space.read.data?.space ?? null : null
  const diskTotal = disk?.disk.total ?? r.diskTotal
  const diskFree = disk?.disk.free ?? r.diskFree
  return (
    <section className={css.ovTiles} aria-label={t('ovResources')}>
      {'cpuBusyUsec' in r && (
        <Tile label={t('mxProcessor')} aside={r.cpus != null ? t('mxProcessorsMax', { n: String(r.cpus) }) : scope ? tw(scope) : null} data-ov-tile="cpu">
          {cpuNow && cpuNow.v != null ? <div className={css.ovValue}>{percent(cpuNow.v)}</div>
            : <NotRead why={cpuWhy} />}
          <Spark samples={cpu} max={1} from={from} to={to} label={t('mxProcessor')} />
          {cpuPeak != null && <div className={css.ovFoot}><span>{t('ovLastHour')}</span><span>{t('ovPeak', { value: percent(cpuPeak) })}</span></div>}
        </Tile>
      )}
      <Tile label={t('memory')} aside={scope ? tw(scope) : null} data-ov-tile="memory">
        {r.memoryTotal != null && r.memoryUsed != null ? (
          <>
            <div className={css.ovValue}>{gib(r.memoryUsed)}<span className={css.ovValueOf}>{t('ovOfTotal', { total: gib(r.memoryTotal) })}</span></div>
            <Meter share={r.memoryTotal > 0 ? r.memoryUsed / r.memoryTotal : 0} label={t('memoryUse')} className={css.ovMeter} />
            <Spark samples={memory} max={r.memoryTotal} from={from} to={to} label={t('memory')} />
            {sandboxes != null && <div className={css.ovFoot}><span>{t('ovSandboxesUse', { size: gib(sandboxes) })}</span></div>}
          </>
        ) : <NotRead why={notRead} />}
      </Tile>
      <Tile label={t('disk')} aside={disk?.disk.fs ?? (diskScope ? tw(diskScope) : null)} asideTitle={diskScope ? tw(diskScope) : null} tone={level === 'critical' ? 'danger' : level === 'low' ? 'warning' : undefined} data-ov-tile="disk">
        {diskTotal != null && diskFree != null ? (
          <>
            <div className={css.ovValue}>{gib(diskFree)}<span className={css.ovValueOf}>{t('ovFreeOf', { total: gib(diskTotal) })}</span></div>
            {disk ? <SpaceBar space={disk} className={css.ovDiskBar} />
              : <Meter share={diskTotal > 0 ? 1 - diskFree / diskTotal : 0} label={t('diskUse')} className={css.ovMeter} />}
            {disk && (
              <div className={css.ovKeys}>
                <span><i className={css.ovKey} data-part="layerfs" />{`LayerFS ${spaceSize(disk.layerfs)}`}</span>
                {disk.outside != null && <span><i className={css.ovKey} data-part="outside" />{t('ovNotLayerfs', { size: spaceSize(disk.outside) })}</span>}
              </div>
            )}
            <div className={css.ovFoot}>
              <span>{d.inodesFree != null ? t('mxInodesFree', { n: d.inodesFree.toLocaleString() }) : null}</span>
              {onTab && <LinkButton onClick={() => onTab('disk')}>{t('ovWhereItGoes')}</LinkButton>}
            </div>
          </>
        ) : <NotRead why={notRead} />}
      </Tile>
    </section>
  )
}

// ---------------------------------------------------------------- what is on it

/** The busiest Sandboxes (those that need you first) with memory and disk, then the Stores and the image cache. */
function Contents({ m, view, onTab }: { m: MachineInfo, view: AvailableView, onTab: (tab: MachineTab) => void }): ReactNode {
  const { t, go } = useMachinesContext()
  const w = useWords()
  const metrics = useMetrics(m.name)
  const space = useMachineSpace(m)
  const records = sandboxesOn(view, m)
  const table = useMemo(() => (metrics.offered ? sandboxTable(metrics.snapshot, m.name) : []), [metrics.offered, metrics.snapshot, m.name])
  const spaceData = space.offered ? space.read.data?.space ?? null : null
  const { rows } = sandboxTabRows(records, table, spaceData?.sandboxes ?? null, sandboxNeedsYou, false)
  const shown = rows.slice(0, SANDBOX_ROWS)
  const memOf = (r: (typeof rows)[number]) => (r.metrics && !r.metrics.gap && r.metrics.row?.live !== false ? r.metrics.row?.usage?.memoryCurrent ?? null : null)
  // the bars compare the Sandboxes shown: the busiest is full
  const memTop = Math.max(0, ...shown.map((r) => memOf(r) ?? 0))
  const counts = liveCounts(records)
  const stores = useStoreRows(m, view)
  const images = spaceData?.parts.images ?? null
  const cols = ['minmax(0, 1.6fr)', 'minmax(0, 1fr)', ...(metrics.offered ? ['minmax(0, 1.3fr)'] : []), ...(space.offered ? ['minmax(64px, auto)'] : [])].join(' ')
  return (
    <Card className={css.ovContents} data-overview-contents={m.name}>
      <section aria-label={t('sandboxes')}>
        <header className={css.columnHead}>
          <h3 className={css.columnTitle}>{t('sandboxes')}</h3>
          <span className={css.columnCount}>{records.length ? `${records.length} · ${t('countRunning', { n: String(counts.running) })}` : '0'}</span>
          <span className={css.columnSpacer} />
          <LinkButton onClick={() => onTab('sandboxes')}>{t('ovAll')}</LinkButton>
        </header>
        {shown.length === 0 ? <p className={css.inventoryEmpty}>{t('noSandboxesHere')}</p> : (
          <ul className={css.ovSbRows}>
            {shown.map((r) => {
              const b = r.record
              const mx = r.metrics
              const mem = memOf(r)
              const why = mx ? w.reason(mx.gap ?? mx.row?.usageReason ?? mx.row?.liveReason) : undefined
              const dot = !b ? 'idle' : sandboxNeedsYou(b) ? 'error' : b.state === 'running' ? 'done' : 'idle'
              return (
                <li key={r.name} className={css.ovSbRow} style={{ gridTemplateColumns: cols }} data-ov-sandbox={r.name}>
                  <button type="button" className={css.ovSbName} onClick={() => go({ kind: 'sandbox', machine: m.name, name: r.name })} title={r.name}>
                    <StateDot state={dot} size={6} />
                    <SandboxGlyph size={13} />
                    <span className={css.mono}>{shortSandbox(r.name)}</span>
                  </button>
                  <span className={css.ovSbMuted}>{b?.project ? projectRef(b.project).name : '—'}</span>
                  {metrics.offered && (
                    <span className={css.ovSbMem} title={mem == null ? why : undefined}>
                      {mem != null && memTop > 0 ? <Meter share={mem / memTop} label={t('memoryUse')} tone="neutral" className={css.ovSbMeter} /> : null}
                      <span className={css.ovNum}>{mem != null ? gib(mem) : '—'}</span>
                    </span>
                  )}
                  {space.offered && <span className={css.ovNum}>{r.space?.bytes != null ? spaceSize(r.space.bytes) : '—'}</span>}
                </li>
              )
            })}
          </ul>
        )}
        {rows.length > SANDBOX_ROWS && <LinkButton onClick={() => onTab('sandboxes')}>{t('ovMore', { n: String(rows.length - SANDBOX_ROWS) })}</LinkButton>}
      </section>
      <section aria-label={t('stores')}>
        <ColumnHead label={t('stores')} count={stores.length} action={<LinkButton onClick={() => onTab('stores')}>{t('ovAll')}</LinkButton>} />
        {stores.length === 0 ? <p className={css.inventoryEmpty}>{t('ovNoStores')}</p>
          : <StoreRows rows={stores.slice(0, STORE_ROWS)} more={Math.max(0, stores.length - STORE_ROWS)} onMore={() => onTab('stores')} />}
        {images != null && images > 0 && (
          <div className={css.ovImages} data-ov-images>
            <span>{t('spaceRowImages')}</span>
            <span className={css.ovSbMuted}>{t('ovImageUsers')}</span>
            <span className={css.ovNum}>{spaceSize(images)}</span>
          </div>
        )}
      </section>
    </Card>
  )
}
