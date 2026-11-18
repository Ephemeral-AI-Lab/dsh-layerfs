/**
 * Image copies the host runs in the background: `POST /api/machines/:id/load-image
 * { image }` answers `202 { load }` at once and `machine.load_image` (copy an image
 * from this computer's Docker to the machine without creating a Sandbox) runs
 * here, in memory. Every phase change is an `image-load { load }` event at
 * once; byte updates within the copy are coalesced to one event every 500 ms,
 * carried over between the copy's steps as a create's are ({@link bytesAfter}).
 *
 * `GET /api/image-loads` lists running copies and failed ones (for 10
 * minutes, or until the same image is copied to the same machine again); a
 * done copy leaves the list. `DELETE /api/image-loads/:id` dismisses a failed
 * one. Leaving the page cancels nothing: the copy belongs to the host. One
 * attempt: a failed copy is never sent again by the host.
 */
import { randomBytes } from 'node:crypto'
import { bytesAfter, BYTES_EVERY_MS, FAILED_KEEP_MS, type CreationPhase } from './sandbox-creates.ts'
import { fixOf, refuse } from './util.ts'

export type LoadPhase = 'queued' | 'inspect' | 'lock' | 'export' | 'send' | 'unpack' | 'done' | 'failed'

/** One copy: the admission answer, a list row and the event payload. */
export interface ImageLoad {
  /** `l-<base36 time>-<4 random>`. */
  id: string
  machine: string
  /** The Docker image as the client named it (its Id). */
  image: string
  phase: LoadPhase
  done?: number
  total?: number
  /** Phase `done`: LayerFS already had it (`reused`). */
  reused?: boolean
  /** Phase `done`: how many FIFO and device paths the copy left out (`dropped`, the first 20, or `dropped_count` beside a cut list). */
  dropped?: number
  /** Phase `failed`: the refusal. */
  error?: { code: string, message: string, detail?: unknown, fix?: string }
  startedAt: number
  updatedAt: number
}

export type LoadReport = (update: { phase: Exclude<LoadPhase, 'queued' | 'done' | 'failed'>, done?: number, total?: number }) => void

const newId = () => `l-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`
const copyOf = (j: ImageLoad): ImageLoad => ({ ...j, ...(j.error ? { error: { ...j.error } } : {}) })

export class ImageLoads {
  private readonly jobs = new Map<string, ImageLoad>()
  private readonly last = new Map<string, { timer: NodeJS.Timeout | null, at: number }>()

  /**
   * @param emit - publishes a host event (`image-load`).
   * @param settled - after a copy ends, done or failed.
   */
  constructor(private readonly emit: (type: string, data: unknown) => void, private readonly settled: (machine: string) => void = () => {}) {}

  /** A copy of `image` to `machine` already running, if any (the route answers it instead of starting another). */
  running(machine: string, image: string): ImageLoad | undefined {
    for (const j of this.jobs.values()) if (j.machine === machine && j.image === image && j.phase !== 'failed') return copyOf(j)
    return undefined
  }

  /** Admits a copy and starts `run` in the background; answers the `queued` entry. A failed copy of the same image to the same machine leaves the list. */
  admit(machine: string, image: string, run: (report: LoadReport) => Promise<{ reused?: boolean, dropped?: string[], dropped_count?: number } | unknown>): ImageLoad {
    for (const [id, j] of this.jobs) if (j.phase === 'failed' && j.machine === machine && j.image === image) this.jobs.delete(id)
    const now = Date.now()
    const job: ImageLoad = { id: newId(), machine, image, phase: 'queued', startedAt: now, updatedAt: now }
    this.jobs.set(job.id, job)
    this.send(job)
    const admitted = copyOf(job)
    void (async () => {
      try {
        await Promise.resolve()
        const answer: any = await run((u) => this.update(job.id, u))
        const dropped = typeof answer?.dropped_count === 'number' ? answer.dropped_count : Array.isArray(answer?.dropped) ? answer.dropped.length : 0
        this.finish(job.id, { reused: answer?.reused === true, dropped })
      } catch (error: any) {
        const detail = error?.detail && typeof error.detail === 'object' ? error.detail : undefined
        this.finish(job.id, { error: { code: typeof error?.code === 'string' ? error.code : 'Unknown', message: error?.message ?? String(error), ...(detail ? { detail } : {}), ...fixOf(error) } })
      }
    })()
    return admitted
  }

  /** Running copies and failed ones younger than {@link FAILED_KEEP_MS}. */
  list(): { loads: ImageLoad[] } {
    const now = Date.now()
    for (const [id, j] of this.jobs) if (j.phase === 'failed' && now - j.updatedAt >= FAILED_KEEP_MS) this.jobs.delete(id)
    return { loads: [...this.jobs.values()].map(copyOf) }
  }

  /** Dismisses a failed copy; a running one is refused (it cannot be cancelled). */
  dismiss(id: string): { loads: ImageLoad[] } {
    const job = this.jobs.get(id)
    if (!job) throw refuse(404, 'NotFound', `no image copy ${id}`)
    if (job.phase !== 'failed') throw refuse(409, 'Busy', `the image is still being copied to ${job.machine}`)
    this.jobs.delete(id)
    return this.list()
  }

  /** A phase change goes out at once; bytes within the copy at most every {@link BYTES_EVERY_MS}. */
  private update(id: string, u: { phase: LoadPhase, done?: number, total?: number }): void {
    const job = this.jobs.get(id)
    if (!job || job.phase === 'done' || job.phase === 'failed') return
    const bytes = bytesAfter(job as { phase: CreationPhase, done?: number, total?: number }, u as { phase: CreationPhase, done?: number, total?: number })
    const changed = u.phase !== job.phase && !(job.total !== undefined && u.phase !== 'unpack' && job.phase !== 'unpack')
    job.phase = u.phase
    if (bytes.done !== undefined) job.done = bytes.done; else delete job.done
    if (bytes.total !== undefined) job.total = bytes.total; else delete job.total
    job.updatedAt = Date.now()
    if (changed) { this.send(job); return }
    const p = this.last.get(id) ?? { timer: null, at: 0 }
    this.last.set(id, p)
    if (p.timer) return
    const wait = BYTES_EVERY_MS - (Date.now() - p.at)
    if (wait <= 0) { this.send(job); return }
    p.timer = setTimeout(() => { p.timer = null; const now = this.jobs.get(id); if (now && now.phase !== 'done' && now.phase !== 'failed') this.send(now) }, wait)
  }

  private finish(id: string, end: { reused?: boolean, dropped?: number, error?: ImageLoad['error'] }): void {
    const job = this.jobs.get(id)
    if (!job) return
    job.phase = end.error ? 'failed' : 'done'
    delete job.done
    delete job.total
    if (end.error) job.error = end.error
    if (end.reused) job.reused = true
    if (end.dropped) job.dropped = end.dropped
    job.updatedAt = Date.now()
    this.send(job)
    const p = this.last.get(id)
    if (p?.timer) clearTimeout(p.timer)
    this.last.delete(id)
    if (job.phase === 'done') this.jobs.delete(id)
    try { this.settled(job.machine) } catch {}
  }

  private send(job: ImageLoad): void {
    const p = this.last.get(job.id)
    if (p) { if (p.timer) { clearTimeout(p.timer); p.timer = null } p.at = Date.now() } else this.last.set(job.id, { timer: null, at: Date.now() })
    this.emit('image-load', { type: 'image-load', load: copyOf(job) })
  }
}
