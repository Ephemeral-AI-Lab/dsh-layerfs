// How the plugin words and tags a LayerFS call (src/host/layerfs/call-words.ts,
// docs/specs/layerfs-logs.md, LayerFS #659 §4–§5): rendering and redaction of a
// receipt's words, saved fields, receipt tags, and which calls keep an output.
//   node --test test/call-words.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = mkdtempSync(join(tmpdir(), 'dsh-call-words-'))
await build({ stdin: { contents: "export * from './src/host/layerfs/call-words.ts'; export * from './src/host/layerfs/tracing.ts'; export { execute } from './src/host/layerfs/cli.ts'; export { hasOutput, readOutput } from './src/host/layerfs/call-output.ts'; export * from './src/shared/logs.ts'", resolveDir: process.cwd(), loader: 'ts' }, outfile: join(root, 'words.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24' })
const L = await import(pathToFileURL(join(root, 'words.mjs')))
const id = '12' + 'a'.repeat(64), base = '32' + 'b'.repeat(64)

test('render: canonical order, front-end switches and `--` dropped, Bool flags bare', () => {
  assert.deepEqual(L.renderCall(['file', 'write', '--message', 'save it', '--mode', '420', '--', 'demo/app', 'main', 'src/a.ts'], 5321),
    ['file', 'write', 'demo/app', 'main', 'src/a.ts', '<5321 bytes>', '--message', '<7 bytes>', '--mode', '420'])
  assert.deepEqual(L.renderCall(['workspace', 'exec', '--events', '--exec-id', 'e1', '--', 'ws1', 'npm test']), ['workspace', 'exec', 'ws1', '<8 bytes>', '--exec-id', 'e1'])
  assert.deepEqual(L.renderCall(['workspace', 'exec', 'ws1', 'ls', '--stream']), ['workspace', 'exec', 'ws1', '<2 bytes>', '--stream'])
  assert.deepEqual(L.renderCall(['workspace', 'commit', '--force=true', '--json', '--', 'ws']), ['workspace', 'commit', 'ws', '--force'])
  assert.deepEqual(L.renderCall(['commit', 'diff', '--paths-only=false', '--', 'p', 'a', 'b']), ['commit', 'diff', 'p', 'a', 'b'])
  assert.deepEqual(L.renderCall(['workspace', 'exec_cancel', 'ws', 'e1', '--progress']), ['workspace', 'exec-cancel', 'ws', 'e1'])
  assert.deepEqual(L.renderCall(['file', 'rm', '-m', 'bye', 'p', 'b', '/x']), ['file', 'rm', 'p', 'b', '/x', '--message', '<3 bytes>'])
})
test('redaction: free text and credentials as byte counts, other values cut to 200 characters', () => {
  assert.deepEqual(L.renderCall(['file', 'edit', '--old', 'aé', '--new=b', '--', 'p', 'b', '/x']), ['file', 'edit', 'p', 'b', '/x', '--old', '<3 bytes>', '--new', '<1 bytes>'])
  assert.deepEqual(L.renderCall(['store', 'connect', '--password', 'env:PW', '--', 'pg', 'postgres://u:secret@h/db']), ['store', 'connect', 'pg', '<24 bytes>', '--password', '<6 bytes>'])
  assert.deepEqual(L.renderCall(['backup', 'connect', 'b', 's3://k@bucket', '--url', 'x']), ['backup', 'connect', 'b', '<13 bytes>', '--url', '<1 bytes>'])
  assert.deepEqual(L.renderCall(['backup', 'connect', '--key', 'env:R2_KEY', '--', 'b', 's3://bucket']), ['backup', 'connect', 'b', '<11 bytes>', '--key', '<10 bytes>'])
  // a text value starting with `--` is still a value: redacted names always, any option with the table's Bools known
  assert.deepEqual(L.renderCall(['file', 'edit', '--old', '--secret-flag', '--new', '--x', '--message', '--m', '--', 'p', 'b', '/x']),
    ['file', 'edit', 'p', 'b', '/x', '--old', '<13 bytes>', '--new', '<3 bytes>', '--message', '<3 bytes>'])
  assert.deepEqual(L.renderCall(['branch', 'diff', '--path-prefix', '--odd', '--paths-only', '--', 'p', 'a', 'b'], null, ['paths_only']),
    ['branch', 'diff', 'p', 'a', 'b', '--path-prefix', '--odd', '--paths-only'])
  const long = '😀'.repeat(250)
  const [, , , , path] = L.renderCall(['file', 'rm', 'p', 'b', long])
  assert.equal(Array.from(path).length, 201); assert.ok(path.endsWith('…'))
  const rendered = JSON.stringify(L.renderCall(['workspace', 'exec', '--', 'ws', 'echo file-content-secret'], Buffer.byteLength('stdin-secret')))
  assert.ok(!rendered.includes('secret'))
})
test('saved fields follow #659 §4.2 and only name 66-hex ids', () => {
  const at = (argv, result) => L.savedFields(argv, result)
  // 2.0: every saving call answers `commit` (66 hex), with `unchanged` when nothing was made; the kind is the receipt's display word
  assert.deepEqual(at(['workspace', 'commit', 'ws'], { commit: id }), { kind: 'Committed', commit: id })
  assert.deepEqual(at(['file', 'write', 'p', 'b', '/x'], { commit: base, unchanged: true }), { kind: 'UpToDate', commit: base })
  assert.deepEqual(at(['branch', 'fork', 'p', 'n'], { commit: id }), { kind: 'Forked', commit: id })
  assert.deepEqual(at(['branch', 'merge', 'p', 'n', 'a', 'b'], { commit: id, fast_forward: false }), { kind: 'Merged', commit: id })
  assert.deepEqual(at(['branch', 'publish', 'p', 'b'], { commit: base }), { kind: 'Added', layer: base })
  assert.deepEqual(at(['branch', 'publish', 'p', 'b'], { commit: base, unchanged: true }), { kind: 'UpToDate', layer: base })
  assert.deepEqual(at(['workspace', 'mount', 'p', 'b'], { workspace: 'p:w' }), {})
  assert.deepEqual(at(['workspace', 'commit', 'ws'], { commit: 'abc' }), {}, 'only a 66-hex id is named')
})
test('receipt ids keep tags within 128 bytes', () => {
  const a = L.makeReceipt('session-1', 'abcd1234', 'f'.repeat(32))
  assert.equal(a.id, `abcd1234.${'f'.repeat(32)}`); assert.equal(a.tag, `dsh:session-1:${a.id}`)
  assert.deepEqual(L.parseTag(a.tag), { sessionId: 'session-1', receiptId: a.id })
  const long = L.makeReceipt('s'.repeat(100), undefined, 'f'.repeat(32))
  assert.ok(Buffer.byteLength(long.tag) <= 128); assert.ok(long.id.length >= 8)
  assert.equal(L.makeReceipt('s'.repeat(130), undefined, 'f'.repeat(32)).tag, undefined)
})
test('execute() tags a call with its receipt and keeps its output under that tag', async () => {
  const dir = mkdtempSync(join(root, 'tags-')), outputs = join(dir, 'trace', 'outputs')
  const cli = join(dir, 'fake.mjs')
  writeFileSync(cli, `#!/usr/bin/env node\nlet input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{if(process.argv.includes('bad-usage')){process.exitCode=2;return}console.log(JSON.stringify({commit:'${id}',tag:process.env.LAYERFS_LOGS_TAG}))});`, { mode: 0o700 })
  const spec = { cli, home: join(dir, 'home'), outputs }
  const receipts = []
  const identity = { origin: 'tool', sessionId: 'sess', project: 'demo/app', turn: 1, toolCallId: 'call-1', workspace: 'sb:main', scope: L.toolScope('sess', 'call-1') }
  let answer
  await L.withTraceContext({ ...identity, record: async row => receipts.push(row) }, async () => {
    answer = await L.execute(spec, ['file', 'write', '--message', 'm', '--', 'demo/app', 'main', '/x'], { input: 'abc' })
    await assert.rejects(L.execute(spec, ['file', 'write', '--', 'demo/app', 'main', '/x', 'bad-usage'], { input: '' }))
  })
  const tag = L.sessionTag('sess', receipts[0].id)
  assert.equal(answer.tag, tag, 'the CLI got the receipt tag as LAYERFS_LOGS_TAG')
  assert.equal(receipts[0].tag, tag)
  assert.deepEqual(receipts[0].argv, ['file', 'write', 'demo/app', 'main', '/x', '<3 bytes>', '--message', '<1 bytes>'])
  assert.equal(receipts[0].kind, 'Committed')
  assert.ok(L.hasOutput(outputs, tag), 'its output is kept under the tag')
  assert.equal(JSON.parse(L.readOutput(outputs, tag).stdout).commit, id)
  // A usage error (exit 2) keeps no output; without `outputs` no host tag is made.
  assert.ok(!L.hasOutput(outputs, receipts[1]?.tag))
  const untagged = await L.execute({ cli, home: spec.home }, ['file', 'write', '--', 'demo/app', 'main', '/x'], { input: '' })
  assert.equal(untagged.tag, undefined)
})

test('loggable: table calls are logged (and keep an output); help, the logs family and the quiet calls are not', () => {
  for (const argv of [['machine', 'list'], ['sandbox', 'get', '--', 'sb'], ['machine', 'get', '--', 'vm'], ['file', 'read', '--', 'p/a', 'main', '/x'], ['workspace', 'exec-cancel', '--', 'sb:ws'], ['sandbox', 'list'], ['machine', 'images', '--', 'vm']]) {
    assert.equal(L.loggable(argv), true, argv.join(' '))
  }
  // not table calls
  for (const argv of [['--version', '--json'], ['help', '--json'], ['doctor'], []]) assert.equal(L.loggable(argv), false, argv.join(' '))
  // the logs family (#659): the call log's own reads, and the worker and daemon logs (layerfs-project#178)
  for (const argv of [['logs', 'list'], ['logs', 'reset'], ['logs', 'machine', '--', 'vm'], ['logs', 'sandbox', '--cursor', 'c', '--', 'sb']]) assert.equal(L.loggable(argv), false, argv.join(' '))
  // the files reads and the call log's own reader and clearer are quiet in LayerFS's log
  for (const argv of [['home', 'log'], ['home', 'clear-log'], ['machine', 'stats', '--', 'vm']]) assert.equal(L.loggable(argv), false, argv.join(' '))
  for (const argv of [['sandbox', 'files', '--', 'sb'], ['sandbox', 'files', '--depth', '1', '--', 'sb', '/home'], ['machine', 'files', '--', 'vm', '/etc']]) assert.equal(L.loggable(argv), false, argv.join(' '))
})
