// Two session modes: where a session works (placeOf: a binding, pending choice
// or owner route makes a project session, a folder path never does), the Scratch project made on first
// use, the pre-step guarantee (ensureBound) and the LayerFS session
// persistence row's import on a local miss, over fakes.
//   node --test test/sessions.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'

const root = fileURLToPath(new URL('..', import.meta.url))
// Inside the checkout, so the external DSH packages resolve from node_modules.
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-sessions-'))
await build({
  absWorkingDir: root,
  stdin: {
    contents: "export * from './src/host/sessions/service.ts'\nexport * from './src/host/placement.ts'\nexport * as persistence from './src/host/session-persistence.ts'\nexport { initialState } from './src/host/sessions/state.ts'\nexport * from './src/host/sessions/availability.ts'\nexport * as tracing from './src/host/layerfs/tracing.ts'\nexport { apply as applySessionsIndex } from './src/host/sessions/index.ts'\nexport { buildTrajectory, trajectoryRevision } from './src/host/sessions/trace.ts'\n",
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
    layerfs: { state: layerfsRoot, scratchProject: 'dsh-scratch/scratch', lfs, emit: (type, data) => events.push({ type, data }), ensureHostDaemon: async () => {} },
    sessions: { get: () => undefined },
    logger: () => ({ warn() {}, info() {} }),
  }
  let value = state
  Object.defineProperty(s, 'ctx', { value: ctx })
  Object.defineProperty(s, 'state', { value: { read: () => value, update(fn) { const d = structuredClone(value); value = fn(d) ?? d; return value } } })
  Object.defineProperty(s, 'lanes', { value: new Map() })
  Object.defineProperty(s, 'storeHealth', { value: new Map() })
  Object.defineProperty(s, 'serverChecked', { value: new Map() })
  return { s, events, state: () => value }
}

const session = (id, header, events = []) => ({ id, header: { id, ...header }, snapshotEvents: () => events })
const ran = [{ type: 'turn/start', data: { turn: 1 } }]

/** The `layerfs-session` events fired, each with the execution state saved when it fired. */
function sessionSaves(s, state) {
  const saves = []
  s.ctx.layerfs.emit = (type, data) => {
    if (type === 'layerfs-session') saves.push({ sessionId: data.sessionId, executionState: state().sessions[data.sessionId]?.executionState })
  }
  return saves
}

test('placeOf: a folder path never creates ownership, not even a recorded legacy project anchor', () => {
  // docs/specs/layerfs-folder.md §4: the project is never inferred from a folder path;
  // ownership comes from a binding, a pending choice, the owner route or a parent.
  const state = S.initialState()
  state.projects['st/app'] = { project: 'st/app', anchor: '/lfs-root/projects/st/app', workspaceId: 'legacy-workspace' }
  const { s } = sessions({ state })
  assert.deepEqual(s.placeOf(session('a', { cwd: '/lfs-root/projects/st/app' })), { kind: 'folder', cwd: '/lfs-root/projects/st/app' })
  assert.deepEqual(s.placeOf(session('b', { cwd: '/lfs-root/scratch' })), { kind: 'folder', cwd: '/lfs-root/scratch' })
  assert.deepEqual(s.placeOf(session('c', { cwd: '/Users/me/Documents/default-workspace' })), { kind: 'folder', cwd: '/Users/me/Documents/default-workspace' })
  assert.deepEqual(s.placeOf(session('d', { cwd: '/Users/me/repo' }, ran)), { kind: 'folder', cwd: '/Users/me/repo' })
  // Nor when the session already ran (resumed after a restart).
  assert.equal(s.placeOf(session('e', { cwd: '/lfs-root/projects/st/app' }, ran)).kind, 'folder')
  assert.deepEqual(s.placeOf(session('unowned', { cwd: '/lfs-root/projects/other/repo' })), { kind: 'folder', cwd: '/lfs-root/projects/other/repo' })
  state.projects['st/new'] = { project: 'st/new', anchor: '/lfs-root/projects/st/new' }
  assert.equal(s.placeOf(session('new-anchor', { cwd: '/lfs-root/projects/st/new' })).kind, 'folder', 'new anchors are not ownership')
  // A pending choice is what makes such a session a project session.
  state.pending.a = { project: 'st/app' }
  assert.deepEqual(s.placeOf(session('a', { cwd: '/lfs-root/projects/st/app' })), { kind: 'project', project: 'st/app', anchor: '/lfs-root/scratch' })
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
  const root = s.ctx.layerfs.state
  const sess = session('n', { cwd: '/Users/me/repo' })
  await s.choose('n', 'st/app')
  assert.deepEqual(state().pending.n, { project: 'st/app' })
  // The same session in the same folder now works in the project — no workspace change;
  // its scratch parent is the Scratch folder (docs/specs/layerfs-folder.md §4).
  assert.deepEqual(s.placeOf(sess), { kind: 'project', project: 'st/app', anchor: `${root}/scratch` })
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

test('choose: a blank session takes the layerfs preset with its project and the default without it', async () => {
  const lfs = { project: { get: async (key) => ({ key }) } }
  const { s } = sessions({ lfs, layerfsRoot: mkdtempSync(join(tmpdir(), 'dsh-root-')) })
  const root = s.ctx.layerfs.state
  const blank = session('np', { cwd: root })
  s.ctx.sessions.get = () => blank
  const selected = []
  let preset = 'compiler'
  const presets = { defaultId: 'compiler', presetForSession: () => preset, select: async (_a, id) => { selected.push(id); preset = id; return id } }
  const agent = { id: 'np', session: blank }
  s.ctx.get = (name) => (name === 'agentPresets' ? presets : name === 'agents' ? { get: () => agent } : undefined)
  s.moveTo = async () => {}
  await s.choose('np', 'st/app')
  await s.choose('np', 'st/other')
  assert.deepEqual(selected, ['layerfs', 'layerfs'], 'the hero chip shows the layerfs preset as soon as a project is chosen')
  await s.choose('np', null)
  assert.deepEqual(selected, ['layerfs', 'layerfs', 'compiler'], 'leaving the project restores the default preset')
  // A preset the person picked themselves is left alone when the project is cleared.
  await s.choose('np', 'st/app')
  preset = 'ptc'
  await s.choose('np', null)
  assert.deepEqual(selected, ['layerfs', 'layerfs', 'compiler', 'layerfs'])
  rmSync(root, { recursive: true, force: true })
})

test('checkPlacement passes for a ready project, and reads the machine a PostgreSQL project would use, without writing anything', async () => {
  // A plain project on a ready machine and Store.
  const ready = sessions({ lfs: {
    project: { get: async () => ({ store: 'st', engine: 'sqlite', machine: 'macos-host', state: 'ready' }) },
    machine: { get: async (name) => ({ machine: name, state: 'ready' }) },
    store: { get: async () => ({ store: 'st', engine: 'sqlite', state: 'ready' }) },
    branch: { fork: async () => { throw new Error('checkPlacement must never claim an identity branch') } },
  } })
  assert.deepEqual(await ready.s.checkPlacement('st/app'), { ok: true })
  assert.deepEqual(ready.state().pending, {})
  assert.deepEqual(ready.state().sessions, {})

  // A PostgreSQL project with no pick uses its last Sandbox's ready machine
  // (the choice `mount` makes), never a stopped host one.
  const got = []
  const pg = sessions({ lfs: {
    project: { get: async () => ({ store: 'st', engine: 'postgresql', state: 'ready' }) },
    machine: {
      list: async () => ({ items: [
        { machine: 'macos-host', state: 'ready', supports: ['sqlite'] },
        { machine: 'docker', state: 'ready', supports: ['sqlite', 'postgresql_sandbox'] },
      ] }),
      get: async (name) => { got.push(name); return { machine: name, state: 'ready' } },
    },
    store: { get: async () => ({ store: 'st', engine: 'postgresql', state: 'ready', machines: [{ machine: 'docker', reached: 'ok' }] }) },
    sandbox: { list: async () => ({ items: [{ sandbox: 'old', machine: 'docker', created_at: '2026-11-19T00:00:00Z' }] }) },
  } })
  assert.deepEqual(await pg.s.checkPlacement('st/app'), { ok: true })
  assert.deepEqual(got, ['docker'], 'the project\'s last Sandbox machine was checked')
  assert.deepEqual(pg.state().pending, {})
  assert.deepEqual(pg.state().sessions, {})
})

test('checkPlacement refuses an identity mismatch, missing project, stopped machine and unavailable Store without a placement', async () => {
  const refused = async ({ lfs, persistence, projectId, machine, code }) => {
    const { s, state } = sessions({ lfs })
    if (persistence) s.ctx.get = (name) => (name === 'sessionPersistence' ? persistence : undefined)
    await assert.rejects(s.checkPlacement('st/app', projectId, machine), (e) => e.code === code)
    assert.deepEqual(state().pending, {}, 'no pending placement')
    assert.deepEqual(state().sessions, {}, 'no binding')
  }
  const branch = { fork: async () => { throw new Error('checkPlacement must never claim a branch') } }
  // A listed identity that no longer matches the project (read, never claimed).
  await refused({
    persistence: { catalog: { assert: async (project, expected, options) => {
      assert.deepEqual([project, expected, options], ['st/app', 'old-id', { claim: false }])
      throw new Refusal('ProjectIdentityChanged', 'This name now refers to another project.')
    } } },
    projectId: 'old-id', code: 'ProjectIdentityChanged',
  })
  // A project the client listed but that cannot be read.
  await refused({ lfs: { project: { get: async () => { throw new Refusal('NotFound', 'no project st/app') } }, branch }, code: 'NotFound' })
  // A SQLite project whose machine is stopped.
  await refused({ lfs: {
    project: { get: async () => ({ store: 'st', engine: 'sqlite', machine: 'vm', state: 'ready' }) },
    machine: { get: async (name) => ({ machine: name, state: 'stopped', reason: 'stopped' }) },
    store: { get: async () => ({ store: 'st', engine: 'sqlite', state: 'ready' }) },
    branch,
  }, code: 'Unavailable' })
  // A PostgreSQL project on its picked machine, when that machine is stopped.
  await refused({ lfs: {
    project: { get: async () => ({ store: 'st', engine: 'postgresql', state: 'ready' }) },
    machine: { get: async (name) => ({ machine: name, state: 'stopped' }) },
    store: { get: async () => ({ store: 'st', engine: 'postgresql', state: 'ready' }) },
    branch,
  }, machine: 'vm2', code: 'Unavailable' })
  // A Store that is blocked by its machine.
  await refused({ lfs: {
    project: { get: async () => ({ store: 'st', engine: 'sqlite', machine: 'macos-host', state: 'ready' }) },
    machine: { get: async (name) => ({ machine: name, state: 'ready' }) },
    store: { get: async () => ({ store: 'st', engine: 'sqlite', state: 'blocked', blocked_by: { machine: 'macos-host', reason: 'stopped' } }) },
    branch,
  }, code: 'Unavailable' })
})

test('a failed choose removes the pending placement it wrote, so a retry is not half placed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-root-'))
  try {
    const state = S.initialState()
    state.sessions.a = { sessionId: 'a', kind: 'project', project: 'st/app', anchor: join(root, 'projects', 'st', 'app'), scratch: '/x', state: 'bound' }
    const { s, state: readState } = sessions({ state, layerfsRoot: root, lfs: { project: { get: async () => ({ store: 'st', engine: 'sqlite', machine: 'macos-host' }) } } })
    s.detach = async () => { throw new Refusal('Busy', 'the Workspace is busy') }
    await assert.rejects(s.choose('a', 'st/app'), (e) => e.code === 'Busy')
    assert.equal(readState().pending.a, undefined, 'the pending placement was removed')
    assert.equal(readState().sessions.a.project, 'st/app', 'the binding stays')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('the layerfs preset is refused without a project: a blank folder session moves off it', async () => {
  const { s, state } = sessions()
  const selected = []
  let preset = 'layerfs'
  const presets = {
    defaultId: 'layerfs', presetForSession: () => preset,
    list: async () => [{ id: 'layerfs' }, { id: 'broken', broken: 'x' }, { id: 'standard' }],
    select: async (_a, id) => { selected.push(id); preset = id; return id },
  }
  s.ctx.get = (name) => (name === 'agentPresets' ? presets : undefined)
  const blank = { id: 'f', session: session('f', { cwd: '/Users/me/repo' }) }
  await s.bindAgent(blank, 'create')
  assert.deepEqual(selected, ['standard'], 'a layerfs default falls back to the first other working preset')
  preset = 'layerfs'
  presets.defaultId = 'compiler'
  await s.enforceFolderPreset(blank)
  assert.deepEqual(selected, ['standard', 'compiler'], 'a layerfs pick falls back to the default')
  // A project session keeps it, and so does a started folder session.
  preset = 'layerfs'
  state().pending.f = { project: 'st/app' }
  await s.enforceFolderPreset(blank)
  await s.enforceFolderPreset({ id: 'r', session: session('r', { cwd: '/Users/me/repo' }, ran) })
  assert.deepEqual(selected, ['standard', 'compiler'])
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
  const { s } = sessions({ lfs: { project: { get: async () => { await gate; return { kind: 'sqlite', machine: 'macos-host' } } } }, layerfsRoot: mkdtempSync(join(tmpdir(), 'dsh-choose-race-')) })
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
      project: { get: async () => ({ store: 'st', engine: 'sqlite', machine: 'macos-host', state: 'ready' }) },
      branch: { fork: async () => { throw new Error('recovery must not fork from main') } },
      // 2.0 `sandbox get --detail`: Workspaces `{ workspace, branch, path }`
      sandbox: { get: async (name) => ({ sandbox: name, state: 'ready', workspaces: [{ workspace: `${name}:main`, branch: 'existing-internal', path: scratch }] }) },
    } })
    const persistence = {
      ownerOf: () => ({ project: 'st/app' }),
      readSidecar: async () => ({ project: 'st/app', codeBranch: 'existing-internal', checkpoints }),
      migrateProject: async () => {}, updateSidecar: async () => {}, recordInvocation: async () => {},
    }
    s.ctx.get = (name) => name === 'sessionPersistence' ? persistence : undefined
    const moves = []
    s.ctx.workingDirectory = { get: () => scratch, set: async (_agent, dir) => { moves.push(dir) } }
    const agent = { id: 'recovered', session: session('recovered', { cwd: scratch }, [...ran, { type: 'turn/end', data: { turn: 1 } }]) }
    await s.ensureBound(agent)
    assert.equal(s.binding('recovered').branch, 'existing-internal')
    assert.deepEqual(s.checkpoints('recovered'), checkpoints)
    // With no binding left, its scratch is a new folder of its own; a session that ran moves with DSH's notice.
    assert.equal(s.binding('recovered').scratch, join(scratch, 'scratch', 'recovered'))
    assert.deepEqual(moves, [join(scratch, 'scratch', 'recovered')])
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
    workspace: { status: async () => ({ changes: [{ path: '/a', change: 'modified' }], overlay: { entries: 1 } }), commit: async () => { throw new Refusal('Unknown', 'uncertain save') } },
    sandbox: { remove: async () => { closed = true } },
  } })
  await assert.rejects(s.close('a'), (e) => e.code === 'Unknown')
  assert.equal(closed, false)
  assert.equal(s.binding('a').state, 'bound')
})

