// The Logs page's default and its empty-state question: the page opens on every
// call (one native page), and an empty filtered view must not probe the log on
// every event — a tag empty view never asks at all.
//   node --test test/logs-filters.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { argsOf, DEFAULT_FILTERS, emptyAction } from '../src/client/logs/filters.ts'

test('the page opens on all calls, not the client-side writes scan', () => {
  assert.equal(DEFAULT_FILTERS.writes, false)
  assert.deepEqual(argsOf(DEFAULT_FILTERS), { limit: 100 }, 'no writes filter is sent on mount')
  assert.equal(argsOf({ ...DEFAULT_FILTERS, writes: true }).writes, true, 'Only writes is an explicit filter')
})

test('an empty view asks the whole-log question only when it has to', () => {
  assert.equal(emptyAction({ lines: 3, hasMore: false, unfiltered: false, tag: false, known: undefined }), 'nonempty')
  assert.equal(emptyAction({ lines: 0, hasMore: true, unfiltered: true, tag: false, known: undefined }), 'skip')
  assert.equal(emptyAction({ lines: 0, hasMore: false, unfiltered: true, tag: false, known: undefined }), 'empty')
  // The empty session filter: a tag has its own empty state, so no probe (the old page made this two reads per event).
  assert.equal(emptyAction({ lines: 0, hasMore: false, unfiltered: false, tag: true, known: undefined }), 'skip')
  assert.equal(emptyAction({ lines: 0, hasMore: false, unfiltered: false, tag: false, known: false }), 'skip')
  assert.equal(emptyAction({ lines: 0, hasMore: false, unfiltered: false, tag: false, known: undefined }), 'probe')
})
