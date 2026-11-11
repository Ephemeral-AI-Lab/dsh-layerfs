// Two session modes: where a session works (placeOf: a project anchor binds,
// anywhere else is a plain folder session), the Scratch project made on first
// use, the pre-step guarantee (ensureBound) and the LayerFS session
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
    sessions: { get: () => undefined },
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

test('placeOf: project anchors bind, everywhere else is a plain folder session', () => {
  const { s } = sessions()
  assert.deepEqual(s.placeOf(session('a', { cwd: '/lfs-root/projects/st/app' })),
    { kind: 'project', project: 'st/app', anchor: '/lfs-root/projects/st/app' })
  assert.deepEqual(s.placeOf(session('b', { cwd: '/lfs-root/scratch' })), { kind: 'folder', cwd: '/lfs-root/scratch' })
  assert.deepEqual(s.placeOf(session('c', { cwd: '/Users/me/Documents/default-workspace' })), { kind: 'folder', cwd: '/Users/me/Documents/default-workspace' })
  assert.deepEqual(s.placeOf(session('d', { cwd: '/Users/me/repo' }, ran)), { kind: 'folder', cwd: '/Users/me/repo' })
  // A project anchor wins even when the session already ran (resumed after a restart).
  assert.equal(s.placeOf(session('e', { cwd: '/lfs-root/projects/st/app' }, ran)).kind, 'project')
})

test('placeOf: bindings, subagents and forks follow what they come from', () => {
  const state = S.initialState()
  state.sessions.p = { sessionId: 'p', kind: 'project', project: 'st/app', anchor: '/lfs-root/projects/st/app', scratch: '/x', state: 'bound' }
  state.sessions.old = { sessionId: 'old', kind: 'project', project: 'dsh-scratch/scratch', anchor: '/lfs-root/scratch', scratch: '/y', state: 'bound' }
  const { s } = sessions({ state })
  assert.deepEqual(s.placeOf(session('p', { cwd: '/elsewhere' }, ran)), { kind: 'project', project: 'st/app', anchor: '/lfs-root/projects/st/app' })
  // A binding from the one-mode era (the Scratch project) still binds to it.
  assert.deepEqual(s.placeOf(session('old', { cwd: '/lfs-root/scratch' }, ran)), { kind: 'project', project: 'dsh-scratch/scratch', anchor: '/lfs-root/scratch' })
  assert.deepEqual(s.placeOf(session('sub', { cwd: '/lfs-root/projects/st/app', origin: 'subagent', parentSession: 'p' })),
    { kind: 'shared', parent: 'p', anchor: '/lfs-root/projects/st/app' })
  // A subagent of a folder session (no parent binding) is a folder session too.
  assert.deepEqual(s.placeOf(session('sub2', { cwd: '/Users/me/repo', origin: 'subagent', parentSession: 'nobody' }, ran)),
    { kind: 'folder', cwd: '/Users/me/repo' })
  // DSH's Fork of a session started in the default workspace copies turns but follows the parent.
  assert.deepEqual(s.placeOf(session('fork', { cwd: '/Users/me/Documents/default-workspace', parentSession: 'p' }, ran)),
    { kind: 'project', project: 'st/app', anchor: '/lfs-root/projects/st/app' })
})

test('choose: a session placed in a project binds there; cleared placement is a folder session', async () => {
  const lfs = { project: { get: async (key) => { if (key === 'gone/x') throw new Refusal('NoSuchProject'); return { key } } } }
  const { s, state } = sessions({ lfs, layerfsRoot: mkdtempSync(join(tmpdir(), 'dsh-root-')) })
  const root = s.ctx.layerfs.root
  const sess = session('n', { cwd: '/Users/me/repo' })
  await s.choose('n', 'st/app')
  assert.deepEqual(state().pending.n, { project: 'st/app' })
  // The same session in the same folder now works in the project — no workspace change.
  assert.deepEqual(s.placeOf(sess), { kind: 'project', project: 'st/app', anchor: `${root}/projects/st/app` })
  assert.deepEqual(s.placeOfId('n'), { project: 'st/app' })
  // An unknown project never reaches the pending record.
  await assert.rejects(s.choose('n', 'gone/x'), (e) => e.code === 'NoSuchProject')
  assert.equal(state().pending.n?.project, 'st/app')
  await s.choose('n', null)
  assert.equal(state().pending.n, undefined)
  assert.deepEqual(s.placeOf(sess), { kind: 'folder', cwd: '/Users/me/repo' })
  // A recorded binding outranks the pending choice.
  state().sessions.n = { sessionId: 'n', kind: 'project', project: 'st/other', anchor: `${root}/projects/st/other`, scratch: '/x', state: 'bound' }
  await s.choose('n', 'st/app')
  assert.equal(s.placeOf(sess).project, 'st/other')
  rmSync(root, { recursive: true, force: true })
})

