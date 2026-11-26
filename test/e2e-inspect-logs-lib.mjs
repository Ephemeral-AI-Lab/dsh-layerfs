// Shared parts of test/e2e-inspect-logs*.mjs: the Worker log and Daemon log
// tabs (layerfs-project#178 "dsh-layerfs UI" scenario matrix) checked in a
// browser against a private side server.
//
// The SAME scripts run against the stand-in CLI and against a real build; only
// the environment differs:
//
//   DSH_LAYERFS_DEV_DIR    the side server's dev dir (url.txt, layerfs-home/, state/)   required
//   DSH_LAYERFS_HOME       the LayerFS home that server uses, when it is not <dev dir>/layerfs-home
//   DSH_LAYERFS_CLI        the CLI that server pins                                      required
//   INSPECT_MACHINE        the machine whose page is opened (default `native`)
//   INSPECT_MACHINE_TITLE  its title in "Jump to" (default: its name)
//   INSPECT_SANDBOX        a running Sandbox on that machine
//   INSPECT_TARGET         `machine` or `sandbox`: the log the one-log rows use
//                          (default: the worker log when the machine offers one, else the daemon log)
//   INSPECT_STANDIN_DIR    the stand-in's fixture folder ($LFS_INSPECT_DIR of
//                          test/fixtures/cli-inspect-logs.mjs). Set: the scripts write log lines,
//                          rotate, hang and refuse by editing that folder, and every result reads
//                          "against the stand-in CLI". It is never a real-machine pass.
//   INSPECT_HOOK           for a real build: an executable that does the same on the real machine,
//                          called as  <hook> <action> <machine|sandbox> <name> [args…]:
//                            fill <n> <tag>           replace the log with n lines "<time> INFO <tag> <6-digit seq> served" (seq 0…n-1)
//                            append <from> <n> <tag>  append n such lines, seq from…from+n-1
//                            rotate                   rotate the log as LayerFS does (old file to .1, new empty file)
//                            truncate                 make the log empty (no rotated file)
//                            hang <ms> / unhang       make the log call for this target hang / answer again
//                            refuse <code> <message> / unrefuse   make it refuse / answer again
//                            hang-get <ms> / unhang-get           make `sandbox get <name>` hang / answer again
//                          exit 0: done; exit 3: this machine cannot (stdout says why): the row is NOT_RUN.
//                          Without a stand-in dir and without a hook, a row that needs an action is NOT_RUN.
//   INSPECT_SPAWN_LOG      a file with one line per CLI process: the stand-in's spawns.log
//                          (`<epoch ms> <argv JSON>`, the default with a stand-in dir) or
//                          test/fixtures/cli-count.sh's ($LFS_COUNT_FILE: `<pid> <epoch ns> <args>`).
//                          Without one, rows that count processes are NOT_RUN.
//   INSPECT_BACKEND        words for the result line (default: "the stand-in CLI", or the CLI's --version)
//
// Every row also fails on: a console or page error; a page request that
// answered 4xx/5xx (a log read the page itself dropped, `Cancelled`, is not
// one); and a new line in <dev dir>/layerfs-home/trace/calls.jsonl or a new
// record in <dev dir>/state/layerfs/trace/outputs/ that comes from a log,
// files or machine stats read. Other reads of the page (store list, machine status, sandbox
// get) do add lines there; they are told apart by argv and tag.
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDev } from '../tools/e2e-lib.mjs'
import { devUrl } from '../tools/ui.mjs'

export const argv = process.argv.slice(2)
export const opt = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback }
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const devDir = process.env.DSH_LAYERFS_DEV_DIR
if (!devDir || !process.env.DSH_LAYERFS_CLI) { console.error('e2e-inspect-logs: set DSH_LAYERFS_DEV_DIR and DSH_LAYERFS_CLI (the side server\'s dev dir and pinned CLI)'); process.exit(2) }
const machine = process.env.INSPECT_MACHINE || 'native'
const standin = process.env.INSPECT_STANDIN_DIR || null
export const cfg = {
  devDir,
  cli: process.env.DSH_LAYERFS_CLI,
  machine,
  machineTitle: process.env.INSPECT_MACHINE_TITLE || machine,
  sandbox: process.env.INSPECT_SANDBOX || null,
  standin,
  hook: process.env.INSPECT_HOOK || null,
  spawnLog: process.env.INSPECT_SPAWN_LOG || (standin ? join(standin, 'spawns.log') : null),
  shots: opt('--shots', join(devDir, 'shots')),
}
mkdirSync(cfg.shots, { recursive: true })

