import assert from 'node:assert/strict'
import test from 'node:test'
import {
  checkpointKey, drawLaneMarks, checkpointVersion, compactNumber, durationParts, filterTurns, flattenRows, focusTarget, laneItems, loadedRecords, mergeOlder, opCommand,
  opWrites, place, prettyArgs, rebaseOlder, recentTurns, recordMatches, selectionTurn, shownHostOp, thinLane, timeSpan, toolEntries,
} from '../src/client/views/trajectory-model.ts'

const T0 = 1_700_000_000_000
const version = (effect, id = `12${'a'.repeat(64)}`) => ({ kind: 'Commit', id, effect, branch: 'b1' })
const op = (id, argv, at, versions = [], outcome = 'success') => ({ id, origin: 'tool', operation: `${argv[0]}.${argv[1]}`, argv, outcome, at, versions })

const exec = op('o1', ['workspace', 'exec', 'ws', 'echo hi'], T0 + 2100)
const commit = op('o2', ['workspace', 'commit', 'ws', '--message', 'm'], T0 + 2500, [version('created')])
const status = op('o3', ['workspace', 'status', 'ws'], T0 + 2600)

const turn1 = {
  turn: 1, at: T0, endAt: T0 + 6000,
  records: [
    { kind: 'context', seq: 1, turn: 1, at: T0, source: 'reminder', text: 'remember things' },
    { kind: 'user', seq: 2, turn: 1, at: T0 + 10, source: 'user', text: 'please commit' },
    { kind: 'context', seq: 3, turn: 1, at: T0 + 20, source: 'runtime', text: 'cwd is /x' },
    { kind: 'assistant', seq: 4, turn: 1, step: 1, at: T0 + 2000, startedAt: T0 + 500, text: '', toolCalls: 2 },
    { kind: 'tool', seq: 5, turn: 1, step: 1, at: T0 + 2000, callId: 'call-a', name: 'bash', summary: 'layerfs workspace commit', result: 'ok', endedAt: T0 + 3000, ops: [exec, commit] },
    { kind: 'tool', seq: 6, turn: 1, step: 1, at: T0 + 2000, callId: 'call-b', name: 'bash', summary: 'echo plain', result: 'plain', endedAt: T0 + 2200, ops: [] },
    { kind: 'tool', seq: 7, turn: 1, step: 2, at: T0 + 4000, callId: 'call-c', name: 'read', summary: 'a.txt', result: 'x', endedAt: T0 + 4100, ops: [status] },
  ],
  orphanCalls: [],
  hostOps: [{ ...status, id: 'h1', origin: 'host', at: T0 + 5000 }, { ...commit, id: 'h2', origin: 'host', at: T0 + 5100, versions: [] }],
  checkpoints: [{ kind: 'turn', commit: `12${'b'.repeat(64)}`, branch: 'b1', changed: 2, message: 'turn 1', at: T0 + 6000 }],
}
const turn2 = {
  turn: 2, at: T0 + 10_000,
  records: [
    { kind: 'user', seq: 10, turn: 2, at: T0 + 10_000, source: 'user', text: 'again' },
    { kind: 'tool', seq: 11, turn: 2, at: T0 + 11_000, callId: 'call-d', name: 'bash', summary: 'sleep', ops: [] },
  ],
  orphanCalls: [{ callId: 'gone', ops: [op('o9', ['file', 'write', 'p'], T0 + 10_500, [version('created', `12${'c'.repeat(64)}`)])] }],
  hostOps: [],
  checkpoints: [],
}
const answer = { sessionId: 's', project: 'st/p', branch: 'b1', turns: [turn1, turn2], logLoaded: true, counts: { versionsCreated: 2, callsWithVersions: 1 } }

