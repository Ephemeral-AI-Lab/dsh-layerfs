#!/usr/bin/env node
// Drive the dev web UI with system Chrome (playwright-core) and script interactions.
//   node tools/shot.mjs <url> <out.png> [--size 1280x820] [--steps steps.mjs]
// A steps module exports `default async (page) => {}`.
import { chromium } from 'playwright-core'
import { pathToFileURL } from 'node:url'
const [url, out = '/tmp/dsh-layerfs.png', ...rest] = process.argv.slice(2)
const opt = (n, d) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : d }
const [w, h] = opt('--size', '1280x820').split('x').map(Number)
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const page = await browser.newPage({ viewport: { width: w, height: h } })
const logs = []
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`) })
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
await page.goto(url, { waitUntil: 'networkidle' }).catch((e) => logs.push(`[goto] ${e.message}`))
await page.waitForTimeout(Number(opt('--wait', '2500')))
const steps = opt('--steps')
let failed = false
if (steps) {
  try { await (await import(pathToFileURL(steps).href)).default(page, { logs }) } catch (e) { failed = true; logs.push(`[steps] ${e.stack ?? e}`) }
}
await page.screenshot({ path: out })
console.log(logs.join('\n') || 'no console errors')
await browser.close()
process.exit(failed ? 1 : 0)
