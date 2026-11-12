import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, linkSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
const root = mkdtempSync(join(tmpdir(), 'dsh-tracing-'))
await build({ stdin: { contents: "export * from './src/host/layerfs/tracing.ts'; export { execute } from './src/host/layerfs/cli.ts'", resolveDir: process.cwd(), loader: 'ts' }, outfile: join(root, 'trace.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24' })
const { execute, operationArguments, savedVersions, invocationProject, withTraceContext, traceInvocation, managedCli, traceEnvironment, drainInvocations } = await import(pathToFileURL(join(root, 'trace.mjs')))
const id = '12' + 'a'.repeat(64), base = '32' + 'b'.repeat(64)
test('raw pinned CLI publication and merge receipts preserve snake_case saved-version links', () => {
  assert.deepEqual(savedVersions('branch.publish', { kind: 'Added', published_layer: { id: base }, source: { branch: 'release', commit: id } }), [{ kind: 'Layer', id: base, effect: 'created' }])
  assert.deepEqual(savedVersions('branch.publish', { kind: 'NoChanges', head_layer: base }), [{ kind: 'Layer', id: base, effect: 'unchanged' }])
  assert.deepEqual(savedVersions('branch.merge', { kind: 'Merged', fast_forward: false, head: id }), [{ kind: 'Commit', id, effect: 'created' }])
  assert.deepEqual(savedVersions('branch.merge', { kind: 'Merged', fast_forward: true, head: id }), [{ kind: 'Commit', id, effect: 'referenced' }])
})
test('eligible receipt semantics preserve Commit, Layer, no-op and reference effects', () => {
  assert.deepEqual(savedVersions('file.apply', { kind: 'Committed', commit: { id } }), [{ kind: 'Commit', id, effect: 'created' }])
  assert.deepEqual(savedVersions('workspace.commit', { kind: 'UpToDate', head: id }), [{ kind: 'Commit', id, effect: 'unchanged' }])
  assert.deepEqual(savedVersions('branch.fork', { kind: 'Forked', head: null, base }), [{ kind: 'Layer', id: base, effect: 'referenced' }])
  assert.deepEqual(savedVersions('branch.merge', { kind: 'Merged', fastForward: true, head: id }), [{ kind: 'Commit', id, effect: 'referenced' }])
  assert.deepEqual(savedVersions('branch.merge', { kind: 'Merged', fastForward: false, head: id }), [{ kind: 'Commit', id, effect: 'created' }])
  assert.deepEqual(savedVersions('branch.merge', { kind: 'Merged', head: id }), [])
  assert.deepEqual(savedVersions('branch.publish', { kind: 'Added', publishedLayer: { id } }), [{ kind: 'Layer', id, effect: 'created' }])
  for (const op of ['workspace.exec', 'file.read', 'file.unknown', 'project.init']) assert.deepEqual(savedVersions(op, { kind: 'Committed', head: id }), [])
  assert.deepEqual(savedVersions('file.apply', { head: id }), [])
  assert.deepEqual(savedVersions('file.apply', { kind:'Committed', head:'a'.repeat(64) }), []) // raw content digests are not typed version IDs
  assert.deepEqual(savedVersions('workspace.commit', { kind: 'UpToDate', head: null, root: id }), []) // a root hash is not a Layer
})
test('concurrent SDK calls keep exact tool identity, host origin and failed outcomes', async () => {
  const receipts = []
  await Promise.all(['A', 'B'].map(toolCallId => withTraceContext({ origin: 'tool', sessionId: 's', project: 'p', toolCallId, record: async row => { receipts.push(row) } }, () => traceInvocation('file.write', async () => {
    await new Promise(resolve => setTimeout(resolve, toolCallId === 'A' ? 10 : 1))
    return { kind: 'Committed', head: toolCallId === 'A' ? id : base }
  }))))
  assert.equal(receipts.find(row => row.toolCallId === 'A').versions[0].id, id)
  assert.equal(receipts.find(row => row.toolCallId === 'B').versions[0].id, base)
  assert.notEqual(receipts[0].id, receipts[1].id)
  await withTraceContext({ origin: 'host', sessionId: 's', project: 'p', internal: true, record: async row => receipts.push(row) }, () => traceInvocation('file.apply', async () => ({ kind: 'Committed', head: id })))
  assert.equal(receipts[2].origin, 'host'); assert.deepEqual(receipts[2].versions, [])
  await assert.rejects(withTraceContext({ origin: 'tool', sessionId: 's', project: 'p', toolCallId: 'C', record: async row => receipts.push(row) }, () => traceInvocation('file.apply', async () => { throw Object.assign(new Error('refused'), { transport: 'refusal' }) })))
  assert.equal(receipts[3].outcome, 'refusal'); assert.deepEqual(receipts[3].versions, [])
})
function run(command, argv, env, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { env: { ...process.env, ...env }, stdio: 'pipe' })
    let stdout = '', stderr = ''
    child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data })
    child.on('error', reject); child.on('close', (code, signal) => resolve({ stdout, stderr, code, signal })); child.stdin.end(input)
  })
}
test('managed CLI preserves stdin, exact streams, exit status and repeated invocation receipts', async () => {
  const cli = join(root, 'fake-cli.mjs')
  writeFileSync(cli, `#!${process.execPath}\nlet input='';for await(const chunk of process.stdin)input+=chunk;process.stderr.write('diagnostic\\n');console.log(JSON.stringify({kind:'Committed',head:'${id}',echo:input}));process.exitCode=process.argv.includes('fail')?125:0;`, { mode: 0o700 })
  const command = managedCli({ root, cli, home: join(root, 'private-home') })
  const env = { DSH_LAYERFS_TRACE_CONTEXT: traceEnvironment({ origin: 'tool', sessionId: 's', project: 'p', turn: 2, toolCallId: 'bash-a' }) }
  const a = await run(command, ['file', 'write', 'p', 'branch', '/x'], env, 'hello\n')
  assert.equal(a.code, 0); assert.equal(a.stderr, 'diagnostic\n'); assert.equal(JSON.parse(a.stdout).echo, 'hello\n')
  await run(command, ['file', 'write', 'p', 'branch', '/x'], env)
  await run(command, ['workspace', 'exec'], env)
  const fail = await run(command, ['file', 'write', 'p', 'branch', '/x', 'fail'], env)
  assert.equal(fail.code, 125)
  const receipts = []
  await drainInvocations(root, async row => receipts.push(row))
  assert.equal(receipts.length, 4); assert.equal(new Set(receipts.map(row => row.id)).size, 4)
  assert.equal(receipts.filter(row => row.versions.length).length, 2)
  assert.deepEqual(receipts.find(row => row.operation === 'workspace.exec').versions, [])
  assert.equal(receipts.find(row => row.outcome === 'refusal').versions.length, 0)
  assert.ok(receipts.every(row => row.toolCallId === 'bash-a' && row.turn === 2))
  await drainInvocations(root, async () => assert.fail('already drained'))
})
test('failed sidecar writes retain spool for retry', async () => {
  const directory = join(root, 'invocation-receipts'), path = join(directory, 'abc.json')
  writeFileSync(path, JSON.stringify({ id: 'abc', sessionId: 'other' }))
  await drainInvocations(root, async () => assert.fail('wrong session'), 's')
  assert.ok(existsSync(path))
  await assert.rejects(drainInvocations(root, async () => { throw Error('disk') }))
  assert.ok(existsSync(path)); assert.equal(JSON.parse(readFileSync(path)).id, 'abc')
})

