/**
 * The DSH sidebar's own fold: the wide column vs the 56px icon rail. The
 * shell's `wide` owner share reaches plugins only through sidebar section
 * occupants, so a `sidebar.footer.action` probe reports it. `collapse` is the
 * mirror of the shell's expandSidebar (`if (collapsed) toggleSidebar()`).
 */
import { useEffect, type ReactNode } from 'react'

/** The rail's fold as last reported by the shell, and the collapse that folds it. */
export interface SidebarRail {
  /** Fold the sidebar to the icon rail; a no-op while already collapsed. */
  collapse(): void
  /** The component registered into `sidebar.footer.action` to observe `wide`. */
  readonly Probe: (props: { wide?: boolean | undefined }) => ReactNode
}

export function createSidebarRail(layout: { toggleSidebar?: (() => void) | undefined } | undefined): SidebarRail {
  let wide = true
  return {
    collapse() {
      if (!wide) return
      wide = false // the rail is closing; don't let a same-click sync toggle back
      layout?.toggleSidebar?.()
    },
    Probe: function RailProbe({ wide: w }): ReactNode {
      useEffect(() => { wide = w !== false }, [w])
      return null
    },
  }
}
