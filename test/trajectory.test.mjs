// The LayerFS trajectory (docs/specs/layerfs-trajectory.md): the session log's
// records by turn, tool calls joined to receipts by tool call id and
// checkpoints to their save by receipt id; one record in full.
//   node --test test/trajectory.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildTrajectory, summarize, trajectoryDetail, usageOf, versionBranch } from '../src/host/sessions/trace.ts'
import { DETAIL_MAX, PREVIEW_MAX, TOOL_DESCRIPTION_MAX } from '../src/shared/trajectory.ts'

const C1 = '12' + '1'.repeat(64), C2 = '12' + '2'.repeat(64), C3 = '12' + '3'.repeat(64), L1 = '32' + '4'.repeat(64)
const ev = (seq, type, data, time = 1000 + seq) => ({ seq, type, data, time })
const txt = (text) => ({ type: 'text', text })
const user = (seq, text, kind = 'user') => ev(seq, 'user/message', { id: `m${seq}`, role: 'user', content: [txt(text)], source: { kind } })
const assistant = (seq, turn, step, content, extra = {}) => ev(seq, 'assistant/message', { turn, step, message: { id: `a${seq}`, role: 'assistant', content, source: { kind: 'model' } }, stream: [], ...extra })
const call = (seq, turn, step, callId, name, args) => ev(seq, 'tool/call', { turn, step, callId, name, arguments: JSON.stringify(args) })
const result = (seq, turn, step, callId, content, isError) => ev(seq, 'tool/result', { turn, step, message: { id: `r${seq}`, role: 'tool', toolCallId: callId, content, source: { kind: 'tool', callId }, ...(isError ? { isError: true } : {}) } })
const tc = (id) => ({ type: 'tool-call', id, name: 'bash', arguments: '{}' })

const events = [
  ev(1, 'turn/start', { turn: 1 }),
  ev(2, 'step/start', { turn: 1, step: 1 }),
  ev(3, 'system/message', { turn: 1, step: 1 }),
  user(4, '  list\n\n  the files  '),
  ev(5, 'user/message', { id: 'm5', role: 'user', content: [txt('Current working directory'), { type: 'image' }, txt('/tmp')], source: { kind: 'runtime-context', form: 'snapshot' } }),
  assistant(6, 1, 1, [{ type: 'reasoning', text: 'think' }, txt('Listing.'), tc('call_a'), tc('call_b')]),
  call(7, 1, 1, 'call_a', 'bash', { command: 'ls -la' }),
  call(8, 1, 1, 'call_b', 'bash', { command: '"$DSH_LAYERFS_CLI" workspace commit "$DSH_LAYERFS_WS" --message fix\n && merge' }),
  result(9, 1, 1, 'call_a', [txt('a.txt\nb.txt')]),
  result(10, 1, 1, 'call_b', [txt('ok')]),
  ev(11, 'step/end', { turn: 1, step: 1 }),
  ev(12, 'step/start', { turn: 1, step: 2 }),
  assistant(13, 1, 2, [txt('Done.')], { interrupted: true }),
  ev(14, 'step/end', { turn: 1, step: 2 }),
  ev(15, 'turn/end', { turn: 1, reason: 'completed' }),
  user(16, 'next please'),
  ev(17, 'turn/start', { turn: 2 }),
  assistant(18, 2, 1, [tc('call_c'), tc('call_d')]),
  call(19, 2, 1, 'call_c', 'write', { path: '/x.txt', content: 'secret text' }),
  result(20, 2, 1, 'call_c', [txt('denied')], true),
  call(21, 2, 1, 'call_d', 'bash', { command: 'sleep 100' }),
]
const receipts = [
  { id: 'r1', origin: 'tool', sessionId: 's', project: 'st/p', turn: 1, toolCallId: 'call_b', operation: 'workspace.exec', outcome: 'success', versions: [], argv: ['workspace', 'exec', 'sb:main', 'ls'], at: 2001, exit: 0 },
  { id: 'r2', origin: 'tool', sessionId: 's', project: 'st/p', turn: 1, toolCallId: 'call_b', operation: 'workspace.commit', outcome: 'success', kind: 'Committed', versions: [{ kind: 'Commit', id: C1, effect: 'created' }], argv: ['workspace', 'commit', 'sb:main'], at: 2002 },
  { id: 'r3', origin: 'tool', sessionId: 's', project: 'st/p', turn: 1, toolCallId: 'call_b', operation: 'branch.merge', outcome: 'success', kind: 'Merged', versions: [{ kind: 'Commit', id: C2, effect: 'created' }], argv: ['branch', 'merge', 'st/p', 'merged', 'dsh.s', 'main'], at: 2003 },
  { id: 'r4', origin: 'host', sessionId: 's', project: 'st/p', turn: 1, operation: 'workspace.commit', outcome: 'success', kind: 'UpToDate', versions: [{ kind: 'Commit', id: C1, effect: 'unchanged' }], at: 2004 },
  { id: 'r5', origin: 'tool', sessionId: 's', project: 'st/p', turn: 2, toolCallId: 'call_gone', operation: 'file.write', outcome: 'refusal', code: 'HeadMoved', versions: [], argv: ['file', 'write', 'st/p', 'dsh.s', '/y', '<3 bytes>'], at: 3001 },
  { id: 'r6', origin: 'host', sessionId: 's', project: 'st/p', turn: 2, operation: 'branch.fork', outcome: 'success', kind: 'Forked', versions: [{ kind: 'Layer', id: L1, effect: 'referenced' }], at: 3002 },
  { id: 'r7', origin: 'tool', project: 'st/p', turn: 2, toolCallId: 'call_gone', operation: 'file.write', outcome: 'success', versions: [{ kind: 'Commit', id: C2, effect: 'created', branch: 'dsh.s' }], argv: ['file', 'write', 'st/p', 'dsh.s', '/y', '<3 bytes>'], at: 3003 },
  { id: 'other', origin: 'tool', sessionId: 'someone-else', turn: 1, toolCallId: 'call_a', operation: 'file.write', outcome: 'success', versions: [{ kind: 'Commit', id: C3, effect: 'created' }] },
]
const checkpoints = [
  { kind: 'base', turn: 0, seq: 0, commit: L1, branch: 'dsh.s', changed: 0, message: 'Started from st/p', at: 500 },
  { kind: 'turn', turn: 1, seq: 15, commit: C1, branch: 'dsh.s', changed: 0, message: 'dsh turn 1', at: 2005, receipt: 'r4' },
]
const build = (over = {}) => buildTrajectory({ sessionId: 's', project: 'st/p', branch: 'dsh.s', events, invocations: receipts, checkpoints, ...over })

