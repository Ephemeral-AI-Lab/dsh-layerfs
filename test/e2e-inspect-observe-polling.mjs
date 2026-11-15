#!/usr/bin/env node
// How often the Machines pages ask `machine stats` (layerfs-project#164 "dsh-layerfs UI":
// "polled only while the page is visible, at a modest interval"):
//   R1  a machine's page: one `machine stats` of that machine every 10 s (0.1 processes a second),
//       none of another machine; none while the page is hidden; one again when it shows
//   R2  the Machines board: each running machine every 30 s, one after the other, a stopped one
//       never; none once another Center page is on screen
// Every row also fails when polling added a line to the call log or a saved output
// (test/e2e-inspect-logs-lib.mjs `traceGrowth`).
//
// The rows count CLI processes: they need a spawn log (the stand-in's, or INSPECT_SPAWN_LOG).
//
//   DSH_LAYERFS_DEV_DIR=… DSH_LAYERFS_CLI=… [INSPECT_STANDIN_DIR=… | INSPECT_SPAWN_LOG=…] node test/e2e-inspect-observe-polling.mjs
import { NotRun, O, diskOf, features, jump, main, needO, openBoard, openHealth, setHidden, setupObserve, sleep, spawnMark, spawns, spawnsSince, statsSpawns, waitObserved } from './e2e-inspect-observe-lib.mjs'

const PAGE_MS = 10_000, BOARD_MS = 30_000
const tally = (by) => Object.entries(by).map(([k, v]) => `${k} ×${v.length}`).join(', ') || 'none'

await main('e2e-inspect-observe-polling', async ({ run, page }) => {
  setupObserve()
  const has = await features(page)
  const need = () => {
    if (!has.inspect?.machineStats) throw new NotRun('the pinned CLI has no machine.stats')
    if (!spawns()) throw new NotRun('no spawn log (INSPECT_SPAWN_LOG, or the stand-in\'s spawns.log): CLI processes cannot be counted')
  }

  await run.row('R1', 'a machine\'s page asks `machine stats` every 10 s, only for that machine, and not while hidden', async (t) => {
    need()
    const m = O.docker.name ? O.docker : needO(O.machine)
    await jump(page, m.title)
    await waitObserved(page, (s) => diskOf(s)?.state === 'observed', { timeout: 20000 })
    const WINDOW = 22_000
    let mark = spawnMark()
    await sleep(WINDOW)
    let by = statsSpawns(spawnsSince(mark))
    const mine = by[m.name] ?? []
    t.check(mine.length >= 2 && mine.length <= 3, `${mine.length} \`machine stats ${m.name}\` in ${WINDOW / 1000} s: one every ${PAGE_MS / 1000} s (2 to 3)`)
    const gaps = mine.slice(1).map((at, i) => at - mine[i])
    t.check(gaps.every((g) => g >= PAGE_MS - 1500), `never sooner than ${PAGE_MS / 1000} s after the one before (gaps ${gaps.map((g) => `${(g / 1000).toFixed(1)} s`).join(', ') || 'none'})`)
    t.check(Object.keys(by).every((name) => name === m.name), `none for a machine whose page is not open (${tally(by)})`)
    t.note(`machine page: interval ${PAGE_MS / 1000} s = ${(1000 / PAGE_MS).toFixed(2)} CLI processes a second while it is on screen; measured ${(mine.length / (WINDOW / 1000)).toFixed(2)}/s`)

    await setHidden(page, true)
    await sleep(1200)
    mark = spawnMark()
    await sleep(12_000)
    by = statsSpawns(spawnsSince(mark))
    t.check(Object.keys(by).length === 0, `hidden for 12 s: no \`machine stats\` (${tally(by)})`)
    mark = spawnMark()
    await setHidden(page, false)
    await sleep(3500)
    by = statsSpawns(spawnsSince(mark))
    t.check((by[m.name] ?? []).length === 1, `visible again: one read within 3.5 s (${tally(by)})`)
  })

  await run.row('R2', 'the board asks each running machine every 30 s, a stopped one never, and nothing once another page shows', async (t) => {
    need()
    const running = [O.machine, O.docker, O.volume].filter((m) => m.name)
    await openBoard(page)
    await waitObserved(page, (s) => running.every((m) => diskOf(s, m.name)), { timeout: 20000 })
    const WINDOW = 32_000
    let mark = spawnMark()
    await sleep(WINDOW)
    let by = statsSpawns(spawnsSince(mark))
    for (const m of running) {
      const n = (by[m.name] ?? []).length
      t.check(n >= 1 && n <= 2, `${m.name}: ${n} \`machine stats\` in ${WINDOW / 1000} s: one every ${BOARD_MS / 1000} s (1 to 2)`)
    }
    if (O.stopped.name) t.check(!(O.stopped.name in by), `${O.stopped.name} (stopped) is never asked`)
    const all = Object.values(by).flat().sort((a, b) => a - b)
    t.note(`board: ${running.length} running machines, interval ${BOARD_MS / 1000} s each = ${(running.length * 1000 / BOARD_MS).toFixed(2)} CLI processes a second while it is on screen; measured ${(all.length / (WINDOW / 1000)).toFixed(2)}/s (${tally(by)})`)

    // another Center page: the board is no longer on screen
    await openHealth(page)
    await sleep(1000)
    mark = spawnMark()
    await sleep(BOARD_MS / 3)
    by = statsSpawns(spawnsSince(mark))
    t.check(Object.keys(by).length === 0, `on the Health page for ${BOARD_MS / 3000} s: no \`machine stats\` (${tally(by)})`)
  })
})
