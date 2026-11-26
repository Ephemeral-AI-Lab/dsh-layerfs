/**
 * Each project's sessions in this DSH, kept across remounts (a tab switch draws
 * the last answer at once) and primed by Home's prefetch. The Home table reads
 * the local list for every row, so the prefetch can make those rows complete
 * before the click; an expanded row reuses the same key for its list.
 */
import { registerPaintHints } from '../ui/paint-hints.ts'
import type { ProjectSession } from '../projects/hooks.ts'

const sessionAnswers = new Map<string, readonly ProjectSession[]>()

// Keyed by `store/project`, so a list only paints its own project's rows. A
// project that left the Store is dropped with every other hint by the event
// invalidation (`ui/paint-hints.ts`), so a removed project's answer cannot
// resurface on the first render. The list kept here is the local one (no Store
// walk), so `machine-progress` and `layerfs-availability` cannot change it; they
// still drop it with every other hint, which costs a first paint, never a wrong
// row.
registerPaintHints(() => sessionAnswers.clear())

/** The last answer for a project key (`store/project`), if any. */
export function knownSessionList(key: string): readonly ProjectSession[] | undefined {
  return sessionAnswers.get(key)
}

/** Keep an answer for a project key; the prefetch and the table's own read share it. */
export function keepSessionList(key: string, sessions: readonly ProjectSession[]): void {
  sessionAnswers.set(key, sessions)
}
