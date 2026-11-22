// Regression tests for ui/204 (Store disabled reasons via storeWaitsFor,
// ExplainedButton, StoreMenu, StoreProjects, StoreLinks/StoreBackups, and
// Store card foot actions).
//   node --test test/store-disabled-reasons.test.mjs
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
const out = mkdtempSync(join(root, 'lib', '.test-store-disabled-reasons-'))

globalThis.__u204Captured = { buttons: [], tooltips: [], menuItems: [] }

const testPlugin = {
  name: 'u204-test-stubs',
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
        Button: `({ variant, size, type = 'button', icon, children, className, title, 'aria-label': ariaLabel, 'aria-disabled': ariaDisabled, 'aria-describedby': ariaDescribedBy, disabled, onClick }) => { globalThis.__u204Captured.buttons.push({ label: typeof children === 'string' ? children : ariaLabel ?? '', variant, type, disabled: !!disabled, ariaDisabled: !!ariaDisabled, ariaDescribedBy, onClick }); return createElement('button', { type, 'data-primitive': 'Button', 'data-variant': variant, className, title, 'aria-label': ariaLabel, 'aria-disabled': ariaDisabled ? 'true' : undefined, 'aria-describedby': ariaDescribedBy, disabled: !!disabled }, icon, children) }`,
        Tooltip: `({ label, disabled, side, portal, children }) => { globalThis.__u204Captured.tooltips.push({ label, disabled: !!disabled, side, portal: !!portal }); return createElement('span', { 'data-primitive': 'Tooltip', 'data-tooltip-disabled': disabled ? 'true' : 'false', 'data-tooltip-label': label }, children) }`,
        Menu: `({ anchor, children }) => createElement('div', { 'data-primitive': 'Menu' }, anchor, createElement('div', { 'data-menu-body': 'true' }, children))`,
        MenuItemButton: `({ children, disabled, disabledReason, danger, onSelect }) => { globalThis.__u204Captured.menuItems.push({ label: typeof children === 'string' ? children : String(children), disabled: !!disabled, disabledReason, danger: !!danger, onSelect }); return createElement('button', { type: 'button', role: 'menuitem', 'data-primitive': 'MenuItemButton', disabled: !!disabled, 'data-disabled-reason': disabledReason }, children) }`,
        StateDot: `({ state, size }) => createElement('span', { 'data-primitive': 'StateDot', 'data-state': state, 'data-size': size })`,
        Input: `({ value, placeholder, 'aria-label': ariaLabel }) => createElement('input', { value, placeholder, 'aria-label': ariaLabel })`,
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
      'machines/context.tsx': `export const useMachinesContext = () => ({ api: { call: async () => ({}) }, useMachines: (s) => s({ data: null, loading: false, error: null }), t: (k) => k }); export const useMachinesMaybe = () => null`,
      'ui/use-query.ts': `export const useQuery = () => ({ data: undefined, loading: false, error: null, reload: () => {} })`,
      'storage/hooks.ts': `export const useHostEvents = () => {}`,
      'projects/hooks.ts': `export const useProjectSessions = () => ({ data: null })`,
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
      export * as sm from './src/client/storage/model.ts'
      export { ExplainedButton } from './src/client/ui/index.tsx'
      export { StoreMenu } from './src/client/storage/StoreCard.tsx'
      export { StoreProjects } from './src/client/storage/StoreProjects.tsx'
      export { StoreBackups } from './src/client/storage/StoreLinks.tsx'
      export { HomeStores } from './src/client/storage/MachineStores.tsx'
      export { locales as storageLocales } from './src/client/storage/locale.ts'
    `,
    resolveDir: root,
    loader: 'tsx',
  },
  outfile: join(out, 'u204.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  loader: { '.module.css': 'local-css', '.css': 'css' },
  plugins: [testPlugin],
  logLevel: 'error',
})

const M = await import(pathToFileURL(join(out, 'u204.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

const src = (rel) => readFileSync(join(root, rel), 'utf8')
const fill = (s, vars = {}) => s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`))
const makeT = (lang) => (key, vars) => fill(M.storageLocales[lang][key] ?? key, vars)
const resetCaptured = () => {
  globalThis.__u204Captured = { buttons: [], tooltips: [], menuItems: [] }
}

