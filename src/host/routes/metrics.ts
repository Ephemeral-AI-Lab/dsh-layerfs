/**
 * Machine and Sandbox metrics (layerfs-project#182 D1, D2): one sampler in the
 * host process, owned by the `Machines` route group, and the history it keeps.
 *
 * - **One read at a time across every machine.** The sampler takes the
 *   machines whose `state` is `running` or `ready` in turn, one `machine.stats`
 *   per machine per {@link TICK_MS}, all the time dsh runs (whether a page is
 *   open or not). A read is one process in the inspect lane (cli.ts
 *   `INSPECT_LANE`), so the sampler holds at most one of its two slots and
 *   leaves the other for logs and files. A machine's next read is due
 *   {@link TICK_MS} after its last read *ended*; a machine whose read timed
 *   out skips its next turn. Nothing is queued and nothing is retried.
 * - **A refused or lost read is a gap**, a point with no values and the code
 *   (`Busy`, `Unavailable`, `Timeout`, …). A machine that is not running is
 *   never asked: each turn it gets a gap point with `machine_stopped`.
 * - **History lives in memory only**: a ring of {@link RING} points (one hour
 *   at 15 s) per machine and per Sandbox. A Sandbox that is no longer in its
 *   machine's rows keeps its ring {@link CLOSED_KEEP_MS} after it went, then
 *   it is dropped. Nothing is written to disk: after a dsh restart the history
 *   starts empty (`epoch` says when it began).
 *
 * The machine list the sampler takes its turns from is `machine.list` (a kept
 * read shared with the machines view), asked at most once per {@link TICK_MS}.
 *
 * **Liveness is sampled here too** (layerfs-project#B4): alongside its stats
 * read, each machine's turn runs the live probe (`machine get --with live`)
 * through {@link SamplerDeps.probe}, so `GET /api/machines` answers from the
 * last probe instead of paying 200+ ms on a page read. A ready or unknown
 * machine is probed every {@link TICK_MS}; a stop, start or any state change
 * asks once more; a stopped or broken machine is otherwise not probed. A
 * probe refusal is kept by the view as the machine's last known liveness.
 *
 * `GET /api/metrics?machines=<names>&since=<seq>` ({@link MetricsSampler.view})
 * is answered from memory with no LayerFS call. Rates are not computed here:
 * the page turns two counters into a rate (src/client/machines/metrics.ts).
 */
import { liveOf, statsAnswer, type MachineStats, type SandboxRow, type Usage } from './observed.ts'

/** One machine's turn: a read every 15 s, counted from the end of its last read. */
export const TICK_MS = 15_000
/** Points kept per machine and per Sandbox: one hour at {@link TICK_MS}. */
export const RING = 240
/** How long a Sandbox that went keeps its history. */
export const CLOSED_KEEP_MS = 10 * 60_000
/** States whose machine is read (2.0: `ready`); any other state is not asked (`machine_stopped`). */
export const SAMPLED_STATES = new Set(['ready'])
/** The gap code of a machine that is not running. */
export const STOPPED = 'machine_stopped'

/** What one machine read observed of the machine, as a chart needs it. */
export interface MachineValues {
  /** The answering side's clock, epoch ms. */
  observedAt: number | null
  cpus: number | null
  /** Absent from a build before the counters; null when not read. */
  cpuBusyUsec?: number | null
  cpuTotalUsec?: number | null
  memoryUsed: number | null
  memoryTotal: number | null
  diskUsed: number | null
  diskTotal: number | null
  /** `resources.reason`, as it came. */
  reason: string | null
}

/** What one machine read observed of one of its Sandboxes (its `machine.stats` row). */
export interface SandboxValues {
  /** The answering side's clock, epoch ms (the machine read's `observed_at`). */
  observedAt: number | null
  live: boolean | null
  liveReason?: string
  startedAt: number | null
  usage: Usage | null
  usageReason?: string
}

