/**
 * The assistant step's text while it runs (docs/specs/layerfs-trajectory.md).
 *
 * DSH streams a running step's model output as `assistant/live-chunk` events
 * on the session's client event feed — the contiguous window behind
 * `SessionBinding.eventSource`, which DSH's own Conversation assembler folds
 * (`@deepseek-ai/dsh-api-session-controller/client`, contract/events.ts). The
 * host's `session.trajectory` has an assistant record only after the step's
 * `assistant/message` reaches the log, so this keeps the in-flight text
 * client-side: deltas are appended here, the view renders them at most ten
 * times a second, and the next `session.trajectory` read replaces them with the
 * log's own record. Nothing is written to the host and the log stays the only
 * durable truth; `session.trajectory` does not change.
 *
 * Memory is bounded: the current step and at most the one before it (kept so a
 * step boundary does not blink before the log read catches up), each capped at
 * {@link MAX_LIVE_TEXT} characters with a truncation note in the view.
 */
import { useEffect, useState } from 'react'
import type { AssistantRecord, TrajectoryRecord, TrajectoryTurn } from '../../shared/trajectory.ts'

/** Characters kept of one step's streamed text; beyond this the view says so. */
export const MAX_LIVE_TEXT = 64 * 1024
/** Renders a running step's growing text at most this many times a second. */
export const LIVE_FRAME_MS = 100

/** One running (or just-settled) assistant step, as the stream has built it so far. */
export interface LiveStep {
  /** The attempt's identity: a retry restarts the text. */
  attemptId: string
  turn: number
  step: number
  text: string
  /** False once the attempt or step settled; the text stays until the log read has it. */
  running: boolean
  truncated: boolean
  interrupted?: boolean
  /** First and latest live-chunk times (client clock), for the row's duration. */
  startedAt?: number
  at?: number
  /** Text-block indexes already joined into `text`: a new block starts a paragraph. */
  blocks: readonly number[]
}

/** The current step and the one it replaced, in that order of recency. */
export interface LiveSteps {
  current: LiveStep | null
  previous: LiveStep | null
}

export const EMPTY_LIVE_STEPS: LiveSteps = { current: null, previous: null }

// ------------------------------------------------------ the controller's feed

/** The parts of DSH's public client event contract this file reads (contract/events.ts). */
export interface LiveChunk {
  type: string
  index?: number
  text?: string
}

export interface LiveChunkEvent {
  readonly type: 'assistant/live-chunk'
  readonly seq: number
  readonly time: number
  readonly data: {
    readonly attemptId: string
    readonly turn: number
    readonly step: number
    readonly chunk: LiveChunk
  }
}

export interface LiveSessionEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data?: any
}

export type LiveEntry =
  | { readonly type: 'event', readonly event: LiveSessionEvent }
  | { readonly type: 'transient', readonly event: LiveChunkEvent }

export type LiveChange =
  | { readonly kind: 'replace', readonly entries: readonly LiveEntry[] }
  | { readonly kind: 'prepend', readonly entries: readonly LiveEntry[] }
  | { readonly kind: 'append', readonly entries: readonly LiveEntry[] }
  | { readonly kind: 'settle-assistant', readonly attemptId: string, readonly entry?: { readonly type: 'event', readonly event: LiveSessionEvent } }

export interface LiveWindow {
  readonly entries: readonly LiveEntry[]
  readonly hasMore: boolean
  readonly revision: number
  readonly change: LiveChange
}

/** `SessionBinding.eventSource`: the observable window, with its latest delta. */
export interface LiveEventSource {
  getSnapshot(): LiveWindow
  subscribe(listener: () => void): () => void
}

/** What the view subscribes to: live steps, deduped and frame-throttled. */
export interface LiveStepsSource {
  getSnapshot(): LiveSteps
  subscribe(listener: () => void): () => void
}

// ------------------------------------------------------------ the reducer

/** Join a message's text blocks the way DSH's trajectory does (paragraphs). */
function messageText(content: unknown): string {
  const parts: string[] = []
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
  }
  return parts.join('\n\n')
}

function capped(text: string): { text: string, truncated: boolean } {
  return text.length > MAX_LIVE_TEXT
    ? { text: text.slice(0, MAX_LIVE_TEXT), truncated: true }
    : { text, truncated: false }
}

