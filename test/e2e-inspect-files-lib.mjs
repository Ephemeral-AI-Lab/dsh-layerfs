// Shared parts of test/e2e-inspect-files*.mjs and test/e2e-inspect-fields.mjs:
// the Files tabs of the machine and Sandbox pages, and the Sandbox page's
// running-command fields (layerfs-project#178 "dsh-layerfs UI" scenario
// matrix), checked in a browser against a private side server.
//
// The frame is test/e2e-inspect-logs-lib.mjs (read its header first: the
// environment, the stand-in and hook contract, and what every row also fails
// on). This file adds what the Files rows need.
//
//   INSPECT_MACHINE          a machine without the Whole filesystem view (default `native`)
//   INSPECT_WHOLE_MACHINE    a machine whose roots answer offers `/` (docker, Lima, Apple Container). Stand-in: `docker`.
//   INSPECT_WHOLE_MACHINE_TITLE  its title in "Jump to" (default: its name with a capital, as the page titles built-in kinds)
//   INSPECT_SANDBOX          a running Sandbox on INSPECT_MACHINE with at least five Workspaces: the first by mount
//                            path with a Commit (a `base`), the second with uncommitted changes
//   INSPECT_WHOLE_SANDBOX    a running Sandbox whose roots answer offers `/` (a namespaces Sandbox)
//   INSPECT_FILES_BASE_<TARGET>   for a real build: the folder that holds the rows' material in the target, where
//                            TARGET is MACHINE, WHOLE_MACHINE, SANDBOX or WHOLE_SANDBOX (a path the target's files call reads:
//                            under a LayerFS root on a native machine, under the home of a host-process Sandbox). Its content,
//                            made by whoever prepares the run (`node test/e2e-inspect-files-lib.mjs material <dir>` writes it):
//                              notes.txt (3 lines), sub/deep/file.txt, empty.txt (0 bytes), data.bin (4096 bytes with NULs),
//                              emptydir/, many/e0000 … e2999 (3,000 files), big.log (50 MB of 64-byte lines), link -> notes.txt,
//                              pipe (a FIFO), slow/ (40 files)
//                            Without it, with the stand-in, the lib writes that material itself. A row whose target
//                            has none is NOT_RUN.
//   INSPECT_HOOK             for a real build, also (called as in the logs lib, `<hook> <action> <machine|sandbox> <name> [args…]`):
//                              files-hang <ms> [<path>] / files-unhang [<path>]     make the files call of the target (or of
//                                                                                   that path only; `-` is the roots) hang / answer again
//                              files-refuse <code> <message> [<path>] / files-unrefuse [<path>]
//                              files-deadline <path> <n> / files-undeadline <path>  make every page of that folder end at its
//                                                                                   time limit after n entries
//                              files-stop / files-start                             stop / start the Sandbox (its home stays readable)
//                            exit 3: this machine cannot: the row is NOT_RUN.
//
// With INSPECT_STANDIN_DIR the stand-in chain is expected to be
// cli-inspect-files.mjs -> cli-inspect-fields.mjs -> cli-inspect-logs.mjs -> the pinned CLI
// (test/fixtures/cli-standin-lib.mjs), all on that fixture folder; this lib
// writes its files.json and fixture trees (`setup`). Every result then reads
// "against the stand-in CLI".
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, symlinkSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { NotRun, cfg, editor, jump, probe, sleep } from './e2e-inspect-logs-lib.mjs'

export * from './e2e-inspect-logs-lib.mjs'

const standin = cfg.standin
export const home = process.env.DSH_LAYERFS_HOME || join(cfg.devDir, 'layerfs-home')
const title = (name) => (name === 'native' ? 'LayerFS Home' : name.charAt(0).toUpperCase() + name.slice(1))
/** The four targets a row can use; `name` null when the environment names none. */
export const T = {
  machine: { kind: 'machine', name: cfg.machine, title: cfg.machineTitle, env: 'MACHINE' },
  wholeMachine: { kind: 'machine', name: process.env.INSPECT_WHOLE_MACHINE || (standin ? 'docker' : null), title: process.env.INSPECT_WHOLE_MACHINE_TITLE || title(process.env.INSPECT_WHOLE_MACHINE || 'docker'), env: 'WHOLE_MACHINE' },
  sandbox: { kind: 'sandbox', name: cfg.sandbox, title: cfg.sandbox, env: 'SANDBOX' },
  wholeSandbox: { kind: 'sandbox', name: process.env.INSPECT_WHOLE_SANDBOX || null, title: process.env.INSPECT_WHOLE_SANDBOX || null, env: 'WHOLE_SANDBOX' },
}
export function need(target) {
  if (!target.name) throw new NotRun(`INSPECT_${target.env} is not set`)
  return target
}

