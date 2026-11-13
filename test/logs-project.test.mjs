/** `logs.project`'s scan (`projectCalls`) over the stand-in call log. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectCalls } from '../src/host/logs/source.ts'

const line = (at, argv, tag = 'dsh:-:x', outcome = 'ok') => ({ v: 1, at, ms: 5, client: 'cli', argv, outcome, tag })

function home(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'lfs-logs-project-'))
  const callLog = join(dir, 'calls.jsonl')
  writeFileSync(callLog, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return { nativeLogs: async () => false, callLog }
}

test('projectCalls keeps the project\'s calls and its Sandboxes\' calls, newest first', async () => {
  const layerfs = home([
    line(1, ['sandbox', 'create', 's/p', 'made', 'm']),
    line(2, ['workspace', 'exec', 'made:w', '<9 bytes>']),
    line(3, ['workspace', 'exec', 'known:w', '<9 bytes>']),
    line(4, ['workspace', 'exec', 'foreign:w', '<9 bytes>']),
    line(5, ['sandbox', 'create', 's/q', 'foreign', 'm']),
    line(6, ['file', 'write', 's/p', 'main', 'a.txt']),
    line(7, ['file', 'write', 's/q', 'main', 'a.txt']),
    line(8, ['branch', 'commits', 's/p', 'main']),
    line(9, ['file', 'read', 's/p', 'main', 'a.txt'], 'dsh:session-1:r1'),
    line(10, ['workspace', 'commit', 'made:w', '--message', '<3 bytes>']),
  ])
  const answer = await projectCalls(layerfs, 's/p', ['known'])
  assert.deepEqual(answer.lines.map((l) => l.at), [10, 9, 6, 3, 2, 1],
    'Sandboxes made in the scan or listed count; a read outside a session (branch commits) is left out; a session\'s read is kept')
  assert.equal(answer.source, 'plugin')
  assert.equal(answer.has_more, false)
  const limited = await projectCalls(layerfs, 's/p', ['known'], 2)
  assert.deepEqual(limited.lines.map((l) => l.at), [10, 9])
})

test('projectCalls stops at its scan budget', async () => {
  const lines = Array.from({ length: 30 }, (_, i) => line(i + 1, ['file', 'write', 's/p', 'main', `f${i}`]))
  const answer = await projectCalls(home(lines), 's/p', [], 500, 10)
  assert.equal(answer.scanned, 10)
  assert.equal(answer.has_more, true)
  assert.deepEqual(answer.lines.map((l) => l.at), [30, 29, 28, 27, 26, 25, 24, 23, 22, 21])
})