test('CLI project provenance handles leading flags and refuses unknown grammar', () => {
  assert.equal(invocationProject(['file','write','--message','hello','--mode=420','--','store/project','b','/x']), 'store/project')
  assert.equal(invocationProject(['branch','fork','--json','store/other','name','from']), 'store/other')
  assert.equal(invocationProject(['file','write','--unknown','value','store/project']), undefined)
})
test('managed CLI never links uncertain target or malformed result and isolates concurrent calls', async () => {
  const cli = join(root, 'fake-other.mjs')
  writeFileSync(cli, `#!${process.execPath}\nif(process.argv.includes('malformed'))console.log('not json');else console.log(JSON.stringify({kind:'UpToDate',head:'${id}'}));`, { mode: 0o700 })
  const command = managedCli({ root, cli, home: join(root, 'private-home') })
  const env = toolCallId => ({ DSH_LAYERFS_TRACE_CONTEXT: traceEnvironment({ origin: 'tool', sessionId: 'parallel', project: 'selected/project', toolCallId }) })
  await Promise.all([
    run(command, ['file','write','--unknown','value','other/project'], env('uncertain')),
    run(command, ['file','write','other/project','malformed'], env('malformed')),
    run(command, ['file','write','--message','x','--','actual/project'], env('valid')),
  ])
  const receipts = []
  await drainInvocations(root, async row => receipts.push(row), 'parallel')
  const uncertain = receipts.find(row => row.toolCallId === 'uncertain')
  assert.equal(uncertain.project, ''); assert.equal(uncertain.captureGap, 'target-project-unconfirmed'); assert.deepEqual(uncertain.versions, [])
  const malformed = receipts.find(row => row.toolCallId === 'malformed')
  assert.equal(malformed.outcome, 'unknown'); assert.deepEqual(malformed.versions, [])
  const valid = receipts.find(row => row.toolCallId === 'valid')
  assert.equal(valid.project, 'actual/project'); assert.equal(valid.versions[0].effect, 'unchanged')
})
test('managed CLI cancellation forwards signal, terminates, and records no version', async () => {
  const cli = join(root, 'fake-wait.mjs')
  writeFileSync(cli, `#!${process.execPath}\nprocess.stdout.write('ready\\n');setInterval(()=>{},1000);`, { mode: 0o700 })
  const command = managedCli({ root, cli, home: join(root, 'private-home') })
  const child = spawn(command, ['workspace','commit','ws'], { env: { ...process.env, DSH_LAYERFS_TRACE_CONTEXT: traceEnvironment({origin:'tool',sessionId:'cancel',project:'p',toolCallId:'cancel-call'}) }, stdio:'pipe' })
  await new Promise((resolve,reject) => { child.once('error',reject);child.stdout.once('data',resolve) })
  const closed = new Promise(resolve => child.once('close',(code,signal)=>resolve({code,signal})))
  child.kill('SIGTERM')
  const result = await closed
  assert.equal(result.signal, 'SIGTERM')
  const receipts=[];await drainInvocations(root,async row=>receipts.push(row),'cancel')
  assert.equal(receipts.length,1);assert.equal(receipts[0].outcome,'unknown');assert.deepEqual(receipts[0].versions,[])
})
test('simultaneous completed tools serialize spool drains without deleting each other receipts', async () => {
  const path = join(root, 'invocation-receipts', 'def.json')
  writeFileSync(path, JSON.stringify({ id: 'def', sessionId: 'drain-parallel' }))
  let count = 0
  const record = async () => { await new Promise(resolve => setTimeout(resolve, 10)); count++ }
  await Promise.all([drainInvocations(root, record, 'drain-parallel'), drainInvocations(root, record, 'drain-parallel')])
  assert.equal(count, 1); assert.equal(existsSync(path), false)
})

