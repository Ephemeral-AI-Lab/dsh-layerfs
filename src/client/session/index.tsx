/**
 * Session area of dsh-layerfs: the LayerFS mark on a project session's row in
 * the Workspace list. A project session's files, history and sandbox are the
 * conversation's own tabs (`../views/`). Ownership comes from the one store
 * (`./ownership.ts`), which reads every row's place in one coalesced batch.
 */
import { useEffect, useRef, type ReactNode } from 'react'
import type { LayerfsApi } from '../api.ts'
import { LayerfsGlyph } from '../overview/glyph.tsx'
import { NS, locales } from './locale.ts'
import { useOwnership } from './ownership.ts'
import css from './session.module.css'

type Translate = (key: string, params?: Record<string, string | number>) => string

/** The Workspace list's LayerFS mark: a small layers glyph on a project session's row. */
function RowMark({ sessionId, api, t }: { sessionId: string, api: LayerfsApi, t: Translate }): ReactNode {
  const ownership = useOwnership(api, sessionId)
  const mark = useRef<HTMLSpanElement>(null)
  const marked = useRef<{ row: Element, sessionId: string } | null>(null)
  const warned = useRef(false)

  useEffect(() => {
    // An unknown read changes nothing: the row keeps whatever the last answer put
    // on it, so a host blip never re-shows a row that was hidden as a project's.
    if (ownership.state === 'unknown') return
    const expected = `session:${sessionId}`
    const row = mark.current?.closest('[role="treeitem"][data-row-key]') ?? null
    if (ownership.state === 'notProject') {
      const held = marked.current
      if (held && held.row.getAttribute('data-layerfs-project-owned') === held.sessionId) held.row.removeAttribute('data-layerfs-project-owned')
      marked.current = null
      if (row && row.getAttribute('data-layerfs-project-owned') === sessionId) row.removeAttribute('data-layerfs-project-owned')
      return
    }
    // DSH offers ambient decorations but no public session-list filter. Limit
    // this adapter to the documented session row identity and fail visible if
    // the renderer no longer supplies it (one warning per row, not per event).
    if (!row || row.getAttribute('data-row-key') !== expected) {
      if (!warned.current) {
        warned.current = true
        console.warn(`[dsh-layerfs] row mark: expected ${expected}, found ${row ? JSON.stringify(row.getAttribute('data-row-key')) : 'no row'}; the session is not hidden from DSH's list`)
      }
      return
    }
    row.setAttribute('data-layerfs-project-owned', sessionId)
    marked.current = { row, sessionId }
  }, [ownership.state, sessionId])

  // Unload: DSH reuses row nodes, so drop the attribute this row put there.
  useEffect(() => () => {
    const held = marked.current
    if (held && held.row.getAttribute('data-layerfs-project-owned') === held.sessionId) held.row.removeAttribute('data-layerfs-project-owned')
    marked.current = null
  }, [])

  // The mark itself renders only for a known project; an unknown read leaves the
  // row as it is (mark included) until the next answer.
  if (ownership.state !== 'project' || !ownership.project) return null
  return <span ref={mark} className={css.rowMark} title={t('inProject', { project: ownership.project })}><LayerfsGlyph size={11} /></span>
}

export function registerSession(ctx: any, api: LayerfsApi): void {
  ctx.effect(() => ctx.locale.register(NS, locales), 'dsh-layerfs: session locale')
  const t: Translate = ctx.locale.bind(NS)
  ctx.effect(() => ctx.slots.inject('sidebar.session.row.trailing', () => ctx.slots.register({
    name: 'sidebar.session.row.trailing', id: 'dsh-layerfs.mark', order: 40, locale: NS,
    inject: (sessionId: string) => ({ sessionId: String(sessionId), api, t }),
  }, RowMark)), 'dsh-layerfs: session row mark')
}
