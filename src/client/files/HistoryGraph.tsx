/**
 * The history tree: main rides the middle, Branches grow above and below it,
 * and every checkpoint is one leaf, one step along the axis in saved order.
 * It opens on the whole run; zooming stretches the axis only, so lanes keep
 * their height and nothing is folded at any zoom.
 */
import { IconFullscreenOutlineRegular, IconPlusOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import clsx from 'clsx'
import { createPortal } from 'react-dom'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react'
import { shortId, toMs } from './format.ts'
import { branchLabel } from './labels.ts'
import type { TreeBranch, TreeLayout, TreeRow } from './tree-model.ts'
import type { Translate } from './types.ts'
import css from './History.module.css'

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n))

/** One hue per family of Branches (the name up to its first digit or separator), from semantic state colors. */
const BOUGHS = [
  'var(--dsw-alias-state-business-primary)',
  'var(--dsw-alias-state-done-primary)',
  'var(--dsw-alias-state-warn-primary)',
  'color-mix(in srgb, var(--dsw-alias-state-success-primary) 45%, var(--dsw-alias-state-business-primary))',
  'var(--dsw-alias-state-error-primary)',
  'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 55%, var(--dsw-alias-state-error-primary))',
]
const MAIN = 'var(--dsw-alias-state-success-primary)'
export const branchColor = (name: string): string => {
  if (name === 'main') return MAIN
  const family = name.startsWith('dsh.') ? name : /^[A-Za-z]+/.exec(name)?.[0] ?? name
  let hash = 0
  for (const c of family) hash = (hash * 31 + c.charCodeAt(0)) | 0
  return BOUGHS[Math.abs(hash) % BOUGHS.length]
}

export interface HistoryGraphProps {
  layout: TreeLayout
  selected: string | null
  /** The Branch in focus: it and its line of descent stay lit, the rest dims. */
  branch: string
  /** Pans to this row when it changes (e.g. a deep-linked Commit). */
  focus?: string | null | undefined
  onSelect: (id: string, branch: string) => void
  onBranch: (branch: string) => void
  /** Bumps to go back to the whole run. */
  reset?: number | undefined
  /** Where the zoom controls go (a slot among the caller's controls); over the tree without one. */
  controlsHost?: HTMLElement | null | undefined
  inspector?: ReactNode
  /** The camera, to restore on a remount: `zoom` 0 is the whole run. */
  onViewport?: ((left: number, zoom: number) => void) | undefined
  viewportRequest?: { left: number, zoom: number } | null | undefined
  /** The history is read: the tree may grow in. Until then nothing is drawn, so it grows once, whole. */
  ready?: boolean | undefined
  t: Translate
}

/** About this many steps fill the screen while the tree grows and follows its tip. */
const FOLLOW_STEPS = 400
/** Checkpoints the growing tree adds each second. */
const GROW_RATE = 200

/** The axis band, the room kept right of the newest step for a name tag, and the widest a step gets. */
const AXIS = 24
const LEFT = 18
const TAG_ROOM = 120
const STEP_MAX = 26
const GAP_MAX = 34
/** The widest the lines spread when zoomed all the way in. */
const GAP_ZOOMED = 40
/** Extra room, in gaps, between main and its nearest Branch on each side. */
const MAIN_ROOM = 0.5
/** The most of the gap between two lines a leaf may fill. */
const LEAF_REACH = 0.4
const GAP_MIN = 16

interface Hover { row?: TreeRow, branch: string, names?: string[], x: number, y: number }

/** A leaf's outline from its own step on the line, up (`side` -1) or down, leaning a little the way the Branch grows, at scale `s`. */
function leafShape(side: number, s: number): string {
  const a = side * -0.3
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const pt = (x: number, y: number) => [(x * cos - y * sin) * s, (x * sin + y * cos) * s]
  const [c1x, c1y] = pt(3.4, side * 3.2)
  const [tx, ty] = pt(0.6, side * 9)
  const [c2x, c2y] = pt(-3, side * 4)
  const f = (n: number) => n.toFixed(1)
  return `q${f(c1x)} ${f(c1y)} ${f(tx)} ${f(ty)}q${f(c2x - tx)} ${f(c2y - ty)} ${f(-tx)} ${f(-ty)}z`
}

