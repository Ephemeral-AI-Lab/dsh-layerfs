// A `sessions.open` DSH refuses (a stored-only row, an identity mismatch) must
// say so at that session's row, not only at the project: one Retry, DSH's
// message as text, the row's open disabled while it runs, and the refusal gone
// on success or when the row's session list is read again.
//   node --test test/project-list-open.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { miniReact } from './mini-react.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-project-list-open-'))
await build({
  absWorkingDir: root,
  stdin: {
    contents: [
      "export { mount, elements, text } from 'react'",
      "export { SessionLine } from './src/client/projects/ProjectList.tsx'",
      "export { locales as listLocales } from './src/client/projects/list-locale.ts'",
    ].join('\n'),
    resolveDir: root, loader: 'tsx',
  },
  outfile: join(out, 'open.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24', logLevel: 'error',
  jsx: 'automatic', loader: { '.module.css': 'local-css', '.css': 'css' }, plugins: [miniReact],
})
const M = await import(pathToFileURL(join(out, 'open.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

const src = readFileSync(join(root, 'src/client/projects/ProjectList.tsx'), 'utf8')
const fill = (text, vars = {}) => text.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`))
const t = (key, vars) => fill(M.listLocales.en[key] ?? key, vars)
const session = { sessionId: 'stored-1', title: 'Chat', local: false, updatedAt: 1, state: 'stored' }
const props = (onOpen, extra = {}) => ({ session, title: 'Chat', selected: false, t, onOpen, onArchive: async () => null, ...extra })
const find = (tree, pred) => M.elements(tree).filter((e) => pred(e.props ?? {}, e))
const openButton = (tree) => find(tree, (p) => p['data-open-session'] === 'stored-1')[0]
const noticeOf = (tree) => find(tree, (p) => 'data-open-refused' in p)
const pressOpen = (view) => { openButton(view.tree).props.onClick(); return view.settle() }

test('a refused open shows DSH\'s message under that row, with one Retry', async () => {
  const message = 'cannot open the session: it is stored in the project, not in this DSH'
  const asked = []
  const view = M.mount(M.SessionLine, props(() => { asked.push('open'); return Promise.reject(new Error(message)) }))
  const after = await pressOpen(view)
  const notice = noticeOf(after)
  assert.equal(notice.length, 1, 'the refusal is at the session row')
  assert.equal(notice[0].props['data-open-refused'], 'stored-1')
  const word = find(notice[0], (p) => p.role === 'alert')[0]
  assert.equal(M.text(word), message, 'DSH\'s message is the text, not only a tip')
  const actions = find(notice[0], (p) => typeof p.onClick === 'function')
  assert.equal(actions.length, 1, 'one retry action')
  assert.equal(M.text(actions[0]), t('openAgain'))
  assert.ok(!openButton(after).props.disabled, 'the row can be pressed again')
  assert.deepEqual(asked, ['open'])
})

test('Retry asks again; a resolved open clears the refusal', async () => {
  const asked = []
  const answers = [() => Promise.reject(new Error('refused once')), () => Promise.resolve()]
  const view = M.mount(M.SessionLine, props(() => { asked.push(asked.length + 1); return answers.shift()() }))
  let tree = await pressOpen(view)
  assert.equal(noticeOf(tree).length, 1)
  const retry = find(noticeOf(tree)[0], (p) => typeof p.onClick === 'function')[0]
  retry.props.onClick()
  tree = await view.settle()
  assert.equal(noticeOf(tree).length, 0, 'the resolved open clears it')
  assert.equal(asked.length, 2, 'Retry asks again')
})

test('the open button is disabled while that row\'s open runs', async () => {
  let release
  const view = M.mount(M.SessionLine, props(() => new Promise((resolve) => { release = resolve })))
  openButton(view.tree).props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const pending = view.render()
  assert.equal(openButton(pending).props.disabled, true, 'only this row waits')
  release()
  const done = await view.settle()
  assert.ok(!openButton(done).props.disabled)
  assert.equal(noticeOf(done).length, 0)
})

test('a reload that replaces the row clears the refusal', async () => {
  const view = M.mount(M.SessionLine, props(() => Promise.reject(new Error('gone'))))
  let tree = await pressOpen(view)
  assert.equal(noticeOf(tree).length, 1)
  tree = view.render({ ...props(() => Promise.reject(new Error('again'))), session: { ...session, updatedAt: 2, state: 'local', local: true } })
  tree = await view.settle()
  assert.equal(noticeOf(tree).length, 0, 'the fresh answer replaces the refusal')
})

test('resume keeps the open tracked: it returns the promise and reloads on success, no refusal is swallowed', () => {
  assert.match(src, /const resume = \(sessionId: string\) => api\.op\('sessions\.open', \{ sessionId, project: project\.key \}\)\.then\(\(\) => \{ onChanged\(\) \}\)/)
  assert.doesNotMatch(src, /\.catch\(\(\) => \{\}\)/)
  for (const lang of ['en', 'zh']) assert.ok(M.listLocales[lang].openAgain, `${lang}.openAgain`)
})
