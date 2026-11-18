// The plugin against the real LayerFS 2.0 call table: every call it sends (home, machine,
// store, backup, project, branch, commit, file, sandbox, workspace and the six doctors) is in
// the pinned CLI's `help --json`, with the options, `--with` sections, `--progress` and
// `--full` it passes, and every flag in a raw argv (presets, simulations) is one the call takes.
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
const CLI = process.env.DSH_LAYERFS_CS20_CLI ?? '/Users/yifanxu/.cache/cs20-pins/c20b3394b2/layerfs'
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

const BUILT = new Set(['home', 'machine', 'store', 'project', 'sandbox', 'backup', 'branch', 'commit', 'file', 'workspace'])
const FAMILY = [...BUILT].join('|')
// family and thing-kind words: `['project', 'bucket']` is a list of kinds, not an argv
const FAMILIES = new Set(['home', 'machine', 'store', 'project', 'sandbox', 'backup', 'bucket', 'branch', 'commit', 'file', 'workspace', 'logs', 'doctor'])
const optionNames = (c) => new Set((c.options ?? []).map((o) => o.name))
const withNames = (c) => new Set(Object.keys(c.form?.with ?? {}))

// What the plugin passes besides the positionals, per call (src/host/routes/*.ts,
// service.ts, logs/source.ts, sessions/*.ts, presets/*.js, simulations/*.ts). `progress` is
// an `on_progress` callback (`--progress`); `with` is a `--with` section.
const SENT = {
  'home.init': {},
  'home.get': { with: ['platforms', 'tree'] },
  'home.log': { options: ['call', 'client', 'tag', 'outcome', 'since', 'limit', 'cursor'] },
  'home.clear_log': {},
  'home.leftovers': {},
  'home.prune': {},
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
  // Storage (routes/storage.ts, jobs.ts; presets build/runner)
  'store.list': { with: ['stats'] },
  'store.get': { with: ['live', 'stats'] },
  'store.create': {},
  'store.remove': {},
  'store.save_auth': { options: ['user', 'password'] },
  'store.auths': {},
  'store.connect': { options: ['auth', 'machine', 'synchronous_commit'] },
  'store.disconnect': { options: ['machine'] },
  'store.update': { options: ['auth', 'synchronous_commit'] },
  'store.doctor': { options: ['machine'] },
  'store.move': { progress: true },
  'store.compact': { progress: true },
  'backup.connect': { options: ['access_key', 'secret_key'] },
  'backup.disconnect': {},
  'backup.list': { options: ['bucket'] },
  'backup.create': { options: ['file'], progress: true },
  'backup.restore': { progress: true },
  // Sandboxes and Workspaces (routes/projects.ts, machines.ts, commands.ts, router.ts; sessions)
  'sandbox.create': { options: ['machine', 'image'], progress: true },
  'sandbox.list': { options: ['project', 'limit', 'cursor'] },
  'sandbox.get': { with: ['stats'] },
  'sandbox.remove': { options: ['force'] },
  'sandbox.files': { options: ['depth', 'limit', 'cursor', 'byte_offset', 'byte_length'] },
  'sandbox.log': { options: ['limit', 'cursor'] },
  'workspace.mount': { options: ['name'] },
  'workspace.exec': { progress: true },
  'workspace.cancel': { options: ['exec'] },
  'workspace.commit': { options: ['message'] },
  'workspace.unmount': { options: ['discard', 'force'] },
  'workspace.status': {},
  // Projects, Branches, Commits and files (routes/projects.ts, project-storage.ts; sessions; presets)
  'project.init': { progress: true },
  'project.list': { options: ['store', 'limit', 'cursor'] },
  'project.get': {},
  'project.stats': { options: ['branch', 'at'] },
  'project.export': { options: ['branch'] },
  'project.delete': {},
  'branch.list': { options: ['prefix', 'limit', 'cursor'] },
  'branch.get': {},
  'branch.fork': { options: ['at'] },
  'branch.merge': { options: ['into', 'message'] },
  'branch.publish': { options: ['at'] },
  'commit.list': { options: ['at', 'limit', 'cursor'] },
  'commit.get': { options: ['branch'] },
  'commit.diff': { options: ['from', 'path', 'limit', 'cursor'], with: ['patch'] },
  'file.read': { options: ['at', 'line', 'limit'] },
  'file.stat': { options: ['at'] },
  'file.list': { options: ['at', 'limit', 'cursor'] },
  'file.glob': { options: ['limit'] },
  'file.history': { options: ['at', 'traversal', 'limit', 'cursor'] },
  'file.blame': { options: ['at', 'line', 'limit'] },
  'file.write': { options: ['message'] },
  'file.apply': { options: ['message'] },
}