/** Append a delta, keeping block order (a later text block starts a new paragraph) and the cap. */
function appendText(step: LiveStep, piece: string, index: number | undefined): LiveStep {
  const room = MAX_LIVE_TEXT - step.text.length
  if (room <= 0) return step.truncated ? step : { ...step, truncated: true }
  let text = step.text
  let blocks = step.blocks
  if (index !== undefined && !blocks.includes(index)) {
    blocks = [...blocks, index]
    if (text.length > 0) text += '\n\n'
  }
  const left = MAX_LIVE_TEXT - text.length
  const cut = piece.length > left
  text += cut ? piece.slice(0, left) : piece
  return { ...step, text, blocks, truncated: step.truncated || cut }
}

function applyChunk(step: LiveStep, chunk: LiveChunk, time: number): LiveStep {
  const running: LiveStep = {
    ...step,
    startedAt: step.startedAt ?? time,
    at: time,
    running: true,
  }
  if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) {
    return appendText(running, chunk.text, typeof chunk.index === 'number' ? chunk.index : undefined)
  }
  return step.at === time && step.running ? step : running
}

/** One durable event against the live state. Only the live step's own story moves it. */
function applyDurable(steps: LiveSteps, event: LiveSessionEvent): LiveSteps {
  const current = steps.current
  if (!current) return steps
  const data = event.data ?? {}
  const turn: unknown = data.turn
  const step: unknown = data.step
  switch (event.type) {
    case 'assistant/message': {
      if (turn !== current.turn || step !== current.step) return steps
      const final = capped(messageText(data.message?.content))
      return {
        ...steps,
        current: {
          ...current,
          text: final.text,
          truncated: final.truncated,
          running: false,
          interrupted: data.interrupted === true,
        },
      }
    }
    case 'step/end':
      if (turn !== current.turn || step !== current.step || !current.running) return steps
      return { ...steps, current: { ...current, running: false } }
    case 'turn/end':
      if (turn !== current.turn || !current.running) return steps
      return { ...steps, current: { ...current, running: false } }
    case 'step/start':
      if (turn === current.turn && step === current.step) return steps
      return { current: null, previous: current }
    case 'turn/start':
      if (turn === current.turn) return steps
      return { current: null, previous: current }
    case 'llm/retry':
      // The failed attempt's text is not part of the message: a retry starts clean.
      if (turn !== current.turn || step !== current.step) return steps
      return { ...steps, current: { ...current, text: '', truncated: false, blocks: [], running: true } }
    case 'assistant/attempt':
      // A failed attempt settled without a message; the next attempt resets the text.
      if (turn !== current.turn || step !== current.step || !current.running) return steps
      return { ...steps, current: { ...current, running: false } }
    default:
      return steps
  }
}

/** Fold one feed entry into the live steps; the same reference means nothing moved. */
export function applyLiveEntry(steps: LiveSteps, entry: LiveEntry): LiveSteps {
  if (entry.type === 'transient') {
    const event = entry.event
    if (event?.type !== 'assistant/live-chunk') return steps
    const { attemptId, turn, step, chunk } = event.data
    const current = steps.current
    if (current && current.attemptId === attemptId) {
      const next = applyChunk(current, chunk, event.time)
      return next === current ? steps : { ...steps, current: next }
    }
    const base: LiveStep = {
      attemptId, turn, step, text: '', running: true, truncated: false,
      startedAt: event.time, at: event.time, blocks: [],
    }
    const previous = current && (current.turn !== turn || current.step !== step) ? current : steps.previous
    return { current: applyChunk(base, chunk, event.time), previous }
  }
  return applyDurable(steps, entry.event)
}

/** Fold a whole window (a reconnect's replacement) from scratch. */
export function foldLiveEntries(entries: readonly LiveEntry[]): LiveSteps {
  let steps = EMPTY_LIVE_STEPS
  for (const entry of entries) steps = applyLiveEntry(steps, entry)
  return steps
}

/** Apply the feed's latest delta to the source's cached state. */
export function applyLiveChange(steps: LiveSteps, change: LiveChange): LiveSteps {
  switch (change.kind) {
    case 'replace':
      return foldLiveEntries(change.entries)
    case 'prepend':
      return steps
    case 'append': {
      let next = steps
      for (const entry of change.entries) next = applyLiveEntry(next, entry)
      return next
    }
    case 'settle-assistant': {
      const current = steps.current
      // Only the attempt that settled: a retry may already be streaming.
      if (!current || current.attemptId !== change.attemptId) return steps
      if (change.entry) {
        const next = applyLiveEntry(steps, change.entry)
        if (next !== steps) return next
      }
      if (!current.running) return steps
      return { ...steps, current: { ...current, running: false } }
    }
    default:
      return steps
  }
}

// ------------------------------------------------------------- the source

