// Self-sufficient receipts (docs/specs/layerfs-logs.md §4, §5a): both writers
// fill `at`, `ms`, redacted portable `argv`, `tag`, outcome code, kind, exec id
// and exit; a store import merges receipts by id; `logs.list` renders an
// imported session's receipts when this machine's log has no line for them.
//   node --test test/receipt-logs.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = mkdtempSync(join(tmpdir(), 'dsh-receipt-logs-'))
await build({
  stdin: { contents: "export * from './src/host/layerfs/call-output.ts'; export * from './src/host/layerfs/call-words.ts'; export * from './src/host/layerfs/tracing.ts'; export { execute } from './src/host/layerfs/cli.ts'; export * from './src/shared/logs.ts'; export { apply as applyLogs, receiptLine, sessionOfTag } from './src/host/logs/index.ts'", resolveDir: process.cwd(), loader: 'ts' },
  outfile: join(root, 'out.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24', external: ['@deepseek-ai/*'],
})
const L = await import(pathToFileURL(join(root, 'out.mjs')))
const id = '12' + 'a'.repeat(64)
let n = 0
const place = () => {
  const dir = mkdtempSync(join(root, `case${n++}-`))
  return { dir, outputs: join(dir, 'trace', 'outputs') }
}
function fakeCli(dir) {
  const cli = join(dir, 'fake.mjs')
  writeFileSync(cli, `#!/usr/bin/env node
const argv = process.argv.slice(2)
let input = ''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => {
  if (argv.includes('fail')) { process.stderr.write(JSON.stringify({ error: 'Conflict', message: 'moved' }) + '\\n'); process.exitCode = 125; return }
  // 2.0: workspace exec prints its one result JSON and exits with the command's own code
  if (argv[0] === 'workspace' && argv[1] === 'exec') { console.log(JSON.stringify({ exit_code: 3, stdout: 'hi\\n', stderr: '', exec: 'exec-7', tag: process.env.LAYERFS_LOGS_TAG })); process.exitCode = 3; return }
  console.log(JSON.stringify({ commit: '${id}', tag: process.env.LAYERFS_LOGS_TAG }))
})
`, { mode: 0o700 })
  return cli
}
function run(command, argv, env, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { env: { ...process.env, ...env }, stdio: 'pipe' })
    let stdout = ''
    child.stdout.on('data', d => { stdout += d }); child.stderr.on('data', () => {})
    child.on('error', reject); child.on('close', code => resolve({ stdout, code })); child.stdin.end(input)
  })
}

test('SDK receipts carry time, duration, redacted portable argv, tag, outcome code, kind, exec id and exit', async () => {
  const { dir, outputs } = place(), cli = fakeCli(dir)
  const spec = { cli, home: join(dir, 'home'), outputs }
  const receipts = []
  const before = Date.now()
  await L.withTraceContext({ origin: 'tool', sessionId: 's', project: 'demo/app', turn: 1, toolCallId: 'c1', scope: L.toolScope('s', 'c1'), record: async row => receipts.push(row) }, async () => {
    await L.execute(spec, ['file', 'write', '--message', 'secret words', '--from', join(homedir(), 'notes.txt'), '--', 'demo/app', 'main', '/x'])
    assert.equal((await L.execute(spec, ['workspace', 'exec', '--detail', '--', 'sb:main', 'echo hi'])).exit_code, 3, 'a command\'s own exit is its answer, not a failure')
    await assert.rejects(L.execute(spec, ['file', 'write', '--', 'demo/app', 'main', '/x', 'fail'], { input: 'abc' }))
  })
  const [write, exec, refused] = receipts
  assert.ok(write.at >= before && write.at <= Date.now()); assert.ok(Number.isInteger(write.ms) && write.ms >= 0)
  assert.deepEqual(write.argv, ['file', 'write', 'demo/app', 'main', '/x', '--message', '<12 bytes>', '--from', '<local path>'])
  assert.ok(!JSON.stringify(receipts).includes(homedir()), 'no machine-local path in a receipt')
  assert.equal(write.kind, 'Committed'); assert.equal(write.code, undefined)
  assert.equal(write.tag, L.sessionTag('s', write.id), 'the receipt names its line by tag')
  assert.ok(L.hasOutput(outputs, write.tag), 'its output is kept under that tag')
  assert.equal(exec.execId, 'exec-7', 'LayerFS\'s exec id from the answer'); assert.equal(exec.exit, 3); assert.deepEqual(exec.argv, ['workspace', 'exec', 'sb:main', '<7 bytes>', '--detail'])
  assert.equal(refused.outcome, 'refusal'); assert.equal(refused.code, 'Conflict'); assert.equal(refused.kind, undefined)
  assert.equal(refused.argv.at(-1), '<3 bytes>')
  // The receipt renders as the line it stands for.
  const rendered = L.receiptLine(write)
  assert.deepEqual(rendered, { v: 1, at: write.at, ms: write.ms, client: 'cli', argv: write.argv, outcome: 'ok', kind: 'Committed', commit: id, tag: write.tag }, 'at, ms, outcome, kind, version and tag')
  assert.equal(L.receiptLine(refused).outcome, 'Conflict')
  assert.equal(L.receiptLine({ id: 'old', sessionId: 's', operation: 'file.write', outcome: 'success', versions: [] }), undefined, 'older receipts without time give no line')
})

