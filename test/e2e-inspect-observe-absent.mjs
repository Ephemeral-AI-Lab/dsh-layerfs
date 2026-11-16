#!/usr/bin/env node
// A pinned CLI without machine.stats, `sandbox list --live`, the daemon and usage fields and
// doctor.fix (layerfs-project#164 and #180, in the manner of #178's F6):
//   A1  the Machines pages, the Sandbox page and the Doctor page are as before: no observed part,
//       no leftovers section, no stats request, `sandbox list` without `--live`, and no request fails
//
// Run it against a side server whose pinned CLI lacks the calls (a build before #164).
// On a server whose CLI has them the row is NOT_RUN.
//
//   DSH_LAYERFS_DEV_DIR=… DSH_LAYERFS_CLI=… [INSPECT_SANDBOX=…] node test/e2e-inspect-observe-absent.mjs
// Environment and what every row also checks: test/e2e-inspect-logs-lib.mjs.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NotRun, cfg, editor, jump, main, probe, requestsTo, shot, sleep } from './e2e-inspect-logs-lib.mjs'

const enc = encodeURIComponent
const bar = (page) => page.locator('header[aria-label="Center navigation"]')
const NEW_PARTS = '[data-disk], [data-resources], [data-worker-line], [data-stats-cpus], [data-stats-memory], [data-stats-disk], [data-stats-worker], [data-stats-at], [data-stats-live], [data-stats-stores], [data-stats-stale], [data-not-observed], [data-here-down], [data-here-unknown], [data-live], [data-daemon-process], [data-sandbox-usage], [data-leftovers], [data-leftover]'
const parts = (page) => page.evaluate((sel) => { const root = [...document.querySelectorAll('[data-storage-page]')].find((e) => e.offsetParent); return { n: root.querySelectorAll(sel).length, text: root.innerText, all: root.textContent } }, NEW_PARTS)
const callsFile = join(process.env.DSH_LAYERFS_HOME || join(cfg.devDir, 'layerfs-home'), 'trace', 'calls.jsonl')
const callLines = () => { try { return readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return {} } }) } catch { return [] } }

await main('e2e-inspect-observe-absent', async ({ run, page }) => {
  await run.row('A1', 'the pinned CLI lacks machine.stats, sandbox.list live, the usage fields and doctor.fix: every page as before, no 4xx/5xx', async (t) => {
    const view = await probe(page, 'GET', '/api/machines?fresh=1')
    if (!view.ok) throw new Error(`GET /api/machines: ${view.status} ${view.code}`)
    const f = view.body.features ?? {}
    if (f.inspect?.machineStats || f.sandboxLive || f.leftovers) throw new NotRun(`this server's CLI has some of the calls (${JSON.stringify({ machineStats: f.inspect?.machineStats, sandboxLive: f.sandboxLive, leftovers: f.leftovers })}): run the row on a server pinned to a CLI without them`)
    t.check(f.inspect?.machineStats === false && f.sandboxLive === false && f.leftovers === false, `the machines view says the CLI has none of them (${JSON.stringify({ machineStats: f.inspect?.machineStats, sandboxLive: f.sandboxLive, leftovers: f.leftovers })})`)
    t.check((view.body.sandboxes ?? []).every((b) => !('live' in b) && !('liveReason' in b)), `no Sandbox of the view carries \`live\` (${(view.body.sandboxes ?? []).length} Sandboxes)`)
    const before = callLines().length

    // the machine page
    await jump(page, cfg.machineTitle)
    await sleep(2500)
    let p = await parts(page)
    t.check(p.n === 0, `machine page: no observed part (${p.n})`)
    t.check(/Free disk/i.test(p.text) && !/Not observed/i.test(p.all), 'machine page: the disk fact is "Free disk" as before, and nothing reads "Not observed"')
    t.check(!/Created with|Daemons running|Observed/.test(p.all), 'machine page: the Details card has no observed or "Created with" fact')
    await shot(page, 'observe-absent-machine')

    // the board
    const root = bar(page).getByRole('navigation', { name: 'Location' }).getByRole('button', { name: 'Center', exact: true })
    if (await root.count()) await root.first().click()
    await editor(page).getByRole('tab', { name: /^Machines\b/ }).first().click()
    await editor(page).locator('[data-machine]').first().waitFor()
    await sleep(2500)
    p = await parts(page)
    t.check(p.n === 0 && !/Not observed|Daemon not running/i.test(p.all), `board: no observed part and no "Not observed" (${p.n})`)
    await shot(page, 'observe-absent-board')

    // the Sandbox page
    if (cfg.sandbox) {
      await jump(page, cfg.sandbox)
      await editor(page).getByRole('tab', { name: 'Workspaces', exact: true }).click()
      await editor(page).getByRole('button', { name: 'New workspace', exact: true }).first().waitFor({ timeout: 20000 }).catch(() => t.check(false, 'Sandbox page: the terminals do not render'))
      await sleep(2000)
      p = await parts(page)
      const info = await probe(page, 'GET', `/api/sandboxes/${enc(cfg.sandbox)}`)
      t.check(info.ok && !('daemon' in info.body) && !('usage' in info.body) && !('usageReason' in info.body), 'sandbox.get of this CLI has no daemon, usage or usage_reason')
      t.check(p.n === 0 && !/\bUsage\b|process ended|process not observed|not measured/.test(p.all), `Sandbox page: no daemon process part and no usage line (${p.n})`)
      await shot(page, 'observe-absent-sandbox')
    } else t.note('INSPECT_SANDBOX is not set: the Sandbox page was not opened')

    // the Doctor page
    await bar(page).getByRole('button', { name: /^Health\b/ }).first().click()
    await page.getByRole('region', { name: 'Health' }).first().waitFor({ timeout: 20000 })
    await sleep(2500)
    p = await parts(page)
    const doctor = await probe(page, 'GET', '/api/doctor')
    t.check(doctor.ok && !('leftovers' in doctor.body) && (doctor.body.findings ?? []).every((x) => !('leftover' in x)), 'GET /api/doctor has no `leftovers` and no finding with a `leftover`')
    t.check(p.n === 0 && !/Left by interrupted operations|doctor fix|Show in Files/.test(p.all), `Health page: no leftovers section, no fix command, no "Show in Files" (${p.n})`)
    await shot(page, 'observe-absent-health')

    const asked = await requestsTo(page, /\/stats\b/)
    t.check(asked.filter((c) => /\/api\/machines\//.test(c.what)).length === 0, `the pages asked no machine stats route (${asked.filter((c) => /\/api\/machines\//.test(c.what)).length})`)
    const added = callLines().slice(before)
    const lists = added.filter((l) => l.argv?.[0] === 'sandbox' && l.argv?.[1] === 'list')
    t.check(lists.every((l) => !l.argv.some((a) => String(a).startsWith('--live'))), `\`sandbox list\` was called without \`--live\` (${lists.length} calls in the call log)`)
    t.check(!added.some((l) => (l.argv?.[0] === 'machine' && l.argv?.[1] === 'stats') || (l.argv?.[0] === 'doctor' && l.argv?.[1] === 'fix')), 'no `machine stats` and no `doctor fix` in the call log')
    // asked directly, the route says the call is missing (the page never asks)
    const direct = await probe(page, 'GET', `/api/machines/${enc(cfg.machine)}/stats`)
    t.check(!direct.ok && direct.status === 501 && direct.code === 'Unsupported', `the stats route itself answers 501 Unsupported when asked (${direct.status} ${direct.code})`)
  })
})
