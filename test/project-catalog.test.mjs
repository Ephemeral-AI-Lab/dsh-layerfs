import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const root = new URL('..', import.meta.url).pathname
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-catalog-'))
await build({ entryPoints: [join(root, 'src/host/sessions/catalog.ts')], outfile: join(out, 'catalog.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24' })
const { ProjectCatalog, uuidOfBranches, identityBranch } = await import(pathToFileURL(join(out, 'catalog.mjs')))
test.after(() => rmSync(out, { recursive: true, force: true }))

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const fail = (code) => Object.assign(new Error(code), { code })
const info = (key, created = 100, machine = 'native') => ({ project: key, store: key.split('/')[0], name: key.split('/')[1], kind: 'sqlite', machine, created })

/** A fake LayerFS: projects by address, each with its branch names. */
function fixture() {
  const dir = mkdtempSync(join(root, '.dev-test-catalog-'))
  const state = { projects: new Map([['store/app', { info: info('store/app'), branches: ['main'] }]]), offline: null, forks: 0, beforeFork: null }
  const project = (key) => {
    if (state.offline) throw fail('Unavailable')
    const p = state.projects.get(key)
    if (!p) throw fail('NoSuchProject')
    return p
  }
  const lfs = {
    project: {
      list: async () => { if (state.offline === 'global') throw fail('Unavailable'); return { items: state.offline ? [] : [...state.projects.values()].map((p) => p.info) } },
      get: async (key) => project(key).info,
    },
    branch: {
      list: async (key) => ({ items: project(key).branches.map((name) => ({ name })) }),
      fork: async (key, name, from) => {
        const p = project(key)
        state.forks++
        state.beforeFork?.(p)
        if (!p.branches.includes(from)) throw fail('NoSuchBranch')
        if (p.branches.includes(name)) throw fail('BranchExists')
        p.branches.push(name)
        return {}
      },
    },
    store: { status: async () => ({ state: state.offline ? 'down' : 'idle' }) },
  }
  return { state, dir, catalog: new ProjectCatalog(() => lfs, dir), close: () => rmSync(dir, { recursive: true, force: true }) }
}

test('the identity is the smallest UUID among dsh.project.* branches', () => {
  assert.equal(uuidOfBranches(['main', identityBranch(B), identityBranch(A), 'dsh.project.not-a-uuid']), A)
  assert.equal(uuidOfBranches(['main', 'dsh.session.x']), null)
})

test('listing never claims; attaching claims once and the UUID survives machine changes', async () => {
  const f = fixture()
  try {
    const listed = (await f.catalog.list())[0]
    assert.equal(listed.projectId, 'unclaimed:store/app')
    assert.equal(f.state.forks, 0, 'a listing writes nothing to the project')
    const claimed = await f.catalog.resolve('store/app')
    assert.match(claimed.projectId, /^[0-9a-f-]{36}$/)
    assert.deepEqual(f.state.projects.get('store/app').branches, ['main', identityBranch(claimed.projectId)])
    f.state.projects.get('store/app').info.machine = 'vm'
    const again = await f.catalog.resolve('store/app')
    assert.equal(again.projectId, claimed.projectId)
    assert.equal(f.state.forks, 1)
    const row = (await f.catalog.list())[0]
    assert.equal(row.projectId, claimed.projectId)
    assert.equal(row.machine, 'vm')
  } finally { f.close() }
})

test('two installations claiming at once agree on the smallest UUID', async () => {
  const f = fixture()
  try {
    f.state.beforeFork = (p) => { f.state.beforeFork = null; p.branches.push(identityBranch(A)) } // the other side wins first
    const claimed = await f.catalog.resolve('store/app')
    assert.equal(claimed.projectId, A)
  } finally { f.close() }
})

test('without claim an unclaimed project is refused, never minted', async () => {
  const f = fixture()
  try {
    await assert.rejects(f.catalog.resolve('store/app', { claim: false }), { code: 'ProjectIdentityChanged' })
    assert.equal(f.state.forks, 0)
  } finally { f.close() }
})

test('an unclaimed id from a listing claims on attach; a claimed id must match', async () => {
  const f = fixture()
  try {
    const row = await f.catalog.assert('store/app', 'unclaimed:store/app')
    assert.match(row.projectId, /^[0-9a-f-]{36}$/)
    assert.equal((await f.catalog.assert('store/app', row.projectId)).projectId, row.projectId)
    await assert.rejects(f.catalog.assert('store/app', B), { code: 'ProjectIdentityChanged' })
  } finally { f.close() }
})

test('unavailable and deleted projects remain in the durable catalog across restarts', async () => {
  const f = fixture()
  try {
    const original = await f.catalog.resolve('store/app')
    f.state.offline = 'global'
    assert.equal((await f.catalog.list())[0].catalogState, 'unavailable')
    assert.equal(new ProjectCatalog(() => ({}), f.dir).retained()[0].projectId, original.projectId)
    f.state.offline = null; f.state.projects.clear()
    const removed = (await f.catalog.list())[0]
    assert.equal(removed.catalogState, 'removed')
    assert.equal(removed.projectId, original.projectId)
  } finally { f.close() }
})

test('a failed observation never proves removal and a returning Store reconnects the same identity', async () => {
  const f = fixture()
  try {
    const original = await f.catalog.resolve('store/app')
    f.state.offline = 'machine'
    assert.equal((await f.catalog.list())[0].catalogState, 'unavailable')
    f.state.offline = null
    const ready = (await f.catalog.list())[0]
    assert.equal(ready.projectId, original.projectId)
    assert.equal(ready.catalogState, 'available')
  } finally { f.close() }
})

test('a project recreated under the same name is a different project', async () => {
  const f = fixture()
  try {
    const original = await f.catalog.resolve('store/app')
    f.state.projects.set('store/app', { info: info('store/app', 200), branches: ['main'] })
    const rows = await f.catalog.list()
    assert.equal(rows.length, 2)
    assert.equal(rows.find((row) => row.projectId === original.projectId).catalogState, 'identity-mismatch')
    assert.equal(rows.find((row) => row.projectId === 'unclaimed:store/app').catalogState, 'available')
    await assert.rejects(f.catalog.assert('store/app', original.projectId), { code: 'ProjectIdentityChanged' })
  } finally { f.close() }
})

test('a moved project keeps its identity at the new address', async () => {
  const f = fixture()
  try {
    const original = await f.catalog.resolve('store/app')
    const moved = f.state.projects.get('store/app')
    f.state.projects.clear()
    f.state.projects.set('other/app', { info: info('other/app', 300), branches: moved.branches })
    const rows = await f.catalog.list()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].key, 'other/app')
    assert.equal(rows[0].projectId, original.projectId)
    assert.equal(rows[0].catalogState, 'available')
  } finally { f.close() }
})

