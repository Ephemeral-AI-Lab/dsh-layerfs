#!/usr/bin/env node
// Call one dsh-layerfs operation through a real browser page of the dev server.
//   node tools/op.mjs <op> [json-args]      (http op: node tools/op.mjs http '{"method":"GET","path":"/api/machines"}')
import { chromium } from 'playwright-core'
import { readFileSync } from 'node:fs'
const [name, json = '{}'] = process.argv.slice(2)
import { devUrl } from './ui.mjs'
const url = devUrl()
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const page = await browser.newPage()
await page.addInitScript(() => { localStorage.setItem('dsh-layerfs:debug', '1') })
await page.goto(url, { waitUntil: 'networkidle' })
await page.waitForFunction(() => window.__dshLayerfs, null, { timeout: 30000 })
const out = await page.evaluate(async ([n, a]) => {
  try { return { ok: true, value: await window.__dshLayerfs.op(n, a) } } catch (e) { return { ok: false, code: e.code, message: e.message, detail: e.detail } }
}, [name, JSON.parse(json)])
console.log(JSON.stringify(out, null, 2))
await browser.close()
