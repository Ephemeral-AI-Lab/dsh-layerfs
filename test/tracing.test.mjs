// Invocation receipts: SDK calls record their own receipt; agent shells' managed
// CLI tags each call, LayerFS writes its call log line, and the host builds the
// receipt from that line (docs/specs/layerfs-logs.md §4).
//   node --test test/tracing.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, linkSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
const root = mkdtempSync(join(tmpdir(), 'dsh-tracing-'))
await build({ stdin: { contents: "export * from './src/host/layerfs/tracing.ts'; export { execute } from './src/host/layerfs/cli.ts'; export { readOutput, hasOutput, compactRaw } from './src/host/layerfs/call-output.ts'; export { parseTag, sessionTag } from './src/shared/logs.ts'", resolveDir: process.cwd(), loader: 'ts' }, outfile: join(root, 'trace.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24' })
const { readOutput, hasOutput, compactRaw, execute, savedVersions, lineVersions, fastForwardOfOutput, exitOfOutput, receiptFromLine, withTraceContext, traceInvocation, managedCli, traceEnvironment, toolScope, parseTag, sessionTag } = await import(pathToFileURL(join(root, 'trace.mjs')))
const id = '12' + 'a'.repeat(64), base = '32' + 'b'.repeat(64)
const RECEIPT_KEYS = ['id', 'origin', 'sessionId', 'project', 'turn', 'toolCallId', 'operation', 'outcome', 'versions', 'captureGap', 'at', 'ms', 'argv', 'tag', 'code', 'kind', 'execId', 'exit', 'step']

test('2.0 publication and merge answers link their saved Commit: commit, unchanged, fast_forward', () => {
  // `branch publish` answers main's new Commit (kept as a Layer link); `unchanged` when main already had it
  assert.deepEqual(savedVersions('branch.publish', { commit: base }), [{ kind: 'Layer', id: base, effect: 'created' }])
  assert.deepEqual(savedVersions('branch.publish', { commit: base, unchanged: true }), [{ kind: 'Layer', id: base, effect: 'unchanged' }])
  assert.deepEqual(savedVersions('branch.merge', { commit: id, fast_forward: false }), [{ kind: 'Commit', id, effect: 'created' }])
  assert.deepEqual(savedVersions('branch.merge', { commit: id, fast_forward: true }), [{ kind: 'Commit', id, effect: 'referenced' }])
})
test('eligible 2.0 answers preserve Commit, no-op and reference effects; other shapes link nothing', () => {
  assert.deepEqual(savedVersions('file.apply', { commit: id }), [{ kind: 'Commit', id, effect: 'created' }])
  assert.deepEqual(savedVersions('workspace.commit', { commit: id, unchanged: true }), [{ kind: 'Commit', id, effect: 'unchanged' }])
  assert.deepEqual(savedVersions('branch.fork', { commit: base }), [{ kind: 'Commit', id: base, effect: 'referenced' }])
  for (const op of ['workspace.exec', 'file.read', 'file.unknown', 'project.init']) assert.deepEqual(savedVersions(op, { commit: id }), [])
  assert.deepEqual(savedVersions('file.apply', { commit: 'a'.repeat(64) }), []) // raw content digests are not typed version IDs
  assert.deepEqual(savedVersions('workspace.commit', { kind: 'Committed', head: id }), [], 'a pre-2.0 answer links nothing')
  assert.deepEqual(savedVersions('workspace.commit', { root: id }), []) // a root hash is not a Commit
})
test('call log lines map to versions: created, unchanged, referenced; Merged by its stored fast_forward', () => {
  const line = (argv, kind, extra = {}) => ({ argv, kind, ...extra })
  assert.deepEqual(lineVersions(line(['workspace', 'commit', 'ws'], 'Committed', { commit: id })), [{ kind: 'Commit', id, effect: 'created' }])
  assert.deepEqual(lineVersions(line(['branch', 'publish', 'p', 'b'], 'Added', { layer: base })), [{ kind: 'Layer', id: base, effect: 'created' }])
  assert.deepEqual(lineVersions(line(['file', 'write', 'p', 'b', '/x'], 'UpToDate', { commit: id })), [{ kind: 'Commit', id, effect: 'unchanged' }])
  assert.deepEqual(lineVersions(line(['branch', 'publish', 'p', 'b'], 'NoChanges', { layer: base })), [{ kind: 'Layer', id: base, effect: 'unchanged' }])
  assert.deepEqual(lineVersions(line(['branch', 'fork', 'p', 'n', 'main'], 'Forked', { layer: base })), [{ kind: 'Layer', id: base, effect: 'referenced' }])
  assert.deepEqual(lineVersions(line(['branch', 'merge', 'p', 'n', 'a', 'b'], 'Merged', { commit: id })), [{ kind: 'Commit', id, effect: 'referenced' }])
  // the stored answer's fast_forward decides: a real merge Commit is created, a moved pointer referenced
  assert.deepEqual(lineVersions(line(['branch', 'merge', 'p', 'n', 'a', 'b'], 'Merged', { commit: id }), false), [{ kind: 'Commit', id, effect: 'created' }])
  assert.deepEqual(lineVersions(line(['branch', 'merge', 'p', 'n', 'a', 'b'], 'Merged', { commit: id }), true), [{ kind: 'Commit', id, effect: 'referenced' }])
  assert.deepEqual(lineVersions(line(['branch', 'fork', 'p', 'n', 'main'], 'Forked', { layer: base }), false), [{ kind: 'Layer', id: base, effect: 'referenced' }])
  assert.deepEqual(lineVersions(line(['file', 'read', 'p', 'b', '/x'], 'Committed', { commit: id })), [])
  assert.deepEqual(lineVersions(line(['workspace', 'commit', 'ws'], 'Committed', { commit: 'short' })), [])
  assert.deepEqual(lineVersions(line(['workspace', 'commit', 'ws'], 'Mounted', { commit: id })), [])
})
test('a merge receipt rebuilt from its line reads fast_forward from the stored answer', () => {
  const out = (stdout, truncated) => ({ tag: 't', stdout, bytes: { stdout: stdout.length, stderr: 0 }, ...(truncated ? { truncated: { stdout: true } } : {}) })
  const answer = (ff) => JSON.stringify({ kind: 'Merged', fast_forward: ff, branch: 'm', head: id, root: base, lww: [] })
  assert.equal(fastForwardOfOutput(out(answer(false))), false)
  assert.equal(fastForwardOfOutput(out(answer(true))), true)
  assert.equal(fastForwardOfOutput(out(answer(false).slice(0, 80), true)), false) // cut answer: the top-level field is in its head
  assert.equal(fastForwardOfOutput(out('{"kind":"Merged","lww":[{"fast_forward":false', true)), undefined) // never a nested value
  assert.equal(fastForwardOfOutput(out('Merged m (3 files)\n')), undefined) // --text
  assert.equal(fastForwardOfOutput({ missing: true }), undefined)
  assert.equal(fastForwardOfOutput(undefined), undefined)
  const line = { v: 1, at: 1, ms: 2, client: 'cli', argv: ['branch', 'merge', 'p/q', 'm', 'a', 'b'], outcome: 'ok', kind: 'Merged', commit: id, tag: 'dsh:s:x.1' }
  const identity = { origin: 'tool', sessionId: 's', project: 'p/q', toolCallId: 'call_7' }
  assert.deepEqual(receiptFromLine(line, identity, 'x.1', undefined, false).versions, [{ kind: 'Commit', id, effect: 'created' }])
  assert.deepEqual(receiptFromLine(line, identity, 'x.1').versions, [{ kind: 'Commit', id, effect: 'referenced' }])
})
test('an exec exit code comes from the 2.0 result JSON, or from a --stream call\'s own exit', () => {
  const out = (stdout, exit) => ({ tag: 't', stdout, exit, bytes: { stdout: stdout.length, stderr: 0 } })
  assert.equal(exitOfOutput(out('{"exit_code":3,"stdout":"hi\\n","exec":"exec-1"}\n', 3)), 3)
  assert.equal(exitOfOutput(out('{"exit_code":3}', 7)), 3, 'the result wins')
  assert.equal(exitOfOutput(out('raw output\n', 2)), undefined, 'no result: the process exit alone is not trusted')
  assert.equal(exitOfOutput(out('raw output\n', 2), true), 2)
  assert.equal(exitOfOutput(out('', 0), true), 0)
  assert.equal(exitOfOutput({ ...out('', 125), refusal: { code: 'Busy' } }, true), undefined, '125 with a refusal: LayerFS refused, not the command')
  assert.equal(exitOfOutput(out('raw\n', 125), true), 125, '125 and no refusal: the command\'s own')
  assert.equal(exitOfOutput(out('{"exit_code":125}', 125)), 125)
  assert.equal(exitOfOutput({ missing: true }, true), undefined)
})
test('concurrent SDK calls keep exact tool identity, host origin and failed outcomes in the smaller receipt', async () => {
  const receipts = []
  await Promise.all(['A', 'B'].map(toolCallId => withTraceContext({ origin: 'tool', sessionId: 's', project: 'p', toolCallId, record: async row => { receipts.push(row) } }, () => traceInvocation('file.write', async () => {
    await new Promise(resolve => setTimeout(resolve, toolCallId === 'A' ? 10 : 1))
    return { commit: toolCallId === 'A' ? id : base }
  }))))
  assert.equal(receipts.find(row => row.toolCallId === 'A').versions[0].id, id)
  assert.equal(receipts.find(row => row.toolCallId === 'B').versions[0].id, base)
  assert.notEqual(receipts[0].id, receipts[1].id)
  for (const row of receipts) assert.ok(Object.keys(row).every(key => RECEIPT_KEYS.includes(key)), Object.keys(row).join())
  await withTraceContext({ origin: 'host', sessionId: 's', project: 'p', internal: true, record: async row => receipts.push(row) }, () => traceInvocation('file.apply', async () => ({ commit: id })))
  assert.equal(receipts[2].origin, 'host'); assert.deepEqual(receipts[2].versions, [])
  await assert.rejects(withTraceContext({ origin: 'tool', sessionId: 's', project: 'p', toolCallId: 'C', record: async row => receipts.push(row) }, () => traceInvocation('file.apply', async () => { throw Object.assign(new Error('refused'), { transport: 'refusal' }) })))
  assert.equal(receipts[3].outcome, 'refusal'); assert.deepEqual(receipts[3].versions, [])
})
function run(command, argv, env, input = '') {
  return new Promise((resolve, reject) => {
    // A test run inside a dsh session inherits that session's trace context; a case that
    // means "no context" (or its own) must not be tagged by the agent's.
    const child = spawn(command, argv, { env: { ...process.env, DSH_LAYERFS_TRACE_CONTEXT: '', LAYERFS_LOGS_TAG: '', ...env }, stdio: 'pipe' })
    let stdout = '', stderr = ''
    child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data })
    child.on('error', reject); child.on('close', (code, signal) => resolve({ stdout, stderr, code, signal })); child.stdin.end(input)
  })
}
/** A LayerFS call log line (`home log --detail` as `lineOfItem` reads it): lower-case kinds. */
const nativeLine = (argv, extra = {}) => ({ v: 1, at: 5, ms: 1, client: 'cli', argv, outcome: 'ok', ...extra })
test('receipts from call log lines: one per tagged line, versions only for saves, refusals and unknowns link nothing', () => {
  const identity = { origin: 'tool', sessionId: 's', project: 'p', turn: 2, toolCallId: 'bash-a', scope: toolScope('s', 'bash-a') }
  const lines = [
    nativeLine(['file', 'write', 'p', 'branch', '/x', '<6 bytes>'], { kind: 'committed', commit: id, tag: `dsh:s:${identity.scope}.r1` }),
    nativeLine(['file', 'write', 'p', 'branch', '/x'], { kind: 'unchanged', commit: id, tag: `dsh:s:${identity.scope}.r2` }),
    nativeLine(['workspace', 'exec', 'ws', '<11 bytes>'], { kind: 'exit:1', tag: `dsh:s:${identity.scope}.r3` }),
    nativeLine(['file', 'write', 'p', 'branch', '/x'], { outcome: 'Conflict', tag: `dsh:s:${identity.scope}.r4` }),
    nativeLine(['workspace', 'commit', 'ws'], { outcome: 'Unknown', tag: `dsh:s:${identity.scope}.r5` }),
  ]
  const receipts = lines.map(line => receiptFromLine(line, identity, parseTag(line.tag).receiptId))
  assert.equal(new Set(receipts.map(row => row.id)).size, 5)
  assert.deepEqual(receipts.map(row => row.versions.length), [1, 1, 0, 0, 0])
  assert.deepEqual(receipts.map(row => row.outcome), ['success', 'success', 'success', 'refusal', 'unknown'])
  assert.deepEqual(receipts.map(row => row.kind ?? row.code), ['Committed', 'Unchanged', 'exit:1', 'Conflict', 'Unknown'])
  assert.equal(receipts[0].versions[0].effect, 'created'); assert.equal(receipts[1].versions[0].effect, 'unchanged')
  assert.equal(sessionTag(receipts[0].sessionId, receipts[0].id), lines[0].tag)
  assert.ok(receipts.every(row => row.toolCallId === 'bash-a' && row.turn === 2 && Object.keys(row).every(key => RECEIPT_KEYS.includes(key))))
})
test('managed CLI is a bash script: tag, stdin, streams, exit and raw outputs', async () => {
  const dir = mkdtempSync(join(root, 'native-'))
  const cli = join(dir, 'fake.mjs')
  // Echo stdin and the tag; `fail` refuses (125 + a refusal frame on stderr), `exit3` exits 3 (a streamed command's code).
  writeFileSync(cli, `#!/usr/bin/env node\nlet input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{console.log(JSON.stringify({commit:'${id}',tag:process.env.LAYERFS_LOGS_TAG??null,input,home:process.env.LAYERFS_HOME}));process.stderr.write('note\\n');if(process.argv.includes('fail')){process.stderr.write(JSON.stringify({error:'Busy',message:'busy'})+'\\n');process.exitCode=125}else if(process.argv.includes('exit3'))process.exitCode=3})`, { mode: 0o700 })
  const command = managedCli({ root: dir, cli, home: join(dir, 'home'), outputs: join(dir, 'trace', 'outputs') })
  assert.match(readFileSync(command, 'utf8'), /^#!\/bin\/bash\n/, 'no node per call')
  assert.doesNotMatch(readFileSync(command, 'utf8'), />\(|<\(|\/dev\/fd/, "no process substitution: DSH's command sandbox denies /dev/fd")
  const env = { DSH_LAYERFS_TRACE_CONTEXT: traceEnvironment({ origin: 'tool', sessionId: 'session-1f2e', project: 'p', scope: 'abcd1234' }), LAYERFS_LOGS_TAG: 'inherited' }
  const ok = await run(command, ['file', 'write', 'p', 'b', '/x'], env, 'hello\n')
  assert.equal(ok.code, 0); assert.equal(ok.stderr, 'note\n')
  const answer = JSON.parse(ok.stdout)
  assert.match(answer.tag, /^dsh:session-1f2e:abcd1234\.[0-9a-f]{32}$/); assert.equal(answer.input, 'hello\n'); assert.equal(answer.home, join(dir, 'home'))
  await new Promise(resolve => setTimeout(resolve, 100)) // the tee processes finish after the CLI
  const outputs = join(dir, 'trace', 'outputs')
  const raw = readOutput(outputs, answer.tag)
  assert.equal(raw.exit, 0); assert.equal(raw.stdout, ok.stdout); assert.equal(raw.stderr, 'note\n')
  assert.equal(hasOutput(outputs, answer.tag), true)
  const refused = await run(command, ['file', 'write', 'p', 'b', '/x', 'fail'], env)
  assert.equal(refused.code, 125)
  const three = await run(command, ['workspace', 'exec', 'sb:w', 'false', '--stream', 'exit3'], env)
  assert.equal(three.code, 3)
  await new Promise(resolve => setTimeout(resolve, 100))
  const refusedTag = JSON.parse(refused.stdout).tag
  assert.equal(readOutput(outputs, refusedTag).refusal.code, 'Busy')
  assert.equal(readOutput(outputs, JSON.parse(three.stdout).tag).exit, 3)
  // Finished calls become records; the raw files go.
  assert.equal(compactRaw(outputs, undefined, Date.now() + 60_000), 3)
  assert.equal(readOutput(outputs, answer.tag).exit, 0)
  assert.deepEqual(readdirSync(join(outputs, 'raw')), [])
  // No trace context, help and logs: the CLI directly, untagged, nothing kept.
  const bare = await run(command, ['file', 'write', 'p', 'b', '/x'], { DSH_LAYERFS_TRACE_CONTEXT: '', LAYERFS_LOGS_TAG: 'inherited' })
  assert.equal(JSON.parse(bare.stdout).tag, null)
})
test('the bash wrapper forwards a signal and re-raises it', async () => {
  const dir = mkdtempSync(join(root, 'native-sig-'))
  const cli = join(dir, 'fake-wait.mjs')
  writeFileSync(cli, `#!/usr/bin/env node\nprocess.stdout.write('ready\\n');process.on('SIGTERM',()=>process.kill(process.pid,'SIGKILL'));setInterval(()=>{},1000);`, { mode: 0o700 })
  const command = managedCli({ root: dir, cli, home: join(dir, 'home'), outputs: join(dir, 'trace', 'outputs') })
  const child = spawn(command, ['workspace', 'commit', 'ws'], { env: { ...process.env, DSH_LAYERFS_TRACE_CONTEXT: traceEnvironment({ origin: 'tool', sessionId: 'sig', project: 'p', scope: 'ab' }) }, stdio: 'pipe' })
  await new Promise((resolve, reject) => { child.once('error', reject); child.stdout.once('data', resolve) })
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
  child.kill('SIGTERM')
  const result = await closed
  assert.ok(result.signal === 'SIGKILL' || result.code === 137, `killed child's signal re-raised: ${JSON.stringify(result)}`)
})
test('receipts from lines never link an uncertain Workspace target or a result without its kind', () => {
  const identity = toolCallId => ({ origin: 'tool', sessionId: 'parallel', project: 'selected/project', workspace: 'bound:main', toolCallId, scope: toolScope('parallel', toolCallId) })
  const receipt = (toolCallId, line) => receiptFromLine(line, identity(toolCallId), `${identity(toolCallId).scope}.r`)
  const bound = receipt('bound', nativeLine(['workspace', 'commit', 'bound:main', '--force'], { kind: 'committed', commit: id }))
  assert.equal(bound.versions[0].id, id); assert.equal(bound.project, 'selected/project')
  const other = receipt('other', nativeLine(['workspace', 'commit', 'other:main'], { kind: 'committed', commit: id }))
  assert.deepEqual(other.versions, []); assert.equal(other.project, ''); assert.equal(other.captureGap, 'target-workspace-unconfirmed')
  const unnamed = receipt('malformed', nativeLine(['file', 'write', 'other/project', 'b', '/x']))
  assert.equal(unnamed.outcome, 'success'); assert.deepEqual(unnamed.versions, []); assert.equal(unnamed.captureGap, 'structured-result-unavailable')
  const valid = receipt('valid', nativeLine(['file', 'write', 'actual/project', 'b', '/x', '--message', '<1 bytes>'], { kind: 'committed', commit: id }))
  assert.equal(valid.project, 'actual/project'); assert.equal(valid.versions[0].effect, 'created')
})
test('SDK executor tags the child with the receipt id and removes an inherited tag outside a context', async () => {
  const cli = join(root, 'fake-sdk.mjs')
  writeFileSync(cli, `#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({commit:'${id}',tag:process.env.LAYERFS_LOGS_TAG??null})));`, { mode: 0o700 })
  const receipts = []
  const spec = { cli, home: join(root, 'sdk-home') }
  let tagged
  await withTraceContext({ origin: 'tool', sessionId: 'sdk', project: 'selected/project', toolCallId: 'sdk-call', scope: 'feed0123', record: async row => receipts.push(row) }, async () => {
    tagged = await execute(spec, ['file', 'write', '--', 'actual/project', 'branch', '/x'], { input: 'hello' })
    assert.equal(tagged.commit, id)
    await execute(spec, ['help', '--json'], { discovery: true })
  })
  assert.equal(receipts.length, 1); assert.equal(receipts[0].project, 'actual/project'); assert.equal(receipts[0].toolCallId, 'sdk-call'); assert.equal(receipts[0].versions[0].id, id)
  assert.equal(tagged.tag, sessionTag('sdk', receipts[0].id)); assert.ok(receipts[0].id.startsWith('feed0123.'))
  process.env.LAYERFS_LOGS_TAG = 'inherited'
  try { assert.equal((await execute(spec, ['file', 'write', '--', 'p', 'b', '/x'], { input: '' })).tag, null) } finally { delete process.env.LAYERFS_LOGS_TAG }
})
test('SDK workspace saves only link the exact bound Workspace target', async () => {
  const cli = join(root, 'fake-workspace-target.mjs')
  writeFileSync(cli, `#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({commit:'${id}'})));`, { mode: 0o700 })
  const spec = { cli, home: join(root, 'target-home') }, identity = { origin: 'tool', sessionId: 'target-check', project: 'selected/project', workspace: 'bound:main', toolCallId: 'commit-tool' }
  const receipts = []
  await withTraceContext({ ...identity, record: async row => receipts.push(row) }, async () => {
    await execute(spec, ['workspace', 'commit', '--message', 'save', '--', 'bound:main'])
    await execute(spec, ['workspace', 'commit', '--', 'other:main'])
  })
  assert.equal(receipts[0].versions[0].id, id); assert.equal(receipts[0].project, 'selected/project')
  assert.deepEqual(receipts[1].versions, []); assert.equal(receipts[1].project, ''); assert.equal(receipts[1].captureGap, 'target-workspace-unconfirmed')
  assert.equal('workspace' in receipts[0], false, 'local execution handle is excluded from portable receipt')
})
test('SDK sidecar failure reports the error without replaying the command or spooling', async () => {
  const dir = mkdtempSync(join(root, 'recover-'))
  const errors = []
  let executions = 0
  const result = await withTraceContext({ origin: 'tool', sessionId: 'recover', project: 'p', toolCallId: 'recover-call', record: async () => { throw Error('sidecar unavailable') }, onError: error => errors.push(error) }, () => traceInvocation('file.write', async () => { executions++; return { kind: 'Committed', head: id } }))
  assert.equal(result.head, id); assert.equal(executions, 1); assert.equal(errors.length, 1)
  assert.equal(existsSync(join(dir, 'invocation-receipts')), false)
})

// The wrapper lives at <root>/bin/layerfs (docs/specs/layerfs-folder.md §2): an installed CLI at
// that very path is refused before any write, never overwritten; one elsewhere is wrapped.
test('managed CLI never overwrites the installed CLI (refused at its own root/bin/layerfs) or follows self-reference aliases', async () => {
  const fixture=mkdtempSync(join(process.cwd(),'.dev-trace-self-'))
  try {
    const original=`#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({kind:'Committed',head:'${id}'})));`
    const own=join(fixture,'own');mkdirSync(join(own,'bin'),{recursive:true})
    const ownCli=join(own,'bin','layerfs');writeFileSync(ownCli,original,{mode:0o700})
    assert.throws(()=>managedCli({root:own,cli:ownCli,home:join(fixture,'home')}),/self.reference|managed CLI/i)
    assert.equal(readFileSync(ownCli,'utf8'),original,'an installed CLI at the wrapper path is never overwritten')
    mkdirSync(join(fixture,'installed'))
    const cli=join(fixture,'installed','layerfs')
    writeFileSync(cli,original,{mode:0o700})
    const command=managedCli({root:fixture,cli,home:join(fixture,'home')})
    assert.equal(readFileSync(cli,'utf8'),original,'the pinned installed CLI must remain byte-for-byte unchanged')
    assert.equal(command,join(fixture,'bin','layerfs'))
    const result=await run(command,['file','write','p','b','/x'],{DSH_LAYERFS_TRACE_CONTEXT:traceEnvironment({origin:'tool',sessionId:'self-check',project:'p',toolCallId:'call'})})
    assert.equal(result.code,0);assert.equal(JSON.parse(result.stdout).head,id)
    const wrapper=readFileSync(command,'utf8')
    assert.throws(()=>managedCli({root:fixture,cli:command,home:fixture}),/self.reference|managed CLI/i)
    assert.equal(readFileSync(command,'utf8'),wrapper,'self-reference refusal cannot rewrite the wrapper')
    const alias=join(fixture,'alias-layerfs');symlinkSync(command,alias)
    assert.throws(()=>managedCli({root:fixture,cli:alias,home:fixture}),/self.reference|managed CLI/i)
    const rootAlias=fixture+'-alias';symlinkSync(fixture,rootAlias)
    try { assert.throws(()=>managedCli({root:rootAlias,cli:command,home:fixture}),/self.reference|managed CLI/i) } finally { rmSync(rootAlias) }
    const fresh=join(fixture,'fresh');mkdirSync(fresh)
    const broken=join(fresh,'alias');symlinkSync(join(fresh,'bin','layerfs'),broken)
    assert.throws(()=>managedCli({root:fresh,cli:broken,home:fixture}),/self.reference|managed CLI/i)
    assert.equal(existsSync(join(fresh,'bin')),false,'self-reference refusal happens before creating output state')
    const hardRoot=join(fixture,'hardlink');mkdirSync(join(hardRoot,'bin'),{recursive:true})
    linkSync(cli,join(hardRoot,'bin','layerfs'))
    assert.throws(()=>managedCli({root:hardRoot,cli,home:fixture}),/self.reference|managed CLI/i)
    const aliasRoot=join(fixture,'output-alias');mkdirSync(join(aliasRoot,'bin'),{recursive:true})
    symlinkSync(cli,join(aliasRoot,'bin','layerfs'))
    assert.throws(()=>managedCli({root:aliasRoot,cli,home:fixture}),/self.reference|managed CLI/i)
    assert.equal(readFileSync(cli,'utf8'),original)
  } finally { rmSync(fixture,{recursive:true,force:true}) }
})

// docs/specs/sandbox-images.md D6/§4.3: the wrappers pass `sandbox create` through untouched; LayerFS picks the image.
test('the managed CLI wrapper inserts no --image into sandbox create', async () => {
  const dir = mkdtempSync(join(root, 'noimage-'))
  const cli = join(dir, 'echo-argv.mjs')
  writeFileSync(cli, `#!/usr/bin/env node\nconsole.log(JSON.stringify({argv:process.argv.slice(2)}))`, { mode: 0o700 })
  const command = managedCli({ root: dir, cli, home: join(dir, 'home'), outputs: join(dir, 'trace', 'outputs') })
  assert.doesNotMatch(readFileSync(command, 'utf8'), /--image|defaults\.tsv|spawnSync/)
  const answer = await run(command, ['sandbox', 'create', 's1/p', 'b1', 'lima1'], {})
  assert.deepEqual(JSON.parse(answer.stdout).argv, ['sandbox', 'create', 's1/p', 'b1', 'lima1'])
})