/** What the results are a result against. */
export const backend = (() => {
  if (process.env.INSPECT_BACKEND) return process.env.INSPECT_BACKEND
  if (standin) return 'the stand-in CLI'
  try { return `build ${execFileSync(cfg.cli, ['--version'], { encoding: 'utf8', timeout: 10000 }).trim()}` } catch { return `the CLI at ${cfg.cli}` }
})()

/** Thrown inside a row: it cannot run here, with the reason. */
export class NotRun extends Error {}

// ---------------------------------------------------------------- the driver: write, rotate, hang, refuse

/** One marker line: the scripts find their own lines by `<tag> <6-digit seq>`. */
export const markerLine = (tag, seq) => `${new Date(Date.UTC(2026, 10, 16, 10, 0, 0) + seq * 1000).toISOString()} INFO ${tag} ${String(seq).padStart(6, '0')} served`
/** The seqs of `tag`'s lines among `texts`, in order shown. */
export const seqsOf = (texts, tag) => texts.map((t) => new RegExp(`\\b${tag} (\\d{6})\\b`).exec(t)).filter(Boolean).map((m) => Number(m[1]))
/** A tag no earlier run used. */
export const newTag = (row) => `e2e${row.toLowerCase()}${Date.now().toString(36)}`

const logFile = (kind, name, rotated = false) => join(standin, kind, `${name}${rotated ? '.1' : ''}.log`)
const controlFile = () => join(standin, 'control.json')
const readControl = () => { try { return JSON.parse(readFileSync(controlFile(), 'utf8')) } catch { return {} } }
function control(change) {
  const now = readControl()
  now.refuse ??= {}; now.delay_ms ??= {}
  change(now)
  writeFileSync(controlFile(), JSON.stringify(now, null, 2))
}
const lines = (tag, from, n) => Array.from({ length: n }, (_, i) => `${markerLine(tag, from + i)}\n`).join('')

function hook(action, kind, name, ...args) {
  if (!cfg.hook) throw new NotRun(`no INSPECT_STANDIN_DIR and no INSPECT_HOOK: nothing here can \`${action}\` the ${kind} log of ${name}`)
  const r = spawnSync(cfg.hook, [action, kind, name, ...args.map(String)], { encoding: 'utf8', timeout: 100000 })
  if (r.status === 3) throw new NotRun(`INSPECT_HOOK cannot \`${action}\` here: ${(r.stdout || r.stderr || '').trim() || 'no reason given'}`)
  if (r.status !== 0) throw new Error(`INSPECT_HOOK ${action} ${kind} ${name} failed (exit ${r.status}): ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`)
}

