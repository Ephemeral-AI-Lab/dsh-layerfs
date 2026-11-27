// Stored-session discovery (sessions/store.ts) against a write that lands
// while a walk runs: a fresh lookup (open, sync, recovery) never answers from a
// walk that started before the save, and an invalidation that fires mid-walk
// is not overwritten by that walk's timestamp.
//   node --test test/discover-fresh.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-discover-fresh-'))
await build({
  absWorkingDir: root,
  stdin: { contents: "export { SessionStore } from './src/host/sessions/store.ts'\n", resolveDir: root, loader: 'ts' },
  outfile: join(out, 'store.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24', external: ['@deepseek-ai/*'], logLevel: 'warning',
})
const S = await import(pathToFileURL(join(out, 'store.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
function gate() {
  let open
  const waiting = new Promise((resolve) => { open = resolve })
  return { waiting, open }
}

/** A SessionStore over a fake Store whose manifest reads can be held per Branch. */
function harness(heads) {
  const held = new Map()
  const manifest = (branch) => ({ version: 3, kind: 'dsh-session', sessionId: branch.slice('dsh.session.'.length), projectId: 'p', title: branch, count: 3, checkpoints: [], updatedAt: 1, bindingKind: 'project', header: { version: 4 } })
  const lfs = {
    branch: {
      list: async (_project, options = {}) => {
        const items = [{ branch: 'main', commit: 'm' }, ...Object.entries(heads).map(([branch, commit]) => ({ branch, commit }))]
        return { items: items.filter((b) => !options.prefix || b.branch.startsWith(options.prefix)) }
      },
    },
    file: {
      read: async (_project, branch) => {
        await held.get(branch)?.waiting
        const text = `${JSON.stringify(manifest(branch))}\n`
        return { text, next_line: null, line_truncated: false, binary: false, size: Buffer.byteLength(text), start_line: 1, end_line: 1 }
      },
    },
  }
  const ctx = new Context()
  ctx.provide('layerfs', { root: '/lfs-root', lfs, emit: () => {} })
  const sessions = {
    binding: () => undefined, lane: (_key, run) => run(), checkpoints: () => [], attach: async () => {},
    state: { read: () => ({ projects: {}, sessions: {}, pending: {}, checkpoints: {}, mirror: {} }), update: () => {} },
  }
  return { store: new S.SessionStore(ctx, sessions), held }
}

test('a fresh lookup never joins a walk that started before a save', async () => {
  const heads = { 'dsh.session.a': 'c1' }
  const h = harness(heads)
  const pending = gate()
  h.held.set('dsh.session.a', pending)
  // a listing starts a walk behind it, seeded with the Branch list it read (only a)
  assert.deepEqual(await h.store.discover('s/p', { identity: 'pid', local: () => false }), [])
  // a save lands while that walk runs: a new stored session, and the write invalidates
  heads['dsh.session.b'] = 'c2'
  h.store.invalidateDiscovery('s/p')
  const lookup = h.store.discover('s/p', { fresh: true })
  pending.open()
  assert.deepEqual((await lookup).map((row) => row.sessionId).sort(), ['a', 'b'], 'the lookup finds the session saved after the walk began')
})

test('an invalidation during a walk wins over the walk\'s timestamp', async () => {
  const heads = { 'dsh.session.a': 'c1', 'dsh.session.b': 'c2' }
  const h = harness(heads)
  const local = { a: false }
  const list = () => h.store.discover('s/p', { identity: 'pid', local: (id) => local[id] ?? false })
  const pending = gate()
  // a's row (and its local flag) is built, then the walk waits on b's manifest
  h.held.set('dsh.session.b', pending)
  assert.deepEqual(await list(), [])
  await tick()
  // a's log arrives locally (an import) and the write invalidates, mid-walk
  local.a = true
  h.store.invalidateDiscovery('s/p')
  pending.open()
  for (let i = 0; i < 50 && h.store.discovering.has('s/p'); i++) await tick()
  // the next listing may still paint the walk's rows, but it must walk again behind them
  await list()
  for (let i = 0; i < 50 && h.store.discovering.has('s/p'); i++) await tick()
  const rows = await list()
  assert.equal(rows.find((row) => row.sessionId === 'a')?.local, true, 'the local flag the invalidation announced, not the pre-invalidation one for DISCOVERY_MS')
})

test('a fresh lookup does not join a listing\'s walk behind even without a local write (another process saved)', async () => {
  const heads = { 'dsh.session.a': 'c1' }
  const h = harness(heads)
  const pending = gate()
  h.held.set('dsh.session.a', pending)
  assert.deepEqual(await h.store.discover('s/p', { identity: 'pid', local: () => false }), [])
  heads['dsh.session.b'] = 'c2'
  const lookup = h.store.discover('s/p', { fresh: true })
  // a second lookup right behind it shares the fresh walk
  const again = h.store.discover('s/p', { fresh: true })
  assert.equal(lookup, again, 'concurrent fresh lookups of one epoch share one walk')
  pending.open()
  assert.deepEqual((await lookup).map((row) => row.sessionId).sort(), ['a', 'b'])
})
