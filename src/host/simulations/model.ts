import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'

export type ScriptReply = { text: string } | { id: string; name: string; arguments: Record<string, unknown> }
export interface SimulationModelSource {
  scripts(): any[]
  next(options: GenerateOptions): Promise<ScriptReply>
  compactionContext?(options: GenerateOptions): string
}

/** A model adapter only: tools and transcript persistence remain DSH-owned. */
export class SimulationAdapter extends LlmAdapter {
  constructor(readonly source: SimulationModelSource) { super() }
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
    options.signal?.throwIfAborted()
    // Titles and other auxiliary requests cannot consume script actions.
    const reply = options.purpose === 'compaction'
      ? { text: simulationCompactionSummary(options, this.source.compactionContext?.(options)) }
      : options.purpose !== undefined
        ? { text: this.source.scripts().find(script => script.scriptId === options.model)?.name ?? 'Project work' }
        : await this.source.next(options)
    options.signal?.throwIfAborted()
    if ('text' in reply) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: reply.text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply.text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } else {
      const id = ToolCallId(reply.id), args = JSON.stringify(reply.arguments)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: reply.name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: reply.name, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
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
