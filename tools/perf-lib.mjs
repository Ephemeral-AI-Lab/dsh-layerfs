// Perf harness pieces (docs/specs/backend-e2e-tests.md §2, §3.4): CLI spawn
// counts from the count shim (test/fixtures/cli-count.sh), host requests from
// the page, action windows with a quiesce, background-poll subtraction and
// percentiles.
//
// Background polling. Page pollers (machines every 5 s, project lists and
// Storage every 15 s, project storage / terminals every 1.5 s, doctor jobs
// every 1 s) are frozen with Playwright's fake clock: `bootPage` installs
// `page.clock` before `goto`, lets DSH boot on the running clock (boot works
// under it), then pauses it. Inside an action window `actionWindow` advances
// page time in 100 ms steps, at most `fakeBudgetMs` (900 ms) per window, so
// sub-second debounces and event refetch timers (300-800 ms) still fire while
// no ≥ 1 s interval ever does. In-page timestamps use the real clock captured
// before the fake one is installed.
//
// Host-side polling cannot be frozen from the page: with a bound project
// session the host lists Stores every 10 s (`store list`, sessions/index.ts
// AVAILABILITY_POLL_MS). `learnBackground` finds such periodic argv lines in an
// idle stretch (no page open); `actionWindow` drops one matching spawn per
// predicted tick (±250 ms) and reports those separately as `background`.
import { readFileSync, statSync, existsSync } from 'node:fs'
import { dismiss } from './ui.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** The count file the shim appends to (`$LFS_COUNT_FILE`, default `<dev dir>/spawns.log`). */
export function countFile(devDir) {
  return process.env.LFS_COUNT_FILE ?? `${devDir}/spawns.log`
}

/** Byte size of the count file (the offset an action window starts at). */
export function spawnOffset(file) {
  return existsSync(file) ? statSync(file).size : 0
}

/**
 * Spawn lines appended since `offset`: `{ pid, ns, ms, argv, pos }` (`ms` epoch
 * milliseconds; `argv` the CLI arguments as one space-joined string; `pos` the
 * line's byte offset in the file).
 */
export function spawns(file, offset = 0) {
  if (!existsSync(file)) return []
  const buf = readFileSync(file).subarray(offset)
  const out = []
  let start = 0
  while (start < buf.length) {
    let end = buf.indexOf(10, start)
    if (end < 0) break // a line still being written
    const m = buf.subarray(start, end).toString('utf8').match(/^(\d+) (\d+) ?(.*)$/)
    if (m) { const ns = BigInt(m[2]); out.push({ pid: Number(m[1]), ns, ms: Number(ns / 1000000n), argv: m[3], pos: offset + start }) }
    start = end + 1
  }
  return out
}

/** Discovery lines (`--version --json`, `help --json`): not LayerFS calls, counted apart. */
export const isDiscovery = (argv) => /^(--version|help)( |$)/.test(argv)

/** `family call` of a spawn line (`store list -- …` → `store.list`). */
export function familyCall(argv) {
  const words = argv.split(' ').filter((w) => w && !w.startsWith('-'))
  return words.length >= 2 ? `${words[0]}.${words[1]}` : (words[0] ?? '?')
}

/** Group spawn lines: `{ total, discovery, byCall: { 'family.call': n } }` (discovery not in total). */
export function groupSpawns(lines) {
  const byCall = {}
  let total = 0, discovery = 0
  for (const l of lines) {
    if (isDiscovery(l.argv)) { discovery++; continue }
    total++
    const k = familyCall(l.argv)
    byCall[k] = (byCall[k] ?? 0) + 1
  }
  return { total, discovery, byCall: Object.fromEntries(Object.entries(byCall).sort(([a], [b]) => a.localeCompare(b))) }
}

/** The p-th percentile (0-100) of numbers, nearest rank; null when empty. */
export function percentile(values, p) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1))]
}

/**
 * Wrap `window.__dshLayerfs.call` and `.op` from the moment the client sets the
 * handle (a setter on window), recording one entry per host request in
 * `window.__perf.log`: `{ kind, name, t0, t1, ok, status, transport }`. `call`
 * reaches the host through `op`'s closure, so both are wrapped and nothing is
 * counted twice. Also observes long tasks. Must run before `page.clock.install()`.
 */