test('ensureBound binds a remote project: Sandbox on its machine, working directory a new scratch folder of its own', async () => {
  const calls = []
  const lfs = {
    project: { get: async () => ({ store: 'st', engine: 'sqlite', machine: 'lima1', state: 'ready' }) },
    branch: { fork: async (project, branch, from) => { calls.push(`fork ${project} ${branch} ${from}`); return { commit: 'f'.repeat(66) } } },
    sandbox: {
      get: async () => { throw new Refusal('NotFound') },
      // 2.0 `sandbox create <project> <sandbox> [--machine M]`
      create: async (project, name, options) => { calls.push(`sandbox ${project} ${name} ${options.machine ?? '(its Store\'s machine)'}`); return { ok: true } },
    },
    workspace: {
      mount: async (sandbox, branch, options) => { calls.push(`mount ${sandbox} ${branch} ${options.name}`); return { path: '/mnt/inside-the-guest', workspace: `${sandbox}:${options.name}`, commit: 'base-1' } },
    },
  }
  const { s, state } = sessions({ lfs, layerfsRoot: mkdtempSync(join(tmpdir(), 'dsh-root-')) })
  const selected = []
  s.ctx.get = (name) => (name === 'agentPresets' ? { select: async (_a, id) => { selected.push(id); return id } } : undefined)
  s.ctx.workingDirectory = { get: () => s.ctx.layerfs.state, set: async () => { throw new Error('a fresh session moves silently, never with a notice') } }
  const anchor = join(s.ctx.layerfs.state, 'projects', 'st', 'app')
  state().pending.n1 = { project: 'st/app' }
  const appended = []
  const agent = { id: 'n1', session: { ...session('n1', { cwd: anchor }), seq: 0, append: (type, data) => appended.push([type, data]) } }
  await s.ensureBound(agent)
  const b = state().sessions.n1
  assert.equal(b.state, 'bound')
  assert.equal(b.machine, 'lima1')
  assert.equal(b.mount, undefined, 'a remote Workspace mounts inside its Sandbox, not on this host')
  assert.equal(b.ws, 'dsh-n1:main', 'the Workspace handle stays usable for exec/status/commit')
  // docs/specs/layerfs-folder.md §4: the folder it was created in never becomes its scratch
  const own = join(s.ctx.layerfs.state, 'scratch', 'n1')
  assert.equal(b.scratch, own)
  assert.equal(b.scratchManaged, true)
  assert.ok(statSync(own).isDirectory())
  assert.equal(b.anchor, join(s.ctx.layerfs.state, 'scratch'), 'the Scratch folder is its parent')
  assert.deepEqual(calls, ['fork st/app dsh.n1 main', 'sandbox st/app dsh-n1 lima1', 'mount dsh-n1 dsh.n1 main'], 'the machine is named whenever it is not the host machine')
  assert.deepEqual(appended.filter(([type]) => type === 'working-directory/change'), [['working-directory/change', { cwd: own }]], 'moved there before its first turn')
  assert.deepEqual(selected, ['layerfs'], 'the session is recomposed under the layerfs preset')
  rmSync(s.ctx.layerfs.state, { recursive: true, force: true })
})

// Issue #185: a project session's first message may spend seconds making its
// Sandbox and mounting the Workspace, and the row used to look idle throughout.
test('a first bind says Starting while its Workspace mounts, then active', async () => {
  let atMount, releaseMount
  const mounting = new Promise((resolve) => { atMount = resolve })
  const gate = new Promise((resolve) => { releaseMount = resolve })
  const lfs = {
    project: { get: async () => ({ store: 'st', engine: 'sqlite', machine: 'macos-host', state: 'ready' }) },
    branch: { fork: async () => ({ commit: 'f'.repeat(66) }) },
    sandbox: {
      get: async () => { throw new Refusal('NotFound') },
      create: async () => ({ ok: true }),
    },
    workspace: {
      mount: async (sandbox, _branch, options) => {
        atMount()
        await gate
        return { path: '/host/mount', workspace: `${sandbox}:${options.name}`, commit: 'base-1' }
      },
    },
  }
  const { s, state } = sessions({ lfs, layerfsRoot: mkdtempSync(join(tmpdir(), 'dsh-root-')) })
  try {
    const saves = sessionSaves(s, state)
    s.ctx.workingDirectory = { get: () => s.ctx.layerfs.state, set: async () => {} }
    state().pending.n1 = { project: 'st/app' }
    const agent = { id: 'n1', session: { ...session('n1', { cwd: join(s.ctx.layerfs.state, 'projects', 'st', 'app') }), seq: 0, append: () => {} } }
    const step = s.ensureBound(agent)
    await mounting
    const starting = state().sessions.n1
    assert.equal(starting.executionState, 'activating', 'the row says Starting while the mount runs')
    assert.equal(starting.state, 'closed', 'it is not bound yet')
    assert.equal(starting.project, 'st/app')
    assert.deepEqual(saves, [{ sessionId: 'n1', executionState: 'activating' }], 'one session event for the start')
    releaseMount()
    await step
    assert.equal(state().sessions.n1.executionState, 'active')
    assert.equal(state().sessions.n1.state, 'bound')
    assert.deepEqual(saves, [{ sessionId: 'n1', executionState: 'activating' }, { sessionId: 'n1', executionState: 'active' }], 'then one for active')
  } finally { rmSync(s.ctx.layerfs.state, { recursive: true, force: true }) }
})

test('a failed mount leaves no Starting session: it ends interrupted with the error', async () => {
  let during
  const lfs = {
    project: { get: async () => ({ store: 'st', engine: 'sqlite', machine: 'macos-host', state: 'ready' }) },
    branch: { fork: async () => ({ commit: 'f'.repeat(66) }) },
    sandbox: {
      get: async () => { throw new Refusal('NotFound') },
      create: async () => ({ ok: true }),
    },
    workspace: { mount: async () => { during = { ...state().sessions.n1 }; throw new Refusal('Unavailable', 'worker gone') } },
  }
  const { s, state } = sessions({ lfs, layerfsRoot: mkdtempSync(join(tmpdir(), 'dsh-root-')) })
  try {
    const saves = sessionSaves(s, state)
    s.ctx.workingDirectory = { get: () => s.ctx.layerfs.state, set: async () => {} }
    state().pending.n1 = { project: 'st/app' }
    const agent = { id: 'n1', session: { ...session('n1', { cwd: join(s.ctx.layerfs.state, 'projects', 'st', 'app') }), seq: 0, append: () => {} } }
    await assert.rejects(s.ensureBound(agent), (e) => e.code === 'Unavailable' && /worker gone/.test(e.message))
    assert.equal(during.executionState, 'activating', 'it was starting during the mount')
    const failed = state().sessions.n1
    assert.equal(failed.executionState, 'interrupted', 'no stuck Starting')
    assert.equal(failed.state, 'failed')
    assert.match(failed.error, /worker gone/)
    assert.equal(failed.ws, undefined, 'no Workspace is claimed')
    assert.deepEqual(saves, [{ sessionId: 'n1', executionState: 'activating' }, { sessionId: 'n1', executionState: 'interrupted' }])
  } finally { rmSync(s.ctx.layerfs.state, { recursive: true, force: true }) }
})

test('a normal step on a bound, usable session does not show Starting', async () => {
  const state = S.initialState()
  state.sessions.live = { sessionId: 'live', kind: 'project', project: 'st/app', anchor: '/a', scratch: '/s', branch: 'dsh.live', sandbox: 'dsh-live', ws: 'dsh-live:main', state: 'bound', executionState: 'active', createdAt: 0, updatedAt: 0 }
  const { s, state: now } = sessions({ state })
  const saves = sessionSaves(s, now)
  const agent = { id: 'live', session: { ...session('live', { cwd: '/scratch' }), seq: 0, append: () => {} } }
  await s.ensureBound(agent)
  await s.ensureBound(agent)
  assert.deepEqual(saves, [], 'no save and no Starting flash')
  assert.equal(now().sessions.live.executionState, 'active')
})

test('a subagent follows its root and never shows a Starting state of its own', async () => {
  const state = S.initialState()
  state.sessions.owner = { sessionId: 'owner', kind: 'project', project: 'st/app', anchor: '/a', scratch: '/s', branch: 'dsh.owner', sandbox: 'dsh-owner', ws: 'dsh-owner:main', mount: '/m', state: 'bound', executionState: 'active', createdAt: 0, updatedAt: 0 }
  const { s, state: now } = sessions({ state })
  const saves = sessionSaves(s, now)
  s.ctx.workingDirectory = { get: () => '/s', set: async () => {} }
  const child = { id: 'kid', session: { id: 'kid', header: { id: 'kid', cwd: '/a', origin: 'subagent', parentSession: 'owner' }, snapshotEvents: () => [] } }
  await s.ensureBound(child)
  assert.equal(now().sessions.kid.kind, 'shared')
  assert.equal(now().sessions.kid.state, 'bound')
  assert.equal(now().sessions.kid.executionState, 'active')
  assert.deepEqual(saves, [{ sessionId: 'kid', executionState: 'active' }], 'one Active save, never Starting')
})

test('ensureBound runs a PostgreSQL project where the session picked, else its last machine while attached and running, else the only attached one; otherwise the person picks (spec v23)', async () => {
  const bind = async (machines, { picked, last, attached = [] } = {}) => {
    const calls = []
    const lfs = {
      // a PostgreSQL Store is on no machine: project.get names none
      project: { get: async () => ({ store: 'st', engine: 'postgresql', state: 'ready' }) },
      // `machine list --detail` (2.0): rows keyed `machine`, `supports` a list
      machine: { list: async () => ({ items: machines.map(({ name, ...rest }) => ({ machine: name, ...rest })) }) },
      store: { get: async () => ({ engine: 'postgresql', machines: attached.map((m) => ({ machine: m, reached: 'ok' })) }) },
      branch: { fork: async () => ({ commit: 'f'.repeat(66) }) },
      sandbox: {
        get: async () => { throw new Refusal('NotFound') },
        list: async () => ({ items: last ? [{ sandbox: 'old', machine: last, created_at: '2026-11-19T00:00:00Z' }] : [] }),
        create: async (project, name, options) => { calls.push(`sandbox ${project} ${name} ${options.machine ?? 'macos-host'}`); return { ok: true } },
      },
      workspace: { mount: async (sandbox, branch, options) => ({ path: '/mnt/inside', workspace: `${sandbox}:${options.name}`, commit: 'base-1' }) },
    }
    const { s, state } = sessions({ lfs, layerfsRoot: mkdtempSync(join(tmpdir(), 'dsh-root-')) })
    try {
      s.ctx.get = (name) => (name === 'agentPresets' ? { select: async (_a, id) => id } : undefined)
      s.ctx.workingDirectory = { get: () => s.ctx.layerfs.state, set: async () => {} }
      state().pending.n1 = { project: 'st/app', ...(picked ? { machine: picked } : {}) }
      await s.ensureBound({ id: 'n1', session: { ...session('n1', { cwd: join(s.ctx.layerfs.state, 'projects', 'st', 'app') }), seq: 0, append: () => {} } })
      assert.deepEqual(calls, [`sandbox st/app dsh-n1 ${state().sessions.n1.machine}`])
      // nothing Store-wide was written: no store-machines.json beside the plugin's state
      assert.equal(existsSync(join(s.ctx.layerfs.state, 'store-machines.json')), false)
      return state().sessions.n1.machine
    } finally { rmSync(s.ctx.layerfs.state, { recursive: true, force: true }) }
  }
  const m = (name, more = {}) => ({ name, supports: ['sqlite', 'postgresql_sandbox'], ...more })
  const fleet = [m('macos-host'), m('docker'), m('vm1'), m('vm2', { state: 'stopped' }), m('vm3', { state: 'broken' }), m('old', { supports: ['sqlite'] })]
  assert.equal(await bind(fleet, { picked: 'vm1' }), 'vm1', 'the session\'s own pick')
  assert.equal(await bind(fleet, { last: 'vm1', attached: ['docker', 'vm1'] }), 'vm1', 'the project\'s last machine, while attached')
  assert.equal(await bind(fleet, { last: 'vm1', attached: ['docker'] }), 'docker', 'a last machine no longer attached is skipped: the only attached one')
  assert.equal(await bind(fleet, { last: 'vm3', attached: ['docker'] }), 'docker', 'a broken last machine is skipped')
  assert.equal(await bind(fleet, { attached: ['macos-host'] }), 'macos-host', 'the host machine attached like any machine')
  await assert.rejects(bind(fleet, { last: 'vm2', attached: ['vm2', 'docker'] }), (e) => e.code === 'InvalidInput', 'a stopped last machine, two attached: nothing is guessed')
  await assert.rejects(bind(fleet, {}), (e) => e.code === 'InvalidInput', 'none attached: nothing is guessed, not even the host machine')
})