const parityTurn = {
  turn: 3, at: T0 + 30_000, endAt: T0 + 30_010,
  records: [
    { kind: 'system', seq: 20, turn: 3, step: 1, at: T0 + 30_000, text: 'You are a careful agent', source: 'system-prompt', truncated: true },
    { kind: 'user', seq: 21, turn: 3, at: T0 + 30_001, source: 'user', text: 'go' },
    { kind: 'request', seq: 22, turn: 3, step: 1, at: T0 + 30_002, provider: 'deepseek', model: 'deepseek-chat', tools: 3, reason: 'initial', summary: 'deepseek/deepseek-chat · 3 tools' },
    { kind: 'assistant', seq: 23, turn: 3, step: 1, at: T0 + 30_009, startedAt: T0 + 30_002, text: 'ok', toolCalls: 0, usage: { input: 1200, output: 340 } },
  ],
  orphanCalls: [], hostOps: [], checkpoints: [],
}
const parityAnswer = { ...answer, turns: [parityTurn] }

test('opWrites: writes and version-naming calls; reads without versions are not', () => {
  assert.equal(opWrites(exec), true)
  assert.equal(opWrites(commit), true)
  assert.equal(opWrites(status), false)
  assert.equal(opWrites({ ...status, versions: [version('referenced')] }), true)
  assert.equal(opWrites({ id: 'x', origin: 'host', operation: 'branch.list', outcome: 'success', versions: [] }), false, 'without argv: from the operation')
  assert.equal(shownHostOp({ ...status, outcome: 'refusal', code: 'NotFound' }), true, 'a refused read is listed')
})

test('opCommand: argv as a shell command, else the operation', () => {
  assert.equal(opCommand(exec), "layerfs workspace exec ws 'echo hi'")
  assert.equal(opCommand({ id: 'x', origin: 'host', operation: 'workspace.get_status', outcome: 'success', versions: [] }), 'layerfs workspace get-status')
})

test('checkpointVersion: created when it saved changes, unchanged when not, referenced for start/restore', () => {
  assert.equal(checkpointVersion(turn1.checkpoints[0]).effect, 'created')
  assert.equal(checkpointVersion({ ...turn1.checkpoints[0], changed: 0 }).effect, 'unchanged')
  assert.equal(checkpointVersion({ ...turn1.checkpoints[0], kind: 'restore' }).effect, 'referenced')
  assert.equal(checkpointVersion({ ...turn1.checkpoints[0], kind: 'base', commit: `32${'d'.repeat(64)}`, branch: null }).kind, 'Layer')
  assert.equal(checkpointVersion({ ...turn1.checkpoints[0], branch: null }).branch, undefined)
  assert.equal(checkpointVersion({ ...turn1.checkpoints[0], commit: null }), null)
})

test('recordMatches: text, name, summary, result and LayerFS commands, case-insensitively', () => {
  const [, user, , , tool] = turn1.records
  assert.equal(recordMatches(user, 'commit'), true)
  assert.equal(recordMatches(tool, 'bash'), true)
  assert.equal(recordMatches(tool, 'echo hi'), true, 'a LayerFS command it ran')
  assert.equal(recordMatches(tool, 'nothing'), false)
  assert.equal(recordMatches(user, ''), true)
})

test('filterTurns: only LayerFS writes keeps writing tool calls, orphans, listed host calls and checkpoints', () => {
  assert.deepEqual(filterTurns(answer.turns, { onlyWrites: false, query: '' }), answer.turns)
  const only = filterTurns(answer.turns, { onlyWrites: true, query: '' })
  assert.deepEqual(only.map((t) => t.turn), [1, 2])
  assert.deepEqual(only[0].records.map((r) => r.seq), [5], 'the read-only call and messages drop')
  assert.deepEqual(only[0].hostOps.map((o) => o.id), ['h2'])
  assert.equal(only[0].checkpoints.length, 1)
  assert.deepEqual(only[1].records, [])
  assert.equal(only[1].orphanCalls.length, 1)
})

test('filterTurns: a search drops turns without a match', () => {
  const found = filterTurns(answer.turns, { onlyWrites: false, query: '  PLAIN ' })
  assert.deepEqual(found.map((t) => t.turn), [1])
  assert.deepEqual(found[0].records.map((r) => r.seq), [6])
  assert.deepEqual(filterTurns(answer.turns, { onlyWrites: false, query: 'zzz' }), [])
})

