/**
 * Machine and Sandbox metrics on the pages (layerfs-project#182 D2): the
 * history the host's sampler keeps (src/host/routes/metrics.ts), read with
 * `GET /api/metrics?machines=<names>&since=<seq>` once per 15 s per page while
 * the page is visible, and the rates drawn from it. Pure: no React.
 *
 * Rates come from two samples, never from one:
 * - a machine's processor is Δ`cpu_busy_usec` / Δ`cpu_total_usec` (a share
 *   of the whole machine, needing neither `cpus` nor a clock);
 * - a Sandbox's processor is Δ`cpu_usec` / Δ`observed_at`, in processors'
 *   worth ("1.3 of 4").
 * A rate is drawn only between two successful samples at most two ticks
 * apart. A negative delta, a changed `started_at` (the Sandbox restarted or
 * its name was reused; a move of at most {@link START_SLACK_MS} is the same
 * run, see {@link sameRun}) or a machine whose busy or total went down (it
 * rebooted) is a gap. A value LayerFS did not read is a gap with its reason,
 * never a zero.
 */
import type { MachineStats, StatsRead } from './stats.ts'

/** A Sandbox's cgroup usage (host `Usage`): `memoryFile` and `oomKills` are absent from a build before them. */
export interface Usage {
  cpuUsec: number | null
  memoryCurrent: number | null
  memoryPeak: number | null
  memoryFile?: number | null
  pids: number | null
  oomKills?: number | null
}

/** One `machine.stats` row of a recorded Sandbox (host `SandboxRow`). */
export interface SandboxRow { name: string, live: boolean | null, liveReason?: string, startedAt: number | null, usage: Usage | null, usageReason?: string }

/** Host `MachineValues`. */
export interface MachineValues {
  observedAt: number | null
  cpus: number | null
  cpuBusyUsec?: number | null
  cpuTotalUsec?: number | null
  memoryUsed: number | null
  memoryTotal: number | null
  diskUsed: number | null
  diskTotal: number | null
  reason: string | null
}

/** Host `SandboxValues`. */
export interface SandboxValues { observedAt: number | null, live: boolean | null, liveReason?: string, startedAt: number | null, usage: Usage | null, usageReason?: string }

/** One sample: `values` null is a gap with its `code` (a refusal's, or `machine_stopped`). */
export interface Point<V> { seq: number, t: number, values: V | null, code?: string, message?: string }

/** `GET /api/metrics` (host `MetricsView`). */
export interface MetricsView {
  epoch: number
  seq: number
  since: number
  now: number
  tick: number
  ring: number
  offered: boolean
  machines: Record<string, { state: string, latest: { at: number, stats: MachineStats } | null, points: Point<MachineValues>[] }>
  sandboxes: Record<string, { machine: string, closedAt: number | null, points: Point<SandboxValues>[] }>
}

/** What a page holds: everything read so far, merged. */
export interface MetricsSnapshot {
  /** At least one answer came. */
  loaded: boolean
  /** The pinned CLI has machine.stats. */
  offered: boolean
  /** When the host's sampler began: no history before it (a dsh restart starts empty). */
  epoch: number | null
  /** The host's clock at the last answer (the charts' right edge), and this page's clock then. */
  now: number | null
  tick: number
  /** The last poll failed (the host did not answer): what is shown is what was read before. */
  error: { code: string, message: string } | null
  machines: Readonly<Record<string, { state: string, latest: { at: number, stats: MachineStats } | null, points: readonly Point<MachineValues>[] }>>
  sandboxes: Readonly<Record<string, { machine: string, closedAt: number | null, points: readonly Point<SandboxValues>[] }>>
}

export const METRICS_TICK_MS = 15_000
/** One poll of the host per page per tick. */
export const METRICS_POLL_MS = 15_000
export const METRICS_RING = 240
/** One hour: the charts' width. */
export const HOUR_MS = 60 * 60_000
/** How long a closed Sandbox's history is shown. */
export const CLOSED_KEEP_MS = 10 * 60_000
/** How often a poller that may not read (a hidden window, another panel) looks again. */
const IDLE_MS = 2000

export interface Clock {
  now: () => number
  setTimeout: (run: () => void, ms: number) => unknown
  clearTimeout: (timer: unknown) => void
}
const realClock: Clock = { now: () => Date.now(), setTimeout: (run, ms) => setTimeout(run, ms), clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>) }

