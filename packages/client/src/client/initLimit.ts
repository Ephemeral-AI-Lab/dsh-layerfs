// An Init's time limit: what the Init dialog offers and how a failed Init
// that ran out of time reads. LayerFS bounds every Live Init (its default is
// @layerfs/agent's INIT_TIMEOUT_MS, 300 s, when the request sets none), and
// one that runs out fails `Failed` like any other failure. So a time-out is
// told from the job's own times, never from its message: failed, and ended at
// least the limit after it started.
import type { InitJob } from './api.ts'

/** LayerFS's default limit (@layerfs/agent INIT_TIMEOUT_MS). */
export const DEFAULT_LIMIT_MS = 300_000
/** The dialog's quick picks, in minutes; any other whole number of minutes is typed. */
export const QUICK_MINUTES = [5, 15, 30, 60] as const

const MINUTE = 60_000
const number = new Intl.NumberFormat()

/** The limit in force for a job: its own, else LayerFS's default. */
export const limitOf = (job: Pick<InitJob, 'timeout'>) => job.timeout ?? DEFAULT_LIMIT_MS

/** Whether a failed job ran into its limit: it ended at least the limit after it started. */
export function timedOut(job: Pick<InitJob, 'step' | 'started' | 'ended' | 'timeout'>): boolean {
  return job.step === 'failed' && job.ended != null && job.ended - job.started >= limitOf(job)
}

/** `ms` in minutes, as the dialog and the message write it. */
export const minutes = (ms: number) => Math.round((ms / MINUTE) * 10) / 10

/** The limit to offer after one ran out: the next quick pick, else twice the last limit. */
export function nextMinutes(limitMs: number): number {
  const m = minutes(limitMs)
  return QUICK_MINUTES.find((q) => q > m) ?? Math.ceil(m * 2)
}

/** The dialog's minutes field: blank is LayerFS's default (no timeout sent), else a whole number of minutes ≥ 1. */
export function limitFromMinutes(text: string): { ms?: number; error?: string } {
  const t = text.trim()
  if (!t) return {}
  const m = Number(t)
  if (!/^\d+$/.test(t) || !Number.isSafeInteger(m * MINUTE) || m < 1)
    return { error: 'The time limit is a whole number of minutes, at least 1.' }
  return { ms: m * MINUTE }
}

/** What a timed-out job says: the limit it stopped at and, when known, how far its import got. */
export function timedOutText(job: Pick<InitJob, 'timeout' | 'imported' | 'totals'>): string {
  const head = `Init stopped at its ${minutes(limitOf(job))} min limit`
  const done = job.imported?.files,
    total = job.totals?.files
  return done != null && total != null
    ? `${head} after importing ${number.format(Math.min(done, total))} of ${number.format(total)} files.`
    : `${head}.`
}