test('the switches the seam writes are in the 2.0 table', { skip }, () => {
  const { help } = table()
  const switches = new Set((help.switches ?? []).map((s) => s.name))
  for (const name of ['--detail', '--with', '--progress']) assert.ok(switches.has(name), `${name} is a 2.0 switch`)
  const detail = help.switches.find((s) => s.name === '--detail')
  for (const call of Object.keys(SENT)) assert.ok(detail.calls.includes(call), `${call} takes --detail (the UI reads its long form)`)
})

test('every call the plugin sends is in the 2.0 table, with its options, sections and progress', { skip }, () => {
  const { calls } = table()
  for (const [name, sent] of Object.entries(SENT)) {
    const c = calls.get(name)
    assert.ok(c, `${name} is a 2.0 call`)
    for (const option of sent.options ?? []) assert.ok(optionNames(c).has(option), `${name} takes ${option}`)
    for (const section of sent.with ?? []) assert.ok(withNames(c).has(section), `${name} has --with ${section}`)
    if (sent.progress) assert.ok(c.form?.progress && optionNames(c).has('on_progress'), `${name} reports progress`)
  }
  // the source agrees with the table above: any `lfs.<family>.x` call or raw
  // `['<family>', 'x', ...]` argv in src/ names a 2.0 call listed in SENT
  const found = new Set()
  for (const { path, text } of sources()) {
    for (const m of text.matchAll(new RegExp(`\\blfs(?:\\(\\))?\\.(${FAMILY})\\.([a-z_]+)\\b`, 'g'))) found.add(`${m[1]}.${m[2]}\t${path}`)
    for (const m of text.matchAll(new RegExp(`\\[\\s*'(${FAMILY})'\\s*,\\s*'([a-z_-]+)'\\s*[,\\]]`, 'g'))) if (!FAMILIES.has(m[2])) found.add(`${m[1]}.${m[2].replace(/-/g, '_')}\t${path}`)
  }
  assert.ok(found.size > 60, 'the scan found the plugin\'s calls')
  for (const entry of found) {
    const [name, path] = entry.split('\t')
    assert.ok(BUILT.has(name.split('.')[0]))
    assert.ok(calls.has(name), `${name} (${path.slice(root.length)}) is a 2.0 call`)
    assert.ok(name in SENT, `${name} (${path.slice(root.length)}) is listed in SENT`)
  }
})

test('every flag in a raw argv the plugin writes (presets, simulations) is a 2.0 switch or one the call takes', { skip }, () => {
  const { help, calls } = table()
  const switches = new Set((help.switches ?? []).map((s) => s.name))
  const flagsOf = (c) => {
    const out = new Set()
    for (const o of c.options ?? []) {
      if (o.kind === 'function') continue
      out.add(`--${o.name.replace(/_/g, '-')}`)
      if (o.shell) out.add(o.shell)
    }
    return out
  }
  let checked = 0
  for (const { path, text } of sources()) {
    // one argv literal on one line: ['family', 'call', ...] up to its closing bracket
    for (const m of text.matchAll(new RegExp(`\\[\\s*'(${FAMILY})'\\s*,\\s*'([a-z_-]+)'([^\\n]*)`, 'g'))) {
      if (FAMILIES.has(m[2])) continue
      const name = `${m[1]}.${m[2].replace(/-/g, '_')}`
      const c = calls.get(name)
      assert.ok(c, `${name} (${path.slice(root.length)}) is a 2.0 call`)
      for (const f of m[3].matchAll(/'(--[a-z][a-z-]*)'/g)) {
        checked++
        assert.ok(switches.has(f[1]) || flagsOf(c).has(f[1]), `${name} (${path.slice(root.length)}) takes ${f[1]}`)
      }
    }
  }
  assert.ok(checked > 30, `the scan checked the plugin's flags (${checked})`)
})

test('secrets go on stdin: the content options the plugin passes have the shell flags it writes', { skip }, () => {
  const { calls } = table()
  const option = (call, name) => (calls.get(call)?.options ?? []).find((o) => o.name === name)
  assert.equal(option('store.save_auth', 'password')?.shell, '--password-stdin')
  assert.equal(option('store.save_auth', 'password')?.kind, 'content')
  assert.equal(option('backup.connect', 'secret_key')?.shell, '--key-stdin')
  // `file write` takes its content as a positional read from stdin (the preset recipe's `input`)
  assert.equal(calls.get('file.write').args.at(-1).kind, 'content')
})