const EMPTY: MetricsSnapshot = { loaded: false, offered: false, epoch: null, now: null, tick: METRICS_TICK_MS, error: null, machines: {}, sandboxes: {} }

const merge = <V>(kept: readonly Point<V>[] | undefined, more: readonly Point<V>[]): Point<V>[] => {
  if (!kept?.length) return more.slice(-METRICS_RING)
  const last = kept.at(-1)!.seq
  const all = [...kept, ...more.filter((p) => p.seq > last)]
  return all.length > METRICS_RING ? all.slice(-METRICS_RING) : all
}

/**
 * One page's metrics: one `GET /api/metrics` per {@link METRICS_POLL_MS}
 * for the machines its views watch, only while the page is visible; each
 * answer brings the points after the last one held (`since`). A new machine
 * to watch reads everything kept again, at once. A host that restarted (a new
 * `epoch`) replaces what was held.
 */
export class MetricsPoller {
  private value: MetricsSnapshot = EMPTY
  private readonly listeners = new Set<() => void>()
  private readonly watched = new Map<string, number>()
  /** The names the last answer covered, and the newest seq held. */
  private asked = new Set<string>()
  private since = 0
  private last = -Infinity
  private flying = false
  private timer: unknown
  private disposed = false

  /**
   * @param read - one `GET /api/metrics?…` (the query string given).
   * @param visible - whether a page that shows metrics is on screen now.
   */
  constructor(private readonly read: (query: string) => Promise<MetricsView>, private readonly visible: () => boolean = () => true, private readonly clock: Clock = realClock) {}

  getSnapshot = (): MetricsSnapshot => this.value
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Watch `name` while mounted; the release ends this watcher (what was read stays). */
  watch(name: string): () => void {
    this.watched.set(name, (this.watched.get(name) ?? 0) + 1)
    // a machine the last answer did not cover: read now
    if (!this.asked.has(name)) this.last = -Infinity
    this.pump()
    let released = false
    return () => {
      if (released) return
      released = true
      const n = (this.watched.get(name) ?? 1) - 1
      if (n > 0) this.watched.set(name, n)
      else this.watched.delete(name)
    }
  }

  /** Read now, not at the next tick (a machine just started: its facts changed, UI pass 3 F14). */
  refresh(): void { this.last = -Infinity; this.pump() }

  /** Look for a due poll now (the window became visible again). */
  wake(): void { this.pump() }

  dispose(): void {
    this.disposed = true
    this.clock.clearTimeout(this.timer)
    this.watched.clear()
  }

  private set(next: MetricsSnapshot): void {
    this.value = next
    for (const l of [...this.listeners]) l()
  }

  private pump(): void {
    if (this.disposed) return
    this.clock.clearTimeout(this.timer)
    this.timer = undefined
    if (this.flying || !this.watched.size) return
    if (!this.visible()) { this.timer = this.clock.setTimeout(() => this.pump(), IDLE_MS); return }
    const due = this.last + METRICS_POLL_MS - this.clock.now()
    if (due > 0) { this.timer = this.clock.setTimeout(() => this.pump(), due); return }
    void this.poll()
  }

  private async poll(): Promise<void> {
    const names = [...this.watched.keys()].sort()
    const all = names.every((n) => this.asked.has(n))
    const since = all ? this.since : 0
    this.flying = true
    let view: MetricsView | null = null, error: { code: string, message: string } | null = null
    try { view = await this.read(`?machines=${names.map(encodeURIComponent).join(',')}&since=${since}`) } catch (e) {
      const x = e as { code?: unknown, message?: unknown }
      error = { code: typeof x?.code === 'string' ? x.code : 'Unknown', message: typeof x?.message === 'string' ? x.message : String(e) }
    }
    if (this.disposed) return
    this.flying = false
    // the interval counts from the end of the poll
    this.last = this.clock.now()
    if (view) this.take(view, names, since)
    else this.set({ ...this.value, error })
    // a machine watched while this poll ran: read it now, not a tick later
    if (view && [...this.watched.keys()].some((n) => !this.asked.has(n))) this.last = -Infinity
    this.pump()
  }

