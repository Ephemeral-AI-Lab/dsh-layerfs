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
const { ProjectCatalog, projectIdentity } = await import(pathToFileURL(join(out, 'catalog.mjs')))
test.after(() => rmSync(out, { recursive: true, force: true }))
const initial = () => ({ project: 'store/app', store: 'store', name: 'app', kind: 'sqlite', machine: 'native', created: 100 })
const fail = (code) => Object.assign(new Error(code), { code })
function fixture() {
  const dir = mkdtempSync(join(root, '.dev-test-catalog-'))
  const state = { info: initial(), stats: { store_id: 'opaque-store', store_generation: 1 }, listed: true, offline: null, deleted: false }
  const lfs = {
    project: {
      list: async () => { if (state.offline === 'global') throw fail('Unavailable'); return { items: state.listed ? [state.info] : [] } },
      get: async () => { if (state.offline) throw fail('Unavailable'); if (state.deleted) throw fail('NoSuchProject'); return state.info },
    },
    store: {
      stats: async () => { if (state.offline) throw fail('Unavailable'); if (state.deleted) throw fail('NoSuchStore'); return state.stats },
      status: async () => ({ state: state.offline ? 'down' : 'idle' }),
    },
  }
  return { state, dir, catalog: new ProjectCatalog(() => lfs, dir), close: () => rmSync(dir, { recursive: true, force: true }) }
}
test('project identity is independent of machine and app home; Store/project reincarnations are distinct', () => {
  const stats = { store_id: 'original', store_generation: 1 }
  const id = projectIdentity(initial(), stats).id
  assert.equal(projectIdentity({ ...initial(), machine: 'vm' }, stats).id, id)
  assert.notEqual(projectIdentity(initial(), { ...stats, store_id: 'restored-copy' }).id, id)
  assert.notEqual(projectIdentity(initial(), { ...stats, store_generation: 2 }).id, id)
  assert.notEqual(projectIdentity({ ...initial(), created: 200 }, stats).id, id)
})
test('unavailable and deleted projects remain in the durable catalog across restarts', async () => {
  const f = fixture()
  try {
    const original = (await f.catalog.list())[0]
    f.state.listed = false; f.state.offline = 'global'
    assert.equal((await f.catalog.list())[0].catalogState, 'unavailable')
    const fresh = new ProjectCatalog(() => ({}), f.dir)
    assert.equal(fresh.retained()[0].projectId, original.projectId)
    f.state.offline = null; f.state.deleted = true
    const removed = (await f.catalog.list())[0]
    assert.equal(removed.catalogState, 'removed')
    assert.equal(removed.projectId, original.projectId)
    assert.equal(f.catalog.retained().length, 1)
  } finally { f.close() }
})
test('a failed observation never proves removal and a returning Store reconnects the same identity', async () => {
  const f = fixture()
  try {
    const original = await f.catalog.resolve('store/app')
    f.state.listed = false; f.state.offline = 'machine'
    assert.equal((await f.catalog.list())[0].catalogState, 'unavailable')
    f.state.listed = true; f.state.offline = null; f.state.info.machine = 'vm'
    const ready = (await f.catalog.list())[0]
    assert.equal(ready.projectId, original.projectId)
    assert.equal(ready.machine, 'vm')
    assert.equal(ready.catalogState, 'available')
  } finally { f.close() }
})
test('same-name replacement has a separate row; old identity cannot resolve to it', async () => {
  const f = fixture()
  try {
    const original = await f.catalog.resolve('store/app')
    f.state.stats.store_id = 'replacement'
    const rows = await f.catalog.list()
    assert.equal(rows.length, 2)
    assert.equal(rows.find((row) => row.projectId === original.projectId).catalogState, 'identity-mismatch')
    await assert.rejects(f.catalog.assert('store/app', original.projectId), { code: 'ProjectIdentityChanged' })
  } finally { f.close() }
})
test('a damaged durable catalog is reported instead of silently replaced', async () => {
  const f = fixture()
  try {
    writeFileSync(join(f.dir, 'project-catalog.json'), '{broken')
    assert.throws(() => f.catalog.retained(), SyntaxError)
  } finally { f.close() }
})