// The parity events: the rendered system prompt, the request header and the
// step's token usage. DSH puts usage on `assistant/message`; a `step/end`
// stamp is accepted too (the parity note calls it step usage).
const systemText = 'You are a careful agent.\nFollow the repository guide.'
const header = {
  config: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high', temperature: 0.3 },
  tools: [
    { name: 'bash', description: 'run a command', parameters: { type: 'object' } },
    { name: 'read', description: 'read a file', parameters: { type: 'object' } },
    { name: 'write', description: 'write a file', parameters: { type: 'object' } },
  ],
}
const parityEvents = [
  ev(100, 'turn/start', { turn: 3 }),
  ev(101, 'step/start', { turn: 3, step: 1 }),
  ev(102, 'system/message', { turn: 3, step: 1, message: { id: 'sys1', role: 'system', content: [txt(systemText)], source: { kind: 'system-prompt' } } }),
  user(103, 'do it'),
  ev(104, 'request/header', { header, reason: 'initial' }),
  assistant(105, 3, 1, [txt('Working.')], { usage: { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 800, cacheWriteTokens: 0 } }),
  ev(106, 'step/end', { turn: 3, step: 1, usage: { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 800, cacheWriteTokens: 0 } }),
  ev(107, 'step/start', { turn: 3, step: 2 }),
  ev(108, 'system/message', { turn: 3, step: 2, message: { id: 'sys2', role: 'system', content: [txt('A changed prompt')], source: { kind: 'system-prompt', name: 'repo-guide' } } }),
  ev(109, 'request/header', { header: { config: { provider: 'deepseek', model: 'deepseek-reasoner' } }, reason: 'change' }),
  assistant(110, 3, 2, [txt('Done.')]),
  ev(111, 'step/end', { turn: 3, step: 2, usage: { inputTokens: 2000, outputTokens: 500 } }),
  ev(112, 'turn/end', { turn: 3, reason: 'completed' }),
]
const buildParity = (events = parityEvents) => buildTrajectory({ sessionId: 's', project: 'st/p', branch: 'dsh.s', events, invocations: [], checkpoints: [] })

