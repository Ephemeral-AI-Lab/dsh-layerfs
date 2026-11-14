// Route behaviour that depends on the pinned CLI's call table (features, the
// Stage-0 sandbox images and create guard, docs/specs/sandbox-images.md), the refusal status map, Sandbox read invalidation after
// writes, Branch paging with main first, and a first Commit's changed paths.
//   node --test test/routes-features.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRoutes, testHost } from './routes-helper.mjs'

const R = await loadRoutes()

class Refusal extends Error {
  constructor(code, message, detail = null) { super(message); Object.assign(this, { code, detail, transport: 'refusal' }) }
}

const entry = (family, call, options = [], kind = 'text') => ({ family, call, args: [], options: options.map((name) => ({ name, kind: name === 'on_progress' ? 'function' : kind })) })
/** The pinned 2.0 table: no machine.images/load/prune, no force, `image` a text option (digests only). */
const PINNED = [entry('machine', 'list'), entry('machine', 'stop'), entry('sandbox', 'create', ['image'])]
/** Stage 1's table: images, load, prune, `image` of kind `image`, progress (plus the identity's `sandbox-runtime`). */
const STAGE1 = [entry('machine', 'list'), entry('machine', 'images'), entry('machine', 'load'), entry('machine', 'prune'), entry('machine', 'stop', ['force']), entry('sandbox', 'create', ['image', 'on_progress'], 'image')]

function fixture(lfs, calls = PINNED, features = []) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-routes-features-'))
  const t = testHost({ lfs, root, home: join(root, 'home'), discovery: async () => ({ identity: { version: '2.0.0-test', features }, calls }) })
  const groups = R.createGroups(t.host, async () => ({}))
  return { groups, host: t.host, events: t.events, logs: t.logs, http: (method, path, body) => R.handle(groups, { method, path, body }), close: () => rmSync(root, { recursive: true, force: true }) }
}

const machineBase = {
  list: async () => ({ machines: [{ name: 'native', platform: 'native', state: 'ready' }] }),
  platforms: async () => ({ host: 'macos', platforms: [] }),
}
const viewLfs = (extra = {}, sandboxes = []) => ({
  machine: { ...machineBase, ...extra },
  store: { list: async () => ({ items: [] }) },
  sandbox: { list: async () => ({ items: sandboxes, next_page_pos: null }) },
})

const NONE = { forceStop: false, images: false, imageLoad: false, imagePrune: false, imageRefs: false, createProgress: false, sandboxRuntime: false, imageStage: 0 }

test('features: the machines view says what the pinned CLI has, Stage 1 only with every piece', async () => {
  const pinned = fixture(viewLfs())
  const almost = fixture(viewLfs(), STAGE1)
  const full = fixture(viewLfs(), STAGE1, ['sandbox-runtime'])
  try {
    assert.deepEqual((await pinned.http('GET', '/api/machines')).body.features, NONE)
    // no `sandbox-runtime` identity feature: everything else is there, still Stage 0 (D11)
    assert.deepEqual((await almost.http('GET', '/api/machines')).body.features, { forceStop: true, images: true, imageLoad: true, imagePrune: true, imageRefs: true, createProgress: true, sandboxRuntime: false, imageStage: 0 })
    assert.deepEqual((await full.http('GET', '/api/machines')).body.features, { forceStop: true, images: true, imageLoad: true, imagePrune: true, imageRefs: true, createProgress: true, sandboxRuntime: true, imageStage: 1 })
  } finally { pinned.close(); almost.close(); full.close() }
})

test('features: featuresOf reads the call table and identity; `image` of kind text is no reference support', async () => {
  const { featuresOf } = R.util
  assert.deepEqual(featuresOf(null), NONE)
  assert.deepEqual(featuresOf({ calls: PINNED, identity: { features: ['sandbox-runtime'] } }), { ...NONE, sandboxRuntime: true })
  const json = [entry('machine', 'images'), entry('machine', 'load'), entry('machine', 'prune'), entry('sandbox', 'create', ['image'], 'json')]
  assert.equal(featuresOf({ calls: json, identity: { features: ['sandbox-runtime'] } }).imageStage, 0, 'the feature branch\'s json `image` is no reference support')
  assert.equal(featuresOf({ calls: STAGE1, identity: { features: ['sandbox-runtime'] } }).imageStage, 1)
})

const hex = (c) => c.repeat(64)
/** A docker-archive tar from `files` (JSON bodies, or Buffers), at `<dir>/<name>`. */
function tarOf(dir, files, name = 'sandbox-image.tar') {
  mkdirSync(dir, { recursive: true })
  for (const [path, body] of Object.entries(files)) { mkdirSync(join(dir, path, '..'), { recursive: true }); writeFileSync(join(dir, path), Buffer.isBuffer(body) ? body : JSON.stringify(body)) }
  execFileSync('tar', ['-cf', join(dir, name), '-C', dir, ...Object.keys(files)])
  return join(dir, name)
}
const arch = process.arch === 'x64' ? 'amd64' : process.arch
const other = arch === 'arm64' ? 'amd64' : 'arm64'
/** A layer tar holding the glibc loader of this host's architecture (a runnable image's). */
function glibcLayer(dir) {
  const loader = arch === 'amd64' ? 'lib64/ld-linux-x86-64.so.2' : 'lib/ld-linux-aarch64.so.1'
  const src = join(dir, 'glibc-src')
  mkdirSync(join(src, loader, '..'), { recursive: true })
  writeFileSync(join(src, loader), '')
  execFileSync('tar', ['-cf', join(dir, 'glibc.tar'), '-C', src, loader])
  return readFileSync(join(dir, 'glibc.tar'))
}

