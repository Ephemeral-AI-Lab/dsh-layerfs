// The files routes behind the machine and Sandbox Files tabs
// (layerfs-project#178 "Host side"): GET /api/machines/:id/files and
// GET /api/sandboxes/:name/files over machine.files / sandbox.files, on the
// same single-flight, stale and cancel helpers as the log routes
// (src/host/routes/inspect.ts). The inspect lane itself is in cli-lanes.test.mjs,
// and `loggable` skipping both calls in call-log.test.mjs.
//   node --test test/inspect-files-routes.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRoutes, testHost } from './routes-helper.mjs'

const R = await loadRoutes()

class Refusal extends Error {
  constructor(code, message = code) { super(message); Object.assign(this, { code, detail: null, transport: 'refusal' }) }
}
const entry = (family, call) => ({ family, call, args: [], options: [] })
const BASE = [entry('machine', 'list'), entry('machine', 'stop'), entry('sandbox', 'create')]
const FILES = [...BASE, entry('sandbox', 'files'), entry('machine', 'files')]
const tick = () => new Promise((r) => setTimeout(r, 10))

function fixture(lfs, calls = FILES) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-files-routes-'))
  const t = testHost({ lfs, root, home: join(root, 'home'), discovery: async () => ({ identity: { version: '2.0.0-test', features: [] }, calls }) })
  const groups = R.createGroups(t.host, async () => ({}))
  return { groups, logs: t.logs, http: (method, path, body) => R.handle(groups, { method, path, body }), close: () => rmSync(root, { recursive: true, force: true }) }
}
const base = () => ({
  machine: { list: async () => ({ machines: [{ name: 'native', platform: 'native', state: 'ready' }] }), platforms: async () => ({ host: 'macos', platforms: [] }) },
  store: { list: async () => ({ items: [] }) },
  sandbox: { list: async () => ({ items: [], next_page_pos: null }) },
})
const folder = (paths, more = {}) => ({ kind: 'folder', entries: paths.map((path) => ({ path, depth: 1, kind: 'file', size: 3, mode: 0o100644, mtime: 1763290000 })), next: null, has_more: false, ...more })

test('files routes: a CLI without the call answers 501 and makes no call; each route needs its own call', async () => {
  let calls = 0
  const lfs = base()
  lfs.machine.files = async () => { calls++; return folder([]) }
  lfs.sandbox.files = async () => { calls++; return folder([]) }
  const none = fixture(lfs, BASE)
  const onlySandbox = fixture(lfs, [...BASE, entry('sandbox', 'files')])
  try {
    for (const path of ['/api/machines/docker/files', '/api/sandboxes/sb/files?path=/x']) {
      const r = await none.http('GET', path)
      assert.equal(r.status, 501)
      assert.equal(r.body.code, 'Unsupported')
      assert.match(r.body.detail.need, /^(machine|sandbox)\.files$/)
    }
    assert.equal(calls, 0)
    assert.deepEqual(none.logs, [], 'an expected refusal logs no stack')
    assert.equal((await onlySandbox.http('GET', '/api/machines/docker/files')).status, 501)
    assert.equal((await onlySandbox.http('GET', '/api/sandboxes/sb/files')).status, 200)
    assert.equal(calls, 1)
    // only GET
    assert.equal((await onlySandbox.http('POST', '/api/sandboxes/sb/files', {})).status, 404)
  } finally { none.close(); onlySandbox.close() }
})

test('files routes: bad queries are refused before any call', async () => {
  let calls = 0
  const lfs = base()
  lfs.machine.files = async () => { calls++; return folder([]) }
  const f = fixture(lfs)
  try {
    for (const query of ['path=relative/x', 'path=/a&depth=0', 'path=/a&depth=65', 'path=/a&limit=0', 'path=/a&limit=1001', 'path=/a&limit=1.5', 'path=/a&offset=-1', 'path=/a&length=0', `path=/a&length=${1024 * 1024 + 1}`, 'cursor=/a', 'offset=0', 'path=/a&cursor=/a/b&offset=0', `path=/${'x'.repeat(4096)}`]) {
      const r = await f.http('GET', `/api/machines/docker/files?${query}`)
      assert.equal(r.status, 400, query)
      assert.equal(r.body.code, 'InvalidInput', query)
    }
    assert.equal(calls, 0)
  } finally { f.close() }
})

