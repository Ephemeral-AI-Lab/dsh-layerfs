// sandbox.get's monitoring fields (layerfs-project#178 "Fields"): the host's
// answer (routes/projects.ts) and the Sandbox page's model
// (src/client/machines/model.ts). Fields are read by presence: an older
// worker's answer keeps the old behaviour.
//   node --test test/inspect-fields.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { loadRoutes, testHost } from './routes-helper.mjs'

const root = new URL('..', import.meta.url).pathname
const out = mkdtempSync(join(root, 'lib', '.test-inspect-fields-'))
await build({
  absWorkingDir: root,
  stdin: { contents: "export { SANDBOX_CAPACITY, alsoRunning, runnerOf, runningSummary, workspaceCapacity } from './src/client/machines/model.ts'", resolveDir: root, loader: 'ts' },
  outfile: join(out, 'model.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24', external: ['@deepseek-ai/*'], logLevel: 'warning',
})
const M = await import(pathToFileURL(join(out, 'model.mjs')).href)
const R = await loadRoutes()
test.after(() => rmSync(out, { recursive: true, force: true }))

const item = (n, more = {}) => ({ name: `w${n}`, branch: `b${n}`, directory: `/run/workspaces/${n}`, mounted: true, dirty: { inodes: 0, entries: 0 }, ...more })
const record = (workspaces, more = {}) => ({ name: 'sb', state: 'running', project: 's/p', machine: 'native', workspaces, next_page_pos: null, ...more })

function routes(answer, { labelTags, own = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fields-'))
  const lfs = { sandbox: { get: async () => answer } }
  const { host } = testHost({ lfs, root: dir, home: dir, discovery: async () => ({ identity: {}, calls: [] }) })
  if (labelTags) host.labelTags = labelTags
  const groups = R.createGroups(host, async () => ({}))
  // what the router wires from commands.ts, with a chosen set of own exec ids
  groups.projects.ownExec = (ws, id) => own.includes(`${ws} ${id}`)
  return { groups, done: () => rmSync(dir, { recursive: true, force: true }) }
}
const get = async (groups, name = 'sb') => (await R.handle(groups, { method: 'GET', path: `/api/sandboxes/${name}` })).body

test('host: an older answer has none of the fields (absent stays absent)', async () => {
  const { groups, done } = routes(record([item(1)]))
  try {
    const info = await get(groups)
    assert.equal('workspaceCapacity' in info, false)
    assert.equal('running' in info.workspaces[0], false)
    assert.equal('overlayBytes' in info.workspaces[0], false)
  } finally { done() }
})

test('host: workspace_capacity, running (oldest first, own marked by exact exec id, sessions labelled) and overlay_bytes', async () => {
  const tag = 'dsh:sess-1234abcd:rcpt-1'
  const answer = record([
    item(1, { overlay_bytes: 81920, running: [
      { exec_id: 'x-late', started: 1763290000500, tag: null, program: 'npm' },
      { exec_id: 'dsh-own', started: 1763290000100, tag: 'dsh:-:host-1', program: 'ls' },
      { exec_id: 'dsh-lookalike', started: 1763290000300, tag, program: 'sleep' },
      { started: 5, program: 'no-id' },
    ] }),
    item(2, { overlay_bytes: null, running: null }),
    item(3, { running: [] }),
  ], { workspace_capacity: 16 })
  const asked = []
  const { groups, done } = routes(answer, { own: ['sb:w1 dsh-own'], labelTags: async (tags) => { asked.push(...tags); return { [tag]: { sessionId: 'sess-1234abcd', match: 'tag', title: 'Build the shop', turn: 3 } } } })
  try {
    const info = await get(groups)
    assert.equal(info.workspaceCapacity, 16)
    const [a, b, c] = info.workspaces
    assert.deepEqual(a.running.map((r) => r.execId), ['dsh-own', 'dsh-lookalike', 'x-late'])
    // own is the exact id this host started, never the `dsh-` prefix
    assert.deepEqual(a.running.map((r) => r.own), [true, false, false])
    assert.deepEqual(a.running[1].session, { sessionId: 'sess-1234abcd', match: 'tag', title: 'Build the shop', turn: 3 })
    assert.equal(a.running[0].session, undefined)
    assert.deepEqual(a.running[2], { execId: 'x-late', started: 1763290000500, tag: null, program: 'npm', own: false })
    assert.equal(a.overlayBytes, 81920)
    assert.equal(b.running, null)
    assert.equal(b.overlayBytes, null)
    assert.deepEqual(c.running, [])
    assert.equal('overlayBytes' in c, false)
    assert.deepEqual(asked.sort(), ['dsh:-:host-1', tag].sort())
  } finally { done() }
})

test('host: a label that fails leaves the answer whole', async () => {
  const { groups, done } = routes(record([item(1, { running: [{ exec_id: 'e1', started: 1, tag: 'dsh:s:r', program: 'sleep' }] })]), { labelTags: async () => { throw new Error('no sessions service') } })
  try {
    const info = await get(groups)
    assert.equal(info.workspaces[0].running[0].program, 'sleep')
    assert.equal(info.workspaces[0].running[0].session, undefined)
  } finally { done() }
})

test('host: commands.started knows the exact ids this host ran in a Workspace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fields-'))
  let release
  const lfs = { workspace: { exec: () => new Promise((resolve) => { release = resolve }) } }
  const { host, events } = testHost({ lfs, root: dir, home: dir, discovery: async () => ({ identity: {}, calls: [] }) })
  const groups = R.createGroups(host, async () => ({}))
  try {
    const entry = groups.commands.start('sb:w1', { command: 'sleep 5' })
    assert.equal(groups.commands.started('sb:w1', entry.id), true)
    assert.equal(groups.commands.started('sb:w2', entry.id), false)
    assert.equal(groups.commands.started('sb:w1', 'dsh-0000000000000000'), false)
    // a start is published too, so pages read sandbox.get again
    assert.deepEqual(events.filter((e) => e.type === 'sandbox-command').map((e) => e.data.state), ['running'])
    release({ kind: 'exited', exit_code: 0 })
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(groups.commands.started('sb:w1', entry.id), true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('model: capacity falls back to 16 only when sandbox.get does not say', () => {
  assert.equal(M.workspaceCapacity({ workspaceCapacity: 8 }), 8)
  assert.equal(M.workspaceCapacity({}), M.SANDBOX_CAPACITY)
  assert.equal(M.workspaceCapacity(null), 16)
  assert.equal(M.workspaceCapacity({ workspaceCapacity: 0 }), 16)
})

test('model: "also running" leaves out own commands by exact id; absent and null show nothing', () => {
  const running = [
    { execId: 'dsh-aaaa', started: 1, tag: null, program: 'sleep', own: true },
    { execId: 'dsh-bbbb', started: 2, tag: null, program: 'make', own: false },
    { execId: 'x-1', started: 3, tag: 'dsh:s1:r1', program: 'npm', own: false },
  ]
  assert.deepEqual(M.alsoRunning({ running }).map((r) => r.execId), ['dsh-bbbb', 'x-1'])
  assert.deepEqual(M.alsoRunning({ running }, new Set(['x-1'])).map((r) => r.execId), ['dsh-bbbb'])
  assert.deepEqual(M.alsoRunning({}), [])
  assert.deepEqual(M.alsoRunning({ running: null }), [])
})

test('model: the toolbar summary counts all running and those by another client, and names the Workspace to show', () => {
  const ws = (id, running) => ({ ws: id, running })
  assert.deepEqual(M.runningSummary([ws('a', []), ws('b', undefined), ws('c', null)]), { running: 0, others: 0, first: null })
  assert.deepEqual(M.runningSummary([ws('a', [{ execId: '1', own: true }]), ws('e', [{ execId: '2', own: false }, { execId: '3', own: true }])]), { running: 3, others: 1, first: 'e' })
  assert.deepEqual(M.runningSummary([ws('a', [{ execId: '1', own: true }])]), { running: 1, others: 0, first: 'a' })
})

test('model: who started a command, from its tag', () => {
  assert.deepEqual(M.runnerOf({ tag: 'dsh:sess-9:rcpt', session: { sessionId: 'sess-9', match: 'tag', title: 'T' } }), { kind: 'session', sessionId: 'sess-9', title: 'T' })
  assert.deepEqual(M.runnerOf({ tag: 'dsh:sess-9:rcpt' }), { kind: 'session', sessionId: 'sess-9', title: null })
  assert.deepEqual(M.runnerOf({ tag: 'dsh:-:host-call' }), { kind: 'dsh' })
  assert.deepEqual(M.runnerOf({ tag: 'ci-run-7' }), { kind: 'tag', tag: 'ci-run-7' })
  assert.deepEqual(M.runnerOf({ tag: null }), { kind: 'other' })
})
