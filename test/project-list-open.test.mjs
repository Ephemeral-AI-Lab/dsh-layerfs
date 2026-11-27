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
      "export { sessionReadiness } from './src/client/projects/session-readiness.ts'",
      "export { locales as listLocales } from './src/client/projects/list-locale.ts'",
      "export { createApi } from './src/client/api.ts'",
      "export { OpeningConversation } from './src/client/projects/opening.tsx'",
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
const canRun = { state: 'available', machine: 'docker', canStart: false, canRun: true, storageBlocked: false }
const props = (onOpen, extra = {}) => ({ session, title: 'Chat', selected: false, t, readiness: M.sessionReadiness(session, canRun, 'demo', t), onOpen, onArchive: async () => null, ...extra })
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

test('the row waits while its open runs, and keeps keyboard focus (aria-disabled, not disabled)', async () => {
  let release
  let asked = 0
  const view = M.mount(M.SessionLine, props(() => { asked++; return new Promise((resolve) => { release = resolve }) }))
  openButton(view.tree).props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const pending = view.render()
  assert.equal(openButton(pending).props['aria-disabled'], true, 'only this row waits')
  assert.ok(!openButton(pending).props.disabled, 'a disabled button would drop focus to the page')
  openButton(pending).props.onClick()
  assert.equal(asked, 1, 'a second press while it opens is ignored')
  release()
  const done = await view.settle()
  assert.ok(!openButton(done).props['aria-disabled'])
  assert.equal(noticeOf(done).length, 0)
})

test('Try again keeps focus on the row it is about; the refusal\'s words match the button', async () => {
  const view = M.mount(M.SessionLine, props(() => Promise.reject(Object.assign(new Error('not listed'), { code: 'session/not-listed' }))))
  let tree = await pressOpen(view)
  let focused = 0
  openButton(tree).props.ref.current = { focus: () => { focused++ } }
  const notice = noticeOf(tree)[0]
  assert.equal(M.text(find(notice, (p) => p.role === 'alert')[0]), t('notListed'))
  find(notice, (p) => typeof p.onClick === 'function')[0].props.onClick()
  assert.equal(focused, 1, 'focus moves to the row before the notice goes')
  tree = await view.settle()
  // One action word: the button says Try again, the message states the fact only.
  for (const lang of ['en', 'zh']) {
    const words = M.listLocales[lang]
    assert.ok(!words.notListed.includes(words.openAgain) && !/Retry|重试/.test(words.notListed), `${lang}: "${words.notListed}" names no second action`)
  }
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
  // The open reloads the project's local rows only (read.reloadLocal): the archive
  // read is a Store walk and paid once per click made the open slow.
  // The open names the selected workspace (DSH publishes a session to the client
  // catalog only while it is attached) and reloads the project's local rows only.
  assert.match(src, /const resume = \(sessionId: string\) => api\.op\('sessions\.open', \{ sessionId, project: project\.key, workspaceId: api\.selectedWorkspaceId\(\) \}\)\.then\(\(\) => \{ read\.reloadLocal\(\) \}\)/)
  assert.doesNotMatch(src, /\.catch\(\(\) => \{\}\)/)
  for (const lang of ['en', 'zh']) assert.ok(M.listLocales[lang].openAgain, `${lang}.openAgain`)
})

// ---------------------------------------------------------------- readiness

const availability = (over = {}) => ({ state: 'available', machine: 'docker', canStart: false, canRun: true, storageBlocked: false, ...over })
const rowButton = (tree, id) => find(tree, (p) => p['data-open-session'] === id)[0]
const actionButtons = (tree) => find(tree, (p) => 'data-session-action' in p)

test('a stored-only session says "Stored elsewhere"; the row itself imports it, with no action', async () => {
  const stored = { sessionId: 'stored-1', title: 'Chat', local: false, updatedAt: 1, state: 'stored' }
  const readiness = M.sessionReadiness(stored, availability(), 'demo', t)
  const asked = []
  const view = M.mount(M.SessionLine, {
    session: stored, title: 'Chat', selected: false, t, readiness,
    onOpen: () => { asked.push('open') }, onArchive: async () => null,
  })
  const tree = view.tree
  assert.match(M.text(tree), /Stored elsewhere/)
  assert.match(M.text(tree), /only in LayerFS/, 'its reason is on screen')
  assert.equal(find(tree, (p) => p['data-session-state'] === 'stored').length, 1, 'the word is beside the title')
  assert.equal(find(tree, (p) => p['data-session-reason'] === 'stored').length, 1, 'the reason is under the row')
  assert.equal(actionButtons(tree).length, 0, 'no readiness action button')
  assert.equal(find(tree, (p) => 'data-archive-session' in p).length, 0, "not DSH's to archive")
  rowButton(tree, 'stored-1').props.onClick()
  await view.settle()
  assert.deepEqual(asked, ['open'], 'the row itself opens it')
})

