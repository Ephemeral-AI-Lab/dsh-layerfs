// The one-shot layout migration (src/host/migrate.ts): an older DSH x LayerFS
// home is brought to layout 2 once, and the old folder is retired.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'dsh-migrate-'))
await build({
  absWorkingDir: root, entryPoints: { migrate: 'src/host/migrate.ts' }, outdir: out,
  bundle: true, format: 'esm', platform: 'node', target: 'node24', logLevel: 'warning', outExtension: { '.js': '.mjs' },
  external: ['@deepseek-ai/*'],
})
const { migrateLayout, retireOldFolder, LAYOUT } = await import(pathToFileURL(join(out, 'migrate.mjs')).href)

const json = (path) => JSON.parse(readFileSync(path, 'utf8'))
const put = (path, value) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)) }

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'dsh-migrate-case-'))
  const state = join(base, 'dsh'), old = join(base, 'old')
  put(join(state, 'dsh.json'), { version: 1, owner: '/dsh', install: 'a'.repeat(64), migratedFrom: old, migratedAt: 'x' })
  const store = join(state, 'sessions', 'store', '--cwd--')
  // a flat, combined sidecar with a read to fold, a write to keep and a .bak
  put(join(store, 'session-a', 'session.v4.jsonl'), '')
  put(join(store, 'session-a', 'layerfs.json'), { version: 1, sessionId: 'session-a', project: 's/p', invocations: [
    { id: 'r1', operation: 'project.list', outcome: 'success', at: 1 },
    { id: 'w1', operation: 'workspace.commit', outcome: 'success', at: 2, versions: ['c1'] },
  ] })
  put(join(store, 'session-a', 'layerfs.json.bak'), '{}')
  // already current
  put(join(store, 'session-b', 'layerfs', 'binding.json'), { version: 1, sessionId: 'session-b', project: 's/p' })
  put(join(store, 'session-b', 'layerfs', 'calls.jsonl'), `${JSON.stringify({ id: 'x', operation: 'workspace.commit', outcome: 'success' })}\n`)
  mkdirSync(join(old, 'scratch', 'sessions', 'session-a'), { recursive: true })
  writeFileSync(join(old, 'scratch', 'sessions', 'session-a', 'notes.txt'), 'kept')
  put(join(state, 'sessions', 'state.json'), {
    version: 1, group: { workspaceId: 'g' },
    projects: { 's/p': { project: 's/p', anchor: join(old, 'projects', 's', 'p'), workspaceId: 'w', createdAt: 1 }, 'dsh-scratch/scratch': { project: 'dsh-scratch/scratch', anchor: join(old, 'scratch'), createdAt: 1 } },
    sessions: {
      'session-a': { sessionId: 'session-a', kind: 'project', project: 's/p', anchor: join(old, 'projects', 's', 'p'), scratch: join(old, 'scratch', 'sessions', 'session-a'), scratchManaged: false, state: 'closed' },
      'session-c': { sessionId: 'session-c', kind: 'shared', parent: 'session-a', project: 's/p', anchor: join(old, 'projects', 's', 'p'), scratch: join(old, 'scratch', 'sessions', 'session-a'), state: 'closed' },
      'session-s': { sessionId: 'session-s', kind: 'project', project: 'dsh-scratch/scratch', anchor: join(old, 'scratch'), scratch: join(old, 'scratch', 'sessions', 'session-s'), state: 'failed' },
      'session-u': { sessionId: 'session-u', kind: 'project', project: 's/p', anchor: join(old, 'projects', 's', 'p'), scratch: '/Users/me/code', scratchManaged: false, state: 'closed' },
    },
    checkpoints: {}, mirror: {},
    pending: { 'session-p': { project: 'dsh-scratch/scratch' }, 'session-q': { project: 's/p', scratch: join(old, 'scratch', 'x') } },
  })
  put(join(state, 'sessions', 'owners.json'), { version: 1, sessions: { 'session-s': { project: 'dsh-scratch/scratch', key: 'k', identity: { id: 'k' } }, 'session-a': { project: 's/p', key: 'u', identity: { id: 'u' } } } })
  mkdirSync(join(state, 'sessions', 'backups', 'x'), { recursive: true })
  return { base, state, old, store }
}

