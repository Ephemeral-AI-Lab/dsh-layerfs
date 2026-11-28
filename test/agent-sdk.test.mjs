// The LayerFS Node SDK agents import as $DSH_LAYERFS_SDK (src/host/layerfs/agent-sdk.ts):
// finding an installed SDK by commit, the generated module's families and call shapes,
// receipt tags passed as `log_tag` (LayerFS writes the call log line), output records,
// and no output for arguments the SDK refuses before calling.
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
    if (spec.call === 'write') return { commit: '${head}' };
    if (spec.call === 'exec') return { exit_code: 3, stdout: 'out', stderr: '' };
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

const records = (base) => {
  const dir = join(base, 'trace', 'outputs')
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8'))) : []
}
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
  const file = S.managedSdk({ root: base, sdk: S.findSdk(dir, commit), home: '/home/lfs', outputs: join(base, 'trace', 'outputs') })
  assert.equal(file, join(base, 'bin', 'sdk.mjs'))
  const out = run(file, `const r = await m.default.file.read('s/p', 'work', '/a.js'); console.log(JSON.stringify({ r, keys: Object.keys(m.default).sort(), store: 'store' in m.default, seen: globalThis.__seen, table: m.table.map((t) => t.family) }))`)
  assert.deepEqual(out.r, { kind: 'ok', text: 'hi' })
  assert.equal(out.store, false)
  assert.deepEqual(out.table, ['file', 'file', 'workspace'])
  assert.equal(out.seen[0].home, '/home/lfs')
  assert.equal(out.seen[0].env.home, '/home/lfs')
  assert.equal(out.seen[0].env.addon, join(dir, 'layerfs.node'))
  // Rewriting the same options keeps the file as it is.
  const before = S.sdkDigest(file)
  S.managedSdk({ root: base, sdk: S.findSdk(dir, commit), home: '/home/lfs', outputs: join(base, 'trace', 'outputs') })
  assert.equal(S.sdkDigest(file), before)
})

test('each traced call passes its receipt tag as log_tag and keeps its output record', () => {
  const dir = install(mkdtempSync(join(root, 'tagged-'))), base = mkdtempSync(join(root, 'r-'))
  const file = S.managedSdk({ root: base, sdk: S.findSdk(dir, commit), home: '/h', outputs: join(base, 'trace', 'outputs') })
  const out = run(file, `
    const l = m.default;
    await l.file.write('s/p', 'work', '/notes.md', 'hello', { message: 'secret words' });
    await l.workspace.exec('sb:w', 'npm test --token=abc', { stream: false });
    await l.file.read('s/p', 'work', '/a.js', { start_line: 2 });
    try { await l.file.read('s/p', 'work', '/missing') } catch (e) { if (e.code !== 'NoSuchPath' || e.name !== 'LayerFSError') throw e }
    console.log(JSON.stringify(globalThis.__seen.map((s) => s.given)))`, { DSH_LAYERFS_TRACE_CONTEXT: trace() })
  const tags = out.map((given) => given.at(-1).log_tag)
  for (const tag of tags) assert.match(tag, /^dsh:session-1:ab12\./)
  assert.equal(new Set(tags).size, 4)
  assert.equal(out[0].at(-1).message, 'secret words'); assert.equal(out[2].at(-1).start_line, 2, 'the caller\'s options stay')
  const got = records(base)
  assert.equal(got.length, 4)
  assert.deepEqual(new Set(got.map((r) => r.tag)), new Set(tags), 'each record is the call\'s tag')
  assert.ok(got.find((r) => r.exit === 125), 'the refusal has an output record with exit 125')
  assert.ok(got.some((r) => r.exit === 0 && r.stdout.includes(head)), 'the write\'s record holds its 2.0 answer')
  assert.ok(got.some((r) => r.exit === 3), 'the exec\'s record exits with the command\'s code')
})

test('no trace context: no log_tag and no output record', () => {
  const dir = install(mkdtempSync(join(root, 'untag-'))), base = mkdtempSync(join(root, 'r-'))
  const file = S.managedSdk({ root: base, sdk: S.findSdk(dir, commit), home: '/h', outputs: join(base, 'trace', 'outputs') })
  const out = run(file, `await m.default.file.read('s/p', 'work', '/a.js'); console.log(JSON.stringify(globalThis.__seen.map((s) => s.given)))`)
  assert.deepEqual(out, [['s/p', 'work', '/a.js']])
  assert.deepEqual(records(base), [])
})

test('arguments the SDK refuses before calling keep no output', () => {
  const dir = install(mkdtempSync(join(root, 'bad-'))), base = mkdtempSync(join(root, 'r-'))
  const file = S.managedSdk({ root: base, sdk: S.findSdk(dir, commit), home: '/h', outputs: join(base, 'trace', 'outputs') })
  run(file, `try { await m.default.file.read('s/p', 'work', '/a.js', { nope: 1 }) } catch (e) { if (e.code !== 'InvalidInput') throw e } console.log('null')`, { DSH_LAYERFS_TRACE_CONTEXT: trace() })
  assert.deepEqual(records(base), [])
})

test('the Stores close when the script ends', () => {
  const dir = install(mkdtempSync(join(root, 'close-'))), base = mkdtempSync(join(root, 'r-'))
  const file = S.managedSdk({ root: base, sdk: S.findSdk(dir, commit), home: '/h', outputs: null })
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(file).href)}); process.on('exit', () => console.log('closed=' + globalThis.__closed))`], { encoding: 'utf8', env: { PATH: process.env.PATH } })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /closed=[1-9]/)
})

test('a workspace exec output record is its one result JSON, exiting with the command\'s code (2.0)', () => {
  const dir = install(mkdtempSync(join(root, 'exec-'))), base = mkdtempSync(join(root, 'r-'))
  const file = S.managedSdk({ root: base, sdk: S.findSdk(dir, commit), home: '/h', outputs: join(base, 'trace', 'outputs') })
  run(file, `await m.default.workspace.exec('sb:w', 'false'); console.log('null')`, { DSH_LAYERFS_TRACE_CONTEXT: trace() })
  const [name] = readdirSync(join(base, 'trace', 'outputs')).filter((f) => f.endsWith('.json'))
  const record = JSON.parse(readFileSync(join(base, 'trace', 'outputs', name), 'utf8'))
  assert.equal(record.exit, 3)
  assert.deepEqual(JSON.parse(record.stdout), { exit_code: 3, stdout: 'out', stderr: '' })
})

test('findSdk takes the folder of installs as well as one install', () => {
  const parent = mkdtempSync(join(root, 'parent-'))
  install(join(parent, commit))
  assert.equal(S.findSdk(parent, commit)?.dir, join(parent, commit))
  assert.equal(S.findSdk(join(parent, commit), commit)?.dir, join(parent, commit))
})