test('sandbox-images: Stage 0 ready rows from the archive a Sandbox runs from (bundle, machine record, native)', async () => {
  const OWN = `sha256:${hex('2')}`
  const records = {}
  const f = fixture(viewLfs({ get: async (name) => records[name] }, [
    { name: 'b1', machine: 'docker', image: `sha256:${hex('1')}` }, { name: 'b2', machine: 'docker', image: `sha256:${hex('1')}` },
    { name: 'b3', machine: 'vm', image: `sha256:${hex('4')}` }, { name: 'b4', machine: 'other', image: `sha256:${hex('1')}` },
  ]))
  const bundle = join(f.host.root, 'bundle')
  const glibc = glibcLayer(f.host.root)
  tarOf(bundle, { [`blobs/sha256/${hex('1')}`]: { os: 'linux', architecture: arch }, 'layer.tar': glibc, 'manifest.json': [{ Config: `blobs/sha256/${hex('1')}`, Layers: ['layer.tar'] }] })
  const many = tarOf(join(f.host.root, 'many'), {
    [`blobs/sha256/${hex('3')}`]: { os: 'linux', architecture: other }, [`blobs/sha256/${hex('4')}`]: { os: 'linux', architecture: arch }, [`blobs/sha256/${hex('5')}`]: { os: 'linux', architecture: arch }, [`blobs/sha256/${hex('7')}`]: { os: 'linux', architecture: arch },
    'layer.tar': glibc, 'musl.tar': Buffer.alloc(1024),
    'manifest.json': [
      { Config: `blobs/sha256/${hex('3')}`, RepoTags: ['web:1'], Layers: ['layer.tar'] },
      { Config: `blobs/sha256/${hex('4')}`, RepoTags: ['api:1', 'api:latest'], Layers: ['layer.tar'] },
      { Config: `blobs/sha256/${hex('7')}`, RepoTags: ['alpine:1'], Layers: ['musl.tar'] },
      { Config: `blobs/sha256/${hex('5')}`, RepoTags: ['db:1'], Layers: ['layer.tar'] },
    ],
  })
  Object.assign(records, {
    docker: { name: 'docker', platform: 'docker', state: 'running', image: 'debian:13' },
    pinnedvm: { name: 'pinnedvm', platform: 'lima', state: 'stopped', image: OWN },
    vm: { name: 'vm', platform: 'lima', state: 'stopped', image: many },
    native: { name: 'native', platform: 'native', state: 'ready' },
  })
  f.host.bundle = () => bundle
  const get = async (name) => (await f.http('GET', `/api/machines/${name}/sandbox-images`)).body
  try {
    // docker's record image is its worker container's, never a Sandbox image: the bundle's archive
    const docker = await get('docker')
    assert.deepEqual({ ...docker, observedAt: 0 }, {
      machine: 'docker', platform: 'docker', state: 'running', stage: 0, free: null, docker: null, observedAt: 0,
      mode: 'images', architecture: arch, default: `sha256:${hex('1')}`, stale: false,
      ready: [{ id: `sha256:${hex('1')}`, name: 'LayerFS default', refs: [], size: glibc.length, source: 'bundle', sandboxes: 2, lastUsed: null, usable: true }],
    })
    // a stopped VM answers too (the archive is read on this host); its record digest is not a row: the bundle's only image
    const pinned = await get('pinnedvm')
    assert.deepEqual([pinned.state, pinned.default, pinned.ready.map((r) => r.id)], ['stopped', `sha256:${hex('1')}`, [`sha256:${hex('1')}`]])
    // a VM's own archive of several: rows in manifest order, a wrong architecture unusable, the first usable row preselected
    const vm = await get('vm')
    assert.deepEqual(vm.ready.map((r) => [r.name, r.refs, r.source, r.usable, r.reason ?? null, r.sandboxes]), [
      ['web:1', ['web:1'], 'machine', false, { kind: 'arch', value: other }, 0],
      ['api:latest', ['api:1', 'api:latest'], 'machine', true, null, 1],
      ['alpine:1', ['alpine:1'], 'machine', false, { kind: 'no-glibc' }, 0],
      ['db:1', ['db:1'], 'machine', true, null, 0],
    ])
    assert.equal(vm.ready[1].size, glibc.length)
    assert.equal(vm.default, `sha256:${hex('4')}`)
    // the record's digest wins when it is a usable row
    records.vm = { ...records.vm, image_archive: many, image: `sha256:${hex('5')}` }
    assert.equal((await get('vm')).default, `sha256:${hex('5')}`)
    const native = await get('native')
    assert.equal(native.mode, process.platform === 'linux' ? 'images' : 'host')
    if (process.platform !== 'linux') assert.deepEqual([native.ready, native.default, native.docker], [[], null, null])
  } finally { f.close() }
})

