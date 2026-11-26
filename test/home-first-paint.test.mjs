// Home's decoration reads wait for the browser's first paint: the setup check's
// second mount and the Doctor count must not compete with the reads that draw
// the first card, and they still land (freshly) once the frame has painted.
//   node --test test/home-first-paint.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { miniReact } from './mini-react.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-home-first-paint-'))
await build({
  stdin: {
    contents: `
      export { mount } from 'react'
      export { useSetupStatus, SETUP_SHARE_MAX_AGE_MS } from './src/client/setup/store.ts'
      export { useDoctorCount } from './src/client/doctor/use-doctor-count.ts'
    `,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  outfile: join(out, 'home.mjs'),
  absWorkingDir: root,
  plugins: [miniReact],
  logLevel: 'warning',
})
const M = await import(pathToFileURL(join(out, 'home.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

test('Home reads held for the first paint land after it, once each and fresh', async () => {
  const painted = []
  const waiting = []
  globalThis.requestAnimationFrame = (cb) => { painted.push(cb); return painted.length }
  globalThis.requestIdleCallback = (cb) => { waiting.push(cb); return waiting.length }
  test.after(() => { delete globalThis.requestAnimationFrame; delete globalThis.requestIdleCallback })

  const calls = []
  const api = {
    op: async (name, args, options) => {
      calls.push({ kind: 'op', name, options })
      return name === 'setup.status'
        ? { needs: [], runtime: { ok: true }, folder: { state: 'current' }, pieces: {}, warnings: [] }
        : {}
    },
    call: async (method, path, body, options) => {
      calls.push({ kind: 'call', method, path, options })
      return path === '/api/doctor/results' ? { last: [], running: [] } : {}
    },
    onEvent: () => () => {},
  }

  /** The boot mount (sidebar footer) and Home's own mount, then Home's Doctor count. */
  function Home({ api }) {
    M.useSetupStatus(api, false, false)
    M.useSetupStatus(api, false, true)
    M.useDoctorCount(api, 0)
    return null
  }

  const view = M.mount(Home, { api })
  const setupCalls = () => calls.filter((call) => call.name === 'setup.status')
  const doctorCalls = () => calls.filter((call) => call.path === '/api/doctor/results')

  // Mounting runs effects: the boot setup check goes now, the decoration does not.
  assert.equal(setupCalls().length, 1, 'the boot setup check runs on mount')
  assert.equal(doctorCalls().length, 0, 'the Doctor count waits')
  await view.settle()
  assert.equal(setupCalls().length, 1, 'and waits after the render too')
  assert.equal(painted.length, 1, 'one first-frame callback is scheduled')

  // The frame paints; the gate then takes its idle turn.
  painted.shift()()
  await view.settle()
  assert.equal(setupCalls().length, 1, 'Home setup still waits for the idle moment')
  assert.equal(waiting.length, 1, 'one idle callback is scheduled')
  assert.equal(doctorCalls().length, 0)

  waiting.shift()()
  await view.settle()
  assert.equal(setupCalls().length, 2, "Home's second setup check landed")
  assert.equal(setupCalls()[1].options?.share?.maxAgeMs, M.SETUP_SHARE_MAX_AGE_MS, 'and shares a recent check rather than reading twice')
  assert.ok(doctorCalls().length >= 1, 'the Doctor count landed')
  assert.equal(doctorCalls()[0].options?.priority, 'background', 'the Doctor count is admitted as decoration')
  view.unmount()
})

test('Check again reads past the shared setup answer', async () => {
  const calls = []
  const api = {
    op: async (name, args, options) => {
      calls.push({ kind: 'op', name, options })
      return { needs: [], runtime: { ok: true }, folder: { state: 'current' }, pieces: {}, warnings: [] }
    },
    call: async () => ({}),
    onEvent: () => () => {},
  }
  let check
  function Boot({ api }) {
    check = M.useSetupStatus(api).check
    return null
  }
  const view = M.mount(Boot, { api })
  await view.settle()
  assert.equal(calls.length, 1, 'the boot read used the shared answer age')
  assert.equal(calls[0].options?.share?.maxAgeMs, M.SETUP_SHARE_MAX_AGE_MS)
  check()
  await view.settle()
  assert.equal(calls.length, 2)
  assert.equal(calls[1].name, 'setup.status')
  assert.equal(calls[1].options?.fresh, true, 'Check again bypasses the shared answer')
  view.unmount()
})
