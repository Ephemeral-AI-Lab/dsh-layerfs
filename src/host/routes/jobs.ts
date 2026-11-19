/**
 * Storage transfer jobs: their persisted records, failure outcomes, summaries
 * and the fresh observations that gate recovery. Port of Connect `host/jobs/`.
 * Push, pull and move are the host's words for `store move` to a machine, to
 * native, and through native; their phases are check, snapshot, send, verify,
 * install, record, retire.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Lfs } from '../layerfs/cli.ts'
import { stringify } from './util.ts'

/** One storage job (Connect's StorageJob). */
export interface StorageJob {
  id: string
  kind: 'push' | 'pull' | 'move' | 'backup' | 'restore' | 'compact'
  store: string
  target: string
  from: string | null
  file: string | null
  started: number
  ended: number | null
  half: 'pull' | 'push' | null
  phase: string | null
  phases: { phase: string, half: string | null, at: number }[]
  /** The phases the call reports, in order, when the host knows them before the run (a compaction). */
  steps?: readonly string[]
  outcome: 'succeeded' | 'failed' | 'unknown' | 'interrupted' | null
  pid: number | null
  observation: any
  summary: string | null
  done: number | null
  total: number | null
  error: any
  result: unknown
  reconcileError?: { code: string, message: string }
  /** A push that places a Store a New Store dialog just made (its words say created on, not pushed to). */
  made?: boolean
  recovery?: unknown
}

/** Transfer failures retain the CLI's declared authority. Never infer rollback. */
/** The phases store.compact reports, by Store family (LayerFS `on_progress`, GC decision A13). */
export const COMPACT_STEPS = { sqlite: ['mark', 'build', 'verify', 'install'], postgresql: ['mark', 'build', 'swap', 'cleanup'] } as const

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

/**
 * Fresh observations gate explicit recovery. They never turn a missing reply
 * into success. A Store's is `store get --with live` (it settles a backup or
 * restore whose owner is gone); a transfer may be retried when the Store is
 * ready again after a certain failure, and resolved (the same `store move`,
 * LayerFS's own `fix`) when it is broken `unresolved` and the machine is ready.
 */
export async function inspectJob(lfs: Lfs, job: StorageJob) {
  const at = Date.now()
  const live = () => lfs.store.get(job.store, { detail: true, with: ['live'] })
  if (job.kind === 'backup') return { at, kind: 'backup', value: await lfs.backup.list({ bucket: job.target, detail: true }), action: null }
  if (job.kind === 'restore') return { at, kind: 'restore', value: await live(), action: null }
  // a compaction is never resolved from here: the next store.compact adopts and settles what a run left
  if (job.kind === 'compact') return { at, kind: 'compact', value: await live(), action: null }
  const status = await live()
  const direction = job.kind === 'move' ? job.half ?? 'pull' : job.kind
  const machine = direction === 'pull' ? job.from : job.target
  let action: string | null = null
  if (status?.state === 'ready' && job.outcome === 'failed' && job.phase !== 'retire') action = 'retry'
  if (status?.state === 'broken' && status?.reason === 'unresolved' && typeof status?.fix === 'string' && /^layerfs store move /.test(status.fix) && machine) {
    // the machine's live state (2.0 `machine get --with live`): a resolve needs it ready
    const target = await lfs.machine.get(machine, { detail: true, with: ['live'] })
    if ((target?.state ?? 'ready') === 'ready' && !target?.op) action = 'resolve'
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
