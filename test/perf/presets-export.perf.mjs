#!/usr/bin/env node
// B10 in process, no server and no browser: the Presets catalog's per-request
// regeneration before (every request builds every preset) and after (the catalog
// is kept until its inputs change), the open dialog's catalog reads per 30 s
// visible vs hidden, and the Export dialog's version read as two sequential
// requests, two concurrent ones, and one combined request. Payload bytes are the
// JSON answers. The browser -> remote -> host hop measured on the side rig for
// these reads (30-45 ms) is not reproducible here: the route times are host work
// only, and `--hop <ms>` adds that round trip to compare the dialog's shapes.
//
//   node test/perf/presets-export.perf.mjs [--reps 40] [--hop 33]
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { miniReact } from '../mini-react.mjs'
import { loadRoutes, testHost } from '../routes-helper.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'b10-perf-'))
const args = process.argv.slice(2)
const flag = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback }
const REP = Number(flag('--reps', 40))
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))] }
const round = (n) => Math.round(n * 1000) / 1000
const time = (fn) => { const t = performance.now(); const r = fn(); return [performance.now() - t, r] }

await build({
  absWorkingDir: root,
  stdin: {
    contents: `
      export { PresetManager } from './src/host/presets/manager.ts'
      export { mount } from 'react'
      export { usePresets } from './src/client/presets/PresetsSection.tsx'
    `,
    resolveDir: root, loader: 'tsx',
  },
  bundle: true, format: 'esm', platform: 'node', target: 'node24', jsx: 'automatic',
  loader: { '.module.css': 'local-css', '.css': 'css' },
  outfile: join(out, 'perf.mjs'), plugins: [miniReact], logLevel: 'warning',
})
const M = await import(pathToFileURL(join(out, 'perf.mjs')).href)
const R = await loadRoutes()
process.on('exit', () => rmSync(out, { recursive: true, force: true }))

// ---- A: the catalog, before (every request regenerates) vs after (kept)
function dirs(tag) {
  const base = mkdtempSync(join(tmpdir(), `b10-${tag}-`))
  return { base, state: join(base, 'presets'), home: join(base, 'home') }
}
function hostFor(d) {
  return {
    spec: () => ({ cli: '/nonexistent/layerfs', home: d.home, bundle: null, daemon: null, state: d.state }),
    busy: () => [], boundSessions: () => [], dshProjects: () => [], forgetProject: async () => {},
    homeStores: async (also) => (also ?? []).map((name) => ({ name })),
    projectConversations: () => [], deleteProjectConversations: async () => [], emit: () => {},
  }
}
{
  const d = dirs('catalog')
  mkdirSync(d.state, { recursive: true })
  // the built library and its verified Build job: the inputs `definition()` reads
  writeFileSync(join(d.state, 'demo-fixtures.json'), JSON.stringify({ tool: 'dsh-layerfs-presets', version: 1, preset: 'studio', homeId: 'h1', contentVersion: 4, executionMode: 'filesystem' }))
  const m = new M.PresetManager(hostFor(d), d.state, d.home)
  const ids = m.list().items.map((p) => p.id)
  const build = [], warm = []
  let bytes = 0
  for (let i = 0; i < REP; i++) {
    // before: every request regenerated every definition (`buildDefinition` is list's work)
    const [ms, value] = time(() => ids.map((id) => m.buildDefinition(id)))
    build.push(ms); bytes = JSON.stringify({ items: value, home: d.home, busy: false }).length
    // after: a request answers the catalog kept until its inputs change
    const [ms2] = time(() => m.list())
    warm.push(ms2)
  }
  console.log(`catalog bytes=${bytes} before(=regenerated per request) p50=${round(pct(build, 0.5))}ms p95=${round(pct(build, 0.95))}ms; after(=cached per request) p50=${round(pct(warm, 0.5))}ms p95=${round(pct(warm, 0.95))}ms`)
  rmSync(d.base, { recursive: true, force: true })
}

