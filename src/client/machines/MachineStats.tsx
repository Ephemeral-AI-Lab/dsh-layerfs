/**
 * Observed machine values on the Machines pages (layerfs-project#164, #182):
 * the disk line and the resources line drawn from the
 * host's metrics sampler (`machine.stats`, once per machine per 15 s; metrics.ts),
 * in place of the disk use the pages used to infer from a record's requested
 * size. Shown only when the pinned CLI has machine.stats; without it each
 * caller draws what it drew before.
 *
 * A machine that is not running is never asked: its record stays, with "Not
 * observed (machine stopped)". A refused or slow read keeps the last values
 * on screen, marked with the time they were read; a value LayerFS answered as
 * `null` reads "Not observed" with its reason, never zero.
 */
import { useEffect, useSyncExternalStore, type ReactNode } from 'react'
import { Meter } from '../ui/index.tsx'
import { useMachinesContext } from './context.tsx'
import { sinceStart, statsReadOf, type MetricsSnapshot } from './metrics.ts'
import { gib, type MachineInfo } from './model.ts'
import { diskScopeWords, notObserved, reasonList, resourceScopeWords, staleWords, statsAskable, type MachineStats, type StatsRead } from './stats.ts'
import css from './machines.module.css'
import { clockTime, dateTime } from '../ui/locale-sync.ts'

/**
 * The page's metrics (every machine read so far) while this component is
 * mounted, with `machine` watched: the page's one poll of the host covers it.
 * @returns `offered`: the pinned CLI has machine.stats (else nothing is watched).
 */
export function useMetrics(machine: string | null | undefined): { offered: boolean, snapshot: MetricsSnapshot } {
  const { metrics, useMachines } = useMachinesContext()
  const offered = useMachines((s) => (s.data?.available ? s.data.features?.inspect?.machineStats === true : false))
  useEffect(() => (offered && machine ? metrics.watch(machine) : undefined), [metrics, offered, machine])
  const snapshot = useSyncExternalStore(metrics.subscribe, metrics.getSnapshot)
  return { offered, snapshot }
}

/**
 * One machine's stats while this component is mounted, as the sampler last
 * read them.
 * @returns `offered`: the pinned CLI has machine.stats; `read`: what is known so far (undefined before the page's first answer, when the machine is not running, or when not offered).
 */
export function useMachineStats(m: Pick<MachineInfo, 'name' | 'state'>): { offered: boolean, read: StatsRead | undefined } {
  const { offered, snapshot } = useMetrics(m.name)
  // a read from before the machine's last start here is not its facts now (UI pass 3 F14)
  const { useStartups } = useMachinesContext()
  const startedAt = useStartups((s) => (s[m.name]?.status === 'success' ? s[m.name]!.endedAt ?? null : null))
  return { offered, read: offered && statsAskable(m) ? sinceStart(statsReadOf(snapshot, m.name), startedAt) : undefined }
}

const clock = (at: number | null): string => (at ? clockTime(at) : '—')

/** "as of 12:03:10 · Busy": the values shown are older than the last read, which was refused. */
function StaleMark({ read }: { read: StatsRead }): ReactNode {
  const { t, tw } = useMachinesContext()
  if (!read.stale) return null
  return <span className={css.muted} data-stats-stale={read.stale.code} title={tw(staleWords(read.stale))}>{t('statsAsOf', { time: clock(read.at), code: read.stale.code })}</span>
}

/** The reasons LayerFS gave for values it did not read, in words. */
function useReasons(): (reason: string | null) => string {
  const { tw } = useMachinesContext()
  return (reason) => reasonList(reason).map(tw).join(', ')
}

/**
 * The machine's data disk as observed: a meter, "used of total · free" and
 * what that filesystem is, in plain words. Used, total and free are LayerFS's
 * own numbers (one `statvfs`), never the record's requested size.
 */
export function ObservedDisk({ m, read }: { m: MachineInfo, read: StatsRead | undefined }): ReactNode {
  const { t, tw } = useMachinesContext()
  const reasons = useReasons()
  const why = notObserved(m, read)
  if (why || !read?.stats) return <span className={css.muted} data-disk="not-observed" title={read?.stale ? read.stale.message : undefined}>{tw(why ?? { key: 'notObservedYet' })}</span>
  const r = read.stats.resources
  const scope = diskScopeWords(read.stats.dataDisk.scope)
  if (r.diskTotal == null || r.diskUsed == null) {
    return <span className={css.muted} data-disk="not-observed">{t('diskNotObserved', { reason: reasons(r.reason) || t('reasonNotObserved') })}</span>
  }
  const share = r.diskTotal > 0 ? r.diskUsed / r.diskTotal : 0
  return (
    <span className={css.diskLine} data-disk="observed" data-disk-scope={read.stats.dataDisk.scope ?? ''}>
      <Meter share={share} label={t('diskUse')} className={css.diskMeter} />
      <span>{r.diskFree != null ? t('diskObserved', { used: gib(r.diskUsed), total: gib(r.diskTotal), free: gib(r.diskFree) }) : t('diskObservedNoFree', { used: gib(r.diskUsed), total: gib(r.diskTotal) })}</span>
      {scope && <span className={css.muted} data-disk-scope-words>{tw(scope)}</span>}
      <StaleMark read={read} />
    </span>
  )
}

/** Observed processors and memory in one line, with whose they are; null when there are none to show (the caller draws the record's). */
export function ObservedCpuMemory({ read }: { read: StatsRead | undefined }): ReactNode {
  const { t, tw } = useMachinesContext()
  const reasons = useReasons()
  const stats = read?.stats
  if (!stats) return null
  const r = stats.resources
  const scope = resourceScopeWords(r.scope)
  const cpu = r.cpus != null ? t(r.cpus === 1 ? 'coresOne' : 'cores', { n: String(r.cpus) }) : t('cpusNotObserved')
  const memory = r.memoryTotal != null && r.memoryUsed != null
    ? t('memoryObserved', { used: gib(r.memoryUsed), total: gib(r.memoryTotal) })
    : t('memoryNotObserved', { reason: reasons(r.reason) || t('reasonNotObserved') })
  return (
    <span data-resources="observed" data-resources-scope={r.scope ?? ''}>
      {cpu} · {memory}{scope ? <span className={css.muted}> · {tw(scope)}</span> : null}
    </span>
  )
}

/** The worker in one line: its LayerFS version and when it began to serve. Null on a machine with no worker (native) or no stats. */
export function workerLine(stats: MachineStats | null | undefined, t: ReturnType<typeof useMachinesContext>['t']): string | null {
  const w = stats?.worker
  if (!w) return null
  return [w.version ? t('workerVersion', { version: w.version }) : null, w.startedAt ? t('workerSince', { time: dateTime(w.startedAt) }) : null].filter(Boolean).join(' · ') || null
}

/** Each sqlite Store's size as observed (`stores[].bytes`: the Store file and its WAL), by name. */
export function storeSizes(read: StatsRead | undefined): Map<string, number | null> | null {
  if (!read?.stats) return null
  return new Map(read.stats.stores.map((s) => [s.name, s.bytes]))
}
