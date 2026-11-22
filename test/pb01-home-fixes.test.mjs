// Targeted regression tests for PB-01 Home fixes: P0-1 (Option A), P0-2 (Option A), P0-3, and P1-2.
//   node --test test/pb01-home-fixes.test.mjs
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
const out = mkdtempSync(join(root, 'lib', '.test-pb01-home-fixes-'))

// Render real TSX components on React 18 server markup while exposing inspectable DOM attributes
// for @deepseek-ai/dsh-client-ui-primitives and lightweight context stubs for HomeOverview hooks.
const testPlugin = {
  name: 'pb01-test-stubs',
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
        Button: `({ variant, size, icon, children, className, title, 'aria-label': ariaLabel, disabled }) => createElement('button', { type: 'button', 'data-primitive': 'Button', 'data-variant': variant, 'data-size': size, className, title, 'aria-label': ariaLabel, disabled }, icon, children)`,
        StateDot: `({ state, size }) => createElement('span', { 'data-primitive': 'StateDot', 'data-state': state, 'data-size': size })`,
        HoverCard: `({ anchor, content }) => createElement('span', { 'data-primitive': 'HoverCard' }, anchor, createElement('span', { 'data-hovercard-content': '' }, content))`,
        MenuItemButton: `({ children }) => createElement('button', { type: 'button', 'data-primitive': 'MenuItemButton' }, children)`,
        relativeTime: `() => ''`,
      }
      const lines = [
        `import { createElement } from 'react'`,
        `const fallback = ({ children }) => createElement('span', null, children)`,
        `export default fallback`,
        ...[...names].map((n) => `export const ${n} = ${rich[n] ?? 'fallback'}`),
      ]
      return { contents: lines.join('\n'), loader: 'js' }
    })

    const stubHooks = {
      'machines/context.tsx': `export const useMachinesContext = () => ({ api: { call: async () => ({}), op: async () => ({}) }, act: async () => ({}), useMachines: (s) => s({ data: null, loading: false, error: null }), useStartups: (s) => s([]), t: (k) => k, tw: (k) => k, doctorT: (k) => k, stateWord: (l) => String(l ?? ''), go: () => {} }); export const useMachinesMaybe = () => null`,
      'setup/store.ts': `export const setupDialog = { open: () => {} }; export const useSetupStatus = () => ({ data: null, loading: false, error: null }); export const useInstalled = () => null; export const lately = () => null`,
      'doctor/Doctor.tsx': `export const useStartDoctor = () => async () => {}; export const DoctorAction = () => null`,
      'ui/use-query.ts': `export const useQuery = () => ({ data: null, loading: false, error: null }); export const cachedAnswer = () => undefined; export const errorCode = () => undefined; export const errorText = (e) => String(e ?? '')`,
    }
    b.onResolve({ filter: /^\.\.?\/.*$/ }, (a) => {
      const resolved = join(a.resolveDir, a.path).replace(/\\/g, '/')
      for (const k of Object.keys(stubHooks)) {
        if (resolved.endsWith(`src/client/${k}`)) return { path: k, namespace: 'hook-stub' }
      }
    })
    b.onLoad({ filter: /.*/, namespace: 'hook-stub' }, (a) => ({ loader: 'js', contents: stubHooks[a.path] }))
  },
}