test('SDK common executor captures actual returned commit and target without discovery noise', async () => {
  const cli = join(root, 'fake-sdk.mjs')
  writeFileSync(cli, `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({kind:'Committed',commit:{id:'${id}'}})));`, { mode: 0o700 })
  const receipts=[]
  const spec={cli,home:join(root,'sdk-home')}
  await withTraceContext({origin:'tool',sessionId:'sdk',project:'selected/project',toolCallId:'sdk-call',record:async row=>receipts.push(row)},async()=>{
    const result=await execute(spec,['file','write','--','actual/project','branch','/x'],{input:'hello'})
    assert.equal(result.commit.id,id)
    await execute(spec,['help','--json'],{discovery:true})
  })
  assert.equal(receipts.length,1);assert.equal(receipts[0].project,'actual/project');assert.equal(receipts[0].toolCallId,'sdk-call');assert.equal(receipts[0].versions[0].id,id)
})
test('SDK and CLI workspace saves only link the exact bound Workspace target', async () => {
  const cli = join(root, 'fake-workspace-target.mjs')
  writeFileSync(cli, `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({kind:'Committed',head:'${id}'})));`, { mode: 0o700 })
  const spec={cli,home:join(root,'target-home')}, identity={origin:'tool',sessionId:'target-check',project:'selected/project',workspace:'bound:main',toolCallId:'commit-tool'}
  const receipts=[]
  await withTraceContext({...identity,record:async row=>receipts.push(row)},async()=>{
    await execute(spec,['workspace','commit','--message','save','--','bound:main'])
    await execute(spec,['workspace','commit','--','other:main'])
  })
  assert.equal(receipts[0].versions[0].id,id);assert.equal(receipts[0].project,'selected/project')
  assert.deepEqual(receipts[1].versions,[]);assert.equal(receipts[1].project,'');assert.equal(receipts[1].captureGap,'target-workspace-unconfirmed')
  assert.equal('workspace' in receipts[0],false,'local execution handle is excluded from portable receipt')
  const command=managedCli({root,cli,home:spec.home}), env={DSH_LAYERFS_TRACE_CONTEXT:traceEnvironment(identity)}
  await Promise.all([run(command,['workspace','commit','--force=true','--','bound:main'],env),run(command,['workspace','commit','other:main'],env)])
  const observed=[];await drainInvocations(root,async row=>observed.push(row),'target-check')
  assert.equal(observed.filter(row=>row.versions.length).length,1)
  assert.equal(observed.find(row=>row.captureGap).captureGap,'target-workspace-unconfirmed')
})