  private take(view: MetricsView, names: string[], since: number): void {
    const prev = this.value
    // a host that restarted numbers its points anew: start over
    const fresh = view.since === 0 || prev.epoch !== view.epoch || since === 0
    const machines: Record<string, MetricsSnapshot['machines'][string]> = fresh ? {} : { ...prev.machines }
    for (const [name, m] of Object.entries(view.machines)) {
      machines[name] = { state: m.state, latest: m.latest, points: merge(fresh ? undefined : prev.machines[name]?.points, m.points) }
    }
    // a machine asked for that the host does not know (removed): gone
    for (const name of names) if (!view.machines[name]) delete machines[name]
    const sandboxes: Record<string, MetricsSnapshot['sandboxes'][string]> = fresh ? {} : { ...prev.sandboxes }
    for (const [name, b] of Object.entries(view.sandboxes)) {
      sandboxes[name] = { machine: b.machine, closedAt: b.closedAt, points: merge(fresh ? undefined : prev.sandboxes[name]?.points, b.points) }
    }
    for (const [name, b] of Object.entries(sandboxes)) if (b.closedAt !== null && view.now - b.closedAt >= CLOSED_KEEP_MS) delete sandboxes[name]
    this.asked = new Set(names)
    this.since = view.seq
    this.set({ loaded: true, offered: view.offered, epoch: view.epoch, now: view.now, tick: view.tick || METRICS_TICK_MS, error: null, machines, sandboxes })
  }
}

// ---------------------------------------------------------------- rates

/** One chart sample: `v` null is a gap, with the reason word (LayerFS's, a refusal's code, or this file's own: `first_sample`, `restarted`, `too_far`). */
export interface Sample { t: number, v: number | null, reason?: string }

/** The reason word `resources.reason` gives for a value group, if any. */
const reasonFor = (reason: string | null | undefined, words: string[]): string | undefined =>
  reason?.split(',').map((r) => r.trim()).find((r) => words.includes(r)) ?? reason?.split(',').map((r) => r.trim()).find(Boolean)

const near = (a: Point<unknown>, b: Point<unknown>, tick: number): boolean => b.t - a.t <= 2 * tick

/**
 * A machine's processor, as a share from 0 to 1 of the whole machine, at each
 * point after the first: Δbusy / Δtotal between it and the point before. A
 * build without the counters gives no samples (the figure is hidden).
 */
export function machineCpu(points: readonly Point<MachineValues>[], tick = METRICS_TICK_MS): Sample[] {
  const out: Sample[] = []
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!, v = p.values
    if (!v) { out.push({ t: p.t, v: null, reason: p.code ?? 'not_observed' }); continue }
    if (!('cpuBusyUsec' in v)) continue
    if (v.cpuBusyUsec == null || v.cpuTotalUsec == null) { out.push({ t: p.t, v: null, reason: reasonFor(v.reason, ['cpu_unsupported', 'cpu_not_read']) ?? 'not_observed' }); continue }
    const q = points[i - 1], w = q?.values
    if (!q || !w || w.cpuBusyUsec == null || w.cpuTotalUsec == null || !near(q, p, tick)) { out.push({ t: p.t, v: null, reason: 'first_sample' }); continue }
    const busy = v.cpuBusyUsec - w.cpuBusyUsec, total = v.cpuTotalUsec - w.cpuTotalUsec
    // a reboot sets the counters back: busy or total went down
    if (busy < 0 || total < 0) { out.push({ t: p.t, v: null, reason: 'restarted' }); continue }
    if (total === 0) { out.push({ t: p.t, v: null, reason: 'first_sample' }); continue }
    out.push({ t: p.t, v: Math.min(1, busy / total) })
  }
  return out
}

/** A machine's memory used (bytes) at each point; a gap where it was not read. */
export function machineMemory(points: readonly Point<MachineValues>[]): Sample[] {
  return points.map((p) => (!p.values ? { t: p.t, v: null, reason: p.code ?? 'not_observed' }
    : p.values.memoryUsed == null ? { t: p.t, v: null, reason: reasonFor(p.values.reason, ['memory_not_read']) ?? 'not_observed' }
      : { t: p.t, v: p.values.memoryUsed }))
}

/** Why a Sandbox point has no usage value: the machine read's code, its row's reason, or not observed. */
const sandboxReason = (p: Point<SandboxValues>): string => (!p.values ? p.code ?? 'not_observed' : p.values.usageReason ?? p.values.liveReason ?? 'not_observed')

