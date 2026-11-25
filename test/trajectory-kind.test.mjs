// The call log `kind` vocabulary: the pinned CLI's lower-case words and the
// stand-in's capitalized ones are one family; the trajectory and receipt
// readers normalize before comparing (issue #186 version chips).
//   node --test test/trajectory-kind.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildTrajectory } from '../src/host/sessions/trace.ts'
import { lineVersions, receiptFromLine } from '../src/host/layerfs/tracing.ts'
import { displayKind, kindFamily, normalizeKind, versionEffect } from '../src/shared/trajectory.ts'

const COMMIT = 'ab'.repeat(33), LAYER = 'cd'.repeat(33)
const label = (kind) => `kind ${JSON.stringify(kind)}`

test('normalizeKind: separators and camel case collapse to one spelling', () => {
  for (const kind of ['committed', 'Committed', 'COMMITTED']) assert.equal(normalizeKind(kind), 'committed', label(kind))
  for (const kind of ['UpToDate', 'up-to-date', 'up_to_date', 'up to date', 'UPTODATE']) assert.equal(normalizeKind(kind), 'up-to-date', label(kind))
  for (const kind of ['NoChanges', 'no-changes', 'no_changes', 'no changes', 'NOCHANGES']) assert.equal(normalizeKind(kind), 'no-changes', label(kind))
  for (const kind of ['Forked', 'forked', 'Merged', 'merged', 'Added', 'added']) assert.equal(normalizeKind(kind), kind.toLowerCase(), label(kind))
  assert.equal(normalizeKind('exit:0'), 'exit:0', 'an unknown word keeps its shape')
  assert.equal(normalizeKind('  weird Kind  '), 'weird-kind')
})

test('kindFamily: created, unchanged, forked; an unknown word has no family', () => {
  for (const kind of ['committed', 'Committed', 'added', 'Added', 'merged', 'Merged']) assert.equal(kindFamily(kind), 'created', label(kind))
  for (const kind of ['up-to-date', 'up_to_date', 'UpToDate', 'no-changes', 'NoChanges', 'unchanged', 'Unchanged']) assert.equal(kindFamily(kind), 'unchanged', label(kind))
  for (const kind of ['forked', 'Forked']) assert.equal(kindFamily(kind), 'forked', label(kind))
  assert.equal(kindFamily('exit:0'), undefined)
  assert.equal(kindFamily('created'), undefined, 'a machine op word is not a save family')
  assert.equal(kindFamily(undefined), undefined)
})

test('displayKind: the canonical word for a known family, the CLI word for an unknown one', () => {
  assert.equal(displayKind('committed'), 'Committed')
  assert.equal(displayKind('Committed'), 'Committed')
  assert.equal(displayKind('up_to_date'), 'UpToDate')
  assert.equal(displayKind('UpToDate'), 'UpToDate')
  assert.equal(displayKind('no changes'), 'NoChanges')
  assert.equal(displayKind('forked'), 'Forked')
  assert.equal(displayKind('weird_kind'), 'weird_kind', 'unknown as given')
  assert.equal(displayKind('exit:0'), 'exit:0')
})

test('versionEffect: a lower-case kind has the same effect as its capitalized twin', () => {
  for (const kind of ['committed', 'Committed', 'added', 'Added']) assert.equal(versionEffect(kind), 'created', label(kind))
  for (const kind of ['up-to-date', 'UpToDate', 'no-changes', 'NoChanges', 'unchanged', 'Unchanged']) assert.equal(versionEffect(kind), 'unchanged', label(kind))
  for (const kind of ['forked', 'Forked']) assert.equal(versionEffect(kind), 'referenced', label(kind))
  assert.equal(versionEffect('merged'), 'referenced')
  assert.equal(versionEffect('Merged', true), 'referenced')
  assert.equal(versionEffect('merged', false), 'created', 'a non-fast-forward merge made a Commit')
  assert.equal(versionEffect('exit:0'), undefined)
})

const line = (kind, extra = {}) => ({ v: 1, at: 1, ms: 2, client: 'cli', argv: ['workspace', 'commit', 'sb:main'], outcome: 'ok', kind, ...extra })