test('an unavailable row says why, cannot open itself and has no Start action; Archive still works', async () => {
  const local = { sessionId: 'local-1', title: 'Chat', local: true, updatedAt: 1, state: 'local', executionState: 'inactive' }
  const readiness = M.sessionReadiness(local, availability({ state: 'stopped', canRun: false, canStart: true }), 'demo', t)
  const archived = []
  const view = M.mount(M.SessionLine, {
    session: local, title: 'Chat', selected: false, t, readiness,
    onOpen: () => { throw new Error('the blocked row must not open') },
    onArchive: async () => { archived.push('archive'); return null },
  })
  const tree = view.tree
  assert.match(M.text(tree), /Unavailable/)
  assert.match(M.text(tree), /Machine stopped/, 'the existing status wording is the reason')
  assert.equal(find(tree, (p) => p['data-session-state'] === 'unavailable').length, 1)
  const reason = find(tree, (p) => p['data-session-reason'] === 'unavailable')
  assert.equal(reason.length, 1, 'the reason is under the row')
  const row = rowButton(tree, 'local-1')
  assert.equal(row.props['aria-disabled'], true, 'the row itself cannot open')
  assert.ok(!row.props.disabled, 'it stays focusable, so its reason can be reached')
  assert.equal(row.props['aria-describedby'], reason[0].props.id, 'assistive tech reads the reason with the row')
  row.props.onClick()
  await view.settle()
  assert.equal(actionButtons(tree).length, 0, 'no readiness action button')
  assert.doesNotMatch(M.text(tree), /Start docker/, 'no Start action')
  const archive = find(tree, (p) => 'data-archive-session' in p)
  assert.equal(archive.length, 1, 'Archive still renders beside it')
  archive[0].props.onClick()
  await view.settle()
  assert.deepEqual(archived, ['archive'])
})

test('a session being bound says Starting, with no reason, and its row can still open', () => {
  const starting = { sessionId: 'start-1', title: 'Chat', local: true, updatedAt: 1, state: 'pending', executionState: 'activating' }
  const readiness = M.sessionReadiness(starting, availability(), 'demo', t)
  const view = M.mount(M.SessionLine, {
    session: starting, title: 'Chat', selected: false, t, readiness,
    onOpen: () => {}, onArchive: async () => null,
  })
  const tree = view.tree
  assert.equal(find(tree, (p) => p['data-session-state'] === 'starting').length, 1, 'the word is beside the title')
  assert.match(M.text(tree), /Starting/)
  assert.equal(find(tree, (p) => 'data-session-reason' in p).length, 0, 'nothing more to say while it starts')
  assert.equal(actionButtons(tree).length, 0, 'no readiness action button')
  assert.ok(!rowButton(tree, 'start-1').props.disabled, 'the row is not disabled: the composer is DSH\'s')
})

test('a blocked row whose Store failure names it states the reason in words, with no Open Store action', () => {
  assert.ok(!('action' in M.sessionReadiness({ sessionId: 'x', state: 'local', local: true }, availability({ canRun: false, state: 'stopped', canStart: true }), 'demo', t)), 'readiness carries no action')
  const local = { sessionId: 'local-2', title: 'Chat', local: true, updatedAt: 1, state: 'local', executionState: 'inactive' }
  const store = { name: 'pg', kind: 'postgresql', state: 'broken', reason: 'missing', postgresql: { passwordSaved: false }, attached: [] }
  const readiness = M.sessionReadiness(local, availability({ state: 'available', canRun: false, storageBlocked: true }), 'pg', t, store)
  const view = M.mount(M.SessionLine, {
    session: local, title: 'Chat', selected: false, t, readiness,
    onOpen: () => {}, onArchive: async () => null,
  })
  assert.match(M.text(view.tree), /Unavailable/)
  assert.match(M.text(view.tree), /has no saved password/, 'the Store failure is the reason')
  assert.equal(find(view.tree, (p) => p['data-session-reason'] === 'unavailable').length, 1)
  assert.equal(rowButton(view.tree, 'local-2').props['aria-disabled'], true, 'the row itself cannot open')
  assert.equal(actionButtons(view.tree).length, 0, 'no readiness action button')
  assert.doesNotMatch(M.text(view.tree), /Open Store/, 'no Open Store action')
})

