// The LayerFS trajectory's prompt diff (docs/specs/layerfs-trajectory.md): the
// recorded system/tool-catalog states, DSH's subtle system-update suppression,
// and the unified hunks with their caps.
//   node --test test/prompt-diff.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { foldSurface, deriveEventMessage } from '@deepseek-ai/dsh-session/surface'
import { buildTrajectory } from '../src/host/sessions/trace.ts'
import {
  PROMPT_DIFF_MAX_BYTES, PROMPT_DIFF_MAX_LINES, promptChanges, promptDiff,
} from '../src/host/sessions/prompt-diff.ts'

const ev = (seq, type, data, extra = {}) => ({ seq, type, data, time: 1000 + seq, ...extra })
const txt = (text) => ({ type: 'text', text })
const system = (seq, text, op = 'append', extra = {}) => ev(seq, 'system/message', {
  turn: 1, step: 1,
  message: { id: `sys-${seq}`, role: 'system', content: [txt(text)], source: { kind: 'system-prompt' } },
}, { surfaceOp: op, ...extra })
const header = (seq, tools, reason = 'change') => ev(seq, 'request/header', {
  reason, header: { config: { provider: 'deepseek', model: 'deepseek-chat' }, tools },
})

const V1 = 'You are a careful agent.\nFollow the repository guide.\nKeep commits small.'
const V2 = 'You are a careful agent.\nFollow the repository guide.\nKeep the diff exact.'
const V3 = 'You are a careful agent.\nFollow the repository guide.\nReport only facts.'
const V4 = 'You are a careful agent.\nFollow the repository guide.\nReport only confirmed facts.'
const TOOL_BASH = { name: 'bash', description: 'run a command', parameters: { type: 'object', properties: { command: { type: 'string' } } } }
const TOOL_READ = { name: 'read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }
const TOOL_GLOB = { name: 'glob', description: 'find files', parameters: { type: 'object', properties: { pattern: { type: 'string' } } } }
const A = [TOOL_BASH, TOOL_READ]
const B = [TOOL_BASH, TOOL_READ, TOOL_GLOB]
const C = [TOOL_BASH, TOOL_GLOB]

// 0 turn, 1 first system, 2 first header (no predecessor), 3 an in-history
// system append, 4 the following header (system.update suppresses system, the
// catalog changed), 5 another system append, 6 a catalog-only header,
// 7 a replacement of 5 (no synthetic row), 8 the header that reports it,
// 9 an unchanged header, 10 an identical system append.
const events = [
  ev(0, 'turn/start', { turn: 1 }),
  system(1, V1),
  header(2, A, 'initial'),
  system(3, V2),
  header(4, B, 'change'),
  system(5, V3),
  header(6, C, 'change'),
  system(7, V4, { op: 'replace', startSeq: 5, endSeq: 5 }, { sourceEventSeqs: [5] }),
  header(8, C, 'change'),
  header(9, C, 'series'),
  system(10, V4),
  ev(11, 'turn/end', { turn: 1, reason: 'completed' }),
]

const trace = () => buildTrajectory({ sessionId: 's', project: 'st/p', branch: 'dsh.s', events, invocations: [], checkpoints: [] })
const recordAt = (seq) => trace().turns[0].records.find((record) => record.seq === seq)

test('the first prompt has no predecessor; an unchanged or identical state has no diff', () => {
  assert.equal(promptDiff(events, 1), undefined, 'the first system message')
  assert.equal(promptDiff(events, 2), undefined, 'the initial header')
  assert.equal(promptDiff(events, 9), undefined, 'an unchanged header')
  assert.equal(promptDiff(events, 10), undefined, 'an identical system append')
  assert.equal(promptDiff(events, 7), undefined, 'a surface replacement is reported at its next header')
  assert.equal(promptDiff(events, 999), undefined)
  assert.equal(promptDiff(events, Number.NaN), undefined)
})

test('an in-history system append is classified at its own seq; the following header is tools only', () => {
  const chain = promptChanges(events)
  assert.equal(chain.changes.get(3).kind, 'system')
  assert.equal(chain.changes.get(3).systemUpdate, true)
  assert.deepEqual(chain.flags.get(3), { promptChanged: 'system', previousSeq: 2 })

  assert.equal(chain.changes.get(4).kind, 'tools', 'NOT system-and-tools: system.update suppresses the duplicate report')
  assert.deepEqual(chain.flags.get(4), { promptChanged: 'tools', previousSeq: 3 })

  const systemDiff = promptDiff(events, 3)
  assert.deepEqual(systemDiff.before, { seq: 2 })
  assert.deepEqual(systemDiff.after, { seq: 3 })
  assert.ok(systemDiff.system)
  assert.equal(systemDiff.tools, undefined, 'the tools did not change at the system seq')
  const toolsDiff = promptDiff(events, 4)
  assert.equal(toolsDiff.system, undefined, 'the system change was already presented at seq 3')
  assert.ok(toolsDiff.tools)
  assert.deepEqual(toolsDiff.before, { seq: 3 })
  assert.deepEqual(toolsDiff.after, { seq: 4 })
})

test('hunks are unified and keep the +/−/space prefixes and 3 context lines', () => {
  const diff = promptDiff(events, 3)
  const lines = diff.system.lines
  const meta = lines.find((line) => line.kind === 'meta' && line.text.startsWith('@@'))
  assert.ok(meta, 'a hunk header')
  assert.match(meta.text, /^@@ -\d+,\d+ \+\d+,\d+ @@$/)
  assert.ok(lines.some((line) => line.kind === 'removed' && line.text === '-Keep commits small.'))
  assert.ok(lines.some((line) => line.kind === 'added' && line.text === '+Keep the diff exact.'))
  assert.ok(lines.some((line) => line.kind === 'context' && line.text === ' You are a careful agent.'))
  assert.ok(lines.filter((line) => line.kind === 'context').length >= 2, 'context: 3 includes the surrounding lines')
  // The tools section is pretty JSON, the stock input, not the name-only preview.
  const tools = promptDiff(events, 4).tools.lines
  assert.ok(tools.some((line) => line.kind === 'context' && line.text === ' ]'))
  assert.ok(tools.some((line) => line.kind === 'added' && line.text.includes('"name": "glob"')))
})

test('a replacement system change is reported by the next header, not as a synthetic row', () => {
  const chain = promptChanges(events)
  assert.equal(chain.changes.get(7), undefined)
  assert.equal(chain.changes.get(8).kind, 'system')
  assert.deepEqual(chain.flags.get(8), { promptChanged: 'system', previousSeq: 6 })
  const diff = promptDiff(events, 8)
  assert.deepEqual(diff.before, { seq: 6 })
  assert.deepEqual(diff.after, { seq: 8 })
  assert.ok(diff.system)
  assert.equal(diff.tools, undefined)
})

test('the light trajectory carries the hint and predecessor only, never the diff text', () => {
  const answer = trace()
  const bySeq = new Map(answer.turns[0].records.map((record) => [record.seq, record]))
  assert.equal(bySeq.get(1).promptChanged, undefined)
  assert.equal(bySeq.get(2).promptChanged, undefined)
  assert.deepEqual([bySeq.get(3).promptChanged, bySeq.get(3).previousSeq], ['system', 2])
  assert.deepEqual([bySeq.get(4).promptChanged, bySeq.get(4).previousSeq], ['tools', 3])
  assert.deepEqual([bySeq.get(5).promptChanged, bySeq.get(5).previousSeq], ['system', 4])
  assert.deepEqual([bySeq.get(6).promptChanged, bySeq.get(6).previousSeq], ['tools', 5])
  assert.equal(bySeq.get(7).promptChanged, undefined, 'a replacement itself')
  assert.deepEqual([bySeq.get(8).promptChanged, bySeq.get(8).previousSeq], ['system', 6])
  assert.equal(bySeq.get(9).promptChanged, undefined, 'an unchanged header')
  const light = JSON.stringify(answer)
  assert.ok(!light.includes('"parameters"'), 'no tool schemas in the light answer')
  assert.ok(!light.includes('run a command'), 'no tool descriptions in the light answer')
  assert.ok(!light.includes('@@ -'), 'no diff lines in the light answer')
})

test('the incremental effective system matches DSH foldSurface', () => {
  const prefix = events.slice(0, 7) // through the catalog-only header; append-only
  const folded = foldSurface(prefix)
  const lastNode = folded.nodes.at(-1)
  const message = deriveEventMessage(prefix[lastNode])
  const text = message.content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('')
  assert.equal(text, V3)
  assert.equal(promptChanges(prefix).changes.get(6).after.system, text)
})

test('the diff is cut at 2000 lines and 64 KiB and marked truncated', () => {
  const many = (prefix) => Array.from({ length: 1200 }, (_, i) => `${prefix} line ${i}`).join('\n')
  const log = [
    ev(0, 'turn/start', { turn: 1 }),
    system(1, many('old')),
    header(2, [], 'initial'),
    system(3, many('new')),
  ]
  const diff = promptDiff(log, 3)
  assert.equal(diff.truncated, true)
  assert.equal(diff.system.truncated, true)
  assert.equal(diff.system.lines.length, PROMPT_DIFF_MAX_LINES)
  const bytes = diff.system.lines.reduce((sum, line) => sum + Buffer.byteLength(line.text, 'utf8') + 1, 0)
  assert.ok(bytes <= PROMPT_DIFF_MAX_BYTES, `${bytes} bytes`)
  assert.ok(diff.system.lines.every((line) => ['meta', 'context', 'added', 'removed'].includes(line.kind)))
})

test('a system-and-tools change keeps both sections; the hint names the system change', () => {
  // An in-history system message without the append update flag (a replacement)
  // plus a changed catalog: the stock classification is system-and-tools. The
  // plugin has one hint value, so the system change names it and the diff keeps
  // both sections.
  const log = [
    ev(0, 'turn/start', { turn: 1 }),
    system(1, V1),
    header(2, A, 'initial'),
    system(3, V4, { op: 'replace', startSeq: 1, endSeq: 1 }),
    header(4, B, 'change'),
  ]
  const diff = promptDiff(log, 4)
  assert.ok(diff.system)
  assert.ok(diff.tools)
  assert.deepEqual(promptChanges(log).flags.get(4), { promptChanged: 'system', previousSeq: 2 })
})