test('timeSpan leaves out the observation row: a read counter days later does not stretch the axis', () => {
  const turn = { turn: 1, at: 1000, endAt: 3700, orphanCalls: [], hostOps: [], checkpoints: [], records: [
    { kind: 'user', seq: 1, turn: 1, at: 1000, text: 'hi' },
    { kind: 'assistant', seq: 2, turn: 1, at: 3700, startedAt: 1100, text: 'ok' },
    { kind: 'observation', seq: 3, turn: 1, at: 1000 + 13 * 86_400_000, text: 'polled 12 times', top: [], reads: 12 },
  ] }
  assert.deepEqual(timeSpan([turn], 1000 + 14 * 86_400_000), { start: 1000, end: 3700 })
})

test('timeSpan covers every time, running calls up to now, and widens an instant', () => {
  assert.deepEqual(timeSpan(answer.turns, T0 + 20_000), { start: T0, end: T0 + 20_000 }, 'call-d runs: up to now')
  assert.deepEqual(timeSpan([turn1], T0 + 99_000), { start: T0, end: T0 + 6000 })
  assert.deepEqual(timeSpan([{ ...turn2, at: undefined, records: [turn2.records[0]], orphanCalls: [] }], 0), { start: T0 + 10_000, end: T0 + 11_000 })
  assert.equal(timeSpan([], 0), null)
})

test('laneItems: input points, model steps from their start, tool bars, one LayerFS tick per call and checkpoint', () => {
  const items = laneItems(answer.turns, T0 + 20_000)
  const by = (lane) => items.filter((i) => i.lane === lane)
  assert.deepEqual(by('input').map((i) => [i.select, i.start, i.end]), [['r:2', T0 + 10, T0 + 10], ['r:10', T0 + 10_000, T0 + 10_000]], 'context records are not input')
  assert.deepEqual(by('model').map((i) => [i.start, i.end]), [[T0 + 500, T0 + 2000]])
  const tools = by('tools')
  assert.equal(tools.length, 4)
  assert.deepEqual([tools[0].start, tools[0].end, tools[0].tone], [T0 + 2000, T0 + 3000, undefined])
  assert.deepEqual([tools[3].end, tools[3].tone], [T0 + 20_000, 'running'])
  const ticks = by('layerfs')
  assert.deepEqual(ticks.map((i) => [i.key, i.select, i.tone ?? null]), [
    ['opo1', 'r:5', null], ['opo2', 'r:5', 'created'], ['opo3', 'r:7', null],
    ['oph1', 'h:1', null], ['oph2', 'h:1', null], ['cp1:0', 'c:1:0', 'created'],
    ['opo9', 'o:gone', 'created'],
  ])
})

test('place: percent of the span, clamped; a point has no width', () => {
  const span = { start: 0, end: 200 }
  assert.deepEqual(place({ start: 50, end: 100 }, span), { left: 25, width: 25 })
  assert.deepEqual(place({ start: 50, end: 50 }, span), { left: 25, width: 0 })
  assert.deepEqual(place({ start: -10, end: 300 }, span), { left: 0, width: 100 })
})

test('flattenRows: turn headers, folded context, LayerFS sub-rows, host and checkpoint rows', () => {
  const rows = flattenRows(answer.turns, { turnOpen: () => true, callOpen: () => true, contextOpen: () => false })
  assert.deepEqual(rows.map((r) => r.type === 'record' ? `${r.type}:${r.record.seq}` : r.type === 'op' ? `op:${r.op.id}` : r.type), [
    'turn', 'contextToggle', 'record:2', 'record:4', 'record:5', 'op:o1', 'op:o2', 'record:6', 'record:7', 'op:o3', 'host', 'checkpoint',
    'turn', 'record:10', 'record:11', 'orphan',
  ])
  assert.equal(rows[1].count, 2)
  const host = rows.find((r) => r.type === 'host')
  assert.deepEqual([host.shown.map((o) => o.id), host.reads], [['h2'], 1])
  assert.equal(rows.find((r) => r.type === 'record' && r.record.seq === 6).open, false, 'a call without LayerFS calls has nothing to open')
})