test('files routes: the roots, a folder page and a file window as the page reads them, with the options LayerFS takes', async () => {
  const seen = []
  const lfs = base()
  lfs.machine.files = async (name, path, options) => {
    seen.push(['machine', name, path, { ...options, signal: options.signal instanceof AbortSignal }])
    if (path === undefined) return { kind: 'folder', entries: [
      { path: '/layerfs/data', depth: 1, kind: 'folder', size: 4096, mode: 0o40700, mtime: 1763290000, role: 'data', free: 123456789 },
      { path: '/layerfs/data/store', depth: 1, kind: 'folder', size: 96, mode: 0o40700, mtime: 1763290001, role: 'stores' },
      { path: '/', depth: 1, kind: 'folder', size: 4096, mode: 0o40755, mtime: 1, role: 'machine' },
    ], next: null, has_more: false }
    if (path === '/etc') return { kind: 'folder', entries: [
      { path: '/etc/hosts', depth: 1, kind: 'file', size: 180, mode: 0o100644, mtime: 1763290000 },
      { path: '/etc/shadow', depth: 1, kind: 'unreadable', size: 900, mode: 0o100640, mtime: 1763290000 },
      { path: '/etc/mtab', depth: 1, kind: 'symlink', size: 19, mode: 0o120777, mtime: 1, target: '../proc/self/mounts' },
      { path: '/etc/future', depth: 1, kind: 'door', size: 0, mode: 0, mtime: 0 },
      { path: '/etc/ws', depth: 1, kind: 'mount', size: null, mode: null, mtime: null, workspace: 'sb:w1', fs: 'fuse.layerfs' },
      { path: '', kind: 'file' }, null, 'bare',
    ], next: '/etc/ws', has_more: true, reason: 'deadline' }
    if (path === '/etc/hosts') return { kind: 'file', size: 300000, offset: options.offset ?? 0, content: 'x'.repeat(8), binary: false, next: 262144 }
    return { kind: 'something else' }
  }
  lfs.sandbox.files = async (name, path, options) => { seen.push(['sandbox', name, path, { ...options, signal: options.signal instanceof AbortSignal }]); return { kind: 'file', size: 4, offset: 0, content: '\u0000\u0001', binary: true, next: null } }
  const f = fixture(lfs)
  try {
    const roots = (await f.http('GET', '/api/machines/vm/files')).body
    assert.equal(roots.kind, 'folder')
    assert.equal(roots.path, null)
    assert.deepEqual(roots.entries.map((e) => [e.path, e.role, e.kind]), [['/layerfs/data', 'data', 'folder'], ['/layerfs/data/store', 'stores', 'folder'], ['/', 'machine', 'folder']])
    assert.equal(roots.entries[0].free, 123456789)
    assert.deepEqual([roots.next, roots.hasMore, roots.reason, roots.stale], [null, false, null, false])
    assert.equal(typeof roots.observedAt, 'number')

    const etc = (await f.http('GET', '/api/machines/vm/files?path=/etc&depth=1&limit=500')).body
    assert.deepEqual(etc.entries.map((e) => e.kind), ['file', 'unreadable', 'symlink', 'door', 'mount'], 'entries without a path are dropped; an unknown kind is passed as it came')
    assert.deepEqual(etc.entries[0], { path: '/etc/hosts', depth: 1, kind: 'file', size: 180, mode: 0o100644, mtime: 1763290000 })
    assert.equal(etc.entries[2].target, '../proc/self/mounts')
    assert.deepEqual([etc.entries[4].workspace, etc.entries[4].fs, etc.entries[4].size], ['sb:w1', 'fuse.layerfs', null])
    assert.deepEqual([etc.path, etc.next, etc.hasMore, etc.reason], ['/etc', '/etc/ws', true, 'deadline'])

    const file = (await f.http('GET', '/api/machines/vm/files?path=/etc/hosts&offset=262144&length=1048576')).body
    assert.deepEqual({ ...file, observedAt: 0 }, { kind: 'file', path: '/etc/hosts', size: 300000, offset: 262144, content: 'xxxxxxxx', binary: false, next: 262144, observedAt: 0, stale: false })
    const binary = (await f.http('GET', '/api/sandboxes/sb/files?path=/home/a.bin')).body
    assert.deepEqual([binary.kind, binary.binary, binary.next, binary.size], ['file', true, null, 4])

    // an answer that is neither is a refusal inside the view, not a failed request
    const odd = await f.http('GET', '/api/machines/vm/files?path=/odd')
    assert.equal(odd.status, 200)
    assert.deepEqual([odd.body.kind, odd.body.stale.code, odd.body.path], ['refused', 'Unknown', '/odd'])

    await f.http('GET', '/api/machines/vm/files?path=/etc&cursor=/etc/ws')
    assert.deepEqual(seen, [
      ['machine', 'vm', undefined, { signal: true }],
      ['machine', 'vm', '/etc', { depth: 1, limit: 500, signal: true }],
      ['machine', 'vm', '/etc/hosts', { offset: 262144, length: 1048576, signal: true }],
      ['sandbox', 'sb', '/home/a.bin', { signal: true }],
      ['machine', 'vm', '/odd', { signal: true }],
      ['machine', 'vm', '/etc', { cursor: '/etc/ws', signal: true }],
    ])
  } finally { f.close() }
})

