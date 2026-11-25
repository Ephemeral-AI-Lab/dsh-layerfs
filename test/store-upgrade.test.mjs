// Store upgrade (LayerFS #804 §10): the host job (src/host/routes/storage.ts,
// jobs.ts) and its words (src/client/storage/model.ts). The `upgrade` kind and
// its steps per family, Cancel = SIGTERM to the CLI with its reply deciding
// (`Cancelled` -> stopped, a late `upgraded` -> succeeded, a killed CLI ->
// unknown), Cancel refused at `commit` and deferred until the first phase, the
// restart's `interrupted` with its Check (`store get --with format`), formats
// in the view only when the CLI has them, the fix line, and the format words.
//   node --test test/store-upgrade.test.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-store-upgrade-'))
after(() => rmSync(out, { recursive: true, force: true }))
const bundle = async (contents, name) => {
  await build({ absWorkingDir: root, stdin: { contents, resolveDir: root, loader: 'ts' }, outfile: join(out, name), bundle: true, format: 'esm', platform: 'node', target: 'node24', logLevel: 'warning' })
  return import(pathToFileURL(join(out, name)).href)
}
const H = await bundle("export { Storage, storeRow, formatOf } from './src/host/routes/storage.ts'\nexport * from './src/host/routes/jobs.ts'\nexport { runnableFix } from './src/shared/doctor.ts'", 'host.mjs')
const M = await bundle("export * from './src/client/storage/model.ts'", 'model.mjs')

const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms
  while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 5)) }
}
const refusal = (code, message, detail = null) => Object.assign(new Error(message), { code, detail, transport: 'refusal' })
const CANCELLED = () => refusal('Failed', 'cancelled before COMMIT; nothing changed', { code: 'Cancelled' })
const UPGRADE_TABLE = { calls: [{ family: 'store', call: 'upgrade', args: [], options: [] }, { family: 'store', call: 'get', args: [], options: [], form: { with: { live: {}, stats: {}, format: {} } } }, { family: 'store', call: 'list', args: [], options: [], form: { with: { stats: {}, format: {} } } }], identity: { features: [], formats: { sqlite: 3, postgresql: 4 } } }

let n = 0
/** A Storage over a fake SDK whose upgrade the test drives (`ctl`), and a kill recorder. */
function fixture({ engine = 'sqlite', discovery = UPGRADE_TABLE, upgrade, kill } = {}) {
  const dir = join(out, `home-${n++}`)
  const ctl = { calls: [] }
  const lfs = {
    store: {
      get: async (store, opts) => { ctl.calls.push(['store.get', store, opts ?? null]); return ctl.get ?? { store, engine, state: 'ready' } },
      list: async (opts) => { ctl.calls.push(['store.list', opts]); return { items: ctl.items ?? [] } },
      upgrade: upgrade ?? ((store, opts) => {
        ctl.calls.push(['store.upgrade', store, { ...opts, on_progress: !!opts.on_progress, on_spawn: !!opts.on_spawn }])
        return new Promise((resolve, reject) => Object.assign(ctl, { opts, resolve, reject, spawn: (pid = 4242) => opts.on_spawn(pid), progress: (phase) => opts.on_progress({ phase, done: null, total: null }) }))
      }),
    },
    machine: { list: async () => ({ items: [] }) },
    home: { get: async () => ({ tree: { buckets: [] } }) },
  }
  const kills = []
  const events = []
  const host = { home: join(dir, 'home'), jobs: join(dir, 'jobs'), stats: join(dir, 'stats'), lfs: () => lfs, discover: async () => discovery, emit: (type, data) => events.push({ type, data }), log: () => {} }
  const svc = new H.Storage(host, kill === 'real' ? undefined : kill ?? ((pid, signal) => kills.push([pid, signal])))
  return { svc, ctl, kills, events, host }
}
const ended = (svc, id) => until(() => svc.job(id).ended)

