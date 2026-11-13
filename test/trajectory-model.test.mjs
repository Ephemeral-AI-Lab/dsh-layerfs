import assert from 'node:assert/strict'
import test from 'node:test'
import {
  checkpointVersion, durationParts, filterTurns, flattenRows, focusTarget, laneItems, opCommand, opWrites, place,
  prettyArgs, recentTurns, recordMatches, selectionTurn, shownHostOp, timeSpan,
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
