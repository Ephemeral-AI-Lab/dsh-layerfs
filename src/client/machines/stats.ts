/**
 * Observed values on the Machines and Sandbox pages (layerfs-project#164,
 * #182): what `machine.stats` answered for a machine, whether a listed
 * Sandbox's daemon runs, and a Sandbox's daemon process and usage. Pure: no
 * React, no host calls of its own. The values come from the host's metrics
 * sampler (metrics.ts `MetricsPoller`, `GET /api/metrics`); nothing here asks
 * LayerFS.
 *
 * Nothing here is derived from a record. A value LayerFS did not observe is
 * `null` and is shown as "not observed" with its reason, never as zero.
 */
import type { MachinesKey } from './locale.ts'
import type { SandboxRow } from './metrics.ts'
import type { MachineInfo, MachineSandbox, StateLook, Words } from './model.ts'

/** Why a read was refused, and when the host last had a good answer (null: never). */
export interface StatsStale { at: number | null, code: string, message: string }

/** What `machine.stats` observed (host `MachineStats`). */
export interface MachineStats {
  platform: string | null
  observedAt: number | null
  worker: { version: string | null, pid: number | null, startedAt: number | null, protocol: string | null, bundle: string | null } | null
  resources: {
    cpus: number | null, memoryTotal: number | null, memoryUsed: number | null
    diskTotal: number | null, diskUsed: number | null, diskFree: number | null
    scope: string | null, reason: string | null
    /** Cumulative processor time of the machine (#182 L1); absent from an older build. */
    cpuBusyUsec?: number | null
    cpuTotalUsec?: number | null
  }
  dataDisk: { path: string | null, fs: string | null, scope: string | null, volume: string | null, inodesFree: number | null }
  stores: { name: string, bytes: number | null, allocated: number | null }[]
  /** `items`: one row per recorded Sandbox (#182 L2); absent from a worker of an older build. */
  sandboxes: { recorded: number | null, live: number | null, items?: SandboxRow[] }
  complete: boolean
  reason: string | null
}

/** `GET /api/machines/:id/stats` (host `MachineStatsView`). */
export interface MachineStatsView {
  machine: string
  readAt: number
  at: number | null
  stats: MachineStats | null
  stale: false | StatsStale
}

/** One machine's stats as a page holds them. */
export interface StatsRead {
  /** The last values read; null until a read brought some. */
  stats: MachineStats | null
  /** When `stats` was read (the host's clock). */
  at: number | null
  /** The last read was refused or lost: what is shown is what was read before. */
  stale: StatsStale | null
  /** A read is running now. */
  reading: boolean
  /** At least one read has ended (an answer or a refusal). */
  loaded: boolean
}

// ---------------------------------------------------------------- what the pages say

const w = (key: MachinesKey, values?: Record<string, string | number>): Words =>
  ({ key, ...(values ? { values: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v)])) } : {}) })

/** Whether the sampler reads a machine: its `state` is `running` or `ready` (native's is `ready`; no platform test). */
export const statsAskable = (m: Pick<MachineInfo, 'state'>): boolean => m.state === 'ready'

/** What the measured filesystem is, in plain words (`data_disk.scope`); an unknown scope as it came. */
export function diskScopeWords(scope: string | null): Words | null {
  if (scope === 'volume') return w('scopeVolume')
  if (scope === 'vm_disk') return w('scopeVmDisk')
  if (scope === 'host_fs') return w('scopeHostFs')
  return scope ? w('raw', { text: scope }) : null
}

/** Whose processors and memory were observed, in plain words (`resources.scope`). */
export function resourceScopeWords(scope: string | null): Words | null {
  if (scope === 'host') return w('scopeHost')
  if (scope === 'engine_host') return w('scopeEngineHost')
  if (scope === 'vm') return w('scopeVm')
  return scope ? w('raw', { text: scope }) : null
}

const REASONS: Record<string, MachinesKey> = {
  memory_not_read: 'reasonMemoryNotRead', disk_not_read: 'reasonDiskNotRead', deadline: 'reasonDeadline',
  machine_stopped: 'reasonMachineStopped', no_pid: 'reasonNoPid', record_unreadable: 'reasonRecordUnreadable', not_answered: 'reasonNotAnswered',
  unavailable: 'reasonUnavailable', busy: 'reasonBusy', invalid_input: 'reasonOlderWorker',
  host_process: 'reasonHostProcess', cgroup_v1: 'reasonCgroupV1', no_cgroup: 'reasonNoCgroup', not_observed: 'reasonNotObserved', no_controller: 'reasonNoController', no_command: 'reasonNoCommand',
  cpu_unsupported: 'reasonCpuUnsupported', cpu_not_read: 'reasonCpuNotRead', not_supported: 'reasonNotSupported',
  first_sample: 'reasonFirstSample', restarted: 'reasonRestarted',
  // a refused sampler read's code
  Busy: 'reasonBusy', Unavailable: 'reasonUnavailable', Timeout: 'reasonTimeout',
}

