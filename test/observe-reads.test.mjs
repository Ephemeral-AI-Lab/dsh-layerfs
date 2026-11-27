// Observed session reads (`session.state {observe: true}`, the conversation
// views' polls): what one read costs and where it goes (opt-in `debug`), how
// long a successful identity, readiness and whole answer may stand, and that a
// change forces a fresh answer.
//   node --test test/observe-reads.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
const out = mkdtempSync(join(root, 'lib', '.test-observe-reads-'))
await build({
  absWorkingDir: root,
  stdin: {
    contents: [
      "export * from './src/host/sessions/service.ts'",
      "export { initialState } from './src/host/sessions/state.ts'",
    ].join('\n'),
    resolveDir: root,
    loader: 'ts',
  },
  outfile: join(out, 'observe.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  external: ['@deepseek-ai/*'],
  logLevel: 'warning',
})
const S = await import(pathToFileURL(join(out, 'observe.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

class Refusal extends Error {
  constructor(code, message = code) { super(message); this.code = code }
}

/** One session bound to `store/app` on machine `vm`, in Workspace `box:main`. */
function liveState(over = {}) {
  const state = S.initialState()
  state.sessions.live = {
    sessionId: 'live', kind: 'project', project: 'store/app', machine: 'vm', anchor: '/anchor', scratch: '/scratch',
    sandbox: 'box', ws: 'box:main', mount: '/mnt/box', branch: 'retained', restores: 0, state: 'bound', executionState: 'active',
    createdAt: 1, updatedAt: 1, ...over,
  }
  state.checkpoints.live = [{ kind: 'turn', turn: 1, seq: 1, endSeq: 1, commit: 'saved', changed: 1, message: 'saved', at: 1 }]
  return state
}

/**
 * A LayerfsSessions over in-memory state and a fake lfs that records every
 * call, as test/sessions.test.mjs builds it. `storeState`/`machineState` are
 * read per call, so a test can flip them between reads.
 */
function fixture(state = liveState()) {
  const calls = []
  const facts = { machine: 'ready', store: 'ready' }
  const lfs = {
    machine: { get: async () => { calls.push('machine'); return { machine: 'vm', state: facts.machine } } },
    store: {
      get: async () => { calls.push('store'); return facts.store === 'ready' ? { store: 'store', engine: 'sqlite', state: 'ready' } : { store: 'store', engine: 'sqlite', state: 'blocked', blocked_by: { machine: 'vm', reason: 'stopped' } } },
      list: async () => { calls.push('list'); return { items: [{ store: 'store', engine: 'sqlite', state: facts.store === 'ready' ? 'ready' : 'blocked', ...(facts.store === 'ready' ? {} : { blocked_by: { machine: 'vm', reason: 'stopped' } }) }] } },
    },
    workspace: { status: async (_ws, options) => { calls.push(`status:${options?.detail === true}`); return { overlay: { inode_count: 2 } } } },
  }
  const s = Object.create(S.LayerfsSessions.prototype)
  const events = []
  const ctx = {
    layerfs: { root: '/lfs-root', scratchProject: 'dsh-scratch/scratch', lfs, emit: (type, data) => events.push({ type, data }), ensureHostDaemon: async () => {} },
    sessions: { get: () => undefined },
    logger: () => ({ warn() {}, info() {} }),
  }
  let value = state
  Object.defineProperty(s, 'ctx', { value: ctx })
  Object.defineProperty(s, 'state', { value: { read: () => value, update(fn) { const draft = structuredClone(value); value = fn(draft) ?? draft; return value } } })
  Object.defineProperty(s, 'lanes', { value: new Map() })
  Object.defineProperty(s, 'storeHealth', { value: new Map() })
  Object.defineProperty(s, 'serverChecked', { value: new Map() })
  s.ctx.get = (name) => name === 'sessionPersistence' ? {
    assertSessionIdentity: async () => { calls.push('identity'); return { key: 'store/app', store: 'store', machine: 'vm' } },
    projectIdOf: () => 'permanent-id',
    local: { stat: async () => ({ eventCount: 5 }) },
  } : undefined
  return { s, calls, facts, events, state: () => value }
}

test('one observed read reports its split under debug: identity, readiness, Workspace status and the host remainder', async () => {
  const f = fixture()
  const slow = () => new Promise((resolve) => setTimeout(resolve, 2))
  f.s.ctx.get = () => ({
    assertSessionIdentity: async () => { f.calls.push('identity'); await slow(); return { key: 'store/app', store: 'store', machine: 'vm' } },
    projectIdOf: () => 'permanent-id',
    local: { stat: async () => ({ eventCount: 5 }) },
  })
  f.s.ctx.layerfs.lfs.machine.get = async () => { f.calls.push('machine'); await slow(); return { machine: 'vm', state: 'ready' } }
  f.s.ctx.layerfs.lfs.store.get = async () => { f.calls.push('store'); await slow(); return { store: 'store', engine: 'sqlite', state: 'ready' } }
  f.s.ctx.layerfs.lfs.workspace.status = async (_ws, options) => { f.calls.push(`status:${options?.detail === true}`); await slow(); return { overlay: { inode_count: 2 } } }
  const view = await f.s.view('live', { observe: true, debug: true })
  const timing = view.timing
  assert.ok(timing, 'debug adds timing')
  assert.equal(timing.memo, false)
  assert.deepEqual(timing.calls, { identity: 2, readiness: 2, status: 1 }, 'project.get + branch.list, machine.get + store.get, workspace status --detail')
  for (const step of ['identity', 'readiness', 'status']) assert.ok(timing.phases[step] >= 1.5, `${step} is timed`)
  assert.ok(timing.phases.total >= timing.phases.identity + timing.phases.readiness + timing.phases.status, 'the named steps fit in the total')
  assert.ok(timing.phases.other >= 0, 'the host remainder is reported')
  assert.deepEqual(f.calls, ['identity', 'machine', 'store', 'status:true'])

  // A plain repeat answers the memo: same payload, no calls, no phase work.
  f.calls.length = 0
  const again = await f.s.view('live', { observe: true, debug: true })
  assert.deepEqual(again, { ...view, timing: again.timing })
  assert.equal(again.timing.memo, true)
  assert.deepEqual(again.timing.calls, { identity: 0, readiness: 0, status: 0 })
  assert.deepEqual(f.calls, [], 'the memo costs no CLI call')
  assert.deepEqual(again.status, view.status, 'the memo still carries the live status')
})

test('a plain repeat is the memo: the same payload shape and no CLI call', async () => {
  const f = fixture()
  const first = await f.s.view('live', { observe: true })
  assert.deepEqual(f.calls, ['identity', 'machine', 'store', 'status:true'])
  f.calls.length = 0
  const second = await f.s.view('live', { observe: true })
  assert.deepEqual(second, first)
  assert.deepEqual(f.calls, [])
  // ... but an explicit (non-observe) read never uses the memo.
  const explicit = await f.s.view('live')
  assert.deepEqual(explicit, first)
  assert.deepEqual(f.calls, ['identity', 'machine', 'store', 'status:true'])
})

test('the 12 s identity window and the 30 s readiness window stand after a gap, while the 8 s memo stays under the poll', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const f = fixture()
  const at = async () => { const view = await f.s.view('live', { observe: true }); assert.equal(view.execution.available, true); return view }
  await at()
  assert.deepEqual(f.calls, ['identity', 'machine', 'store', 'status:true'])
  // Inside the memo window: nothing at all.
  f.calls.length = 0
  t.mock.timers.tick(7_500)
  await at()
  assert.deepEqual(f.calls, [])
  // A gap past the identity window but inside readiness: identity is read
  // again, the machine and Store still stand, the Workspace status stays fresh.
  f.calls.length = 0
  t.mock.timers.tick(13_000)
  await at()
  assert.deepEqual(f.calls, ['identity', 'status:true'])
  // A gap past the readiness window too: the machine and Store are asked again.
  f.calls.length = 0
  t.mock.timers.tick(31_000)
  await at()
  assert.deepEqual(f.calls, ['identity', 'machine', 'store', 'status:true'])
  // A poll inside both renewed windows after the memo: the status alone.
  f.calls.length = 0
  t.mock.timers.tick(10_500)
  await at()
  assert.deepEqual(f.calls, ['status:true'])
})

test('a steady 10.5 s poll is one CLI: identity and readiness stand until their 60 s hard re-check', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const f = fixture()
  const read = () => f.s.view('live', { observe: true, debug: true })
  const total = (view) => Object.values(view.timing.calls).reduce((sum, n) => sum + n, 0)
  // A cold read (no memo) pays the full path: project.get + branch.list,
  // machine.get + store.get, workspace.status --detail.
  const first = await read()
  assert.deepEqual(first.timing.calls, { identity: 2, readiness: 2, status: 1 })
  assert.equal(total(first), 5, 'the first read is five CLI calls')
  // The views poll every 10 s through a 500 ms coalescing timer (~10.5 s).
  // Every reuse renews both checks, so a steady poll is the Workspace status.
  for (let poll = 1; poll <= 5; poll++) {
    f.calls.length = 0
    t.mock.timers.tick(10_500)
    const view = await read()
    assert.deepEqual(view.timing.calls, { identity: 0, readiness: 0, status: 1 }, `poll ${poll}: identity and readiness stand`)
    assert.deepEqual(f.calls, ['status:true'], `poll ${poll}: the Workspace status is the only CLI call`)
  }
  // The hard re-check: both checks are 63 s old, so this poll reads identity,
  // the machine, the Store and the Workspace status again.
  f.calls.length = 0
  t.mock.timers.tick(10_500)
  const refreshed = await read()
  assert.deepEqual(refreshed.timing.calls, { identity: 2, readiness: 2, status: 1 }, 'the 60 s hard re-check')
  assert.deepEqual(f.calls, ['identity', 'machine', 'store', 'status:true'])
})

test('every invalidator clears a steady poll, and the full five-CLI path returns', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const full = { identity: 2, readiness: 2, status: 1 }
  const reattach = (f) => f.s.save({ ...f.state().sessions.live, state: 'bound', executionState: 'active', ws: 'box:main', mount: '/mnt/box', error: undefined, interruption: undefined })
  // What the very next read pays after each invalidator: a detached or
  // interrupted session has no Workspace status to read, so its full path is
  // identity + readiness (and a health refusal stops before the status). The
  // restore only puts a healthy bound session back; it never runs before the
  // first post-invalidation read, so that read proves the invalidator itself
  // cleared the memo. The machine-stop case uses a session without a Sandbox,
  // so the stop clears the memo but does not interrupt the binding; the restart
  // then shows the full five.
  const cases = [
    ['a saved binding', (f) => f.s.save({ ...f.state().sessions.live, error: undefined }), full, () => {}],
    ['a mount', (f) => f.s.save({ ...f.state().sessions.live, mount: '/mnt/other' }), full, () => {}],
    ['a detach', (f) => f.s.save({ ...f.state().sessions.live, mount: undefined, ws: undefined, state: 'closed', executionState: 'inactive' }), { identity: 2, readiness: 2, status: 0 }, reattach],
    ['an interrupt', (f) => f.s.interrupt('live', 'stopped by the test', 'blocked'), { identity: 2, readiness: 2, status: 0 }, reattach],
    ['a branch change', (f) => f.s.save({ ...f.state().sessions.live, branch: 'dsh.live.r1', restores: 1 }), full, () => {}],
    ['a Store health flip', async (f) => { f.facts.store = 'blocked'; await f.s.refreshAvailability() }, { identity: 2, readiness: 0, status: 0 }, (f) => { f.facts.store = 'ready'; reattach(f) }],
    ['a machine stop', (f) => { f.facts.machine = 'stopped'; f.s.machinesStopped(['vm']); f.facts.machine = 'ready' }, full, () => {}],
  ]
  for (const [label, invalidate, expected, restore] of cases) {
    const f = fixture(label === 'a machine stop' ? liveState({ sandbox: undefined }) : liveState())
    const first = await f.s.view('live', { observe: true, debug: true })
    assert.deepEqual(first.timing.calls, full, `${label}: the first read is full`)
    f.calls.length = 0
    t.mock.timers.tick(10_500)
    const steady = await f.s.view('live', { observe: true, debug: true })
    assert.deepEqual(steady.timing.calls, { identity: 0, readiness: 0, status: 1 }, `${label}: a steady poll is the status`)
    f.calls.length = 0
    await invalidate(f)
    const fresh = await f.s.view('live', { observe: true, debug: true })
    assert.deepEqual(fresh.timing.calls, expected, `${label}: the remembered checks are gone`)
    if (label === 'a detach' || label === 'an interrupt' || label === 'a Store health flip') {
      assert.ok(f.calls.includes('machine') && f.calls.includes('store'), `${label}: readiness is read again`)
    }
    if (label === 'a Store health flip') assert.equal(fresh.execution.available, false, `${label}: the refusal is fresh, never a memo`)
    if (expected.status === 0) {
      // Detached/interrupted: put a bound Workspace back and read it healthily.
      restore(f)
      const after = await f.s.view('live', { observe: true, debug: true })
      assert.deepEqual(after.timing.calls, full, `${label}: the next healthy read is the full five CLI`)
    }
  }
})

