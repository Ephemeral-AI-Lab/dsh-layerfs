#!/usr/bin/env node
// axe-core on the pages layerfs-project#164 and #180 changed: the Doctor (Health) page with
// its leftovers, the Machines board, a machine's page (observed, stale, a stopped machine)
// and the Sandbox page (usage, and the reason when there is none).
//
// axe runs on the open LayerFS page (`[data-storage-page]`). A violation inside a new part
// fails the row; one elsewhere on the page is reported as found, and does not (three older
// ones are known from the #178 runs). A Sandbox row of the inventory is an older part: this
// work added its `live` state, not its button or its label.
//
//   DSH_LAYERFS_DEV_DIR=… DSH_LAYERFS_CLI=… [INSPECT_STANDIN_DIR=… | INSPECT_HOOK=…] node test/e2e-inspect-observe-axe.mjs
// Environment and what every row also checks: test/e2e-inspect-logs-lib.mjs, test/e2e-inspect-observe-lib.mjs.
import { createRequire } from 'node:module'
import { NotRun, O, diskOf, editor, features, jump, main, openBoard, openHealth, setupObserve, shot, sleep, statsDriver, waitObserved } from './e2e-inspect-observe-lib.mjs'

const axePath = createRequire(import.meta.url).resolve('axe-core/axe.min.js')
const FRESH = '[data-leftovers], [data-disk], [data-resources], [data-worker-line], [data-stats-cpus], [data-stats-memory], [data-stats-disk], [data-stats-disk-scope], [data-stats-worker], [data-stats-at], [data-stats-live], [data-stats-stores], [data-stats-stale], [data-not-observed], [data-stats], [data-here-now], [data-daemon-process], [data-sandbox-usage]'

async function axe(page) {
  if (!(await page.evaluate(() => !!window.axe))) await page.addScriptTag({ path: axePath })
  return page.evaluate(async (fresh) => {
    const root = [...document.querySelectorAll('[data-storage-page]')].find((e) => e.offsetParent)
    const result = await window.axe.run(root, { resultTypes: ['violations'] })
    return {
      version: window.axe.version, passes: result.passes.length, parts: root.querySelectorAll(fresh).length,
      violations: result.violations.map((v) => ({
        id: v.id, impact: v.impact, help: v.help,
        nodes: v.nodes.map((n) => {
          const el = document.querySelector(n.target[0])
          return { target: n.target.join(' '), html: n.html.slice(0, 160), fresh: !!el && (!!el.closest(fresh) || !!el.querySelector(fresh) && el.matches('dd, dt, li, p')), summary: (n.failureSummary ?? '').replace(/\s+/g, ' ').slice(0, 200) }
        }),
      })),
    }
  }, FRESH)
}

await main('e2e-inspect-observe-axe', async ({ run, page }) => {
  setupObserve()
  const has = await features(page)
  await run.row('X1', 'axe on the Doctor page\'s leftovers, the Machines board, the machine page and the Sandbox page', async (t) => {
    if (!has.inspect?.machineStats && !has.leftovers) throw new NotRun('the pinned CLI has neither machine.stats nor doctor.fix: there is no new part to check')
    const elsewhere = new Map()
    let version = ''
    const scan = async (state, { parts = true } = {}) => {
      const result = await axe(page)
      version = result.version
      let fresh = 0
      for (const v of result.violations) {
        for (const n of v.nodes) {
          if (n.fresh) { fresh++; t.check(false, `${state}: ${v.id} (${v.impact}) ${v.help} — ${n.target} — ${n.html} — ${n.summary}`) } else elsewhere.set(`${v.id} ${n.html}`, `${v.id} (${v.impact}) ${v.help} — ${n.target} — ${n.html}`)
        }
      }
      if (parts) t.check(result.parts > 0, `${state}: the new parts are on the page (${result.parts})`)
      t.note(`${state}: ${fresh} violations in the new parts (${result.parts} elements), ${result.violations.reduce((n, v) => n + v.nodes.filter((x) => !x.fresh).length, 0)} elsewhere on the page (${result.passes} rules passed)`)
    }
    const details = async () => { const d = editor(page).locator('summary', { hasText: 'Details' }).first(); if (await d.count() && !(await d.evaluate((el) => el.parentElement.open))) await d.click(); await sleep(300) }

    if (has.leftovers) {
      await openHealth(page)
      // the Health page is the Doctor page now (leftovers are no longer a section of it): its rows are scanned as they open
      await editor(page).locator('[data-rows]').first().waitFor({ timeout: 20000 }).catch(() => {})
      await scan('Health page', { parts: false })
      await shot(page, 'observe-axe-health')
    } else t.note('no doctor.fix: the Health page was not scanned')

    if (has.inspect?.machineStats) {
      const running = [O.machine, O.docker, O.volume].filter((m) => m.name)
      await openBoard(page)
      await waitObserved(page, (s) => running.every((m) => diskOf(s, m.name)), { timeout: 20000 })
      await scan('Machines board')

      const m = O.docker.name ? O.docker : O.machine
      await jump(page, m.title)
      await waitObserved(page, (s) => diskOf(s)?.state === 'observed', { timeout: 20000 })
      await details()
      await scan(`Machine page (${m.name}), observed, Details open`)
      await shot(page, 'observe-axe-machine')
      try {
        statsDriver.refuse(m.name, 'Busy', '2 inspect reads are running on this machine; try again')
        const got = await waitObserved(page, (s) => diskOf(s)?.stale === 'Busy', { timeout: 20000 })
        t.check(got.ok, 'the stale mark is shown')
        await scan(`Machine page (${m.name}), a refused read over kept values`)
      } catch (error) { if (!(error instanceof NotRun)) throw error; t.note(`stale state not scanned — ${error.message}`) } finally { try { statsDriver.unrefuse(m.name) } catch { /* nothing to undo */ } }
      if (O.stopped.name) {
        await jump(page, O.stopped.title)
        await waitObserved(page, (s) => diskOf(s)?.state === 'not-observed', { timeout: 15000 })
        await details()
        await scan(`Machine page (${O.stopped.name}), stopped: not observed`)
      } else t.note('INSPECT_STOPPED_MACHINE is not set: the not-observed state was not scanned')
    } else t.note('no machine.stats: the Machines pages were not scanned')

    for (const b of [O.up, O.dead, O.unseen]) {
      if (!b.name) continue
      await jump(page, b.name)
      await editor(page).locator('[data-sandbox-usage], [data-daemon-process]').first().waitFor({ timeout: 15000 }).catch(() => {})
      await sleep(500)
      await scan(`Sandbox page (${b.name})`, { parts: (await editor(page).locator('[data-sandbox-usage], [data-daemon-process]').count()) > 0 })
    }
    t.note(`axe-core ${version}`)
    for (const line of elsewhere.values()) t.note(`elsewhere on the page (not the new parts): ${line}`)
  })
})
