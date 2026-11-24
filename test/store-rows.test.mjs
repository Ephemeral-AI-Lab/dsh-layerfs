// The home Store tab's rows, as data (src/client/storage/store-rows.ts;
// docs/specs/store-home-rows.md): the caps, the shared status labels, a
// PostgreSQL row's summary and status word, loopback and login-in-URL
// detection, a SQLite row's state, the attach picker and Check all.
//   node --test test/store-rows.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-store-rows-'))
await build({
  absWorkingDir: root,
  stdin: { contents: "export * from './src/client/storage/store-rows.ts'\nexport { locales } from './src/client/storage/locale.ts'\n", resolveDir: root, loader: 'ts' },
  outfile: join(out, 'rows.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24', logLevel: 'warning',
})
const R = await import(pathToFileURL(join(out, 'rows.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

const reach = (ok, error = null) => ({ at: 1, ok, latencyMs: ok ? 2 : null, version: ok ? '17.6' : null, error })
const pg = (name, more = {}) => ({
  name, kind: 'postgresql', machine: null, projects: ['a', 'b'], projectsCount: 2, size: null, state: 'ready', links: [], job: null,
  postgresql: { url: 'postgresql://db.lan:5432/team', target: 'db.lan:5432/team', server: 'db.lan:5432', database: 'team', user: 'app', passwordSaved: true, passwordChangedAt: null, synchronousCommit: null, host: reach(true) },
  attached: [], ...more,
})
const machines = [
  { name: 'native', platform: 'native', state: 'ready', supports: ['sqlite', 'postgresql_sandbox'] },
  { name: 'docker', platform: 'docker', state: 'ready', supports: ['sqlite', 'postgresql_sandbox'] },
  { name: 'vm1', platform: 'lima', state: 'stopped', supports: ['sqlite', 'postgresql_sandbox'] },
  { name: 'vm2', platform: 'lima', state: 'broken', reason: 'outdated', supports: ['sqlite', 'postgresql_sandbox'] },
  { name: 'win', platform: 'wsl', state: 'ready', supports: ['sqlite'] },
]

test('caps: 5 rows in a list, and how many more', () => {
  assert.equal(R.LIST_ROWS, 5)
  assert.deepEqual(R.capped([1, 2, 3, 4, 5, 6, 7], R.LIST_ROWS), { shown: [1, 2, 3, 4, 5], more: 2 })
  assert.deepEqual(R.capped([1, 2], 3), { shown: [1, 2], more: 0 })
  assert.deepEqual(R.capped([1, 2], 0), { shown: [], more: 2 })
})

test('status labels: one shared set, each failure with its one action; LayerFS\'s words stay the tooltip', () => {
  const s = (r, opts) => { const x = R.reachStatus(r, opts); return [x.key, x.tone, x.fix] }
  assert.deepEqual(s(reach(true)), ['reachable', 'ok', null])
  assert.deepEqual(s(null), ['notChecked', 'idle', null], 'a machine attached but not checked yet')
  assert.deepEqual(s(reach(true), { checking: true }), ['checking', 'ongoing', null])
  assert.deepEqual(s(reach(false, 'connection refused (os error 61)')), ['address', 'danger', 'edit'])
  assert.deepEqual(s(reach(false, 'password authentication failed for user "app" (SQLSTATE 28P01)')), ['password', 'danger', 'edit'])
  for (const words of ['the server refused the session (SQLSTATE 28000)', 'FATAL: password authentication failed for user "x"', 'role x: SQLSTATE 28P01']) assert.equal(R.failureKey(words), 'password', words)
  assert.deepEqual(['ok', 'danger', 'warning', 'ongoing', 'idle'].map(R.dotState), ['done', 'error', 'warning', 'ongoing', 'idle'], 'one tone → dot rule')
  assert.deepEqual(['ready', 'busy', 'stopped', 'attention'].map(R.sqliteTone), ['ok', 'ongoing', 'warning', 'danger'], 'a stopped machine is a warning everywhere')
  assert.deepEqual(s(reach(false, 'database "team" does not exist (SQLSTATE 3D000)')), ['database', 'danger', 'edit'])
  assert.deepEqual(s(reach(false, 'this database holds another Store than pg')), ['notThisStore', 'danger', 'edit'])
  assert.deepEqual(s(reach(false, 'some opaque backend error')), ['failed', 'danger', 'edit'], 'never guessed')
  assert.deepEqual(s(reach(true), { machine: { state: 'stopped' } }), ['machineStopped', 'warning', 'start'], 'the machine\'s own state first')
  assert.deepEqual(s(null, { machine: { state: 'broken', reason: 'outdated' } }), ['machineUpdate', 'warning', 'update'])
  assert.equal(R.reachStatus(reach(false, 'role app: SQLSTATE 28P01')).detail, 'role app: SQLSTATE 28P01')
  for (const key of Object.values(R.REACH_LABEL)) for (const lang of ['en', 'zh']) assert.ok(R.locales[lang][key], `${lang} ${key}`)
  assert.deepEqual(['stReachable', 'stNotChecked', 'stAddress', 'stPassword', 'stFailed'].map((k) => R.locales.en[k]), ['reachable', 'not checked', 'cannot reach address', 'wrong password', 'check failed'])
})

test('the host\'s check: its recorded reach, else a broken unreachable Store\'s failure, else not checked', () => {
  assert.equal(R.hostStatus(pg('a')).key, 'reachable')
  assert.equal(R.hostStatus(pg('a'), true).key, 'checking')
  const none = pg('b', { postgresql: { ...pg('b').postgresql, host: null } })
  assert.equal(R.hostStatus(none).key, 'notChecked')
  assert.equal(R.hostStatus({ ...none, state: 'broken', reason: 'unreachable', message: 'connection refused' }).key, 'address')
})

test('a PostgreSQL row\'s summary: projects, the host, every machine with its status, failures and stopped machines', () => {
  const attached = ['native', 'docker', 'vm1', 'vm2', 'win'].map((m, i) => ({ machine: m, reached: null, reach: i === 1 ? reach(false, 'connection refused') : i === 0 ? reach(true) : null }))
  const sum = R.pgSummary(pg('a', { attached }), { machines })
  assert.equal(sum.projects, 2)
  assert.equal(sum.host.key, 'reachable')
  assert.deepEqual(sum.machines.slice(0, 3).map((m) => [m.machine, m.platform, m.status.key]), [['native', 'native', 'reachable'], ['docker', 'docker', 'address'], ['vm1', 'lima', 'machineStopped']])
  assert.equal(sum.machines.length, 5)
  assert.equal(sum.failed, 1, 'a stopped machine or one needing an update is not a failure')
  assert.equal(sum.stopped, 1)
  // machines as icons, one per provider: a group's dot is its worst member's
  const members = sum.machines.map((m) => ({ name: m.machine, provider: m.platform ?? '', tone: m.status.tone, words: m.status.key }))
  assert.deepEqual(R.providerGroups(members).map((g) => [g.provider, g.members.map((m) => m.name), g.tone]),
    [['native', ['native'], 'ok'], ['docker', ['docker'], 'danger'], ['lima', ['vm1', 'vm2'], 'warning'], ['wsl', ['win'], 'idle']])
  assert.deepEqual(R.providerGroups([{ name: 'b', provider: 'docker', tone: 'ok', words: '' }, { name: 'a', provider: 'docker', tone: 'danger', words: '' }])
    .map((g) => [g.members.map((m) => m.name), g.tone]), [[['a', 'b'], 'danger']], 'several of one provider: one icon, its worst dot, members by name')
  assert.equal(R.worstTone([]), 'ok')
  for (const lang of ['en', 'zh']) for (const key of ['pgRowFailed', 'pgRowStopped', 'rowBackupsFailed']) assert.ok(R.locales[lang][key], `${lang} ${key}`)
  assert.deepEqual([R.locales.zh.pgRowFailed, R.locales.zh.rowBackupsFailed], ['{n} 台未通过', '{n} 个失败'])
  assert.equal(R.pgSummary(pg('c', { attached }), { machines }, new Set(['docker'])).machines[1].status.key, 'checking')
  assert.equal(R.pgAddress(pg('a')), 'app@db.lan:5432/team', 'never a password')
})

test('a login in the address: detected with or without the scheme', () => {
  for (const url of ['postgresql://app@db/x', 'postgresql://app:pw@db/x', 'app:pw@db/x', 'postgresql://db/x?password=p', 'postgresql://db/x?user=u', 'postgresql://db/x?passfile=/p', 'postgresql://db/x?sslpassword=s']) assert.equal(R.urlHasLogin(url), true, url)
  for (const url of ['postgresql://db:5432/x', 'postgresql://db/x?sslmode=require', 'postgresql://db/x?sslkey=/k.pem', '', null]) assert.equal(R.urlHasLogin(url), false, String(url))
  // reach is tested from each machine, never predicted from the address
  assert.equal(R.isLoopbackUrl, undefined)
  assert.equal(R.loopbackShared, undefined)
})

test('a SQLite row\'s state: busy, its machine stopped (neutral), needs attention, else ready', () => {
  assert.equal(R.sqliteState({ state: 'ready' }, 'ready', null), 'ready')
  assert.equal(R.sqliteState({ state: 'ready' }, 'ready', { ended: null }), 'busy')
  assert.equal(R.sqliteState({ state: 'busy' }, 'ready', null), 'busy')
  assert.equal(R.sqliteState({ state: 'blocked', blockedBy: { machine: 'vm1', reason: 'stopped' } }, 'stopped', null), 'stopped')
  assert.equal(R.sqliteState({ state: 'ready' }, 'stopped', null), 'stopped')
  assert.equal(R.sqliteState({ state: 'broken' }, 'ready', null), 'attention')
  assert.equal(R.sqliteState({ state: 'blocked', blockedBy: { machine: 'vm2', reason: 'broken' } }, 'broken', null), 'attention')
  // a backup that failed after the last success counts, one that failed before it does not
  assert.equal(R.linkFailed({ bucket: 'b', last: { at: 5 }, attempt: { at: 9, error: 'refused' } }), true)
  assert.equal(R.linkFailed({ bucket: 'b', last: { at: 9 }, attempt: { at: 5, error: 'refused' } }), false)
  assert.equal(R.linkFailed({ bucket: 'b', last: null, attempt: { at: 5, error: 'refused' } }), true)
})

test('the attach picker: machines not attached, by provider; one that cannot attach is greyed with why', () => {
  const store = pg('a', { attached: [{ machine: 'native', reached: 'ok', reach: reach(true) }] })
  const groups = R.attachMachines(store, machines)
  assert.deepEqual(groups.map((g) => [g.platform, g.items.map((m) => [m.name, m.block])]), [
    ['docker', [['docker', null]]],
    ['lima', [['vm1', 'stopped'], ['vm2', null]]],
    ['wsl', [['win', 'platform']]],
  ], 'native is attached already; providers by name, like any machine')
  assert.deepEqual(R.attachMachines(pg('none'), machines).map((g) => g.platform), ['docker', 'lima', 'native', 'wsl'], 'native is listed like any machine, in its own group')
  const local = pg('l', { postgresql: { ...pg('l').postgresql, url: 'postgresql://localhost:5432/x', target: 'localhost:5432/x', server: 'localhost:5432', database: 'x' } })
  const blocks = (list) => Object.fromEntries(R.attachMachines(local, list).flatMap((g) => g.items.map((m) => [m.name, m.block])))
  assert.deepEqual(blocks(machines), { docker: null, vm1: 'stopped', vm2: null, native: null, win: 'platform' }, 'a local address greys nothing: each machine is tested')
  assert.deepEqual(R.attachMachines(store, machines, { query: 'vm' }).flatMap((g) => g.items.map((m) => m.name)), ['vm1', 'vm2'])
  // from a machine page: the Stores not attached to it, the ones it can attach first
  const stores = [pg('z'), local, pg('b', { attached: [{ machine: 'docker', reached: null, reach: null }] }), { ...pg('s'), kind: 'sqlite', postgresql: null }]
  assert.deepEqual(R.attachStores(machines[1], stores).map((s) => [s.name, s.block]), [['l', null], ['z', null]])
  assert.deepEqual(R.attachStores(machines[1], stores, { query: 'db.lan' }).map((s) => s.name), ['z'])
})

test('a refused test or attach: the connection step LayerFS names, else why it never dialled', () => {
  const steps = { configuration: 'address', transport: 'connection', tls: 'tls', authentication: 'login', database: 'database', schema: 'store', identity: 'store' }
  for (const [step, shown] of Object.entries(steps)) assert.deepEqual(R.attachFailure({ code: 'Unavailable', message: 'x', step }), { step: shown, words: 'pickFailedAt' }, step)
  assert.deepEqual(R.attachFailure({ code: 'Unsupported', message: 'its URL names this host\'s loopback', step: 'configuration' }), { step: 'address', words: 'pickFailedAt' }, 'the step, not the words')
  assert.deepEqual(R.attachFailure({ code: 'Unsupported', message: 'machine win runs no PostgreSQL Sandboxes', step: null }), { step: null, words: 'pickNoPlatform' })
  for (const code of ['InvalidInput', 'NotFound', 'Conflict']) assert.deepEqual(R.attachFailure({ code, message: 'x', step: null }), { step: null, words: 'pickRefused' }, code)
  assert.deepEqual(R.TEST_STEPS, ['address', 'connection', 'tls', 'login', 'database', 'store'])
  for (const lang of ['en', 'zh']) for (const k of ['pickRefused', 'pickFailedAt', 'pickTest', 'pickNotTested', 'pickReachable', ...Object.values(R.STEP_LABEL)]) assert.ok(R.locales[lang][k], `${lang} ${k}`)
})

test('a refused connect is one mapped line about one field, from its step, never LayerFS\'s raw words', () => {
  assert.deepEqual(R.connectFailure('Unavailable', 'authentication'), { key: 'pgErrPassword', field: 'password' })
  assert.deepEqual(R.connectFailure('Unavailable', 'transport'), { key: 'pgErrAddress', field: 'address' })
  assert.deepEqual(R.connectFailure('Unsupported', 'configuration'), { key: 'pgErrAddress', field: 'address' })
  assert.deepEqual(R.connectFailure('Unavailable', 'tls'), { key: 'pgErrTls', field: 'address' })
  assert.deepEqual(R.connectFailure('Unavailable', 'database'), { key: 'pgErrDatabase', field: 'address' })
  assert.deepEqual(R.connectFailure('Conflict', 'identity'), { key: 'pgErrNotThisStore', field: 'address' }, 'another Store is its step, though its code is Conflict')
  assert.deepEqual(R.connectFailure('Conflict', null), { key: 'pgTestLoses', field: null }, 'a changed connection an attached machine would lose')
  assert.deepEqual(R.connectFailure('Exists', null), { key: 'cdNameTaken', field: 'name' })
  assert.deepEqual(R.connectFailure('Failed', null), { key: 'pgErrFailed', field: null })
  assert.deepEqual(['pgErrPassword', 'pgErrAddress', 'pgErrDatabase', 'pgErrNotThisStore'].map((k) => R.locales.en[k]), [
    'The server refused the login. Check the user, password and database name.', 'Nothing answered at this address.', 'The database doesn\'t exist on this server.', 'This database holds another Store.',
  ])
  for (const k of ['pgErrPassword', 'pgErrAddress', 'pgErrDatabase', 'pgErrNotThisStore', 'pgErrFailed']) assert.ok(R.locales.zh[k], k)
})

test('three terms: "this computer" is the host\'s own check; machine native is named native; a local address names the machines that share its network', () => {
  const { en, zh } = R.locales
  assert.equal(en.pgHostCheck, 'Checked from this computer')
  assert.equal(zh.pgHostCheck, '从这台电脑检查')
  assert.equal(en.rowHostDot, 'Checked from this computer: {status} · {when}')
  assert.equal(en.pgRecheckMachines, 'Checks from this computer, then from {machines}.')
  assert.equal(en.pgThisComputer, undefined, 'no "This computer" label for machine native')
  assert.equal(en.pgLoopbackNote, undefined, 'no local-address copy: reach is tested')
  assert.match(en.pgTestLoses + zh.pgTestLoses, /\{machines\}.*\{machines\}/s)
  assert.equal(R.providerBeside('native', 'Native'), null, 'no "native Native"')
  assert.equal(R.providerBeside('docker', 'Docker'), null)
  assert.equal(R.providerBeside('vm1', 'Lima'), 'Lima')
  assert.equal(R.listWords(['a']), 'a')
  assert.match(R.listWords(['a', 'b', 'c']), /^a, b,? and c$/)
})

test('Check all opens every row whose host check failed and keeps the ones already open', () => {
  const next = R.openFailed(new Set(['kept']), [{ store: 'a', host: { ok: false } }, { store: 'b', host: { ok: true } }, { store: 'c', host: null }])
  assert.deepEqual([...next].sort(), ['a', 'kept'])
})
