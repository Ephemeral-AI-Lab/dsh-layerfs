// Targeted regression tests for PB-01 Home & Storage fixes:
// P0-1 (Signal opt-in dot vs shared callers like BucketPage), P0-2 (Option A), P0-3, and P1-2.
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

globalThis.__pb01Setup = null
globalThis.__pb01Buttons = []

// Render real TSX components on React 18 server markup while exposing inspectable DOM attributes
// for @deepseek-ai/dsh-client-ui-primitives and lightweight context/button-click capture.
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
        Button: `({ variant, size, icon, children, className, title, 'aria-label': ariaLabel, disabled, onClick }) => { globalThis.__pb01Buttons.push({ label: typeof children === 'string' ? children : ariaLabel ?? '', variant, onClick }); return createElement('button', { type: 'button', 'data-primitive': 'Button', 'data-variant': variant, 'data-size': size, className, title, 'aria-label': ariaLabel, disabled }, icon, children) }`,
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
      'setup/store.ts': `export const setupDialog = { open: () => {} }; export const useSetupStatus = () => ({ data: globalThis.__pb01Setup, loading: false, error: null }); export const useInstalled = () => null; export const lately = () => null`,
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
      export { BucketCards } from './src/client/storage/BucketCards.tsx'
      export { BucketPage } from './src/client/storage/BucketPage.tsx'
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

