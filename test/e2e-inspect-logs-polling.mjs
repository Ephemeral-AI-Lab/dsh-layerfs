#!/usr/bin/env node
// What following a log costs (layerfs-project#178 matrix):
//   P6  30 s on the Log tab: at most 15 inspection processes, none while the page is hidden;
//       the page's other reads are not made more often (their kept answers stay)
//
// It counts CLI processes in the spawn log (the stand-in's spawns.log, or
// cli-count.sh's file for a real build): 30 s on the page's other tab as the
// baseline, then 30 s on the log tab while a line is written every second (so
// the poll never backs off: the most it can spawn), then 8 s hidden.
//
//   DSH_LAYERFS_DEV_DIR=… DSH_LAYERFS_CLI=… INSPECT_SANDBOX=… [INSPECT_STANDIN_DIR=… | INSPECT_HOOK=… INSPECT_SPAWN_LOG=…] \
//     node test/e2e-inspect-logs-polling.mjs
// Environment and what every row also checks: test/e2e-inspect-logs-lib.mjs.
import { driver, main, newTag, openQuiet, primary, seqsOf, setHidden, showLog, sleep, spawnMark, spawnsSince, waitPane } from './e2e-inspect-logs-lib.mjs'

const WINDOW_MS = 30000, HIDDEN_MS = 8000
const tally = (others) => Object.entries(others).sort().map(([k, n]) => `${k} ×${n}`).join(', ') || 'none'

await main('e2e-inspect-logs-polling', async ({ run, page }) => {
  await run.row('P6', '30 s on the Log tab: at most 15 inspection spawns, zero when hidden; other reads not made more often', async (t) => {
    const target = await primary(page), tag = newTag('p6')
    spawnsSince(0) // NOT_RUN here when no process can be counted
    await openQuiet(page, target)
    driver.fill(target.kind, target.name, 50, tag)

    // baseline: the same page on its other tab
    await sleep(1500)
    let mark = spawnMark()
    await sleep(WINDOW_MS)
    const base = spawnsSince(mark)
    t.check(base.inspect.length === 0, `no inspection process while the log tab is closed (${base.inspect.length})`)
    t.note(`baseline, ${WINDOW_MS / 1000} s on "${target.other}": other reads ${tally(base.others)}`)

    // the log tab, with a new line every second
    await showLog(page, target)
    let got = await waitPane(page, (s) => s.state === 'ready' && seqsOf(s.rows, tag).length === 50)
    t.check(got.ok, 'the log is shown')
    mark = spawnMark()
    let seq = 50
    for (const until = Date.now() + WINDOW_MS; Date.now() < until;) { driver.append(target.kind, target.name, seq++, 1, tag); await sleep(1000) }
    const live = spawnsSince(mark)
    t.check(live.inspect.length <= 15, `${live.inspect.length} inspection processes in ${WINDOW_MS / 1000} s on the log tab with a line written every second (at most 15)`)
    t.check(live.inspect.length >= 5, `the tab did poll (${live.inspect.length} reads)`)
    t.check(live.inspect.every((s) => s.argv.includes('--cursor')), 'every poll reads by --cursor')
    t.note(`log tab, ${WINDOW_MS / 1000} s with a line written every second: ${live.inspect.length} inspection processes, all by --cursor; other reads ${tally(live.others)}`)
    // the same page in the same time: a read the log tab made more often (its kept answer dropped) shows as a higher count.
    // One more of a kind is the phase of that read's own timer between two 30 s windows, not the log tab.
    for (const [name, n] of Object.entries(live.others)) t.check(n <= (base.others[name] ?? 0) + 1, `\`${name}\` is not read more often on the log tab (${n} against ${base.others[name] ?? 0} in the baseline)`)
    got = await waitPane(page, (s) => seqsOf(s.rows, tag).at(-1) === seq - 1, { timeout: 8000 })
    t.check(got.ok, `the lines written are all shown (last ${seqsOf(got.state.rows, tag).at(-1)}, written ${seq - 1})`)

    // hidden: no read at all; visible again: it catches up
    await setHidden(page, true)
    await sleep(1500) // a read in flight ends
    const shown = (await waitPane(page, () => true)).state.lines
    mark = spawnMark()
    for (const until = Date.now() + HIDDEN_MS; Date.now() < until;) { driver.append(target.kind, target.name, seq++, 1, tag); await sleep(1000) }
    const hidden = spawnsSince(mark)
    t.check(hidden.inspect.length === 0, `no inspection process in ${HIDDEN_MS / 1000} s hidden (${hidden.inspect.length})`)
    t.check((await waitPane(page, () => true)).state.lines === shown, 'nothing was read while hidden')
    t.note(`hidden, ${HIDDEN_MS / 1000} s with a line written every second: ${hidden.inspect.length} inspection processes`)
    t.note('hidden: document.visibilityState overridden in the page and visibilitychange sent (a headless Chrome page cannot be hidden for real)')
    await setHidden(page, false)
    got = await waitPane(page, (s) => seqsOf(s.rows, tag).at(-1) === seq - 1, { timeout: 8000 })
    t.check(got.ok, `visible again: the lines written meanwhile appear (last ${seqsOf(got.state.rows, tag).at(-1)}, written ${seq - 1})`)
  })
})