test('files routes: one read per key at a time; another folder, cursor or target reads on its own; never part of the machines view', async () => {
  let calls = 0
  const gates = []
  const lfs = base()
  lfs.machine.files = async (_name, path, options) => { calls++; await new Promise((r) => gates.push(r)); return folder([`${path ?? ''}/f${options.cursor ?? ''}`]) }
  const f = fixture(lfs)
  try {
    const same = [1, 2, 3].map(() => f.http('GET', '/api/machines/vm/files?path=/a'))
    await tick()
    assert.equal(calls, 1, 'three GETs of the same folder share one read')
    const others = [f.http('GET', '/api/machines/vm/files?path=/b'), f.http('GET', '/api/machines/vm/files?path=/a&cursor=/a/k'), f.http('GET', '/api/machines/other/files?path=/a'), f.http('GET', '/api/machines/vm/files')]
    await tick()
    assert.equal(calls, 5)
    // the machines view answers while they are held, and makes no files call
    assert.equal((await f.http('GET', '/api/machines')).status, 200)
    assert.equal(calls, 5)
    for (const g of gates.splice(0)) g()
    assert.deepEqual((await Promise.all(same)).map((r) => r.body.entries[0].path), ['/a/f', '/a/f', '/a/f'])
    await Promise.all(others)
    assert.equal(f.groups.machines.reads.flights, 0)
  } finally { f.close() }
})

