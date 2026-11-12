import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'

export interface ScriptToolCall { id: string; name: string; arguments: Record<string, unknown> }
/** One assistant message: optional text (block 0), then zero or more tool calls. */
export interface ScriptMessage { text?: string; calls?: ScriptToolCall[] }
export type ScriptReply = ScriptMessage | ScriptToolCall
/** Streams text into the current reply while the script is still deciding, for
 * example before a long dependency wait. Resolves once the text has been sent. */
export interface ScriptStream { say(text: string): Promise<void> }
export interface SimulationModelSource {
  scripts(): any[]
  next(options: GenerateOptions, stream?: ScriptStream): Promise<ScriptReply>
  compactionContext?(options: GenerateOptions): string
  /** After an aborted script step: resolves once a stopping session may go idle. */
  holdStopping?(sessionId: string): Promise<void>
}

/** Delivery pacing only: it never changes what a reply contains. */
export interface SimulationPacing {
  /** Delay between text deltas (ms range). */
  word: [number, number]
  /** Delay before each tool call is emitted (ms range). */
  decision: [number, number]
  /** Delay between tool-call argument deltas (ms range). */
  argument: [number, number]
}
export const DEFAULT_PACING: SimulationPacing = { word: [20, 40], decision: [300, 800], argument: [30, 70] }

/** `DSH_LAYERFS_SIMULATION_PACING=0` (or off/false) disables pacing; it is on by default. */
export function pacingFromEnvironment(value = process.env.DSH_LAYERFS_SIMULATION_PACING): SimulationPacing | null {
  return value !== undefined && /^(0|off|false|no)$/i.test(value.trim()) ? null : DEFAULT_PACING
}

const between = ([low, high]: [number, number]) => low + Math.random() * Math.max(0, high - low)
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return }
    const abort = () => { clearTimeout(timer); reject(signal!.reason) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, ms)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

/** Word-sized deltas of two to four words; whitespace is preserved exactly. */
export function textDeltas(text: string, random: () => number = Math.random): string[] {
  const tokens = text.match(/\s*\S+\s*/g) ?? (text ? [text] : [])
  const deltas: string[] = []
  for (let index = 0; index < tokens.length;) {
    const size = 2 + Math.floor(random() * 3)
    deltas.push(tokens.slice(index, index + size).join(''))
    index += size
  }
  // A leading whitespace-only text (no words) still reaches the block.
  if (!deltas.length && text) deltas.push(text)
  return deltas
}

/** Two or three argument deltas: through the description value first (when it
 * leads), then the rest in one or two pieces. Concatenation is exact. */
export function argumentDeltas(json: string): string[] {
  const lead = json.match(/^\{"description":"(?:[^"\\]|\\.)*",?/)
  const head = lead ? lead[0] : json.slice(0, Math.ceil(json.length / 3))
  const rest = json.slice(head.length)
  if (!rest) return [head]
  if (rest.length < 24) return [head, rest]
  const middle = Math.ceil(rest.length / 2)
  return [head, rest.slice(0, middle), rest.slice(middle)]
}

const normalize = (reply: ScriptReply): ScriptMessage => 'id' in reply && 'name' in reply
  ? { calls: [reply as ScriptToolCall] }
  : reply as ScriptMessage