test('jobs: an upgrade has its steps per family; Cancelled is stopped, a lost reply unknown, any other refusal failed', () => {
  assert.deepEqual(H.UPGRADE_STEPS.sqlite, ['check', 'convert', 'verify', 'commit'])
  assert.deepEqual(H.UPGRADE_STEPS.postgresql, ['check', 'convert'])
  assert.equal(H.upgradeOutcome(CANCELLED()), 'stopped')
  assert.equal(H.upgradeOutcome(refusal('Failed', 'check store.integrity failed')), 'failed')
  assert.equal(H.upgradeOutcome(refusal('InUse', 'mounted')), 'failed')
  assert.equal(H.upgradeOutcome(Object.assign(new Error('gone'), { code: 'Unknown', transport: 'transport-unknown' })), 'unknown')
  // dsh's own Cancelled (an AbortSignal) is never an upgrade's answer: only LayerFS's refusal is stopped
  assert.equal(H.upgradeOutcome(Object.assign(new Error('x'), { code: 'Failed', detail: { code: 'Cancelled' }, transport: 'transport-unknown' })), 'unknown')
  assert.equal(H.transferSummary({ outcome: 'stopped' }), 'Cancelled · nothing changed')
})

test('host: store.upgrade runs as a job with the family\'s steps, --progress, and its reply as the result', async () => {
  const { svc, ctl } = fixture({ engine: 'postgresql' })
  const job = await svc.upgrade('old')
  assert.equal(job.kind, 'upgrade')
  assert.deepEqual(job.steps, ['check', 'convert'])
  await until(() => ctl.resolve)
  assert.deepEqual(ctl.calls.find((c) => c[0] === 'store.upgrade'), ['store.upgrade', 'old', { on_progress: true, on_spawn: true, detail: true }])
  ctl.spawn(); ctl.progress('check'); ctl.progress('convert')
  assert.deepEqual(svc.job(job.id).phases.map((p) => p.phase), ['check', 'convert'])
  ctl.resolve({ outcome: 'upgraded', format_before: 3, format_after: 4 })
  await ended(svc, job.id)
  assert.equal(svc.job(job.id).outcome, 'succeeded')
  assert.deepEqual(svc.job(job.id).result, { outcome: 'upgraded', format_before: 3, format_after: 4 })
})

test('host: without store.upgrade in the call table the route refuses 501 and nothing runs', async () => {
  const { svc, ctl } = fixture({ discovery: { calls: [], identity: { features: [] } } })
  await assert.rejects(svc.upgrade('old'), (e) => e.status === 501 && e.code === 'Unsupported')
  assert.ok(!ctl.calls.some((c) => c[0] === 'store.upgrade'))
})

test('host: Cancel sends SIGTERM once, the job reads Stopping, and the Cancelled reply ends it stopped', async () => {
  const { svc, ctl, kills, events } = fixture()
  const job = await svc.upgrade('old')
  await until(() => ctl.spawn)
  ctl.spawn(777); ctl.progress('check'); ctl.progress('convert')
  const asked = svc.stop(job.id)
  assert.equal(asked.stopping, true)
  assert.deepEqual(kills, [[777, 'SIGTERM']])
  svc.stop(job.id)
  assert.equal(kills.length, 1, 'a second press sends nothing more')
  assert.ok(events.some((e) => e.type === 'storage-job' && e.data.job.stopping), 'the stopping job goes out')
  assert.equal(svc.job(job.id).ended, null, 'Stop never ends the job itself: the reply does')
  ctl.reject(CANCELLED())
  await ended(svc, job.id)
  const done = svc.job(job.id)
  assert.equal(done.outcome, 'stopped')
  assert.equal(done.error.detail.code, 'Cancelled')
})

test('host: a Cancel that lands too late reads the reply: upgraded is success', async () => {
  const { svc, ctl, kills } = fixture()
  const job = await svc.upgrade('old')
  await until(() => ctl.spawn)
  ctl.spawn(778); ctl.progress('check'); ctl.progress('verify')
  svc.stop(job.id)
  assert.deepEqual(kills, [[778, 'SIGTERM']])
  ctl.progress('commit')
  ctl.resolve({ outcome: 'upgraded', warnings: [] })
  await ended(svc, job.id)
  assert.equal(svc.job(job.id).outcome, 'succeeded')
  assert.equal(svc.job(job.id).error, null)
})

