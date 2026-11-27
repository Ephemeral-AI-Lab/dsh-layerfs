// The Export dialog's version line reads a Commit for its header only (id,
// message, time), so it asks the history route for `?changes=0` (one `commit
// get`, not the Commit and its diff). The picker's History and Files views still
// read the changed paths through `filesApi.commit`. The route's side is
// test/routes.test.mjs ("commit detail: the diff is read only when the caller asks
// for the changes").
//   node --test test/exports-version-header.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { miniReact } from './mini-react.mjs'
import { loadRoutes, testHost } from './routes-helper.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const out = mkdtempSync(join(root, 'lib', '.test-exports-version-header-'))
await build({
  absWorkingDir: root,
  stdin: {
    contents: `
      export { ExportDialog } from './src/client/exports/ExportDialog.tsx'
      export { versionHeader } from './src/client/exports/model.ts'
      export { filesApi } from './src/client/files/api.ts'
      export { mount, elements, text } from 'react'
    `,
    resolveDir: root,
    loader: 'tsx',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  jsx: 'automatic',
  loader: { '.module.css': 'local-css', '.css': 'css' },
  outfile: join(out, 'exports.mjs'),
  plugins: [miniReact],
  logLevel: 'warning',
})
const M = await import(pathToFileURL(join(out, 'exports.mjs')).href)
const R = await loadRoutes()
test.after(() => rmSync(out, { recursive: true, force: true }))

const project = 's1/p', encoded = encodeURIComponent(project)
const HEAD = 'a'.repeat(66), PARENT = 'c'.repeat(66), OTHER = 'b'.repeat(66)
const NOW = Date.parse('2026-11-25T10:00:00Z')

/** A fake CLI that counts each read, and a host over it (the dialog's own routes). */
function routeFixture() {
  const calls = []
  const lfs = {
    commit: {
      get: async (_project, ref) => {
        calls.push('commit.get')
        return {
          commit: ref,
          branch: 'main',
          message: ref === HEAD ? 'first save' : 'picked save',
          created_at: new Date(NOW).toISOString(),
          parent: PARENT,
          size: 9,
        }
      },
      diff: async () => { calls.push('commit.diff'); return { items: [{ path: '/a.txt', change: 'modified' }], next_cursor: null } },
    },
  }
  const rootDir = mkdtempSync(join(tmpdir(), 'dsh-export-header-'))
  const t = testHost({ lfs, root: rootDir, home: join(rootDir, 'home'), discovery: async () => ({ identity: {}, calls: [], commands: [], switches: [] }) })
  const groups = R.createGroups(t.host, async () => ({}))
  return {
    calls,
    http: (method, path) => R.handle(groups, { method, path }),
    close: () => rmSync(rootDir, { recursive: true, force: true }),
  }
}

/** The dialog's API over the routes: `call` answers the body, as Connect does. */
function routedApi(f) {
  return {
    call: async (method, path) => {
      const answer = await f.http(method, path)
      assert.equal(answer.status, 200, JSON.stringify(answer.body))
      return answer.body
    },
    onEvent: () => () => {},
  }
}

test('the version header read is one CLI call; the picker detail still reads the diff', async () => {
  const f = routeFixture()
  try {
    const api = routedApi(f)
    const header = await M.versionHeader(api, project, 'main', HEAD)
    assert.deepEqual(f.calls, ['commit.get'], 'the version line reads the header only')
    assert.equal(header.item.id, HEAD)
    assert.equal(header.item.message, 'first save')
    assert.equal(header.item.at, NOW)
    assert.deepEqual(header.changes, [])

    // What the picker's History detail (and its More) reads: the changed paths.
    f.calls.length = 0
    const detail = await M.filesApi.commit(api, project, 'main', HEAD, PARENT)
    assert.deepEqual(f.calls, ['commit.get', 'commit.diff'], 'the picker detail keeps the diff')
    assert.deepEqual(detail.changes, [{ path: '/a.txt', kind: 'modified' }])
  } finally { f.close() }
})

/** A dialog API: the Branch read seeds main's head, then the chosen version's header is read. */
function dialogApi() {
  const calls = []
  const item = (id, message) => ({ id, branch: 'main', message, at: NOW })
  return {
    calls,
    api: {
      call: async (method, path) => {
        calls.push({ method, path })
        assert.equal(method, 'GET', 'the dialog writes nothing')
        if (path.includes('/branches?branch=main&with=commit')) return { commit: HEAD, item: item(HEAD, 'first save') }
        if (path.includes(`commit=${OTHER}&changes=0`)) return { item: item(OTHER, 'picked save'), changes: [], nextChanges: null }
        throw new Error(`unexpected read: ${method} ${path}`)
      },
      onEvent: () => () => {},
    },
  }
}

test('choosing another version reads its header (changes=0) and renders the same id and message', async () => {
  const { calls, api } = dialogApi()
  const t = (key, params) => (params && params.name ? `${key}:${params.name}` : key)
  const view = M.mount(M.ExportDialog, { api, t, project: 's1/p', onClose: () => {} })
  try {
    await view.settle()
    await view.settle()
    assert.equal(calls.length, 1, 'the dialog opens with the Branch read and its seeded header')
    assert.ok(calls.every((c) => c.method === 'GET'), 'no export is started (a start is a POST)')

    const choose = M.elements(view.tree).find((e) => e.props && e.props['data-export-choose'] !== undefined)
    assert.ok(choose, 'the version picker button renders')
    choose.props.onClick()
    await view.settle()
    const history = M.elements(view.tree).find((e) => e.type && e.type.name === 'ProjectHistory')
    assert.ok(history, 'the picker renders the History view')
    assert.equal(history.props.initialBranch, 'main')
    assert.equal(history.props.initialCommit, HEAD)

    // The picker reports a different Commit, then "Use this version" keeps it.
    history.props.onSelectionChange({ branch: 'main', commit: OTHER, head: false })
    await view.settle()
    const use = M.elements(view.tree).find((e) => e.props && e.props['data-export-use'] !== undefined)
    assert.ok(use, 'the picker has "Use this version"')
    use.props.onClick()
    await view.settle()
    await view.settle()

    assert.equal(calls.length, 2, 'the version line reads the chosen header once')
    assert.deepEqual(calls[1], { method: 'GET', path: `/api/projects/${encoded}/history?branch=main&commit=${OTHER}&changes=0` })
    assert.ok(calls.every((c) => c.method === 'GET'), 'no POST, so no export starts')

    const version = M.elements(view.tree).find((e) => e.props && e.props['data-export-version'] !== undefined)
    assert.ok(version, 'the version line renders')
    assert.equal(version.props['data-export-version'], `main@${OTHER}`, 'the chosen version id')
    const shown = M.text(version)
    assert.match(shown, /bbbbbbbb/, 'the chosen version\'s short id')
    assert.match(shown, /picked save/, 'the chosen version\'s message')
    assert.doesNotMatch(shown, /first save/, 'the previous version\'s message is gone')
  } finally { view.unmount() }
})

test('the dialog keeps one version read call site, and the picker keeps the full detail', () => {
  const tsx = readFileSync(join(root, 'src/client/exports/ExportDialog.tsx'), 'utf8')
  assert.match(tsx, /void versionHeader\(api, project, sel\.branch, sel\.commit\)/, 'the version line reads the header helper')
  assert.doesNotMatch(tsx, /filesApi\.commit/, 'and not the full-detail read')
  assert.match(tsx, /<ProjectHistory /, 'the picker still renders History, whose detail reads the changed paths')
})