await build({
  absWorkingDir: root,
  stdin: {
    contents: `
      export { Signal } from './src/client/storage/Signal.tsx'
      export { FixContext } from './src/client/ui/index.tsx'
      export { storeTrouble, troubleAction } from './src/client/storage/HomeCards.tsx'
      export { HomeStores, MachineLine } from './src/client/storage/MachineStores.tsx'
      export { BucketCards } from './src/client/storage/BucketCards.tsx'
      export { HomeOverview } from './src/client/storage/HomeOverview.tsx'
      export { locales as storageLocales } from './src/client/storage/locale.ts'
      export { locales as doctorLocales } from './src/client/doctor/locale.ts'
    `,
    resolveDir: root,
    loader: 'tsx',
  },
  outfile: join(out, 'pb01.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  loader: { '.module.css': 'local-css', '.css': 'css' },
  plugins: [testPlugin],
  logLevel: 'error',
})

const M = await import(pathToFileURL(join(out, 'pb01.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

const src = (rel) => readFileSync(join(root, rel), 'utf8')
const fill = (s, vars = {}) => s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`))
const makeT = (lang) => (key, vars) => fill(M.storageLocales[lang][key] ?? key, vars)
const makeDocT = (lang) => (key, vars) => fill(M.doctorLocales[lang][key] ?? key, vars)

const emptyFleet = {
  available: true,
  machines: [
    { name: 'native', platform: 'native', state: 'ready', stores: [], sandboxes: [], builtIn: true },
    { name: 'docker', platform: 'docker', state: 'stopped', stores: [], sandboxes: [], builtIn: true },
  ],
  platforms: [
    { platform: 'native', how: 'builtIn', ready: true, missing: [] },
    { platform: 'docker', how: 'builtIn', ready: false, missing: ['daemon'] },
  ],
  live: {},
  sandboxes: [],
  readErrors: {},
}

const troubleView = {
  stores: [
    {
      name: 'alpha-store', kind: 'sqlite', machine: 'docker', state: 'blocked',
      blockedBy: { machine: 'docker', reason: 'stopped' }, projects: ['app'], projectsCount: 1,
      size: { bytes: 420000, stale: true, seen: 1000 }, links: [], ownConnections: [],
    },
    {
      name: 'broken-store', kind: 'sqlite', machine: 'native', state: 'broken',
      reason: 'corrupt', message: 'Store header unreadable', fix: 'layerfs store compact broken-store',
      projects: ['web'], projectsCount: 1, size: { bytes: 120000 },
      links: [{ bucket: 'b1', file: 'f1' }], ownConnections: [],
    },
  ],
  machines: [
    { name: 'native', platform: 'native', state: 'ready', stores: ['broken-store'], sandboxes: [] },
    { name: 'docker', platform: 'docker', state: 'stopped', stores: ['alpha-store'], sandboxes: [] },
  ],
  buckets: [
    { name: 'b1', provider: 'minio', files: [{ file: 'f1', store: 'broken-store', behind: true, changed: false, missing: false }] },
  ],
  jobs: [],
  auths: [],
  at: 61000,
}

const noopStoreActions = () => ({
  openStore: () => {}, openMachine: () => {}, openBackups: () => {}, addProject: () => {},
  push: () => {}, pull: () => {}, move: () => {}, backup: () => {}, compact: () => {},
  disconnect: () => {}, remove: () => {}, fix: () => {}, retry: () => {}, dismiss: () => {},
})

test('P0-1 (Option A): Signal renders semantic StateDot with full reason & HoverCard fix matching observed app/web scenes (en + zh)', () => {
  for (const lang of ['en', 'zh']) {
    const t = makeT(lang)
    const place = (m) => (m === 'native' ? t('layerfsHome') : m ?? '?')

    // app on unavailable stopped docker: warning dot, full reason inside HoverCard, NO fix button
    const appTrouble = M.storeTrouble(troubleView.stores[0], troubleView, t, place, emptyFleet)
    assert.equal(appTrouble?.state, 'warning')
    const appAction = M.troubleAction(appTrouble, t)
    assert.equal(appAction, undefined, `expected no action button for unavailable docker (${lang})`)
    const appHtml = renderToStaticMarkup(createElement(M.Signal, { state: appTrouble.state, title: appTrouble.reason, detail: appTrouble.detail, action: appAction }))
    assert.match(appHtml, /data-dot=""/, `Option A Signal button must carry data-dot (${lang})`)
    assert.match(appHtml, /data-primitive="StateDot" data-state="warning"/, `app Signal must render warning StateDot (${lang})`)
    assert.ok(!appHtml.includes('data-primitive="Button"'), `app HoverCard must not render a fix button (${lang})`)
    const expectedAppReason = lang === 'zh' ? 'docker 现在无法在这台电脑上运行。' : 'docker can’t run on this computer now.'
    assert.ok(appHtml.includes(expectedAppReason), `expected full reason ${expectedAppReason}`)

    // web on broken-store: error dot, Store header unreadable + Compact broken-store CTA
    const webTrouble = M.storeTrouble(troubleView.stores[1], troubleView, t, place, emptyFleet)
    assert.equal(webTrouble?.state, 'error')
    const webAction = M.troubleAction(webTrouble, t)
    const runner = {
      run: async () => ({}),
      label: (fix) => t('fixRunCompact', { name: fix.store ?? '' }),
      confirm: () => 'confirm',
      tip: (line) => line,
      done: 'done',
    }
    const webHtml = renderToStaticMarkup(createElement(M.FixContext.Provider, { value: runner }, createElement(M.Signal, { state: webTrouble.state, title: webTrouble.reason, detail: webTrouble.detail, action: webAction })))
    assert.match(webHtml, /data-dot=""/)
    assert.match(webHtml, /data-primitive="StateDot" data-state="error"/, `web Signal must render error StateDot (${lang})`)
    assert.ok(webHtml.includes('Store header unreadable'))
    const expectedFix = lang === 'zh' ? '压缩 broken-store' : 'Compact broken-store'
    assert.ok(webHtml.includes(expectedFix), `expected web fix button ${expectedFix} (${lang})`)
  }

  const signalCss = src('src/client/storage/Signal.module.css')
  assert.match(signalCss, /\.signal\[data-dot\]\s*\{[\s\S]*border-radius:\s*50%;/)
})

test('P0-3: MachineStores shows broken red dot and amber stale backup dot while leaving stopped-machine Store/MachineLine quiet', () => {
  const t = makeT('en')
  const html = renderToStaticMarkup(createElement(M.HomeStores, {
    api: { call: async () => ({}) },
    stores: troubleView.stores,
    view: troubleView,
    t,
    now: 61000,
    jobs: [],
    dismissed: new Set(),
    actionsFor: noopStoreActions,
    loginActions: () => ({}),
    sandboxes: [],
    place: (m) => (m === 'native' ? t('layerfsHome') : m ?? '?'),
    onOpenStore: () => {},
    onOpenProject: () => {},
    onOpenBackups: () => {},
    onStartMachine: () => {},
    onNewStore: () => {},
    onConnect: () => {},
  }))

  // Exactly one error StateDot in StoreStatus (for broken-store); alpha-store on stopped docker renders no StateDot
  const statusDots = [...html.matchAll(/data-primitive="StateDot" data-state="([^"]+)"/g)].map((m) => m[1])
  assert.deepEqual(statusDots, ['error'], 'only broken StoreStatus renders a StateDot; stopped machine alpha-store has none')

  // Backup badge on broken-store keeps amber stale dot; stopped docker MachineLine gets no health dot
  assert.match(html, /data-health="stale"/, 'backup behind: true keeps amber stale health dot')
  const alphaMachineHtml = renderToStaticMarkup(createElement(M.MachineLine, { s: troubleView.stores[0], view: troubleView, t, on: noopStoreActions() }))
  assert.ok(!alphaMachineHtml.includes('data-health='), 'stopped docker MachineLine must not show health dot')

  const msCss = src('src/client/storage/MachineStores.module.css')
  assert.ok(!msCss.includes('.statusRow > :first-child:not(.statusText)'), 'CSS must not hide status dots globally')
  assert.ok(!/\.dot\s*\{[^}]*display:\s*none/.test(msCss), 'CSS .dot must remain visible for stale backup dots')
})

test('P0-2 (Option A) & P1-2: Hero identity shows LayerFS version + short SHA; empty Stores/Buckets cards show in-card guides & CTAs', () => {
  for (const lang of ['en', 'zh']) {
    const t = makeT(lang)
    t.doctorT = makeDocT(lang)

    // 1. BucketCards empty card includes ovNoBucketsBody + ovAddBucket button
    const bucketsHtml = renderToStaticMarkup(createElement(M.BucketCards, {
      view: { stores: [], machines: [], buckets: [], jobs: [], at: 0 },
      t,
      now: 61000,
      jobs: [],
      onOpen: () => {},
      onAddBucket: () => {},
      onList: () => {},
      onReconnect: () => {},
      onRestore: () => {},
    }))
    assert.ok(bucketsHtml.includes(t('ovNoBucketsBody')), `empty Buckets card must include ovNoBucketsBody (${lang})`)
    assert.ok(bucketsHtml.includes(t('ovAddBucket')), `empty Buckets card must include ovAddBucket button (${lang})`)

    // 2. HomeOverview empty Stores tab renders noStoresBody, primary newStore, outline connectDatabase,
    // omits duplicate New Store button from tab bar, and mounts runtime identity in HomeHero
    const homeHtml = renderToStaticMarkup(createElement(M.HomeOverview, {
      view: { stores: [], machines: troubleView.machines, buckets: [], jobs: [], at: 0 },
      error: null,
      t,
      setup: (k) => k,
      now: 61000,
      doctor: { data: null, loading: false, error: null },
      jobs: [],
      dismissed: new Set(),
      onOpen: () => {},
      onRefresh: () => {},
      onCheckAgain: () => {},
      refreshKey: 0,
      onNewStore: () => {},
      onConnect: () => {},
      onBackups: () => {},
      onNewMachine: () => {},
      onAddStore: () => {},
      onRemoveProject: () => {},
      onRetry: () => {},
      onDismiss: () => {},
      onBackup: () => {},
      onAddBucket: () => {},
      onPresets: () => {},
      presetsLabel: 'Presets',
      onListBucket: () => {},
      onListAll: () => {},
      listingAll: false,
      onReconnect: () => {},
      onRestore: () => {},
      actionsFor: noopStoreActions,
      loginActions: () => ({}),
      sandboxes: [],
      tab: 'stores',
      onTab: () => {},
    }))
    assert.ok(homeHtml.includes(t('noStoresBody')), `empty Stores card must include noStoresBody (${lang})`)
    assert.match(homeHtml, new RegExp(`data-primitive="Button" data-variant="primary"[^>]*>[\\s\\S]*${t('newStore')}`))
    assert.match(homeHtml, new RegExp(`data-primitive="Button" data-variant="outline"[^>]*>[\\s\\S]*${t('connectDatabase')}`))
    const newStoreButtons = homeHtml.match(new RegExp(`data-primitive="Button"[^>]*>(?:(?!<button).)*?${t('newStore')}</button>`, 'g')) ?? []
    assert.equal(newStoreButtons.length, 1, `New Store button should appear once (inside card), not duplicated in tab bar (${lang})`)
    assert.ok(homeHtml.includes(t('ovRuntimeChecking')), `HomeOverview must render runtimeBadge (${lang})`)
  }

  // P0-2 Option A: HomeHero heading aligns identity beside Overview title (before tools group) with monospace nowrap style
  const heroTsx = src('src/client/storage/HomeHero.tsx')
  assert.match(heroTsx, /<h1 className=\{css\.title\}>\{title\}<\/h1>\s*\{identity\}/)
  const heroCss = src('src/client/storage/HomeHero.module.css')
  assert.match(heroCss, /\.heading\s*\{[^}]*align-items:\s*center;/)
  assert.match(heroCss, /\.runtime\s*\{[^}]*white-space:\s*nowrap;/)
  const homeTsx = src('src/client/storage/HomeOverview.tsx')
  assert.match(homeTsx, /<HomeHero\s+title=\{t\('overview'\)\}\s+identity=\{runtimeBadge\}/)
})
