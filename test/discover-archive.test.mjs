// A list read never waits for the Store walk it triggers: it answers what the
// last walk knew, the walk finishes behind the call and emits one
// `layerfs-session` change event, and the next read has the rows it found (or
// has lost the ones that are gone).
//   node --test test/discover-archive.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-discover-archive-'))
await build({
  absWorkingDir: root,
  stdin: {
    contents: "export { SessionStore } from './src/host/sessions/store.ts'\nexport * from './src/host/sessions/service.ts'\nexport { initialState } from './src/host/sessions/state.ts'\nexport { apply as applySessionsIndex } from './src/host/sessions/index.ts'\n",
    resolveDir: root,
    loader: 'ts',
  },
  outfile: join(out, 'discover.mjs'),
  bundle: true, format: 'esm', platform: 'node', target: 'node24',
  external: ['@deepseek-ai/*'],
  logLevel: 'warning',
})
const S = await import(pathToFileURL(join(out, 'discover.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

const tick = () => new Promise((r) => setTimeout(r, 0))
async function until(what, ready, ms = 3000) {
  const end = Date.now() + ms
  for (;;) {
    if (ready()) return
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await tick()
  }
}
/** A promise the test opens when the walk may finish (a pending manifest read). */
function gate() {
  let open
  const waiting = new Promise((resolve) => { open = resolve })
  return { waiting, open }
}

/**
 * A SessionStore over a fake Store: `heads` is the Branch list's change token
 * (`branch -> head`), `titles` lets a manifest change without moving its head,
 * and a `gate` keeps a manifest read pending so the walk can be observed
 * mid-flight.
 */
function storeHarness({ heads = {}, titles = {}, gate: pending } = {}) {
  const events = []
  const reads = []
  let lists = 0
  const manifest = (branch) => ({
    version: 3, kind: 'dsh-session', sessionId: branch.slice('dsh.session.'.length), projectId: 'p',
    title: `${branch}@${titles[branch] ?? heads[branch]}`, count: 3, checkpoints: [], updatedAt: 1,
    bindingKind: 'project', header: { version: 4 },
  })
  const lfs = {
    branch: {
      list: async (_project, options = {}) => {
        lists++
        const items = [{ branch: 'main', commit: 'm' }, ...Object.entries(heads).map(([branch, commit]) => ({ branch, commit }))]
        return { items: items.filter((b) => !options.prefix || b.branch.startsWith(options.prefix)) }
      },
    },
    file: {
      read: async (_project, branch) => {
        reads.push(branch)
        if (pending) await pending.waiting
        const text = `${JSON.stringify(manifest(branch))}\n`
        return { text, next_line: null, line_truncated: false, binary: false, size: Buffer.byteLength(text), start_line: 1, end_line: 1 }
      },
    },
  }
  const ctx = new Context()
  ctx.provide('layerfs', { root: '/lfs-root', lfs, emit: (type, data) => events.push({ type, data }) })
  const sessions = {
    binding: () => undefined, lane: (_key, run) => run(), checkpoints: () => [], attach: async () => {},
    state: {
      read: () => ({ projects: {}, sessions: {}, pending: {}, checkpoints: {}, mirror: {} }),
      update: () => {},
    },
  }
  const store = new S.SessionStore(ctx, sessions)
  return {
    store, events, reads, heads, titles,
    /** The list read `sessions.list` makes: it names the live identity and what it stat'ed. */
    list: (identity = 'pid-1') => store.discover('s/p', { identity, local: () => undefined }),
    discovered: () => events.filter((e) => e.type === 'layerfs-session' && e.data?.discovery === true),
    branchLists: () => lists,
    setGate: (next) => { pending = next },
  }
}

test('a cold list answers at once, then the walk lands behind it with one change event', async () => {
  const pending = gate()
  const h = storeHarness({ heads: { 'dsh.session.a': 'c1', 'dsh.session.b': 'c2' }, gate: pending })
  const first = await h.list()
  assert.deepEqual(first, [], 'no stored row is known yet')
  assert.equal(h.discovered().length, 0, 'the walk has not landed')
  assert.deepEqual(h.reads, ['dsh.session.a'], 'the walk is reading manifests behind the call')
  // A second list while the walk runs answers known rows and starts no second walk.
  const second = await h.list()
  assert.deepEqual(second, [])
  assert.equal(h.branchLists(), 2, 'each listing reads the Branch list: that is its change token')
  assert.deepEqual(h.reads, ['dsh.session.a'], 'the running walk is not started twice')
  pending.open()
  await until('the walk lands', () => h.discovered().length > 0)
  assert.equal(h.discovered().length, 1, 'one change event, once')
  assert.deepEqual(h.discovered()[0].data, { project: 's/p', discovery: true })
  assert.equal(h.reads.length, 2, 'one manifest read per stored session, not per walk')
  const third = await h.list()
  assert.deepEqual(third.map((row) => row.sessionId).sort(), ['a', 'b'], 'the rows the walk found show on the next read')
  assert.equal(h.reads.length, 2, 'unchanged heads: no manifest is read again')
  assert.equal(h.discovered().length, 1, 'a memo hit announces nothing')
})

test('a row that disappeared from the Store is dropped on the read after the walk', async () => {
  const h = storeHarness({ heads: { 'dsh.session.a': 'c1', 'dsh.session.b': 'c2' } })
  // Prime the answer the way a first list does: it answers nothing, the walk lands.
  assert.deepEqual(await h.list(), [])
  await until('the walk lands', () => h.discovered().length === 1)
  assert.deepEqual((await h.list()).map((row) => row.sessionId).sort(), ['a', 'b'])
  assert.equal(h.reads.length, 2, 'the primed answer needs no further manifest read')
  // Another process removed b and saved a: the next list answers the known rows
  // at once, and the walk behind it drops b.
  delete h.heads['dsh.session.b']
  h.heads['dsh.session.a'] = 'c2'
  const pending = gate()
  h.setGate(pending)
  const during = await h.list()
  assert.deepEqual(during.map((row) => row.sessionId).sort(), ['a', 'b'], 'the list keeps its rows while the walk runs')
  pending.open()
  await until('the walk lands', () => h.discovered().length === 2)
  const after = await h.list()
  assert.deepEqual(after.map((row) => row.sessionId), ['a'], 'the row the walk did not find is gone on the next read')
  assert.equal(after[0].title, 'dsh.session.a@c2')
})

test('a local write invalidates the answer at once: known rows stay, the next read re-walks', async () => {
  const h = storeHarness({ heads: { 'dsh.session.a': 'c1' }, titles: { 'dsh.session.a': 'first' } })
  assert.deepEqual(await h.list(), [])
  await until('the first walk lands', () => h.discovered().length === 1)
  assert.deepEqual((await h.list()).map((row) => row.title), ['dsh.session.a@first'])
  assert.equal(h.reads.length, 1)
  // A save of ours moved the head and changed the row; the write path invalidates
  // the answer before it returns, so the next list may not serve it as current.
  h.heads['dsh.session.a'] = 'c2'
  h.titles['dsh.session.a'] = 'second'
  h.store.invalidateDiscovery('s/p')
  const pending = gate()
  h.setGate(pending)
  const known = await h.list()
  assert.deepEqual(known.map((row) => row.title), ['dsh.session.a@first'], 'the last answer is still shown, not dropped')
  assert.equal(h.reads.length, 2, 'the invalidation walked the saved Branch again behind the list')
  pending.open()
  await until('the walk lands', () => h.discovered().length === 2)
  assert.deepEqual((await h.list()).map((row) => row.title), ['dsh.session.a@second'], 'the write shows on the event-driven read')
})

test('a fresh lookup still waits for the Store', async () => {
  const pending = gate()
  const h = storeHarness({ heads: { 'dsh.session.a': 'c1' }, gate: pending })
  let settled = false
  const lookup = h.store.discover('s/p', { fresh: true })
  void lookup.then(() => { settled = true }, () => { settled = true })
  await tick()
  assert.equal(settled, false, 'a lookup of a stored session waits for its manifest')
  pending.open()
  assert.deepEqual((await lookup).map((row) => row.sessionId), ['a'])
  assert.equal(h.discovered().length, 0, 'a lookup emits no list change event')
})

/** The sessions plugin's own state, without cordis (as test/sessions.test.mjs builds it). */
function sessions({ state = S.initialState(), lfs = {}, layerfsRoot = '/lfs-root' } = {}) {
  const s = Object.create(S.LayerfsSessions.prototype)
  const ctx = {
    layerfs: { root: layerfsRoot, scratchProject: 'dsh-scratch/scratch', lfs, emit: () => {}, ensureHostDaemon: async () => {} },
    sessions: { get: () => undefined },
    logger: () => ({ warn() {}, info() {} }),
  }
  let value = state
  Object.defineProperty(s, 'ctx', { value: ctx })
  Object.defineProperty(s, 'state', { value: { read: () => value, update(fn) { const d = structuredClone(value); value = fn(d) ?? d; return value } } })
  Object.defineProperty(s, 'lanes', { value: new Map() })
  Object.defineProperty(s, 'storeHealth', { value: new Map() })
  Object.defineProperty(s, 'serverChecked', { value: new Map() })
  return { s, state: () => value }
}

test('sessions.list returns while the walk is still reading manifests, then the event brings the row', async () => {
  const pending = gate()
  let branchLists = 0, manifestReads = 0
  const manifest = {
    version: 3, kind: 'dsh-session', sessionId: 'stored1', projectId: 'pid-1', title: 'Stored one',
    count: 1, checkpoints: [], updatedAt: 10, bindingKind: 'project',
    header: { version: 4, id: 'stored1', createdAt: 10, isSeeded: false, delegationDepth: 0 },
  }
  const lfs = {
    branch: { list: async () => { branchLists++; return { items: [{ branch: 'dsh.session.stored1', commit: 'c1' }] } } },
    file: {
      read: async () => {
        manifestReads++
        await pending.waiting
        const text = `${JSON.stringify(manifest)}\n`
        return { text, size: Buffer.byteLength(text), start_line: 1, line_truncated: false, next_line: null }
      },
    },
  }
  const events = []
  const persistence = {
    stat: async () => undefined, readSidecar: async () => undefined, ownedSessionIds: () => [],
    projectIdOf: () => undefined, catalog: { assert: async () => ({ projectId: 'pid-1' }) },
  }
  const f = sessions({ state: S.initialState() })
  const ops = {}
  const ctx = {
    layerfs: { root: '/lfs-root', scratchProject: 'dsh-scratch/scratch', lfs, emit: (type, data) => events.push({ type, data }), callLog: {} },
    layerfsSessions: f.s,
    layerfsRemote: { operate: (_ctx, table) => Object.assign(ops, table) },
    plugin() {}, inject: (deps, callback) => { if (deps.includes('layerfsSessions')) callback(ctx) }, on() {}, effect() {},
    get: (name) => name === 'sessionPersistence' ? persistence : undefined,
    logger: () => ({ warn() {}, info() {} }),
    workspaceRegistry: { archivedSessionIds: [] },
  }
  S.applySessionsIndex(ctx)
  const list = () => ops['sessions.list']({ project: 'st/app', projectId: 'pid-1', localOnly: false, debug: true })
  const announcements = () => events.filter((e) => e.type === 'layerfs-session' && e.data?.discovery === true)

  const first = await list()
  assert.deepEqual(first.sessions, [], 'the cold read paints no stored rows yet')
  assert.equal(first.discoveryError ?? null, null)
  assert.equal(branchLists, 1, 'one Branch list inline: the change token')
  assert.equal(manifestReads, 1, 'the walk started behind the call')
  const second = await list()
  assert.deepEqual(second.sessions, [], 'a second read during the walk answers known rows')
  assert.equal(branchLists, 2, 'each read lists the Branches')
  assert.equal(manifestReads, 1, 'the running walk is not started twice')
  pending.open()
  await until('the walk lands', () => announcements().length === 1)
  assert.deepEqual(announcements()[0].data, { project: 'st/app', discovery: true })
  const third = await list()
  assert.deepEqual(third.sessions.map((row) => row.sessionId), ['stored1'], 'the stored row shows on the event-driven read')
  assert.equal(third.sessions[0].stored, true)
  assert.equal(branchLists, 3)
  assert.equal(manifestReads, 1, 'unchanged heads: the manifest is not read again')
  assert.equal(announcements().length, 1, 'a memo hit announces nothing')
})
