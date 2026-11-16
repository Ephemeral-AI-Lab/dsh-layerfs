/**
 * The metrics views (layerfs-project#182 D3), drawn from the host's sampler
 * (metrics.ts): a machine card's meters, a machine page's figures, its hour
 * of processor and memory and its Sandboxes by memory, and a Sandbox page's
 * figures and charts.
 *
 * Everything renders from field presence, never from a platform name: an
 * absent field hides its figure, a `null` shows a dash and the reason, and an
 * unknown `scope` or reason word is shown as it came. A processor figure is a
 * dash until a second sample exists. The history is the host's memory: a dsh
 * restart starts it empty, and the charts say so.
 */
import { useMemo, type ReactNode } from 'react'
import clsx from 'clsx'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { ChartGroup, Figure, Figures, LineArea, type ChartSample } from '../ui/LineArea.tsx'
import { Card, Meter } from '../ui/index.tsx'
import { useMachinesContext } from './context.tsx'
import { SandboxGlyph } from './icons.tsx'
import {
  HOUR_MS, latest, machineCpu, machineMemory, percent, processors, sandboxFigures, sandboxTable, upTime,
  type MetricsSnapshot, type Sample,
} from './metrics.ts'
import { useMetrics } from './MachineStats.tsx'
import { bytes, gib, shortSandbox, type MachineInfo } from './model.ts'
import { diskScopeWords, reasonList, reasonWords, resourceScopeWords, statsAskable, type MachineStats } from './stats.ts'
import css from './machines.module.css'

const clock = (t: number): string => new Date(t).toLocaleTimeString()

/** The page's words for a gap, a dash's reason and the charts' frame. */
function useWords() {
  const { t, tw } = useMachinesContext()
  const reason = (r: string | undefined | null): string => tw(reasonWords(r || 'not_observed'))
  return {
    reason,
    gap: (r: string | undefined): string => (r === 'first_sample' ? t('mxNeedsSecond') : t('mxNotRead', { reason: reason(r) })),
    reasons: (r: string | null): string => reasonList(r).map(tw).join(', '),
  }
}

/** A dash with its reason (a `null` LayerFS answered, or a gap): the reason on its own small line, so a figure keeps its width. */
function Dash({ why }: { why: string }): ReactNode {
  return <span className={css.mxDash} data-mx-dash title={why}><span>—</span><span className={css.mxWhy}>{why}</span></span>
}

/** The span every chart of a page draws: the hour up to the host's last answer. */
function span(snapshot: MetricsSnapshot): { from: number, to: number } {
  const to = snapshot.now ?? Date.now()
  return { from: to - HOUR_MS, to }
}

/** "Kept in memory since 12:00:03. A dsh restart starts the charts empty." */
function HistoryNote({ snapshot }: { snapshot: MetricsSnapshot }): ReactNode {
  const { t } = useMachinesContext()
  return <p className={css.muted} data-mx-history>{t('mxHistoryNote', { time: snapshot.epoch ? new Date(snapshot.epoch).toLocaleString() : '—' })}</p>
}

// ---------------------------------------------------------------- machine card

/**
 * A machine card's meters: memory used of total, data disk used of total and
 * live Sandboxes of recorded, from the sampler's last answer. A machine the
 * sampler does not read shows what its record was created with, labelled
 * "allocated", and "Not read" with why.
 */
export function MachineMeters({ m }: { m: MachineInfo }): ReactNode {
  const { t } = useMachinesContext()
  const w = useWords()
  const { offered, snapshot } = useMetrics(m.name)
  if (!offered) return null
  const entry = snapshot.machines[m.name]
  const stats = statsAskable(m) ? entry?.latest?.stats ?? null : null
  if (!stats) {
    const last = entry?.points.at(-1)
    const why = !statsAskable(m) ? w.reason('machine_stopped') : last && !last.values ? w.reason(last.code) : snapshot.loaded ? w.reason('not_observed') : null
    const allocated = [m.memory != null ? t('mxAllocatedMemory', { size: gib(m.memory) }) : null, m.disk != null ? t('mxAllocatedDisk', { size: gib(m.disk) }) : null].filter(Boolean).join(' · ')
    return (
      <span className={css.meters} data-mx-meters="not-read">
        {allocated && <span data-mx-allocated>{allocated}</span>}
        <span className={css.muted} data-mx-not-read>{why ? t('mxNotRead', { reason: why }) : t('notObservedYet')}</span>
      </span>
    )
  }
  const r = stats.resources, b = stats.sandboxes
  return (
    <span className={css.meters} data-mx-meters="read">
      {r.memoryTotal != null && r.memoryUsed != null
        ? <span className={css.meterItem} data-mx-memory><Meter share={r.memoryTotal > 0 ? r.memoryUsed / r.memoryTotal : 0} label={t('memoryUse')} className={css.diskMeter} />{t('mxMemoryOf', { used: gib(r.memoryUsed), total: gib(r.memoryTotal) })}</span>
        : <span className={css.muted} data-mx-memory="null">{t('mxMemoryNotRead', { reason: w.reasons(r.reason) || w.reason(null) })}</span>}
      {r.diskTotal != null && r.diskUsed != null
        ? <span className={css.meterItem} data-mx-disk><Meter share={r.diskTotal > 0 ? r.diskUsed / r.diskTotal : 0} label={t('diskUse')} className={css.diskMeter} />{t('mxDiskOf', { used: gib(r.diskUsed), total: gib(r.diskTotal) })}</span>
        : <span className={css.muted} data-mx-disk="null">{t('mxDiskNotRead', { reason: w.reasons(r.reason) || w.reason(null) })}</span>}
      <span className={css.muted} data-mx-live>{b.live != null ? t('mxLiveOf', { live: String(b.live), recorded: b.recorded != null ? String(b.recorded) : '—' }) : t('mxLiveNotRead', { reason: w.reason(stats.reason) })}</span>
    </span>
  )
}

