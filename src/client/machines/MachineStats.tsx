/**
 * Observed machine values on the Machines pages (layerfs-project#164): the
 * disk line, the resources line and the Details facts drawn from
 * `machine.stats` (stats.ts), in place of the disk use the pages used to
 * infer from a record's requested size. Shown only when the pinned CLI has
 * machine.stats; without it each caller draws what it drew before.
 *
 * A machine that is not running is never asked: its record stays, with "Not
 * observed (machine stopped)". A refused or slow read keeps the last values
 * on screen, marked with the time they were read; a value LayerFS answered as
 * `null` reads "Not observed" with its reason, never zero.
 */
import { useEffect, useSyncExternalStore, type ReactNode } from 'react'
import { Fact, Meter } from '../ui/index.tsx'
import { useMachinesContext } from './context.tsx'
import { bytes, gib, type MachineInfo, type Words } from './model.ts'
import { diskScopeWords, notObserved, reasonList, reasonWords, resourceScopeWords, staleWords, statsAskable, type MachineStats, type StatsRead } from './stats.ts'
import css from './machines.module.css'

/**
 * One machine's stats while this component is mounted.
 * @param everyMs - how often it is read (the shortest interval among the mounted watchers wins).
 * @returns `offered`: the pinned CLI has machine.stats; `read`: what is known so far (undefined before the first read starts, or when not offered).
 */
export function useMachineStats(m: Pick<MachineInfo, 'name' | 'platform' | 'state'>, everyMs: number): { offered: boolean, read: StatsRead | undefined } {
  const { stats, useMachines } = useMachinesContext()
  const offered = useMachines((s) => (s.data?.available ? s.data.features?.inspect?.machineStats === true : false))
  const askable = statsAskable(m)
  useEffect(() => (offered && askable ? stats.watch(m.name, everyMs) : undefined), [stats, offered, askable, m.name, everyMs])
  const read = useSyncExternalStore(stats.subscribe, () => stats.getSnapshot()[m.name])
  return { offered, read: offered && askable ? read : undefined }
}

const clock = (at: number | null): string => (at ? new Date(at).toLocaleTimeString() : '—')

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

/** "Not observed (…)" for one value LayerFS answered as null. */
function Unobserved({ reason }: { reason?: string | undefined }): ReactNode {
  const { t } = useMachinesContext()
  return <span className={css.muted} data-not-observed>{reason ? t('notObservedBecause', { reason }) : t('notObserved')}</span>
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
  return [w.version ? t('workerVersion', { version: w.version }) : null, w.startedAt ? t('workerSince', { time: new Date(w.startedAt).toLocaleString() }) : null].filter(Boolean).join(' · ') || null
}

/**
 * The Resources facts of the Details card from `machine.stats`: observed
 * processors, memory and disk with their scope, what a VM was created with
 * (the record, named as such), the worker, and when it was observed.
 */
