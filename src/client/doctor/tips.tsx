/**
 * The Doctor page's tips and toasts, and its marks: the plugin's StateDot
 * (ok done, bad error, warn warning, nc idle, run ongoing), always beside
 * the words that say the same, so colour is never the only carrier.
 *
 * A tip hangs off a signal, a mark group or a button, never a whole row. It
 * opens 120 ms after the pointer or the keyboard arrives and at once on a tap,
 * below its anchor (beside it when there is no room below, above only when
 * neither fits), and closes on Escape, scroll and resize. One tip shows at a
 * time; it has its own surface, so its text and marks keep their contrast on
 * every row colour. The toasts are the page's polite live region.
 */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type PointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './DoctorPage.module.css'

export type MarkKind = 'ok' | 'bad' | 'warn' | 'nc' | 'run'

/** A check's or a row's result as the plugin's state dot. */
export const MARK_DOT: Record<MarkKind, StateDotState> = { ok: 'done', bad: 'error', warn: 'warning', nc: 'idle', run: 'ongoing' }

/** A result's StateDot at check-mark size (a spinner a little larger). */
export const markDot = (s: MarkKind): ReactNode => <StateDot state={MARK_DOT[s]} size={s === 'run' ? 10 : 7} className={css.mk} />

/** What a tip says (its lines, checks and commands), in the tip layer or in a Signal's card. */
export function TipBody({ tip }: { tip: TipData }): ReactNode {
  return (
    <>
      {(tip.lines ?? []).filter(Boolean).map((line, i) => <span key={i} className={css.tipLine}>{line}</span>)}
      {tip.checks?.length ? (
        <ul>{tip.checks.map((c, i) => <li key={i}>{markDot(c.r)}<code>{c.name}</code><i>{c.text}</i></li>)}</ul>
      ) : null}
      {tip.cmds?.length ? (
        <pre>{tip.cmds.map((line, i) => (
          <span key={i}>{i > 0 ? '\n' : ''}{line.startsWith('#') ? <i>{line}</i> : <><i>$ </i>{line}</>}</span>
        ))}</pre>
      ) : null}
    </>
  )
}

export interface TipCheck { r: MarkKind, name: string, text: string }

export interface TipData {
  title: string
  mark?: MarkKind | undefined
  lines?: readonly (string | null | undefined | false)[] | undefined
  checks?: readonly TipCheck[] | undefined
  /** Commands, one per line; a line starting with `#` is a comment. */
  cmds?: readonly string[] | undefined
  wide?: boolean | undefined
}

interface TipApi {
  show(el: HTMLElement, tip: TipData, soon: boolean): void
  hide(el?: HTMLElement): void
  /** The anchor's tip changed while it may be showing. */
  sync(el: HTMLElement, tip: TipData | null): void
  toast(text: string): void
}

const Ctx = createContext<TipApi>({ show() {}, hide() {}, sync() {}, toast() {} })

const TIP_ID = 'lfs-doctor-tip'

function place(anchor: HTMLElement, tip: HTMLElement): void {
  const r = anchor.getBoundingClientRect()
  // measured from the corner: where it last stood must not narrow it
  tip.style.left = '0px'
  tip.style.top = '0px'
  const w = tip.offsetWidth, h = tip.offsetHeight
  const vw = window.innerWidth, vh = window.innerHeight, gap = 6, pad = 8
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
  let left: number, top: number
  if (r.bottom + gap + h <= vh - pad) { top = r.bottom + gap; left = clamp(r.left, pad, vw - w - pad) }
  else if (r.right + gap + w <= vw - pad) { left = r.right + gap; top = clamp(r.top, pad, vh - h - pad) }
  else if (r.left - gap - w >= pad) { left = r.left - gap - w; top = clamp(r.top, pad, vh - h - pad) }
  else { top = Math.max(pad, r.top - gap - h); left = clamp(r.left, pad, vw - w - pad) }
  tip.style.left = `${left}px`
  tip.style.top = `${top}px`
}

