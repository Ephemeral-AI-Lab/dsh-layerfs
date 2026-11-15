/**
 * Observed values on the Machines and Sandbox pages (layerfs-project#164):
 * what `machine.stats` answered for a machine, whether a listed Sandbox's
 * daemon runs (`sandbox.list` with `live`), and a Sandbox's daemon process and
 * usage (`sandbox.get`). Pure: no React, no host calls of its own.
 *
 * Nothing here is derived from a record. A value LayerFS did not observe is
 * `null` and is shown as "not observed" with its reason, never as zero.
 *
 * {@link StatsPoller} reads `GET /api/machines/:id/stats` for the machines a
 * page on screen watches: one read at a time (so it never holds more than one
 * of the host's two inspect slots), each machine no sooner than the shortest
 * interval a watcher asked for after its last read ended, and only while the
 * page is visible.
 * What was read stays while the next read runs or is refused.
 */
import type { MachinesKey } from './locale.ts'
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
  }
  dataDisk: { path: string | null, fs: string | null, scope: string | null, volume: string | null, inodesFree: number | null }
  stores: { name: string, bytes: number | null, allocated: number | null }[]
  sandboxes: { recorded: number | null, live: number | null }
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

/** The machine page reads its one machine every 10 s; the Machines tab each running machine every 30 s. */
export const STATS_PAGE_MS = 10_000
export const STATS_BOARD_MS = 30_000
/** How long the page waits for one stats read (the host's own budget is 15 s plus its queue). */
export const STATS_ANSWER_MS = 25_000
/** How often a poller that may not read (a hidden window, another panel) looks again. */
export const STATS_IDLE_MS = 2000

/** Refusals after which a machine is not asked again until it is watched anew: waiting changes nothing. */
const FINAL = new Set(['Unsupported', 'NotFound', 'NoSuchMachine', 'CliIncompatible'])

export interface Clock {
  now: () => number
  setTimeout: (run: () => void, ms: number) => unknown
  clearTimeout: (timer: unknown) => void
}
const realClock: Clock = { now: () => Date.now(), setTimeout: (run, ms) => setTimeout(run, ms), clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>) }

interface Watched { every: number[], last: number, stopped: boolean }

export class StatsPoller {
  private value: Readonly<Record<string, StatsRead>> = {}
  private readonly listeners = new Set<() => void>()
  private readonly watched = new Map<string, Watched>()
  private flying: string | null = null
  private timer: unknown
  private disposed = false

  /**
   * @param read - one `GET /api/machines/<name>/stats`; a refusal LayerFS gave arrives as `stale` in the answer, anything thrown is a lost read.
   * @param visible - whether a page that shows stats is on screen now.
   */
  constructor(private readonly read: (name: string) => Promise<MachineStatsView>, private readonly visible: () => boolean = () => true, private readonly clock: Clock = realClock) {}

  getSnapshot = (): Readonly<Record<string, StatsRead>> => this.value
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Read `name` every `everyMs` while watched; the release ends this watcher (the values stay for the next one). */
  watch(name: string, everyMs: number): () => void {
    let w = this.watched.get(name)
    if (!w) this.watched.set(name, w = { every: [], last: -Infinity, stopped: false })
    w.every.push(everyMs)
    // a new watcher asks again where polling had stopped
    w.stopped = false
    this.pump()
    let released = false
    return () => {
      if (released) return
      released = true
      const now = this.watched.get(name)
      if (!now) return
      now.every.splice(now.every.indexOf(everyMs), 1)
      if (!now.every.length) this.watched.delete(name)
    }
  }

  /** Read `name` now (after a Start, or "Read again"), if it is watched. */
  refresh(name: string): void {
    const w = this.watched.get(name)
    if (!w) return
    w.last = -Infinity
    w.stopped = false
    this.pump()
  }

  /** Look for a due read now (the window became visible again). */
  wake(): void { this.pump() }

  dispose(): void {
    this.disposed = true
    this.clock.clearTimeout(this.timer)
    this.watched.clear()
  }

  private set(name: string, next: StatsRead): void {
    this.value = { ...this.value, [name]: next }
    for (const l of [...this.listeners]) l()
  }

  private pump(): void {
    if (this.disposed) return
    this.clock.clearTimeout(this.timer)
    this.timer = undefined
    if (this.flying || !this.watched.size) return
    if (!this.visible()) { this.timer = this.clock.setTimeout(() => this.pump(), STATS_IDLE_MS); return }
    const now = this.clock.now()
    let next: string | null = null, nextDue = Infinity, soonest = Infinity
    for (const [name, w] of this.watched) {
      if (w.stopped) continue
      const due = w.last + Math.min(...w.every)
      if (due <= now && due < nextDue) { next = name; nextDue = due }
      soonest = Math.min(soonest, due)
    }
    if (next === null) {
      if (soonest !== Infinity) this.timer = this.clock.setTimeout(() => this.pump(), Math.max(50, soonest - now))
      return
    }
    void this.readOne(next)
  }