// ---------------------------------------------------------------- the rows' material

const LINE = 64
const bigLine = (i) => `line ${String(i).padStart(7, '0')} ${'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(2)}`.slice(0, LINE - 1) + '\n'
export const MANY = 3000, BIG_BYTES = 50 * 1024 * 1024, SLOW = 40
export const NOTES = 'first line of notes\nsecond line of notes\nthird line of notes\n'

/** Write the material into `dir` (a folder on this disk); what is there already is kept. */
export function writeMaterial(dir) {
  mkdirSync(join(dir, 'sub', 'deep'), { recursive: true })
  mkdirSync(join(dir, 'emptydir'), { recursive: true })
  writeFileSync(join(dir, 'notes.txt'), NOTES)
  writeFileSync(join(dir, 'sub', 'deep', 'file.txt'), 'deep file\n')
  writeFileSync(join(dir, 'empty.txt'), '')
  const bin = Buffer.alloc(4096)
  for (let i = 0; i < bin.length; i++) bin[i] = i % 7 === 0 ? 0 : (i * 31) % 256
  writeFileSync(join(dir, 'data.bin'), bin)
  if (!existsSync(join(dir, 'many', `e${String(MANY - 1).padStart(4, '0')}`))) {
    mkdirSync(join(dir, 'many'), { recursive: true })
    for (let i = 0; i < MANY; i++) writeFileSync(join(dir, 'many', `e${String(i).padStart(4, '0')}`), `${i}\n`)
  }
  mkdirSync(join(dir, 'slow'), { recursive: true })
  for (let i = 0; i < SLOW; i++) writeFileSync(join(dir, 'slow', `s${String(i).padStart(2, '0')}`), `${i}\n`)
  const big = join(dir, 'big.log')
  let have = 0
  try { have = statSync(big).size } catch { /* not there */ }
  if (have !== BIG_BYTES) {
    const fd = openSync(big, 'w')
    const per = 16384
    for (let i = 0; i < BIG_BYTES / LINE; i += per) writeSync(fd, Array.from({ length: per }, (_, k) => bigLine(i + k)).join(''))
    closeSync(fd)
  }
  try { symlinkSync('notes.txt', join(dir, 'link')) } catch { /* there already */ }
  if (!existsSync(join(dir, 'pipe'))) spawnSync('mkfifo', [join(dir, 'pipe')])
}
if (process.argv[1] && process.argv[1].endsWith('e2e-inspect-files-lib.mjs') && process.argv[2] === 'material') { writeMaterial(process.argv[3]); process.exit(0) }

// ---------------------------------------------------------------- the stand-in's fixture

const filesFile = () => join(standin, 'files.json')
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return {} } }
/** The folder on this disk that is the stand-in's `/` of a target. */
const rootOf = (kind, name) => join(standin, 'files', `${kind}-${name}`)
const put = (file, text, mode) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); if (mode !== undefined) chmodSync(file, mode) }

/** The run folder of a Sandbox of the private home (its record's `daemon.directory`). */
export function runFolder(sandbox) {
  try { return JSON.parse(readFileSync(join(home, 'sandbox', sandbox, 'record.json'), 'utf8')).daemon.directory } catch { return null }
}

/**
 * Where each target's material is, as the target's files call names it: from
 * INSPECT_FILES_BASE_<TARGET>, else (stand-in) written by {@link setup}.
 */
export const bases = {}
export function baseOf(target) {
  need(target)
  const base = bases[target.env] ?? process.env[`INSPECT_FILES_BASE_${target.env}`]
  if (!base) throw new NotRun(`no material for ${target.kind} ${target.name}: set INSPECT_FILES_BASE_${target.env} (the folder made by \`node test/e2e-inspect-files-lib.mjs material <dir>\`)`)
  return base
}