test('records by turn in log order; a user message between turns opens the next one', () => {
  const t = build()
  assert.equal(t.logLoaded, true)
  assert.equal(t.sessionId, 's')
  assert.equal(t.project, 'st/p')
  assert.equal(t.branch, 'dsh.s')
  assert.deepEqual(t.turns.map((x) => x.turn), [0, 1, 2])
  const [t0, t1, t2] = t.turns
  assert.deepEqual(t0.records, [])
  assert.equal(t0.checkpoints[0].kind, 'base')
  assert.equal(t1.at, 1001)
  assert.equal(t1.endAt, 1015)
  assert.deepEqual(t1.records.map((r) => [r.seq, r.kind]), [[4, 'user'], [5, 'context'], [6, 'assistant'], [7, 'tool'], [8, 'tool'], [13, 'assistant']])
  assert.ok(t1.records.every((r) => r.turn === 1))
  // seq 16 came after turn 1 ended and before turn 2 started: it is turn 2's input.
  assert.deepEqual(t2.records.map((r) => [r.seq, r.kind, r.turn]), [[16, 'user', 2], [18, 'assistant', 2], [19, 'tool', 2], [21, 'tool', 2]])
  assert.equal(t2.endAt, undefined)
})

test('user and context records: source, one-line text', () => {
  const [, t1] = build().turns
  assert.deepEqual(t1.records[0], { kind: 'user', seq: 4, turn: 1, source: 'user', at: 1004, text: 'list the files' })
  assert.deepEqual(t1.records[1], { kind: 'context', seq: 5, turn: 1, source: 'runtime-context', at: 1005, text: 'Current working directory /tmp' })
})

test('assistant records: visible text, thinking, tool calls, step start, interrupted', () => {
  const [, t1, t2] = build().turns
  assert.deepEqual(t1.records[2], { kind: 'assistant', seq: 6, turn: 1, step: 1, at: 1006, text: 'Listing.', thinking: true, toolCalls: 2, startedAt: 1002 })
  assert.deepEqual(t1.records[5], { kind: 'assistant', seq: 13, turn: 1, step: 2, at: 1013, text: 'Done.', toolCalls: 0, startedAt: 1012, interrupted: true })
  const toolOnly = t2.records[1]
  assert.equal(toolOnly.text, '')
  assert.equal(toolOnly.toolCalls, 2)
  assert.equal(toolOnly.startedAt, undefined, 'no step/start logged')
  assert.equal(toolOnly.thinking, undefined)
})

test('tool records: summary, result, error, running, and their LayerFS calls', () => {
  const [, t1, t2] = build().turns
  const a = t1.records[3]
  assert.deepEqual(a, { kind: 'tool', seq: 7, turn: 1, step: 1, at: 1007, callId: 'call_a', name: 'bash', summary: 'ls -la', result: 'a.txt b.txt', resultSeq: 9, endedAt: 1009, ops: [] })
  const b = t1.records[4]
  assert.match(b.summary, /^"\$DSH_LAYERFS_CLI" workspace commit .* && merge$/, 'one line, whitespace collapsed')
  assert.deepEqual(b.ops.map((o) => [o.operation, o.versions.map((v) => [v.effect, v.id.slice(0, 4), v.branch])]), [
    ['workspace.exec', []],
    ['workspace.commit', [['created', '1211', 'dsh.s']]], // the session's branch at that time
    ['branch.merge', [['created', '1222', 'merged']]], // the merge's new branch
  ])
  assert.equal(b.ops[0].exit, 0)
  assert.equal(b.ops[0].origin, 'tool')
  const c = t2.records[2]
  assert.equal(c.summary, '/x.txt', 'a path over file content')
  assert.equal(c.isError, true)
  assert.equal(c.result, 'denied')
  const d = t2.records[3]
  assert.equal(d.callId, 'call_d')
  assert.equal(d.result, undefined, 'still running')
  assert.equal(d.resultSeq, undefined)
  assert.equal(d.endedAt, undefined)
  // Another session's receipt never joins.
  assert.ok(!build().turns.flatMap((x) => x.records).some((r) => r.kind === 'tool' && r.ops.some((o) => o.id === 'other')))
})