test('the 2.0 answers the plugin reads: paging, the project/file forms and the removed calls', { skip }, () => {
  const { calls } = table()
  const form = (name) => calls.get(name)?.form ?? {}
  const longOf = (name) => new Set(form(name).long ?? [])
  // removed in 2.0; the plugin never sends them
  for (const gone of ['file.diff', 'file.revision', 'project.remove_file', 'store.status', 'store.push', 'store.pull', 'sandbox.close', 'logs.sandbox', 'branch.commits']) assert.equal(calls.has(gone), false, `${gone} is gone`)
  // paged lists answer items + next_cursor (and the plugin pages by --cursor)
  for (const name of ['project.list', 'branch.list', 'commit.list', 'commit.diff', 'file.list', 'file.history', 'sandbox.list']) {
    assert.ok(longOf(name).has('items'), `${name} answers items`)
    assert.ok(optionNames(calls.get(name)).has('cursor'), `${name} pages by cursor`)
  }
  // the long fields the routes read
  for (const f of ['text', 'next_line', 'line_truncated', 'binary']) assert.ok(longOf('file.read').has(f), `file.read --detail has ${f}`)
  for (const f of ['type', 'size', 'mode']) assert.ok(longOf('file.stat').has(f), `file.stat --detail has ${f}`)
  for (const f of ['ranges', 'commits']) assert.ok(longOf('file.blame').has(f), `file.blame --detail has ${f}`)
  for (const f of ['file_count', 'dir_count', 'size']) assert.ok(longOf('project.stats').has(f), `project.stats --detail has ${f}`)
  for (const f of ['commit', 'unchanged']) assert.ok(longOf('workspace.commit').has(f), `workspace.commit --detail has ${f}`)
  for (const f of ['items', 'not_listed']) assert.ok(longOf('home.leftovers').has(f), `home.leftovers --detail has ${f}`)
  assert.ok(longOf('home.init').has('outcome'), 'home.init --detail has outcome')
})

test('spec v19 forms the Machines page reads: image item states, load-image reuse and drops, prune skips, compact outcome', { skip }, () => {
  const { calls } = table()
  const form = (name) => calls.get(name)?.form ?? {}
  const longOf = (name) => new Set(form(name).long ?? [])
  const sometimes = (name) => new Set(form(name).short?.sometimes ?? [])
  // machine images: an item's six-state companions (absent when ready) and a partial copy's staged bytes
  const item = new Set(form('machine.images').parts?.items?.long ?? [])
  for (const f of ['state', 'op', 'reason', 'fix', 'staged_bytes', 'sandboxes_count', 'last_used_at', 'source']) assert.ok(item.has(f), `machine images items have ${f}`)
  // machine load-image: progress events, `reused` / `dropped` in the short form, dropped_count only when cut
  assert.equal(form('machine.load_image').progress, true)
  for (const f of ['reused', 'dropped']) assert.ok(sometimes('machine.load_image').has(f), `machine load-image may answer ${f}`)
  for (const f of ['dropped_count', 'expanded_bytes']) assert.ok(longOf('machine.load_image').has(f), `machine load-image --detail has ${f}`)
  // machine prune: `skipped` items `{ image, message }`, `removed`, `freed_bytes`
  assert.ok(sometimes('machine.prune').has('skipped'))
  assert.deepEqual(form('machine.prune').parts?.skipped?.short?.always, ['image', 'message'])
  for (const f of ['removed', 'freed_bytes']) assert.ok(longOf('machine.prune').has(f), `machine prune --detail has ${f}`)
  // store compact: progress, `outcome` and `freed_bytes` (a remote sqlite Store runs on its worker: no host-side block)
  assert.equal(form('store.compact').progress, true)
  for (const f of ['outcome', 'freed_bytes']) assert.ok(longOf('store.compact').has(f), `store compact --detail has ${f}`)
  // sandbox create reports its phases; workspace exec answers its exec id and whole-stream byte counts
  assert.equal(form('sandbox.create').progress, true)
  for (const f of ['exec', 'exit_code', 'stdout_bytes', 'stderr_bytes', 'cancelled']) assert.ok(longOf('workspace.exec').has(f), `workspace exec --detail has ${f}`)
  // the markers this pin proves are gone from the source
  for (const { path, text } of sources()) assert.ok(!text.includes('cs20: switch when V19 merges'), `${path} still waits on V19`)
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
