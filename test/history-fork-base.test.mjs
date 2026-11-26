// The History page's fork-base row reads a Commit for its header only
// (`source_branch`), so its read asks the route for `?changes=0` and the diff is
// not walked; the selected Commit's page and its More still read the changes,
// which their views draw. The route's side is test/routes.test.mjs
// ("commit detail: the diff is read only when the caller asks for the changes").
//   node --test test/history-fork-base.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { miniReact } from './mini-react.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-history-fork-base-'))
await build({
  absWorkingDir: root,
  stdin: {
    contents: [
      "export { forkBaseRead } from './src/client/files/ProjectHistory.tsx'",
      "export { filesApi } from './src/client/files/api.ts'",
    ].join('\n'),
    resolveDir: root, loader: 'tsx',
  },
  outfile: join(out, 'history.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24', logLevel: 'error',
  jsx: 'automatic', loader: { '.module.css': 'local-css', '.css': 'css' }, plugins: [miniReact],
})
const M = await import(pathToFileURL(join(out, 'history.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

const project = 's1/p', encoded = encodeURIComponent(project)
const commit = 'a'.repeat(66), parent = 'b'.repeat(66)

/** A host that records each read and answers the Commit detail shape. */
function fakeApi(detail = { item: { sourceBranch: 'main' }, changes: [], nextChanges: null }) {
  const calls = []
  return { calls, api: { call: async (...args) => { calls.push(args); return detail } } }
}

test('the fork-base row asks for the Commit header, not its diff', async () => {
  const { calls, api } = fakeApi()
  const detail = await M.forkBaseRead(api, project, 'main', commit)
  assert.deepEqual(calls, [['GET', `/api/projects/${encoded}/history?branch=main&commit=${commit}&changes=0`]], 'one header read, with no diff')
  assert.equal(detail.item.sourceBranch, 'main')
})

test("the selected Commit's page and its More still ask for the diff", async () => {
  const { calls, api } = fakeApi({ item: {}, changes: [{ path: '/a.txt', kind: 'modified' }], nextChanges: 'next' })
  const page = await M.filesApi.commit(api, project, 'feat', commit, parent)
  assert.deepEqual(calls, [['GET', `/api/projects/${encoded}/history?branch=feat&commit=${commit}&from=${parent}`]], 'the page reads the changed paths: no changes=0')
  assert.deepEqual(page.changes, [{ path: '/a.txt', kind: 'modified' }])
  calls.length = 0
  await M.filesApi.commit(api, project, 'feat', commit, parent, 'next')
  assert.deepEqual(calls, [['GET', `/api/projects/${encoded}/history?branch=feat&commit=${commit}&from=${parent}&cursor=next`]], 'More reads the next page of changes')
})

test('the component reads the header only for the fork row and the diff for the selected Commit', () => {
  const tsx = readFileSync(join(root, 'src/client/files/ProjectHistory.tsx'), 'utf8')
  assert.match(tsx, /void forkBaseRead\(api, project, forkBaseSource, forkBaseId\)/, 'the fork row reads the header')
  assert.doesNotMatch(tsx, /filesApi\.commit\(api, project, forkBaseSource/, 'the fork row never reads the diff')
  assert.match(tsx, /filesApi\.commit\(api, project, branch, id, from\)\.then/, "the selected Commit's page reads the changes")
  assert.match(tsx, /filesApi\.commit\(api, project, branch, id, from, page\.nextChanges\)/, 'More reads the changes')
})
