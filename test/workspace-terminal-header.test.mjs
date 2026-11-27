// The Sandbox map's Workspace panel is a replay transcript, not a terminal:
// its header always says "Replay", and the live terminal is a link to the
// Sandbox page (group 9's `TerminalPane`), offered only when the caller has
// one to open. Mounted through mini-react, like test/trajectory-logs-link.
//   node --test test/workspace-terminal-header.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { miniReact } from './mini-react.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-workspace-terminal-header-'))
await build({
  absWorkingDir: root,
  stdin: {
    contents: [
      "export { mount, elements, text } from 'react'",
      "export { WorkspaceTerminal } from './src/client/views/WorkspaceTerminal.tsx'",
    ].join('\n'),
    resolveDir: root, loader: 'tsx',
  },
  outfile: join(out, 'workspace-terminal-header.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24', logLevel: 'error',
  jsx: 'automatic', loader: { '.module.css': 'local-css', '.css': 'css' }, plugins: [miniReact],
})
const M = await import(pathToFileURL(join(out, 'workspace-terminal-header.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

const t = (key, vars = {}) => String(key).replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''))
const find = (tree, pred) => M.elements(tree).filter((e) => pred(e))
const badge = (tree) => find(tree, (e) => e.props?.children === 'wsReplay')
const liveLink = (tree) => find(tree, (e) => e.props?.children === 'wsOpenLive' && typeof e.props?.onClick === 'function')
const exec = {
  id: 'e1', agent: 'agent-1', method: 'workspace.exec', outcome: 'ok', at: 0, ms: 120, start: 0, end: 1,
  argv: ['workspace', 'exec', 'ws-1', 'bash', '-c', 'ls'], ws: 'ws-1',
}

function mount(extra = {}) {
  return M.mount(M.WorkspaceTerminal, {
    api: {}, t, events: [], wsName: 'ws-1', now: 2, agentName: () => 'agent-1', laneOf: () => 'lane-0', reduced: false, ...extra,
  })
}

test('the header says Replay and offers the live terminal; pressing it only calls the caller', async () => {
  const opened = []
  const view = mount({ onOpenLive: () => opened.push('live') })
  await view.settle()
  assert.equal(badge(view.tree).length, 1, 'the Replay badge always renders')
  const links = liveLink(view.tree)
  assert.equal(links.length, 1)
  links[0].props.onClick()
  assert.deepEqual(opened, ['live'], 'the component does not navigate itself')
  assert.match(M.text(view.tree), /wsTerminalEmpty/, 'the empty state stays')
})

test('without onOpenLive there is no link, and the caller\'s reason shows muted; with no reason, nothing', async () => {
  const noLive = mount({ liveUnavailable: 'live-terminal-not-here' })
  await noLive.settle()
  assert.equal(liveLink(noLive.tree).length, 0)
  assert.equal(badge(noLive.tree).length, 1, 'the header still renders')
  assert.match(M.text(noLive.tree), /live-terminal-not-here/)
  assert.match(M.text(noLive.tree), /wsTerminalEmpty/)

  const bare = mount()
  await bare.settle()
  assert.equal(liveLink(bare.tree).length, 0)
  assert.doesNotMatch(M.text(bare.tree), /live-terminal-not-here/)
})

test('the transcript log is labelled as a replay, not the live terminal', async () => {
  const view = mount({ events: [exec] })
  await view.settle()
  const log = find(view.tree, (e) => e.props?.role === 'log')
  assert.equal(log.length, 1)
  assert.equal(log[0].props['aria-label'], 'wsReplayLabel')
  assert.equal(liveLink(view.tree).length, 0, 'the header renders above a transcript too')
})
