// The phone's folded Trajectory summary read "1 checkpoints" and "1 versions":
// one of each uses its own singular wording, in English and Chinese.
//   node --test test/trajectory-summary-plural.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')

test('one version or checkpoint has a singular summary in both languages', () => {
  const locale = read('../src/client/views/locale.ts')
  const zhAt = locale.indexOf('const zh')
  for (const [lang, part] of [['en', locale.slice(0, zhAt)], ['zh', locale.slice(zhAt)]]) {
    for (const key of ['trajSummaryCheckpointOne', 'trajSummaryVersionOne', 'trajSummaryVersionOneWindow']) {
      const m = part.match(new RegExp(`^\\s+${key}: '([^']*)'`, 'm'))
      assert.ok(m, `${lang} ${key}`)
      assert.ok(!m[1].includes('{n}'), `${lang} ${key} names the count itself`)
    }
  }
  assert.match(locale, /trajSummaryCheckpointOne: '1 checkpoint',/)
  assert.match(locale, /trajSummaryVersionOne: '1 version',/)
})

test('the folded summary picks the singular for exactly one', () => {
  const view = read('../src/client/views/TrajectoryView.tsx')
  assert.match(view, /versionsCreated === 1\s*\?\s*t\(answer\.windowed \? 'trajSummaryVersionOneWindow' : 'trajSummaryVersionOne'\)/)
  assert.match(view, /checkpoints\.length === 1 \? t\('trajSummaryCheckpointOne'\)/)
})
