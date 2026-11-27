// A Trajectory page the host trimmed to its byte budget (`elided`, see
// src/host/sessions/trace.ts fitPage) says so under the table, in en and zh.
//   node --test test/trajectory-elided.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

test('the Trajectory view shows a note when the page is elided', () => {
  const view = src('src/client/views/TrajectoryView.tsx')
  assert.match(view, /\{answer\.elided \? <div className=\{css\.more\}><span className=\{css\.note\} data-traj-elided>\{t\('trajElided'\)\}<\/span><\/div> : null\}/)
  const locale = src('src/client/views/locale.ts')
  assert.equal((locale.match(/^\s+trajElided: '/gm) ?? []).length, 2, 'en and zh')
})
