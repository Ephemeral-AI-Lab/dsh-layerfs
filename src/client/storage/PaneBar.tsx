/**
 * The top of a Storage editor tab. The tab strip and the explorer already name
 * the page, so the bar shows no title: facts and state on the left, the
 * actions found nowhere else on the right. The title stays for assistive
 * technology.
 */
import type { ReactNode } from 'react'
import css from './Storage.module.css'

export function PaneBar({ title, children, actions }: {
  /** The page's name, read by assistive technology only. */
  title: string
  /** Facts and state chips, or the page's own view switch. */
  children?: ReactNode
  actions?: ReactNode
}): ReactNode {
  return (
    <header className={css.paneBar}>
      <h1 className={css.srOnly}>{title}</h1>
      <div className={css.paneBarMeta}>{children}</div>
      {actions ? <div className={css.paneBarActions}>{actions}</div> : null}
    </header>
  )
}