export async function instrument(page) {
  await page.addInitScript(() => {
    try { localStorage.setItem('dsh-layerfs:debug', '1') } catch {}
    const now = performance.now.bind(performance)
    const origin = performance.timeOrigin
    const realNow = () => origin + now()
    const perf = window.__perf = { log: [], inflight: 0, quiet: false, longtasks: [], realNow }
    const wrap = (api) => {
      if (!api || api.__perfWrapped) return api
      const record = (kind, name, run) => {
        if (perf.quiet) return run()
        const entry = { kind, name, t0: realNow(), t1: null, ok: null, status: null, transport: null }
        perf.log.push(entry)
        perf.inflight++
        let settled = false
        const done = (ok, status, transport) => { if (settled) return; settled = true; entry.t1 = realNow(); entry.ok = ok; entry.status = status; entry.transport = transport ?? null; perf.inflight-- }
        try {
          const p = run()
          Promise.resolve(p).then(() => done(true, 200), (e) => done(false, e?.status ?? 0, e?.transport))
          return p
        } catch (e) { done(false, 0); throw e }
      }
      const call = api.call, op = api.op
      api.call = (method, path, body) => record('call', `${method} ${String(path)}`, () => call(method, path, body))
      api.op = (name, args) => record('op', name === 'http' ? `http ${args?.method} ${args?.path}` : String(name), () => op(name, args))
      Object.defineProperty(api, '__perfWrapped', { value: true })
      return api
    }
    let current
    Object.defineProperty(window, '__dshLayerfs', {
      configurable: true,
      get: () => current,
      set: (v) => { current = wrap(v) },
    })
    try {
      new PerformanceObserver((list) => { for (const e of list.getEntries()) perf.longtasks.push({ t: origin + e.startTime, ms: e.duration }) }).observe({ type: 'longtask', buffered: true })
    } catch {}
  })
}

/**
 * Open the dev URL on a page already instrumented: fake clock installed (running)
 * before `goto`, wait for DSH and the handle, let boot quiesce, then pause the
 * clock. Returns when the page is idle.
 */
export async function bootPage(page, url, { file, background = [], clock = true, timeoutMs = 30000 } = {}) {
  if (clock) await page.clock.install()
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.locator('[data-composer-input=true], [role=treeitem]').first().waitFor({ timeout: timeoutMs })
  await page.waitForFunction(() => window.__dshLayerfs && window.__perf, null, { timeout: timeoutMs })
  await dismiss(page)
  await quiesce(page, { file, offset: spawnOffset(file), background, clock: false })
  if (clock) await page.clock.pauseAt(await page.evaluate(() => Date.now() + 50))
}

/**
 * Find periodic host-side spawns in an idle stretch: argv strings seen at least
 * twice at a steady interval. Returns `[{ argv, period, last }]` (ms).
 */
export function learnBackground(lines) {
  const byArgv = new Map()
  for (const l of lines) { if (!isDiscovery(l.argv)) byArgv.set(l.argv, [...(byArgv.get(l.argv) ?? []), l.ms]) }
  const out = []
  for (const [argv, times] of byArgv) {
    if (times.length < 2) continue
    const gaps = times.slice(1).map((t, i) => t - times[i])
    const period = percentile(gaps, 50)
    if (period < 900 || gaps.some((g) => Math.abs(g - period) > 300)) continue
    out.push({ argv, period, last: times.at(-1) })
  }
  return out
}

/** How early / late a host poll's spawn may land around its predicted tick (a busy host fires timers late). */
export const BG_EARLY_MS = 250, BG_LATE_MS = 2500

/** Predicted ticks of the learned signatures in [lo, hi] (epoch ms): `[{ sig, at }]`. */
export function backgroundTicks(background, lo, hi) {
  const out = []
  for (const sig of background) {
    for (let k = Math.ceil((lo - sig.last) / sig.period); sig.last + k * sig.period <= hi; k++) out.push({ sig, at: sig.last + k * sig.period })
  }
  return out.sort((a, b) => a.at - b.at)
}

/**
 * Split lines into `{ own, background }` using learned periodic signatures:
 * each predicted tick claims the earliest unclaimed line with its argv in
 * [tick − early, tick + late]. A host poll's spawn is independent of page
 * reads (the SDK does not coalesce), so claiming one line per tick keeps the
 * count right whichever of two identical lines it claims. Pass lines from
 * before and after the window too, so ticks whose spawn falls just outside it
 * claim that line instead of a page's.
 */
export function subtractBackground(lines, background, { early = BG_EARLY_MS, late = BG_LATE_MS } = {}) {
  const own = [...lines], bg = []
  if (!lines.length || !background.length) return { own, background: bg }
  for (const { sig, at } of backgroundTicks(background, lines[0].ms - late, lines.at(-1).ms + early)) {
    const i = own.findIndex((l) => l.argv === sig.argv && l.ms >= at - early && l.ms <= at + late)
    if (i >= 0) bg.push(...own.splice(i, 1))
  }
  return { own, background: bg }
}

/**
 * Wait until no host request is in flight and no new (non-background) spawn
 * line has appeared for `idleMs`, at most `maxMs`. With `clock`, advances the
 * paused page clock by 100 ms per step up to `fakeBudgetMs` in total.
 * @returns {{ settled: boolean, fakeMs: number }}
 */
