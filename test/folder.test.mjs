// The LayerFS folder (docs/specs/layerfs-folder.md): where the LayerFS home and
// the DSH x LayerFS home (`dsh/`) are resolved (§3), the owner record, and the
// one-time migration of an older `$DSH_HOME/layerfs` (§5). Temp folders only:
// every case names DSH_HOME and the folder, never the real ~/.layerfs.
//   node --test test/folder.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-folder-'))
await build({
  absWorkingDir: root,
  stdin: { contents: "export * from './src/host/folder.ts'\n", resolveDir: root, loader: 'ts' },
  outfile: join(out, 'folder.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24', logLevel: 'warning',
})
const F = await import(pathToFileURL(join(out, 'folder.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

const sha = (s) => createHash('sha256').update(s).digest('hex')
const json = (path) => JSON.parse(readFileSync(path, 'utf8'))
const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text) }

/** A temp machine: a DSH_HOME and a LayerFS folder, nothing else. */
function machine() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-folder-'))
  const dshHome = join(dir, 'dsh-home')
  mkdirSync(dshHome)
  return { dir, dshHome, folder: join(dir, 'lfs'), env: { DSH_HOME: dshHome }, done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('folder: config, then DSH_LAYERFS_FOLDER, then the pointer, then ~/.layerfs', () => {
  const m = machine()
  const savedHome = process.env.HOME
  try {
    const viaConfig = F.resolveFolder({ folder: join(m.dir, 'a') }, { ...m.env, DSH_LAYERFS_FOLDER: join(m.dir, 'b') })
    assert.deepEqual([viaConfig.folder, viaConfig.folderSource], [join(m.dir, 'a'), 'config'])
    const viaEnv = F.resolveFolder({}, { ...m.env, DSH_LAYERFS_FOLDER: join(m.dir, 'b') })
    assert.deepEqual([viaEnv.folder, viaEnv.folderSource], [join(m.dir, 'b'), 'env'])
    // the setup modal's pointer, $DSH_HOME/layerfs.json
    assert.equal(F.pointerPath(m.dshHome), join(m.dshHome, 'layerfs.json'))
    F.writeJson(F.pointerPath(m.dshHome), { folder: join(m.dir, 'c') })
    const viaPointer = F.resolveFolder({}, m.env)
    assert.deepEqual([viaPointer.folder, viaPointer.folderSource, viaPointer.pointer], [join(m.dir, 'c'), 'pointer', join(m.dshHome, 'layerfs.json')])
    // a relative value is no folder: ignored
    assert.equal(F.resolveFolder({ folder: 'relative/x' }, { ...m.env, DSH_LAYERFS_FOLDER: 'also/relative' }).folderSource, 'pointer')
    rmSync(F.pointerPath(m.dshHome))
    // the default under a temp HOME (os.homedir() reads HOME)
    process.env.HOME = join(m.dir, 'user')
    const byDefault = F.resolveFolder({}, m.env)
    assert.deepEqual([byDefault.folder, byDefault.folderSource], [join(m.dir, 'user', '.layerfs'), 'default'])
    assert.equal(byDefault.state, join(m.dir, 'user', '.layerfs', 'dsh'))
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome
    m.done()
  }
})

test('home: config, DSH_LAYERFS_HOME, LAYERFS_HOME, else <folder>/home once set up there, else the folder itself', () => {
  const m = machine()
  try {
    const env = { ...m.env, DSH_LAYERFS_FOLDER: m.folder }
    assert.equal(F.resolveFolder({ home: join(m.dir, 'h1') }, { ...env, DSH_LAYERFS_HOME: join(m.dir, 'h2'), LAYERFS_HOME: join(m.dir, 'h3') }).home, join(m.dir, 'h1'))
    assert.equal(F.resolveFolder({}, { ...env, DSH_LAYERFS_HOME: join(m.dir, 'h2'), LAYERFS_HOME: join(m.dir, 'h3') }).home, join(m.dir, 'h2'))
    assert.equal(F.resolveFolder({}, { ...env, LAYERFS_HOME: join(m.dir, 'h3') }).home, join(m.dir, 'h3'))
    // a legacy home: the folder is the home while LayerFS defaults to ~/.layerfs (§3)
    assert.equal(F.resolveFolder({}, env).home, m.folder)
    // an empty home/ is not a home
    mkdirSync(join(m.folder, 'home'), { recursive: true })
    assert.equal(F.resolveFolder({}, env).home, m.folder)
    writeFileSync(join(m.folder, 'home', 'layerfs.json'), '{}')
    assert.equal(F.resolveFolder({}, env).home, join(m.folder, 'home'))
  } finally { m.done() }
})

test('state: <folder>/dsh with a dsh.json naming its owner and install; config and env override it', () => {
  const m = machine()
  try {
    const env = { ...m.env, DSH_LAYERFS_FOLDER: m.folder }
    const first = F.resolveFolder({}, env)
    assert.equal(first.state, join(m.folder, 'dsh'))
    assert.equal(first.stateTaken, null)
    assert.equal(first.migratedFrom, null)
    const record = json(join(m.folder, 'dsh', 'dsh.json'))
    assert.deepEqual([record.version, record.owner, record.install], [1, m.dshHome, sha(join(m.folder, 'dsh'))])
    assert.equal(first.install, record.install)
    assert.match(first.install, /^[0-9a-f]{64}$/)
    // read back, not rewritten: the install id is stable
    assert.equal(F.resolveFolder({}, env).install, first.install)
    assert.deepEqual(F.readDshRecord(first.state), record)
    // explicit state wins: config state, then the older config root, then DSH_LAYERFS_STATE
    const s = join(m.dir, 's'), r = join(m.dir, 'r'), e = join(m.dir, 'e')
    assert.equal(F.resolveFolder({ state: s, root: r }, { ...env, DSH_LAYERFS_STATE: e }).state, s)
    assert.equal(F.resolveFolder({ root: r }, { ...env, DSH_LAYERFS_STATE: e }).state, r)
    assert.equal(F.resolveFolder({}, { ...env, DSH_LAYERFS_STATE: e }).state, e)
    for (const dir of [s, r, e]) assert.equal(json(join(dir, 'dsh.json')).owner, m.dshHome)
  } finally { m.done() }
})

test('a dsh/ owned by another DSH_HOME is never shared: this install uses dsh-<8 hex of its DSH_HOME>', () => {
  const m = machine()
  try {
    const other = join(m.dir, 'other-dsh-home')
    const theirs = F.resolveFolder({}, { DSH_HOME: other, DSH_LAYERFS_FOLDER: m.folder })
    assert.equal(theirs.state, join(m.folder, 'dsh'))
    const mine = F.resolveFolder({}, { ...m.env, DSH_LAYERFS_FOLDER: m.folder })
    assert.equal(mine.state, join(m.folder, `dsh-${sha(m.dshHome).slice(0, 8)}`))
    assert.equal(mine.stateTaken, join(m.folder, 'dsh'))
    assert.notEqual(mine.install, theirs.install)
    assert.equal(json(join(mine.state, 'dsh.json')).owner, m.dshHome)
    assert.equal(json(join(m.folder, 'dsh', 'dsh.json')).owner, other, 'the other install\'s record is untouched')
    // the owner keeps its own folder
    assert.equal(F.resolveFolder({}, { DSH_HOME: other, DSH_LAYERFS_FOLDER: m.folder }).state, join(m.folder, 'dsh'))
    // an explicit state is used as named, taken or not
    assert.equal(F.resolveFolder({ state: join(m.folder, 'dsh') }, { ...m.env, DSH_LAYERFS_FOLDER: m.folder }).stateTaken, null)
  } finally { m.done() }
})

/** An older build's `$DSH_HOME/layerfs`: plugin state, project sessions by owner key, scratch and anchors. */
function oldState(old) {
  const key = 'k'.repeat(64), stale = 's'.repeat(64)
  put(join(old, 'sessions.json'), JSON.stringify({ sessions: { 'session-1': { project: 'st/app' } } }))
  put(join(old, 'runtime.json'), JSON.stringify({ cli: '/pinned/layerfs' }))
  put(join(old, 'simulations', 'run-1', 'run.json'), '{"run":1}')
  put(join(old, 'trace', 'outputs', 'abc.json'), '{"out":1}')
  put(join(old, 'trace', 'calls.jsonl'), '{"old":"stand-in log"}\n')
  put(join(old, 'store-machines.json'), '{}')
  put(join(old, 'scratch', 'README.md'), '# Scratch\n')
  put(join(old, 'projects', 'st', 'app', 'sessions', 'session-1', 'work.txt'), 'scratch work')
  const ps = join(old, 'project-sessions')
  put(join(ps, 'owners.json'), JSON.stringify({ version: 1, sessions: { 'session-1': { project: 'st/app', key }, 'session-2': { project: 'st/app', key } } }))
  put(join(ps, 'deleted.json'), JSON.stringify({ version: 1, sessions: {} }))
  put(join(ps, 'project-catalog.json'), JSON.stringify({ 'pid-1': { key: 'st/app' } }))
  put(join(ps, 'migration-backups', 'b1', 'session.v4.jsonl'), '{"backup":1}\n')
  const owned = join(ps, 'projects', key, 'sessions', '--cwd--', 'session-1')
  put(join(owned, 'session.v4.jsonl'), '{"version":4,"id":"session-1"}\n')
  put(join(owned, 'layerfs.json'), JSON.stringify({ version: 1, sessionId: 'session-1', project: 'st/app' }))
  put(join(owned, 'receipts.jsonl'), '{"id":"r1"}\n')
  put(join(owned, 'layerfs.json.bak'), 'old combined copy')
  // only a log file and no sidecar: still moves
  put(join(ps, 'projects', key, 'sessions', '--cwd--', 'session-2', 'session.v4.jsonl'), '{"version":4,"id":"session-2"}\n')
  // a copy an older log migration left under another owner key: not moved
  put(join(ps, 'projects', stale, 'sessions', '--cwd--', 'session-1', 'session.v4.jsonl'), '{"stale":true}\n')
  return { key, ps }
}

test('migration: an older $DSH_HOME/layerfs moves into <folder>/dsh in the new layout, then is set aside', () => {
  const m = machine()
  try {
    const old = join(m.dshHome, 'layerfs')
    oldState(old)
    const logs = []
    const env = { ...m.env, DSH_LAYERFS_FOLDER: m.folder }
    const got = F.resolveFolder({}, env, (line) => logs.push(line))
    const state = join(m.folder, 'dsh')
    assert.equal(got.state, state)
    assert.equal(got.migratedFrom, old)
    // §5.2: dsh.json last, keeping the install id the old folder had
    const record = json(join(state, 'dsh.json'))
    assert.deepEqual([record.owner, record.install, record.migratedFrom], [m.dshHome, sha(old), old])
    assert.ok(record.migratedAt)
    assert.equal(got.install, sha(old))
    // §5.1: plugin state
    assert.deepEqual(json(join(state, 'sessions', 'state.json')), { sessions: { 'session-1': { project: 'st/app' } } })
    assert.deepEqual(json(join(state, 'runtime.json')), { cli: '/pinned/layerfs' })
    assert.equal(readFileSync(join(state, 'simulations', 'run-1', 'run.json'), 'utf8'), '{"run":1}')
    assert.equal(readFileSync(join(state, 'trace', 'outputs', 'abc.json'), 'utf8'), '{"out":1}')
    assert.equal(existsSync(join(state, 'trace', 'calls.jsonl')), false, 'only trace/outputs is copied')
    assert.equal(existsSync(join(state, 'store-machines.json')), false, 'dropped')
    // the project-session indexes and backups
    assert.ok(json(join(state, 'sessions', 'owners.json')).sessions['session-1'])
    assert.ok(existsSync(join(state, 'sessions', 'deleted.json')))
    assert.deepEqual(json(join(state, 'sessions', 'projects.json')), { 'pid-1': { key: 'st/app' } })
    assert.equal(readFileSync(join(state, 'sessions', 'backups', 'b1', 'session.v4.jsonl'), 'utf8'), '{"backup":1}\n')
    // each owned session into the one store, its LayerFS files in layerfs/
    const moved = join(state, 'sessions', 'store', '--cwd--', 'session-1')
    assert.equal(readFileSync(join(moved, 'session.v4.jsonl'), 'utf8'), '{"version":4,"id":"session-1"}\n', 'the owned copy, not the stale one')
    assert.equal(json(join(moved, 'layerfs', 'binding.json')).project, 'st/app')
    assert.equal(readFileSync(join(moved, 'layerfs', 'calls.jsonl'), 'utf8'), '{"id":"r1"}\n')
    assert.deepEqual(readdirSync(moved).sort(), ['layerfs', 'session.v4.jsonl'], 'no layerfs.json, receipts.jsonl or .bak beside the log')
    assert.ok(existsSync(join(state, 'sessions', 'store', '--cwd--', 'session-2', 'session.v4.jsonl')))
    assert.deepEqual(readdirSync(join(state, 'sessions', 'store', '--cwd--')).sort(), ['session-1', 'session-2'])
    // §5.3: the copied entries are set aside; scratch/ and projects/ stay where they are
    const left = readdirSync(old).sort()
    for (const name of ['sessions.json', 'runtime.json', 'simulations', 'trace', 'project-sessions', 'store-machines.json']) {
      assert.ok(left.includes(`${name}.moved`), `${name}.moved in ${left}`)
      assert.ok(!left.includes(name), `${name} renamed`)
    }
    assert.equal(readFileSync(join(old, 'scratch', 'README.md'), 'utf8'), '# Scratch\n')
    assert.equal(readFileSync(join(old, 'projects', 'st', 'app', 'sessions', 'session-1', 'work.txt'), 'utf8'), 'scratch work')
    assert.match(readFileSync(join(old, 'MOVED.txt'), 'utf8'), new RegExp(`moved to ${state.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    assert.ok(logs.some((line) => /2 project sessions/.test(line)), logs.join('\n'))
    // once: the next start reads dsh.json and moves nothing again
    const again = F.resolveFolder({}, env)
    assert.equal(again.install, sha(old))
    assert.equal(again.migratedFrom, old)
    assert.ok(!readdirSync(old).some((name) => name.endsWith('.moved.moved')))
  } finally { m.done() }
})

test('migration: a configured root is the old folder and is converted in place; $DSH_HOME/layerfs is not taken then', () => {
  const m = machine()
  try {
    const rootDir = join(m.dir, 'configured-root')
    oldState(rootDir)
    const env = { ...m.env, DSH_LAYERFS_FOLDER: m.folder }
    const got = F.resolveFolder({ root: rootDir }, env)
    assert.equal(got.state, rootDir)
    assert.equal(got.migratedFrom, rootDir)
    assert.equal(got.install, sha(rootDir))
    assert.ok(existsSync(join(rootDir, 'sessions', 'state.json')))
    assert.ok(existsSync(join(rootDir, 'sessions', 'store', '--cwd--', 'session-1', 'layerfs', 'binding.json')))
    assert.ok(existsSync(join(rootDir, 'runtime.json')), 'an entry already where it belongs stays')
    assert.ok(existsSync(join(rootDir, 'sessions.json.moved')))
    // A fresh configured root with an older $DSH_HOME/layerfs beside it: that folder is not this install's.
    const legacy = join(m.dshHome, 'layerfs')
    oldState(legacy)
    const fresh = join(m.dir, 'fresh-root')
    const other = F.resolveFolder({ root: fresh }, env)
    assert.equal(other.state, fresh)
    assert.equal(other.migratedFrom, null)
    assert.ok(existsSync(join(legacy, 'sessions.json')), 'the other folder is left alone')
    assert.equal(existsSync(join(legacy, 'MOVED.txt')), false)
  } finally { m.done() }
})

test('relayout puts a session folder\'s LayerFS files into layerfs/ and never overwrites newer ones', () => {
  const m = machine()
  try {
    const dir = join(m.dir, 'session')
    put(join(dir, 'layerfs.json'), '{"old":true}')
    put(join(dir, 'receipts.jsonl'), '{"id":"r1"}\n')
    put(join(dir, 'layerfs.json.bak'), 'x')
    F.relayout(dir)
    assert.deepEqual(readdirSync(dir).sort(), ['layerfs'])
    assert.deepEqual(readdirSync(join(dir, 'layerfs')).sort(), ['binding.json', 'calls.jsonl'])
    // an old file appearing next to newer ones is left where it is
    put(join(dir, 'layerfs.json'), '{"older":true}')
    F.relayout(dir)
    assert.equal(readFileSync(join(dir, 'layerfs', 'binding.json'), 'utf8'), '{"old":true}')
  } finally { m.done() }
})

test('checkFolder accepts an absolute folder and refuses anything else', () => {
  const m = machine()
  try {
    assert.equal(F.checkFolder(m.folder), m.folder)
    assert.throws(() => F.checkFolder('relative'), (e) => e.code === 'InvalidInput')
    assert.throws(() => F.checkFolder(42), (e) => e.code === 'InvalidInput')
    put(join(m.dir, 'file'), 'x')
    assert.throws(() => F.checkFolder(join(m.dir, 'file')), (e) => e.code === 'InvalidInput' && /not a folder/.test(e.message))
  } finally { m.done() }
})
