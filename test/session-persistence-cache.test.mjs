// The persistence row's bounded header cache: a `stat` reuses one session's
// snapshot while its log keeps the same identity (path, inode, size, mtime,
// ctime), and every write, move, delete or ownership change drops it.
//   node --test test/session-persistence-cache.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-cache-'))
await build({
  absWorkingDir: root,
  stdin: { contents: "export * as persistence from './src/host/session-persistence.ts'\n", resolveDir: root, loader: 'ts' },
  outfile: join(out, 'persistence.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  external: ['@deepseek-ai/*'],
  logLevel: 'warning',
})
const P = await import(pathToFileURL(join(out, 'persistence.mjs')).href)
const scratch = mkdtempSync(join(tmpdir(), 'dsh-header-cache-'))
test.after(() => { rmSync(out, { recursive: true, force: true }); rmSync(scratch, { recursive: true, force: true }) })

const handle = (header) => ({
  id: header.id, header, access: 'write',
  append: async () => {}, flush: async () => {}, close: async () => {},
})

/** A backend whose header is read from a log file, like the stock JSONL one. */
class FileBackend {
  constructor(path) { this.path = path; this.stats = 0 }
  async stat() {
    this.stats++
    if (!existsSync(this.path)) return undefined
    const header = JSON.parse(readFileSync(this.path, 'utf8').split('\n')[0])
    const s = statSync(this.path)
    return { header, formatStatus: 'current', revision: `${s.ino}:${s.size}:${s.mtimeMs}`, sizeBytes: s.size, location: { kind: 'jsonl', path: this.path } }
  }
  async create(header) { writeFileSync(this.path, `${JSON.stringify(header)}\n`); return handle(header) }
  async flush() {}
}

/** A backend that keeps its header in memory: its log's identity never moves. */
class MemoryBackend {
  constructor(path, header) { this.path = path; this.header = header; this.stats = 0 }
  async stat() {
    this.stats++
    if (!existsSync(this.path)) return undefined
    return { header: this.header, formatStatus: 'current', location: { kind: 'jsonl', path: this.path } }
  }
  async create(header) { this.header = header; return handle(header) }
  async open() {
    return {
      id: this.header.id, header: this.header, access: 'write',
      append: async () => { this.header = { ...this.header, title: 'appended' } },
      flush: async () => {}, close: async () => {},
    }
  }
  async flush() {}
}

/** The row's service over a backend, without cordis (the tests' usual pattern). */
function persistence(backend, { service, owners } = {}) {
  const w = Object.create(P.persistence.LayerfsSessionPersistence.prototype)
  Object.defineProperty(w, 'stock', { value: backend })
  Object.defineProperty(w, 'local', { value: backend })
  Object.defineProperty(w, 'ctx', { value: { get: (name) => (name === 'layerfs' ? service : undefined), logger: () => ({ warn() {}, info() {} }) } })
  Object.defineProperty(w, 'handles', { value: new Map() })
  // The class fields a constructor would install (this fake skips it).
  Object.defineProperty(w, 'sidecars', { value: new Map() })
  Object.defineProperty(w, 'sidecarPaths', { value: new Map() })
  Object.defineProperty(w, 'sidecarBytes', { value: 0, writable: true })
  if (owners) Object.defineProperty(w, 'owners', { value: { version: 1, sessions: owners } })
  return w
}

test('repeated stat calls read one header while the log is unchanged', async () => {
  const log = join(scratch, 's1.jsonl')
  writeFileSync(log, `${JSON.stringify({ version: 4, id: 's1', createdAt: 1, title: 'one' })}\n`)
  const backend = new FileBackend(log)
  const w = persistence(backend)
  const first = await w.stat('s1')
  for (let i = 0; i < 8; i++) assert.deepEqual(await w.stat('s1'), first)
  assert.equal(backend.stats, 1)
  assert.equal(first.header.title, 'one')
})

test('a rewritten log is re-read and its new header returned', async () => {
  const log = join(scratch, 's2.jsonl')
  writeFileSync(log, `${JSON.stringify({ version: 4, id: 's2', createdAt: 1, title: 'before' })}\n`)
  const backend = new FileBackend(log)
  const w = persistence(backend)
  assert.equal((await w.stat('s2')).header.title, 'before')
  assert.equal(backend.stats, 1)
  // A rewrite can keep the path; the new size and mtime are the identity change.
  writeFileSync(log, `${JSON.stringify({ version: 4, id: 's2', createdAt: 1, title: 'after', agentPreset: 'longer' })}\n`)
  assert.equal((await w.stat('s2')).header.title, 'after')
  assert.equal(backend.stats, 2)
  assert.equal((await w.stat('s2')).header.title, 'after')
  assert.equal(backend.stats, 2)
})

test('a deleted log is not served from the cache', async () => {
  const log = join(scratch, 's3.jsonl')
  writeFileSync(log, `${JSON.stringify({ version: 4, id: 's3', createdAt: 1 })}\n`)
  const backend = new FileBackend(log)
  const w = persistence(backend)
  assert.ok(await w.stat('s3'))
  rmSync(log)
  assert.equal(await w.stat('s3'), undefined)
  assert.equal(backend.stats, 2)
})

test('a snapshot without a log path is never cached', async () => {
  let stats = 0
  const backend = { stat: async () => { stats++; return { header: { version: 4, id: 'pending', createdAt: 1 }, revision: 'r' } } }
  const w = persistence(backend)
  await w.stat('pending')
  await w.stat('pending')
  await w.stat('pending')
  assert.equal(stats, 3)
})

test('callers never share the cached snapshot or its header', async () => {
  const log = join(scratch, 's4.jsonl')
  writeFileSync(log, `${JSON.stringify({ version: 4, id: 's4', createdAt: 1, title: 'original' })}\n`)
  const backend = new FileBackend(log)
  const w = persistence(backend)
  const a = await w.stat('s4')
  const b = await w.stat('s4')
  assert.notEqual(a, b)
  assert.notEqual(a.header, b.header)
  assert.notEqual(a.location, b.location)
  a.header.title = 'mutated'
  assert.equal((await w.stat('s4')).header.title, 'original')
  assert.equal(backend.stats, 1)
})

test('create invalidates: a header changed without a new identity is read again', async () => {
  const log = join(scratch, 's5.jsonl')
  writeFileSync(log, '{"version":4}\n')
  const backend = new MemoryBackend(log, { version: 4, id: 's5', createdAt: 1, title: 'old' })
  const w = persistence(backend)
  assert.equal((await w.stat('s5')).header.title, 'old')
  await w.create({ version: 4, id: 's5', createdAt: 2, title: 'new' })
  assert.equal(backend.stats, 1)
  assert.equal((await w.stat('s5')).header.title, 'new')
  assert.equal(backend.stats, 2)
})

test('append through the routed handle invalidates the cached header', async () => {
  const log = join(scratch, 's7.jsonl')
  writeFileSync(log, '{"version":4}\n')
  const backend = new MemoryBackend(log, { version: 4, id: 's7', createdAt: 1, title: 'old' })
  const w = persistence(backend)
  assert.equal((await w.stat('s7')).header.title, 'old')
  const writer = await w.open('s7', 'write')
  try { await writer.append([{ type: 'session/title', data: { title: 'new' } }]) } finally { await writer.close() }
  assert.equal(w.headers.entries.has('s7'), false)
  assert.equal((await w.stat('s7')).header.title, 'appended')
  assert.equal(backend.stats, 2)
})

test('deleteSessions invalidates the deleted session', async () => {
  const home = join(scratch, 'home')
  const log = join(scratch, 'outside.jsonl')
  mkdirSync(home, { recursive: true })
  writeFileSync(log, '{"version":4}\n')
  const key = 'a'.repeat(64)
  writeFileSync(join(home, 'owners.json'), JSON.stringify({ version: 1, sessions: { s6: { project: 'st/app', key } } }))
  const backend = new MemoryBackend(log, { version: 4, id: 's6', createdAt: 1, title: 'old' })
  const w = persistence(backend, {
    service: { projectSessionHome: home },
    owners: { s6: { project: 'st/app', key } },
  })
  Object.defineProperty(w, 'backend', { value: async () => backend })
  assert.equal((await w.stat('s6')).header.title, 'old')
  assert.equal(backend.stats, 1)
  backend.header = { version: 4, id: 's6', createdAt: 2, title: 'new' }
  assert.deepEqual(await w.deleteSessions(['s6']), ['s6'])
  assert.equal(w.headers.entries.has('s6'), false)
  assert.equal((await w.stat('s6')).header.title, 'new')
  assert.equal(backend.stats, 3) // one internal stat in deleteSessions, one after it
})

test('the cache is a bounded LRU of 1024 entries', async () => {
  const log = join(scratch, 'many.jsonl')
  writeFileSync(log, `${JSON.stringify({ version: 4, id: 'many', createdAt: 1 })}\n`)
  const backend = new FileBackend(log)
  const w = persistence(backend)
  const first = 'id-0000'
  for (let i = 0; i < 1025; i++) await w.stat(`id-${String(i).padStart(4, '0')}`)
  assert.equal(w.headers.entries.size, 1024)
  assert.equal(w.headers.entries.has(first), false)
  assert.equal(w.headers.entries.has('id-1024'), true)
  const before = backend.stats
  await w.stat(first)
  assert.equal(backend.stats, before + 1)
  await w.stat('id-1024')
  assert.equal(backend.stats, before + 1)
})

test('the byte budget bounds the cache before the entry bound', async () => {
  const log = join(scratch, 'big.jsonl')
  const header = { version: 4, id: 'big', createdAt: 1, agentPreset: 'p'.repeat(20_000) }
  writeFileSync(log, `${JSON.stringify(header)}\n`)
  const backend = new FileBackend(log)
  const w = persistence(backend)
  for (let i = 0; i < 400; i++) await w.stat(`big-${i}`)
  assert.ok(w.headers.entries.size < 400, `evicted ${w.headers.entries.size}`)
  assert.ok(w.headers.bytes <= w.headers.budget)
  assert.ok(w.headers.entries.has('big-399'))
})

// ---------------------------------------------------------------- sidecar cache

/** A log file with a sidecar next to it, in its own folder (the sidecar path is `<log dir>/layerfs/binding.json`). */
function sidecarFixture(name) {
  const dir = join(scratch, name)
  mkdirSync(join(dir, 'layerfs'), { recursive: true })
  const log = join(dir, 'session.jsonl')
  writeFileSync(log, `${JSON.stringify({ version: 4, id: 's1', createdAt: 1 })}\n`)
  return { dir, log, sidecar: join(dir, 'layerfs', 'binding.json'), backend: new FileBackend(log) }
}
const sidecarValue = (title, extra = {}) => ({ version: 1, sessionId: 's1', project: 'st/app', invocations: [], title, ...extra })
/** Count the cache's real file reads (the method is overridable for exactly this). */
function countingReads(w) {
  const counts = { reads: 0 }
  const real = w.readSidecarFile.bind(w)
  w.readSidecarFile = (path) => { counts.reads++; return real(path) }
  return counts
}

test('readSidecar reads one file while it is unchanged, and every caller gets its own copy', async () => {
  const f = sidecarFixture('sidecar-copy')
  writeFileSync(f.sidecar, JSON.stringify(sidecarValue('one', { checkpoints: [{ commit: 'c1', changed: 2 }] })))
  const w = persistence(f.backend)
  const reads = countingReads(w)
  const first = await w.readSidecar('s1')
  assert.equal(first.title, 'one')
  const copy = await w.readSidecar('s1')
  assert.deepEqual(copy, first)
  assert.notEqual(copy, first, 'a cached sidecar is copied, never shared')
  assert.notEqual(copy.checkpoints, first.checkpoints)
  assert.equal(reads.reads, 1)
  first.checkpoints.push({ commit: 'poison', changed: 1 })
  first.invocations.push({ id: 'poison' })
  const again = await w.readSidecar('s1')
  assert.deepEqual(again.checkpoints, [{ commit: 'c1', changed: 2 }])
  assert.deepEqual(again.invocations, [])
  assert.equal(reads.reads, 1)
})

test('an absent sidecar is never cached: one written later shows on the next read', async () => {
  const f = sidecarFixture('sidecar-absent')
  const w = persistence(f.backend)
  const reads = countingReads(w)
  assert.equal(await w.readSidecar('s1'), undefined)
  assert.equal(w.sidecarPaths.has('s1'), false)
  writeFileSync(f.sidecar, JSON.stringify(sidecarValue('appeared')))
  assert.equal((await w.readSidecar('s1')).title, 'appeared')
  assert.equal(reads.reads, 1)
  assert.equal(w.sidecarPaths.has('s1'), true)
})

test('another process changing the sidecar file is re-read', async () => {
  const f = sidecarFixture('sidecar-external')
  writeFileSync(f.sidecar, JSON.stringify(sidecarValue('before')))
  const w = persistence(f.backend)
  const reads = countingReads(w)
  assert.equal((await w.readSidecar('s1')).title, 'before')
  assert.equal(reads.reads, 1)
  // A second writer (the same path, another process): a new inode/size/mtime/ctime.
  writeFileSync(f.sidecar, JSON.stringify(sidecarValue('after', { invocations: [{ id: 'external' }] })))
  const after = await w.readSidecar('s1')
  assert.equal(after.title, 'after')
  assert.deepEqual(after.invocations, [{ id: 'external' }])
  assert.equal(reads.reads, 2)
})

test('updateSidecar is visible to the next read, then another writer invalidates it', async () => {
  const home = join(scratch, 'sidecar-update-home')
  mkdirSync(home, { recursive: true })
  const key = 'a'.repeat(64)
  writeFileSync(join(home, 'owners.json'), JSON.stringify({ version: 1, sessions: { s1: { project: 'st/app', key } } }))
  const f = sidecarFixture('sidecar-update')
  writeFileSync(f.sidecar, JSON.stringify(sidecarValue('old')))
  const w = persistence(f.backend, { service: { projectSessionHome: home }, owners: { s1: { project: 'st/app', key } } })
  Object.defineProperty(w, 'backend', { value: async () => f.backend })
  const reads = countingReads(w)
  assert.equal((await w.readSidecar('s1')).title, 'old')
  assert.equal(reads.reads, 1)
  await w.updateSidecar('s1', (value) => { value.title = 'new'; value.checkpoints = [{ commit: 'c2', changed: 1 }] })
  const fresh = await w.readSidecar('s1')
  assert.equal(fresh.title, 'new', 'the value just written is the next read')
  assert.deepEqual(fresh.checkpoints, [{ commit: 'c2', changed: 1 }])
  assert.equal(reads.reads, 1, 'the write refreshed the entry instead of forcing a re-read')
  // Same path, another writer: the identity moves and the next read sees it.
  writeFileSync(f.sidecar, JSON.stringify(sidecarValue('external')))
  assert.equal((await w.readSidecar('s1')).title, 'external')
  assert.equal(reads.reads, 2)
})

test('create invalidates a cached sidecar', async () => {
  const f = sidecarFixture('sidecar-create')
  writeFileSync(f.sidecar, JSON.stringify(sidecarValue('before')))
  const backend = new MemoryBackend(f.log, { version: 4, id: 's1', createdAt: 1, title: 'before' })
  const w = persistence(backend)
  assert.equal((await w.readSidecar('s1')).title, 'before')
  assert.equal(w.sidecarPaths.has('s1'), true)
  await w.create({ version: 4, id: 's1', createdAt: 2, title: 'new' })
  assert.equal(w.sidecarPaths.has('s1'), false)
  writeFileSync(f.sidecar, JSON.stringify(sidecarValue('new')))
  assert.equal((await w.readSidecar('s1')).title, 'new')
})

test('deleteSessions invalidates a cached sidecar', async () => {
  const home = join(scratch, 'sidecar-delete-home')
  mkdirSync(home, { recursive: true })
  const dir = join(scratch, 'sidecar-delete')
  mkdirSync(dir, { recursive: true })
  const log = join(dir, 'session.jsonl')
  writeFileSync(log, '{"version":4}\n')
  mkdirSync(join(dir, 'layerfs'), { recursive: true })
  writeFileSync(join(dir, 'layerfs', 'binding.json'), JSON.stringify({ version: 1, sessionId: 's6', project: 'st/app', invocations: [] }))
  const key = 'a'.repeat(64)
  writeFileSync(join(home, 'owners.json'), JSON.stringify({ version: 1, sessions: { s6: { project: 'st/app', key } } }))
  const backend = new MemoryBackend(log, { version: 4, id: 's6', createdAt: 1 })
  const w = persistence(backend, { service: { projectSessionHome: home }, owners: { s6: { project: 'st/app', key } } })
  Object.defineProperty(w, 'backend', { value: async () => backend })
  assert.ok(await w.readSidecar('s6'))
  assert.equal(w.sidecarPaths.has('s6'), true)
  assert.deepEqual(await w.deleteSessions(['s6']), ['s6'])
  assert.equal(w.sidecarPaths.has('s6'), false)
})

test('the sidecar cache is bounded to 1024 entries', async () => {
  // One log per id, so each read is its own cache entry.
  const base = join(scratch, 'sidecar-bound')
  const backend = {
    async stat(id) {
      const path = join(base, id, 'session.jsonl')
      if (!existsSync(path)) return undefined
      return { header: { version: 4, id, createdAt: 1 }, formatStatus: 'current', location: { kind: 'jsonl', path } }
    },
  }
  for (let i = 0; i < 1100; i++) {
    const id = `id-${String(i).padStart(4, '0')}`
    mkdirSync(join(base, id, 'layerfs'), { recursive: true })
    writeFileSync(join(base, id, 'session.jsonl'), '{"version":4}\n')
    writeFileSync(join(base, id, 'layerfs', 'binding.json'), JSON.stringify(sidecarValue(id)))
  }
  const w = persistence(backend)
  for (let i = 0; i < 1100; i++) await w.readSidecar(`id-${String(i).padStart(4, '0')}`)
  assert.equal(w.sidecars.size, 1024)
  assert.equal(w.sidecarPaths.has('id-0000'), false)
  assert.equal(w.sidecarPaths.has('id-1099'), true)
})
