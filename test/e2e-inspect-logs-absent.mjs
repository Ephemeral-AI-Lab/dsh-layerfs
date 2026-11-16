#!/usr/bin/env node
// A pinned CLI without the log calls (layerfs-project#178 matrix):
//   F6  the pinned CLI lacks the calls: the log tabs and their links are hidden, and no request fails
//
// Run it against a side server whose pinned CLI has no `logs machine` /
// `logs sandbox` (a build before #178 step 1, or test/fixtures/cli-hide-calls.mjs
// with LFS_HIDE_CALLS=logs.machine,logs.sandbox in front of one that has them).
// On a server whose CLI has the calls the row is NOT_RUN.
//
//   DSH_LAYERFS_DEV_DIR=… DSH_LAYERFS_CLI=… [INSPECT_SANDBOX=…] node test/e2e-inspect-logs-absent.mjs
// Environment and what every row also checks: test/e2e-inspect-logs-lib.mjs.
import { NotRun, cfg, editor, hasTab, jump, main, offered, pane, probe, requestsTo, shot, sleep, spawns, spawnsSince, tabs, targets } from './e2e-inspect-logs-lib.mjs'

const enc = encodeURIComponent

await main('e2e-inspect-logs-absent', async ({ run, page }) => {
  await run.row('F6', 'the pinned CLI lacks the calls: parts hidden, no 4xx/5xx', async (t) => {
    const has = await offered(page)
    if (has.inspect.machineLog || has.inspect.sandboxLog) throw new NotRun(`this server's CLI has the log calls (${JSON.stringify(has.inspect)}): run the row on a server pinned to a CLI without them`)
    t.check(has.inspect.machineLog === false && has.inspect.sandboxLog === false && has.inspect.files === false && has.inspect.machineFiles === false, `the machines view says which monitoring calls the CLI has: ${JSON.stringify(has.inspect)}`)

    await jump(page, cfg.machineTitle)
    await sleep(2500)
    t.check(!(await hasTab(page, 'Worker log')) && !(await hasTab(page, 'Overview')), `machine page: no tabs (${JSON.stringify(await tabs(page))})`)
    t.check((await editor(page).getByRole('button', { name: 'Open worker log', exact: true }).count()) === 0, 'machine page: no "Open worker log"')
    t.check((await pane(page).count()) === 0, 'machine page: no log pane')
    await shot(page, 'inspect-logs-f6-machine')

    if (cfg.sandbox) {
      await jump(page, targets.sandbox.title)
      await editor(page).getByRole('tab', { name: 'Workspaces', exact: true }).click()
      await editor(page).getByRole('button', { name: 'New workspace', exact: true }).first().waitFor({ timeout: 20000 }).catch(() => t.check(false, 'Sandbox page: the terminals do not render'))
      await sleep(2500)
      t.check(!(await hasTab(page, 'Daemon log')), `Sandbox page: no Daemon log tab (${JSON.stringify(await tabs(page))})`)
      t.check((await editor(page).getByRole('button', { name: 'Open daemon log', exact: true }).count()) === 0, 'Sandbox page: no "Open daemon log"')
      t.check((await pane(page).count()) === 0, 'Sandbox page: no log pane')
      await shot(page, 'inspect-logs-f6-sandbox')
    } else t.note('INSPECT_SANDBOX is not set: the Sandbox page was not opened')

    const asked = await requestsTo(page, /\/log\b/)
    t.check(asked.length === 0, `the page asked no log route (${asked.length})`)
    if (spawns()) t.check(spawnsSince(0).inspect.length === 0, `no monitoring read became a CLI process (${spawnsSince(0).inspect.length})`)
    // asked directly, the routes say the call is missing (the page never asks)
    const direct = await probe(page, 'GET', `/api/machines/${enc(cfg.machine)}/log`)
    t.check(!direct.ok && direct.status === 501 && direct.code === 'Unsupported', `the route itself answers 501 Unsupported when asked (${direct.status} ${direct.code})`)
    if (cfg.sandbox) {
      const sb = await probe(page, 'GET', `/api/sandboxes/${enc(cfg.sandbox)}/log`)
      t.check(!sb.ok && sb.status === 501 && sb.code === 'Unsupported', `…and so does the Sandbox's (${sb.status} ${sb.code})`)
    }
  })
})
