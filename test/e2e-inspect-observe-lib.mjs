// Shared parts of test/e2e-inspect-observe*.mjs: the observed values of the
// Machines and Sandbox pages (layerfs-project#164) and the Doctor page's
// leftovers (#180), checked in a browser against a private side server.
//
// The frame is test/e2e-inspect-logs-lib.mjs and test/e2e-inspect-files-lib.mjs
// (read their headers first: the environment, the stand-in and hook contract,
// and what every row also fails on). This file adds what these rows need.
//
//   INSPECT_MACHINE          a running machine whose calls run on this computer (default `native`): scope host / host_fs
//   INSPECT_WHOLE_MACHINE    a running machine on Docker's kernel (default with the stand-in: `docker`): scope engine_host / vm_disk
//   INSPECT_VOLUME_MACHINE   a running VM machine with a data disk of its own (stand-in: `m179-vm`): scope vm / volume
//   INSPECT_STOPPED_MACHINE  a stopped machine (stand-in: `m179-off`)
//   INSPECT_SANDBOX          a Sandbox whose daemon runs (stand-in: `m179-up`); with INSPECT_USAGE=1 its sandbox.get has `usage`
//   INSPECT_DEAD_SANDBOX     a Sandbox recorded running whose daemon process has ended (stand-in: `m179-dead`)
//   INSPECT_UNSEEN_SANDBOX   a Sandbox recorded running whose daemon could not be observed, e.g. on a stopped machine (stand-in: `m179-unseen`)
//   INSPECT_HOOK             for a real build, also (called as in the logs lib, `<hook> <action> machine <name> [args…]`):
//                              stats-hang <ms> / stats-unhang                  make `machine stats <name>` hang / answer again
//                              stats-refuse <code> <message> / stats-unrefuse  make it refuse / answer again
//                            exit 3: this machine cannot: the row is NOT_RUN.
//   Leftovers on a real build are made by whoever prepares the run (one of each kind `layerfs doctor` reports,
//   at least one whose size the walk does not measure, at least one image lock and one unmount marker); the
//   Doctor rows read what `layerfs doctor` answers and compare the page with it, so they need no hook.
//
// With INSPECT_STANDIN_DIR the stand-in chain is expected to be
//   cli-inspect-observe.mjs -> cli-inspect-files.mjs -> cli-inspect-fields.mjs -> cli-inspect-logs.mjs -> the pinned CLI
// all on that fixture folder; this lib writes its observe.json (`setupObserve`).
// Every result then reads "against the stand-in CLI".
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { NotRun, T, cfg, editor, home, probe, setup, sleep } from './e2e-inspect-files-lib.mjs'

export * from './e2e-inspect-files-lib.mjs'

const standin = cfg.standin
const title = (name) => (name === 'native' ? 'LayerFS Home' : name === 'docker' ? 'Docker' : name)
const target = (kind, name, env) => ({ kind, name, title: name ? (kind === 'machine' ? title(name) : name) : null, env })
/** The machines and Sandboxes these rows open; `name` null when the environment names none. */
export const O = {
  machine: T.machine,
  docker: T.wholeMachine,
  volume: target('machine', process.env.INSPECT_VOLUME_MACHINE || (standin ? 'm179-vm' : null), 'VOLUME_MACHINE'),
  stopped: target('machine', process.env.INSPECT_STOPPED_MACHINE || (standin ? 'm179-off' : null), 'STOPPED_MACHINE'),
  up: target('sandbox', cfg.sandbox || (standin ? 'm179-up' : null), 'SANDBOX'),
  dead: target('sandbox', process.env.INSPECT_DEAD_SANDBOX || (standin ? 'm179-dead' : null), 'DEAD_SANDBOX'),
  unseen: target('sandbox', process.env.INSPECT_UNSEEN_SANDBOX || (standin ? 'm179-unseen' : null), 'UNSEEN_SANDBOX'),
}
export function needO(t) {
  if (!t.name) throw new NotRun(`INSPECT_${t.env} is not set`)
  return t
}

// ---------------------------------------------------------------- the stand-in's world

const observeFile = () => join(standin, 'observe.json')
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return {} } }
const GIB = 1024 ** 3

