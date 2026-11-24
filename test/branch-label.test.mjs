// The session line's branch chip: the host's branchKind/restore name the case,
// and a binding without them (an older host) falls back to describeBranch. The
// words are the views' own dictionary, in both languages.
//   node --test test/branch-label.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { branchLabel } from '../src/client/views/branch-label.ts'
import { locales } from '../src/client/views/locale.ts'

const fill = (text, vars = {}) => text.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`))
const tOf = (lang) => (key, vars) => fill(locales[lang][key] ?? key, vars)
const en = tOf('en')
const zh = tOf('zh')

const chip = (branch, branchKind, restore) => ({
  branch,
  ...(branchKind === undefined ? {} : { branchKind }),
  ...(restore === undefined ? {} : { restore }),
})

test('the host kind is the chip\'s words: own, restore, resume, or another branch by name', () => {
  assert.equal(branchLabel('session-ab-12', chip('dsh.ab12', 'own'), en), 'This session’s branch')
  assert.equal(branchLabel('session-ab-12', chip('dsh.ab12.r2', 'restore', 2), en), 'This session’s branch · restore 2')
  assert.equal(branchLabel('session-ab-12', chip('dsh.ab12.resume.0123456789ab', 'resume'), en), 'This session’s branch · resumed')
  assert.equal(branchLabel('session-ab-12', chip('feature/x', 'other'), en), 'Session branch feature/x')
})

test('the same words in Chinese', () => {
  assert.equal(branchLabel('session-ab-12', chip('dsh.ab12', 'own'), zh), '本会话的分支')
  assert.equal(branchLabel('session-ab-12', chip('dsh.ab12.r2', 'restore', 2), zh), '本会话的分支 · 第 2 次恢复')
  assert.equal(branchLabel('session-ab-12', chip('dsh.ab12.resume.0123456789ab', 'resume'), zh), '本会话的分支 · 已恢复')
  assert.equal(branchLabel('session-ab-12', chip('feature/x', 'other'), zh), '会话分支 feature/x')
})

test('without the host annotation the shared derivation names the same cases', () => {
  const branch = (b) => chip(b)
  assert.equal(branchLabel('session-AB-12', branch('dsh.ab12'), en), 'This session’s branch')
  assert.equal(branchLabel('session-AB-12', branch('dsh.ab12.r3'), en), 'This session’s branch · restore 3')
  assert.equal(branchLabel('session-AB-12', branch('dsh.ab12.resume.0123456789ab'), en), 'This session’s branch · resumed')
  assert.equal(branchLabel('session-AB-12', branch('dsh.other'), en), 'Session branch dsh.other')
  assert.equal(branchLabel('session-AB-12', branch('dsh.ab12.r3'), zh), '本会话的分支 · 第 3 次恢复')
  assert.equal(branchLabel('session-AB-12', branch('dsh.ab12.resume.0123456789ab'), zh), '本会话的分支 · 已恢复')
})

test('the host answer wins over the name, and a missing count falls back to the name', () => {
  assert.equal(branchLabel('session-ab-12', chip('dsh.ab12', 'resume'), en), 'This session’s branch · resumed')
  assert.equal(branchLabel('session-ab-12', chip('dsh.ab12', 'other'), en), 'Session branch dsh.ab12')
  assert.equal(branchLabel('session-ab-12', chip('dsh.ab12.r4', 'restore'), en), 'This session’s branch · restore 4')
  assert.equal(branchLabel('session-ab-12', chip('dsh.ab12.r4', 'restore'), zh), '本会话的分支 · 第 4 次恢复')
})

test('no binding or no branch says nothing', () => {
  assert.equal(branchLabel('session-ab-12', null, en), '')
  assert.equal(branchLabel('session-ab-12', undefined, en), '')
  assert.equal(branchLabel('session-ab-12', chip(undefined, 'own'), en), '')
})

test('the fallback reads the binding\'s session id, so a subagent still sees its root\'s branch', () => {
  const binding = { sessionId: 'session-AB-12', branch: 'dsh.ab12.r2' }
  assert.equal(branchLabel('subagent-xyz', binding, en), 'This session’s branch · restore 2')
})
