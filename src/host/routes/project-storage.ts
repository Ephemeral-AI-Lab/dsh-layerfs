/**
 * A project's own storage, from the counters every saved Commit carries
 * (`new_canonical`, `new_stored`, `new_metadata`, see LayerFS's
 * `layerfs-sdk-observe/references/storage-metrics.md`). LayerFS keeps byte
 * totals per Store only; summed over one project's Commits these counters are
 * the bytes that project's saves wrote first, and over every project they add
 * up to the Store's `store.stats` totals.
 *
 * No LayerFS call sums them, so the host keeps a ledger per project in
 * `<root>/project-storage/`: one row per Commit id (a Commit never changes).
 * A refresh lists the Branches, walks each moved Branch newest first until a
 * Commit the ledger has, taking the counters from the listing itself
 * (`branch.commits --include-storage`, one call per page instead of one per
 * Commit), and counts main's publications. Reads of one Store run one at a
 * time, so the walk is sequential: page reads of the same Store take their
 * turn between its pages. The first read of a long history runs in the
 * background; the route answers at once with what the ledger holds so far
 * (`partial` until a first read finishes) and the progress of the refresh.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Lfs } from '../layerfs/cli.ts'
import { pages } from './util.ts'

/** Rows per `branch.commits` page (a smaller page when one does not fit). */
const PAGE_SIZES = [100, 25, 5]
/** The same with the storage counters, whose rows are larger (25 fit the reply budget). */
const STORAGE_PAGE_SIZES = [25, 10, 5]
/** The ledger is saved at most this often during a long read, to survive a restart. */
const SAVE_MS = 5000
/** Newest saves the page draws as bars. */
const RECENT = 30
/** Points on the growth line. */
const GROWTH_POINTS = 40
/** A finished refresh is reused this long before the next one starts. */
const FRESH_MS = 15_000
/** Messages are kept this long. */
const MESSAGE = 120

/** One Commit: [time, via, logical, new_canonical, new_stored, new_metadata, branch, message]. */
type Row = [number | null, string | null, number, number, number, number, string, string]

interface Ledger {
  version: 1
  project: string
  created: number | null
  /** Commit id -> its row. */
  commits: Record<string, Row>
  /** Branch -> the head whose walk finished. */
  heads: Record<string, string>
  /** main's publication Layers: how many, their trees' raw bytes, the newest counted. */
  publications: { count: number, logical: number, head: string | null }
  updatedAt: number | null
}

export interface StorageProgress { branches: number, branchesTotal: number, saves: number }

/** A running refresh; `ledger` is the one it fills, read by the view while it runs. */
interface Job { promise: Promise<void>, progress: StorageProgress, ledger: Ledger | null }

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const num = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0
const isCommit = (c: any) => (c?.ref?.kind ?? (String(c?.id).startsWith('32') ? 'Layer' : 'Commit')) === 'Commit'
const counted = (c: any) => typeof c?.new_canonical === 'number' && typeof c?.new_stored === 'number' && typeof c?.new_metadata === 'number'

export class ProjectStorageLedgers {
  readonly directory: string
  private readonly home: string
  private readonly jobs = new Map<string, Job>()
  private readonly errors = new Map<string, any>()
  private readonly finished = new Map<string, number>()
  /** CLI clients that refused `include_storage` (builds older than it); a runtime switch makes a new client. */
  private readonly withoutStorage = new WeakSet<object>()

  constructor(root: string, home: string, private readonly lfs: () => Lfs, private readonly log: (line: string) => void = () => {}, private readonly now: () => number = Date.now) {
    this.directory = join(root, 'project-storage')
    this.home = resolve(home ?? root)
  }

  /** A project record's ledger file: a recreated project (another `created`) starts a new one. */
  path(project: string, created: number | null): string { return join(this.directory, `${digest(`${this.home}\0${project}\0${created ?? ''}`)}.json`) }

