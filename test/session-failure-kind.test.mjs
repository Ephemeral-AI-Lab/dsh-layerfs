// A session's raw error is worded for PostgreSQL only when its Store is PostgreSQL (or of unknown kind).
//   node --test test/session-failure-kind.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inferSessionFailure } from '../src/client/projects/session-failure.ts'

test('a SQLite Store\'s unreachable machine is not a PostgreSQL server failure', () => {
  const raw = 'machine docker did not answer in time: connection refused'
  assert.equal(inferSessionFailure(raw, 's', undefined, 'sqlite')?.code?.startsWith('pg_') ?? false, false)
  assert.match(inferSessionFailure(raw, 's', undefined, 'postgresql')?.code ?? '', /^pg_/)
  assert.match(inferSessionFailure(raw, 's')?.code ?? '', /^pg_/, 'unknown kind keeps the PostgreSQL reading')
})
