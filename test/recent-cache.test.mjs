// `projects.recent` reads every owned session's log and sidecar on every call
// (248 ms cold, 40–61 ms warm on the real DSH). The memo keeps one session's
// facts while the values the row reads hold: the log's stat identity, the
// sidecar's file identity and the binding's activity. A save (a new
// `updatedAt`), a receipt (a rewritten sidecar), a create, a delete, a migrate
// or a foreign append is a miss on the very next call; an unchanged session is
// a hit that skips the sidecar read.
//   node --test test/recent-cache.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-recent-cache-'))
await build({
  absWorkingDir: root,
  stdin: {
    contents: [
      "export * from './src/host/sessions/service.ts'",
      "export { initialState } from './src/host/sessions/state.ts'",
      "export { apply as applySessionsIndex } from './src/host/sessions/index.ts'",
    ].join('\n'),
    resolveDir: root, loader: 'ts',
  },
  outfile: join(out, 'recent.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24',
  external: ['@deepseek-ai/*'], logLevel: 'warning',
})
const S = await import(pathToFileURL(join(out, 'recent.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

const scratch = mkdtempSync(join(tmpdir(), 'dsh-recent-cache-'))
test.after(() => rmSync(scratch, { recursive: true, force: true }))

let seq = 0
/** A session log + its sidecar on disk, so the sidecar's identity is real. */
function sessionOnDisk(id, { createdAt = 100, project = 'st/app', projectId = 'pid-app', revision = '1:1:1', bindingKind = 'project', sidecar = true } = {}) {
  const dir = join(scratch, `${++seq}-${id}`)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'session.v4.jsonl')
  writeFileSync(path, `${JSON.stringify({ version: 4, id, createdAt })}\n`)
  // the binding sits in layerfs/ beside the log (docs/specs/layerfs-folder.md §2)
  if (sidecar) { mkdirSync(join(dir, 'layerfs'), { recursive: true }); writeFileSync(join(dir, 'layerfs', 'binding.json'), JSON.stringify({ version: 1, sessionId: id, project, bindingKind })) }
  return { id, createdAt, project, projectId, revision, path, dir, bindingKind }
}

/** The host's recent-project reads over the fact sessions, counting what they ask of the row. */
function harness(state, records) {
  const calls = { stat: 0, sidecar: 0, snapshot: 0 }
  const sessions = new Map(records.map((r) => [r.id, r]))
  const persistence = {
    ownerOf: (id) => sessions.get(id) ? { project: sessions.get(id).project } : undefined,
    projectIdOf: (id) => sessions.get(id)?.projectId,
    ownedSessionIds: () => [...sessions.keys()],
    async stat(id) {
      calls.stat++
      const record = sessions.get(id)
      if (!record || record.missing) return undefined
      return {
        header: { id, createdAt: record.createdAt, origin: record.origin },
        revision: record.revision, sizeBytes: 64,
        location: { kind: 'jsonl', path: record.path },
      }
    },
    async readSidecar(id, options) {
      calls.sidecar++
      if (options?.snapshot) calls.snapshot++
      return { version: 1, sessionId: id, bindingKind: sessions.get(id)?.bindingKind ?? 'project' }
    },
  }
  const s = Object.create(S.LayerfsSessions.prototype)
  Object.defineProperty(s, 'ctx', { value: {
    layerfs: { state: '/lfs-root', lfs: {}, emit() {}, ensureHostDaemon: async () => {} },
    sessions: { get: () => undefined },
    logger: () => ({ warn() {}, info() {} }),
  } })
  Object.defineProperty(s, 'state', { value: { read: () => state } })
  Object.defineProperty(s, 'lanes', { value: new Map() })
  Object.defineProperty(s, 'storeHealth', { value: new Map() })
  Object.defineProperty(s, 'serverChecked', { value: new Map() })
  const ops = {}
  const ctx = {
    layerfs: { state: '/lfs-root', lfs: {}, emit() {}, outputs: '/lfs-root/trace/outputs' },
    layerfsSessions: s,
    layerfsRemote: { operate: (_ctx, table) => Object.assign(ops, table) },
    plugin() {},
    inject: (deps, callback) => { if (deps.includes('layerfsSessions')) callback(ctx) },
    on() {}, effect() {},
    get: (name) => name === 'sessionPersistence' ? persistence : undefined,
    logger: () => ({ warn() {}, info() {} }),
    workspaceRegistry: { archivedSessionIds: [] },
  }
  S.applySessionsIndex(ctx)
  const recent = (args = {}) => ops['projects.recent'](args)
  return { recent, calls, persistence, sessions }
}

const rowOf = (answer, id) => answer.projects.find((p) => (p.projectId ?? p.project) === id)
const ids = (answer) => answer.projects.flatMap((p) => p.sessionIds).sort()

test('an unchanged list is a sidecar hit, and the read still stats every owned log', async () => {
  const state = S.initialState()
  const a = sessionOnDisk('a')
  const b = sessionOnDisk('b', { createdAt: 200, project: 'st/other', projectId: 'pid-other' })
  const h = harness(state, [a, b])
  const first = await h.recent()
  assert.deepEqual(ids(first), ['a', 'b'])
  assert.equal(h.calls.stat, 2, 'the first read stats both logs')
  assert.equal(h.calls.sidecar, 2, 'and reads both sidecars')
  assert.equal(h.calls.snapshot, 2, 'the stat it just read is handed to the sidecar read')
  const second = await h.recent()
  assert.deepEqual(second, first, 'the memo answers the same rows')
  assert.equal(h.calls.stat, 4, 'a hit still stats every log (freshness first)')
  assert.equal(h.calls.sidecar, 2, 'a hit does not read an unchanged sidecar')
})

test('a save shows its new lastActivity on the very next call, with no wait', async () => {
  const state = S.initialState()
  state.sessions.bound = { sessionId: 'bound', kind: 'project', project: 'st/app', anchor: '/a', scratch: '/scratch', state: 'bound', createdAt: 10, updatedAt: 100 }
  const h = harness(state, [])
  assert.equal(rowOf(await h.recent(), 'st/app').lastActivity, 100)
  state.sessions.bound.updatedAt = 250
  assert.deepEqual(rowOf(await h.recent(), 'st/app').sessionIds, ['bound'])
  assert.equal(rowOf(await h.recent(), 'st/app').lastActivity, 250, 'the write is visible on the very next read')
})

test('a receipt (a rewritten sidecar) re-reads that session; a foreign append (a new revision) does too', async () => {
  const state = S.initialState()
  const a = sessionOnDisk('a')
  const b = sessionOnDisk('b', { project: 'st/other', projectId: 'pid-other' })
  const h = harness(state, [a, b])
  await h.recent()
  assert.equal(h.calls.sidecar, 2)
  // A receipt rewrites the sidecar: its file identity changes, the log's does not.
  writeFileSync(join(a.dir, 'layerfs', 'binding.json'), JSON.stringify({ version: 1, sessionId: 'a', project: 'st/app', bindingKind: 'project', invocations: [{ id: 'one' }] }))
  await h.recent()
  assert.equal(h.calls.sidecar, 3, 'the rewritten sidecar is read again')
  assert.equal(h.calls.snapshot, 3)
  // Another process appends to a log: its revision moves while nothing else does.
  b.revision = '1:2:999'
  await h.recent()
  assert.equal(h.calls.sidecar, 4, 'a foreign log change is not served from the memo')
})

test('a create adds a row; a delete removes it and its memo', async () => {
  const state = S.initialState()
  const a = sessionOnDisk('a')
  const h = harness(state, [a])
  assert.deepEqual(ids(await h.recent()), ['a'])
  const b = sessionOnDisk('b', { createdAt: 300, project: 'st/other', projectId: 'pid-other' })
  h.sessions.set('b', b)
  const created = await h.recent()
  assert.deepEqual(ids(created), ['a', 'b'], 'a new session is listed on the next read')
  assert.equal(h.calls.sidecar, 2)
  b.missing = true
  const deleted = await h.recent()
  assert.deepEqual(ids(deleted), ['a'], 'a removed log is not listed')
  const reads = h.calls.sidecar
  b.missing = false
  b.revision = '2:2:2'
  await h.recent()
  assert.equal(h.calls.sidecar, reads + 1, 'a session that comes back is read again, not served from the dropped fact')
})

test('a shared subagent sidecar is not a project row, and an absent sidecar is never memoized', async () => {
  const state = S.initialState()
  const shared = sessionOnDisk('shared', { bindingKind: 'shared' })
  const bare = sessionOnDisk('bare', { project: 'st/other', projectId: 'pid-other', sidecar: false })
  const h = harness(state, [shared, bare])
  const first = await h.recent()
  assert.deepEqual(ids(first), ['bare'])
  assert.equal(h.calls.sidecar, 2)
  await h.recent()
  // Both are misses: the shared row is filtered every time, and no sidecar
  // identity means no fact to trust (a later rewrite must show at once).
  assert.equal(h.calls.sidecar, 4)
})

test('a project identity change re-keys the row instead of reusing the old one', async () => {
  const state = S.initialState()
  const a = sessionOnDisk('a')
  const h = harness(state, [a])
  assert.equal(rowOf(await h.recent(), 'pid-app').lastActivity, 100)
  a.projectId = 'pid-renamed'
  const after = await h.recent()
  assert.ok(rowOf(after, 'pid-renamed'), 'the row follows the new identity')
  assert.equal(rowOf(after, 'pid-app'), undefined)
  assert.equal(h.calls.sidecar, 2, 'the identity is part of the fact key')
})

test('the memo is short-lived: an old fact is read again', async () => {
  const state = S.initialState()
  const a = sessionOnDisk('a')
  const h = harness(state, [a])
  await h.recent()
  assert.equal(h.calls.sidecar, 1)
  const now = Date.now
  let clock = now()
  Date.now = () => clock
  try {
    clock += 60 * 60 * 1000
    await h.recent()
    assert.equal(h.calls.sidecar, 2, 'a fact older than the window is not trusted')
    await h.recent()
    assert.equal(h.calls.sidecar, 2, 'and the fresh fact is reused')
  } finally { Date.now = now }
})