test('a restored copy beside its original does not take over the identity', async () => {
  const f = fixture()
  try {
    const original = await f.catalog.resolve('store/app')
    f.state.projects.set('store/copy', { info: info('store/copy', 400), branches: [...f.state.projects.get('store/app').branches] })
    const rows = await f.catalog.list()
    assert.equal(rows.find((row) => row.key === 'store/app').catalogState, 'available')
    const copy = rows.find((row) => row.key === 'store/copy')
    assert.equal(copy.projectId, original.projectId)
    assert.equal(copy.catalogState, 'identity-mismatch')
    assert.match(copy.catalogError, /store\/app/)
  } finally { f.close() }
})

test('a damaged durable catalog is reported instead of silently replaced', async () => {
  const f = fixture()
  try {
    writeFileSync(join(f.dir, 'project-catalog.json'), '{broken')
    assert.throws(() => f.catalog.retained(), SyntaxError)
  } finally { f.close() }
})

test('parallel identity lookups of one project share one read, and a dropped-lease refusal is retried', async () => {
  const f = fixture()
  try {
    const lfs = f.catalog['lfs']()
    const list = lfs.branch.list
    let reads = 0, refuse = 1
    lfs.branch.list = async (key, paging) => {
      reads++
      await new Promise((r) => setTimeout(r, 20))
      if (refuse-- > 0) throw Object.assign(new Error('Os { code: 2, kind: NotFound, message: "No such file or directory" }'), { code: 'Failed' })
      return list(key, paging)
    }
    f.state.projects.get('store/app').branches.push(identityBranch(A))
    const ids = await Promise.all([1, 2, 3].map(() => f.catalog.uuidOf('store/app')))
    assert.deepEqual(ids, [A, A, A])
    assert.equal(reads, 2, 'three callers, one read plus its one retry')
    refuse = 5
    await assert.rejects(f.catalog.uuidOf('store/app'), /NotFound/, 'gives up after two retries')
    lfs.branch.list = async () => { throw Object.assign(new Error('nope'), { code: 'Unavailable' }) }
    await assert.rejects(f.catalog.uuidOf('store/app'), /nope/, 'other refusals are not retried')
  } finally { f.close() }
})
