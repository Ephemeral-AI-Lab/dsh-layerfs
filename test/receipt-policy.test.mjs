// The receipt policy: a write is history, an observation is a counter.
//   node --test test/receipt-policy.test.mjs
//
// A session's layerfs.json used to grow by one receipt per traced call: a real
// one held 83,250 receipts / 55.2 MB, 92% of them read-only calls the plugin
// makes itself (observe polls, store/branch listings, log reads). These tests
// pin the policy at the recording seam (a host read folds into the counter, a
// write/refusal/agent command keeps its receipt) and the cap that trims the
// oldest receipts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-receipt-policy-'))
await build({
  absWorkingDir: root,
  stdin: { contents: "export * from './src/host/layerfs/tracing.ts'\nexport { isWrite } from './src/shared/logs.ts'\nexport { buildTrajectory, trajectoryRevision, pageTrajectory } from './src/host/sessions/trace.ts'\n", resolveDir: root, loader: 'ts' },
  outfile: join(out, 'policy.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  external: ['@deepseek-ai/*'],
  logLevel: 'warning',
})
const P = await import(pathToFileURL(join(out, 'policy.mjs')).href)
test.after(() => { rmSync(out, { recursive: true, force: true }) })
/** Each session's counter, as persistence's `aggregateInvocation` folds it into the sidecar metadata. */
const counters = new Map()

let n = 0
const id = () => `policy-session-${++n}`
const COMMIT = 'a'.repeat(66)
const LAYER = 'b'.repeat(66)

/** Run one traced SDK call; answers the receipts it recorded and the counter it folded. */
async function traced(sessionId, operation, run, argv, options = {}) {
  const receipts = [], aggregated = []
  const context = {
    origin: options.origin ?? 'host', sessionId, project: 'store/project', turn: 1, toolCallId: options.toolCallId, workspace: options.workspace,
    record: async (row) => { receipts.push(row) },
    aggregate: async (row) => {
      aggregated.push(row)
      counters.set(sessionId, P.foldRead(counters.get(sessionId), { operation: row.operation, at: row.at ?? 0, outcome: row.outcome }, { count: row.outcome === 'success' }))
    },
  }
  try {
    await P.withTraceContext(context, () => P.traceInvocation(operation, run, options.targetProject, options.targetWorkspace, argv ? () => ({ argv }) : undefined))
  } catch (error) {
    if (!options.throws) throw error
  }
  return { receipts, aggregated, meta: counters.get(sessionId) }
}

/** One receipt row as the sidecar holds it. */
const receipt = (rid, operation, extra = {}) => ({
  id: rid, origin: 'host', sessionId: 'legacy', project: 'store/project', operation,
  outcome: 'success', versions: [], at: 1_700_000_000_000, ms: 4, argv: operation.split('.').slice(0, 2), ...extra,
})

test('a read-only host call adds no receipt and increments the aggregate', async () => {
  const sessionId = id()
  const status = await traced(sessionId, 'workspace.status', async () => ({ state: 'ready', changes_count: 0 }), ['workspace', 'status', 'sb:main'])
  const log = await traced(sessionId, 'home.log', async () => ({ items: [] }), ['home', 'log', '--detail'])
  const list = await traced(sessionId, 'file.list', async () => ({ items: ['a'] }), ['file', 'list', 'store/project'])
  assert.deepEqual(status.receipts, [], 'a successful poll is not history')
  assert.deepEqual(log.receipts, [])
  assert.deepEqual(list.receipts, [])
  assert.equal(status.aggregated.length + log.aggregated.length + list.aggregated.length, 3, 'the persistence hook sees each folded read')
  const meta = list.meta
  assert.equal(meta.readsTotal, 3)
  assert.deepEqual(Object.fromEntries(Object.entries(meta.reads).map(([op, read]) => [op, read.count])), { 'workspace.status': 1, 'home.log': 1, 'file.list': 1 })
  for (const read of Object.values(meta.reads)) {
    assert.equal(read.lastOutcome, 'success')
    assert.ok(read.lastAt > 0)
  }
  assert.ok(meta.firstAt > 0 && meta.lastAt >= meta.firstAt)
  const lines = P.receiptAggregateLines(meta)
  assert.equal(lines[0], 'polled 3 times across 3 read-only operations', 'the inspector keeps the aggregated line')
  assert.ok(lines.some((line) => line.startsWith('workspace status: 1')))
  assert.deepEqual(P.receiptAggregateLines(P.emptyReceiptMeta()), [], 'nothing folded: no observation line')
})

test('a tool-origin read adds one receipt; a host poll inside the same tool context does not', async () => {
  // The agent's own command: a receipt built from its tagged call-log line (origin tool).
  const callId = 'call-bash-read'
  const identity = { origin: 'tool', sessionId: 'commanded', project: 'store/project', turn: 2, toolCallId: callId, scope: P.toolScope('commanded', callId) }
  const line = { v: 1, at: 1_700_000_000_500, ms: 9, client: 'cli', argv: ['file', 'read', 'store/project', 'dsh.s', '/README.md'], outcome: 'ok', tag: `dsh:commanded:${identity.scope}.0` }
  const commandRead = P.receiptFromLine(line, identity, `${identity.scope}.0`)
  assert.equal(commandRead.origin, 'tool')
  assert.equal(P.receiptDisposition(commandRead, 'tool'), 'keep', 'an agent command is history whatever it reads')
  assert.equal(P.receiptDisposition(commandRead, 'host'), 'aggregate', 'the same call made by the host would be a poll')
  const collected = [commandRead]
  assert.equal(collected.length, 1)

  // The plugin's own read: it runs inside the tool's async context (origin tool),
  // but a host-process SDK call is still the plugin polling, not the agent's command.
  const sessionId = id()
  const poll = await traced(sessionId, 'file.read', async () => ({ text: 'x' }), ['file', 'read', 'store/project', 'dsh.s', '/README.md'], { origin: 'tool', toolCallId: callId })
  assert.deepEqual(poll.receipts, [], 'no receipt for the plugin\'s read')
  assert.equal(poll.aggregated.length, 1, 'it is counted')
  assert.equal(poll.meta.readsTotal, 1)
})

test('a write adds exactly one receipt with its versions; a refusal adds one and is counted as last outcome', async () => {
  const sessionId = id()
  const write = await traced(sessionId, 'file.write', async () => ({ commit: COMMIT }), ['file', 'write', 'store/project', 'dsh.s', '/a', '<3 bytes>'])
  assert.equal(write.receipts.length, 1)
  assert.equal(write.receipts[0].outcome, 'success')
  assert.deepEqual(write.receipts[0].versions, [{ kind: 'Commit', id: COMMIT, effect: 'created' }], 'checkpoint/version linking is unchanged for writes')
  assert.equal(write.meta, undefined, 'a write folds nothing')

  const commit = await traced(sessionId, 'workspace.commit', async () => ({ commit: COMMIT, unchanged: true }), ['workspace', 'commit', 'sb:main'], { targetWorkspace: 'sb:main', origin: 'host', workspace: 'sb:main' })
  assert.equal(commit.receipts.length, 1)
  assert.deepEqual(commit.receipts[0].versions, [{ kind: 'Commit', id: COMMIT, effect: 'unchanged' }])

  // A refused read: a receipt (all refusals are history) and the counter's last outcome moves.
  const before = await traced(sessionId, 'workspace.status', async () => ({ state: 'ready' }), ['workspace', 'status', 'sb:main'])
  assert.equal(before.meta.reads['workspace.status'].lastOutcome, 'success')
  const refusal = await traced(sessionId, 'workspace.status', async () => { throw Object.assign(new Error('gone'), { transport: 'refusal', code: 'NotFound' }) }, ['workspace', 'status', 'sb:missing'], { throws: true })
  assert.equal(refusal.receipts.length, 1)
  assert.equal(refusal.receipts[0].outcome, 'refusal')
  assert.equal(refusal.receipts[0].code, 'NotFound')
  assert.equal(refusal.meta.reads['workspace.status'].lastOutcome, 'refusal', 'the aggregate says the last poll failed')
  assert.equal(refusal.meta.reads['workspace.status'].count, 1, 'a refusal is recorded, not folded as a read')

  const unknown = await traced(sessionId, 'workspace.status', async () => { throw Object.assign(new Error('lost'), { code: 'Unknown' }) }, ['workspace', 'status', 'sb:main'], { throws: true })
  assert.equal(unknown.receipts.length, 1)
  assert.equal(unknown.receipts[0].outcome, 'unknown')
})

test('store.* stays recorded (Reading history), store.get is an observation', async () => {
  const sessionId = id()
  const list = await traced(sessionId, 'store.list', async () => ({ items: [] }), ['store', 'list'])
  assert.equal(list.receipts.length, 1, 'goal 1 keeps store.* even though it only reads')
  const get = await traced(sessionId, 'store.get', async () => ({ store: 's' }), ['store', 'get', 's'])
  assert.deepEqual(get.receipts, [], 'goal 2 names store.get as an observation')
  assert.equal(get.meta.reads['store.get'].count, 1)
})

test('the cap trims the oldest receipts first and marks truncation', () => {
  const writes = Array.from({ length: 6 }, (_, i) => receipt(`w${i}`, 'file.write', { at: 1000 + i }))
  const result = P.compactInvocations(undefined, writes, { cap: 3 })
  assert.deepEqual(result.invocations.map((row) => row.id), ['w3', 'w4', 'w5'], 'the newest three survive, in order')
  assert.equal(result.dropped, 3)
  assert.equal(result.meta.dropped, 3)
  assert.equal(result.meta.truncated, true)
  assert.equal(result.meta.cap, 3)
  // Running the cap again over its own result changes nothing.
  const again = P.compactInvocations(result.meta, result.invocations, { cap: 3 })
  assert.deepEqual(again.invocations, result.invocations)
  assert.deepEqual(again.meta, result.meta)
  assert.equal(again.dropped, 0)
  assert.equal(P.RECEIPT_CAP, 5000, 'the default cap is the documented 5,000')
  assert.equal(P.emptyReceiptMeta().cap, 5000)
})

test('the cap folds nothing: every kept receipt is history, reads were counted when made', () => {
  const rows = [receipt('a', 'workspace.status', { at: 10 }), receipt('b', 'home.log', { at: 20 }), receipt('w', 'file.write', { at: 30 })]
  const result = P.compactInvocations(undefined, rows)
  assert.deepEqual(result.invocations.map((row) => row.id), ['a', 'b', 'w'])
  assert.equal(result.meta.readsTotal, 0)
  assert.equal('foldedThrough' in result.meta, false)
})

test('a write is visible in the very next read: ordering is untouched', async () => {
  const sessionId = id()
  const order = []
  await P.withTraceContext({
    origin: 'host', sessionId, project: 'store/project',
    record: async (row) => { order.push(row.operation) },
    aggregate: async (row) => { order.push(`poll:${row.operation}`) },
  }, async () => {
    await P.traceInvocation('file.write', async () => ({ commit: COMMIT }), undefined, undefined, () => ({ argv: ['file', 'write', 'store/project', 'dsh.s', '/a'] }))
    await P.traceInvocation('workspace.status', async () => ({ state: 'ready' }), undefined, undefined, () => ({ argv: ['workspace', 'status', 'sb:main'] }))
    await P.traceInvocation('file.write', async () => ({ commit: LAYER }), undefined, undefined, () => ({ argv: ['file', 'write', 'store/project', 'dsh.s', '/b'] }))
  })
  assert.deepEqual(order, ['file.write', 'poll:workspace.status', 'file.write'], 'receipts keep their order around folded reads')
})

test('the trajectory shows one observation row, identical in whole and first-page builds', () => {
  const counters = {
    version: 1, readsTotal: 31_597, firstAt: 1_700_000_000_000, lastAt: 1_700_000_002_000,
    dropped: 0, cap: 5000, truncated: false,
    reads: {
      'workspace.status': { count: 31_000, lastAt: 1_700_000_002_000, lastOutcome: 'success' },
      'home.log': { count: 597, lastAt: 1_700_000_001_000, lastOutcome: 'success' },
    },
  }
  const events = [
    { type: 'turn/start', seq: 1, time: 10, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: 11, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'go' }] } },
    { type: 'assistant/message', seq: 3, time: 12, data: { turn: 1, message: { content: [{ type: 'text', text: 'done' }] } } },
    { type: 'turn/end', seq: 4, time: 13, data: { turn: 1 } },
  ]
  const input = { sessionId: 'observed', project: 'store/project', branch: 'b1', events, invocations: [], checkpoints: [], receipts: counters }
  const whole = P.buildTrajectory(input)
  const row = whole.turns.at(-1).records.at(-1)
  assert.equal(row.kind, 'observation')
  assert.equal(row.text, 'polled 31,597 times across 2 read-only operations')
  assert.deepEqual(row.top, ['workspace status: 31,000', 'home log: 597'])
  assert.equal(row.reads, 31_597)
  assert.equal(row.seq, 5, 'it sits just after the newest event')
  assert.equal(row.turn, 1)

  // A first-page build materializes only the newest records but carries the row
  // at the same place; its total counts the observation (no double count).
  const first = P.buildTrajectory(input, { newest: 1 })
  assert.deepEqual(first.turns.at(-1).records.at(-1), row)
  assert.equal(first.recordTotal, whole.turns.flatMap((t) => t.records).length, 'the observation is one record in the total')
  const wholePage = P.pageTrajectory(whole)
  const firstPage = P.pageTrajectory(first)
  assert.deepEqual(wholePage.turns.at(-1).records.at(-1), row)
  assert.deepEqual(firstPage.turns.at(-1).records.at(-1), row, 'whole and first-page builds agree at the same position')
  assert.ok(JSON.stringify(wholePage).includes('polled 31,597 times'), 'the row is inside the first page, so it counts against its bytes')
  // The older page starts before the observation (it is the newest content).
  const older = P.pageTrajectory(whole, 2)
  assert.ok(!older.turns.some((turn) => turn.records.some((record) => record.kind === 'observation')))

  // The counter is part of the revision: a new poll forces a fresh answer even
  // though no receipt was written.
  const revision = P.trajectoryRevision(input)
  assert.notEqual(P.trajectoryRevision({ ...input, receipts: { ...counters, readsTotal: 31_598 } }), revision)
  assert.equal(P.trajectoryRevision({ ...input }), revision)
  // No counter: no row (a write-only session).
  assert.ok(!P.buildTrajectory({ ...input, receipts: undefined }).turns.some((turn) => turn.records.some((record) => record.kind === 'observation')))
})
