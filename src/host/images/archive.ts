/**
 * A Sandbox image archive's images, read on this host: a docker-archive
 * (`docker save`, legacy or OCI layout) whose `manifest.json` names each
 * image's config blob. LayerFS names an image by that config digest
 * (`<64 hex>.json` or `blobs/sha256/<64 hex>`; layerfs-sandbox-backend
 * `rootfs/archive.rs`), so the digests here are the ones `sandbox.create
 * --image` takes. Only tar headers, `manifest.json` and the config blobs are
 * read; layers are skipped by offset.
 */
import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs'

/** One image an archive holds. */
export interface ArchiveImage {
  /** `sha256:<config digest>`, as `sandbox.create --image` takes it. */
  readonly digest: string
  /** The archive's RepoTags for it (`docker save` keeps the names it was given). */
  readonly tags: string[]
  readonly os: string | null
  readonly architecture: string | null
  /** The config's creation time (RFC 3339), when it says. */
  readonly created: string | null
  readonly layers: number
  /** The layers' bytes in the archive (null when a layer the manifest names is missing). */
  readonly size: number | null
  /**
   * Why LayerFS cannot run it, when the archive shows it: `compressed` (a
   * gzip or zstd layer; LayerFS takes uncompressed layers only), `device-node`
   * (a Sandbox root does not extract device nodes) or `no-glibc` (no glibc
   * loader for the Sandbox daemon, e.g. a musl image such as Alpine).
   */
  readonly problem: ImageProblem | null
}

export type ImageProblem = 'compressed' | 'device-node' | 'no-glibc'

/** What a blob's first bytes say it is. */
export function magicOf(fd: number, blob: { offset: number, size: number }): 'gzip' | 'zstd' | 'tar' {
  const b = Buffer.alloc(4)
  readSync(fd, b, 0, Math.min(4, blob.size), blob.offset)
  if (b[0] === 0x1f && b[1] === 0x8b) return 'gzip'
  if (b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd) return 'zstd'
  return 'tar'
}

const BLOCK = 512
/** The largest manifest.json or config blob read (LayerFS takes manifests up to 1 MiB). */
const SMALL_MAX = 1 << 20
const HEX = /^[a-f0-9]{64}$/

const refuse = (message: string) => Object.assign(new Error(message), { code: 'InvalidInput' })

const cstr = (b: Buffer, start: number, length: number) => {
  const slice = b.subarray(start, start + length)
  const end = slice.indexOf(0)
  return slice.subarray(0, end < 0 ? slice.length : end).toString('utf8')
}

/** A tar size field: octal text, or base-256 when its first byte has the high bit set. */
function sizeOf(b: Buffer): number {
  const field = b.subarray(124, 136)
  if (field[0] & 0x80) {
    let n = 0
    for (let i = 1; i < field.length; i++) n = n * 256 + field[i]
    return n
  }
  const text = cstr(b, 124, 12).trim()
  return text ? parseInt(text, 8) : 0
}

/** `path=` from a pax extended header's records (`<len> key=value\n`). */
function paxPath(data: Buffer): string | null {
  let at = 0
  while (at < data.length) {
    const space = data.indexOf(0x20, at)
    if (space < 0) break
    const length = parseInt(data.subarray(at, space).toString('ascii'), 10)
    if (!Number.isFinite(length) || length <= 0) break
    const record = data.subarray(space + 1, at + length - 1).toString('utf8')
    const eq = record.indexOf('=')
    if (eq > 0 && record.slice(0, eq) === 'path') return record.slice(eq + 1)
    at += length
  }
  return null
}

export const normal = (name: string) => name.replace(/^(\.\/)+/, '')

/** Walk the tar between `start` and `end` of `fd`: each entry's normalized path, type flag, data offset and size. */
function walk(fd: number, start: number, end: number, visit: (name: string, type: string, offset: number, size: number) => void): void {
  const header = Buffer.alloc(BLOCK)
  let at = start
  let longName: string | null = null
  while (at + BLOCK <= end) {
    if (readSync(fd, header, 0, BLOCK, at) < BLOCK) break
    if (header.every((byte) => byte === 0)) break
    const size = sizeOf(header)
    if (!Number.isSafeInteger(size) || size < 0) throw refuse('the image archive has a malformed tar header')
    const type = String.fromCharCode(header[156] || 0x30)
    const data = at + BLOCK
    const next = data + Math.ceil(size / BLOCK) * BLOCK
    if (type === 'L' || type === 'x') {
      // a GNU long name or pax header names the entry that follows
      if (size > SMALL_MAX) throw refuse('the image archive has an oversized tar header')
      const body = Buffer.alloc(size)
      readSync(fd, body, 0, size, data)
      longName = type === 'L' ? cstr(body, 0, size) : paxPath(body) ?? longName
    } else if (type !== 'g') {
      const ustar = cstr(header, 257, 6).startsWith('ustar')
      const prefix = ustar ? cstr(header, 345, 155) : ''
      const name = longName ?? (prefix ? `${prefix}/${cstr(header, 0, 100)}` : cstr(header, 0, 100))
      longName = null
      visit(normal(name), type, data, size)
    }
    at = next
  }
}

/** Every regular file of the tar at `fd`: its normalized path, data offset and size. */
export function entries(fd: number, total: number): Map<string, { offset: number, size: number }> {
  const found = new Map<string, { offset: number, size: number }>()
  walk(fd, 0, total, (name, type, offset, size) => { if (type === '0' || type === '\0' || type === '7') found.set(name, { offset, size }) })
  return found
}

