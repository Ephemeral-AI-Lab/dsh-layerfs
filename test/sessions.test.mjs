// Two session modes: where a session works (placeOf: a project anchor binds,
// anywhere else is a plain folder session), the Scratch project made on first
// use, the pre-step guarantee (ensureBound) and the LayerFS session
// persistence row's import on a local miss, over fakes.
//   node --test test/sessions.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

test('placeOf: only recorded legacy project anchors bind; folder paths do not create ownership', () => {
  const state = S.initialState()
  state.projects['st/app'] = { project: 'st/app', anchor: '/lfs-root/projects/st/app', workspaceId: 'legacy-workspace' }
  const { s } = sessions({ state })
  assert.deepEqual(s.placeOf(session('a', { cwd: '/lfs-root/projects/st/app' })),
    { kind: 'project', project: 'st/app', anchor: '/lfs-root/projects/st/app' })
  assert.deepEqual(s.placeOf(session('b', { cwd: '/lfs-root/scratch' })), { kind: 'folder', cwd: '/lfs-root/scratch' })
  assert.deepEqual(s.placeOf(session('c', { cwd: '/Users/me/Documents/default-workspace' })), { kind: 'folder', cwd: '/Users/me/Documents/default-workspace' })
  assert.deepEqual(s.placeOf(session('d', { cwd: '/Users/me/repo' }, ran)), { kind: 'folder', cwd: '/Users/me/repo' })
  // A project anchor wins even when the session already ran (resumed after a restart).
  assert.equal(s.placeOf(session('e', { cwd: '/lfs-root/projects/st/app' }, ran)).kind, 'project')
  assert.deepEqual(s.placeOf(session('unowned', { cwd: '/lfs-root/projects/other/repo' })), { kind: 'folder', cwd: '/lfs-root/projects/other/repo' })
  state.projects['st/new'] = { project: 'st/new', anchor: '/lfs-root/projects/st/new' }
  assert.equal(s.placeOf(session('new-anchor', { cwd: '/lfs-root/projects/st/new' })).kind, 'folder', 'new anchors are not ownership')
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
  await assert.rejects(s.choose('n', 'st/app'), (e) => e.code === 'SessionStarted')
  assert.equal(s.placeOf(sess).project, 'st/other')
  rmSync(root, { recursive: true, force: true })
})

test('ensureBound lets a folder session run untouched (stock DSH)', async () => {
  const { s, state } = sessions()
  const agent = { id: 'leg', session: session('leg', { cwd: '/Users/me/repo' }, ran) }
  await s.ensureBound(agent)
  assert.equal(state().sessions.leg, undefined, 'a folder session records no binding')
})

test('a running Preset blocks project steps but never a normal folder session', async () => {
  const state = S.initialState()
  state.sessions.proj = { sessionId: 'proj', kind: 'project', project: 'st/p', sandbox: 'box', ws: 'box:main', scratch: '/scratch', anchor: '/anchor', state: 'bound' }
  const { s } = sessions({ state })
  s.ctx.layerfs.exclusive = () => 'A Preset build holds the LayerFS home'
  await s.ensureBound({ id: 'normal', session: session('normal', { cwd: '/Users/me/repo' }, ran) })
  await assert.rejects(s.ensureBound({ id: 'proj', session: session('proj', { cwd: '/scratch' }, ran) }), (e) => e.code === 'ConnectBusy')
})

test('a first step waits for an in-flight project choice and runs under the chosen owner', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const { s } = sessions({ lfs: { project: { get: async () => { await gate; return { kind: 'sqlite', machine: 'native' } } } }, layerfsRoot: mkdtempSync(join(tmpdir(), 'dsh-choose-race-')) })
  const blank = session('blank', { cwd: '/Users/me/repo' })
  s.ctx.sessions.get = () => blank
  const choosing = s.choose('blank', 'st/app')
  const order = []
  // The bind itself is stubbed: this test asserts only where the step is placed.
  s.bindAgent = async (agent) => { order.push(['bind', s.placeOf(agent.session).kind]) }
  s.validateExecutionIdentity = async () => {}
  const step = s.ensureBound({ id: 'blank', session: blank }).then(() => order.push(['step']))
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(order, [], 'the step waits while the owner is being chosen')
  release()
  await choosing
  await step
  assert.deepEqual(order, [['bind', 'project'], ['step']], 'the first step binds the chosen project')
})