/** Acts on the log of `kind` (`machine` | `sandbox`) `name`: on the stand-in's fixture folder, else through INSPECT_HOOK. */
export const driver = {
  fill(kind, name, n, tag) {
    if (!standin) return hook('fill', kind, name, n, tag)
    mkdirSync(join(standin, kind), { recursive: true })
    rmSync(logFile(kind, name, true), { force: true })
    rmSync(logFile(kind, name), { force: true })
    writeFileSync(logFile(kind, name), lines(tag, 0, n))
  },
  append(kind, name, from, n, tag) {
    if (!standin) return hook('append', kind, name, from, n, tag)
    appendFileSync(logFile(kind, name), lines(tag, from, n))
  },
  rotate(kind, name) {
    if (!standin) return hook('rotate', kind, name)
    renameSync(logFile(kind, name), logFile(kind, name, true))
    writeFileSync(logFile(kind, name), '')
  },
  truncate(kind, name) {
    if (!standin) return hook('truncate', kind, name)
    mkdirSync(join(standin, kind), { recursive: true })
    rmSync(logFile(kind, name, true), { force: true })
    rmSync(logFile(kind, name), { force: true })
    writeFileSync(logFile(kind, name), '')
  },
  hang(kind, name, ms) { if (!standin) return hook('hang', kind, name, ms); control((c) => { c.delay_ms[`${kind}:${name}`] = ms }) },
  unhang(kind, name) { if (!standin) return hook('unhang', kind, name); control((c) => { delete c.delay_ms[`${kind}:${name}`] }) },
  refuse(kind, name, code, message) { if (!standin) return hook('refuse', kind, name, code, message); control((c) => { c.refuse[`${kind}:${name}`] = { code, message } }) },
  unrefuse(kind, name) { if (!standin) return hook('unrefuse', kind, name); control((c) => { delete c.refuse[`${kind}:${name}`] }) },
  hangGet(name, ms) { if (!standin) return hook('hang-get', 'sandbox', name, ms); control((c) => { c.delay_ms[`call:sandbox.get:${name}`] = ms }) },
  unhangGet(name) { if (!standin) return hook('unhang-get', 'sandbox', name); control((c) => { delete c.delay_ms[`call:sandbox.get:${name}`] }) },
  /** Undo every hang and refusal this run may have left (the stand-in only; a hook undoes its own in `unhang`/`unrefuse`). */
  reset() { if (standin) writeFileSync(controlFile(), '{}') },
}

// ---------------------------------------------------------------- CLI processes

/** Every CLI process recorded so far: `{ at (epoch ms), argv }`; null without a spawn log. */
export function spawns() {
  if (!cfg.spawnLog) return null
  let text = ''
  try { text = readFileSync(cfg.spawnLog, 'utf8') } catch { return [] }
  const out = []
  for (const line of text.split('\n')) {
    if (!line) continue
    const sp = line.indexOf(' ')
    const rest = line.slice(sp + 1)
    if (rest.startsWith('[')) { try { out.push({ at: Number(line.slice(0, sp)), argv: JSON.parse(rest) }) } catch { /* a torn line */ } } else {
      // cli-count.sh: <pid> <epoch ns> <args joined by spaces>
      const [ns, ...words] = rest.split(' ')
      out.push({ at: Number(ns.slice(0, -6)), argv: words })
    }
  }
  return out
}
/** A monitoring read: `logs machine|sandbox`, `sandbox files`, `machine files`, `machine stats`. */
export const isInspect = (words) => (words[0] === 'logs' && (words[1] === 'machine' || words[1] === 'sandbox')) || ((words[0] === 'sandbox' || words[0] === 'machine') && words[1] === 'files') || (words[0] === 'machine' && words[1] === 'stats')
/** The processes started after `mark` (a count from `spawnMark`), split into monitoring reads and the rest by `family call`. */
export function spawnsSince(mark) {
  const all = spawns()
  if (!all) throw new NotRun('no spawn log (INSPECT_SPAWN_LOG, or the stand-in\'s spawns.log): CLI processes cannot be counted')
  const added = all.slice(mark)
  const others = {}
  for (const s of added) if (!isInspect(s.argv) && s.argv[0] !== 'help' && s.argv[0] !== '--version') others[`${s.argv[0]} ${s.argv[1] ?? ''}`.trim()] = (others[`${s.argv[0]} ${s.argv[1] ?? ''}`.trim()] ?? 0) + 1
  return { inspect: added.filter((s) => isInspect(s.argv)), others, all: added }
}
export const spawnMark = () => (spawns() ?? []).length

// ---------------------------------------------------------------- the call log and the saved outputs

const callsFile = join(process.env.DSH_LAYERFS_HOME || join(devDir, 'layerfs-home'), 'trace', 'calls.jsonl')
const outputsDir = join(devDir, 'state', 'layerfs', 'trace', 'outputs')
const callLines = () => { try { return readFileSync(callsFile, 'utf8').split('\n').filter(Boolean) } catch { return [] } }
const outputNames = () => { try { return readdirSync(outputsDir) } catch { return [] } }

