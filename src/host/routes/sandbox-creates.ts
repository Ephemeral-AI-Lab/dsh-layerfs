/**
 * Sandbox creations the host runs in the background (docs/specs/sandbox-images.md
 * §4.1, D10): `POST /api/projects/:key/sandboxes { …, background: true }`
 * answers `202 { creation }` at once and the create runs here, in memory.
 * Every phase change is a `sandbox-progress { creation }` event at once; byte
 * updates within a phase (and steps within the image copy once its bytes are
 * known) are coalesced per job to one event every 500 ms. Within the copy the
 * last known bytes carry over ({@link bytesAfter}).
 *
 * `GET /api/sandbox-creates` lists the running jobs and the failed ones
 * (for 10 minutes, or until the same project and name are created again);
 * a done job leaves the list. `DELETE /api/sandbox-creates/:id` dismisses a
 * failed job. Retry is the client re-sending `input` (a new job). Closing the
 * dialog cancels nothing: the job belongs to the host.
 */
import { randomBytes } from 'node:crypto'
import { refuse } from './util.ts'

export type CreationPhase = 'queued' | 'machine' | 'inspect' | 'export' | 'send' | 'unpack' | 'start' | 'done' | 'failed'

/** One creation job: the admission answer, a list row and the event payload. */
export interface Creation {
  /** `c-<base36 time>-<4 random>`. */
  id: string
  input: { project: string, name: string, machine: string, image?: string, start?: boolean }
  phase: CreationPhase
  /** Bytes, only while a phase reports them. */
  done?: number
  total?: number
  /** Phase `failed`: the refusal. */
  error?: { code: string, message: string, detail?: unknown }
  startedAt: number
  updatedAt: number
}

/** What a job's body reports: a phase, with bytes while the phase has them. */
export type Report = (update: { phase: CreationPhase, done?: number, total?: number }) => void

/** The image copy's phases: bytes reported in one carry over to the next while the copy goes on. */
const COPY = new Set<CreationPhase>(['inspect', 'export', 'send'])

/**
 * A job's bytes after an update (§4.1): what the update reports; within the
 * copy (inspect, export, send), a report without bytes keeps the last known
 * ones and `done` never goes back for the same `total`, so the row never
 * flickers back to a bare "Copying image" nor its bar backwards. Any other
 * phase (unpack, start) has only its own bytes.
 */
export function bytesAfter(job: Pick<Creation, 'phase' | 'done' | 'total'>, u: { phase: CreationPhase, done?: number, total?: number }): { done?: number, total?: number } {
  const carry = COPY.has(u.phase) && COPY.has(job.phase)
  const total = typeof u.total === 'number' ? u.total : carry ? job.total : undefined
  let done = typeof u.done === 'number' ? u.done : carry ? job.done : undefined
  if (carry && done !== undefined && job.done !== undefined && total === job.total && done < job.done) done = job.done
  return { ...(done !== undefined ? { done } : {}), ...(total !== undefined ? { total } : {}) }
}

/** How long a failed job stays listed. */
export const FAILED_KEEP_MS = 10 * 60_000
/** Byte updates within a phase: at most one event per job this often. */
export const BYTES_EVERY_MS = 500

const newId = () => `c-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`

export class SandboxCreates {
  private readonly jobs = new Map<string, Creation>()
  /** Per job: a byte update held back, and when the last event went out. */
  private readonly pending = new Map<string, { timer: NodeJS.Timeout | null, last: number }>()

  /**
   * @param emit - publishes a host event (`sandbox-progress`).
   * @param settled - after a job ends, done or failed (the machines view reads anew).
   */
  constructor(private readonly emit: (type: string, data: unknown) => void, public settled: () => void = () => {}) {}