test('flattenRows: open context shows in place; collapsed turns and calls hide their rows; a search reveals context', () => {
  const open = flattenRows([turn1], { turnOpen: () => true, callOpen: () => false, contextOpen: () => true })
  assert.deepEqual(open.slice(0, 5).map((r) => r.type === 'record' ? r.record.seq : r.type), ['turn', 'contextToggle', 1, 2, 3])
  assert.ok(!open.some((r) => r.type === 'op'))
  assert.deepEqual(flattenRows(answer.turns, { turnOpen: (t) => t === 2, callOpen: () => true, contextOpen: () => false }).map((r) => r.key), ['t:1', 't:2', 'r:10', 'r:11', 'o:gone'])
  const searched = flattenRows([turn1], { turnOpen: () => true, callOpen: () => false, contextOpen: () => false }, true)
  assert.ok(!searched.some((r) => r.type === 'contextToggle'))
  assert.equal(searched[1].record.seq, 1)
})

test('recentTurns opens the newest three', () => {
  const turns = [0, 1, 2, 3, 4].map((turn) => ({ turn }))
  assert.deepEqual([...recentTurns(turns)], [2, 3, 4])
})

test('focusTarget takes a bare call id, or JSON {callId} / {seq}', () => {
  assert.equal(focusTarget(answer, 'call-a').record.seq, 5)
  assert.equal(focusTarget(answer, 'call-d').turn, 2)
  assert.equal(focusTarget(answer, JSON.stringify({ callId: 'call-b' })).record.seq, 6)
  assert.equal(focusTarget(answer, JSON.stringify({ seq: 4 })).record.kind, 'assistant')
  assert.equal(focusTarget(answer, 'nope'), null)
})

test('selectionTurn finds the turn of a record, orphan, checkpoint or host row', () => {
  assert.equal(selectionTurn(answer, 'r:11'), 2)
  assert.equal(selectionTurn(answer, 'o:gone'), 2)
  assert.equal(selectionTurn(answer, 'c:1:0'), 1)
  assert.equal(selectionTurn(answer, 'h:1'), 1)
  assert.equal(selectionTurn(answer, 'r:999'), null)
})

test('durationParts and prettyArgs', () => {
  assert.deepEqual(durationParts(450), { unit: 'ms', n: 450 })
  assert.deepEqual(durationParts(2345), { unit: 's', n: '2.3' })
  assert.deepEqual(durationParts(42_000), { unit: 's', n: '42' })
  assert.deepEqual(durationParts(185_000), { unit: 'm', m: 3, s: 5 })
  assert.equal(prettyArgs('{"command":"ls"}'), '{\n  "command": "ls"\n}')
  assert.equal(prettyArgs('not json'), 'not json')
  assert.equal(prettyArgs(undefined), '')
})

test('thinLane: a crowded lane keeps one mark per bin, preferring the selected item, then refused, running, created', () => {
  const span = { start: 0, end: 1000 }
  const items = Array.from({ length: 1000 }, (_, i) => ({ start: i, select: `r:${i}`, ...(i === 7 ? { tone: 'created' } : i === 8 ? { tone: 'refused' } : {}) }))
  const marks = thinLane(items, span, 'r:42', 100)
  assert.equal(marks.length, 100, 'one mark per bin')
  assert.equal(marks.reduce((n, m) => n + 1 + m.more, 0), 1000, 'every item is counted once')
  assert.equal(marks[0].select, 'r:8', 'refused beats created and plain items in its bin')
  assert.equal(marks[4].select, 'r:42', 'the selected item always shows')
  assert.ok(marks.every((m, i) => i === 0 || m.start > marks[i - 1].start), 'marks stay in time order')
  const few = thinLane(items.slice(0, 50), span, null, 100)
  assert.equal(few.length, 50, 'a lane within the cap is drawn as is')
  assert.ok(few.every((m) => m.more === 0))
})


