// Route behaviour that depends on the pinned CLI's call table (image inventory,
// image archives), the refusal status map, Sandbox read invalidation after
// writes, Branch paging with main first, and a first Commit's changed paths.
//   node --test test/routes-features.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRoutes, testHost } from './routes-helper.mjs'

const R = await loadRoutes()

class Refusal extends Error {
  constructor(code, message, detail = null) { super(message); Object.assign(this, { code, detail, transport: 'refusal' }) }
}

const entry = (family, call, options = []) => ({ family, call, args: [], options: options.map((name) => ({ name, kind: 'text' })) })
/** The pinned 2.0 table: no machine.images, no force, no image_archive. */
const PINNED = [entry('machine', 'list'), entry('machine', 'stop'), entry('sandbox', 'create', ['image'])]
const FULL = [entry('machine', 'list'), entry('machine', 'images'), entry('machine', 'stop', ['force']), entry('sandbox', 'create', ['image', 'image_archive'])]

function fixture(lfs, calls = PINNED) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-routes-features-'))
  const t = testHost({ lfs, root, home: join(root, 'home'), discovery: async () => ({ identity: { version: '2.0.0-test' }, calls }) })
  const groups = R.createGroups(t.host, async () => ({}))
  return { groups, host: t.host, http: (method, path, body) => R.handle(groups, { method, path, body }), close: () => rmSync(root, { recursive: true, force: true }) }
}

const machineBase = {
  list: async () => ({ machines: [{ name: 'native', platform: 'native', state: 'ready' }] }),
  platforms: async () => ({ host: 'macos', platforms: [] }),
}
const viewLfs = (extra = {}) => ({
  machine: { ...machineBase, ...extra },
  store: { list: async () => ({ items: [] }) },
  sandbox: { list: async () => ({ items: [], next_page_pos: null }) },
})

test('features: the machines view says what the pinned CLI has', async () => {
  const pinned = fixture(viewLfs())
  const full = fixture(viewLfs(), FULL)
  try {
    assert.deepEqual((await pinned.http('GET', '/api/machines')).body.features, { forceStop: false, images: false, imageArchive: false })
    assert.deepEqual((await full.http('GET', '/api/machines')).body.features, { forceStop: true, images: true, imageArchive: true })
  } finally { pinned.close(); full.close() }
})

test('images: a CLI without machine.images answers unsupported, one with it is asked', async () => {
  const inventory = { machine: 'native', mode: 'archive', default_digest: null, images: [] }
  const images = async () => inventory
  const pinned = fixture(viewLfs({ images }))
  const full = fixture(viewLfs({ images }), FULL)
  try {
    const a = await pinned.http('GET', '/api/machines/native/images')
    assert.equal(a.status, 200)
    assert.deepEqual(a.body, { machine: 'native', mode: 'unsupported', default_digest: null, images: [] })
    assert.deepEqual((await full.http('GET', '/api/machines/native/images')).body, inventory)
  } finally { pinned.close(); full.close() }
})

test('image archive: refused before sandbox.create when the CLI has no image_archive', async () => {
  const created = []
  const lfs = {
    project: { get: async (key) => ({ project: key, store: 's1', machine: 'native', kind: 'sqlite' }) },
    sandbox: { create: async (...args) => { created.push(args); return { name: 'b1' } } },
  }
  const pinned = fixture(lfs)
  const full = fixture(lfs, FULL)
  const key = encodeURIComponent('s1/p')
  const image = { archive: '/tmp/image.tar' }
  try {
    const refused = await pinned.http('POST', `/api/projects/${key}/sandboxes`, { name: 'b1', image })
    assert.equal(refused.status, 501)
    assert.equal(refused.body.code, 'Unsupported')
    assert.equal(created.length, 0)
    assert.equal((await pinned.http('POST', `/api/projects/${key}/sandboxes`, { name: 'b1', image: 'sha256:abc' })).status, 200, 'a named image still works')
    assert.equal((await full.http('POST', `/api/projects/${key}/sandboxes`, { name: 'b1', image })).status, 200)
    assert.deepEqual(created.at(-1)[3], { image })
  } finally { pinned.close(); full.close() }
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