test('sandbox-images: an unreadable archive answers the kept rows marked stale, else none', async () => {
  const records = { vm: { name: 'vm', platform: 'lima', state: 'running' } }
  const f = fixture(viewLfs({ get: async (name) => records[name] }))
  const archive = tarOf(join(f.host.root, 'a'), { [`blobs/sha256/${hex('6')}`]: { os: 'linux', architecture: arch }, 'layer.tar': glibcLayer(f.host.root), 'manifest.json': [{ Config: `blobs/sha256/${hex('6')}`, RepoTags: ['x:1'], Layers: ['layer.tar'] }] })
  const get = async (name) => (await f.http('GET', `/api/machines/${name}/sandbox-images`)).body
  try {
    records.vm.image = join(f.host.root, 'missing.tar')
    const none = await get('vm')
    assert.deepEqual([none.ready, none.default, none.stale.code], [[], null, 'ENOENT'])
    records.vm.image = archive
    const good = await get('vm')
    assert.equal(good.stale, false)
    rmSync(archive)
    const stale = await get('vm')
    assert.deepEqual(stale.ready, good.ready)
    assert.equal(stale.default, `sha256:${hex('6')}`)
    assert.equal(stale.stale.at, good.observedAt)
    // no pinned bundle and no archive of its own: no rows, not stale
    records.vm.image = null
    assert.deepEqual([(await get('vm')).ready, (await get('vm')).stale], [[], false])
  } finally { f.close() }
})

test('sandbox-images: the default rule (record digest if usable, else the only usable row, else the first usable)', () => {
  const { defaultOf } = R.machinesModule
  const row = (id, usable = true) => ({ id, usable })
  assert.equal(defaultOf([], 'sha256:a'), null)
  assert.equal(defaultOf([row('a'), row('b')], 'sha256:z'), 'a')
  assert.equal(defaultOf([row('a', false), row('b')], 'b'), 'b')
  assert.equal(defaultOf([row('a', false), row('b')], 'a'), 'b', 'an unusable record digest is not preselected')
  assert.equal(defaultOf([row('a', false)], null), null)
})

test('prune-images: 501 Unsupported until the CLI has machine.prune; never logged as a fault', async () => {
  const f = fixture(viewLfs())
  try {
    const answer = await f.http('POST', '/api/machines/vm/prune-images', { unused: true })
    assert.equal(answer.status, 501)
    assert.equal(answer.body.code, 'Unsupported')
    assert.equal(answer.body.detail.need, 'image-prune')
    assert.deepEqual(f.logs, [])
    for (const path of ['/api/docker-images', '/api/machines/vm/images']) assert.equal((await f.http('GET', path)).status, 404, `${path} is gone`)
    assert.equal((await f.http('POST', '/api/machines/vm/default-image', { digest: `sha256:${hex('1')}` })).status, 404)
  } finally { f.close() }
})

test('create: Stage 0 takes a full digest only (501 image-refs before any call); Stage 1 passes a reference through', async () => {
  const created = []
  const lfs = {
    project: { get: async (key) => ({ project: key, store: 's1', machine: 'native', kind: 'sqlite' }) },
    sandbox: { create: async (...args) => { created.push(args); return { name: args[1] } } },
  }
  const pinned = fixture(lfs)
  const stage1 = fixture(lfs, STAGE1, ['sandbox-runtime'])
  const key = encodeURIComponent('s1/p')
  const DIG = `sha256:${hex('a')}`
  try {
    for (const image of ['postgres:17', 'sha256:abc', `sha256:${hex('A')}`]) {
      const refused = await pinned.http('POST', `/api/projects/${key}/sandboxes`, { name: 'b1', image })
      assert.equal(refused.status, 501, image)
      assert.deepEqual([refused.body.code, refused.body.detail], ['Unsupported', { need: 'image-refs' }])
    }
    // the object form is gone
    assert.equal((await pinned.http('POST', `/api/projects/${key}/sandboxes`, { name: 'b1', image: { archive: '/tmp/x.tar' } })).status, 400)
    assert.equal(created.length, 0)
    assert.deepEqual(pinned.logs, [], 'expected refusals log no stack')
    assert.equal((await pinned.http('POST', `/api/projects/${key}/sandboxes`, { name: 'b1', image: DIG })).status, 200)
    assert.deepEqual(created.at(-1), ['s1/p', 'b1', 'native', { image: DIG }])
    assert.equal((await pinned.http('POST', `/api/projects/${key}/sandboxes`, { name: 'b2' })).status, 200)
    assert.deepEqual(created.at(-1), ['s1/p', 'b2', 'native', {}])
    assert.equal((await stage1.http('POST', `/api/projects/${key}/sandboxes`, { name: 'b3', image: 'postgres:17' })).status, 200)
    const [, , , options] = created.at(-1)
    assert.deepEqual([created.at(-1).slice(0, 3), options.image, typeof options.on_progress], [['s1/p', 'b3', 'native'], 'postgres:17', 'function'], 'the reference as it was picked, with progress')
  } finally { pinned.close(); stage1.close() }
})

