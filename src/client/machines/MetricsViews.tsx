/**
 * The metrics views (layerfs-project#182 D3), drawn from the host's sampler
 * (metrics.ts): a machine card's and a machine row's meters, current values
 * only. Per-Sandbox rows are the Sandboxes tab (MachineTabs.tsx).
 *
 * Everything renders from field presence, never from a platform name: an
 * absent field hides its figure, a `null` shows a dash and the reason, and an
 * unknown `scope` or reason word is shown as it came. A processor figure is a
 * dash until a second sample exists.
 */
import type { ReactNode } from 'react'
import clsx from 'clsx'
import { Meter } from '../ui/index.tsx'
import { useMachinesContext } from './context.tsx'
import { useMetrics } from './MachineStats.tsx'
import { gib, type MachineInfo } from './model.ts'
import { reasonList, reasonWords, statsAskable } from './stats.ts'
import css from './machines.module.css'

/** The page's words for a gap and a dash's reason. */
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
