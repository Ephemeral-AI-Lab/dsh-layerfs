// PB-03 (R2): a stopped machine's Files tab still explains why it cannot read —
// "the machine is stopped, start its worker and the tab reads again" — with the
// error details folded and Read again, and no Start of its own (the page head
// holds the one Start). Both places: a refused first read, and a folder already
// on screen that can no longer be read. A Sandbox's Files tab, and a running
// machine's, are untouched.
//
// Rendered, not matched as source: the product's InspectFiles, MachineDetail and
// SandboxDetail are bundled and driven through the small hook runtime in
// mini-react.mjs, with the Machines context (its translate table and host API)
// faked. Fails on ec610d5 (the stopped guidance disappears with the removed
// `unavailableAction`) and passes after FIX2 decoupled the guidance from it.
//   node --test test/pb03-files-stopped.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { miniReact } from './mini-react.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-pb03-files-stopped-'))

/**
 * The page's Machines context (`machines/context.tsx`) and remembered tab
 * (`machines/detail-tabs.ts`) are faked — a test drives them with the values
 * below instead of DSH's slot. The Sandbox page's own reads (`Sandboxes.tsx`)
 * and its page bar are faked too: this file is about its Files tab. Everything
 * else is the product.
 */
const fakes = {
  name: 'pb03-fakes',
  setup(b) {
    const at = (file) => new RegExp(`(^|/)${file.replace('.', '\\.')}$`)
    b.onResolve({ filter: at('context.tsx') }, () => ({ path: 'context', namespace: 'pb03' }))
    b.onResolve({ filter: at('detail-tabs.ts') }, () => ({ path: 'tabs', namespace: 'pb03' }))
    b.onResolve({ filter: at('Sandboxes.tsx') }, (a) => (a.importer.endsWith('SandboxDetail.tsx') ? { path: 'sandboxes', namespace: 'pb03' } : null))
    b.onResolve({ filter: at('PaneBar.tsx') }, () => ({ path: 'panebar', namespace: 'pb03' }))
    b.onLoad({ filter: /.*/, namespace: 'pb03' }, (a) => ({ loader: 'js', contents: {
      context: [
        'export const useMachinesContext = () => { const c = globalThis.__pb03?.ctx; if (!c) throw new Error("no faked machines context"); return c }',
        'export const useMachinesMaybe = () => globalThis.__pb03?.ctx ?? null',
        'export const MachinesProvider = ({ children }) => children',
        'export const tabOfView = (view) => (view.kind === "board" ? "machines" : `${view.kind}:${view.name}`)',
      ].join('\n'),
      tabs: [
        'export const useDetailTab = (_kind, _name, _keys, fallback) => [globalThis.__pb03?.tab ?? fallback, (next) => { if (globalThis.__pb03) globalThis.__pb03.tab = next }]',
        'export const readDetailTab = () => null',
        'export const writeDetailTab = () => {}',
        'export const watchDetailTab = () => () => {}',
      ].join('\n'),
      sandboxes: [
        'export const useSandboxRead = () => ({ data: globalThis.__pb03?.sandboxInfo ?? null, error: null, loading: false, reload: () => {} })',
        'export const useClose = () => ({ busy: false, error: null, unknown: null, close: async () => true, forceAllowed: true, uncertain: false })',
        'export const SandboxMenu = () => null',
      ].join('\n'),
      panebar: 'export const usePageReading = () => {}',
    }[a.path] }))
  },
}