export function HistoryGraph({ layout: latest, selected, branch, focus, onSelect, onBranch, reset = 0, controlsHost, inspector, onViewport, viewportRequest, ready = true, t }: HistoryGraphProps): ReactNode {
  const host = useRef<HTMLDivElement>(null)
  // While the tree grows in it is drawn from the layout it started with: checkpoints landing meanwhile would move every lane.
  const [held, setHeld] = useState<TreeLayout | null>(null)
  const layout = held ?? latest
  const latestRef = useRef(latest)
  latestRef.current = latest
  const [size, setSize] = useState({ width: 0, height: 0 })
  /** The camera: a step is `k` px wide, the view starts `left` px in and `top` px off center. */
  const [cam, setCam] = useState({ k: 0, left: 0, top: 0 })
  const camRef = useRef(cam)
  const whole = useRef(false)
  /** The view sits on the newest step and follows it as the tree grows. */
  const tail = useRef(false)
  /** Steps drawn so far while the tree grows in; Infinity once it has. */
  const [reveal, setReveal] = useState(Infinity)
  const growing = useRef(0)
  const maskId = `tree-${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const [hover, setHover] = useState<Hover | null>(null)
  const drag = useRef<{ x: number, y: number, left: number, top: number, moved: boolean } | null>(null)
  const appliedReset = useRef(reset)
  const started = useRef(false)
  const count = layout.rows.length
  const sizeRef = useRef(size)
  sizeRef.current = size
  const countRef = useRef(count)
  countRef.current = count
  const onViewportRef = useRef(onViewport)
  onViewportRef.current = onViewport

  const lanes = 2 * layout.reach + 1
  // Lines sit as far apart as the height allows, and spread further as the steps widen.
  const gap = Math.max(clamp((size.height - AXIS - 28) / (lanes + 2 * MAIN_ROOM), GAP_MIN, GAP_MAX), clamp(GAP_MIN + (cam.k - 4) * 1.2, GAP_MIN, GAP_ZOOMED))
  const laneY = useCallback((lane: number) => (lane + Math.sign(lane) * MAIN_ROOM) * gap, [gap])
  const overflowY = Math.max(0, ((lanes + 2 * MAIN_ROOM) * gap + 28 - (size.height - AXIS)) / 2)
  const overflowRef = useRef(overflowY)
  overflowRef.current = overflowY
  /** The step width that shows the whole run. */
  const fitK = useCallback(() => clamp((sizeRef.current.width - LEFT - TAG_ROOM) / Math.max(1, countRef.current), 0.02, STEP_MAX), [])
  const apply = useCallback((k: number, left: number, top = camRef.current.top) => {
    const fit = fitK()
    const next = clamp(k, fit, STEP_MAX)
    whole.current = next <= fit * 1.001
    const width = LEFT + countRef.current * next + TAG_ROOM
    const maxLeft = Math.max(0, width - sizeRef.current.width)
    const camera = { k: next, left: clamp(left, 0, maxLeft), top: clamp(top, -overflowRef.current, overflowRef.current) }
    tail.current = !whole.current && maxLeft > 0 && camera.left >= maxLeft - 2
    camRef.current = camera
    setCam(camera)
    onViewportRef.current?.(camera.left, whole.current ? 0 : camera.k)
  }, [fitK])
  const zoomTo = useCallback((k: number, px = sizeRef.current.width / 2) => {
    const c = camRef.current
    const fit = fitK()
    const next = clamp(k, fit, STEP_MAX)
    apply(next, ((c.left + px - LEFT) / (c.k || fit)) * next + LEFT - px)
  }, [apply, fitK])

  useEffect(() => {
    const el = host.current
    if (!el) return
    const observer = new ResizeObserver(() => { if (el.clientWidth && el.clientHeight) setSize({ width: el.clientWidth, height: el.clientHeight }) })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const stopGrowing = useCallback(() => {
    if (!growing.current) return
    cancelAnimationFrame(growing.current)
    growing.current = 0
    setReveal(Infinity)
    setHeld(null)
  }, [])
  /**
   * The tree grows from its first step at a fixed scale while the view follows its tip to the
   * right, at one steady pace from start to end whatever the size of the history.
   */
  const grow = useCallback((scale: number) => {
    const k = clamp(Math.max(fitK(), scale), 0.02, STEP_MAX)
    const steps = latestRef.current.rows.length
    const time = (steps / GROW_RATE) * 1000
    let began = 0
    setHeld(latestRef.current)
    countRef.current = steps
    setReveal(0)
    apply(k, 0)
    const frame = (now: number) => {
      began ||= now
      const done = Math.min(1, (now - began) / time)
      const at = done * steps
      if (done < 1) {
        apply(k, LEFT + at * k - sizeRef.current.width * 0.8)
        setReveal(at)
        growing.current = requestAnimationFrame(frame)
      } else {
        growing.current = 0
        apply(k, Infinity)
        setReveal(Infinity)
        setHeld(null)
      }
    }
    growing.current = requestAnimationFrame(frame)
  }, [apply, fitK])
  useEffect(() => () => cancelAnimationFrame(growing.current), [])
  // A zoomed view stays where it is as checkpoints arrive and the pane resizes; the whole run stays whole, and a view on the newest step follows it.
  useEffect(() => {
    if (!size.width || !count) return
    if (!started.current) {
      if (!ready) return
      started.current = true
      // It grows in every time it opens, at the scale it was last left at.
      if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) apply(viewportRequest?.zoom || fitK(), viewportRequest?.left ?? 0)
      else grow(viewportRequest?.zoom || sizeRef.current.width / FOLLOW_STEPS)
    } else if (growing.current) return
    else if (whole.current) apply(fitK(), 0)
    else apply(camRef.current.k, tail.current ? Infinity : camRef.current.left)
  }, [size.width, size.height, count, apply, fitK, grow, viewportRequest, ready])
  useEffect(() => {
    if (reset === appliedReset.current) return
    appliedReset.current = reset
    stopGrowing()
    apply(fitK(), 0, 0)
  }, [reset, apply, fitK])

  const { k, left, top } = cam
  const X = (slot: number) => LEFT + slot * k
  const cy = AXIS + (size.height - AXIS) / 2 - top
  const laneOf = useCallback((name: string) => layout.byName.get(name)?.lane ?? 0, [layout])

  const focusSlot = focus ? layout.byId.get(focus)?.slot : undefined
  useEffect(() => {
    const c = camRef.current
    if (focusSlot === undefined || !size.width || !c.k) return
    const x = LEFT + focusSlot * c.k - c.left
    if (x < 30 || x > size.width - 30) apply(c.k, LEFT + focusSlot * c.k - size.width / 2)
  }, [focus, focusSlot, size.width, apply])

  useEffect(() => {
    const el = host.current
    if (!el) return
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      stopGrowing()
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1
      const c = camRef.current
      if (!e.ctrlKey && !e.metaKey && Math.abs(e.deltaX) > Math.abs(e.deltaY)) apply(c.k, c.left + e.deltaX * unit)
      else zoomTo(c.k * Math.exp(-e.deltaY * unit * (e.ctrlKey || e.metaKey ? 0.012 : 0.0035)), e.clientX - el.getBoundingClientRect().left)
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [apply, zoomTo, stopGrowing])

  // The Branch in focus keeps its ancestors and descendants lit.
  const lit = useMemo(() => {
    if (!branch || branch === 'main' || !layout.byName.has(branch)) return null
    const set = new Set<string>()
    for (let n: string | undefined = branch; n && n !== 'main' && !set.has(n); n = layout.byName.get(n)?.parent) set.add(n)
    for (let grew = true; grew;) {
      grew = false
      for (const b of layout.branches) if (!set.has(b.name) && set.has(b.parent)) { set.add(b.name); grew = true }
    }
    return set
  }, [branch, layout])

  // Geometry is rebuilt per zoom and per screenful, not per pan step.
  const screen = size.width ? Math.floor(left / size.width) : 0
  const leaf = clamp(Math.min(k / 8, (gap * LEAF_REACH) / 8.6), 0.4, 2)
  const shapes = useMemo(() => {
    if (!k || !size.width) return []
    const from = ((screen - 1) * size.width - LEFT) / k
    const to = ((screen + 3) * size.width - LEFT) / k
    const up = leafShape(-1, leaf)
    const down = leafShape(1, leaf)
    const x = (slot: number) => LEFT + slot * k
    return layout.branches.filter((b) => b.last >= from && b.fork <= to).map((b) => {
      const y = laneY(b.lane)
      const yp = laneY(b.parentLane)
      const xs = x(b.first)
      const xe = Math.max(x(b.last), xs + 3)
      const dy = Math.abs(y - yp)
      const x0 = dy ? Math.min(xs - clamp(dy * 0.45, 16, 44), Math.max(x(b.fork), xs - clamp(dy * 0.9, 16, 72))) : x(b.fork)
      const d = xs - x0
      let leaves = ''
      const merges: number[] = []
      b.rows.forEach((r, i) => {
        if (r.slot < from || r.slot > to) return
        if (r.kind === 'merge') merges.push(x(r.slot))
        else leaves += `M${x(r.slot).toFixed(1)} ${y}${i % 2 ? down : up}`
      })
      return { b, y, xs, xe, sprout: `M${x0.toFixed(1)} ${yp}C${(x0 + d * 0.5).toFixed(1)} ${yp} ${(xs - d * 0.5).toFixed(1)} ${y} ${xs.toFixed(1)} ${y}`, run: `M${xs.toFixed(1)} ${y}H${xe.toFixed(1)}`, leaves, merges, knot: !dy }
    })
  }, [layout, k, laneY, screen, size.width, leaf])
  const links = useMemo(() => {
    if (!k || !size.width) return []
    const from = (screen - 1) * size.width
    const to = (screen + 3) * size.width
    return layout.links.flatMap((l) => {
      const x1 = LEFT + l.from.slot * k
      const x2 = LEFT + l.to.slot * k
      if (x2 < from || x1 > to) return []
      const y1 = laneY(laneOf(l.from.branch))
      const y2 = laneY(laneOf(l.to.branch))
      const d = Math.min(Math.max(1, x2 - x1), clamp(Math.abs(y2 - y1) * 0.8, 14, 70))
      return [{ key: `${l.from.id}:${l.to.id}`, branch: l.from.branch, publish: l.publish, d: `M${x1.toFixed(1)} ${y1}H${(x2 - d).toFixed(1)}C${(x2 - d * 0.3).toFixed(1)} ${y1} ${x2.toFixed(1)} ${y1 + (y2 - y1) * 0.5} ${x2.toFixed(1)} ${y2}` }]
    })
  }, [layout, k, laneY, screen, size.width, laneOf])
  // Name tags: the biggest Branches first, only where a tag covers no line and no other tag.
  const tags = useMemo(() => {
    if (!k) return []
    const spans = layout.branches.map((b) => ({ b, xs: LEFT + Math.max(b.fork, b.first - 3) * k, xe: Math.max(LEFT + b.last * k, LEFT + b.first * k + 3) }))
    const byLane = new Map<number, typeof spans>()
    for (const s of spans) { const list = byLane.get(s.b.lane); if (list) list.push(s); else byLane.set(s.b.lane, [s]) }
    const taken = new Map<number, { x: number, w: number }[]>()
    const result: { b: TreeBranch, x: number, w: number, text: string }[] = []
    for (const s of [...spans].sort((p, q) => q.b.rows.length - p.b.rows.length)) {
      const text = branchLabel(s.b.name, t)
      const w = text.length * 6.4 + 12
      const x = s.xe + 8
      const blocked = byLane.get(s.b.lane)!.some((o) => o !== s && o.xs < x + w + 4 && x < o.xe) || taken.get(s.b.lane)?.some((o) => o.x < x + w + 6 && x < o.x + o.w + 6)
      if (blocked && s.b.name !== branch) continue
      const list = taken.get(s.b.lane)
      if (list) list.push({ x, w }); else taken.set(s.b.lane, [{ x, w }])
      result.push({ b: s.b, x, w, text })
    }
    return result
  }, [layout, k, t, branch])
  const sideOf = useMemo(() => {
    const map = new Map<string, number>()
    for (const b of layout.branches) b.rows.forEach((r, i) => map.set(r.id, i % 2 ? 1 : -1))
    return map
  }, [layout])

  /** What is under the pointer: a leaf, a Layer, a bud, else a Branch's line. */
  const pick = (px: number, py: number): Hover | null => {
    if (!k) return null
    const at = (px + left - LEFT) / k
    const reachSteps = Math.min(200, Math.max(1, Math.ceil(10 / k)))
    let best: Hover | null = null
    let bestD = 11
    for (let s = Math.max(0, Math.floor(at - reachSteps)); s <= Math.min(count - 1, Math.ceil(at + reachSteps)); s++) {
      const r = layout.rows[s]
      const x = X(s) - left
      const y = cy + laneY(laneOf(r.branch))
      const names = layout.buds.get(r.id)
      if (names && Math.hypot(px - x, py - (y - 9)) < 7) return { branch: names[0], names, x, y: y - 9 }
      const side = r.kind === 'checkpoint' ? (sideOf.get(r.id) ?? -1) * 5 * leaf : 0
      const d = Math.min(Math.hypot(px - x, py - y), Math.hypot(px - x - 2 * leaf, py - y - side))
      if (d < bestD) { bestD = d; best = { row: r, branch: r.branch, x, y } }
    }
    if (best) return best
    const off = (py - cy) / gap
    const lane = Math.sign(off) * Math.round(Math.abs(off) - MAIN_ROOM)
    if (!lane || Math.abs(py - (cy + laneY(lane))) > 6) return null
    const b = layout.branches.find((o) => o.lane === lane && at >= o.first - 0.5 && at <= o.last + 0.5)
    return b ? { branch: b.name, x: px, y: cy + laneY(lane) } : null
  }
  const local = (e: { clientX: number, clientY: number }) => {
    const r = host.current!.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top] as const
  }
  const startDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button || (e.target as Element).closest('[data-branch-tag], button')) return
    e.preventDefault()
    stopGrowing()
    host.current!.focus({ preventScroll: true })
    drag.current = { x: e.clientX, y: e.clientY, left: camRef.current.left, top: camRef.current.top, moved: false }
    host.current!.setPointerCapture(e.pointerId)
  }
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (d) {
      if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 4) d.moved = true
      if (d.moved) { setHover(null); apply(camRef.current.k, d.left - (e.clientX - d.x), d.top - (e.clientY - d.y)) }
      return
    }
    if ((e.target as Element).closest('[data-branch-tag], button')) return setHover(null)
    const next = pick(...local(e))
    setHover((h) => (h?.row === next?.row && h?.branch === next?.branch && !next?.names === !h?.names ? h : next))
  }
  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    drag.current = null
    if (!d || d.moved) return
    const hit = pick(...local(e))
    if (hit?.row) onSelect(hit.row.id, hit.row.branch)
    else if (hit) onBranch(hit.branch)
  }
  /** Left and Right walk the selected Branch a checkpoint at a time. */
  const step = (by: number): boolean => {
    const row = selected ? layout.byId.get(selected) : undefined
    const rows = row ? (row.branch === 'main' ? layout.layers : layout.byName.get(row.branch)?.rows) : undefined
    const next = rows?.[rows.indexOf(row!) + by]
    if (next) onSelect(next.id, next.branch)
    return !!next
  }

  const first = Math.max(0, Math.floor((left - LEFT) / (k || 1)))
  const last = Math.min(count - 1, Math.ceil((left + size.width - LEFT) / (k || 1)))
  const tick = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000].find((n) => n * k >= 104) ?? 25000
  const ticks: number[] = []
  for (let n = Math.ceil(first / tick) * tick; n <= last; n += tick) ticks.push(n)
  const clock = (row: TreeRow | undefined) => {
    const at = toMs(row?.commit?.at ?? row?.commit?.sourceTime)
    return at == null ? '' : new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  const dim = (name: string) => !!lit && !lit.has(name)
  const selectedRow = selected ? layout.byId.get(selected) : undefined
  const mainEnd = layout.layers.at(-1)?.slot ?? 0
  let lastLayerLabel = -Infinity
  const inView = Math.min(count, Math.round(size.width / (k || 1)))
  const tipBranch = hover ? layout.byName.get(hover.branch) : undefined

  const controls = (
    <div className={css.mapControls} role="group" aria-label={t('files_zoomHistory')}>
        <button type="button" onClick={() => { stopGrowing(); zoomTo(k / 1.8) }} aria-label={t('files_zoomOut')}>
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 8h12" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
        </button>
        <span className={css.zoomValue}>{t('files_inView', { count: inView.toLocaleString() })}</span>
        <button type="button" onClick={() => { stopGrowing(); zoomTo(k * 1.8) }} aria-label={t('files_zoomIn')}><IconPlusOutlineRegular size={14} /></button>
        <button type="button" onClick={() => { stopGrowing(); apply(fitK(), 0, 0) }} aria-label={t('files_zoomFit')} title={t('files_zoomFit')}><IconFullscreenOutlineRegular size={14} /></button>
      </div>
  )
  return (
    <div className={css.map}>
      {controlsHost ? createPortal(controls, controlsHost) : controls}
      <div className={clsx(css.graph, hover && css.pointing)} ref={host} tabIndex={0} aria-label={t('files_graphAria')}
        onPointerDown={startDrag} onPointerMove={move} onPointerUp={endDrag} onPointerCancel={() => { drag.current = null }} onPointerLeave={() => setHover(null)}
        onKeyDown={(e) => {
          if ((e.target as Element).closest('[data-branch-tag]')) return
          stopGrowing()
          if (e.key === '+' || e.key === '=') zoomTo(k * 1.5)
          else if (e.key === '-') zoomTo(k / 1.5)
          else if (e.key === '0') apply(fitK(), 0, 0)
          else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { if (!step(e.key === 'ArrowRight' ? 1 : -1)) apply(k, left + (e.key === 'ArrowRight' ? 120 : -120)) }
          else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') apply(k, left, top + (e.key === 'ArrowDown' ? 60 : -60))
          else return
          e.preventDefault()
        }}>
        <svg className={css.canvas} width={size.width} height={size.height}>
          <g transform={`translate(${-left},0)`}>
            {ticks.map((n) => (
              <g key={n}>
                <line className={css.tickLine} x1={X(n)} x2={X(n)} y1={AXIS} y2={size.height} />
                <text className={css.tickLabel} x={X(n)} y={AXIS / 2 + 4} textAnchor="middle">#{n.toLocaleString()}{clock(layout.rows[n]) ? ` · ${clock(layout.rows[n])}` : ''}</text>
              </g>
            ))}
          </g>
          {reveal !== Infinity ? (
            // The growing tip fades in over a short stretch instead of being cut off square.
            <defs>
              <linearGradient id={`${maskId}-fade`} gradientUnits="userSpaceOnUse" x1={X(reveal) - 56} x2={X(reveal)} y1={0} y2={0}>
                <stop offset="0" stopColor="#fff" /><stop offset="1" stopColor="#000" />
              </linearGradient>
              <mask id={maskId} maskUnits="userSpaceOnUse" x={left - 10} y={-size.height} width={size.width + 20} height={size.height * 2}>
                <rect x={left - 10} y={-size.height} width={Math.max(0, X(reveal) - left + 10)} height={size.height * 2} fill={`url(#${maskId}-fade)`} />
              </mask>
            </defs>
          ) : null}
          <g transform={`translate(${-left},${cy})`} mask={reveal !== Infinity ? `url(#${maskId})` : undefined}>
            {links.map((l) => <path key={l.key} className={clsx(l.publish ? css.publishPath : css.mergePath, lit && (dim(l.branch) ? css.dimmed : css.lit))} style={{ '--bough': branchColor(l.branch) } as CSSProperties} d={l.d} />)}
            {[false, true].map((live) => shapes.filter((s) => s.b.live === live).map((s) => (
              <g key={s.b.name} data-branch={s.b.name} style={{ '--bough': branchColor(s.b.name) } as CSSProperties} className={clsx(css.bough, !s.b.live && css.dead, dim(s.b.name) && css.dimmed, (hover?.branch === s.b.name || branch === s.b.name) && css.hot)}>
                <path className={s.b.partial ? css.unloadedPath : css.forkPath} d={s.sprout} />
                <path className={css.branchPath} d={s.run} />
                {s.leaves ? <path className={css.leaves} d={s.leaves} /> : null}
                {s.knot ? <circle className={css.knot} cx={s.xs} cy={s.y} r={clamp(k, 2, 3)} /> : null}
                {s.merges.map((x) => <circle key={x} className={css.mergeRing} cx={x} cy={s.y} r={clamp(k * 1.2, 2.2, 4.5)} />)}
              </g>
            )))}
            <path className={css.mainLine} d={`M${X(0)} 0H${X(mainEnd)}`} />
            {layout.layers.filter((r) => r.slot >= first - 20 && r.slot <= last + 20).map((r) => {
              const labelled = r.n !== undefined && X(r.slot) - lastLayerLabel > 30
              if (labelled) lastLayerLabel = X(r.slot)
              return (
                <g key={r.id} data-history-node={r.id} data-kind="layer" transform={`translate(${X(r.slot)},0)`}>
                  <rect className={css.layerBand} x={-4} y={-11} width={8} height={22} rx={4} />
                  {labelled ? <text className={css.layerLabel} y={24} textAnchor="middle">L{r.n}</text> : null}
                </g>
              )
            })}
            {[...layout.buds.entries()].map(([id, names]) => {
              const r = layout.byId.get(id)!
              return r.slot < first - 20 || r.slot > last + 20 ? null : <circle key={id} className={css.bud} style={{ '--bough': branchColor(names[0]) } as CSSProperties} cx={X(r.slot)} cy={laneY(laneOf(r.branch)) - 9} r={3} />
            })}
            {tags.map(({ b, x, w, text }) => {
              if (x - left > size.width || x + w - left < 0) return null
              return (
                <g key={b.name} data-branch-tag={b.name} role="button" tabIndex={0} aria-label={t('files_openBranch', { name: text })}
                  className={clsx(css.branchTag, !b.live && css.dead, dim(b.name) && css.dimmed)} style={{ '--bough': branchColor(b.name) } as CSSProperties}
                  transform={`translate(${x},${laneY(b.lane)})`} onClick={() => onBranch(b.name)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onBranch(b.name) } }}>
                  <title>{text === b.name ? t('files_openBranch', { name: text }) : `${t('files_openBranch', { name: text })}\n${b.name}`}</title>
                  <rect x={0} y={-8} width={w} height={16} rx={3} />
                  <text x={6} y={3.5}>{text}</text>
                </g>
              )
            })}
            {selectedRow ? <circle className={css.selectedRing} cx={X(selectedRow.slot)} cy={laneY(laneOf(selectedRow.branch))} r={9} /> : null}
          </g>
        </svg>
        {hover ? (
          <div className={css.tip} role="status" style={{ left: clamp(hover.x + 14, 4, Math.max(4, size.width - 330)), top: hover.y + 18 > size.height - 70 ? hover.y - 62 : hover.y + 18 }}>
            {hover.names ? <span>{t('files_emptyBranches', { count: hover.names.length, names: hover.names.map((n) => branchLabel(n, t)).join(', ') })}</span>
              : hover.row ? (
                <>
                  <b>{branchLabel(hover.row.branch, t)}</b> <span>#{hover.row.slot.toLocaleString()}{clock(hover.row) ? ` · ${clock(hover.row)}` : ''} · {shortId(hover.row.id)}</span>
                  <div>{hover.row.commit?.message || t(hover.row.kind === 'layer' ? 'files_layerOnMain' : hover.row.kind === 'merge' ? 'files_merge' : 'files_checkpoint')}</div>
                </>
              ) : (
                <>
                  <b>{branchLabel(hover.branch, t)}</b> <span>{t('files_checkpointCount', { count: tipBranch?.rows.length ?? 0 })}</span>
                  {tipBranch && !tipBranch.live ? <div>{t('files_neverReachedMain')}</div> : tipBranch?.partial ? <div>{t('files_earlierUnread')}</div> : null}
                </>
              )}
          </div>
        ) : null}
      </div>
      {inspector}
    </div>
  )
}