/**
 * How far a Sandbox's `started_at` may move between two reads of the same
 * run. Linux places a start by the boot time (`btime`) plus clock ticks, to
 * about a second, and a VM whose clock is being corrected moves `btime`:
 * on Lima it was seen to step back 1 s about every 90 s (layerfs-project#182
 * real runs). A restart or a reused name moves it further, and also resets
 * `cpu_usec`, which is checked on its own.
 */
export const START_SLACK_MS = 2_000

/** Whether two reads' `started_at` are one run of the Sandbox ({@link START_SLACK_MS}). */
export function sameRun(a: number | null, b: number | null): boolean {
  if (a == null || b == null) return a === b
  return Math.abs(a - b) <= START_SLACK_MS
}

/**
 * A Sandbox's processor in processors' worth (1.0 = one processor busy the
 * whole time) at each point after the first: Δcpu_usec / Δobserved_at.
 */
export function sandboxCpu(points: readonly Point<SandboxValues>[], tick = METRICS_TICK_MS): Sample[] {
  const out: Sample[] = []
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!, u = p.values?.usage
    if (!p.values || !u || u.cpuUsec == null || p.values.observedAt == null) { out.push({ t: p.t, v: null, reason: sandboxReason(p) }); continue }
    const q = points[i - 1], w = q?.values, wu = w?.usage
    if (!q || !w || !wu || wu.cpuUsec == null || w.observedAt == null || !near(q, p, tick)) { out.push({ t: p.t, v: null, reason: 'first_sample' }); continue }
    if (!sameRun(w.startedAt, p.values.startedAt)) { out.push({ t: p.t, v: null, reason: 'restarted' }); continue }
    const cpu = u.cpuUsec - wu.cpuUsec, ms = p.values.observedAt - w.observedAt
    if (cpu < 0) { out.push({ t: p.t, v: null, reason: 'restarted' }); continue }
    if (ms <= 0) { out.push({ t: p.t, v: null, reason: 'first_sample' }); continue }
    out.push({ t: p.t, v: cpu / (ms * 1000) })
  }
  return out
}

/** A Sandbox's memory now (bytes, file cache and tmpfs included) at each point. */
export function sandboxMemory(points: readonly Point<SandboxValues>[]): Sample[] {
  return points.map((p) => (p.values?.usage?.memoryCurrent != null ? { t: p.t, v: p.values.usage.memoryCurrent } : { t: p.t, v: null, reason: sandboxReason(p) }))
}

/** Each out-of-memory kill: the points where `oom_kills` went up since the point before (the same Sandbox run). */
export function oomMarks(points: readonly Point<SandboxValues>[]): { t: number, kills: number }[] {
  const out: { t: number, kills: number }[] = []
  let before: SandboxValues | null = null
  for (const p of points) {
    const v = p.values
    if (!v?.usage || v.usage.oomKills == null) continue
    if (before && sameRun(before.startedAt, v.startedAt) && before.usage!.oomKills != null && v.usage.oomKills > before.usage!.oomKills!) out.push({ t: p.t, kills: v.usage.oomKills - before.usage!.oomKills! })
    before = v
  }
  return out
}

/** The newest sample: its value (null: a dash) and why it has none. */
export const latest = (samples: readonly Sample[]): Sample | null => samples.at(-1) ?? null

/** The newest point that has values. */
export function newest<V>(points: readonly Point<V>[] | undefined): Point<V> & { values: V } | null {
  if (!points) return null
  for (let i = points.length - 1; i >= 0; i--) if (points[i]!.values) return points[i] as Point<V> & { values: V }
  return null
}

/**
 * One machine as the stats-shaped figures read it (MachineStats.tsx): the
 * sampler's last good answer, marked stale when its newest point is a gap.
 * Undefined before the first answer of this page, or when the host has no
 * point for the machine yet.
 */
export function statsReadOf(snapshot: MetricsSnapshot, machine: string): StatsRead | undefined {
  if (!snapshot.loaded) return undefined
  const m = snapshot.machines[machine]
  if (!m) return { stats: null, at: null, stale: null, reading: false, loaded: false }
  const last = m.points.at(-1)
  const stale = last && !last.values ? { at: m.latest?.at ?? null, code: last.code ?? 'Unknown', message: last.message ?? last.code ?? '' } : null
  return { stats: m.latest?.stats ?? null, at: m.latest?.at ?? null, stale, reading: false, loaded: m.points.length > 0 || !!m.latest }
}