/**
 * One point of a ring: `t` is this host's clock when the read ended. `values`
 * null is a gap, with `code` (the refusal's code, or `machine_stopped`) and,
 * for a refusal, LayerFS's `message`.
 */
export interface Point<V> { seq: number, t: number, values: V | null, code?: string, message?: string }

interface MachineTrack {
  name: string
  state: string
  /** Whether `machine.list`'s record is readable: an unreadable one is not probed (`machine get` refuses it). */
  readable: boolean
  /** When this machine's next turn is (this host's clock). */
  due: number
  /** When this machine's next live probe is due; `Infinity` when it stopped being worth probing (a stopped or broken record). */
  probeDue: number
  /** Its last read timed out: its next turn is skipped. */
  skip: boolean
  points: Point<MachineValues>[]
  /** The last good answer, whole (the pages' figures), and when it was read. */
  latest: { at: number, stats: MachineStats } | null
}

interface SandboxTrack { name: string, machine: string, closedAt: number | null, points: Point<SandboxValues>[] }

/** `GET /api/metrics`: what the sampler holds for the machines asked, from memory. */
export interface MetricsView {
  /** When this sampler began (this host's start): history before it was never kept. */
  epoch: number
  /** The newest point's sequence number; send it back as `since` to get only newer points. */
  seq: number
  /** The `since` this answer covers (0: everything kept). */
  since: number
  now: number
  tick: number
  ring: number
  /** The pinned CLI has machine.stats (the sampler reads nothing otherwise). */
  offered: boolean
  machines: Record<string, {
    state: string
    latest: { at: number, stats: MachineStats } | null
    points: Point<MachineValues>[]
  }>
  sandboxes: Record<string, { machine: string, closedAt: number | null, points: Point<SandboxValues>[] }>
}

export interface Clock {
  now: () => number
  setTimeout: (run: () => void, ms: number) => unknown
  clearTimeout: (timer: unknown) => void
}
const realClock: Clock = { now: () => Date.now(), setTimeout: (run, ms) => { const t = setTimeout(run, ms); t.unref?.(); return t }, clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>) }

/** What the sampler needs from LayerFS: the machine list and one machine's stats. */
export interface SamplerDeps {
  /** `machine.list()`'s machines: `{ name, state }` each, and whether its record can be read (an unreadable record is not probed). */
  list: () => Promise<{ name: string, state: string, readable?: boolean }[]>
  /** One `machine.stats(name)`, aborted by `signal` when the sampler stops. */
  stats: (name: string, signal: AbortSignal) => Promise<unknown>
  /**
   * One machine's live probe (`machine get <m> --detail --with live`), the
   * only read that says whether a Docker machine died. It runs in the
   * machine's turns, never on a page read (layerfs-project#B4): once every
   * {@link TICK_MS} while the record says `ready` or `unknown`, and once more
   * when its record changes (a stop, a start). Absent: no liveness sampling
   * (a test or a caller that has nothing to probe).
   */
  probe?: (name: string) => Promise<unknown>
  /** Whether the pinned CLI has machine.stats. */
  offered: () => Promise<boolean>
  clock?: Clock
}

const machineValues = (s: MachineStats): MachineValues => {
  const r = s.resources
  return {
    observedAt: s.observedAt, cpus: r.cpus,
    ...('cpuBusyUsec' in r ? { cpuBusyUsec: r.cpuBusyUsec ?? null } : {}),
    ...('cpuTotalUsec' in r ? { cpuTotalUsec: r.cpuTotalUsec ?? null } : {}),
    memoryUsed: r.memoryUsed, memoryTotal: r.memoryTotal, diskUsed: r.diskUsed, diskTotal: r.diskTotal, reason: r.reason,
  }
}

const sandboxValues = (row: SandboxRow, observedAt: number | null): SandboxValues => ({
  observedAt, live: row.live, ...(row.liveReason ? { liveReason: row.liveReason } : {}), startedAt: row.startedAt,
  usage: row.usage, ...(row.usageReason ? { usageReason: row.usageReason } : {}),
})