/** The leftover a finding carries, with LayerFS's message and fix sentence for its kind. */
function finding(machine, kind, path, bytes, age, more = {}) {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const id = `${machine}:${kind}:${more.name ?? name}`
  const fix = `\`layerfs doctor fix ${id}\``
  const words = {
    'run-folder': ['a Sandbox run folder no Sandbox record names', `${fix} removes it when it has its \`owner\` marker, no daemon of it runs and nothing is mounted under it`],
    'empty-root': ['the empty private root of a Sandbox whose run folder is gone', `${fix} removes it`],
    'backup-staging': ['a snapshot a `backup create` of Store shop staged and did not remove', `${fix} removes it unless a \`backup create\` of that Store is running`],
    'image-tmp': ['a temporary directory an interrupted image unpack left', `${fix} removes it unless an unpack of that image is running; that image's next unpack removes it too`],
    'image-part': ['a partly received Sandbox image, which the next load of that image resumes', `${fix} removes it once it has not changed for an hour`],
    'init-copy': more.fixable === false
      ? ['a folder copy of a `project init`; no line of log/uncertain.jsonl names it with a deadline, so it may belong to an Init that is still running', 'report-only: `layerfs doctor fix` refuses it; once no `project init` into that machine runs, remove the folder there by hand']
      : ['the folder copy of a `project init` of shop/site whose answer was lost', `${fix} removes it an hour after that Init's deadline`],
  }[kind]
  const { name: _n, ...detail } = more
  return {
    severity: 'warning', entity: { kind: 'machine', name: machine },
    message: `${path} on machine ${machine} is ${words[0]} (${bytes == null ? 'size not measured' : `${bytes} bytes`}, last changed ${age} s ago)`,
    fix: words[1],
    leftover: { machine, kind, path, bytes, age, id, fixable: true, ...detail },
  }
}

/**
 * The stand-in's world for these rows, written once per run (after the Files
 * lib's own `setup`): three running machines of the three scopes, a stopped
 * one, three Sandboxes (daemon running with usage, daemon dead, not observed),
 * and a Doctor report with one leftover of every kind. A real build needs
 * none of this.
 */
