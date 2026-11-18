// The plugin against the real LayerFS 2.0 call table: every call it sends for the families
// already built in 2.0 (home, machine and the six doctors) is in the pinned CLI's
// `help --json`, with the options, `--with` sections, `--progress` and `--full` it passes.
// Runs the pinned CLI (`DSH_LAYERFS_CS20_CLI`, default the cs20 pin) with a throwaway
// LAYERFS_HOME; skipped when the pin is absent.
//   node --test test/cs20-contract.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = new URL('..', import.meta.url).pathname
const CLI = process.env.DSH_LAYERFS_CS20_CLI ?? '/Users/yifanxu/.cache/cs20-pins/313c1c118a/layerfs'
const skip = existsSync(CLI) ? false : `no 2.0 CLI at ${CLI}`

/** The pinned table, read once in a home of its own. */
function table() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-cs20-home-'))
  try {
    const text = execFileSync(CLI, ['help', '--json'], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, LAYERFS_HOME: home } })
    const help = JSON.parse(text)
    const calls = new Map(help.calls.map((c) => [`${c.family}.${c.call}`, c]))
    return { help, calls }
  } finally { rmSync(home, { recursive: true, force: true }) }
}

/** Every production source file (src/), as text. */
function sources(dir = join(root, 'src'), out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) sources(path, out)
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push({ path, text: readFileSync(path, 'utf8') })
  }
  return out
}

const BUILT = new Set(['home', 'machine'])
const FAMILIES = new Set(['home', 'machine', 'store', 'project', 'sandbox', 'backup', 'branch', 'commit', 'file', 'workspace', 'logs', 'doctor'])
const optionNames = (c) => new Set((c.options ?? []).map((o) => o.name))
const withNames = (c) => new Set(Object.keys(c.form?.with ?? {}))

// What the plugin passes besides the positionals, per call (src/host/routes/machines.ts,
// jobs.ts, inspect.ts, service.ts, logs/source.ts, presets/runner.js). `progress` is an
// `on_progress` callback (`--progress`); `with` is a `--with` section.
const SENT = {
  'home.get': { with: ['platforms', 'tree'] },
  'home.log': { options: ['call', 'client', 'tag', 'outcome', 'since', 'limit', 'cursor'] },
  'home.clear_log': {},
  'machine.list': {},
  'machine.get': { with: ['live'] },
  'machine.images': { with: ['docker'] },
  'machine.load_image': { progress: true },
  'machine.prune': { options: ['unused'] },
  'machine.stats': { with: ['space'] },
  'machine.files': { options: ['depth', 'limit', 'cursor', 'byte_offset', 'byte_length'] },
  'machine.log': { options: ['limit', 'cursor'] },
  'machine.start': { progress: true },
  'machine.stop': { options: ['force'], progress: true },
  'machine.create': { options: ['cpus', 'memory', 'disk', 'image', 'os_image'], progress: true },
  'machine.remove': { progress: true },
  'machine.update': { options: ['cpus', 'memory', 'image', 'docker', 'wsl', 'daemon'] },
}

test('the switches the seam writes are in the 2.0 table', { skip }, () => {
  const { help } = table()
  const switches = new Set((help.switches ?? []).map((s) => s.name))
  for (const name of ['--detail', '--with', '--progress']) assert.ok(switches.has(name), `${name} is a 2.0 switch`)
  const detail = help.switches.find((s) => s.name === '--detail')
  for (const call of Object.keys(SENT)) assert.ok(detail.calls.includes(call), `${call} takes --detail (the UI reads its long form)`)
})

test('every home and machine call the plugin sends is in the 2.0 table, with its options, sections and progress', { skip }, () => {
  const { calls } = table()
  for (const [name, sent] of Object.entries(SENT)) {
    const c = calls.get(name)
    assert.ok(c, `${name} is a 2.0 call`)
    for (const option of sent.options ?? []) assert.ok(optionNames(c).has(option), `${name} takes ${option}`)
    for (const section of sent.with ?? []) assert.ok(withNames(c).has(section), `${name} has --with ${section}`)
    if (sent.progress) assert.ok(c.form?.progress && optionNames(c).has('on_progress'), `${name} reports progress`)
  }
  // the source agrees with the table above: any `lfs.home.x` / `lfs.machine.x` call or raw
  // `['home'|'machine', 'x', ...]` argv in src/ names a 2.0 call listed in SENT (or home.init,
  // left on its old route until the home.init package merges)
  const found = new Set()
  for (const { path, text } of sources()) {
    for (const m of text.matchAll(/\blfs(?:\(\))?\.(home|machine)\.([a-z_]+)\b/g)) found.add(`${m[1]}.${m[2]}\t${path}`)
    for (const m of text.matchAll(/\[\s*'(home|machine)'\s*,\s*'([a-z_-]+)'\s*[,\]]/g)) if (!FAMILIES.has(m[2])) found.add(`${m[1]}.${m[2].replace(/-/g, '_')}\t${path}`)
  }
  assert.ok(found.size > 10, 'the scan found the plugin\'s calls')
  for (const entry of found) {
    const [name, path] = entry.split('\t')
    assert.ok(BUILT.has(name.split('.')[0]))
    assert.ok(calls.has(name), `${name} (${path.slice(root.length)}) is a 2.0 call`)
    assert.ok(name in SENT || name === 'home.init', `${name} (${path.slice(root.length)}) is listed in SENT`)
  }
})

test('the Doctor page\'s argv is a 2.0 call: six doctors, --progress only where reported, --full only where taken', { skip }, async () => {
  const { help, calls } = table()
  const out = mkdtempSync(join(tmpdir(), 'dsh-cs20-doctor-'))
  try {
    await build({
      absWorkingDir: root,
      stdin: { contents: "export * from './src/shared/doctor.ts'\n", resolveDir: root, loader: 'ts' },
      outfile: join(out, 'doctor.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24', logLevel: 'warning',
    })
    const D = await import(pathToFileURL(join(out, 'doctor.mjs')).href)
    const doctors = [...calls.keys()].filter((k) => k.endsWith('.doctor'))
    assert.equal(D.DOCTOR_KINDS.length, 6)
    assert.equal(doctors.length, 6, `the table has six doctors: ${doctors.join(', ')}`)
    for (const kind of D.DOCTOR_KINDS) {
      for (const full of [false, true]) {
        const argv = D.doctorArgv({ kind, name: kind === 'home' ? undefined : 'x', full })
        if (full && !D.FULL_KINDS.includes(kind)) { assert.equal(argv, null, `${kind} has no Full check`); continue }
        const [family, call, ...rest] = argv
        const c = calls.get(`${family}.${call}`)
        assert.ok(c, `${family}.${call} is a 2.0 call`)
        assert.ok(rest.includes('--detail'))
        assert.equal(rest.includes('--progress'), !!c.form?.progress, `${family} doctor: --progress exactly when the call reports progress`)
        if (full) assert.ok(optionNames(c).has('full'), `${family} doctor takes --full`)
        assert.equal(rest.includes('--'), (c.args ?? []).length > 0, `${family} doctor: a name exactly when the call takes one`)
      }
    }
    // the tree read gate: home.get's `with` declares `tree`
    assert.equal(D.hasTreeRead(help.calls), true)
  } finally { rmSync(out, { recursive: true, force: true }) }
})
