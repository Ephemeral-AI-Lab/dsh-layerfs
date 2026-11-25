// The row adapter's miss handling, without a DOM: one report per session (a
// matched row gets the mark; a mismatch is reported and left visible), and the
// 30 s probe only queries while the document is visible, once per project id.
//   node --test test/session-row-adapter.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-session-row-adapter-'))
await build({
  absWorkingDir: root,
  stdin: {
    contents: [
      "export { AdapterMissLog, RowProbe, applyRowOwnership, markRow, probeProjectRows, sessionRowKey, sessionRowSelector, PROJECT_OWNED_ATTR, adapterMisses, PROBE_INTERVAL_MS } from './src/client/session/adapters.ts'",
    ].join('\n'),
    resolveDir: root, loader: 'tsx',
  },
  outfile: join(out, 'adapter.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24', logLevel: 'error',
  jsx: 'automatic', loader: { '.module.css': 'local-css', '.css': 'css' },
})
const M = await import(pathToFileURL(join(out, 'adapter.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

/** The smallest row the adapter sees: DSH's key plus whatever attributes a test set. */
function row(key, attrs = {}) {
  const values = new Map(Object.entries(attrs))
  values.set('data-row-key', key)
  return {
    getAttribute(name) { return values.has(name) ? values.get(name) : null },
    setAttribute(name, value) { values.set(name, String(value)) },
    removeAttribute(name) { values.delete(name) },
  }
}

test('the collector warns once per session and dedupes later reports', () => {
  const warned = []
  const log = new M.AdapterMissLog((message) => warned.push(message), () => 123)
  const wrong = row('session:other')

  assert.equal(M.applyRowOwnership('project', 'a', wrong, log), 'miss')
  assert.equal(M.applyRowOwnership('project', 'a', null, log), 'miss')
  assert.equal(M.applyRowOwnership('project', 'a', row('session:b'), log), 'miss')

  assert.equal(log.misses.length, 1, 'one miss per session id')
  assert.equal(warned.length, 1, 'one warning per session id')
  assert.equal(log.misses[0].sessionId, 'a')
  assert.equal(log.misses[0].reason, 'row-key')
  assert.equal(log.misses[0].at, 123)
  assert.match(warned[0], /session:a/)
  assert.equal(log.report('a', 'seat-gone', 'again'), false, 'a later reason is still deduped')
  assert.equal(log.has('a'), true)
})

test('a matched row gets the mark; a mismatch is reported and stays unmarked (visible)', () => {
  const log = new M.AdapterMissLog(() => {})
  const good = row('session:a')
  const wrong = row('session:b')

  assert.equal(M.applyRowOwnership('project', 'a', good, log), 'marked')
  assert.equal(good.getAttribute(M.PROJECT_OWNED_ATTR), 'a')
  assert.equal(M.applyRowOwnership('project', 'a', wrong, log), 'miss')
  assert.equal(wrong.getAttribute(M.PROJECT_OWNED_ATTR), null, 'the wrong row is not hidden')
  assert.equal(log.misses.length, 1)

  // notProject clears our own mark, never a mark another session owns.
  assert.equal(M.applyRowOwnership('notProject', 'a', good, log), 'cleared')
  assert.equal(good.getAttribute(M.PROJECT_OWNED_ATTR), null)
  const other = row('session:c', { [M.PROJECT_OWNED_ATTR]: 'c' })
  M.markRow(other, 'c')
  assert.equal(M.applyRowOwnership('notProject', 'a', other, log), 'cleared')
  assert.equal(other.getAttribute(M.PROJECT_OWNED_ATTR), 'c')

  // unknown leaves the last decision alone.
  const kept = row('session:d', { [M.PROJECT_OWNED_ATTR]: 'd' })
  assert.equal(M.applyRowOwnership('unknown', 'd', kept, log), 'ignored')
  assert.equal(kept.getAttribute(M.PROJECT_OWNED_ATTR), 'd')
})

test('the probe reports a present-but-unmarked row once, leaves it visible, and asks once per id', () => {
  const warned = []
  const log = new M.AdapterMissLog((message) => warned.push(message))
  const unmarked = row('session:a')
  const marked = row('session:b', { [M.PROJECT_OWNED_ATTR]: 'b' })
  const rows = new Map([
    [M.sessionRowSelector('a'), unmarked],
    [M.sessionRowSelector('b'), marked],
  ])
  let asked = 0
  const doc = {
    hidden: false,
    querySelector(selector) { asked += 1; return rows.get(selector) ?? null },
  }
  const probe = new M.RowProbe({ projectIds: () => ['a', 'b'] }, log, doc, 30_000)

  assert.equal(probe.check(), 2, 'one question per known project session')
  assert.equal(asked, 2)
  assert.equal(log.misses.length, 1)
  assert.equal(log.misses[0].sessionId, 'a')
  assert.equal(log.misses[0].reason, 'seat-gone')
  assert.equal(unmarked.getAttribute(M.PROJECT_OWNED_ATTR), null, 'fail-open: the row stays visible')

  assert.equal(probe.check(), 2)
  assert.equal(asked, 4)
  assert.equal(log.misses.length, 1, 'the next interval does not report it again')
  assert.equal(warned.length, 1)

  // No project is still known: no query at all.
  const empty = new M.RowProbe({ projectIds: () => [] }, log, doc)
  assert.equal(empty.check(), 0)
  assert.equal(asked, 4)
})

test('the probe does not run (or query) while the document is hidden', () => {
  const log = new M.AdapterMissLog(() => {})
  let projectReads = 0
  let queries = 0
  const probe = new M.RowProbe(
    { projectIds: () => { projectReads += 1; return ['a'] } },
    log,
    { hidden: true, querySelector() { queries += 1; throw new Error('must not query a hidden document') } },
    30_000,
  )
  assert.equal(probe.check(), 0)
  assert.equal(projectReads, 0, 'the hidden check does not even read the store')
  assert.equal(queries, 0)
  assert.equal(M.probeProjectRows({ hidden: true, querySelector() { queries += 1; return null } }, ['a'], log), 0)
  assert.equal(queries, 0)
})

test('the module collector is the default the adapter reports through', () => {
  M.adapterMisses.clear()
  const warn = console.warn
  console.warn = () => {}
  try {
    assert.equal(M.applyRowOwnership('project', 'module-a', row('session:other')), 'miss')
    assert.equal(M.adapterMisses.misses.length, 1, 'the module log is the default')
    assert.equal(M.adapterMisses.misses[0].sessionId, 'module-a')
  } finally {
    console.warn = warn
    M.adapterMisses.clear()
  }
  const log = new M.AdapterMissLog(() => {})
  assert.equal(M.applyRowOwnership('project', 'module-b', row('session:other'), log), 'miss')
  assert.equal(log.misses.length, 1, 'a supplied collector is used instead')
  assert.equal(M.adapterMisses.misses.length, 0)
})

test('the group-header rule is direct-child and all-owned only (never group-name text)', () => {
  const css = readFileSync(join(root, 'src/client/session/session.module.css'), 'utf8')
  assert.match(css, /div:has\(> \[role='treeitem'\]\[data-row-key='workspace:'\]\)/)
  assert.match(css, /:has\(> \[role='treeitem'\]\[data-row-key\^='session:'\]\)/)
  assert.match(css, /:not\(:has\(> \[role='group'\] \[role='treeitem'\]\)\)/)
  assert.match(css, /:not\(\[data-layerfs-project-owned\]\)/)
  assert.match(css, /display: none;/)
})