test('ensureBound gives a host machine project a new scratch folder, separate from the mount; a picked folder is kept', async () => {
  const calls = []
  const lfs = {
    project: { get: async () => ({ store: 'st', engine: 'sqlite', machine: 'macos-host', state: 'ready' }) },
    branch: { fork: async () => { calls.push('fork'); return { commit: 'f'.repeat(66) } } },
    sandbox: {
      get: async () => { throw new Refusal('NotFound') },
      create: async (_p, _n, options) => { calls.push(`sandbox ${options.machine ?? 'macos-host'}`); return { ok: true } },
    },
    workspace: { mount: async (sandbox, _b, options) => { calls.push(`mount ${sandbox}`); return { path: `${s_root}/host-mount`, workspace: `${sandbox}:${options.name}` } } },
  }
  const { s, state } = sessions({ lfs, layerfsRoot: mkdtempSync(join(tmpdir(), 'dsh-root-')) })
  const s_root = s.ctx.layerfs.state
  s.ctx.workingDirectory = { get: () => s_root, set: async () => {} }
  const anchor = join(s_root, 'projects', 'st', 'app')
  state().pending.n2 = { project: 'st/app' }
  const appended = []
  const agent = { id: 'n2', session: { ...session('n2', { cwd: anchor }), seq: 0, append: (type, data) => appended.push([type, data]) } }
  await s.ensureBound(agent)
  const b = state().sessions.n2
  assert.equal(b.state, 'bound')
  assert.equal(b.mount, `${s_root}/host-mount`)
  assert.deepEqual(calls, ['fork', 'sandbox macos-host', 'mount dsh-n2'])
  const own = join(s_root, 'scratch', 'n2')
  assert.equal(b.scratch, own, 'the folder it was created in (an old anchor) is not its scratch')
  assert.equal(b.scratchManaged, true)
  assert.notEqual(b.scratch, b.mount)
  assert.deepEqual(appended.filter(([type]) => type === 'working-directory/change'), [['working-directory/change', { cwd: own }]])
  // A folder the person picked (sessions.selectScratch) stays the scratch, unmanaged.
  const picked = join(s_root, 'picked')
  mkdirSync(picked)
  state().sessions.n3 = { sessionId: 'n3', kind: 'project', project: 'st/app', anchor: join(s_root, 'scratch'), scratch: picked, scratchManaged: false, state: 'closed', createdAt: 1, updatedAt: 1 }
  const kept = []
  await s.ensureBound({ id: 'n3', session: { ...session('n3', { cwd: picked }), seq: 0, append: (type, data) => kept.push([type, data]) } })
  assert.equal(state().sessions.n3.state, 'bound')
  assert.equal(state().sessions.n3.scratch, picked)
  assert.equal(state().sessions.n3.scratchManaged, false)
  assert.equal(existsSync(join(s_root, 'scratch', 'n3')), false, 'no scratch folder is made for it')
  rmSync(s_root, { recursive: true, force: true })
})

