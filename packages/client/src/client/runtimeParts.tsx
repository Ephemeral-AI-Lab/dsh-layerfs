// Small parts the two Sandbox pages share: a level's dot and colour, a
// capacity meter, durations, and polling while the page is shown.
import { useEffect, useRef } from 'react'
import type { Level } from './api.ts'
import { T } from './tokens.ts'

export const LEVEL_COLOR: Record<Level, string> = { ok: T.ok, degraded: T.warn, down: T.danger }
export const LEVEL_WORD: Record<Level, string> = { ok: 'ok', degraded: 'needs a look', down: 'down' }

export function Dot({ level, title }: { level: Level; title?: string }) {
  return (
    <span
      role="img"
      aria-label={title ?? LEVEL_WORD[level]}
      title={title ?? LEVEL_WORD[level]}
      style={{
        display: 'inline-block',
        flex: 'none',
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: LEVEL_COLOR[level],
      }}
    />
  )
}

/** Used out of capacity, as a thin bar. */
export function Meter({ used, capacity }: { used: number; capacity: number }) {
  const share = Math.min(1, used / capacity)
  return (
    <span
      title={`${used} of ${capacity} Workspaces`}
      style={{
        display: 'inline-block',
        flex: 'none',
        width: 64,
        height: 6,
        borderRadius: 3,
        background: T.well,
        overflow: 'hidden',
      }}
    >
      <span
        style={{
          display: 'block',
          height: '100%',
          width: `${share * 100}%`,
          background: used >= capacity ? T.warn : 'var(--dsw-alias-state-business-primary)',
        }}
      />
    </span>
  )
}

/** 40 s, 12 min, 3 h, 2 d. */
export function span(ms: number) {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.round(s / 60)} min`
  if (s < 86400) return `${Math.round(s / 3600)} h`
  return `${Math.round(s / 86400)} d`
}

/** `/workspaces/3` → "WS 3", as the views name a Workspace. */
export const wsName = (path: string) => `WS ${path.slice(path.lastIndexOf('/') + 1)}`

/** Runs `read` now and every `ms` while the page is visible; again when it comes back. */
export function usePoll(read: () => void, ms: number, deps: unknown[]) {
  const latest = useRef(read)
  latest.current = read
  useEffect(() => {
    latest.current()
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') latest.current()
    }, ms)
    const back = () => {
      if (document.visibilityState === 'visible') latest.current()
    }
    document.addEventListener('visibilitychange', back)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', back)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}

export const POLL_MS = 10_000
