import type { CSSProperties, ReactNode } from 'react'
import { StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import clsx from 'clsx'
import css from './StatusDot.module.css'

export function coreOf(size: number): number {
  const slot = Math.max(2, Math.round(size))
  const target = Math.min(slot, slot >= 12 ? 8 : 6)
  return (slot - target) % 2 ? target - 1 : target
}

export function StatusDot({ state, size, className, label }: {
  state: StateDotState
  size?: number | undefined
  className?: string | undefined
  label?: string | undefined
}): ReactNode {
  if (state === 'ongoing') return <StateDot state="ongoing" size={size} className={className} />
  const slot = Math.max(2, Math.round(size ?? 10))
  return (
    <span
      className={clsx(css.dot, className)}
      data-state={state}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      title={label}
      style={{ width: slot, height: slot, '--core': `${coreOf(slot)}px` } as CSSProperties}
    />
  )
}