  async read(project: string, created: number | null): Promise<Ledger> {
    try {
      const value = JSON.parse(await readFile(this.path(project, created), 'utf8'))
      if (value.version === 1 && value.project === project && value.created === created && value.commits && value.heads && value.publications) return value
    } catch (error: any) {
      if (error.code !== 'ENOENT') this.log(`[host] project storage ledger of ${project}: ${error?.message ?? error}`)
    }
    return { version: 1, project, created, commits: {}, heads: {}, publications: { count: 0, logical: 0, head: null }, updatedAt: null }
  }

  private async write(ledger: Ledger): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    const file = this.path(ledger.project, ledger.created), temp = `${file}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(ledger))
    await rename(temp, file)
  }

  /** Starts a refresh unless one runs or one finished a moment ago; returns the running one. */
  refresh(project: string, created: number | null, force = false): Job | null {
    const key = this.path(project, created)
    const running = this.jobs.get(key)
    if (running) return running
    if (!force && this.now() - (this.finished.get(key) ?? 0) < FRESH_MS) return null
    const job: Job = { promise: Promise.resolve(), progress: { branches: 0, branchesTotal: 0, saves: 0 }, ledger: null }
    job.promise = this.build(project, created, job)
      .then(() => { this.errors.delete(key) }, (error: any) => {
        this.errors.set(key, { code: error?.code ?? 'Failed', message: error?.message ?? String(error), detail: error?.detail ?? null })
        this.log(`[host] project storage of ${project}: ${error?.message ?? error}`)
      })
      .finally(() => { this.jobs.delete(key); this.finished.set(key, this.now()) })
    this.jobs.set(key, job)
    return job
  }

  /** Waits for the running refresh, if any (tests and shutdown). */
  async settle(project: string, created: number | null): Promise<void> { await this.jobs.get(this.path(project, created))?.promise }

  async close(): Promise<void> { await Promise.all([...this.jobs.values()].map((job) => job.promise)) }

  /**
   * Walks `branch` from `head` newest first, handing each page's rows to `take`
   * until `known` matches. A page refused as too large is listed again in
   * smaller pages from the same row on, so no row is taken twice.
   */
  private async walk(project: string, branch: string, head: string, known: (id: string) => boolean, counters: boolean, take: (rows: any[]) => Promise<void>): Promise<void> {
    const storage = counters && !this.withoutStorage.has(this.lfs())
    const sizes = storage ? STORAGE_PAGE_SIZES : PAGE_SIZES
    let taken = 0
    for (const [index, size] of sizes.entries()) {
      try {
        for (;;) {
          const skip = taken % size
          const listed = await this.lfs().branch.commits(project, branch, { page: Math.floor(taken / size) + 1, page_size: size, at_commit: head, ...(storage ? { include_storage: true } : {}) })
          const items: any[] = listed.items ?? []
          const rows: any[] = []
          let reached = false
          for (const c of items.slice(skip)) {
            if (known(c.id)) { reached = true; break }
            rows.push(c)
          }
          taken += rows.length
          await take(rows)
          if (reached || !listed.has_more || items.length <= skip) return
        }
      } catch (error: any) {
        // a CLI older than `--include-storage` refuses the option before listing anything:
        // list without it, and each Commit is read whole (`row`)
        if (storage && taken === 0 && error?.code === 'InvalidInput' && /include_storage/.test(String(error?.message))) {
          this.withoutStorage.add(this.lfs())
          this.log('[host] project storage: this LayerFS CLI lists no storage counters; reading each save')
          return this.walk(project, branch, head, known, counters, take)
        }
        // a page whose reply does not fit is refused whole: list smaller pages
        if (error?.code !== 'Capacity' || index === sizes.length - 1) throw error
      }
    }
  }

  /** A ledger row from a listed Commit; one without counters (an older listing) is read whole. */
  private async row(project: string, branch: string, c: any): Promise<Row> {
    const r = counted(c) ? c : { ...c, ...await this.lfs().branch.get_commit(project, branch, c.id) }
    return [typeof r.time === 'number' ? r.time : null, r.via ?? null, num(r.logical), num(r.new_canonical), num(r.new_stored), num(r.new_metadata), branch, String(r.message ?? '').slice(0, MESSAGE)]
  }

  private async build(project: string, created: number | null, job: Job): Promise<void> {
    const lfs = this.lfs(), progress = job.progress
    const ledger = job.ledger = await this.read(project, created)
    const branches: any[] = await pages((p) => lfs.branch.list(project, p))
    const side = branches.filter((b) => b.name !== 'main' && b.head)
    progress.branchesTotal = side.length
    let dirty = false, lastWrite = this.now()
    // keep progress across a restart of a long first read
    const save = async () => { if (dirty && this.now() - lastWrite > SAVE_MS) { await this.write(ledger); dirty = false; lastWrite = this.now() } }
    for (const b of side) {
      const head: string = b.saved_head?.id ?? b.head
      if (ledger.heads[b.name] !== head) {
        await this.walk(project, b.name, head, (id) => id in ledger.commits, true, async (rows) => {
          for (const c of rows.filter(isCommit)) {
            ledger.commits[c.id] = await this.row(project, b.name, c)
            progress.saves++
          }
          dirty = true
          await save()
        })
        ledger.heads[b.name] = head
        dirty = true
      }
      progress.branches++
      await save()
    }
    // main's publications: Layers, newest first, down to the newest one counted
    const main = branches.find((b) => b.name === 'main')
    const mainHead: string | null = main ? main.saved_head?.id ?? main.base ?? null : null
    if (mainHead && mainHead !== ledger.publications.head) {
      const layers: any[] = []
      await this.walk(project, 'main', mainHead, (id) => id === ledger.publications.head, false, async (rows) => { layers.push(...rows) })
      ledger.publications = {
        count: ledger.publications.count + layers.length,
        logical: ledger.publications.logical + layers.reduce((sum, c) => sum + num(c.logical), 0),
        head: mainHead,
      }
      dirty = true
    }
    ledger.updatedAt = this.now()
    await this.write(ledger)
  }

  /**
   * ProjectStorage: the ledger's totals (null while nothing is counted;
   * `partial` until a first read finishes), the newest saves, the growth of
   * packed bytes, and the running refresh. While a refresh runs the view reads
   * the ledger it fills, so the totals grow as the saves are counted.
   */
  async view(project: string, created: number | null, options: { refresh?: boolean } = {}) {
    const job = this.refresh(project, created, options.refresh === true)
    const key = this.path(project, created)
    const ledger = job?.ledger ?? await this.read(project, created)
    const rows = Object.entries(ledger.commits).sort((a, b) => (a[1][0] ?? 0) - (b[1][0] ?? 0))
    const totals = ledger.updatedAt === null && !rows.length ? null : {
      saves: rows.length,
      merges: rows.filter(([, r]) => r[1] === 'merge').length,
      branches: Object.keys(ledger.heads).length,
      publications: ledger.publications.count,
      commitLogical: rows.reduce((sum, [, r]) => sum + r[2], 0),
      publicationLogical: ledger.publications.logical,
      canonical: rows.reduce((sum, [, r]) => sum + r[3], 0),
      stored: rows.reduce((sum, [, r]) => sum + r[4], 0),
      metadata: rows.reduce((sum, [, r]) => sum + r[5], 0),
    }
    const growth: number[] = []
    if (rows.length) {
      let sum = 0, at = 0
      for (let i = 0; i < GROWTH_POINTS; i++) {
        const end = Math.ceil((i + 1) * rows.length / GROWTH_POINTS)
        for (; at < end; at++) sum += rows[at][1][4]
        growth.push(sum)
      }
    }
    return {
      project,
      totals,
      growth,
      recent: rows.slice(-RECENT).map(([id, r]) => ({ id, time: r[0], via: r[1], logical: r[2], stored: r[4], branch: r[6], message: r[7] })),
      updatedAt: ledger.updatedAt,
      partial: ledger.updatedAt === null,
      building: job ? { ...job.progress } : null,
      error: job ? null : this.errors.get(key) ?? null,
    }
  }
}
