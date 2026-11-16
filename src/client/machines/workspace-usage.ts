/**
 * Each Workspace's processor rate over the sandbox.get reads a Sandbox page
 * makes, without React. A Workspace's `usage.cpuUsec` is the CPU time of its
 * own cgroup (`ws-<workspace>`), which LayerFS removes once no command runs:
 * the rate between two reads is Δcpu_usec / Δtime (in processors), and a
 * count that went down (the group was made again) starts a new series rather
 * than giving a negative rate. Kept per Workspace while the page lives, so a
 * tab switch keeps the sparkline.
 */
import type { WorkspaceInfo } from './model.ts'

/** How many rates a sparkline keeps. */
export const SERIES_LENGTH = 24
/** Reads further apart than this are not one series (a hidden page stops polling). */
export const SERIES_GAP_MS = 60_000
/** Reads closer than this (a re-render, a read and its retry) add nothing. */
export const MIN_STEP_MS = 1000

export interface UsageTrack {
  /** The last read: when, and the CPU time then (null when it was not read). */
  at: number
  cpuUsec: number | null
  /** Processor rates between reads, oldest first; null where there was none to measure. */
  rates: (number | null)[]
}

/**
 * The track after one more read of a Workspace at `at` (epoch ms). A
 * Workspace with no usage this read (nothing runs, or not reported) adds a
 * gap; the first read of a series adds nothing to measure against.
 */
export function step(track: UsageTrack | undefined, usage: WorkspaceInfo['usage'], at: number): UsageTrack {
  const cpuUsec = usage?.cpuUsec ?? null
  if (!track) return { at, cpuUsec, rates: [] }
  if (at - track.at < MIN_STEP_MS) return track
  const ms = at - track.at
  const rate = cpuUsec != null && track.cpuUsec != null && cpuUsec >= track.cpuUsec && ms <= SERIES_GAP_MS
    ? (cpuUsec - track.cpuUsec) / (ms * 1000)
    : null
  return { at, cpuUsec, rates: [...track.rates, rate].slice(-SERIES_LENGTH) }
}

/** The newest rate, or null when the last read had none. */
export const latestRate = (track: UsageTrack | undefined): number | null => track?.rates.at(-1) ?? null

/** A processor rate as a card shows it: `0.42 CPU`, `1.8 CPU`, `12 CPU`. */
export function cpuWords(rate: number | null): string | null {
  if (rate == null || !Number.isFinite(rate)) return null
  const v = Math.max(0, rate)
  return v < 1 ? v.toFixed(2) : v < 10 ? v.toFixed(1) : String(Math.round(v))
}

/** A sparkline's polyline points in a `width` × `height` box, gaps skipped; null with fewer than two rates. */
export function sparkPoints(rates: readonly (number | null)[], width: number, height: number): string | null {
  const known = rates.filter((r): r is number => r != null)
  if (known.length < 2) return null
  const top = Math.max(1, ...known)
  const n = Math.max(1, rates.length - 1)
  const points: string[] = []
  rates.forEach((r, i) => {
    if (r == null) return
    points.push(`${((i / n) * width).toFixed(1)},${(height - (Math.max(0, r) / top) * height).toFixed(1)}`)
  })
  return points.join(' ')
}

const tracks = new Map<string, UsageTrack>()

/** Record one sandbox.get answer's Workspaces at `at`; returns each Workspace's track. */
export function recordUsage(workspaces: readonly WorkspaceInfo[], at: number = Date.now()): ReadonlyMap<string, UsageTrack> {
  const out = new Map<string, UsageTrack>()
  for (const w of workspaces) {
    if (w.usage === undefined) continue
    const next = step(tracks.get(w.ws), w.usage, at)
    tracks.set(w.ws, next)
    out.set(w.ws, next)
  }
  return out
}