test('choose refuses changing a normal session owner once its first turn started', async () => {
  const { s, state } = sessions()
  s.ctx.sessions.get = () => session('started', { cwd: '/selected' }, ran)
  await assert.rejects(s.choose('started', 'st/app'), (e) => e.code === 'SessionStarted')
  assert.equal(state().pending.started, undefined)
})

test('durable project ownership survives missing global binding state', () => {
  const { s } = sessions()
  s.ctx.get = (name) => name === 'sessionPersistence' ? { ownerOf: () => ({ project: 'st/app' }) } : undefined
  assert.equal(s.placeOf(session('recovered', { cwd: '/old-local-scratch' }, ran)).project, 'st/app')
  assert.deepEqual(s.placeOfId('recovered'), { project: 'st/app' })
})

test('recovery reuses the persisted project execution context instead of starting from main', async () => {
  const scratch = mkdtempSync(join(root, '.dev-session-recovery-'))
  try {
    const checkpoints = [{ kind: 'turn', turn: 1, commit: 'saved', branch: 'existing-internal', changed: 1 }]
    const { s } = sessions({ layerfsRoot: scratch, lfs: {
      project: { get: async () => ({ kind: 'sqlite', machine: 'native' }) },
      branch: { fork: async () => { throw new Error('recovery must not fork from main') } },
      sandbox: { get: async () => ({ state: 'running', workspaces: [{ name: 'main', branch: 'existing-internal', directory: scratch }] }) },
    } })
    const persistence = {
      ownerOf: () => ({ project: 'st/app' }),
      readSidecar: async () => ({ project: 'st/app', codeBranch: 'existing-internal', checkpoints }),
      migrateProject: async () => {}, updateSidecar: async () => {}, recordInvocation: async () => {},
    }
    s.ctx.get = (name) => name === 'sessionPersistence' ? persistence : undefined
    s.ctx.workingDirectory = { get: () => scratch }
    const agent = { id: 'recovered', session: session('recovered', { cwd: scratch }, [...ran, { type: 'turn/end', data: { turn: 1 } }]) }
    await s.ensureBound(agent)
    assert.equal(s.binding('recovered').branch, 'existing-internal')
    assert.deepEqual(s.checkpoints('recovered'), checkpoints)
    assert.equal(s.binding('recovered').scratch, scratch)
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})

test('closed started session cannot change owner without loading its agent', async () => {
  const { s } = sessions()
  s.ctx.get = (name) => name === 'sessionPersistence' ? {
    ownerOf: () => ({ project: 'st/app' }),
    local: { stat: async () => ({}), open: async () => ({ read: async () => ({ events: ran }), close: async () => {} }) },
  } : undefined
  await assert.rejects(s.choose('closed', 'st/another'), (e) => e.code === 'SessionStarted')
})

test('selectScratch changes the selected local folder without changing ownership', async () => {
  const scratch = mkdtempSync(join(root, '.dev-scratch-selection-'))
  try {
    const state = S.initialState()
    state.pending.a = { project: 'st/app' }
    const { s } = sessions({ state })
    const changes = []
    const agent = { id: 'a', session: { ...session('a', { cwd: '/original' }), append: (type, data) => changes.push({ type, data }) } }
    s.ctx.get = (name) => name === 'agents' ? { get: () => agent } : undefined
    s.ctx.workingDirectory = { get: () => '/original' }
    await s.selectScratch('a', scratch)
    assert.deepEqual(changes, [{ type: 'working-directory/change', data: { cwd: scratch } }])
    assert.equal(s.placeOfId('a').project, 'st/app')
    assert.equal(state.pending.a.project, 'st/app')
    await assert.rejects(s.selectScratch('a', join(scratch, 'missing')), (e) => e.code === 'ScratchUnavailable')
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})

test('forget preserves a selected scratch folder even under the project anchor', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-root-'))
  try {
    const state = S.initialState()
    const scratch = join(root, 'projects', 'st', 'app', 'user-folder')
    mkdirSync(scratch, { recursive: true })
    writeFileSync(join(scratch, 'keep.txt'), 'user data')
    state.sessions.a = { sessionId: 'a', kind: 'project', project: 'st/app', anchor: join(root, 'projects', 'st', 'app'), scratch, state: 'closed' }
    const { s } = sessions({ state, layerfsRoot: root })
    await s.forget('a')
    assert.ok(existsSync(join(scratch, 'keep.txt')))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('project detach removes its normal workspace membership without changing the folder', async () => {
  const { s } = sessions()
  const ids = ['project', 'normal']
  const workspace = { sessionIds: ids, detachSession: async (id) => { ids.splice(ids.indexOf(id), 1) } }
  s.ctx.workspaceRegistry = { list: () => [workspace] }
  await s.detach('project')
  await s.detach('project')
  assert.deepEqual(ids, ['normal'])
})

test('close refuses to discard unsaved files after an uncertain checkpoint', async () => {
  const state = S.initialState()
  state.sessions.a = { sessionId: 'a', kind: 'project', project: 'st/app', state: 'bound', ws: 'sb:main', sandbox: 'sb', branch: 'internal' }
  let closed = false
  const { s } = sessions({ state, lfs: {
    workspace: { status: async () => ({ overlay: { entries: 1 } }), commit: async () => { throw new Refusal('Unknown', 'uncertain save') } },
    sandbox: { close: async () => { closed = true } },
  } })
  await assert.rejects(s.close('a'), (e) => e.code === 'Unknown')
  assert.equal(closed, false)
  assert.equal(s.binding('a').state, 'bound')
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
  s.ctx.workingDirectory = { get: () => s.ctx.layerfs.root, set: async () => { throw new Error('selected scratch must stay unchanged') } }
  const anchor = join(s.ctx.layerfs.root, 'projects', 'st', 'app')
  state().pending.n1 = { project: 'st/app' }
  const appended = []
  const agent = { id: 'n1', session: { ...session('n1', { cwd: anchor }), seq: 0, append: (type, data) => appended.push([type, data]) } }
  await s.ensureBound(agent)
  const b = state().sessions.n1
  assert.equal(b.state, 'bound')
  assert.equal(b.machine, 'lima1')
  assert.equal(b.mount, undefined, 'a remote Workspace mounts inside its Sandbox, not on this host')
  assert.equal(b.ws, 'dsh-n1:main', 'the Workspace handle stays usable for exec/status/commit')
  assert.equal(b.scratch, s.ctx.layerfs.root)
  assert.equal(b.scratchManaged, false)
  assert.deepEqual(calls, ['fork st/app dsh.n1 main', 'sandbox st/app dsh-n1 lima1', 'mount dsh-n1 dsh.n1 main'])
  assert.equal(appended.find(([type]) => type === 'working-directory/change'), undefined)
  assert.deepEqual(selected, ['layerfs'], 'the session is recomposed under the layerfs preset')
  rmSync(s.ctx.layerfs.root, { recursive: true, force: true })
})

test('ensureBound keeps native project local cwd as selected scratch, separate from the mount', async () => {
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
  s.ctx.workingDirectory = { get: () => s_root, set: async () => {} }
  const anchor = join(s_root, 'projects', 'st', 'app')
  state().pending.n2 = { project: 'st/app' }
  const appended = []
  const agent = { id: 'n2', session: { ...session('n2', { cwd: anchor }), seq: 0, append: (type, data) => appended.push([type, data]) } }
  await s.ensureBound(agent)
  const b = state().sessions.n2
  assert.equal(b.state, 'bound')
  assert.equal(b.mount, `${s_root}/host-mount`)
  assert.deepEqual(calls, ['fork', 'sandbox native', 'mount dsh-n2'])
  assert.equal(b.scratch, s_root)
  assert.equal(b.scratchManaged, false)
  assert.equal(appended.find(([type]) => type === 'working-directory/change'), undefined, 'selected local folder stays the working directory')
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

test('force-stopped machines invalidate only their mounts while preserving session history and ownership', () => {
  const state = S.initialState()
  state.sessions.parent = { sessionId: 'parent', kind: 'project', project: 'st/p', machine: 'vm', sandbox: 'box', ws: 'box:main', mount: '/mounted', scratch: '/scratch', anchor: '/anchor', state: 'bound' }
  state.sessions.child = { sessionId: 'child', kind: 'shared', project: 'st/p', parent: 'parent', ws: 'box:main', mount: '/mounted', scratch: '/scratch', anchor: '/anchor', state: 'bound' }
  state.sessions.other = { sessionId: 'other', kind: 'project', project: 'st/q', machine: 'native', sandbox: 'other-box', ws: 'other-box:main', scratch: '/local', anchor: '/anchor', state: 'bound' }
  state.pending.draft = { project: 'st/p' }
  state.checkpoints.parent = [{ commit: 'saved' }]
  state.mirror.parent = { branch: 'archive', count: 10 }
  const f = sessions({ state })
  f.s.machinesStopped(['vm'])
  const after = f.state()
  for (const id of ['parent', 'child']) {
    assert.equal(after.sessions[id].state, 'closed')
    assert.equal(after.sessions[id].ws, undefined)
    assert.equal(after.sessions[id].mount, undefined)
    assert.equal(after.sessions[id].project, 'st/p')
    assert.equal(after.sessions[id].scratch, '/scratch')
  }
  assert.equal(after.sessions.other.state, 'bound')
  assert.deepEqual(after.checkpoints, state.checkpoints)
  assert.deepEqual(after.mirror, state.mirror)
  assert.deepEqual(after.pending, state.pending)
  f.s.sandboxClosed('other-box')
  assert.equal(f.state().sessions.other.state, 'closed')
  assert.equal(f.state().sessions.other.ws, undefined)
  assert.deepEqual(f.state().checkpoints, state.checkpoints)
})

test('a running preset stop blocks new steps even when a session still has cached bound handles', async () => {
  const state = S.initialState()
  state.sessions.live = { sessionId: 'live', kind: 'project', project: 'st/p', machine: 'vm', sandbox: 'box', ws: 'box:main', scratch: '/scratch', anchor: '/anchor', state: 'bound' }
  const f = sessions({ state })
  f.s.ctx.layerfs.exclusive = () => 'Machines are stopping'
  await assert.rejects(f.s.ensureBound({ id: 'live' }), (error) => error.code === 'ConnectBusy')
})

test('a session recreates its force-stopped gone Sandbox on the retained branch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-force-rebind-'))
  const state = S.initialState(), calls = []
  state.sessions.live = { sessionId: 'live', kind: 'project', project: 'st/p', machine: 'vm', sandbox: 'box', branch: 'saved-branch', scratch: root, anchor: root, state: 'closed' }
  const f = sessions({ state, layerfsRoot: root, lfs: {
    sandbox: {
      get: async () => ({ state: 'gone', workspaces: [] }),
      close: async (name) => { calls.push(['close', name]) },
      create: async (...args) => { calls.push(['create', ...args]) },
    },
    workspace: { mount: async (name, branch) => { calls.push(['mount', name, branch]); return { ws: 'box:main', base: 'saved' } } },
  } })
  f.s.ctx.get = () => undefined
  f.s.ctx.workingDirectory = { get: () => root }
  try {
    await f.s.ensureBound({ id: 'live', session: session('live', { cwd: root }) })
    assert.deepEqual(calls, [['close', 'box'], ['create', 'st/p', 'box', 'vm'], ['mount', 'box', 'saved-branch']])
    assert.equal(f.state().sessions.live.state, 'bound')
    assert.equal(f.state().sessions.live.branch, 'saved-branch')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('opening project history hydrates local context without activating execution', async () => {
  const dir = mkdtempSync(join(root, '.dev-lazy-open-'))
  try {
    const { s, state } = sessions({ layerfsRoot: dir })
    const checkpoints = [{ kind: 'turn', turn: 1, commit: 'saved', branch: 'retained', changed: 1 }]
    s.ctx.get = (name) => name === 'sessionPersistence' ? {
      ownerOf: () => ({ project: 'store/app' }), projectIdOf: () => 'permanent-id',
      readSidecar: async () => ({ codeBranch: 'retained', checkpoints }),
    } : undefined
    s.ctx.workingDirectory = { get: () => dir }
    const agent = { id: 'history', session: session('history', { cwd: dir }, ran) }
    await s.bindAgent(agent, 'resume')
    assert.equal(state().sessions.history.executionState, 'inactive')
    assert.equal(state().sessions.history.state, 'closed')
    assert.equal(state().sessions.history.projectId, 'permanent-id')
    assert.deepEqual(state().checkpoints.history, checkpoints)
    assert.equal(state().sessions.history.mount, undefined)
    assert.equal(state().sessions.history.ws, undefined)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a cached active workspace cannot bypass permanent identity validation', async () => {
  const state = S.initialState()
  state.sessions.active = { sessionId: 'active', kind: 'project', project: 'store/app', anchor: '/anchor', scratch: '/scratch', state: 'bound', ws: 'box:main', sandbox: 'box', branch: 'retained' }
  state.checkpoints.active = [{ commit: 'saved' }]
  const f = sessions({ state })
  f.s.ctx.get = (name) => name === 'sessionPersistence' ? { assertSessionIdentity: async () => { throw new Refusal('ProjectIdentityChanged') } } : undefined
  await assert.rejects(f.s.ensureBound({ id: 'active', session: session('active', { cwd: '/scratch' }, ran) }), { code: 'ProjectIdentityChanged' })
  assert.equal(f.state().sessions.active.executionState, 'interrupted')
  assert.equal(f.state().sessions.active.project, 'store/app')
  assert.equal(f.state().checkpoints.active[0].commit, 'saved')
})

test('project removal retains bindings, pending choices, archive progress and checkpoint references', async () => {
  const state = S.initialState()
  state.sessions.history = { sessionId: 'history', kind: 'project', project: 'store/app', anchor: '/anchor', scratch: '/scratch', state: 'closed' }
  state.pending.draft = { project: 'store/app' }
  state.checkpoints.history = [{ commit: 'saved' }]
  state.mirror.history = { count: 5, project: 'store/app', branch: 'archive' }
  state.projects['store/app'] = { project: 'store/app', anchor: '/anchor', createdAt: 1 }
  const f = sessions({ state })
  await f.s.forgetProject('store/app')
  assert.equal(f.state().sessions.history.executionState, 'interrupted')
  assert.equal(f.state().sessions.history.project, 'store/app')
  assert.deepEqual(f.state().pending, state.pending)
  assert.deepEqual(f.state().checkpoints, state.checkpoints)
  assert.deepEqual(f.state().mirror, state.mirror)
  assert.deepEqual(f.state().projects, state.projects)
})

test('polling detects lost access and restored availability without replaying execution', async () => {
  let online = false, mounts = 0
  const state = S.initialState()
  state.sessions.history = { sessionId: 'history', kind: 'project', project: 'store/app', machine: 'vm', anchor: '/anchor', scratch: '/scratch', state: 'bound', ws: 'box:main', branch: 'retained' }
  state.checkpoints.history = [{ commit: 'saved' }]
  const f = sessions({ state, lfs: {
    machine: { get: async () => ({ state: online ? 'running' : 'stopped' }) },
    store: { status: async () => ({ state: online ? 'idle' : 'down' }) },
    workspace: { status: async () => ({}), mount: async () => { mounts++; return {} } },
  } })
  f.s.ctx.get = (name) => name === 'sessionPersistence' ? {
    assertSessionIdentity: async () => ({ key: 'store/app', store: 'store', machine: 'vm' }),
    projectIdOf: () => 'permanent-id', local: { stat: async () => ({ eventCount: 5 }) },
  } : undefined
  const unavailable = await f.s.view('history')
  assert.equal(unavailable.execution.available, false)
  assert.equal(unavailable.execution.state, 'interrupted')
  online = true
  const available = await f.s.view('history')
  assert.equal(available.execution.available, true)
  assert.equal(available.execution.state, 'interrupted')
  assert.equal(mounts, 0, 'status refresh never mounts a workspace')
  assert.equal(available.checkpoints[0].commit, 'saved')
})

test('a missing saved checkpoint blocks activation without falling back to project main', async () => {
  const state = S.initialState()
  state.sessions.history = { sessionId: 'history', kind: 'project', project: 'store/app', machine: 'vm', anchor: '/anchor', scratch: '/scratch', state: 'closed', sandbox: 'box', branch: 'retained' }
  state.checkpoints.history = [{ commit: 'missing-checkpoint', branch: 'retained' }]
  const calls = []
  const f = sessions({ state, lfs: {
    machine: { get: async () => ({ state: 'running' }) }, store: { status: async () => ({ state: 'idle' }) },
    file: { list: async () => { throw new Refusal('NotFound') } },
    branch: { fork: async () => { calls.push('fork') } }, sandbox: { create: async () => { calls.push('sandbox') } },
  } })
  f.s.ctx.get = (name) => name === 'sessionPersistence' ? { assertSessionIdentity: async () => ({ key: 'store/app', store: 'store', machine: 'vm' }) } : undefined
  await assert.rejects(f.s.ensureBound({ id: 'history', session: session('history', { cwd: '/scratch' }, ran) }), { code: 'CheckpointUnavailable' })
  assert.deepEqual(calls, [])
  assert.equal(f.state().checkpoints.history[0].commit, 'missing-checkpoint')
})