/** One of LayerFS's reason words (`deadline`, `host_process`, …) in plain words; an unknown one as it came. */
export const reasonWords = (reason: string): Words => (REASONS[reason] ? w(REASONS[reason]) : w('raw', { text: reason.replaceAll('_', ' ') }))

/** `resources.reason` (reasons joined by `, `) as a list of words. */
export const reasonList = (reason: string | null): Words[] => (reason ? reason.split(',').map((r) => r.trim()).filter(Boolean).map(reasonWords) : [])

/**
 * Why a machine's stats are not on the page, when they are not: it is
 * stopped (never asked), the read was refused or lost, or no read has ended
 * yet. Null when there are values to show.
 */
export function notObserved(m: Pick<MachineInfo, 'state'>, read: StatsRead | undefined): Words | null {
  if (!statsAskable(m)) return m.state === 'stopped' ? w('notObservedStopped') : w('notObservedState', { state: m.state })
  if (read?.stats) return null
  if (read?.stale) return read.stale.code === 'Unavailable' ? w('notObservedUnavailable') : w('notObservedRefused', { code: read.stale.code, message: read.stale.message })
  return w('notObservedYet')
}

/** A refused read under values still shown: its code and words. */
export const staleWords = (stale: StatsStale): Words => (stale.code === 'Timeout' ? w('statsStaleTimeout') : stale.code === 'Busy' ? w('statsStaleBusy') : w('statsStaleRefused', { code: stale.code, message: stale.message }))

// ---------------------------------------------------------------- Sandboxes: live

/** A listed Sandbox counts as running: its record says so and LayerFS did not see its daemon ended. */
export const sandboxRuns = (b: Pick<MachineSandbox, 'state' | 'live'>): boolean => b.state === 'ready' && b.live !== false

/**
 * How a listed Sandbox looks. Its record's state, except: recorded running
 * with a daemon LayerFS saw ended (`live: false`) is "Daemon not running",
 * which needs you; recorded running but not observed (`live: null`) keeps its
 * state with a dashed chip.
 */
export function sandboxLook<B extends Pick<MachineSandbox, 'state' | 'live'>>(b: B, look: (b: B) => StateLook): StateLook {
  const base = look(b)
  if (b.state !== 'ready' || b.live === undefined || b.live === true) return base
  if (b.live === false) return { tone: 'danger', label: 'stateDaemonDown', attention: true }
  return { ...base, tone: 'neutral', dashed: true }
}

/**
 * Why a Sandbox recorded running is not confirmed, for its chip's tooltip; null when it is confirmed or not asked.
 * @param tw - the page's translator (the reason is one of LayerFS's words, said plainly).
 */
export function liveNote(b: Pick<MachineSandbox, 'state' | 'live' | 'liveReason'>, tw: (words: Words) => string): string | null {
  if (b.state !== 'ready' || b.live === undefined || b.live === true) return null
  if (b.live === false) return tw(w('liveDown'))
  return b.liveReason ? tw(w('liveUnknownBecause', { reason: tw(reasonWords(b.liveReason)) })) : tw(w('liveUnknown'))
}

/**
 * The Sandboxes of one machine by what was observed. `observed` is false when
 * the list carries no `live` (an older CLI): `running` is then the records'
 * count, as before.
 */
export function liveCounts(sandboxes: readonly Pick<MachineSandbox, 'state' | 'live'>[]): { total: number, running: number, down: number, unknown: number, observed: boolean } {
  let running = 0, down = 0, unknown = 0, observed = false
  for (const b of sandboxes) {
    if (b.live !== undefined) observed = true
    if (b.state !== 'ready') continue
    if (b.live === false) down++
    else if (b.live === null) unknown++
    else running++
  }
  return { total: sandboxes.length, running, down, unknown, observed }
}

// ---------------------------------------------------------------- a Sandbox's process and usage

/** CPU time in words: `usage_usec` as `1.2 s`, `3 min 4 s`, `2 h 5 min`. */
export function cpuTime(usec: number | null | undefined): string {
  if (usec == null || !Number.isFinite(usec)) return '—'
  const s = usec / 1e6
  if (s < 10) return `${s.toFixed(s < 1 ? 2 : 1)} s`
  if (s < 60) return `${Math.round(s)} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ${Math.round(s - m * 60)} s`
  return `${Math.floor(m / 60)} h ${m % 60} min`
}