test('host: Cancel is refused 409 at commit, for another kind, and after the end', async () => {
  const { svc, ctl, kills } = fixture()
  const job = await svc.upgrade('old')
  await until(() => ctl.spawn)
  ctl.spawn(); ctl.progress('check'); ctl.progress('convert'); ctl.progress('verify'); ctl.progress('commit')
  assert.throws(() => svc.stop(job.id), (e) => e.status === 409 && e.code === 'Busy' && /commit/.test(e.message))
  assert.deepEqual(kills, [])
  ctl.resolve({ outcome: 'upgraded' })
  await ended(svc, job.id)
  assert.throws(() => svc.stop(job.id), (e) => e.status === 409)
  assert.throws(() => svc.stop('nope'), (e) => e.status === 404)
})

test('host: a Cancel before the CLI is spawned signals it as soon as its pid is known, with no phase needed', async () => {
  const { svc, ctl, kills } = fixture()
  const job = await svc.upgrade('old')
  svc.stop(job.id)
  assert.deepEqual(kills, [], 'no pid yet: nothing to signal')
  await until(() => ctl.spawn)
  ctl.spawn(779)
  assert.deepEqual(kills, [[779, 'SIGTERM']], 'signalled at spawn, before any phase')
  // a kill before LayerFS masks the signal ends the CLI by the signal: Unknown, never a false Cancelled
  ctl.reject(Object.assign(new Error('LayerFS ended without a complete result'), { code: 'Unknown', transport: 'transport-unknown', detail: { signal: 'SIGTERM' } }))
  await ended(svc, job.id)
  assert.equal(svc.job(job.id).outcome, 'unknown')
})

test('host: a kill that fails is not counted: the next Stop tries again; ESRCH (already gone) counts', async () => {
  const kills = []
  let fail = 'EPERM'
  const { svc, ctl } = fixture({ kill: (pid, signal) => { kills.push([pid, signal]); if (fail) throw Object.assign(new Error(fail), { code: fail }) } })
  const job = await svc.upgrade('old')
  await until(() => ctl.spawn)
  ctl.spawn(780); ctl.progress('check')
  svc.stop(job.id)
  assert.equal(kills.length, 1)
  assert.equal(svc.job(job.id).stopping, true)
  fail = 'ESRCH'
  svc.stop(job.id)
  assert.equal(kills.length, 2, 'the second press retries the failed kill')
  svc.stop(job.id)
  assert.equal(kills.length, 2, 'ESRCH: the process is gone, its reply is on its way; nothing more is sent')
  ctl.reject(CANCELLED())
  await ended(svc, job.id)
  assert.equal(svc.job(job.id).outcome, 'stopped')
})

test('host: the short reply has no `ok` key ({"outcome":"upgraded"}); the outcome never depends on it', async () => {
  for (const reply of [{ outcome: 'upgraded' }, { outcome: 'current' }]) {
    const { svc, ctl } = fixture()
    const job = await svc.upgrade('old')
    await until(() => ctl.resolve)
    ctl.resolve(reply)
    await ended(svc, job.id)
    const done = svc.job(job.id)
    assert.equal(done.outcome, 'succeeded')
    assert.equal(M.upgradeEnd(done, t).word, reply.outcome === 'current' ? 'jobUpgradeCurrent {"place":"old"}' : 'jobUpgraded {"place":"old"}')
  }
})

test('host: without --with format the Check reads no format and says format unknown', async () => {
  const { svc, ctl } = fixture({ discovery: { calls: [{ family: 'store', call: 'upgrade', args: [], options: [] }], identity: { features: [] } } })
  const job = await svc.upgrade('old')
  await until(() => ctl.reject)
  ctl.reject(Object.assign(new Error('gone'), { code: 'Unknown', transport: 'transport-unknown' }))
  await ended(svc, job.id)
  const seen = await svc.inspect(job.id)
  assert.ok(!ctl.calls.some((c) => c[0] === 'store.get' && c[2]?.with), 'no `--with format` is sent')
  assert.equal(seen.observation.value.format.status, 'unknown')
  const end = M.upgradeEnd(seen, t)
  assert.deepEqual([end.state, end.check], ['warning', true])
  assert.match(end.tip, /upgradeFormatUnknownTip/)
})

test('host: a Store holds one job: a second upgrade while one runs is refused', async () => {
  const { svc, ctl } = fixture()
  await svc.upgrade('old')
  await until(() => ctl.spawn)
  await assert.rejects(svc.upgrade('old'), (e) => e.status === 409)
})

