// The host's branch naming, shared by both faces: a session's own branch, the
// generation a restore made, and the suffix an archive resume made. Any other
// branch (another session's included) is just a name.
//   node --test test/session-branch.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { branchFields, compactSessionId, describeBranch } from '../src/shared/session-branch.ts'

test('compactSessionId is the host\'s compact: no session- prefix, no punctuation, lowercase', () => {
  assert.equal(compactSessionId('session-AB-cd.12'), 'abcd12')
  assert.equal(compactSessionId('493a4b3f-751a-4b9d-9241-e8d1ae2c46f4'), '493a4b3f751a4b9d9241e8d1ae2c46f4')
  assert.equal(compactSessionId('session-session-x'), 'sessionx')
  assert.equal(compactSessionId('SESSION-UP'), 'sessionup')
})

test('describeBranch reads the session\'s own branch and its restore generations', () => {
  const id = 'session-AB-12'
  assert.deepEqual(describeBranch(id, 'dsh.ab12'), { kind: 'own' })
  assert.deepEqual(describeBranch(id, 'dsh.ab12.r1'), { kind: 'restore', restore: 1 })
  assert.deepEqual(describeBranch(id, 'dsh.ab12.r2'), { kind: 'restore', restore: 2 })
  assert.deepEqual(describeBranch(id, 'dsh.ab12.r10'), { kind: 'restore', restore: 10 })
})

test('describeBranch reads an archive resume at 8 or more hex characters', () => {
  const id = 'session-ab-12'
  assert.deepEqual(describeBranch(id, 'dsh.ab12.resume.01234567'), { kind: 'resume' })
  assert.deepEqual(describeBranch(id, 'dsh.ab12.resume.0123456789ab'), { kind: 'resume' })
  assert.deepEqual(describeBranch(id, 'dsh.ab12.resume.0123456789AB'), { kind: 'resume' }, 'hex either case')
})

test('describeBranch leaves another session\'s branch and unrelated branches alone', () => {
  assert.deepEqual(describeBranch('abc', 'dsh.abd'), { kind: 'other' })
  assert.deepEqual(describeBranch('abc', 'dsh.abcx'), { kind: 'other' })
  assert.deepEqual(describeBranch('abc', 'feature/x'), { kind: 'other' })
  assert.deepEqual(describeBranch('abc', 'main'), { kind: 'other' })
  assert.deepEqual(describeBranch('abc', ''), { kind: 'other' })
  assert.deepEqual(describeBranch('abc', null), { kind: 'other' })
  assert.deepEqual(describeBranch('abc', undefined), { kind: 'other' })
})

test('describeBranch refuses malformed suffixes: short or non-hex resumes, non-numeric generations', () => {
  assert.deepEqual(describeBranch('abc', 'dsh.abc.resume.0123456'), { kind: 'other' }, '7 hex characters')
  assert.deepEqual(describeBranch('abc', 'dsh.abc.resume.zzzzzzzz'), { kind: 'other' })
  assert.deepEqual(describeBranch('abc', 'dsh.abc.resume.0123456g'), { kind: 'other' })
  assert.deepEqual(describeBranch('abc', 'dsh.abc.resume.'), { kind: 'other' })
  assert.deepEqual(describeBranch('abc', 'dsh.abc.r'), { kind: 'other' })
  assert.deepEqual(describeBranch('abc', 'dsh.abc.rx'), { kind: 'other' })
  assert.deepEqual(describeBranch('abc', 'dsh.abc.r2x'), { kind: 'other' })
  assert.deepEqual(describeBranch('abc', 'dsh.abc.r-1'), { kind: 'other' })
  assert.deepEqual(describeBranch('abc', 'dsh.abc.r999999999999999999999'), { kind: 'other' }, 'not a safe integer')
})

test('branchFields names the kind for a binding, restore only when there is one', () => {
  assert.deepEqual(branchFields('abc', 'dsh.abc'), { branchKind: 'own' })
  assert.deepEqual(branchFields('abc', 'dsh.abc.r3'), { branchKind: 'restore', restore: 3 })
  assert.deepEqual(branchFields('abc', 'dsh.abc.resume.0123456789ab'), { branchKind: 'resume' })
  assert.deepEqual(branchFields('abc', 'feature/x'), { branchKind: 'other' })
  assert.deepEqual(branchFields('abc', null), { branchKind: 'other' })
  assert.equal('restore' in branchFields('abc', 'dsh.abc'), false)
})
