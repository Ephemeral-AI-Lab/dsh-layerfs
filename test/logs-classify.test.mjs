// The Logs page's read/write rule (`isWrite`, src/shared/logs.ts) against every call
// of the pinned CLI: "Writes only" must hide exactly the calls that only read.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isWrite } from '../src/shared/logs.ts'
import { pinned, liveSkipReason } from './routes-helper.mjs'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Calls of the pinned CLI that change state (or may: `workspace.exec` runs a command). */
const WRITES = new Set([
  'project.init', 'project.export', 'project.delete', 'project.hide_path',
  'branch.fork', 'branch.merge', 'branch.publish', 'branch.remove',
  'file.write', 'file.edit', 'file.rm', 'file.mkdir', 'file.mv', 'file.cp', 'file.apply',
  'sandbox.create', 'sandbox.remove',
  'workspace.mount', 'workspace.exec', 'workspace.cancel', 'workspace.commit', 'workspace.unmount',
  'machine.start', 'machine.stop', 'machine.create', 'machine.remove', 'machine.update', 'machine.load_image', 'machine.prune',
  'home.init', 'home.clear_log',
  'store.create', 'store.connect', 'store.attach', 'store.detach', 'store.move', 'store.remove', 'store.compact', 'store.disconnect', 'store.repair_mount_holders',
  'store.save_auth', 'store.remove_auth', 'store.update',
  'backup.connect', 'backup.disconnect', 'backup.create', 'backup.restore',
  'doctor.fix',
])

test('family-only reads are not writes', () => {
  for (const argv of [['doctor'], ['doctor', 'machine', 'docker'], ['help', '--json'], ['logs', 'list'], ['--version', '--json']]) assert.equal(isWrite(argv), false, argv.join(' '))
  // the monitoring reads (they write no call-log line, and a line of one would be a read)
  for (const argv of [['machine', 'files', 'docker', '/etc'], ['sandbox', 'files', 'sb'], ['machine', 'stats', 'docker'], ['machine', 'log', 'docker'], ['sandbox', 'log', 'sb'], ['home', 'log'], ['home', 'doctor'], ['machine', 'doctor', 'docker']]) assert.equal(isWrite(argv), false, argv.join(' '))
  assert.equal(isWrite(['doctor', 'fix', 'native:run-folder:x']), true, 'doctor fix removes a leftover')
})

test('every pinned CLI call is classified as its kind', { skip: !pinned() && liveSkipReason() }, () => {
  const home = mkdtempSync(join(tmpdir(), 'lfs-classify-'))
  const help = JSON.parse(execFileSync(pinned().cli, ['help', '--json'], { env: { ...process.env, LAYERFS_HOME: home }, encoding: 'utf8', timeout: 15000 }))
  rmSync(home, { recursive: true, force: true })
  // home.leftovers and home.prune are removed by LayerFS (spec v20, LO); a pin from before LO still lists them
  const calls = new Set(help.calls.map((c) => `${c.family}.${c.call}`).filter((call) => call !== 'home.leftovers' && call !== 'home.prune'))
  assert.ok(calls.size > 40, `found ${calls.size} calls in help --json`)
  const wrong = [...calls].filter((call) => {
    const [family, name] = call.split('.')
    return isWrite([family, name]) !== WRITES.has(call)
  })
  assert.deepEqual(wrong, [], 'misclassified (a new call: add it to WRITES or READ_CALLS)')
})
