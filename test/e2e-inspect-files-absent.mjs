#!/usr/bin/env node
// A pinned CLI without the files calls and without the monitoring fields
// (layerfs-project#178 matrix):
//   F6  the pinned CLI lacks the calls: the Files tabs are hidden, the Sandbox page shows no part
//       that needs a missing field, and no request fails
//
// Run it against a side server whose pinned CLI has no `machine files` /
// `sandbox files` (a build before #178 step 3; the log calls may be there or
// not). On a server whose CLI has the calls the row is NOT_RUN.
//
//   DSH_LAYERFS_DEV_DIR=… DSH_LAYERFS_CLI=… [INSPECT_SANDBOX=…] node test/e2e-inspect-files-absent.mjs
// Environment and what every row also checks: test/e2e-inspect-logs-lib.mjs.
import { NotRun, cfg, editor, hasTab, jump, main, probe, requestsTo, shot, sleep, spawns, spawnsSince, tabs, targets } from './e2e-inspect-logs-lib.mjs'

const enc = encodeURIComponent

await main('e2e-inspect-files-absent', async ({ run, page }) => {
  await run.row('F6', 'the pinned CLI lacks the files calls and the fields: parts hidden, no 4xx/5xx', async (t) => {
    const view = await probe(page, 'GET', '/api/machines')
    if (!view.ok) throw new Error(`GET /api/machines: ${view.status} ${view.code}`)
    const inspect = view.body.features?.inspect ?? {}
    if (inspect.files || inspect.machineFiles) throw new NotRun(`this server's CLI has the files calls (${JSON.stringify(inspect)}): run the row on a server pinned to a CLI without them`)
    t.check(inspect.files === false && inspect.machineFiles === false, `the machines view says which monitoring calls the CLI has: ${JSON.stringify(inspect)}`)

    await jump(page, cfg.machineTitle)
    await sleep(2500)
    t.check(!(await hasTab(page, 'Files')), `machine page: no Files tab (${JSON.stringify(await tabs(page))})`)
    t.check((await editor(page).locator('[data-files]').count()) === 0, 'machine page: no Files pane')
    await shot(page, 'inspect-files-f6-machine')

    if (cfg.sandbox) {
      await jump(page, targets.sandbox.title)
      await editor(page).getByRole('tab', { name: 'Workspaces', exact: true }).click()
      await editor(page).getByRole('button', { name: 'New workspace', exact: true }).first().waitFor({ timeout: 20000 }).catch(() => t.check(false, 'Sandbox page: the terminals do not render'))
      await sleep(2500)
      t.check(!(await hasTab(page, 'Files')), `Sandbox page: no Files tab (${JSON.stringify(await tabs(page))})`)
      t.check((await editor(page).locator('[data-files]').count()) === 0, 'Sandbox page: no Files pane')
      // the fields are detected by presence
      const info = await probe(page, 'GET', `/api/sandboxes/${enc(cfg.sandbox)}`)
      const ws = info.body?.workspaces ?? []
      const absent = info.ok && !('workspaceCapacity' in info.body) && ws.every((w) => !('running' in w) && !('overlayBytes' in w))
      if (absent) {
        t.check(true, 'sandbox.get of this CLI has no workspace_capacity, running or overlay_bytes')
        const count = await editor(page).locator('[data-ws-count]').first().textContent().catch(() => null)
        t.check(/\bof 16\b/.test(count ?? ''), `"n of N" falls back to 16 ("${count}")`)
        t.check((await editor(page).locator('[data-also-running]').count()) === 0 && (await editor(page).locator('[data-running-summary]').count()) === 0, 'no "also running" line and no running summary')
        const tips = await editor(page).locator('[data-ws-changes]').evaluateAll((els) => els.map((e) => e.getAttribute('title')))
        t.check(tips.every((x) => !x), `the changes chips have no overlay tooltip (${JSON.stringify(tips)})`)
      } else t.note('this CLI\'s sandbox.get has the monitoring fields: their absence was not checked')
      await shot(page, 'inspect-files-f6-sandbox')
    } else t.note('INSPECT_SANDBOX is not set: the Sandbox page was not opened')

    const asked = await requestsTo(page, /\/files\b/)
    t.check(asked.length === 0, `the page asked no files route (${asked.length})`)
    if (spawns()) t.check(spawnsSince(0).inspect.filter((s) => s.argv[1] === 'files').length === 0, 'no files read became a CLI process')
    // asked directly, the routes say the call is missing (the page never asks)
    const direct = await probe(page, 'GET', `/api/machines/${enc(cfg.machine)}/files`)
    t.check(!direct.ok && direct.status === 501 && direct.code === 'Unsupported', `the route itself answers 501 Unsupported when asked (${direct.status} ${direct.code})`)
    if (cfg.sandbox) {
      const sb = await probe(page, 'GET', `/api/sandboxes/${enc(cfg.sandbox)}/files`)
      t.check(!sb.ok && sb.status === 501 && sb.code === 'Unsupported', `…and so does the Sandbox's (${sb.status} ${sb.code})`)
    }
  })
})