  private async readOne(name: string): Promise<void> {
    const w = this.watched.get(name)!
    w.last = this.clock.now()
    this.flying = name
    const before = this.value[name]
    this.set(name, { stats: before?.stats ?? null, at: before?.at ?? null, stale: before?.stale ?? null, loaded: before?.loaded ?? false, reading: true })
    let view: MachineStatsView | null = null, lost: StatsStale | null = null
    try { view = await this.read(name) } catch (error) {
      const e = error as { code?: unknown, message?: unknown }
      lost = { at: before?.at ?? null, code: typeof e?.code === 'string' ? e.code : 'Unknown', message: typeof e?.message === 'string' ? e.message : String(error) }
    }
    if (this.disposed) return
    this.flying = null
    const kept = this.value[name]
    if (view) {
      // a refused read keeps the values already shown when the host has none (it was restarted)
      const stats = view.stats ?? (view.stale ? kept?.stats ?? null : null)
      this.set(name, { stats, at: view.stats ? view.at : stats ? kept?.at ?? null : null, stale: view.stale || null, reading: false, loaded: true })
    } else this.set(name, { stats: kept?.stats ?? null, at: kept?.at ?? null, stale: lost, reading: false, loaded: true })
    const code = view ? (view.stale ? view.stale.code : null) : lost!.code
    const now = this.watched.get(name)
    if (now) {
      // the interval counts from the end of the read: a machine that answers slowly, or not at all, is not asked again at once
      now.last = this.clock.now()
      if (code && FINAL.has(code)) now.stopped = true
    }
    this.pump()
  }
}

// ---------------------------------------------------------------- what the pages say

const w = (key: MachinesKey, values?: Record<string, string | number>): Words =>
  ({ key, ...(values ? { values: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v)])) } : {}) })

/** Whether a machine can be asked for stats now: `native` always answers in the caller's process; another machine only while it runs. */
export const statsAskable = (m: Pick<MachineInfo, 'platform' | 'state'>): boolean => m.platform === 'native' || m.state === 'running' || m.state === 'ready'

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
  host_process: 'reasonHostProcess', cgroup_v1: 'reasonCgroupV1', no_cgroup: 'reasonNoCgroup', not_observed: 'reasonNotObserved',
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
export function notObserved(m: Pick<MachineInfo, 'platform' | 'state'>, read: StatsRead | undefined): Words | null {
  if (!statsAskable(m)) return m.state === 'stopped' ? w('notObservedStopped') : w('notObservedState', { state: m.state })
  if (read?.stats) return null
  if (read?.stale) return read.stale.code === 'Unavailable' ? w('notObservedUnavailable') : w('notObservedRefused', { code: read.stale.code, message: read.stale.message })
  return w('notObservedYet')
}

/** A refused read under values still shown: its code and words. */
export const staleWords = (stale: StatsStale): Words => (stale.code === 'Timeout' ? w('statsStaleTimeout') : stale.code === 'Busy' ? w('statsStaleBusy') : w('statsStaleRefused', { code: stale.code, message: stale.message }))

// ---------------------------------------------------------------- Sandboxes: live

/** A listed Sandbox counts as running: its record says so and LayerFS did not see its daemon ended. */
export const sandboxRuns = (b: Pick<MachineSandbox, 'state' | 'live'>): boolean => b.state === 'running' && b.live !== false

/**
 * How a listed Sandbox looks. Its record's state, except: recorded running
 * with a daemon LayerFS saw ended (`live: false`) is "Daemon not running",
 * which needs you; recorded running but not observed (`live: null`) keeps its
 * state with a dashed chip.
 */
export function sandboxLook(b: Pick<MachineSandbox, 'state' | 'live'>, look: (state: string | null | undefined) => StateLook): StateLook {
  const base = look(b.state)
  if (b.state !== 'running' || b.live === undefined || b.live === true) return base
  if (b.live === false) return { tone: 'danger', label: 'stateDaemonDown', attention: true }
  return { ...base, tone: 'neutral', dashed: true }
}

/**
 * Why a Sandbox recorded running is not confirmed, for its chip's tooltip; null when it is confirmed or not asked.
 * @param tw - the page's translator (the reason is one of LayerFS's words, said plainly).
 */
export function liveNote(b: Pick<MachineSandbox, 'state' | 'live' | 'liveReason'>, tw: (words: Words) => string): string | null {
  if (b.state !== 'running' || b.live === undefined || b.live === true) return null
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
    if (b.state !== 'running') continue
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
