// Backup states LayerFS leaves `unknown` for a Store on another machine,
// settled by the host from its own history fingerprints (src/host/routes/backup-heads.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = mkdtempSync(join(tmpdir(), 'dsh-backup-heads-'))
await build({ stdin: { contents: "export * from './src/host/routes/backup-heads.ts'", resolveDir: process.cwd(), loader: 'ts' }, outfile: join(root, 'heads.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24' })
const H = await import(pathToFileURL(join(root, 'heads.mjs')))

const REASON = 'Store cache is on box; its heads are read on native only'
const item = (over = {}) => ({ file: 'cache', store: 'cache', state: 'unknown', bytes: 1, modified: 1, reason: REASON, heads: 'h1', ...over })
const stores = (over = {}) => [{ name: 'cache', kind: 'sqlite', machine: 'box', backups: { minio: { file: 'cache', heads: 'h1', last: { op: 'create', at: 1, sha256: 's1' }, ...over } } }]
const marks = () => { const dir = mkdtempSync(join(root, 'marks-')); return { dir, m: new H.BackupMarks(dir) } }

test('only the remote-machine unknown is settled', () => {
  assert.equal(H.remoteOnly(item()), true)
  assert.equal(H.remoteOnly(item({ reason: 'the link records no heads' })), false)
  assert.equal(H.remoteOnly(item({ reason: `${REASON}; the listing read no sha256 of cache (at most 64 stats per listing)` })), false)
  assert.equal(H.remoteOnly(item({ state: 'current', reason: null })), false)
})

test('a marked backup with an unchanged Store and copy is current; each half changes the state', async () => {
  const { m } = marks()
  m.set('cache', 'minio', 'cache', { sha256: 's1', fingerprint: 'f1', at: 1 })
  const settle = (fp, copyHeads) => H.settleRemote([item({ heads: copyHeads })], 'minio', stores(), m, async () => fp).then((x) => x[0])
  assert.deepEqual(await settle('f1', 'h1'), { ...item(), state: 'current', reason: null, checked: 'host' })
  assert.equal((await settle('f2', 'h1')).state, 'store_changed')
  assert.equal((await settle('f1', 'h9')).state, 'bucket_changed')
  assert.equal((await settle('f2', 'h9')).state, 'both_changed')
})

test('no mark, or a mark from an earlier transfer, stays unknown and says it is untracked', async () => {
  const { m } = marks()
  let [x] = await H.settleRemote([item()], 'minio', stores(), m, async () => 'f1')
  assert.equal(x.state, 'unknown'); assert.equal(x.untracked, true); assert.equal(x.reason, REASON)
  m.set('cache', 'minio', 'cache', { sha256: 'older', fingerprint: 'f1', at: 1 });
  [x] = await H.settleRemote([item()], 'minio', stores(), m, async () => 'f1')
  assert.equal(x.state, 'unknown'); assert.equal(x.untracked, true)
})

test('an unreadable Store or a copy without heads keeps LayerFS state', async () => {
  const { m } = marks()
  m.set('cache', 'minio', 'cache', { sha256: 's1', fingerprint: 'f1', at: 1 })
  let [x] = await H.settleRemote([item()], 'minio', stores(), m, async () => { throw new Error('worker down') })
  assert.equal(x.state, 'unknown'); assert.equal(x.untracked, undefined)
  ;[x] = await H.settleRemote([item({ heads: null })], 'minio', stores(), m, async () => 'f1')
  assert.equal(x.state, 'unknown')
})

test('one fingerprint per Store per listing; other items pass through untouched', async () => {
  const { m } = marks()
  m.set('cache', 'minio', 'cache', { sha256: 's1', fingerprint: 'f1', at: 1 })
  m.set('cache', 'minio', 'cache-2', { sha256: 's2', fingerprint: 'f1', at: 1 })
  const two = [{ name: 'cache', machine: 'box', backups: { minio: { file: 'cache', heads: 'h1', last: { sha256: 's1' } } } }]
  let calls = 0
  const other = { file: 'x', store: null, state: 'unlinked', reason: null }
  const out = await H.settleRemote([item(), other], 'minio', two, m, async () => (calls++, 'f1'))
  assert.equal(calls, 1)
  assert.equal(out[0].state, 'current')
  assert.equal(out[1], other)
})

test('marks persist in the stat folder', () => {
  const { dir, m } = marks()
  m.set('cache', 'minio', 'cache', { sha256: 's1', fingerprint: 'f1', at: 5 })
  assert.ok(existsSync(join(dir, 'backup-marks.json')))
  assert.deepEqual(new H.BackupMarks(dir).get('cache', 'minio', 'cache'), { sha256: 's1', fingerprint: 'f1', at: 5 })
})

test('the fingerprint covers main, every Branch base and head, and nothing else', async () => {
  let state = { compiler: { main: 'L1', branches: [{ name: 'main', base: 'L1', head: null }, { name: 'a', base: 'L1', head: 'C1' }] } }
  const lfs = {
    project: { list: async () => ({ items: Object.keys(state).map((name) => ({ project: `cache/${name}`, name })), next_page_pos: null }) },
    branch: {
      list: async (ref) => ({ items: state[ref.split('/')[1]].branches, next_page_pos: null }),
      commits: async (ref) => ({ items: [{ id: state[ref.split('/')[1]].main }] }),
    },
  }
  const a = await H.historyFingerprint(lfs, 'cache')
  assert.equal(await H.historyFingerprint(lfs, 'cache'), a)
  state.compiler.branches[1] = { name: 'a', base: 'L1', head: 'C2' }
  const b = await H.historyFingerprint(lfs, 'cache')
  assert.notEqual(b, a)
  state.compiler.main = 'L2'
  assert.notEqual(await H.historyFingerprint(lfs, 'cache'), b)
  state = { ...state, sdk: { main: 'L9', branches: [] } }
  assert.notEqual(await H.historyFingerprint(lfs, 'cache'), b)
})

test.after(() => rmSync(root, { recursive: true, force: true }))
