#!/usr/bin/env node
// The Doctor page's leftovers on a CLI that has doctor.fix but no machine.files
// (layerfs-project#180 "dsh-layerfs UI": the 78-call build):
//   L4  "Show in Files" is replaced by its reason, never a link that leads nowhere; the fix command stays
//
// Run it against a side server whose pinned CLI has doctor.fix and no `machine files`
// (stand-in: the chain without cli-inspect-files.mjs). On another server the row is NOT_RUN.
//
//   DSH_LAYERFS_DEV_DIR=… DSH_LAYERFS_CLI=… [INSPECT_STANDIN_DIR=…] node test/e2e-inspect-observe-nofiles.mjs
// Environment and what every row also checks: test/e2e-inspect-logs-lib.mjs.
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { NotRun, cfg, hasTab, jump, main, probe, requestsTo, shot, sleep } from './e2e-inspect-logs-lib.mjs'

const home = process.env.DSH_LAYERFS_HOME || join(cfg.devDir, 'layerfs-home')
const REASON = 'Show in Files is not available: this LayerFS build cannot list a machine\'s files.'

await main('e2e-inspect-observe-nofiles', async ({ run, page }) => {
  await run.row('L4', 'without machine.files, "Show in Files" is replaced by its reason; the command stays', async (t) => {
    const view = await probe(page, 'GET', '/api/machines?fresh=1')
    if (!view.ok) throw new Error(`GET /api/machines: ${view.status} ${view.code}`)
    const f = view.body.features ?? {}
    if (!f.leftovers) throw new NotRun('this server\'s CLI has no doctor.fix: there are no leftovers to show')
    if (f.inspect?.machineFiles) throw new NotRun('this server\'s CLI has machine.files: the link is offered (e2e-inspect-observe-doctor.mjs S4)')
    const r = spawnSync(cfg.cli, ['doctor'], { env: { ...process.env, LAYERFS_HOME: home, ...(cfg.standin ? { LFS_INSPECT_DIR: cfg.standin } : {}) }, encoding: 'utf8', timeout: 30000 })
    const left = (JSON.parse(r.stdout).findings ?? []).filter((x) => x.leftover)
    if (!left.length) throw new NotRun('`layerfs doctor` reports no leftover on this home')
    await page.locator('header[aria-label="Center navigation"]').getByRole('button', { name: /^Health\b/ }).first().click()
    await page.getByRole('region', { name: 'Health' }).first().waitFor({ timeout: 20000 })
    await page.locator('[data-storage-page]:visible [data-leftovers]').first().waitFor({ timeout: 20000 })
    const rows = await page.evaluate(() => [...[...document.querySelectorAll('[data-storage-page]')].find((e) => e.offsetParent).querySelectorAll('[data-leftover]')].map((el) => ({
      id: el.getAttribute('data-leftover'), command: el.querySelector('[data-leftover-fix] code')?.textContent ?? null, reportOnly: !!el.querySelector('[data-leftover-report-only]'),
      noFiles: el.querySelector('[data-leftover-files]')?.getAttribute('data-leftover-files') ?? null, reason: el.querySelector('[data-leftover-files]')?.textContent ?? null,
      links: [...el.querySelectorAll('button, a')].filter((b) => /Show in Files/.test(b.textContent)).length,
    })))
    t.check(rows.length === left.length, `every leftover is still a row (${rows.length} of ${left.length})`)
    t.check(rows.every((x) => x.links === 0), `no row has a "Show in Files" link or button (${rows.filter((x) => x.links).length})`)
    t.check(rows.every((x) => x.noFiles === 'unavailable' && x.reason === REASON), `each says why instead ("${rows[0]?.reason}")`)
    for (const l of left) {
      const row = rows.find((x) => x.id === l.leftover.id)
      if (l.leftover.fixable === false) t.check(row?.command === null && row.reportOnly, `${l.leftover.id}: reported only, as before`)
      else t.check(row?.command === `layerfs doctor fix ${l.leftover.id}`, `${l.leftover.id}: its command is still there to copy`)
    }
    await shot(page, 'observe-nofiles-health')
    await jump(page, cfg.machineTitle)
    await sleep(1500)
    t.check(!(await hasTab(page, 'Files')), 'the machine page has no Files tab to open')
    const asked = await requestsTo(page, /\/api\/machines\/[^/]+\/files\b/)
    t.check(asked.length === 0, `no machine files route was asked (${asked.length})`)
  })
})
