// Regression tests for ui/205 (Store stopped machine neutral tone & copy,
// stopped / broken / ok three-state grading across StoreCard, StorePage,
// HealthCard and MachineLine).
//   node --test test/store-stopped-neutral.test.mjs
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
const out = mkdtempSync(join(root, 'lib', '.test-store-stopped-neutral-'))

globalThis.__u205Machines = []

const testPlugin = {
  name: 'u205-test-stubs',
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
        Button: `({ variant, size, icon, children, className, title, 'aria-label': ariaLabel, 'aria-disabled': ariaDisabled, 'data-start-machine': startMachine, 'data-repair': repair, disabled }) => createElement('button', { type: 'button', 'data-primitive': 'Button', 'data-variant': variant, 'data-size': size, className, title, 'aria-label': ariaLabel, 'aria-disabled': ariaDisabled, 'data-start-machine': startMachine, 'data-repair': repair, disabled }, icon, children)`,
        StateDot: `({ state, size }) => createElement('span', { 'data-primitive': 'StateDot', 'data-state': state, 'data-size': size })`,
        Tooltip: `({ label, disabled, children }) => createElement('span', { 'data-primitive': 'Tooltip', 'data-tooltip-label': disabled ? undefined : label }, children)`,
        MenuItemButton: `({ children, disabled, disabledReason }) => createElement('button', { type: 'button', 'data-primitive': 'MenuItemButton', disabled, 'data-disabled-reason': disabledReason }, children)`,
        SegmentedTabs: `({ items, value }) => createElement('div', { 'data-primitive': 'SegmentedTabs', 'data-value': value }, items.map((i) => createElement('button', { key: i.value, type: 'button', role: 'tab', 'aria-selected': i.value === value }, i.label)))`,
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
      'machines/context.tsx': `export const useMachinesMaybe = () => ({ useMachines: (sel) => sel({ data: { available: true, machines: globalThis.__u205Machines }, loading: false, error: null }), openStorageTab: () => {} })`,
      'machines/detail-tabs.ts': `export const useDetailTab = (_kind, _name, _offered, first) => [first, () => {}]`,
      'projects/hooks.ts': `export const useProjectMachines = () => ({ data: { available: true, machines: globalThis.__u205Machines, sandboxes: [] } }); export const useProjectSessions = () => ({ data: null })`,
      'doctor/Doctor.tsx': `export const DoctorAction = () => null`,
      'storage/hooks.ts': `export const useHostEvents = () => {}`,
      'ui/use-query.ts': `export const useQuery = () => ({ data: undefined, loading: false, error: null, reload: () => {} }); export const cachedAnswer = () => undefined; export const errorText = (e) => String(e?.message ?? e); export const errorCode = (e) => e?.code`,
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
      export { HomeStores, MachineLine } from './src/client/storage/MachineStores.tsx'
      export { storeNotice, storePageNotice } from './src/client/storage/StoreCard.tsx'
      export { StorePage } from './src/client/storage/StorePage.tsx'
      export { locales as storageLocales } from './src/client/storage/locale.ts'
      export { locales as doctorLocales } from './src/client/doctor/locale.ts'
    `,
    resolveDir: root,
    loader: 'tsx',
  },
  outfile: join(out, 'u205.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  loader: { '.module.css': 'local-css', '.css': 'css' },
  plugins: [testPlugin],
  logLevel: 'error',
})

const M = await import(pathToFileURL(join(out, 'u205.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

const src = (rel) => readFileSync(join(root, rel), 'utf8')
const fill = (s, vars = {}) => s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`))
const makeT = (lang) => (key, vars) => fill(M.storageLocales[lang][key] ?? key, vars)
const makeDocT = (lang) => (key, vars) => fill(M.doctorLocales[lang][key] ?? key, vars)

const fixtureMachines = [
  { name: 'native', platform: 'native', state: 'ready', stores: ['ok-store', 'broken-store'], sandboxes: [] },
  { name: 'docker', platform: 'docker', state: 'stopped', stores: ['stopped-store'], sandboxes: [] },
  { name: 'vm-broken', platform: 'lima', state: 'broken', reason: 'outdated', fix: 'layerfs machine repair vm-broken', stores: ['mbroken-store'], sandboxes: [] },
]
globalThis.__u205Machines = fixtureMachines