test('files routes: a refused read answers the folder\'s last good first page marked stale, else the refusal; never an error status', async () => {
  let fail = null
  const lfs = base()
  lfs.sandbox.files = async (_name, path, options) => { if (fail) throw fail; return path === undefined ? folder(['/run/tmp'], {}) : folder([`${path}/a`, `${path}/b`], options.cursor ? {} : { next: `${path}/b`, has_more: true, reason: 'limit' }) }
  const f = fixture(lfs)
  try {
    assert.equal((await f.http('GET', '/api/sandboxes/sb/files')).body.stale, false)
    const first = (await f.http('GET', '/api/sandboxes/sb/files?path=/home')).body
    assert.deepEqual([first.stale, first.reason, first.next], [false, 'limit', '/home/b'])
    await f.http('GET', '/api/sandboxes/sb/files?path=/home&cursor=/home/b')

    fail = new Refusal('Unavailable', 'machine native is stopped')
    for (const [query, kept] of [['', 1], ['?path=/home', 2]]) {
      const r = await f.http('GET', `/api/sandboxes/sb/files${query}`)
      assert.equal(r.status, 200, query)
      assert.equal(r.body.kind, 'folder')
      assert.equal(r.body.entries.length, kept)
      assert.deepEqual([r.body.stale.code, r.body.stale.message, r.body.stale.at], ['Unavailable', 'machine native is stopped', first.observedAt > 0 ? r.body.stale.at : null])
      assert.equal(typeof r.body.stale.at, 'number')
    }
    // a later page, a folder never read, a file window and another target have nothing kept
    fail = new Refusal('Busy', '2 inspect reads are running and 4 are waiting on this host; read again in a moment')
    for (const query of ['?path=/home&cursor=/home/b', '?path=/never', '?path=/home/a&offset=0']) {
      const r = await f.http('GET', `/api/sandboxes/sb/files${query}`)
      assert.equal(r.status, 200, query)
      assert.deepEqual([r.body.kind, r.body.stale.code, r.body.stale.at], ['refused', 'Busy', null], query)
    }
    assert.equal((await f.http('GET', '/api/sandboxes/other/files?path=/home')).body.kind, 'refused')
    for (const code of ['InvalidInput', 'Unsupported', 'Timeout', 'Failed']) {
      fail = new Refusal(code)
      const r = await f.http('GET', '/api/sandboxes/sb/files?path=/x')
      assert.deepEqual([r.status, r.body.kind, r.body.stale.code], [200, 'refused', code])
    }
    // it answers again: the stale mark goes
    fail = null
    assert.equal((await f.http('GET', '/api/sandboxes/sb/files?path=/home')).body.stale, false)
    assert.deepEqual(f.logs, [], 'refusals of a files read log no stack')
  } finally { f.close() }
})

test('files routes: the kept folders are bounded', async () => {
  const lfs = base()
  let fail = false
  lfs.machine.files = async (_name, path) => { if (fail) throw new Refusal('Unavailable'); return folder([`${path}/a`]) }
  const f = fixture(lfs)
  try {
    const n = R.inspect.KEEP_FOLDERS + 3
    for (let i = 0; i < n; i++) await f.http('GET', `/api/machines/vm/files?path=/d${i}`)
    fail = true
    assert.equal((await f.http('GET', '/api/machines/vm/files?path=/d0')).body.kind, 'refused', 'the oldest kept folder went')
    assert.equal((await f.http('GET', `/api/machines/vm/files?path=/d${n - 1}`)).body.kind, 'folder')
  } finally { f.close() }
})

test('files routes: ?rid= names a read the page can drop (inspect.cancel); the read itself ends when nobody waits', async () => {
  const signals = []
  let release
  const lfs = base()
  lfs.machine.files = (_name, _path, options) => new Promise((resolve, reject) => {
    signals.push(options.signal)
    release = () => resolve(folder(['/a/x']))
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('dropped'), { code: 'Cancelled' })), { once: true })
  })
  const f = fixture(lfs)
  const reads = f.groups.machines.reads
  try {
    const a = f.http('GET', '/api/machines/vm/files?path=/a&rid=a')
    const b = f.http('GET', '/api/machines/vm/files?path=/a&rid=b')
    await tick()
    assert.equal(signals.length, 1)
    assert.equal(reads.cancel('a'), true)
    assert.equal((await a).body.code, 'Cancelled')
    assert.equal(signals[0].aborted, false, 'another caller still waits')
    release()
    assert.equal((await b).body.entries[0].path, '/a/x')
    // a collapsed folder: its only waiter leaves and the read is aborted
    const c = f.http('GET', '/api/machines/vm/files?path=/c&rid=c')
    await tick()
    assert.equal(reads.cancel('c'), true)
    assert.equal((await c).body.code, 'Cancelled')
    assert.equal(signals[1].aborted, true)
    assert.equal(reads.flights, 0)
    // a dropped read keeps nothing: the folder is not answered stale later
    lfs.machine.files = async () => { throw new Refusal('Unavailable') }
    assert.equal((await f.http('GET', '/api/machines/vm/files?path=/c')).body.kind, 'refused')
  } finally { f.close() }
})
