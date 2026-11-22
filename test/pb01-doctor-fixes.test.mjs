// Targeted regression tests for PB-01 P0-4 (Option A) Doctor fixes.
//   node --test test/pb01-doctor-fixes.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-pb01-doctor-fixes-'))

let testDoctorState = null
globalThis.__pb01DoctorState = () => testDoctorState
if (!globalThis.document) globalThis.document = { body: {} }

const testPlugin = {
  name: 'pb01-doctor-stubs',
  setup(b) {
    b.onResolve({ filter: /^@deepseek-ai\/.*$/ }, (a) => ({ path: `${a.path}|${a.importer}`, namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => {
      const [spec, importer] = a.path.split('|')
      const text = readFileSync(importer, 'utf8')
      const names = new Set()
      const quoted = spec.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
      for (const m of text.matchAll(new RegExp(`import\\s+(type\\s+)?([^'";]*?)\\s+from\\s+['"]${quoted}['"]`, 'g'))) {
        if (m[1]) continue
        const braces = /\{([^}]*)\}/.exec(m[2])
        for (const part of braces ? braces[1].split(',') : []) {
          const w = part.trim()
          if (!w || w.startsWith('type ')) continue
          names.add(w.split(/\s+as\s+/)[0].trim())
        }
      }
      const rich = {
        Button: `({ variant, size, icon, children, className, title, 'aria-label': ariaLabel, disabled, 'data-fid': fid }) => createElement('button', { type: 'button', 'data-primitive': 'Button', 'data-variant': variant, 'data-size': size, 'data-fid': fid, className, title, 'aria-label': ariaLabel, disabled }, icon, children)`,
        StateDot: `({ state, size }) => createElement('span', { 'data-primitive': 'StateDot', 'data-state': state, 'data-size': size })`,
        HoverCard: `({ anchor, content }) => createElement('span', { 'data-primitive': 'HoverCard' }, anchor, createElement('span', { 'data-hovercard-content': '' }, content))`,
        relativeTime: `() => ''`,
      }
      return {
        loader: 'js',
        contents: [
          `import { createElement } from 'react'`,
          `const fallback = ({ children }) => createElement('span', null, children)`,
          `export default fallback`,
          ...[...names].map((n) => `export const ${n} = ${rich[n] ?? 'fallback'}`),
        ].join('\n'),
      }
    })

    const stubModules = {
      'doctor/use-doctor.ts': `export const useDoctor = () => ({ state: globalThis.__pb01DoctorState(), loading: false, error: null, reload: () => {}, check: () => {}, full: () => {}, checkAll: () => {}, stop: () => {}, fix: () => {}, fixes: { run: async () => ({}) } })`,
      'storage/PaneBar.tsx': `export const usePageReading = () => {}`,
    }
    b.onResolve({ filter: /^react-dom$/ }, () => ({ path: 'react-dom', namespace: 'react-dom-stub' }))
    b.onLoad({ filter: /^react-dom$/, namespace: 'react-dom-stub' }, () => ({ loader: 'js', contents: `export const createPortal = (node) => node` }))
    b.onResolve({ filter: /^\.\.?\/.*$/ }, (a) => {
      const resolved = join(a.resolveDir, a.path).replace(/\\/g, '/')
      for (const k of Object.keys(stubModules)) {
        if (resolved.endsWith(`src/client/${k}`)) return { path: k, namespace: 'doc-stub' }
      }
    })
    b.onLoad({ filter: /.*/, namespace: 'doc-stub' }, (a) => ({ loader: 'js', contents: stubModules[a.path] }))
  },
}

await build({
  absWorkingDir: root,
  stdin: {
    contents: `
      export * as dm from './src/client/doctor/model.ts'
      export { wordsOf } from './src/client/doctor/words.ts'
      export { DoctorPage } from './src/client/doctor/DoctorPage.tsx'
      export { Row, Detail } from './src/client/doctor/Row.tsx'
      export { TipLayer } from './src/client/doctor/tips.tsx'
      export { locales as doctorLocales } from './src/client/doctor/locale.ts'
      export { locales as storageLocales } from './src/client/storage/locale.ts'
    `,
    resolveDir: root,
    loader: 'tsx',
  },
  outfile: join(out, 'pb01-doc.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  external: ['react', 'react/jsx-runtime'],
  loader: { '.module.css': 'local-css', '.css': 'css' },
  plugins: [testPlugin],
  logLevel: 'error',
})

const M = await import(pathToFileURL(join(out, 'pb01-doc.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

const fill = (s, vars = {}) => s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`))
const makeDocT = (lang) => (key, vars) => fill(M.doctorLocales[lang][key] ?? key, vars)
const makeSt = (lang) => (key, vars) => fill(M.storageLocales[lang][key] ?? key, vars)

function mixedDoctorState() {
  const now = 61000
  const tree = {
    at: now,
    home: { home: '/Users/dev/.layerfs', version: '2.0.0', state: 'ready', reason: null, fix: null },
    tree: {
      machines: [
        { machine: 'docker', platform: 'docker', state: 'stopped', stores: [], sandboxes: [] },
        { machine: 'native', platform: 'native', state: 'ready', stores: [{ store: 'alpha-store', engine: 'sqlite', projects: ['app'] }, { store: 'broken-store', engine: 'sqlite', projects: ['web'] }], sandboxes: [{ sandbox: 'box-1', project: 'alpha-store/app', workspaces: [] }] },
      ],
      stores: [],
      buckets: [],
    },
  }
  const report = {
    ok: false,
    status: 'not_checked',
    observed_at: new Date(now).toISOString(),
    findings: [],
    not_checked: [{ home: '/Users/dev/.layerfs', check: 'home.records', reason: 'failed' }],
    counts: {},
    tree: {
      home: '/Users/dev/.layerfs',
      status: 'not_checked',
      coverage: 'shallow',
      checks: [
        { check: 'home.build', outcome: 'pass' },
        { check: 'home.prerequisites', outcome: 'pass' },
        { check: 'home.layout', outcome: 'pass' },
        { check: 'home.records', outcome: 'not_checked' },
        { check: 'home.native_daemon', outcome: 'pass' },
        { check: 'home.capacity', outcome: 'pass' },
      ],
      machines: [
        {
          machine: 'docker',
          status: 'ok',
          coverage: 'shallow',
          checks: [
            { check: 'machine.record', outcome: 'pass' },
            { check: 'machine.configuration', outcome: 'pass' },
            { check: 'machine.provider', outcome: 'pass' },
            { check: 'machine.state', outcome: 'pass' },
            { check: 'machine.operation', outcome: 'pass' },
          ],
        },
        {
          machine: 'native',
          status: 'ok',
          coverage: 'shallow',
          checks: [
            { check: 'machine.record', outcome: 'pass' },
            { check: 'machine.configuration', outcome: 'pass' },
            { check: 'machine.native_daemon', outcome: 'pass' },
          ],
        },
      ],
    },
  }
  const s0 = M.dm.emptyState()
  const w0 = M.dm.setTree(s0, tree)
  return M.dm.seed(w0, { last: [{ id: 'doc-1', kind: 'home', name: '/Users/dev/.layerfs', full: false, group: null, state: 'done', started: now - 2000, ended: now - 1000, report }], running: [], fixes: [] }, now)
}

test('P0-4 (Option A): header separates stopped count from OK, Partial HoverCard & zh child failure translate cleanly, stopped machine shows neutral Stopped + 5 marks + outline Start/Check', () => {
  const state = mixedDoctorState()
  testDoctorState = state
  const head = M.dm.headOf(state)
  // Stopped machine whose static checks passed is counted in head.stopped (not head.counts.ok)
  assert.deepEqual([head.counts.ok, head.stopped, head.counts.nc], [1, 1, 6])

  for (const lang of ['en', 'zh']) {
    const t = makeDocT(lang)
    const ts = makeSt(lang)
    const w = M.wordsOf(t)

    // 1. Page header summary renders separate stopped count ("1 OK · 1 stopped · 6 not checked")
    const pageHtml = renderToStaticMarkup(createElement(M.DoctorPage, { api: { call: async () => ({}) }, t, ts, refreshKey: 0 }))
    const expectedHead = lang === 'zh' ? '1 项正常 · 1 项已停止 · 6 项未检查' : '1 OK · 1 stopped · 6 not checked'
    assert.ok(pageHtml.includes(expectedHead), `DoctorPage header must show "${expectedHead}"`)

    // 2. Root Partial row: label & HoverCard title both use dpWordPartial ("Partial" / "部分检查"), and zh child checks translate "failed" -> "失败"
    const homeThing = state.world.by['home:/Users/dev/.layerfs']
    const homeView = M.dm.viewOf(state, homeThing)
    const homeTip = w.sigTip(state, homeView)
    assert.equal(homeTip.title, t('dpWordPartial'), `Partial row HoverCard title must match dpWordPartial (${lang})`)
    const rowCtx = {
      state,
      w,
      open: { 'home:/Users/dev/.layerfs': true },
      flash: null,
      now: 61000,
      on: { toggle: () => {}, check: () => {}, full: () => {}, stop: () => {}, fix: () => {}, goTo: () => {} },
    }
    const homeDetailHtml = renderToStaticMarkup(createElement(M.TipLayer, { w }, createElement(M.Detail, { v: homeView, ctx: rowCtx })))
    if (lang === 'zh') {
      assert.ok(homeDetailHtml.includes('未检查：失败'), 'zh expanded child checks must translate failed to 失败')
      assert.ok(!homeDetailHtml.includes('未检查: failed'), 'zh expanded child checks must not leak English "failed"')
    }

    // 3. Stopped machine (Option A): status = neutral Stopped (no OK), .more omits duplicate rowWord,
    // keeps 5 static green marks, both Start & Check are outline, and HoverCard title is Stopped · Static checks OK
    const dockerThing = state.world.by['machine:docker']
    const dockerView = M.dm.viewOf(state, dockerThing)
    assert.equal(dockerView.canCheck, true, 'stopped machine permits static Check')
    const dockerTip = w.sigTip(state, dockerView)
    assert.equal(dockerTip.title, t('dpTipStoppedStaticTitle'))

    const dockerRowHtml = renderToStaticMarkup(createElement(M.TipLayer, { w }, createElement(M.Row, { v: dockerView, open: false, ctx: rowCtx })))
    assert.match(dockerRowHtml, new RegExp(`data-fid="sig:machine:docker"[^>]*>[\\s\\S]*${t('dpWordStopped')}`))
    // .more must show "docker" without repeating "Stopped" / "已停止" before it
    assert.match(dockerRowHtml, /<span class="[^"]*fact[^"]*">docker<\/span>/)
    assert.ok(!dockerRowHtml.includes(`>${t('dpWordStopped')}</span><span`), '.more should omit redundant stopped word')
    // Preserves 5 static green marks and both Start + Check outline buttons
    const marksSlice = dockerRowHtml.slice(dockerRowHtml.indexOf('data-fid="marks:machine:docker"'))
    const marksBtn = marksSlice.slice(0, marksSlice.indexOf('</button>'))
    assert.equal((marksBtn.match(/data-primitive="StateDot" data-state="done"/g) ?? []).length, 5, 'Option A keeps 5 static ok marks on stopped docker row')
    assert.match(dockerRowHtml, new RegExp(`data-variant="outline"[^>]*data-fid="fix:machine:docker"[^>]*>[^<]*${t('dpFixStart')}<`))
    assert.match(dockerRowHtml, new RegExp(`data-variant="outline"[^>]*data-fid="check:machine:docker"[^>]*>[^<]*${t('dpCheck')}<`))
  }
})
