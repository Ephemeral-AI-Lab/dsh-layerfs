#!/usr/bin/env node
// axe-core on the Worker log and Daemon log tabs (layerfs-project#178 matrix S5, log part):
// the tab bar and the log pane in each of its states (lines with a find match,
// a refused read over kept lines, an empty log) have no accessibility violation.
//
// axe runs on the open LayerFS page (`[data-storage-page]`). A violation inside
// the new parts (the log pane, the tab bar, a tab panel's own element) fails the
// row; one elsewhere on the page is reported as found, and does not.
//
//   DSH_LAYERFS_DEV_DIR=… DSH_LAYERFS_CLI=… INSPECT_SANDBOX=… [INSPECT_STANDIN_DIR=… | INSPECT_HOOK=…] \
//     node test/e2e-inspect-logs-axe.mjs
// Environment and what every row also checks: test/e2e-inspect-logs-lib.mjs.
import { createRequire } from 'node:module'
import { NotRun, driver, editor, main, needSandbox, newTag, offered, openQuiet, pane, seqsOf, shot, showLog, targets, waitPane } from './e2e-inspect-logs-lib.mjs'

const axePath = createRequire(import.meta.url).resolve('axe-core/axe.min.js')

/** Run axe on the open page; each violation node says whether it is in a new part. */
async function axe(page) {
  if (!(await page.evaluate(() => !!window.axe))) await page.addScriptTag({ path: axePath })
  return page.evaluate(async () => {
    const root = [...document.querySelectorAll('[data-storage-page]')].find((e) => e.offsetParent)
    const result = await window.axe.run(root, { resultTypes: ['violations'] })
    return {
      version: window.axe.version,
      passes: result.passes.length,
      violations: result.violations.map((v) => ({
        id: v.id, impact: v.impact, help: v.help,
        nodes: v.nodes.map((n) => {
          const el = document.querySelector(n.target[0])
          const fresh = !!el && (!!el.closest('[data-log]') || !!el.closest('[role=tablist]') || el.getAttribute('role') === 'tabpanel')
          return { target: n.target.join(' '), html: n.html.slice(0, 160), fresh, summary: (n.failureSummary ?? '').replace(/\s+/g, ' ').slice(0, 200) }
        }),
      })),
    }
  })
}

await main('e2e-inspect-logs-axe', async ({ run, page }) => {
  await run.row('S5-axe', 'axe on the Worker log and Daemon log tabs (S5, log part)', async (t) => {
    needSandbox()
    const has = await offered(page)
    if (!has.sandboxLog) throw new NotRun('the pinned CLI has no logs.sandbox: there is no log tab to check')
    const elsewhere = new Map()
    let version = ''
    const scan = async (state) => {
      const result = await axe(page)
      version = result.version
      let fresh = 0
      for (const v of result.violations) {
        for (const n of v.nodes) {
          if (n.fresh) { fresh++; t.check(false, `${state}: ${v.id} (${v.impact}) ${v.help} — ${n.target} — ${n.html} — ${n.summary}`) } else elsewhere.set(`${v.id} ${n.target}`, `${v.id} (${v.impact}) ${v.help} — ${n.target} — ${n.html}`)
        }
      }
      t.note(`${state}: ${fresh} violations in the new parts, ${result.violations.reduce((n, v) => n + v.nodes.filter((x) => !x.fresh).length, 0)} elsewhere on the page (${result.passes} rules passed)`)
    }
    const sb = targets.sandbox, tag = newTag('axe')

    // the Sandbox page's tab bar, on Workspaces
    await openQuiet(page, sb)
    driver.fill('sandbox', sb.name, 80, tag)
    await editor(page).getByRole('tab', { name: 'Workspaces', exact: true }).click()
    await editor(page).getByRole('button', { name: 'New workspace', exact: true }).first().waitFor({ timeout: 20000 }).catch(() => {})
    await scan('Sandbox page, Workspaces tab')

    // Daemon log: lines, a find with matches
    await showLog(page, sb)
    let got = await waitPane(page, (s) => s.state === 'ready' && seqsOf(s.rows, tag).length === 80)
    t.check(got.ok, 'the daemon log is shown')
    await scan('Daemon log, following')
    await pane(page).getByRole('textbox', { name: 'Find in loaded lines' }).fill(`${tag} 00004`)
    await pane(page).getByText('1 of 10', { exact: true }).waitFor({ timeout: 3000 }).catch(() => t.check(false, 'find: no "1 of 10"'))
    await scan('Daemon log, find with 10 matches')
    await shot(page, 'inspect-logs-axe-find')
    await pane(page).getByRole('textbox', { name: 'Find in loaded lines' }).press('Escape')

    // Daemon log: a refused read over kept lines
    try {
      driver.refuse('sandbox', sb.name, 'Unavailable', 'the daemon did not answer')
      got = await waitPane(page, (s) => s.stale === 'Unavailable', { timeout: 15000 })
      t.check(got.ok, 'the refusal is shown')
      await scan('Daemon log, refused read over kept lines')
      driver.unrefuse('sandbox', sb.name)
    } catch (error) { if (!(error instanceof NotRun)) throw error; t.note(`refused state not scanned — ${error.message}`) }

    // Daemon log: empty
    try {
      await openQuiet(page, sb)
      driver.truncate('sandbox', sb.name)
      await showLog(page, sb)
      got = await waitPane(page, (s) => s.state === 'ready' && s.lines === 0)
      t.check(got.ok, 'the empty log is shown')
      await scan('Daemon log, empty')
    } catch (error) { if (!(error instanceof NotRun)) throw error; t.note(`empty state not scanned — ${error.message}`) }

    // the machine page: Overview with the tab bar, then the Worker log
    if (has.machineLog) {
      const m = targets.machine, mtag = newTag('axem')
      await openQuiet(page, m)
      driver.fill('machine', m.name, 80, mtag)
      await scan('Machine page, Overview tab')
      await showLog(page, m)
      got = await waitPane(page, (s) => s.state === 'ready' && seqsOf(s.rows, mtag).length === 80)
      t.check(got.ok, 'the worker log is shown')
      await scan('Worker log, following')
    } else t.note(`machine ${targets.machine.name} offers no worker log: its tab was not scanned`)
    t.note(`axe-core ${version}`)
    for (const line of elsewhere.values()) t.note(`elsewhere on the page (not the new parts): ${line}`)
  })
})
