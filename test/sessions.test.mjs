// One session mode: where a session works (placeOf), the Scratch project made
// on first use, the pre-step guarantee (ensureBound) and the LayerFS session
// persistence row's import on a local miss, over fakes.
//   node --test test/sessions.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = new URL('..', import.meta.url).pathname
// Inside the checkout, so the external DSH packages resolve from node_modules.
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-sessions-'))
await build({
  absWorkingDir: root,
  stdin: {
    contents: "export * from './src/host/sessions/service.ts'\nexport * as persistence from './src/host/session-persistence.ts'\nexport { initialState } from './src/host/sessions/state.ts'\n",
    resolveDir: root,
    loader: 'ts',
  },
  outfile: join(out, 'sessions.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  external: ['@deepseek-ai/*'],
  logLevel: 'warning',
})
const S = await import(pathToFileURL(join(out, 'sessions.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

class Refusal extends Error {
  constructor(code, message = code) { super(message); this.code = code }
}

/** A LayerfsSessions over an in-memory state and a fake lfs, without cordis. */
function sessions({ state = S.initialState(), lfs = {}, layerfsRoot = '/lfs-root' } = {}) {
  const s = Object.create(S.LayerfsSessions.prototype)
  const events = []
  const ctx = {
    layerfs: { root: layerfsRoot, scratchProject: 'dsh-scratch/scratch', lfs, emit: (type, data) => events.push({ type, data }), ensureNative: async () => {} },
    logger: () => ({ warn() {}, info() {} }),
  }
  let value = state
  Object.defineProperty(s, 'ctx', { value: ctx })
  Object.defineProperty(s, 'state', { value: { read: () => value, update(fn) { const d = structuredClone(value); value = fn(d) ?? d; return value } } })
  Object.defineProperty(s, 'lanes', { value: new Map() })
  return { s, events, state: () => value }
}

const session = (id, header, events = []) => ({ id, header: { id, ...header }, snapshotEvents: () => events })
const ran = [{ type: 'turn/start', data: { turn: 1 } }]

test('placeOf: project anchors, Scratch for new sessions elsewhere, legacy for sessions that already ran', () => {
  const { s } = sessions()
  assert.deepEqual(s.placeOf(session('a', { cwd: '/lfs-root/projects/st/app' })),
    { kind: 'project', project: 'st/app', anchor: '/lfs-root/projects/st/app' })
  assert.deepEqual(s.placeOf(session('b', { cwd: '/lfs-root/scratch' })), { kind: 'project', project: 'dsh-scratch/scratch', anchor: '/lfs-root/scratch' })
  assert.deepEqual(s.placeOf(session('c', { cwd: '/Users/me/Documents/default-workspace' })), { kind: 'project', project: 'dsh-scratch/scratch', anchor: '/lfs-root/scratch' })
  assert.deepEqual(s.placeOf(session('d', { cwd: '/Users/me/repo' }, ran)), { kind: 'legacy', cwd: '/Users/me/repo' })
  // A project anchor wins even when the session already ran (resumed after a restart).
  assert.equal(s.placeOf(session('e', { cwd: '/lfs-root/projects/st/app' }, ran)).kind, 'project')
})

test('placeOf: bindings, subagents and forks follow what they come from', () => {
  const state = S.initialState()
  state.sessions.p = { sessionId: 'p', kind: 'project', project: 'st/app', anchor: '/lfs-root/projects/st/app', scratch: '/x', state: 'bound' }
  state.sessions.old = { sessionId: 'old', kind: 'scratch', anchor: '/lfs-root/scratch', scratch: '/y', state: 'bound' }
  const { s } = sessions({ state })
  assert.deepEqual(s.placeOf(session('p', { cwd: '/elsewhere' }, ran)), { kind: 'project', project: 'st/app', anchor: '/lfs-root/projects/st/app' })
  // A binding from before one mode (a scratch folder only) becomes a Scratch project session.
  assert.deepEqual(s.placeOf(session('old', { cwd: '/lfs-root/scratch' }, ran)), { kind: 'project', project: 'dsh-scratch/scratch', anchor: '/lfs-root/scratch' })
  assert.deepEqual(s.placeOf(session('sub', { cwd: '/lfs-root/projects/st/app', origin: 'subagent', parentSession: 'p' })),
    { kind: 'shared', parent: 'p', anchor: '/lfs-root/projects/st/app' })
  // DSH's Fork of a session started in the default workspace copies turns but follows the parent.
  assert.deepEqual(s.placeOf(session('fork', { cwd: '/Users/me/Documents/default-workspace', parentSession: 'p' }, ran)),
    { kind: 'project', project: 'st/app', anchor: '/lfs-root/projects/st/app' })
})

test('ensureBound refuses a legacy host-folder session before the step runs', async () => {
  const { s } = sessions()
  const agent = { id: 'leg', session: session('leg', { cwd: '/Users/me/repo' }, ran) }
  await assert.rejects(s.ensureBound(agent), (e) => e.code === 'LegacyFolderSession' && /\/Users\/me\/repo/.test(e.message))
})

test('ensureBound fails the step when the Workspace cannot be bound', async () => {
  const lfs = { project: { get: async () => ({ kind: 'sqlite', machine: 'lima1' }) } }
  const { s, state } = sessions({ lfs, layerfsRoot: mkdtempSync(join(tmpdir(), 'dsh-root-')) })
  const anchor = join(s.ctx.layerfs.root, 'projects', 'st', 'app')
  const agent = { id: 'n1', session: { ...session('n1', { cwd: anchor }), seq: 0, append() {} } }
  await assert.rejects(s.ensureBound(agent), (e) => e.code === 'Unsupported' && /lima1/.test(e.message))
  assert.equal(state().sessions.n1.state, 'failed', 'the refusal is recorded for the panel')
  rmSync(s.ctx.layerfs.root, { recursive: true, force: true })
})

test('ensureScratchProject makes the Store and project once, tolerating Exists', async () => {
  const calls = []
  let made = false
  const lfs = {
    project: {
      get: async (key) => { calls.push(`get ${key}`); if (!made) throw new Refusal('NoSuchStore'); return { key } },
      init: async (key, folder) => { calls.push(`init ${key}`); assert.ok(folder.includes('scratch-')); made = true; return {} },
    },
    store: { create: async (name) => { calls.push(`create ${name}`); throw new Refusal('Exists') } },
  }
  const { s } = sessions({ lfs, layerfsRoot: mkdtempSync(join(tmpdir(), 'dsh-root-')) })
  await Promise.all([s.ensureScratchProject(), s.ensureScratchProject()])
  await s.ensureScratchProject()
  assert.deepEqual(calls, ['get dsh-scratch/scratch', 'create dsh-scratch', 'init dsh-scratch/scratch'])
  rmSync(s.ctx.layerfs.root, { recursive: true, force: true })
})

test('ensureScratchProject retries after a failure', async () => {
  let attempts = 0
  const lfs = {
    project: { get: async () => { attempts++; if (attempts === 1) throw new Refusal('Unknown'); return {} } },
    store: { create: async () => {} },
  }
  const { s } = sessions({ lfs })
  await assert.rejects(s.ensureScratchProject(), (e) => e.code === 'Unknown')
  await s.ensureScratchProject()
  assert.equal(attempts, 2)
})

test('session persistence row: a local miss is imported from LayerFS, then answered', async () => {
  const { SessionPersistenceNotFoundError } = await import('@deepseek-ai/dsh-session-persistence')
  const stored = new Set(['local-1'])
  const local = {
    stat: async (id) => (stored.has(id) ? { header: { id } } : undefined),
    open: async (id) => { if (!stored.has(id)) throw new SessionPersistenceNotFoundError(id); return { id } },
  }
  const imports = []
  const store = {
    locate: async (id) => (id.startsWith('remote') ? 'st/app' : undefined),
    import: async (project, id) => { imports.push(`${project} ${id}`); stored.add(id); return { imported: true } },
  }
  // The row's service without cordis: its methods over `local` and the sessions area's store.
  const w = Object.create(S.persistence.LayerfsSessionPersistence.prototype)
  Object.defineProperty(w, 'local', { value: local })
  Object.defineProperty(w, 'ctx', { value: { get: (name) => (name === 'layerfsSessions' ? { store } : undefined), logger: () => ({ warn() {} }) } })
  assert.deepEqual(await w.stat('local-1'), { header: { id: 'local-1' } })
  assert.deepEqual(await w.open('remote-2', 'read'), { id: 'remote-2' })
  assert.deepEqual(await w.stat('remote-3'), { header: { id: 'remote-3' } })
  assert.equal(await w.stat('nowhere'), undefined)
  await assert.rejects(w.open('nowhere', 'read'), SessionPersistenceNotFoundError)
  assert.deepEqual(imports, ['st/app remote-2', 'st/app remote-3'])
})

test('session persistence row: before the sessions area is up, every call is the stock one', async () => {
  const local = { stat: async () => undefined, open: async () => { throw new Error('stock') } }
  const w = Object.create(S.persistence.LayerfsSessionPersistence.prototype)
  Object.defineProperty(w, 'local', { value: local })
  Object.defineProperty(w, 'ctx', { value: { get: () => undefined, logger: () => ({ warn() {} }) } })
  assert.equal(await w.stat('x'), undefined)
  await assert.rejects(w.open('x', 'read'), /stock/)
})
