// The sidebar session readiness rule (src/client/projects/session-readiness.ts):
// the project cannot run, the session is stored elsewhere, interrupted, starting,
// active, not started, or a state with no word. Words and reasons resolve in both
// locales.
//   node --test test/session-readiness.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
const out = mkdtempSync(join(root, 'lib', '.test-session-readiness-'))
await build({
  absWorkingDir: root,
  stdin: {
    contents: [
      "export { sessionReadiness } from './src/client/projects/session-readiness.ts'",
      "export { locales as listLocales } from './src/client/projects/list-locale.ts'",
    ].join('\n'),
    resolveDir: root, loader: 'ts',
  },
  outfile: join(out, 'readiness.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24', logLevel: 'error',
})
const { sessionReadiness, listLocales } = await import(pathToFileURL(join(out, 'readiness.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

const fill = (text, vars = {}) => text.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`))
const tOf = (lang) => (key, vars) => fill(listLocales[lang][key] ?? key, vars)
const en = tOf('en'), zh = tOf('zh')
const canRun = (over = {}) => ({ state: 'available', machine: 'docker', canStart: false, canRun: true, storageBlocked: false, ...over })
const session = (over = {}) => ({ sessionId: 's-1', title: 'Chat', local: true, updatedAt: 1, state: 'local', ...over })
const pgStore = (over = {}) => ({ name: 'pg', kind: 'postgresql', state: 'broken', reason: 'missing', postgresql: { passwordSaved: false }, attached: [], ...over })

test('a project that cannot run is unavailable and says why, in words only', () => {
  const r = sessionReadiness(session({ executionState: 'inactive' }), { state: 'stopped', machine: 'docker', canStart: true, canRun: false, storageBlocked: false }, 'demo', en)
  assert.equal(r.key, 'unavailable')
  assert.equal(r.word, 'Unavailable')
  assert.match(r.reason, /Machine stopped/, 'the existing status wording says why')
  assert.ok(!('action' in r), 'no row action: the project row carries Start <machine>')
})

test('a Store failure says its own words, with no Open Store action on the row', () => {
  const r = sessionReadiness(session(), { state: 'available', machine: 'docker', canStart: false, canRun: false, storageBlocked: true }, 'pg', en, pgStore())
  assert.equal(r.key, 'unavailable')
  assert.equal(r.word, 'Unavailable')
  assert.match(r.reason, /has no saved password/)
  assert.ok(!('action' in r), 'the project row carries the Store link')
})

test('unavailable wins over the host state, but checking is not an answer yet', () => {
  const stored = session({ state: 'stored', local: false })
  assert.equal(sessionReadiness(stored, canRun({ canRun: false, state: 'stopped', machine: 'docker', canStart: true }), 'demo', en).key, 'unavailable')
  // while the machine list is being read the session state still shows
  assert.deepEqual(sessionReadiness(stored, canRun({ canRun: false, state: 'checking', machine: null }), 'demo', en), {
    key: 'stored', word: 'Stored elsewhere', reason: en('storedWhy'),
  })
})

test('a session only in LayerFS is stored elsewhere (opening the row imports it)', () => {
  const r = sessionReadiness(session({ state: 'stored', local: false }), canRun(), 'demo', en)
  assert.equal(r.key, 'stored')
  assert.equal(r.word, 'Stored elsewhere')
  assert.match(r.reason, /only in LayerFS/)
  assert.ok(!('action' in r))
  // a stored row this DSH also holds locally is not "elsewhere"
  assert.deepEqual(sessionReadiness(session({ state: 'stored', local: true, executionState: 'inactive' }), canRun(), 'demo', en), {
    key: 'notStarted', word: 'Not started',
  })
})

test('an interrupted execution says why', () => {
  const r = sessionReadiness(session({ state: 'bound', executionState: 'interrupted', error: 'the sandbox was lost' }), canRun(), 'demo', en)
  assert.equal(r.key, 'interrupted')
  assert.equal(r.word, 'Interrupted')
  assert.equal(r.reason, en('interruptedHint'), 'an unclassified error falls back to the hint')
  assert.ok(!('action' in r))
  const fail = sessionReadiness(session({ executionState: 'interrupted', failure: { code: 'store_unresolved', store: 'demo' } }), canRun(), 'demo', en)
  assert.match(fail.reason, /cannot verify Store demo/)
})

test('starting, active and not started are one word each, with no reason and no action', () => {
  assert.deepEqual(sessionReadiness(session({ executionState: 'activating' }), canRun(), 'demo', en), { key: 'starting', word: 'Starting' })
  // A session being bound is starting, not "not started", even while its placement is still pending.
  assert.deepEqual(sessionReadiness(session({ state: 'pending', executionState: 'activating' }), canRun(), 'demo', en), { key: 'starting', word: 'Starting' })
  assert.deepEqual(sessionReadiness(session({ state: 'closed', executionState: 'activating' }), canRun(), 'demo', en), { key: 'starting', word: 'Starting' })
  assert.deepEqual(sessionReadiness(session({ executionState: 'active' }), canRun(), 'demo', en), { key: 'active', word: 'Active' })
  for (const s of [
    session({ state: 'pending' }),
    session({ executionState: 'inactive' }),
    session({ executionState: undefined }),
    session({ state: 'closed', executionState: undefined }),
  ]) assert.deepEqual(sessionReadiness(s, canRun(), 'demo', en), { key: 'notStarted', word: 'Not started' })
})

test('a host state with no word stays hidden', () => {
  assert.deepEqual(sessionReadiness(session({ state: 'local', executionState: 'sleeping' }), canRun(), 'demo', en), { key: 'unknown' })
})

test('every word and reason resolves in en and zh', () => {
  const start = sessionReadiness(session(), { state: 'stopped', machine: 'docker', canStart: true, canRun: false, storageBlocked: false }, 'demo', zh)
  assert.equal(start.word, '不可用')
  assert.match(start.reason, /机器已停止/)
  const stored = sessionReadiness(session({ state: 'stored', local: false }), canRun(), 'demo', zh)
  assert.equal(stored.word, '存储在其他位置')
  assert.equal(stored.reason, listLocales.zh.storedWhy)
  assert.equal(sessionReadiness(session({ executionState: 'activating' }), canRun(), 'demo', zh).word, '正在启动')
  assert.equal(sessionReadiness(session({ state: 'pending', executionState: 'activating' }), canRun(), 'demo', zh).word, '正在启动')
  assert.equal(sessionReadiness(session({ executionState: 'active' }), canRun(), 'demo', zh).word, '活动中')
  assert.equal(sessionReadiness(session({ executionState: 'inactive' }), canRun(), 'demo', zh).word, '未开始')
  for (const k of ['active', 'sessionStarting', 'notStarted', 'storedElsewhere', 'storedWhy', 'unavailableWhy']) {
    assert.ok(listLocales.en[k], `en.${k}`)
    assert.ok(listLocales.zh[k], `zh.${k}`)
  }
  assert.deepEqual(Object.keys(listLocales.zh).sort(), Object.keys(listLocales.en).sort())
})
