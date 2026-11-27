/**
 * The first screen's paint, as one shared moment. Reads that only decorate the
 * first card or row wait for it; the reads that draw that card or row do not.
 * This is a timing rule, not a cache: a deferred read still starts on mount and
 * reads the host once (the `useQuery` freshness contract is unchanged).
 */

/** A hidden tab never runs `requestAnimationFrame`: the fallback still lands its reads. */
export const FIRST_PAINT_FALLBACK_MS = 1_000
/** Idle time allowed after the first frame before deferred reads go anyway. */
export const FIRST_PAINT_IDLE_TIMEOUT_MS = 200

let painted: Promise<void> | null = null

/**
 * Resolves once the browser has painted a frame and had an idle moment (or
 * after {@link FIRST_PAINT_FALLBACK_MS}, or at once where there is no DOM).
 * Every caller shares the one promise.
 */
export function afterFirstPaint(): Promise<void> {
  if (painted) return painted
  painted = new Promise<void>((resolve) => {
    let done = false
    const finish = () => { if (done) return; done = true; clearTimeout(fallback); resolve() }
    const fallback = setTimeout(finish, FIRST_PAINT_FALLBACK_MS)
    if (typeof requestAnimationFrame !== 'function') { setTimeout(finish, 0); return }
    requestAnimationFrame(() => {
      const idle = (globalThis as { requestIdleCallback?: (cb: () => void, options?: { timeout?: number }) => number }).requestIdleCallback
      if (typeof idle === 'function') idle(finish, { timeout: FIRST_PAINT_IDLE_TIMEOUT_MS })
      else setTimeout(finish, 0)
    })
  })
  return painted
}
