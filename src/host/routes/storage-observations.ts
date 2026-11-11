/**
 * Explicit successful Store statistics reads, observed by this host.
 * These are observations from now onward, never reconstructed disk history.
 * Port of Connect `host/storage-observations.js`; journals live in
 * `<root>/storage-observations/`.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { stringify } from './util.ts'

export const OBSERVATION_GAP_MS = 30 * 60 * 1000
const MAX_POINTS = 1000, MAX_SERIES = 8, RETAIN_MS = 90 * 86400000
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const fields = ['kind', 'accounting_version', 'history_logical', 'canonical', 'stored', 'metadata', 'file', 'free', 'data_pack_bytes', 'metadata_pack_bytes', 'database_overhead_bytes', 'free_page_bytes', 'database_page_bytes', 'composition_complete', 'composition_reason', 'fileMeasurements', 'fileMeasurementError']

type Journal = { version: 1, scope: 'store', store: string, gapAfterMs: number, retentionDays: number, maxPoints: number, series: { identity: string, startedAt: number, points: { observedAt: number, stats: any }[] }[] }

export class StorageObservations {
  readonly directory: string
  readonly home: string
  private readonly pending = new Map<string, Promise<void>>()

  constructor(root: string, home: string, private readonly now: () => number = Date.now) {
    this.directory = join(root, 'storage-observations')
    this.home = resolve(home ?? root)
  }

  path(store: string): string { return join(this.directory, `${digest(`${this.home}\0${store}`)}.json`) }

  async read(store: string): Promise<Journal> {
    try {
      const value = JSON.parse(await readFile(this.path(store), 'utf8'))
      if (value.version !== 1 || value.store !== store || !Array.isArray(value.series)) throw new Error('Invalid Store observation journal')
      return value
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error
      return { version: 1, scope: 'store', store, gapAfterMs: OBSERVATION_GAP_MS, retentionDays: 90, maxPoints: MAX_POINTS, series: [] }
    }
  }

  record(store: string, stats: any, record: any): Promise<void> {
    const next = (this.pending.get(store) ?? Promise.resolve()).catch(() => {}).then(() => this.append(store, stats, record))
    this.pending.set(store, next)
    return next.finally(() => { if (this.pending.get(store) === next) this.pending.delete(store) })
  }

  async append(store: string, stats: any, record: any): Promise<void> {
    // A name, creation timestamp or machine path alone cannot establish identity.
    if (typeof stats.store_id !== 'string' || !stats.store_id) throw new Error('This LayerFS build does not expose Store identity; disk observations are unavailable')
    const generation = stats.store_generation
    if (generation == null) throw new Error('This LayerFS build does not expose Store generation; disk observations are unavailable')
    const identity = digest(stringify([this.home, store, stats.store_id, generation, stats.kind, record?.machine ?? null]))
    const now = this.now(), journal = await this.read(store)
    journal.series = journal.series.map((series) => ({ ...series, points: series.points.filter((p) => p.observedAt >= now - RETAIN_MS) })).filter((series) => series.points.length)
    let series = journal.series.at(-1)
    // A route or generation change starts a separate line. Never join across gaps.
    if (!series || series.identity !== identity || now < series.points.at(-1)!.observedAt) {
      series = { identity, startedAt: now, points: [] }
      journal.series.push(series)
    }
    const snapshot = Object.fromEntries(fields.filter((field) => Object.hasOwn(stats, field)).map((field) => [field, stats[field]]))
    series.points.push({ observedAt: now, stats: snapshot })
    let count = journal.series.reduce((sum, item) => sum + item.points.length, 0)
    while (count > MAX_POINTS) {
      journal.series[0].points.shift(); count--
      if (!journal.series[0].points.length) journal.series.shift()
    }
    journal.series = journal.series.slice(-MAX_SERIES)
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const file = this.path(store), temporary = `${file}.${randomUUID()}.tmp`
    await writeFile(temporary, `${stringify(journal)}\n`, { mode: 0o600 })
    await rename(temporary, file)
  }
}
