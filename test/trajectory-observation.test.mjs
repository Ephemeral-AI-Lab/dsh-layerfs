// The Trajectory's OBSERVATION row (the read counter, src/host/sessions/trace.ts)
// is not a log record: its seq is made up (one past the newest record). Its
// inspector shows the counter's facts and never asks `session.trajectory.record`
// for that seq, and selecting it keys on the row, not the seq, so a selection
// does not jump to the real record that later takes the seq.
//   node --test test/trajectory-observation.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { miniReact } from './mini-react.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-trajectory-observation-'))
await build({
  absWorkingDir: root,
  stdin: {
    contents: [
      "export { mount, elements, text } from 'react'",
      "export { TrajectoryInspector, ObservationBody } from './src/client/views/TrajectoryInspector.tsx'",
      "export { inspectedOf } from './src/client/views/TrajectoryView.tsx'",
      "export { flattenRows, focusTarget, selectionTurn, recordKey, rowKeyOf, OBSERVATION_KEY } from './src/client/views/trajectory-model.ts'",
      "export { locales } from './src/client/views/locale.ts'",
    ].join('\n'),
    resolveDir: root, loader: 'tsx',
  },
  outfile: join(out, 'observation.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24', logLevel: 'error',
  jsx: 'automatic', loader: { '.module.css': 'local-css', '.css': 'css' }, plugins: [miniReact],
})
const M = await import(pathToFileURL(join(out, 'observation.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

const fill = (text, vars = {}) => String(text).replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`))
const t = (key, vars) => fill(M.locales.en[key] ?? key, vars)

const user = { kind: 'user', seq: 1, turn: 1, at: 1000, source: 'user', text: 'hi' }
const observation = (seq) => ({
  kind: 'observation', seq, turn: 1, at: 5000,
  text: 'polled 82,726 times across 20 read-only operations', top: ['workspace status: 31,593', 'branch list: 12,000'], reads: 82726,
})
const answerOf = (records) => ({
  sessionId: 's', project: 'st/p', branch: 'dsh.s', logLoaded: true,
  turns: [{ turn: 1, at: 1000, records, orphanCalls: [], hostOps: [], checkpoints: [] }],
  checkpoints: [], counts: { versionsCreated: 0, callsWithVersions: 0 }, revision: 'r', recordTotal: records.length,
})

test('the observation inspector shows the counter and reads no record detail', async () => {
  const asked = []
  const api = { op: async (name, args) => { asked.push({ name, args }); return {} } }
  const view = M.mount(M.TrajectoryInspector, {
    api, sessionId: 's', inspected: { kind: 'record', turn: 1, record: observation(2) }, tab: 'summary',
    onTab() {}, onClose() {}, onOpen: undefined, cache: new Map(), t, layerfs: true,
  })
  const tree = await view.settle()
  assert.deepEqual(asked, [], 'no session.trajectory.record for a made-up seq')
  assert.deepEqual(M.elements(tree).filter((e) => e.props?.role === 'tab'), [], 'one view, no Timing tab over nothing')

  const body = M.mount(M.ObservationBody, { record: { ...observation(2), truncated: true }, t })
  const text = M.text(body.tree)
  assert.match(text, /polled 82,726 times/)
  assert.match(text, /82,726/)
  assert.match(text, /workspace status: 31,593/)
  assert.match(text, /branch list: 12,000/)
  assert.match(text, /counter still covers them/, 'the record cap is said')
  for (const key of ['trajObsCounted', 'trajObsReads', 'trajObsTop', 'trajObsLast', 'trajObsNote', 'trajObsTruncated']) {
    assert.ok(M.locales.zh[key], `zh.${key}`)
  }
})

test('selecting the observation row keys on the row, not its made-up seq', () => {
  const before = answerOf([user, observation(2)])
  const rows = M.flattenRows(before.turns, { turnOpen: () => true, callOpen: () => true, contextOpen: () => false })
  const row = rows.find((r) => r.type === 'record' && r.record.kind === 'observation')
  assert.equal(row.key, M.OBSERVATION_KEY)
  assert.equal(rows.find((r) => r.type === 'record' && r.record.kind === 'user').key, M.recordKey(1))
  assert.equal(M.inspectedOf(before, row.key, t)?.record.kind, 'observation')
  assert.equal(M.selectionTurn(before, row.key), 1)

  // The session moves on: a real record takes seq 2 and the observation moves to 3.
  const after = answerOf([user, { kind: 'assistant', seq: 2, turn: 1, at: 2000, text: 'ok', toolCalls: 0 }, observation(3)])
  assert.equal(M.inspectedOf(after, row.key, t)?.record.kind, 'observation', 'the selection stays on the observation row')
  // A record key never lands on the observation, and a focus by seq never names it.
  assert.equal(M.inspectedOf(after, M.recordKey(3), t), null)
  assert.equal(M.focusTarget(after, JSON.stringify({ seq: 3 })), null)
})
