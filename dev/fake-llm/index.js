// DEV-ONLY scripted LLM provider for deterministic, offline, key-less DSH turns.
// Registers provider route `fake` with model `scripted`; see README.md.
import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'

export const name = 'dsh-layerfs-fake-llm'
export const inject = ['llm']

export const Config = z.object({
  provider: z.string().default('fake').description('Provider route to register.'),
  model: z.string().default('scripted').description('Advertised model id (any id is served).'),
  autoApprove: z.boolean().default(false).description('Answer every approval/request with allowed-once (dev only).'),
  chunkDelayMs: z.natural().default(0).description('Delay between streamed chunks.'),
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const textOf = (message) => (Array.isArray(message?.content) ? message.content : [])
  .filter((b) => b?.type === 'text').map((b) => b.text).join('')

/** Index of the latest human-authored user message (falls back to any user message). */
function lastHumanIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'user' && (m.source === undefined || m.source.kind === 'user')) return i
  }
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') return i
  return -1
}

/** One escape level: `\n` becomes a newline and `\\n` becomes `\n` (for a nested `subagent:` prompt). */
const unescape = (text) => text.replace(/\\(\\?)n/g, (_, extra) => extra ? '\\n' : '\n')

/** Parse `bash: <cmd>`, `write: <path> <text>` and `subagent: <label> | <prompt>` lines into tool calls. */
function scriptedCalls(text, tools) {
  const toolNames = new Set(tools.map((t) => t.name))
  // `bash!:` asks for the widest advertised sandbox escalation (exercises approval prompts).
  const escalation = tools.find((t) => t.name === 'bash')?.parameters?.properties?.sandbox_permissions?.enum?.at(-1)
  const calls = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    let m
    if ((m = /^bash(!?):\s*(.+)$/.exec(line)) && toolNames.has('bash')) {
      const args = { description: `Run ${m[2].slice(0, 40)}`, command: m[2] }
      if (m[1] && escalation) Object.assign(args, { sandbox_permissions: escalation, justification: 'Scripted dev test needs wider access.' })
      calls.push({ name: 'bash', args })
    } else if ((m = /^write:\s*(\S+)\s?(.*)$/.exec(line)) && toolNames.has('write')) {
      calls.push({ name: 'write', args: { file_path: m[1], content: m[2].replace(/\\n/g, '\n') } })
    } else if ((m = /^subagent:\s*([^|]+?)\s*\|\s*(.+)$/.exec(line)) && toolNames.has('subagent')) {
      calls.push({ name: 'subagent', args: { description: m[1], prompt: unescape(m[2]) } })
    }
  }
  return calls
}

class FakeScriptedAdapter extends LlmAdapter {
  constructor(config) {
    super()
    this.config = config
  }

  providerInfo(provider) { return { id: provider, name: 'Fake (dev)' } }

  listModels(provider) {
    return Promise.resolve([{ provider, id: this.config.model, name: 'Fake scripted', description: 'Deterministic dev-only scripted model', inputModalities: ['text'] }])
  }

  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model === this.config.model ? 'Fake scripted' : model, context: { contextWindow: 128000 }, inputModalities: ['text'] })
  }

  async * text(index, reply) {
    yield { type: 'block-start', index, blockType: 'text' }
    for (const piece of reply.match(/[\s\S]{1,16}/g) ?? ['']) {
      if (this.config.chunkDelayMs) await sleep(this.config.chunkDelayMs)
      yield { type: 'text-delta', index, text: piece }
    }
    yield { type: 'block-end', index, block: { type: 'text', text: reply } }
  }

  async * stream(options) {
    const messages = options.messages ?? []
    const usage = { inputTokens: Math.max(1, Math.round(JSON.stringify(messages).length / 4)), outputTokens: 8 }
    const finish = async function * (kind) {
      yield { type: 'usage', usage }
      yield { type: 'finish', reason: { kind } }
    }
    const at = lastHumanIndex(messages)
    const prompt = at >= 0 ? textOf(messages[at]) : (options.system ?? '')
    if (options.signal?.aborted) {
      yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'aborted' } } }
      return
    }
    // Auxiliary calls (session titles, compaction, …) get a fixed short answer.
    if (options.purpose !== undefined) {
      yield * this.text(0, 'Fake session')
      yield * finish('stop')
      return
    }
    const results = messages.slice(at + 1).filter((m) => m.role === 'tool')
    if (results.length > 0) {
      const failed = results.filter((m) => m.isError).length
      yield * this.text(0, `done: ${results.length} commands${failed ? ` (${failed} failed)` : ''}`)
      yield * finish('stop')
      return
    }
    const calls = scriptedCalls(prompt, options.tools ?? [])
    if (process.env.DSH_FAKE_LLM_TRACE) console.error('[fake-llm]', JSON.stringify({ tools: (options.tools ?? []).map((t) => t.name), calls: calls.map((c) => c.name), prompt: prompt.slice(0, 120) }))
    if (calls.length === 0) {
      yield * this.text(0, `echo: ${prompt}`)
      yield * finish('stop')
      return
    }
    let index = 0
    for (const call of calls) {
      const id = ToolCallId(`fake-${randomUUID()}`)
      const args = JSON.stringify(call.args)
      yield { type: 'block-start', index, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: args }
      yield { type: 'block-end', index, block: { type: 'tool-call', id, name: call.name, arguments: args } }
      index++
    }
    yield * finish('tool-calls')
  }
}

export function apply(ctx, config) {
  ctx.llm.registerAdapter([config.provider], new FakeScriptedAdapter(config))
  if (config.autoApprove) {
    ctx.on('approval/request', () => 'allowed-once', { prepend: true })
  }
}
