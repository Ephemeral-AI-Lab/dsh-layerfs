/**
 * Project exports to a folder on this computer (`project.export`), run by the
 * host in the background. `POST /api/project-exports { project, branch?,
 * commit?, folder, name? }` answers the `queued` job at once; the export runs
 * here, in memory, and every change is a `project-export { export }` event
 * (byte updates coalesced to one every 500 ms per job).
 *
 * - The version is fixed before the copy starts: `project.stats` reads the
 *   Branch's head (or the named Commit) and its size, and the export runs
 *   `--branch B --at <that commit>`, so a Branch that moves meanwhile changes
 *   nothing and the size is the progress total (the CLI reports no total).
 *   LayerFS refuses an `--at` outside the Branch's history.
 * - The export always makes a new folder `<folder>/<name>`: the first of
 *   `name`, `name-2`, … that neither exists nor is held by a running export.
 * - Stop: the CLI's process group is ended (SIGTERM). LayerFS puts the folder
 *   in place only at `finalize`, so a stopped export leaves nothing; while it
 *   finalizes, stop is refused (it is about to finish). A stop that reaches a
 *   job still queued ends its process as soon as it starts.
 * - Ended jobs (done, stopped, failed) stay listed for {@link ENDED_KEEP_MS},
 *   or until dismissed, so a page opened later still shows the outcome.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fixOf, projectRef, refuse, type RouteHost } from './util.ts'

export type ExportPhase = 'queued' | 'prepare' | 'export' | 'finalize' | 'stopping' | 'done' | 'stopped' | 'failed'

/** One export: the admission answer, a list row and the event payload. */
export interface ProjectExport {
  /** `x-<base36 time>-<4 random>`. */
  id: string
  /** `<store>/<project>`. */
  project: string
  branch: string
  /** The Commit exported: the one asked for, else the Branch's head once read. */
  commit: string | null
  /** Whether `commit` was the Branch's head when the export started (none was named, or the one named was the head). */
  head: boolean
  /** The folder chosen and the new folder the export makes in it. */
  folder: string
  destination: string
  phase: ExportPhase
  /** Bytes copied and the tree's size (from `project.stats`). */
  done: number | null
  total: number | null
  /** Files in the tree (stats, then the export's own answer). */
  files: number | null
  error?: { code: string, message: string, detail?: unknown, fix?: string }
  startedAt: number
  updatedAt: number
  endedAt: number | null
}

/** How long an ended export stays listed. */
export const ENDED_KEEP_MS = 30 * 60_000
/** Byte updates within a phase: at most one event per job this often. */
export const BYTES_EVERY_MS = 500
const RUNNING = new Set<ExportPhase>(['queued', 'prepare', 'export', 'finalize', 'stopping'])
const CLI_PHASES = new Set<ExportPhase>(['prepare', 'export', 'finalize'])

const newId = () => `x-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`
const num = (v: unknown): number | null => {
  const n = typeof v === 'bigint' ? Number(v) : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null
}
/** A folder name from free text: letters, digits, `.`, `_`, `-`; other runs become `-`. */
export function folderName(text: string): string {
  return text.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '').slice(0, 120)
}
/** The default name: the project for main's head, else the project, Branch and short Commit. */
export function defaultName(project: string, branch: string, commit: string | null): string {
  const { name } = projectRef(project)
  if (branch === 'main' && !commit) return folderName(name) || 'project'
  return folderName([name, branch, commit?.slice(0, 8)].filter(Boolean).join('-')) || 'project'
}
const inside = (parent: string | null, child: string) => {
  if (!parent) return false
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}
const safeReal = (path: string): string | null => { try { return realpathSync(path) } catch { return null } }

interface Running {
  pid: number | null
  stop: boolean
  timer: NodeJS.Timeout | null
  last: number
}

export class ProjectExports {
  private readonly jobs = new Map<string, ProjectExport>()
  private readonly running = new Map<string, Running>()

  constructor(private readonly host: RouteHost, private readonly kill: (pid: number, signal: NodeJS.Signals) => void = killGroup) {}