test('create: start runs machine.start first (machine-progress), then sandbox.create', async () => {
  const order = []
  const lfs = {
    project: { get: async (key) => ({ project: key, store: 's1', machine: 'lima1', kind: 'sqlite' }) },
    machine: { start: async (name, { on_progress }) => { order.push(`start ${name}`); on_progress({ stage: 'boot' }); return { name } } },
    sandbox: { create: async (project, name) => { order.push(`create ${name}`); return { name } } },
  }
  const f = fixture(lfs)
  try {
    assert.equal((await f.http('POST', `/api/projects/${encodeURIComponent('s1/p')}/sandboxes`, { name: 'b1', start: true })).status, 200)
    assert.deepEqual(order, ['start lima1', 'create b1'])
    assert.ok(f.events.some((e) => e.type === 'machine-progress' && e.data.name === 'lima1'))
    await f.http('POST', `/api/projects/${encodeURIComponent('s1/p')}/sandboxes`, { name: 'b2' })
    assert.deepEqual(order.slice(2), ['create b2'], 'no start without start: true')
  } finally { f.close() }
})

test('status map: LayerFS and host refusals that are not server faults', async () => {
  const cases = { NotMounted: 409, StaleSandbox: 409, Cancelled: 409, NoStore: 404, NoSuchBucket: 404, Timeout: 504, ProjectIdentityChanged: 409 }
  for (const [code, status] of Object.entries(cases)) {
    const f = fixture({ sandbox: { get: async () => { throw new Refusal(code, code) } } })
    try {
      const answer = await f.http('GET', '/api/sandboxes/b1')
      assert.equal(answer.status, status, code)
      assert.equal(answer.body.code, code)
    } finally { f.close() }
  }
  const f = fixture({})
  try {
    assert.equal((await f.http('POST', '/api/stores', '{')).body.code, 'InvalidInput')
    assert.equal((await f.http('GET', '/api/nothing')).body.code, 'NotFound')
  } finally { f.close() }
})

test('errors: NoSpace is 507 with its detail; Unavailable, NoSpace and Unsupported log no stack, Unknown and Timeout do', async () => {
  assert.deepEqual(R.errorAnswer(new Refusal('NoSpace', 'need more', { need: 10, free: 1 })), { status: 507, body: { code: 'NoSpace', transport: 'refusal', message: 'need more', detail: { need: 10, free: 1 } } })
  for (const [code, status, logged] of [['Unavailable', 502, false], ['NoSpace', 507, false], ['Unsupported', 501, false], ['MountsActive', 409, false], ['Unknown', 500, true], ['Timeout', 504, true]]) {
    const f = fixture({ sandbox: { get: async () => { throw new Refusal(code, code) } } })
    try {
      assert.equal((await f.http('GET', '/api/sandboxes/b1')).status, status, code)
      assert.equal(f.logs.length > 0, logged, code)
    } finally { f.close() }
  }
})

test('Sandbox reads: a cached Busy refusal is dropped by mount, unmount, commit and close', async () => {
  let busy = true
  let reads = 0
  const lfs = {
    sandbox: {
      get: async () => { reads++; if (busy) throw new Refusal('Busy', 'held'); return { name: 'b1', project: 's1/p', workspaces: [], next_page_pos: null } },
      close: async () => ({ kind: 'Closed' }),
    },
    workspace: { mount: async () => ({ ws: 'b1:w' }), unmount: async () => ({}), commit: async () => ({ id: 'c' }) },
  }
  const f = fixture(lfs)
  const busyAgain = async () => {
    busy = true
    assert.equal((await f.http('GET', '/api/sandboxes/b1')).status, 409)
    const before = reads
    assert.equal((await f.http('GET', '/api/sandboxes/b1')).status, 409)
    assert.equal(reads, before, 'Busy answers from the cache')
    busy = false
  }
  try {
    for (const write of [
      () => f.http('POST', '/api/sandboxes/b1/workspaces', { branch: 'side' }),
      () => f.http('DELETE', `/api/workspaces/${encodeURIComponent('b1:w')}?force=1`),
      () => f.http('POST', `/api/workspaces/${encodeURIComponent('b1:w')}/commit`, {}),
      () => f.http('DELETE', '/api/sandboxes/b1?force=1'),
    ]) {
      await busyAgain()
      assert.equal((await write()).status, 200)
      const before = reads
      assert.equal((await f.http('GET', '/api/sandboxes/b1')).status, 200, 'the write cleared the Busy answer')
      assert.equal(reads, before + 1)
    }
  } finally { f.close() }
})

test('Branches: main first on page 0 and never again, however many pages', async () => {
  const head = 'c'.repeat(66)
  const listed = [
    { items: [{ name: 'dsh.session.a', head }, { name: 'dsh.session.b', head }], next_page_pos: 2 },
    { items: [{ name: 'main', base: head }, { name: 'side', head }], next_page_pos: null },
  ]
  const lfs = { branch: { list: async (_p, { page_pos }) => listed[page_pos ? 1 : 0], get: async (_p, name) => ({ name, base: head }) } }
  const f = fixture(lfs)
  const key = encodeURIComponent('s1/p')
  try {
    const h0 = await f.http('GET', `/api/projects/${key}/history`)
    const h1 = await f.http('GET', `/api/projects/${key}/history?pos=2`)
    assert.deepEqual([...h0.body.branches, ...h1.body.branches].map((b) => b.name), ['main', 'dsh.session.a', 'dsh.session.b', 'side'])
    assert.equal(h0.body.next, 2)
    const b0 = await f.http('GET', `/api/projects/${key}/branches`)
    const b1 = await f.http('GET', `/api/projects/${key}/branches?pos=2`)
    assert.deepEqual([...b0.body.items, ...b1.body.items].map((b) => b.name), ['main', 'dsh.session.a', 'dsh.session.b', 'side'])
    assert.equal(b0.body.items[0].head, head)
  } finally { f.close() }
})

