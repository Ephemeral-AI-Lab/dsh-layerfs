// Where a machine's data disk goes (`machine.space`), host and page side,
// over a fake `lfs` with the answers the LayerFS build gave on a Docker VM
// (complete) and a Lima VM whose walk stopped at its bound (partial):
//   host    featuresOf, the inspect lane, GET /api/machines/:id/space (501
//           without the call, one answer kept a minute, ?fresh=1, a refusal
//           keeps the last answer and says so)
//   page    src/client/machines/space.ts: how full a disk is, the breakdown
//           rows, the bar's spans, what is not LayerFS's in words
//   node --test test/space.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { loadRoutes, testHost } from './routes-helper.mjs'

const root = new URL('..', import.meta.url).pathname
const out = mkdtempSync(join(root, 'lib', '.test-space-'))
const bundle = async (name, contents) => {
  await build({ absWorkingDir: root, stdin: { contents, resolveDir: root, loader: 'ts' }, outfile: join(out, `${name}.mjs`), bundle: true, format: 'esm', platform: 'node', target: 'node24', external: ['@deepseek-ai/*', 'react', 'react/*'], logLevel: 'warning' })
  return import(pathToFileURL(join(out, `${name}.mjs`)).href)
}
const S = await bundle('space', "export * from './src/client/machines/space.ts'")
const R = await loadRoutes()
test.after(() => rmSync(out, { recursive: true, force: true }))

class Refusal extends Error {
  constructor(code, message = code, detail = null) { super(message); Object.assign(this, { code, detail, transport: 'refusal' }) }
}
const entry = (family, call) => ({ family, call, args: [], options: [] })
const BASE = [entry('machine', 'list'), entry('sandbox', 'list')]
const SPACE = [...BASE, entry('machine', 'stats'), entry('machine', 'space')]

function fixture(lfs, calls = SPACE) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-space-'))
  const t = testHost({ lfs, root: dir, home: join(dir, 'home'), discovery: async () => ({ identity: { version: '2.0.0-test', features: [] }, calls }) })
  const groups = R.createGroups(t.host, async () => ({}))
  return { logs: t.logs, http: (method, path, body) => R.handle(groups, { method, path, body }), close: () => rmSync(dir, { recursive: true, force: true }) }
}
const viewLfs = (machine = {}) => ({
  machine: { list: async () => ({ machines: [{ name: 'docker', platform: 'docker', state: 'running' }] }), platforms: async () => ({ host: 'macos', platforms: [] }), ...machine },
  store: { list: async () => ({ items: [] }) },
  sandbox: { list: async () => ({ items: [], next_page_pos: null }) },
})

// As the LayerFS build answered (scratchpad evidence docker-space.json, lm-partial-space.json).
const DOCKER = { machine: 'docker', platform: 'docker', observed_at: 1794817003610, disk: { total: 260972097536, used: 54543675392, free: 193097302016, path: '/layerfs/data', fs: 'ext4', scope: 'vm_disk' }, layerfs: 3348140032, outside: 51195535360, parts: { stores: 2297856, sandboxes: 532910080, images: 2812887040, other_runs: 0, logs: 8192, other: 36864 }, stores: [{ name: 'dsdocker', bytes: 2297856 }], sandboxes: [{ name: 'sb-docker-a', bytes: 273371136, overlays: 6553600, writes: 5312512, home: 2105344, log: 4096, runtime: 259395584 }, { name: 'sb-docker-b', bytes: 259538944, overlays: 86016, writes: 53248, home: 4096, log: 4096, runtime: 259391488 }], unreadable: 0, complete: true }
const LIMA_PARTIAL = { machine: 'lm', platform: 'lima', observed_at: 1794817144867, disk: { total: 20955348992, used: 3354255360, free: 16510681088, path: '/layerfs/data', fs: 'ext4', scope: 'volume' }, layerfs: 264634368, outside: null, parts: { stores: 2297856, sandboxes: 262336512, images: null, other_runs: null, logs: null, other: null }, stores: [{ name: 'dslm', bytes: 2297856 }], sandboxes: [{ name: 'sb-lm-a', bytes: 262336512, overlays: 6553600, writes: 6156288, home: 2105344, log: 0, runtime: 247521280 }, { name: 'sb-lm-b', bytes: null, overlays: null, writes: null, home: null, log: null, runtime: null, reason: 'deadline' }], unreadable: 0, complete: false, reason: 'deadline' }
const GIB = 2 ** 30

// ---------------------------------------------------------------- host

