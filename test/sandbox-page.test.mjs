// The Sandbox page model's mount map, daemon and overlay summaries
// (src/client/machines/model.ts). The command runner and its routes are in
// test/sandbox-commands.test.mjs.
//   node --test test/sandbox-page.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = new URL('..', import.meta.url).pathname
const out = mkdtempSync(join(root, 'lib', '.test-sandbox-page-'))
await build({
  absWorkingDir: root,
  stdin: { contents: "export * from './src/host/routes/commands.ts'; export { createGroups, route } from './src/host/routes/router.ts'; export { mountRows, daemonLook, daemonSlots, uncaptured, activityLook, overlayDirty, overlayCount, workspaceChanges } from './src/client/machines/model.ts'", resolveDir: root, loader: 'ts' },
  outfile: join(out, 'page.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24', external: ['@deepseek-ai/*'], logLevel: 'warning',
})
const M = await import(pathToFileURL(join(out, 'page.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

test('mount map folds single folder chains and keeps Workspaces at their paths', () => {
  const ws = (name, path) => ({ ws: `sb:${name}`, name, branch: 'b', path })
  const rows = M.mountRows([ws('build', '/layerfs/ws/build'), ws('sdk', '/layerfs/ws/sdk'), ws('tmp', '/tmp/x')])
  assert.deepEqual(rows.map((r) => [r.depth, r.label, r.ws?.name ?? null]), [
    [1, 'layerfs/ws', null],
    [2, 'build', 'build'],
    [2, 'sdk', 'sdk'],
    [1, 'tmp', null],
    [2, 'x', 'tmp'],
  ])
  // one deep host mount: the folders fold, the Workspace keeps its own folder name
  assert.deepEqual(M.mountRows([ws('build', '/Users/me/.layerfs/run/box/workspaces/1')]).map((r) => [r.depth, r.label, r.ws?.name ?? null]), [
    [1, 'Users/me/.layerfs/run/box/workspaces', null],
    [2, '1', 'build'],
  ])
  assert.deepEqual(M.mountRows([ws('top', '/w')]).map((r) => [r.depth, r.label]), [[1, 'w']])
  assert.deepEqual(M.mountRows([]), [])
})

test('daemon, slots, overlay and activity summaries', () => {
  const base = { state: 'running', workspaces: [] }
  assert.equal(M.daemonLook({ ...base }).key, 'sbDaemonReachable')
  assert.equal(M.daemonLook({ ...base, downReason: 'x' }).tone, 'danger')
  assert.equal(M.daemonLook({ ...base, state: 'lost' }).key, 'sbDaemonStopped')
  assert.equal(M.daemonLook({ ...base, unread: true }).key, 'notReported')
  assert.deepEqual(M.daemonSlots({ ...base, daemonCapacity: { admission: { pool_vacant: 3, pool_running: 1, reserved_vacant: 1, reserved_running: 0 } } }), { free: 4, total: 5 })
  assert.equal(M.daemonSlots(base), null)
  assert.equal(M.uncaptured([{ dirty: null }]), null)
  assert.deepEqual(M.uncaptured([{ dirty: { entries: 3, inodes: 1 } }, { dirty: { entries: 4, inodes: 2 } }, {}]), { inodes: 3, entries: 7 })
  // an in-place edit: one inode, no directory entry, still a change
  const edited = { ws: 'sb:a', branch: 'b', path: '/w', dirty: { inodes: 1, entries: 0 } }
  assert.equal(M.overlayDirty(edited.dirty), true)
  assert.equal(M.overlayCount(edited.dirty), 1)
  assert.equal(M.workspaceChanges(edited).key, 'wsUncommitted')
  assert.equal(M.overlayDirty({ inodes: 0, entries: 0 }), false)
  assert.equal(M.workspaceChanges({ ...edited, dirty: { inodes: 0, entries: 0 } }).key, 'wsClean')
  assert.equal(M.activityLook('LocalFailure').key, 'activityLocalFailure')
  assert.equal(M.activityLook('Uncertain').tone, 'warning')
  assert.deepEqual(M.activityLook('Weird'), { key: null, raw: 'Weird', tone: 'info' })
  assert.equal(existsSync(out), true)
})
