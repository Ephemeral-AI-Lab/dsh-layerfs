/**
 * Each project's sessions in this DSH, kept across remounts (a tab switch draws
 * the last answer at once) and primed by Home's prefetch. The Home table reads
 * the local list for every row, so the prefetch can make those rows complete
 * before the click; an expanded row reuses the same key for its list.
 */
import type { ProjectSession } from '../projects/hooks.ts'

const sessionAnswers = new Map<string, readonly ProjectSession[]>()

/** The last answer for a project key (`store/project`), if any. */
export function knownSessionList(key: string): readonly ProjectSession[] | undefined {
  return sessionAnswers.get(key)
}

/** Keep an answer for a project key; the prefetch and the table's own read share it. */
export function keepSessionList(key: string, sessions: readonly ProjectSession[]): void {
  sessionAnswers.set(key, sessions)
}
