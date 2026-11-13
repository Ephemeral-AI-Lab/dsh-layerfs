// The LayerFS Node SDK agents import as $DSH_LAYERFS_SDK (src/host/layerfs/agent-sdk.ts):
// finding an installed SDK by commit, the generated module's families and call shapes,
// receipt tags, the stand-in call log line (client "node"), output records, native
// mode's log_tag, and no line for arguments the SDK refuses before calling.
// A stub @layerfs/node stands in for the real one (no addon needed); test/agent-sdk-live
// runs the installed SDK when one is present.
//   node --test test/agent-sdk.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const root = mkdtempSync(join(tmpdir(), 'dsh-agent-sdk-'))
await build({ stdin: { contents: "export * from './src/host/layerfs/agent-sdk.ts'", resolveDir: process.cwd(), loader: 'ts' }, outfile: join(root, 'sdk.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24' })
const S = await import(pathToFileURL(join(root, 'sdk.mjs')))
const commit = 'b'.repeat(40), head = '12' + 'c'.repeat(64)

// A stub of @layerfs/node: the same table shape, a client whose calls record what they got.
const STUB = `
export class LayerFSError extends Error { constructor(code, message, detail) { super(message); this.name = 'LayerFSError'; this.code = code; this.detail = detail } }
export const table = [
  { family: 'file', call: 'read', args: [{ name: 'project', kind: 'project' }, { name: 'branch', kind: 'name' }, { name: 'path', kind: 'text' }, { name: 'commit', kind: 'name', optional: true }], options: [{ name: 'start_line', kind: 'int' }] },
  { family: 'file', call: 'write', args: [{ name: 'project', kind: 'project' }, { name: 'branch', kind: 'name' }, { name: 'path', kind: 'text' }, { name: 'content', kind: 'content' }], options: [{ name: 'message', kind: 'text' }] },
  { family: 'workspace', call: 'exec', args: [{ name: 'ws', kind: 'text' }, { name: 'command', kind: 'text' }], options: [{ name: 'stream', kind: 'bool' }, { name: 'stdout', kind: 'function' }] },
  { family: 'store', call: 'remove', args: [{ name: 'name', kind: 'name' }], options: [] },
];
export const seen = globalThis.__seen = [];
let closed = 0;
export function close() { closed++; globalThis.__closed = closed; return 1 }
export function client({ home }) {
  const made = {};
  for (const spec of table) (made[spec.family] ??= {})[spec.call] = async (...given) => {
    seen.push({ call: spec.family + '.' + spec.call, given, home, env: { home: process.env.LAYERFS_HOME, addon: process.env.LAYERFS_NATIVE } });
    const options = given.at(-1) && typeof given.at(-1) === 'object' ? given.at(-1) : {};
    for (const key of Object.keys(options)) if (!['start_line', 'message', 'stream', 'stdout', 'log_tag'].includes(key)) throw new LayerFSError('InvalidInput', spec.family + '.' + spec.call + ': unknown option "' + key + '"', null);
    if (given[2] === '/missing') throw new LayerFSError('NoSuchPath', '/missing does not exist', { path: '/missing' });
    if (spec.call === 'write') return { kind: 'Committed', branch: given[1], head: '${head}', commit: { id: '${head}' } };
    if (spec.call === 'exec') return { kind: 'exit:3', exit_code: 3, stdout: 'out', stderr: '' };
    return { kind: 'ok', text: 'hi' };
  };
  return made;
}`

function install(dir, at = commit) {
  mkdirSync(join(dir, 'api', 'node', 'src'), { recursive: true })
  writeFileSync(join(dir, 'api', 'node', 'package.json'), '{"type":"module"}')
  writeFileSync(join(dir, 'api', 'node', 'src', 'index.js'), STUB)
  writeFileSync(join(dir, 'layerfs.node'), '')
  writeFileSync(join(dir, 'sdk.json'), JSON.stringify({ commit: at }))
  return dir
}

/** Run a script against a generated module in a child process (fresh env); answer its JSON stdout. */
function run(file, script, env = {}) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(pathToFileURL(file).href)}); ${script}`], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim() ? JSON.parse(r.stdout.trim().split('\n').at(-1)) : null
}

const lines = (callLog) => existsSync(callLog) ? readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
const trace = (sessionId = 'session-1') => JSON.stringify({ sessionId, scope: 'ab12' })

test('findSdk answers an install only for its own commit', () => {
  const dir = install(mkdtempSync(join(root, 'find-')))
  assert.equal(S.findSdk(dir, commit)?.commit, commit)
  assert.equal(S.findSdk(dir, 'a'.repeat(40)), null)
  assert.equal(S.findSdk(join(root, 'nowhere'), commit), null)
  assert.equal(S.findSdk(null, commit), null)
})

test('the module binds the home and addon and exposes the six families only', () => {
  const dir = install(mkdtempSync(join(root, 'bind-'))), base = mkdtempSync(join(root, 'r-'))
  const file = S.managedSdk({ root: base, sdk: S.findSdk(dir, commit), home: '/home/lfs', callLog: join(base, 'trace', 'calls.jsonl') })
  assert.equal(file, join(base, 'agent-bin', 'sdk.mjs'))
  const out = run(file, `const r = await m.default.file.read('s/p', 'work', '/a.js'); console.log(JSON.stringify({ r, keys: Object.keys(m.default).sort(), store: 'store' in m.default, seen: globalThis.__seen, table: m.table.map((t) => t.family) }))`)
  assert.deepEqual(out.r, { kind: 'ok', text: 'hi' })
  assert.equal(out.store, false)
  assert.deepEqual(out.table, ['file', 'file', 'workspace'])
  assert.equal(out.seen[0].home, '/home/lfs')
  assert.equal(out.seen[0].env.home, '/home/lfs')
  assert.equal(out.seen[0].env.addon, join(dir, 'layerfs.node'))
  // Rewriting the same options keeps the file as it is.
  const before = S.sdkDigest(file)
  S.managedSdk({ root: base, sdk: S.findSdk(dir, commit), home: '/home/lfs', callLog: join(base, 'trace', 'calls.jsonl') })
  assert.equal(S.sdkDigest(file), before)
})

test('stand-in mode writes one tagged node line per call, and the output record', () => {
  const dir = install(mkdtempSync(join(root, 'stand-'))), base = mkdtempSync(join(root, 'r-')), callLog = join(base, 'trace', 'calls.jsonl')
  const file = S.managedSdk({ root: base, sdk: S.findSdk(dir, commit), home: '/h', callLog, bools: ['stream'] })
  run(file, `
    const l = m.default;
    await l.file.write('s/p', 'work', '/notes.md', 'hello', { message: 'secret words' });
    await l.workspace.exec('sb:w', 'npm test --token=abc', { stream: false });
    try { await l.file.read('s/p', 'work', '/missing') } catch (e) { if (e.code !== 'NoSuchPath' || e.name !== 'LayerFSError') throw e }
    console.log('null')`, { DSH_LAYERFS_TRACE_CONTEXT: trace() })
  const got = lines(callLog)
  assert.equal(got.length, 3)
  for (const line of got) { assert.equal(line.client, 'node'); assert.match(line.tag, /^dsh:session-1:ab12\./) }
  assert.deepEqual(got[0].argv, ['file', 'write', 's/p', 'work', '/notes.md', '<5 bytes>', '--message', '<12 bytes>'])
  assert.equal(got[0].outcome, 'ok'); assert.equal(got[0].kind, 'Committed'); assert.equal(got[0].commit, head)
  assert.deepEqual(got[1].argv, ['workspace', 'exec', 'sb:w', '<20 bytes>'])
  assert.equal(got[2].outcome, 'NoSuchPath')
  const outputs = readdirSync(join(base, 'trace', 'outputs')).filter((f) => f.endsWith('.json'))
  assert.equal(outputs.length, 3)
  const records = outputs.map((f) => JSON.parse(readFileSync(join(base, 'trace', 'outputs', f), 'utf8')))
  const refused = records.find((r) => r.exit === 125)
  assert.ok(refused, 'the refusal has an output record with exit 125')
  assert.ok(records.some((r) => r.exit === 0 && /Committed/.test(r.stdout)))
})

test('no trace context: lines are untagged and no output record is written', () => {
  const dir = install(mkdtempSync(join(root, 'untag-'))), base = mkdtempSync(join(root, 'r-')), callLog = join(base, 'trace', 'calls.jsonl')
  const file = S.managedSdk({ root: base, sdk: S.findSdk(dir, commit), home: '/h', callLog })
  run(file, `await m.default.file.read('s/p', 'work', '/a.js'); console.log('null')`)
  const got = lines(callLog)
  assert.equal(got.length, 1)
  assert.equal(got[0].tag, undefined)
  assert.equal(existsSync(join(base, 'trace', 'outputs')), false)
})

test('arguments the SDK refuses before calling write no line', () => {
  const dir = install(mkdtempSync(join(root, 'bad-'))), base = mkdtempSync(join(root, 'r-')), callLog = join(base, 'trace', 'calls.jsonl')
  const file = S.managedSdk({ root: base, sdk: S.findSdk(dir, commit), home: '/h', callLog })
  run(file, `try { await m.default.file.read('s/p', 'work', '/a.js', { nope: 1 }) } catch (e) { if (e.code !== 'InvalidInput') throw e } console.log('null')`, { DSH_LAYERFS_TRACE_CONTEXT: trace() })
  assert.deepEqual(lines(callLog), [])
})

test('native mode passes the tag as log_tag and writes no stand-in line', () => {
  const dir = install(mkdtempSync(join(root, 'native-'))), base = mkdtempSync(join(root, 'r-')), callLog = join(base, 'trace', 'calls.jsonl')
  const file = S.managedSdk({ root: base, sdk: S.findSdk(dir, commit), home: '/h', callLog, native: true })
  const out = run(file, `
    await m.default.file.read('s/p', 'work', '/a.js');
    await m.default.file.read('s/p', 'work', '/a.js', { start_line: 2 });
    console.log(JSON.stringify(globalThis.__seen.map((s) => s.given)))`, { DSH_LAYERFS_TRACE_CONTEXT: trace() })
  assert.match(out[0][3].log_tag, /^dsh:session-1:ab12\./)
  assert.equal(out[1][3].start_line, 2)
  assert.match(out[1][3].log_tag, /^dsh:session-1:/)
  assert.deepEqual(lines(callLog), [])
  assert.equal(readdirSync(join(base, 'trace', 'outputs')).filter((f) => f.endsWith('.json')).length, 2)
})

test('the Stores close when the script ends', () => {
  const dir = install(mkdtempSync(join(root, 'close-'))), base = mkdtempSync(join(root, 'r-'))
  const file = S.managedSdk({ root: base, sdk: S.findSdk(dir, commit), home: '/h', callLog: null })
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(file).href)}); process.on('exit', () => console.log('closed=' + globalThis.__closed))`], { encoding: 'utf8', env: { PATH: process.env.PATH } })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /closed=[1-9]/)
})

