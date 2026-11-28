// The New Session project chip's three ownership states: a known project is
// its name, `notProject` is "No project", and a failed read is a neutral chip
// with Retry — never a false "No project". The menu stays available.
//   node --test test/hero-ownership.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { miniReact } from './mini-react.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-hero-ownership-'))
await build({
  absWorkingDir: root,
  stdin: {
    contents: [
      "export { mount, elements, text } from 'react'",
      "export { HeroProjectControl } from './src/client/hero/HeroProject.tsx'",
      "export { locales } from './src/client/hero/locale.ts'",
    ].join('\n'),
    resolveDir: root, loader: 'tsx',
  },
  outfile: join(out, 'hero.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24', logLevel: 'error',
  jsx: 'automatic', loader: { '.module.css': 'local-css', '.css': 'css' }, plugins: [miniReact],
})
const M = await import(pathToFileURL(join(out, 'hero.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

const fill = (text, vars = {}) => text.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`))
const tOf = (lang) => (key, vars) => fill(M.locales[lang][key] ?? key, vars)
const EN = tOf('en')
const EN_DICT = M.locales.en

/** The control's own inputs: no store, no session.place, a catalog that answers empty. */
function props(ownership, retry = () => {}) {
  const api = {
    op: async (name) => (name === 'projects.catalog' ? { rows: [] } : {}),
    call: async () => ({ stores: [] }),
    onEvent: () => () => {},
    pickDirectory: async () => null,
  }
  const imports = { get: () => null, subscribe: () => () => {}, set: () => {} }
  return { sessionId: 'blank-1', api, t: EN, tp: EN, imports, ownership, retry }
}

const buttons = (tree) => M.elements(tree).filter((e) => e.type === 'button')
const chipOf = (tree, label) => buttons(tree).find((e) => e.props['aria-label'] === label)
const retryOf = (tree, word) => buttons(tree).find((e) => M.text(e) === word)

test('unknown: a neutral chip with Retry, never "No project"', async () => {
  let retried = 0
  const view = M.mount(M.HeroProjectControl, props({ state: 'unknown', error: new Error('host unavailable') }, () => { retried++ }))
  const tree = await view.settle()
  const chip = chipOf(tree, EN_DICT.placeUnknown)
  assert.ok(chip, 'the chip stays where it is, in the unknown state')
  assert.match(M.text(chip), /Could not read this session's project/)
  assert.doesNotMatch(M.text(chip), /No project/)
  assert.equal(chip.props['aria-haspopup'], 'menu', 'the project menu stays available')
  const retry = retryOf(tree, EN_DICT.retry)
  assert.ok(retry, 'a Retry action is on screen')
  retry.props.onClick()
  assert.equal(retried, 1, 'Retry reads the session again')
})

test('project: the chip names the project', async () => {
  const view = M.mount(M.HeroProjectControl, props({ state: 'project', project: 'st/app', projectId: 'pid', scratch: '/tmp/scratch' }))
  const tree = await view.settle()
  const chip = chipOf(tree, fill(EN_DICT.chipAria, { project: 'app' }))
  assert.ok(chip, 'the project chip')
  assert.ok(M.text(chip).includes('app'))
  assert.doesNotMatch(M.text(tree), /No project/)
})

test('a project session in no workspace leaves DSH its own workspace chip: no scratch selector', async () => {
  const ownership = { state: 'project', project: 'st/app', projectId: 'pid', scratch: '/tmp/scratch' }
  const scratchShown = (tree) => M.elements(tree).some((e) => e.props && 'data-layerfs-scratch' in e.props)
  const listed = await M.mount(M.HeroProjectControl, props(ownership)).settle()
  assert.equal(scratchShown(listed), true)
  const p = props(ownership)
  p.api.sessionUnlisted = () => true
  p.api.onWorkspaces = () => () => {}
  const tree = await M.mount(M.HeroProjectControl, p).settle()
  assert.equal(scratchShown(tree), false)
  assert.ok(chipOf(tree, fill(EN_DICT.chipAria, { project: 'app' })), 'the project chip stays')
})

test('a draft in no workspace is replaced by a fresh one in the project; a started session never is', async () => {
  const run = async (sessionId, draft, listed = false) => {
    const calls = []
    const p = props({ state: 'project', project: 'st/app', projectId: 'pid', ...(draft ? { draft: true } : {}) })
    p.sessionId = sessionId
    p.api.sessionUnlisted = () => true
    p.api.onWorkspaces = () => () => {}
    p.api.openProjectSession = async (...args) => { calls.push(['open', ...args]); return { sessionId: `${sessionId}-new` } }
    const op = p.api.op
    p.api.op = async (name, args) => {
      if (name === 'sessions.reattach') return { listed }
      if (name === 'sessions.archive') calls.push([name, args])
      return op(name, args)
    }
    await M.mount(M.HeroProjectControl, p).settle()
    await new Promise((resolve) => setTimeout(resolve, 1000))
    return calls
  }
  assert.deepEqual(await run('old-draft', true), [['open', 'st/app', undefined, 'pid'], ['sessions.archive', { sessionId: 'old-draft' }]])
  assert.deepEqual(await run('has-history', false), [])
  assert.deepEqual(await run('list-lagging', true, true), [], 'the host put it back: nothing replaced')
})

test('notProject: the chip says No project', async () => {
  const view = M.mount(M.HeroProjectControl, props({ state: 'notProject' }))
  const tree = await view.settle()
  const chip = chipOf(tree, fill(EN_DICT.chipAria, { project: EN_DICT.noProject }))
  assert.ok(chip, 'the no-project chip')
  assert.ok(M.text(chip).includes('No project'))
})

test('the unknown copy is in both locales', () => {
  for (const lang of ['en', 'zh']) {
    assert.ok(M.locales[lang].placeUnknown, `${lang}.placeUnknown`)
    assert.ok(M.locales[lang].retry, `${lang}.retry`)
  }
  assert.notEqual(M.locales.en.placeUnknown, M.locales.en.noProject)
})
