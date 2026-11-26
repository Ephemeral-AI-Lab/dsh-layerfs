// One machine's space is read once however many components ask: the Overview
// has one useMachineSpace, and two readers of the same machine share the one
// request (the disk is the same answer for both).
//   node --test test/machine-space-share.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { miniReact } from './mini-react.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-machine-space-'))
/** The machines context as the page supplies it; only the host api and `useMachines` are needed here. */
const stubContext = {
  name: 'stub-machines-context',
  setup(b) {
    b.onResolve({ filter: /^\.\/context\.tsx$/ }, () => ({ path: 'context', namespace: 'stub-context' }))
    b.onLoad({ filter: /.*/, namespace: 'stub-context' }, () => ({
      contents: `
        export const useMachinesContext = () => ({
          api: globalThis.__machineSpaceApi,
          t: (key) => key,
          tw: (key) => key,
          useMachines: (selector) => selector({ data: { available: true, features: { machineSpace: true } } }),
        })
      `,
      loader: 'js',
    }))
  },
}
await build({
  stdin: {
    contents: `
      export { createApi } from './src/client/api.ts'
      export { useMachineSpace } from './src/client/machines/SpaceViews.tsx'
      export { mount } from 'react'
    `,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  outfile: join(out, 'space.mjs'),
  absWorkingDir: root,
  plugins: [miniReact, stubContext],
  loader: { '.css': 'text' },
  logLevel: 'warning',
})
const M = await import(pathToFileURL(join(out, 'space.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

test('two space readers of one machine send one /space request', async (t) => {
  const calls = []
  const remote = {
    call(request) {
      calls.push(request.args)
      return Promise.resolve({ ok: true, value: { offered: true, space: null, observedAt: 1 } })
    },
    events() {
      return { [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}) } }, dispose() {} }
    },
  }
  const api = M.createApi(() => remote, {
    createSession: async () => 'session-x',
    openPanel() {},
    openWorkspace: async () => {},
    openSession() {},
  }, () => undefined)
  t.after(() => api.dispose())
  globalThis.__machineSpaceApi = api
  t.after(() => { delete globalThis.__machineSpaceApi })

  function TwoReaders() {
    M.useMachineSpace({ name: 'docker', state: 'ready' })
    M.useMachineSpace({ name: 'docker', state: 'ready' })
    return null
  }
  const view = M.mount(TwoReaders, {})
  await view.settle()
  view.unmount()
  const space = calls.filter((call) => call.path === '/api/machines/docker/space')
  assert.equal(space.length, 1, 'the second reader joined the one space read')
  assert.equal(space[0].method, 'GET')
})