  /** Admits an export and starts it in the background; answers the `queued` job. */
  start(input: any): ProjectExport {
    const { key: project } = projectRef(input?.project)
    const branch = input?.branch === undefined || input?.branch === null || input?.branch === '' ? 'main' : input.branch
    if (typeof branch !== 'string' || branch.includes('\0') || branch.length > 255) throw refuse(400, 'InvalidInput', 'Name the Branch to export.')
    const commit = input?.commit === undefined || input?.commit === null || input?.commit === '' ? null : input.commit
    if (commit !== null && (typeof commit !== 'string' || !/^[0-9a-f]{8,128}$/i.test(commit))) throw refuse(400, 'InvalidInput', 'A Commit id has 8 or more hexadecimal characters.')
    const folder = this.checkFolder(input?.folder)
    const asked = typeof input?.name === 'string' && input.name.trim() ? folderName(input.name.trim()) : ''
    const destination = this.freeName(folder, asked || defaultName(project, branch, commit))
    const now = Date.now()
    const job: ProjectExport = { id: newId(), project, branch, commit, head: commit === null, folder, destination, phase: 'queued', done: null, total: null, files: null, startedAt: now, updatedAt: now, endedAt: null }
    this.jobs.set(job.id, job)
    const run: Running = { pid: null, stop: false, timer: null, last: 0 }
    this.running.set(job.id, run)
    this.send(job)
    const admitted = { ...job }
    void this.run(job, run)
    return admitted
  }

  private async run(job: ProjectExport, run: Running): Promise<void> {
    try {
      const lfs = this.host.lfs()
      const stats: any = await lfs.project.stats(job.project, { branch: job.branch, ...(job.commit ? { at: job.commit } : {}), detail: true })
      job.commit = typeof stats?.commit === 'string' ? stats.commit : job.commit
      // a named Commit is "latest" when it is the Branch's head now (Home sends main's head as it read it)
      if (!job.head && job.commit) {
        const head = await lfs.branch.get(job.project, job.branch).then((b: any) => (typeof b?.commit === 'string' ? b.commit : null), () => null)
        job.head = !!head && head === job.commit
      }
      job.total = num(stats?.size)
      job.files = num(stats?.file_count)
      if (run.stop) throw Object.assign(new Error('stopped'), { code: 'Cancelled' })
      this.touch(job, true)
      const answer: any = await lfs.project.export(job.project, job.destination, {
        branch: job.branch,
        ...(job.commit ? { at: job.commit } : {}),
        detail: true,
        on_progress: (p: any) => this.progress(job, p),
        on_spawn: (pid: number) => {
          run.pid = pid
          if (run.stop) this.signal(run)
        },
      })
      job.files = num(answer?.file_count) ?? job.files
      job.total = num(answer?.size) ?? job.total
      job.done = job.total
      this.finish(job, 'done')
    } catch (error: any) {
      // LayerFS makes the folder only when the copy is complete: one there now finished before the stop landed
      if (run.stop && existsSync(job.destination)) { job.done = job.total; this.finish(job, 'done'); return }
      if (run.stop) { this.finish(job, 'stopped'); return }
      const detail = error?.detail && typeof error.detail === 'object' ? error.detail : undefined
      this.finish(job, 'failed', { code: typeof error?.code === 'string' ? error.code : 'Unknown', message: error?.message ?? String(error), ...(detail ? { detail } : {}), ...fixOf(error) })
      this.host.log(`[host] exporting ${job.project}: ${error?.message ?? error}`)
    }
  }

  /** Running exports and ended ones younger than {@link ENDED_KEEP_MS}; `project` narrows to one project. */
  list(project?: string | null): { exports: ProjectExport[] } {
    this.expire()
    return { exports: [...this.jobs.values()].filter((j) => !project || j.project === project).reverse().map((j) => ({ ...j })) }
  }

  get(id: string): ProjectExport {
    const job = this.jobs.get(id)
    if (!job) throw refuse(404, 'NotFound', 'This export is no longer listed.')
    return { ...job }
  }

  /** Ends a running export; refused once it finalizes (it is about to finish) or after it ended. */
  stop(id: string): ProjectExport {
    const job = this.jobs.get(id)
    const run = this.running.get(id)
    if (!job) throw refuse(404, 'NotFound', 'This export is no longer listed.')
    if (!run || !RUNNING.has(job.phase)) throw refuse(409, 'Conflict', 'This export has already ended.')
    if (job.phase === 'finalize') throw refuse(409, 'Busy', 'The export is finishing and can no longer be stopped.')
    if (!run.stop) {
      run.stop = true
      job.phase = 'stopping'
      this.touch(job, true)
      if (run.pid) this.signal(run)
    }
    return { ...job }
  }

  /** Forgets an ended export; a running one is refused (stop it first). */
  dismiss(id: string): { exports: ProjectExport[] } {
    const job = this.jobs.get(id)
    if (!job) throw refuse(404, 'NotFound', 'This export is no longer listed.')
    if (RUNNING.has(job.phase)) throw refuse(409, 'Busy', 'This export is still running. Stop it first.')
    this.jobs.delete(id)
    return this.list()
  }

