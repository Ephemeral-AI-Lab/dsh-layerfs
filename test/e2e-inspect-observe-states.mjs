#!/usr/bin/env node
// A machine's observed values while `machine stats` is slow or refused
// (layerfs-project#164 "dsh-layerfs UI": success, in-progress and failure states):
//   T1  a slow `machine stats`: the last values stay on screen while it runs (no spinner in their
//       place), and the new ones replace them when it answers
//   T2  `Busy`: the last values stay, marked "as of <time> · Busy"; the mark goes with the next answer
//   T3  `Unavailable`: the same, with its code
// (A read that never answers is test/e2e-inspect-observe-hang.mjs.)
//
//   DSH_LAYERFS_DEV_DIR=… DSH_LAYERFS_CLI=… [INSPECT_STANDIN_DIR=… | INSPECT_HOOK=…] node test/e2e-inspect-observe-states.mjs
// Environment and what every row also checks: test/e2e-inspect-logs-lib.mjs, test/e2e-inspect-observe-lib.mjs.
import { NotRun, O, cfg, cli, diskOf, features, gibText, jump, main, needO, setupObserve, shot, sleep, spawnMark, spawns, spawnsSince, statsDriver, statsSpawns, waitObserved } from './e2e-inspect-observe-lib.mjs'

const GIB = 1024 ** 3
const SLOW_MS = 7000

