// The folder check the New project dialog runs before it makes a Store
// (`POST /api/project-sources/check`), and Init's use of the same rule.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRoutes, testHost } from './routes-helper.mjs'

const R = await loadRoutes()

function fixture(lfs = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-source-check-'))
  const root = join(dir, 'root'), home = join(dir, 'home')
  mkdirSync(root); mkdirSync(home)
  const { host } = testHost({ lfs, root, home, discovery: async () => ({ identity: {}, calls: [] }) })
  const groups = R.createGroups(host, async () => ({}))
  const check = (source) => R.handle(groups, { method: 'POST', path: '/api/project-sources/check', body: { source } })
  return { dir, root, home, groups, check, close: () => rmSync(dir, { recursive: true, force: true }) }
}

test('folder check: an existing absolute folder passes with its real path; reads nothing', async () => {
  const f = fixture()
  try {
    const shop = join(f.dir, 'code', 'shop')
    mkdirSync(shop, { recursive: true })
    writeFileSync(join(shop, 'a.txt'), 'x')
    symlinkSync(shop, join(f.dir, 'link'))
    const ok = await f.check(shop)
    assert.equal(ok.status, 200)
    assert.match(ok.body.source, /code\/shop$/)
    assert.equal((await f.check(join(f.dir, 'link'))).body.source, ok.body.source, 'a link answers the real folder')
    // a sibling named like a parent step is still outside
    const dots = join(f.dir, 'home..x')
    mkdirSync(dots)
    assert.equal((await f.check(dots)).status, 200)
  } finally { f.close() }
})

test('folder check: relative, missing, a file and the LayerFS home are refused; plugin state is allowed', async () => {
  const f = fixture()
  try {
    writeFileSync(join(f.dir, 'file.txt'), 'x')
    mkdirSync(join(f.home, 'store'))
    mkdirSync(join(f.root, 'projects'))
    for (const bad of ['code/shop', join(f.dir, 'missing'), join(f.dir, 'file.txt'), undefined, 7]) {
      const r = await f.check(bad)
      assert.equal(r.status, 400, String(bad))
      assert.equal(r.body.error?.code ?? r.body.code, 'InvalidInput')
    }
    for (const inside of [f.home, join(f.home, 'store')]) {
      const r = await f.check(inside)
      assert.equal(r.status, 400, inside)
      assert.match(JSON.stringify(r.body), /outside the LayerFS home/)
    }
    assert.equal((await f.check(join(f.root, 'projects'))).status, 200, 'a scratch folder under the plugin root may be imported')
  } finally { f.close() }
})

test('Init refuses a folder inside the LayerFS home before calling project.init', async () => {
  const calls = []
  const f = fixture({ project: { init: async (...args) => { calls.push(args); return {} } } })
  try {
    const r = await R.handle(f.groups, { method: 'POST', path: '/api/projects', body: { store: 's', name: 'app', source: f.home } })
    assert.equal(r.status, 400)
    assert.deepEqual(calls, [])
  } finally { f.close() }
})