export function ObservedResources({ m, read }: { m: MachineInfo, read: StatsRead | undefined }): ReactNode {
  const { t, tw } = useMachinesContext()
  const reasons = useReasons()
  const why = notObserved(m, read)
  const requested = [
    m.cpus != null ? t(m.cpus === 1 ? 'coresOne' : 'cores', { n: String(m.cpus) }) : null,
    m.memory != null ? t('requestedMemory', { size: gib(m.memory) }) : null,
    m.disk != null ? t('requestedDisk', { size: gib(m.disk) }) : null,
  ].filter(Boolean).join(' · ')
  if (why || !read?.stats) {
    return (
      <>
        <Fact label={t('observed')} tone="muted"><span data-stats="not-observed">{tw(why ?? { key: 'notObservedYet' })}</span></Fact>
        {requested && <Fact label={t('requested')}>{requested}</Fact>}
      </>
    )
  }
  const s = read.stats, r = s.resources, d = s.dataDisk
  const none = reasons(r.reason) || undefined
  const cpuScope = resourceScopeWords(r.scope), diskScope = diskScopeWords(d.scope)
  const diskSub = [diskScope ? tw(diskScope) : null, d.fs, d.path, d.volume ? t('volumeNamed', { name: d.volume }) : null].filter(Boolean).join(' · ')
  return (
    <>
      <Fact label={t('cpus')}>
        {r.cpus != null ? <span data-stats-cpus>{r.cpus}</span> : <Unobserved reason={none} />}
        {cpuScope ? <span className={css.factSub}>{tw(cpuScope)}</span> : null}
      </Fact>
      <Fact label={t('memory')}>
        {r.memoryTotal != null && r.memoryUsed != null
          ? (
            <span className={css.factMeter} data-stats-memory>
              <Meter share={r.memoryTotal > 0 ? r.memoryUsed / r.memoryTotal : 0} label={t('memoryUse')} />
              <span>{t('memoryObserved', { used: gib(r.memoryUsed), total: gib(r.memoryTotal) })}</span>
            </span>
          )
          : <Unobserved reason={none} />}
      </Fact>
      <Fact label={t('disk')}>
        {r.diskTotal != null && r.diskUsed != null
          ? (
            <span className={css.factMeter} data-stats-disk>
              <Meter share={r.diskTotal > 0 ? r.diskUsed / r.diskTotal : 0} label={t('diskUse')} />
              <span>{r.diskFree != null ? t('diskObserved', { used: gib(r.diskUsed), total: gib(r.diskTotal), free: gib(r.diskFree) }) : t('diskObservedNoFree', { used: gib(r.diskUsed), total: gib(r.diskTotal) })}</span>
            </span>
          )
          : <Unobserved reason={none} />}
        {diskSub ? <span className={css.factSub} data-stats-disk-scope={d.scope ?? ''}>{diskSub}</span> : null}
      </Fact>
      {requested && <Fact label={t('requested')}>{requested}</Fact>}
      <Fact label={t('worker')}>
        {s.worker
          ? <span data-stats-worker>{[workerLine(s, t), s.worker.pid != null ? t('pidOf', { pid: String(s.worker.pid) }) : null].filter(Boolean).join(' · ') || t('notObserved')}</span>
          : <span className={css.muted} data-stats-worker="none">{t('workerNone')}</span>}
      </Fact>
      <Fact label={t('observed')}>
        <span data-stats-at>{clock(read.at)}</span>
        {!s.complete ? <span className={css.factSub}>{t('statsIncomplete', { reason: s.reason ? tw(reasonWords(s.reason)) : t('reasonNotObserved') })}</span> : null}
        {read.stale ? <span className={css.factSub} data-stats-stale={read.stale.code}>{tw(staleWords(read.stale))}</span> : null}
      </Fact>
    </>
  )
}

/** Each sqlite Store's size as observed (`stores[].bytes`: the Store file and its WAL), by name. */
export function storeSizes(read: StatsRead | undefined): Map<string, number | null> | null {
  if (!read?.stats) return null
  return new Map(read.stats.stores.map((s) => [s.name, s.bytes]))
}

/** "shop 217 KB, big (size not observed)": the machine's Stores with their observed sizes. */
export function storeSizeWords(names: readonly string[], sizes: Map<string, number | null>, t: ReturnType<typeof useMachinesContext>['t']): string {
  return names.map((name) => { const size = sizes.get(name); return size != null ? `${name} ${bytes(size)}` : t('storeSizeUnknown', { name }) }).join(', ')
}

/** How many of the machine's recorded Sandboxes have a daemon that runs now (`sandboxes.live` of `recorded`). */
export function liveWords(stats: MachineStats, t: ReturnType<typeof useMachinesContext>['t'], tw: (words: Words) => string): string {
  const { recorded, live } = stats.sandboxes
  if (live == null) return t('notObservedBecause', { reason: tw(reasonWords(stats.reason ?? 'not_observed')) })
  return t('daemonsLiveOf', { live: String(live), recorded: recorded != null ? String(recorded) : '—' })
}
