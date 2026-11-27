// On a phone the Sandboxes tab's Activity header squeezed its toggle to
// "Acti…" beside the long hint. In the phone layout the header wraps, so the
// hint takes its own line and the toggle keeps its word.
//   node --test test/sandbox-activity-head.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('the Activity header wraps in the phone map layout only', () => {
  const styles = readFileSync(new URL('../src/client/views/sandbox.module.css', import.meta.url), 'utf8')
  const at = styles.indexOf('@container sandbox-map (max-width: 620px)')
  assert.ok(at > 0)
  assert.match(styles.slice(at), /\.inspectorHead \{ flex-wrap: wrap; row-gap: 0; \}/)
  const base = styles.slice(0, at).match(/\.inspectorHead \{[^}]*\}/)
  assert.ok(base && !base[0].includes('flex-wrap'), 'the desktop header stays on one line')
})