/**
 * The stand-in's world, written once per run (idempotent): fixture trees
 * under <stand-in dir>/files and their declaration in files.json.
 * - `native`: the private home's own folders by role (stores, Sandbox records, run folders, logs); no `/`.
 * - INSPECT_WHOLE_MACHINE (docker): a fixture tree that is its `/`: LayerFS's folders under /layerfs by role, at
 *   the paths and on the mounts a docker machine of the real build has them (machine.md `machine.files`),
 *   system folders, a host mount, a Workspace mount, unreadable entries; and one root with a role no build
 *   names (`cache_future`: not a real answer, kept so the page's rule for an unknown role stays checked).
 * - INSPECT_SANDBOX: the real Sandbox from its records: Workspaces, home, log; only its home is read.
 * - INSPECT_WHOLE_SANDBOX: the same, plus a fixture tree as its `/` (what a namespaces Sandbox's commands see),
 *   with its run folder and the project's Store folder at their own paths.
 * A real build needs none of this.
 */
export function setup() {
  for (const target of Object.values(T)) { const given = process.env[`INSPECT_FILES_BASE_${target.env}`]; if (given) bases[target.env] = given }
  if (!standin) return
  const config = { machine: {}, sandbox: {} }
  // ---- the native machine: the home's own folders
  mkdirSync(join(home, 'log'), { recursive: true })
  if (!existsSync(join(home, 'log', 'e2e-files'))) mkdirSync(join(home, 'log', 'e2e-files'))
  writeMaterial(join(home, 'log', 'e2e-files'))
  bases.MACHINE ??= join(home, 'log', 'e2e-files')
  const nativeRoots = [{ role: 'stores', path: join(home, 'store') }, { role: 'sandbox_records', path: join(home, 'sandbox') }, { role: 'run_folders', path: join(home, 'machine', 'native', 'run') }, { role: 'logs', path: join(home, 'log') }]
  config.machine.native = { binds: [{ at: home, from: home }], roots: nativeRoots, confine: nativeRoots.map((r) => r.path), run_folders: [join(home, 'machine', 'native', 'run')], restricted_names: ['control.json', 'worker.json', 'store.sqlite', 'store.sqlite-wal', 'store.sqlite-shm', 'layerfs.lock', 'lock', 'serve.lock'] }

  // ---- a machine with a Whole filesystem view
  if (T.wholeMachine.name && T.wholeMachine.name !== 'native') {
    const root = rootOf('machine', T.wholeMachine.name)
    const run = '/layerfs/data/machine/native/run/layerfs-0a1b2c3d-shop'
    put(join(root, 'layerfs/data/store/shop/store.sqlite'), 'SQLite format 3\0')
    put(join(root, 'layerfs/data/store/shop/record.json'), '{"v":1,"name":"shop"}\n')
    put(join(root, 'layerfs/data/sandbox/shop/control.json'), '{"secret":"never shown"}\n')
    put(join(root, 'layerfs/data/sandbox/shop/record.json'), '{"v":1,"name":"shop"}\n')
    put(join(root, run, 'config/daemon.key'), 'PRIVATE KEY\n')
    put(join(root, run, 'overlay/1.sqlite'), 'SQLite format 3\0')
    put(join(root, run, 'tmp/hello.txt'), 'hello from the Sandbox home\n')
    put(join(root, run, 'daemon.log'), 'daemon started\n')
    mkdirSync(join(root, run, 'workspaces/1'), { recursive: true })
    put(join(root, 'layerfs/data/machine/native/run/images/1f2e3d.2.json'), '{}\n')
    put(join(root, 'layerfs/data/machine/native/run/images/1f2e3d.2.lock'), '')
    put(join(root, 'layerfs/data/store/shop/open/4242'), '')
    mkdirSync(join(root, 'layerfs/data/incoming'), { recursive: true })
    put(join(root, 'layerfs/data/log/worker.log'), 'worker listening\n')
    put(join(root, 'layerfs/data/log/worker.1.log'), 'earlier start\n')
    put(join(root, 'layerfs/state/secret'), 'worker secret\n', 0o600)
    put(join(root, 'layerfs/state/worker.pid'), '1\n')
    put(join(root, 'layerfs/bundle/bundle.json'), '{"version":"2.0.0"}\n')
    put(join(root, 'layerfs/cache/note.txt'), 'a root with a role this page does not know\n')
    put(join(root, 'etc/hosts'), '127.0.0.1 localhost\n::1 localhost\n')
    put(join(root, 'etc/hostname'), 'layerfs-machine\n')
    put(join(root, 'etc/shadow'), 'root:*:19000:0:99999:7:::\n', 0o600)
    put(join(root, 'usr/bin/env'), '#!/bin/sh\n')
    put(join(root, 'var/log/syslog'), 'boot\n')
    mkdirSync(join(root, 'root'), { recursive: true }); chmodSync(join(root, 'root'), 0o700)
    mkdirSync(join(root, 'tmp'), { recursive: true })
    try { symlinkSync('usr/bin', join(root, 'bin')) } catch { /* there */ }
    try { symlinkSync('../proc/self/mounts', join(root, 'etc/mtab')) } catch { /* there */ }
    writeMaterial(join(root, 'var/e2e-files'))
    bases.WHOLE_MACHINE ??= '/var/e2e-files'
    config.machine[T.wholeMachine.name] = {
      root, whole: 'machine', o_r_outside: '/layerfs',
      roots: [
        // as a docker machine answers: the data volume, the worker's tmpfs and the bundle bind are mounts of their own
        { role: 'data', path: '/layerfs/data', free_bytes: 48_500_000_000, fs: 'ext4' }, { role: 'stores', path: '/layerfs/data/store' }, { role: 'sandbox_records', path: '/layerfs/data/sandbox' },
        { role: 'run_folders', path: '/layerfs/data/machine/native/run' }, { role: 'images', path: '/layerfs/data/machine/native/run/images' }, { role: 'staging', path: '/layerfs/data/incoming' },
        { role: 'logs', path: '/layerfs/data/log' }, { role: 'state', path: '/layerfs/state', fs: 'tmpfs' }, { role: 'bundle', path: '/layerfs/bundle', fs: 'fakeowner' }, { role: 'image', path: '/layerfs/image' },
        { role: 'cache_future', path: '/layerfs/cache' },
      ],
      run_folders: ['/layerfs/data/machine/native/run'],
      overlay: {
        '/proc': { kind: 'system' }, '/sys': { kind: 'system' }, '/dev': { kind: 'system' }, '/run': { kind: 'system' },
        '/mnt': { kind: 'mount', fs: 'virtiofs' }, '/layerfs/state/secret': { kind: 'restricted' },
        [`${run}/workspaces/1`]: { kind: 'mount', workspace: 'ws-0001' },
      },
      deadline: { '/var/e2e-files/slow': 15 },
    }
  }

  // ---- the Sandboxes, from their records in the private home
  for (const target of [T.sandbox, T.wholeSandbox]) {
    if (!target.name) continue
    const run = runFolder(target.name)
    if (!run) continue
    writeMaterial(join(run, 'tmp', 'e2e-files'))
    bases[target.env] ??= join(run, 'tmp', 'e2e-files')
    const entry = { records: join(home, 'sandbox', target.name), deadline: { [join(run, 'tmp', 'e2e-files', 'slow')]: 15 } }
    if (target === T.wholeSandbox) {
      const root = rootOf('sandbox', target.name)
      put(join(root, 'etc/os-release'), 'NAME="LayerFS Sandbox"\n')
      put(join(root, 'bin/sh'), '#!stand-in\n')
      put(join(root, 'usr/lib/libexample.so'), 'ELF\0')
      put(join(root, '.layerfs/runtime/bash'), '#!stand-in\n')
      mkdirSync(join(root, 'tmp'), { recursive: true })
      const store = join(home, 'store')
      Object.assign(entry, {
        root, whole: 'root', binds: [{ at: store, from: store }],
        // a Sandbox's root (sandbox.md "The root"): /proc, /sys and /dev are `system`
        overlay: { '/proc': { kind: 'system' }, '/sys': { kind: 'system' }, '/dev': { kind: 'system' } },
      })
    }
    config.sandbox[target.name] = entry
  }
  const kept = readJson(filesFile())
  writeFileSync(filesFile(), JSON.stringify({ ...config, ...(kept.calls ? { calls: kept.calls } : {}) }, null, 2))
}