// ---------------------------------------------------------------- B2: opening

/** An API whose host answers stay pending until the test resolves them. */
function openingApi() {
  const answers = []
  const opened = []
  const web = {
    call: (request) => new Promise((resolve) => answers.push({ request, resolve })),
    events: async function* () { yield { type: 'ready' }; await new Promise(() => {}) },
  }
  const nav = {
    createSession: async () => 'new',
    openPanel() {},
    openWorkspace: async () => {},
    openSession: (id) => opened.push(id),
    knowsSession: () => true,
    currentSessionId: () => undefined,
  }
  return { api: M.createApi(() => web, nav, () => undefined), answers, opened }
}
const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0)) }
const openingPill = (tree) => find(tree, (p) => 'data-opening-conversation' in p)

test('B2: the conversation says it is opening while sessions.open runs, and is gone on success', async () => {
  const { api, answers, opened } = openingApi()
  const seen = []
  const off = api.onOpening((opening) => seen.push(opening?.sessionId ?? null))
  const view = M.mount(M.OpeningConversation, { api, t })
  assert.equal(openingPill(view.tree).length, 0, 'nothing is opening at rest')
  // An ordinary op is not an opening.
  const catalog = api.op('projects.catalog')
  await flush()
  assert.equal(api.openingSession(), undefined)
  answers.shift().resolve({ ok: true, value: { rows: [] } })
  await catalog
  const open = api.op('sessions.open', { sessionId: 'stored-1', project: 'demo/app' })
  await flush()
  assert.equal(api.openingSession().sessionId, 'stored-1')
  assert.equal(api.openingSession().project, 'demo/app')
  const tree = await view.settle()
  const pill = openingPill(tree)
  assert.equal(pill.length, 1, 'the pending open is on screen')
  assert.equal(pill[0].props['data-opening-conversation'], 'stored-1')
  assert.equal(pill[0].props['data-opening-project'], 'demo/app')
  assert.equal(pill[0].props['data-opening-pane'], 'conversation', 'it is anchored to the conversation pane, not the window')
  assert.equal(pill[0].props.role, 'status', 'it is a status, not a dialog')
  assert.equal(pill[0].props['aria-live'], 'polite')
  assert.match(M.text(pill[0]), /Opening the conversation/)
  assert.equal(find(pill[0], (p) => typeof p.onClick === 'function').length, 0, 'it offers no action and covers nothing')
  answers[0].resolve({ ok: true, value: { sessionId: 'stored-1', navigate: { sessionId: 'stored-1' } } })
  await open
  await flush()
  assert.equal(api.openingSession(), undefined, 'the answer settles the state')
  assert.equal(openingPill(await view.settle()).length, 0, 'the pill is gone once the conversation is selected')
  assert.deepEqual(opened, ['stored-1'], 'the session is selected after the state clears')
  assert.deepEqual(seen, ['stored-1', null])
  off()
})

test('B2: a refused open clears the opening state too', async () => {
  const { api, answers } = openingApi()
  const view = M.mount(M.OpeningConversation, { api, t })
  const open = api.op('sessions.open', { sessionId: 'stored-2' })
  await flush()
  assert.equal(openingPill(await view.settle()).length, 1, 'it is shown while the refusal is pending')
  answers[0].resolve({ ok: false, error: { code: 'NotFound', message: 'This session is gone' } })
  await assert.rejects(open, /gone/)
  await flush()
  assert.equal(api.openingSession(), undefined)
  assert.equal(openingPill(await view.settle()).length, 0, 'a refusal leaves no opening pill behind')
})

test('B2: the pill takes no pointer events and never covers the composer or tabs', () => {
  const css = readFileSync(join(root, 'src/client/projects/list.module.css'), 'utf8')
  const rule = /\.opening\s*\{[^}]*\}/.exec(css)?.[0] ?? ''
  assert.match(rule, /pointer-events:\s*none/, 'the status does not take the click')
  assert.doesNotMatch(rule, /inset:\s*0/, 'it is a pill, not a full-frame backdrop')
  assert.match(rule, /top:\s*var\(--lfs-opening-y, 50%\)/, 'the pane measure centres it vertically')
  assert.match(rule, /left:\s*var\(--lfs-opening-x, 50%\)/, 'the pane measure centres it horizontally')
  assert.match(rule, /translate\(-50%, -50%\)/, 'the pill, not its top-left corner, sits at the centre')
  assert.match(rule, /width:\s*max-content/, 'the centred left edge does not squeeze the status into a wrap')
  assert.match(rule, /white-space:\s*nowrap/, 'the status stays one line on a phone')
  assert.doesNotMatch(rule, /--dsh-frame-overlay-top/, 'it no longer hugs the top of the window')
  for (const lang of ['en', 'zh']) assert.ok(M.listLocales[lang].openingConversation, `${lang}.openingConversation`)
})

