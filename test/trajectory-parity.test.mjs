// The LayerFS trajectory's parity records render through the same pieces the
// view uses: an assistant row's compact usage, SYSTEM/REQUEST pills and rows,
// and the inspector's Summary/Payload/Timing tabs for system and request
// details. Mounted with the mini hook runtime; no DOM.
//   node --test test/trajectory-parity.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { miniReact } from './mini-react.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-trajectory-parity-'))
await build({
  absWorkingDir: root,
  stdin: {
    contents: [
      "export { mount, elements, text } from 'react'",
      "export { RecordText } from './src/client/views/TrajectoryView.tsx'",
      "export { SystemBody, RequestBody, UnknownBody, TrajectoryInspector } from './src/client/views/TrajectoryInspector.tsx'",
      "export { KindCell } from './src/client/views/TrajectoryParts.tsx'",
      "export { locales } from './src/client/views/locale.ts'",
    ].join('\n'),
    resolveDir: root, loader: 'tsx',
  },
  outfile: join(out, 'parity.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24', logLevel: 'error',
  jsx: 'automatic', loader: { '.module.css': 'local-css', '.css': 'css' }, plugins: [miniReact],
})
const M = await import(pathToFileURL(join(out, 'parity.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

const fill = (text, vars = {}) => String(text).replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`))
const t = (key, vars) => fill(M.locales.en[key] ?? key, vars)
const tZh = (key, vars) => fill(M.locales.zh[key] ?? key, vars)
const tabs = (tree) => M.elements(tree).filter((e) => e.props?.role === 'tab').map((e) => M.text(e))

test('an assistant row shows its compact usage', () => {
  const record = { kind: 'assistant', seq: 1, turn: 1, at: 1, text: 'Done.', toolCalls: 0, usage: { input: 1200, output: 340 } }
  const row = M.mount(M.RecordText, { record, t })
  assert.match(M.text(row.tree), /Done\./)
  assert.match(M.text(row.tree), /in 1\.2k · out 340/)
  const noUsage = M.mount(M.RecordText, { record: { ...record, usage: undefined }, t })
  assert.doesNotMatch(M.text(noUsage.tree), /in |out /)
  assert.match(M.text(M.mount(M.RecordText, { record, t: tZh }).tree), /输入 1\.2k · 输出 340/)
})

test('SYSTEM and REQUEST pills, system preview and request summary render', () => {
  assert.equal(M.text(M.mount(M.KindCell, { kind: 'system', t }).tree), 'SYSTEM')
  assert.equal(M.text(M.mount(M.KindCell, { kind: 'request', t }).tree), 'REQUEST')
  const system = M.mount(M.RecordText, { record: { kind: 'system', seq: 2, turn: 1, text: 'You are careful', source: 'system-prompt' }, t })
  assert.match(M.text(system.tree), /You are careful/)
  assert.match(M.text(system.tree), /system-prompt/)
  const request = M.mount(M.RecordText, {
    record: { kind: 'request', seq: 3, turn: 1, provider: 'deepseek', model: 'deepseek-chat', tools: 3, reason: 'initial', summary: 'deepseek/deepseek-chat · 3 tools' },
    t,
  })
  assert.match(M.text(request.tree), /deepseek\/deepseek-chat · 3 tools/)
  assert.match(M.text(request.tree), /initial/)
})

const systemRecord = { kind: 'system', seq: 2, turn: 1, step: 1, at: 1000, text: 'You are careful', source: 'system-prompt', truncated: true }
const requestRecord = {
  kind: 'request', seq: 3, turn: 1, step: 1, at: 1001, provider: 'deepseek', model: 'deepseek-chat', tools: 3,
  reason: 'initial', summary: 'deepseek/deepseek-chat · 3 tools',
}
const details = {
  2: { seq: 2, kind: 'system', text: 'You are careful.\n\nFollow the guide.' },
  3: { seq: 3, kind: 'request', header: '{\n  "config": {\n    "provider": "deepseek",\n    "model": "deepseek-chat"\n  }\n}' },
}
const api = { op: async (_name, args) => details[args.seq] }
const inspector = (record, tab = 'summary') => ({
  api, sessionId: 's', inspected: { kind: 'record', turn: 1, record }, tab,
  onTab() {}, onClose() {}, onOpen: undefined, cache: new Map(), t, layerfs: true,
})

const detail = (seq) => ({ detail: details[seq] })
const labels = (tree) => M.elements(tree).map((e) => e.props?.label).filter(Boolean)
const withField = (tree, label) => M.elements(tree).find((e) => e.props?.label === label)

test('a system record opens Summary/Payload/Timing; Payload carries the full text', async () => {
  const summary = await M.mount(M.TrajectoryInspector, inspector(systemRecord)).settle()
  assert.deepEqual(tabs(summary), ['Summary', 'Payload', 'Timing'])
  const fieldsView = M.mount(M.SystemBody, { record: systemRecord, tab: 'summary', detail: detail(2), t })
  const fields = await fieldsView.settle()
  assert.deepEqual(labels(fields), ['Source', 'Preview'])
  assert.equal(withField(fields, 'Source').props.children, 'system-prompt')
  assert.match(String(withField(fields, 'Preview').props.children), /Cut at 300 characters/)
  const payloadView = M.mount(M.SystemBody, { record: systemRecord, tab: 'payload', detail: detail(2), t })
  const payload = await payloadView.settle()
  assert.match(M.text(payload), /You are careful\./)
  assert.match(M.text(payload), /Follow the guide\./)
})

test('a request record opens Summary/Payload/Timing; Payload is the header JSON', async () => {
  const summary = await M.mount(M.TrajectoryInspector, inspector(requestRecord)).settle()
  assert.deepEqual(tabs(summary), ['Summary', 'Payload', 'Timing'])
  const fieldsView = M.mount(M.RequestBody, { record: requestRecord, tab: 'summary', detail: detail(3), t })
  const fields = await fieldsView.settle()
  assert.deepEqual(labels(fields), ['Provider', 'Model', 'Tools', 'Reason'])
  assert.equal(withField(fields, 'Model').props.children, 'deepseek-chat')
  const payloadView = M.mount(M.RequestBody, { record: requestRecord, tab: 'payload', detail: detail(3), t })
  const payload = await payloadView.settle()
  assert.match(M.text(payload), /"model": "deepseek-chat"/)
})

test('an unknown record kind stays safe in the inspector', async () => {
  const view = M.mount(M.UnknownBody, { kind: 'mystery', t })
  assert.match(M.text(view.tree), /This record kind is not supported yet/)
  const tree = M.mount(M.TrajectoryInspector, inspector({ kind: 'mystery', seq: 9, turn: 1 })).tree
  assert.deepEqual(tabs(tree), ['Summary', 'Timing'])
})
