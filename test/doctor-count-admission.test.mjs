// The Doctor count's GET /api/doctor/results is decoration and stays
// background; its POST /api/doctor/runs is a write, so it is admitted as
// interactive even when the count starts that run by itself after the first
// frame (architecture finding A3). Driven through the hook, not its source.
//   node --test test/doctor-count-admission.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { miniReact } from './mini-react.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-doctor-count-admission-'))
await build({
  stdin: {
    contents: `
      export { mount } from 'react'
      export { useDoctorCount } from './src/client/doctor/use-doctor-count.ts'
    `,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  outfile: join(out, 'doctor-count.mjs'),
  absWorkingDir: root,
  plugins: [miniReact],
  logLevel: 'warning',
})
const M = await import(pathToFileURL(join(out, 'doctor-count.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

/** A host that records every call and holds no doctor report, so the count starts its own home run. */
function fakeApi() {
  const calls = []
  return {
    calls,
    api: {
      call: async (method, path, body, options) => {
        calls.push({ method, path, body, options })
        return path === '/api/doctor/results' ? { last: [], running: [] } : { runs: body?.runs ?? [], already: [] }
      },
      onEvent: () => () => {},
    },
  }
}

const is = (call, method, path) => call.method === method && call.path === path

test("a doctor run is a write: the count's POST is interactive, its GET stays background", async () => {
  const { api, calls } = fakeApi()
  function Count({ api, checks }) { M.useDoctorCount(api, checks); return null }
  const view = M.mount(Count, { api, checks: 0 })
  await view.settle()

  const reads = calls.filter((c) => is(c, 'GET', '/api/doctor/results'))
  const posts = calls.filter((c) => is(c, 'POST', '/api/doctor/runs'))
  assert.equal(reads.length, 1, 'the count read the held results')
  assert.equal(reads[0].options?.priority, 'background', 'reading the count is decoration')
  assert.equal(posts.length, 1, 'with no home report held, the count started one home run')
  assert.equal(posts[0].options?.priority ?? 'interactive', 'interactive', 'the run is a write, not decoration')

  // Check again is the person's own action: its run is interactive too.
  view.render({ api, checks: 1 })
  await view.settle()
  const after = calls.filter((c) => is(c, 'POST', '/api/doctor/runs'))
  assert.equal(after.length, 2, 'Check again started another home run')
  assert.equal(after[1].options?.priority ?? 'interactive', 'interactive', 'and it is interactive')
  view.unmount()
})
