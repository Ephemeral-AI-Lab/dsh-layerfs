/**
 * The conversation's "opening" state (B2): while `sessions.open` resolves a
 * closed project conversation, DSH has not announced or selected it yet, so the
 * conversation area has nothing to show. This is one small status pill in the
 * frame's overlay layer — our own surface, not DSH's Chat, composer or tab row —
 * and it is gone the moment the answer lands (opened or refused). It reports
 * what the client knows and nothing more: no progress, no percentage.
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { LayerfsApi, OpeningSession } from '../api.ts'
import { LayerfsGlyph } from '../overview/glyph.tsx'
import type { ListT } from './list-locale.ts'
import css from './list.module.css'

/** Renders the pending open, or nothing when no `sessions.open` is in flight. */
export function OpeningConversation({ api, t }: { api: LayerfsApi, t: ListT }): ReactNode {
  const [opening, setOpening] = useState<OpeningSession | undefined>(() => api.openingSession())
  useEffect(() => {
    const read = () => setOpening(api.openingSession())
    read()
    return api.onOpening(read)
  }, [api])
  if (!opening) return null
  return <div className={css.opening} role="status" aria-live="polite" data-opening-conversation={opening.sessionId} data-opening-project={opening.project}>
    <span className={css.openingMark} aria-hidden="true"><LayerfsGlyph size={12} /></span>
    <span>{t('openingConversation')}</span>
  </div>
}