test('thinLane: checkpoint ticks are never thinned away, however crowded the LayerFS lane is', () => {
  const span = { start: 0, end: 10_000 }
  // Thousands of LayerFS calls, a few refused, and a checkpoint per turn among them.
  const calls = Array.from({ length: 5000 }, (_, i) => ({ key: `op${i}`, start: i * 2, end: i * 2, select: `r:${i}`, ...(i % 7 === 0 ? { tone: 'refused' } : {}) }))
  const checkpoints = Array.from({ length: 40 }, (_, i) => ({ key: `cp${i + 1}:0`, start: i * 250 + 1, end: i * 250 + 1, select: `c:${i + 1}:0` }))
  // A checkpoint outside the loaded turns (no row to select) sits in a crowded bin too.
  checkpoints.push({ key: 'cp99:1', start: 4001, end: 4001, select: 'c:99:1', tone: 'created' })
  const items = [...calls, ...checkpoints]
  const marks = thinLane(items, span, null, 600)
  const kept = marks.filter((m) => m.key.startsWith('cp')).map((m) => m.key)
  assert.deepEqual(kept.sort(), checkpoints.map((c) => c.key).sort(), 'every checkpoint tick survives')
  assert.ok(marks.every((m) => !m.key.startsWith('cp') || m.more === 0), 'a checkpoint stands for itself only')
  assert.equal(marks.filter((m) => !m.key.startsWith('cp')).length, 600, 'the calls are still thinned to the bins')
  assert.equal(marks.reduce((n, m) => n + 1 + m.more, 0), items.length, 'every item is counted once')
  assert.ok(marks.every((m, i) => i === 0 || m.start >= marks[i - 1].start), 'marks stay in time order')
  // And the drawn strip keeps them too (drawLaneMarks never collapses a checkpoint).
  const drawn = drawLaneMarks(marks, span, 0.05, null)
  assert.deepEqual(drawn.filter((m) => m.key.startsWith('cp')).map((m) => m.key).sort(), checkpoints.map((c) => c.key).sort())
})

test('drawLaneMarks: marks landing on each other draw once; a checkpoint always survives', () => {
  const span = { start: 0, end: 1000 }
  const at = (start, key, select, tone) => ({ start, end: start, key, select, tone, more: 0 })
  // Two records at (almost) the same instant, as two assistant steps seconds apart in a long session are.
  const merged = drawLaneMarks([at(0, 'r1', 'r:1'), at(0.1, 'r2', 'r:2'), at(500, 'r3', 'r:3')], span, 5, null)
  assert.equal(merged.length, 2, 'the pair at 0/0.1 collapses')
  assert.equal(merged[0].select, 'r:1', 'the first of a point group keeps the mark')
  assert.equal(merged[0].more, 1, 'and counts the record it stands for')
  assert.equal(merged[1].select, 'r:3')
  // The selected item wins the group.
  const picked = drawLaneMarks([at(0, 'r1', 'r:1'), at(0.1, 'r2', 'r:2')], span, 5, 'r:2')
  assert.equal(picked.length, 1)
  assert.equal(picked[0].select, 'r:2')
  assert.equal(picked[0].more, 1)
  // A checkpoint is never hidden by a nearby op, and two checkpoints never merge.
  const cp = at(0, 'cp1:0', 'c:1:0')
  const withOp = drawLaneMarks([cp, at(0.2, 'op1', 'c:1:0')], span, 5, null)
  assert.equal(withOp.length, 1)
  assert.equal(withOp[0].key, 'cp1:0')
  assert.equal(withOp[0].more, 1)
  const twoCps = drawLaneMarks([cp, { ...at(0.1, 'cp1:1', 'c:1:1') }], span, 5, null)
  assert.equal(twoCps.length, 2, 'both checkpoints keep their mark')
  // A mark whose box overlaps a long bar collapses into it; a clear one does not.
  const bar = { start: 0, end: 50, key: 'r9', select: 'r:9', more: 0 }
  const inside = drawLaneMarks([bar, at(10, 'r10', 'r:10')], span, 0, null)
  assert.equal(inside.length, 1, 'a point inside a bar is not painted over it')
  const clear = drawLaneMarks([bar, at(60, 'r10', 'r:10')], span, 0, null)
  assert.equal(clear.length, 2, 'a mark past the bar keeps its own')
})