export interface LiveStepSourceOptions {
  /** Coalescing window; defaults to {@link LIVE_FRAME_MS}. */
  frameMs?: number
  /** Test seam for the timer. */
  schedule?: (run: () => void, ms: number) => unknown
  cancel?: (token: unknown) => void
  /** Test seam: whether frames may publish (a visible page). */
  visible?: () => boolean
  /** Test seam for the visibility listener. */
  listenVisible?: (onChange: () => void) => () => void
  /** Test seam: whether the reader asked for reduced motion (frames then come {@link REDUCED_MOTION_FRAME_MS} apart). */
  reducedMotion?: () => boolean
}

/**
 * With `prefers-reduced-motion`, the running text still updates (it is content,
 * and the step's end must reach the view) but at most once a second, so it does
 * not scroll by as an animation. Only the caret's blink stops (the CSS does it).
 */
export const REDUCED_MOTION_FRAME_MS = 1000

const documentVisible = (): boolean => typeof document === 'undefined' || document.visibilityState !== 'hidden'
const prefersReducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

function listenVisibility(onChange: () => void): () => void {
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return () => {}
  document.addEventListener('visibilitychange', onChange)
  return () => document.removeEventListener('visibilitychange', onChange)
}

/**
 * Observe one session's event feed and publish the running step's text at most
 * `frameMs` apart (at most once a second with reduced motion). A hidden page
 * accumulates no timers or renders: deltas are still folded (cheap, bounded)
 * and the latest state is published once when the page is visible again.
 */
export class LiveStepSource implements LiveStepsSource {
  private readonly events: LiveEventSource
  private readonly frameMs: number
  private readonly scheduleFn: (run: () => void, ms: number) => unknown
  private readonly cancelFn: (token: unknown) => void
  private readonly visible: () => boolean
  private readonly listenVisible: (onChange: () => void) => () => void
  private readonly reducedMotion: () => boolean

  private state: LiveSteps = EMPTY_LIVE_STEPS
  /**
   * The window revision `state` was folded through; undefined before the first
   * read and after the last listener left. The feed's revision goes up by one
   * per published change, so a change that is not the next one (events while
   * nobody listened, e.g. between a render's read and the effect's subscribe)
   * refolds the whole window instead of applying only the latest delta.
   */
  private revision: number | undefined
  private readonly listeners = new Set<() => void>()
  private offFeed: (() => void) | undefined
  private offVisible: (() => void) | undefined
  private timer: unknown
  private dirty = false

  constructor(events: LiveEventSource, options: LiveStepSourceOptions = {}) {
    this.events = events
    this.frameMs = options.frameMs ?? LIVE_FRAME_MS
    this.scheduleFn = options.schedule ?? ((run, ms) => setTimeout(run, ms))
    this.cancelFn = options.cancel ?? ((token) => clearTimeout(token as ReturnType<typeof setTimeout>))
    this.visible = options.visible ?? documentVisible
    this.listenVisible = options.listenVisible ?? listenVisibility
    this.reducedMotion = options.reducedMotion ?? prefersReducedMotion
  }

  getSnapshot = (): LiveSteps => {
    // Subscribed, the feed keeps the state current; otherwise read the window now.
    if (!this.offFeed) this.sync()
    return this.state
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (this.listeners.size === 1) {
      const before = this.state
      this.sync()
      this.offFeed = this.events.subscribe(this.onFeed)
      this.offVisible = this.listenVisible(this.onVisible)
      // Chunks that arrived since the last read are on screen with the next frame.
      if (this.state !== before) this.schedule()
    }
    let active = true
    return () => {
      if (!active) return
      active = false
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.stop()
    }
  }

  /** Fold the whole window when it moved since the state was folded. */
  private sync(): void {
    const window = this.events.getSnapshot()
    if (window.revision === this.revision) return
    this.state = foldLiveEntries(window.entries)
    this.revision = window.revision
  }

  private onFeed = (): void => {
    const window = this.events.getSnapshot()
    if (window.revision === this.revision) return
    // Only the next change may be applied as a delta; a gap refolds the window.
    const next = this.revision !== undefined && window.revision === this.revision + 1
      ? applyLiveChange(this.state, window.change)
      : foldLiveEntries(window.entries)
    this.revision = window.revision
    if (next === this.state) return
    this.state = next
    this.schedule()
  }

  private schedule(): void {
    if (!this.visible()) { this.dirty = true; return }
    if (this.timer !== undefined) return
    const ms = this.reducedMotion() ? Math.max(this.frameMs, REDUCED_MOTION_FRAME_MS) : this.frameMs
    this.timer = this.scheduleFn(() => {
      this.timer = undefined
      if (!this.visible()) { this.dirty = true; return }
      this.emit()
    }, ms)
  }

