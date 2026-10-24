// An Init's progress: one line of text and a bar. While the Host counts the
// source and makes the volume the bar moves without a fraction; while LayerFS
// imports, its counts over the Host's totals fill it (jobFraction).
import { useEffect, useState } from 'react'
import type { InitJob } from './api.ts'
import { limitOf, nextMinutes, timedOutText } from './initLimit.ts'

const RULE = `@keyframes lfs-progress { from { left: -40%; } to { left: 100%; } }`

// in place before any bar paints: a bar that paints before its keyframes exist does not move
if (typeof document !== 'undefined' && !document.getElementById('lfs-progress-rule')) {
  const style = document.createElement('style')
  style.id = 'lfs-progress-rule'
  style.textContent = RULE
  document.head.append(style)
}

const number = new Intl.NumberFormat()
export function size(bytes: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let n = bytes,
    unit = 0
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024
    unit++
  }
  return `${unit ? n.toFixed(n < 10 ? 1 : 0) : n} ${units[unit]}`
}
const clock = (ms: number) => {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * Where each of LayerFS's Init steps sits on the bar. Constructing the files
 * is most of the work; within it, each file weighs its bytes plus FILE_COST,
 * so a tree of many small files still moves.
 */
const SPANS = {
  scan: [0, 0.15],
  files: [0.15, 0.95],
  tree: [0.95, 0.98],
  publish: [0.98, 0.99],
  seal: [0.99, 1],
} as const
const FILE_COST = 4096
const ratio = (done: number, total: number) => (total > 0 ? Math.min(1, done / total) : 1)

/** How much of the Init is done (0–1), or null while there is nothing to measure against. */
export function jobFraction(job: InitJob): number | null {
  if (job.step === 'done') return 1
  if (job.step !== 'import' || !job.imported || !job.totals) return null
  const { step, entries, files, bytes } = job.imported,
    totals = job.totals
  const within =
    step === 'scan'
      ? ratio(entries, totals.entries)
      : step === 'files'
        ? ratio(bytes + files * FILE_COST, totals.bytes + totals.files * FILE_COST)
        : 0
  const [from, to] = SPANS[step]
  return from + (to - from) * within
}

/** One line for a job: its step, what was counted or done, how long it has run. */
export function jobText(job: InitJob, now = Date.now()) {
  const elapsed = clock(Math.max(0, now - job.started))
  const fraction = jobFraction(job)
  const t = job.totals,
    i = job.imported
  if (job.step === 'import' && i && t) {
    const of = (done: number, total: number) => `${number.format(Math.min(done, total))} of ${number.format(total)}`
    const what = {
      scan: `Scanning ${of(i.entries, t.entries)} entries`,
      files: `Importing ${of(i.files, t.files)} files · ${size(Math.min(i.bytes, t.bytes))} of ${size(t.bytes)}`,
      tree: 'Building the file tree',
      publish: 'Publishing the first Layer',
      seal: 'Sealing the Store',
    }[i.step]
    return [`${Math.floor(fraction! * 100)}%`, what, elapsed].join(' · ')
  }
  const counts = t ?? job.scanned
  const what = counts ? `${number.format(counts.files)} files · ${size(counts.bytes)}` : ''
  const step = {
    scan: 'Counting files',
    volume: 'Creating the volume',
    import: 'Importing',
    done: 'Imported',
    failed: 'Failed',
  }[job.step]
  return [step, what, elapsed].filter(Boolean).join(' · ')
}

/** A thin bar: `fraction` fills it (0–1); null moves a segment across it. */
export function ProgressBar({ fraction, height = 4 }: { fraction: number | null; height?: number }) {
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)}
      style={{
        position: 'relative',
        overflow: 'hidden',
        height,
        borderRadius: height,
        background: 'color-mix(in srgb, currentColor 12%, transparent)',
      }}
    >
      <div
        style={
          fraction === null
            ? {
                position: 'absolute',
                top: 0,
                bottom: 0,
                width: '40%',
                borderRadius: height,
                background: 'var(--dsw-alias-brand-primary, #4c7dff)',
                animation: 'lfs-progress 1.2s ease-in-out infinite',
              }
            : {
                width: `${Math.min(1, Math.max(0, fraction)) * 100}%`,
                height: '100%',
                borderRadius: height,
                background: 'var(--dsw-alias-brand-primary, #4c7dff)',
                transition: 'width .3s ease',
              }
        }
      />
    </div>
  )
}

/** Re-renders every second so the elapsed time moves between reads. */
export function useClock(running: boolean) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])
  return now
}

/** The job's line over its bar. */
export function InitProgress({ job }: { job: InitJob }) {
  const now = useClock(true)
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <span style={{ fontSize: 12, opacity: 0.75 }}>{jobText(job, now)}</span>
      <ProgressBar fraction={jobFraction(job)} />
    </div>
  )
}

/**
 * A failed Init that ran into its time limit (initLimit.ts timedOut): the
 * limit and how far the import got, and a button that refills the form with
 * the next limit for the user to start. Other failures keep their message.
 */
export function InitTimedOut({ job, onAgain }: { job: InitJob; onAgain: () => void }) {
  return (
    <div
      role="alert"
      style={{ display: 'grid', gap: 8, justifyItems: 'start', color: 'var(--dsh-color-fg-danger, #d33)' }}
    >
      <span>{timedOutText(job)}</span>
      <button
        onClick={onAgain}
        style={{
          font: 'inherit',
          fontSize: 12,
          padding: '4px 12px',
          borderRadius: 6,
          border: '1px solid var(--dsh-color-border, #8884)',
          background: 'transparent',
          color: 'var(--dsh-color-fg, #111)',
          cursor: 'pointer',
        }}
      >
        Start again with a longer limit ({nextMinutes(limitOf(job))} min)
      </button>
    </div>
  )
}
