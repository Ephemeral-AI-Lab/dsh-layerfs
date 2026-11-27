// The prune tool's keep set beside the host's own list: DSH's archive set is
// read from the workspace store (the running host may predate the host-side
// default), and --exclude adds to it. `node --test test/prune-exclusions.test.mjs`
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { archivedSessionIds, keepSet, pruneOutcome } from '../tools/prune-exclusions.mjs'

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

test('pruneOutcome on an old host: a dry run answers, an apply is refused and claims no deletion', () => {
  const dry = pruneOutcome({ apply: false, result: { ok: true, candidates: ['draft-a', 'draft-b'], deleted: [], archiveKnown: false } })
  assert.equal(dry.exitCode, 0)
  assert.match(dry.note, /dry run: 2 candidate\(s\), nothing deleted/)
  assert.match(dry.note, /cannot verify DSH's archive set/)
  assert.match(dry.note, /--apply is refused until DSH restarts/)
  const apply = pruneOutcome({
    apply: true,
    result: { ok: false, code: 'InvalidInput', message: 'Refusing to delete: the archive set is unknown', detail: { archiveKnown: false, reason: 'archive-unknown' } },
  })
  assert.equal(apply.exitCode, 1)
  assert.match(apply.note, /refused:/)
  assert.match(apply.note, /deleted nothing/)
  assert.match(apply.note, /restart DSH/)
  assert.doesNotMatch(apply.note, /deleted [1-9]/, 'a refusal never claims a deletion')
})

test('pruneOutcome on a new host keeps the normal dry-run and apply messages', () => {
  const dry = pruneOutcome({ apply: false, result: { ok: true, candidates: ['draft'], deleted: [], archiveKnown: true } })
  assert.equal(dry.exitCode, 0)
  assert.match(dry.note, /dry run: 1 candidate\(s\), nothing deleted\. Re-run with --apply/)
  const apply = pruneOutcome({ apply: true, result: { ok: true, candidates: ['draft'], deleted: ['draft'], archiveKnown: true } })
  assert.equal(apply.exitCode, 0)
  assert.equal(apply.note, 'deleted 1 conversation(s).')
  const failed = pruneOutcome({ apply: false, result: { ok: false, code: 'Unavailable', message: 'host is down' } })
  assert.equal(failed.exitCode, 1)
  assert.equal(failed.note, 'refused (Unavailable): host is down')
})