test('features and lane: machine.space is read from the call table, optional, and a monitoring read', () => {
  assert.equal(R.util.featuresOf({ calls: BASE }).machineSpace, false)
  assert.equal(R.util.featuresOf({ calls: SPACE }).machineSpace, true)
  assert.equal(R.util.featuresOf(null).machineSpace, false)
  assert.ok(!R.cli.REQUIRED_CALLS.includes('machine.space'))
  assert.ok(R.cli.INSPECT_CALLS.has('machine.space'))
  assert.deepEqual(R.cli.laneOf(['machine', 'space', '--', 'docker']), R.cli.INSPECT_LANE)
})

test('space route: 501 without machine.space, and no call', async () => {
  let calls = 0
  const f = fixture(viewLfs({ space: async () => { calls++; return DOCKER } }), BASE)
  try {
    const r = await f.http('GET', '/api/machines/docker/space')
    assert.equal(r.status, 501); assert.equal(r.body.code, 'Unsupported'); assert.equal(r.body.detail.need, 'machine.space')
    assert.equal(calls, 0)
    assert.deepEqual(f.logs, [])
  } finally { f.close() }
})

test('space route: the answer in the page\'s names, kept a minute; ?fresh=1 reads again', async () => {
  const seen = []
  const f = fixture(viewLfs({ space: async (name) => { seen.push(name); return DOCKER } }))
  try {
    const a = await f.http('GET', '/api/machines/docker/space')
    assert.equal(a.status, 200)
    const s = a.body.space
    assert.equal(a.body.machine, 'docker'); assert.equal(a.body.stale, false); assert.equal(typeof a.body.at, 'number')
    assert.deepEqual(s.disk, { total: 260972097536, used: 54543675392, free: 193097302016, path: '/layerfs/data', fs: 'ext4', scope: 'vm_disk' })
    assert.equal(s.layerfs, 3348140032); assert.equal(s.outside, 51195535360); assert.equal(s.complete, true); assert.equal(s.reason, null)
    assert.deepEqual(s.parts, { stores: 2297856, sandboxes: 532910080, images: 2812887040, otherRuns: 0, logs: 8192, other: 36864 })
    assert.deepEqual(s.sandboxes.map((r) => [r.name, r.bytes, r.overlays + r.writes + r.home + r.log + r.runtime]), [['sb-docker-a', 273371136, 273371136], ['sb-docker-b', 259538944, 259538944]])
    await f.http('GET', '/api/machines/docker/space')
    assert.deepEqual(seen, ['docker'], 'a second read within the minute is the kept answer')
    await f.http('GET', '/api/machines/docker/space?fresh=1')
    assert.deepEqual(seen, ['docker', 'docker'])
  } finally { f.close() }
})

test('space route: a partial walk keeps its nulls and reasons; a refusal keeps the last answer and says so', async () => {
  let next = () => LIMA_PARTIAL
  const f = fixture(viewLfs({ space: async () => next() }))
  try {
    const a = (await f.http('GET', '/api/machines/lm/space')).body
    assert.equal(a.space.complete, false); assert.equal(a.space.reason, 'deadline'); assert.equal(a.space.outside, null)
    assert.equal(a.space.parts.images, null); assert.equal(a.space.parts.otherRuns, null)
    assert.equal(a.space.sandboxes[1].bytes, null); assert.equal(a.space.sandboxes[1].reason, 'deadline')
    next = () => { throw new Refusal('Unavailable', 'machine lm is not running') }
    const b = (await f.http('GET', '/api/machines/lm/space?fresh=1')).body
    assert.equal(b.space.layerfs, 264634368, 'the last answer stays')
    assert.equal(b.at, a.at)
    assert.deepEqual({ code: b.stale.code, message: b.stale.message, at: b.stale.at }, { code: 'Unavailable', message: 'machine lm is not running', at: a.at })
    // never read before: no answer, the refusal
    const c = (await f.http('GET', '/api/machines/other/space')).body
    assert.equal(c.space, null); assert.equal(c.stale.code, 'Unavailable')
  } finally { f.close() }
})

// ---------------------------------------------------------------- page

const page = (raw) => {
  // the host's names, as GET /api/machines/:id/space answers
  const p = raw.parts
  return { ...raw, observedAt: raw.observed_at, parts: { stores: p.stores, sandboxes: p.sandboxes, images: p.images, otherRuns: p.other_runs, logs: p.logs, other: p.other }, reason: raw.reason ?? null }
}