/** A fake `layerfs store upgrade` child: progress lines on stdout; on SIGTERM it answers as `onTerm` says and exits. */
function fakeCli(onTerm) {
  const script = `
    const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
    process.on('SIGTERM', () => {
      ${onTerm === 'cancel' ? "process.stderr.write(JSON.stringify({ error: 'Failed', message: 'cancelled before COMMIT; nothing changed', detail: { code: 'Cancelled' } }) + '\\n'); process.exit(125)" : "say({ ok: true, outcome: 'upgraded' }); process.exit(0)"}
    })
    say({ progress: { phase: 'check', done: null, total: null } })
    setTimeout(() => say({ progress: { phase: 'convert', done: null, total: null } }), 20)
    setTimeout(() => process.exit(3), 20000)
  `
  return (store, opts) => new Promise((resolve, reject) => {
    // not a test-runner child: without NODE_TEST_CONTEXT its stdout is its own
    const { NODE_TEST_CONTEXT: _, ...env } = process.env
    const child = spawn(process.execPath, ['-e', script], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env })
    let err = '', buf = '', result
    child.stdout.on('data', (d) => {
      buf += d
      for (let i; (i = buf.indexOf('\n')) >= 0;) {
        const line = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1)
        if (line.progress) opts.on_progress(line.progress); else result = line
      }
    })
    child.stderr.on('data', (d) => { err += d })
    opts.on_spawn(child.pid)
    child.on('close', (code, signal) => {
      if (signal) return reject(Object.assign(new Error('LayerFS ended without a complete result'), { code: 'Unknown', transport: 'transport-unknown', detail: { signal } }))
      if (code === 0 && result) return resolve(result)
      const r = JSON.parse(err)
      reject(Object.assign(new Error(r.message), { code: r.error, detail: r.detail, transport: 'refusal' }))
    })
  })
}

test('host: Stop sends a real SIGTERM to the CLI\'s process group; the child\'s Cancelled reply ends it stopped', async () => {
  const { svc } = fixture({ upgrade: fakeCli('cancel'), kill: 'real' })
  // the default kill: the export Stop's own killGroup
  const job = await svc.upgrade('old')
  await until(() => svc.job(job.id).phase === 'convert')
  svc.stop(job.id)
  await ended(svc, job.id)
  assert.equal(svc.job(job.id).outcome, 'stopped')
})

test('host: with a real child that finishes on SIGTERM, the reply decides: succeeded', async () => {
  const { svc } = fixture({ upgrade: fakeCli('finish'), kill: 'real' })
  const job = await svc.upgrade('old')
  await until(() => svc.job(job.id).phase === 'convert')
  svc.stop(job.id)
  await ended(svc, job.id)
  assert.equal(svc.job(job.id).outcome, 'succeeded')
})

test('host restart: a running upgrade reads interrupted, and its Check reads `store get --with format`', async () => {
  const first = fixture()
  const job = await first.svc.upgrade('old')
  await until(() => first.ctl.spawn)
  first.ctl.spawn(); first.ctl.progress('convert')
  // a new host over the same job folder (dsh restarted: its SIGTERM cancelled the CLI)
  first.ctl.get = { store: 'old', engine: 'sqlite', state: 'ready', format: { version: 3, latest: 3, status: 'current' } }
  const again = new H.Storage({ ...first.host, lfs: first.host.lfs }, () => {})
  await again.reconciled
  const seen = again.job(job.id)
  assert.equal(seen.outcome, 'interrupted')
  assert.equal(seen.observation.kind, 'upgrade')
  assert.deepEqual(seen.observation.value.format, { version: 3, latest: 3, status: 'current' })
  const read = first.ctl.calls.filter((c) => c[0] === 'store.get' && c[2]?.with?.includes('format'))
  assert.ok(read.length >= 1 && read.every((c) => c[2].timeout_ms > 0), 'the Check asks afresh (its own budget skips kept answers)')
  // and in words: the format says it was upgraded
  assert.equal(M.upgradeEnd(seen, t).state, 'ok')
})