test('Commits: a Branch\'s first Commit diffs against its base Layer', async () => {
  const layer = `32${'a'.repeat(64)}`
  const diffs = []
  const lfs = {
    branch: {
      get: async (_p, name) => ({ name, forked_from: null }),
      commits: async () => ({ items: [{ id: 'c2', parent: 'c1', base: layer }, { id: 'c1', parent: null, base: layer }], has_more: false }),
    },
    commit: { diff: async (_p, from, to) => { diffs.push([from, to]); return { items: [{ path: `/${to}.txt`, kind: 'Added' }], next_cursor: null } } },
  }
  const f = fixture(lfs)
  try {
    const answer = await f.http('GET', `/api/projects/${encodeURIComponent('s1/p')}/commits?branch=side`)
    assert.equal(answer.status, 200)
    assert.deepEqual(diffs.sort(), [[layer, 'c1'], ['c1', 'c2']])
    assert.deepEqual(answer.body.map((c) => c.changes), [[{ path: '/c2.txt', kind: 'added' }], [{ path: '/c1.txt', kind: 'added' }]])
  } finally { f.close() }
})

test('client api: a Remote call lost after it was sent is tagged transport-unknown', async (t) => {
  const { build } = await import('esbuild')
  const { pathToFileURL } = await import('node:url')
  const root = new URL('..', import.meta.url).pathname
  const out = mkdtempSync(join(tmpdir(), 'dsh-api-'))
  t.after(() => rmSync(out, { recursive: true, force: true }))
  await build({ absWorkingDir: root, stdin: { contents: "export { createApi, HostError } from './src/client/api.ts'", resolveDir: root, loader: 'ts' }, outfile: join(out, 'api.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24', logLevel: 'warning' })
  const { createApi } = await import(pathToFileURL(join(out, 'api.mjs')).href)
  const events = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }), dispose() {} }
  const api = createApi(() => ({ call: async () => { throw new Error('connection reset') }, events: () => events }), { openPanel() {}, openWorkspace: async () => {}, openSession() {} }, () => undefined)
  try {
    await assert.rejects(api.call('POST', '/api/machines/a/stop'), (e) => e.code === 'no-host' && e.status === 0 && e.transport === 'transport-unknown')
  } finally { api.dispose() }
})

/** The client API over a fake Remote whose event stream the test drops and reopens, and whose calls it answers by hand. */
async function droppableApi(t) {
  const { build } = await import('esbuild')
  const { pathToFileURL } = await import('node:url')
  const root = new URL('..', import.meta.url).pathname
  const out = mkdtempSync(join(tmpdir(), 'dsh-api-'))
  t.after(() => rmSync(out, { recursive: true, force: true }))
  await build({ absWorkingDir: root, stdin: { contents: "export { createApi, HostError, GET_TIMEOUT_MS } from './src/client/api.ts'", resolveDir: root, loader: 'ts' }, outfile: join(out, 'api.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24', logLevel: 'warning' })
  const mod = await import(pathToFileURL(join(out, 'api.mjs')).href)
  // Each events() call is one connection: it says `ready`, then ends when the test drops it.
  let end = () => {}
  const stream = () => {
    const queue = [{ type: 'ready' }]
    let wake = null
    end = () => { queue.push(null); wake?.() }
    return {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          while (!queue.length) await new Promise((r) => { wake = r })
          const item = queue.shift()
          return item === null ? { done: true, value: undefined } : { done: false, value: item }
        },
      }),
      dispose() {},
    }
  }
  const sent = []
  const remote = { call: (req) => new Promise((resolve) => sent.push({ req, answer: (body) => resolve({ ok: true, value: { status: 200, body } }) })), events: stream }
  const api = mod.createApi(() => remote, { openPanel() {}, openWorkspace: async () => {}, openSession() {} }, () => undefined)
  t.after(() => api.dispose())
  const connected = () => new Promise((resolve) => { if (api.connected()) resolve(); else { const off = api.onEvent('connection', (e) => { if (e.data?.connected) { off(); resolve() } }) } })
  await connected()
  return { api, mod, sent, drop: () => end(), connected, tick: () => new Promise((r) => setTimeout(r, 0)) }
}

test('client api: a GET whose connection drops is sent again once the host is back, and answers', async (t) => {
  const { api, sent, drop } = await droppableApi(t)
  const reply = api.call('GET', '/api/storage')
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(sent.length, 1)
  drop()
  // The stream reconnects after its back-off (500 ms); the read goes out again then.
  for (let i = 0; i < 300 && sent.length < 2; i++) await new Promise((r) => setTimeout(r, 10))
  assert.equal(sent.length, 2, 'the read was re-sent on the new connection')
  assert.equal(api.connected(), true)
  assert.deepEqual(sent[1].req, sent[0].req)
  sent[1].answer({ stores: [] })
  assert.deepEqual(await reply, { stores: [] })
})

test('client api: a write whose connection drops fails as transport-unknown and is never re-sent', async (t) => {
  const { api, sent, drop, connected } = await droppableApi(t)
  const reply = api.call('POST', '/api/machines/a/stop')
  await new Promise((r) => setTimeout(r, 10))
  drop()
  await assert.rejects(reply, (e) => e.code === 'no-host' && e.status === 0 && e.transport === 'transport-unknown')
  await connected()
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(sent.length, 1)
})

