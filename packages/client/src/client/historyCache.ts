// Projects' History, kept for as long as the page is open, so the Work and
// History tabs (and switching between them) draw it at once instead of
// reading it again. A kept History is checked with the Host's `since`: the
// Host answers { kind: 'unchanged' } while neither the Store's History nor the
// traces' authors and times changed, and the kept one is used.

/** A Host History answer as kept: it carries the Host's `version`. */
export interface Versioned {
  version?: string
}
type Answer<T> = T | { kind: 'unchanged'; version: string }

/** Projects whose History is kept, the most recently read. */
export const KEEP_PROJECTS = 8

export function createHistoryCache<T extends Versioned>(
  read: (name: string, since?: string) => Promise<Answer<T>>,
  most = KEEP_PROJECTS,
) {
  const kept = new Map<string, T>()
  /** One read per project at a time; a caller while it runs gets the same answer. */
  const reading = new Map<string, Promise<T>>()
  const keep = (name: string, value: T) => {
    kept.delete(name)
    kept.set(name, value)
    while (kept.size > most) kept.delete(kept.keys().next().value!)
  }
  return {
    /** The kept History of `name`, if any (it may be behind the Store). */
    kept: (name: string): T | undefined => kept.get(name),
    /** The project's current History: the kept object itself when the Host says it is unchanged. */
    read(name: string): Promise<T> {
      const running = reading.get(name)
      if (running) return running
      const held = kept.get(name)
      const next = read(name, held?.version)
        .then((answer) => {
          if (held && 'kind' in answer && answer.kind === 'unchanged' && answer.version === held.version) {
            keep(name, held)
            return held
          }
          const value = answer as T
          if (value.version) keep(name, value)
          else kept.delete(name)
          return value
        })
        .finally(() => reading.delete(name))
      reading.set(name, next)
      return next
    },
    /** Drops a project's kept History (it was removed). */
    forget: (name: string) => {
      kept.delete(name)
    },
  }
}