const fixtureStores = [
  {
    name: 'ok-store', kind: 'sqlite', machine: 'native', state: 'ready',
    projects: ['app'], projectsCount: 1, size: { bytes: 4096 }, links: [], ownConnections: [],
  },
  {
    name: 'stopped-store', kind: 'sqlite', machine: 'docker', state: 'blocked',
    blockedBy: { machine: 'docker', reason: 'stopped' }, fix: null,
    projects: ['app'], projectsCount: 1, size: { bytes: 4096, stale: true, seen: 1000 }, links: [], ownConnections: [],
  },
  {
    name: 'mbroken-store', kind: 'sqlite', machine: 'vm-broken', state: 'blocked',
    blockedBy: { machine: 'vm-broken', reason: 'outdated' }, fix: 'layerfs machine repair vm-broken',
    projects: ['worker'], projectsCount: 1, size: { bytes: 2048, stale: true, seen: 1000 }, links: [], ownConnections: [],
  },
  {
    name: 'broken-store', kind: 'sqlite', machine: 'native', state: 'broken',
    reason: 'corrupt', message: 'Store header unreadable', fix: 'layerfs store compact broken-store',
    projects: ['legacy'], projectsCount: 1, size: { bytes: 1024 }, links: [], ownConnections: [],
  },
  {
    name: 'broken-on-stopped', kind: 'sqlite', machine: 'docker', state: 'broken',
    reason: 'corrupt', message: 'Store header unreadable', fix: 'layerfs store compact broken-on-stopped',
    projects: ['legacy'], projectsCount: 1, size: { bytes: 1024, stale: true, seen: 1000 }, links: [], ownConnections: [],
  },
]

const fixtureView = { stores: fixtureStores, machines: fixtureMachines, buckets: [], jobs: [], auths: [], at: 61000 }

const noopActions = () => ({
  push: () => {}, pull: () => {}, move: () => {}, backup: () => {}, backupTo: () => {},
  compact: () => {}, restore: () => {}, remove: () => {}, disconnect: () => {}, start: () => {},
  addProject: () => {}, retry: () => {}, dismiss: () => {}, openMachine: () => {},
  editConnection: () => {}, check: () => {}, connectMachine: () => {}, removeOwn: () => {}, newOnServer: () => {},
})