test('lineVersions: a real-shaped lower-case line names its created version', () => {
  assert.deepEqual(lineVersions(line('committed', { commit: COMMIT })), [{ kind: 'Commit', id: COMMIT, effect: 'created' }])
  assert.deepEqual(lineVersions(line('unchanged', { commit: COMMIT })), [{ kind: 'Commit', id: COMMIT, effect: 'unchanged' }])
  assert.deepEqual(lineVersions(line('up-to-date', { commit: COMMIT })), [{ kind: 'Commit', id: COMMIT, effect: 'unchanged' }])
  assert.deepEqual(lineVersions({ ...line('forked', { commit: COMMIT, argv: ['branch', 'fork', 'st/p', 'new', 'main'] }) }), [{ kind: 'Commit', id: COMMIT, effect: 'referenced' }])
  // A publication's Commit is main's Layer: kept distinguishable from a Branch Commit.
  assert.deepEqual(lineVersions({ ...line('added', { layer: LAYER, commit: undefined, argv: ['branch', 'publish', 'st/p', 'b'] }) }), [{ kind: 'Layer', id: LAYER, effect: 'created' }])
  assert.deepEqual(lineVersions({ ...line('merged', { commit: COMMIT, argv: ['branch', 'merge', 'st/p', 'n', 'a', 'b'] }) }), [{ kind: 'Commit', id: COMMIT, effect: 'referenced' }])
  assert.deepEqual(lineVersions({ ...line('merged', { commit: COMMIT, argv: ['branch', 'merge', 'st/p', 'n', 'a', 'b'] }) }, false), [{ kind: 'Commit', id: COMMIT, effect: 'created' }])
  assert.deepEqual(lineVersions(line('exit:0', { commit: COMMIT })), [], 'an unknown kind links nothing')
  assert.deepEqual(lineVersions(line('committed', { commit: 'short' })), [])
})

test('a lower-case line through a receipt yields the trajectory version chip and count', () => {
  const identity = { origin: 'tool', sessionId: 's', project: 'st/p', turn: 1, toolCallId: 'call-1', workspace: 'sb:main' }
  const receipt = receiptFromLine(line('committed', { commit: COMMIT }), identity, 'r1')
  assert.equal(receipt.kind, 'Committed')
  assert.deepEqual(receipt.versions, [{ kind: 'Commit', id: COMMIT, effect: 'created' }])
  const answer = buildTrajectory({ sessionId: 's', project: 'st/p', branch: 'dsh.s', events: undefined, invocations: [receipt], checkpoints: [] })
  const op = answer.turns[0].orphanCalls[0].ops[0]
  assert.equal(op.kind, 'Committed')
  assert.equal(op.operation, 'workspace.commit')
  assert.deepEqual(op.versions, [{ kind: 'Commit', id: COMMIT, effect: 'created', branch: 'dsh.s' }])
  assert.equal(answer.counts.callsWithVersions, 1)
  assert.equal(answer.counts.versionsCreated, 1)

  const unchanged = receiptFromLine(line('unchanged', { commit: COMMIT }), identity, 'r2')
  assert.equal(unchanged.kind, 'Unchanged')
  assert.deepEqual(unchanged.versions, [{ kind: 'Commit', id: COMMIT, effect: 'unchanged' }])

  // A receipt replayed from an older sidecar (no `versions`) still counts by its kind family.
  const legacy = { id: 'r3', origin: 'tool', sessionId: 's', project: 'st/p', turn: 1, toolCallId: 'call-3', operation: 'workspace.commit', outcome: 'success', kind: 'committed', versions: [] }
  const replayed = buildTrajectory({ sessionId: 's', project: 'st/p', branch: 'dsh.s', events: undefined, invocations: [legacy], checkpoints: [] })
  assert.equal(replayed.turns[0].orphanCalls[0].ops[0].kind, 'Committed')
  assert.equal(replayed.counts.versionsCreated, 1)
  assert.equal(replayed.counts.callsWithVersions, 1)
})
