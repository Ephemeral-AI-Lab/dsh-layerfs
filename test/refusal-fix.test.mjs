// A refusal's `fix` line as the page's one action (review UR bug 1): which
// lines run, and the host call each makes (the route the page's own button takes).
//   node --test test/refusal-fix.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = new URL('..', import.meta.url).pathname
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-refusal-fix-'))
await build({
  stdin: { contents: "export { fixCall } from './src/client/storage/fix-call.ts'\nexport { runnableFix } from './src/shared/doctor.ts'\n", resolveDir: root, loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'fix.mjs'), absWorkingDir: root, target: 'node24', logLevel: 'warning',
})
const M = await import(pathToFileURL(join(out, 'fix.mjs')).href)
process.on('exit', () => rmSync(out, { recursive: true, force: true }))

test('each runnable fix line makes the host call of the page\'s own button', async () => {
  const sent = []
  const api = { call: async (...a) => { sent.push(a); return {} }, op: async (...a) => { sent.push(['op', ...a]); return {} } }
  for (const line of [
    'layerfs machine start dev', 'layerfs machine stop dev', 'layerfs machine stop dev && layerfs machine start dev',
    'layerfs machine prune dev --unused', 'layerfs store compact shop', 'layerfs project delete shop/web',
    'layerfs backup create shop r2', 'layerfs home init',
  ]) await M.fixCall(api, M.runnableFix(line))
  assert.deepEqual(sent, [
    ['POST', '/api/machines/dev/start', {}],
    ['POST', '/api/machines/dev/stop', {}],
    ['POST', '/api/machines/dev/restart', {}],
    ['POST', '/api/machines/dev/prune-images', { unused: true }],
    ['POST', '/api/stores/shop/compact', {}],
    ['DELETE', '/api/projects/shop%2Fweb'],
    ['POST', '/api/stores/shop/backup', { bucket: 'r2' }],
    ['op', 'setup.convert'],
  ])
})