// ---------------------------------------------------------------- machine page

/** The machine's processor share now: the newest rate, or why there is none; null when the build has no counters (hidden). */
function machineCpuNow(points: MetricsSnapshot['machines'][string]['points'], tick: number): Sample | null {
  return latest(machineCpu(points, tick))
}

/**
 * A machine page's figures: processor %, memory used of total, data disk used
 * of total with free inodes, whose processor and memory they are (`scope`),
 * and the worker's version and up time.
 */
export function MachineFigures({ m }: { m: MachineInfo }): ReactNode {
  const { t, tw } = useMachinesContext()
  const w = useWords()
  const { offered, snapshot } = useMetrics(m.name)
  if (!offered || !statsAskable(m)) return null
  const entry = snapshot.machines[m.name]
  const stats = entry?.latest?.stats
  if (!stats) return null
  const r = stats.resources, d = stats.dataDisk
  const cpu = entry ? machineCpuNow(entry.points, snapshot.tick) : null
  const scope = resourceScopeWords(r.scope), diskScope = diskScopeWords(d.scope)
  const now = snapshot.now ?? Date.now()
  return (
    <Figures label={t('mxFigures')}>
      {'cpuBusyUsec' in r && (
        <Figure label={t('mxProcessor')} gap={!cpu || cpu.v == null} data-mx-figure="cpu" sub={scope ? tw(scope) : undefined}>
          {cpu && cpu.v != null ? percent(cpu.v) : <Dash why={w.gap(cpu?.reason ?? (r.cpuBusyUsec == null ? w.reasons(r.reason) || undefined : 'first_sample'))} />}
        </Figure>
      )}
      <Figure label={t('memory')} gap={r.memoryUsed == null} data-mx-figure="memory" sub={!('cpuBusyUsec' in r) && scope ? tw(scope) : undefined}>
        {r.memoryTotal != null && r.memoryUsed != null
          ? <><Meter share={r.memoryTotal > 0 ? r.memoryUsed / r.memoryTotal : 0} label={t('memoryUse')} />{t('mxOf', { used: gib(r.memoryUsed), total: gib(r.memoryTotal) })}</>
          : <Dash why={w.reasons(r.reason) || w.reason(null)} />}
      </Figure>
      <Figure label={t('disk')} gap={r.diskUsed == null} data-mx-figure="disk"
        sub={[d.inodesFree != null ? t('mxInodesFree', { n: d.inodesFree.toLocaleString() }) : null, diskScope ? tw(diskScope) : null].filter(Boolean).join(' · ') || undefined}>
        {r.diskTotal != null && r.diskUsed != null
          ? <><Meter share={r.diskTotal > 0 ? r.diskUsed / r.diskTotal : 0} label={t('diskUse')} />{t('mxOf', { used: gib(r.diskUsed), total: gib(r.diskTotal) })}</>
          : <Dash why={w.reasons(r.reason) || w.reason(null)} />}
      </Figure>
      {stats.worker && (
        <Figure label={t('worker')} data-mx-figure="worker" sub={stats.worker.startedAt != null ? t('mxUpFor', { time: upTime(stats.worker.startedAt, now) }) : undefined}>
          {stats.worker.version ? t('workerVersion', { version: stats.worker.version }) : <Dash why={w.reason(null)} />}
        </Figure>
      )}
    </Figures>
  )
}

