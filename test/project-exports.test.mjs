// Project exports to a folder (src/host/routes/project-exports.ts): admission,
// naming, the pinned version, progress, stop at each stage, and a live pass
// over the real pinned CLI against a private temporary LAYERFS_HOME.
//   node --test test/project-exports.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { liveSkipReason, loadRoutes, pinned, testHost } from './routes-helper.mjs'
import { tmpRoot } from './support/env.mjs'

const R = await loadRoutes()
const { ProjectExports, folderName, defaultName } = R.exportsModule
const tick = () => new Promise((r) => setTimeout(r, 0))
const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms
  while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 5)) }
}

/** A fake SDK whose export the test drives: `ctl.spawn()`, `ctl.progress(p)`, `ctl.resolve(answer)`, `ctl.reject(error)`. */
function fixture({ stats = { commit: 'c'.repeat(66), size: 1000, file_count: 3 } } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-exports-')))
  const folder = join(root, 'out')
  mkdirSync(folder)
  const calls = []
  const ctl = {}
  const lfs = {
    branch: {
      get: async (project, branch) => { calls.push(['branch.get', project, branch]); return { commit: ctl.branchHead ?? 'c'.repeat(66) } },
    },
    project: {
      stats: async (project, opts) => { calls.push(['stats', project, opts]); if (ctl.statsGate) await ctl.statsGate; return typeof stats === 'function' ? stats(opts) : stats },
      export: (project, dest, opts) => {
        calls.push(['export', project, dest, { ...opts, on_progress: !!opts.on_progress, on_spawn: !!opts.on_spawn }])
        return new Promise((resolve, reject) => Object.assign(ctl, {
          spawn: (pid = 4242) => opts.on_spawn(pid),
          progress: (p) => opts.on_progress(p),
          resolve: (answer) => { mkdirSync(dest); resolve(answer) },
          reject,
          dest,
        }))
      },
    },
  }
  const kills = []
  const t = testHost({ lfs, root: join(root, 'plugin'), home: join(root, 'home'), discovery: async () => ({}) })
  mkdirSync(join(root, 'home'))
  const exports = new ProjectExports(t.host, (pid, signal) => kills.push([pid, signal]))
  const events = () => t.events.filter((e) => e.type === 'project-export').map((e) => e.data.export)
  return { root, folder, calls, ctl, kills, exports, events, t, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('folder names and defaults', () => {
  assert.equal(folderName('feature/login fix'), 'feature-login-fix')
  assert.equal(folderName('..hidden'), 'hidden')
  assert.equal(defaultName('shop/web', 'main', null), 'web')
  assert.equal(defaultName('shop/web', 'main', 'abcdef0123456789'), 'web-main-abcdef01')
  assert.equal(defaultName('shop/web', 'session/d7d156f8', 'abcdef0123456789'), 'web-session-d7d156f8-abcdef01')
})

test('an export pins the version, reports progress and ends done', async () => {
  const f = fixture()
  try {
    const job = f.exports.start({ project: 'shop/web', folder: f.folder })
    assert.equal(job.phase, 'queued')
    assert.equal(job.destination, join(f.folder, 'web'))
    assert.equal(job.head, true)
    await until(() => f.ctl.spawn)
    // the export runs at the Commit stats read, on the Branch (LayerFS refuses an --at outside it)
    assert.deepEqual(f.calls[0], ['stats', 'shop/web', { branch: 'main', detail: true }])
    assert.equal(f.calls[1][3].at, 'c'.repeat(66))
    assert.equal(f.calls[1][3].branch, 'main')
    f.ctl.spawn()
    f.ctl.progress({ phase: 'prepare', done: null, total: null })
    f.ctl.progress({ phase: 'export', done: 400, total: null })
    const mid = f.exports.get(job.id)
    assert.deepEqual([mid.phase, mid.done, mid.total, mid.files], ['export', 400, 1000, 3])
    f.ctl.resolve({ file_count: 3, size: 1000 })
    await until(() => f.exports.get(job.id).phase === 'done')
    const done = f.exports.get(job.id)
    assert.deepEqual([done.done, done.total], [1000, 1000])
    assert.ok(done.endedAt)
    assert.ok(f.events().some((e) => e.phase === 'export'))
    assert.equal(f.events().at(-1).phase, 'done')
    assert.equal(f.exports.busy(), false)
    // still listed, filtered by project, until dismissed
    assert.equal(f.exports.list('shop/web').exports.length, 1)
    assert.equal(f.exports.list('shop/other').exports.length, 0)
    assert.equal(f.exports.dismiss(job.id).exports.length, 0)
  } finally { f.cleanup() }
})

test('names never collide with a folder on disk or a running export', async () => {
  const f = fixture()
  try {
    mkdirSync(join(f.folder, 'web'))
    const a = f.exports.start({ project: 'shop/web', folder: f.folder })
    const b = f.exports.start({ project: 'shop/web', folder: f.folder })
    assert.equal(a.destination, join(f.folder, 'web-2'))
    assert.equal(b.destination, join(f.folder, 'web-3'))
    const c = f.exports.start({ project: 'shop/web', folder: f.folder, branch: 'work', commit: 'abcdef0123', name: 'my export!' })
    assert.equal(c.destination, join(f.folder, 'my-export'))
    assert.equal(c.head, false, 'admitted before its Branch head is read')
    await until(() => f.exports.get(c.id).commit === 'c'.repeat(66) && f.calls.some((x) => x[0] === 'branch.get'))
    await until(() => f.exports.get(c.id).head === true)
  } finally { f.exports.close(); f.cleanup() }
})

test('admission refuses bad input', () => {
  const f = fixture()
  try {
    assert.throws(() => f.exports.start({ project: 'web', folder: f.folder }), /project key/)
    assert.throws(() => f.exports.start({ project: 'shop/web', folder: 'relative/dir' }), /absolute/)
    assert.throws(() => f.exports.start({ project: 'shop/web', folder: join(f.folder, 'missing') }), /not an existing folder/)
    assert.throws(() => f.exports.start({ project: 'shop/web', folder: f.folder, commit: 'xyz' }), /hexadecimal/)
    assert.throws(() => f.exports.start({ project: 'shop/web', folder: join(f.root, 'home') }), /outside the LayerFS home/)
    mkdirSync(join(f.root, 'plugin', 'x'), { recursive: true })
    assert.throws(() => f.exports.start({ project: 'shop/web', folder: join(f.root, 'plugin', 'x') }), /outside DeepSeek Harness/)
    assert.equal(f.exports.list().exports.length, 0)
  } finally { f.cleanup() }
})

test('stop while copying ends the process group and ends stopped', async () => {
  const f = fixture()
  try {
    const job = f.exports.start({ project: 'shop/web', folder: f.folder })
    await until(() => f.ctl.spawn)
    f.ctl.spawn(777)
    f.ctl.progress({ phase: 'export', done: 100 })
    const stopping = f.exports.stop(job.id)
    assert.equal(stopping.phase, 'stopping')
    assert.deepEqual(f.kills, [[777, 'SIGTERM']])
    // a late progress line does not undo the stop
    f.ctl.progress({ phase: 'export', done: 200 })
    assert.equal(f.exports.get(job.id).phase, 'stopping')
    // a second stop sends nothing more
    f.exports.stop(job.id)
    assert.equal(f.kills.length, 1)
    f.ctl.reject(Object.assign(new Error('LayerFS ended without a complete result'), { code: 'Unknown' }))
    await until(() => f.exports.get(job.id).phase === 'stopped')
    assert.equal(f.exports.get(job.id).error, undefined)
    assert.throws(() => f.exports.stop(job.id), /already ended/)
  } finally { f.cleanup() }
})

test('stop before the process starts ends it as soon as it spawns; stop while reading stats never starts it', async () => {
  const f = fixture()
  try {
    const job = f.exports.start({ project: 'shop/web', folder: f.folder })
    await until(() => f.ctl.spawn)
    f.exports.stop(job.id)
    assert.deepEqual(f.kills, [])
    f.ctl.spawn(888)
    assert.deepEqual(f.kills, [[888, 'SIGTERM']])
    f.ctl.reject(new Error('killed'))
    await until(() => f.exports.get(job.id).phase === 'stopped')

    let open
    f.ctl.statsGate = new Promise((r) => { open = r })
    f.ctl.spawn = null
    const second = f.exports.start({ project: 'shop/web', folder: f.folder })
    await tick()
    f.exports.stop(second.id)
    open()
    await until(() => f.exports.get(second.id).phase === 'stopped')
    assert.equal(f.calls.filter((c) => c[0] === 'export').length, 1, 'the second export never ran')
  } finally { f.cleanup() }
})

test('stop is refused while finalizing; a stop that lands too late reports done', async () => {
  const f = fixture()
  try {
    const job = f.exports.start({ project: 'shop/web', folder: f.folder })
    await until(() => f.ctl.spawn)
    f.ctl.spawn()
    f.ctl.progress({ phase: 'finalize', done: 1000 })
    assert.throws(() => f.exports.stop(job.id), (e) => e.code === 'Busy')
    f.ctl.resolve({ file_count: 3, size: 1000 })
    await until(() => f.exports.get(job.id).phase === 'done')

    const late = f.exports.start({ project: 'shop/web', folder: f.folder })
    await until(() => f.calls.filter((c) => c[0] === 'export').length === 2)
    f.ctl.spawn()
    f.exports.stop(late.id)
    mkdirSync(f.ctl.dest)
    f.ctl.reject(new Error('signal'))
    await until(() => f.exports.get(late.id).phase === 'done')
  } finally { f.cleanup() }
})

test('a refusal ends failed with its code; dismissing a running export is refused', async () => {
  const f = fixture()
  try {
    const job = f.exports.start({ project: 'shop/web', folder: f.folder, branch: 'nope' })
    await until(() => f.ctl.spawn)
    assert.throws(() => f.exports.dismiss(job.id), (e) => e.code === 'Busy')
    f.ctl.reject(Object.assign(new Error('Branch nope does not exist'), { code: 'NotFound' }))
    await until(() => f.exports.get(job.id).phase === 'failed')
    assert.deepEqual([f.exports.get(job.id).error.code, f.exports.get(job.id).error.message], ['NotFound', 'Branch nope does not exist'])
  } finally { f.cleanup() }
})

test('routes: start, list, get, stop and dismiss through the http operation', async () => {
  const f = fixture()
  try {
    const groups = R.createGroups(f.t.host, async () => ({}))
    const http = (method, path, body) => R.handle(groups, { method, path, body })
    const started = await http('POST', '/api/project-exports', { project: 'shop/web', folder: f.folder })
    assert.equal(started.status, 200, JSON.stringify(started.body))
    const listed = await http('GET', `/api/project-exports?project=${encodeURIComponent('shop/web')}`)
    assert.equal(listed.body.exports[0].id, started.body.id)
    assert.equal((await http('GET', `/api/project-exports/${started.body.id}`)).body.project, 'shop/web')
    const bad = await http('POST', '/api/project-exports', { project: 'shop/web', folder: 'nope' })
    assert.equal(bad.status, 400)
    await until(() => f.ctl.spawn)
    const stop = await http('POST', `/api/project-exports/${started.body.id}/stop`)
    assert.equal(stop.body.phase, 'stopping')
    f.ctl.reject(new Error('killed'))
    await until(() => groups.exports.get(started.body.id).phase === 'stopped')
    const gone = await http('DELETE', `/api/project-exports/${started.body.id}`)
    assert.deepEqual(gone.body.exports, [])
    assert.equal((await http('GET', '/api/project-exports/x-none')).status, 404)
  } finally { f.cleanup() }
})

// ---------------------------------------------------------------- live

const pin = pinned()

test('live: export main, a Branch Commit, and stop a running export', { skip: !pin && liveSkipReason(), timeout: 300_000 }, async (context) => {
  const root = tmpRoot('dshx-')
  const home = join(root, 'home')
  const env = { ...process.env, LAYERFS_HOME: home }
  const run = (...args) => execFileSync(pin.cli, args, { env, timeout: 120_000 }).toString()
  run('home', 'init')
  const src = join(root, 'src')
  mkdirSync(join(src, 'lib'), { recursive: true })
  writeFileSync(join(src, 'README.md'), 'hello\n')
  writeFileSync(join(src, 'lib', 'a.js'), 'export const a = 1\n')
  run('store', 'create', 'xp')
  run('project', 'init', 'xp/demo', src)
  run('branch', 'fork', 'xp/demo', 'work')
  execFileSync(pin.cli, ['file', 'write', 'xp/demo', 'work', '/README.md', '-m', 'change'], { env, input: 'changed\n', timeout: 60_000 })
  const out = join(root, 'out')
  mkdirSync(out)
  const lfs = R.cli.client({ cli: pin.cli, home })
  const t = testHost({ lfs, root: join(root, 'plugin'), home, cli: pin.cli, daemon: pin.daemon ?? null, discovery: () => R.cli.discover({ cli: pin.cli }) })
  const exports = new ProjectExports(t.host)
  context.after(() => {
    exports.close()
    try { execFileSync(pin.cli, ['machine', 'stop', 'macos-host'], { env, timeout: 30_000 }) } catch {}
    rmSync(root, { recursive: true, force: true })
  })
  const finish = async (job) => { await until(() => exports.get(job.id).endedAt, 120_000); return exports.get(job.id) }

  const main = await finish(exports.start({ project: 'xp/demo', folder: out }))
  assert.equal(main.phase, 'done', JSON.stringify(main.error))
  assert.equal(readFileSync(join(out, 'demo', 'README.md'), 'utf8'), 'hello\n')
  assert.equal(main.files, 2)
  assert.equal(main.done, main.total)
  assert.match(main.commit, /^[0-9a-f]{66}$/)

  const work = await finish(exports.start({ project: 'xp/demo', folder: out, branch: 'work', name: 'demo-work' }))
  assert.equal(work.phase, 'done', JSON.stringify(work.error))
  assert.equal(readFileSync(join(out, 'demo-work', 'README.md'), 'utf8'), 'changed\n')

  // main's import Commit is in work's history: work at that Commit is the original tree
  const back = await finish(exports.start({ project: 'xp/demo', folder: out, branch: 'work', commit: main.commit.slice(0, 16) }))
  assert.equal(back.phase, 'done', JSON.stringify(back.error))
  assert.equal(readFileSync(join(back.destination, 'README.md'), 'utf8'), 'hello\n')

  const missing = await finish(exports.start({ project: 'xp/demo', folder: out, branch: 'nope' }))
  assert.equal(missing.phase, 'failed')
  assert.equal(existsSync(missing.destination), false)

  // a stop as soon as the process starts leaves no folder
  const job = exports.start({ project: 'xp/demo', folder: out, name: 'stopped' })
  exports.stop(job.id)
  const stopped = await finish(job)
  assert.equal(stopped.phase, 'stopped')
  assert.equal(existsSync(stopped.destination), false)
})
