/**
 * A call's command: the words (`layerfs`, the operation emphasized, the
 * arguments), and the table cell that shows the whole command in a popover on
 * hover or when its row has keyboard focus. The primitives Tooltip draws a
 * plain-text, click-through bubble and HoverCard caps inline cards at 300px,
 * so the full command (monospace, wrapped, selectable, up to 640px) gets this
 * small popover placed with the primitives' `useAnchoredPosition`.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CommandParts } from './format.ts'
import css from './logs.module.css'

/** `layerfs` quiet, the operation strong, the arguments plain. Text content is the shell command. */
export function CommandWords({ parts }: { parts: CommandParts }): ReactNode {
  return (
    <>
      <span className={css.cmdBin}>layerfs</span>
      {parts.verb && <>{' '}<span className={css.cmdVerb}>{parts.verb}</span></>}
      {parts.rest && <span className={css.cmdArgs}>{parts.rest}</span>}
    </>
  )
}

const OPEN_DELAY = 350
const CLOSE_GRACE = 150

/**
 * The command cell's content and its popover.
 * @param props.parts - the command's words.
 * @param props.focusOpen - the row has keyboard focus: show the popover now.
 * @param props.popoverId - id the row names in `aria-describedby`.
 * @param props.disabled - hide it (the call's detail is open over the table).
 */
export function CommandCell({ parts, focusOpen, popoverId, disabled }: { parts: CommandParts, focusOpen: boolean, popoverId: string, disabled?: boolean }): ReactNode {
  const anchorRef = useRef<HTMLElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [hovered, setHovered] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const open = (hovered || focusOpen) && !dismissed && !disabled
  const style = useAnchoredPosition({ open, anchorRef, panelRef, side: 'bottom', align: 'start', gap: 6, margin: 12, layoutKey: parts.full })

  const later = (next: boolean, ms: number) => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setHovered(next), ms)
  }
  useEffect(() => () => clearTimeout(timer.current), [])
  // A new focus or hover after Escape shows it again.
  useEffect(() => { if (!focusOpen && !hovered) setDismissed(false) }, [focusOpen, hovered])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setDismissed(true) } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  return (
    <>
      <code ref={anchorRef} className={css.command}
        onPointerEnter={(e) => { if (e.pointerType !== 'touch') later(true, hovered ? 0 : OPEN_DELAY) }}
        onPointerLeave={() => later(false, CLOSE_GRACE)}>
        <CommandWords parts={parts} />
      </code>
      {open && createPortal(
        <div ref={panelRef} id={popoverId} role="tooltip" className={css.popover} style={style ?? { visibility: 'hidden' }}
          onPointerEnter={() => clearTimeout(timer.current)}
          onPointerLeave={() => later(false, CLOSE_GRACE)}
          // React bubbles portal events to the row; selecting or clicking here must not open the detail.
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}>
          <code className={css.popoverText}><CommandWords parts={parts} /></code>
        </div>,
        document.body,
      )}
    </>
  )
}