test('a new event and a new checkpoint force a fresh answer', async () => {
  const f = fixture()
  const live = { seq: 3, snapshotEvents: () => [] }
  f.s.ctx.sessions.get = () => live
  await f.s.view('live', { observe: true })
  f.calls.length = 0
  await f.s.view('live', { observe: true })
  assert.deepEqual(f.calls, [], 'nothing moved: the memo')
  live.seq = 4
  await f.s.view('live', { observe: true })
  assert.deepEqual(f.calls, ['status:true'], 'a new event reads the Workspace status again (identity and readiness still stand)')
  f.calls.length = 0
  f.s.markTurnEnd('live', 1, 4)
  f.state().checkpoints.live.push({ kind: 'turn', turn: 2, seq: 4, commit: 'next', changed: 1, message: 'next', at: 2 })
  await f.s.view('live', { observe: true })
  assert.deepEqual(f.calls, ['status:true'], 'a new checkpoint forces a fresh answer')
})

test('a mount, a detach and a branch change each force a fresh answer', async () => {
  const f = fixture()
  const first = await f.s.view('live', { observe: true })
  assert.equal(first.binding.mount, '/mnt/box')
  for (const [label, over] of [
    ['a new mount', { mount: '/mnt/other' }],
    ['a detach', { mount: undefined, ws: undefined, state: 'closed', executionState: 'inactive' }],
    ['a branch change', { branch: 'dsh.live.r1', restores: 1, state: 'bound', ws: 'box:main', mount: '/mnt/box', executionState: 'active' }],
  ]) {
    f.calls.length = 0
    f.s.save({ ...f.state().sessions.live, ...over })
    const view = await f.s.view('live', { observe: true })
    assert.ok(f.calls.includes('identity'), `${label}: identity is read again`)
    assert.equal(view.binding.sessionId, 'live')
    // leave the next step a bound session again
    if (over.state === 'closed') f.s.save({ ...f.state().sessions.live, state: 'bound', executionState: 'active', ws: 'box:main', mount: '/mnt/box' })
  }
})

