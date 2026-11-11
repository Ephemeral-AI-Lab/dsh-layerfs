/**
 * A sidebar row under LayerFS. The sidebar owns the row and only renders the
 * plugin's icon, so a child row indents through its icon: the padding moves
 * the glyph and the title after it, and a hairline guide joins the children.
 */
import type { ReactNode } from 'react'
import css from './child.module.css'

export function ChildGlyph({ children }: { children: ReactNode }): ReactNode {
  return <span className={css.child}>{children}</span>
}