export function setupObserve() {
  setup()
  if (!standin) return
  const now = Date.now()
  const run = join(home, 'machine', 'native', 'run')
  // a leftover the native machine's Files tab can open: a run folder no record names
  const gone = join(run, 'lfs-0a1b2c3d-gone')
  mkdirSync(join(gone, 'tmp'), { recursive: true })
  if (!existsSync(join(gone, 'owner'))) writeFileSync(join(gone, 'owner'), 'layerfs\n')
  writeFileSync(join(gone, 'tmp', 'left.txt'), 'left by a Sandbox that was closed while its machine was away\n')
  // and one in the docker machine's fixture tree
  const dockerRoot = join(standin, 'files', `machine-${O.docker.name}`)
  mkdirSync(join(dockerRoot, 'layerfs/data/incoming/init-00112233aabbccdd/site'), { recursive: true })
  writeFileSync(join(dockerRoot, 'layerfs/data/incoming/init-00112233aabbccdd/site/index.html'), '<h1>half copied</h1>\n')
  // and the VM machine's own small tree, so its Files tab has the staged snapshot to open
  const vmRoot = join(standin, 'files', `machine-${O.volume.name}`)
  mkdirSync(join(vmRoot, 'layerfs/data/backup/shop'), { recursive: true })
  mkdirSync(join(vmRoot, 'layerfs/data/store'), { recursive: true })
  writeFileSync(join(vmRoot, 'layerfs/data/backup/shop/snapshot-20261116.sqlite'), 'SQLite format 3\0 staged and not removed\n')
  const declared = readJson(join(standin, 'files.json'))
  declared.machine ??= {}
  declared.machine[O.volume.name] = { root: vmRoot, whole: 'machine', roots: [{ role: 'data', path: '/layerfs/data' }, { role: 'stores', path: '/layerfs/data/store' }] }
  writeFileSync(join(standin, 'files.json'), JSON.stringify(declared, null, 2))
  const pidOf = (name) => { try { return JSON.parse(readFileSync(join(home, 'sandbox', name, 'record.json'), 'utf8')).daemon?.pid ?? null } catch { return null } }
  const config = {
    machines: {
      native: { sandboxes: [O.dead.name] },
      [O.docker.name]: { state: 'running', tool_version: '29.5.2', free_disk: 39_000_000_000, sandboxes: [O.up.name] },
      [O.volume.name]: { add: true, platform: 'lima', backend: 'namespaces', state: 'running', cpus: 4, memory: 8 * GIB, disk: 50 * GIB, free_disk: 30 * GIB, tool_version: '1.2.1' },
      [O.stopped.name]: { add: true, platform: 'lima', backend: 'namespaces', state: 'stopped', cpus: 2, memory: 4 * GIB, disk: 20 * GIB, sandboxes: [O.unseen.name] },
    },
    stats: {
      native: {
        platform: 'native', worker: null,
        resources: { cpus: 14, memory_total: 36 * GIB, memory_used: 29 * GIB, disk_total: 926 * GIB, disk_used: 598 * GIB, disk_free: 328 * GIB, scope: 'host' },
        data_disk: { path: home, fs: 'apfs', scope: 'host_fs', volume: null, inodes_free: 3_446_842_200 },
        stores: [{ name: 'm179f', bytes: 217_088, allocated: 217_088 }], sandboxes: { recorded: 1, live: 0 }, complete: true,
      },
      [O.docker.name]: {
        platform: 'docker', worker: { version: '2.0.0', pid: 41, started_at: now - 3 * 3600_000, protocol: 7, bundle: '8de908dfcb63' },
        resources: { cpus: 8, memory_total: 8 * GIB, memory_used: 3 * GIB, disk_total: 58 * GIB, disk_used: 19 * GIB, disk_free: 36 * GIB, scope: 'engine_host' },
        data_disk: { path: '/layerfs/data', fs: 'ext4', scope: 'vm_disk', volume: 'layerfs-1a2b3c4d-docker-data', inodes_free: 3_900_000 },
        stores: [], sandboxes: { recorded: 1, live: 1 }, complete: true,
      },
      [O.volume.name]: {
        platform: 'lima', worker: { version: '2.0.0', pid: 612, started_at: now - 26 * 3600_000, protocol: 7, bundle: '8de908dfcb63' },
        resources: { cpus: 4, memory_total: 8 * GIB, memory_used: 1 * GIB, disk_total: 49 * GIB, disk_used: 7 * GIB, disk_free: 40 * GIB, scope: 'vm' },
        // a machine made before the `layerfs-` prefix keeps the name it was given
        data_disk: { path: '/layerfs/data', fs: 'ext4', scope: 'volume', volume: 'lfs-9f8e7d6c-m179-vm-data', inodes_free: 3_200_000 },
        stores: [], sandboxes: { recorded: 0, live: 0 }, complete: true,
      },
    },
    sandboxes: {
      // as a namespaces machine of the build at 73d824ec64 answers: CPU time only, and why the rest is null
      [O.up.name]: { machine: O.docker.name, live: true, daemon: { pid: 4242, started_at: now - 2 * 3600_000 }, usage: { cpu_usec: 184_000_000, memory_current: null, memory_peak: null, pids: null }, usage_reason: 'no_controller' },
      [O.dead.name]: { live: false, daemon: { pid: pidOf(O.dead.name) ?? 4243, started_at: null }, usage: null, usage_reason: 'host_process' },
      [O.unseen.name]: { machine: O.stopped.name, live: null, live_reason: 'machine_stopped', daemon: null, usage: null, usage_reason: 'not_observed' },
    },
    doctor: {
      findings: [
        finding('native', 'run-folder', gone, 61, 7200),
        finding(O.docker.name, 'init-copy', '/layerfs/data/incoming/init-00112233aabbccdd', null, 95, { name: '00112233aabbccdd', fixable: false }),
        finding(O.docker.name, 'init-copy', '/layerfs/data/incoming/init-ffeeddccbbaa0099', 3_000_000, 400, { name: 'ffeeddccbbaa0099', not_before: now + 3600_000 }),
        finding(O.docker.name, 'empty-root', '/layerfs/data/machine/native/root/layerfs-0a1b2c3d-shop', 0, 86_400),
        finding(O.docker.name, 'image-tmp', '/layerfs/data/images/.tmp-sha256-1f2e3d', 734_003_200, 5400),
        finding(O.docker.name, 'image-part', '/layerfs/data/images/sha256-77aa.part', 1_288_490_188, 12_000),
        finding(O.volume.name, 'backup-staging', '/layerfs/data/backup/shop/snapshot-20261116.sqlite', 4_194_304, 1900, { name: 'shop/snapshot-20261116.sqlite' }),
      ],
      leftovers: [
        { machine: 'native', complete: true, image_locks: 0, unmount_markers: 1 },
        { machine: O.docker.name, complete: false, image_locks: 3, unmount_markers: 0 },
        { machine: O.volume.name, complete: true, image_locks: 0, unmount_markers: 0 },
      ],
    },
  }
  writeFileSync(observeFile(), JSON.stringify(config, null, 2))
}