const makeStore = (name, over = {}) => ({
  name, kind: 'sqlite', machine: 'native', state: 'ready',
  projects: ['app'], projectsCount: 1, size: { bytes: 4096 },
  links: [{ bucket: 'b1', file: `${name}.db`, last: { op: 'backup', at: 1000, bytes: 4096 } }],
  ownConnections: [], ...over,
})

const noopActions = (calls = {}) => ({
  push: () => { calls.push = (calls.push ?? 0) + 1 },
  pull: () => { calls.pull = (calls.pull ?? 0) + 1 },
  move: () => { calls.move = (calls.move ?? 0) + 1 },
  backup: () => { calls.backup = (calls.backup ?? 0) + 1 },
  backupTo: () => { calls.backupTo = (calls.backupTo ?? 0) + 1 },
  compact: () => { calls.compact = (calls.compact ?? 0) + 1 },
  restore: () => { calls.restore = (calls.restore ?? 0) + 1 },
  remove: () => {}, disconnect: () => {}, start: () => {},
  addProject: () => { calls.addProject = (calls.addProject ?? 0) + 1 },
  retry: () => {}, dismiss: () => {}, openMachine: () => {},
  editConnection: () => {}, check: () => {}, connectMachine: () => {}, removeOwn: () => {}, newOnServer: () => {},
})

test('ui/204 model: storeWaitsFor & compactWaitsFor cover ready, local job, other client op, machine stopped/busy/broken, broken/unresolved Store, and unknown', () => {
  for (const lang of ['en', 'zh']) {
    const t = makeT(lang)
    assert.equal(M.sm.storeWaitsFor(makeStore('s1'), t), null)
    assert.equal(M.sm.storeWaitsFor(makeStore('s1'), t, true), t('storeNeedsOpFinish'))
    assert.equal(M.sm.storeWaitsFor(makeStore('s1', { job: 'j1' }), t), t('storeNeedsOpFinish'))
    assert.equal(M.sm.storeWaitsFor(makeStore('s1', { state: 'busy' }), t), t('storeNeedsOpFinish'))
    assert.equal(M.sm.storeWaitsFor(makeStore('s1', { state: 'busy', op: { name: 'move', phase: 'send' } }), t), t('opRunning', { op: 'move · send' }))
    assert.equal(M.sm.storeWaitsFor(makeStore('s1', { state: 'busy', op: { name: 'move', phase: 'send' } }), t, true), t('storeNeedsOpFinish'))
    assert.equal(M.sm.storeWaitsFor(makeStore('s1', { machine: 'docker', state: 'blocked', blockedBy: { machine: 'docker', reason: 'stopped' } }), t), t('compactNeedsMachine', { machine: 'docker' }))
    assert.equal(M.sm.storeWaitsFor(makeStore('s1', { machine: 'vm-busy', state: 'blocked', blockedBy: { machine: 'vm-busy', reason: 'busy' } }), t), t('storeNeedsMachineBusy', { machine: 'vm-busy' }))
    assert.equal(M.sm.storeWaitsFor(makeStore('s1', { machine: 'vm-broken', state: 'blocked', blockedBy: { machine: 'vm-broken', reason: 'failed' } }), t), t('compactNeedsMachineFixed', { machine: 'vm-broken' }))
    assert.equal(M.sm.storeWaitsFor(makeStore('s1', { state: 'broken', fix: 'layerfs store compact s1' }), t), t('storeNeedsCompact'))
    assert.equal(M.sm.compactWaitsFor(makeStore('s1', { state: 'broken', fix: 'layerfs store compact s1' }), t), null, 'Compact stays enabled when its fix is compact')
    assert.equal(M.sm.compactWaitsFor(makeStore('s1', { state: 'broken', fix: 'layerfs store compact s1' }), t, true), t('storeNeedsOpFinish'))
    assert.equal(M.sm.storeWaitsFor(makeStore('s1', { state: 'broken', fix: 'layerfs store remove s1' }), t), t('storeNeedsRepair'))
    assert.equal(M.sm.compactWaitsFor(makeStore('s1', { state: 'broken', fix: 'layerfs store remove s1' }), t), t('storeNeedsRepair'))
    assert.equal(M.sm.storeWaitsFor(makeStore('s1', { state: 'unknown' }), t), t('compactNeedsIdle'))
  }
  assert.equal(M.storageLocales.en.opRunning, 'Another client runs {op} on this Store')
  assert.equal(M.storageLocales.zh.opRunning, '另一个客户端正在此 Store 上运行 {op}')
})

