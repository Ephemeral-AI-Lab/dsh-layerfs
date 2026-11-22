// Backup state tone grading across chip, health dot/bar, signals, Store overview
// and Backups tab (layerfs-project#194 / #189): backups are optional, so missing
// or older backups are neutral (never amber); only Missing and Both changed are red.
//   node --test test/backup-tones.test.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = new URL('..', import.meta.url).pathname
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-backup-tones-'))
after(() => rmSync(out, { recursive: true, force: true }))
await build({
  absWorkingDir: root,
  stdin: {
    contents: [
      "export * from './src/client/storage/model.ts'",
      "export * from './src/client/storage/store-backups.ts'",
    ].join('\n'),
    resolveDir: root,
    loader: 'ts',
  },
  outfile: join(out, 'bt.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  external: ['@deepseek-ai/*'],
  logLevel: 'warning',
})
const M = await import(pathToFileURL(join(out, 'bt.mjs')).href)

const src = (rel) => readFileSync(join(root, rel), 'utf8')
const t = (key, vars = {}) => `${key}${Object.keys(vars).length ? ' ' + JSON.stringify(vars) : ''}`

const STATES = {
  current: [false, false, false],
  store_changed: [true, false, false],
  bucket_changed: [false, true, false],
  both_changed: [true, true, false],
  missing: [null, null, true],
}
const listed = (store, state) => {
  const [behind, changed, missing] = STATES[state]
  return { file: store, store, bytes: 10, modified: 1, behind, changed, missing, message: null }
}
const bucketWith = (store, state) => ({ name: 'b1', provider: 'minio', listed: 1, files: [listed(store, state)], error: null, stores: [] })
const storeWithLink = (name = 's1') => ({
  name, kind: 'sqlite', machine: 'native', state: 'ready', projects: [],
  links: [{ bucket: 'b1', file: name, last: { op: 'backup', at: 1, bytes: 10 } }],
})

test('backupChip: current is green, missing/both_changed are red, store_changed/bucket_changed/unlinked/unknown/unlisted are neutral', () => {
  assert.equal(M.backupChip('current', t).tone, 'success')
  assert.equal(M.backupChip('store_changed', t).tone, 'neutral')
  assert.equal(M.backupChip('bucket_changed', t).tone, 'neutral')
  assert.equal(M.backupChip('both_changed', t).tone, 'danger')
  assert.equal(M.backupChip('missing', t).tone, 'danger')
  assert.equal(M.backupChip('unlinked', t).tone, 'neutral')
  assert.deepEqual(M.backupChip('unknown', t), { tone: 'neutral', label: 'backupUnknown', dashed: true })
  assert.deepEqual(M.backupChip(null, t), { tone: 'neutral', label: 'backupNotListed', dashed: true })
  assert.deepEqual(M.backupChip(undefined, t), { tone: 'neutral', label: 'backupNotListed', dashed: true })
})

test('healthOf: only missing and both_changed are problem; store_changed and bucket_changed are stale (rendered neutral)', () => {
  assert.equal(M.healthOf('missing'), 'problem')
  assert.equal(M.healthOf('both_changed'), 'problem')
  assert.equal(M.healthOf('store_changed'), 'stale')
  assert.equal(M.healthOf('bucket_changed'), 'stale')
  assert.equal(M.healthOf('current'), 'current')
  assert.equal(M.healthOf('unlinked'), 'unknown')
  assert.equal(M.healthOf('unknown'), 'unknown')
  assert.equal(M.healthOf(null), 'unknown')
  // CSS must render data-health="stale" neutrally, never with warn/amber tokens
  for (const cssPath of ['src/client/storage/MachineStores.module.css', 'src/client/storage/BucketCards.module.css']) {
    const css = src(cssPath)
    const staleRules = css.match(/\[data-health='stale'\][^}]*\}/g) ?? []
    assert.ok(staleRules.length > 0, `${cssPath} styles data-health='stale'`)
    for (const rule of staleRules) {
      assert.doesNotMatch(rule, /state-warn/, `${cssPath} stale rule must not use amber warn token: ${rule}`)
    }
  }
})

test('storeSignal and bucketSignal: no backup, store_changed and bucket_changed emit no signal; only missing and both_changed emit error', () => {
  const noBackup = { name: 's0', kind: 'sqlite', machine: 'native', state: 'ready', projects: [], links: [] }
  assert.equal(M.storeSignal(noBackup, undefined, 'ready', [], t), null)
  for (const state of ['current', 'store_changed', 'bucket_changed']) {
    assert.equal(M.storeSignal(storeWithLink('s1'), undefined, 'ready', [bucketWith('s1', state)], t), null, `storeSignal(${state})`)
    assert.equal(M.bucketSignal([{ file: 's1', store: null, storeName: 's1', state, bytes: 10, modified: 1, reason: null, link: null }], t), null, `bucketSignal(${state})`)
  }
  for (const state of ['missing', 'both_changed']) {
    assert.equal(M.storeSignal(storeWithLink('s1'), undefined, 'ready', [bucketWith('s1', state)], t)?.state, 'error', `storeSignal(${state})`)
    assert.equal(M.bucketSignal([{ file: 's1', store: null, storeName: 's1', state, bytes: 10, modified: 1, reason: null, link: null }], t)?.state, 'error', `bucketSignal(${state})`)
  }
})

test('overviewBackupHealth: neutral for none/store_changed/bucket_changed, green for current, red only for missing/both_changed', () => {
  assert.deepEqual(M.overviewBackupHealth([], null), { tone: 'info', kind: 'none' })
  assert.deepEqual(M.overviewBackupHealth(['current'], 100), { tone: 'ok', kind: 'ok' })
  assert.deepEqual(M.overviewBackupHealth(['store_changed'], 100), { tone: 'info', kind: 'store_changed' })
  assert.deepEqual(M.overviewBackupHealth(['bucket_changed'], 100), { tone: 'info', kind: 'bucket_changed' })
  assert.deepEqual(M.overviewBackupHealth(['missing'], 100), { tone: 'danger', kind: 'problem', state: 'missing' })
  assert.deepEqual(M.overviewBackupHealth(['missing'], null), { tone: 'danger', kind: 'problem', state: 'missing' })
  assert.deepEqual(M.overviewBackupHealth(['both_changed'], 100), { tone: 'danger', kind: 'problem', state: 'both_changed' })
  assert.deepEqual(M.overviewBackupHealth(['current', 'store_changed'], 100), { tone: 'info', kind: 'store_changed' })
  assert.deepEqual(M.overviewBackupHealth(['store_changed', 'missing'], 100), { tone: 'danger', kind: 'problem', state: 'missing' })
})

test('StoreOverview and StoreLinks: no warning/amber tone for missing or older backups, red for missing and both_changed', () => {
  const overview = src('src/client/storage/StoreOverview.tsx')
  assert.doesNotMatch(overview, /latest === null \? 'warning'/, 'Last backup tile and Health row must not use warning for no backup')
  assert.doesNotMatch(overview, /behind \? 'warning'/, 'Health row must not use warning for older backup')
  const links = src('src/client/storage/StoreLinks.tsx')
  assert.doesNotMatch(links, /store_changed:\s*'warning'|bucket_changed:\s*'warning'|both_changed:\s*'warning'/, 'StoreLinks must not paint changed/conflict states warning')
})

test('StorageDetails and coverageOf are removed', () => {
  assert.equal(existsSync(join(root, 'src/client/storage/Details.tsx')), false)
  assert.equal('coverageOf' in M, false)
})
