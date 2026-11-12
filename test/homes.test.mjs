// The two homes (docs/specs/homes.md): LAYERFS_HOME holds LayerFS's records,
// its runtime (runtime/<version>-<sha>/) and secrets (secret/); DSH_HOME holds
// dsh-layerfs's own state.
//   node --test test/homes.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = new URL('..', import.meta.url).pathname
// Inside the checkout, so the external DSH packages resolve from node_modules.
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-homes-'))
await build({
  stdin: {
    contents: "export * from './src/host/layerfs/runtime-home.ts'\nexport { LayerfsService } from './src/host/service.ts'\nexport { Context } from '@deepseek-ai/cordis'\n",
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['@deepseek-ai/*'],
  outfile: join(out, 'homes.mjs'),
  absWorkingDir: root,
  target: 'node24',
  logLevel: 'warning',
})
const H = await import(pathToFileURL(join(out, 'homes.mjs')).href)

/** A scratch folder with a fake CLI, daemon and bundle. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-homes-'))
  const src = join(dir, 'src')
  mkdirSync(join(src, 'bundle', 'linux-aarch64'), { recursive: true })
  writeFileSync(join(src, 'layerfs'), '#!/bin/sh\necho cli-1\n', { mode: 0o755 })
  writeFileSync(join(src, 'layerfs-daemon'), 'daemon-1', { mode: 0o755 })
  writeFileSync(join(src, 'bundle', 'linux-aarch64', 'bundle.json'), JSON.stringify({ hash: 'h1' }))
  writeFileSync(join(src, 'bundle', 'linux-aarch64', 'worker'), 'w')
  return { dir, src, home: join(dir, 'home'), done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('runtime install: copies into <home>/runtime/<version>-<sha>, owner-only home, reused when identical', () => {
  const f = fixture()
  try {
    const given = { cli: join(f.src, 'layerfs'), daemon: join(f.src, 'layerfs-daemon'), bundle: join(f.src, 'bundle', 'linux-aarch64') }
    const a = H.installRuntime(f.home, '2.0.0', given)
    assert.match(a.id, /^2\.0\.0-[0-9a-f]{12}$/)
    const dir = join(f.home, 'runtime', a.id)
    assert.deepEqual([a.cli, a.daemon, a.bundle], [join(dir, 'bin', 'layerfs'), join(dir, 'bin', 'layerfs-daemon'), join(dir, 'bundle', 'linux-aarch64')])
    assert.equal(readFileSync(a.cli, 'utf8'), '#!/bin/sh\necho cli-1\n')
    assert.equal(statSync(a.cli).mode & 0o111, 0o111)
    assert.equal(readFileSync(join(a.bundle, 'worker'), 'utf8'), 'w')
    assert.equal(statSync(f.home).mode & 0o777, 0o700)
    // again, and from the installed copies themselves: the same folder
    assert.deepEqual(H.installRuntime(f.home, '2.0.0', given), a)
    assert.deepEqual(H.installRuntime(f.home, '2.0.0', { cli: a.cli, daemon: null, bundle: null }), a)
    const listed = H.installedRuntimes(f.home)
    assert.deepEqual(listed.map((r) => [r.id, r.cli, r.daemon, r.bundle]), [[a.id, a.cli, a.daemon, a.bundle]])
  } finally { f.done() }
})

test('runtime install: a different daemon or bundle for the same CLI is refused, never replaced', () => {
  const f = fixture()
  try {
    const given = { cli: join(f.src, 'layerfs'), daemon: join(f.src, 'layerfs-daemon'), bundle: join(f.src, 'bundle', 'linux-aarch64') }
    const a = H.installRuntime(f.home, '2.0.0', given)
    writeFileSync(join(f.src, 'layerfs-daemon'), 'daemon-2')
    assert.throws(() => H.installRuntime(f.home, '2.0.0', given), (e) => e.code === 'InvalidInput' && /different daemon/.test(e.message))
    assert.equal(readFileSync(a.daemon, 'utf8'), 'daemon-1')
    writeFileSync(join(f.src, 'layerfs-daemon'), 'daemon-1')
    writeFileSync(join(given.bundle, 'bundle.json'), JSON.stringify({ hash: 'h2' }))
    assert.throws(() => H.installRuntime(f.home, '2.0.0', given), (e) => e.code === 'InvalidInput' && /different Linux bundle/.test(e.message))
    // another CLI build gets its own folder
    writeFileSync(join(f.src, 'layerfs'), '#!/bin/sh\necho cli-2\n')
    const b = H.installRuntime(f.home, '2.0.0', given)
    assert.notEqual(b.id, a.id)
    assert.equal(H.installedRuntimes(f.home).length, 2)
    assert.ok(!H.installedRuntimes(f.home).some((r) => r.id.includes('.tmp-')))
  } finally { f.done() }
})

test('service defaults: the LayerFS home is ~/.layerfs-style and apart from DSH_HOME; secrets in <home>/secret; logs under <root>', () => {
  const f = fixture()
  const saved = { DSH_HOME: process.env.DSH_HOME, DSH_LAYERFS_HOME: process.env.DSH_LAYERFS_HOME, LAYERFS_HOME: process.env.LAYERFS_HOME, DSH_LAYERFS_CLI: process.env.DSH_LAYERFS_CLI, DSH_LAYERFS_SESSION_HOME: process.env.DSH_LAYERFS_SESSION_HOME, DSH_LAYERFS_SECRETS: process.env.DSH_LAYERFS_SECRETS }
  try {
    for (const k of Object.keys(saved)) delete process.env[k]
    process.env.DSH_HOME = join(f.dir, 'dsh')
    process.env.LAYERFS_HOME = f.home
    const s = new H.LayerfsService(new H.Context(), {})
    assert.equal(s.home, f.home)
    assert.equal(s.root, join(f.dir, 'dsh', 'layerfs'))
    assert.equal(s.secrets, join(f.home, 'secret'))
    assert.equal(s.projectSessionHome, join(f.dir, 'dsh', 'layerfs', 'project-sessions'))
    assert.equal(s.cli, null)
    // nothing pinned: the newest runtime installed in the home
    const a = H.installRuntime(f.home, '2.0.0', { cli: join(f.src, 'layerfs'), daemon: join(f.src, 'layerfs-daemon'), bundle: join(f.src, 'bundle', 'linux-aarch64') })
    const t = new H.LayerfsService(new H.Context(), {})
    assert.deepEqual([t.cli, t.daemon, t.bundle], [a.cli, a.daemon, a.bundle])
    // an explicit pin still wins
    const u = new H.LayerfsService(new H.Context(), { cli: join(f.src, 'layerfs') })
    assert.equal(u.cli, join(f.src, 'layerfs'))
    // without LAYERFS_HOME the default is ~/.layerfs, never under DSH_HOME
    delete process.env.LAYERFS_HOME
    const v = new H.LayerfsService(new H.Context(), {})
    assert.match(v.home, /\/\.layerfs$/)
    assert.ok(!v.home.startsWith(process.env.DSH_HOME))
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    f.done()
  }
})

test.after(() => rmSync(out, { recursive: true, force: true }))
