import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import test from 'node:test'
import { buildHome } from '../tools/perf-fixture.mjs'
import { pinned, liveSkipReason } from './routes-helper.mjs'
import { tmpRoot } from './support/env.mjs'

test('live: the tier S fixture counts history Commits from the pinned CLI', { skip: !pinned() && liveSkipReason() }, async (t) => {
  const dir = tmpRoot('dsh-tier-s-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // The tool resolves its own CLI from LFS_REAL_CLI or the runtime pin; give it the
  // unpinned CLI this suite selected, or it would run a wrapper that fixes LAYERFS_HOME.
  process.env.LFS_REAL_CLI = pinned().cli
  const manifest = await buildHome({ tier: 'S', dir, log: () => {} })
  // Each project's recipe writes 22 changes and makes two divergent merges.
  // Forks and publications return a commit ID too, but add no history Commit.
  assert.equal(manifest.commits, 48)
})