test('client api: a named operation whose connection drops fails instead of waiting forever', async (t) => {
  const { api, drop } = await droppableApi(t)
  const reply = api.op('session.state', { sessionId: 's' })
  await new Promise((r) => setTimeout(r, 10))
  drop()
  await assert.rejects(reply, (e) => e.code === 'no-host' && e.transport === 'transport-unknown')
})

test('client api: a GET that never answers fails after its budget', async (t) => {
  const { api, mod, sent } = await droppableApi(t)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const reply = api.call('GET', '/api/storage')
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  assert.equal(sent.length, 1)
  t.mock.timers.tick(mod.GET_TIMEOUT_MS + 1)
  await assert.rejects(reply, (e) => e.code === 'timeout' && e.transport === 'transport-unknown')
})

// ---------------------------------------------------------------- Stage 1 (docs/specs/sandbox-images.md §4.1)

const PG = `sha256:${hex('d')}`, BUNDLE = `sha256:${hex('b')}`, UB = `sha256:${hex('c')}`
/** machine.images as LayerFS answers it at Stage 1 (§3 R2 plus the Docker part LayerFS lists, dedupes and sizes). */
const imagesAnswer = (extra = {}) => ({
  machine: 'lima1', mode: 'images', default: BUNDLE, free: 5e9,
  images: [
    { id: BUNDLE, refs: [`layerfs-cache/sandbox:${hex('b')}`], size: 310e6, architecture: arch, source: 'bundle', sandboxes: 1, last_used: null },
    { id: UB, refs: ['ubuntu:24.04'], size: 780e6, architecture: arch, source: 'imported', sandboxes: 2, last_used: '2026-11-13T10:00:00Z' },
  ],
  docker: { available: true },
  available: [
    { id: PG, refs: ['postgres:17-bookworm'], size: 412e6, os: 'linux', architecture: arch, usable: true, need: 865_200_000, fits: true },
    { id: `sha256:${hex('e')}`, refs: ['mssql:2022'], size: 1.5e9, os: 'linux', architecture: other, usable: false, reason: { kind: 'arch', value: other }, need: 3_150_000_000, fits: true },
  ],
  ...extra,
})
function stage1Fixture({ images = async () => imagesAnswer(), prune, create } = {}) {
  const calls = []
  const lfs = {
    project: { get: async (key) => ({ project: key, store: 's1', machine: 'lima1', kind: 'sqlite' }) },
    machine: {
      ...machineBase,
      get: async (name) => ({ name, platform: name === 'docker' ? 'docker' : 'lima', state: 'running' }),
      images: async (...args) => { calls.push(['images', ...args]); return images(...args) },
      prune: async (...args) => { calls.push(['prune', ...args]); return prune(...args) },
    },
    store: { list: async () => ({ items: [] }) },
    sandbox: { list: async () => ({ items: [], next_page_pos: null }), create: async (...args) => { calls.push(['create', ...args]); return create ? create(...args) : { name: args[1] } } },
  }
  return { ...fixture(lfs, STAGE1, ['sandbox-runtime']), calls }
}

test('sandbox-images Stage 1: ready rows, free, default and the Docker group come from machine.images as LayerFS answers them', async () => {
  const f = stage1Fixture()
  try {
    const answer = (await f.http('GET', '/api/machines/lima1/sandbox-images')).body
    assert.deepEqual({ ...answer, observedAt: 0 }, {
      machine: 'lima1', platform: 'lima', state: 'running', stage: 1, mode: 'images', architecture: arch, free: 5e9,
      // D7: the newest last_used wins over LayerFS's default
      default: UB, observedAt: 0, stale: false,
      ready: [
        { id: BUNDLE, name: 'LayerFS default', refs: [], size: 310e6, source: 'bundle', sandboxes: 1, lastUsed: null, usable: true },
        { id: UB, name: 'ubuntu:24.04', refs: ['ubuntu:24.04'], size: 780e6, source: 'imported', sandboxes: 2, lastUsed: '2026-11-13T10:00:00Z', usable: true },
      ],
      docker: { available: true, images: [
        { id: PG, name: 'postgres:17-bookworm', refs: ['postgres:17-bookworm'], size: 412e6, architecture: arch, os: 'linux', need: 865_200_000, fits: true, usable: true },
        { id: `sha256:${hex('e')}`, name: 'mssql:2022', refs: ['mssql:2022'], size: 1.5e9, architecture: other, os: 'linux', need: 3_150_000_000, fits: true, usable: false, reason: { kind: 'arch', value: other } },
      ] },
    })
    assert.deepEqual(f.calls.filter(([c]) => c === 'images'), [['images', 'lima1']], 'one machine.images read; the plugin never reads Docker')
  } finally { f.close() }
})