const push = <V>(points: Point<V>[], point: Point<V>): void => {
  points.push(point)
  if (points.length > RING) points.splice(0, points.length - RING)
}

/** A gap code as the `live_reason` word the pages know (`busy`, `unavailable`, `not_answered`, `machine_stopped`). */
const liveReasonOf = (code: string): string => (code === 'Timeout' ? 'not_answered' : code === STOPPED ? STOPPED : code.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase())

export class MetricsSampler {
  readonly epoch: number
  private readonly clock: Clock
  private readonly machines = new Map<string, MachineTrack>()
  private readonly sandboxes = new Map<string, SandboxTrack>()
  /** Sandboxes made since a read began, by name, with when: that read's rows predate them (U10 add-on 7). */
  private readonly madeAt = new Map<string, number>()
  private listedAt = -Infinity
  private seq = 0
  private stepping = false
  private running = false
  private timer: unknown
  private controller: AbortController | null = null
  private isOffered = false
  /** Reads started (tests and the load count). */
  reads = 0

  constructor(private readonly deps: SamplerDeps) {
    this.clock = deps.clock ?? realClock
    this.epoch = this.clock.now()
  }

  /** Begin sampling (once per host). */
  start(): void {
    if (this.running) return
    this.running = true
    this.schedule(0)
  }

  /** Stop: the read in flight is aborted; nothing more is read. */
  stop(): void {
    this.running = false
    this.clock.clearTimeout(this.timer)
    this.timer = undefined
    this.controller?.abort()
  }

  /** A machine was started, stopped, created or removed: the next turn lists the machines again (no read of its own). */
  relist(): void { this.listedAt = -Infinity }

  /** Whether a read is running now (tests). */
  get reading(): boolean { return this.controller !== null }

  private schedule(ms: number): void {
    if (!this.running) return
    this.clock.clearTimeout(this.timer)
    this.timer = this.clock.setTimeout(() => { this.timer = undefined; void this.step() }, Math.max(0, ms))
  }

  /**
   * One turn: list when due, then the machine whose turn is first (a stats
   * read, a live probe, a stopped gap, or a skipped turn). One LayerFS call
   * per turn: a probe and a stats read of the same machine never overlap.
   */
  async step(): Promise<void> {
    if (!this.running || this.stepping) return
    this.stepping = true
    try {
      let now = this.clock.now()
      if (now - this.listedAt >= TICK_MS) {
        this.listedAt = now
        this.isOffered = await this.deps.offered().catch(() => false)
        // the liveness sampler still needs the rows when the pinned CLI cannot read stats
        if (this.isOffered || this.deps.probe) {
          try { this.listed(await this.deps.list(), this.clock.now()) } catch { /* the last list stays; asked again next tick */ }
        }
        now = this.clock.now()
      }
      this.prune(now)
      const action = this.nextAction(now)
      if (!action) return
      if (action.kind === 'probe') { await this.probe(action.m); return }
      const next = action.m
      if (next.skip) { next.skip = false; next.due = now + TICK_MS; return }
      if (!SAMPLED_STATES.has(next.state)) { this.gap(next, now, STOPPED); next.due = now + TICK_MS; return }
      await this.read(next)
    } finally {
      this.stepping = false
      if (this.running) this.schedule(this.nextIn())
    }
  }

  /** The earliest due turn now: a stats read, or a live probe (an equal time reads stats first). */
  private nextAction(now: number): { kind: 'stats' | 'probe', m: MachineTrack } | null {
    let next: { kind: 'stats' | 'probe', m: MachineTrack, at: number } | null = null
    if (this.isOffered) for (const m of this.machines.values()) if (m.due <= now && (!next || m.due < next.at)) next = { kind: 'stats', m, at: m.due }
    if (this.deps.probe) for (const m of this.machines.values()) if (m.readable && m.probeDue <= now && (!next || m.probeDue < next.at)) next = { kind: 'probe', m, at: m.probeDue }
    return next && { kind: next.kind, m: next.m }
  }

