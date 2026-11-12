/**
 * Targeted Doctor diagnoses as a dedicated bounded queue; navigation and
 * reconnect never launch work. Port of Connect `host/doctor/` (without the
 * activity recorder). Jobs persist in `<root>/doctor-jobs.json`.
 * Event: `doctor` `{ type, id, state }` whenever a job changes.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execute, type CliSpec } from '../layerfs/cli.ts'
import { refuse, stringify, wire, type RouteHost } from './util.ts'

const targets = new Set(['host', 'machine', 'sandbox', 'store.integrity', 'store.connection', 'backup.connection'])
const invalid = (message: string) => refuse(400, 'InvalidInput', message)

/** Targeted reports require scope and coverage, never the legacy findings shape. */
export function validateReport(report: any, request: any) {
  const [family, operation = 'diagnose'] = request.target.split('.')
  const mode = request.target === 'store.integrity' ? (request.quick ? 'quick' : 'full') : request.write_test ? 'write-test' : 'observation'
  if (!report || typeof report.ok !== 'boolean' || typeof report.truncated !== 'boolean' || !report.counts || typeof report.counts !== 'object' || !Array.isArray(report.checks) || !Array.isArray(report.findings) || typeof report.complete !== 'boolean' || report.target?.kind !== family || report.target?.name !== (request.name ?? 'local') || report.mode !== mode || report.operation !== operation) {
    throw refuse(null, 'InvalidReport', 'Interrupted — no valid targeted Doctor report.')
  }
  return report
}

/**
 * A report's verdict in numbers, for lists that carry no report (the
 * Overview's Health grid): errors and warnings from findings or failed checks,
 * whichever names more, checks left unverified or skipped, and the first
 * findings in LayerFS's words.
 */
export function summarize(report: any) {
  const findings: any[] = Array.isArray(report?.findings) ? report.findings : []
  const checks: any[] = Array.isArray(report?.checks) ? report.checks : []
  const failed = (severity: string) => checks.filter((c) => c?.outcome === 'fail' && (c.severity ?? 'error') === severity).length
  const found = (severity: string) => findings.filter((f) => f?.severity === severity).length
  return {
    ok: report?.ok === true,
    complete: report?.complete === true,
    mode: typeof report?.mode === 'string' ? report.mode : null,
    errors: Math.max(found('error'), failed('error')),
    warnings: Math.max(found('warning'), failed('warning')),
    unverified: checks.filter((c) => !['pass', 'fail', 'skipped'].includes(c?.outcome)).length,
    skipped: checks.filter((c) => c?.outcome === 'skipped').length,
    findings: (findings.length ? findings : checks.filter((c) => c?.outcome === 'fail'))
      .slice(0, 8)
      .map((f) => ({ severity: f.severity === 'warning' ? 'warning' : 'error', message: String(f.message ?? ''), fix: typeof f.fix === 'string' ? f.fix : null })),
  }
}

type Run = (spec: CliSpec, argv: string[], options: { read: boolean, onSpawn: (child: { pid?: number }) => void }) => Promise<any>

export class DoctorManager {
  readonly file: string
  readonly jobs = new Map<string, any>()
  private active = 0

  constructor(private readonly host: RouteHost, private readonly run: Run = execute as never, private readonly maxActive = 2, private readonly maxReports = 40, private readonly maxBytes = 8 * 1024 * 1024) {
    this.file = join(host.jobs, 'doctor-jobs.json')
    if (existsSync(this.file)) for (const job of JSON.parse(readFileSync(this.file, 'utf8'))) {
      if (['queued', 'running'].includes(job.state)) Object.assign(job, { state: 'interrupted', error: 'Interrupted — final result unavailable after host restart.', ended: Date.now() })
      this.jobs.set(job.id, job)
    }
    this.persist()
  }

