// The Runs player's clock and model (RunsPage.tsx): a recorded run's SDK calls
// on one timeline that plays at a chosen speed, pauses, and moves to any
// point. Each step sits where its call ended, but an idle gap longer than
// MAX_GAP_MS (a long build, the hours between two ranges) is cut to MAX_GAP_MS,
// so the timeline follows the run's activity, not its wall time. Moving back
// rebuilds the model from the start: a replay is deterministic, and with the
// view derived once at the end (catchUp) about 2,000 calls take ~10 ms.
// Playing forward animates a lone due step as the session tabs do
// (playback.ts); several due at once (a high speed) catch up and draw once.
import * as X from '../../../model/src/index.js'

/** The longest pause the timeline keeps between two steps, in ms. */
export const MAX_GAP_MS = 3000
/** The player's speeds, timeline ms per wall ms. */
export const SPEEDS = [1, 4, 16, 64]

/** One drawn call (the model's trace step) with its place on the timeline. */
export interface RunStep {
  a: string
  label: string
  line: any
  replay: (W: any) => void
  /** ms on the compressed timeline */
  t: number
  /** ms of wall time since the run's first call ended */
  real: number
  /** the range its line came from (RunsPage tags each line), else null */
  range: number | null
}

/** A run's lines as steps on the compressed timeline, and its length in ms. */
export function schedule(lines: any[], { maxGap = MAX_GAP_MS }: { maxGap?: number } = {}): { steps: RunStep[], duration: number } {
  const steps = X.traceSteps(lines, { agent: 'main' }) as RunStep[]
  let t = 0, latest: number | null = null, first: number | null = null
  for (const st of steps) {
    const end = Date.parse(st.line.start) + (st.line.ms || 0)
    first ??= end
    // calls overlap: a step's gap is from the latest end so far, never negative
    if (latest !== null) t += Math.min(Math.max(0, end - latest), maxGap)
    latest = Math.max(latest ?? end, end)
    st.t = t
    st.real = end - first
    st.range = typeof st.line.range === 'number' ? st.line.range : null
  }
  return { steps, duration: t }
}

/** Applies steps without drawing, then derives the view once. */
export function catchUp(W: any, steps: RunStep[]) {
  for (const st of steps) { W.tick = (W.tick || 0) + 1; st.replay(W) }
  X.derive(W)
  W.newNodes = new Set()
  W.flash = {}
  return W
}

export class RunPlayer {
  readonly steps: RunStep[]
  readonly duration: number
  /** the view model after the steps played so far */
  W: any
  /** where the clock is, in timeline ms */
  position = 0
  /** how many steps are applied */
  index = 0
  speed = 1
  playing = false
  private fresh: () => any
  private show: (W: any, step: RunStep | null) => void
  private work: Promise<void> = Promise.resolve()

  /**
   * @param fresh a new, empty view model
   * @param show draws the model after `step` (animated), or after a jump (null)
   */
  constructor(timeline: { steps: RunStep[], duration: number }, fresh: () => any, show: (W: any, step: RunStep | null) => void) {
    this.steps = timeline.steps
    this.duration = timeline.duration
    this.fresh = fresh
    this.show = show
    this.W = fresh()
  }

  /** The step last applied, or null before the first. */
  get current(): RunStep | null { return this.index ? this.steps[this.index - 1] : null }
  get ended() { return this.position >= this.duration && this.index >= this.steps.length }

  play() {
    if (this.ended) void this.seek(0)
    this.playing = true
  }
  pause() { this.playing = false }
  setSpeed(speed: number) { this.speed = speed }

  /** Moves the clock on by `ms` of wall time at the speed, while playing; stops at the end. */
  advance(ms: number): Promise<void> {
    return this.to(() => this.playing ? Math.min(this.duration, this.position + ms * this.speed) : null, true)
  }

  /** Moves the clock to `t` (timeline ms), back or forward, and draws once. */
  seek(t: number): Promise<void> {
    return this.to(() => Math.min(this.duration, Math.max(0, t)), false)
  }

  /** The timeline ms of the first step of `range`, or null. */
  startOf(range: number): number | null {
    return this.steps.find((st) => st.range === range)?.t ?? null
  }

  /** `target` is read when the move runs, after the moves before it (null: stay). */
  private to(target: () => number | null, animate: boolean): Promise<void> {
    // one move at a time, in order: a frame and a seek never interleave
    this.work = this.work.then(async () => {
      const t = target()
      if (t === null) return
      let rebuilt = false
      if (t < this.position) { this.W = this.fresh(); this.index = 0; rebuilt = true }
      this.position = t
      let n = this.index
      while (n < this.steps.length && this.steps[n].t <= t) n++
      const due = this.steps.slice(this.index, n)
      this.index = n
      if (this.position >= this.duration && this.index >= this.steps.length) this.playing = false
      if (animate && due.length) {
        if (due.length > 1) catchUp(this.W, due.slice(0, -1))
        const last = due[due.length - 1]
        await X.runStep(this.W, last, {})
        this.show(this.W, due.length === 1 ? last : null)
      } else if (due.length || rebuilt) {
        catchUp(this.W, due)
        this.show(this.W, null)
      }
    })
    return this.work
  }
}

/** m:ss, or h:mm:ss, of `ms`. */
export function clock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`
}