test('sandbox-images Stage 1: Docker off, LayerFS default without last_used, epoch last_used, macOS native host mode', async () => {
  let answer = imagesAnswer({ docker: { available: false, reason: 'not-running', message: 'Cannot connect to the Docker daemon' }, available: [] })
  answer.images[1].last_used = null
  const f = stage1Fixture({ images: async () => answer })
  try {
    const off = (await f.http('GET', '/api/machines/lima1/sandbox-images')).body
    assert.deepEqual(off.docker, { available: false, reason: 'not-running', message: 'Cannot connect to the Docker daemon' })
    assert.equal(off.default, BUNDLE, 'never used: LayerFS\'s own default')
    answer = imagesAnswer({ docker: { available: false, reason: 'weird' } })
    answer.images[1].last_used = 1_700_000_000
    const odd = (await f.http('GET', '/api/machines/lima1/sandbox-images')).body
    assert.deepEqual(odd.docker, { available: false, reason: 'error' })
    assert.equal(odd.ready[1].lastUsed, new Date(1_700_000_000_000).toISOString(), 'epoch seconds as ISO')
    answer = { machine: 'lima1', mode: 'host', images: [], docker: null, available: [] }
    const host = (await f.http('GET', '/api/machines/lima1/sandbox-images')).body
    assert.deepEqual([host.mode, host.stage, host.ready, host.docker, host.default], ['host', 1, [], null, null])
    answer = imagesAnswer({ docker: null, available: [] })
    assert.equal((await f.http('GET', '/api/machines/lima1/sandbox-images')).body.docker, null, 'no Docker part: no group')
  } finally { f.close() }
})

test('sandbox-images Stage 1: a stopped machine (Unavailable) answers the kept answer marked stale, else none', async () => {
  let refuse = false
  const f = stage1Fixture({ images: async () => { if (refuse) throw new Refusal('Unavailable', 'machine lima1 is stopped', { what: 'machine' }); return imagesAnswer() } })
  try {
    refuse = true
    const none = (await f.http('GET', '/api/machines/lima1/sandbox-images')).body
    assert.deepEqual([none.ready, none.docker, none.free, none.default, none.stale.code], [[], null, null, null, 'Unavailable'])
    refuse = false
    const good = (await f.http('GET', '/api/machines/lima1/sandbox-images')).body
    refuse = true
    const kept = (await f.http('GET', '/api/machines/lima1/sandbox-images')).body
    assert.deepEqual([kept.ready, kept.docker, kept.free, kept.default], [good.ready, good.docker, good.free, good.default])
    assert.deepEqual(kept.stale, { at: good.observedAt, code: 'Unavailable', message: 'machine lima1 is stopped' })
    assert.deepEqual(f.logs, [])
  } finally { f.close() }
})

test('sandbox-images Stage 1: a worker of another LayerFS build is WorkerOutdated (message kept), not a stopped machine', async () => {
  const message = 'machine docker is of another build (2.0.0+abc); stop it and start it again to replace its worker'
  let refuse = false
  const f = stage1Fixture({ images: async () => { if (refuse) throw new Refusal('Unavailable', message, { what: 'machine' }); return imagesAnswer() } })
  try {
    refuse = true
    const none = (await f.http('GET', '/api/machines/lima1/sandbox-images')).body
    assert.equal(none.state, 'running')
    assert.deepEqual([none.ready, none.stale.code, none.stale.message], [[], 'WorkerOutdated', message])
    refuse = false
    const good = (await f.http('GET', '/api/machines/lima1/sandbox-images')).body
    refuse = true
    const kept = (await f.http('GET', '/api/machines/lima1/sandbox-images')).body
    assert.deepEqual([kept.ready, kept.docker], [good.ready, good.docker], 'the kept answer, Docker group included')
    assert.equal(kept.stale.code, 'WorkerOutdated')
    assert.deepEqual(R.machinesModule.staleOf(new Refusal('Unavailable', 'machine lima1 is stopped'), 1), { at: 1, code: 'Unavailable', message: 'machine lima1 is stopped' })
    assert.equal(R.machinesModule.staleOf(new Refusal('Busy', 'replace its worker later'), 1).code, 'Busy', 'only Unavailable')
    assert.deepEqual(f.logs, [])
  } finally { f.close() }
})

test('sandbox-images Stage 1: an image is named by its :latest ref, else its first; every ref listed', async () => {
  const answer = imagesAnswer()
  answer.images[1].refs = ['alpine:3', 'alpine:latest']
  answer.available[0].refs = ['postgres:17', 'postgres:latest', 'postgres:17-bookworm']
  answer.available[1].refs = ['mssql:2022', 'mssql:2022-cu1']
  const f = stage1Fixture({ images: async () => answer })
  try {
    const got = (await f.http('GET', '/api/machines/lima1/sandbox-images')).body
    assert.deepEqual([got.ready[1].name, got.ready[1].refs], ['alpine:latest', ['alpine:3', 'alpine:latest']])
    assert.deepEqual(got.docker.images.map((r) => r.name), ['postgres:latest', 'mssql:2022'])
    assert.equal(got.docker.images[0].refs.length, 3)
  } finally { f.close() }
})