test('structured targets are bounded and never duplicate stdin, inline content, commands or branch names', async () => {
  const cli=join(root,'fake-target-arguments.mjs')
  writeFileSync(cli,`#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({kind:'Committed',head:'${id}'})));`,{mode:0o700})
  const argv=['file','write','--mode','420','--','actual/project','private-branch','/target/path','inline-file-content-secret']
  const identity={origin:'tool',sessionId:'argument-check',project:'selected/project',toolCallId:'arguments-tool'},receipts=[]
  await withTraceContext({...identity,record:async row=>receipts.push(row)},()=>execute({cli,home:root},argv,{input:'stdin-file-content-secret'}))
  assert.deepEqual(receipts[0].arguments,{mode:'420',paths:['/target/path']})
  const command=managedCli({root,cli,home:root})
  await run(command,argv,{DSH_LAYERFS_TRACE_CONTEXT:traceEnvironment(identity)},'stdin-file-content-secret')
  await drainInvocations(root,async row=>receipts.push(row),'argument-check')
  assert.deepEqual(receipts[1].arguments,receipts[0].arguments)
  assert.ok(!JSON.stringify(receipts).includes('file-content-secret'))
  assert.ok(!JSON.stringify(receipts).includes('private-branch'))
  assert.deepEqual(operationArguments(['workspace','exec','bound:main','echo file-content-secret']),{workspace:'bound:main'})
  assert.deepEqual(operationArguments(['file','apply','project','branch','file-content-secret']),{})
  const bounded=operationArguments(['file','mv','p','b','😀'.repeat(5000),'\\'.repeat(5000)])
  assert.equal(bounded.truncated,true);assert.ok(bounded.paths.every(path=>path.endsWith('[truncated]')))
  assert.ok(Buffer.byteLength(JSON.stringify(bounded))<=8192)
})
test('SDK sidecar failure retains the exact invocation in recovery spool without replaying the command', async () => {
  const receiptRoot=join(root,'sdk-recovery'), failed=[], recovered=[], errors=[]
  let executions=0
  const result=await withTraceContext({origin:'tool',sessionId:'recover',project:'p',toolCallId:'recover-call',receiptRoot,record:async receipt=>{failed.push(receipt);throw Error('sidecar unavailable')},onError:error=>errors.push(error)},()=>traceInvocation('file.write',async()=>{executions++;return {kind:'Committed',head:id}}))
  assert.equal(result.head,id);assert.equal(executions,1);assert.equal(errors.length,1)
  await drainInvocations(receiptRoot,async receipt=>recovered.push(receipt),'recover')
  assert.deepEqual(recovered,failed);assert.equal(recovered[0].versions[0].id,id)
  assert.equal('receiptRoot' in recovered[0],false)
  await drainInvocations(receiptRoot,async()=>assert.fail('receipt already recovered'),'recover')
  assert.equal(executions,1)
  await withTraceContext({origin:'host',sessionId:'recover',project:'p',receiptRoot,record:async receipt=>recovered.push(receipt)},()=>traceInvocation('file.write',async()=>({kind:'Committed',head:id})))
  await drainInvocations(receiptRoot,async()=>assert.fail('successful sidecar write must not also spool'))
})