  /** One live probe: its answer (or refusal) is the machines view's last known liveness; nothing is queued or retried. */
  private async probe(m: MachineTrack): Promise<void> {
    const controller = new AbortController()
    this.controller = controller
    try { await this.deps.probe?.(m.name) } catch { /* the view keeps the refusal the probe stored */ }
    this.controller = null
    if (!this.running) return
    // a ready or unknown machine is asked again next tick; a stopped/broken one only got the probe its state change asked for
    m.probeDue = SAMPLED_STATES.has(m.state) || m.state === 'unknown' ? this.clock.now() + TICK_MS : Infinity
  }

  /** Milliseconds until the next turn or list. */
  private nextIn(): number {
    const now = this.clock.now()
    let at = this.listedAt + TICK_MS
    for (const m of this.machines.values()) {
      if (this.isOffered) at = Math.min(at, m.due)
      if (this.deps.probe && m.readable) at = Math.min(at, m.probeDue)
    }
    return Math.max(0, at - now)
  }

  private listed(rows: { name: string, state: string, readable?: boolean }[], now: number): void {
    const seen = new Set<string>()
    for (const row of rows) {
      if (!row || typeof row.name !== 'string' || !row.name) continue
      seen.add(row.name)
      const state = typeof row.state === 'string' && row.state ? row.state : 'unknown'
      const readable = row.readable !== false
      const known = this.machines.get(row.name)
      if (known) {
        // a machine that just began to run is read at its next turn, not 15 s after its last stopped gap
        if (!SAMPLED_STATES.has(known.state) && SAMPLED_STATES.has(state)) known.due = Math.min(known.due, now)
        // a state that changed makes the last probe stale: ask once, even a stop (its free disk is not the running machine's)
        if (known.state !== state) known.probeDue = Math.min(known.probeDue, now)
        known.state = state
        known.readable = readable
      } else this.machines.set(row.name, { name: row.name, state, readable, due: now, probeDue: now, skip: false, points: [], latest: null })
    }
    for (const [name] of this.machines) {
      if (seen.has(name)) continue
      // a removed machine: its history goes, its Sandboxes' history is kept as closed
      this.machines.delete(name)
      for (const b of this.sandboxes.values()) if (b.machine === name && b.closedAt === null) b.closedAt = now
    }
  }

  private async read(m: MachineTrack): Promise<void> {
    const controller = new AbortController()
    this.controller = controller
    this.reads++
    const begun = this.clock.now()
    let answer: unknown, error: any = null
    try { answer = await this.deps.stats(m.name, controller.signal) } catch (e) { error = e }
    this.controller = null
    if (!this.running) return
    const end = this.clock.now()
    m.due = end + TICK_MS
    if (error) {
      const code = typeof error?.code === 'string' ? error.code : 'Unknown'
      const message = error instanceof Error ? error.message : typeof error?.message === 'string' ? error.message : String(error)
      this.gap(m, end, code, message)
      if (code === 'Timeout') m.skip = true
      return
    }
    const stats = statsAnswer(answer)
    const seq = ++this.seq
    m.latest = { at: end, stats }
    push(m.points, { seq, t: end, values: machineValues(stats) })
    const items = stats.sandboxes.items
    // an older worker sends no rows: its Sandboxes get no points (the pages hide their values)
    if (!items) return
    const here = new Set<string>()
    for (const row of items) {
      here.add(row.name)
      // a read that began before this Sandbox was made saw its create (or an earlier one of that name), not its daemon now
      const made = this.madeAt.get(row.name)
      if (made !== undefined && begun <= made) continue
      this.madeAt.delete(row.name)
      let b = this.sandboxes.get(row.name)
      if (!b) this.sandboxes.set(row.name, b = { name: row.name, machine: m.name, closedAt: null, points: [] })
      b.machine = m.name
      b.closedAt = null
      push(b.points, { seq, t: end, values: sandboxValues(row, stats.observedAt) })
    }
    for (const b of this.sandboxes.values()) if (b.machine === m.name && b.closedAt === null && !here.has(b.name)) b.closedAt = end
  }