// ---------------------------------------------------------------- hang, refuse, stop: the stand-in's files, else the hook

const controlFile = () => join(standin, 'control.json')
function control(change) {
  const now = readJson(controlFile())
  now.refuse ??= {}; now.delay_ms ??= {}
  change(now)
  writeFileSync(controlFile(), JSON.stringify(now, null, 2))
}
function declare(change) {
  const now = readJson(filesFile())
  change(now)
  writeFileSync(filesFile(), JSON.stringify(now, null, 2))
}
function hook(action, target, ...args) {
  if (!cfg.hook) throw new NotRun(`no INSPECT_STANDIN_DIR and no INSPECT_HOOK: nothing here can \`${action}\` the files call of ${target.kind} ${target.name}`)
  const r = spawnSync(cfg.hook, [action, target.kind, target.name, ...args.map(String)], { encoding: 'utf8', timeout: 100000 })
  if (r.status === 3) throw new NotRun(`INSPECT_HOOK cannot \`${action}\` here: ${(r.stdout || r.stderr || '').trim() || 'no reason given'}`)
  if (r.status !== 0) throw new Error(`INSPECT_HOOK ${action} ${target.kind} ${target.name} failed (exit ${r.status}): ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`)
}
/** The control key of a target's files call: of every read, or of one path (`''` is the roots). */
const keyOf = (target, path) => `files-${target.kind}:${target.name}${path === undefined ? '' : `:${path}`}`
export const filesDriver = {
  hang(target, ms, path) { if (!standin) return hook('files-hang', target, ms, ...(path === undefined ? [] : [path || '-'])); control((c) => { c.delay_ms[keyOf(target, path)] = ms }) },
  unhang(target, path) { if (!standin) return hook('files-unhang', target, ...(path === undefined ? [] : [path || '-'])); control((c) => { delete c.delay_ms[keyOf(target, path)] }) },
  refuse(target, code, message, path) { if (!standin) return hook('files-refuse', target, code, message, ...(path === undefined ? [] : [path || '-'])); control((c) => { c.refuse[keyOf(target, path)] = { code, message } }) },
  unrefuse(target, path) { if (!standin) return hook('files-unrefuse', target, ...(path === undefined ? [] : [path || '-'])); control((c) => { delete c.refuse[keyOf(target, path)] }) },
  deadline(target, path, n) { if (!standin) return hook('files-deadline', target, path, n); declare((f) => { (f[target.kind][target.name].deadline ??= {})[path] = n }) },
  /** A Sandbox as LayerFS answers for a stopped one: its home is read, its root is `Unavailable`. */
  stop(target) { if (!standin) return hook('files-stop', target); declare((f) => { f[target.kind][target.name].state = 'stopped' }) },
  start(target) { if (!standin) return hook('files-start', target); declare((f) => { delete f[target.kind][target.name].state }) },
}

