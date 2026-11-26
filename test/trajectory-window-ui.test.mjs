// B9-C's client half: a windowed Trajectory answer says how many records its
// window holds and offers "Load full history"; a whole answer keeps today's
// "Load older records (n not loaded)". Rendered with the project's mini React
// runtime (test/mini-react.mjs), so the assertions are on elements and text.
//   node --test test/trajectory-window-ui.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { miniReact } from './mini-react.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-trajectory-window-ui-'))
await build({
  absWorkingDir: root,
  stdin: {
    contents: [
      "export { mount, elements, text } from 'react'",
      "export { OlderFooter } from './src/client/views/TrajectoryParts.tsx'",
      "export { mergeOlder } from './src/client/views/trajectory-model.ts'",
      "export { locales } from './src/client/views/locale.ts'",
    ].join('\n'),
    resolveDir: root, loader: 'tsx',
  },
  outfile: join(out, 'window-ui.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24', logLevel: 'error',
  jsx: 'automatic', loader: { '.module.css': 'local-css', '.css': 'css' }, plugins: [miniReact],
})
const M = await import(pathToFileURL(join(out, 'window-ui.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

const t = (key, vars = {}) => String(M.locales.en[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ''))

const record = (seq) => ({ kind: 'user', seq, turn: 1, at: 1000, source: 'user', text: `record ${seq}` })
const answer = (over = {}) => ({
  sessionId: 's', project: 'st/p', branch: 'dsh.s', logLoaded: true,
  turns: [{ turn: 1, at: 1000, records: [record(1), record(2), record(3)], orphanCalls: [], hostOps: [], checkpoints: [] }],
  checkpoints: [], counts: { versionsCreated: 2, callsWithVersions: 1 }, revision: 'r1', recordTotal: 3,
  ...over,
})
const mount = (props) => M.mount(M.OlderFooter, { answer: answer(), busy: false, t, onLoadOlder() {}, ...props })
const button = (view) => M.elements(view.tree).find((element) => typeof element.props?.onClick === 'function')

test('a windowed answer shows its window size and loads the full history', () => {
  let loads = 0
  const view = mount({ answer: answer({ windowed: true, windowFromSeq: 1, recordTotalKnown: false, recordTotal: 402 }), onLoadOlder: () => { loads++ } })
  assert.equal(M.text(view.tree), '402 in the loaded window·Load older records (window)')
  assert.equal(button(view).props.onClick(), undefined)
  assert.equal(loads, 1, 'the button asks for the full history')
  assert.equal(button(view).props.disabled, false)
})

test('merging the whole history adopts its counts, not the window\'s', () => {
  // The measured shape: the window counts 0 versions, the full answer 1.
  const windowed = answer({
    windowed: true, windowFromSeq: 1, recordTotalKnown: false, recordTotal: 402,
    counts: { versionsCreated: 0, callsWithVersions: 0 }, hasMore: true, olderBefore: 2,
  })
  const older = answer({ recordTotal: 3314, counts: { versionsCreated: 1, callsWithVersions: 1 } })
  const merged = M.mergeOlder(windowed, older)
  assert.deepEqual(merged.counts, { versionsCreated: 1, callsWithVersions: 1 }, 'the full answer\'s counts')
})

test('a record the full page also carries takes its complete opsTotal', () => {
  const op = (id) => ({ id, origin: 'tool', operation: 'file.read', versions: [], argv: ['file', 'read'] })
  const shared = (opsTotal, ops) => ({ kind: 'tool', seq: 2, turn: 1, callId: 'call_shared', name: 'bash', ops, opsTotal })
  const windowed = answer({
    windowed: true, recordTotalKnown: false, recordTotal: 402, hasMore: true, olderBefore: 2,
    turns: [{ turn: 1, at: 1000, records: [shared(1, [op('w1')])], orphanCalls: [], hostOps: [], checkpoints: [] }],
  })
  const older = answer({
    recordTotal: 3314,
    turns: [{ turn: 1, at: 1000, records: [shared(3, [op('w1'), op('w2'), op('w3')])], orphanCalls: [], hostOps: [], checkpoints: [] }],
  })
  const merged = M.mergeOlder(windowed, older)
  const record = merged.turns[0].records.find((item) => item.seq === 2)
  assert.equal(record.opsTotal, 3, 'the whole parse\'s record wins')
  assert.equal(record.ops.length, 3)
})

test('a whole answer keeps the older-records count', () => {
  const view = mount({ answer: answer({ recordTotal: 3314 }) })
  assert.equal(M.text(view.tree), 'Load older records (3311 not loaded)')
})

test('loading the full history merges away the window: the next label is a whole-log count', () => {
  const windowed = answer({ windowed: true, windowFromSeq: 1, recordTotalKnown: false, recordTotal: 402, hasMore: true, olderBefore: 1 })
  const older = answer({ recordTotal: 3314 })
  const merged = M.mergeOlder(windowed, older)
  assert.equal(merged.windowed, undefined)
  assert.equal(merged.recordTotalKnown, undefined)
  assert.equal(merged.windowFromSeq, undefined)
  assert.equal(merged.recordTotal, 3314)
  const view = mount({ answer: merged })
  assert.equal(M.text(view.tree), `Load older records (${3314 - 3} not loaded)`)
})

test('a busy footer says it is loading and cannot be clicked again', () => {
  const view = mount({ answer: answer({ windowed: true, recordTotal: 402 }), busy: true })
  assert.equal(M.text(view.tree), '402 in the loaded window·Loading…')
  assert.equal(button(view).props.disabled, true)
})
