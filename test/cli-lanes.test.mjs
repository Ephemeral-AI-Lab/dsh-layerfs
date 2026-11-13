// The pinned-CLI SDK under load and failure (src/host/layerfs/cli.ts): admission lanes keep short
// reads clear of long work and terminals, reads have a default time budget, a timed-out call ends
// its whole process group and settles, a read meeting another process's Store lease is retried,
// argument shapes that would shift or invent CLI words are refused, the native daemon record is
// retried after a failure (service.ts), and preset long work gets a long budget (presets/driver.ts).
//   node --test test/cli-lanes.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = mkdtempSync(join(tmpdir(), 'dsh-cli-lanes-'))
process.on('exit', () => rmSync(root, { recursive: true, force: true }))
await build({
  stdin: {
    contents: "export * from './src/host/layerfs/cli.ts'\nexport { presetTimeout, PRESET_TIMEOUT_MS, PRESET_LONG_TIMEOUT_MS } from './src/host/presets/driver.ts'\nexport { LayerfsService } from './src/host/service.ts'\nexport { Context } from '@deepseek-ai/cordis'\n",
    resolveDir: process.cwd(), loader: 'ts',
  },
  outfile: join(root, 'cli.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24',
})
const C = await import(pathToFileURL(join(root, 'cli.mjs')))

const a = (name, kind, optional) => ({ name, kind, ...(optional ? { optional } : {}) })
const o = (name, kind) => ({ name, kind })
const CALLS = {
  'machine.list': [[], []],
  'machine.get': [[a('name', 'name')], []],
  'machine.update': [[a('name', 'name')], [o('daemon', 'text'), o('cpus', 'int')]],
  'workspace.exec': [[a('ws', 'text'), a('command', 'text')], [o('message', 'text'), o('stream', 'bool'), o('stdout', 'function'), o('stderr', 'function'), o('exec_id', 'text'), o('on_progress', 'function')]],
  'store.push': [[a('name', 'name'), a('machine', 'name')], [o('on_progress', 'function')]],
  'file.list': [[a('project', 'project'), a('branch', 'name'), a('path', 'text'), a('commit', 'name', true)], [o('page_size', 'int'), o('page_pos', 'int')]],
  'file.write': [[a('project', 'project'), a('branch', 'name'), a('path', 'text'), a('content', 'content')], [o('message', 'text'), o('mode', 'int')]],
  'project.stats': [[a('project', 'project'), a('branch', 'name', true), a('commit', 'name', true)], []],
  'branch.diff': [[a('project', 'project'), a('from_branch', 'name'), a('to_branch', 'name')], [o('path_prefix', 'text'), o('paths_only', 'bool')]],
}
const calls = [...new Set([...C.REQUIRED_CALLS, ...Object.keys(CALLS)])].map((name) => {
  const [family, call] = name.split('.'), [args, options] = CALLS[name] ?? [[], []]
  return { family, call, args, options }
})

/** A fake pinned CLI: discovery, a call log, held calls released by a file, and scripted refusals. */
function fakeCli(dir) {
  mkdirSync(join(dir, 'home'), { recursive: true })
  writeFileSync(join(dir, 'home', 'layerfs.json'), '{}')
  writeFileSync(join(dir, 'help.json'), JSON.stringify({ calls, commands: [], switches: [] }))
  const cli = join(dir, 'layerfs')
  writeFileSync(cli, `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
const dir = ${JSON.stringify(dir)}, a = process.argv.slice(2), op = a[0] + '.' + a[1]
if (a[0] === '--version') { console.log(JSON.stringify({ version: '2.0.0', commit: 'a'.repeat(40), dirty: false, features: [] })); process.exit(0) }
if (a[0] === 'help') { process.stdout.write(readFileSync(dir + '/help.json')); process.exit(0) }
appendFileSync(dir + '/calls.log', JSON.stringify(a) + '\\n')
const answer = (value) => { console.log(JSON.stringify(a.includes('--events') ? { result: value } : value)); process.exit(0) }
const failing = (counter, env) => {
  const n = existsSync(dir + '/' + counter) ? Number(readFileSync(dir + '/' + counter, 'utf8')) : 0
  writeFileSync(dir + '/' + counter, String(n + 1))
  return n < Number(process.env[env] ?? 0)
}
if (op === 'workspace.exec' || op === 'store.push') setInterval(() => { if (existsSync(dir + '/release')) answer({ held: op }) }, 10)
else if ((op === 'file.list' || op === 'file.write') && failing('race.count', 'FAKE_RACE_FAILS')) {
  process.stderr.write(JSON.stringify({ code: 'Failed', message: 'Os { code: 2, kind: NotFound, message: "No such file or directory" }' }) + '\\n'); process.exit(125)
} else if (op === 'machine.update' && failing('update.count', 'FAKE_UPDATE_FAILS')) {
  process.stderr.write(JSON.stringify({ code: 'Failed', message: 'daemon not reachable' }) + '\\n'); process.exit(125)
} else if (op === 'machine.get' && process.env.FAKE_SLOW_MS) setTimeout(() => answer({ slow: true }), Number(process.env.FAKE_SLOW_MS))
else answer({ argv: a })
`, { mode: 0o700 })
  return { cli, home: join(dir, 'home'), log: () => existsSync(join(dir, 'calls.log')) ? readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n').map(JSON.parse) : [] }
}
let n = 0
const fresh = () => { const dir = join(root, `t${n++}`); mkdirSync(dir); return { dir, ...fakeCli(dir) } }

test('laneOf: short calls, long jobs, Workspace commands and exec-cancel take separate lanes', () => {
  assert.equal(C.laneOf(['machine', 'list']).name, 'calls')
  assert.equal(C.laneOf(['file', 'write', '--', 'p/a', 'main', '/x']).name, 'calls')
  for (const argv of [['store', 'push'], ['store', 'pull'], ['backup', 'create'], ['backup', 'restore'], ['project', 'init'], ['project', 'export'], ['machine', 'create'], ['machine', 'start'], ['machine', 'stop'], ['machine', 'update'], ['sandbox', 'create'], ['doctor', 'store', 'integrity']]) {
    assert.equal(C.laneOf(argv).name, 'jobs', argv.join(' '))
  }
  assert.equal(C.laneOf(['workspace', 'exec']).name, 'exec')
  assert.equal(C.laneOf(['workspace', 'exec-cancel']).name, 'cancel')
  assert.equal(C.laneOf(['workspace', 'exec_cancel']).name, 'cancel')
})

test('short reads answer while Workspace commands and long jobs fill their lanes', { timeout: 30000 }, async (t) => {
  const f = fresh()
  t.after(() => writeFileSync(join(f.dir, 'release'), ''))
  const lfs = C.client({ cli: f.cli, home: f.home })
  await lfs.machine.list()
  const held = []
  for (let i = 0; i < 8; i++) held.push(lfs.workspace.exec(`sb${i}:ws`, 'sleep 600', { stdout: () => {} }))
  for (let i = 0; i < 4; i++) held.push(lfs.store.push(`s${i}`, 'vm'))
  // all 12 are running at once: none queued behind another lane
  for (let i = 0; i < 300 && f.log().length < 13; i++) await new Promise((r) => setTimeout(r, 20))
  assert.equal(f.log().filter((argv) => argv[0] !== 'machine').length, 12, 'eight Workspace commands and four jobs run together')
  const started = Date.now()
  assert.deepEqual((await lfs.machine.list()).argv.slice(0, 2), ['machine', 'list'])
  assert.ok(Date.now() - started < 10000, `machine.list answered (the held calls never end on their own) in ${Date.now() - started} ms`)
  writeFileSync(join(f.dir, 'release'), '')
  assert.equal((await Promise.all(held)).length, 12)
})

test('reads get a time budget (timeout_ms overrides it); a timed-out call is transport-unknown', { timeout: 20000 }, async (t) => {
  const f = fresh()
  const lfs = C.client({ cli: f.cli, home: f.home })
  assert.equal(C.READ_TIMEOUT_MS, 120_000)
  t.after(() => { delete process.env.FAKE_SLOW_MS })
  // discovery (two spawns, slow under a parallel test run) first, so the clock below times only the call
  process.env.FAKE_SLOW_MS = '0'
  await lfs.machine.get('vm')
  process.env.FAKE_SLOW_MS = '5000'
  const started = Date.now()
  await assert.rejects(lfs.machine.get('vm', { timeout_ms: 300 }), (error) => error.code === 'Unknown' && error.transport === 'transport-unknown' && error.detail.timeout === 300)
  // well under the fake's 5 s
  assert.ok(Date.now() - started < 4000, `settled in ${Date.now() - started} ms`)
  process.env.FAKE_SLOW_MS = '200'
  assert.deepEqual(await lfs.machine.get('vm', { timeout_ms: 0 }), { slow: true }, '0: no budget')
  await assert.rejects(lfs.machine.get('vm', { timeout_ms: -1 }), (error) => error.code === 'InvalidInput')
  assert.ok(!f.log().some((argv) => argv.some((word) => word.includes('timeout'))), 'timeout_ms never reaches the CLI')
})

test('a timeout ends the CLI\'s process group, escalating to SIGKILL, and settles', { timeout: 40000 }, async () => {
  const dir = join(root, 'hang'); mkdirSync(join(dir, 'home'), { recursive: true })
  const cli = join(dir, 'layerfs')
  // ignores SIGTERM, and so does its helper, which holds stdout/stderr open
  const ignore = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"
  writeFileSync(cli, `#!${process.execPath}
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
${ignore}
const helper = spawn(process.execPath, ['-e', ${JSON.stringify(ignore)}], { stdio: 'inherit' })
writeFileSync(${JSON.stringify(join(dir, 'helper'))}, String(helper.pid))
`, { mode: 0o700 })
  const started = Date.now()
  let pid
  // a budget past Node's start (slow under a loaded test run), so the CLI's SIGTERM handler is in place
  const budget = 5000
  await assert.rejects(C.execute({ cli, home: join(dir, 'home') }, ['machine', 'list'], { timeout: budget, onSpawn: (child) => { pid = child.pid } }),
    (error) => error.code === 'Unknown' && error.transport === 'transport-unknown')
  const took = Date.now() - started
  assert.ok(existsSync(join(dir, 'helper')), 'the CLI was up when its budget ran out')
  assert.ok(took >= budget + C.KILL_GRACE_MS - 200 && took < budget + 2 * C.KILL_GRACE_MS + 3000, `settled after ${took} ms (SIGTERM ignored, SIGKILL after the grace)`)
  const helper = Number(readFileSync(join(dir, 'helper'), 'utf8'))
  await new Promise((r) => setTimeout(r, 100))
  assert.throws(() => process.kill(helper, 0), /ESRCH/, 'the helper is gone')
  assert.throws(() => process.kill(pid, 0), /ESRCH/, 'the CLI is gone')
  assert.equal(C.children.size, 0)
})

test('a CLI that exits while a helper holds its stdout still answers; child.kill signals the whole group', { timeout: 40000 }, async (t) => {
  const dir = join(root, 'linger'); mkdirSync(join(dir, 'home'), { recursive: true })
  const cli = join(dir, 'layerfs')
  writeFileSync(cli, `#!/bin/sh\nif [ "$1" = hold ]; then sleep 30 & echo $! > ${dir}/helper; wait; exit 0; fi\nsleep 30 &\necho '{"ok":true}'\nexit 0\n`, { mode: 0o700 })
  let group
  t.after(() => { try { process.kill(-group, 'SIGKILL') } catch { /* gone */ } })
  const started = Date.now()
  assert.deepEqual(await C.execute({ cli, home: join(dir, 'home') }, ['machine', 'list'], { onSpawn: (child) => { group = child.pid } }), { ok: true })
  assert.ok(Date.now() - started < 20000, `answered after ${Date.now() - started} ms, not when the 30 s helper ended`)
  assert.equal(C.children.size, 0)

  // shutdown (index.ts) and simulation cancel call child.kill: it reaches the helper too
  let spawned
  const running = C.execute({ cli, home: join(dir, 'home') }, ['hold', 'x'], { onSpawn: (child) => { spawned = child } })
  for (let i = 0; i < 200 && !existsSync(join(dir, 'helper')); i++) await new Promise((r) => setTimeout(r, 10))
  assert.equal(C.children.size, 1)
  for (const child of C.children) child.kill('SIGTERM')
  await assert.rejects(running, (error) => error.transport === 'transport-unknown')
  const helper = Number(readFileSync(join(dir, 'helper'), 'utf8'))
  await new Promise((r) => setTimeout(r, 100))
  assert.throws(() => process.kill(helper, 0), /ESRCH/)
  assert.ok(spawned.pid)
})

test('a read refused by another process\'s Store lease (Failed/NotFound) is retried, at most twice; writes never', { timeout: 20000 }, async (t) => {
  const f = fresh()
  const lfs = C.client({ cli: f.cli, home: f.home })
  t.after(() => { delete process.env.FAKE_RACE_FAILS })
  const lists = () => f.log().filter((argv) => argv[1] === 'list' && argv[0] === 'file').length
  process.env.FAKE_RACE_FAILS = '2'
  assert.deepEqual((await lfs.file.list('demo/app', 'main', '/')).argv.slice(0, 2), ['file', 'list'])
  assert.equal(lists(), 3)
  rmSync(join(f.dir, 'race.count'))
  process.env.FAKE_RACE_FAILS = '3'
  await assert.rejects(lfs.file.list('demo/app', 'main', '/src'), (error) => error.code === 'Failed' && /NotFound/.test(error.message) && C.storeRace(error))
  assert.equal(lists(), 6, 'one try and two retries')
  rmSync(join(f.dir, 'race.count'))
  process.env.FAKE_RACE_FAILS = '1'
  await assert.rejects(lfs.file.write('demo/app', 'main', '/x', 'body'), (error) => error.code === 'Failed')
  assert.equal(f.log().filter((argv) => argv[1] === 'write').length, 1, 'a write is never replayed')
  assert.equal(C.storeRace(new C.CliError('Failed', 'Busy')), false)
})

test('null options are left out; an omitted optional positional followed by a given one is refused', { timeout: 20000 }, async () => {
  const f = fresh()
  const lfs = C.client({ cli: f.cli, home: f.home })
  const { argv } = await lfs.branch.diff('demo/app', 'a', 'b', { path_prefix: null, paths_only: null })
  assert.deepEqual(argv, ['branch', 'diff', '--', 'demo/app', 'a', 'b'])
  await assert.rejects(lfs.project.stats('demo/app', undefined, 'c1'), (error) => error.code === 'InvalidInput' && /commit/.test(error.message))
  await assert.rejects(lfs.project.stats('demo/app', null, 'c1'), (error) => error.code === 'InvalidInput')
  assert.deepEqual((await lfs.project.stats('demo/app', 'main', undefined)).argv, ['project', 'stats', '--', 'demo/app', 'main'])
  assert.deepEqual((await lfs.file.write('demo/app', 'main', '/x', 'body', { message: null })).argv, ['file', 'write', '--', 'demo/app', 'main', '/x'])
  assert.ok(!f.log().some((argv) => argv[1] === 'stats' && argv.includes('c1')), 'the shifted call never ran')
})

test('ensureNative retries after a failed record and caches a success', { skip: process.platform !== 'darwin' && 'macOS only', timeout: 20000 }, async (t) => {
  const f = fresh()
  rmSync(join(f.home, 'layerfs.json'))
  const daemon = join(f.dir, 'layerfs-daemon'); writeFileSync(daemon, '')
  process.env.FAKE_UPDATE_FAILS = '1'
  t.after(() => { delete process.env.FAKE_UPDATE_FAILS })
  const service = new C.LayerfsService(new C.Context(), { cli: f.cli, daemon, home: f.home, root: join(f.dir, 'root') })
  const updates = () => f.log().filter((argv) => argv[0] === 'machine' && argv[1] === 'update').length
  await service.ensureNative()
  assert.equal(updates(), 1)
  await service.ensureNative()
  assert.equal(updates(), 2, 'the failed attempt is not kept')
  await service.ensureNative()
  assert.equal(updates(), 2, 'a recorded daemon is kept')
})

test('preset calls: reads and short writes keep 2 minutes, long work gets 30 minutes', () => {
  assert.equal(C.presetTimeout(['machine', 'list'], true), C.PRESET_TIMEOUT_MS)
  assert.equal(C.presetTimeout(['file', 'write', 'p/a', 'main', '/x'], false), C.PRESET_TIMEOUT_MS)
  for (const argv of [['machine', 'create', 'vm', 'lima'], ['machine', 'start', 'vm'], ['store', 'push', 's', 'vm'], ['project', 'init', 'p/a', '/src'], ['sandbox', 'create', 'p/a', 'sb']]) {
    assert.equal(C.presetTimeout(argv, false), C.PRESET_LONG_TIMEOUT_MS, argv.join(' '))
  }
  assert.equal(C.PRESET_LONG_TIMEOUT_MS, 30 * 60_000)
})
