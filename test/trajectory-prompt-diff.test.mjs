// The LayerFS trajectory's Diff tab: the record-row hint, the lazy
// `session.trajectory.prompt-diff` read cached per session+seq, the unified
// meta/added/removed/context lines and the truncated note. Mounted with the
// mini hook runtime; no DOM.
//   node --test test/trajectory-prompt-diff.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { miniReact } from './mini-react.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-trajectory-prompt-diff-'))
await build({
  absWorkingDir: root,
  stdin: {
    contents: [
      "export { mount, elements, text } from 'react'",
      "export { RecordText } from './src/client/views/TrajectoryView.tsx'",
      "export { PromptDiffBody, TrajectoryInspector } from './src/client/views/TrajectoryInspector.tsx'",
      "export { locales } from './src/client/views/locale.ts'",
    ].join('\n'),
    resolveDir: root, loader: 'tsx',
  },
  outfile: join(out, 'prompt-diff.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24', logLevel: 'error',
  jsx: 'automatic', loader: { '.module.css': 'local-css', '.css': 'css' }, plugins: [miniReact],
})
const M = await import(pathToFileURL(join(out, 'prompt-diff.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

const fill = (text, vars = {}) => String(text).replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`))
const t = (key, vars) => fill(M.locales.en[key] ?? key, vars)
const tZh = (key, vars) => fill(M.locales.zh[key] ?? key, vars)
const tabs = (tree) => M.elements(tree).filter((e) => e.props?.role === 'tab').map((e) => M.text(e))

const systemRecord = {
  kind: 'system', seq: 20, turn: 1, step: 2, at: 2000, text: 'Second version.', source: 'system-prompt',
  promptChanged: 'system', previousSeq: 4,
}
const requestRecord = {
  kind: 'request', seq: 21, turn: 1, step: 2, at: 2001, provider: 'deepseek', model: 'deepseek-chat', tools: 3,
  reason: 'change', summary: 'deepseek/deepseek-chat · 3 tools', promptChanged: 'tools', previousSeq: 20,
}
const diffAnswer = {
  seq: 20,
  before: { seq: 4 },
  after: { seq: 20 },
  truncated: true,
  system: {
    lines: [
      { kind: 'meta', text: '@@ -1,3 +1,3 @@' },
      { kind: 'context', text: ' You are a careful agent.' },
      { kind: 'removed', text: '-Keep commits small.' },
      { kind: 'added', text: '+Keep the diff exact.' },
    ],
    truncated: true,
  },
  tools: {
    lines: [
      { kind: 'meta', text: '@@ -1,2 +1,3 @@' },
      { kind: 'context', text: ' "tools": [' },
      { kind: 'added', text: '+    "name": "glob",' },
    ],
  },
}
const detail = { seq: 20, kind: 'system', text: 'Second version.' }

const inspector = (record, extra = {}) => ({
  api: extra.api, sessionId: 's', inspected: { kind: 'record', turn: 1, record }, tab: 'summary',
  onTab() {}, onClose() {}, onOpen: undefined, cache: new Map(), diffs: new Map(), t, layerfs: true, ...extra,
})

test('a prompt change adds the Diff tab first; an unchanged record has none', () => {
  const noop = { op: async () => detail }
  const changed = M.mount(M.TrajectoryInspector, inspector(systemRecord, { api: noop }))
  assert.deepEqual(tabs(changed.tree), ['Diff', 'Summary', 'Payload', 'Timing'])
  const request = M.mount(M.TrajectoryInspector, inspector(requestRecord, { api: noop }))
  assert.deepEqual(tabs(request.tree), ['Diff', 'Summary', 'Payload', 'Tools', 'Timing'])
  const same = M.mount(M.TrajectoryInspector, inspector({ ...systemRecord, promptChanged: undefined, previousSeq: undefined }, { api: noop }))
  assert.deepEqual(tabs(same.tree), ['Summary', 'Payload', 'Timing'])
})

test('the diff is read only when its tab opens, once per session+seq', async () => {
  const calls = []
  const api = {
    op: async (name, args) => {
      calls.push([name, args.seq])
      if (name === 'session.trajectory.record') return detail
      return diffAnswer
    },
  }
  const cache = new Map()
  const diffs = new Map()
  const props = inspector(systemRecord, { api, cache, diffs })
  const view = M.mount(M.TrajectoryInspector, props)
  await view.settle()
  assert.deepEqual(calls, [['session.trajectory.record', 20]], 'Summary reads the record detail, not the diff')
  view.render({ ...props, tab: 'diff' })
  await view.settle()
  assert.deepEqual(calls, [['session.trajectory.record', 20], ['session.trajectory.prompt-diff', 20]])
  assert.equal(diffs.get('s:20'), diffAnswer, 'the answer is kept in the per-session diff cache')
  // Away and back: the cache answers, no second host read.
  view.render({ ...props, tab: 'summary' })
  view.render({ ...props, tab: 'diff' })
  await view.settle()
  assert.equal(calls.filter(([name]) => name === 'session.trajectory.prompt-diff').length, 1)
})

test('the diff body renders meta, added, removed and context lines and the truncated note', () => {
  const view = M.mount(M.PromptDiffBody, { state: { key: 's:20', diff: diffAnswer }, t })
  const text = M.text(view.tree)
  assert.match(text, /@@ -1,3 \+1,3 @@/)
  assert.match(text, /-Keep commits small\./)
  assert.match(text, /\+Keep the diff exact\./)
  assert.match(text, / You are a careful agent\./)
  assert.match(text, /"name": "glob"/)
  assert.match(text, /The diff was cut at its display limit\./)
  assert.equal(M.locales.zh.trajDiffSystem, '系统提示词')
  const zh = M.mount(M.PromptDiffBody, { state: { key: 's:20', diff: diffAnswer }, t: tZh })
  assert.match(M.text(zh.tree), /系统提示词/)
  assert.match(M.text(zh.tree), /差异已截断到显示上限。/)
})

test('the row hint names what changed and stays absent when nothing did', () => {
  const system = M.mount(M.RecordText, { record: systemRecord, t })
  assert.match(M.text(system.tree), /prompt changed/)
  const request = M.mount(M.RecordText, { record: requestRecord, t })
  assert.match(M.text(request.tree), /tools changed/)
  assert.match(M.text(request.tree), /3 tools/)
  const unchanged = M.mount(M.RecordText, { record: { ...systemRecord, promptChanged: undefined }, t })
  assert.doesNotMatch(M.text(unchanged.tree), /prompt changed|tools changed/)
  const zh = M.mount(M.RecordText, { record: requestRecord, t: tZh })
  assert.match(M.text(zh.tree), /工具已更改/)
})
