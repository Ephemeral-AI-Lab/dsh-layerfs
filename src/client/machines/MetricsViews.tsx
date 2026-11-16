/**
 * The metrics views (layerfs-project#182 D3), drawn from the host's sampler
 * (metrics.ts): a machine card's meters and a Sandbox page's
 * figures and charts. Per-Sandbox rows are the Sandboxes tab (MachineTabs.tsx).
 *
 * Everything renders from field presence, never from a platform name: an
 * absent field hides its figure, a `null` shows a dash and the reason, and an
 * unknown `scope` or reason word is shown as it came. A processor figure is a
 * dash until a second sample exists. The history is the host's memory: a dsh
 * restart starts it empty, and the charts say so.
 */
import { useMemo, type ReactNode } from 'react'
import clsx from 'clsx'
import { ChartGroup, Figure, Figures, LineArea, type ChartSample } from '../ui/LineArea.tsx'
import { Meter } from '../ui/index.tsx'
import { useMachinesContext } from './context.tsx'
import {
  HOUR_MS, latest, processors, sandboxFigures, upTime,
  type MetricsSnapshot,
} from './metrics.ts'
import { useMetrics } from './MachineStats.tsx'
import { gib, type MachineInfo } from './model.ts'
import { reasonList, reasonWords, statsAskable } from './stats.ts'
import css from './machines.module.css'

const clock = (t: number): string => new Date(t).toLocaleTimeString()

/** The page's words for a gap, a dash's reason and the charts' frame. */
export function useWords() {
  const { t, tw } = useMachinesContext()
  const reason = (r: string | undefined | null): string => tw(reasonWords(r || 'not_observed'))
  return {
    reason,
    gap: (r: string | undefined): string => (r === 'first_sample' ? t('mxNeedsSecond') : t('mxNotRead', { reason: reason(r) })),
    reasons: (r: string | null): string => reasonList(r).map(tw).join(', '),
  }
}

/** A dash with its reason (a `null` LayerFS answered, or a gap): the reason on its own small line, so a figure keeps its width. */
export function Dash({ why }: { why: string }): ReactNode {
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
 * A machine card's meters: memory used of total and data disk used of total,
 * from the sampler's last answer (the Sandboxes column counts the Sandboxes). A machine the
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
  const r = stats.resources
  return (
    <span className={css.meters} data-mx-meters="read">
      {r.memoryTotal != null && r.memoryUsed != null
        ? <span className={css.meterItem} data-mx-memory><Meter share={r.memoryTotal > 0 ? r.memoryUsed / r.memoryTotal : 0} label={t('memoryUse')} className={css.diskMeter} />{t('mxMemoryOf', { used: gib(r.memoryUsed), total: gib(r.memoryTotal) })}</span>
        : <span className={css.muted} data-mx-memory="null">{t('mxMemoryNotRead', { reason: w.reasons(r.reason) || w.reason(null) })}</span>}
      {r.diskTotal != null && r.diskUsed != null
        ? <span className={css.meterItem} data-mx-disk><Meter share={r.diskTotal > 0 ? r.diskUsed / r.diskTotal : 0} label={t('diskUse')} className={css.diskMeter} />{t('mxDiskOf', { used: gib(r.diskUsed), total: gib(r.diskTotal) })}</span>
        : <span className={css.muted} data-mx-disk="null">{t('mxDiskNotRead', { reason: w.reasons(r.reason) || w.reason(null) })}</span>}
    </span>
  )
}

/**
 * A machine row's memory: a meter and "89% of 36 GiB" (used of total on
 * hover), warning past 75 % and danger past 90 %. Not read: the memory its
 * record was created with, muted, or a dash, with why on hover.
 */
export function MemoryCell({ m }: { m: MachineInfo }): ReactNode {
  const { t } = useMachinesContext()
  const w = useWords()
  const { offered, snapshot } = useMetrics(m.name)
  const entry = offered ? snapshot.machines[m.name] : undefined
  const r = statsAskable(m) ? entry?.latest?.stats?.resources : undefined
  if (r?.memoryTotal != null && r.memoryUsed != null && r.memoryTotal > 0) {
    const share = Math.max(0, Math.min(1, r.memoryUsed / r.memoryTotal))
    return (
      <span className={css.cellStack} data-mx-memory>
        <Meter share={share} label={t('memoryUse')} className={css.cellBar} />
        <span className={css.cellText} data-tone={share > 0.9 ? 'danger' : share > 0.75 ? 'warning' : undefined}
          title={t('mxMemoryOf', { used: gib(r.memoryUsed), total: gib(r.memoryTotal) })}>
          {t('memoryShare', { pct: String(Math.round(share * 100)), total: gib(r.memoryTotal) })}
        </span>
      </span>
    )
  }
  const last = entry?.points.at(-1)
  const why = !offered ? null : !statsAskable(m) ? w.reason('machine_stopped') : last && !last.values ? w.reason(last.code) : snapshot.loaded ? w.reason('not_observed') : null
  return (
    <span className={clsx(css.cellText, css.cellMuted)} data-mx-memory="null" title={why ? t('mxNotRead', { reason: why }) : undefined}>
      {m.memory != null ? t('mxAllocatedMemory', { size: gib(m.memory) }) : '—'}
    </span>
  )
}

// ---------------------------------------------------------------- machine page

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
            u!.memoryPeak != null ? t('mxPeak', { size: gib(u!.memoryPeak) }) : null,
            'memoryFile' in u! ? (u!.memoryFile != null ? t('mxFileShare', { size: gib(u!.memoryFile) }) : t('mxFileNotRead')) : null,
            t('mxMemoryNote'),
          ].filter(Boolean).join(' · ') : undefined}>
          {usable && u!.memoryCurrent != null ? gib(u!.memoryCurrent) : <Dash why={w.reason(why)} />}
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
        <LineArea label={t('mxMemoryChart')} samples={f.memory as ChartSample[]} max={top} maxText={memoryRead ? gib(top) : undefined} format={(v) => gib(v)} marks={marks}
          peak={peak != null ? { v: peak, label: t('mxPeak', { size: gib(peak) }) } : null} {...frame} />
      </ChartGroup>
      <HistoryNote snapshot={snapshot} />
    </div>
  )
}
