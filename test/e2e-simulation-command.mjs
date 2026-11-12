#!/usr/bin/env node
// Public /simulation command proof; uses full default profile and stops owned
// roots after confirming only the initiating surface navigates.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { openDev, runTurn } from '../tools/e2e-lib.mjs'
const { browser, page, logs } = await openDev()
const op = (name, args = {}) => page.evaluate(([name, args]) => window.__dshLayerfs.op(name, args), [name, args])
const selected = () => page.evaluate(() => window.__dshLayerfs.selectedSessionId())
let project
try {
  const origin = await runTurn(page, { message: 'Check the current folder.', expect: /echo: Check the current folder\./ })
  assert.ok(origin.ok, origin.error)
  const input = page.locator('[data-composer-input=true]').first()
  await input.click()
  await page.keyboard.insertText('/simulation --project design --machine native')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await page.waitForFunction((source) => {
    const current = window.__dshLayerfs?.selectedSessionId()
    return current && current !== source
  }, origin.sessionId, { timeout: 60000 })
  const sessionId = await selected()
  const script = await op('simulation.script', { sessionId })
  assert.ok(script.script?.runId, 'the host command opens its project conversation')
  project = (await op('session.place', { sessionId })).place.project
  assert.ok(project)
  await page.getByRole('button', { name: /^Stop(?:\s|$)/ }).first().waitFor()
  await page.getByRole('button', { name: /^Stop(?:\s|$)/ }).first().click()
  console.log('Public /simulation command opened its ordinary project session through the initiating surface.')
  assert.deepEqual(logs.filter(line => line.startsWith('[pageerror]')), [])
} catch (error) {
  await page.screenshot({ path: join(process.env.DSH_LAYERFS_DEV_DIR ?? '.dev', 'simulation-command-failure.png'), fullPage: true }).catch(() => {})
  console.error((await page.locator('body').innerText()).slice(-4000))
  console.error(logs.join('\n'))
  throw error
} finally {
  if (project) {
    const rows = (await op('sessions.list', { project })).sessions
    for (const row of rows) await op('simulation.stop', { sessionId: row.sessionId }).catch(() => {})
  }
  await browser.close()
}