  persist(): void {
    const completed = () => [...this.jobs.values()].filter((j) => !['queued', 'running'].includes(j.state))
    while ((this.jobs.size > this.maxReports || Buffer.byteLength(stringify([...this.jobs.values()])) > this.maxBytes) && completed().length > 1) this.jobs.delete(completed()[0].id)
    mkdirSync(this.host.jobs, { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.tmp`
    writeFileSync(temporary, stringify([...this.jobs.values()]), { mode: 0o600 })
    renameSync(temporary, this.file)
  }

  changed(job: any): void {
    this.persist()
    this.host.emit('doctor', wire({ type: 'doctor', id: job.id, state: job.state }))
  }

  /** Whether a diagnosis is queued or running. */
  busy(): boolean { return [...this.jobs.values()].some((j) => ['queued', 'running'].includes(j.state)) }

  list() { return [...this.jobs.values()].map(({ report, ...job }) => ({ ...job, hasReport: !!report, ...(report ? { summary: summarize(report) } : {}) })).reverse() }

  get(id: string) { const job = this.jobs.get(id); if (!job) throw refuse(404, 'failed', 'Doctor report unavailable or expired.'); return job }

  async launch(input: any) {
    const { target, name, timeout, quick, write_test, key } = input
    if (!targets.has(target) || typeof key !== 'string' || !key || key.length > 128) throw invalid('Choose a supported Doctor target and launch key.')
    if (Object.keys(input).some((k) => !['target', 'name', 'timeout', 'quick', 'write_test', 'key'].includes(k))) throw invalid('Unknown Doctor option.')
    if (target !== 'host' && (typeof name !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,62}$/.test(name))) throw invalid('Choose a saved resource name.')
    if (target === 'host' && name !== undefined) throw invalid('Host diagnosis has no resource name.')
    if (quick !== undefined && (target !== 'store.integrity' || typeof quick !== 'boolean')) throw invalid('Quick applies only to Store integrity.')
    if (write_test !== undefined && (target !== 'backup.connection' || typeof write_test !== 'boolean')) throw invalid('Write test applies only to Backup connection.')
    if (timeout !== undefined && !/^[1-9]\d*(ms|s|m|h)$/.test(timeout)) throw invalid('Time budget must be a positive ms/s/m/h duration.')
    const capability = await this.host.discover()
    const command = `doctor ${target.replaceAll('.', ' ')}`
    if (!capability.commands.some((c: any) => (typeof c === 'string' ? c : c?.name) === command)) throw refuse(409, 'Unsupported', 'Diagnostics unavailable for this CLI/runtime.')
    const previous = [...this.jobs.values()].find((j) => j.key === key)
    if (previous) {
      if (JSON.stringify(previous.request) !== JSON.stringify({ target, name, timeout, quick, write_test })) throw invalid('Launch key already belongs to another diagnosis.')
      return previous
    }
    if (target === 'store.integrity' && [...this.jobs.values()].some((j) => ['queued', 'running'].includes(j.state) && j.request.target === target && j.request.name === name)) throw refuse(409, 'failed', 'An integrity audit is already queued or running for this Store.')
    if ([...this.jobs.values()].filter((j) => ['queued', 'running'].includes(j.state)).length >= this.maxReports) throw refuse(409, 'failed', 'Doctor queue is full; wait for an active diagnosis to finish.')
    const job = { id: randomUUID(), key, request: { target, name, timeout, quick, write_test }, state: 'queued', created: Date.now(), simulated: false, identity: capability.identity }
    this.jobs.set(job.id, job)
    this.changed(job)
    void this.drain()
    return job
  }

  async drain(): Promise<void> {
    if (this.active >= this.maxActive) return
    const job = [...this.jobs.values()].find((j) => j.state === 'queued')
    if (!job) return
    this.active++
    Object.assign(job, { state: 'running', started: Date.now() })
    this.changed(job)
    const request = job.request
    const argv = ['doctor', ...request.target.split('.'), ...(request.name ? [request.name] : []), ...(request.quick ? ['--quick'] : []), ...(request.write_test ? ['--write-test'] : []), ...(request.timeout ? ['--timeout', request.timeout] : [])]
    try {
      job.report = validateReport(await this.run(this.host.lfs().spec, argv, { read: true, onSpawn: (child) => { job.pid = child.pid; this.changed(job) } }), request)
      job.state = 'completed'
      if (Buffer.byteLength(stringify(job)) > this.maxBytes / 2) { delete job.report; job.error = 'Report exceeded the retention budget; final report unavailable.' }
    } catch (error: any) {
      job.state = error?.code === 'Unsupported' || error?.code === 'CliIncompatible' ? 'unavailable' : error?.code === 'InvalidReport' || error?.transport === 'transport-unknown' ? 'interrupted' : 'failed'
      job.error = error?.message
      job.code = error?.code
    } finally {
      job.ended = Date.now()
      this.active--
      this.changed(job)
      void this.drain()
    }
  }
}
