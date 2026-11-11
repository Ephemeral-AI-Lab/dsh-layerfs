/**
 * The storage measurements' pictures (LayerFS Connect's
 * `components/storage/{RealStorageVisuals,StagedStorageFlow}`): byte values
 * that count up, a staged flow whose bands arrive in turn, the canonical
 * reuse ring, and the measured line. Motion settles under
 * prefers-reduced-motion.
 */
import { useEffect, useId, useState, type CSSProperties, type ReactNode } from 'react'
import { CountUp, useReducedMotion } from './motion.tsx'
import { exactBytes, exactCount, type WireInteger } from './exact-count.ts'
import { canonicalReuse, coordinate, encodingRatio, integer, maximum } from './measures.ts'
import type { StorageT } from './locale.ts'
import css from './StorageVisuals.module.css'

const delay = (ms: number): CSSProperties => ({ '--storage-delay': `${ms}ms` }) as CSSProperties

/** Safe values animate; large integers retain their exact wire representation. */
export function MeasuredValue({ value, bytes = false }: { value: unknown, bytes?: boolean }): ReactNode {
  const format = bytes ? exactBytes : exactCount
  return typeof value === 'number' && integer(value) !== null
    ? <CountUp value={value} format={(shown) => format(Math.round(shown))} ms={650} />
    : <span className={css.nums}>{format(value)}</span>
}

/** A measured line of values, oldest left; selectable points inspect a revision. */
export function MeasurementLine({ values, label, points, times, selectedIndex, onSelect, t }: {
  values: unknown[]
  label: string
  points?: string[]
  times?: number[]
  selectedIndex?: number
  onSelect?: (index: number) => void
  t: StorageT
}): ReactNode {
  if (!values.some((value) => integer(value) !== null)) return <p className={css.note}>{t('measurementsUnavailable')}</p>
  const max = maximum(values)
  const start = times?.[0] ?? 0
  const duration = times ? times.at(-1)! - start : 0
  const coords = values.map((v, i) => ({
    x: values.length < 2 ? 300 : 8 + (duration > 0 ? (times![i] - start) / duration : i / (values.length - 1)) * 584,
    y: coordinate(v, max),
  }))
  const paths: string[] = []
  let current = ''
  coords.forEach((p) => {
    if (p.y === null) { if (current) paths.push(current); current = '' }
    else current += `${current ? ' L' : 'M'}${p.x},${142 - p.y * 126}`
  })
  if (current) paths.push(current)
  return (
    <div className={css.lineChart}>
      <div className={css.chartScale}>
        <span>{exactBytes(max <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(max) : { $layerfs: 'i64-v1', decimal: max.toString() })}</span>
        <span>0 B</span>
      </div>
      <svg viewBox="0 0 600 156" preserveAspectRatio="none" role={onSelect ? 'group' : 'img'} aria-label={label}>
        {[16, 79, 142].map((y) => <line key={y} x1="8" x2="592" y1={y} y2={y} stroke="var(--dsw-alias-border-l2)" strokeDasharray="3 5" />)}
        {paths.map((d, i) => {
          const matches = [...d.matchAll(/[ML]([\d.]+),([\d.]+)/g)]
          return matches.length > 1 ? <path key={`area:${i}`} d={`${d} L${matches.at(-1)![1]},142 L${matches[0][1]},142 Z`} fill="var(--storage-canonical)" fillOpacity=".08" /> : null
        })}
        {selectedIndex !== undefined && coords[selectedIndex]?.y !== null && coords[selectedIndex] && (
          <line x1={coords[selectedIndex].x} x2={coords[selectedIndex].x} y1="8" y2="148" stroke="var(--storage-canonical)" strokeOpacity=".45" strokeDasharray="3 4" />
        )}
        {paths.map((d, i) => (
          <path className={css.historyLine} key={i} d={d} fill="none" stroke="var(--storage-canonical)" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
        ))}
        {coords.map((p, i) => p.y === null ? null : (
          <circle key={i} cx={p.x} cy={142 - p.y * 126} r={selectedIndex === i ? 5 : 3.5}
            className={onSelect ? css.revisionPoint : undefined}
            tabIndex={onSelect ? 0 : undefined} role={onSelect ? 'button' : undefined}
            aria-label={onSelect ? t('inspectRevision', { id: points?.[i] ?? String(i + 1), bytes: exactBytes(values[i]) }) : undefined}
            aria-pressed={onSelect ? selectedIndex === i : undefined}
            onClick={onSelect ? () => onSelect(i) : undefined}
            onKeyDown={onSelect ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(i) } } : undefined}
            stroke="var(--storage-canonical)" strokeWidth={onSelect ? 14 : 0} strokeOpacity="0" fill="var(--storage-canonical)">
            <title>{points?.[i] ?? `${i + 1}`}: {exactBytes(values[i])}</title>
          </circle>
        ))}
      </svg>
    </div>
  )
}

// ---------- staged flow ----------

export interface StorageStage {
  label: string
  caption: string
  value: WireInteger | null | undefined
  tone: 'referenced' | 'canonical' | 'stored' | 'allocation'
}

const tone = (name: StorageStage['tone']): string => `var(--storage-${name === 'allocation' ? 'overhead' : name})`

function StageBytes({ value, wait }: { value: StorageStage['value'], wait: number }): ReactNode {
  const reduced = useReducedMotion()
  const [arrived, setArrived] = useState(reduced || wait === 0)
  useEffect(() => {
    if (reduced) return
    const timer = setTimeout(() => setArrived(true), wait)
    return () => clearTimeout(timer)
  }, [reduced, wait])
  if (!reduced && !arrived) return <span aria-hidden="true">{exactBytes(value)}</span>
  return typeof value === 'number' && integer(value) !== null
    ? <CountUp value={value} format={(shown) => exactBytes(Math.round(shown))} ms={650} />
    : <span className={integer(value) === null ? css.stageUnknown : undefined}>{exactBytes(value)}</span>
}

