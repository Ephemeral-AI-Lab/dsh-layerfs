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
