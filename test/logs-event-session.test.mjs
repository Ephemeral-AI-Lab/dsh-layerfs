// The `logs` event's session: the host reads the call log from a cursor, because
// CLI and SDK calls are appended by separate processes. A window it cannot
// attribute (rotation, partial line, untagged line) must answer null so every
// view refreshes rather than one being skipped.
//   node --test test/logs-event-session.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readNewCallTags } from '../src/host/logs/new-lines.ts'

const line = (tag) => `${JSON.stringify({ v: 1, at: Date.now(), client: 'cli', argv: ['file', 'read'], outcome: 'ok', ...(tag === undefined ? {} : { tag }) })}\n`

test('appended tagged lines give their tags; nothing new gives none', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lfs-newlines-'))
  try {
    const path = join(dir, 'calls.jsonl')
    writeFileSync(path, line('dsh:session-a:r0'))
    const held = { value: null }
    assert.deepEqual(readNewCallTags(path, held), [], 'the first look starts at the end')
    assert.deepEqual(readNewCallTags(path, held), [], 'nothing appended')
    appendFileSync(path, line('dsh:session-a:r1') + line('dsh:session-a:r2'))
    assert.deepEqual(readNewCallTags(path, held), ['dsh:session-a:r1', 'dsh:session-a:r2'])
    assert.deepEqual(readNewCallTags(path, held), [], 'read once')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a partial trailing line is unreadable now and read whole next time', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lfs-newlines-'))
  try {
    const path = join(dir, 'calls.jsonl')
    writeFileSync(path, line('dsh:session-a:r0'))
    const held = { value: null }
    readNewCallTags(path, held)
    appendFileSync(path, '{"v":1,"tag":"dsh:session-a:r1"}')
    assert.equal(readNewCallTags(path, held), null, 'mid-line: not attributable')
    appendFileSync(path, '\n')
    assert.deepEqual(readNewCallTags(path, held), ['dsh:session-a:r1'], 'the completed line is read once')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('an untagged or broken line makes the window unattributable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lfs-newlines-'))
  try {
    const path = join(dir, 'calls.jsonl')
    writeFileSync(path, line('dsh:session-a:r0'))
    const held = { value: null }
    readNewCallTags(path, held)
    appendFileSync(path, line(undefined))
    assert.equal(readNewCallTags(path, held), null)
    appendFileSync(path, 'not json\n')
    assert.equal(readNewCallTags(path, held), null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a truncated file and a replaced file are unattributable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lfs-newlines-'))
  try {
    const path = join(dir, 'calls.jsonl')
    writeFileSync(path, line('dsh:session-a:r0') + line('dsh:session-a:r1'))
    const held = { value: null }
    readNewCallTags(path, held)
    appendFileSync(path, line('dsh:session-a:r2'))
    assert.deepEqual(readNewCallTags(path, held), ['dsh:session-a:r2'])
    // Truncation to an empty file resets the cursor; later bytes at 0 are new.
    writeFileSync(path, '')
    assert.equal(readNewCallTags(path, held), null, 'shorter than the cursor')
    appendFileSync(path, line('dsh:session-b:r0'))
    assert.deepEqual(readNewCallTags(path, held), ['dsh:session-b:r0'], 'new bytes after the reset')
    // A writer rotating by rename: another inode, so the window cannot be trusted.
    const moved = join(dir, 'next.jsonl')
    writeFileSync(moved, line('dsh:session-c:r0') + line('dsh:session-c:r1'))
    renameSync(moved, path)
    assert.equal(readNewCallTags(path, held), null, 'a different inode')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