/** Stages share one linear byte scale. Missing values never produce a band. */
export function StagedStorageFlow({ stages, steps, label, t }: { stages: StorageStage[], steps: string[], label: string, t: StorageT }): ReactNode {
  const id = useId().replace(/[^\w-]/g, '')
  const [replay, setReplay] = useState(0)
  const max = maximum(stages.map((stage) => stage.value))
  const center = (index: number) => (index + .5) * 900 / stages.length
  const height = (index: number) => (coordinate(stages[index].value, max) ?? 0) * 120
  return (
    <div className={css.stagedFlow}>
      <div key={replay} className={css.flowSequence}>
        <div className={css.flowLabels} style={{ gridTemplateColumns: `repeat(${stages.length}, minmax(0, 1fr))` }}>
          {stages.map((stage, index) => (
            <div className={css.stageLabel} key={stage.label} style={delay(index * 260)}>
              <span><i style={{ background: tone(stage.tone) }} />{stage.label}</span>
              <strong><StageBytes value={stage.value} wait={index * 260} /></strong>
              <small>{stage.caption}</small>
            </div>
          ))}
        </div>
        <svg className={css.flowSvg} viewBox="0 0 900 150" preserveAspectRatio="none" role="img"
          aria-label={`${label}. ${stages.map((stage) => `${stage.label}: ${exactBytes(stage.value)}`).join('; ')}`}>
          <defs>
            {stages.slice(1).map((stage, index) => (
              <linearGradient key={stage.label} id={`${id}-${index}`}>
                <stop stopColor={tone(stages[index].tone)} stopOpacity=".65" />
                <stop offset="1" stopColor={tone(stage.tone)} stopOpacity=".75" />
              </linearGradient>
            ))}
          </defs>
          {stages.slice(1).map((stage, index) => {
            if (integer(stages[index].value) === null || integer(stage.value) === null || max === 0n) return null
            const x0 = center(index) + 3, x1 = center(index + 1) - 3, mid = (x0 + x1) / 2
            const h0 = height(index), h1 = height(index + 1)
            const d = `M${x0},${75 - h0 / 2} C${mid},${75 - h0 / 2} ${mid},${75 - h1 / 2} ${x1},${75 - h1 / 2} L${x1},${75 + h1 / 2} C${mid},${75 + h1 / 2} ${mid},${75 + h0 / 2} ${x0},${75 + h0 / 2} Z`
            return (
              <g className={css.flowBand} key={stage.label} style={delay(index * 260 + 130)}>
                <path d={d} fill={`url(#${id}-${index})`} />
                {[-.24, 0, .24].map((offset, k) => (
                  <path key={offset} className={css.flowStroke}
                    d={`M${x0},${75 + offset * h0} C${mid},${75 + offset * h0} ${mid},${75 + offset * h1} ${x1},${75 + offset * h1}`}
                    fill="none" stroke={tone(stage.tone)} strokeWidth="1.2" pathLength="1" vectorEffect="non-scaling-stroke"
                    style={delay(index * 260 + k * 100 + 300)} />
                ))}
              </g>
            )
          })}
          {stages.map((stage, index) => integer(stage.value) === null ? null : (
            <rect className={css.flowPillar} key={stage.label} style={delay(index * 260)}
              x={center(index) - 3} y={75 - height(index) / 2} width="6" height={height(index)} rx="3" fill={tone(stage.tone)} />
          ))}
        </svg>
        <div className={css.flowSteps} style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))`, marginInline: `${50 / stages.length}%` }}>
          {steps.map((step, index) => <span className={css.stageLabel} key={index} style={delay(index * 260 + 400)}>{step}</span>)}
        </div>
      </div>
      <div className={css.flowReplay}>
        <button type="button" onClick={() => setReplay((value) => value + 1)} aria-label={t('replayAria', { label: label.toLowerCase() })}>{t('replay')}</button>
      </div>
    </div>
  )
}

/** The canonical-reuse ring: how much of the referenced bytes the unique set did not need. */
export function ReuseRing({ referenced, unique, t }: { referenced: unknown, unique: unknown, t: StorageT }): ReactNode {
  const fraction = canonicalReuse(referenced, unique)
  const percent = fraction === null ? null : Math.round(fraction * 1000) / 10
  return (
    <div className={css.reuseRing} role="img"
      aria-label={percent === null ? t('reuseUnavailable') : t('reuseAria', { percent })}>
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle cx="50" cy="50" r="42" fill="none" stroke="var(--dsw-alias-border-l2)" strokeWidth="7" />
        <circle className={css.reuseArc} cx="50" cy="50" r="42" fill="none" stroke="var(--storage-stored)" strokeWidth="7"
          pathLength="1" strokeDasharray="1" strokeDashoffset={1 - (fraction ?? 0)} strokeLinecap="round" />
      </svg>
      <div>
        <strong>{percent === null ? '—' : <CountUp value={percent} format={(value) => `${Math.round(value * 10) / 10}%`} ms={950} />}</strong>
        <span>{t('canonicalReuse')}</span>
      </div>
    </div>
  )
}

/** "3.4× deduplication", or the step marked unavailable. */
export function ratioStep(t: StorageT, left: unknown, right: unknown, label: string): string {
  const ratio = encodingRatio(left, right)
  return ratio ? t('stepRatio', { ratio, label }) : t('stepUnavailable', { label })
}
