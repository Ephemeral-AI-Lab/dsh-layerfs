/**
 * The conversation's "opening" state (B2): while `sessions.open` resolves a
 * closed project conversation, DSH has not announced or selected it yet, so the
 * conversation area has nothing to show. This is one small status pill in the
 * frame's overlay layer — our own surface, not DSH's Chat, composer or tab row —
 * and it is gone the moment the answer lands (opened or refused). It reports
 * what the client knows and nothing more: no progress, no percentage.
 *
 * The overlay is page-wide while the owner asked for the conversation's centre,
 * so the pill measures the pane under DSH's `main.conversation` slot and sits at
 * that pane's centre on both axes (not the window's). It is still a pill, never
 * a backdrop: `pointer-events: none`, no click target, no dimming layer.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { LayerfsApi, OpeningSession } from '../api.ts'
import { LayerfsGlyph } from '../overview/glyph.tsx'
import type { ListT } from './list-locale.ts'
import css from './list.module.css'

/**
 * The widest mounted conversation pane. The `main.conversation` slot host is a
 * zero-size wrapper; its first element is the pane that carries the header and
 * the body. A split view can mount more than one, and the open names no pane,
 * so the one with the most room is the one the person is looking at.
 */
function conversationPane(): HTMLElement | null {
  if (typeof document === 'undefined') return null
  let pane: HTMLElement | null = null
  let area = 0
  for (const host of document.querySelectorAll<HTMLElement>('[data-slot="main.conversation"]')) {
    const candidate = (host.firstElementChild as HTMLElement | null) ?? host
    const rect = candidate.getBoundingClientRect()
    if (rect.width < 2 || rect.height < 2) continue
    const next = rect.width * rect.height
    if (next > area) { pane = candidate; area = next }
  }
  return pane
}

/** Sits the pill at its pane's centre, and follows a pane resize or a side-panel move. */
function usePaneCentre(ref: RefObject<HTMLDivElement | null>, opening: OpeningSession | undefined): void {
  useLayoutEffect(() => {
    if (!opening || typeof window === 'undefined') return
    const pill = ref.current
    if (!pill) return
    let frame = 0
    const place = () => {
      frame = 0
      const pane = conversationPane()
      if (!pane) return
      const rect = pane.getBoundingClientRect()
      pill.style.setProperty('--lfs-opening-x', `${rect.left + rect.width / 2}px`)
      pill.style.setProperty('--lfs-opening-y', `${rect.top + rect.height / 2}px`)
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(place) }
    place()
    // The frame resizes when the sidebar, the right panel or a window edge moves.
    const pane = conversationPane()
    const observer = typeof ResizeObserver === 'function' && pane ? new ResizeObserver(schedule) : undefined
    if (pane && observer) observer.observe(pane)
    window.addEventListener('resize', schedule)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('resize', schedule)
    }
  }, [opening, ref])
}

/** Renders the pending open, or nothing when no `sessions.open` is in flight. */
export function OpeningConversation({ api, t }: { api: LayerfsApi, t: ListT }): ReactNode {
  const [opening, setOpening] = useState<OpeningSession | undefined>(() => api.openingSession())
  const pill = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const read = () => setOpening(api.openingSession())
    read()
    return api.onOpening(read)
  }, [api])
  usePaneCentre(pill, opening)
  if (!opening) return null
  return <div ref={pill} className={css.opening} role="status" aria-live="polite" data-opening-conversation={opening.sessionId} data-opening-project={opening.project} data-opening-pane="conversation">
    <span className={css.openingMark} aria-hidden="true"><LayerfsGlyph size={12} /></span>
    <span>{t('openingConversation')}</span>
  </div>
}