test('how full a disk is: both a share and an absolute floor', () => {
  assert.equal(S.diskLevel(null, 100), null); assert.equal(S.diskLevel(10, null), null); assert.equal(S.diskLevel(10, 0), null)
  assert.equal(S.diskLevel(193097302016, 260972097536), 'ok')
  assert.equal(S.diskLevel(30 * GIB, 250 * GIB), 'low', '12 % free')
  assert.equal(S.diskLevel(10 * GIB, 250 * GIB), 'critical', '4 % free')
  assert.equal(S.diskLevel(4 * GIB, 20 * GIB), 'low', '20 % of a small volume but under 5 GiB')
  assert.equal(S.diskLevel(1.5 * GIB, 20 * GIB), 'critical', 'under 2 GiB')
  assert.equal(S.diskLevel(16510681088, 20955348992), 'ok')
})

test('breakdown rows: LayerFS\'s parts sum to its total, then not LayerFS\'s, then free; zero rows dropped', () => {
  const space = page(DOCKER)
  const rows = S.spaceRows(space)
  assert.deepEqual(rows.map((r) => r.key), ['stores', 'overlays', 'sandboxFiles', 'sandboxRuntime', 'images', 'logs', 'outside', 'free'], 'no leftover run folders: no row')
  const of = (key) => rows.find((r) => r.key === key).bytes
  assert.equal(rows.filter((r) => r.layerfs).reduce((a, r) => a + r.bytes, 0), DOCKER.layerfs)
  assert.equal(of('overlays'), 6553600 + 86016)
  assert.equal(of('sandboxFiles'), 5312512 + 2105344 + 53248 + 4096)
  assert.equal(of('logs'), 8192 + 36864)
  assert.equal(of('outside'), DOCKER.outside); assert.equal(of('free'), DOCKER.disk.free)
})

test('a partial walk: parts not read stay as not read, not as zero; what is not LayerFS\'s is unknown', () => {
  const space = page(LIMA_PARTIAL)
  const rows = S.spaceRows(space)
  const of = (key) => rows.find((r) => r.key === key)
  assert.equal(of('images').bytes, null); assert.equal(of('otherRuns').bytes, null); assert.equal(of('logs').bytes, null)
  assert.equal(of('outside').bytes, null)
  assert.equal(of('overlays').bytes, 6553600, 'the measured Sandbox only')
  const spans = S.diskSpans(space)
  assert.equal(spans.outside, 0)
  assert.ok(Math.abs(spans.layerfs + spans.unsplit - LIMA_PARTIAL.disk.used / LIMA_PARTIAL.disk.total) < 1e-9, 'used space LayerFS did not split is drawn as unsplit')
  assert.deepEqual(S.sandboxesBySize(space).map((r) => r.name), ['sb-lm-a', 'sb-lm-b'])
  assert.deepEqual(S.sandboxSpaceReason('deadline'), { key: 'spaceDeadline' })
})

test('bar spans and what is not LayerFS\'s in words', () => {
  const spans = S.diskSpans(page(DOCKER))
  assert.ok(Math.abs(spans.layerfs - DOCKER.layerfs / DOCKER.disk.total) < 1e-9)
  assert.ok(Math.abs(spans.outside - DOCKER.outside / DOCKER.disk.total) < 1e-9)
  assert.equal(spans.unsplit, 0)
  assert.equal(S.diskSpans({ ...page(DOCKER), disk: { ...DOCKER.disk, total: null } }), null)
  assert.deepEqual(S.outsideWords('vm_disk'), { key: 'spaceOutsideVmDisk' })
  assert.deepEqual(S.outsideWords('host_fs'), { key: 'spaceOutsideHost' })
  assert.deepEqual(S.outsideWords('volume'), { key: 'spaceOutsideVolume' })
  assert.deepEqual(S.outsideWords(null), { key: 'spaceOutsideOther' })
  assert.equal(S.outsideCommand('vm_disk'), 'docker system df')
  assert.equal(S.outsideCommand('volume'), null)
  for (const [r, key] of [['no_run_folder', 'spaceNoRunFolder'], ['outside_run_root', 'spaceOutsideRunRoot'], ['record_unreadable', 'spaceRecordUnreadable']]) assert.deepEqual(S.sandboxSpaceReason(r), { key })
  assert.deepEqual(S.sandboxSpaceReason('new_reason'), { key: 'raw', values: { text: 'new_reason' } })
  assert.equal(S.sandboxSpaceReason(undefined), null)
})
