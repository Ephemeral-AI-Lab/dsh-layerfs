// The readiness ladder (src/client/machines/needs.ts): each LayerFS need sorted into the
// step that fixes it on this computer's OS, a platform's hardest step, and the host's
// own name for this computer (src/host/routes/computer.ts).
//   node --test test/machine-needs.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = new URL('..', import.meta.url).pathname
const out = mkdtempSync(join(tmpdir(), 'dsh-machine-needs-'))
await build({
  absWorkingDir: root, entryPoints: { needs: 'src/client/machines/needs.ts', computer: 'src/host/routes/computer.ts' }, outdir: out,
  bundle: true, format: 'esm', platform: 'node', target: 'node24', logLevel: 'warning', outExtension: { '.js': '.mjs' },
})
const { readinessOf, blockOf, fixOf, shortVersion, nativeGlyphOs, nativeNameKey } = await import(pathToFileURL(join(out, 'needs.mjs')).href)
const { osOf, prettyName } = await import(pathToFileURL(join(out, 'computer.mjs')).href)
process.on('exit', () => rmSync(out, { recursive: true, force: true }))

const row = (platform, missing = [], extra = {}) => ({ platform, ready: missing.length === 0, missing, how: 'created', version: null, ...extra })

test('a ready platform needs nothing', () => {
  assert.deepEqual(readinessOf(row('lima'), 'macos'), { step: 'ready', fixes: [] })
})

test('a missing tool is an install step with this OS’s commands', () => {
  const r = readinessOf(row('lima', ['tool:limactl']), 'macos')
  assert.equal(r.step, 'install')
  assert.deepEqual(r.fixes[0].commands, ['brew install lima'])
  assert.equal(r.fixes[0].why.values.tool, 'Lima')
  const docker = readinessOf(row('docker', ['tool:docker']), 'linux')
  assert.equal(docker.step, 'install')
  assert.ok(docker.fixes[0].commands.some((c) => c.includes('systemctl')), 'Linux gets the Docker service, not Homebrew')
})

test('a host fact no install fixes wins: Lima on Linux is unsupported, not "install Lima"', () => {
  const r = readinessOf(row('lima', ['tool:limactl', 'host:macos']), 'linux')
  assert.equal(r.step, 'unsupported')
  assert.equal(r.fixes[0].need, 'host:macos')
  // a tool LayerFS runs only on macOS is unsupported on another OS even when LayerFS reports just the tool
  assert.equal(readinessOf(row('lima', ['tool:limactl']), 'linux').step, 'unsupported')
})

test('Windows: native and Docker through WSL2 are unsupported', () => {
  assert.equal(readinessOf(row('native', ['host:macos-or-linux']), 'windows').step, 'unsupported')
  assert.equal(readinessOf(row('docker', ['host:wsl2-worker']), 'windows').step, 'unsupported')
})

test('Linux native: root, /dev/fuse and cgroup v2 are setup steps', () => {
  const r = readinessOf(row('native', ['host:root', 'host:/dev/fuse', 'host:cgroup2']), 'linux')
  assert.equal(r.step, 'setup')
  assert.deepEqual(r.fixes.map((f) => f.need), ['host:root', 'host:/dev/fuse', 'host:cgroup2'])
  assert.deepEqual(fixOf('host:/dev/fuse', 'native', 'linux').commands, ['sudo modprobe fuse'])
})

test('Docker’s socket that does not answer is a start step, per OS', () => {
  const mac = readinessOf(row('docker', ['host:/var/run/docker.sock']), 'macos')
  assert.equal(mac.step, 'start')
  assert.equal(mac.fixes[0].why.values.socket, '/var/run/docker.sock')
  assert.ok(mac.fixes[0].commands.includes('open -a Docker'))
  assert.deepEqual(readinessOf(row('docker', ['host:/var/run/docker.sock']), 'linux').fixes[0].commands, ['sudo systemctl start docker'])
})

test('steps order the fixes: install before start before runtime', () => {
  const r = readinessOf(row('docker', ['bundle:linux-arm64', 'host:/var/run/docker.sock', 'tool:docker']), 'macos')
  assert.equal(r.step, 'install')
  assert.deepEqual(r.fixes.map((f) => f.step), ['install', 'start', 'runtime'])
})

test('an unknown need stays in view in LayerFS’s words', () => {
  const r = readinessOf(row('lima', ['host:kvm']), 'linux')
  assert.equal(r.step, 'setup')
  assert.deepEqual(r.fixes[0].why, { key: 'needHost', values: { thing: 'kvm' } })
  assert.equal(readinessOf(row('lima', [], { ready: false }), 'macos').step, 'setup', 'not ready with no reason is not ready')
})

test('blockOf: a machine is blocked only while its platform is not ready', () => {
  const platforms = [row('docker', ['host:/var/run/docker.sock'], { how: 'built_in' }), row('lima')]
  assert.equal(blockOf(platforms, 'docker', 'macos').step, 'start')
  assert.equal(blockOf(platforms, 'lima', 'macos'), null)
  assert.equal(blockOf(platforms, 'microsandbox', 'macos'), null, 'a platform LayerFS did not list blocks nothing')
})

test('versions are shown short', () => {
  assert.equal(shortVersion('container CLI version 1.6.1 (build: release, commit: unspeci)'), '1.6.1')
  assert.equal(shortVersion('limactl version 2.2.1'), '2.2.1')
  assert.equal(shortVersion('29.5.2'), '29.5.2')
  assert.equal(shortVersion('dev'), 'dev')
  assert.equal(shortVersion(null), null)
})

test('the native machine is named and marked by this computer’s OS', () => {
  assert.deepEqual(['macos', 'linux', 'windows', 'other'].map(nativeNameKey), ['nativeMac', 'nativeComputer', 'nativePc', 'nativeComputer'])
  assert.deepEqual(['macos', 'linux', 'windows'].map(nativeGlyphOs), ['mac', 'linux', 'pc'])
})

test('host: LayerFS’s and Node’s OS words, and an os-release name', () => {
  assert.deepEqual(['macos', 'darwin', 'linux', 'windows', 'win32', 'freebsd', null].map(osOf), ['macos', 'macos', 'linux', 'windows', 'windows', 'other', 'other'])
  assert.equal(prettyName('NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\nID=ubuntu\n'), 'Ubuntu 24.04.1 LTS')
  assert.equal(prettyName('ID=alpine\n'), null)
})
