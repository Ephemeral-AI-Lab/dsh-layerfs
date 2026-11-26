/**
 * The paint hints Home's prefetch leaves for a first render: the prefetched
 * answers in `ui/use-query.ts` and the session lists in
 * `storage/session-cache.ts`. They are decorations, so any host event that says
 * an answer may have changed drops them all; the next mount then paints only
 * its own read (which it starts anyway — the 30 s age only bounds a hint, it is
 * not a cache lifetime).
 *
 * Both hint caches register their clear here, so forgetting every hint is one
 * call, and `PAINT_HINT_EVENTS` is the one event list to edit when a surface
 * starts rereading on a new event. `api.ts` runs the clear from its event
 * dispatch, before any mounted surface hears the event, so even a mount that
 * starts in the same turn as the event cannot paint a stale hint.
 */
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
 * The events after which no hint may paint: the Store view or a project moved,
 * a session changed, or the connection came back (every answer may have been
 * read on the lost connection). A disconnect clears too: the drop itself is the
 * event. These are the events the reading surfaces already reread on
 * (`storage/StoragePage.tsx`, `storage/ProjectTable.tsx`).
 */
export const PAINT_HINT_EVENTS: ReadonlySet<string> = new Set([
  'storage',
  'storage-changed',
  'projects',
  'projects-changed',
  'layerfs-session',
  'layerfs-workspaces-changed',
  'connection',
])
