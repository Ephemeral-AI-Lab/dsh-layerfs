/**
 * One line chart for the metrics pages (layerfs-project#182 D3): a 2px line
 * over a light wash, the current value at the line's end, a hover readout
 * shared by every chart inside one {@link ChartGroup}, the line broken at
 * each gap (its readout says "Not read" and why), a mark at each event (an
 * out-of-memory kill), and a thin reference line (the kernel's peak).
 *
 * No animation. Colours are `--dsw-alias-*` tokens only, so light and dark
 * themes follow DSH. The chart is as wide as its column (phone width
 * included). Keyboard: the chart takes focus; ←/→ move the readout one
 * sample, Home/End to the first and last, Escape clears it. Every visible
 * word arrives from the caller.
 */
import { createContext, useContext, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import css from './chart.module.css'

/** One sample: `v` null is a gap, with its reason word. */
export interface ChartSample { t: number, v: number | null, reason?: string | undefined }

/** The readout every chart of a group shows: the time hovered or focused, or null. */
interface Readout { t: number | null, set: (t: number | null) => void }
const ReadoutContext = createContext<Readout | null>(null)

/** The readout a group of charts shares, given from outside (tests, or a page that drives it). */
export const ChartReadout = ReadoutContext.Provider

/** Charts inside share one hover readout: hovering one shows the same moment on all. */
export function ChartGroup({ children, className }: { children: ReactNode, className?: string }): ReactNode {
  const [t, set] = useState<number | null>(null)
  const value = useMemo(() => ({ t, set }), [t])
  return <ReadoutContext.Provider value={value}><div className={clsx(css.group, className)}>{children}</div></ReadoutContext.Provider>
}

/**
 * Where a key moves the readout: the index of the sample to show, `null` to
 * clear it, or `undefined` for a key the chart does not take. With no readout
 * yet (`at` -1) an arrow shows the newest sample.
 */
export function stepReadout(count: number, at: number, key: string): number | null | undefined {
  if (!count) return undefined
  const clamp = (n: number) => Math.max(0, Math.min(count - 1, n))
  if (key === 'ArrowLeft') return at >= 0 ? clamp(at - 1) : count - 1
  if (key === 'ArrowRight') return at >= 0 ? clamp(at + 1) : count - 1
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  if (key === 'Escape') return null
  return undefined
}

export interface LineAreaProps {
  /** The chart's name ("Processor"); also its accessible name. */
  label: string
  samples: readonly ChartSample[]
  /** The time span drawn (epoch ms): the last hour, ending now. */
  from: number
  to: number
  /** The top of the value axis (> 0); larger values are drawn at the top. */
  max: number
  /** A value in words ("34 %", "1.3 of 4", "512 MB"). */
  format: (v: number) => string
  /** A gap in words ("Not read: the machine was busy with other reads"). */
  gapText: (reason: string | undefined) => string
  /** A time in words (the readout's). */
  timeText: (t: number) => string
  /** The top of the axis in words, top left ("100 %"). */
  maxText?: string | undefined
  /** The axis' ends in words ("60 min ago", "now"). */
  startText?: string | undefined
  endText?: string | undefined
  /** Events at a time (each out-of-memory kill), drawn as marks. */
  marks?: readonly { t: number, label: string }[] | undefined
  /** A reference value drawn as a thin line (the kernel's peak). */
  peak?: { v: number, label: string } | null | undefined
  /** Said when there is no sample in the span. */
  empty: string
  className?: string
}

const W = 1000, H = 100

/** The index of the sample nearest `t`, or -1. */
function nearest(samples: readonly ChartSample[], t: number): number {
  let best = -1, gap = Infinity
  for (let i = 0; i < samples.length; i++) {
    const d = Math.abs(samples[i]!.t - t)
    if (d < gap) { gap = d; best = i }
  }
  return best
}

export function LineArea({ label, samples: all, from, to, max, format, gapText, timeText, maxText, startText, endText, marks = [], peak, empty, className }: LineAreaProps): ReactNode {
  const group = useContext(ReadoutContext)
  const [own, setOwn] = useState<number | null>(null)
  const readT = group ? group.t : own
  const setT = group ? group.set : setOwn
  const box = useRef<HTMLDivElement>(null)
  const id = useId()
  const span = Math.max(1, to - from)
  const top = max > 0 ? max : 1
  const samples = useMemo(() => all.filter((s) => s.t >= from && s.t <= to), [all, from, to])
  const x = (t: number) => ((t - from) / span) * W
  const y = (v: number) => H - (Math.max(0, Math.min(top, v)) / top) * H
  const pct = (n: number, of: number) => `${(n / of) * 100}%`

  // the line, broken at each gap
  const { lines, areas } = useMemo(() => {
    const lines: string[] = [], areas: string[] = []
    let run: { x: number, y: number }[] = []
    const close = () => {
      if (!run.length) return
      if (run.length === 1) lines.push(`M${run[0]!.x} ${run[0]!.y}l0.01 0`)
      else {
        lines.push(run.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(''))
        areas.push(`M${run[0]!.x} ${H}${run.map((p) => `L${p.x} ${p.y}`).join('')}L${run.at(-1)!.x} ${H}Z`)
      }
      run = []
    }
    for (const s of samples) {
      if (s.v == null) close()
      else run.push({ x: x(s.t), y: y(s.v) })
    }
    close()
    return { lines, areas }
  // x and y depend only on these
  }, [samples, from, span, top]) // eslint-disable-line react-hooks/exhaustive-deps

  const last = samples.at(-1)
  const at = readT != null ? nearest(samples, readT) : -1
  const shown = at >= 0 ? samples[at]! : null
  const markAt = shown ? marks.filter((m) => m.t === shown.t) : []
  const value = (s: ChartSample) => (s.v != null ? format(s.v) : gapText(s.reason))
  const readout = shown ? `${timeText(shown.t)} · ${value(shown)}${markAt.length ? ` · ${markAt.map((m) => m.label).join(', ')}` : ''}` : null

  const move = (e: PointerEvent<HTMLDivElement>) => {
    const r = box.current?.getBoundingClientRect()
    if (!r || !r.width || !samples.length) return
    const i = nearest(samples, from + ((e.clientX - r.left) / r.width) * span)
    if (i >= 0) setT(samples[i]!.t)
  }
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = stepReadout(samples.length, at, e.key)
    if (next === undefined) return
    e.preventDefault()
    setT(next === null ? null : samples[next]!.t)
  }

  return (
    <figure className={clsx(css.chart, className)} data-chart={label}>
      <figcaption className={css.head}>
        <span className={css.label}>{label}</span>
        <span className={css.readout} id={`${id}-readout`} aria-live="polite" data-chart-readout={readout ? '' : undefined}>
          {/* the hovered or focused moment; else, when the newest sample is a gap, why (a value shows at the line's end) */}
          {readout ?? (last && last.v == null ? <span data-chart-current="gap">{value(last)}</span> : null)}
        </span>
      </figcaption>
      <div
        ref={box}
        className={css.plot}
        tabIndex={0}
        role="group"
        aria-label={label}
        aria-describedby={`${id}-readout`}
        onPointerMove={move}
        onPointerLeave={() => setT(null)}
        onFocus={() => { if (readT == null && last) setT(last.t) }}
        onBlur={() => setT(null)}
        onKeyDown={key}
        data-chart-plot
      >
        {maxText && <span className={css.max}>{maxText}</span>}
        <svg className={css.svg} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
          {areas.map((d, i) => <path key={`a${i}`} d={d} className={css.wash} />)}
          {peak && peak.v <= top && <line x1={0} x2={W} y1={y(peak.v)} y2={y(peak.v)} className={css.peak} data-chart-peak />}
          {marks.filter((m) => m.t >= from && m.t <= to).map((m, i) => <line key={`m${i}`} x1={x(m.t)} x2={x(m.t)} y1={0} y2={H} className={css.mark} data-chart-mark />)}
          {lines.map((d, i) => <path key={`l${i}`} d={d} className={css.line} data-chart-line />)}
          {shown && <line x1={x(shown.t)} x2={x(shown.t)} y1={0} y2={H} className={css.cursor} />}
        </svg>
        {samples.length === 0 && <span className={css.empty}>{empty}</span>}
        {peak && peak.v <= top && <span className={css.peakLabel} style={{ top: pct(y(peak.v), H) }}>{peak.label}</span>}
        {marks.filter((m) => m.t >= from && m.t <= to).map((m, i) => <span key={`k${i}`} className={css.markFlag} style={{ left: pct(x(m.t), W) }} title={m.label} aria-hidden="true" />)}
        {last && last.v != null && !shown && (
          <span className={css.end} style={{ left: pct(x(last.t), W), top: pct(y(last.v), H) }} data-chart-current="value">{format(last.v)}</span>
        )}
        {shown && <span className={css.dot} data-gap={shown.v == null || undefined} style={{ left: pct(x(shown.t), W), top: shown.v != null ? pct(y(shown.v), H) : '50%' }} aria-hidden="true" />}
      </div>
      {(startText || endText) && (
        <div className={css.axis} aria-hidden="true"><span>{startText}</span><span>{endText}</span></div>
      )}
    </figure>
  )
}

/** Figures as plain numbers separated by hairlines: a `<dl>` of {@link Figure}s. */
export function Figures({ label, children, className }: { label: string, children: ReactNode, className?: string }): ReactNode {
  return <dl className={clsx(css.figures, className)} aria-label={label}>{children}</dl>
}

/** One figure: its name, its number (a dash and why when not read), and a line under it. */
export function Figure({ label, children, sub, gap, ...data }: { label: string, children: ReactNode, sub?: ReactNode, gap?: boolean } & Record<`data-${string}`, string | undefined>): ReactNode {
  return (
    <div className={css.figure} {...data}>
      <dt>{label}</dt>
      <dd className={gap ? css.figureGap : undefined}>{children}</dd>
      {sub ? <dd className={css.figureSub}>{sub}</dd> : null}
    </div>
  )
}
