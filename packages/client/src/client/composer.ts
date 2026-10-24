// The LayerFS tab is a full-height board, so the conversation's composer is
// hidden while it shows. dsh places the composer's seat as a direct child of
// the conversation's scroll body, beside the view area; the tab marks that
// scroll body, and the seat (the child holding [data-composer-card]) is not
// displayed. dsh then measures the seat as 0 px tall (--dsh-composer-height),
// so the board takes the whole band.
import { useEffect, type RefObject } from 'react'

const MARK = 'data-lfs-composer-hidden'
const RULE = `[${MARK}] > :has([data-composer-card]) { display: none !important; }`

function injectRule(doc: Document) {
  if (doc.getElementById('lfs-composer-rule')) return
  const style = doc.createElement('style')
  style.id = 'lfs-composer-rule'
  style.textContent = RULE
  doc.head.append(style)
}

/** The nearest ancestor with a child that holds the composer card, other than the tab's own branch. */
function seatParent(anchor: Element): Element | null {
  for (let el: Element | null = anchor; el?.parentElement; el = el.parentElement) {
    const parent: Element = el.parentElement
    for (const child of parent.children) if (child !== el && child.querySelector('[data-composer-card]')) return parent
  }
  return null
}

/** Hides the conversation's composer while the element is mounted. */
export function useHiddenComposer(anchor: RefObject<Element | null>) {
  useEffect(() => {
    const el = anchor.current
    const parent = el && seatParent(el)
    if (!parent) return
    injectRule(el.ownerDocument)
    parent.setAttribute(MARK, '')
    return () => {
      parent.removeAttribute(MARK)
    }
  }, [anchor])
}