  /**
   * Admits a job and starts `run` in the background; answers the `queued`
   * entry. A failed job for the same project and name leaves the list.
   */
  admit(input: Creation['input'], run: (report: Report) => Promise<unknown>): Creation {
    this.forgetFailed(input.project, input.name)
    const now = Date.now()
    const job: Creation = { id: newId(), input: { ...input }, phase: 'queued', startedAt: now, updatedAt: now }
    this.jobs.set(job.id, job)
    this.send(job)
    const admitted = { ...job, input: { ...job.input } }
    const report: Report = (u) => this.update(job.id, u)
    void (async () => {
      try {
        await Promise.resolve()
        await run(report)
        this.finish(job.id, 'done')
      } catch (error: any) {
        const detail = error?.detail && typeof error.detail === 'object' ? error.detail : undefined
        this.finish(job.id, 'failed', { code: typeof error?.code === 'string' ? error.code : 'Unknown', message: error?.message ?? String(error), ...(detail ? { detail } : {}) })
      }
    })()
    return admitted
  }

  /** Running jobs and failed ones younger than {@link FAILED_KEEP_MS}. */
  list(): { creations: Creation[] } {
    this.expire()
    return { creations: [...this.jobs.values()].map((j) => ({ ...j, input: { ...j.input } })) }
  }

  /** Dismisses a failed job; a running one is refused (closing cancels nothing). */
  dismiss(id: string): { creations: Creation[] } {
    const job = this.jobs.get(id)
    if (!job) throw refuse(404, 'NotFound', `no Sandbox creation ${id}`)
    if (job.phase !== 'failed') throw refuse(409, 'Busy', `Sandbox ${job.input.name} is still being created`)
    this.jobs.delete(id)
    return this.list()
  }

  /** A create of `project`/`name` succeeded anywhere (also without `background`): its failed jobs go. */
  created(project: string, name: string): void { this.forgetFailed(project, name) }

  private forgetFailed(project: string, name: string): void {
    for (const [id, j] of this.jobs) if (j.phase === 'failed' && j.input.project === project && j.input.name === name) this.jobs.delete(id)
  }

  private expire(): void {
    const now = Date.now()
    for (const [id, j] of this.jobs) if (j.phase === 'failed' && now - j.updatedAt >= FAILED_KEEP_MS) this.jobs.delete(id)
  }

  /** A phase change goes out at once; bytes within the same phase at most every {@link BYTES_EVERY_MS}. */
  private update(id: string, u: { phase: CreationPhase, done?: number, total?: number }): void {
    const job = this.jobs.get(id)
    if (!job || job.phase === 'done' || job.phase === 'failed') return
    const bytes = bytesAfter(job, u)
    // a step within the copy once bytes are known reads the same ("Copying image x of y"): coalesced like bytes
    const changed = u.phase !== job.phase && !(COPY.has(u.phase) && COPY.has(job.phase) && job.total !== undefined)
    job.phase = u.phase
    if (bytes.done !== undefined) job.done = bytes.done; else delete job.done
    if (bytes.total !== undefined) job.total = bytes.total; else delete job.total
    job.updatedAt = Date.now()
    if (changed) { this.send(job); return }
    const p = this.pending.get(id) ?? { timer: null, last: 0 }
    this.pending.set(id, p)
    if (p.timer) return
    const wait = BYTES_EVERY_MS - (Date.now() - p.last)
    if (wait <= 0) { this.send(job); return }
    p.timer = setTimeout(() => { p.timer = null; const now = this.jobs.get(id); if (now && now.phase !== 'done' && now.phase !== 'failed') this.send(now) }, wait)
  }

  private finish(id: string, phase: 'done' | 'failed', error?: Creation['error']): void {
    const job = this.jobs.get(id)
    if (!job) return
    job.phase = phase
    delete job.done
    delete job.total
    if (error) job.error = error
    job.updatedAt = Date.now()
    this.send(job)
    const p = this.pending.get(id)
    if (p?.timer) clearTimeout(p.timer)
    this.pending.delete(id)
    if (phase === 'done') {
      this.jobs.delete(id)
      this.forgetFailed(job.input.project, job.input.name)
    }
    try { this.settled() } catch {}
  }

  private send(job: Creation): void {
    const p = this.pending.get(job.id)
    if (p) {
      if (p.timer) { clearTimeout(p.timer); p.timer = null }
      p.last = Date.now()
    } else this.pending.set(job.id, { timer: null, last: Date.now() })
    this.emit('sandbox-progress', { type: 'sandbox-progress', creation: { ...job, input: { ...job.input } } })
  }
}