test('an SDK that refuses log_tag falls back to the stand-in line, once', () => {
  const dir = install(mkdtempSync(join(root, 'notag-'))), base = mkdtempSync(join(root, 'r-')), callLog = join(base, 'trace', 'calls.jsonl')
  const index = join(dir, 'api', 'node', 'src', 'index.js')
  writeFileSync(index, readFileSync(index, 'utf8').replace("'stdout', 'log_tag']", "'stdout']"))
  const file = S.managedSdk({ root: base, sdk: S.findSdk(dir, commit), home: '/h', callLog, native: true })
  const out = run(file, `
    const a = await m.default.file.read('s/p', 'work', '/a.js');
    const b = await m.default.file.read('s/p', 'work', '/b.js');
    console.log(JSON.stringify({ a, b, calls: globalThis.__seen.length }))`, { DSH_LAYERFS_TRACE_CONTEXT: trace() })
  assert.equal(out.a.kind, 'ok')
  assert.equal(out.calls, 3, 'one refused try, then one call each')
  assert.deepEqual(lines(callLog).map((l) => l.argv[4]), ['/a.js', '/b.js'])
})

test('a workspace exec output record carries the exit code frame and the command output', () => {
  const dir = install(mkdtempSync(join(root, 'exec-'))), base = mkdtempSync(join(root, 'r-')), callLog = join(base, 'trace', 'calls.jsonl')
  const file = S.managedSdk({ root: base, sdk: S.findSdk(dir, commit), home: '/h', callLog })
  run(file, `await m.default.workspace.exec('sb:w', 'false'); console.log('null')`, { DSH_LAYERFS_TRACE_CONTEXT: trace() })
  const [name] = readdirSync(join(base, 'trace', 'outputs')).filter((f) => f.endsWith('.json'))
  const record = JSON.parse(readFileSync(join(base, 'trace', 'outputs', name), 'utf8'))
  assert.match(record.stdout, /^out\n?/)
  assert.equal(JSON.parse(record.stdout.trimEnd().split('\n').at(-1)).result.exit_code, 3)
})

test('findSdk takes the folder of installs as well as one install', () => {
  const parent = mkdtempSync(join(root, 'parent-'))
  install(join(parent, commit))
  assert.equal(S.findSdk(parent, commit)?.dir, join(parent, commit))
  assert.equal(S.findSdk(join(parent, commit), commit)?.dir, join(parent, commit))
})
