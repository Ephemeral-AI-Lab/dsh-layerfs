/**
 * Numbers that count up when they first show and ease to each new value, and
 * the reader's reduced-motion setting (LayerFS Connect's
 * `components/layerfs/motion/{count-up,reduced-motion}`).
 */
import clsx from 'clsx'
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'

const QUERY = '(prefers-reduced-motion: reduce)'

/** True when the system asks for less motion. Safe to call anywhere. */
export const prefersReducedMotion = (): boolean => typeof window !== 'undefined' && window.matchMedia(QUERY).matches

const subscribe = (onChange: () => void) => {
  const media = window.matchMedia(QUERY)
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}

/** The same, kept current as the setting changes. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, prefersReducedMotion, () => false)
}

export interface CountUpOptions {
  /** Duration of each move. Default 800 ms. */
  ms?: number
  /** Where the first count starts. Default 0. */
  from?: number
}

/** `value`, eased (out-cubic) from where it last was; null stays null. */
export function useCountUp(value: number | null, { ms = 800, from = 0 }: CountUpOptions = {}): number | null {
  const [shown, setShown] = useState<number | null>(value === null ? null : prefersReducedMotion() ? value : from)
  const at = useRef(shown ?? from)
  useEffect(() => {
    if (value === null) { setShown(null); return }
    if (prefersReducedMotion() || at.current === value) {
      at.current = value
      setShown(value)
      return
    }
    const start = at.current
    const t0 = performance.now()
    let frame = 0
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / ms)
      at.current = start + (value - start) * (1 - (1 - k) ** 3)
      setShown(at.current)
      if (k < 1) frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [value, ms])
  return shown
}

export interface CountUpProps extends CountUpOptions {
  value: number | null
  /** How to print it. Default: a rounded, grouped integer. */
  format?: (n: number) => string
  /** Shown while the value is null. */
  placeholder?: string
  className?: string
}

const grouped = (n: number): string => Math.round(n).toLocaleString()

/** A number that counts up, in tabular figures. */
export function CountUp({ value, format = grouped, placeholder = '—', className, ...options }: CountUpProps): ReactNode {
  const v = useCountUp(value, options)
  return <span className={clsx(className)} style={{ fontVariantNumeric: 'tabular-nums' }}>{v === null ? placeholder : format(v)}</span>
}
