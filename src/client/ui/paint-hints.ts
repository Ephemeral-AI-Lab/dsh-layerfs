/**
 * The paint hints Home's prefetch leaves for a first render: the prefetched
 * answers in `ui/use-query.ts` and the session lists in
 * `storage/session-cache.ts`. They are decorations, so any host event that says
 * an answer may have changed drops them all; the next mount then paints only
 * its own read (which it starts anyway — the 30 s age only bounds a hint, it is
 * not a cache lifetime).
 *
 * Both hint caches register their clear here, so forgetting every hint is one
 * call, and the event set is derived from the shared invalidation table
 * (`invalidation.ts`): the events that make a shared answer wrong are the ones
 * that may make a hint wrong, and one table cannot omit an event the other
 * already handles. A few of them (`runtime-changed`, `setup-changed`) do not
 * touch a hint cache's reads; they drop the hints anyway, which costs a first
 * paint, never a stale one.
 *
 * `api.ts` runs the clear from its event dispatch, before any mounted surface
 * hears the event, so even a mount that starts in the same turn as the event
 * cannot paint a stale hint.
 */
import { SHARE_INVALIDATION } from '../invalidation.ts'

const clears: (() => void)[] = []

/** Register one hint cache's clear (each cache does this once, at module load). */
export function registerPaintHints(clear: () => void): void {
  clears.push(clear)
}

/** Drop every prefetched answer and session list (a host event, or a test). */
export function forgetPaintHints(): void {
  for (const clear of clears) clear()
}

/**
 * The events after which no hint may paint: every event that invalidates a
 * shared answer — a Store view, catalog or session moved, a machine or Store
 * changed readiness, the setup check changed, or the connection came back. It
 * is derived from `invalidation.ts`, not listed, so a new event there cannot
 * leave a prefetched answer painting after it.
 */
export const PAINT_HINT_EVENTS: ReadonlySet<string> = new Set(Object.keys(SHARE_INVALIDATION))
