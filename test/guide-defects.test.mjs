// UI defects the UI guide's writers found (docs/guide/): the client halves.
// The host halves are in test/routes-features.test.mjs ("file compare",
// "file history and blame") and the Workspace handle in test/sandbox-page.test.mjs.
//   node --test test/guide-defects.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { miniReact } from './mini-react.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-guide-defects-'))
await build({
  absWorkingDir: root,
  stdin: {
    contents: [
      "export { mount, elements, text } from 'react'",
      "export { compareFiles } from './src/client/files/BranchCompare.tsx'",
      "export { hunksOf } from './src/client/files/CommitDiff.tsx'",
      "export { pickedCompare, treeCounts } from './src/client/files/ProjectHistory.tsx'",
      "export { filesEn, filesZh } from './src/client/files/locale.ts'",
      "export { tagWords } from './src/client/logs/LogsPage.tsx'",
      "export { locales as logsLocales } from './src/client/logs/locale.ts'",
      "export { backupChip, listStatusWords, placeWords } from './src/client/storage/model.ts'",
      "export { providerWords } from './src/client/storage/BucketPage.tsx'",
      "export { StoreBackups } from './src/client/storage/StoreLinks.tsx'",
      "export { locales as storageLocales } from './src/client/storage/locale.ts'",
    ].join('\n'),
    resolveDir: root, loader: 'tsx',
  },
  outfile: join(out, 'guide.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24', logLevel: 'error',
  jsx: 'automatic', loader: { '.module.css': 'local-css', '.css': 'css' }, plugins: [miniReact],
})
const M = await import(pathToFileURL(join(out, 'guide.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

const src = (path) => readFileSync(join(root, path), 'utf8')
const fill = (text, vars = {}) => text.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`))
const tOf = (dict) => (key, vars) => fill(dict[key] ?? key, vars)

test('1: a modified file\'s hunk keeps its removed and kept lines on the before side', () => {
  const rows = [{ op: ' ', text: 'one', left_line: 1, right_line: 1 }, { op: '-', text: 'two', left_line: 2 }, { op: '+', text: 'three', right_line: 2 }]
  assert.deepEqual(M.hunksOf('/a.txt', rows, false), [{ path: '/a.txt', oldText: 'one\ntwo\n', newText: 'one\nthree\n' }])
  assert.deepEqual(M.hunksOf('/a.txt', [{ op: '+', text: 'hi', right_line: 1 }], true), [{ path: '/a.txt', oldText: null, newText: 'hi\n' }])
  // the client reads the side the host sends: before null is an added path, an object is a file that was there
  assert.match(src('src/client/files/CommitDiff.tsx'), /const added = r\.before === null \|\|/)
})

test('3: "Only owner changes" is offered only when LayerFS says per file whether owners changed', () => {
  const unknown = [{ path: '/a', type: 'file', attribution: null }, { path: '/d', type: 'dir', attribution: null }, { path: '/b', type: 'file', attribution: null }]
  assert.deepEqual(M.compareFiles(unknown, true), { ownersKnown: false, files: [unknown[0], unknown[2]] }, '2.0: every file, and no option')
  const known = [{ path: '/a', type: 'file', attribution: true }, { path: '/b', type: 'file', attribution: false }]
  assert.deepEqual(M.compareFiles(known, true), { ownersKnown: true, files: [known[0]] })
  assert.deepEqual(M.compareFiles(known, false).files, known)
})

test('5: a "Compare with…" pick ends at a Branch (its head) as well as at a version', () => {
  const picking = { branch: 'feat', pin: 'p1' }
  assert.deepEqual(M.pickedCompare(picking, { branch: 'main' }, 'h-main'), { from: picking, to: { branch: 'main' } })
  assert.deepEqual(M.pickedCompare(picking, { branch: 'feat', pin: 'p2' }, 'h-feat'), { from: picking, to: { branch: 'feat', pin: 'p2' } })
  assert.equal(M.pickedCompare(picking, { branch: 'feat', pin: 'p1' }, 'h-feat'), null, 'the version picked first')
  assert.equal(M.pickedCompare(picking, { branch: 'feat' }, 'p1'), null, 'a Branch whose head is the version picked first')
  // the Branch tag and the finder go through the pick while picking
  assert.match(src('src/client/files/ProjectHistory.tsx'), /const openBranch = \(name: string\) => \{\n\s+\/\/[^\n]*\n\s+if \(picking\) \{ setFinderOpen\(false\); if \(completePick\(\{ branch: name \}\)\) return \}/)
})

test('6: the Store\'s Backups tab says a backup\'s state and provider in the words the bucket page uses', () => {
  const t = tOf(M.storageLocales.en)
  assert.deepEqual(['current', 'store_changed', 'bucket_changed'].map((s) => M.backupChip(s, t).label), ['Backed up', 'Store changed', 'Bucket changed'])
  assert.equal(M.providerWords('minio', t), 'MinIO')
  const links = src('src/client/storage/StoreLinks.tsx')
  assert.match(links, /backupChip\(state, t\)/)
  assert.match(links, /providerWords\(bucket\.provider, t\)/)
  const noop = () => {}
  const store = {
    name: 'notes', kind: 'sqlite', machine: 'macos-host', state: 'ready', projects: [], projectsCount: 0,
    links: [
      { bucket: 'ok-b', file: 'notes', last: { op: 'backup', at: 1000, bytes: 1024 } },
      { bucket: 'unlisted-b', file: 'notes', last: { op: 'backup', at: 1000, bytes: 1024 } },
      { bucket: 'failed-b', file: 'notes', last: { op: 'backup', at: 1000, bytes: 1024 } },
    ],
  }
  const view = {
    stores: [store], machines: [], jobs: [], auths: [],
    buckets: [
      { name: 'ok-b', provider: 'minio', url: 's3://ok', files: [{ file: 'notes', store: 'notes', behind: false, changed: false, missing: false, bytes: 1024 }] },
      { name: 'unlisted-b', provider: 'minio', url: 's3://unlisted', files: null },
      { name: 'failed-b', provider: 'r2', url: 's3://failed', files: null, error: { code: 'timeout', message: 'offline' } },
    ],
  }
  const on = { backup: noop, backupTo: noop, restore: noop, remove: noop, push: noop, pull: noop, move: noop, disconnect: noop, start: noop, addProject: noop, editConnection: noop, check: noop, connectMachine: noop, removeOwn: noop, newOnServer: noop, retry: noop, dismiss: noop, openMachine: noop }
  const tree = M.mount(M.StoreBackups, { store, view, t, now: 2000, on }).tree
  const card = (name) => M.elements(tree).find((n) => n.props?.['data-backup-link'] === name)
  const pill = (name) => M.elements(card(name)).find((n) => n.type === 'span' && ('data-tone' in (n.props ?? {}) || 'data-dashed' in (n.props ?? {})))
  assert.equal(M.text(pill('ok-b')), 'Backed up')
  assert.ok(M.elements(card('ok-b')).some((n) => n.type === 'dd' && M.text(n) === 'MinIO'))
  assert.equal(pill('unlisted-b')?.props?.['data-dashed'], true)
  assert.equal(M.text(pill('unlisted-b')), M.backupChip(undefined, t).label)
  assert.equal(pill('failed-b')?.props?.['data-tone'], 'danger')
  assert.equal(pill('failed-b')?.props?.title, 'offline')
  assert.equal(M.text(pill('failed-b')), M.listStatusWords('timeout', t))
  assert.ok(M.elements(card('failed-b')).some((n) => n.type === 'dd' && M.text(n) === 'Cloudflare R2'))
  for (const lang of ['en', 'zh']) assert.equal(Object.keys(M.storageLocales[lang]).some((k) => k.startsWith('spBackupState_')), false)
})

test('7 (revised 2026-11-24): a Store on the host machine names the host machine like any machine; the LayerFS home is not a machine', () => {
  assert.equal(M.placeWords('macos-host'), 'macos-host')
  assert.equal(M.placeWords('docker'), 'docker')
  assert.doesNotMatch(src('src/client/hero/HeroProject.tsx'), /m === 'macos-host' \? t\('home'\)/)
  assert.doesNotMatch(src('src/client/projects/setup/ProjectDialog.tsx'), /placeName\(/)
  for (const file of ['src/client/storage/locale.ts', 'src/client/machines/locale.ts', 'src/client/projects/setup/locale.ts', 'src/client/doctor/locale.ts', 'src/client/picker/locale.ts', 'src/client/hero/locale.ts']) assert.doesNotMatch(src(file), /LayerFS Home/, file)
})

test('8: the Move dialog\'s notice names the move', () => {
  assert.doesNotMatch(M.storageLocales.en.heldNow, /push/)
})

test('10: a session tag reads without DSH\'s session- prefix', () => {
  const t = tOf(M.logsLocales.en)
  assert.equal(M.tagWords('dsh:session-ef98a1b2c3d4e5f6:', t), 'session ef98a1b2c3d4')
  assert.equal(M.tagWords('dsh:abc:', t), 'session abc')
  assert.equal(M.tagWords('other', t), 'other')
})

test('11: the history legend counts are singular for one', () => {
  const t = tOf(M.filesEn)
  assert.equal(M.treeCounts(1, 1, 1, t), '1 Branch · 1 checkpoint · 1 Layer')
  assert.equal(M.treeCounts(20, 552, 3, t), '20 Branches · 552 checkpoints · 3 Layers')
  for (const k of ['files_treeBranches', 'files_treeBranchOne', 'files_treeCheckpoints', 'files_treeCheckpointOne', 'files_treeLayers', 'files_treeLayerOne']) assert.ok(M.filesZh[k], k)
})

test('15: the unused RuntimeCard is gone', () => {
  assert.equal(existsSync(join(root, 'src/client/machines/Runtime.tsx')), false)
})