test('orphan calls, host ops and the checkpoint save', () => {
  const [, t1, t2] = build().turns
  // The turn's host save is the checkpoint's own call, not a loose host call.
  assert.equal(t1.hostOps.length, 0)
  assert.equal(t1.checkpoints[0].op.id, 'r4')
  assert.deepEqual(t1.checkpoints[0].op.versions, [{ kind: 'Commit', id: C1, effect: 'unchanged', branch: 'dsh.s' }])
  assert.deepEqual(t1.orphanCalls, [])
  // A receipt whose call is outside the log; a receipt without sessionId is the session's own.
  assert.deepEqual(t2.orphanCalls.map((o) => [o.callId, o.ops.map((x) => [x.id, x.outcome, x.code ?? null])]),
    [['call_gone', [['r5', 'refusal', 'HeadMoved'], ['r7', 'success', null]]]])
  assert.deepEqual(t2.hostOps.map((o) => [o.operation, o.origin, o.versions[0].branch]), [['branch.fork', 'host', 'main']])
})

test('counts: distinct versions created by tool calls, and the calls that created any', () => {
  // call_b created C1 and C2; the orphan call_gone created C2 again (distinct: 2); host saves never count.
  assert.deepEqual(build().counts, { versionsCreated: 2, callsWithVersions: 2 })
  assert.deepEqual(build({ invocations: [] }).counts, { versionsCreated: 0, callsWithVersions: 0 })
})

test('without a loaded log: no records, calls from receipts alone', () => {
  const t = build({ events: undefined, checkpoints: [] })
  assert.equal(t.logLoaded, false)
  assert.deepEqual(t.turns.map((x) => [x.turn, x.records.length, x.orphanCalls.map((c) => c.callId)]), [[1, 0, ['call_b']], [2, 0, ['call_gone']]])
  assert.equal(t.turns[0].hostOps[0].id, 'r4', 'no checkpoint: the host save is a loose host call')
  assert.deepEqual(t.counts, { versionsCreated: 2, callsWithVersions: 2 })
  // An empty log is loaded; receipts without a turn go to turn 0.
  const e = buildTrajectory({ sessionId: 's', project: null, branch: null, events: [], invocations: [{ id: 'x', toolCallId: 'c', operation: 'file.read', outcome: 'success', versions: [] }], checkpoints: [] })
  assert.equal(e.logLoaded, true)
  assert.deepEqual(e.turns.map((x) => [x.turn, x.orphanCalls[0].callId]), [[0, 'c']])
})

test('a user message with no turn after it goes to the next turn; one before any turn to turn 1', () => {
  const trailing = buildTrajectory({ sessionId: 's', project: null, branch: null, invocations: [], checkpoints: [],
    events: [ev(1, 'turn/start', { turn: 3 }), ev(2, 'turn/end', { turn: 3 }), user(3, 'queued')] })
  assert.deepEqual(trailing.turns.map((x) => [x.turn, x.records.map((r) => r.seq)]), [[3, []], [4, [3]]])
  const first = buildTrajectory({ sessionId: 's', project: null, branch: null, invocations: [], checkpoints: [], events: [user(1, 'hi')] })
  assert.deepEqual(first.turns.map((x) => [x.turn, x.records[0].turn]), [[1, 1]])
  // Context inside an open turn stays in it, even after its steps.
  const inside = buildTrajectory({ sessionId: 's', project: null, branch: null, invocations: [], checkpoints: [],
    events: [ev(1, 'turn/start', { turn: 1 }), assistant(2, 1, 1, [txt('x')]), user(3, 'file changed', 'notice'), ev(4, 'turn/end', { turn: 1 })] })
  assert.deepEqual(inside.turns[0].records.map((r) => [r.seq, r.kind, r.source ?? null]), [[2, 'assistant', null], [3, 'context', 'notice']])
})

test('previews are one line of at most PREVIEW_MAX characters', () => {
  const long = 'word '.repeat(200)
  const t = buildTrajectory({ sessionId: 's', project: null, branch: null, invocations: [], checkpoints: [], events: [
    ev(1, 'turn/start', { turn: 1 }), user(2, long), assistant(3, 1, 1, [txt(long)]),
    call(4, 1, 1, 'c', 'bash', { command: 'cat' }), result(5, 1, 1, 'c', [txt('x'.repeat(10_000))]),
    user(6, 'y'.repeat(PREVIEW_MAX)), user(7, `${' \n'.repeat(5000)}tail`),
  ] })
  const [u, a, tool, exact, spaced] = t.turns[0].records
  assert.equal(u.text.length, PREVIEW_MAX)
  assert.ok(u.text.endsWith('…'))
  assert.equal(u.truncated, true)
  assert.equal(a.truncated, true)
  assert.equal(a.text.length, PREVIEW_MAX)
  assert.equal(tool.result.length, PREVIEW_MAX)
  assert.equal(tool.resultTruncated, true)
  assert.equal(exact.text.length, PREVIEW_MAX)
  assert.equal(exact.truncated, undefined, 'exactly the limit is whole')
  assert.equal(spaced.text, 'tail')
  assert.equal(spaced.truncated, undefined)
})