  /** Shows a finished export's folder in the file manager (Finder on macOS). */
  reveal(id: string): { ok: true } {
    const job = this.get(id)
    if (job.phase !== 'done' || !existsSync(job.destination)) throw refuse(404, 'NotFound', 'The exported folder is no longer there.')
    const [cmd, args] = process.platform === 'darwin' ? ['open', ['-R', job.destination]]
      : process.platform === 'win32' ? ['explorer', [`/select,${job.destination}`]]
        : ['xdg-open', [dirname(job.destination)]]
    const child = spawn(cmd, args as string[], { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
    return { ok: true }
  }

  /** Whether an export is running (for runtime admission). */
  busy(): boolean { return [...this.jobs.values()].some((j) => RUNNING.has(j.phase)) }

  /** The host is going away: running exports are ended (they leave nothing). */
  close(): void {
    for (const run of this.running.values()) {
      run.stop = true
      if (run.pid) this.signal(run)
      if (run.timer) clearTimeout(run.timer)
    }
  }

  /** An existing absolute folder outside the LayerFS home and this plugin's state; answers its real path. */
  checkFolder(folder: unknown): string {
    if (typeof folder !== 'string' || !isAbsolute(folder) || folder.includes('\0')) throw refuse(400, 'InvalidInput', 'Choose an existing folder, written as an absolute path.')
    const real = safeReal(folder)
    if (!real || !statSync(real, { throwIfNoEntry: false })?.isDirectory()) throw refuse(400, 'InvalidInput', `${folder} is not an existing folder.`)
    if (inside(safeReal(this.host.home), real)) throw refuse(400, 'InvalidInput', `Choose a folder outside the LayerFS home (${this.host.home}).`)
    if (inside(safeReal(this.host.root), real)) throw refuse(400, 'InvalidInput', 'Choose a folder outside DeepSeek Harness\'s LayerFS state.')
    if (this.host.folder && inside(safeReal(this.host.folder), real)) throw refuse(400, 'InvalidInput', `Choose a folder outside the LayerFS folder (${this.host.folder}).`)
    return real
  }

  /** `<folder>/<name>`, else `name-2`, `name-3`, …: free on disk and not held by a running export. */
  private freeName(folder: string, name: string): string {
    const held = new Set([...this.jobs.values()].filter((j) => RUNNING.has(j.phase)).map((j) => j.destination))
    for (let n = 1; n < 1000; n++) {
      const candidate = join(folder, n === 1 ? name : `${name}-${n}`)
      if (!held.has(candidate) && !existsSync(candidate)) return candidate
    }
    throw refuse(409, 'Exists', `${basename(name)} and its numbered names are all taken in ${folder}.`)
  }

  private progress(job: ProjectExport, p: any): void {
    if (!RUNNING.has(job.phase) || job.phase === 'stopping') return
    const phase = typeof p?.phase === 'string' && CLI_PHASES.has(p.phase as ExportPhase) ? p.phase as ExportPhase : job.phase
    const done = num(p?.done)
    const changed = phase !== job.phase
    job.phase = phase
    if (done !== null) job.done = job.total !== null ? Math.min(done, job.total) : done
    this.touch(job, changed)
  }

  private signal(run: Running): void {
    if (!run.pid) return
    try { this.kill(run.pid, 'SIGTERM') } catch { /* already gone */ }
  }

  private finish(job: ProjectExport, phase: 'done' | 'stopped' | 'failed', error?: ProjectExport['error']): void {
    job.phase = phase
    if (error) job.error = error
    job.endedAt = Date.now()
    const run = this.running.get(job.id)
    if (run?.timer) clearTimeout(run.timer)
    this.running.delete(job.id)
    this.touch(job, true)
  }

  private expire(): void {
    const now = Date.now()
    for (const [id, j] of this.jobs) if (j.endedAt !== null && now - j.endedAt >= ENDED_KEEP_MS) this.jobs.delete(id)
  }

  /** A phase change goes out at once; bytes within the same phase at most every {@link BYTES_EVERY_MS}. */
  private touch(job: ProjectExport, now: boolean): void {
    job.updatedAt = Date.now()
    const run = this.running.get(job.id)
    if (now || !run) { this.send(job); return }
    if (run.timer) return
    const wait = BYTES_EVERY_MS - (Date.now() - run.last)
    if (wait <= 0) { this.send(job); return }
    run.timer = setTimeout(() => { run.timer = null; if (RUNNING.has(job.phase)) this.send(job) }, wait)
  }

  private send(job: ProjectExport): void {
    const run = this.running.get(job.id)
    if (run) {
      if (run.timer) { clearTimeout(run.timer); run.timer = null }
      run.last = Date.now()
    }
    this.host.emit('project-export', { type: 'project-export', export: { ...job } })
  }
}

/** Signal a CLI's whole process group (it was spawned detached), else the process itself. */
export function killGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal) } catch { process.kill(pid, signal) }
}
