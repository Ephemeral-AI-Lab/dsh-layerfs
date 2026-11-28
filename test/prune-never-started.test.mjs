// Never-started project conversations (the empty "New session / Not started"
// rows): sessions.list leaves them out unless they are the open one, and
// sessions.pruneNeverStarted deletes exactly the proven-blank ones.
//   node --test test/prune-never-started.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-prune-'))
await build({
  absWorkingDir: root,
  stdin: {
    contents: "export * from './src/host/sessions/service.ts'\nexport { initialState } from './src/host/sessions/state.ts'\nexport { apply as applySessionsIndex } from './src/host/sessions/index.ts'\n",
    resolveDir: root,
    loader: 'ts',
  },
  outfile: join(out, 'prune.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  external: ['@deepseek-ai/*'],
  logLevel: 'warning',
})
const S = await import(pathToFileURL(join(out, 'prune.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

/** A metadata-only log, as opening a New Session writes it. */
const blankLog = (n = 3) => ['session', 'permission/preset', 'sandbox/mode', 'approval/policy', 'agent-preset/selected'].slice(0, n).map((type) => ({ type, data: {} }))
const startedLog = () => [{ type: 'session', data: {} }, { type: 'turn/start', data: { turn: 1 } }, { type: 'user/message', data: {} }, { type: 'assistant/message', data: {} }]
const project = 'st/app'
const binding = (sessionId, extra = {}) => ({ sessionId, kind: 'project', project, anchor: '/anchor', scratch: '/scratch', state: 'closed', createdAt: 1, updatedAt: 2, ...extra })

/**
 * A LayerfsSessions over in-memory state with a fake persistence row: `logs`
 * maps ids to their events (no entry = no log), `sidecars` to their metadata,
 * and `loaded` is the set of conversations DSH has loaded (the open ones).
 */
function harness({ state = S.initialState(), logs = {}, sidecars = {}, loaded = new Set() } = {}) {
  const events = []
  const deletedSessions = []
  const snapshots = (id) => logs[id] ? { header: { id, createdAt: 1 }, revision: `r${logs[id].length}`, eventCount: logs[id].length } : undefined
  const persistence = {
    local: {
      stat: async (id) => snapshots(id),
      open: async (id) => {
        if (!logs[id]) throw Object.assign(new Error('not found'), { code: 'NotFound' })
        return { read: async (offset = 0, length) => ({ events: logs[id].slice(offset, length === undefined ? undefined : offset + length) }), close: async () => {} }
      },
    },
    stat: async (id) => snapshots(id),
    readSidecar: async (id) => sidecars[id],
    deleteSessions: async (ids) => { deletedSessions.push(...ids); for (const id of ids) delete logs[id]; return ids },
    ownedSessionIds: () => [],
    projectIdOf: () => undefined,
    catalog: { assert: async () => ({ projectId: 'pid-1' }) },
  }
  const catalog = { get: (id) => loaded.has(id) ? { id, header: { id }, snapshotEvents: () => logs[id] ?? [] } : undefined }
  const ops = {}
  const ctx = {
    layerfs: { root: '/lfs-root', lfs: {}, emit: (type, data) => events.push({ type, data }), outputs: '/lfs-root/trace/outputs', ensureHostDaemon: async () => {} },
    layerfsRemote: { operate: (_ctx, table) => Object.assign(ops, table) },
    plugin() {},
    inject: (deps, callback) => { if (deps.includes('layerfsSessions')) callback(ctx) },
    on() {},
    effect() {},
    get: (name) => name === 'sessionPersistence' ? persistence : name === 'sessions' ? catalog : undefined,
    logger: () => ({ warn() {}, info() {} }),
    workspaceRegistry: { archivedSessionIds: [] },
  }
  // The service itself, over the same in-memory state and context.
  const sessions = Object.create(S.LayerfsSessions.prototype)
  let value = state
  Object.defineProperty(sessions, 'ctx', { value: ctx })
  Object.defineProperty(sessions, 'state', { value: { read: () => value, update(fn) { const next = structuredClone(value); value = fn(next) ?? next; return value } } })
  Object.defineProperty(sessions, 'lanes', { value: new Map() })
  Object.defineProperty(sessions, 'storeHealth', { value: new Map() })
  Object.defineProperty(sessions, 'serverChecked', { value: new Map() })
  ctx.layerfsSessions = sessions
  S.applySessionsIndex(ctx)
  return { ctx, ops, sessions, persistence, events, deletedSessions, state: () => value, loaded }
}

const listIds = async (f, extra = {}) => (await f.ops['sessions.list']({ project, localOnly: true, ...extra })).sessions.map((row) => row.sessionId).sort()

test('sessions.list hides a never-started draft, keeps the current and loaded ones, and shows it once it starts', async () => {
  const state = S.initialState()
  state.pending.draft = { project }
  state.pending.open = { project }
  state.sessions.used = binding('used')
  // A bound-but-never-used draft is hidden too.
  state.sessions.closedDraft = binding('closedDraft')
  const logs = { draft: blankLog(), open: blankLog(2), used: startedLog(), closedDraft: blankLog(4) }
  const f = harness({ state, logs, sidecars: { used: { title: 'Used conversation' } } })
  // An idle draft (pending or bound) is not a conversation; the current selection and a real row are.
  assert.deepEqual(await listIds(f, { current: 'open' }), ['open', 'used'].sort(), 'the current draft stays')
  // A loaded conversation is the open one even without the explicit argument.
  f.loaded.add('open')
  assert.deepEqual(await listIds(f), ['open', 'used'].sort(), 'the loaded draft stays')
  // Once a message lands, the conversation appears.
  f.loaded.delete('open')
  logs.draft.push({ type: 'user/message', data: {} })
  assert.deepEqual(await listIds(f), ['draft', 'used'].sort(), 'a started draft is listed')
  logs.closedDraft.push({ type: 'user/message', data: {} })
  assert.deepEqual(await listIds(f), ['closedDraft', 'draft', 'used'].sort(), 'a started bound draft is listed')
})

test('pruneNeverStarted dry run lists the blank drafts and deletes nothing', async () => {
  const state = S.initialState()
  state.pending.b1 = { project }
  state.pending.b2 = { project }
  state.sessions.titled = binding('titled')
  const f = harness({ state, logs: { b1: blankLog(), b2: blankLog(5), titled: startedLog() }, sidecars: { titled: { title: 'A real conversation' } } })
  const answer = await f.ops['sessions.pruneNeverStarted']({ project, dryRun: true })
  assert.deepEqual(answer, { candidates: ['b1', 'b2'], deleted: [], archiveKnown: true })
  assert.equal(f.state().pending.b1?.project, project, 'nothing is removed')
  assert.deepEqual(f.deletedSessions, [], 'no log is deleted')
  assert.deepEqual(f.events.filter((e) => e.type === 'layerfs-session' && e.data?.deleted), [], 'no deleted event')
  // The default is a dry run too.
  assert.deepEqual(await f.ops['sessions.pruneNeverStarted']({ project }), { candidates: ['b1', 'b2'], deleted: [], archiveKnown: true })
})

test('pruneNeverStarted deletes exactly the candidates, keeps used/titled/checkpointed/shared/seeded ones, and is idempotent', async () => {
  const state = S.initialState()
  state.pending.b1 = { project }
  state.pending.b2 = { project }
  // A placed draft whose log was never materialized is a candidate too.
  state.pending.b4 = { project }
  // A bound-but-never-used blank draft is a candidate too.
  state.sessions.b3 = binding('b3')
  state.sessions.used = binding('used')
  state.sessions.titled = binding('titled')
  state.sessions.checkpointed = binding('checkpointed')
  state.checkpoints.checkpointed = [{ kind: 'turn', turn: 1, seq: 5, commit: 'c1', branch: 'b', changed: 2, message: 'Turn 1', at: 1 }]
  state.sessions.mirrored = binding('mirrored')
  state.mirror.mirrored = { project, branch: 'b', count: 3, segments: [], updatedAt: 1 }
  state.sessions.sub = binding('sub', { kind: 'shared', parent: 'used' })
  state.pending.seeded = { project }
  const logs = {
    b1: blankLog(), b2: blankLog(5), b3: blankLog(4), used: startedLog(), titled: startedLog(),
    checkpointed: startedLog(), mirrored: blankLog(), sub: blankLog(), seeded: blankLog(),
  }
  const f = harness({ state, logs, sidecars: { titled: { title: 'Titled' } } })
  // The seeded subagent/import route is skipped on its header, not pruned.
  f.persistence.local.stat = async (id) => id === 'seeded'
    ? { header: { id, createdAt: 1, isSeeded: true }, revision: 'r-seeded', eventCount: 3 }
    : (logs[id] ? { header: { id, createdAt: 1 }, revision: `r${logs[id].length}`, eventCount: logs[id].length } : undefined)
  const answer = await f.ops['sessions.pruneNeverStarted']({ project, dryRun: false })
  assert.deepEqual(answer, { candidates: ['b1', 'b2', 'b3', 'b4'], deleted: ['b1', 'b2', 'b3', 'b4'], archiveKnown: true })
  assert.deepEqual(f.deletedSessions, ['b1', 'b2', 'b3', 'b4'], 'the persistence row deleted exactly the candidates')
  assert.deepEqual(f.state().pending, { seeded: { project } }, 'the pruned pending choices are gone; the seeded one stays')
  for (const id of ['b1', 'b2', 'b3', 'b4']) {
    assert.equal(f.state().sessions[id], undefined, `${id}: binding removed`)
    assert.equal(logs[id], undefined, `${id}: log removed`)
  }
  for (const id of ['used', 'titled', 'checkpointed', 'mirrored', 'sub', 'seeded']) {
    assert.ok(f.state().sessions[id] || f.state().pending[id], `${id}: kept`)
  }
  assert.equal(f.state().checkpoints.checkpointed.length, 1)
  const deletedEvents = f.events.filter((e) => e.type === 'layerfs-session' && e.data?.deleted)
  assert.deepEqual(deletedEvents.map((e) => e.data.sessionId).sort(), ['b1', 'b2', 'b3', 'b4'], 'one deleted event per id')
  assert.equal(deletedEvents.length, 4)
  // Re-run: no candidates, no deletion, no new event.
  assert.deepEqual(await f.ops['sessions.pruneNeverStarted']({ project, dryRun: false }), { candidates: [], deleted: [], archiveKnown: true })
  assert.equal(f.deletedSessions.length, 4, 'a second run deletes nothing')
  assert.equal(f.events.filter((e) => e.type === 'layerfs-session' && e.data?.deleted).length, 4)
})

test('a draft whose only activity is its folded placement reads is still never started', async () => {
  // Regression (d681957): a draft's own placement reads (project.get,
  // branch.list, machine.get, store.get) fold into sidecar.receipts.readsTotal.
  // The receipt counter is not usage: the draft stays hidden and prunable.
  const state = S.initialState()
  state.pending.draft = { project }
  state.sessions.boundDraft = binding('boundDraft')
  const folded = { receipts: { version: 1, reads: { 'project.get': { count: 1, lastOutcome: 'success' } }, readsTotal: 4, dropped: 0, cap: 5000, truncated: false } }
  const polled = { receipts: { version: 1, reads: { 'workspace.status': { count: 8, lastOutcome: 'success' } }, readsTotal: 8, dropped: 0, cap: 5000, truncated: false } }
  const f = harness({ state, logs: { draft: blankLog(6), boundDraft: blankLog(5) }, sidecars: { draft: folded, boundDraft: polled } })

  assert.deepEqual(await listIds(f), [], 'a metadata-only draft with folded reads is not listed')
  assert.deepEqual(await f.ops['sessions.pruneNeverStarted']({ project, dryRun: true }), { candidates: ['boundDraft', 'draft'], deleted: [], archiveKnown: true })
  assert.deepEqual(await f.ops['sessions.pruneNeverStarted']({ project, dryRun: false }), { candidates: ['boundDraft', 'draft'], deleted: ['boundDraft', 'draft'], archiveKnown: true })
  assert.equal(folded.receipts.readsTotal, 4, 'the folded counter is not cleared or changed by the predicate')
  assert.equal(polled.receipts.readsTotal, 8, 'and the same for a bound draft')
  assert.deepEqual(await f.ops['sessions.pruneNeverStarted']({ project, dryRun: false }), { candidates: [], deleted: [], archiveKnown: true }, 'a second run is empty')
})

test('a conversation is started by content — a message, a title or a checkpoint — not by reads', async () => {
  const state = S.initialState()
  state.sessions.system = binding('system')
  state.sessions.titled = binding('titled')
  state.sessions.checkpointed = binding('checkpointed')
  state.checkpoints.checkpointed = [{ kind: 'turn', turn: 1, seq: 5, commit: 'c1', branch: 'b', changed: 2, message: 'Turn 1', at: 1 }]
  const logs = {
    // One system message is content (the acceptance rule's first message event).
    system: [{ type: 'session', data: {} }, { type: 'system/message', data: {} }],
    titled: blankLog(),
    checkpointed: blankLog(),
  }
  // The message has folded reads and is still started; the titled and
  // checkpointed ones have no message events and are still started.
  const sidecars = {
    titled: { title: 'A named conversation' },
    system: { receipts: { version: 1, reads: {}, readsTotal: 12, dropped: 0, cap: 5000, truncated: false } },
  }
  const f = harness({ state, logs, sidecars })
  assert.deepEqual(await listIds(f), ['checkpointed', 'system', 'titled'].sort(), 'all three are conversations')
  assert.deepEqual(await f.ops['sessions.pruneNeverStarted']({ project, dryRun: true }), { candidates: [], deleted: [], archiveKnown: true }, 'prune keeps a message, a title and a checkpoint')
})

test('a whitespace title is the placeholder, not a title', async () => {
  const state = S.initialState()
  state.pending.blank = { project }
  const f = harness({ state, logs: { blank: blankLog() }, sidecars: { blank: { title: '   ' } } })
  assert.deepEqual(await listIds(f), [], 'the placeholder title does not list the draft')
  assert.deepEqual(await f.ops['sessions.pruneNeverStarted']({ project, dryRun: true }), { candidates: ['blank'], deleted: [], archiveKnown: true })
})

test('pruneNeverStarted keeps the current conversation and everything of another project', async () => {
  const state = S.initialState()
  state.pending.mine = { project }
  state.pending.other = { project: 'st/other' }
  state.pending.open = { project }
  const f = harness({ state, logs: { mine: blankLog(), other: blankLog(), open: blankLog() } })
  f.loaded.add('open')
  assert.deepEqual(await f.ops['sessions.pruneNeverStarted']({ project, dryRun: true }), { candidates: ['mine'], deleted: [], archiveKnown: true })
  // An explicit current id is kept too.
  assert.deepEqual(await f.ops['sessions.pruneNeverStarted']({ project, current: 'mine', dryRun: true }), { candidates: [], deleted: [], archiveKnown: true })
  // With no project filter, the other project's draft is included.
  assert.deepEqual(await f.ops['sessions.pruneNeverStarted']({ current: ['mine', 'open'], dryRun: true }), { candidates: ['other'], deleted: [], archiveKnown: true })
})

test('pruneNeverStarted keeps DSH-archived and explicitly excluded blank drafts, and deletes only the rest', async () => {
  const state = S.initialState()
  for (const id of ['archived', 'excluded', 'remaining']) state.pending[id] = { project }
  const f = harness({ state, logs: { archived: blankLog(), excluded: blankLog(), remaining: blankLog() } })
  // DSH's archive set is a default keep, not a candidate source.
  f.ctx.workspaceRegistry.archivedSessionIds = ['archived']
  assert.deepEqual(await f.ops['sessions.pruneNeverStarted']({ project, dryRun: true }), { candidates: ['excluded', 'remaining'], deleted: [], archiveKnown: true })
  // `exclude` (string or array) keeps another blank id, dry run and apply alike.
  assert.deepEqual(await f.ops['sessions.pruneNeverStarted']({ project, exclude: 'excluded', dryRun: true }), { candidates: ['remaining'], deleted: [], archiveKnown: true })
  assert.deepEqual(await f.ops['sessions.pruneNeverStarted']({ project, exclude: ['excluded'], dryRun: false }), { candidates: ['remaining'], deleted: ['remaining'], archiveKnown: true })
  assert.ok(f.state().pending.archived, 'the archived draft stays')
  assert.ok(f.state().pending.excluded, 'the excluded draft stays')
  assert.equal(f.state().pending.remaining, undefined, 'only the other blank draft is removed')
  assert.deepEqual(f.deletedSessions, ['remaining'], 'the persistence row deletes only the rest')
  assert.deepEqual(await f.ops['sessions.pruneNeverStarted']({ project, exclude: ['excluded'], dryRun: false }), { candidates: [], deleted: [], archiveKnown: true }, 'a second run finds nothing new')
})

test('pruneNeverStarted keeps a blank id passed as current', async () => {
  const state = S.initialState()
  state.pending.blank = { project }
  const f = harness({ state, logs: { blank: blankLog() } })
  assert.deepEqual(await f.ops['sessions.pruneNeverStarted']({ project, current: 'blank', dryRun: false }), { candidates: [], deleted: [], archiveKnown: true })
  assert.ok(f.state().pending.blank, 'the kept draft is still pending')
  assert.deepEqual(f.deletedSessions, [])
})

test('an empty archive set is known, not unknown: the normal prune applies', async () => {
  const state = S.initialState()
  state.pending.blank = { project }
  const f = harness({ state, logs: { blank: blankLog() } })
  assert.deepEqual(f.ctx.workspaceRegistry.archivedSessionIds, [], 'the harness host names its archive set')
  assert.deepEqual(await f.ops['sessions.pruneNeverStarted']({ project, dryRun: false }),
    { candidates: ['blank'], deleted: ['blank'], archiveKnown: true })
})

test('pruneNeverStarted refuses an apply when the host cannot name the archive set', async () => {
  const state = S.initialState()
  for (const id of ['archived', 'blank']) state.pending[id] = { project }
  const f = harness({ state, logs: { archived: blankLog(), blank: blankLog() } })
  // An old host still has the registry seam but not the field: that is unknown,
  // not "nothing archived". A dry run answers (useful for diagnostics) and says so.
  delete f.ctx.workspaceRegistry.archivedSessionIds
  assert.deepEqual(await f.ops['sessions.pruneNeverStarted']({ project, dryRun: true }),
    { candidates: ['archived', 'blank'], deleted: [], archiveKnown: false })
  // A field that is present but not an array is unknown too, not an empty set.
  f.ctx.workspaceRegistry.archivedSessionIds = 'session-1'
  assert.equal((await f.ops['sessions.pruneNeverStarted']({ project, dryRun: true })).archiveKnown, false)
  delete f.ctx.workspaceRegistry.archivedSessionIds
  // An apply refuses with InvalidInput, naming the reason, and deletes nothing.
  await assert.rejects(f.ops['sessions.pruneNeverStarted']({ project, dryRun: false }), (error) => {
    assert.equal(error?.code, 'InvalidInput')
    assert.match(error?.message, /archived conversations/)
    assert.equal(error?.detail?.archiveKnown, false)
    assert.equal(error?.detail?.reason, 'archive-unknown')
    return true
  })
  assert.deepEqual(f.state().pending, { archived: { project }, blank: { project } }, 'the refusal removes nothing')
  assert.deepEqual(f.deletedSessions, [], 'no log is deleted')
  assert.deepEqual(f.events.filter((event) => event.type === 'layerfs-session' && event.data?.deleted), [], 'no deleted event')
  // A keep set read from the file (current/exclude) is not a bypass: only the
  // host can prove the archive set is complete.
  await assert.rejects(f.ops['sessions.pruneNeverStarted']({ project, current: ['archived'], exclude: ['blank'], dryRun: false }), { code: 'InvalidInput' })
  // Even an empty scan refuses; the host still cannot verify the set.
  for (const id of Object.keys(state.pending)) delete state.pending[id]
  await assert.rejects(f.ops['sessions.pruneNeverStarted']({ project, dryRun: false }), { code: 'InvalidInput' })
})

test('prune keeps a draft whose log or sidecar cannot be read', async () => {
  const state = S.initialState()
  state.pending.unstatable = { project }
  state.pending.unreadSidecar = { project }
  state.pending.blank = { project }
  const logs = { unreadSidecar: blankLog(), blank: blankLog() }
  const f = harness({ state, logs })
  const failing = Object.assign(new Error('EACCES'), { code: 'EACCES' })
  const stat = f.persistence.local.stat
  f.persistence.local.stat = async (id) => { if (id === 'unstatable') throw failing; return stat(id) }
  f.persistence.stat = f.persistence.local.stat
  const readSidecar = f.persistence.readSidecar
  f.persistence.readSidecar = async (id, options) => { if (id === 'unreadSidecar') throw failing; return readSidecar(id, options) }
  const answer = await f.ops['sessions.pruneNeverStarted']({ project, dryRun: false })
  assert.deepEqual(answer, { candidates: ['blank'], deleted: ['blank'], archiveKnown: true })
  assert.deepEqual(f.deletedSessions, ['blank'])
  assert.ok(f.state().pending.unstatable && f.state().pending.unreadSidecar, 'the unreadable drafts keep their pending choice')
})

test('prune keeps a draft that is opened or written to between its scan and its delete', async () => {
  const state = S.initialState()
  state.pending.opened = { project }
  state.pending.written = { project }
  state.pending.idle = { project }
  const logs = { opened: blankLog(), written: blankLog(), idle: blankLog() }
  const f = harness({ state, logs })
  // After the scan has read each draft, and before the delete, the person
  // opens one draft and sends a message in the other.
  const open = f.persistence.local.open
  const seen = new Set()
  f.persistence.local.open = async (id, mode) => {
    const reader = await open(id, mode)
    return { ...reader, close: async () => {
      await reader.close()
      if (seen.has(id)) return
      seen.add(id)
      if (id === 'opened') f.loaded.add('opened')
      if (id === 'written') logs.written = startedLog()
    } }
  }
  const answer = await f.ops['sessions.pruneNeverStarted']({ project, dryRun: false })
  assert.deepEqual(answer, { candidates: ['idle', 'opened', 'written'], deleted: ['idle'], archiveKnown: true })
  assert.deepEqual(f.deletedSessions, ['idle'], 'only the still-blank, unopened draft is deleted')
  assert.ok(f.state().pending.opened && f.state().pending.written, 'the kept drafts keep their pending choice')
  assert.deepEqual(f.events.filter((e) => e.type === 'layerfs-session' && e.data?.deleted).map((e) => e.data.sessionId), ['idle'])
})