// ------------------------------------------------- catalog publication on open

test('the open hands the host summary to the catalog before navigating', async () => {
  const admitted = []
  const opened = []
  let known = false
  const summary = { sessionId: 'closed-1', updatedAt: 7, running: false, blank: false }
  const web = {
    call: async () => ({ ok: true, value: { sessionId: 'closed-1', navigate: { sessionId: 'closed-1' }, session: summary } }),
    events: async function* () { yield { type: 'ready' }; await new Promise(() => {}) },
  }
  const nav = {
    createSession: async () => 'new', openPanel() {}, openWorkspace: async () => {},
    openSession: (id) => { opened.push(id) },
    knowsSession: () => known,
    admitSession: (s) => { admitted.push(s); known = s?.sessionId === 'closed-1' },
    currentSessionId: () => undefined,
  }
  const api = M.createApi(() => web, nav, () => undefined)
  await api.op('sessions.open', { sessionId: 'closed-1' })
  assert.deepEqual(admitted, [summary], 'the host summary seeds the catalog')
  assert.deepEqual(opened, ['closed-1'], 'the selected id is then opened')
  api.dispose()
})

test('an id missing after the wait and one catalog refresh refuses instead of opening', async () => {
  const opened = []
  let refreshes = 0
  const web = {
    call: async () => ({ ok: true, value: { sessionId: 'missing-1', navigate: { sessionId: 'missing-1' } } }),
    events: async function* () { yield { type: 'ready' }; await new Promise(() => {}) },
  }
  const nav = {
    createSession: async () => 'new', openPanel() {}, openWorkspace: async () => {},
    openSession: (id) => { opened.push(id) },
    knowsSession: () => false,
    refreshSessions: async () => { refreshes++ },
    currentSessionId: () => undefined,
  }
  const api = M.createApi(() => web, nav, () => undefined)
  const failure = await api.op('sessions.open', { sessionId: 'missing-1' }).then(() => null, (e) => e)
  assert.ok(failure, 'the open is refused')
  assert.equal(failure.code, 'session/not-listed', 'a stable code the row can localize')
  assert.match(failure.message, /not in this window.s session list yet/, 'a clear refusal, not a silent blank')
  assert.equal(refreshes, 1, 'the catalog is read again once before refusing')
  assert.deepEqual(opened, [], 'no navigation to an id the catalog does not hold')
  api.dispose()
})

test('a not-listed refusal is localized at the row and offers Retry', async () => {
  const error = Object.assign(new Error('This conversation is not in this window’s session list yet — Retry'), { code: 'session/not-listed' })
  const view = M.mount(M.SessionLine, props(() => Promise.reject(error)))
  const after = await pressOpen(view)
  const notice = noticeOf(after)
  assert.equal(notice.length, 1, 'the refusal is at the session row')
  const word = find(notice[0], (p) => p.role === 'alert')[0]
  assert.equal(M.text(word), t('notListed'), 'the row words it for the reader')
  assert.doesNotMatch(M.text(word), /sessions\.retain|unknown session/, 'DSH internals are not shown')
  assert.equal(find(notice[0], (p) => typeof p.onClick === 'function').length, 1, 'one Retry')
  assert.ok(M.listLocales.en.notListed && M.listLocales.zh.notListed, 'both locales word it')
})

test('the host publishes the opened session summary (event + open answer)', () => {
  const host = readFileSync(join(root, 'src/host/sessions/index.ts'), 'utf8')
  assert.match(host, /const publishSession = \(sessionId: string, agent\?: any\)/, 'the host builds the summary it publishes')
  assert.match(host, /ctx\.emit\('api-session\/added' as never, summary as never\)/, 'it emits the same event DSH publishes on session/created')
  assert.match(host, /summaryFor\?\.\(session\)/, 'from the controller list state, not a hand-made shape')
  const open = host.slice(host.indexOf("'sessions.open'"), host.indexOf("'sessions.close'"))
  assert.match(open, /const summary = publishSession\(sessionId, resolved\?\.agent\)/, 'every open publishes, live agent or not')
  assert.match(open, /session: summary/, 'the answer carries it for a client whose event was lost')
  assert.doesNotMatch(open, /catch \{ \/\* not in the catalog yet \*\/ \}/, 'no swallowed navigation')
})