test('detail: one record in full, by its seq', () => {
  assert.deepEqual(trajectoryDetail(events, 4), { seq: 4, kind: 'user', text: '  list\n\n  the files  ' })
  assert.deepEqual(trajectoryDetail(events, 5), { seq: 5, kind: 'context', text: 'Current working directory\n/tmp' })
  assert.deepEqual(trajectoryDetail(events, 6), { seq: 6, kind: 'assistant', text: 'Listing.', thinking: 'think' })
  assert.deepEqual(trajectoryDetail(events, 18), { seq: 18, kind: 'assistant', text: '' })
  assert.deepEqual(trajectoryDetail(events, 7), { seq: 7, kind: 'tool', args: '{"command":"ls -la"}', result: 'a.txt\nb.txt' })
  assert.deepEqual(trajectoryDetail(events, 19), { seq: 19, kind: 'tool', args: '{"path":"/x.txt","content":"secret text"}', result: 'denied' })
  assert.deepEqual(trajectoryDetail(events, 21), { seq: 21, kind: 'tool', args: '{"command":"sleep 100"}' }, 'running: no result yet')
})

test('detail: fields cut at DETAIL_MAX are listed; an unknown seq has none', () => {
  const big = 'z'.repeat(DETAIL_MAX + 10)
  const log = [
    ev(1, 'turn/start', { turn: 1 }), user(2, big),
    assistant(3, 1, 1, [{ type: 'reasoning', text: big }, txt('short')]),
    call(4, 1, 1, 'c', 'bash', { command: big }), result(5, 1, 1, 'c', [txt(big)]),
  ]
  const u = trajectoryDetail(log, 2)
  assert.equal(u.text.length, DETAIL_MAX)
  assert.deepEqual(u.truncated, ['text'])
  const a = trajectoryDetail(log, 3)
  assert.equal(a.text, 'short')
  assert.equal(a.thinking.length, DETAIL_MAX)
  assert.deepEqual(a.truncated, ['thinking'])
  const tool = trajectoryDetail(log, 4)
  assert.equal(tool.args.length, DETAIL_MAX)
  assert.equal(tool.result.length, DETAIL_MAX)
  assert.deepEqual(tool.truncated, ['args', 'result'])
  // Not a record: a turn marker, a tool result, a missing seq, no log.
  assert.equal(trajectoryDetail(log, 1), undefined)
  assert.equal(trajectoryDetail(log, 5), undefined)
  assert.equal(trajectoryDetail(log, 99), undefined)
  assert.equal(trajectoryDetail(undefined, 2), undefined)
})

test('a large session stays small and builds in one pass', () => {
  const log = []
  let seq = 0
  const invocations = []
  for (let turn = 1; turn <= 70; turn++) {
    log.push(ev(seq++, 'turn/start', { turn }), user(seq++, `do task ${turn} `.repeat(50)))
    for (let step = 1; step <= 21; step++) {
      const id = `c${turn}_${step}`
      log.push(ev(seq++, 'step/start', { turn, step }), assistant(seq++, turn, step, [{ type: 'reasoning', text: 'r'.repeat(2000) }, txt('t '.repeat(400)), tc(id)]))
      log.push(call(seq++, turn, step, id, 'bash', { command: `"$DSH_LAYERFS_CLI" workspace exec "$DSH_LAYERFS_WS" -- make target-${step}` }))
      log.push(result(seq++, turn, step, id, [txt('output line\n'.repeat(500))]), ev(seq++, 'step/end', { turn, step }))
      invocations.push({ id: `r${id}`, origin: 'tool', sessionId: 's', turn, toolCallId: id, operation: 'workspace.exec', outcome: 'success', versions: [], argv: ['workspace', 'exec', 'sb:main', 'make'], at: seq, ms: 12, exit: 0 })
    }
    log.push(ev(seq++, 'turn/end', { turn }))
  }
  const started = performance.now()
  const t = buildTrajectory({ sessionId: 's', project: 'st/p', branch: 'dsh.s', events: log, invocations, checkpoints: [] })
  const ms = performance.now() - started
  const bytes = JSON.stringify(t).length
  assert.ok(log.length > 7_000, `${log.length} events`)
  assert.equal(invocations.length, 1470)
  assert.equal(t.turns.length, 70)
  console.log(`# ${log.length} events, ${invocations.length} receipts: ${bytes} bytes in ${ms.toFixed(0)} ms`)
  assert.ok(ms < 1000, `built in ${ms.toFixed(0)} ms`)
  // Worst case (every preview full, a receipt per call): about 1.2 KB per step.
  assert.ok(bytes < 2_000_000, `${bytes} bytes`)
})

