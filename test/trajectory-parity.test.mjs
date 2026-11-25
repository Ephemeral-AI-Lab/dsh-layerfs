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
      "export { SystemBody, RequestBody, UnknownBody, TrajectoryInspector, ToolsList, ToolsBody, ToolSchema } from './src/client/views/TrajectoryInspector.tsx'",
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

test('a request record opens Summary/Payload/Tools/Timing; Payload is the header JSON', async () => {
  const summary = await M.mount(M.TrajectoryInspector, inspector(requestRecord)).settle()
  assert.deepEqual(tabs(summary), ['Summary', 'Payload', 'Tools', 'Timing'])
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

// A request's tool catalog: the row's `N tools` and `+ − ~`, the Summary's
// Tools field, and the Tools tab's list with change marks and earlier values.
const toolRequest = {
  ...requestRecord,
  tools: 3,
  toolsChanged: { added: ['glob'], removed: ['read'], changed: ['bash'] },
}
const toolDetail = {
  seq: 3, kind: 'request',
  tools: [
    { name: 'bash', description: 'run a shell command', parameterCount: 1, parameters: { type: 'object', properties: { command: { type: 'string' } } } },
    { name: 'glob', description: 'find files', parameterCount: 1, parameters: { type: 'object', properties: { pattern: { type: 'string' } } } },
    { name: 'write', description: 'write a file', parameterCount: 0, parameters: { type: 'object' } },
  ],
  previousRequestSeq: 2,
  truncated: ['tools'],
}
const toolDetailState = { detail: toolDetail }

test('a REQUEST row shows N tools and its change counts; none when nothing changed', () => {
  const changed = M.mount(M.RecordText, { record: toolRequest, t })
  assert.match(M.text(changed.tree), /deepseek\/deepseek-chat · 3 tools/)
  assert.match(M.text(changed.tree), /\+1 −1 ~1/)
  const same = M.mount(M.RecordText, { record: { ...toolRequest, toolsChanged: { added: [], removed: [], changed: [] } }, t })
  assert.match(M.text(same.tree), /3 tools/)
  assert.doesNotMatch(M.text(same.tree), /[+−~]\d/)
  const first = M.mount(M.RecordText, { record: { ...toolRequest, toolsChanged: undefined }, t })
  assert.doesNotMatch(M.text(first.tree), /[+−~]\d/)
})

test('the Summary shows N tools with the change counts, and nothing without a change', async () => {
  const view = M.mount(M.RequestBody, { record: toolRequest, tab: 'summary', detail: toolDetailState, t })
  assert.match(M.text(view.tree), /3 tools/)
  assert.match(M.text(view.tree), /\+1 −1 ~1/)
  const same = M.mount(M.RequestBody, { record: { ...toolRequest, toolsChanged: { added: [], removed: [], changed: [] } }, tab: 'summary', detail: toolDetailState, t })
  assert.match(M.text(same.tree), /3 tools/)
  assert.doesNotMatch(M.text(same.tree), /[+−~]\d/)
})

test('the Tools tab lists the catalog, each with its schema and parameter count', () => {
  const list = M.mount(M.ToolsList, { tools: toolDetail.tools, change: toolRequest.toolsChanged, truncated: true, t })
  const text = M.text(list.tree)
  assert.match(text, /bash/)
  assert.match(text, /run a shell command/)
  assert.match(text, /1 parameters/)
  assert.match(text, /glob/)
  assert.match(text, /write a file/)
  assert.match(text, /"command"/, 'the parameter schema is shown as JSON')
  assert.match(text, /The catalog was cut at 64 KiB\./)
  // With the previous catalog read, changed and removed tools show their earlier value.
  const withPrevious = M.mount(M.ToolsList, {
    tools: toolDetail.tools, change: toolRequest.toolsChanged,
    previous: [
      { name: 'bash', description: 'run a command', parameterCount: 1, parameters: { type: 'object' } },
      { name: 'read', description: 'read a file', parameterCount: 2, parameters: { type: 'object' } },
    ], t,
  })
  const changed = M.text(withPrevious.tree)
  assert.match(changed, /~/, 'a changed tool is marked')
  assert.match(changed, /\+/, 'an added tool is marked')
  assert.match(changed, /−/, 'a removed tool is marked')
  assert.match(changed, /Previous/)
  assert.match(changed, /run a command/, "the changed tool's earlier description")
  assert.match(changed, /read a file/, "the removed tool's earlier description")
  // The no-change case: no marks, no earlier value.
  const plain = M.mount(M.ToolsList, { tools: [toolDetail.tools[2]], change: { added: [], removed: [], changed: [] }, t })
  assert.doesNotMatch(M.text(plain.tree), /[+−~]/)
})

test('the Tools tab reads the previous request catalog when a tool changed', async () => {
  const previous = [
    { name: 'bash', description: 'run a command', parameterCount: 1, parameters: { type: 'object' } },
    { name: 'read', description: 'read a file', parameterCount: 2, parameters: { type: 'object' } },
  ]
  const calls = []
  const api = { op: async (name, args) => { calls.push([name, args.seq]); return { seq: args.seq, kind: 'request', tools: previous } } }
  const body = M.mount(M.ToolsBody, {
    record: toolRequest, detail: toolDetailState, source: { api, sessionId: 's', cache: new Map() }, t,
  })
  await body.settle()
  assert.deepEqual(calls, [['session.trajectory.record', 2]], 'the previous request record, read once')
  assert.equal(body.tree.type, M.ToolsList)
  assert.deepEqual(body.tree.props.previous.map((tool) => tool.name), ['bash', 'read'])
  // A request whose catalog did not change needs no earlier catalog read.
  const callsFresh = []
  const freshApi = { op: async (name, args) => { callsFresh.push([name, args.seq]); return {} } }
  const fresh = M.mount(M.ToolsBody, {
    record: { ...toolRequest, toolsChanged: { added: [], removed: [], changed: [] } },
    detail: toolDetailState, source: { api: freshApi, sessionId: 's', cache: new Map() }, t,
  })
  await fresh.settle()
  assert.deepEqual(callsFresh, [])
  assert.equal(fresh.tree.type, M.ToolsList)
})

test('a request with no logged catalog says so; a tool without a schema says so', async () => {
  const api = { op: async () => ({}) }
  const view = M.mount(M.ToolsBody, {
    record: toolRequest, detail: { detail: { seq: 3, kind: 'request' } }, source: { api, sessionId: 's', cache: new Map() }, t,
  })
  assert.match(M.text(view.tree), /tool catalog was not recorded/)
  const schema = M.mount(M.ToolSchema, { tool: { name: 'x', parameterCount: 0 }, t })
  assert.match(M.text(schema.tree), /No parameter schema was logged\./)
  const empty = M.mount(M.ToolsList, { tools: [], change: undefined, t })
  assert.match(M.text(empty.tree), /No tools in this request\./)
})

test('the Tools tab and its copy are translated', () => {
  assert.equal(M.locales.zh.trajTab_tools, '工具')
  assert.equal(M.locales.zh.trajToolParams, '{n} 个参数')
  const list = M.mount(M.ToolsList, { tools: toolDetail.tools, change: toolRequest.toolsChanged, t: tZh })
  assert.match(M.text(list.tree), /1 个参数/)
  const tool = M.mount(M.ToolSchema, { tool: { name: 'x', parameterCount: 0 }, t: tZh })
  assert.match(M.text(tool.tree), /未记录参数 schema/)
})
