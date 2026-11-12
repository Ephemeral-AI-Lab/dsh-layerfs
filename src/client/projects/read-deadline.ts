/** A UI deadline for read-only project discovery; it does not cancel host work. */
export class ReadDeadlineError extends Error {
  constructor() { super('read-deadline'); this.name = 'ReadDeadlineError' }
}

/** Do not use for mutations: timing out does not establish their outcome. */
export function readWithDeadline<T>(read: Promise<T>, milliseconds = 20_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new ReadDeadlineError()), milliseconds)
    read.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error: unknown) => { clearTimeout(timer); reject(error) },
    )
  })
}

/**
 * A periodic read that rides out one failed refresh: after a good answer, a
 * single failure keeps that answer; the second failure in a row is reported.
 * Rows read from it do not flip to unavailable on one slow or dropped read.
 */
export function steadyRead<T>(last: { current: { value: T, failures: number } | null }, read: () => Promise<T>): Promise<T> {
  return read().then((value) => { last.current = { value, failures: 0 }; return value }, (error: unknown) => {
    const held = last.current
    if (held && held.failures === 0) { held.failures = 1; return held.value }
    if (held) held.failures++
    throw error
  })
}
