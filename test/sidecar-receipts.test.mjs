// The session sidecar split: metadata stays in `layerfs.json`, receipts live in
// an append-only `receipts.jsonl` beside it. A list read (metadata only) must
// never open, read or parse the receipts; a receipt reader streams them, pages
// them, and survives a legacy combined file plus a crash while migrating.
//   node --test test/sidecar-receipts.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-sidecar-receipts-'))
await build({
  absWorkingDir: root,
  stdin: { contents: "export * as persistence from './src/host/session-persistence.ts'\n", resolveDir: root, loader: 'ts' },
  outfile: join(out, 'persistence.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  external: ['@deepseek-ai/*'],
  logLevel: 'warning',
})
const P = await import(pathToFileURL(join(out, 'persistence.mjs')).href)
const scratch = mkdtempSync(join(root, '.dev-test-sidecar-receipts-'))
test.after(() => { rmSync(out, { recursive: true, force: true }); rmSync(scratch, { recursive: true, force: true }) })

const KEY = 'a'.repeat(64)
const SIDECAR = 'layerfs.json'
const RECEIPTS = 'receipts.jsonl'
const meta = (id) => ({ version: 1, sessionId: id, project: 'store/project', title: `title ${id}` })
const receipt = (id, extra = {}) => ({ id, sessionId: 's1', operation: 'file.write', outcome: 'success', at: 1_700_000_000_000, ms: 3, versions: [], ...extra })

/** A log plus its sidecar folder, as the stock unpacked backend would lay it out. */
function session(name, id = 's1') {
  const dir = join(scratch, name)
  mkdirSync(dir, { recursive: true })
  const log = join(dir, 'session.jsonl')
  writeFileSync(log, `${JSON.stringify({ version: 4, id, createdAt: 1 })}\n`)
  return { dir, log, id, sidecar: join(dir, SIDECAR), receipts: join(dir, RECEIPTS) }
}

/** The row over a fake backend, with local ownership so writes are allowed. */
function persistence(f, { owners = true } = {}) {
  const backend = {
    async stat() {
      if (!existsSync(f.log)) return undefined
      return { header: { version: 4, id: f.id, createdAt: 1 }, formatStatus: 'current', location: { kind: 'jsonl', path: f.log } }
    },
    async flush() {},
  }
  const w = Object.create(P.persistence.LayerfsSessionPersistence.prototype)
  Object.defineProperty(w, 'stock', { value: backend })
  Object.defineProperty(w, 'local', { value: backend })
  Object.defineProperty(w, 'ctx', { value: {
    get: (name) => name === 'layerfs' ? { projectSessionHome: f.dir } : undefined,
    logger: () => ({ warn() {}, info() {} }),
  } })
  Object.defineProperty(w, 'handles', { value: new Map() })
  Object.defineProperty(w, 'sidecars', { value: new Map() })
  Object.defineProperty(w, 'sidecarPaths', { value: new Map() })
  Object.defineProperty(w, 'sidecarBytes', { value: 0, writable: true })
  if (owners) {
    Object.defineProperty(w, 'owners', { value: { version: 1, sessions: { [f.id]: { project: 'store/project', key: KEY } } } })
    // Owned sessions route through a per-project backend; this fake is one backend.
    Object.defineProperty(w, 'backend', { value: async () => backend })
  }
  return w
}

/** Count real receipts-file reads through the overridable IO seam. */
function countingReceiptReads(w) {
  const counts = { reads: 0, paths: [] }
  const real = w.readReceiptsFile.bind(w)
  w.readReceiptsFile = (path) => { counts.reads++; counts.paths.push(path); return real(path) }
  return counts
}

test('a metadata read never touches the receipts file', async () => {
  const f = session('meta-only-read')
  writeFileSync(f.sidecar, JSON.stringify({ ...meta('s1'), checkpoints: [{ commit: 'c1' }] }))
  writeFileSync(f.receipts, [receipt('r1'), receipt('r2'), receipt('r3')].map((row) => JSON.stringify(row)).join('\n') + '\n')
  const w = persistence(f)
  const reads = countingReceiptReads(w)
  const cached = await w.readSidecar('s1', { cached: true })
  assert.equal(cached.title, 'title s1')
  assert.deepEqual(cached.checkpoints, [{ commit: 'c1' }])
  const copy = await w.readSidecar('s1')
  assert.equal(copy.title, 'title s1')
  assert.equal(reads.reads, 0, 'metadata reads never opened receipts.jsonl')
  // Receipts are read only when a caller actually asks for them, then cached by identity.
  assert.deepEqual(cached.invocations.map((row) => row.id), ['r1', 'r2', 'r3'])
  assert.equal(reads.reads, 1)
  assert.deepEqual(copy.invocations.map((row) => row.id), ['r1', 'r2', 'r3'])
  assert.equal(reads.reads, 1, 'the parsed receipts file stays hot while its identity holds')
  copy.invocations.push({ id: 'poison' })
  assert.deepEqual((await w.readSidecar('s1')).invocations.map((row) => row.id), ['r1', 'r2', 'r3'], 'non-cached callers never share the receipt array')
  assert.equal(existsSync(f.receipts), true)
})

test('a receipt written by this process is visible to the very next read, deduped by id', async () => {
  const f = session('append-visible')
  const w = persistence(f)
  await w.recordInvocation(receipt('op', { outcome: 'unknown' }))
  assert.equal(existsSync(f.sidecar), true)
  assert.equal(JSON.parse(readFileSync(f.sidecar, 'utf8')).invocations, undefined, 'metadata keeps no receipts')
  assert.equal(readFileSync(f.receipts, 'utf8').trim().split('\n').length, 1)
  assert.deepEqual((await w.readSidecar('s1')).invocations.map((row) => row.id), ['op'])
  // The same id is an update: appended, and read back as one receipt with the new value.
  await w.recordInvocation(receipt('op', { outcome: 'success' }))
  const after = (await w.readSidecar('s1')).invocations
  assert.equal(after.length, 1)
  assert.equal(after[0].outcome, 'success')
  assert.equal(readFileSync(f.receipts, 'utf8').trim().split('\n').length, 2, 'append-only: an update is a new line')
  await w.recordInvocation(receipt('newer'))
  const page = await w.readReceipts('s1', { from: -1, limit: 1 })
  assert.deepEqual(page.invocations.map((row) => row.id), ['newer'])
  assert.equal(page.total, 2)
  assert.equal(page.from, 1)
  assert.equal(page.truncated, true, 'a page that omits older receipts says so')
  // A parsed receipts file is folded forward on this process's append, and the
  // next read sees the new receipt without re-parsing the file.
  const reads = countingReceiptReads(w)
  assert.deepEqual((await w.readSidecar('s1')).invocations.map((row) => row.id), ['op', 'newer'])
  assert.equal(reads.reads, 0, 'the earlier readReceipts already parsed the file')
  await w.recordInvocation(receipt('folded'))
  assert.deepEqual((await w.readSidecar('s1')).invocations.map((row) => row.id), ['op', 'newer', 'folded'])
  assert.equal(reads.reads, 0, 'the append updated the parsed cache instead of invalidating it')
  // A foreign writer's append is seen through the file identity, not a TTL.
  appendFileSync(f.receipts, `${JSON.stringify(receipt('foreign'))}\n`)
  assert.deepEqual((await w.readReceipts('s1', { from: -1, limit: 1 })).invocations.map((row) => row.id), ['foreign'])
  assert.equal(reads.reads, 1, 'a foreign append moves the identity and forces a fresh read')
})

test('metadata-only updates never create a receipts file', async () => {
  const f = session('meta-only-write')
  writeFileSync(f.sidecar, JSON.stringify(meta('s1')))
  const w = persistence(f)
  await w.updateSidecar('s1', (value) => { value.checkpoints = [{ commit: 'c1' }] })
  assert.equal(existsSync(f.receipts), false)
  assert.equal((await w.readSidecar('s1')).checkpoints[0].commit, 'c1')
  assert.deepEqual((await w.readReceipts('s1')).invocations, [])
  // An empty receipts file is the same as an absent one: no error, no receipts.
  writeFileSync(f.receipts, '')
  const empty = await w.readReceipts('s1')
  assert.deepEqual(empty.invocations, [])
  assert.equal(empty.total, 0)
  assert.equal(empty.truncated, false)
})

test('first write migrates a legacy combined sidecar: every receipt kept, .bak retained, idempotent', async () => {
  const f = session('legacy-migrate')
  const rows = Array.from({ length: 500 }, (_, index) => receipt(`r${index}`))
  const legacy = { ...meta('s1'), checkpoints: [{ commit: 'old' }], invocations: rows }
  const original = JSON.stringify(legacy)
  writeFileSync(f.sidecar, original)
  const w = persistence(f)
  assert.equal((await w.readSidecar('s1')).invocations.length, 500, 'a legacy in-file array still reads')
  await w.recordInvocation(receipt('r-new'))
  assert.equal(existsSync(f.receipts), true)
  const migrated = JSON.parse(readFileSync(f.sidecar, 'utf8'))
  assert.equal(migrated.invocations, undefined)
  assert.deepEqual(migrated.checkpoints, [{ commit: 'old' }])
  assert.equal(migrated.title, 'title s1')
  assert.equal(readFileSync(`${f.sidecar}.bak`, 'utf8'), original, 'the combined original is kept verbatim')
  assert.equal(readFileSync(f.receipts, 'utf8').trim().split('\n').length, 501)
  const page = await w.readReceipts('s1')
  assert.deepEqual(page.invocations.map((row) => row.id), [...rows.map((row) => row.id), 'r-new'])
  // A later metadata write finds nothing to migrate and appends nothing.
  await w.updateSidecar('s1', (value) => { value.title = 'renamed' })
  assert.equal(readFileSync(f.receipts, 'utf8').trim().split('\n').length, 501)
  assert.deepEqual((await w.readReceipts('s1')).invocations.map((row) => row.id), [...rows.map((row) => row.id), 'r-new'])
  assert.equal((await w.readSidecar('s1')).title, 'renamed')
})

test('a crash mid-migration cannot lose receipts: the combined file still wins until the metadata rewrite', async () => {
  const f = session('legacy-crash')
  const rows = Array.from({ length: 40 }, (_, index) => receipt(`r${index}`))
  writeFileSync(f.sidecar, JSON.stringify({ ...meta('s1'), invocations: rows }))
  // Simulate the crash window: the receipts file is present (possibly partial),
  // the metadata was never rewritten. The next write migrates again from metadata.
  writeFileSync(f.receipts, rows.slice(0, 5).map((row) => JSON.stringify(row)).join('\n') + '\n')
  const w = persistence(f)
  await w.recordInvocation(receipt('after-crash'))
  const page = await w.readReceipts('s1')
  assert.deepEqual(page.invocations.map((row) => row.id), [...rows.map((row) => row.id), 'after-crash'])
  assert.equal(readFileSync(f.receipts, 'utf8').trim().split('\n').length, 41)
})

test('a crashed or incomplete final line is skipped, and a later append keeps working', async () => {
  const f = session('crashed-tail')
  writeFileSync(f.receipts, `${JSON.stringify(receipt('r1'))}\n{"id":"half-writ`)
  const w = persistence(f)
  const page = await w.readReceipts('s1')
  assert.deepEqual(page.invocations.map((row) => row.id), ['r1'])
  assert.equal(page.skipped, 1)
  await w.recordInvocation(receipt('r2'))
  const after = await w.readReceipts('s1')
  assert.deepEqual(after.invocations.map((row) => row.id), ['r1', 'r2'], 'the partial line does not swallow the new receipt')
})

test('the byte budget keeps the newest receipts and marks what was dropped', async () => {
  const f = session('bounded')
  writeFileSync(f.sidecar, JSON.stringify(meta('s1')))
  const w = persistence(f)
  w.receiptBudget = 2048
  // 60 receipts of ~100 bytes; the next append compacts to the newest <= budget.
  const rows = Array.from({ length: 60 }, (_, index) => receipt(`r${String(index).padStart(2, '0')}`, { payload: 'x'.repeat(60) }))
  writeFileSync(f.receipts, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
  const before = statSync(f.receipts).size
  assert.ok(before > 2048)
  await w.recordInvocation(receipt('newest', { payload: 'y'.repeat(60) }))
  const page = await w.readReceipts('s1')
  assert.ok(statSync(f.receipts).size <= 2048 + 256, `compacted size ${statSync(f.receipts).size}`)
  assert.equal(page.truncated, true)
  assert.ok(page.dropped > 0, `dropped ${page.dropped}`)
  assert.equal(page.invocations.at(-1).id, 'newest')
  assert.equal(page.invocations.some((row) => row.id === 'r00'), false, 'the oldest receipts were dropped')
  // The newest page is still readable without the dropped prefix.
  assert.deepEqual((await w.readReceipts('s1', { from: -2 })).invocations.map((row) => row.id), page.invocations.slice(-2).map((row) => row.id))
  // The marker is a marker, never a receipt.
  assert.equal(page.invocations.every((row) => typeof row.id === 'string'), true)
})

test('20k receipts: the receipts read is bounded and readSidecar stays metadata-sized', async () => {
  const f = session('synthetic-20k')
  writeFileSync(f.sidecar, JSON.stringify({ ...meta('s1'), checkpoints: Array.from({ length: 50 }, (_, index) => ({ commit: `c${index}` })) }))
  const text = Array.from({ length: 20_000 }, (_, index) => JSON.stringify(receipt(`r${String(index).padStart(6, '0')}`, { payload: 'z'.repeat(140) }))).join('\n') + '\n'
  writeFileSync(f.receipts, text)
  const bytes = Buffer.byteLength(text)
  const cold = persistence(f)
  const started = performance.now()
  const page = await cold.readReceipts('s1')
  const receiptsMs = performance.now() - started
  assert.equal(page.total, 20_000)
  assert.equal(page.bytes, bytes)
  assert.ok(receiptsMs < 1_000, `20k receipts parsed in ${receiptsMs.toFixed(1)} ms`)
  // A list read never looks at them, even cold: median of five independent reads.
  const times = []
  for (let run = 0; run < 5; run++) {
    const w = persistence(f)
    const at = performance.now()
    const sidecar = await w.readSidecar('s1', { cached: true })
    times.push(performance.now() - at)
    assert.equal(sidecar.title, 'title s1')
  }
  times.sort((a, b) => a - b)
  const median = times[2]
  assert.ok(median < 5, `readSidecar median ${median.toFixed(2)} ms (20k receipts: ${receiptsMs.toFixed(1)} ms for ${(bytes / 1e6).toFixed(1)} MB)`)
  console.log(`# 20k receipts: readReceipts ${receiptsMs.toFixed(1)} ms / ${(bytes / 1e6).toFixed(1)} MB; readSidecar median ${median.toFixed(2)} ms`)
})