await main('e2e-inspect-observe-states', async ({ run, page }) => {
  setupObserve()
  const has = await features(page)
  const m = O.docker.name ? O.docker : O.machine
  const need = () => { if (!has.inspect?.machineStats) throw new NotRun('the pinned CLI has no machine.stats'); needO(m) }
  /** The page of `m` with observed values and no stale mark. */
  const settled = async () => {
    await jump(page, m.title)
    return waitObserved(page, (s) => diskOf(s)?.state === 'observed' && !diskOf(s).stale, { timeout: 25000 })
  }
  /** Wait until a `machine stats` of `m` started after `mark`. */
  const started = async (mark, timeout = 14000) => {
    if (!spawns()) { await sleep(timeout); return null }
    const until = Date.now() + timeout
    for (;;) { const at = statsSpawns(spawnsSince(mark))[m.name]?.[0]; if (at || Date.now() > until) return at ?? null; await sleep(150) }
  }

  await run.row('T1', 'a slow `machine stats`: the last values stay while it runs, the new ones replace them when it answers', async (t) => {
    need()
    const first = await settled()
    if (!t.check(first.ok, 'the page shows observed values')) return
    const before = diskOf(first.state).text
    const base = cli('machine', 'stats', '--', m.name)
    let changed = null
    if (cfg.standin) { changed = base.resources.disk_used + 5 * GIB; statsDriver.declare((c) => { c.stats[m.name].resources.disk_used = changed; c.stats[m.name].resources.disk_free = base.resources.disk_free - 5 * GIB }) }
    const mark = spawnMark()
    statsDriver.hang(m.name, SLOW_MS)
    try {
      const at = await started(mark)
      if (spawns()) t.check(!!at, 'the next poll started a `machine stats`, which is now slow')
      const t0 = Date.now()
      let samples = 0, kept = 0, busy = 0
      while (Date.now() - t0 < SLOW_MS - 1500) {
        const s = (await waitObserved(page, () => true, { timeout: 1000 })).state
        const disk = diskOf(s)
        samples++
        if (disk?.state === 'observed' && disk.text === before && s.card.cpus !== null) kept++
        if (disk?.stale) busy++
        await sleep(700)
      }
      t.check(samples > 3 && kept === samples, `while the read runs the page keeps showing the values it had (${kept} of ${samples} looks over ${((Date.now() - t0) / 1000).toFixed(1)} s): "${before}"`)
      t.check(busy === 0, 'a read that is only slow is not marked stale')
      const loading = await page.evaluate(() => { const root = [...document.querySelectorAll('[data-storage-page]')].find((e) => e.offsetParent); const d = root.querySelector('[data-disk]'); return { busy: !!d?.closest('[aria-busy=true]'), spinner: !!d?.parentElement?.querySelector('[role=progressbar]:not([aria-valuenow]), [class*=spinner]') } })
      t.check(!loading.busy && !loading.spinner, `no spinner stands in for the values (${JSON.stringify(loading)})`)
      await shot(page, 'observe-states-slow')
      if (changed !== null) {
        const want = `${gibText(changed)} used of ${gibText(base.resources.disk_total)}`
        const next = await waitObserved(page, (s) => diskOf(s)?.text.startsWith(want), { timeout: 12000 })
        t.check(next.ok, `when it answers (${SLOW_MS / 1000} s later) the new values replace them ("${diskOf(next.state)?.text}")`)
      } else t.note('a real build: the answer after the slow read was not told apart from the one before (nothing changed the disk)')
    } finally {
      statsDriver.unhang(m.name)
      if (cfg.standin) statsDriver.declare((c) => { c.stats[m.name].resources.disk_used = base.resources.disk_used; c.stats[m.name].resources.disk_free = base.resources.disk_free })
    }
  })

  for (const [id, code, message, words] of [
    ['T2', 'Busy', '2 inspect reads are running on this machine; try again', 'The last read was refused because other reads were running. These are the values read before.'],
    ['T3', 'Unavailable', `machine ${m.name ?? ''} did not answer`, null],
  ]) {
    await run.row(id, `\`${code}\`: the last values stay, marked "as of <time> · ${code}"; the mark goes with the next answer`, async (t) => {
      need()
      const first = await settled()
      if (!t.check(first.ok, 'the page shows observed values with no stale mark')) return
      const before = diskOf(first.state)
      statsDriver.refuse(m.name, code, message)
      try {
        const got = await waitObserved(page, (s) => diskOf(s)?.stale === code, { timeout: 20000 })
        const disk = diskOf(got.state)
        if (!t.check(got.ok, `after the refused read the disk line is marked ${code} (${JSON.stringify(disk)})`)) return
        t.check(disk.state === 'observed' && disk.text.startsWith(before.text.replace(before.scopeWords ?? '', '')), `the values read before stay ("${disk.text}")`)
        t.check(new RegExp(`^as of .+ · ${code}$`).test(disk.staleText ?? ''), `the mark reads "as of <time> · ${code}" ("${disk.staleText}")`)
        const title = await page.evaluate(() => [...document.querySelectorAll('[data-storage-page]')].find((e) => e.offsetParent)?.querySelector('[data-disk] [data-stats-stale]')?.getAttribute('title'))
        t.check(words ? title === words : (title ?? '').includes(`${code}: ${message}`) && (title ?? '').endsWith('These are the values read before.'), `its tooltip says why in words ("${title}")`)
        t.check(got.state.card.cpus !== null && got.state.card.stale.includes(code) && got.state.allText.includes('These are the values read before.'), 'the Details card keeps its values too, and says the same')
        t.check(got.state.card.notObserved.length === 0 && !/Not observed/.test(disk.text), 'nothing turned into "Not observed" or 0')
        const failed = await page.evaluate(() => (window.__inspect?.calls ?? []).filter((c) => /\/stats\b/.test(c.what) && c.status !== undefined && c.status !== 'ok').length)
        t.check(failed === 0, `the refused read is an answer of the route, not a failed request (${failed})`)
        await shot(page, `observe-states-${code.toLowerCase()}`)
      } finally { statsDriver.unrefuse(m.name) }
      const back = await waitObserved(page, (s) => diskOf(s)?.state === 'observed' && !diskOf(s).stale && s.card.stale.length === 0, { timeout: 20000 })
      t.check(back.ok, 'with the next answer the mark is gone')
    })
  }
})
