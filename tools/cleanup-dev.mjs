#!/usr/bin/env node
// Remove test Stores/projects (names starting with e2e or imp) from a dev
// server's LayerFS home through the real host API, which also closes their
// session Sandboxes and drops their DSH workspaces.
//   DSH_LAYERFS_DEV_DIR=<dir> node tools/cleanup-dev.mjs [prefix...]
import { openDev } from './e2e-lib.mjs'
const prefixes = process.argv.slice(2).length ? process.argv.slice(2) : ['e2e', 'imp']
const { browser, page } = await openDev()
await page.waitForFunction(() => window.__dshLayerfs, null, { timeout: 30000 })
const http = (method, path) => page.evaluate(async ([m, p]) => window.__dshLayerfs.op('http', { method: m, path: p }), [method, path])
const projects = (await http('GET', '/api/projects')).body ?? []
const stores = new Set()
for (const p of projects) {
  const store = p.key.split('/')[0]
  if (!prefixes.some((x) => store.startsWith(x))) continue
  stores.add(store)
  const r = await http('DELETE', `/api/projects/${encodeURIComponent(p.key)}`)
  console.log('project', p.key, r.status, r.status >= 300 ? JSON.stringify(r.body) : '')
}
const view = (await http('GET', '/api/storage')).body
for (const s of JSON.stringify(view).match(/"name":"(e2e|imp)[a-z0-9]+"/g) ?? []) stores.add(s.slice(8, -1))
for (const store of stores) {
  const r = await http('DELETE', `/api/stores/${encodeURIComponent(store)}?confirm=${encodeURIComponent(store)}`)
  console.log('store', store, r.status, r.status >= 300 ? JSON.stringify(r.body).slice(0, 200) : '')
}
await browser.close()