// ---------------------------------------------------------------- hang, refuse, change: the stand-in's files, else the hook

const controlFile = () => join(standin, 'control.json')
function control(change) {
  const now = readJson(controlFile())
  now.refuse ??= {}; now.delay_ms ??= {}
  change(now)
  writeFileSync(controlFile(), JSON.stringify(now, null, 2))
}
function hook(action, machine, ...args) {
  if (!cfg.hook) throw new NotRun(`no INSPECT_STANDIN_DIR and no INSPECT_HOOK: nothing here can \`${action}\` machine ${machine}`)
  const r = spawnSync(cfg.hook, [action, 'machine', machine, ...args.map(String)], { encoding: 'utf8', timeout: 100000 })
  if (r.status === 3) throw new NotRun(`INSPECT_HOOK cannot \`${action}\` here: ${(r.stdout || r.stderr || '').trim() || 'no reason given'}`)
  if (r.status !== 0) throw new Error(`INSPECT_HOOK ${action} machine ${machine} failed (exit ${r.status}): ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`)
}
export const statsDriver = {
  hang(machine, ms) { if (!standin) return hook('stats-hang', machine, ms); control((c) => { c.delay_ms[`stats:${machine}`] = ms }) },
  unhang(machine) { if (!standin) return hook('stats-unhang', machine); control((c) => { delete c.delay_ms[`stats:${machine}`] }) },
  refuse(machine, code, message) { if (!standin) return hook('stats-refuse', machine, code, message); control((c) => { c.refuse[`stats:${machine}`] = { code, message } }) },
  unrefuse(machine) { if (!standin) return hook('stats-unrefuse', machine); control((c) => { delete c.refuse[`stats:${machine}`] }) },
  /** Change what the stand-in answers (observe.json). A real build answers what it observes: NOT_RUN. */
  declare(change) {
    if (!standin) throw new NotRun('a real build answers what it observes: this part needs the stand-in')
    const now = readJson(observeFile())
    change(now)
    writeFileSync(observeFile(), JSON.stringify(now, null, 2))
  },
}

// ---------------------------------------------------------------- what the CLI answers (the rows compare the page with it)

/** The CLI's answer to a read, run directly on the private home (never through the host: no call-log line of the host's). */
export function cli(...args) {
  const env = { ...process.env, LAYERFS_HOME: home }
  if (process.env.DSH_LAYERFS_BUNDLE) env.LAYERFS_BUNDLE = process.env.DSH_LAYERFS_BUNDLE
  if (standin) env.LFS_INSPECT_DIR = standin
  const r = spawnSync(cfg.cli, args, { env, encoding: 'utf8', timeout: 30000, maxBuffer: 1 << 26 })
  // `layerfs doctor` exits 1 when it has findings; its report is on stdout either way
  try { return JSON.parse(r.stdout) } catch { throw new Error(`${args.join(' ')}: exit ${r.status}: ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`) }
}
export const version = () => { try { return execFileSync(cfg.cli, ['--version'], { encoding: 'utf8', timeout: 10000 }).trim() } catch { return null } }

/** What the server says the pinned CLI can do. */
export async function features(page) {
  const view = await probe(page, 'GET', '/api/machines')
  if (!view.ok) throw new Error(`GET /api/machines: ${view.status} ${view.code} ${view.message}`)
  return { ...(view.body.features ?? {}), view: view.body }
}

// ---------------------------------------------------------------- words, as the page writes them

/** "12 GiB" as machines/model.ts `gib` writes a size. */
export const gibText = (bytes) => { const g = bytes / GIB; return g >= 1 ? `${Number.isInteger(g) ? g : g.toFixed(1)} GiB` : `${Math.round(bytes / 2 ** 20)} MiB` }
export const SCOPE_WORDS = {
  volume: 'this machine\'s own disk',
  vm_disk: 'the Docker VM\'s disk, shared with every image and volume',
  host_fs: 'the host\'s filesystem, shared with everything else on it',
}

// ---------------------------------------------------------------- pages

