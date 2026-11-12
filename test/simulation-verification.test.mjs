import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const root = new URL('..', import.meta.url).pathname
const out = mkdtempSync(join(root, 'lib', '.test-simulation-verify-'))
await build({ absWorkingDir: root, entryPoints: ['src/host/simulations/verify.ts'], outfile: join(out, 'verify.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24', external: ['@deepseek-ai/*'] })
const { simulationVerificationQuery, verifySimulation } = await import(pathToFileURL(join(out, 'verify.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

test('workload verifier filters only exact bound archive branches and preserves pagination', async () => {
  const manifest = { store: 'fresh', project: 'billing', projectRef: 'fresh/billing-unique' }
  const journal = { records: [{ type: 'binding', sessionId: 'a-a' }] }
  const calls = []
  const query = simulationVerificationQuery(manifest, journal, async argv => {
    calls.push(argv)
    if (argv[0] !== 'branch') return { text: 'saved file' }
    const position = Number(argv[argv.indexOf('--page-pos') + 1])
    if (!position) return { items: [{ name: 'dsh.session.aa' }], has_more: true, next_page_pos: 1 }
    return { items: [{ name: 'main' }, { name: 'dsh.session.unowned' }, { name: 'release' }], has_more: false }
  })
  assert.deepEqual(await query(['branch', 'list', 'fresh/billing', '--page-size', '2', '--page-pos', '0']), { items: [{ name: 'main' }, { name: 'dsh.session.unowned' }], has_more: true, next_page_pos: 2 })
  assert.deepEqual(await query(['branch', 'list', 'fresh/billing', '--page-size', '2', '--page-pos', '2']), { items: [{ name: 'release' }], has_more: false, next_page_pos: null })
  assert.equal(calls.length, 2)
  await query(['file', 'read', 'fresh/billing', 'main', '/invoice.md'])
  assert.equal(calls[2][2], manifest.projectRef)
})
test('verification cannot begin with an unconfirmed workload mutation', async () => {
  let queried = false
  await assert.rejects(verifySimulation({}, { steps: [{ key: 'unfinished' }] }, { receipts: {}, append: async () => {} }, async () => { queried = true }), /incomplete simulation step/)
  assert.equal(queried, false)
})