test('P0-1 (Option A): opt-in Signal dot renders StateDot + full HoverCard body for Home & ProjectTable while default Signal keeps visible word for BucketPage', () => {
  for (const lang of ['en', 'zh']) {
    const t = makeT(lang)
    const doctorT = makeDocT(lang)
    const place = (m) => m ?? '?'

    // app on unavailable stopped docker: opt-in dot -> warning StateDot; HoverCard content body itself carries full reason (no fix button)
    const appTrouble = M.storeTrouble(troubleView.stores[0], troubleView, t, place, emptyFleet)
    assert.equal(appTrouble?.state, 'warning')
    const appAction = M.troubleAction(appTrouble, t)
    assert.equal(appAction, undefined, `expected no action button for unavailable docker (${lang})`)
    const appHtml = renderToStaticMarkup(createElement(M.Signal, { dot: true, state: appTrouble.state, title: appTrouble.reason, detail: appTrouble.detail, action: appAction }))
    assert.match(appHtml, /data-dot=""/, `opt-in dot Signal must carry data-dot (${lang})`)
    assert.match(appHtml, /StatusDot_dot[^"]*" data-state="warning"/, `app Signal must render warning StatusDot (${lang})`)
    const appHoverBody = appHtml.slice(appHtml.indexOf('data-hovercard-content'))
    const expectedAppReason = lang === 'zh' ? 'docker 现在无法在这台电脑上运行。' : 'docker can’t run on this computer now.'
    assert.ok(appHoverBody.includes(expectedAppReason), `HoverCard body itself must contain full reason (${lang})`)
    assert.ok(!appHoverBody.includes('data-primitive="Button"'), `app HoverCard must not render a fix button (${lang})`)

    // web on broken-store: opt-in dot -> error dot; HoverCard body contains Store header unreadable + Compact broken-store CTA
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
    const webHtml = renderToStaticMarkup(createElement(M.FixContext.Provider, { value: runner }, createElement(M.Signal, { dot: true, state: webTrouble.state, title: webTrouble.reason, detail: webTrouble.detail, action: webAction })))
    assert.match(webHtml, /data-dot=""/)
    assert.match(webHtml, /StatusDot_dot[^"]*" data-state="error"/, `web Signal must render error StatusDot (${lang})`)
    const webHoverBody = webHtml.slice(webHtml.indexOf('data-hovercard-content'))
    assert.ok(webHoverBody.includes('Store header unreadable'))
    const expectedFix = lang === 'zh' ? '压缩 broken-store' : 'Compact broken-store'
    assert.ok(webHoverBody.includes(expectedFix), `HoverCard body must render fix button ${expectedFix} (${lang})`)

    // BucketPage shared Signal caller: must NOT default to dot-only; keeps visible Broken / 已损坏 text + detail tip
    const brokenBucket = { name: 'broken-bucket', provider: 'minio', state: 'broken', message: 'bucket corrupt', fix: 'layerfs backup remove broken-bucket', files: null }
    const bucketHtml = renderToStaticMarkup(createElement(M.BucketPage, {
      name: 'broken-bucket',
      view: { stores: [], machines: [], buckets: [brokenBucket], jobs: [], auths: [], at: 0 },
      t,
      api: { call: async () => ({}) },
      doctorT,
      now: 61000,
      listing: false,
      onList: () => {},
      onRestore: () => {},
      onBackup: () => {},
      onDisconnect: () => {},
      onReconnect: () => {},
      onOpenStore: () => {},
      onOpenFile: () => {},
    }))
    const statusIdx = bucketHtml.indexOf('data-bucket-status="broken"')
    assert.ok(statusIdx >= 0, `BucketPage must render broken status container (${lang})`)
    const statusSlice = bucketHtml.slice(statusIdx, bucketHtml.indexOf('</div>', statusIdx))
    const firstBtn = /<button[^>]*>([\s\S]*?)<\/button>/.exec(statusSlice)
    assert.ok(firstBtn, 'expected first button inside broken bucket status')
    assert.equal(firstBtn[1], t('bucketRecordBroken'), `BucketPage broken status button must keep visible text, not dot-only (${lang})`)
    assert.ok(!statusSlice.includes('data-dot=""'), `BucketPage status signal must not opt into data-dot (${lang})`)
    assert.ok(statusSlice.includes('bucket corrupt'), `BucketPage HoverCard keeps detail message (${lang})`)
  }

  // Ensure HomeOverview and ProjectTable explicitly pass dot to their target Signal callers
  assert.match(src('src/client/storage/ProjectTable.tsx'), /<Signal\s+dot\s+state=\{trouble\.state\}/)
  assert.match(src('src/client/storage/HomeOverview.tsx'), /<Signal\s+dot\s+state=\{top\.tone/)
  assert.match(src('src/client/storage/HomeOverview.tsx'), /<Signal\s+dot\s+state=\{n\.tone/)

  const signalCss = src('src/client/storage/Signal.module.css')
  assert.match(signalCss, /\.signal\[data-dot\]\s*\{[\s\S]*border-radius:\s*50%;/)
})

test('P0-2 (Option A) & P1-2: Hero identity shows LayerFS version + 8-char SHA; empty Stores/Buckets cards wire live callbacks', () => {
  for (const lang of ['en', 'zh']) {
    const t = makeT(lang)
    t.doctorT = makeDocT(lang)

    // 1. BucketCards empty card renders ovNoBucketsBody + wired ovAddBucket callback
    let addBucketCalls = 0
    globalThis.__pb01Buttons = []
    const bucketsHtml = renderToStaticMarkup(createElement(M.BucketCards, {
      view: { stores: [], machines: [], buckets: [], jobs: [], at: 0 },
      t,
      now: 61000,
      jobs: [],
      onOpen: () => {},
      onAddBucket: () => { addBucketCalls++ },
      onList: () => {},
      onReconnect: () => {},
      onRestore: () => {},
    }))
    assert.ok(bucketsHtml.includes(t('ovNoBucketsBody')), `empty Buckets card must include ovNoBucketsBody (${lang})`)
    const bucketBtn = globalThis.__pb01Buttons.find((b) => b.label === t('ovAddBucket'))
    assert.ok(bucketBtn && typeof bucketBtn.onClick === 'function', `expected wired ovAddBucket button (${lang})`)
    bucketBtn.onClick()
    assert.equal(addBucketCalls, 1, `clicking ovAddBucket must invoke onAddBucket (${lang})`)

    // 2. HomeOverview ready runtime fixture renders LayerFS version + exact 8-char short SHA + wired Stores CTAs
    globalThis.__pb01Setup = { runtime: { ok: true, version: '2.0.0', commit: 'ed911896abcdef1234', home: '/Users/dev/.layerfs' }, needs: [] }
    let newStoreCalls = 0
    let connectCalls = 0
    globalThis.__pb01Buttons = []
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
      onNewStore: () => { newStoreCalls++ },
      onConnect: () => { connectCalls++ },
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
    globalThis.__pb01Setup = null

    assert.ok(homeHtml.includes(t('noStoresBody')), `empty Stores card must include noStoresBody (${lang})`)
    const newStoreButtons = homeHtml.match(new RegExp(`data-primitive="Button"[^>]*>(?:(?!<button).)*?${t('newStore')}</button>`, 'g')) ?? []
    assert.equal(newStoreButtons.length, 1, `New Store button should appear once (inside card), not duplicated in tab bar (${lang})`)

    const newStoreBtn = globalThis.__pb01Buttons.find((b) => b.label === t('newStore') && b.variant === 'primary')
    const connectBtn = globalThis.__pb01Buttons.find((b) => b.label === t('connectDatabase') && b.variant === 'outline')
    assert.ok(newStoreBtn?.onClick, `expected primary newStore CTA (${lang})`)
    assert.ok(connectBtn?.onClick, `expected outline connectDatabase CTA (${lang})`)
    newStoreBtn.onClick()
    connectBtn.onClick()
    assert.equal(newStoreCalls, 1, `clicking New Store must invoke onNewStore (${lang})`)
    assert.equal(connectCalls, 1, `clicking Connect a database must invoke onConnect (${lang})`)

    assert.ok(homeHtml.includes('LayerFS 2.0.0'), `runtimeBadge must show LayerFS version (${lang})`)
    assert.ok(homeHtml.includes('ed911896'), `runtimeBadge must show 8-char short SHA (${lang})`)
    assert.ok(!homeHtml.includes('ed911896abcdef1234'), `runtimeBadge must truncate commit SHA to 8 chars (${lang})`)
  }

  const heroTsx = src('src/client/storage/HomeHero.tsx')
  // the LayerFS × DSH lockup is the h1's visible face; the page's name stays for assistive technology
  assert.match(heroTsx, /<h1 className=\{css\.title\}><span className=\{css\.srOnly\}>\{title\}<\/span><BrandLockup \/><\/h1>\s*\{identity\}/)
  const heroCss = src('src/client/storage/HomeHero.module.css')
  assert.match(heroCss, /\.heading\s*\{[^}]*align-items:\s*center;/)
  assert.match(heroCss, /\.runtime\s*\{[^}]*white-space:\s*nowrap;/)
  const homeTsx = src('src/client/storage/HomeOverview.tsx')
  assert.match(homeTsx, /<HomeHero\s+title=\{t\('overview'\)\}\s+identity=\{runtimeBadge\}/)
})