test('a version opens on the branch its call names, else the session branch at that time', () => {
  const cps = [{ branch: 'dsh.s', at: 100 }, { branch: 'dsh.s.r1', at: 300, receipt: 'save' }]
  assert.equal(versionBranch({ kind: 'Commit', branch: 'stamped' }, {}, cps, 'cur'), 'stamped')
  assert.equal(versionBranch({ kind: 'Layer' }, { operation: 'workspace.commit' }, cps, 'cur'), 'main')
  assert.equal(versionBranch({ kind: 'Commit' }, { operation: 'file.edit', argv: ['file', 'edit', 'st/p', 'feature', '/a'] }, cps, 'cur'), 'feature')
  assert.equal(versionBranch({ kind: 'Commit' }, { operation: 'file.edit', argv: ['file', 'edit', 'st/p', '<local path>'] }, cps, 'cur'), undefined, 'a placeholder is no branch')
  assert.equal(versionBranch({ kind: 'Commit' }, { operation: 'branch.fork', argv: ['branch', 'fork', 'st/p', 'new', 'src', C1] }, cps, 'cur'), 'src', 'a fork points at a Commit on its source')
  assert.equal(versionBranch({ kind: 'Commit' }, { id: 'save', operation: 'workspace.commit', at: 999 }, cps, 'cur'), 'dsh.s.r1', 'its own checkpoint')
  assert.equal(versionBranch({ kind: 'Commit' }, { id: 'x', operation: 'workspace.commit', at: 200 }, cps, 'cur'), 'dsh.s', 'before the restore')
  assert.equal(versionBranch({ kind: 'Commit' }, { id: 'x', operation: 'workspace.commit', at: 50 }, cps, 'cur'), 'cur', 'before any checkpoint')
})

test('summaries are one bounded line', () => {
  assert.equal(summarize('{"command":"a\\n  b"}'), 'a b')
  assert.equal(summarize('{"n":1,"note":"first text"}'), 'first text')
  assert.equal(summarize('not json'), 'not json')
  assert.equal(summarize(''), undefined)
  assert.equal(summarize(JSON.stringify({ command: 'x'.repeat(500) })).length, 200)
})


test('system and request records sit before the assistant step they precede; usage rides the step', () => {
  const turns = buildParity().turns
  assert.deepEqual(turns.map((t) => t.turn), [3])
  const [turn] = turns
  assert.deepEqual(turn.records.map((r) => [r.seq, r.kind, r.step ?? null]), [
    [102, 'system', 1], [103, 'user', null], [104, 'request', 1], [105, 'assistant', 1],
    [108, 'system', 2], [109, 'request', 2], [110, 'assistant', 2],
  ])
  const system = turn.records[0]
  assert.equal(system.text, 'You are a careful agent. Follow the repository guide.', 'one-line preview')
  assert.equal(system.source, 'system-prompt')
  assert.equal(system.truncated, undefined)
  assert.equal(turn.records[4].source, 'repo-guide', 'a source name when logged')
  const request = turn.records[2]
  assert.equal(request.provider, 'deepseek')
  assert.equal(request.model, 'deepseek-chat')
  assert.equal(request.tools, 3)
  assert.equal(request.reason, 'initial')
  assert.equal(request.summary, 'deepseek/deepseek-chat · 3 tools')
  assert.equal(turn.records[5].summary, 'deepseek/deepseek-reasoner · 0 tools')
  assert.deepEqual(turn.records[3].usage, { input: 1200, output: 340, cacheRead: 800, cacheWrite: 0 })
  assert.deepEqual(turn.records[6].usage, { input: 2000, output: 500 }, 'step/end usage when the message reports none')
  assert.equal('header' in request, false, 'the header stays out of the light answer')
  assert.ok(!JSON.stringify(buildParity()).includes('run a command'), 'no tool schemas in the answer')
  assert.deepEqual(buildParity().counts, { versionsCreated: 0, callsWithVersions: 0 }, 'parity records do not move the counts')
})

