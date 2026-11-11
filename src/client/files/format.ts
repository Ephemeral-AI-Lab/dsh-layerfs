import { relativeTime } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from './types.ts'

/** A host time as epoch milliseconds: the host may answer seconds or milliseconds. */
export const toMs = (at: number | null | undefined): number | null =>
  at === null || at === undefined || !Number.isFinite(at) ? null : at < 1e12 ? at * 1000 : at

/** "1.2 MB", "340 KB", "12 B" (decimal units). */
export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  if (n < 1000) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1000
  let i = 0
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++ }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

/** Eight characters of a saved id; a tagged id (0x12 Commit, 0x32 Layer) skips its tag byte. */
export const shortId = (id: string | null | undefined): string =>
  !id ? '—' : id.length <= 12 ? id : /^(12|32)[0-9a-f]{64}$/.test(id) ? id.slice(2, 10) : id.slice(0, 8)

/**
 * A relative time in the caller's words (`files_justNow`, `files_minutes`, …).
 * @param at - epoch seconds or milliseconds.
 * @param now - the current epoch milliseconds.
 * @param t - a translator whose namespace carries the files dictionary.
 * @returns the words, or "—" without a time.
 */
export function ago(at: number | null | undefined, now: number, t: Translate): string {
  const ms = toMs(at)
  if (ms === null) return '—'
  const r = relativeTime(ms, now)
  switch (r.unit) {
    case 'now': return t('files_justNow')
    case 'minutes': return t('files_minutes', { n: r.n })
    case 'hours': return t('files_hours', { n: r.n })
    case 'days': return t('files_days', { n: r.n })
    case 'months': return t('files_months', { n: r.n })
    case 'years': return t('files_years', { n: r.n })
    default: return t('files_justNow')
  }
}

/** A local date and time, for tooltips. */
export const when = (at: number | null | undefined): string | undefined => {
  const ms = toMs(at)
  return ms === null ? undefined : new Date(ms).toLocaleString()
}
