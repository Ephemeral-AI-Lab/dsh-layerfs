/**
 * Session area of dsh-layerfs: the LayerFS mark on a project session's row in
 * the Workspace list. A project session's files, history and sandbox are the
 * conversation's own tabs (`../views/`).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { LayerfsApi } from '../api.ts'
import { LayerfsGlyph } from '../overview/glyph.tsx'
import { NS, locales } from './locale.ts'
import css from './session.module.css'

type Translate = (key: string, params?: Record<string, string | number>) => string

/** The Workspace list's LayerFS mark: a small layers glyph on a project session's row. */
function RowMark({ sessionId, api, t }: { sessionId: string, api: LayerfsApi, t: Translate }): ReactNode {
  const [project, setProject] = useState<string | null>(null)
  const mark = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!project) return
    // DSH offers ambient decorations but no public session-list filter. Limit
    // this adapter to the documented session row identity and fail visible if
    // the renderer no longer supplies it. Blank rows omit this slot entirely.
    const row = mark.current?.closest('[role="treeitem"][data-row-key]')
    if (!row || row.getAttribute('data-row-key') !== `session:${sessionId}`) return
    row.setAttribute('data-layerfs-project-owned', sessionId)
    return () => { if (row.getAttribute('data-layerfs-project-owned') === sessionId) row.removeAttribute('data-layerfs-project-owned') }
  }, [project, sessionId])
  useEffect(() => {
    let live = true
    const read = () => api.op<{ place: { project: string | null } | null }>('session.place', { sessionId })
      .then((r) => { if (live) setProject(r.place?.project ?? null) }, () => {})
    read()
    const off = api.onEvent('layerfs-session', read)
    return () => { live = false; off() }
  }, [api, sessionId])
  if (!project) return null
  return <span ref={mark} className={css.rowMark} title={t('inProject', { project })}><LayerfsGlyph size={11} /></span>
}

export function registerSession(ctx: any, api: LayerfsApi): void {
  ctx.effect(() => ctx.locale.register(NS, locales), 'dsh-layerfs: session locale')
  const t: Translate = ctx.locale.bind(NS)
  ctx.effect(() => ctx.slots.inject('sidebar.session.row.trailing', () => ctx.slots.register({
    name: 'sidebar.session.row.trailing', id: 'dsh-layerfs.mark', order: 40, locale: NS,
    inject: (sessionId: string) => ({ sessionId: String(sessionId), api, t }),
  }, RowMark)), 'dsh-layerfs: session row mark')
}