/**
 * A machine's stats read against its last start (UI pass 3 F14): a read taken
 * before the start ended describes the machine before it (stopped, an older
 * worker's uptime), so it reads as not observed yet until a later read lands.
 */
export function sinceStart(read: StatsRead | undefined, startedAt: number | null | undefined): StatsRead | undefined {
  if (!read || startedAt == null || read.at == null || read.at >= startedAt) return read
  return { stats: null, at: null, stale: null, reading: true, loaded: false }
}

/** A Sandbox's newest row, its machine's processors, and its series. */
export function sandboxFigures(snapshot: MetricsSnapshot, name: string): {
  row: (SandboxValues & { t: number }) | null
  /** Its newest point is a gap: the machine read's code. */
  gap: string | null
  cpu: Sample[]
  memory: Sample[]
  kills: { t: number, kills: number }[]
  /** Processors of its machine (the "of 4"), when observed. */
  cpus: number | null
  closedAt: number | null
} | null {
  const b = snapshot.sandboxes[name]
  if (!b) return null
  const row = newest(b.points)
  const last = b.points.at(-1)
  return {
    row: row ? { ...row.values, t: row.t } : null,
    gap: last && !last.values ? last.code ?? 'not_observed' : null,
    cpu: sandboxCpu(b.points, snapshot.tick), memory: sandboxMemory(b.points), kills: oomMarks(b.points),
    cpus: snapshot.machines[b.machine]?.latest?.stats.resources.cpus ?? null,
    closedAt: b.closedAt,
  }
}

/** The machine's Sandboxes the sampler read, with their newest values and processor rate, the most memory first (unknown memory last). */
export function sandboxTable(snapshot: MetricsSnapshot, machine: string): { name: string, row: SandboxValues | null, gap: string | null, cpu: Sample | null, closedAt: number | null }[] {
  const rows = Object.entries(snapshot.sandboxes).filter(([, b]) => b.machine === machine).map(([name, b]) => {
    const row = newest(b.points), last = b.points.at(-1)
    return { name, row: row?.values ?? null, gap: last && !last.values ? last.code ?? 'not_observed' : null, cpu: latest(sandboxCpu(b.points, snapshot.tick)), closedAt: b.closedAt }
  })
  const memory = (r: (typeof rows)[number]) => (r.gap ? null : r.row?.usage?.memoryCurrent ?? null)
  return rows.sort((a, b) => {
    const x = memory(a), y = memory(b)
    if (x == null && y == null) return a.name.localeCompare(b.name)
    if (x == null) return 1
    if (y == null) return -1
    return y - x || a.name.localeCompare(b.name)
  })
}

/** "1.3", "0.05", "12": processors' worth with sense, not noise. */
export function processors(v: number): string {
  if (v >= 10) return String(Math.round(v))
  if (v >= 0.1) return v.toFixed(1)
  if (v > 0) return v < 0.01 ? '<0.01' : v.toFixed(2)
  return '0'
}

/** "34 %". */
export const percent = (share: number): string => `${share > 0 && share < 0.01 ? '<1' : Math.round(share * 100)} %`

/** Up time in words from a start time: "45 s", "12 min", "3 h 5 min", "2 d 4 h". */
export function upTime(startedAt: number | null | undefined, now: number, u: TimeUnits = EN_UNITS): string {
  if (startedAt == null || !Number.isFinite(startedAt) || now < startedAt) return '—'
  const s = Math.floor((now - startedAt) / 1000)
  if (s < 60) return `${s} ${u.s}`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} ${u.min}`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h} ${u.h} ${m % 60} ${u.min}`
  return `${Math.floor(h / 24)} ${u.d} ${h % 24} ${u.h}`
}

/** The unit words an uptime reads in (B2 #5: `16 分钟` in zh, never `16 min`). */
export interface TimeUnits { s: string, min: string, h: string, d: string }
export const EN_UNITS: TimeUnits = { s: 's', min: 'min', h: 'h', d: 'd' }
/** The units from the machines locale (`unitS`, `unitMin`, `unitH`, `unitD`). */
export const unitsOf = (t: (key: 'unitS' | 'unitMin' | 'unitH' | 'unitD') => string): TimeUnits => ({ s: t('unitS'), min: t('unitMin'), h: t('unitH'), d: t('unitD') })
