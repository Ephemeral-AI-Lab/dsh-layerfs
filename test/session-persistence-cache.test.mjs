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