test('system and request records: search words, lane, rows and the only-writes filter', () => {
  const [system, user, request] = parityTurn.records
  assert.equal(recordMatches(system, 'careful'), true)
  assert.equal(recordMatches(system, 'system-prompt'), true)
  assert.equal(recordMatches(request, 'deepseek-chat'), true)
  assert.equal(recordMatches(request, '3 tools'), true)
  assert.equal(recordMatches(user, 'careful'), false)

  // Only LayerFS writes keeps tool calls only; messages never survive it.
  assert.deepEqual(filterTurns([parityTurn], { onlyWrites: true, query: '' }), [])
  const found = filterTurns([parityTurn], { onlyWrites: false, query: 'deepseek' })
  assert.deepEqual(found.map((t) => t.turn), [3])
  assert.deepEqual(found[0].records.map((r) => r.seq), [22])

  // Rows: system and request are ordinary records (not context folds).
  const rows = flattenRows([parityTurn], { turnOpen: () => true, callOpen: () => true, contextOpen: () => false })
  assert.deepEqual(rows.map((r) => r.type === 'record' ? [r.record.seq, r.record.kind] : r.type), [
    'turn', [20, 'system'], [21, 'user'], [22, 'request'], [23, 'assistant'],
  ])
  assert.ok(!rows.some((r) => r.type === 'contextToggle'), 'system/request are not context messages')
})

test('system and request stay in the Input lane; assistant usage changes no lane', () => {
  const items = laneItems([parityTurn], T0 + 40_000)
  const input = items.filter((i) => i.lane === 'input')
  assert.deepEqual(input.map((i) => [i.select, i.label]), [
    ['r:20', 'You are a careful agent'],
    ['r:21', 'go'],
    ['r:22', 'deepseek/deepseek-chat · 3 tools'],
  ])
  assert.deepEqual(items.filter((i) => i.lane === 'model').map((i) => i.select), ['r:23'])
  assert.ok(!items.some((i) => i.lane === 'system'), 'no new lane')
  assert.deepEqual(timeSpan([parityTurn], T0), { start: T0 + 30_000, end: T0 + 31_000 })
})

test('selection and focus reach system/request records by their seq', () => {
  assert.equal(focusTarget(parityAnswer, JSON.stringify({ seq: 20 })).record.kind, 'system')
  assert.equal(focusTarget(parityAnswer, JSON.stringify({ seq: 22 })).record.kind, 'request')
  assert.equal(selectionTurn(parityAnswer, 'r:20'), 3)
  assert.equal(selectionTurn(parityAnswer, 'r:22'), 3)
})

test('compactNumber: whole counts below 1000, one decimal below ten, k and m above', () => {
  assert.equal(compactNumber(0), '0')
  assert.equal(compactNumber(340), '340')
  assert.equal(compactNumber(999), '999')
  assert.equal(compactNumber(1000), '1k')
  assert.equal(compactNumber(1200), '1.2k')
  assert.equal(compactNumber(12_345), '12k')
  assert.equal(compactNumber(150_000), '150k')
  assert.equal(compactNumber(1_200_000), '1.2m')
  assert.equal(compactNumber(2_000_000), '2m')
  assert.equal(compactNumber(Number.NaN), '—')
})

