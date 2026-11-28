// The session line's branch chip: the host's branchKind/restore name the case.
// The words are the views' own dictionary, in both languages.
//   node --test test/branch-label.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { branchLabel } from '../src/client/views/branch-label.ts'
import { locales } from '../src/client/views/locale.ts'

const fill = (text, vars = {}) => text.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`))
const tOf = (lang) => (key, vars) => fill(locales[lang][key] ?? key, vars)
const en = tOf('en')
const zh = tOf('zh')

const chip = (branch, branchKind, restore) => ({ branch, branchKind, ...(restore === undefined ? {} : { restore }) })

test('the host kind is the chip\'s words: own, restore, resume, or another branch by name', () => {
  assert.equal(branchLabel(chip('dsh.ab12', 'own'), en), 'This session’s branch')
  assert.equal(branchLabel(chip('dsh.ab12.r2', 'restore', 2), en), 'This session’s branch · restore 2')
  assert.equal(branchLabel(chip('dsh.ab12.resume.0123456789ab', 'resume'), en), 'This session’s branch · resumed')
  assert.equal(branchLabel(chip('feature/x', 'other'), en), 'Session branch feature/x')
})

test('the same words in Chinese', () => {
  assert.equal(branchLabel(chip('dsh.ab12', 'own'), zh), '本会话的分支')
  assert.equal(branchLabel(chip('dsh.ab12.r2', 'restore', 2), zh), '本会话的分支 · 第 2 次恢复')
  assert.equal(branchLabel(chip('dsh.ab12.resume.0123456789ab', 'resume'), zh), '本会话的分支 · 已恢复')
  assert.equal(branchLabel(chip('feature/x', 'other'), zh), '会话分支 feature/x')
})

test('the host answer wins over the name', () => {
  assert.equal(branchLabel(chip('dsh.ab12', 'resume'), en), 'This session’s branch · resumed')
  assert.equal(branchLabel(chip('dsh.ab12', 'other'), en), 'Session branch dsh.ab12')
})

test('no binding or no branch says nothing', () => {
  assert.equal(branchLabel(null, en), '')
  assert.equal(branchLabel(undefined, en), '')
  assert.equal(branchLabel(chip(undefined, 'own'), en), '')
})