/**
 * The glibc dynamic loader LayerFS's Sandbox daemon starts with (its ELF
 * interpreter), per architecture, with and without a merged /usr.
 */
const LOADERS: Record<string, string[]> = {
  arm64: ['lib/ld-linux-aarch64.so.1', 'usr/lib/ld-linux-aarch64.so.1'],
  amd64: ['lib64/ld-linux-x86-64.so.2', 'usr/lib64/ld-linux-x86-64.so.2'],
}

/** What one uncompressed layer holds that decides whether LayerFS can run it. */
function scanLayer(fd: number, blob: { offset: number, size: number }, loaders: Set<string>): { device: boolean, loader: boolean } {
  let device = false, loader = false
  walk(fd, blob.offset, blob.offset + blob.size, (name, type) => {
    if (type === '3' || type === '4') device = true
    if (loaders.has(name)) loader = true
  })
  return { device, loader }
}

export function readSmall(fd: number, blob: { offset: number, size: number }, what: string): Buffer {
  if (blob.size > SMALL_MAX) throw refuse(`the image archive's ${what} is too long`)
  const b = Buffer.alloc(blob.size)
  readSync(fd, b, 0, blob.size, blob.offset)
  return b
}

/** The first reason LayerFS cannot run an image of these layers, read from the layers' tar headers. */
function problemOf(fd: number, all: Map<string, { offset: number, size: number }>, layers: unknown[], architecture: string | null, scans: Map<string, { device: boolean, loader: boolean }>): ImageProblem | null {
  const blobs = layers.map((l) => (typeof l === 'string' ? all.get(normal(l)) : undefined))
  if (blobs.some((b) => b && b.size > 0 && magicOf(fd, b) !== 'tar')) return 'compressed'
  const loaders = new Set(architecture && LOADERS[architecture] ? LOADERS[architecture] : Object.values(LOADERS).flat())
  let device = false, loader = false
  layers.forEach((l, i) => {
    const blob = blobs[i]
    if (!blob || typeof l !== 'string') return
    const key = `${normal(l)}\0${[...loaders].join(',')}`
    let scan = scans.get(key)
    // a layer that is not a readable tar decides nothing here (LayerFS says why at create)
    if (!scan) { try { scan = scanLayer(fd, blob, loaders) } catch { scan = { device: false, loader: true } } scans.set(key, scan) }
    device ||= scan.device
    loader ||= scan.loader
  })
  return device ? 'device-node' : !loader ? 'no-glibc' : null
}

/** The bytes of the layers named, as the archive holds them; null when one is missing. */
function layerBytes(all: Map<string, { offset: number, size: number }>, layers: unknown[]): number | null {
  let total = 0
  for (const l of layers) {
    const blob = typeof l === 'string' ? all.get(normal(l)) : undefined
    if (!blob) return null
    total += blob.size
  }
  return total
}

const kept = new Map<string, ArchiveImage[]>()

/**
 * The images the archive at `path` holds, in its `manifest.json` order (one
 * archive naming several needs a digest: LayerFS refuses to guess). Answers
 * are kept per path, size and modification time.
 */
export function readArchive(path: string): ArchiveImage[] {
  const stat = statSync(path)
  if (!stat.isFile()) throw refuse(`${path} is not a file`)
  const key = `${path}\0${stat.size}\0${stat.mtimeMs}`
  const hit = kept.get(key)
  if (hit) return hit
  const fd = openSync(path, 'r')
  try {
    const all = entries(fd, fstatSync(fd).size)
    const manifest = all.get('manifest.json')
    if (!manifest) throw refuse('the image archive has no manifest.json (make it with docker save)')
    let list: unknown
    try { list = JSON.parse(readSmall(fd, manifest, 'manifest.json').toString('utf8')) } catch (e) { throw (e as { code?: string }).code ? e : refuse('the image archive\'s manifest.json is not JSON') }
    if (!Array.isArray(list)) throw refuse('the image archive\'s manifest.json is not a list')
    const images: ArchiveImage[] = []
    // layers shared by several images are scanned once
    const scans = new Map<string, { device: boolean, loader: boolean }>()
    for (const item of list as Array<Record<string, unknown>>) {
      if (!item || typeof item.Config !== 'string' || !Array.isArray(item.Layers)) continue
      const config = normal(item.Config)
      const base = config.slice(config.lastIndexOf('/') + 1)
      const hex = base.endsWith('.json') ? base.slice(0, -5) : base
      if (!HEX.test(hex)) continue
      let facts: Record<string, unknown> = {}
      const blob = all.get(config)
      if (blob) { try { facts = JSON.parse(readSmall(fd, blob, 'config').toString('utf8')) ?? {} } catch {} }
      const text = (v: unknown) => (typeof v === 'string' && v ? v : null)
      images.push({
        digest: `sha256:${hex}`,
        tags: Array.isArray(item.RepoTags) ? item.RepoTags.filter((t): t is string => typeof t === 'string') : [],
        os: text(facts.os), architecture: text(facts.architecture), created: text(facts.created),
        layers: item.Layers.length,
        size: layerBytes(all, item.Layers),
        problem: problemOf(fd, all, item.Layers, text(facts.architecture), scans),
      })
    }
    if (kept.size > 64) kept.clear()
    kept.set(key, images)
    return images
  } finally { closeSync(fd) }
}
