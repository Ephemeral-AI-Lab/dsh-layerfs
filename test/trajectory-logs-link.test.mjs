// A refused (or failed) LayerFS call in the trajectory inspector links to the
// Logs page filtered by that call's receipt tag, `dsh:<session>:<receipt>` —
// the page the guide tells the user to check.
//   node --test test/trajectory-logs-link.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { miniReact } from './mini-react.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-trajectory-logs-link-'))
await build({
  absWorkingDir: root,
  stdin: {
    contents: [
      "export { mount, elements } from 'react'",
      "export { OpsList } from './src/client/views/TrajectoryInspector.tsx'",
    ].join('\n'),
    resolveDir: root, loader: 'tsx',
  },
  outfile: join(out, 'logs-link.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24', logLevel: 'error',
  jsx: 'automatic', loader: { '.module.css': 'local-css', '.css': 'css' }, plugins: [miniReact],
})
const M = await import(pathToFileURL(join(out, 'logs-link.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

const t = (key, vars = {}) => String(key).replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''))
const op = (id, extra = {}) => ({ id, origin: 'tool', operation: 'file.read', versions: [], ...extra })
const find = (tree) => M.elements(tree).filter((e) => e.props?.children === 'trajOpenInLogs')

function mount(ops, onOpenLogs) {
  return M.mount(M.OpsList, { ops, sessionId: 'session-1', t, onOpen() {}, onOpenLogs })
}

test('a refusal and a non-zero exit each link to their receipt tag; a success does not', () => {
  const opened = []
  const view = mount([
    op('r1', { outcome: 'refusal', code: 'NotFound' }),
    op('r2', { outcome: 'success' }),
    op('r3', { outcome: 'success', exit: 2 }),
  ], (tag) => opened.push(tag))
  const links = find(view.tree)
  assert.equal(links.length, 2, 'one per refused/failed call, none for the success')
  links[0].props.onClick()
  links[1].props.onClick()
  assert.deepEqual(opened, ['dsh:session-1:r1', 'dsh:session-1:r3'])
})

test('without the Logs callback no link renders', () => {
  const view = mount([op('r1', { outcome: 'refusal', code: 'Busy' })], undefined)
  assert.equal(find(view.tree).length, 0)
})