export function traceMark() { return { calls: callLines().length, outputs: new Set(outputNames()) } }
/** What polling must never add since `mark`: call-log lines and saved outputs of a log or files read. Also the tally of other new lines. */
export function traceGrowth(mark) {
  const added = callLines().slice(mark.calls).map((l) => { try { return JSON.parse(l) } catch { return { argv: ['?'], raw: l } } })
  const inspectTags = new Set(), bad = [], others = {}
  for (const line of added) {
    const words = Array.isArray(line.argv) ? line.argv : []
    if (isInspect(words)) { bad.push(`calls.jsonl: ${JSON.stringify(words)}`); if (line.tag) inspectTags.add(line.tag) } else others[`${words[0]} ${words[1] ?? ''}`.trim()] = (others[`${words[0]} ${words[1] ?? ''}`.trim()] ?? 0) + 1
  }
  let newOutputs = 0
  for (const name of outputNames()) {
    if (mark.outputs.has(name)) continue
    newOutputs++
    let record = null
    try { record = JSON.parse(readFileSync(join(outputsDir, name), 'utf8')) } catch { continue }
    const out = typeof record?.stdout === 'string' ? record.stdout : ''
    // a log answer's shape, or a files answer's (a folder page, a file window), whatever its tag
    if (inspectTags.has(record?.tag) || (/"has_more"\s*:/.test(out) && /"lines"\s*:\s*\[/.test(out)) || (/"has_more"\s*:/.test(out) && /"kind"\s*:\s*"folder"/.test(out) && /"entries"\s*:\s*\[/.test(out)) || (/"kind"\s*:\s*"file"/.test(out) && /"binary"\s*:/.test(out) && /"offset"\s*:/.test(out)) || (/"data_disk"\s*:/.test(out) && /"resources"\s*:/.test(out) && /"observed_at"\s*:/.test(out))) bad.push(`trace/outputs/${name}: a log, files or stats read's output (tag ${record?.tag})`)
  }
  return { bad, others, newLines: added.length, newOutputs }
}

// ---------------------------------------------------------------- the browser

/** Record every host request of `page` (after `window.__dshLayerfs` is there); `raw` keeps the unrecorded calls for a script's own probes. */
export async function track(page) {
  await page.waitForFunction(() => window.__dshLayerfs, null, { timeout: 30000 })
  await page.evaluate(() => {
    if (window.__inspect) return
    const api = window.__dshLayerfs
    const call = api.call, op = api.op
    const rec = window.__inspect = { calls: [], raw: { call, op } }
    const watch = (entry, run) => {
      rec.calls.push(entry)
      return run().then((value) => { entry.status = 'ok'; return value }, (error) => {
        entry.status = typeof error?.status === 'number' ? error.status : 0
        entry.code = error?.code ?? null
        entry.message = String(error?.message ?? error).slice(0, 200)
        throw error
      })
    }
    api.call = (method, path, body) => watch({ kind: 'call', what: `${method} ${path}` }, () => call(method, path, body))
    api.op = (name, args) => watch({ kind: 'op', what: name === 'http' ? `http ${args?.method} ${args?.path}` : name }, () => op(name, args))
  })
}
/** The page's requests that failed, without the log and files reads it dropped itself (`Cancelled`). */
export async function failedRequests(page) {
  const calls = await page.evaluate(() => window.__inspect?.calls ?? [])
  return calls.filter((c) => c.status !== undefined && c.status !== 'ok' && !(c.code === 'Cancelled' && /\/(log|files|stats)\b/.test(c.what)))
    .map((c) => `${c.what} -> ${c.status} ${c.code ?? ''} ${c.message ?? ''}`.trim())
}
export const requestsTo = async (page, pattern) => (await page.evaluate(() => window.__inspect?.calls ?? [])).filter((c) => pattern.test(c.what))

/** One unrecorded host request from the page: `{ ok, status, body | code, message, ms }` (never throws). */
export const probe = (page, method, path, body) => page.evaluate(async ({ method, path, body }) => {
  const t0 = performance.now()
  try { return { ok: true, status: 200, body: await window.__inspect.raw.call(method, path, body), ms: performance.now() - t0 } } catch (error) {
    return { ok: false, status: typeof error?.status === 'number' ? error.status : 0, code: error?.code ?? null, message: String(error?.message ?? error), ms: performance.now() - t0 }
  }
}, { method, path, body })
export const probeOp = (page, name, args) => page.evaluate(({ name, args }) => window.__inspect.raw.op(name, args).then((value) => ({ ok: true, value }), (error) => ({ ok: false, code: error?.code ?? null, message: String(error?.message ?? error) })), { name, args })

export async function open() {
  const { browser, page, logs } = await openDev({ headless: !argv.includes('--headed') })
  page.setDefaultTimeout(15000)
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {})
  await track(page)
  await center(page)
  return { browser, page, logs }
}
/** A second page on the same server, in a browser context of its own (its own console log). */
export async function second(browser, url) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
  const page = await context.newPage()
  // the Sandbox page's Workspaces tab opens on its Terminals view (Grid is the default): these rows drive terminals
  await page.addInitScript(() => { try { localStorage.setItem('dsh-layerfs:debug', '1'); localStorage.setItem('dsh-layerfs:sandbox-workspaces-view', 'terminals') } catch {} })
  const logs = []
  page.on('console', (m) => { if (m.type() === 'error') logs.push(`[error] ${m.text()}`) })
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
  page.setDefaultTimeout(15000)
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.locator('[data-composer-input=true], [role=treeitem]').first().waitFor({ timeout: 30000 })
  await track(page)
  await center(page)
  return { page, logs }
}

