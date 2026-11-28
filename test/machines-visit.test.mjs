// The Machines controller reads its view once per page visit: a panel focus
// on the way in joins the mount's read instead of starting the view twice,
// a return to the panel reads again, and the Refresh path bypasses the share.
//   node --test test/machines-visit.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-machines-visit-'))
await build({
  stdin: { contents: "export { MachinesController } from './src/client/machines/controller.ts'\n", resolveDir: root, loader: 'ts' },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  outfile: join(out, 'machines.mjs'),
  absWorkingDir: root,
  logLevel: 'warning',
})
const M = await import(pathToFileURL(join(out, 'machines.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** An api that records every call and answers the shapes the controller uses. */
function fakeApi() {
  const calls = []
  return {
    calls,
    connected: () => true,
    onEvent: () => () => {},
    call: async (method, path, body, options) => {
      calls.push({ kind: 'call', method, path, options })
      if (path.startsWith('/api/machines')) return { available: false, machines: [], sandboxes: [] }
      if (path === '/api/sandbox-creates') return { creations: [] }
      return {}
    },
    op: async (name, args, options) => {
      calls.push({ kind: 'op', name, options })
      return {}
    },
  }
}

const machineCalls = (calls) => calls.filter((call) => call.path === '/api/machines')

test('the machines view starts once for a visit, and a return reads again', async (t) => {
  // The deferred decoration runs at once where there is no frame loop.
  globalThis.requestAnimationFrame = (cb) => { cb(); return 1 }
  globalThis.requestIdleCallback = (cb) => { cb(); return 1 }
  t.after(() => { delete globalThis.requestAnimationFrame; delete globalThis.requestIdleCallback })

  const api = fakeApi()
  const controller = new M.MachinesController(api, () => true)
  t.after(() => controller.dispose())
  const release = controller.activate()
  await flush()
  assert.equal(machineCalls(api.calls).length, 1, 'the mount read the view once')
  assert.equal(machineCalls(api.calls)[0].options?.share, true, 'and shares it with a staggered surface')
  // The panel-focus subscription fires for this same visit: no second start.
  controller.refocus()
  await flush()
  assert.equal(machineCalls(api.calls).length, 1, 'the focus on the way in did not start the view twice')
  // Leaving the panel and coming back is a new visit.
  controller.hide()
  controller.refocus()
  await flush()
  assert.equal(machineCalls(api.calls).length, 2, 'the return to the panel read again')
  release()
})

test('the Refresh/recheck path bypasses the shared answer', async (t) => {
  const api = fakeApi()
  const controller = new M.MachinesController(api, () => true)
  t.after(() => controller.dispose())
  const face = controller.face()
  await face.recheck()
  const fresh = api.calls.filter((call) => call.path === '/api/machines?fresh=1')
  assert.equal(fresh.length, 1)
  assert.equal(fresh[0].options?.fresh, true, 'a recheck never joins a recent answer')
})