test('ui/205 model: three-state grading separates ok, stopped (neutral), and broken (danger)', () => {
  const t = makeT('en')
  const [ok, stopped, mbroken, broken] = fixtureStores

  // 1. storeTone: ok -> success, stopped -> neutral, broken machine/store -> danger
  assert.equal(M.sm.storeTone(ok.state, ok.blockedBy), 'success')
  assert.equal(M.sm.storeTone(stopped.state, stopped.blockedBy), 'neutral')
  assert.equal(M.sm.storeTone('stopped'), 'neutral')
  assert.equal(M.sm.storeTone('blocked', { machine: 'vm1', reason: 'busy' }), 'neutral')
  assert.equal(M.sm.storeTone(mbroken.state, mbroken.blockedBy), 'danger')
  assert.equal(M.sm.storeTone(broken.state, broken.blockedBy), 'danger')

  // 2. storeNoticeTone: neutral (undefined) for ok and stopped; danger for broken machine or broken Store
  assert.equal(M.sm.storeNoticeTone(ok, 'ready'), undefined)
  assert.equal(M.sm.storeNoticeTone(stopped, 'stopped'), undefined)
  assert.equal(M.sm.storeNoticeTone({ kind: 'sqlite', state: 'ready', blockedBy: null }, 'stopped'), undefined)
  assert.equal(M.sm.storeNoticeTone(mbroken, 'broken'), 'danger')
  assert.equal(M.sm.storeNoticeTone({ kind: 'sqlite', state: 'ready', blockedBy: null }, 'broken'), 'danger')
  assert.equal(M.sm.storeNoticeTone(broken, 'ready'), 'danger')
  assert.equal(M.sm.storeNoticeTone(broken, 'stopped'), 'danger')

  // 3. overviewMachineHealth: green for running, grey info for stopped/busy, red danger for broken/unreadable
  assert.deepEqual(M.sm.overviewMachineHealth(ok, 'ready'), { tone: 'ok', key: 'spMachineRunning' })
  assert.deepEqual(M.sm.overviewMachineHealth(stopped, 'stopped'), { tone: 'info', key: 'spMachineStopped' })
  assert.deepEqual(M.sm.overviewMachineHealth({ kind: 'sqlite', machine: 'vm1', state: 'blocked', blockedBy: { machine: 'vm1', reason: 'busy' } }, 'busy'), { tone: 'info', key: 'spMachineBusy' })
  assert.deepEqual(M.sm.overviewMachineHealth(mbroken, 'broken'), { tone: 'danger', key: 'spMachineBroken' })
  assert.deepEqual(M.sm.overviewMachineHealth({ kind: 'sqlite', machine: 'vm1', state: 'blocked', blockedBy: { machine: 'vm1', reason: 'failed' } }, 'broken'), { tone: 'danger', key: 'spMachineUnreadable' })

  // 3b. Combined state: broken Store on a stopped machine keeps Store banner danger while Machine health reports stopped
  const brokenOnStopped = fixtureStores[4]
  assert.deepEqual(M.sm.overviewMachineHealth(brokenOnStopped, 'stopped'), { tone: 'info', key: 'spMachineStopped' })
  assert.equal(M.sm.storeNoticeTone(brokenOnStopped, 'stopped'), 'danger')
  assert.match(M.storePageNotice(brokenOnStopped, 'stopped', t), /Broken · corrupt/)
  assert.equal(M.sm.storeSignal(brokenOnStopped, undefined, 'stopped', [], t)?.state, 'error')

  // 4. Notices & signals: stopped uses cardMachineStopped / storeStoppedNotice and emits no RowSignal
  assert.equal(M.storeNotice(stopped, 'stopped', t), 'docker is stopped')
  assert.equal(M.storePageNotice(stopped, 'stopped', t), 'docker is stopped. Start it to use this Store.')
  assert.equal(M.sm.storeSignal(stopped, undefined, 'stopped', [], t), null)
  assert.equal(M.sm.storeSignal(mbroken, undefined, 'broken', [], t)?.state, 'error')
  assert.equal(M.sm.storeSignal(broken, undefined, 'ready', [], t)?.state, 'error')
})

