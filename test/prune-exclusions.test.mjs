// The prune tool's keep set beside the host's own list: DSH's archive set is
// read from the workspace store (the running host may predate the host-side
// default), and --exclude adds to it. `node --test test/prune-exclusions.test.mjs`
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { archivedSessionIds, keepSet } from '../tools/prune-exclusions.mjs'

test('keepSet is the deduped union of the open session, the archive set and --exclude', () => {
  assert.deepEqual(keepSet('open', ['archived-a', 'archived-b'], ['excluded', 'archived-a']), ['open', 'archived-a', 'archived-b', 'excluded'])
  assert.deepEqual(keepSet(undefined, [], []), [], 'no session, no archive, no exclusion')
  assert.deepEqual(keepSet('open', ['', null], [undefined]), ['open'], 'empty values are dropped')
})

test('archivedSessionIds reads global.archivedSessionIds and is empty when the store is missing or unreadable', () => {
  const home = mkdtempSync(join(tmpdir(), 'prune-exclusions-'))
  try {
    mkdirSync(join(home, 'storages'), { recursive: true })
    writeFileSync(join(home, 'storages', 'workspace.json'), JSON.stringify({ global: { archivedSessionIds: ['session-a', 'session-b', 7] } }))
    assert.deepEqual(archivedSessionIds(home), ['session-a', 'session-b'])
    assert.deepEqual(archivedSessionIds(join(home, 'missing')), [], 'a missing workspace store is not an error')
    writeFileSync(join(home, 'storages', 'workspace.json'), 'not json')
    assert.deepEqual(archivedSessionIds(home), [], 'a malformed workspace store is not an error')
  } finally { rmSync(home, { recursive: true, force: true }) }
})