// ---------------------------------------------------------------- a second client

/**
 * Run `command` in Workspace `ws` as another client of the same LayerFS home
 * would: the CLI the server pins, run directly, with a log tag of its own.
 * Returns the child (its `exit` ends when the command does).
 */
export function secondClient(ws, command, { tag = null, execId = null } = {}) {
  const env = { ...process.env, LAYERFS_HOME: home }
  if (process.env.DSH_LAYERFS_BUNDLE) env.LAYERFS_BUNDLE = process.env.DSH_LAYERFS_BUNDLE
  if (tag) env.LAYERFS_LOGS_TAG = tag; else delete env.LAYERFS_LOGS_TAG
  if (standin) Object.assign(env, { LFS_INSPECT_DIR: standin })
  return spawn(cfg.cli, ['workspace', 'exec', ws, command, ...(execId ? ['--exec-id', execId] : [])], { env, stdio: 'ignore' })
}

/** The pinned CLI's answer to a read, run directly on the private home (setup and checks, outside any row's mark). */
export function lfs(...args) {
  const env = { ...process.env, LAYERFS_HOME: home }
  if (process.env.DSH_LAYERFS_BUNDLE) env.LAYERFS_BUNDLE = process.env.DSH_LAYERFS_BUNDLE
  return JSON.parse(execFileSync(cfg.cli, args, { env, encoding: 'utf8', timeout: 30000, maxBuffer: 1 << 26 }))
}