test('usage maps DSH TokenUsage fields and keeps absent ones absent', () => {
  assert.deepEqual(usageOf({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }), { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 })
  assert.deepEqual(usageOf({ inputTokens: 1, outputTokens: 2, reasoningTokens: 9, totalTokens: 10 }), { input: 1, output: 2 })
  assert.deepEqual(usageOf({ outputTokens: 0 }), { output: 0 })
  assert.equal(usageOf(undefined), undefined)
  assert.equal(usageOf({}), undefined)
})

test('detail: the full system text and the request header as pretty JSON', () => {
  assert.deepEqual(trajectoryDetail(parityEvents, 102), { seq: 102, kind: 'system', text: systemText })
  const request = trajectoryDetail(parityEvents, 104)
  assert.equal(request.kind, 'request')
  assert.equal(request.header, JSON.stringify(header, null, 2))
  assert.equal(request.truncated, undefined)
  // Unknown/unrelated seqs stay safe.
  assert.equal(trajectoryDetail(parityEvents, 101), undefined)
  assert.equal(trajectoryDetail(parityEvents, 999), undefined)
})

test('system previews and details obey the preview and detail caps', () => {
  const long = 'word '.repeat(200)
  const log = [
    ev(1, 'turn/start', { turn: 1 }),
    ev(2, 'system/message', { turn: 1, step: 1, message: { content: [txt(long)], source: { kind: 'system-prompt' } } }),
  ]
  const record = buildTrajectory({ sessionId: 's', project: null, branch: null, events: log, invocations: [], checkpoints: [] }).turns[0].records[0]
  assert.equal(record.text.length, PREVIEW_MAX)
  assert.equal(record.truncated, true)
  const detail = trajectoryDetail(log, 2)
  assert.ok(detail.text.length > PREVIEW_MAX)
  assert.equal(detail.truncated, undefined, 'the full prompt fits under DETAIL_MAX')

  const big = 'x'.repeat(DETAIL_MAX + 10)
  const cutLog = [ev(1, 'system/message', { turn: 1, step: 1, message: { content: [txt(big)], source: { kind: 'system-prompt' } } })]
  const cut = trajectoryDetail(cutLog, 1)
  assert.equal(cut.text.length, DETAIL_MAX)
  assert.deepEqual(cut.truncated, ['text'])
})

test('a huge request header detail is cut at DETAIL_MAX and flagged', () => {
  const bigHeader = { config: { provider: 'deepseek', model: 'deepseek-chat' }, tools: [{ name: 't', description: 'd'.repeat(DETAIL_MAX + 100), parameters: {} }] }
  const log = [ev(1, 'request/header', { header: bigHeader, reason: 'initial' })]
  const detail = trajectoryDetail(log, 1)
  assert.equal(detail.kind, 'request')
  assert.equal(detail.header.length, DETAIL_MAX)
  assert.deepEqual(detail.truncated, ['header'])
})

