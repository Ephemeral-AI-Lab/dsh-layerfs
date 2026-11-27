// The Trajectory kind pills sit in an 84px column (--traj-kind, as DSH's own
// Trajectory): an English label longer than CHECKPOINT is cut (OBSERVATION was).
//   node --test test/trajectory-kind-labels.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('no English kind label is longer than CHECKPOINT', () => {
  const locale = readFileSync(new URL('../src/client/views/locale.ts', import.meta.url), 'utf8')
  const en = locale.slice(0, locale.indexOf('const zh'))
  const labels = [...en.matchAll(/^\s+trajKind_(\w+): '([^']*)'/gm)].map((m) => [m[1], m[2]])
  assert.ok(labels.length >= 9)
  for (const [kind, label] of labels) assert.ok(label.length <= 'CHECKPOINT'.length, `${kind}: ${label}`)
  assert.match(readFileSync(new URL('../src/client/views/trajectory.module.css', import.meta.url), 'utf8'), /--traj-kind: 84px;/)
})