test('ui/204 ExplainedButton: uses aria-disabled + Tooltip + aria-describedby + hidden reason span, blocks onClick/submit, and keeps CSS hover guards', () => {
  let clicks = 0
  resetCaptured()
  const html = renderToStaticMarkup(createElement(M.ExplainedButton, {
    variant: 'primary',
    type: 'submit',
    disabled: true,
    disabledReason: 'Start machine docker first',
    onClick: () => { clicks++ },
  }, 'Add project'))

  assert.equal(globalThis.__u204Captured.tooltips.length, 1)
  assert.deepEqual(globalThis.__u204Captured.tooltips[0], { label: 'Start machine docker first', disabled: false, side: 'bottom', portal: true })
  const btn = globalThis.__u204Captured.buttons[0]
  assert.equal(btn.disabled, false, 'ExplainedButton must NOT pass native disabled when disabledReason is present')
  assert.equal(btn.ariaDisabled, true, 'ExplainedButton must set aria-disabled=true')
  assert.equal(btn.type, 'button', 'ExplainedButton must neutralize type=submit while explained')
  assert.equal(btn.onClick, undefined, 'ExplainedButton must omit onClick while explained')
  assert.ok(btn.ariaDescribedBy, 'ExplainedButton must wire aria-describedby')
  assert.ok(html.includes(`<span id="${btn.ariaDescribedBy}" hidden="">Start machine docker first</span>`), 'hidden reason span must match aria-describedby')
  assert.equal(clicks, 0)

  // Enabled state wires onClick and disables Tooltip
  resetCaptured()
  renderToStaticMarkup(createElement(M.ExplainedButton, {
    variant: 'primary',
    disabled: false,
    disabledReason: 'ignored while enabled',
    onClick: () => { clicks++ },
  }, 'Add project'))
  assert.equal(globalThis.__u204Captured.tooltips[0].disabled, true)
  assert.equal(globalThis.__u204Captured.buttons[0].ariaDisabled, false)
  assert.equal(globalThis.__u204Captured.buttons[0].disabled, false)
  globalThis.__u204Captured.buttons[0].onClick()
  assert.equal(clicks, 1)

  // Native disabled fallback without reason
  resetCaptured()
  renderToStaticMarkup(createElement(M.ExplainedButton, { variant: 'outline', disabled: true, onClick: () => {} }, 'Plain off'))
  assert.equal(globalThis.__u204Captured.tooltips[0].disabled, true)
  assert.equal(globalThis.__u204Captured.buttons[0].disabled, true)
  assert.equal(globalThis.__u204Captured.buttons[0].ariaDisabled, false)

  const uiCss = src('src/client/ui/ui.module.css')
  assert.match(uiCss, /\.disabledButton\[aria-disabled='true'\]\s*\{[^}]*cursor:\s*not-allowed;[^}]*opacity:\s*0\.4;/)
  assert.match(uiCss, /\.disabledButton\[aria-disabled='true'\]\[data-variant='primary'\]:hover/)
  assert.match(uiCss, /\.disabledButton\[aria-disabled='true'\]\[data-variant='outline'\]:hover/)
})

