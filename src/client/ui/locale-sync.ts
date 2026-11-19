/**
 * The active DSH locale, mirrored for what the dictionaries cannot reach: the
 * clock and date words (`Intl` takes the locale, never the browser's when the
 * person picked another), and memoized views whose translator is a stable
 * function (a revision in their dependencies redraws them on a switch).
 * index.tsx feeds it from `ctx.locale`.
 */
import { useSyncExternalStore } from 'react'

let active = 'en'
let revision = 0
const listeners = new Set<() => void>()

/** The locale switched (or a dictionary landed): store it and redraw subscribers. */
export function syncLocale(id: string | null | undefined): void {
  const next = typeof id === 'string' && id ? id : 'en'
  if (next === active) return
  active = next
  revision++
  for (const fn of listeners) fn()
}

const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }

/** A number that changes on every locale switch, for memo dependencies. */
export const useLocaleRevision = (): number => useSyncExternalStore(subscribe, () => revision, () => revision)

/** The `Intl` locale for times and dates: Chinese in zh (24-hour), else the browser's own. */
export const timeLocale = (): string | undefined => (active.startsWith('zh') ? 'zh-CN' : undefined)

/** A clock time in the active locale (`18:52:16` in zh). */
export const clockTime = (at: number | Date, options?: Intl.DateTimeFormatOptions): string => new Date(at).toLocaleTimeString(timeLocale(), options)

/** A date and time in the active locale. */
export const dateTime = (at: number | Date, options?: Intl.DateTimeFormatOptions): string => new Date(at).toLocaleString(timeLocale(), options)

/** A date in the active locale. */
export const dateOnly = (at: number | Date, options?: Intl.DateTimeFormatOptions): string => new Date(at).toLocaleDateString(timeLocale(), options)