// ---- B: the open dialog's catalog reads per 30 s, visible vs hidden
const real = { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval }
function pollHarness() {
  const intervals = []
  const listeners = new Map()
  const state = { hidden: false, focused: true }
  globalThis.setInterval = (fn, ms) => { const id = { fn, ms }; intervals.push(id); return id }
  globalThis.clearInterval = (id) => { const at = intervals.indexOf(id); if (at >= 0) intervals.splice(at, 1) }
  globalThis.document = {
    get visibilityState() { return state.hidden ? 'hidden' : 'visible' },
    hasFocus: () => state.focused,
    addEventListener: (t, fn) => { const s = listeners.get(t) ?? new Set(); s.add(fn); listeners.set(t, s) },
    removeEventListener: (t, fn) => { listeners.get(t)?.delete(fn) },
  }
  globalThis.window = {
    addEventListener: (t, fn) => { const s = listeners.get(`w:${t}`) ?? new Set(); s.add(fn); listeners.set(`w:${t}`, s) },
    removeEventListener: (t, fn) => { listeners.get(`w:${t}`)?.delete(fn) },
  }
  return { intervals, state, fire: (t) => { for (const fn of [...(listeners.get(t) ?? [])]) fn() } }
}
async function callsPer30s(hidden) {
  const h = pollHarness()
  const calls = []
  const api = { call: async () => { calls.push(1); return { items: [], home: '/h', busy: false } }, onEvent: () => () => {} }
  const Probe = ({ api: a }) => { M.usePresets(a); return null }
  const view = M.mount(Probe, { api })
  await view.settle()
  const mountCalls = calls.length
  if (hidden) { h.state.hidden = true; h.fire('visibilitychange') }
  const ms = h.intervals.at(-1).ms
  h.intervals.at(-1).fn()
  await view.settle()
  view.unmount()
  globalThis.setInterval = real.setInterval; globalThis.clearInterval = real.clearInterval
  delete globalThis.document; delete globalThis.window
  return { interval: ms, mount: mountCalls, in30s: calls.length - mountCalls }
}
{
  const visible = await callsPer30s(false)
  const hidden = await callsPer30s(true)
  console.log(`client 30s-open interval=${visible.interval}ms visible: mount=${visible.mount} + ${visible.in30s} poll call(s); hidden: mount=${hidden.mount} + ${hidden.in30s} poll call(s); before: 5s poll, 6 calls/30s`)
}

// ---- C: the Export dialog's version read
{
  const HEAD = 'a'.repeat(66)
  const seen = []
  const lfs = {
    branch: { get: async (_p, branch) => { seen.push('branch.get'); return { branch, commit: HEAD, base: null, forked_from: null } } },
    commit: {
      get: async (_p, ref) => { seen.push('commit.get'); return { commit: ref, message: 'second save', created_at: '2026-11-25T10:00:00.000Z', parent: null, size: 9 } },
      diff: async () => { seen.push('commit.diff'); return { items: [] } },
    },
  }
  const base = mkdtempSync(join(tmpdir(), 'b10-export-'))
  const t = testHost({ lfs, root: base, home: join(base, 'home'), discovery: async () => ({ identity: {}, calls: [], commands: [], switches: [] }) })
  const groups = R.createGroups(t.host, async () => ({}))
  const key = encodeURIComponent('perf2/demo2')
  /** One browser -> host round trip: the route's work plus the rig's measured per-request remainder. */
  const hopMs = Number(flag('--hop', 33))
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const at = (method, path) => async () => { const answer = await R.handle(groups, { method, path }); await sleep(hopMs); return answer }
  const shapes = { serial: [], parallel: [], combined: [] }
  let payload = 0, combinedPayload = 0
  for (let i = 0; i < REP; i++) {
    let t0 = performance.now()
    const b = await at('GET', `/api/projects/${key}/branches?branch=main`)()
    const d = await at('GET', `/api/projects/${key}/history?branch=main&commit=${b.body.commit}`)()
    shapes.serial.push(performance.now() - t0)
    payload = JSON.stringify(b.body).length + JSON.stringify(d.body).length
    // the alternative when the head is already known: both reads at once
    t0 = performance.now()
    await Promise.all([at('GET', `/api/projects/${key}/branches?branch=main`)(), at('GET', `/api/projects/${key}/history?branch=main&commit=${HEAD}`)()])
    shapes.parallel.push(performance.now() - t0)
    t0 = performance.now()
    const one = await at('GET', `/api/projects/${key}/branches?branch=main&with=commit`)()
    shapes.combined.push(performance.now() - t0)
    combinedPayload = JSON.stringify(one.body).length
    if (one.body.item?.message !== 'second save') throw new Error('the combined read lost the Commit header')
  }
  seen.length = 0
  const one = await R.handle(groups, { method: 'GET', path: `/api/projects/${key}/branches?branch=main&with=commit` })
  const calls = [...seen]
  await groups.projects.close()
  rmSync(base, { recursive: true, force: true })
  const p = (xs) => `p50=${round(pct(xs, 0.5))}ms p95=${round(pct(xs, 0.95))}ms`
  console.log(`export hop=${hopMs}ms/request payload=${payload}B (two reads) -> ${combinedPayload}B (one read); serial ${p(shapes.serial)}; parallel ${p(shapes.parallel)}; combined ${p(shapes.combined)}; the combined read's CLI calls: ${calls.join('+')}`)
}