test('toolEntries: header order with change marks, then removed tools with their previous values', () => {
  const tools = [
    { name: 'bash', description: 'run a shell command', parameterCount: 1 },
    { name: 'glob', description: 'find files', parameterCount: 1 },
    { name: 'write', description: 'write a file', parameterCount: 0 },
  ]
  const change = { added: ['glob'], removed: ['read'], changed: ['bash'] }
  const previous = [
    { name: 'bash', description: 'run a command', parameterCount: 1 },
    { name: 'read', description: 'read a file', parameterCount: 2 },
    { name: 'write', description: 'write a file', parameterCount: 0 },
  ]
  const entries = toolEntries(tools, change, previous)
  assert.deepEqual(entries.map((entry) => [entry.name, entry.mark ?? null]), [
    ['bash', '~'], ['glob', '+'], ['write', null], ['read', '−'],
  ])
  assert.equal(entries[0].previous.description, 'run a command', 'a changed tool carries its earlier value')
  assert.equal(entries[1].previous, undefined, 'an added tool has no earlier value')
  assert.equal(entries[3].previous.description, 'read a file', 'a removed tool comes from the previous catalog')

  // Without the previous catalog (not read yet): names and marks only.
  const bare = toolEntries(tools, change, undefined)
  assert.deepEqual(bare.map((entry) => [entry.name, entry.mark ?? null]), [['bash', '~'], ['glob', '+'], ['write', null], ['read', '−']])
  assert.ok(bare.every((entry) => entry.previous === undefined))

  // No change: no marks, no removed entries.
  assert.deepEqual(toolEntries(tools, { added: [], removed: [], changed: [] }, undefined).map((entry) => entry.mark ?? null), [null, null, null])
  assert.deepEqual(toolEntries(tools, undefined, undefined).map((entry) => entry.mark ?? null), [null, null, null])
  assert.deepEqual(toolEntries([], { added: [], removed: [], changed: [] }, undefined), [])
})


// ---------------------------------------------------- paging on screen

const paged = {
  ...answer, revision: 'r1', recordTotal: 4, hasMore: true, olderBefore: 4,
  turns: [{ ...turn2, records: [turn2.records[1]], totalRecords: 2 }],
}
const olderPage = {
  ...answer, revision: 'r2', recordTotal: 4,
  turns: [
    { ...turn1, records: [turn1.records[0]], checkpoints: [], hostOps: [], orphanCalls: [] },
    { ...turn2, records: [turn2.records[0]], checkpoints: [], hostOps: [], orphanCalls: [] },
  ],
}

test('loadedRecords counts what the answer carries', () => {
  assert.equal(loadedRecords(answer), turn1.records.length + turn2.records.length)
  assert.equal(loadedRecords(paged), 1)
})

test('mergeOlder appends records in log order, keeps the newer turn and takes the older cursor', () => {
  const merged = mergeOlder(paged, olderPage)
  assert.equal(merged.revision, 'r1', 'the revision the first page was built from stays')
  assert.equal(merged.recordTotal, 4)
  assert.equal(merged.hasMore, undefined, 'the older page exhausted the history')
  assert.equal(merged.olderBefore, undefined)
  assert.deepEqual(merged.turns.map((turn) => turn.turn), [1, 2], 'an older turn joins the list, ordered')
  const turn = merged.turns.find((t) => t.turn === 2)
  assert.deepEqual(turn.records.map((r) => r.seq), [10, 11], 'log order')
  assert.equal(turn.totalRecords, 2, 'the first page keeps its total')
  assert.equal(turn.checkpoints.length, paged.turns[0].checkpoints.length, 'the newer turn keeps its checkpoints')
  assert.equal(loadedRecords(merged), 3, 'the older page\'s records plus the first page\'s')
})

test('mergeOlder keeps the older cursor while records remain, and never repeats a record', () => {
  const more = { ...olderPage, hasMore: true, olderBefore: 9, turns: [{ ...turn2, records: [turn2.records[0], turn2.records[1]], checkpoints: [], hostOps: [], orphanCalls: [] }] }
  const merged = mergeOlder(paged, more)
  assert.equal(merged.hasMore, true)
  assert.equal(merged.olderBefore, 9)
  assert.equal(merged.turns.find((t) => t.turn === 2).records.length, 2, 'the already loaded record is not repeated')
  const again = mergeOlder(merged, more)
  assert.equal(again.turns.find((t) => t.turn === 2).records.length, 2)
})

test('mergeOlder keeps `elided` when either page left content out to fit its budget', () => {
  assert.equal(mergeOlder(paged, olderPage).elided, undefined, 'neither page was cut')
  assert.equal(mergeOlder({ ...paged, elided: true }, olderPage).elided, true, 'the newer page was cut')
  assert.equal(mergeOlder(paged, { ...olderPage, elided: true }).elided, true, 'the older page was cut')
})

