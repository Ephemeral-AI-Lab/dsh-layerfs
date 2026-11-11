/**
 * Storage transfer jobs: their persisted records, failure outcomes, summaries
 * and the fresh observations that gate recovery. Port of Connect `host/jobs/`.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Lfs } from '../layerfs/cli.ts'
import { stringify } from './util.ts'

/** One storage job (Connect's StorageJob). */
export interface StorageJob {
  id: string
  kind: 'push' | 'pull' | 'move' | 'backup' | 'restore'
  store: string
  target: string
  from: string | null
  file: string | null
  started: number
  ended: number | null
  half: 'pull' | 'push' | null
  phase: string | null
  phases: { phase: string, half: string | null, at: number }[]
  outcome: 'succeeded' | 'failed' | 'unknown' | 'interrupted' | null
  pid: number | null
  observation: any
  summary: string | null
  done: number | null
  total: number | null
  error: any
  result: unknown
  reconcileError?: { code: string, message: string }
  recovery?: unknown
}

/** Transfer failures retain the CLI's declared authority. Never infer rollback. */
export function failureOutcome(error: any, phase: string | null): StorageJob['outcome'] {
  if (error?.code === 'Unknown' || (error?.transport && error.transport !== 'refusal') || ['install', 'record'].includes(phase ?? '')) return 'unknown'
  if (error?.code === 'Interrupted') return 'interrupted'
  return 'failed'
}

export function transferSummary(job: StorageJob): string | null {
  if (job.outcome === 'unknown') return 'Outcome unknown · Inspect'
  if (job.outcome === 'interrupted') return 'Interrupted · Final result unavailable'
  if (!job.error) return null
  if (job.phase === 'retire') return job.kind === 'pull' || job.half === 'pull'
    ? 'On Home; source copy not removed'
    : `Moved to ${job.target}; old copy on Home not removed`
  if (job.kind === 'move' && job.half === 'push') return 'Pulled to Home; push failed (certain)'
  return null
}

/** Fresh observations gate explicit recovery. They never turn a missing reply into success. */
export async function inspectJob(lfs: Lfs, job: StorageJob) {
  const at = Date.now()
  if (job.kind === 'backup') return { at, kind: 'backup', value: await lfs.backup.list(job.target), action: null }
  if (job.kind === 'restore') return { at, kind: 'restore', value: await lfs.store.get(job.store), action: null }
  const status = await lfs.store.status(job.store)
  const direction = job.kind === 'move' ? job.half ?? 'pull' : job.kind
  const expected = `store.${direction}`
  const machine = direction === 'pull' ? job.from : job.target
  let action: string | null = null
  if (status.state === 'idle' && job.outcome === 'failed' && job.phase !== 'retire') action = 'retry'
  const oldOp = job.observation?.value?.op ?? job.error?.detail?.op
  if (status.state === 'unresolved' && oldOp?.id && status.op?.id === oldOp.id && status.op?.name === oldOp.name && status.op?.name === expected) {
    const target = await lfs.machine.status(machine)
    if (target.state === 'running' || (machine === 'native' && target.state === 'ready')) action = 'resolve'
  }
  return { at, kind: 'transfer', value: status, direction, action }
}

/** Host-owned transfer records (`<root>/storage-jobs.json`). A restart retains custody, never replays work. */
export class JobStore {
  readonly file: string | null
  readonly jobs = new Map<string, StorageJob>()

  constructor(directory: string | null) {
    this.file = directory ? join(directory, 'storage-jobs.json') : null
    if (!directory || !this.file) return
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    let records: unknown
    try { records = JSON.parse(readFileSync(this.file, 'utf8')) } catch (error: any) {
      if (error.code === 'ENOENT') return
      throw new Error(`Storage job records could not be read: ${error.message}`)
    }
    if (!Array.isArray(records)) throw new Error('Storage job records are malformed')
    for (const record of records as StorageJob[]) {
      if (!record.ended) Object.assign(record, { ended: Date.now(), outcome: 'interrupted', error: { code: 'Interrupted', message: 'Host restarted; final result unavailable. Remote work may still finish.', phase: record.phase, detail: null }, recovery: null })
      this.jobs.set(record.id, record)
    }
    this.save()
  }

  save(): void {
    if (!this.file) return
    const records = [...this.jobs.values()]
    while (records.length > 30) {
      const at = records.findIndex((j) => j.ended)
      if (at < 0) break
      this.jobs.delete(records[at].id)
      records.splice(at, 1)
    }
    writeFileSync(`${this.file}.tmp`, stringify(records), { mode: 0o600 })
    renameSync(`${this.file}.tmp`, this.file)
  }
}