test('receipts from wrapper calls\' log lines carry the same fields; exit comes from the stored output', async () => {
  const { dir, outputs } = place(), cli = fakeCli(dir)
  const command = L.managedCli({ root: dir, cli, home: join(dir, 'home'), outputs })
  const identity = { origin: 'tool', sessionId: 's', project: 'demo/app', turn: 2, toolCallId: 'bash-1', scope: L.toolScope('s', 'bash-1') }
  const env = { DSH_LAYERFS_TRACE_CONTEXT: L.traceEnvironment(identity) }
  const execTag = JSON.parse((await run(command, ['workspace', 'exec', 'sb:main', 'echo hi'], env)).stdout).tag
  const initTag = JSON.parse((await run(command, ['project', 'init', 'demo/app', join(tmpdir(), 'src-folder')], env)).stdout).tag
  await new Promise(resolve => setTimeout(resolve, 100)) // the tee processes finish after the CLI
  // The lines LayerFS logged for them (`home log --detail` as lineOfItem reads it).
  const exec = { v: 1, at: 1000, ms: 7, client: 'cli', argv: ['workspace', 'exec', 'sb:main', '<7 bytes>'], outcome: 'ok', tag: execTag }
  const init = { v: 1, at: 2000, ms: 9, client: 'cli', argv: ['project', 'init', 'demo/app', join(tmpdir(), 'src-folder')], outcome: 'ok', tag: initTag }
  const execReceipt = L.receiptFromLine(exec, identity, L.parseTag(exec.tag).receiptId, L.exitOfOutput(L.readOutput(outputs, exec.tag)))
  assert.equal(execReceipt.at, exec.at); assert.equal(execReceipt.ms, exec.ms); assert.equal(execReceipt.tag, exec.tag)
  // a log line names no exec id (only the answer does); the exit comes from the stored result
  assert.equal(execReceipt.execId, undefined); assert.equal(execReceipt.exit, 3)
  assert.equal(execReceipt.turn, 2)
  const initReceipt = L.receiptFromLine(init, identity, L.parseTag(init.tag).receiptId)
  assert.deepEqual(initReceipt.argv, ['project', 'init', 'demo/app', '<local path>'], 'a project source folder is local')
  assert.equal(initReceipt.execId, undefined); assert.equal(initReceipt.exit, undefined)
})

test('receipt argv stays bounded', () => {
  const long = ['file', 'write', ...Array.from({ length: 40 }, (_, i) => `word-${i}-${'x'.repeat(60)}`)]
  const argv = L.portableArgv(long)
  assert.equal(argv.length, L.RECEIPT_ARGV_WORDS + 1); assert.equal(argv.at(-1), '<10 more>')
  assert.ok(argv.slice(2, -1).every(w => Array.from(w).length <= 41))
  assert.ok(Buffer.byteLength(JSON.stringify(argv)) < 2000)
  assert.deepEqual(L.portableArgv(['file', 'read', 'demo/app', 'main', '/src/a.ts']), ['file', 'read', 'demo/app', 'main', '/src/a.ts'], 'project paths stay')
})

test('store import merges receipts by id', () => {
  const local = [{ id: 'a', operation: 'file.write', at: 1 }, { id: 'b', operation: 'file.read' }]
  const incoming = [{ id: 'b', operation: 'file.read', at: 5, argv: ['file', 'read'] }, { id: 'c', operation: 'workspace.exec', at: 9 }, null, { nope: 1 }]
  assert.deepEqual(L.mergeInvocations(local, incoming), [
    { id: 'a', operation: 'file.write', at: 1 },
    { id: 'b', operation: 'file.read', at: 5, argv: ['file', 'read'] },
    { id: 'c', operation: 'workspace.exec', at: 9, imported: true },
  ])
  assert.deepEqual(L.mergeInvocations(undefined, [{ id: 'x' }]), [{ id: 'x', imported: true }])
  assert.deepEqual(L.mergeInvocations([{ id: 'x' }], undefined), [{ id: 'x' }])
})

