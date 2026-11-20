#!/usr/bin/env node
// Run host operations in one dev page, in order: node tools/guide/calls.mjs '[{"method":"GET","path":"/api/storage"},{"wait":2000},{"op":"session.place","args":{}}]'
// node calls.mjs '<json array of {method,path,body}>' : run http ops in one page, sequentially
import { chromium } from 'playwright-core'
import { devUrl } from '../ui.mjs'
const list = JSON.parse(process.argv[2])
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const page = await browser.newPage()
await page.addInitScript(() => { localStorage.setItem('dsh-layerfs:debug', '1') })
await page.goto(devUrl(), { waitUntil: 'networkidle' })
await page.waitForFunction(() => window.__dshLayerfs, null, { timeout: 30000 })
for (const req of list) {
  if (req.wait) { await page.waitForTimeout(req.wait); continue }
  const out = await page.evaluate(async (r) => { try { return { ok: true, value: await window.__dshLayerfs.op(r.op ?? 'http', r.op ? r.args : r) } } catch (e) { return { ok: false, code: e.code, message: e.message } } }, req)
  console.log(req.method ?? req.op, req.path ?? '', JSON.stringify(out).slice(0, 300))
}
await browser.close()
