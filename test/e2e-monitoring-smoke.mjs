#!/usr/bin/env node
// Smoke test of a private side server for the Machine and Sandbox monitoring work
// (layerfs-project #179): the LayerFS Center opens, its Machines tab lists the
// built-in machines (native and docker), and the native machine's page opens. Read only.
//
//   DSH_LAYERFS_DEV_DIR=$PWD/.dev-m179 DSH_LAYERFS_CLI=<pinned cli> node test/e2e-monitoring-smoke.mjs [--shots <dir>] [--headed]
//
// Fails on: a missing page part, any console or page error, a host request that
// answers 4xx/5xx or fails in transport, and any difference in the private LayerFS
// home between the tools/lfs-check.mjs snapshots taken before and after (a write
// call, a new Sandbox, mount, doctor finding or daemon log error).
// DSH_LAYERFS_CLI must name the CLI the server pins: lfs-check falls back to the
// newest runtime in ~/.layerfs when it is unset, which these runs must not read.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDev } from '../tools/e2e-lib.mjs'
import { diff, formatDiff, snapshot } from '../tools/lfs-check.mjs'

const argv = process.argv.slice(2)
const opt = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback }
const devDir = process.env.DSH_LAYERFS_DEV_DIR
if (!devDir || !process.env.DSH_LAYERFS_CLI) { console.error('smoke: set DSH_LAYERFS_DEV_DIR and DSH_LAYERFS_CLI (the side server\'s dev dir and pinned CLI)'); process.exit(2) }
const shots = opt('--shots', join(devDir, 'shots'))
mkdirSync(shots, { recursive: true })

const failures = []
const fail = (message) => { failures.push(message); console.error(`FAIL ${message}`) }

const before = await snapshot(devDir)
const { browser, page, logs } = await openDev({ headless: !argv.includes('--headed') })
page.setDefaultTimeout(15000)
try {
  await page.waitForFunction(() => window.__dshLayerfs, null, { timeout: 30000 })
  // Record every host request the page makes (call goes through op, so each is seen once per kind).
  await page.evaluate(() => {
    const rec = window.__smoke = { calls: [] }
    const api = window.__dshLayerfs
    const track = (entry, run) => {
      rec.calls.push(entry)
      return run().then((value) => { entry.status = 'ok'; return value }, (error) => {
        entry.status = typeof error?.status === 'number' ? error.status : 0
        entry.code = error?.code ?? null
        entry.message = String(error?.message ?? error).slice(0, 200)
        throw error
      })
    }
    const call = api.call, op = api.op
    api.call = (method, path, body) => track({ kind: 'call', what: `${method} ${path}` }, () => call(method, path, body))
    api.op = (name, args) => track({ kind: 'op', what: name }, () => op(name, args))
  })

  const bar = page.locator('header[aria-label="Center navigation"]')
  const editor = () => page.locator('[data-storage-page]:visible').first()
  await page.getByRole('navigation', { name: 'Global panels' }).getByRole('button', { name: 'LayerFS', exact: true }).first().click()
  await bar.waitFor()

  // Overview → Machines tab: the native machine is listed.
  await editor().getByRole('tab', { name: /^Machines\b/ }).first().click()
  // The machines table has a row for the native machine ("LayerFS Home") and one for docker.
  for (const name of ['native', 'docker']) await editor().locator(`[data-machine="${name}"]`).first().waitFor().catch(() => fail(`Machines tab: no ${name} machine row`))
  await page.screenshot({ path: join(shots, 'smoke-machines-tab.png') })

  // The native machine's page (Jump to → LayerFS Home).
  await bar.getByRole('button', { name: /^Jump to/ }).click()
  await page.getByRole('combobox', { name: 'Jump to' }).fill('LayerFS Home')
  await page.getByRole('listbox', { name: 'Jump to' }).getByRole('option').filter({ has: page.locator('span', { hasText: /^LayerFS Home$/ }) }).first().click()
  await editor().getByRole('heading', { level: 1 }).first().waitFor().catch(() => fail('machine page: no heading'))
  await page.waitForTimeout(1500)
  await page.screenshot({ path: join(shots, 'smoke-machine-native.png') })

  const calls = await page.evaluate(() => window.__smoke.calls)
  for (const c of calls) if (c.status !== 'ok' && c.status !== undefined) fail(`host ${c.kind} ${c.what} → ${c.status} ${c.code ?? ''} ${c.message ?? ''}`)
  console.log(`smoke: ${calls.length} host request(s) from the page`)
} catch (error) {
  fail(`${error?.stack ?? error}`)
  await page.screenshot({ path: join(shots, 'smoke-failure.png') }).catch(() => {})
} finally {
  await browser.close()
}

for (const line of logs) fail(`console ${line}`)
const state = diff(before, await snapshot(devDir))
console.log(formatDiff(state))
for (const f of state.failures) fail(`lfs-check ${f.kind}: ${f.message}`)
console.log(failures.length ? `smoke: ${failures.length} failure(s)` : 'smoke: ok (Machines tab, native machine page, no console errors, LayerFS home unchanged)')
process.exit(failures.length ? 1 : 0)