/** The machine's processor and memory over the last hour; the processor chart only with a build that has the counters. */
export function MachineCharts({ m }: { m: MachineInfo }): ReactNode {
  const { t } = useMachinesContext()
  const w = useWords()
  const { offered, snapshot } = useMetrics(m.name)
  const entry = snapshot.machines[m.name]
  const cpu = useMemo(() => (entry ? machineCpu(entry.points, snapshot.tick) : []), [entry, snapshot.tick])
  const memory = useMemo(() => (entry ? machineMemory(entry.points) : []), [entry])
  if (!offered || !snapshot.loaded) return null
  const { from, to } = span(snapshot)
  const stats = entry?.latest?.stats
  const hasCpu = !!entry?.points.some((p) => p.values && 'cpuBusyUsec' in p.values) || (!!stats && 'cpuBusyUsec' in stats.resources)
  // the scale: the machine's own total, else its recorded size (never read: no label)
  const read = Math.max(0, ...memory.map((s) => s.v ?? 0))
  const known = stats?.resources.memoryTotal ?? (m.memory != null && m.memory > 0 ? m.memory : read > 0 ? read : null)
  const total = known ?? 1
  const frame = { from, to, gapText: w.gap, timeText: clock, startText: t('mxHourAgo'), endText: t('mxNow'), empty: t('mxEmpty') }
  return (
    <Card className={clsx(css.block, css.mxCharts)} data-mx-charts={m.name}>
      <ChartGroup>
        {hasCpu && <LineArea label={t('mxProcessor')} samples={cpu as ChartSample[]} max={1} maxText="100 %" format={percent} {...frame} />}
        <LineArea label={t('memory')} samples={memory as ChartSample[]} max={total} maxText={known != null ? gib(known) : undefined} format={(v) => gib(v)} {...frame} />
      </ChartGroup>
      <HistoryNote snapshot={snapshot} />
    </Card>
  )
}

/**
 * The machine's Sandboxes as the sampler last read them, the most memory
 * first: live dot, processor (processors' worth), memory and up time. Not
 * drawn for a worker of an older build (no rows: only the counts show).
 */