test('view: --with format joins the one store list read only when the CLI has it; rows carry format and a running upgrade is busy', async () => {
  const withFormat = fixture()
  withFormat.ctl.items = [{ store: 'old', engine: 'sqlite', machine: 'native', state: 'ready', format: { version: 2, latest: 3, status: 'outdated', fix: 'layerfs store upgrade old' } }]
  const v = await withFormat.svc.view(true)
  assert.deepEqual(withFormat.ctl.calls.find((c) => c[0] === 'store.list')[1].with, ['stats', 'format'])
  assert.equal(withFormat.ctl.calls.filter((c) => c[0] === 'store.list').length, 1, 'no read of its own')
  assert.deepEqual(v.stores[0].format, { version: 2, latest: 3, status: 'outdated', fix: 'layerfs store upgrade old' })
  assert.deepEqual([v.upgrade, v.format, v.formats], [true, true, { sqlite: 3, postgresql: 4 }])
  const old = fixture({ discovery: { calls: [], identity: { features: [] } } })
  old.ctl.items = [{ store: 'old', engine: 'sqlite', machine: 'native', state: 'ready' }]
  const w = await old.svc.view(true)
  assert.deepEqual(old.ctl.calls.find((c) => c[0] === 'store.list')[1].with, ['stats'])
  assert.deepEqual([w.upgrade, w.format, w.formats, w.stores[0].format], [false, false, null, null])
  // this host's running upgrade holds the Store: busy with store.upgrade (Mount and Sandbox create wait)
  const row = H.storeRow({ store: 'old', state: 'ready' }, [{ store: 'old', kind: 'upgrade', ended: null, phase: 'convert', started: 5 }])
  assert.equal(row.state, 'busy')
  assert.deepEqual([row.op.name, row.op.phase], ['store.upgrade', 'convert'])
  assert.equal(H.storeRow({ store: 'old', state: 'ready' }, [{ store: 'old', kind: 'compact', ended: null }]).state, 'ready')
  assert.equal(H.formatOf({ version: 2 }), null, 'no status: no format')
})

test('fix line: `layerfs store upgrade <store>` is the Store\'s own upgrade', () => {
  assert.deepEqual(H.runnableFix('layerfs store upgrade old'), { kind: 'upgrade', store: 'old' })
  assert.ok(M.namesUpgrade('layerfs store upgrade old', 'old'))
  assert.ok(!M.namesUpgrade('layerfs store remove old', 'old'))
  assert.ok(!M.namesUpgrade('layerfs store upgrade other', 'old'))
})

const t = (key, vars = {}) => `${key}${Object.keys(vars).length ? ' ' + JSON.stringify(vars) : ''}`

test('words: the format row, tips and chips come from --with format alone', () => {
  const f = (version, latest, status, fix = null) => ({ version, latest, status, fix })
  assert.equal(M.formatWords(f(3, 3, 'current'), t), 'fmtLatest {"v":"3"}')
  assert.equal(M.formatWords(f(2, 3, 'outdated'), t), 'fmtBehind {"v":"2","latest":"3"}')
  assert.equal(M.formatWords(f(4, 3, 'newer'), t), 'fmtNewer {"v":"4"}')
  assert.equal(M.formatWords(null, t), null)
  assert.match(M.formatTip(f(2, 3, 'outdated'), t), /^fmtTip/)
  assert.deepEqual(M.formatChip(f(2, 3, 'outdated'), t), { tone: 'danger', label: 'spOutdated' })
  // no upgrade path: its own words, never Outdated; an unreadable format (`unknown`) earns no chip
  assert.deepEqual(M.formatChip(f(1, 3, 'unsupported'), t), { tone: 'danger', label: 'fmtUnsupportedChip' })
  assert.equal(M.formatWords(f(1, 3, 'unsupported'), t), 'fmtNoPath {"v":"1"}')
  assert.equal(M.formatWords(f(null, 3, 'unsupported'), t), 'fmtUnknown', 'an unrecognized one reads Format unknown')
  assert.equal(M.formatChip(f(null, 3, 'unknown'), t), null)
  assert.equal(M.formatWords(f(null, 3, 'unknown'), t), 'fmtUnknown')
  assert.equal(M.formatTip(f(null, 3, 'unknown'), t), 'fmtTip {"words":"fmtUnknown"}')
  assert.ok(!M.canUpgrade({ name: 'old', format: f(null, 3, 'unknown') }, { upgrade: true }))
  assert.deepEqual(M.formatChip(f(4, 3, 'newer'), t), { tone: 'warning', label: 'fmtNewerChip' })
  assert.equal(M.formatChip(f(3, 3, 'current'), t), null)
  assert.equal(M.upgradeLine(f(2, 3, 'outdated'), t), 'fmtArrow {"from":"2","to":"3"}')
  const s = { name: 'old', format: f(2, 3, 'outdated', 'layerfs store upgrade old') }
  assert.ok(M.canUpgrade(s, { upgrade: true }))
  assert.ok(!M.canUpgrade(s, { upgrade: false }), 'a runtime without store upgrade offers none')
  assert.ok(!M.canUpgrade({ name: 'old', format: f(1, 3, 'unsupported', 'layerfs store remove old') }, { upgrade: true }))
  assert.ok(M.canUpgrade({ name: 'old', format: null }, { upgrade: true }, 'layerfs store upgrade old'), 'a refusal\'s fix names it too')
})