/**
 * A page in a browser context of its own: another client of the same host.
 * The page reaches the host over HTTP/1.1, so one browser context has about
 * four requests in flight at most (Chrome's six connections per origin, less
 * the page's streams): a script that needs more host reads at once than that
 * (to fill the inspect lane) spreads them over such pages.
 */
export async function outside(browser) {
  const context = await browser.newContext()
  const page = await context.newPage()
  // the Sandbox page's Workspaces tab opens on its Terminals view (Grid is the default): these rows drive terminals
  await page.addInitScript(() => { try { localStorage.setItem('dsh-layerfs:debug', '1'); localStorage.setItem('dsh-layerfs:sandbox-workspaces-view', 'terminals') } catch {} })
  await page.goto(devUrl(), { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__dshLayerfs, null, { timeout: 30000 })
  return page
}

const bar = (page) => page.locator('header[aria-label="Center navigation"]')
export const editor = (page) => page.locator('[data-storage-page]:visible').first()
export async function center(page) {
  if (!(await bar(page).isVisible().catch(() => false))) await page.getByRole('navigation', { name: 'Global panels' }).getByRole('button', { name: 'LayerFS', exact: true }).first().click()
  await bar(page).waitFor()
}
const exact = (text) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
export async function jump(page, text) {
  await bar(page).getByRole('button', { name: /^Jump to/ }).click()
  await page.getByRole('combobox', { name: 'Jump to' }).fill(text)
  await page.getByRole('listbox', { name: 'Jump to' }).getByRole('option').filter({ has: page.locator('span', { hasText: exact(text) }) }).first().click()
  await editor(page).getByRole('heading', { level: 1 }).first().waitFor()
}

export const pane = (page) => editor(page).locator('[data-log]')
/** The page's own tabs (the Files pane's view switch is a tab list of its own, shown where a target has two views: not counted). */
export const tabs = (page) => editor(page).locator('[role=tab]:not([data-files] [role=tab])').allTextContents()
/** Whether the open page offers a tab named `name`. */
export const hasTab = async (page, name) => (await editor(page).getByRole('tab', { name, exact: true }).count()) > 0

/** The two logs: where each is opened and under which tab. */
export const targets = {
  machine: { kind: 'machine', name: cfg.machine, title: cfg.machineTitle, tab: 'Worker log', other: 'Overview', link: 'Open worker log' },
  sandbox: { kind: 'sandbox', name: cfg.sandbox, title: cfg.sandbox, tab: 'Daemon log', other: 'Workspaces', link: 'Open daemon log' },
}
/** What the server says about the logs: the CLI's features and the machine's `supports.log`. */
export async function offered(page) {
  const view = await probe(page, 'GET', '/api/machines')
  if (!view.ok) throw new Error(`GET /api/machines: ${view.status} ${view.code} ${view.message}`)
  const m = (view.body.machines ?? []).find((x) => x.name === cfg.machine)
  const inspect = view.body.features?.inspect ?? {}
  return { inspect, machine: m ?? null, machineLog: inspect.machineLog === true && m?.supports?.log === true, sandboxLog: inspect.sandboxLog === true }
}
/** The log the one-log rows use. */
export async function primary(page) {
  const has = await offered(page)
  const want = process.env.INSPECT_TARGET
  if (want === 'machine' || (!want && has.machineLog)) { if (!has.machineLog) throw new NotRun(`machine ${cfg.machine} offers no worker log (supports.log ${has.machine?.supports?.log}, CLI call ${has.inspect.machineLog})`); return targets.machine }
  if (!cfg.sandbox) throw new NotRun('INSPECT_SANDBOX is not set and the machine offers no worker log')
  if (!has.sandboxLog) throw new NotRun('the pinned CLI has no logs.sandbox')
  return targets.sandbox
}
export function needSandbox() { if (!cfg.sandbox) throw new NotRun('INSPECT_SANDBOX is not set') }

/** Open `target`'s page on its tab without a log pane (so a script can prepare the log first). */
export async function openQuiet(page, target) {
  await jump(page, target.title)
  // the page opens on its last tab, which may be the log
  const other = editor(page).getByRole('tab', { name: target.other, exact: true })
  if (await other.count()) await other.click()
  await pane(page).waitFor({ state: 'detached' })
}
/** Open `target`'s log tab and wait for its first answer. */
export async function openLog(page, target, { timeout = 20000 } = {}) {
  await openQuiet(page, target)
  await showLog(page, target, { timeout })
}
export async function showLog(page, target, { timeout = 20000 } = {}) {
  await editor(page).getByRole('tab', { name: target.tab, exact: true }).click()
  await pane(page).waitFor()
  await page.waitForFunction(() => { const el = [...document.querySelectorAll('[data-storage-page] [data-log]')].find((e) => e.offsetParent); return el && el.getAttribute('data-log-state') !== 'reading' }, null, { timeout })
}
/** The pane as data: state, line count, status words, and the text of every row (`---` for the "log replaced" divider). */
export const paneState = (page) => page.evaluate(() => {
  const el = [...document.querySelectorAll('[data-storage-page] [data-log]')].find((e) => e.offsetParent)
  if (!el) return null
  const scroll = el.querySelector('[data-log-scroll]')
  return {
    state: el.getAttribute('data-log-state'), lines: Number(el.getAttribute('data-log-lines')),
    status: el.querySelector('[data-log-status]')?.textContent ?? '',
    stale: el.querySelector('[data-log-stale]')?.getAttribute('data-log-stale') ?? null,
    staleText: el.querySelector('[data-log-stale]')?.textContent ?? '',
    rows: [...scroll.querySelectorAll('[data-row]')].map((r) => (r.hasAttribute('data-log-replaced') ? '---' : r.textContent)),
    earlier: !!scroll.querySelector('[data-log-earlier]'), start: !!scroll.querySelector('[data-log-start]'), cut: !!scroll.querySelector('[data-log-cut]'),
    jump: el.querySelector('[data-log-jump]')?.textContent ?? null,
    atBottom: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 24,
  }
})
/** Wait until the pane's state satisfies `test` (a function of `paneState`'s value, run in Node); the last state seen is returned either way. */
export async function waitPane(page, test, { timeout = 15000, every = 150 } = {}) {
  const until = Date.now() + timeout
  let last = null
  for (;;) {
    last = await paneState(page)
    if (last && test(last)) return { ok: true, state: last }
    if (Date.now() > until) return { ok: false, state: last }
    await sleep(every)
  }
}
/** Make the page hidden or visible to itself. A headless Chrome page cannot be hidden for real, so `document.visibilityState` is overridden and `visibilitychange` sent: what the pane reads. */
export async function setHidden(page, hidden) {
  await page.evaluate((hidden) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
    document.dispatchEvent(new Event('visibilitychange'))
  }, hidden)
}
export const shot = (page, name) => page.screenshot({ path: join(cfg.shots, `${name}.png`) }).catch(() => {})

