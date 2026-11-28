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

test('folder: config, then DSH_LAYERFS_FOLDER, then LAYERFS_ROOT, then the pointer, then ~/.layerfs', () => {
  const m = machine()
  const savedHome = process.env.HOME
  try {
    const viaConfig = F.resolveFolder({ folder: join(m.dir, 'a') }, { ...m.env, DSH_LAYERFS_FOLDER: join(m.dir, 'b') })
    assert.deepEqual([viaConfig.folder, viaConfig.folderSource], [join(m.dir, 'a'), 'config'])
    const viaEnv = F.resolveFolder({}, { ...m.env, DSH_LAYERFS_FOLDER: join(m.dir, 'b'), LAYERFS_ROOT: join(m.dir, 'r') })
    assert.deepEqual([viaEnv.folder, viaEnv.folderSource], [join(m.dir, 'b'), 'env'])
    // LayerFS's own root variable names the folder after DSH_LAYERFS_FOLDER, before the pointer
    F.writeJson(F.pointerPath(m.dshHome), { folder: join(m.dir, 'c') })
    const viaRoot = F.resolveFolder({}, { ...m.env, LAYERFS_ROOT: join(m.dir, 'r') })
    assert.deepEqual([viaRoot.folder, viaRoot.folderSource, viaRoot.home], [join(m.dir, 'r'), 'env', join(m.dir, 'r', 'home')])
    assert.equal(F.resolveFolder({}, { ...m.env, LAYERFS_ROOT: 'relative/r' }).folderSource, 'pointer', 'a relative root is ignored')
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

test('home: found in the folder by LayerFS\'s rule (the folder while it holds layerfs.json, else <folder>/home); no home override', () => {
  const m = machine()
  try {
    const env = { ...m.env, DSH_LAYERFS_FOLDER: m.folder }
    // the home overrides are gone: a config `home`, DSH_LAYERFS_HOME and LAYERFS_HOME are ignored
    assert.equal(F.resolveFolder({ home: join(m.dir, 'h1') }, { ...env, DSH_LAYERFS_HOME: join(m.dir, 'h2'), LAYERFS_HOME: join(m.dir, 'h3') }).home, join(m.folder, 'home'))
    // a new folder, or one with an empty home/: <folder>/home
    assert.equal(F.resolveFolder({}, env).home, join(m.folder, 'home'))
    mkdirSync(join(m.folder, 'home'), { recursive: true })
    assert.equal(F.resolveFolder({}, env).home, join(m.folder, 'home'))
    // a home made before the root layout: the folder itself while it holds layerfs.json
    writeFileSync(join(m.folder, 'layerfs.json'), '{}')
    assert.equal(F.resolveFolder({}, env).home, m.folder)
  } finally { m.done() }
})

test('homeIn / rootOf: the home in a root and the root (LAYERFS_ROOT) for a home, inverse of each other', () => {
  const m = machine()
  try {
    const root = m.folder
    // no layerfs.json in the root: <root>/home, whether or not it exists yet
    assert.equal(F.homeIn(root), join(root, 'home'))
    assert.equal(F.rootOf(join(root, 'home')), root)
    mkdirSync(join(root, 'home'), { recursive: true })
    writeFileSync(join(root, 'home', 'layerfs.json'), '{}')
    // a home folder holding layerfs.json is a root of its own: LayerFS finds it there
    assert.equal(F.homeIn(join(root, 'home')), join(root, 'home'))
    assert.equal(F.rootOf(join(root, 'home')), join(root, 'home'))
    // a legacy home at the root: the root is the home and its own root
    const legacy = join(m.dir, 'legacy')
    put(join(legacy, 'layerfs.json'), '{}')
    assert.equal(F.homeIn(legacy), legacy)
    assert.equal(F.rootOf(legacy), legacy)
    // a home not named `home` without layerfs.json names itself: LayerFS would look in <it>/home
    assert.equal(F.rootOf(join(m.dir, 'elsewhere')), join(m.dir, 'elsewhere'))
    // round trip for a new root
    const fresh = join(m.dir, 'fresh')
    assert.equal(F.rootOf(F.homeIn(fresh)), fresh)
  } finally { m.done() }
})

test('state: <folder>/dsh with a dsh.json naming its owner and install; config and env override it', () => {
  const m = machine()
  try {
    const env = { ...m.env, DSH_LAYERFS_FOLDER: m.folder }
    const first = F.resolveFolder({}, env)
    assert.equal(first.state, join(m.folder, 'dsh'))
    assert.equal(first.stateTaken, null)
    const record = json(join(m.folder, 'dsh', 'dsh.json'))
    assert.deepEqual([record.version, record.owner, record.install, record.layout], [1, m.dshHome, sha(join(m.folder, 'dsh')), F.LAYOUT])
    assert.equal(first.install, record.install)
    assert.match(first.install, /^[0-9a-f]{64}$/)
    // read back, not rewritten: the install id is stable
    assert.equal(F.resolveFolder({}, env).install, first.install)
    assert.deepEqual(F.readDshRecord(first.state), record)
    // explicit state wins: config state, then DSH_LAYERFS_STATE
    const s = join(m.dir, 's'), e = join(m.dir, 'e')
    assert.equal(F.resolveFolder({ state: s }, { ...env, DSH_LAYERFS_STATE: e }).state, s)
    assert.equal(F.resolveFolder({}, { ...env, DSH_LAYERFS_STATE: e }).state, e)
    for (const dir of [s, e]) assert.equal(json(join(dir, 'dsh.json')).owner, m.dshHome)
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
