// A preset's publish step: LayerFS's `previous` (main's head before, when it
// was not the Branch's base) is not a forced publication; only --force is.
//   node --test test/preset-publish-check.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertProjectStep } from '../src/host/presets/recipe/recipe.js'

const step = (argv) => ({ key: 'dense.001.integration.publish.1', argv, expect: { commit: true, notForced: true } })
const publish = ['branch', 'publish', 'demo-starter/bookshelf', 'integration']

test('a second publish from the same Branch (previous = its own earlier publication) passes', () => {
  assert.doesNotThrow(() => assertProjectStep(step(publish), { commit: 'c2', previous: 'c1' }))
  assert.doesNotThrow(() => assertProjectStep(step(publish), { commit: 'c1', previous: null }))
})

test('a forced publish, or one with no Commit, still fails', () => {
  assert.throws(() => assertProjectStep(step([...publish, '--force']), { commit: 'c2', previous: 'c1' }), /must not be forced/)
  assert.throws(() => assertProjectStep(step(publish), { commit: null }), /expected a Commit/)
  assert.throws(() => assertProjectStep(step(publish), { commit: 'c1', unchanged: true }), /expected a new Commit/)
})