export function SandboxUsage({ m }: { m: MachineInfo }): ReactNode {
  const { t, go } = useMachinesContext()
  const w = useWords()
  const { offered, snapshot } = useMetrics(m.name)
  const stats: MachineStats | null | undefined = snapshot.machines[m.name]?.latest?.stats
  const rows = useMemo(() => sandboxTable(snapshot, m.name), [snapshot, m.name])
  if (!offered || !stats?.sandboxes.items || !rows.length) return null
  const now = snapshot.now ?? Date.now()
  const cpus = stats.resources.cpus
  return (
    <Card className={css.tableCard} data-mx-sandboxes={m.name}>
      <table className={clsx(css.rows, css.mxTable)} aria-label={t('mxSandboxesNow', { name: m.name })}>
        <thead>
          <tr><th className={css.mxName}>{t('mxSandbox')}</th><th>{t('mxProcessor')}</th><th>{t('memory')}</th><th>{t('mxUpTime')}</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const u = r.row?.usage
            const why = r.gap ?? r.row?.usageReason ?? r.row?.liveReason
            const dot = r.closedAt != null ? 'idle' : r.gap ? 'idle' : r.row?.live === true ? 'done' : r.row?.live === false ? 'error' : 'idle'
            return (
              <tr key={r.name} data-mx-row={r.name} data-mx-closed={r.closedAt != null || undefined}>
                <td className={css.mxName}>
                  <button type="button" className={css.mxRowName} onClick={() => go({ kind: 'sandbox', machine: m.name, name: r.name })} title={r.name}>
                    <StateDot state={dot} size={6} />
                    <SandboxGlyph size={13} />
                    <span className={css.mono}>{shortSandbox(r.name)}</span>
                    {r.closedAt != null && <span className={css.muted}>{t('mxClosed')}</span>}
                  </button>
                </td>
                <td data-mx-cell="cpu">{r.cpu?.v != null ? (cpus != null ? t('mxProcessorsOf', { n: processors(r.cpu.v), of: String(cpus) }) : processors(r.cpu.v)) : <Dash why={w.gap(r.cpu?.reason ?? why)} />}</td>
                <td data-mx-cell="memory">{!r.gap && u?.memoryCurrent != null ? bytes(u.memoryCurrent) : <Dash why={w.reason(why)} />}</td>
                <td data-mx-cell="up" className={css.muted}>{!r.gap && r.row?.startedAt != null ? upTime(r.row.startedAt, now) : '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </Card>
  )
}

// ---------------------------------------------------------------- Sandbox page

/**
 * A Sandbox page's figures and charts from its machine's rows: up time,
 * processor in processors' worth ("1.3 of 4"), memory now and at its peak
 * with its file-cache share, processes, out-of-memory kills when above 0, and
 * the hour of processor and memory with a mark at each kill and the peak as
 * a thin line. `null` when the sampler has nothing for it: a worker of an
 * older build sends no rows, so per-Sandbox values are hidden.
 */
export function SandboxMetrics({ name, machine }: { name: string, machine: string }): ReactNode {
  const { t } = useMachinesContext()
  const w = useWords()
  const { offered, snapshot } = useMetrics(machine)
  const f = useMemo(() => sandboxFigures(snapshot, name), [snapshot, name])
  if (!offered || !snapshot.loaded) return null
  const items = snapshot.machines[machine]?.latest?.stats.sandboxes.items
  if (!f) {
    if (snapshot.machines[machine]?.latest && !items) return <p className={css.muted} data-mx-older>{t('mxOlderWorker')}</p>
    return null
  }
  const row = f.row, u = row?.usage
  const now = snapshot.now ?? Date.now()
  const cpuNow = latest(f.cpu)
  const why = f.gap ?? row?.usageReason ?? row?.liveReason
  const usable = !f.gap && !!u
  const of = (v: number) => (f.cpus != null ? t('mxProcessorsOf', { n: processors(v), of: String(f.cpus) }) : processors(v))
  const { from, to } = span(snapshot)
  const peak = usable && u!.memoryPeak != null ? u!.memoryPeak : null
  // headroom above the peak, so its line sits clear of the axis label
  const top = Math.max(1, peak ?? 0, ...f.memory.map((s) => s.v ?? 0)) * 1.25
  // no value read yet (no_controller, deadline): no scale to label
  const memoryRead = peak != null || f.memory.some((s) => s.v != null)
  const cpuTop = f.cpus ?? Math.max(1, ...f.cpu.map((s) => s.v ?? 0))
  const kills = usable && u!.oomKills != null ? u!.oomKills : null
  const frame = { from, to, gapText: w.gap, timeText: clock, startText: t('mxHourAgo'), endText: t('mxNow'), empty: t('mxEmpty') }
  const marks = f.kills.map((k) => ({ t: k.t, label: t(k.kills === 1 ? 'mxKillOne' : 'mxKills', { n: String(k.kills) }) }))
  return (
    <div className={css.mxSandbox} data-mx-sandbox={name}>
      <Figures label={t('mxFigures')}>
        <Figure label={t('mxUpTime')} data-mx-figure="up" gap={row?.startedAt == null}>
          {!f.gap && row?.startedAt != null ? upTime(row.startedAt, now) : <Dash why={w.reason(why)} />}
        </Figure>
        <Figure label={t('mxProcessor')} data-mx-figure="cpu" gap={cpuNow?.v == null}>
          {cpuNow?.v != null ? of(cpuNow.v) : <Dash why={w.gap(cpuNow?.reason ?? why)} />}
        </Figure>
        <Figure label={t('memory')} data-mx-figure="memory" gap={!usable || u!.memoryCurrent == null}
          sub={usable && u!.memoryCurrent != null ? [
            u!.memoryPeak != null ? t('mxPeak', { size: bytes(u!.memoryPeak) }) : null,
            'memoryFile' in u! ? (u!.memoryFile != null ? t('mxFileShare', { size: bytes(u!.memoryFile) }) : t('mxFileNotRead')) : null,
            t('mxMemoryNote'),
          ].filter(Boolean).join(' · ') : undefined}>
          {usable && u!.memoryCurrent != null ? bytes(u!.memoryCurrent) : <Dash why={w.reason(why)} />}
        </Figure>
        <Figure label={t('mxProcesses')} data-mx-figure="pids" gap={!usable || u!.pids == null}>
          {usable && u!.pids != null ? String(u!.pids) : <Dash why={w.reason(why)} />}
        </Figure>
        {kills != null && kills > 0 && (
          <Figure label={t('mxOomKills')} data-mx-figure="oom">
            <span className={css.mxDanger}>{String(kills)}</span>
          </Figure>
        )}
      </Figures>
      <ChartGroup>
        <LineArea label={t('mxProcessor')} samples={f.cpu as ChartSample[]} max={cpuTop} maxText={f.cpus != null ? t('mxProcessorsMax', { n: String(f.cpus) }) : processors(cpuTop)} format={of} marks={marks} {...frame} />
        <LineArea label={t('mxMemoryChart')} samples={f.memory as ChartSample[]} max={top} maxText={memoryRead ? bytes(top) : undefined} format={(v) => bytes(v)} marks={marks}
          peak={peak != null ? { v: peak, label: t('mxPeak', { size: bytes(peak) }) } : null} {...frame} />
      </ChartGroup>
      <HistoryNote snapshot={snapshot} />
    </div>
  )
}
