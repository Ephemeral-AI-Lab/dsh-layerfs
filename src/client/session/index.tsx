/**
 * Session area of dsh-layerfs: the LayerFS mark on a project session's row in
 * the Workspace list. A project session's files, history and sandbox are the
 * conversation's own tabs (`../views/`). Ownership comes from the one store
 * (`./ownership.ts`), which reads every row's place in one coalesced batch.
 */
import { useEffect, useRef, type ReactNode } from 'react'
import type { LayerfsApi } from '../api.ts'
import { LayerfsGlyph } from '../overview/glyph.tsx'
import { PROJECT_OWNED_ATTR, ROW_SELECTOR, RowProbe, adapterMisses, applyRowOwnership } from './adapters.ts'
import { NS, locales } from './locale.ts'
import { ownershipStore, useOwnership } from './ownership.ts'
import css from './session.module.css'

type Translate = (key: string, params?: Record<string, string | number>) => string

/** The Workspace list's LayerFS mark: a small layers glyph on a project session's row. */
function RowMark({ sessionId, api, t }: { sessionId: string, api: LayerfsApi, t: Translate }): ReactNode {
  const ownership = useOwnership(api, sessionId)
  const mark = useRef<HTMLSpanElement>(null)
  const marked = useRef<{ row: Element, sessionId: string } | null>(null)

  useEffect(() => {
    // An unknown read changes nothing: the row keeps whatever the last answer put
    // on it, so a host blip never re-shows a row that was hidden as a project's.
    if (ownership.state === 'unknown') return
    const row = mark.current?.closest(ROW_SELECTOR) ?? null
    if (ownership.state === 'notProject') {
      const held = marked.current
      if (held && held.row.getAttribute(PROJECT_OWNED_ATTR) === held.sessionId) held.row.removeAttribute(PROJECT_OWNED_ATTR)
      marked.current = null
      applyRowOwnership('notProject', sessionId, row)
      return
    }
    // DSH offers ambient decorations but no public session-list filter. Limit
    // this adapter to the documented session row identity and fail visible if
    // the renderer no longer supplies it: the collector reports it once per
    // session, never per render. A row whose identity differs is left unmarked.
    if (applyRowOwnership('project', sessionId, row) === 'marked' && row) marked.current = { row, sessionId }
  }, [ownership.state, sessionId])

  // Unload: DSH reuses row nodes, so drop the attribute this row put there.
  useEffect(() => () => {
    const held = marked.current
    if (held && held.row.getAttribute(PROJECT_OWNED_ATTR) === held.sessionId) held.row.removeAttribute(PROJECT_OWNED_ATTR)
    marked.current = null
  }, [])

  // The mark renders for a known project; an unknown read keeps the last
  // project answer (the store keeps it), so the row keeps its mark until the
  // next answer. An unknown read with no project answer yet shows none.
  const project = ownership.state === 'project' || ownership.state === 'unknown' ? ownership.project : undefined
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

  // The seat can stop rendering without unmounting the plugin (a DSH update):
  // then RowMark never mounts and nothing marks the row. This probe watches the
  // rows the ownership store already knows are projects, so a present-but-
  // unmarked row is reported once and left visible (fail-open) instead of the
  // whole hide rule going quiet. It starts with the plugin, not with a row.
  ctx.effect(() => {
    const probe = new RowProbe(ownershipStore(api), adapterMisses, document)
    probe.start()
    return () => probe.stop()
  }, 'dsh-layerfs: session row probe')
}