test('migrateLayout brings an older home to the current layout once', () => {
  const { base, state, old, store } = fixture()
  try {
    const report = migrateLayout(state)
    assert.equal(report.sessions, 2)
    assert.equal(report.combined, 1)
    assert.deepEqual(report.dropped.sort(), ['session-p', 'session-s'])
    // session folder: relaid out, calls split out with the read folded, .bak gone
    const a = join(store, 'session-a')
    assert.ok(!existsSync(join(a, 'layerfs.json')) && !existsSync(join(a, 'layerfs.json.bak')))
    const binding = json(join(a, 'layerfs', 'binding.json'))
    assert.equal(binding.invocations, undefined)
    assert.equal(binding.receipts.foldedThrough, undefined)
    assert.ok(binding.receipts.reads >= 1 || Object.keys(binding.receipts).length > 0)
    const calls = readFileSync(join(a, 'layerfs', 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.deepEqual(calls.map((c) => c.id), ['w1'])
    assert.equal(readFileSync(join(store, 'session-b', 'layerfs', 'calls.jsonl'), 'utf8').trim().split('\n').length, 1)
    // state: scratch moved into <state>/scratch/<id>, children follow, anchors current
    const s = json(join(state, 'sessions', 'state.json'))
    const scratch = join(state, 'scratch', 'session-a')
    assert.equal(s.sessions['session-a'].scratch, scratch)
    assert.equal(s.sessions['session-a'].scratchManaged, true)
    assert.equal(readFileSync(join(scratch, 'notes.txt'), 'utf8'), 'kept')
    assert.equal(s.sessions['session-c'].scratch, scratch)
    assert.equal(s.sessions['session-a'].anchor, join(state, 'scratch'))
    assert.equal(s.sessions['session-u'].scratch, '/Users/me/code')
    assert.equal(s.sessions['session-s'], undefined)
    assert.equal(s.pending['session-p'], undefined)
    assert.deepEqual(s.pending['session-q'], { project: 's/p' })
    assert.deepEqual(Object.keys(s.projects), ['s/p'])
    assert.deepEqual(s.projects['s/p'], { project: 's/p', anchor: join(state, 'scratch'), createdAt: 1 })
    assert.equal(s.group, undefined)
    assert.deepEqual(Object.keys(json(join(state, 'sessions', 'owners.json')).sessions), ['session-a'])
    assert.equal(json(join(state, 'dsh.json')).layout, LAYOUT)
    // idempotent
    assert.equal(migrateLayout(state), null)
    assert.ok(existsSync(old), 'the old folder waits for retireOldFolder')
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('retireOldFolder unregisters the old folder\'s workspaces and deletes the old folder', async () => {
  const { base, state, old } = fixture()
  try {
    migrateLayout(state)
    const workspaces = [
      { id: 'w-old', path: join(old, 'scratch'), title: 'Scratch', sessionIds: ['session-x'] },
      { id: 'w-proj', path: join(old, 'projects', 's', 'p'), sessionIds: [] },
      { id: 'w-mine', path: '/Users/me/code', sessionIds: ['session-y'] },
    ]
    const deleted = []
    const registry = { list: () => workspaces, delete: async (id) => { deleted.push(id); return true } }
    await retireOldFolder(state, registry)
    assert.deepEqual(deleted.sort(), ['w-old', 'w-proj'])
    assert.ok(!existsSync(old))
    assert.ok(!existsSync(join(state, 'sessions', 'backups')))
    const record = json(join(state, 'dsh.json'))
    assert.equal(record.migratedFrom, undefined)
    assert.equal(record.layout, LAYOUT)
    assert.equal(record.install, 'a'.repeat(64))
    // a second start has nothing left to do
    deleted.length = 0
    await retireOldFolder(state, registry)
    assert.deepEqual(deleted, [])
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('a home already at the current layout is left alone', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-migrate-case-'))
  try {
    put(join(base, 'dsh.json'), { version: 1, owner: '/dsh', install: 'b'.repeat(64), layout: LAYOUT })
    assert.equal(migrateLayout(base), null)
  } finally { rmSync(base, { recursive: true, force: true }) }
})