export async function quiesce(page, { file, offset, background = [], idleMs = 750, maxMs = 30000, clock = true, fakeBudgetMs = 900 } = {}) {
  const start = Date.now()
  let lastCount = -1, lastChange = Date.now(), fakeMs = 0
  for (;;) {
    if (clock && fakeMs < fakeBudgetMs) { await page.clock.runFor(100).catch(() => {}); fakeMs += 100 }
    const inflight = await page.evaluate(() => window.__perf?.inflight ?? 0)
    const count = subtractBackground(spawns(file, offset), background).own.length
    if (count !== lastCount || inflight > 0) { lastCount = count; lastChange = Date.now() }
    if (Date.now() - lastChange >= idleMs && (!clock || fakeMs >= fakeBudgetMs)) return { settled: true, fakeMs }
    if (Date.now() - start > maxMs) return { settled: false, fakeMs }
    await sleep(100)
  }
}

/**
 * Measure one action: note the count-file offset and the host-request log
 * position, run `fn`, optionally time `ready` (first content), quiesce, diff.
 * @param page - an instrumented, booted page.
 * @param fn - the action (`async (page) => {}`).
 * @param opts.ready - optional `async (page) => {}` resolving when the page shows content (TTFC).
 * @returns {{ spawns, background, discovery, hostCalls, ms, ttfcMs, settled, longtasks }}
 */
export async function actionWindow(page, fn, { file, background = [], ready, clock = true, idleMs = 750, maxMs = 30000, fakeBudgetMs = 900 } = {}) {
  const offset = spawnOffset(file)
  const logAt = await page.evaluate(() => { const p = window.__perf; return { log: p.log.length, long: p.longtasks.length } })
  const t0 = Date.now()
  let ttfcMs = null
  const run = (async () => { await fn(page) })()
  if (ready) {
    // Keep page timers moving while waiting for content (within the window's fake budget).
    let fake = 0
    const ticking = clock ? (async () => { while (ttfcMs === null && fake < fakeBudgetMs) { await sleep(100); await page.clock.runFor(100).catch(() => {}); fake += 100 } })() : null
    await run
    await ready(page)
    ttfcMs = Date.now() - t0
    await ticking
    fakeBudgetMs = Math.max(0, fakeBudgetMs - fake)
  } else await run
  const q = await quiesce(page, { file, offset, background, idleMs, maxMs, clock, fakeBudgetMs })
  const ms = Date.now() - t0
  // A poll tick near the end may spawn late: wait for its line so it does not claim nothing (or a page line).
  const tail = backgroundTicks(background, Date.now() - BG_LATE_MS, Date.now() + BG_EARLY_MS)
  if (tail.length) await sleep(Math.max(0, tail.at(-1).at + BG_LATE_MS - Date.now()) + 100)
  // Lines from just before the window let a tick that spawned before it claim its own line.
  const around = spawns(file, 0).filter((l) => l.pos >= offset || l.ms >= t0 - BG_LATE_MS - BG_EARLY_MS)
  const claimed = subtractBackground(around, background)
  const split = { own: claimed.own.filter((l) => l.pos >= offset), background: claimed.background.filter((l) => l.pos >= offset) }
  const { log, long } = await page.evaluate((at) => ({ log: window.__perf.log.slice(at.log), long: window.__perf.longtasks.slice(at.long) }), logAt)
  return {
    spawns: split.own.filter((l) => !isDiscovery(l.argv)).map((l) => ({ argv: l.argv, at: l.ms - t0 })),
    discovery: split.own.filter((l) => isDiscovery(l.argv)).length,
    background: split.background.map((l) => l.argv),
    hostCalls: log.map((e) => ({ kind: e.kind, name: e.name, ok: e.ok, status: e.status, transport: e.transport, ms: e.t1 === null ? null : Math.round(e.t1 - e.t0) })),
    ms, ttfcMs, settled: q.settled,
    longtasks: { count: long.length, ms: Math.round(long.reduce((s, e) => s + e.ms, 0)) },
  }
}

/**
 * Call-log lines (`{at, ms, argv, outcome, tag}`) at or after `since` (epoch ms),
 * read through the `logs.list` op without being recorded as page requests.
 */
export async function callLines(page, since, limit = 500) {
  return page.evaluate(async ([s, n]) => {
    const p = window.__perf
    p.quiet = true
    try { return ((await window.__dshLayerfs.op('logs.list', { since: s, limit: n }))?.lines ?? []).filter((l) => (l.at ?? 0) >= s) } catch { return [] } finally { p.quiet = false }
  }, [since, limit])
}

/** Host calls grouped by name: `{ name: n }`. */
export function groupHostCalls(calls) {
  const out = {}
  for (const c of calls) out[c.name] = (out[c.name] ?? 0) + 1
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)))
}