// A request's parsed tool catalog and what changed between two consecutive
// requests: names, description previews, parameter counts and schemas.
const catalogA = {
  config: { provider: 'deepseek', model: 'deepseek-chat' },
  tools: [
    { name: 'bash', description: 'run a command', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
    { name: 'read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'number' } } } },
    { name: 'write', description: 'write a file', parameters: { type: 'object', additionalProperties: false } },
  ],
}
const catalogB = {
  config: { provider: 'deepseek', model: 'deepseek-chat' },
  tools: [
    { name: 'bash', description: 'run a shell command', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
    { name: 'glob', parameters: { type: 'object', properties: { pattern: { type: 'string' } } } },
    // Same description and schema as catalogA's write, its keys in another order: no change.
    { name: 'write', description: 'write a file', parameters: { additionalProperties: false, type: 'object' } },
  ],
}
const catalogEvents = [
  ev(200, 'turn/start', { turn: 4 }),
  ev(201, 'step/start', { turn: 4, step: 1 }),
  ev(202, 'request/header', { header: catalogA, reason: 'initial' }),
  assistant(203, 4, 1, [txt('One.')]),
  ev(204, 'step/start', { turn: 4, step: 2 }),
  ev(205, 'request/header', { header: catalogB, reason: 'change' }),
  assistant(206, 4, 2, [txt('Two.')]),
  ev(207, 'turn/end', { turn: 4 }),
]
const buildCatalog = (events = catalogEvents) => buildTrajectory({ sessionId: 's', project: 'st/p', branch: 'dsh.s', events, invocations: [], checkpoints: [] })

test('toolsChanged: added, removed and changed tools between consecutive requests', () => {
  const requests = buildCatalog().turns[0].records.filter((r) => r.kind === 'request')
  assert.deepEqual(requests.map((r) => [r.seq, r.tools]), [[202, 3], [205, 3]])
  assert.equal(requests[0].toolsChanged, undefined, 'the first request has nothing to compare against')
  assert.deepEqual(requests[1].toolsChanged, { added: ['glob'], removed: ['read'], changed: ['bash'] })
  // The preview stays light: names only, no descriptions or schemas.
  assert.ok(!JSON.stringify(buildCatalog()).includes('run a shell command'))
  assert.ok(!JSON.stringify(buildCatalog()).includes('command'))
})

test('detail: a request carries its parsed tool catalog, parameters as logged', () => {
  const detail = trajectoryDetail(catalogEvents, 205)
  assert.equal(detail.kind, 'request')
  assert.equal(detail.previousRequestSeq, 202)
  assert.deepEqual(detail.tools.map((tool) => tool.name), ['bash', 'glob', 'write'])
  const [bash, glob, write] = detail.tools
  assert.equal(bash.description, 'run a shell command')
  assert.equal(bash.parameterCount, 1)
  assert.deepEqual(bash.parameters, catalogB.tools[0].parameters, 'the JSON-schema object, not a string')
  assert.equal(glob.parameterCount, 1)
  assert.equal(glob.description, undefined, 'a missing description is fine')
  assert.equal(write.parameterCount, 0)
  assert.equal(detail.truncated, undefined)
  const first = trajectoryDetail(catalogEvents, 202)
  assert.equal(first.previousRequestSeq, undefined)
  assert.deepEqual(first.tools.map((tool) => tool.name), ['bash', 'read', 'write'])
  assert.equal(first.tools[1].parameterCount, 2)
})

test('detail: tool descriptions are previews, and a catalog too big is cut and flagged', () => {
  const long = 'word '.repeat(200)
  const one = trajectoryDetail([ev(1, 'request/header', { header: { tools: [{ name: 't', description: long, parameters: { type: 'object' } }] } })], 1)
  assert.equal(one.tools[0].description.length, TOOL_DESCRIPTION_MAX)
  assert.ok(one.tools[0].description.endsWith('…'))
  assert.equal(one.tools[0].descriptionTruncated, true)
  assert.equal(one.truncated, undefined)

  // Many tools: the catalog keeps what fits in DETAIL_MAX and says it was cut.
  const many = Array.from({ length: 400 }, (_, i) => ({
    name: `t${i}`, description: 'd'.repeat(300), parameters: { type: 'object', properties: { a: { type: 'string' } } },
  }))
  const cut = trajectoryDetail([ev(1, 'request/header', { header: { tools: many } })], 1)
  assert.ok(cut.tools.length > 0 && cut.tools.length < many.length, `${cut.tools.length} of ${many.length}`)
  assert.ok(cut.truncated.includes('tools'))
  assert.ok(JSON.stringify(cut.tools).length <= DETAIL_MAX, 'the catalog stays inside the cap')

  // One schema too big for the whole budget: dropped, the rest of its entry kept.
  const huge = { type: 'object', properties: Object.fromEntries(Array.from({ length: 4000 }, (_, i) => [`p${i}`, { type: 'string', description: 'x'.repeat(20) }])) }
  const hugeDetail = trajectoryDetail([ev(1, 'request/header', { header: { tools: [{ name: 'huge', description: 'big', parameters: huge }, { name: 'small', parameters: {} }] } })], 1)
  assert.deepEqual(hugeDetail.tools.map((tool) => tool.name), ['huge', 'small'])
  assert.equal(hugeDetail.tools[0].parameters, undefined, 'the schema alone is over the cap')
  assert.equal(hugeDetail.tools[0].parameterCount, 4000)
  assert.ok(hugeDetail.tools[1].parameters !== undefined, 'a later, small tool still fits')
  assert.ok(hugeDetail.truncated.includes('tools'))
})

test('a request without a tool set in its header has no catalog view', () => {
  const detail = trajectoryDetail(parityEvents, 109)
  assert.equal(detail.kind, 'request')
  assert.equal('tools' in detail, false)
  assert.equal(detail.previousRequestSeq, 104)
  assert.deepEqual(buildParity().turns[0].records.filter((r) => r.kind === 'request')[1].toolsChanged,
    { added: [], removed: ['bash', 'read', 'write'], changed: [] })
})