await build({
  absWorkingDir: root,
  stdin: {
    contents: [
      "export { mount, elements, text } from 'react'",
      "export { InspectFiles } from './src/client/machines/InspectFiles.tsx'",
      "export { MachineDetail } from './src/client/machines/MachineDetail.tsx'",
      "export { SandboxDetail } from './src/client/machines/SandboxDetail.tsx'",
      "export { PowerButton } from './src/client/machines/parts.tsx'",
      "export { locales } from './src/client/machines/locale.ts'",
      "export { HostError } from './src/client/api.ts'",
    ].join('\n'),
    resolveDir: root, loader: 'tsx',
  },
  outfile: join(out, 'pb03.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24', logLevel: 'error',
  jsx: 'automatic', loader: { '.module.css': 'local-css', '.css': 'css' }, plugins: [miniReact, fakes],
})
const M = await import(pathToFileURL(join(out, 'pb03.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

// ---------------------------------------------------------------- fixtures

/** The product's sentence for `key`, its {placeholders} filled. */
const sentence = (lang, key, vars = {}) => String(M.locales[lang][key] ?? key).replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`))
const fill = (text, vars) => String(text).replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`))
const translate = (lang) => (key, vars) => fill(M.locales[lang][key] ?? key, vars)

const refusedError = (name = 'lima') => new M.HostError('Unavailable', `machine "${name}" is stopped`, 501)
const folderAnswer = () => ({
  kind: 'folder', path: '/', observedAt: Date.now(), stale: false, next: null, hasMore: false, reason: null,
  entries: [{ path: '/srv', depth: 1, kind: 'folder', size: null, mode: null, mtime: null }],
})

/** A host API whose files reads answer `answer(url)`; every other call answers nothing. */
const hostApi = (answer) => ({ call: (_method, url) => Promise.resolve().then(() => answer(url)), op: () => Promise.resolve({}) })

const machine = (platform, state) => ({
  name: platform, platform, backend: platform, state, supports: ['files', 'log'],
  cpus: 4, memory: 8 * 2 ** 30, disk: 40 * 2 ** 30, stores: [], sandboxes: [],
})
const machinesView = (m, extra = {}) => ({
  available: true, layerfs: '2.0.0', machines: [m], platforms: [], stores: [], postgresql: [], sandboxes: [],
  live: {}, features: { inspect: { machineFiles: true, machineLog: true } }, ...extra,
})

/** The Machines context a page renders with: the product's words, the test's host. */
const ctxOf = ({ m, view, lang = 'en', answer = folderAnswer }) => ({
  t: translate(lang), tw: (w) => (w?.key ? translate(lang)(w.key, w.values) : String(w ?? '')),
  doctorT: (key) => key, kind: (platform) => platform,
  api: hostApi(answer),
  useMachines: (select) => select({ status: 'ready', data: view ?? machinesView(m), error: null, observedAt: 1 }),
  useStartups: (select) => select({}),
  useRuntime: (select) => select({}),
  useConnected: () => true,
  useCreations: (select) => select({}),
  metrics: { watch: () => undefined, subscribe: () => () => {}, getSnapshot: () => ({}) },
  act: async () => {},
  readSandbox: async () => null, closeSandbox: async () => null,
  stateWord: (look) => look.label ?? look.raw ?? 'unknown',
  refusal: { category: (c) => c, inTheWay: '', kind: (k) => k, phase: (p) => p, operation: (o) => o },
  openStorageTab: () => {}, go: () => {},
})

const render = (component, props, state) => {
  globalThis.__pb03 = state
  return M.mount(component, props)
}
const elements = (tree) => M.elements(tree)
const powerButtons = (tree) => elements(tree).filter((e) => e.type === M.PowerButton)
const isTree = (e) => typeof e.type === 'function' && e.type.name === 'FileTree'

/** The machine page as a stopped/running machine draws it, with its Files tab up. */
async function machinePage(platform, state, lang = 'en', answer = folderAnswer) {
  const m = machine(platform, state)
  const t = render(M.MachineDetail, { name: platform, go: () => {} }, { ctx: ctxOf({ m, lang, answer }), tab: 'files' })
  const viewElement = t.tree
  const page = M.mount(viewElement.type, viewElement.props)
  await page.settle()
  const files = elements(page.tree).find((e) => e.type === M.InspectFiles)
  assert.ok(files, 'the machine page draws its Files tab')
  return { page, files }
}

/** The Files tab as drawn, mounted with the given host answer, once its reads settled. */
async function filesTab(files, ctx) {
  // the context the tab reads with, in place before its first render
  globalThis.__pb03 = { ...(globalThis.__pb03 ?? {}), ctx }
  const tab = M.mount(M.InspectFiles, files.props)
  await tab.settle()
  await tab.settle()
  const tree = elements(tab.tree).find(isTree)
  assert.ok(tree, 'the Files tab draws a file tree')
  return { tab, tree: tree.props }
}

// ---------------------------------------------------------------- cases

for (const platform of ['lima', 'docker']) {
  test(`${platform}: a stopped machine's Files tab says it is stopped, offers Read again and no Start`, async () => {
    const { page, files } = await machinePage(platform, 'stopped')
    assert.equal(powerButtons(page.tree).length, 1, 'the page has one Start: the page head')
    const head = elements(page.tree).find((e) => e.type?.name === 'PageHead' || e.type === 'PageHead')
    assert.equal(powerButtons(head).length, 1, 'that Start is the page head\'s')

    const { tree } = await filesTab(files, ctxOf({ m: machine(platform, 'stopped'), answer: () => { throw refusedError(platform) } }))
    const note = tree.failed(tree.root, refusedError(platform))
    const text = M.text(note)
    assert.match(text, new RegExp(sentence('en', 'filesMachineStopped', { name: platform })), 'the stop is explained with the machine named')
    assert.match(text, new RegExp(sentence('en', 'filesStartToRead')), 'the reader is told starting the worker lets it read')
    assert.match(text, new RegExp(sentence('en', 'filesReadAgain')), 'Read again stays')
    assert.match(text, new RegExp(sentence('en', 'filesErrorDetails')), 'the error details stay folded')
    assert.equal(elements(note).filter((e) => e.type === 'details').length, 1, 'the details are a <details> fold')
    assert.equal(powerButtons(note).length, 0, 'the note carries no Start of its own')
  })

  test(`${platform}: a stopped machine's Files tab says it is stopped when a folder it shows can no longer be read`, async () => {
    let unavailable = false
    const answer = () => { if (!unavailable) return folderAnswer(); throw refusedError(platform) }
    const { files } = await machinePage(platform, 'stopped', 'en', answer)
    const { tab } = await filesTab(files, ctxOf({ m: machine(platform, 'stopped'), answer }))
    const loaded = elements(tab.tree).find(isTree).props
    assert.equal(typeof loaded.after, 'function')
    assert.equal(loaded.after(loaded.root), null, 'a folder read without trouble carries no note')

    // read once, then the machine stops: Refresh keeps the folder it has and says why
    const refresh = elements(tab.tree).find((e) => typeof e.props?.onClick === 'function' && M.text(e) === sentence('en', 'refresh'))
    assert.ok(refresh, 'the Files tab has its Refresh')
    unavailable = true
    refresh.props.onClick()
    await tab.settle()
    await tab.settle()

    const kept = elements(tab.tree).find(isTree).props
    const note = kept.after(kept.root)
    assert.ok(note != null, 'a kept folder says its read was refused')
    const text = M.text(note)
    assert.match(text, new RegExp(sentence('en', 'filesMachineStopped', { name: platform })), 'the stop is explained with the machine named')
    assert.match(text, new RegExp(sentence('en', 'filesStartToRead')), 'the reader is told starting the worker lets it read')
    assert.match(text, new RegExp(sentence('en', 'filesReadAgain')), 'Read again stays')
    assert.match(text, new RegExp(sentence('en', 'filesErrorDetails')), 'the error details stay folded')
    assert.equal(elements(note).filter((e) => e.type === 'details').length, 1, 'the details are a <details> fold')
    assert.equal(powerButtons(note).length, 0, 'the note carries no Start of its own')
  })
}

test('the stopped guidance is in the interface language, not only LayerFS\'s message', async () => {
  const { files } = await machinePage('lima', 'stopped', 'zh')
  const { tree } = await filesTab(files, ctxOf({ m: machine('lima', 'stopped'), lang: 'zh', answer: () => { throw refusedError() } }))
  const text = M.text(tree.failed(tree.root, refusedError()))
  assert.match(text, new RegExp(sentence('zh', 'filesMachineStopped', { name: 'lima' })))
  assert.match(text, new RegExp(sentence('zh', 'filesStartToRead')))
  assert.match(text, new RegExp(sentence('zh', 'filesReadAgain')))
  assert.match(text, new RegExp(sentence('zh', 'filesErrorDetails')))
})

test('a running machine\'s Files tab does not claim the machine is stopped', async () => {
  const { page, files } = await machinePage('lima', 'ready')
  assert.equal(powerButtons(page.tree).length, 1, 'the page head still holds the Start it had')
  const { tree } = await filesTab(files, ctxOf({ m: machine('lima', 'ready'), answer: () => { throw refusedError() } }))
  const text = M.text(tree.failed(tree.root, refusedError()))
  assert.match(text, /Unavailable/, 'the refusal names its code')
  assert.doesNotMatch(text, new RegExp(sentence('en', 'filesMachineStopped', { name: 'lima' })), 'no stopped guidance on a running machine')
  assert.doesNotMatch(text, new RegExp(sentence('en', 'filesStartToRead')))
})

test('the Worker log tab of a stopped machine keeps its own banner and no Start', async () => {
  const m = machine('lima', 'stopped')
  globalThis.__pb03 = { ctx: ctxOf({ m }), tab: 'log' }
  const detail = M.mount(M.MachineDetail, { name: 'lima', go: () => {} })
  const page = M.mount(detail.tree.type, detail.tree.props)
  await page.settle()
  const log = elements(page.tree).find((e) => typeof e.type === 'function' && e.type.name === 'LogPane')
  assert.ok(log, 'the Worker log tab is drawn')
  assert.equal(log.props.unavailable?.message, sentence('en', 'logMachineStopped'), 'the banner keeps the stopped sentence')
  assert.equal('action' in log.props, false, 'no Start in the log banner')
  assert.equal(powerButtons(page.tree).length, 1, 'the page head holds the only Start')
})

test('a Sandbox\'s Files tab shows no machine-stopped guidance', async () => {
  const listed = { name: 'box', machine: 'lima', state: 'ready', project: null, live: true }
  const info = { name: 'box', machine: 'lima', state: 'ready', workspaces: [], project: null }
  globalThis.__pb03 = {
    ctx: ctxOf({ m: machine('lima', 'stopped'), view: machinesView(machine('lima', 'stopped'), { sandboxes: [listed] }), answer: () => { throw refusedError() } }),
    tab: 'files', sandboxInfo: info,
  }
  const detail = M.mount(M.SandboxDetail, { machine: 'lima', name: 'box', go: () => {} })
  await detail.settle()
  const files = elements(detail.tree).find((e) => e.type === M.InspectFiles)
  assert.ok(files, 'the Sandbox page draws its Files tab')

  const tab = M.mount(M.InspectFiles, files.props)
  await tab.settle()
  const tree = elements(tab.tree).find(isTree).props
  const text = M.text(tree.failed(tree.root, refusedError()))
  assert.match(text, /Unavailable/, 'the refusal still names its code')
  assert.match(text, new RegExp(sentence('en', 'filesReadAgain')), 'Read again stays')
  assert.doesNotMatch(text, new RegExp(sentence('en', 'filesMachineStopped', { name: 'box' })), 'no machine-stopped guidance in a Sandbox')
  assert.doesNotMatch(text, new RegExp(sentence('en', 'filesStartToRead')))
})
