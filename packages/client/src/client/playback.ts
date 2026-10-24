// Plays a session's SDK calls in the LayerFS tab in step with the run: each
// step (one drawn trace line; the SDK's own service Sandbox and its backend
// reads ride with the next one, by the trace source's rule X.ridesAlong)
// shows LAG_MS after the call ended, so the gaps on screen are the run's
// own gaps and the view never falls behind it. LAG_MS is longer than the
// Host poll (1.5 s), so a call is usually here before its time. Steps
// whose time has passed (the tab opened, a rebuild, a late poll) apply at
// once and draw once. How fast a demo runs is the mock's business
// (mock/src/pace.js), not the playback's; a Workspace that a script mounts and
// unmounts within a second still shows, as the view's fading trail.
import * as X from '../../../model/src/index.js'

const LAG_MS = 2000

export interface Step {
  a: string
  line: any
  lines: any[]
  replay: (W: any) => void
  due: number
}

/** When a line shows: LAG_MS after it ended, by the Host's clock. */
export const dueOf = (line: { start: string; ms?: number }) => Date.parse(line.start) + (line.ms || 0) + LAG_MS

export class Playback {
  W: any
  private seen = new Set<string>()
  private done = new Set<string>()
  private pending: any[] = []
  private queue: Step[] = []
  private t0: number | null = null
  private running = false
  private stopped = false
  private wake: (() => void) | null = null
  private feeding: Promise<void> = Promise.resolve()
  played = 0

  /**
   * @param fresh a new view model (an empty trace replay)
   * @param show draws the model after `step`, or after catching up (null)
   * @param now the clock lines are timed by (the Host's, as this browser sees it)
   */
  constructor(fresh: () => any, show: (W: any, step: Step | null) => void, now: () => number = Date.now) {
    this.show = show
    this.now = now
    this.W = fresh()
  }
  private show: (W: any, step: Step | null) => void
  private now: () => number

  /** Steps still to play. */
  get waiting() {
    return this.queue.length
  }

  /** Of a session's `lines`, the end lines not played yet (queued, or not taken yet): their calls still show as running. */
  unplayed(lines: any[]) {
    return lines.filter((line) => line.phase !== 'start' && !this.done.has(line.id))
  }

  /** Takes a session's lines so far (agents named): the new ones queue, each for its time. */
  feed(lines: any[], agent: string): Promise<void> {
    const next = this.feeding.then(() => this.take(lines, agent))
    this.feeding = next.catch(() => {})
    return next
  }

  private async take(lines: any[], agent: string) {
    const ends = X.endLines(lines)
    if (!ends.length) return
    this.t0 ??= Date.parse(ends[0].start)
    const t0 = this.t0
    for (const line of ends) {
      if (this.seen.has(line.id)) continue
      this.seen.add(line.id)
      this.pending.push(line)
      if (X.ridesAlong(line.method)) continue
      const batch = this.pending
      this.pending = []
      // a step never shows before the one before it
      // a line ended before now, so with a browser clock behind the Host's it still shows within LAG_MS
      const due = Math.max(
        Math.min(dueOf(line), this.now() + LAG_MS),
        this.queue.length ? this.queue[this.queue.length - 1].due : 0,
      )
      this.queue.push({
        a: line.agent || agent,
        line,
        lines: batch,
        due,
        replay: (W) => {
          for (const l of batch) X.replayLine(W, l, { agent, t0 })
        },
      })
    }
    this.wake?.()
    await this.play()
  }

  stop() {
    this.stopped = true
    this.queue = []
    this.wake?.()
  }

  private async play() {
    if (this.running) return
    this.running = true
    try {
      while (this.queue.length && !this.stopped) {
        await this.until(this.queue[0].due)
        if (this.stopped) return
        // every step whose time has come, drawn once: the last one animates
        // when it is the run's latest, else the view just catches up
        const now = this.now()
        let last: Step | null = null
        while (this.queue.length && this.queue[0].due <= now) {
          last = this.queue.shift()!
          await X.runStep(this.W, last, {})
          for (const line of last.lines) this.done.add(line.id)
          this.played++
        }
        if (last) this.show(this.W, now - last.due < LAG_MS ? last : null)
      }
    } finally {
      this.running = false
    }
  }

  /** Waits until `due`; a stop or a new line wakes it to look again. */
  private async until(due: number) {
    const left = due - this.now()
    if (left <= 0) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, left)
      this.wake = () => {
        clearTimeout(timer)
        resolve()
      }
    })
    this.wake = null
  }
}