test('rebaseOlder keeps the loaded older records under a new first page, by seq, and drops them across a gap', () => {
  const rec = (seq, turn) => ({ kind: 'user', seq, turn, at: T0 + seq, source: 'user', text: `r${seq}` })
  const t = (n, records) => ({ turn: n, at: T0 + n, records, orphanCalls: [], hostOps: [], checkpoints: [] })
  const base = { ...answer, counts: { versionsCreated: 1, callsWithVersions: 1 } }
  // What was on screen: an older page (seqs 1, 2) under the first page (seqs 5, 6).
  const loaded = { ...base, revision: 'r1', recordTotal: 4, hasMore: true, olderBefore: 1, turns: [t(1, [rec(1, 1), rec(2, 1)]), t(2, [rec(5, 2), rec(6, 2)])] }
  // The first page moved on: seq 5 left it, seq 7 joined.
  const first = { ...base, revision: 'r2', recordTotal: 5, counts: { versionsCreated: 2, callsWithVersions: 2 }, hasMore: true, olderBefore: 6, turns: [t(2, [rec(6, 2), rec(7, 2)])] }
  const rebased = rebaseOlder(loaded, first)
  assert.deepEqual(rebased.turns.flatMap((turn) => turn.records.map((r) => r.seq)), [1, 2, 5, 6, 7], 'every record once, in log order')
  assert.equal(rebased.revision, 'r2', 'the new first page\'s revision')
  assert.equal(rebased.olderBefore, 1, 'the loaded cursor stays')
  assert.equal(rebased.hasMore, true)
  assert.deepEqual(rebased.counts, first.counts, 'a whole (non-windowed) first page keeps its newer totals')
  assert.equal(rebased.recordTotal, 5)
  // More than a page arrived: the new first page starts after every loaded record.
  assert.equal(rebaseOlder(loaded, { ...first, olderBefore: 9, turns: [t(3, [rec(9, 3)])] }), null, 'a gap drops the older pages')
  assert.equal(rebaseOlder(loaded, { ...first, hasMore: undefined, olderBefore: undefined }), null, 'a first page that reaches the start needs none')
})

const cpRow = (turn, at, kind = 'turn') => ({
  turn, kind, commit: `12${String(turn).padStart(64, '0')}`, branch: 'b1',
  changed: kind === 'base' ? 0 : 1, message: `${kind} ${turn}`, at,
})
const checkpointTicks = (items) => items.filter((item) => item.lane === 'layerfs' && item.select?.startsWith('c:'))

test('a page whose turns are newer than every checkpoint still ticks the base and all eight', () => {
  const newer = { ...turn2, records: [turn2.records[0]], orphanCalls: [], hostOps: [], checkpoints: [] }
  const base = cpRow(0, T0 - 5000, 'base')
  assert.equal(checkpointTicks(laneItems([newer], T0 + 20_000, [base])).length, 1, 'the base tick at 0:00')
  const eight = [base, ...[7, 46, 171, 188, 195, 199, 210].map((turn, i) => cpRow(turn, T0 + 30_000 + i))]
  const items = laneItems([newer], T0 + 40_000, eight)
  assert.equal(checkpointTicks(items).length, 8, 'one LayerFS tick per checkpoint even with no turn loaded')
  assert.equal(timeSpan([newer], T0 + 40_000, eight)?.start, base.at, 'the axis reaches the base checkpoint')
})

test('a loaded turn\'s checkpoints are not ticked twice, and a checkpoint outside it still ticks', () => {
  const loaded = { ...turn1, checkpoints: [{ ...turn1.checkpoints[0], turn: 1 }] }
  const base = cpRow(0, T0 - 5000, 'base')
  const outside = cpRow(2, T0 + 20_000)
  const items = laneItems([loaded], T0 + 20_000, [base, { ...loaded.checkpoints[0], turn: 1 }, outside])
  const ticks = checkpointTicks(items)
  assert.equal(ticks.length, 3, 'base, the loaded turn, and the unloaded turn once each')
  assert.deepEqual(ticks.map((item) => item.select), [checkpointKey(1, 0), checkpointKey(0, 0), checkpointKey(2, 0)])
  assert.equal(new Set(items.map((item) => item.key)).size, items.length, 'no duplicate keys')
})
