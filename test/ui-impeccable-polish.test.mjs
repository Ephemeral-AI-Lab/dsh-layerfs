// Regression tests for the 12 UI/UX polish items (ui/impeccable-polish).
// Every test fails on base 581f727 and passes after the polish changes.
//   node --test test/ui-impeccable-polish.test.mjs
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
const out = mkdtempSync(join(root, 'lib', '.test-ui-impeccable-polish-'))

const readSrc = (rel) => readFileSync(join(root, rel), 'utf8')

// Provide minimal browser globals for SSR rendering of components reading localStorage
if (!globalThis.localStorage) {
  const store = new Map()
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)) },
    removeItem: (k) => { store.delete(k) },
  }
}

const testPlugin = {
  name: 'ui-impeccable-stubs',
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
        Button: `({ variant, size, type = 'button', icon, children, className, title, 'aria-label': ariaLabel, 'aria-disabled': ariaDisabled, 'aria-describedby': ariaDescribedBy, disabled }) => createElement('button', { type, 'data-primitive': 'Button', 'data-variant': variant, 'data-size': size, className, title, 'aria-label': ariaLabel, 'aria-disabled': ariaDisabled ? 'true' : undefined, 'aria-describedby': ariaDescribedBy, disabled: !!disabled }, icon, children)`,
        Tooltip: `({ label, disabled, children }) => createElement('span', { 'data-primitive': 'Tooltip', 'data-tooltip-disabled': disabled ? 'true' : 'false', 'data-tooltip-label': label }, children)`,
        Menu: `({ anchor, children }) => createElement('div', { 'data-primitive': 'Menu' }, anchor, createElement('div', { 'data-menu-body': 'true' }, children))`,
        MenuItemButton: `({ children, disabled, disabledReason }) => createElement('button', { type: 'button', role: 'menuitem', disabled: !!disabled, 'data-disabled-reason': disabledReason }, children)`,
        Modal: `({ open, title, children, footer }) => open ? createElement('div', { role: 'dialog', 'aria-label': title }, children, footer) : null`,
        StateDot: `({ state, size }) => createElement('span', { 'data-primitive': 'StateDot', 'data-state': state, 'data-size': size })`,
        Input: `({ value, placeholder, 'aria-label': ariaLabel }) => createElement('input', { value, placeholder, 'aria-label': ariaLabel })`,
        relativeTime: `() => 'just now'`,
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
      'machines/context.tsx': `export const useMachinesContext = () => ({ api: { call: async () => ({}) }, useMachines: (s) => s({ data: null, loading: false, error: null }), useCreations: (s) => s([]), t: (k) => k, tw: (k) => k, stateWord: (l) => String(l?.key ?? ''), go: () => {}, openStorageTab: () => {}, retryCreation: async () => {}, dismissCreation: async () => {} }); export const useMachinesMaybe = () => null`,
      'ui/use-query.ts': `export const useQuery = () => ({ data: undefined, loading: false, error: null, reload: () => {} }); export const cachedAnswer = () => undefined; export const errorText = (e) => String(e?.message ?? e); export const errorCode = (e) => e?.code`,
      'storage/hooks.ts': `export const useHostEvents = () => {}`,
      'storage/PaneBar.tsx': `export const PaneBar = ({ title, children, actions }) => null; export const usePageReading = () => {}`,
      'projects/hooks.ts': `export const useProjectSessions = () => ({ sessions: [], loading: false, error: null })`,
      'doctor/Doctor.tsx': `export const DoctorAction = () => null; export const useStartDoctor = () => async () => {}`,
      'machines/MachineStats.tsx': `export const useMachineStats = () => ({ read: { data: undefined } }); export const storeSizes = () => null`,
      'machines/Sandboxes.tsx': `export const SandboxMenu = () => null; export const useClose = () => false`,
      'machines/MachineImages.tsx': `export const FreeSpaceDialog = () => null`,
      'logs/index.tsx': `export const LogsPanelIcon = () => null`,
      'setup/store.ts': `export const setupDialog = { open: () => {} }`,
    }
    b.onResolve({ filter: /^\.\.?\/.*$/ }, (a) => {
      const resolved = join(a.resolveDir, a.path).replace(/\\/g, '/')
      for (const k of Object.keys(stubModules)) {
        if (resolved.endsWith(`src/client/${k}`)) return { path: k, namespace: 'imp-stub' }
      }
    })
    b.onLoad({ filter: /.*/, namespace: 'imp-stub' }, (a) => ({ loader: 'js', contents: stubModules[a.path] }))
  },
}