test('managed CLI never overwrites the installed CLI at root/bin/layerfs or follows self-reference aliases', async () => {
  const fixture=mkdtempSync(join(process.cwd(),'.dev-trace-self-'))
  try {
    mkdirSync(join(fixture,'bin'))
    const cli=join(fixture,'bin','layerfs'), original=`#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({kind:'Committed',head:'${id}'})));`
    writeFileSync(cli,original,{mode:0o700})
    const command=managedCli({root:fixture,cli,home:join(fixture,'home')})
    assert.equal(readFileSync(cli,'utf8'),original,'the pinned installed CLI must remain byte-for-byte unchanged')
    assert.equal(command,join(fixture,'agent-bin','layerfs'))
    const result=await run(command,['file','write','p','b','/x'],{DSH_LAYERFS_TRACE_CONTEXT:traceEnvironment({origin:'tool',sessionId:'self-check',project:'p',toolCallId:'call'})})
    assert.equal(result.code,0);assert.equal(JSON.parse(result.stdout).head,id)
    const wrapper=readFileSync(command,'utf8')
    assert.throws(()=>managedCli({root:fixture,cli:command,home:fixture}),/self.reference|managed CLI/i)
    assert.equal(readFileSync(command,'utf8'),wrapper,'self-reference refusal cannot rewrite the wrapper')
    const alias=join(fixture,'alias-layerfs');symlinkSync(command,alias)
    assert.throws(()=>managedCli({root:fixture,cli:alias,home:fixture}),/self.reference|managed CLI/i)
    const implementation=command+'.mjs'
    assert.throws(()=>managedCli({root:fixture,cli:implementation,home:fixture}),/self.reference|managed CLI/i)
    const rootAlias=fixture+'-alias';symlinkSync(fixture,rootAlias)
    try { assert.throws(()=>managedCli({root:rootAlias,cli:command,home:fixture}),/self.reference|managed CLI/i) } finally { rmSync(rootAlias) }
    const fresh=join(fixture,'fresh');mkdirSync(fresh)
    const broken=join(fresh,'alias');symlinkSync(join(fresh,'agent-bin','layerfs'),broken)
    assert.throws(()=>managedCli({root:fresh,cli:broken,home:fixture}),/self.reference|managed CLI/i)
    assert.equal(existsSync(join(fresh,'agent-bin')),false,'self-reference refusal happens before creating output state')
    const hardRoot=join(fixture,'hardlink');mkdirSync(join(hardRoot,'agent-bin'),{recursive:true})
    linkSync(cli,join(hardRoot,'agent-bin','layerfs'))
    assert.throws(()=>managedCli({root:hardRoot,cli,home:fixture}),/self.reference|managed CLI/i)
    const aliasRoot=join(fixture,'output-alias');mkdirSync(join(aliasRoot,'agent-bin'),{recursive:true})
    symlinkSync(cli,join(aliasRoot,'agent-bin','layerfs'))
    assert.throws(()=>managedCli({root:aliasRoot,cli,home:fixture}),/self.reference|managed CLI/i)
    assert.equal(readFileSync(cli,'utf8'),original)
  } finally { rmSync(fixture,{recursive:true,force:true}) }
})