// ---------------------------------------------------------------- the Files tab

export const files = (page) => editor(page).locator('[data-files]')

/** Open `target`'s page on its first tab (no Files pane yet). */
export async function openPage(page, target) {
  need(target)
  await jump(page, target.title)
  const first = editor(page).getByRole('tab').first()
  if (await first.count()) await first.click()
  await files(page).waitFor({ state: 'detached' })
}
/** Forget where the Files tab of `target` was left (the viewer's localStorage and the page's own memory need a reload: use before the page opens). */
export const forgetPlace = (page) => page.evaluate(() => { try { localStorage.removeItem('dsh-layerfs:inspect-files') } catch { /* blocked */ } })
/** Open `target`'s Files tab and wait for its first answer. */
export async function openFiles(page, target, { timeout = 20000 } = {}) {
  await openPage(page, target)
  await showFiles(page, { timeout })
}
export async function showFiles(page, { timeout = 20000 } = {}) {
  await editor(page).getByRole('tab', { name: 'Files', exact: true }).click()
  await files(page).waitFor()
  await waitFiles(page, (s) => s.state !== 'reading' && s.state !== 'going', { timeout })
}

/** The Files tab as data: its view, top folder, open file, state, notice, and every tree row showing. */
export const filesState = (page) => page.evaluate(() => {
  const el = [...document.querySelectorAll('[data-storage-page] [data-files]')].find((e) => e.offsetParent)
  if (!el) return null
  const rows = [...el.querySelectorAll('[data-files-tree] [data-tree-key]')].map((b) => {
    const li = b.closest('[role=treeitem]')
    return {
      key: b.getAttribute('data-tree-key'), kind: b.getAttribute('data-tree-kind'), more: b.hasAttribute('data-tree-more'),
      text: b.textContent, title: b.getAttribute('title'), disabled: b.getAttribute('aria-disabled') === 'true',
      expanded: li?.getAttribute('aria-expanded') ?? null, selected: li?.getAttribute('aria-selected') === 'true', busy: li?.getAttribute('aria-busy') === 'true',
      trailing: li?.querySelector(':scope > div > span:last-child:not(:first-child)')?.textContent ?? '', below: li?.querySelector(':scope > div + div:not([role])')?.textContent ?? '',
      tabindex: b.getAttribute('tabindex'),
    }
  })
  const viewer = el.querySelector('[data-files-viewer]')
  return {
    view: el.getAttribute('data-files-view'), base: el.getAttribute('data-files-base'), file: el.getAttribute('data-files-file'), state: el.getAttribute('data-files-state'),
    narrow: el.hasAttribute('data-files-narrow'), busy: el.getAttribute('aria-busy') === 'true',
    notice: el.querySelector('[data-files-notice]')?.textContent ?? null,
    path: el.querySelector('[data-files-pathbar] input')?.value ?? null,
    views: [...el.querySelectorAll('[role=radiogroup] [role=radio], [role=tablist] [role=tab]')].map((b) => b.textContent),
    crumbs: el.querySelector('[data-files-crumbs]')?.textContent ?? null,
    rows,
    reading: [...el.querySelectorAll('[data-tree-reading]')].map((n) => ({ path: n.getAttribute('data-tree-reading'), text: n.textContent })),
    refusals: [...el.querySelectorAll('[data-files-refusal]')].map((n) => ({ code: n.getAttribute('data-files-refusal'), text: n.textContent })),
    stale: [...el.querySelectorAll('[data-files-stale]')].map((n) => ({ code: n.getAttribute('data-files-stale'), text: n.textContent })),
    empty: [...el.querySelectorAll('[data-tree-empty]')].map((n) => n.getAttribute('data-tree-empty')),
    viewer: viewer ? viewer.innerText : null,
    scrollX: el.scrollWidth - el.clientWidth,
  }
})
export async function waitFiles(page, test, { timeout = 15000, every = 120 } = {}) {
  const until = Date.now() + timeout
  let last = null
  for (;;) {
    last = await filesState(page)
    if (last && test(last)) return { ok: true, state: last }
    if (Date.now() > until) return { ok: false, state: last }
    await sleep(every)
  }
}
export const rowOf = (state, key) => state?.rows.find((r) => r.key === key)
/** The tree row button of `path`. */
export const row = (page, path) => files(page).locator(`[data-files-tree] [data-tree-key=${JSON.stringify(path)}]`)
/** Type `path` into the path bar and press "Go to path". */
export async function goPath(page, path, { wait = true } = {}) {
  const input = files(page).locator('[data-files-pathbar] input')
  await input.fill(path)
  await files(page).getByRole('button', { name: 'Go to path', exact: true }).click()
  if (wait) await waitFiles(page, (s) => s.state !== 'going' && s.state !== 'reading')
}
/** Whether the page's Files tab is offered by the server for `target`. */
export async function offeredFiles(page) {
  const view = await probe(page, 'GET', '/api/machines')
  if (!view.ok) throw new Error(`GET /api/machines: ${view.status} ${view.code} ${view.message}`)
  return view.body.features?.inspect ?? {}
}
/** Switch the Files tab to the view named `name` ("Whole filesystem (/)", "LayerFS folders", "Sandbox"). */
export async function switchView(page, name) {
  await files(page).getByText(name, { exact: true }).first().click()
  await waitFiles(page, (s) => s.state !== 'reading' && s.state !== 'going')
}
/** The tree item (row, trailing part and the lines under it) of `path`. */
export const itemOf = (page, path) => files(page).locator('li[role=treeitem]').filter({ has: page.locator(`:scope > div > [data-tree-key=${JSON.stringify(path)}]`) }).first()
/** Open (or close) the folder row of `path` and wait until its listing is in. */
export async function toggle(page, path, { timeout = 15000 } = {}) {
  await row(page, path).click()
  return waitFiles(page, (s) => { const r = rowOf(s, path); return r && !r.busy && !s.reading.some((x) => x.path === path) }, { timeout })
}
/** The rows directly or deeper under `path`. */
export const under = (state, path) => state.rows.filter((r) => !r.more && r.key.startsWith(`${path}/`))
/** The "More entries" row of the folder `path`, as filesState shows it. */
export const moreOf = (state, path) => state.rows.find((r) => r.more && r.key.includes(path))
export const moreButton = (page, path) => files(page).locator(`[data-tree-more=${JSON.stringify(path)}]`)
/** The files reads that became CLI processes since `mark` (spawnMark()), as `{ path, flags }`. */
export function filesSpawns(since) {
  return since.inspect.filter((s) => s.argv[1] === 'files').map((s) => ({ kind: s.argv[0], name: s.argv[2], argv: s.argv }))
}
/** The folder a path is in. */
export const parentPath = (path) => { const at = path.lastIndexOf('/'); return at <= 0 ? '/' : path.slice(0, at) }
/** Open `target`'s page and its Files tab without passing through another tab (the tab keeps what its first read said). */
export async function openFilesAsLeft(page, target, { timeout = 20000 } = {}) {
  need(target)
  await jump(page, target.title)
  const tab = editor(page).getByRole('tab', { name: 'Files', exact: true })
  await tab.waitFor()
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click()
  await files(page).waitFor()
  await waitFiles(page, (s) => s.state !== 'reading' && s.state !== 'going', { timeout })
}

// ---------------------------------------------------------------- the monitoring fields (the stand-in only)

/** Set what the stand-in's `sandbox get` says about the fields (cli-inspect-fields.mjs fields.json); `{}` is the default. A real build has the fields it has: NOT_RUN. */
export function declareFields(config) {
  if (!standin) throw new NotRun('a real build answers the fields it has: this part needs the stand-in')
  writeFileSync(join(standin, 'fields.json'), JSON.stringify(config))
}
/** Back at the roots of the view shown (the app remembers the place a tab was left at while it is open, whatever localStorage holds). */
export async function toRoots(page) {
  const state = await filesState(page)
  if (!state || state.base === '') return
  await files(page).locator('[data-files-crumbs] button').first().click()
  await waitFiles(page, (s) => s.base === '' && s.state === 'ready')
}