/** Provides tips and toasts to the page under it. */
export function TipLayer({ children }: { children: ReactNode }): ReactNode {
  const [shown, setShown] = useState<{ el: HTMLElement, tip: TipData } | null>(null)
  const [toasts, setToasts] = useState<{ id: number, text: string }[]>([])
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const shownRef = useRef(shown)
  shownRef.current = shown
  const tipRef = useRef<HTMLDivElement | null>(null)
  const seq = useRef(0)
  const toastTimers = useRef(new Set<ReturnType<typeof setTimeout>>())

  const api = useMemo<TipApi>(() => ({
    show(el, tip, soon) {
      clearTimeout(timer.current)
      const open = () => { if (el.isConnected && (!soon || el.matches(':hover') || el === document.activeElement)) setShown({ el, tip }) }
      if (soon) timer.current = setTimeout(open, 120)
      else open()
    },
    hide(el) {
      clearTimeout(timer.current)
      if (!el || shownRef.current?.el === el) setShown(null)
    },
    sync(el, tip) {
      if (shownRef.current?.el !== el) return
      setShown(tip ? { el, tip } : null)
    },
    toast(text) {
      const id = ++seq.current
      setToasts((list) => [...list.slice(-3), { id, text }])
      const t = setTimeout(() => { toastTimers.current.delete(t); setToasts((list) => list.filter((x) => x.id !== id)) }, 3600)
      toastTimers.current.add(t)
    },
  }), [])

  useEffect(() => () => { clearTimeout(timer.current); for (const t of toastTimers.current) clearTimeout(t) }, [])

  // the anchor names its tip while it shows
  useLayoutEffect(() => {
    if (!shown) return
    const { el } = shown
    if (!el.isConnected) { setShown(null); return }
    el.setAttribute('aria-describedby', TIP_ID)
    if (tipRef.current) place(el, tipRef.current)
    return () => { el.removeAttribute('aria-describedby') }
  }, [shown])

  useEffect(() => {
    if (!shown) return
    const hide = () => setShown(null)
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') hide() }
    const scroll = (e: Event) => { if (!(e.target instanceof HTMLElement) || !e.target.hasAttribute('data-tip-keep')) hide() }
    const down = (e: Event) => { if (e.target instanceof Node && !shown.el.contains(e.target)) hide() }
    window.addEventListener('keydown', key)
    window.addEventListener('resize', hide)
    window.addEventListener('scroll', scroll, true)
    window.addEventListener('pointerdown', down, true)
    return () => {
      window.removeEventListener('keydown', key)
      window.removeEventListener('resize', hide)
      window.removeEventListener('scroll', scroll, true)
      window.removeEventListener('pointerdown', down, true)
    }
  }, [shown])

  const tip = shown?.tip
  const wide = !!tip && (tip.wide || !!tip.checks?.length || !!tip.cmds?.length)
  return (
    <Ctx.Provider value={api}>
      {children}
      {createPortal((
        <>
          <div ref={tipRef} id={TIP_ID} role="tooltip" className={css.tip} data-on={tip ? '' : undefined} data-wide={wide || undefined}>
            {tip ? (
              <>
                <b>{tip.mark ? markDot(tip.mark) : null}{tip.title}</b>
                <TipBody tip={tip} />
              </>
            ) : null}
          </div>
          <div className={css.toasts} role="status" aria-live="polite">
            {toasts.map((x) => <div key={x.id} className={css.toast}>{x.text}</div>)}
          </div>
        </>
      ), document.body)}
    </Ctx.Provider>
  )
}

export const useToast = (): ((text: string) => void) => useContext(Ctx).toast

export interface TipProps {
  onPointerEnter(e: PointerEvent<HTMLElement>): void
  onPointerLeave(e: PointerEvent<HTMLElement>): void
  onFocus(e: FocusEvent<HTMLElement>): void
  onBlur(e: FocusEvent<HTMLElement>): void
}

/**
 * The handlers that hang `tip` off an element, and `showNow` for a tap (a
 * signal, a mark group, a button that cannot be pressed: the tip says why).
 */
export function useTip(tip: TipData | null): { props: TipProps, showNow(el: HTMLElement): void, hide(): void } {
  const api = useContext(Ctx)
  const el = useRef<HTMLElement | null>(null)
  const ref = useRef(tip)
  ref.current = tip
  // its words changed while it shows (a count, a state): the open tip follows
  const key = tip ? JSON.stringify(tip) : ''
  useEffect(() => { if (el.current) api.sync(el.current, ref.current) }, [api, key])
  useEffect(() => () => { if (el.current) api.hide(el.current) }, [api])
  const showNow = useCallback((target: HTMLElement) => { el.current = target; if (ref.current) api.show(target, ref.current, false) }, [api])
  const props = useMemo<TipProps>(() => ({
    onPointerEnter(e) { if (e.pointerType === 'touch') return; el.current = e.currentTarget; if (ref.current) api.show(e.currentTarget, ref.current, true) },
    onPointerLeave(e) { api.hide(e.currentTarget) },
    onFocus(e) { el.current = e.currentTarget; if (ref.current && e.currentTarget.matches(':focus-visible')) api.show(e.currentTarget, ref.current, true) },
    onBlur(e) { api.hide(e.currentTarget) },
  }), [api])
  const hide = useCallback(() => { api.hide() }, [api])
  return { props, showNow, hide }
}
