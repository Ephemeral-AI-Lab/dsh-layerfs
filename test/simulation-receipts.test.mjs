import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSimulationBashReceipt } from '../src/host/simulations/receipts.ts'
const tool = frames => ({ value: { kind: 'foreground', exitCode: 0, stdout: { text: frames.map(frame => typeof frame === 'string' ? frame : JSON.stringify(frame)).join('\n') + '\n', truncated: false } } })

test('framed workspace execution resolves its one final real receipt', () => {
  const receipt = { kind: 'exit:0', exit_code: 0 }
  const result = tool([{ progress: { phase: 'running' } }, { stream: 'stdout', bytes: [104, 105] }, { stream: 'stderr', bytes: [] }, { result: receipt }])
  assert.deepEqual(parseSimulationBashReceipt(result, { events: true }), receipt)
  // The decoder never replaces or strips frames from the ordinary tool result.
  assert.equal(result.value.stdout.text.split('\n').length, 5)
})
test('ordinary direct-write receipt retains the exact saved-version structure', () => {
  const receipt = { kind: 'Written', head: '02' + 'a'.repeat(64) }
  assert.deepEqual(parseSimulationBashReceipt(tool([receipt])), receipt)
})
test('incomplete, refused, malformed and trailing event output cannot confirm a mutation', () => {
  for (const frames of [
    [], [{ stream: 'stdout', bytes: [] }], [{ result: null }], [{ refusal: { code: 'Busy' } }],
    [{ result: {} }, { result: {} }], [{ result: {} }, { progress: {} }],
    [{ unknown: true }], ['{bad'], [[{ result: {} }]],
  ]) assert.throws(() => parseSimulationBashReceipt(tool(frames), { events: true }))
  assert.throws(() => parseSimulationBashReceipt(tool([{}, {}])))
})
test('tool failures and truncated output cannot become successful receipts', () => {
  for (const result of [
    { ...tool([{}]), isError: true },
    { value: { ...tool([{}]).value, exitCode: 1 } },
    { value: { ...tool([{}]).value, aborted: true } },
    { value: { ...tool([{}]).value, timedOut: true } },
    { value: { ...tool([{}]).value, stdout: { text: '{}', truncated: true } } },
  ]) assert.throws(() => parseSimulationBashReceipt(result), /complete successful result/)
})