test('ui/205 HomeStores cards: stopped card stays neutral without grey dot, while broken Store and broken machine render red status + error dot', () => {
  for (const lang of ['en', 'zh']) {
    const t = makeT(lang)
    const html = renderToStaticMarkup(createElement(M.HomeStores, {
      api: { call: async () => ({}) },
      stores: fixtureStores,
      view: fixtureView,
      t,
      now: 61000,
      jobs: [],
      dismissed: new Set(),
      actionsFor: noopActions,
      loginActions: () => ({}),
      sandboxes: [],
      actionHost: null,
      onNewStore: () => {},
      onConnect: () => {},
      onOpenStore: () => {},
      onOpenProject: () => {},
      onBackups: () => {},
    }))

    const cardSlice = (name) => {
      const start = html.indexOf(`data-store="${name}"`)
      assert.ok(start >= 0, `expected card for ${name}`)
      const next = html.indexOf('data-store="', start + 1)
      return next > 0 ? html.slice(start, next) : html.slice(start)
    }

    // Ok store: no statusRow, no error dot
    const okCard = cardSlice('ok-store')
    assert.ok(!okCard.includes('statusRow'), `ok-store must not render statusRow (${lang})`)
    assert.ok(!okCard.includes('data-state="error"'), `ok-store must not render error dot (${lang})`)

    // Stopped store: neutral statusRow (no data-tone="danger" or "warning"), NO dot in statusRow, cardMachineStopped text, Start docker button
    const stoppedCard = cardSlice('stopped-store')
    const statusIdx = stoppedCard.indexOf('statusRow')
    assert.ok(statusIdx >= 0, `stopped-store must render statusRow (${lang})`)
    const statusOpenTag = stoppedCard.slice(stoppedCard.lastIndexOf('<div', statusIdx), stoppedCard.indexOf('>', statusIdx) + 1)
    assert.match(statusOpenTag, /\bMachineStores_statusRow\b/, `stopped-store statusRow must carry MachineStores_statusRow class (${lang})`)
    assert.ok(!statusOpenTag.includes('data-tone="danger"'), `stopped-store statusRow must not be danger (${lang})`)
    assert.ok(!statusOpenTag.includes('data-tone="warning"'), `stopped-store statusRow must not be warning (${lang})`)
    const statusBlock = stoppedCard.slice(stoppedCard.lastIndexOf('<div', statusIdx), stoppedCard.indexOf('</div>', statusIdx))
    assert.ok(!statusBlock.includes('StatusDot_dot') && !statusBlock.includes('data-primitive="StateDot"'), `stopped-store statusRow must not draw a dot (${lang})`)
    assert.ok(statusBlock.includes(t('cardMachineStopped', { machine: 'docker' })), `stopped-store must show cardMachineStopped copy (${lang})`)
    assert.ok(statusBlock.includes('data-start-machine="docker"'), `stopped-store must render Start docker button (${lang})`)
    const stoppedMachineHtml = renderToStaticMarkup(createElement(M.MachineLine, { s: fixtureStores[1], view: fixtureView, t, on: noopActions() }))
    assert.ok(!stoppedMachineHtml.includes('data-health='), `stopped MachineLine must not render dot (${lang})`)

    // Machine broken store: danger statusRow WITH red StateDot AND problem dot on MachineLine chip
    const mbrokenCard = cardSlice('mbroken-store')
    assert.ok(mbrokenCard.includes('data-tone="danger"'), `mbroken-store statusRow must have data-tone="danger" (${lang})`)
    assert.match(mbrokenCard, /StatusDot_dot[^"]*" data-state="error"/, `mbroken-store must render red error StatusDot (${lang})`)
    const mbrokenMachineHtml = renderToStaticMarkup(createElement(M.MachineLine, { s: fixtureStores[2], view: fixtureView, t, on: noopActions() }))
    assert.ok(mbrokenMachineHtml.includes('data-health="problem"'), `broken MachineLine must render problem red dot (${lang})`)

    // Store itself broken: danger statusRow WITH red StateDot
    const brokenCard = cardSlice('broken-store')
    assert.ok(brokenCard.includes('data-tone="danger"'), `broken-store statusRow must have data-tone="danger" (${lang})`)
    assert.match(brokenCard, /StatusDot_dot[^"]*" data-state="error"/, `broken-store must render red error StatusDot (${lang})`)
  }
})

test('ui/205 StorePage: header chip, notice banner, and Health › Machine match three-state grading in EN and ZH', () => {
  for (const lang of ['en', 'zh']) {
    const t = makeT(lang)
    const doctorT = makeDocT(lang)
    const renderStore = (name) => renderToStaticMarkup(createElement(M.StorePage, {
      name,
      view: fixtureView,
      t,
      api: { call: async () => ({}) },
      doctorT,
      now: 61000,
      job: undefined,
      jobs: [],
      catalog: new Map(),
      on: noopActions(),
      onOpenProject: () => {},
    }))

    // 1. Stopped store: neutral chip ("Machine stopped" / "机器已停止"), neutral status notice with Start docker, neutral info Health › Machine
    const stoppedHtml = renderStore('stopped-store')
    assert.match(stoppedHtml, new RegExp(`<span[^>]*data-tone="neutral"[^>]*>[^]*?${t('stateMachineStopped')}</span>`), `stopped StorePage chip must be neutral Machine stopped (${lang})`)
    const noticeMatch = /<div[^>]*class="([^"]+)"[^>]*role="([^"]+)"[^>]*>/.exec(stoppedHtml)
    assert.ok(noticeMatch && noticeMatch[2] === 'status', `stopped StorePage notice must have role="status" (${lang})`)
    assert.match(noticeMatch[1], /\bStorePage_noticeRow\b/, `rendered stopped Notice must carry StorePage_noticeRow class (${lang})`)
    assert.ok(!noticeMatch[0].includes('data-tone="danger"') && !noticeMatch[0].includes('data-tone="warning"'), `stopped notice must not carry danger/warning tone (${lang})`)
    assert.ok(stoppedHtml.includes(t('storeStoppedNotice', { machine: 'docker' })), `stopped StorePage notice must show storeStoppedNotice (${lang})`)
    assert.ok(stoppedHtml.includes('data-start-machine="docker"'), `stopped StorePage notice must include Start docker (${lang})`)
    const stoppedHealthIdx = stoppedHtml.indexOf('data-store-health')
    const stoppedHealth = stoppedHtml.slice(stoppedHealthIdx, stoppedHtml.indexOf('</ul>', stoppedHealthIdx))
    assert.ok(stoppedHealth.includes(`data-tone="info"`), `stopped Health › Machine row must be neutral info (${lang})`)
    assert.ok(stoppedHealth.includes(t('spMachineStopped', { machine: 'docker' })), `stopped Health › Machine text must match spMachineStopped (${lang})`)

    // 2. Machine broken store: red danger chip, red alert notice, red Health › Machine ("is broken" / "已损坏", never "is running")
    const mbrokenHtml = renderStore('mbroken-store')
    assert.match(mbrokenHtml, /<span[^>]*data-tone="danger"[^>]*>/, `broken machine StorePage chip must be danger (${lang})`)
    assert.match(mbrokenHtml, /<div[^>]*class="[^"]*\bStorePage_noticeRow\b[^"]*"[^>]*data-tone="danger"[^>]*role="alert"/, `broken machine StorePage notice must be danger alert with StorePage_noticeRow (${lang})`)
    const mbHealthIdx = mbrokenHtml.indexOf('data-store-health')
    const mbHealth = mbrokenHtml.slice(mbHealthIdx, mbrokenHtml.indexOf('</ul>', mbHealthIdx))
    assert.ok(mbHealth.includes('data-tone="danger"'), `broken machine Health › Machine row must be danger (${lang})`)
    assert.ok(mbHealth.includes(t('spMachineBroken', { machine: 'vm-broken' })), `broken machine Health › Machine must show spMachineBroken (${lang})`)
    assert.ok(!mbHealth.includes(t('spMachineRunning', { machine: 'vm-broken' })), `broken machine must never say running (${lang})`)

    // 3. Broken store: red danger chip, red alert notice
    const brokenHtml = renderStore('broken-store')
    assert.match(brokenHtml, /<span[^>]*data-tone="danger"[^>]*>/, `broken StorePage chip must be danger (${lang})`)
    assert.match(brokenHtml, /<div[^>]*class="[^"]*\bStorePage_noticeRow\b[^"]*"[^>]*data-tone="danger"[^>]*role="alert"/, `broken StorePage notice must be danger alert with StorePage_noticeRow (${lang})`)

    // 3b. Combined broken Store + stopped machine: Store banner stays danger alert while Health › Machine reports stopped (info)
    const comboHtml = renderStore('broken-on-stopped')
    assert.match(comboHtml, /<span[^>]*data-tone="danger"[^>]*>/, `broken-on-stopped chip must stay danger (${lang})`)
    assert.match(comboHtml, /<div[^>]*class="[^"]*\bStorePage_noticeRow\b[^"]*"[^>]*data-tone="danger"[^>]*role="alert"/, `broken-on-stopped banner must stay danger alert (${lang})`)
    const comboHealthIdx = comboHtml.indexOf('data-store-health')
    const comboHealth = comboHtml.slice(comboHealthIdx, comboHtml.indexOf('</ul>', comboHealthIdx))
    assert.ok(comboHealth.includes('data-tone="info"'), `broken-on-stopped Health › Machine must be info (${lang})`)
    assert.ok(comboHealth.includes(t('spMachineStopped', { machine: 'docker' })), `broken-on-stopped Health › Machine must report docker stopped (${lang})`)
    assert.ok(!comboHealth.includes(t('spMachineUnknown', { machine: 'docker' })), `broken-on-stopped Health › Machine must never fall back to unknown (${lang})`)

    // 4. Ok store: no chip, no notice, green Health › Machine
    const okHtml = renderStore('ok-store')
    assert.ok(!okHtml.includes('data-tone="danger"') && !okHtml.includes('data-tone="neutral"'), `ready StorePage must not show state chip or notice (${lang})`)
    const okHealthIdx = okHtml.indexOf('data-store-health')
    const okHealth = okHtml.slice(okHealthIdx, okHtml.indexOf('</ul>', okHealthIdx))
    assert.ok(okHealth.includes('data-tone="ok"'), `ready Health › Machine row must be ok (${lang})`)
    assert.ok(okHealth.includes(t('spMachineRunning', { machine: M.storageLocales[lang].layerfsHome })), `ready Health › Machine must say running (${lang})`)
  }
})

test('ui/205 CSS & locale: compiled statusRow and notice default colors stay neutral, single-row notice layout, neutral info health dot, and EN/ZH copy integrity', () => {
  const builtCss = readFileSync(join(out, 'u205.css'), 'utf8')
  const statusRule = /\.MachineStores_statusRow\s*\{([^}]*)\}/.exec(builtCss)
  assert.ok(statusRule, 'compiled CSS must contain .MachineStores_statusRow rule')
  assert.match(statusRule[1], /color:\s*var\(--dsw-alias-label-secondary\)/, 'default .statusRow text color must use neutral secondary label token')
  assert.doesNotMatch(statusRule[1], /state-error|state-warn|tone-danger|tone-warning|#[0-9a-f]{3,8}/i, 'default .statusRow must never paint text red or amber')
  const statusDangerRule = /\.MachineStores_statusRow\[data-tone=["']?danger["']?\]\s*\{([^}]*)\}/.exec(builtCss)
  assert.ok(statusDangerRule, 'compiled CSS must contain .MachineStores_statusRow[data-tone=danger]')
  assert.match(statusDangerRule[1], /color:\s*var\(--lf-tone-danger-fg\)/)

  const noticeRule = /\.ui_notice\s*\{([^}]*)\}/.exec(builtCss)
  assert.ok(noticeRule, 'compiled CSS must contain .ui_notice rule')
  assert.match(noticeRule[1], /color:\s*var\(--dsw-alias-label-secondary\)/, 'default .notice text color must use neutral secondary label token')
  assert.doesNotMatch(noticeRule[1], /state-error|state-warn|tone-danger|tone-warning/i, 'default .notice must never use error or warn token')

  const spCss = src('src/client/storage/StorePage.module.css')
  assert.match(spCss, /\.noticeRow\s*\{[^}]*flex-direction:\s*row;[^}]*justify-content:\s*space-between;/)
  assert.match(spCss, /\.health li\[data-tone='info'\] > i\s*\{\s*background:\s*var\(--dsw-alias-border-l3\);/)
  assert.match(spCss, /\.health li\[data-tone='danger'\] > i\s*\{\s*background:\s*var\(--lf-tone-danger-dot\);/)
  assert.match(spCss, /\.health li > i\s*\{[^}]*background:\s*var\(--lf-tone-success-dot\);/)

  for (const lang of ['en', 'zh']) {
    for (const key of ['stateMachineStopped', 'cardMachineStopped', 'storeStoppedNotice', 'spMachineStopped', 'spMachineBroken', 'spMachineUnreadable', 'spMachineBusy', 'spMachineUnknown']) {
      assert.ok(M.storageLocales[lang][key], `missing ${lang}.${key}`)
    }
  }
  assert.doesNotMatch(M.storageLocales.zh.spMachineStopped, /stopped|start it/i)
  assert.doesNotMatch(M.storageLocales.zh.storeStoppedNotice, /stopped|Start it/i)
})