test('ensureBound lets a folder session run untouched (stock DSH)', async () => {
  const { s, state } = sessions()
  const agent = { id: 'leg', session: session('leg', { cwd: '/Users/me/repo' }, ran) }
  await s.ensureBound(agent)
  assert.equal(state().sessions.leg, undefined, 'a folder session records no binding')
})

test('ensureBound binds a remote project: Sandbox on its machine, working directory the scratch folder', async () => {
  const calls = []
  const lfs = {
    project: { get: async () => ({ kind: 'sqlite', machine: 'lima1' }) },
    branch: { fork: async (project, branch, from) => calls.push(`fork ${project} ${branch} ${from}`) },
    sandbox: {
      get: async () => { throw new Refusal('NoSuchSandbox') },
      create: async (project, name, machine) => calls.push(`sandbox ${project} ${name} ${machine}`),
    },
    workspace: {
      mount: async (sandbox, branch, options) => { calls.push(`mount ${sandbox} ${branch} ${options.name}`); return { path: '/mnt/inside-the-guest', ws: `${sandbox}:${options.name}`, base: 'base-1' } },
    },
  }
  const { s, state } = sessions({ lfs, layerfsRoot: mkdtempSync(join(tmpdir(), 'dsh-root-')) })
  const selected = []
  s.ctx.get = (name) => (name === 'agentPresets' ? { select: async (_a, id) => { selected.push(id); return id } } : undefined)
  s.ctx.workingDirectory = { get: () => '/elsewhere', set: async () => { throw new Error('fresh sessions append instead') } }
  const anchor = join(s.ctx.layerfs.root, 'projects', 'st', 'app')
  const appended = []
  const agent = { id: 'n1', session: { ...session('n1', { cwd: anchor }), seq: 0, append: (type, data) => appended.push([type, data]) } }
  await s.ensureBound(agent)
  const b = state().sessions.n1
  assert.equal(b.state, 'bound')
  assert.equal(b.machine, 'lima1')
  assert.equal(b.mount, undefined, 'a remote Workspace mounts inside its Sandbox, not on this host')
  assert.equal(b.ws, 'dsh-n1:main', 'the Workspace handle stays usable for exec/status/commit')
  assert.ok(b.scratch.startsWith(anchor))
  assert.deepEqual(calls, ['fork st/app dsh.n1 main', 'sandbox st/app dsh-n1 lima1', 'mount dsh-n1 dsh.n1 main'])
  assert.deepEqual(appended.find(([type]) => type === 'working-directory/change')?.[1], { cwd: b.scratch })
  assert.deepEqual(selected, ['layerfs'], 'the session is recomposed under the layerfs preset')
  rmSync(s.ctx.layerfs.root, { recursive: true, force: true })
})

test('ensureBound keeps a native project on its host mount', async () => {
  const calls = []
  const lfs = {
    project: { get: async () => ({ kind: 'sqlite', machine: 'native' }) },
    branch: { fork: async () => calls.push('fork') },
    sandbox: {
      get: async () => { throw new Refusal('NoSuchSandbox') },
      create: async (_p, _n, machine) => calls.push(`sandbox ${machine}`),
    },
    workspace: { mount: async (sandbox, _b, options) => { calls.push(`mount ${sandbox}`); return { path: `${s_root}/host-mount`, ws: `${sandbox}:${options.name}` } } },
  }
  const { s, state } = sessions({ lfs, layerfsRoot: mkdtempSync(join(tmpdir(), 'dsh-root-')) })
  const s_root = s.ctx.layerfs.root
  s.ctx.workingDirectory = { get: () => '/elsewhere', set: async () => {} }
  const anchor = join(s_root, 'projects', 'st', 'app')
  const appended = []
  const agent = { id: 'n2', session: { ...session('n2', { cwd: anchor }), seq: 0, append: (type, data) => appended.push([type, data]) } }
  await s.ensureBound(agent)
  const b = state().sessions.n2
  assert.equal(b.state, 'bound')
  assert.equal(b.mount, `${s_root}/host-mount`)
  assert.deepEqual(calls, ['fork', 'sandbox native', 'mount dsh-n2'])
  assert.deepEqual(appended.find(([type]) => type === 'working-directory/change')?.[1], { cwd: `${s_root}/host-mount` })
  rmSync(s_root, { recursive: true, force: true })
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