  /** A gap point for the machine and each of its open Sandboxes. */
  private gap(m: MachineTrack, t: number, code: string, message?: string): void {
    const seq = ++this.seq
    const point = { seq, t, values: null, code, ...(message ? { message } : {}) }
    push(m.points, point)
    for (const b of this.sandboxes.values()) if (b.machine === m.name && b.closedAt === null) push(b.points, point)
  }

  private prune(now: number): void {
    for (const [name, b] of this.sandboxes) if (b.closedAt !== null && now - b.closedAt >= CLOSED_KEEP_MS) this.sandboxes.delete(name)
    for (const [name, at] of this.madeAt) if (now - at >= CLOSED_KEEP_MS) this.madeAt.delete(name)
  }

  /**
   * `GET /api/metrics?machines=a,b&since=<seq>`: what is kept for those
   * machines (every machine when none is named) and their Sandboxes, only the
   * points newer than `since`. From memory: no LayerFS call.
   */
  view(query: URLSearchParams): MetricsView {
    const names = (query.get('machines') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    const raw = Number(query.get('since') ?? 0)
    // a `since` past what this sampler numbered is another host's (dsh restarted): everything kept
    const since = Number.isSafeInteger(raw) && raw > 0 && raw <= this.seq ? raw : 0
    const wanted = names.length ? new Set(names) : null
    const machines: MetricsView['machines'] = {}
    for (const m of this.machines.values()) {
      if (wanted && !wanted.has(m.name)) continue
      machines[m.name] = { state: m.state, latest: m.latest, points: m.points.filter((p) => p.seq > since) }
    }
    const sandboxes: MetricsView['sandboxes'] = {}
    for (const b of this.sandboxes.values()) {
      if (wanted && !wanted.has(b.machine)) continue
      const points = b.points.filter((p) => p.seq > since)
      if (since && !points.length && b.closedAt === null) continue
      sandboxes[b.name] = { machine: b.machine, closedAt: b.closedAt, points }
    }
    return { epoch: this.epoch, seq: this.seq, since, now: this.clock.now(), tick: TICK_MS, ring: RING, offered: this.isOffered, machines, sandboxes }
  }

  /** The machine's last good answer and its newest point (the stats route). */
  machine(name: string): { latest: MachineTrack['latest'], last: Point<MachineValues> | null, state: string } | null {
    const m = this.machines.get(name)
    return m ? { latest: m.latest, last: m.points.at(-1) ?? null, state: m.state } : null
  }

  /**
   * A Sandbox was just made: what was kept for its name is of its create or an
   * earlier Sandbox, so it is dropped, and a read already under way when it was
   * made adds nothing for it. Until the next read its `live` is absent and its
   * card shows its record's state (never "Daemon not running" from before).
   */
  created(name: string): void {
    this.sandboxes.delete(name)
    this.madeAt.set(name, this.clock.now())
  }

  /**
   * Whether a Sandbox's daemon ran at its newest point, as `sandbox.list
   * --live` said it (`live`, `liveReason`); absent when the sampler has no
   * point for it (an older worker, or not read yet).
   */
  liveOf(name: string): { live?: boolean | null, liveReason?: string } {
    const last = this.sandboxes.get(name)?.points.at(-1)
    if (!last) return {}
    if (!last.values) return { live: null, liveReason: liveReasonOf(last.code ?? 'not_observed') }
    return liveOf({ live: last.values.live, live_reason: last.values.liveReason })
  }

  /** How many Sandboxes hold a ring, and how many points in all (tests, the load note). */
  get size(): { machines: number, sandboxes: number, points: number } {
    let points = 0
    for (const m of this.machines.values()) points += m.points.length
    for (const b of this.sandboxes.values()) points += b.points.length
    return { machines: this.machines.size, sandboxes: this.sandboxes.size, points }
  }
}