/** LayerFS's call log as `home log --detail` answers it: `log.push(line)` logs a line; a read is newest logged first. */
function nativeLog() {
  const lines = []
  const item = (l) => ({ logged_at: new Date(l.at).toISOString(), duration_ms: l.ms, client: l.client, argv: l.argv, outcome: l.outcome, ...(l.tag ? { tag: l.tag } : {}) })
  return { push: (line) => lines.push(line), lfs: { home: { log: async () => ({ items: [...lines].reverse().map(item) }) } } }
}
/** A logs ctx over a fake LayerFS call log and fake sidecars / session state. */
function logsCtx(log, outputs, sidecars, sessions = {}) {
  let ops
  const services = {
    sessionPersistence: { readSidecar: async (sid) => sidecars[sid] },
    layerfsSessions: { checkpoints: () => [], state: { read: () => ({ sessions, checkpoints: {} }) } },
  }
  L.applyLogs({ effect() {}, get: (name) => services[name], layerfs: { outputs, lfs: log.lfs, discovery: async () => ({ calls: [] }), emit() {} }, layerfsRemote: { operate(_ctx, table) { ops = table } } })
  return ops
}

test('logs.list falls back to an imported session\'s receipts, pages them and skips ones this log holds', async () => {
  const { outputs } = place(), log = nativeLog()
  const receipt = (rid, at, extra = {}) => ({ id: rid, origin: 'tool', sessionId: 'imp', project: 'demo/app', turn: 1, toolCallId: `t-${rid}`, operation: 'file.write', outcome: 'success',
    versions: [{ kind: 'Commit', id, effect: 'created' }], at, ms: 4, argv: ['file', 'write', 'demo/app', 'main', '/x', '<3 bytes>'], tag: `dsh:imp:${rid}`, kind: 'Committed', imported: true, ...extra })
  const sidecars = {
    imp: { title: 'Imported', invocations: [receipt('r1', 1000), receipt('r2', 2000), receipt('r3', 3000, { operation: 'file.read', argv: ['file', 'read', 'demo/app', 'main', '/x'], versions: [], kind: undefined })] },
    own: { invocations: [{ ...receipt('o1', 1000), sessionId: 'own', tag: 'dsh:own:o1', imported: undefined }] },
  }
  const ops = logsCtx(log, outputs, sidecars)
  let page = await ops['logs.list']({ tag: 'dsh:imp:' })
  assert.deepEqual(page.lines.map(l => l.tag), ['dsh:imp:r3', 'dsh:imp:r2', 'dsh:imp:r1'])
  assert.ok(page.lines.every(l => l.source === 'receipt' && l.client === 'cli' && !l.output))
  assert.equal(page.lines[2].commit, id); assert.equal(page.lines[2].dsh.toolCallId, 't-r1');
  assert.equal(page.lines[2].dsh.title, 'Imported')
  assert.equal((await ops['logs.list']({ tag: 'dsh:imp:', writes: true })).lines.length, 2, 'filters apply to receipt lines')
  assert.deepEqual((await ops['logs.list']({ tag: 'dsh:imp:r2' })).lines.map(l => l.tag), ['dsh:imp:r2'])
  // Paging continues through a receipt cursor.
  page = await ops['logs.list']({ tag: 'dsh:imp:', limit: 2 })
  assert.equal(page.lines.length, 2); assert.equal(page.has_more, true); assert.equal(page.next, 'receipt:2')
  page = await ops['logs.list']({ tag: 'dsh:imp:', limit: 2, cursor: page.next })
  assert.deepEqual(page.lines.map(l => l.tag), ['dsh:imp:r1']); assert.equal(page.has_more, false)
  await assert.rejects(ops['logs.list']({ cursor: 'receipt:0' }), e => e.code === 'InvalidInput')
  // This machine's lines come first; a receipt whose line is here is not repeated.
  log.push({ v: 1, at: 5000, ms: 1, client: 'cli', argv: ['file', 'write', 'demo/app', 'main', '/y'], outcome: 'ok', tag: 'dsh:imp:local' })
  log.push({ v: 1, at: 3000, ms: 1, client: 'cli', argv: ['file', 'read', 'demo/app', 'main', '/x'], outcome: 'ok', tag: 'dsh:imp:r3' })
  page = await ops['logs.list']({ tag: 'dsh:imp:' })
  assert.deepEqual(page.lines.map(l => [l.tag, l.source ?? 'log']), [['dsh:imp:r3', 'log'], ['dsh:imp:local', 'log'], ['dsh:imp:r2', 'receipt'], ['dsh:imp:r1', 'receipt']])
  // Receipts recorded on this machine are never shown in place of a reset log.
  assert.equal((await ops['logs.list']({ tag: 'dsh:own:' })).lines.length, 0)
  // Without a session tag there is no fallback.
  assert.ok((await ops['logs.list']({})).lines.every(l => !l.source))
  assert.equal(L.sessionOfTag('dsh:-:'), undefined); assert.equal(L.sessionOfTag('dsh:imp:'), 'imp'); assert.equal(L.sessionOfTag('dsh:imp:r1'), 'imp')
})