test('ui/204 StoreMenu, StoreProjects, StoreBackups, and Store card foot wire disabledReason in EN and ZH', () => {
  const view = {
    stores: [],
    machines: [
      { name: 'native', platform: 'native', state: 'ready', stores: [], sandboxes: [] },
      { name: 'docker', platform: 'docker', state: 'stopped', stores: [], sandboxes: [] },
    ],
    buckets: [{ name: 'b1', provider: 'minio', files: [{ file: 's-stopped.db', store: 's-stopped', bytes: 100, modified: 1000, behind: false, changed: false, missing: false }, { file: 's-busy.db', store: 's-busy', bytes: 100, modified: 1000, behind: false, changed: false, missing: false }] }],
    jobs: [],
    auths: [],
    at: 61000,
  }
  const stoppedStore = makeStore('s-stopped', { machine: 'docker', state: 'blocked', blockedBy: { machine: 'docker', reason: 'stopped' } })
  const busyStore = makeStore('s-busy', { machine: 'native', state: 'busy', op: { name: 'move', phase: 'send' } })
  const unresolvedStore = makeStore('s-unresolved', { machine: 'native', state: 'broken', fix: 'layerfs store compact s-unresolved' })
  const readyStore = makeStore('s-ready', { machine: 'native', state: 'ready' })

  for (const lang of ['en', 'zh']) {
    const t = makeT(lang)
    const stoppedReason = t('compactNeedsMachine', { machine: 'docker' })
    const busyReason = t('opRunning', { op: 'move · send' })

    // 1. StoreMenu on stoppedStore: Pull/Move/Back up/Back up now/Compact all disabled with stoppedReason; Remove stays enabled
    resetCaptured()
    renderToStaticMarkup(createElement(M.StoreMenu, { store: stoppedStore, on: noopActions(), t }))
    const stoppedItems = globalThis.__u204Captured.menuItems
    for (const label of [t('pullHome'), t('moveTo'), t('backupTo'), `${t('backupNow')} · b1/s-stopped.db`, t('compactStore')]) {
      const item = stoppedItems.find((x) => x.label === label)
      assert.ok(item, `expected menu item ${label} (${lang})`)
      assert.equal(item.disabled, true, `${label} must be disabled (${lang})`)
      assert.equal(item.disabledReason, stoppedReason, `${label} disabledReason (${lang})`)
    }
    const removeItem = stoppedItems.find((x) => x.label === t('remove'))
    assert.equal(removeItem?.disabled, false)
    assert.equal(removeItem?.disabledReason, undefined)

    // 2. StoreMenu on unresolvedStore: Back up/Push disabled with storeNeedsCompact, Compact enabled
    resetCaptured()
    renderToStaticMarkup(createElement(M.StoreMenu, { store: unresolvedStore, on: noopActions(), t }))
    const unresolvedItems = globalThis.__u204Captured.menuItems
    assert.equal(unresolvedItems.find((x) => x.label === t('pushTo'))?.disabledReason, t('storeNeedsCompact'))
    assert.equal(unresolvedItems.find((x) => x.label === t('compactStore'))?.disabled, false)
    assert.equal(unresolvedItems.find((x) => x.label === t('compactStore'))?.disabledReason, undefined)

    // 3. StoreProjects Add project: disabled + Tooltip reason on stopped/runningJob; clickable on ready
    resetCaptured()
    renderToStaticMarkup(createElement(M.StoreProjects, {
      api: { call: async () => ({}) },
      store: { name: 's-stopped', kind: 'sqlite', state: 'blocked' },
      names: ['app'],
      projects: undefined,
      stored: null,
      stores: [stoppedStore],
      fleet: null,
      t,
      now: 61000,
      tick: 0,
      canAdd: false,
      addDisabledReason: stoppedReason,
      onAdd: () => {},
      onOpen: () => {},
    }))
    const addBtnStopped = globalThis.__u204Captured.buttons.find((b) => b.label === t('addProject'))
    assert.equal(addBtnStopped?.ariaDisabled, true, `Add project must be aria-disabled when stopped (${lang})`)
    assert.equal(addBtnStopped?.onClick, undefined)
    assert.ok(globalThis.__u204Captured.tooltips.some((tp) => !tp.disabled && tp.label === stoppedReason), `Add project Tooltip must carry stoppedReason (${lang})`)

    resetCaptured()
    const projCalls = {}
    renderToStaticMarkup(createElement(M.StoreProjects, {
      api: { call: async () => ({}) },
      store: { name: 's-ready', kind: 'sqlite', state: 'ready' },
      names: ['app'],
      projects: undefined,
      stored: null,
      stores: [readyStore],
      fleet: null,
      t,
      now: 61000,
      tick: 0,
      canAdd: true,
      addDisabledReason: null,
      onAdd: noopActions(projCalls).addProject,
      onOpen: () => {},
    }))
    const addBtnReady = globalThis.__u204Captured.buttons.find((b) => b.label === t('addProject'))
    assert.equal(addBtnReady?.ariaDisabled, false)
    addBtnReady?.onClick()
    assert.equal(projCalls.addProject, 1)

    // 4. StoreBackups (StoreLinks.tsx): Back up to & Back up now disabled with stoppedReason; Restore stays enabled when stopped, disabled when busy
    resetCaptured()
    const restoreCalls = {}
    renderToStaticMarkup(createElement(M.StoreBackups, { store: stoppedStore, view, t, now: 61000, on: noopActions(restoreCalls) }))
    assert.equal(globalThis.__u204Captured.buttons.find((b) => b.label === t('backupTo'))?.ariaDisabled, true)
    assert.equal(globalThis.__u204Captured.buttons.find((b) => b.label === t('backupNow'))?.ariaDisabled, true)
    const restoreStopped = globalThis.__u204Captured.buttons.find((b) => b.label === t('restore'))
    assert.equal(restoreStopped?.ariaDisabled, false, `Restore must stay enabled when only machine is stopped (${lang})`)
    restoreStopped?.onClick()
    assert.equal(restoreCalls.restore, 1)
    assert.equal(globalThis.__u204Captured.tooltips.filter((tp) => !tp.disabled && tp.label === stoppedReason).length, 2)

    resetCaptured()
    renderToStaticMarkup(createElement(M.StoreBackups, { store: busyStore, view, t, now: 61000, on: noopActions() }))
    for (const label of [t('backupTo'), t('backupNow'), t('restore')]) {
      assert.equal(globalThis.__u204Captured.buttons.find((b) => b.label === label)?.ariaDisabled, true, `${label} must be disabled when busy (${lang})`)
    }
    assert.equal(globalThis.__u204Captured.tooltips.filter((tp) => !tp.disabled && tp.label === busyReason).length, 3)

    // 5. HomeStores card foot: Pull disabled with stoppedReason on stoppedStore; Push to… disabled with busyReason on busyStore; Push to… enabled on readyStore
    resetCaptured()
    const cardCalls = {}
    renderToStaticMarkup(createElement(M.HomeStores, {
      api: { call: async () => ({}) },
      stores: [stoppedStore, busyStore, readyStore],
      view: { ...view, stores: [stoppedStore, busyStore, readyStore] },
      t,
      now: 61000,
      jobs: [],
      dismissed: new Set(),
      actionsFor: () => noopActions(cardCalls),
      loginActions: () => ({}),
      sandboxes: [],
      actionHost: null,
      onNewStore: () => {},
      onConnect: () => {},
      onOpenStore: () => {},
      onOpenProject: () => {},
      onBackups: () => {},
    }))
    const pullFoot = globalThis.__u204Captured.buttons.find((b) => b.label === t('msPull'))
    assert.equal(pullFoot?.ariaDisabled, true, `stopped card foot Pull must be aria-disabled (${lang})`)
    assert.equal(pullFoot?.onClick, undefined)
    assert.ok(globalThis.__u204Captured.tooltips.some((tp) => !tp.disabled && tp.label === stoppedReason))

    const pushButtons = globalThis.__u204Captured.buttons.filter((b) => b.label === t('pushTo'))
    assert.equal(pushButtons.length, 2)
    assert.equal(pushButtons[0].ariaDisabled, true, `busy card foot Push to… must be aria-disabled (${lang})`)
    assert.equal(pushButtons[0].onClick, undefined)
    assert.ok(globalThis.__u204Captured.tooltips.some((tp) => !tp.disabled && tp.label === busyReason))
    assert.equal(pushButtons[1].ariaDisabled, false, `ready card foot Push to… must be enabled (${lang})`)
    pushButtons[1].onClick()
    assert.equal(cardCalls.push, 1)
  }
})
