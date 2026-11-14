/**
 * A health signal: one dot (green, yellow, red; grey when unknown, a spinner
 * while something runs) that says the state at a glance, with the words —
 * what is wrong, LayerFS's own reason, and the verb that fixes it — in a card
 * shown on hover or keyboard focus. Cards and lists stay free of prose.
 */
import type { ReactNode } from 'react'
import { HoverCard, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './Signal.module.css'

export type SignalState = 'ok' | 'warning' | 'error' | 'idle' | 'ongoing'

const DOT = { ok: 'done', warning: 'warning', error: 'error', idle: 'idle', ongoing: 'ongoing' } as const

export function Signal({ state, title, detail, action, size = 8 }: {
  state: SignalState
  /** The state in a few words (also the dot's accessible name). */
  title: string
  /** The longer reason, usually LayerFS's own words. */
  detail?: ReactNode
  /** The fix, as a button inside the hover card. */
  action?: ReactNode
  size?: number
}): ReactNode {
  return (
    <span className={css.root} onClick={(e) => e.stopPropagation()}>
      <HoverCard inline fitContent openDelayMs={120}
        anchor={(
          <button type="button" className={css.signal} data-state={state} aria-label={title}>
            <StateDot state={DOT[state]} size={state === 'ongoing' ? size + 3 : size} />
          </button>
        )}
        content={(
          <span className={css.body}>
            <span className={css.title} data-state={state}>{title}</span>
            {detail ? <span className={css.detail}>{detail}</span> : null}
            {action ? <span className={css.action}>{action}</span> : null}
          </span>
        )} />
    </span>
  )
}
