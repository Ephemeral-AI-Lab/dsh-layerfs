import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSimulationBashReceipt } from '../src/host/simulations/receipts.ts'
const tool = frames => ({ value: { kind: 'foreground', exitCode: 0, stdout: { text: frames.map(frame => typeof frame === 'string' ? frame : JSON.stringify(frame)).join('\n') + '\n', truncated: false } } })

test('a workspace exec resolves its one result JSON; a non-zero exit is the command\'s when the result says so', () => {
  const receipt = { exit_code: 0, stdout: 'hi', exec: 'exec-1' }
  const result = tool([receipt])
  assert.deepEqual(parseSimulationBashReceipt(result, { exec: true }), receipt)
  // The decoder never replaces or strips the ordinary tool result.
  assert.equal(result.value.stdout.text, JSON.stringify(receipt) + '\n')
  const failed = { value: { ...tool([{ exit_code: 3, stderr: 'no', exec: 'exec-2' }]).value, exitCode: 3 } }
  assert.equal(parseSimulationBashReceipt(failed, { exec: true }).exit_code, 3)
  assert.throws(() => parseSimulationBashReceipt(failed), /complete successful result/, 'only an exec exits with the command\'s code')
  assert.throws(() => parseSimulationBashReceipt({ value: { ...tool([{ exit_code: 0 }]).value, exitCode: 3 } }, { exec: true }), /complete successful result/)
  assert.throws(() => parseSimulationBashReceipt({ value: { ...tool([{ error: 'Busy' }]).value, exitCode: 125 } }, { exec: true }), /complete successful result/)
})
test('ordinary direct-write receipt retains the exact saved-version structure', () => {
  const receipt = { kind: 'Written', head: '02' + 'a'.repeat(64) }
  assert.deepEqual(parseSimulationBashReceipt(tool([receipt])), receipt)
})
test('incomplete, malformed and trailing output cannot confirm a mutation', () => {
  for (const frames of [[], [{}, {}], [{ commit: 'x' }, { commit: 'y' }], ['{bad'], [[{ commit: 'x' }]], ['null'], ['3']]) {
    assert.throws(() => parseSimulationBashReceipt(tool(frames)))
    assert.throws(() => parseSimulationBashReceipt(tool(frames), { exec: true }))
  }
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