test('a machine stop forces a fresh answer, and its refusal is never the memo', async () => {
  const f = fixture()
  await f.s.view('live', { observe: true })
  assert.equal((await f.s.view('live', { observe: true })).execution.available, true)
  f.facts.machine = 'stopped'
  f.calls.length = 0
  f.s.machinesStopped(['vm'])
  const stopped = await f.s.view('live', { observe: true })
  assert.equal(stopped.execution.available, false)
  assert.match(String(stopped.execution.reason), /not ready/, 'the stopped machine is named')
  assert.ok(f.calls.includes('machine'), 'the machine is asked again')
  f.calls.length = 0
  const again = await f.s.view('live', { observe: true })
  assert.equal(again.execution.available, false)
  assert.deepEqual(f.calls, ['identity', 'machine'], 'a refusal is not cached: identity and the machine are asked again')
})

test('a Store health flip forces a fresh answer', async () => {
  const f = fixture()
  await f.s.view('live', { observe: true })
  assert.equal((await f.s.view('live', { observe: true })).execution.available, true)
  f.facts.store = 'blocked'
  await f.s.refreshAvailability()
  assert.equal(f.s.availability().store?.state, 'unavailable', 'the poll noticed the flip')
  f.calls.length = 0
  const view = await f.s.view('live', { observe: true })
  assert.equal(view.execution.available, false)
  assert.match(String(view.execution.reason), /machine of Store store/i)
  assert.ok(f.calls.includes('store'), 'the Store is asked again')
})

test('a refused workspace status is answered as unavailable and is not memoised', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const f = fixture()
  await f.s.view('live', { observe: true })
  f.s.ctx.layerfs.lfs.workspace.status = async () => { f.calls.push('status'); throw new Refusal('Timeout', 'workspace status timed out') }
  // Past the memo window (the poll's cadence): the status is read again.
  t.mock.timers.tick(8_500)
  f.calls.length = 0
  const refused = await f.s.view('live', { observe: true })
  assert.equal(refused.execution.available, false)
  assert.match(String(refused.execution.reason), /timed out/)
  // The failure is not memoised: the next read asks again.
  f.calls.length = 0
  const again = await f.s.view('live', { observe: true })
  assert.equal(again.execution.available, false)
  assert.deepEqual(f.calls, ['status'], 'the status is read again, not answered from the successful memo')
})