// ---------------------------------------------------------------- rows

/**
 * Runs matrix rows and reports each as PASS, FAIL or NOT_RUN "against <backend>".
 * @param watched - `{ page, logs }` pairs whose console errors and failed requests fail the row that was running.
 */
export function runner(script) {
  const only = opt('--rows') ? new Set(opt('--rows').split(',')) : null
  const results = []
  const watched = []
  return {
    watch(page, logs) { watched.push({ page, logs, seen: 0, failed: 0 }) },
    async row(id, title, fn) {
      if (only && !only.has(id)) return
      const failures = [], notes = []
      const t = {
        check(ok, message) { if (!ok) { failures.push(message); console.error(`  FAIL ${id}: ${message}`) } return !!ok },
        note(text) { notes.push(text); console.log(`  ${id}: ${text}`) },
      }
      const mark = traceMark()
      const started = Date.now()
      let outcome = 'PASS', reason = ''
      console.log(`ROW ${id}: ${title}`)
      try { await fn(t) } catch (error) {
        if (error instanceof NotRun) { outcome = 'NOT_RUN'; reason = error.message } else { failures.push(`${error?.message ?? error}`.split('\n').slice(0, 6).join(' | ')); console.error(`  FAIL ${id}: ${error?.stack ?? error}`) }
      }
      for (const w of watched) {
        const errors = w.logs.slice(w.seen)
        w.seen = w.logs.length
        for (const e of errors) failures.push(`console: ${e.slice(0, 300)}`)
        const failed = await failedRequests(w.page).catch(() => [])
        for (const f of failed.slice(w.failed)) failures.push(`request: ${f}`)
        w.failed = failed.length
      }
      const growth = traceGrowth(mark)
      for (const b of growth.bad) failures.push(`trace growth from polling: ${b}`)
      notes.push(`call log: ${growth.newLines} new lines, none from a log read (${Object.entries(growth.others).map(([k, n]) => `${k} ×${n}`).join(', ') || 'none'}); trace/outputs: ${growth.newOutputs} new, none from a log read`)
      if (failures.length) outcome = 'FAIL'
      results.push({ id, title, outcome, reason, failures, notes, seconds: (Date.now() - started) / 1000 })
      for (const w of watched) if (outcome === 'FAIL') await shot(w.page, `${script}-${id}-fail`)
    },
    /** Print the results; the exit code is 1 when a row failed. */
    finish() {
      console.log(`\n${script}: results against ${backend}, machine ${cfg.machine}${cfg.sandbox ? `, Sandbox ${cfg.sandbox}` : ''}`)
      for (const r of results) {
        console.log(`${r.id} ${r.outcome} (${r.seconds.toFixed(1)} s) — ${r.title}${r.reason ? ` — ${r.reason}` : ''}`)
        for (const f of r.failures) console.log(`    FAIL: ${f}`)
        for (const n of r.notes) console.log(`    ${n}`)
      }
      return results.some((r) => r.outcome === 'FAIL') ? 1 : 0
    },
  }
}

/** A script's frame: one browser, rows, a clean stand-in afterwards, and a hard stop before the 2-minute ceiling. */
export async function main(script, body) {
  const hard = setTimeout(() => { console.error(`${script}: still running after 110 s: stopped`); driver.reset(); process.exit(1) }, 110000)
  hard.unref()
  const run = runner(script)
  const { browser, page, logs } = await open()
  run.watch(page, logs)
  let code = 1
  try {
    await body({ run, browser, page, logs })
  } finally {
    try { driver.reset() } catch { /* the fixture folder is gone */ }
    code = run.finish()
    await browser.close().catch(() => {})
  }
  process.exit(code)
}
