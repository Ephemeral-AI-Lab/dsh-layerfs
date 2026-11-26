// The receipt policy: a write is history, an observation is a counter.
//   node --test test/receipt-policy.test.mjs
//
// A session's layerfs.json used to grow by one receipt per traced call: a real
// one held 83,250 receipts / 55.2 MB, 92% of them read-only calls the plugin
// makes itself (observe polls, store/branch listings, log reads). These tests
// pin the policy at the recording seam (a host read folds into the counter, a
// write/refusal/agent command keeps its receipt), the cap that trims the oldest
// receipts, and the idempotent migration that compacts an existing sidecar.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-receipt-policy-'))
await build({
  absWorkingDir: root,
  stdin: { contents: "export * from './src/host/layerfs/tracing.ts'\nexport { isWrite } from './src/shared/logs.ts'\n", resolveDir: root, loader: 'ts' },
  outfile: join(out, 'policy.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  external: ['@deepseek-ai/*'],
  logLevel: 'warning',
})
const P = await import(pathToFileURL(join(out, 'policy.mjs')).href)
const scratch = mkdtempSync(join(root, '.dev-test-receipt-policy-'))
test.after(() => { rmSync(out, { recursive: true, force: true }); rmSync(scratch, { recursive: true, force: true }) })
P.resetAggregatedReads()

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
    aggregate: async (row) => { aggregated.push(row) },
  }
  try {
    await P.withTraceContext(context, () => P.traceInvocation(operation, run, options.targetProject, options.targetWorkspace, argv ? () => ({ argv }) : undefined))
  } catch (error) {
    if (!options.throws) throw error
  }
  return { receipts, aggregated, meta: P.aggregatedReads(sessionId) }
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

test('an old sidecar compacts into the aggregate, keeps writes, and survives a reload', () => {
  const dir = join(scratch, 'legacy')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'layerfs.json')
  const reads = [
    receipt('r1', 'workspace.status', { origin: 'tool' }),
    receipt('r2', 'workspace.status', { origin: 'host', at: 1_700_000_001_000 }),
    receipt('r3', 'home.log', { origin: 'tool' }),
    receipt('r4', 'file.read', { origin: 'tool' }),
  ]
  const refusal = receipt('r5', 'file.read', { outcome: 'refusal', code: 'NotFound', origin: 'tool' })
  const writes = [
    receipt('w1', 'file.write', { origin: 'tool', versions: [{ kind: 'Commit', id: COMMIT, effect: 'created' }] }),
    receipt('w2', 'workspace.commit', { origin: 'host', versions: [{ kind: 'Commit', id: COMMIT, effect: 'unchanged' }] }),
    receipt('w3', 'branch.remove', { origin: 'tool' }),
  ]
  const original = {
    version: 1, sessionId: 'legacy', project: 'store/project', title: 'keep me',
    checkpoints: [{ kind: 'turn', turn: 1, commit: COMMIT }],
    invocations: [...reads, ...writes.slice(0, 1), refusal, ...writes.slice(1)],
  }
  writeFileSync(path, `${JSON.stringify(original, null, 2)}\n`)
  const beforeBytes = Buffer.byteLength(readFileSync(path))
  const result = P.compactSidecarFile(path)
  assert.ok(result)
  assert.equal(result.folded, 4, 'all four successful reads folded, whatever their origin')
  assert.equal(result.dropped, 0)
  assert.ok(result.bytes.after < result.bytes.before)
  assert.ok(existsSync(`${path}.bak`), 'the original is kept once for recovery')

  const reloaded = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(reloaded.title, 'keep me', 'metadata is preserved')
  assert.deepEqual(reloaded.checkpoints, original.checkpoints)
  assert.deepEqual(reloaded.invocations.map((row) => row.id), ['w1', 'r5', 'w2', 'w3'], 'writes and the read refusal are kept in order')
  assert.equal(reloaded.receipts.readsTotal, 4)
  assert.deepEqual(reloaded.receipts.reads['workspace.status'], { count: 2, lastAt: 1_700_000_001_000, lastOutcome: 'success' })
  assert.equal(reloaded.receipts.reads['home.log'].count, 1)
  assert.equal(reloaded.receipts.foldedThrough, 'r4')
  assert.equal(reloaded.receipts.truncated, false)
  // The "Only LayerFS writes" filter is still exact: what stays is writes or a refusal.
  assert.ok(reloaded.invocations.every((row) => row.outcome !== 'success' || P.isWrite(row.argv)))
  assert.ok(!JSON.stringify(reloaded.invocations).includes('workspace status'), 'no read receipt survived')

  // Reload → next write: a second compaction folds nothing and writes nothing.
  const beforeSecond = readFileSync(path, 'utf8')
  const second = P.compactSidecarFile(path)
  assert.equal(second.folded, 0)
  assert.equal(second.dropped, 0)
  assert.equal(second.bytes.before, result.bytes.after, 'same file size')
  assert.equal(readFileSync(path, 'utf8'), beforeSecond, 'idempotent: the file is byte-identical')
})

test('a migration interrupted between metadata and receipts never counts a read twice', () => {
  const rows = [receipt('a', 'workspace.status', { at: 10 }), receipt('b', 'home.log', { at: 20 }), receipt('w', 'file.write', { at: 30 })]
  const first = P.compactInvocations(undefined, rows)
  assert.equal(first.meta.readsTotal, 2)
  // Crash after the metadata write: the receipts still hold the folded rows.
  const retry = P.compactInvocations(first.meta, rows)
  assert.equal(retry.folded, 0, 'the foldedThrough watermark skips them')
  assert.equal(retry.meta.readsTotal, 2, 'no double count')
  assert.deepEqual(retry.invocations.map((row) => row.id), ['w'], 'the folded rows are dropped')
  // And once the trimmed receipts are written, the watermark id is gone: the same answer.
  const done = P.compactInvocations(retry.meta, retry.invocations)
  assert.deepEqual(done.meta, retry.meta)
  assert.deepEqual(done.invocations, retry.invocations)
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