test('ensureScratchProject makes the Store and project once, tolerating Exists', async () => {
  const calls = []
  let made = false
  const lfs = {
    project: {
      get: async (key) => { calls.push(`get ${key}`); if (!made) throw new Refusal('NotFound'); return { project: key } },
      init: async (key, folder) => { calls.push(`init ${key}`); assert.ok(folder.includes('scratch-')); made = true; return {} },
    },
    store: { create: async (name) => { calls.push(`create ${name}`); throw new Refusal('Exists') } },
  }
  const { s } = sessions({ lfs, layerfsRoot: mkdtempSync(join(tmpdir(), 'dsh-root-')) })
  await Promise.all([s.ensureScratchProject(), s.ensureScratchProject()])
  await s.ensureScratchProject()
  assert.deepEqual(calls, ['get dsh-scratch/scratch', 'create dsh-scratch', 'init dsh-scratch/scratch'])
  rmSync(s.ctx.layerfs.state, { recursive: true, force: true })
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
  state.sessions.other = { sessionId: 'other', kind: 'project', project: 'st/q', machine: 'macos-host', sandbox: 'other-box', ws: 'other-box:main', scratch: '/local', anchor: '/anchor', state: 'bound' }
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
      // 2.0: a Sandbox whose daemon is gone reads broken (lost)
      get: async (name) => ({ sandbox: name, state: 'broken', reason: 'lost', workspaces: [] }),
      remove: async (name) => { calls.push(['remove', name]); return { ok: true } },
      create: async (...args) => { calls.push(['create', ...args]); return { ok: true } },
    },
    workspace: { mount: async (name, branch) => { calls.push(['mount', name, branch]); return { workspace: 'box:main', commit: 'saved' } } },
  } })
  f.s.ctx.get = () => undefined
  f.s.ctx.workingDirectory = { get: () => root }
  try {
    await f.s.ensureBound({ id: 'live', session: session('live', { cwd: root }) })
    assert.deepEqual(calls, [['remove', 'box'], ['create', 'st/p', 'box', { machine: 'vm' }], ['mount', 'box', 'saved-branch']])
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
    machine: { get: async () => ({ machine: 'vm', state: online ? 'ready' : 'stopped' }) },
    // 2.0 `store get --detail`: a Store on a stopped machine reads blocked
    store: { get: async () => online ? { store: 'store', engine: 'sqlite', state: 'ready' } : { store: 'store', engine: 'sqlite', state: 'blocked', blocked_by: { machine: 'vm', reason: 'stopped' } } },
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

test('an observed session.state (the views\' poll) changes nothing: a refused machine, Store or Workspace check leaves the session bound (RV4 FAIL 1)', async () => {
  for (const refused of ['machine-op', 'machine', 'store', 'workspace']) {
    const state = S.initialState()
    state.sessions.live = { sessionId: 'live', kind: 'project', project: 'store/app', machine: 'vm', anchor: '/anchor', scratch: '/scratch', state: 'bound', ws: 'box:main', sandbox: 'box', mount: '/mnt/box', branch: 'retained', executionState: 'active' }
    state.checkpoints.live = [{ commit: 'saved' }]
    const before = structuredClone(state)
    const f = sessions({ state, lfs: {
      // an image load on the machine (an `op`), a stopped machine, a blocked Store, a timed-out status
      machine: { get: async () => refused === 'machine-op' ? { machine: 'vm', state: 'ready', op: 'image load' } : { machine: 'vm', state: refused === 'machine' ? 'stopped' : 'ready' } },
      store: { get: async () => refused === 'store' ? { store: 'store', engine: 'sqlite', state: 'blocked', blocked_by: { machine: 'vm', reason: 'stopped' } } : { store: 'store', engine: 'sqlite', state: 'ready' } },
      workspace: { status: async () => { if (refused === 'workspace') throw new Refusal('Timeout', 'workspace status timed out'); return { overlay: { inode_count: 1 } } } },
    } })
    f.s.ctx.get = (name) => name === 'sessionPersistence' ? {
      assertSessionIdentity: async () => ({ key: 'store/app', store: 'store', machine: 'vm' }),
      projectIdOf: () => 'permanent-id', local: { stat: async () => ({ eventCount: 5 }) },
    } : undefined
    const view = await f.s.view('live', { observe: true })
    assert.equal(view.execution.available, false, refused)
    assert.ok(view.execution.reason, refused)
    assert.deepEqual(f.state().sessions, before.sessions, `${refused}: the binding is unchanged (still bound, mount and Workspace kept)`)
    assert.equal(f.state().sessions.live.state, 'bound')
    assert.notEqual(f.state().sessions.live.executionState, 'interrupted')
    assert.deepEqual(f.state().checkpoints, before.checkpoints)
    assert.deepEqual(f.events.filter((e) => e.type === 'layerfs-session'), [], `${refused}: no session event`)
    // without `observe` (an explicit read) the same refusal still interrupts, as before
    await f.s.view('live')
    assert.equal(f.state().sessions.live.executionState, 'interrupted', refused)
  }
})

test('observed reads check identity and readiness once per short window, and a repeat with no change costs no CLI call', async () => {
  const state = S.initialState()
  state.sessions.live = { sessionId: 'live', kind: 'project', project: 'store/app', machine: 'vm', anchor: '/anchor', scratch: '/scratch', state: 'bound', ws: 'box:main', sandbox: 'box', branch: 'retained', executionState: 'active' }
  state.checkpoints.live = [{ commit: 'saved' }]
  const calls = []
  const f = sessions({ state, lfs: {
    machine: { get: async () => { calls.push('machine'); return { machine: 'vm', state: 'ready' } } },
    store: { get: async () => { calls.push('store'); return { store: 'store', engine: 'sqlite', state: 'ready' } } },
    workspace: { status: async (_ws, options) => { calls.push(`status:${options?.detail === true}`); return { overlay: { inode_count: 2 } } } },
  } })
  f.s.ctx.get = (name) => name === 'sessionPersistence' ? {
    assertSessionIdentity: async () => { calls.push('identity'); return { key: 'store/app', store: 'store', machine: 'vm' } },
    projectIdOf: () => 'permanent-id', local: { stat: async () => ({ eventCount: 5 }) },
  } : undefined
  for (let i = 0; i < 3; i++) {
    const view = await f.s.view('live', { observe: true })
    assert.equal(view.execution.available, true)
    assert.equal(view.execution.reason, undefined)
    assert.deepEqual(view.status?.overlay, { inode_count: 2 }, 'status stays live inside the window')
    assert.equal(view.binding.state, 'bound')
  }
  assert.deepEqual(calls, ['identity', 'machine', 'store', 'status:true'],
    'identity and readiness read once; a repeat with the same revision answers from the memo, no CLI call')
  // Without observe (an explicit read) the check always runs, window or not.
  calls.length = 0
  await f.s.view('live')
  assert.deepEqual(calls, ['identity', 'machine', 'store', 'status:true'])
})

test('an observed read never caches a refused machine, Store or identity: the next read asks again', async () => {
  for (const refused of ['machine', 'store', 'identity']) {
    const state = S.initialState()
    state.sessions.live = { sessionId: 'live', kind: 'project', project: 'store/app', machine: 'vm', anchor: '/anchor', scratch: '/scratch', state: 'bound', ws: 'box:main', sandbox: 'box', branch: 'retained', executionState: 'active' }
    const calls = []
    const f = sessions({ state, lfs: {
      machine: { get: async () => { calls.push('machine'); if (refused === 'machine') throw new Refusal('Unavailable', 'machine vm is stopped'); return { machine: 'vm', state: 'ready' } } },
      store: { get: async () => { calls.push('store'); if (refused === 'store') throw new Refusal('Unavailable', 'store is blocked'); return { store: 'store', engine: 'sqlite', state: 'ready' } } },
      workspace: { status: async () => { calls.push('status'); return {} } },
    } })
    f.s.ctx.get = (name) => name === 'sessionPersistence' ? {
      assertSessionIdentity: async () => { calls.push('identity'); if (refused === 'identity') throw new Refusal('ProjectIdentityChanged'); return { key: 'store/app', store: 'store', machine: 'vm' } },
      projectIdOf: () => 'permanent-id', local: { stat: async () => ({ eventCount: 5 }) },
    } : undefined
    const first = await f.s.view('live', { observe: true })
    assert.equal(first.execution.available, false, refused)
    assert.ok(first.execution.reason, refused)
    const second = await f.s.view('live', { observe: true })
    assert.equal(second.execution.available, false, refused)
    assert.equal(calls.filter((call) => call === 'identity').length, 2, `${refused}: identity is read again`)
    if (refused !== 'identity') assert.equal(calls.filter((call) => call === 'machine').length, 2, `${refused}: readiness is read again`)
    assert.equal(f.state().sessions.live.state, 'bound', `${refused}: an observed refusal changes nothing`)
  }
})

test('save and interrupt invalidate the observed readiness window for that session', async () => {
  const state = S.initialState()
  state.sessions.live = { sessionId: 'live', kind: 'project', project: 'store/app', machine: 'vm', anchor: '/anchor', scratch: '/scratch', state: 'bound', ws: 'box:main', sandbox: 'box', branch: 'retained', executionState: 'active' }
  const calls = []
  const f = sessions({ state, lfs: {
    machine: { get: async () => { calls.push('machine'); return { machine: 'vm', state: 'ready' } } },
    store: { get: async () => { calls.push('store'); return { store: 'store', engine: 'sqlite', state: 'ready' } } },
    workspace: { status: async () => { calls.push('status'); return {} } },
  } })
  f.s.ctx.get = (name) => name === 'sessionPersistence' ? {
    assertSessionIdentity: async () => { calls.push('identity'); return { key: 'store/app', store: 'store', machine: 'vm' } },
    projectIdOf: () => 'permanent-id', local: { stat: async () => ({ eventCount: 5 }) },
  } : undefined
  const once = () => calls.filter((call) => call === 'identity').length
  await f.s.view('live', { observe: true })
  await f.s.view('live', { observe: true })
  assert.equal(once(), 1)
  f.s.save({ ...f.state().sessions.live })
  await f.s.view('live', { observe: true })
  assert.equal(once(), 2, 'save clears the entry')
  f.s.interrupt('live', 'A test interruption', 'blocked')
  await f.s.view('live', { observe: true })
  assert.equal(once(), 3, 'interrupt clears the entry (through its save)')
})

test('a stopped machine clears observed readiness even with no binding save', async () => {
  const state = S.initialState()
  state.sessions.held = { sessionId: 'held', kind: 'project', project: 'store/app', machine: 'vm', anchor: '/anchor', scratch: '/scratch', state: 'closed', executionState: 'interrupted', error: 'Store down', interruption: { kind: 'availability', at: 1 }, branch: 'retained' }
  const calls = []
  const f = sessions({ state, lfs: {
    machine: { get: async () => { calls.push('machine'); return { machine: 'vm', state: 'ready' } } },
    store: { get: async () => { calls.push('store'); return { store: 'store', engine: 'sqlite', state: 'ready' } } },
    workspace: { status: async () => { calls.push('status'); return {} } },
  } })
  f.s.ctx.get = (name) => name === 'sessionPersistence' ? {
    assertSessionIdentity: async () => { calls.push('identity'); return { key: 'store/app', store: 'store', machine: 'vm' } },
    projectIdOf: () => 'permanent-id', local: { stat: async () => ({ eventCount: 5 }) },
  } : undefined
  await f.s.view('held', { observe: true })
  await f.s.view('held', { observe: true })
  assert.equal(calls.filter((call) => call === 'identity').length, 1)
  f.s.machinesStopped(['vm'])
  await f.s.view('held', { observe: true })
  assert.equal(calls.filter((call) => call === 'identity').length, 2, 'a machine transition clears the entry without a save')
})

test('an observed read never clears an availability error either; the explicit read does', async () => {
  const state = S.initialState()
  state.sessions.held = { sessionId: 'held', kind: 'project', project: 'store/app', machine: 'vm', anchor: '/anchor', scratch: '/scratch', state: 'closed', executionState: 'interrupted', error: 'Store down', interruption: { kind: 'availability', at: 1 }, branch: 'retained' }
  const f = sessions({ state, lfs: {
    machine: { get: async () => ({ machine: 'vm', state: 'ready' }) },
    store: { get: async () => ({ store: 'store', engine: 'sqlite', state: 'ready' }) },
    workspace: { status: async () => ({}) },
  } })
  f.s.ctx.get = (name) => name === 'sessionPersistence' ? {
    assertSessionIdentity: async () => ({ key: 'store/app', store: 'store', machine: 'vm' }),
    projectIdOf: () => 'permanent-id', local: { stat: async () => ({ eventCount: 5 }) },
  } : undefined
  await f.s.view('held', { observe: true })
  assert.equal(f.state().sessions.held.error, 'Store down')
  await f.s.view('held')
  assert.equal(f.state().sessions.held.error, undefined)
})

test('the session view reads workspace status --detail: its overlay counts are the line\'s unsaved files (review UR bug 2)', async () => {
  const state = S.initialState()
  state.sessions.live = { sessionId: 'live', kind: 'project', project: 'store/app', machine: 'vm', anchor: '/anchor', scratch: '/scratch', state: 'bound', ws: 'box:main', branch: 'retained' }
  const f = sessions({ state, lfs: {
    machine: { get: async () => ({ machine: 'vm', state: 'ready' }) },
    store: { get: async () => ({ store: 'store', engine: 'sqlite', state: 'ready' }) },
    // the long form carries `overlay`; the short form has none
    workspace: { status: async (_ws, o) => (o?.detail ? { workspace: 'box:main', overlay: { inode_count: 2, entry_count: 3 } } : { workspace: 'box:main' }) },
  } })
  f.s.ctx.get = (name) => name === 'sessionPersistence' ? {
    assertSessionIdentity: async () => ({ key: 'store/app', store: 'store', machine: 'vm' }),
    projectIdOf: () => 'permanent-id', local: { stat: async () => ({ eventCount: 5 }) },
  } : undefined
  const view = await f.s.view('live')
  assert.equal(view.execution.available, true)
  assert.deepEqual(view.status?.overlay, { inode_count: 2, entry_count: 3 })
})

test('a missing saved checkpoint blocks activation without falling back to project main', async () => {
  const state = S.initialState()
  state.sessions.history = { sessionId: 'history', kind: 'project', project: 'store/app', machine: 'vm', anchor: '/anchor', scratch: '/scratch', state: 'closed', sandbox: 'box', branch: 'retained' }
  state.checkpoints.history = [{ commit: 'missing-checkpoint', branch: 'retained' }]
  const calls = []
  const f = sessions({ state, lfs: {
    machine: { get: async () => ({ state: 'ready' }) }, store: { get: async () => ({ store: 'store', engine: 'sqlite', state: 'ready' }) },
    file: { list: async () => { throw new Refusal('NotFound') } },
    branch: { fork: async () => { calls.push('fork') } }, sandbox: { create: async () => { calls.push('sandbox') } },
  } })
  f.s.ctx.get = (name) => name === 'sessionPersistence' ? { assertSessionIdentity: async () => ({ key: 'store/app', store: 'store', machine: 'vm' }) } : undefined
  await assert.rejects(f.s.ensureBound({ id: 'history', session: session('history', { cwd: '/scratch' }, ran) }), { code: 'CheckpointUnavailable' })
  assert.deepEqual(calls, [])
  assert.equal(f.state().checkpoints.history[0].commit, 'missing-checkpoint')
})

test('classifyStore: the 2.0 six states: blocked and broken are unavailable, busy waits, unknown never deactivates', () => {
  assert.equal(S.classifyStore({ store: 's', state: 'ready' }).state, 'available')
  assert.equal(S.classifyStore({ store: 's' }).state, 'available', 'a ready row may leave state out')
  assert.equal(S.classifyStore({ store: 's', state: 'busy', op: { name: 'move' } }).state, 'transient')
  assert.equal(S.classifyStore({ store: 's', state: 'ready', op: { name: 'compact' } }).state, 'transient')
  const blocked = S.classifyStore({ store: 's', state: 'blocked', blocked_by: { machine: 'vm', reason: 'stopped' } })
  assert.deepEqual(blocked, {
    state: 'unavailable',
    reason: 'The machine of Store s (vm) is stopped.',
    failure: { code: 'machine_blocked', store: 's', machine: 'vm', reason: 'stopped' },
  })
  assert.equal(S.classifyStore({ store: 's', state: 'broken', reason: 'unresolved', fix: 'layerfs store move s vm' }).state, 'unavailable')
  assert.match(S.classifyStore({ store: 's', state: 'broken', reason: 'unresolved', fix: 'layerfs store move s vm' }).reason, /Fix: layerfs store move s vm/)
  assert.equal(S.classifyStore(undefined).state, 'removed')
  // a PostgreSQL Store: the live read (`store get --with live`) decides
  assert.equal(S.classifyStore({ store: 'pg', engine: 'postgresql', state: 'ready' }, { store: 'pg', state: 'broken', reason: 'unreachable' }).state, 'unavailable')
  assert.equal(S.classifyStore({ store: 'pg', engine: 'postgresql', state: 'ready' }, { store: 'pg', state: 'ready' }).state, 'available')
  assert.equal(S.classifyStore({ store: 's', state: 'unknown' }).state, 'unknown')
  assert.equal(S.classifyStore({ store: 's', state: 'mystery' }).state, 'unknown')
  // a PostgreSQL Store with no saved password is unavailable, and says what fixes it; never a missing SQLite file or the "Storage page"
  const noLogin = S.classifyStore({ store: 'old', engine: 'postgresql', state: 'broken', reason: 'failed', password_saved: false, fix: 'layerfs store connect old postgresql://db/old --user <user> --password-stdin' })
  assert.equal(noLogin.state, 'unavailable')
  assert.equal(noLogin.failure?.code, 'pg_no_login')
  assert.match(noLogin.reason, /PostgreSQL Store old has no saved password; give one with Edit connection… on its Store page/)
  assert.doesNotMatch(noLogin.reason, /file of Store|Storage page/i)
  const priv = S.classifyStore({ store: 'billing', engine: 'postgresql', state: 'broken', reason: 'unreachable', message: 'role app lacks USAGE on schema layerfs (2 privilege(s) missing in all)' })
  assert.equal(priv.failure?.code, 'pg_privilege')
  assert.match(priv.reason, /lacks USAGE on schema layerfs/)
  const dns = S.classifyStore({ store: 'dev', engine: 'postgresql', state: 'broken', reason: 'unreachable', message: 'pack persistence: Refused { status: "Closed" }' })
  assert.equal(dns.failure?.code, 'pg_daemon_dns')
})

/** Store health poll fixture: an active owner + its subagent on `st`, another active session on `ok`. */
function polled(stores, statuses = {}) {
  const state = S.initialState()
  state.sessions.owner = { sessionId: 'owner', kind: 'project', project: 'st/app', machine: 'vm', sandbox: 'box', branch: 'dsh.owner', ws: 'box:main', mount: '/m', scratch: '/scratch', anchor: '/anchor', state: 'bound', executionState: 'active' }
  state.sessions.child = { sessionId: 'child', kind: 'shared', project: 'st/app', parent: 'owner', mount: '/m', scratch: '/scratch', anchor: '/anchor', state: 'bound', executionState: 'active' }
  state.sessions.calm = { sessionId: 'calm', kind: 'project', project: 'ok/app', machine: 'macos-host', sandbox: 'calm-box', ws: 'calm-box:main', scratch: '/s2', anchor: '/a2', state: 'bound', executionState: 'active' }
  state.checkpoints.owner = [{ commit: 'saved', branch: 'dsh.owner' }]
  const calls = []
  const f = sessions({ state, lfs: {
    // 2.0: `store list --detail` rows, and a PostgreSQL Store's `store get --with live`
    store: {
      list: async () => { calls.push('list'); if (stores instanceof Error) throw stores; return { items: stores() } },
      get: async (name) => { calls.push(`get:${name}`); return statuses[name]?.() ?? { store: name, state: 'ready' } },
    },
    workspace: { mount: async () => { calls.push('mount') } }, sandbox: { create: async () => { calls.push('create') }, remove: async () => { calls.push('remove') } },
  } })
  return { ...f, calls }
}

test('the availability poll deactivates active conversations whose Store went down, keeping history and the retained branch', async () => {
  let down = true
  const f = polled(() => [down ? { store: 'st', engine: 'sqlite', state: 'blocked', blocked_by: { machine: 'vm', reason: 'stopped' } } : { store: 'st', engine: 'sqlite', state: 'ready' }, { store: 'ok', engine: 'sqlite', state: 'ready' }])
  assert.equal(f.s.watchesAvailability(), true)
  await f.s.refreshAvailability()
  await f.s.settled('owner')
  for (const id of ['owner', 'child']) {
    const b = f.state().sessions[id]
    assert.equal(b.state, 'closed')
    assert.equal(b.executionState, 'interrupted')
    assert.equal(b.mount, undefined)
    assert.equal(b.ws, undefined)
    assert.equal(b.interruption.kind, 'availability')
    assert.match(b.error, /machine of Store st \(vm\) is stopped/)
  }
  assert.equal(f.state().sessions.owner.sandbox, 'box', 'the Sandbox name is kept so the next message re-mounts it')
  assert.equal(f.state().sessions.owner.branch, 'dsh.owner')
  assert.deepEqual(f.state().checkpoints.owner, [{ commit: 'saved', branch: 'dsh.owner' }])
  assert.equal(f.state().sessions.calm.state, 'bound', 'other Stores are untouched')
  assert.ok(f.events.some((e) => e.type === 'layerfs-availability' && e.data.stores.st.state === 'unavailable'))
  assert.ok(!f.calls.includes('mount') && !f.calls.includes('create') && !f.calls.includes('remove'), 'polling never starts, mounts or removes anything')
  // Access returns: the error clears, execution stays interrupted until a new message.
  down = false
  await f.s.refreshAvailability()
  const after = f.state().sessions.owner
  assert.equal(after.error, undefined)
  assert.equal(after.executionState, 'interrupted')
  assert.equal(after.state, 'closed')
  assert.ok(!f.calls.includes('mount'))
  assert.equal(f.s.availability().st.state, 'available')
})

test('the availability poll never deactivates on a busy Store, an unknown state or a failed list', async () => {
  const busy = polled(() => [{ store: 'st', state: 'busy', op: { name: 'move' } }, { store: 'ok', state: 'unknown' }])
  await busy.s.refreshAvailability()
  assert.equal(busy.state().sessions.owner.state, 'bound')
  assert.equal(busy.state().sessions.calm.state, 'bound')
  const offline = polled(Object.assign(new Error('cli gone'), { code: 'Unavailable' }))
  await offline.s.refreshAvailability()
  assert.equal(offline.state().sessions.owner.state, 'bound')
})

test('a removed Store and an unreachable PostgreSQL server deactivate their conversations', async () => {
  const removed = polled(() => [{ store: 'ok', state: 'ready' }])
  await removed.s.refreshAvailability()
  await removed.s.settled('owner')
  assert.equal(removed.state().sessions.owner.executionState, 'interrupted')
  assert.match(removed.state().sessions.owner.error, /no longer listed/)
  const pg = polled(() => [{ store: 'st', engine: 'postgresql', state: 'ready' }, { store: 'ok', state: 'ready' }],
    { st: () => ({ store: 'st', engine: 'postgresql', state: 'broken', reason: 'unreachable', fix: 'layerfs store doctor st' }) })
  await pg.s.refreshAvailability()
  await pg.s.settled('owner')
  assert.equal(pg.state().sessions.owner.executionState, 'interrupted')
  assert.equal(pg.state().sessions.owner.failure?.code, 'pg_unreachable')
  assert.match(pg.state().sessions.owner.error, /PostgreSQL Store st could not reach its server; check its connection on its Store page/)
  assert.ok(pg.calls.includes('get:st'), 'its server is read live')
})

test('a tool call never re-activates an interrupted context mid-turn; only a new message does', async () => {
  const state = S.initialState()
  state.sessions.live = { sessionId: 'live', kind: 'project', project: 'st/p', machine: 'vm', sandbox: 'box', branch: 'b', scratch: '/scratch', anchor: '/anchor', state: 'closed', executionState: 'interrupted', error: 'Store down', interruption: { kind: 'availability', at: 1 } }
  const calls = []
  const f = sessions({ state, lfs: { sandbox: { create: async () => { calls.push('create') } }, workspace: { mount: async () => { calls.push('mount') } } } })
  f.s.ctx.get = () => undefined
  await assert.rejects(f.s.ensureBound({ id: 'live', session: session('live', { cwd: '/scratch' }, ran) }, { rebind: false }), (error) => error.code === 'Unavailable' && /Store down/.test(error.message))
  assert.deepEqual(calls, [])
})

test('pgPlacement: the last machine while attached and placeable, else the only attached one, else none; placeable means running, PostgreSQL Sandboxes, not broken (spec v23)', () => {
  const m = (name, more = {}) => ({ name, supports: ['sqlite', 'postgresql_sandbox'], ...more })
  const fleet = [m('macos-host'), m('docker'), m('vm1', { state: 'stopped' }), m('vm2', { state: 'broken' })]
  assert.equal(S.pgPlacement(fleet, { last: 'docker', attached: ['docker'] }), 'docker')
  assert.equal(S.pgPlacement(fleet, { last: 'docker', attached: ['macos-host'] }), 'macos-host', 'a last machine no longer attached is not chosen: the only attached one')
  assert.equal(S.pgPlacement(fleet, { last: 'vm1', attached: ['vm1', 'vm2', 'docker'] }), null, 'a stopped last machine, several attached: LayerFS asks for one')
  assert.equal(S.pgPlacement(fleet, { last: 'gone', attached: [] }), null, 'none attached: not even the host machine')
  assert.equal(S.pgPlacement([], { attached: ['vm1'] }), 'vm1', 'the only attached machine, as LayerFS picks it')
  assert.deepEqual(S.attachedFrom({ machines: [{ machine: 'macos-host', reached: null }, { machine: 'docker', reached: 'failed' }, { machine: 'vm', reached: 'ok' }] }), ['vm', 'macos-host', 'docker'], 'a machine that reached the database first')
  assert.deepEqual(S.attachedFrom({ machines: ['a', 'b'] }), ['a', 'b'], 'store list names only')
  assert.deepEqual(S.attachedFrom({}), [])
  assert.equal(S.lastUsed([{ machine: 'a', created_at: '2026-01-01T00:00:00Z' }, { machine: 'b', created_at: '2026-02-01T00:00:00Z' }]), 'b')
  assert.equal(S.placeable({ name: 'x' }), true, 'a machine that says nothing about support or state is placeable')
})

test('Presets Reset deletes this home\'s project sessions only; loaded ones are archived with activity stopped first', async () => {
  const state = S.initialState()
  state.sessions.bound = { sessionId: 'bound', kind: 'project', project: 'demo/app', sandbox: 'dsh-bound', anchor: '/a', scratch: '/s', state: 'bound' }
  state.sessions.child = { sessionId: 'child', kind: 'shared', project: 'demo/app', parent: 'bound', anchor: '/a', scratch: '/s', state: 'bound' }
  state.sessions.folder = { sessionId: 'folder', kind: 'project', project: 'other/app', anchor: '/a', scratch: '/s', state: 'closed' }
  state.pending.draft = { project: 'demo/app' }
  state.checkpoints.bound = [{ commit: 'c1' }]
  state.mirror.bound = { count: 3, project: 'demo/app', branch: 'dsh.session.bound' }
  state.projects['demo/app'] = { project: 'demo/app', anchor: '/a', createdAt: 1 }
  const closed = [], archived = [], deleted = [], forgotten = []
  const f = sessions({ state, lfs: { sandbox: { remove: async (name, options) => { closed.push([name, options]); return { ok: true } } } } })
  // Owner routes: one in this home's Store, one in a same-named Store of another home (other Store ID).
  const owners = { bound: { project: 'demo/app', storeId: 'here' }, archivedOnly: { project: 'demo/old', storeId: 'here' }, foreign: { project: 'demo/app', storeId: 'elsewhere' } }
  const persistence = {
    ownedSessionIds: () => Object.keys(owners),
    ownerOf: (id) => owners[id] && { project: owners[id].project },
    storeIdOf: (id) => owners[id]?.storeId,
    deleteSessions: async (ids) => { deleted.push(...ids); return ids },
  }
  Object.assign(f.s.ctx, {
    get: (name) => (name === 'sessionPersistence' ? persistence : undefined),
    sessions: { get: (id) => (id === 'bound' ? { id } : undefined) },
    workspaceRegistry: { archiveSession: async (id, options) => { archived.push([id, options]) } },
  })
  Object.defineProperty(f.s, 'store', { value: { forget: (id) => forgotten.push(id) } })
  const stores = [{ name: 'demo', id: 'here' }]
  const listed = f.s.projectConversations(stores).map((c) => c.id)
  assert.deepEqual(listed.sort(), ['archivedOnly', 'bound', 'child', 'draft'])
  assert.deepEqual(f.s.projectConversations([{ name: 'demo' }]).map((c) => c.id).sort(), ['archivedOnly', 'bound', 'child', 'draft', 'foreign'], 'without a Store ID the name decides')
  const ids = await f.s.deleteProjectConversations(stores)
  assert.deepEqual(ids.sort(), ['archivedOnly', 'bound', 'child', 'draft'])
  assert.deepEqual(archived, [['bound', { stopActivity: true }]], 'only the loaded session is archived, with its activity stopped')
  assert.deepEqual(closed, [['dsh-bound', { force: true }]])
  assert.deepEqual(deleted.sort(), ids.sort())
  assert.deepEqual(forgotten.sort(), ids.sort())
  assert.deepEqual(Object.keys(f.state().sessions), ['folder'], 'another Store\'s binding stays')
  assert.deepEqual(f.state().pending, {})
  assert.deepEqual(f.state().checkpoints, {})
  assert.deepEqual(f.state().mirror, {})
  assert.deepEqual(Object.keys(f.state().projects), ['demo/app'], 'project workspaces are not this step\'s to drop')
  assert.ok(f.events.some((e) => e.type === 'layerfs-workspaces-changed' && e.data.project === 'demo/app'))
})

function removeFixture() {
  const state = S.initialState()
  state.sessions.bound = { sessionId: 'bound', kind: 'project', project: 'demo/app', sandbox: 'dsh-bound', anchor: '/a', scratch: '/s', state: 'closed' }
  state.sessions.other = { sessionId: 'other', kind: 'project', project: 'live/app', anchor: '/a', scratch: '/s', state: 'closed' }
  state.sessions.folder = { sessionId: 'folder', kind: 'folder', anchor: '/a', scratch: '/s', state: 'closed' }
  state.pending.draft = { project: 'demo/app' }
  const deleted = [], closed = []
  const f = sessions({ state, lfs: { sandbox: { remove: async (name) => { closed.push(name); return { ok: true } } } } })
  // `renamed` routes to the project's old address; `reused` is another project that took its address since.
  const owners = { routed: { project: 'demo/app' }, renamed: { project: 'demo/old-name' }, reused: { project: 'demo/app' }, foreign: { project: 'live/app' } }
  const ids = { routed: 'P1', renamed: 'P1', reused: 'P9', foreign: 'P2', bound: 'P1' }
  const persistence = {
    ownedSessionIds: () => Object.keys(owners),
    ownerOf: (id) => owners[id],
    projectIdOf: (id) => ids[id],
    deleteSessions: async (list) => { deleted.push(...list); return list },
  }
  Object.assign(f.s.ctx, {
    get: (name) => (name === 'sessionPersistence' ? persistence : undefined),
    sessions: { get: () => undefined },
    workspaceRegistry: { archiveSession: async () => {} },
  })
  Object.defineProperty(f.s, 'store', { value: { forget: () => {} } })
  return { ...f, deleted, closed }
}

test('Remove on a project row deletes its conversations by identity, live project or not', async () => {
  const f = removeFixture()
  const removed = await f.s.deleteConversationsOfProject('demo/app', 'P1')
  assert.deepEqual(removed, ['bound', 'draft', 'renamed', 'routed'], 'by identity, plus the address for a conversation that records none')
  assert.deepEqual(f.deleted.sort(), removed)
  assert.deepEqual(f.closed, ['dsh-bound'])
  assert.deepEqual(Object.keys(f.state().sessions).sort(), ['folder', 'other'])
  assert.deepEqual(f.state().pending, {})
  const g = removeFixture()
  assert.deepEqual(await g.s.deleteConversationsOfProject('demo/app'), ['bound', 'draft', 'reused', 'routed'], 'without an identity the address decides')
})

test('Delete on a conversation row deletes that project conversation only', async () => {
  const f = removeFixture()
  assert.deepEqual(await f.s.deleteConversation('renamed'), ['renamed'])
  assert.deepEqual(await f.s.deleteConversation('bound'), ['bound'])
  assert.deepEqual(f.deleted, ['renamed', 'bound'])
  assert.deepEqual(Object.keys(f.state().sessions).sort(), ['folder', 'other'])
  await assert.rejects(f.s.deleteConversation('folder'), /not a LayerFS project conversation/, 'a DSH folder conversation is not ours to delete')
  await assert.rejects(f.s.deleteConversation('nope'), /not a LayerFS project conversation/)
})

// ---------------------------------------------------------------- checkpoint receipts

const hex = (c) => c.repeat(66)
/** A fake lfs whose calls go through the real trace path (receipt id + log tag). */
function traced(operation, answer, tags, target) {
  return (...args) => S.tracing.traceInvocation(operation, async (tag) => { tags.push(tag); return answer(...args) }, undefined, target?.(...args))
}
function receiptFixture(lfs, state) {
  const recorded = []
  const f = sessions({ state, lfs })
  f.s.ctx.get = (name) => name === 'sessionPersistence' ? { recordInvocation: async (row) => { recorded.push(row) }, updateSidecar: async () => {} } : undefined
  return { ...f, recorded }
}
const boundState = (extra = {}) => {
  const state = S.initialState()
  state.sessions.a = { sessionId: 'a', kind: 'project', project: 'st/app', state: 'bound', ws: 'sb:main', sandbox: 'sb', branch: 'internal', ...extra }
  return state
}

test('a turn-end save carries its receipt; UpToDate binds as unchanged; a refused save keeps the refusal receipt', async () => {
  const tags = []
  // 2.0 answers: `workspace status --detail` counts its changes; `workspace commit` answers `commit` (+ `unchanged`)
  let answer = { commit: hex('a') }
  const { s, recorded } = receiptFixture({ workspace: {
    status: async () => ({ changes: [{ path: '/a', change: 'modified' }, { path: '/b', change: 'added' }], changes_count: 2 }),
    commit: traced('workspace.commit', () => { if (answer instanceof Error) throw answer; return answer }, tags, (ws) => ws),
  } }, boundState())
  const saved = await s.checkpoint('a', 'turn', 1, 'dsh turn 1')
  assert.equal(saved.commit, hex('a')); assert.equal(saved.changed, 2)
  assert.equal(saved.receipt, recorded[0].id)
  assert.equal(tags[0], `dsh:a:${saved.receipt}`, 'tagged with the owning session id')
  assert.deepEqual(recorded[0].versions, [{ kind: 'Commit', id: hex('a'), effect: 'created' }])
  answer = { commit: hex('a'), unchanged: true }
  const same = await s.checkpoint('a', 'manual', 1, 'Checkpoint')
  assert.equal(same.changed, 0); assert.equal(same.commit, hex('a')); assert.equal(same.receipt, recorded[1].id)
  assert.notEqual(same.receipt, saved.receipt)
  answer = Object.assign(new Refusal('Conflict', 'markers'), { transport: 'refusal' })
  const failed = await s.checkpoint('a', 'manual', 1, 'Checkpoint')
  assert.equal(failed.commit, null); assert.equal(failed.error.code, 'Conflict'); assert.equal(failed.receipt, recorded[2].id)
  assert.equal(recorded[2].outcome, 'refusal')
  assert.deepEqual(s.checkpoints('a').map((c) => c.receipt), recorded.map((r) => r.id))
})

test('a restore checkpoint carries the successful fork receipt', async () => {
  const tags = []
  const state = boundState()
  state.checkpoints.a = [{ kind: 'turn', turn: 1, seq: 3, endSeq: 4, commit: hex('c'), branch: 'gone-branch', changed: 1, message: 't1', at: 1 }]
  const { s, recorded } = receiptFixture({
    workspace: {
      status: async () => ({ changes_count: 0 }),
      commit: traced('workspace.commit', () => ({ commit: hex('c'), unchanged: true }), tags, (ws) => ws),
      unmount: async () => ({ ok: true }), mount: async () => ({ workspace: 'sb:main', path: '/mnt' }),
    },
    branch: { fork: traced('branch.fork', (project, branch, from) => { if (from !== 'main') throw new Refusal('NotFound'); return { commit: hex('c') } }, tags) },
    sandbox: { get: async (name) => ({ sandbox: name, state: 'ready', workspaces: [] }) },
  }, state)
  await s.restore('a', hex('c'))
  const restore = s.checkpoints('a').at(-1)
  assert.equal(restore.kind, 'restore')
  const forks = recorded.filter((r) => r.operation === 'branch.fork')
  assert.equal(forks.length, 2); assert.equal(forks[1].outcome, 'success')
  assert.equal(restore.receipt, forks[1].id)
  assert.deepEqual(forks[1].versions, [{ kind: 'Commit', id: hex('c'), effect: 'referenced' }])
  assert.ok(tags.includes(`dsh:a:${restore.receipt}`))
})

test('a branched child base checkpoint carries the fork receipt, tagged with the child session', async () => {
  const tags = []
  const state = boundState()
  state.checkpoints.a = [{ kind: 'turn', turn: 1, seq: 3, endSeq: 4, commit: hex('d'), branch: 'internal', changed: 1, message: 't1', at: 1 }]
  state.sessions.child = { sessionId: 'child', kind: 'project', project: 'st/app', state: 'bound', ws: 'sbc:main', sandbox: 'sbc', branch: 'first' }
  const { s, recorded } = receiptFixture({
    workspace: { unmount: async () => ({ ok: true }), mount: async () => ({ workspace: 'sbc:main', path: '/mnt' }) },
    branch: { fork: traced('branch.fork', () => ({ commit: hex('d') }), tags) },
    sandbox: { get: async (name) => ({ sandbox: name, state: 'ready', workspaces: [] }) },
  }, state)
  const persistence = s.ctx.get('sessionPersistence')
  s.ctx.get = (name) => name === 'sessionPersistence' ? persistence : name === 'sessionController' ? { fork: async () => ({ sessionId: 'child' }) } : undefined
  await s.branchAt('a', hex('d'), 1)
  const [baseCheckpoint] = s.checkpoints('child')
  assert.equal(baseCheckpoint.kind, 'base')
  assert.equal(recorded.length, 1); assert.equal(recorded[0].sessionId, 'child')
  assert.equal(baseCheckpoint.receipt, recorded[0].id)
  assert.equal(tags[0], `dsh:child:${baseCheckpoint.receipt}`)
})

test('archive writes stay untagged and record no receipt', async () => {
  const recorded = [], tags = []
  await S.tracing.withTraceContext({ origin: 'host', sessionId: 'a', project: 'st/app', record: async (row) => { recorded.push(row) } }, () =>
    S.tracing.withoutTraceContext(() => S.tracing.traceInvocation('file.apply', async (tag) => { tags.push(tag); return { commit: hex('e') } })))
  assert.deepEqual(tags, [undefined]); assert.deepEqual(recorded, [])
})

// A session's own host reads (the panel's polls and the pre-step check) run in
// its trace context: a successful read folds into the sidecar counter before the
// next annotation or trajectory read, while a tool read and a write keep their
// receipts. This is the live wiring the receipt policy needs; the policy itself
// is covered in test/receipt-policy.test.mjs.
test('a session\'s host reads fold into its sidecar; a tool read and a write keep receipts', async () => {
  const dir = mkdtempSync(join(root, '.dev-test-receipt-wiring-'))
  const tags = []
  const info = { project: 'store/app', store: 'store', engine: 'sqlite', machine: 'vm', created_at: '1970-01-01T00:00:00.100Z' }
  const branches = []
  const lfs = {
    project: { get: traced('project.get', () => info, tags), list: async () => ({ items: [info] }) },
    branch: { list: traced('branch.list', () => ({ items: branches.map((branch) => ({ branch })) }), tags), fork: async (_, branch) => { branches.push(branch); return { commit: hex('a') } } },
    machine: { get: traced('machine.get', () => ({ machine: 'vm', state: 'ready' }), tags), list: async () => ({ items: [] }) },
    store: { get: traced('store.get', () => ({ store: 'store', engine: 'sqlite', state: 'ready' }), tags), list: async () => ({ items: [] }) },
    workspace: { status: traced('workspace.status', () => ({ changes_count: 0 }), tags) },
  }
  const ctx = new Context()
  ctx.provide('layerfs', { state: join(dir, 'plugin'), projectSessionHome: join(dir, 'project-home'), home: join(dir, 'layerfs-home'), lfs })
  const fork = ctx.plugin(S.persistence, { root: join(dir, 'normal') })
  const header = (id) => ({ version: 4, id, createdAt: 1, cwd: '/scratch', isSeeded: false })
  const binding = (id) => ({ sessionId: id, kind: 'project', project: 'store/app', machine: 'vm', anchor: '/anchor', scratch: '/scratch',
    sandbox: 'box', ws: 'box:main', branch: 'internal', state: 'bound', executionState: 'active', createdAt: 1, updatedAt: 1 })
  try {
    await fork.await()
    const p = ctx.get('sessionPersistence')
    for (const id of ['live', 'fresh']) {
      const writer = await p.create(header(id))
      await writer.flush(); await writer.close()
      await p.migrateProject(id, 'store/app')
    }
    // Migration reads identity Branches without a session context; start counting here.
    tags.length = 0
    const attached = (state) => {
      const f = sessions({ state, lfs })
      f.s.ctx.get = (name) => name === 'sessionPersistence' ? p : name === 'layerfsSessions' ? f.s : undefined
      return f.s
    }
    const liveState = S.initialState()
    liveState.sessions.live = binding('live')
    const live = attached(liveState)
    // The panel's poll: identity, readiness and Workspace status are host calls.
    const view = await live.view('live', { observe: true })
    assert.equal(view.execution.available, true)
    const observed = tags.filter((tag) => tag !== undefined)
    assert.ok(observed.length >= 3, 'the poll made its host reads')
    assert.ok(observed.every((tag) => tag.startsWith('dsh:live:')), 'each call carries the session id, never dsh:-')
    const annotations = await p.readSidecar('live')
    assert.ok(annotations.receipts, 'the next annotations read carries the counter')
    assert.ok(annotations.receipts.readsTotal >= 3, 'successful host reads folded')
    assert.equal(annotations.receipts.reads['workspace.status'].count, 1)
    assert.deepEqual(annotations.invocations, [], 'a folded read writes no receipt')

    const events = [
      { type: 'turn/start', seq: 1, time: 10, data: { turn: 1 } },
      { type: 'user/message', seq: 2, time: 11, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'go' }] } },
      { type: 'turn/end', seq: 3, time: 12, data: { turn: 1 } },
    ]
    const input = { sessionId: 'live', project: 'store/app', branch: 'internal', events, invocations: annotations.invocations, checkpoints: [], receipts: annotations.receipts }
    const revision = S.trajectoryRevision(input)
    const observation = S.buildTrajectory(input).turns.flatMap((turn) => turn.records).find((record) => record.kind === 'observation')
    assert.ok(observation, 'the trajectory carries the observation record')
    assert.equal(observation.text, `polled ${annotations.receipts.readsTotal.toLocaleString('en-US')} times across ${Object.keys(annotations.receipts.reads).length} read-only operations`)
    assert.equal(observation.reads, annotations.receipts.readsTotal)
    assert.ok(observation.top.some((line) => line.startsWith('workspace status: ')))

    // A second read (no memo) moves the counter and so the revision, with no new receipt.
    await live.view('live')
    const moved = await p.readSidecar('live')
    assert.ok(moved.receipts.readsTotal > annotations.receipts.readsTotal)
    assert.notEqual(S.trajectoryRevision({ ...input, receipts: moved.receipts, invocations: moved.invocations }), revision)

    // Many host reads stay one counter: no receipt per poll, however many.
    const beforeLoop = moved.receipts.readsTotal
    for (let i = 0; i < 20; i++) await live.view('live')
    const polled = await p.readSidecar('live')
    assert.ok(polled.receipts.readsTotal >= beforeLoop + 20, 'every poll folded')
    assert.deepEqual(polled.invocations, [], 'a poll loop writes no receipts')

    // The pre-step check folds as well.
    const beforeStep = polled.receipts.readsTotal
    await live.ensureBound({ id: 'live', session: { id: 'live', cwd: '/scratch', snapshotEvents: () => [] } })
    const stepped = await p.readSidecar('live')
    assert.ok(stepped.receipts.readsTotal > beforeStep)
    assert.ok(tags.filter((tag) => tag !== undefined).every((tag) => tag.startsWith('dsh:live:')), 'no untagged session call')

    // An agent's own read is a command: one receipt, no fold.
    await p.recordInvocation({ id: 'tool-read', origin: 'tool', sessionId: 'live', project: 'store/app', operation: 'file.read',
      outcome: 'success', versions: [], at: 2, argv: ['file', 'read', 'store/app', 'internal', '/README.md'] })
    const commanded = await p.readSidecar('live')
    assert.deepEqual(commanded.invocations.map((row) => row.id), ['tool-read'], 'the tool read kept its receipt')
    assert.equal(commanded.receipts.readsTotal, stepped.receipts.readsTotal, 'and bumped nothing')
    // A write is history too.
    await p.recordInvocation({ id: 'write', origin: 'host', sessionId: 'live', project: 'store/app', operation: 'file.write',
      outcome: 'success', versions: [{ kind: 'Commit', id: hex('b'), effect: 'created' }], at: 3, argv: ['file', 'write', 'store/app', 'internal', '/README.md'] })
    const written = await p.readSidecar('live')
    assert.deepEqual(written.invocations.map((row) => row.id), ['tool-read', 'write'])
    assert.equal(written.receipts.readsTotal, stepped.receipts.readsTotal, 'a write bumps no read')

    // A session whose sidecar does not exist yet gets its first folded read.
    const freshState = S.initialState()
    freshState.sessions.fresh = binding('fresh')
    const fresh = attached(freshState)
    await fresh.view('fresh', { observe: true })
    const first = await p.readSidecar('fresh')
    assert.ok(first, 'the observation created the sidecar')
    assert.ok(first.receipts.readsTotal >= 3, 'its first reads folded')
    assert.deepEqual(first.invocations, [])
    assert.ok(tags.filter((tag) => tag !== undefined).some((tag) => tag.startsWith('dsh:fresh:')), 'the fresh session\'s reads carry its own tag')
    assert.equal(tags.filter((tag) => tag === undefined).length, 0, 'no host read of a session is untagged')
  } finally {
    await fork.dispose().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- review fixes

test('choosing a project with an unclaimed listing id claims it (the one claiming path)', async () => {
  const asserted = []
  const lfs = { project: { get: async (key) => ({ key }) } }
  const { s, state } = sessions({ lfs, layerfsRoot: mkdtempSync(join(tmpdir(), 'dsh-root-')) })
  s.ctx.get = (name) => name === 'sessionPersistence' ? { catalog: { assert: async (...args) => { asserted.push(args) } } } : undefined
  await s.choose('n', 'st/app', 'unclaimed:st/app')
  assert.deepEqual(asserted, [['st/app', 'unclaimed:st/app', { claim: true }]])
  assert.deepEqual(state().pending.n, { project: 'st/app' })
  rmSync(s.ctx.layerfs.state, { recursive: true, force: true })
})

test('a turn with changes (an in-place edit counts as one) or a pending merge is checkpointed; an unchanged turn is not', async () => {
  // 2.0 `workspace status --detail`: `changes` lists the first 20, `changes_count` all of them
  let status = { changes: [{ path: '/a.txt', change: 'modified' }], changes_count: 1, pending_merge: false, branch_moved: false }
  let commits = 0
  const { s } = receiptFixture({ workspace: {
    status: async () => status,
    commit: async () => { commits++; return { commit: hex('f') } },
  } }, boundState())
  const saved = await s.checkpoint('a', 'turn', 1, 'dsh turn 1')
  assert.equal(commits, 1)
  assert.equal(saved.commit, hex('f')); assert.equal(saved.changed, 1)
  status = { changes: [{ path: '/a', change: 'modified' }], changes_count: 3, pending_merge: false, branch_moved: false }
  assert.equal((await s.checkpoint('a', 'turn', 2, 'dsh turn 2')).changed, 3, 'changed is changes_count, not the listed page')
  status = { changes: [], changes_count: 0, pending_merge: true, branch_moved: false }
  assert.ok(await s.checkpoint('a', 'turn', 3, 'dsh turn 3'), 'a pending merge is saved')
  status = { changes: [], changes_count: 0, pending_merge: false, branch_moved: false }
  assert.equal(await s.checkpoint('a', 'turn', 4, 'dsh turn 4'), undefined, 'an unchanged turn records nothing')
  assert.equal(commits, 3)
})

test('a restore whose mount fails keeps the forked branch, unbound, and a retry forks the next generation', async () => {
  const state = boundState()
  state.checkpoints.a = [{ kind: 'turn', turn: 1, seq: 3, endSeq: 4, commit: hex('c'), branch: 'internal', changed: 1, message: 't1', at: 1 }]
  const forks = []
  let failMount = 1
  const { s } = receiptFixture({
    workspace: {
      status: async () => ({ changes_count: 0 }),
      commit: async () => ({ commit: hex('c'), unchanged: true }),
      unmount: async () => ({ ok: true }),
      mount: async (sandbox, branch) => { if (failMount-- > 0) throw new Refusal('Unavailable', 'worker gone'); return { workspace: `${sandbox}:main`, path: '/mnt', commit: hex('c') } },
    },
    branch: { fork: async (project, branch) => { if (forks.includes(branch)) throw new Refusal('Exists'); forks.push(branch); return { commit: hex('c') } } },
    sandbox: { get: async (name) => ({ sandbox: name, state: 'ready', workspaces: [] }) },
  }, state)
  await assert.rejects(s.restore('a', hex('c')), (e) => e.code === 'Unavailable')
  const failed = s.binding('a')
  assert.equal(failed.branch, S.branchOf('a', 1), 'the forked branch is recorded at once')
  assert.equal(failed.restores, 1)
  assert.equal(failed.state, 'failed'); assert.equal(failed.ws, undefined); assert.equal(failed.mount, undefined)
  assert.match(failed.error, /worker gone/)
  assert.equal(s.checkpoints('a').at(-1).kind, 'restore')
  // Retried: no `Exists`, the next generation is forked and mounted.
  const next = await s.restore('a', hex('c'))
  assert.deepEqual(forks, [S.branchOf('a', 1), S.branchOf('a', 2)])
  assert.equal(next.branch, S.branchOf('a', 2)); assert.equal(next.state, 'bound'); assert.equal(next.ws, 'sb:main')
  assert.equal(s.binding('a').state, 'bound')
})

test('a branched child whose mount fails keeps its forked branch for the next message', async () => {
  const state = boundState()
  state.checkpoints.a = [{ kind: 'turn', turn: 1, seq: 3, endSeq: 4, commit: hex('d'), branch: 'internal', changed: 1, message: 't1', at: 1 }]
  state.sessions.child = { sessionId: 'child', kind: 'project', project: 'st/app', state: 'bound', ws: 'sbc:main', sandbox: 'sbc', branch: 'first' }
  const { s } = receiptFixture({
    workspace: { unmount: async () => ({ ok: true }), mount: async () => { throw new Refusal('Unavailable', 'worker gone') } },
    branch: { fork: async () => ({ commit: hex('d') }) },
    sandbox: { get: async (name) => ({ sandbox: name, state: 'ready', workspaces: [] }) },
  }, state)
  const persistence = s.ctx.get('sessionPersistence')
  s.ctx.get = (name) => name === 'sessionPersistence' ? persistence : name === 'sessionController' ? { fork: async () => ({ sessionId: 'child' }) } : undefined
  await assert.rejects(s.branchAt('a', hex('d'), 1), (e) => e.code === 'Unavailable')
  const child = s.binding('child')
  assert.equal(child.branch, S.branchOf('child', 1))
  assert.equal(child.state, 'failed'); assert.equal(child.ws, undefined)
  assert.deepEqual(child.from, { session: 'a', commit: hex('d'), turn: 1 })
})

// Quarry v2 FIX-LOG F21: a readiness read failing under host load interrupted a running team.
test('a failed readiness check keeps a bound execution whose Workspace still answers (F21)', async () => {
  const state = S.initialState()
  state.sessions.owner = { sessionId: 'owner', kind: 'project', project: 'st/app', anchor: '/a', scratch: '/s', machine: 'docker', branch: 'dsh.owner', sandbox: 'dsh-owner', ws: 'dsh-owner:main', state: 'bound', executionState: 'active', createdAt: 0, updatedAt: 0 }
  state.sessions.child = { sessionId: 'child', kind: 'shared', project: 'st/app', parent: 'owner', anchor: '/a', scratch: '', state: 'bound', createdAt: 0, updatedAt: 0 }
  let answers = true
  const { s, state: now } = sessions({ state, lfs: {
    machine: { get: async () => ({ state: 'unknown' }) },
    store: { get: async () => ({ store: 'st', state: 'unknown' }) },
    workspace: { status: async () => { if (!answers) throw new Refusal('NotFound'); return { workspace: 'dsh-owner:main' } } },
  } })
  s.ctx.get = (name) => name === 'sessionPersistence' ? { assertSessionIdentity: async () => ({ kind: 'sqlite', machine: 'docker', store: 'st', key: 'st/app' }) } : undefined
  await s.validateExecutionIdentity('child')
  assert.equal(now().sessions.owner.state, 'bound', 'the owner stays bound')
  assert.equal(now().sessions.owner.ws, 'dsh-owner:main')
  assert.equal(now().sessions.owner.interruption, undefined)
  // A Workspace that no longer answers still interrupts, as before.
  answers = false
  s.identityChecked.clear()
  await assert.rejects(s.validateExecutionIdentity('child'), (e) => e.code === 'Unavailable')
  assert.equal(now().sessions.owner.state, 'closed')
  assert.equal(now().sessions.owner.executionState, 'interrupted')
})

// Quarry v2 FIX-LOG F23: re-activation over a still-mounted Workspace left `ws` unset.
test('re-activating an interrupted binding over a still-mounted Workspace restores its handle (F23)', async () => {
  const mounts = []
  const { s } = sessions({ lfs: {
    sandbox: { get: async (name) => ({ sandbox: name, state: 'ready', workspaces: [{ workspace: 'dsh-owner:main', branch: 'dsh.owner', path: '/layerfs/run/main' }] }) },
    workspace: { mount: async (...args) => { mounts.push(args); return { workspace: 'dsh-owner:main' } }, unmount: async () => ({ ok: true }) },
  } })
  const binding = { sessionId: 'owner', kind: 'project', project: 'st/app', machine: 'docker', branch: 'dsh.owner', sandbox: 'dsh-owner', state: 'closed', executionState: 'interrupted' }
  const mount = await s.mount(binding)
  assert.equal(mount, undefined, 'a docker Workspace has no host path')
  assert.equal(binding.ws, 'dsh-owner:main', 'the Workspace handle is restored')
  assert.deepEqual(mounts, [], 'nothing is remounted')
})

test('session.state names the branch kind the host returned, without touching the saved binding', async () => {
  const cases = [
    ['own', S.branchOf('abc'), 'own', undefined],
    ['restore', S.branchOf('abc', 2), 'restore', 2],
    ['resume', `${S.branchOf('abc')}.resume.0123456789ab`, 'resume', undefined],
    ['other', 'feature/x', 'other', undefined],
  ]
  for (const [name, branch, kind, restore] of cases) {
    const state = S.initialState()
    state.sessions.abc = { sessionId: 'abc', kind: 'project', project: 'store/app', anchor: '/anchor', scratch: '/scratch', state: 'closed', branch }
    const f = sessions({ state })
    const before = structuredClone(state.sessions.abc)
    const view = await f.s.view('abc')
    assert.equal(view.binding.branch, branch, name)
    assert.equal(view.binding.branchKind, kind, name)
    assert.equal(view.binding.restore, restore, name)
    assert.deepEqual(f.state().sessions.abc, before, `${name}: the persisted binding is untouched`)
    assert.equal(f.state().sessions.abc.branchKind, undefined, name)
  }
})

test('sessions.list rows carry the branch kind too, from the row\'s branch and its own session id', async () => {
  const state = S.initialState()
  const row = (sessionId, branch, updatedAt) => ({ sessionId, kind: 'project', project: 'st/app', anchor: '/a', scratch: '/s', state: 'closed', branch, createdAt: 0, updatedAt })
  state.sessions.own = row('own', S.branchOf('own'), 1)
  state.sessions.restored = row('restored', S.branchOf('restored', 2), 2)
  state.sessions.resumed = row('resumed', `${S.branchOf('resumed')}.resume.0123456789ab`, 3)
  state.sessions.plain = row('plain', 'feature/x', 4)
  const ops = {}
  const ctx = {
    layerfs: { state: '/lfs-root', scratchProject: 'dsh-scratch/scratch', lfs: {}, emit() {}, outputs: '/lfs-root/trace/outputs' },
    layerfsSessions: { state: { read: () => state } },
    layerfsRemote: { operate: (_ctx, table) => Object.assign(ops, table) },
    plugin() {},
    // The one scoped injection `apply` needs to register its operations.
    inject: (deps, callback) => { if (deps.includes('layerfsSessions')) callback(ctx) },
    on() {},
    effect() {},
    get: (name) => name === 'sessionPersistence' ? { stat: async () => undefined, ownedSessionIds: () => [] } : undefined,
    logger: () => ({ warn() {}, info() {} }),
    workspaceRegistry: { archivedSessionIds: [] },
  }
  S.applySessionsIndex(ctx)
  const { sessions: listed } = await ops['sessions.list']({ project: 'st/app', localOnly: true })
  const byId = Object.fromEntries(listed.map((r) => [r.sessionId, r]))
  assert.deepEqual(Object.keys(byId).sort(), ['own', 'plain', 'restored', 'resumed'])
  assert.equal(byId.own.branchKind, 'own')
  assert.equal(byId.restored.branchKind, 'restore')
  assert.equal(byId.restored.restore, 2)
  assert.equal(byId.resumed.branchKind, 'resume')
  assert.equal(byId.plain.branchKind, 'other')
  assert.equal('restore' in byId.own, false)
  for (const id of Object.keys(byId)) assert.equal(state.sessions[id].branchKind, undefined, id)
})

test('sessions.places: a second batch in the window reuses project ids, and ids no session knows do no lookup', () => {
  const state = S.initialState()
  state.sessions.live = { sessionId: 'live', kind: 'project', project: 'st/app', anchor: '/a', scratch: '/scratch', state: 'bound' }
  const f = sessions({ state })
  let projectIdCalls = 0, ownedCalls = 0
  const persistence = {
    projectIdOf: (id) => { projectIdCalls++; return id === 'live' ? 'pid-1' : undefined },
    ownedSessionIds: () => { ownedCalls++; return ['live'] },
  }
  f.s.ctx.get = (name) => name === 'sessionPersistence' ? persistence : undefined
  const ops = {}
  const ctx = {
    layerfs: { state: '/lfs-root', scratchProject: 'dsh-scratch/scratch', lfs: {}, emit() {}, outputs: '/lfs-root/trace/outputs' },
    layerfsSessions: f.s,
    layerfsRemote: { operate: (_ctx, table) => Object.assign(ops, table) },
    plugin() {},
    inject: (deps, callback) => { if (deps.includes('layerfsSessions')) callback(ctx) },
    on() {},
    effect() {},
    get: (name) => name === 'sessionPersistence' ? persistence : undefined,
    logger: () => ({ warn() {}, info() {} }),
    workspaceRegistry: { archivedSessionIds: [] },
  }
  S.applySessionsIndex(ctx)
  const placeCalls = []
  const placeOfId = f.s.placeOfId.bind(f.s)
  f.s.placeOfId = (id) => { placeCalls.push(id); return placeOfId(id) }
  const first = ops['sessions.places']({ sessionIds: ['live', 'unknown', 'unknown-too'] })
  assert.deepEqual(first, {
    places: {
      live: { project: 'st/app', projectId: 'pid-1', scratch: '/scratch' },
      unknown: null,
      'unknown-too': null,
    },
  })
  const second = ops['sessions.places']({ sessionIds: ['live', 'unknown', 'unknown-too'] })
  assert.deepEqual(second, first, 'the payload is identical')
  assert.equal(projectIdCalls, 1, 'the project id is read once inside the window')
  assert.equal(ownedCalls, 2, 'the ownership index is read once per batch, never per unknown id')
  assert.deepEqual(placeCalls, ['live', 'live'], 'ids no binding, pending choice, live session or route names never reach placeOfId')
})

test('sessions.places: one read-only batch over placeOfId and projectIdOf; bad ids and oversize batches are refused', () => {
  const places = { live: { project: 'st/app', scratch: '/scratch' }, folder: { project: null }, gone: null }
  const projectIds = { live: 'pid-1' }
  const ops = {}
  const ctx = {
    layerfs: { state: '/lfs-root', scratchProject: 'dsh-scratch/scratch', lfs: {}, emit() {}, outputs: '/lfs-root/trace/outputs' },
    layerfsSessions: { state: { read: () => S.initialState() }, placeOfId: (id) => places[id] ?? null },
    layerfsRemote: { operate: (_ctx, table) => Object.assign(ops, table) },
    plugin() {},
    inject: (deps, callback) => { if (deps.includes('layerfsSessions')) callback(ctx) },
    on() {},
    effect() {},
    get: (name) => name === 'sessionPersistence' ? { projectIdOf: (id) => projectIds[id] } : undefined,
    logger: () => ({ warn() {}, info() {} }),
    workspaceRegistry: { archivedSessionIds: [] },
  }
  S.applySessionsIndex(ctx)
  assert.deepEqual(ops['sessions.places']({ sessionIds: ['live', 'folder', 'gone', 'live'] }), {
    places: {
      live: { project: 'st/app', projectId: 'pid-1', scratch: '/scratch' },
      folder: null,
      gone: null,
    },
  })
  assert.deepEqual(ops['sessions.places']({ sessionIds: [] }), { places: {} })
  for (const bad of [{}, { sessionIds: 'live' }, { sessionIds: [1] }, { sessionIds: [''] }, { sessionIds: Array.from({ length: 201 }, (_, i) => `s${i}`) }]) {
    assert.throws(() => ops['sessions.places'](bad), (error) => error.code === 'InvalidInput')
  }
})

test('sessions.list reads each session\'s log and sidecar once per call', async () => {
  const state = S.initialState()
  const row = (sessionId, updatedAt) => ({ sessionId, kind: 'project', project: 'st/app', anchor: '/a', scratch: '/s', state: 'closed', createdAt: 0, updatedAt })
  state.sessions.local1 = row('local1', 4)
  state.sessions.local2 = row('local2', 3)
  state.pending.pend1 = { project: 'st/app' }
  const stats = new Map(), sidecars = new Map()
  const persistence = {
    local: { stat: async (id) => { stats.set(id, (stats.get(id) ?? 0) + 1); return { header: { id, createdAt: 1 } } } },
    stat: async (id) => { stats.set(id, (stats.get(id) ?? 0) + 1); return { header: { id, createdAt: 1 } } },
    readSidecar: async (id) => { sidecars.set(id, (sidecars.get(id) ?? 0) + 1); return { title: `sidecar ${id}`, checkpoints: [{ commit: 'c', changed: 1 }] } },
    ownedSessionIds: () => ['local1', 'local2', 'pend1', 'owned1'],
    projectIdOf: () => 'pid-1',
    catalog: { assert: async () => ({ projectId: 'pid-1' }) },
  }
  const ops = {}
  const ctx = {
    layerfs: { state: '/lfs-root', scratchProject: 'dsh-scratch/scratch', lfs: { branch: { list: async () => ({ items: [] }) } }, emit() {}, outputs: '/lfs-root/trace/outputs' },
    layerfsSessions: sessions({ state }).s,
    layerfsRemote: { operate: (_ctx, table) => Object.assign(ops, table) },
    plugin() {}, inject: (deps, callback) => { if (deps.includes('layerfsSessions')) callback(ctx) }, on() {}, effect() {},
    get: (name) => name === 'sessionPersistence' ? persistence : undefined,
    logger: () => ({ warn() {}, info() {} }),
    workspaceRegistry: { archivedSessionIds: [] },
  }
  S.applySessionsIndex(ctx)
  const { sessions: listed } = await ops['sessions.list']({ project: 'st/app', projectId: 'pid-1', localOnly: false })
  assert.deepEqual(listed.map((r) => r.sessionId).sort(), ['local1', 'local2', 'owned1', 'pend1'])
  for (const id of ['local1', 'local2', 'pend1', 'owned1']) {
    assert.equal(stats.get(id), 1, `${id}: one log stat`)
    assert.equal(sidecars.get(id), 1, `${id}: one sidecar read`)
  }
  // The already-read sidecar feeds the title and the checkpoint/stored fields.
  const owned = listed.find((r) => r.sessionId === 'owned1')
  assert.equal(owned.title, 'sidecar owned1')
  assert.equal(owned.checkpoints, 1)
})

test('a cold sessions.list answers known rows at once, then the walk lands and its event brings the stored session', async () => {
  let branchLists = 0, manifestReads = 0, head = 'c1'
  // Keep the first walk's manifest read pending: a list must not wait for it.
  let release, holding = true
  const walkGate = new Promise((resolve) => { release = resolve })
  const manifest = {
    version: 3, kind: 'dsh-session', sessionId: 'stored1', projectId: 'pid-1', title: 'Stored one',
    count: 1, checkpoints: [], updatedAt: 10, bindingKind: 'project',
    header: { version: 4, id: 'stored1', createdAt: 10, isSeeded: false, delegationDepth: 0 },
  }
  const lfs = {
    branch: { list: async () => { branchLists++; return { items: [{ branch: 'dsh.session.stored1', commit: head }] } } },
    file: {
      read: async () => {
        manifestReads++
        if (holding) await walkGate
        const text = `${JSON.stringify(manifest)}\n`
        return { text, size: Buffer.byteLength(text), start_line: 1, line_truncated: false, next_line: null }
      },
    },
  }
  const persistence = {
    stat: async () => undefined,
    readSidecar: async () => undefined,
    ownedSessionIds: () => [],
    projectIdOf: () => undefined,
    catalog: { assert: async () => ({ projectId: 'pid-1' }) },
  }
  const state = S.initialState()
  const f = sessions({ state })
  const ops = {}
  const events = []
  const ctx = {
    layerfs: { state: '/lfs-root', scratchProject: 'dsh-scratch/scratch', lfs, emit: (type, data) => events.push({ type, data }), outputs: '/lfs-root/trace/outputs' },
    layerfsSessions: f.s,
    layerfsRemote: { operate: (_ctx, table) => Object.assign(ops, table) },
    plugin() {}, inject: (deps, callback) => { if (deps.includes('layerfsSessions')) callback(ctx) }, on() {}, effect() {},
    get: (name) => name === 'sessionPersistence' ? persistence : undefined,
    logger: () => ({ warn() {}, info() {} }),
    workspaceRegistry: { archivedSessionIds: [] },
  }
  S.applySessionsIndex(ctx)
  const list = () => ops['sessions.list']({ project: 'st/app', projectId: 'pid-1', localOnly: false })
  const announcements = () => events.filter((e) => e.type === 'layerfs-session' && e.data?.discovery === true)
  const until = async (ready) => { for (let i = 0; i < 200; i++) { if (ready()) return; await new Promise((r) => setTimeout(r, 0)) } throw new Error('timed out') }

  // The cold read answers what is known (nothing) now; the walk finishes behind it.
  const first = await list()
  assert.deepEqual(first.sessions, [])
  assert.equal(branchLists, 1, 'one Branch list inline: the change token')
  assert.equal(manifestReads, 1, 'the walk started behind the call')
  // A second read while the walk runs answers known rows and starts no second walk.
  const second = await list()
  assert.deepEqual(second.sessions, [])
  assert.equal(branchLists, 2, 'every read lists the Branches')
  assert.equal(manifestReads, 1, 'the running walk is not started twice')
  holding = false
  release()
  await until(() => announcements().length === 1)
  assert.deepEqual(announcements()[0].data, { project: 'st/app', discovery: true })
  const third = await list()
  assert.deepEqual(third.sessions.map((r) => r.sessionId), ['stored1'], 'the stored row shows on the event-driven read')
  assert.equal(branchLists, 3)
  assert.equal(manifestReads, 1, 'unchanged heads: no stored manifest is read again')
  // A stored session saved by another process moves its Branch head: the next
  // read answers the known row at once, and the walk behind it rereads it.
  head = 'c2'
  manifest.title = 'Stored one @ c2'
  f.s.store.forget('stored1')
  const moved = await list()
  assert.deepEqual(moved.sessions.map((r) => r.sessionId), ['stored1'], 'the known row is not dropped while the walk runs')
  await until(() => announcements().length === 2)
  assert.equal(branchLists, 4, 'a moved head re-walks the Store')
  assert.equal(manifestReads, 2)
})

// The metadata projection the UI's annotations read uses: title, checkpoints,
// the receipt counter and archive, never the lazy receipts array. The lazy
// getter throwing proves the op never materializes it; the paged receipts op is
// the only way to read rows, and it is bounded.
test('session.annotations answers sidecar metadata only; session.receipts pages the rows', async () => {
  const ops = {}
  const calls = []
  let reads = 0
  const sidecar = {
    version: 1, sessionId: 'live', project: 'st/app', title: 'A long session',
    checkpoints: [{ commit: 'c1' }, { commit: 'c2' }],
    receipts: { version: 1, reads: { 'workspace.status': { count: 83_250, lastAt: 1, lastOutcome: 'success' } }, readsTotal: 83_250, dropped: 0, cap: 5000, truncated: false },
    archive: { count: 1, updatedAt: 2 },
  }
  Object.defineProperty(sidecar, 'invocations', {
    enumerable: true, configurable: true,
    get: () => { reads++; throw new Error('session.annotations read the receipts array') },
  })
  const persistence = {
    readSidecar: async (id, options) => { calls.push({ read: 'sidecar', id, options }); return sidecar },
    readReceipts: async (id, options) => {
      calls.push({ read: 'receipts', id, options })
      return { invocations: [{ id: 'r1' }], total: 1, from: 0, truncated: false, dropped: 0, skipped: 0, bytes: 0 }
    },
  }
  const ctx = {
    layerfs: { state: '/lfs-root', scratchProject: 'dsh-scratch/scratch', lfs: {}, emit() {}, outputs: '/lfs-root/trace/outputs' },
    layerfsSessions: {},
    layerfsRemote: { operate: (_ctx, table) => Object.assign(ops, table) },
    plugin() {},
    inject: (deps, callback) => { if (deps.includes('layerfsSessions')) callback(ctx) },
    on() {},
    effect() {},
    get: (name) => name === 'sessionPersistence' ? persistence : undefined,
    logger: () => ({ warn() {}, info() {} }),
    workspaceRegistry: { archivedSessionIds: [] },
  }
  S.applySessionsIndex(ctx)
  const annotations = await ops['session.annotations']({ sessionId: 'live' })
  assert.equal(reads, 0, 'the metadata answer never touched the receipts array')
  assert.deepEqual(calls, [{ read: 'sidecar', id: 'live', options: { cached: true } }])
  assert.equal('invocations' in annotations, false, 'no receipts array in the answer')
  assert.equal(annotations.title, 'A long session')
  assert.deepEqual(annotations.checkpoints, [{ commit: 'c1' }, { commit: 'c2' }])
  assert.equal(annotations.receipts.readsTotal, 83_250)
  assert.deepEqual(annotations.archive, { count: 1, updatedAt: 2 })
  assert.ok(Buffer.byteLength(JSON.stringify(annotations)) < 2048, 'metadata-sized, not sidecar-sized')

  const page = await ops['session.receipts']({ sessionId: 'live', from: -1 })
  assert.deepEqual(page.invocations, [{ id: 'r1' }])
  assert.deepEqual(calls.at(-1), { read: 'receipts', id: 'live', options: { from: -1, limit: 1000 } })
  await ops['session.receipts']({ sessionId: 'live' })
  assert.deepEqual(calls.at(-1), { read: 'receipts', id: 'live', options: { limit: 1000 } })

  for (const bad of [{}, { sessionId: '' }, { sessionId: 'live', from: 1.5 }, { sessionId: 'live', from: '1' },
    { sessionId: 'live', limit: 0 }, { sessionId: 'live', limit: 1001 }, { sessionId: 'live', limit: 1.5 }]) {
    await assert.rejects(() => ops['session.receipts'](bad), (error) => error.code === 'InvalidInput')
  }
})

test('a choice that fails after moving the owner route moves the route back', async () => {
  const lfs = { project: { get: async (key) => ({ key }) } }
  const { s, state } = sessions({ lfs, layerfsRoot: mkdtempSync(join(tmpdir(), 'dsh-choose-undo-')) })
  const root = s.ctx.layerfs.state
  s.ctx.sessions.get = (id) => session(id, { cwd: '/Users/me/repo' })
  // The persistence row's public face: owner routes in owners.json, moved by migrateProject.
  const owners = { kept: 'st/old' }
  const moves = []
  const persistence = {
    ownerOf: (id) => owners[id] ? { project: owners[id] } : undefined,
    migrateProject: async (live, project) => {
      const id = typeof live === 'string' ? live : live.id
      moves.push([id, project])
      if (project) owners[id] = project
      else delete owners[id]
    },
  }
  // Any step after the route move can fail; here the agents service does.
  s.ctx.get = (name) => name === 'sessionPersistence' ? persistence : name === 'agents' ? { get: () => { throw new Error('agents unavailable') } } : undefined
  await assert.rejects(s.choose('draft', 'st/app'), /agents unavailable/)
  assert.equal(state().pending.draft, undefined, 'no pending placement')
  assert.equal(persistence.ownerOf('draft'), undefined, 'and no owner route: no hidden owned draft is left behind')
  assert.deepEqual(moves, [['draft', 'st/app'], ['draft', null]])
  // A draft that was already owned keeps its owner.
  await assert.rejects(s.choose('kept', 'st/new'), /agents unavailable/)
  assert.deepEqual(persistence.ownerOf('kept'), { project: 'st/old' })
  rmSync(root, { recursive: true, force: true })
})