/** A model adapter only: tools and transcript persistence remain DSH-owned. */
export class SimulationAdapter extends LlmAdapter {
  readonly pacing: SimulationPacing | null
  constructor(readonly source: SimulationModelSource, options: { pacing?: SimulationPacing | boolean | null } = {}) {
    super()
    this.pacing = options.pacing === undefined ? pacingFromEnvironment() : options.pacing === true ? DEFAULT_PACING : options.pacing || null
  }
  providerInfo(provider: string) { return { id: provider, name: 'LayerFS scripts' } }
  async listModels(provider: string) {
    return this.source.scripts().map(script => ({ provider, id: script.scriptId, name: script.name, description: 'Project action script', inputModalities: ['text' as const] }))
  }
  async resolveModel(provider: string, model: string) {
    const script = this.source.scripts().find(script => script.scriptId === model)
    if (!script) throw new Error('This script is unavailable. Select an ordinary model to continue this session.')
    return { provider, id: model, name: script.name, description: 'Project action script', context: { contextWindow: 1_000_000 }, inputModalities: ['text' as const] }
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const signal = options.signal
    signal?.throwIfAborted()
    // Titles and other auxiliary requests cannot consume script actions.
    if (options.purpose !== undefined) {
      const text = options.purpose === 'compaction'
        ? simulationCompactionSummary(options, this.source.compactionContext?.(options))
        : this.source.scripts().find(script => script.scriptId === options.model)?.name ?? 'Project work'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    // Any abort point of a script step (waits, pacing pauses) may be a Stop: a
    // stopping root stays busy until its children settle (runtime holdForChildren).
    try {
      const pacing = this.pacing
      let text = ''
      let open = false
      const self = this
      async function* streamText(segment: string): AsyncGenerator<StreamChunk> {
        if (!segment) return
        if (!open) { open = true; yield { type: 'block-start', index: 0, blockType: 'text' } }
        const piece = text && !/\s$/.test(text) ? `\n\n${segment}` : segment
        const deltas = pacing ? textDeltas(piece) : [piece]
        for (const [index, delta] of deltas.entries()) {
          if (pacing && index) await pause(between(pacing.word), signal)
          yield { type: 'text-delta', index: 0, text: delta }
        }
        text += piece
      }
      // Text spoken while the script waits is streamed before its reply settles.
      const spoken: { text: string; done: () => void }[] = []
      let wake: (() => void) | undefined
      let outcome: { reply: ScriptMessage } | { error: unknown } | undefined
      let closed = false
      const say = (value: string) => closed ? Promise.resolve() : new Promise<void>(resolve => { spoken.push({ text: value, done: resolve }); wake?.() })
      void Promise.resolve().then(() => self.source.next(options, { say })).then(
        reply => { outcome = { reply: normalize(reply) }; wake?.() },
        error => { outcome = { error }; wake?.() },
      )
      try {
        for (;;) {
          while (spoken.length) {
            const item = spoken.shift()!
            yield* streamText(item.text)
            item.done()
          }
          if (outcome) break
          await new Promise<void>(resolve => { wake = resolve; if (spoken.length || outcome) resolve() })
          wake = undefined
        }
      } finally {
        // Never leave the script waiting on text that was not delivered.
        closed = true
        for (const item of spoken.splice(0)) item.done()
      }
      if ('error' in outcome) throw outcome.error
      signal?.throwIfAborted()
      const reply = outcome.reply
      if (reply.text) yield* streamText(reply.text)
      if (open) yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      const calls = reply.calls ?? []
      for (const [offset, call] of calls.entries()) {
        const index = (open ? 1 : 0) + offset
        if (pacing) await pause(between(pacing.decision), signal)
        const id = ToolCallId(call.id), args = JSON.stringify(call.arguments)
        yield { type: 'block-start', index, blockType: 'tool-call' }
        for (const [part, delta] of (pacing ? argumentDeltas(args) : [args]).entries()) {
          if (pacing && part) await pause(between(pacing.argument), signal)
          yield { type: 'tool-call-delta', index, id, ...(part ? {} : { name: call.name }), argumentsDelta: delta }
        }
        yield { type: 'block-end', index, block: { type: 'tool-call', id, name: call.name, arguments: args } }
      }
      if (!open && !calls.length) {
        // An empty reply still closes as a (blank) text answer.
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '' } }
      }
      yield { type: 'finish', reason: { kind: calls.length ? 'tool-calls' : 'stop' } }
    } finally {
      if (signal?.aborted && options.sessionId !== undefined) await this.source.holdStopping?.(String(options.sessionId))
    }
    // No invented model token accounting.
  }
}

/** A pure checkpoint made from actual message excerpts and confirmed context.
 * The native compaction owner records this summary; no private transcript exists. */
export function simulationCompactionSummary(options: GenerateOptions, context = ''): string {
  const limit = Math.max(512, Math.min(24000, Math.floor((options.maxTokens ?? 4000) * 3)))
  const excerpt = (value: string, size: number) => value.length <= size ? value : `${value.slice(0, size)} [excerpt truncated]`
  const text = (message: any) => (message.content ?? []).filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n')
  // The installed compactor appends its own anonymous final user instruction.
  const messages = options.messages.filter((message, index, all) => !(index === all.length - 1 && message.role === 'user' && !message.source))
  const sections = ['Recorded project checkpoint. Text below contains partial excerpts; full messages and tool output remain in the native session history.']
  if (context) sections.push(excerpt(context, 5000))
  const requests = messages.filter(message => message.role === 'user')
  const selected = [...requests.slice(0, 2), ...requests.slice(-3)].filter((message, index, all) => all.indexOf(message) === index)
  for (const message of selected) sections.push(`Recorded request/context:\n${excerpt(text(message), 1200)}`)
  for (const message of messages.filter((message: any) => message.role === 'tool' && message.isError).slice(-4)) sections.push(`Recorded tool error:\n${excerpt(text(message), 1200)}`)
  for (const message of messages.filter(message => message.role === 'assistant').slice(-3)) {
    const reply = text(message)
    if (reply) sections.push(`Recorded assistant response:\n${excerpt(reply, 1000)}`)
  }
  for (const message of messages.filter(message => message.role === 'tool').slice(-6)) {
    const result = message as any
    sections.push(`Recorded tool result ${result.toolCallId ?? result.source?.callId ?? ''}:\n${excerpt(text(message), 1000)}`)
  }
  const system = messages.filter(message => message.role === 'system' || message.role === 'developer')
  for (const message of system.slice(-2)) {
    const value = text(message)
    sections.push(`Recorded execution instructions (ending excerpt):\n${value.length > 2500 ? '[earlier instructions omitted] ' : ''}${value.slice(-2500)}`)
  }
  sections.push('Continue from confirmed results and the saved project file context. Omitted output is not evidence that application tests passed. The script driver derives completed actions from the unchanged native log, not from this summary.')
  const summary = sections.join('\n\n')
  return summary.length <= limit ? summary : `${summary.slice(0, Math.max(0, limit - 33))}\n[checkpoint excerpts truncated]`
}