const bar = (page) => page.locator('header[aria-label="Center navigation"]')
/** The Health page (the Doctor page), read anew. */
export async function openHealth(page) {
  await bar(page).getByRole('button', { name: /^Health\b/ }).first().click()
  await page.getByRole('region', { name: 'Health' }).first().waitFor({ timeout: 20000 })
}
/** The Machines board: the Overview's Machines tab, every machine's card (machines/Board.tsx). */
export async function openBoard(page) {
  const root = bar(page).getByRole('navigation', { name: 'Location' }).getByRole('button', { name: 'Center', exact: true })
  if (await root.count()) await root.first().click()
  await editor(page).getByRole('tab', { name: /^Machines\b/ }).first().click()
  await editor(page).locator('[data-machine]').first().waitFor()
}

/** What the open page shows of a machine's observed values (machine page, Details card and board cards). */
export const observed = (page) => page.evaluate(() => {
  const root = [...document.querySelectorAll('[data-storage-page]')].find((e) => e.offsetParent)
  if (!root) return null
  const text = (sel, from = root) => from.querySelector(sel)?.textContent ?? null
  const attr = (sel, name, from = root) => from.querySelector(sel)?.getAttribute(name) ?? null
  const fact = (el) => el?.closest('div')?.textContent ?? null
  return {
    disks: [...root.querySelectorAll('[data-disk]')].map((el) => ({
      machine: el.closest('[data-machine]')?.getAttribute('data-machine') ?? null, state: el.getAttribute('data-disk'), scope: el.getAttribute('data-disk-scope'),
      text: el.textContent, scopeWords: text('[data-disk-scope-words]', el), stale: attr('[data-stats-stale]', 'data-stats-stale', el), staleText: text('[data-stats-stale]', el),
    })),
    resources: text('[data-resources]'), resourcesScope: attr('[data-resources]', 'data-resources-scope'),
    worker: text('[data-worker-line]'),
    card: {
      cpus: text('[data-stats-cpus]'), cpusFact: fact(root.querySelector('[data-stats-cpus]')),
      memory: text('[data-stats-memory]'), disk: text('[data-stats-disk]'), diskScope: attr('[data-stats-disk-scope]', 'data-stats-disk-scope'), diskSub: text('[data-stats-disk-scope]'),
      worker: text('[data-stats-worker]'), workerNone: attr('[data-stats-worker]', 'data-stats-worker') === 'none', at: text('[data-stats-at]'),
      stale: [...root.querySelectorAll('[data-stats-stale]')].map((el) => el.getAttribute('data-stats-stale')),
      notObserved: [...root.querySelectorAll('[data-not-observed], [data-stats="not-observed"]')].map((el) => el.textContent),
      live: text('[data-stats-live]'), stores: text('[data-stats-stores]'),
      hereNow: text('[data-here-now]'), hereDown: text('[data-here-down]'), hereUnknown: text('[data-here-unknown]'),
    },
    sandboxRows: [...root.querySelectorAll('[data-sandbox-row]')].map((el) => ({ name: el.getAttribute('data-sandbox-row'), live: el.getAttribute('data-live'), text: el.textContent, tone: el.getAttribute('data-tone') })),
    spinners: root.querySelectorAll('[aria-busy=true]').length,
    // `text` is what shows; `allText` also has what a closed Details card holds
    text: root.innerText, allText: root.textContent,
  }
})
/** Wait until `test(observed)` holds; the last value seen is returned either way. */
export async function waitObserved(page, test, { timeout = 15000, every = 150 } = {}) {
  const until = Date.now() + timeout
  let last = null
  for (;;) {
    last = await observed(page)
    if (last && test(last)) return { ok: true, state: last }
    if (Date.now() > until) return { ok: false, state: last }
    await sleep(every)
  }
}
/** The disk line of the machine page (the one not inside a board card), or of `machine`'s board card. */
export const diskOf = (state, machine = null) => state?.disks.find((d) => d.machine === machine) ?? null

/** The `machine stats` processes among `since` (spawnsSince), by machine. */
export function statsSpawns(since) {
  const by = {}
  for (const s of since.inspect) if (s.argv[0] === 'machine' && s.argv[1] === 'stats') { const name = s.argv.at(-1); (by[name] ??= []).push(s.at) }
  return by
}

// `node test/e2e-inspect-observe-lib.mjs setup`: write the stand-in's world before the side server starts.
if (process.argv[1] && process.argv[1].endsWith('e2e-inspect-observe-lib.mjs') && process.argv[2] === 'setup') { setupObserve(); process.exit(0) }