test('prune-images Stage 1: per id, a refused image listed (InUse) without failing the rest; unused; nothing named is refused', async () => {
  const f = stage1Fixture({
    prune: async (name, image) => {
      if (typeof image === 'object') return { removed: [PG, UB], freed: 900 }
      if (image === UB) throw new Refusal('InUse', 'ubuntu:24.04 is used by 2 Sandboxes')
      return { removed: [image], freed: 400 }
    },
  })
  try {
    const answer = await f.http('POST', '/api/machines/lima1/prune-images', { images: [PG, UB, PG] })
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, { removed: [PG], freed: 400, refused: [{ id: UB, code: 'InUse', message: 'ubuntu:24.04 is used by 2 Sandboxes' }] })
    assert.deepEqual(f.calls.filter(([c]) => c === 'prune'), [['prune', 'lima1', PG], ['prune', 'lima1', UB]], 'once per id')
    assert.deepEqual((await f.http('POST', '/api/machines/lima1/prune-images', { unused: true })).body, { removed: [PG, UB], freed: 900, refused: [] })
    assert.deepEqual(f.calls.at(-1), ['prune', 'lima1', { unused: true }])
    assert.equal((await f.http('POST', '/api/machines/lima1/prune-images', {})).status, 400)
  } finally { f.close() }
  const g = stage1Fixture({ prune: async () => { throw new Refusal('Unavailable', 'machine lima1 is stopped') } })
  try {
    const answer = await g.http('POST', '/api/machines/lima1/prune-images', { images: [PG] })
    assert.deepEqual([answer.status, answer.body.code], [502, 'Unavailable'], 'a machine-wide refusal fails the request')
  } finally { g.close() }
})

test('create Stage 1: NoSpace precheck (507, before any create or job) only for a Docker image that does not fit', async () => {
  let answer = imagesAnswer({ free: 5e8 })
  const f = stage1Fixture({ images: async () => answer })
  const key = encodeURIComponent('s1/p')
  try {
    for (const image of [PG, 'postgres:17-bookworm']) {
      for (const background of [false, true]) {
        const refused = await f.http('POST', `/api/projects/${key}/sandboxes`, { name: 'b1', image, background })
        assert.equal(refused.status, 507, `${image} ${background}`)
        assert.deepEqual([refused.body.code, refused.body.detail], ['NoSpace', { need: 865_200_000, free: 5e8 }])
      }
    }
    assert.equal(f.calls.filter(([c]) => c === 'create').length, 0)
    assert.deepEqual(f.events.filter((e) => e.type === 'sandbox-progress'), [], 'no job admitted')
    assert.deepEqual(f.logs, [], 'an expected refusal logs no stack')
    // a ready image needs no copy; an unknown name is LayerFS's to judge
    for (const image of [UB, 'ubuntu:24.04', 'nothing:here']) assert.equal((await f.http('POST', `/api/projects/${key}/sandboxes`, { name: `r${image.length}`, image })).status, 200, image)
    answer = imagesAnswer({ free: 5e9 })
    assert.equal((await f.http('POST', `/api/projects/${key}/sandboxes`, { name: 'fits', image: PG })).status, 200, 'fits')
    answer = imagesAnswer({ free: null })
    assert.equal((await f.http('POST', `/api/projects/${key}/sandboxes`, { name: 'unknown', image: PG })).status, 200, 'free unknown: no precheck')
  } finally { f.close() }
})

test('create Stage 1: the CLI\'s phases become the job\'s (bytes coalesced), unknown events ignored, refusals kept with detail', async () => {
  const f = stage1Fixture({
    create: async (project, name, machine, { on_progress }) => {
      for (const p of [{ phase: 'inspect' }, { phase: 'export' }, { phase: 'send', done: 0, total: 412 }, { phase: 'send', done: 100, total: 412 }, { stage: 'other' }, { phase: 'unpack' }, { phase: 'start' }]) on_progress(p)
      if (name === 'bad') throw new Refusal('Unsupported', 'arm64 machine, amd64 image', { reason: 'arch', value: 'amd64' })
      return { name }
    },
  })
  const key = encodeURIComponent('s1/p')
  const settle = () => new Promise((r) => setTimeout(r, 20))
  try {
    const job = (await f.http('POST', `/api/projects/${key}/sandboxes`, { name: 'b1', image: PG, background: true })).body.creation
    await settle()
    const seen = f.events.filter((e) => e.type === 'sandbox-progress' && e.data.creation.id === job.id).map((e) => [e.data.creation.phase, e.data.creation.done ?? null])
    assert.deepEqual(seen, [['queued', null], ['inspect', null], ['export', null], ['send', 0], ['unpack', null], ['start', null], ['done', null]], 'phase changes at once; the second send held (500 ms) and dropped by unpack')
    const bad = (await f.http('POST', `/api/projects/${key}/sandboxes`, { name: 'bad', image: PG, background: true })).body.creation
    await settle()
    const failed = (await f.http('GET', '/api/sandbox-creates')).body.creations.find((c) => c.id === bad.id)
    assert.deepEqual(failed.error, { code: 'Unsupported', message: 'arm64 machine, amd64 image', detail: { reason: 'arch', value: 'amd64' } })
  } finally { f.close() }
})

test('create: no on_progress option when the CLI declares none (Stage 0 sends exactly what it did)', async () => {
  const created = []
  const lfs = {
    project: { get: async (key) => ({ project: key, store: 's1', machine: 'native', kind: 'sqlite' }) },
    sandbox: { create: async (...args) => { created.push(args); return { name: args[1] } } },
  }
  const f = fixture(lfs)
  try {
    await f.http('POST', `/api/projects/${encodeURIComponent('s1/p')}/sandboxes`, { name: 'b1', image: `sha256:${hex('a')}` })
    assert.deepEqual(created, [['s1/p', 'b1', 'native', { image: `sha256:${hex('a')}` }]])
  } finally { f.close() }
})
