// The Sandbox page's client model: the daemon line and overlay helpers
// (src/client/machines/model.ts) and the terminals' layout, order, history
// and transcript (src/client/machines/terminal.ts). The command runner and
// its routes are in test/sandbox-commands.test.mjs.
//   node --test test/sandbox-page.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = new URL('..', import.meta.url).pathname
const out = mkdtempSync(join(root, 'lib', '.test-sandbox-page-'))
await build({
  absWorkingDir: root,
  stdin: { contents: "export { daemonLook, daemonSlots, overlayDirty, overlayCount, workspaceChanges } from './src/client/machines/model.ts'; export * from './src/client/machines/terminal.ts'", resolveDir: root, loader: 'ts' },
  outfile: join(out, 'page.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24', external: ['@deepseek-ai/*'], logLevel: 'warning',
})
const M = await import(pathToFileURL(join(out, 'page.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

test('daemon line and overlay helpers', () => {
  const base = { state: 'running', workspaces: [] }
  assert.equal(M.daemonLook({ ...base }).key, 'sbDaemonReachable')
  assert.equal(M.daemonLook({ ...base, downReason: 'x' }).tone, 'danger')
  assert.equal(M.daemonLook({ ...base, state: 'lost' }).key, 'sbDaemonStopped')
  assert.equal(M.daemonLook({ ...base, unread: true }).key, 'sbDaemonUnknown')
  assert.deepEqual(M.daemonSlots({ ...base, daemonCapacity: { admission: { pool_vacant: 3, pool_running: 1, reserved_vacant: 1, reserved_running: 0 } } }), { free: 4, total: 5 })
  assert.equal(M.daemonSlots(base), null)
  // an in-place edit: one inode, no directory entry, still a change (the Sandboxes table's status)
  const edited = { ws: 'sb:a', branch: 'b', path: '/w', dirty: { inodes: 1, entries: 0 } }
  assert.equal(M.overlayDirty(edited.dirty), true)
  assert.equal(M.overlayCount(edited.dirty), 1)
  assert.equal(M.workspaceChanges(edited).key, 'wsUncommitted')
  assert.equal(M.workspaceChanges({ ...edited, dirty: { inodes: 0, entries: 0 } }).key, 'wsClean')
})

test('Workspaces keep creation order: numeric by mount path', () => {
  const ws = (n, name = null) => ({ ws: `sb:${name ?? `/r/workspaces/${n}`}`, name, branch: 'b', path: `/r/workspaces/${n}` })
  const ordered = M.orderWorkspaces([ws(10, 'j'), ws(2, 'b'), ws(1, 'a'), ws(3)])
  assert.deepEqual(ordered.map((w) => w.path.split('/').at(-1)), ['1', '2', '3', '10'])
  assert.equal(M.mountLabel('/Users/me/.layerfs/machine/native/run/lfs-1-box/workspaces/3'), 'workspaces/3')
  assert.equal(M.mountLabel('/w'), 'w')
})

test('page layout: one, two, 2×2 with a New tile, pages of four, maximize, full', () => {
  const ids = (n) => Array.from({ length: n }, (_, i) => `w${i + 1}`)
  const shape = (l) => [l.grid, l.slots.join(','), l.page, l.pages]
  assert.deepEqual(shape(M.pageLayout([], 0, null, true)), ['one', 'new', 0, 1])
  assert.deepEqual(shape(M.pageLayout([], 0, null, false)), ['one', 'blank', 0, 1])
  assert.deepEqual(shape(M.pageLayout(ids(1), 0, null, true)), ['one', 'w1', 0, 1])
  assert.deepEqual(shape(M.pageLayout(ids(2), 0, null, true)), ['two', 'w1,w2', 0, 1])
  assert.deepEqual(shape(M.pageLayout(ids(3), 0, null, true)), ['quad', 'w1,w2,w3,new', 0, 1])
  assert.deepEqual(shape(M.pageLayout(ids(3), 0, null, false)), ['quad', 'w1,w2,w3,blank', 0, 1])
  assert.deepEqual(shape(M.pageLayout(ids(4), 0, null, true)), ['quad', 'w1,w2,w3,w4', 0, 1])
  assert.deepEqual(shape(M.pageLayout(ids(5), 0, null, true)), ['quad', 'w1,w2,w3,w4', 0, 2])
  assert.deepEqual(shape(M.pageLayout(ids(5), 1, null, true)), ['quad', 'w5,new,blank,blank', 1, 2])
  assert.deepEqual(shape(M.pageLayout(ids(9), 2, null, true)), ['quad', 'w9,new,blank,blank', 2, 3])
  // a page past the end clamps; a maximized Workspace shows alone
  assert.deepEqual(shape(M.pageLayout(ids(5), 7, null, true)), ['quad', 'w5,new,blank,blank', 1, 2])
  assert.deepEqual(shape(M.pageLayout(ids(5), 0, 'w3', true)), ['one', 'w3', 0, 2])
  assert.deepEqual(shape(M.pageLayout(ids(5), 0, 'gone', true)), ['quad', 'w1,w2,w3,w4', 0, 2])
  assert.deepEqual(shape(M.pageLayout(ids(16), 3, null, false)), ['quad', 'w13,w14,w15,w16', 3, 4])
  assert.equal(M.pageOf(ids(9), 'w5'), 1)
  assert.equal(M.pageOf(ids(9), 'w9'), 2)
  assert.equal(M.pageOf(ids(9), 'nope'), 0)
})

test('history steps like a shell: older on ↑, back to the draft on ↓, repeats once', () => {
  const cmds = ['ls', 'ls', 'make', 'cd src']
  let s = M.historyStep(cmds, -1, -1, 'dra')
  assert.deepEqual(s, { cursor: 0, text: 'ls' })
  s = M.historyStep(cmds, s.cursor, -1, 'dra')
  assert.deepEqual(s, { cursor: 1, text: 'make' })
  s = M.historyStep(cmds, s.cursor, -1, 'dra')
  assert.deepEqual(s, { cursor: 2, text: 'cd src' })
  assert.deepEqual(M.historyStep(cmds, 2, -1, 'dra'), { cursor: 2, text: 'cd src' })
  assert.deepEqual(M.historyStep(cmds, 0, 1, 'dra'), { cursor: -1, text: 'dra' })
  assert.deepEqual(M.historyStep(cmds, -1, 1, 'dra'), { cursor: -1, text: 'dra' })
  assert.deepEqual(M.historyStep([], -1, -1, 'x'), { cursor: -1, text: 'x' })
})

test('transcript: oldest first, cleared rows hidden, tails, binary and running time', () => {
  const e = (id, startedAt, extra = {}) => ({ id, ws: 'sb:a', sandbox: 'sb', command: id, state: 'exited', startedAt, finishedAt: startedAt + 40, exitCode: 0, stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0, error: null, ...extra })
  const rows = M.transcript([
    e('c', 300, { state: 'running', finishedAt: null, exitCode: null }),
    e('b', 200, { stdout: 'tail', stdoutBytes: 70000, stderrBinary: true, stderr: '', stderrBytes: 12 }),
    e('a', 100),
  ], 150, 1300)
  assert.deepEqual(rows.map((r) => r.id), ['b', 'c'])
  assert.equal(rows[0].stdoutOmitted, 69996)
  assert.equal(rows[0].stderrBinary, true)
  assert.equal(rows[0].ms, 40)
  assert.equal(rows[1].ms, 1000)
  assert.equal(M.duration(40), '40ms')
  assert.equal(M.duration(18200), '18s')
  assert.equal(M.duration(72000), '1m 12s')
  assert.equal(M.duration(null), '')
})

test('pane state outlives a pane and can be forgotten', () => {
  let calls = 0
  const off = M.paneStore.subscribe(() => calls++)
  M.paneStore.patch('sb:a', { draft: 'make' })
  assert.equal(M.paneStore.get('sb:a').draft, 'make')
  assert.equal(M.paneStore.get('sb:a').cursor, -1)
  M.paneStore.forget('sb:a')
  assert.equal(M.paneStore.get('sb:a').draft, '')
  off()
  assert.equal(calls, 2)
})
