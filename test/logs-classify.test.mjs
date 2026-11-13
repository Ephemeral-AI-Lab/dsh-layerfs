// The Logs page's read/write rule (`isWrite`, src/shared/logs.ts) against every call
// of the pinned CLI: "Writes only" must hide exactly the calls that only read.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isWrite } from '../src/shared/logs.ts'
import { pinned } from './routes-helper.mjs'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Calls of the pinned CLI that change state (or may: `workspace.exec` runs a command). */
const WRITES = new Set([
  'project.init', 'project.export', 'project.remove',
  'branch.fork', 'branch.merge', 'branch.publish',
  'file.write', 'file.edit', 'file.rm', 'file.mkdir', 'file.mv', 'file.cp', 'file.apply',
  'sandbox.create', 'sandbox.close',
  'workspace.mount', 'workspace.exec', 'workspace.exec_cancel', 'workspace.commit', 'workspace.unmount',
  'machine.start', 'machine.stop', 'machine.create', 'machine.remove', 'machine.update',
  'store.create', 'store.connect', 'store.attach', 'store.detach', 'store.push', 'store.pull', 'store.remove', 'store.disconnect',
  'backup.connect', 'backup.disconnect', 'backup.create', 'backup.restore',
])

test('family-only reads are not writes', () => {
  for (const argv of [['doctor'], ['help', '--json'], ['logs', 'list'], ['--version', '--json']]) assert.equal(isWrite(argv), false, argv.join(' '))
})

test('every pinned CLI call is classified as its kind', { skip: !pinned() && 'no pinned CLI' }, () => {
  const home = mkdtempSync(join(tmpdir(), 'lfs-classify-'))
  const help = JSON.parse(execFileSync(pinned().cli, ['help', '--json'], { env: { ...process.env, LAYERFS_HOME: home }, encoding: 'utf8', timeout: 15000 }))
  rmSync(home, { recursive: true, force: true })
  const calls = new Set(help.calls.map((c) => `${c.family}.${c.call}`))
  assert.ok(calls.size > 40, `found ${calls.size} calls in help --json`)
  const wrong = [...calls].filter((call) => {
    const [family, name] = call.split('.')
    return isWrite([family, name]) !== WRITES.has(call)
  })
  assert.deepEqual(wrong, [], 'misclassified (a new call: add it to WRITES or READ_CALLS)')
})