  private emit(): void {
    this.dirty = false
    for (const listener of [...this.listeners]) listener()
  }

  private onVisible = (): void => {
    if (!this.visible() || this.timer !== undefined || !this.dirty) return
    this.dirty = false
    this.emit()
  }

  private stop(): void {
    this.offFeed?.()
    this.offFeed = undefined
    this.offVisible?.()
    this.offVisible = undefined
    if (this.timer !== undefined) {
      this.cancelFn(this.timer)
      this.timer = undefined
    }
    this.dirty = false
    // A later subscriber re-reads the window: events during the gap were not folded.
    this.revision = undefined
  }
}

/** One source per session binding, created on first sight (the caller caches it). */
export function createLiveStepSource(events: LiveEventSource, options?: LiveStepSourceOptions): LiveStepSource {
  return new LiveStepSource(events, options)
}

// ------------------------------------------------------------- the view hook

/** Subscribe to a live-step source for the current step and the one before it. */
export function useLiveSteps(source: LiveStepsSource | undefined): LiveSteps {
  const [state, setState] = useState<LiveSteps>(() => source?.getSnapshot() ?? EMPTY_LIVE_STEPS)
  useEffect(() => {
    if (!source) { setState(EMPTY_LIVE_STEPS); return }
    setState(source.getSnapshot())
    return source.subscribe(() => setState(source.getSnapshot()))
  }, [source])
  return state
}

// ---------------------------------------------------------- merge into turns

/** A client-only assistant record: the log has no row for this step yet. */
export interface StreamingAssistantRecord extends AssistantRecord {
  /** Marks the record as streamed, never read from the log. */
  live: true
  /** The step is still producing text (the view shows a caret and a marker). */
  streaming: boolean
}

export function isStreamingAssistant(record: TrajectoryRecord): record is StreamingAssistantRecord {
  return record.kind === 'assistant' && (record as Partial<StreamingAssistantRecord>).live === true
}

/** A synthetic negative seq, unique per step and never a log seq. */
const liveSeq = (turn: number, step: number): number => -(1_000_000 * turn + step + 1)

function liveRecord(step: LiveStep): StreamingAssistantRecord {
  return {
    kind: 'assistant',
    live: true,
    streaming: step.running,
    seq: liveSeq(step.turn, step.step),
    turn: step.turn,
    step: step.step,
    text: step.text,
    toolCalls: 0,
    ...(step.startedAt !== undefined ? { startedAt: step.startedAt } : {}),
    ...(step.at !== undefined ? { at: step.at } : {}),
    ...(step.truncated ? { truncated: true } : {}),
    ...(step.interrupted ? { interrupted: true } : {}),
  }
}

/** Where a step's assistant row belongs: after the step's setup, before its tool calls. */
function insertIndex(records: readonly TrajectoryRecord[], step: number): number {
  const at = records.findIndex((record) => {
    if (typeof record.step !== 'number') return false
    return record.step > step || (record.step === step && record.kind === 'tool')
  })
  return at < 0 ? records.length : at
}

/**
 * The answer's turns plus the live step (or steps) the log has not caught up
 * with yet. A step the log already has is left alone: the log's record replaces
 * the streamed text, with no duplicate row. Pure, so the merge is unit tested.
 */
export function mergeLiveSteps(turns: readonly TrajectoryTurn[], steps: LiveSteps | null | undefined): TrajectoryTurn[] {
  const live = [steps?.previous, steps?.current].filter((step): step is LiveStep => step !== null && step !== undefined)
    .filter((step) => step.running || step.text.length > 0)
    .sort((left, right) => left.turn - right.turn || left.step - right.step)
  if (!live.length) return turns as TrajectoryTurn[]
  const out = turns.slice() as TrajectoryTurn[]
  let changed = false
  for (const step of live) {
    let index = out.findIndex((turn) => turn.turn === step.turn)
    if (index < 0) {
      const turn: TrajectoryTurn = { turn: step.turn, records: [], orphanCalls: [], hostOps: [], checkpoints: [] }
      let at = out.findIndex((candidate) => candidate.turn > step.turn)
      if (at < 0) at = out.length
      out.splice(at, 0, turn)
      index = at
      changed = true
    }
    const turn = out[index]!
    if (turn.records.some((record) => record.kind === 'assistant' && record.step === step.step)) continue
    const records = turn.records.slice()
    records.splice(insertIndex(records, step.step), 0, liveRecord(step))
    out[index] = { ...turn, records }
    changed = true
  }
  return changed ? out : turns as TrajectoryTurn[]
}