test('words: the stepper, Cancel at commit, and each end state as a signal', () => {
  const job = (over = {}) => ({ id: 'u', kind: 'upgrade', store: 'old', target: 'old', file: null, started: 1, ended: null, phase: null, done: null, total: null, error: null, phases: [], steps: ['check', 'convert', 'verify', 'commit'], ...over })
  const p = (...phases) => phases.map((phase, i) => ({ phase, half: null, at: i }))
  assert.deepEqual(M.stepsOf(job({ phase: 'convert', phases: p('check', 'convert') })).map((s) => s.state), ['done', 'now', 'todo', 'todo'])
  // an unknown phase appends at the end
  assert.deepEqual(M.stepsOf(job({ phase: 'tidy', phases: p('check', 'tidy') })).map((s) => s.step), ['check', 'convert', 'verify', 'commit', 'tidy'])
  assert.equal(M.stepWords('convert', t), 'stepConvert')
  assert.equal(M.stepWords('commit', t), 'stepCommit')
  assert.equal(M.doingWords(job(), t), 'jobUpgrading {"place":"old"}')
  assert.equal(M.kindWords('upgrade', t), 'kindUpgrade')
  assert.ok(M.upgradeFinishing(job({ phase: 'commit' })))
  assert.ok(!M.upgradeFinishing(job({ phase: 'verify' })))
  assert.equal(M.elapsedWords(65_000), '1:05')
  assert.equal(M.elapsedWords(3_725_000), '1:02:05')
  const okEnd = M.upgradeEnd(job({ ended: 9, outcome: 'succeeded', result: { outcome: 'upgraded', format_after: 3 } }), t)
  assert.deepEqual([okEnd.state, okEnd.word, okEnd.check], ['ok', 'jobUpgraded {"place":"old"}', false])
  assert.match(okEnd.tip, /fmtLatest/)
  assert.equal(M.upgradeEnd(job({ ended: 9, outcome: 'succeeded', result: { outcome: 'current' } }), t).word, 'jobUpgradeCurrent {"place":"old"}')
  const stopped = M.upgradeEnd(job({ ended: 9, outcome: 'stopped', error: { code: 'Failed', message: 'cancelled', detail: { code: 'Cancelled' }, phase: 'convert' } }), t)
  assert.deepEqual([stopped.state, stopped.word], ['idle', 'jobUpgradeStopped {"place":"old"}'])
  const failed = M.upgradeEnd(job({ ended: 9, outcome: 'failed', error: { code: 'Failed', message: 'check store.integrity failed', phase: 'verify' } }), t)
  assert.equal(failed.state, 'error')
  assert.match(failed.tip, /store\.integrity/, 'the tip names the check')
  const unknown = M.upgradeEnd(job({ ended: 9, outcome: 'unknown', error: { code: 'Unknown', message: 'gone', phase: 'convert' } }), t)
  assert.deepEqual([unknown.state, unknown.check], ['warning', true])
  assert.equal(M.upgradeEnd(job({ ended: 9, outcome: 'interrupted', error: { code: 'Interrupted', message: 'restart' } }), t).state, 'warning')
  const checkedOld = M.upgradeEnd(job({ ended: 9, outcome: 'unknown', observation: { at: 10, kind: 'upgrade', value: { format: { version: 2, latest: 3, status: 'outdated' } } } }), t)
  assert.deepEqual([checkedOld.state, checkedOld.word], ['error', 'jobUpgradeOutdated {"place":"old"}'])
  assert.equal(M.endedWords(job({ ended: 9, outcome: 'stopped', error: { code: 'Failed', message: 'x' } }), t), 'jobUpgradeStopped {"place":"old"}')
})