await build({
  absWorkingDir: root,
  stdin: {
    contents: `
      export * as sm from './src/client/storage/model.ts'
      export { locales as storageLocales } from './src/client/storage/locale.ts'
      export { locales as doctorLocales } from './src/client/doctor/locale.ts'
      export { wordsOf as doctorWords } from './src/client/doctor/words.ts'
      export * as dm from './src/client/doctor/model.ts'
      export { OpPanel, JobPanel } from './src/client/storage/JobProgress.tsx'
      export { HomeStores } from './src/client/storage/MachineStores.tsx'
      export { BucketPage } from './src/client/storage/BucketPage.tsx'
      export { StoreOverview } from './src/client/storage/StoreOverview.tsx'
      export { ProjectGrid } from './src/client/storage/ProjectTable.tsx'
      export { Inventory } from './src/client/machines/Inventory.tsx'
      export { NavBar } from './src/client/storage/Nav.tsx'
    `,
    resolveDir: root,
    loader: 'tsx',
  },
  outfile: join(out, 'imp-polish.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  loader: { '.module.css': 'local-css', '.css': 'css' },
  plugins: [testPlugin],
  logLevel: 'error',
})

const M = await import(pathToFileURL(join(out, 'imp-polish.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

const fill = (s, vars = {}) => String(s).replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`))
const makeStorageT = (lang) => (k, vars) => fill(M.storageLocales[lang][k] ?? k, vars)
const makeDoctorT = (lang) => (k, vars) => fill(M.doctorLocales[lang][k] ?? k, vars)

const noopApi = { call: async () => ({}), op: async () => ({}), openProjectSession: async () => {} }

test('#1: storeStateWords and doctor words localize known reasons and fall back cleanly for unknown codes', () => {
  const zh = makeStorageT('zh')
  const en = makeStorageT('en')

  assert.equal(M.sm.storeStateWords('broken', zh, 'corrupt'), '损坏 · 数据损坏')
  assert.equal(M.sm.storeStateWords('broken', zh, 'outdated'), '损坏 · 记录过旧')
  assert.equal(M.sm.storeStateWords('broken', zh, 'not_answering'), '损坏 · 无响应')
  assert.equal(M.sm.storeStateWords('broken', en, 'corrupt'), 'Broken · corrupt')
  assert.equal(M.sm.storeStateWords('broken', zh, 'future_reason_code'), '损坏 · future reason code')
  assert.equal(M.sm.storeStateWords('broken', en, 'future_reason_code'), 'Broken · future reason code')

  const dwZh = M.doctorWords(makeDoctorT('zh'))
  const dwEn = M.doctorWords(makeDoctorT('en'))
  assert.equal(dwZh.rowWord('record:outdated'), '版本过旧')
  assert.equal(dwZh.rowWord('record:corrupt'), '数据损坏')
  assert.equal(dwEn.rowWord('record:outdated'), 'Outdated')
  assert.equal(dwZh.rowWord('record:custom_code'), 'Custom code')

  const nativeMachine = { key: 'machine:native', kind: 'machine', name: 'native', platform: 'native', machine: null, state: 'ready', reason: null, fix: null, message: null, op: null }
  assert.equal(dwZh.nameOf(nativeMachine), 'LayerFS Home')
  assert.equal(dwEn.nameOf(nativeMachine), 'LayerFS Home')

  const treeState = M.dm.setTree(M.dm.emptyState(), {
    at: 1000,
    home: { home: '/tmp/h', version: '2.0.0', state: 'ready', reason: null, fix: null },
    tree: { machines: [{ machine: 'native', platform: 'native', state: 'ready', stores: [], sandboxes: [] }], stores: [], buckets: [] },
  })
  const view = M.dm.viewOf(treeState, treeState.world.by['machine:native'])
  assert.equal(dwZh.fact(treeState, view), '这台电脑')
  assert.equal(dwEn.fact(treeState, view), 'this computer')
})

test('#2: doctor zh locale eliminates machine-translated 医生 and unifies terminology to 诊断', () => {
  const { en, zh } = M.doctorLocales
  for (const key of Object.keys(en)) {
    assert.ok(key in zh, `zh missing key ${key}`)
  }
  for (const [k, v] of Object.entries(zh)) {
    assert.ok(!v.includes('医生'), `doctor zh key ${k} must not contain 医生: ${v}`)
  }
  assert.equal(zh.dpTitle, '诊断')
  assert.equal(zh.dpTabsLabel, '分类')
  assert.match(zh.dpHeadTip, /诊断/)
  assert.match(zh.dpSource, /诊断/)
  assert.match(zh.dpUnsupportedTitle, /诊断/)
})

test('#3: contrast fixes use DSH token color-mix for green labels and secondary ink for placeholders/nav/tab counts without literal colors', () => {
  const uiCss = readSrc('src/client/ui/ui.module.css')
  const ptCss = readSrc('src/client/storage/ProjectTable.module.css')
  const spCss = readSrc('src/client/storage/StorePage.module.css')
  const msCss = readSrc('src/client/storage/MachineStores.module.css')
  const hcCss = readSrc('src/client/storage/HomeCards.module.css')
  const navCss = readSrc('src/client/storage/Nav.module.css')
  const tbCss = readSrc('src/client/ui/TabBar.module.css')

  const greenFg = /color:\s*var\(--lf-tone-success-fg\)/
  assert.match(uiCss, new RegExp(`\\.chip\\[data-tone='success'\\][^}]*${greenFg.source}`))
  assert.match(ptCss, new RegExp(`\\.runningPill\\s*\\{[^}]*${greenFg.source}`))
  assert.match(spCss, new RegExp(`\\.statePill\\[data-tone='ok'\\][^}]*${greenFg.source}`))
  assert.match(msCss, new RegExp(`\\.pill\\[data-tone='success'\\][^}]*${greenFg.source}`))
  assert.match(hcCss, /\.finderSearch\s+input::placeholder\s*\{[^}]*color:\s*var\(--dsw-alias-label-secondary\)/)
  assert.match(navCss, /\.jumpField\s*\{[^}]*color:\s*var\(--dsw-alias-label-secondary\)/)
  assert.match(navCss, /\.jumpKeys\s*\{[^}]*color:\s*var\(--dsw-alias-label-secondary\)/)
  assert.match(tbCss, /\.count\s*\{[^}]*color:\s*var\(--dsw-alias-label-secondary\)/)
})

test('#4: HomeHero active tab count selector preserves danger/warning semantic tones', () => {
  const css = readSrc('src/client/storage/HomeHero.module.css')
  assert.match(css, /\.tab\[data-active\]\s+\.count:not\(\[data-tone\]\)\s*\{/)
  assert.doesNotMatch(css, /\.tab\[data-active\]\s+\.count\s*\{/)
})

test('#5: OpPanel/JobPanel support compact mode on cards and .job aligns flush (margin: 0)', () => {
  const storageCss = readSrc('src/client/storage/Storage.module.css')
  assert.match(storageCss, /\.job\s*\{[^}]*margin:\s*0;/)
  assert.match(storageCss, /\.job\[data-compact\]/)

  const store = { name: 'busy-store', kind: 'sqlite', machine: 'native', state: 'busy', op: { name: 'move', phase: 'send' }, projects: [], links: [], ownConnections: [] }
  const compactHtml = renderToStaticMarkup(createElement(M.OpPanel, { store, t: makeStorageT('zh'), compact: true }))
  assert.match(compactHtml, /data-compact="true"/)
  const fullHtml = renderToStaticMarkup(createElement(M.OpPanel, { store, t: makeStorageT('zh') }))
  assert.doesNotMatch(fullHtml, /data-compact=/)
})

test('#6: Nav bar stays single-row at 760px by compacting jumpField under 900px and lowering crumbs flex-basis', () => {
  const navCss = readSrc('src/client/storage/Nav.module.css')
  assert.match(navCss, /\.bar\s*\{[^}]*flex-wrap:\s*nowrap;/)
  assert.match(navCss, /\.crumbs\s*\{[^}]*flex:\s*1 1 120px;/)
  assert.match(navCss, /@media\s*\(max-width:\s*900px\)\s*\{[\s\S]*?\.jumpField/)
})

test('#7: ProjectGrid wraps row expand button inside role=cell and unifies branch width & numeric alignment', () => {
  const ptCss = readSrc('src/client/storage/ProjectTable.module.css')
  assert.match(ptCss, /\.branch\s*\{[^}]*flex:\s*none;/)
  assert.doesNotMatch(ptCss, /\.table\[data-store-column\]\s*:is\(\.colSessions/)

  const row = {
    key: 'ready-store/api',
    store: { name: 'ready-store', kind: 'sqlite', state: 'ready' },
    p: { name: 'api', created: 1000, totals: { saves: 5, branches: 2, stored: 1024 }, last: { id: 'abc', message: 'hello', branch: 'main', time: 2000 }, files: null, partial: false, building: null, error: null },
    boxes: [],
    sessions: [],
  }
  const html = renderToStaticMarkup(createElement(M.ProjectGrid, {
    api: noopApi,
    t: makeStorageT('zh'),
    now: 5000,
    rows: [row],
    label: '项目',
    showStore: true,
    fleet: null,
    place: (m) => m ?? '',
    tick: 0,
    onOpen: () => {},
  }))
  assert.match(html, /role="row"><span role="cell"[^>]*><button type="button"[^>]*aria-expanded=/)
})

test('#8: PgCard omits empty footer when all projects fit under status and replaces Unicode ▣ with SVG SandboxGlyph', () => {
  localStorage.setItem('dsh-layerfs:store-kind:(home)', 'postgresql')
  const view = {
    stores: [
      {
        name: 'pg-one', kind: 'postgresql', machine: null, state: 'broken', reason: 'outdated',
        postgresql: { target: 'db:5432/a', server: 'db:5432', database: 'a', auth: 'primary' },
        connectedFrom: [{ machine: null, own: false, reached: 'failed' }],
        projects: ['p1'], projectsCount: 1, links: [], ownConnections: [],
      },
      {
        name: 'pg-two', kind: 'postgresql', machine: null, state: 'broken', reason: 'outdated',
        postgresql: { target: 'db:5432/b', server: 'db:5432', database: 'b', auth: 'primary' },
        connectedFrom: [{ machine: 'vm-ready', own: false, reached: 'ok' }],
        projects: ['p1', 'p2'], projectsCount: 2, links: [], ownConnections: [],
      },
    ],
    machines: [
      { name: 'native', platform: 'native', state: 'ready', stores: [], sandboxes: [] },
      { name: 'vm-ready', platform: 'lima', state: 'ready', stores: [], sandboxes: ['sb-1'] },
    ],
    buckets: [],
    jobs: [],
    auths: [{ auth: 'primary', user: 'app', stores: ['pg-one', 'pg-two'], state: 'ready' }],
    at: 1000,
  }
  const noopAct = () => ({
    push: () => {}, pull: () => {}, move: () => {}, backup: () => {}, compact: () => {},
    addProject: () => {}, remove: () => {}, disconnect: () => {}, editConnection: () => {},
    check: () => {}, connectMachine: () => {}, openMachine: () => {}, retry: () => {}, dismiss: () => {},
  })
  const html = renderToStaticMarkup(createElement(M.HomeStores, {
    api: noopApi,
    stores: view.stores,
    view,
    t: makeStorageT('zh'),
    now: 2000,
    jobs: [],
    dismissed: new Set(),
    actionsFor: noopAct,
    sandboxes: [{ machine: 'vm-ready', project: 'pg-two/p1' }],
    onOpenStore: () => {},
    onOpenProject: () => {},
    onBackups: () => {},
    onNewStore: () => {},
    onConnect: () => {},
  }))

  const pgOneStart = html.indexOf('data-store="pg-one"')
  const pgTwoStart = html.indexOf('data-store="pg-two"')
  assert.ok(pgOneStart > 0 && pgTwoStart > pgOneStart)
  const pgOneHtml = html.slice(pgOneStart, pgTwoStart)
  const pgTwoHtml = html.slice(pgTwoStart)

  assert.ok(!pgOneHtml.includes('foot_'), 'pg-one (1 project under status) must not render an empty footer')
  assert.ok(!/class="[^"]*foot[^"]*"/.test(pgOneHtml), 'pg-one must not render empty foot divider')
  assert.ok(/class="[^"]*foot[^"]*"/.test(pgTwoHtml), 'pg-two (2 projects under status, 1 folded) must render footer with +1')
  assert.ok(!html.includes('▣'), 'connected chip must not use raw Unicode ▣')
  assert.match(pgTwoHtml, /class="[^"]*chipCount[^"]*"[^>]*>1<svg/)
})

test('#9: toolbar diagnose button and all three segmented switchers share unified heights', () => {
  const homeTsx = readSrc('src/client/storage/HomeOverview.tsx')
  const msCss = readSrc('src/client/storage/MachineStores.module.css')
  const bcCss = readSrc('src/client/storage/BucketCards.module.css')

  assert.match(homeTsx, /<Button variant="outline" size="sm" className=\{heroCss\.actionButton\}[\s\S]*?\{mc\.doctorT\('diagnoseHost'\)\}<\/Button>/)
  assert.match(msCss, /\.view\s*\{[^}]*height:\s*28px;/)
  assert.match(bcCss, /\.seg button\s*\{[^}]*height:\s*28px;/)
})

test('#10: BucketPage deduplicates empty copy (Stores not Projects) and disables Back up now with reason on stopped/broken Stores', () => {
  const emptyView = {
    stores: [], machines: [], jobs: [], at: 1000,
    buckets: [{ name: 'b-empty', provider: 'r2', state: 'ready', listed: 900, files: [] }],
  }
  const commonProps = {
    api: noopApi, now: 1000, listing: false,
    onList: () => {}, onRestore: () => {}, onBackup: () => {}, onDisconnect: () => {},
    onReconnect: () => {}, onOpenStore: () => {}, onOpenFile: () => {},
  }
  const zhEmpty = renderToStaticMarkup(createElement(M.BucketPage, { ...commonProps, name: 'b-empty', view: emptyView, t: makeStorageT('zh'), doctorT: makeDoctorT('zh') }))
  assert.equal((zhEmpty.match(/这里还没有 Store 文件/g) ?? []).length, 1, 'empty title must not repeat in body')
  assert.ok(zhEmpty.includes('“Store”页签'), 'zh empty copy must point to Stores tab')
  assert.ok(!zhEmpty.includes('“项目”中'), 'zh empty copy must not point to Projects')

  const enEmpty = renderToStaticMarkup(createElement(M.BucketPage, { ...commonProps, name: 'b-empty', view: emptyView, t: makeStorageT('en'), doctorT: makeDoctorT('en') }))
  assert.equal((enEmpty.match(/No Store files here/g) ?? []).length, 1, 'en empty title must not repeat in body')
  assert.ok(enEmpty.includes('Stores tab'), 'en empty copy must point to Stores tab')
  assert.ok(!enEmpty.includes('on Projects'), 'en empty copy must not point to Projects')

  const mixedView = {
    stores: [
      { name: 'ready-s', kind: 'sqlite', machine: 'native', state: 'ready', projects: [], links: [], ownConnections: [] },
      { name: 'stopped-s', kind: 'sqlite', machine: 'docker', state: 'blocked', blockedBy: { machine: 'docker', reason: 'stopped' }, projects: [], links: [], ownConnections: [] },
      { name: 'broken-s', kind: 'sqlite', machine: 'native', state: 'broken', reason: 'corrupt', projects: [], links: [], ownConnections: [] },
    ],
    machines: [], jobs: [], at: 1000,
    buckets: [{
      name: 'b-main', provider: 'minio', state: 'ready', listed: 900,
      files: [
        { file: 'ready.db', store: 'ready-s', bytes: 100, modified: 800, behind: true, changed: false, missing: false, message: null },
        { file: 'stopped.db', store: 'stopped-s', bytes: 100, modified: 800, behind: true, changed: false, missing: false, message: null },
        { file: 'broken.db', store: 'broken-s', bytes: 100, modified: 800, behind: true, changed: false, missing: false, message: null },
      ],
    }],
  }
  const tableHtml = renderToStaticMarkup(createElement(M.BucketPage, { ...commonProps, name: 'b-main', view: mixedView, t: makeStorageT('zh'), doctorT: makeDoctorT('zh') }))
  const rowOf = (file) => {
    const start = tableHtml.indexOf(file)
    assert.ok(start > 0, `row for ${file} missing`)
    return tableHtml.slice(start, tableHtml.indexOf('</tr>', start))
  }
  assert.doesNotMatch(rowOf('ready.db'), /aria-disabled="true"/, 'ready store Back up now stays enabled')
  assert.match(rowOf('stopped.db'), /data-tooltip-disabled="false"[^>]*data-tooltip-label="[^"]+docker[^"]*"[\s\S]*?aria-disabled="true"[^>]*>立即备份</)
  assert.match(rowOf('broken.db'), /data-tooltip-disabled="false"[^>]*data-tooltip-label="[^"]+"[\s\S]*?aria-disabled="true"[^>]*>立即备份</)
})

test('#11: StoreOverview avoids nested <dl> in tiles and follows DSH hairline/focus/code-font/non-link-blue rules', () => {
  const store = {
    name: 'ready-store', kind: 'sqlite', machine: 'native', state: 'ready',
    projects: ['api'], projectsCount: 1, size: { bytes: 512000 },
    links: [{ bucket: 'b-main', file: 'ready.db', last: { op: 'backup', at: 900, bytes: 512000 } }],
    ownConnections: [], created: 500,
  }
  const view = { stores: [store], machines: [{ name: 'native', platform: 'native', state: 'ready', stores: ['ready-store'], sandboxes: [] }], buckets: [], jobs: [], at: 1000 }
  const html = renderToStaticMarkup(createElement(M.StoreOverview, {
    store, view, t: makeStorageT('zh'), api: noopApi, now: 1000,
    stats: { file_bytes: 512000, stored_bytes: 300000, metadata_bytes: 100000, reusable_bytes: 112000, canonical_bytes: 700000 },
    statsError: undefined, projects: [], running: new Map(), machineState: 'ready',
    onTab: () => {}, onRemove: () => {},
  }))
  const tilesStart = html.indexOf('role="group"')
  assert.ok(tilesStart > 0, 'StoreOverview tiles must use role="group" container')
  const tilesSlice = html.slice(tilesStart, html.indexOf('data-store-file'))
  assert.ok(!tilesSlice.includes('<dl'), 'StoreOverview tiles must not render <dl>')
  assert.ok(!tilesSlice.includes('<dt'), 'StoreOverview tiles must not render <dt>')

  const spCss = readSrc('src/client/storage/StorePage.module.css')
  assert.doesNotMatch(spCss, /--dsw-alias-font-mono/)
  assert.match(spCss, /@media \(hover: hover\)\s*\{\s*\.tileButton:hover/)
  assert.match(spCss, /\.tileButton:focus-visible/)
  assert.match(spCss, /\.shareBlock \+ \.shareBlock\s*\{\s*border-top:\s*0\.5px/)
  assert.match(spCss, /\.ratioLine strong\s*\{[^}]*color:\s*var\(--dsw-alias-label-primary\)/)
})

test('#12: PG check failure wraps errors in semantic callout and Inventory/ProjectGrid use h2 (no skipped h3)', () => {
  const cdTsx = readSrc('src/client/storage/ConnectDatabase.tsx')
  const msCss = readSrc('src/client/storage/MachineStores.module.css')
  assert.match(cdTsx, /<div className=\{css\.checkFailure\}>/)
  assert.match(msCss, /\.checkFailure\s*\{[^}]*background:\s*var\(--lf-tone-danger-bg\)/)

  const invHtml = renderToStaticMarkup(createElement(M.Inventory, {
    m: { name: 'native', platform: 'native', state: 'ready', stores: [], sandboxes: [] },
    view: { available: true, machines: [], platforms: [], stores: [], postgresql: [], live: {}, sandboxes: [], readErrors: {} },
  }))
  assert.match(invHtml, /<h2[^>]*>stores<\/h2>/)
  assert.match(invHtml, /<h2[^>]*>sandboxes<\/h2>/)
  assert.ok(!invHtml.includes('<h3'), 'Inventory must not skip to <h3>')

  // Open a project row via localStorage so ProjectGrid renders ListHead
  localStorage.setItem('dsh-layerfs:projects-open', JSON.stringify({ 'ready-store/api': 'sandboxes' }))
  const row = {
    key: 'ready-store/api',
    store: { name: 'ready-store', kind: 'sqlite', state: 'ready' },
    p: { name: 'api', created: 1000, totals: { saves: 5, branches: 2, stored: 1024 }, last: null, files: null, partial: false, building: null, error: null },
    boxes: [],
    sessions: [],
  }
  const ptHtml = renderToStaticMarkup(createElement(M.ProjectGrid, {
    api: noopApi, t: makeStorageT('zh'), now: 5000, rows: [row], label: '项目',
    showStore: true, fleet: null, place: (m) => m ?? '', tick: 0, onOpen: () => {},
  }))
  assert.match(ptHtml, /<h2[^>]*>Sandbox<\/h2>/)
  assert.ok(!ptHtml.includes('<h3'), 'ProjectGrid ListHead must not skip to <h3>')
})

test('fix1 #1: prototype property names (constructor/toString/valueOf) fall back cleanly without leaking Object internals', () => {
  const zh = makeStorageT('zh')
  const en = makeStorageT('en')

  for (const protoKey of ['constructor', 'toString', 'valueOf', '__proto__']) {
    const clean = protoKey.replace(/_/g, ' ')
    assert.equal(M.sm.storeStateWords('broken', en, protoKey), `Broken · ${clean}`)
    assert.equal(M.sm.storeStateWords('broken', zh, protoKey), `损坏 · ${clean}`)
  }

  const dwZh = M.doctorWords(makeDoctorT('zh'))
  const dwEn = M.doctorWords(makeDoctorT('en'))

  assert.equal(dwEn.rowWord('record:constructor'), 'Constructor')
  assert.equal(dwZh.rowWord('record:constructor'), 'Constructor')
  assert.equal(dwZh.rowWord('record:toString'), 'ToString')
  assert.equal(dwEn.checkText({ r: 'nc', check: 'store.record', reason: 'constructor' }), 'not checked: constructor')
  assert.equal(dwZh.checkText({ r: 'nc', check: 'store.record', reason: 'constructor' }), '未检查：constructor')
  assert.equal(dwZh.stepWord('constructor'), '')
})

test('fix1 #2: compact running JobPanel on SQLite and PostgreSQL Store cards shows full title tooltip while keeping failed refusal tips', () => {
  const noopAct = () => ({
    push: () => {}, pull: () => {}, move: () => {}, backup: () => {}, compact: () => {},
    addProject: () => {}, remove: () => {}, disconnect: () => {}, editConnection: () => {},
    check: () => {}, connectMachine: () => {}, openMachine: () => {}, retry: () => {}, dismiss: () => {},
  })
  const sqliteStore = {
    name: 'sqlite-busy', kind: 'sqlite', machine: 'native', state: 'ready',
    projects: ['api'], projectsCount: 1, size: { bytes: 1024 }, links: [], ownConnections: [],
  }
  const pgStore = {
    name: 'pg-very-long-database-name', kind: 'postgresql', machine: null, state: 'ready',
    postgresql: { target: 'db:5432/app', server: 'db:5432', database: 'app', auth: 'primary' },
    connectedFrom: [{ machine: null, own: false, reached: 'ok' }],
    projects: ['api'], projectsCount: 1, links: [], ownConnections: [],
  }
  const baseView = {
    stores: [sqliteStore, pgStore],
    machines: [{ name: 'native', platform: 'native', state: 'ready', stores: ['sqlite-busy'], sandboxes: [] }],
    buckets: [],
    jobs: [],
    auths: [{ auth: 'primary', user: 'app', stores: ['pg-very-long-database-name'], state: 'ready' }],
    at: 2000,
  }
  const baseProps = {
    api: noopApi, stores: baseView.stores, view: baseView, t: makeStorageT('zh'), now: 3000,
    dismissed: new Set(), actionsFor: noopAct, sandboxes: [],
    onOpenStore: () => {}, onOpenProject: () => {}, onBackups: () => {}, onNewStore: () => {}, onConnect: () => {},
  }

  // SQLite Store card with running backup to long bucket name
  localStorage.setItem('dsh-layerfs:store-kind:(home)', 'sqlite')
  const sqliteHtml = renderToStaticMarkup(createElement(M.HomeStores, {
    ...baseProps,
    jobs: [{ id: 'j-sql', kind: 'backup', store: 'sqlite-busy', target: 'a-very-long-bucket-name', phase: 'upload', started: 1000, ended: null, error: null, outcome: null }],
  }))
  assert.match(sqliteHtml, /data-store="sqlite-busy"[\s\S]*?data-compact="true"[\s\S]*?title="正在备份到 a-very-long-bucket-name">正在备份到 a-very-long-bucket-name</)

  // PostgreSQL Store card with running compact job
  const pgView = { ...baseView, stores: [pgStore] }
  const pgHtml = renderToStaticMarkup(createElement(M.HomeStores, {
    ...baseProps,
    stores: pgView.stores,
    view: pgView,
    jobs: [{ id: 'j-pg', kind: 'compact', store: 'pg-very-long-database-name', target: 'pg-very-long-database-name', phase: 'build', started: 1000, ended: null, error: null, outcome: null }],
  }))
  assert.match(pgHtml, /data-store="pg-very-long-database-name"[\s\S]*?data-compact="true"[\s\S]*?title="正在压缩 pg-very-long-database-name">正在压缩 pg-very-long-database-name</)

  // Failed job keeps refusal details as title tooltip (not overwritten by short label)
  localStorage.setItem('dsh-layerfs:store-kind:(home)', 'sqlite')
  const failedHtml = renderToStaticMarkup(createElement(M.HomeStores, {
    ...baseProps,
    jobs: [{
      id: 'j-fail', kind: 'backup', store: 'sqlite-busy', target: 'a-very-long-bucket-name',
      phase: 'upload', started: 1000, ended: 2500, outcome: 'failed',
      error: { code: 'Denied', message: 'Access denied for bucket', phase: 'upload' },
    }],
  }))
  assert.match(failedHtml, /data-compact="true"[\s\S]*?title="Denied: Access denied for bucket"/)
})

test('fix1 #3: NavBar jump button exposes localized aria-label and title for 760px icon-only state', () => {
  const history = { current: 'overview', canBack: false, canForward: false, open: () => {}, back: () => {}, forward: () => {}, forget: () => {} }
  for (const [lang, expected] of [['zh', '跳转到…'], ['en', 'Jump to…']]) {
    const html = renderToStaticMarkup(createElement(M.NavBar, {
      t: makeStorageT(lang),
      history,
      crumbs: [{ key: 'overview', label: lang === 'zh' ? '主页' : 'Home', id: 'overview' }],
      sessions: undefined,
      onSession: () => {},
      jump: [],
      jobs: [],
      findings: [],
      refreshing: false,
      add: [],
      onOpen: () => {},
    }))
    const btnMatch = /<button[^>]*aria-haspopup="dialog"[^>]*>/.exec(html)
    assert.ok(btnMatch, `jump button missing (${lang})`)
    assert.ok(btnMatch[0].includes(`aria-label="${expected}"`), `jump button must carry aria-label="${expected}" (${lang}): ${btnMatch[0]}`)
    assert.ok(btnMatch[0].includes(`title="${expected}"`), `jump button must carry title="${expected}" (${lang}): ${btnMatch[0]}`)
  }
})
