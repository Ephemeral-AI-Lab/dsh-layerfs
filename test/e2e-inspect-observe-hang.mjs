#!/usr/bin/env node
// A `machine stats` that never answers must hold nothing else up
// (layerfs-project#164 "dsh-layerfs UI", the failure state "hang past the lane's timeout"):
//   H1  `machine stats` hangs 60 s: the host gives the read up after its 15 s (one attempt, the process
//       ended), the page keeps the last values marked "as of <time> · Timeout", the machines view and
//       another machine's stats still answer, reads do not pile up, and the mark goes when it answers again
//
//   DSH_LAYERFS_DEV_DIR=… DSH_LAYERFS_CLI=… [INSPECT_STANDIN_DIR=… | INSPECT_HOOK=…] node test/e2e-inspect-observe-hang.mjs
// Environment and what every row also checks: test/e2e-inspect-logs-lib.mjs, test/e2e-inspect-observe-lib.mjs.
import { spawnSync } from 'node:child_process'
import { NotRun, O, cfg, diskOf, features, jump, main, needO, probe, setupObserve, shot, sleep, spawnMark, spawns, spawnsSince, statsDriver, statsSpawns, waitObserved } from './e2e-inspect-observe-lib.mjs'

const HANG_MS = 60000, LANE_TIMEOUT_MS = 15000
const enc = encodeURIComponent
/** The `machine stats <name>` CLI processes alive now (the stand-in's own; a real build: by its argv). */
const alive = (name) => spawnSync('pgrep', ['-f', `machine stats.* ${name}$`], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).length

await main('e2e-inspect-observe-hang', async ({ run, page }) => {
  setupObserve()
  const has = await features(page)
  await run.row('H1', '`machine stats` hangs 60 s: given up after 15 s, last values kept and marked Timeout, nothing else held up', async (t) => {
    if (!has.inspect?.machineStats) throw new NotRun('the pinned CLI has no machine.stats')
    const m = O.docker.name ? O.docker : needO(O.machine)
    const other = [O.machine, O.volume].find((x) => x.name && x.name !== m.name)
    await jump(page, m.title)
    const first = await waitObserved(page, (s) => diskOf(s)?.state === 'observed' && !diskOf(s).stale, { timeout: 25000 })
    if (!t.check(first.ok, 'the page shows observed values')) return
    const before = diskOf(first.state)
    const mark = spawnMark()
    statsDriver.hang(m.name, HANG_MS)
    let h0 = Date.now()
    try {
      if (spawns()) {
        const until = Date.now() + 14000
        let at = null
        while (!(at = statsSpawns(spawnsSince(mark))[m.name]?.[0]) && Date.now() < until) await sleep(150)
        if (!t.check(!!at, 'the next poll started a `machine stats`, which now hangs')) return
        h0 = at
      } else await sleep(10500)
      // while it hangs: the values stay, the view and another machine answer
      const view = await probe(page, 'GET', '/api/machines')
      t.check(view.ok && view.ms < 2000, `the machines view answers in under 2 s while it hangs (${Math.round(view.ms)} ms)`)
      if (other) {
        const o = await probe(page, 'GET', `/api/machines/${enc(other.name)}/stats`)
        t.check(o.ok && o.body.stale === false && o.ms < 5000, `another machine's stats still answer: the hung read holds one of the lane's two places (${other.name}: ${Math.round(o.ms)} ms, stale ${JSON.stringify(o.body?.stale)})`)
      }
      const during = (await waitObserved(page, () => true, { timeout: 1000 })).state
      t.check(diskOf(during)?.state === 'observed' && diskOf(during).text === before.text, `the last values stay on screen while it hangs ("${diskOf(during)?.text}")`)
      // the host gives it up
      const got = await waitObserved(page, (s) => diskOf(s)?.stale === 'Timeout', { timeout: Math.max(2000, LANE_TIMEOUT_MS + 6000 - (Date.now() - h0)) })
      const disk = diskOf(got.state), took = Date.now() - h0
      if (!t.check(got.ok, `the disk line is marked Timeout (${JSON.stringify(disk)}, ${took} ms after the read started)`)) return
      t.check(took >= LANE_TIMEOUT_MS - 1000 && took <= LANE_TIMEOUT_MS + 6000, `about ${LANE_TIMEOUT_MS / 1000} s after it started, well before the ${HANG_MS / 1000} s (${(took / 1000).toFixed(1)} s)`)
      t.check(disk.state === 'observed' && /^as of .+ · Timeout$/.test(disk.staleText ?? '') && disk.text.startsWith(before.text.replace(before.scopeWords ?? '', '')), `the last values stay, marked "${disk.staleText}"`)
      const title = await page.evaluate(() => [...document.querySelectorAll('[data-storage-page]')].find((e) => e.offsetParent)?.querySelector('[data-disk] [data-stats-stale]')?.getAttribute('title'))
      t.check(title === 'The last read got no answer in time. These are the values read before.', `its tooltip says so in words ("${title}")`)
      t.check(alive(m.name) === 0, `the hung CLI process was ended, not left running (${alive(m.name)} alive)`)
      await shot(page, 'observe-hang-timeout')
      // no pile-up: one read at a time, each given up before the next
      await sleep(Math.max(0, 42000 - (Date.now() - h0)))
      if (spawns()) {
        const made = statsSpawns(spawnsSince(mark))[m.name] ?? []
        const gaps = made.slice(1).map((at, i) => at - made[i])
        t.check(made.length <= 3 && gaps.every((g) => g >= LANE_TIMEOUT_MS), `${made.length} reads were started in ${Math.round((Date.now() - h0) / 1000)} s, never two at once (gaps ${gaps.map((g) => `${(g / 1000).toFixed(1)} s`).join(', ') || 'none'})`)
      }
      t.check(alive(m.name) <= 1, `at most one \`machine stats ${m.name}\` is alive (${alive(m.name)})`)
      const view2 = await probe(page, 'GET', '/api/machines')
      t.check(view2.ok && view2.ms < 2000, `the machines view still answers in under 2 s (${Math.round(view2.ms)} ms)`)
    } finally { statsDriver.unhang(m.name) }
    const back = await waitObserved(page, (s) => diskOf(s)?.state === 'observed' && !diskOf(s).stale, { timeout: 40000 })
    t.check(back.ok, `once it answers again the mark is gone (${Math.round((Date.now() - h0) / 1000)} s in)`)
    if (!cfg.standin) t.note('a real build: the hang is the hook\'s')
  })
})
