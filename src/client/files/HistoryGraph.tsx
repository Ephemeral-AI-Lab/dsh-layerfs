/**
 * The history tree canvas, ported from LayerFS Connect's
 * `components/history/HistoryGraph.tsx` onto the shared file views' seams:
 * CSS Modules, DSW tokens and the files locale. Branches grow outward from
 * a centered main on a dot-grid canvas the camera pans and zooms freely; an
 * overview strip covers dense histories.
 */
import { IconFullscreenOutlineRegular, IconPlusOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import clsx from 'clsx'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react'
import { bendOf, layoutNodes, type Fork, type GraphNode, type HistoryBranch } from './graph-model.ts'
import { branchLabel } from './labels.ts'
import type { Translate } from './types.ts'
import css from './History.module.css'

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n))

/** One hue per lane, resolved from semantic state colors; main rides the label color. */
const BOUGHS = [
  'var(--dsw-alias-state-business-primary)',
  'var(--dsw-alias-state-done-primary)',
  'var(--dsw-alias-state-warn-primary)',
  'color-mix(in srgb, var(--dsw-alias-state-success-primary) 55%, var(--dsw-alias-state-business-primary))',
  'var(--dsw-alias-state-error-primary)',
  'var(--dsw-alias-state-success-primary)',
]
export const branchColor = (name: string): string => {
  let hash = 0
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) | 0
  return name === 'main' ? 'var(--dsw-alias-label-secondary)' : BOUGHS[Math.abs(hash) % BOUGHS.length]
}

type Point = ReturnType<typeof layoutNodes>['positioned'][number]

export interface HistoryGraphProps {
  nodes: GraphNode[]
  lanes: ReadonlyMap<string, number>
  branches: readonly HistoryBranch[]
  familyCounts: ReadonlyMap<string, number>
  selected: string | null
  /** Pans to this node when it changes (e.g. a deep-linked Commit). */
  focus?: string | null | undefined
  onSelect: (id: string, branch: string) => void
  onBranch: (branch: string) => void
  onToggleFamily: (name: string) => void
  collapsed: ReadonlySet<string>
  expanded: boolean
  onCollapse: () => void
  /** Bumps to reset zoom and re-center on now. */
  reset: number
  inspector?: ReactNode
  onViewport?: ((top: number, left: number) => void) | undefined
  viewportRequest?: { left: number, top: number, token: number } | null | undefined
  t: Translate
}

/** Dot-grid pitch in layout units; labels stop growing below this zoom. */
const GRID = 24
const LABEL_FLOOR = 0.75

export function HistoryGraph({ nodes, lanes, branches, selected, focus, onSelect, onBranch, onToggleFamily, collapsed, familyCounts, expanded, onCollapse, reset, inspector, onViewport, viewportRequest, t }: HistoryGraphProps): ReactNode {
  const host = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  /** The canvas camera: screen = layout × zoom − (left, top). */
  const [view, setView] = useState({ left: 0, top: 0, zoom: 1 })
  const drag = useRef<{ x: number, y: number, left: number, top: number, moved: boolean } | null>(null)
  const skipClick = useRef(false)
  const first = useRef(true)
  const appliedReset = useRef(reset)
  const tagWidth = useCallback((name: string) => branchLabel(name, t).length * 6.3 + 16, [t])
  const layout = useMemo(() => layoutNodes(nodes, lanes, (name) => 24 + tagWidth(name) + (familyCounts.get(name) ? 40 : 8)), [nodes, lanes, familyCounts, tagWidth])
  const zoom = view.zoom
  const viewRef = useRef(view)
  const sizeRef = useRef(size)
  sizeRef.current = size
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  const onViewportRef = useRef(onViewport)
  onViewportRef.current = onViewport
  const tagPoints = useMemo(() => {
    const result = new Map<string, Point>()
    for (const n of layout.positioned) if (!result.has(n.branch) || n.x > result.get(n.branch)!.x) result.set(n.branch, n)
    return result
  }, [layout])
  const now = Math.max(90, ...layout.positioned.map((n) => n.x)) + 38
  const main = tagPoints.get('main')
  const mainEnd = main?.x ?? 60
  /** Moves the camera, keeping some of the tree on screen. */
  const apply = useCallback((left: number, top: number, next = viewRef.current.zoom) => {
    const { width, height } = sizeRef.current
    const l = layoutRef.current
    const camera = {
      zoom: next,
      left: clamp(left, -width * 0.6, Math.max(-width * 0.6, l.width * next - width * 0.4)),
      top: clamp(top, -height * 0.6, Math.max(-height * 0.6, l.height * next - height * 0.4)),
    }
    viewRef.current = camera
    setView(camera)
    onViewportRef.current?.(camera.top, camera.left)
  }, [])
  const pan = useCallback((left: number, top: number) => apply(left, top), [apply])
  /** Newest growth in view with main on the middle line; the whole tree when it fits at half size. */
  const home = useCallback((fitAll = false) => {
    const { width, height } = sizeRef.current
    const l = layoutRef.current
    const k = clamp(Math.min(width / l.width, height / l.height), fitAll ? 0.2 : 0.5, 1)
    apply(l.width * k <= width ? (l.width * k - width) / 2 : l.width * k - width, l.center * k - height / 2, k)
  }, [apply])
  useEffect(() => {
    const el = host.current
    if (!el) return
    const observer = new ResizeObserver(() => {
      if (el.clientWidth && el.clientHeight) setSize({ width: el.clientWidth, height: el.clientHeight })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!nodes.length || !size.width || !first.current) return
    first.current = false
    if (viewportRequest) apply(viewportRequest.left, viewportRequest.top)
    else home()
  }, [nodes.length, size.width, home, apply, viewportRequest])
  useEffect(() => {
    if (!focus || !size.width) return
    const point = layout.points.get(focus)
    if (!point) return
    const v = viewRef.current
    const x = point.x * v.zoom
    const y = point.y * v.zoom
    const left = x < v.left + 25 || x > v.left + size.width - 25 ? x - size.width / 2 : v.left
    const top = y < v.top + 25 ? y - 25 : y > v.top + size.height - 25 ? y - size.height + 25 : v.top
    pan(left, top)
  }, [focus, layout, pan, size.width, size.height])
  useEffect(() => {
    if (reset === appliedReset.current) return
    appliedReset.current = reset
    home()
  }, [reset, home])
  // Main stays on the middle line as lanes come and go.
  useEffect(() => {
    if (!first.current && !focus) pan(viewRef.current.left, layout.center * viewRef.current.zoom - sizeRef.current.height / 2)
  }, [layout.center, size.height, pan, focus])
  const changeZoom = useCallback((next: number, px?: number, py?: number) => {
    const v = viewRef.current
    const value = clamp(next, 0.2, 3)
    const x = px ?? sizeRef.current.width / 2
    const y = py ?? sizeRef.current.height / 2
    apply((v.left + x) / v.zoom * value - x, (v.top + y) / v.zoom * value - y, value)
  }, [apply])
  useEffect(() => {
    const el = host.current
    if (!el) return
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1
      const v = viewRef.current
      if (e.ctrlKey || e.metaKey) {
        const r = el.getBoundingClientRect()
        changeZoom(v.zoom * Math.exp(-e.deltaY * unit * 0.01), e.clientX - r.left, e.clientY - r.top)
      } else apply(v.left + e.deltaX * unit, v.top + e.deltaY * unit)
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [changeZoom, apply])
  const startDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button || (e.target as Element).closest('[data-history-node], [data-branch-tag], button')) return
    e.preventDefault()
    drag.current = { x: e.clientX, y: e.clientY, left: viewRef.current.left, top: viewRef.current.top, moved: false }
    host.current!.setPointerCapture(e.pointerId)
  }
  const moveDrag = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 4) d.moved = true
    if (d.moved) pan(d.left - (e.clientX - d.x), d.top - (e.clientY - d.y))
  }
  const endDrag = () => {
    skipClick.current = drag.current?.moved ?? false
    drag.current = null
  }
  const byBranch = new Map<string, Point[]>()
  for (const n of layout.positioned) {
    const list = byBranch.get(n.branch)
    if (list) list.push(n)
    else byBranch.set(n.branch, [n])
  }
  for (const list of byBranch.values()) list.sort((a, b) => a.x - b.x)
  /** A sprout runs along its parent from the fork point (main's own line carries that stretch), leaves slanting, curves into its lane (about 45°), then runs to the knot. */
  const sprout = (from: Point, fork: Fork, y1: number) => {
    const { leave: x0, bend: d, knot } = fork
    const y0 = from.y
    const dy = y1 - y0
    return `${from.branch === 'main' || x0 <= from.x ? `M${x0},${y0}` : `M${from.x},${y0} H${x0}`} C${x0 + d * 0.45},${y0 + dy * 0.3} ${x0 + d * 0.55},${y1} ${x0 + d},${y1} H${Math.max(knot, x0 + d)}`
  }
  /** A merge or publish runs along its source's lane, then curves into the target where it lands. */
  const rise = (a: Point, b: Point) => {
    const ax = a.end
    if (a.y === b.y) return `M${ax},${a.y} H${b.x}`
    const d = bendOf(b.y - a.y, Math.max(1, b.x - ax))
    return `M${ax},${a.y} H${b.x - d} C${b.x - d * 0.35},${a.y} ${b.x},${a.y + (b.y - a.y) * 0.45} ${b.x},${b.y}`
  }
  /** The branch that published a Layer, for its band's colour. */
  const publisher = (n: Point) => layout.points.get(n.source ?? '')?.branch ?? n.commits[0]?.sourceBranch ?? 'main'
  const left = view.left / zoom
  const top = view.top / zoom
  const right = (view.left + size.width) / zoom
  const bottom = (view.top + size.height) / zoom
  const visible = layout.positioned.filter((n) => n.x > left - 50 / zoom && n.x < right + 50 / zoom && n.y > top - 40 / zoom && n.y < bottom + 40 / zoom)
  const topologyPins = new Set(branches.flatMap((b) => [b.head, b.forkedFrom]).filter((id): id is string => !!id))
  const bins = new Set<string>()
  const drawn = visible.filter((n) => {
    const essential = topologyPins.has(n.id) || n.commits.some((c) => topologyPins.has(c.id)) || n.kind === 'layer' || n.kind === 'group' || n.second || n.id === selected || n.commits.some((c) => c.id === selected) || tagPoints.get(n.branch)?.id === n.id
    const bin = `${n.branch}:${Math.floor(n.x * zoom / 12)}`
    if (!essential && bins.has(bin)) return false
    bins.add(bin)
    return true
  })
  const label = 1 / Math.max(zoom, LABEL_FLOOR)
  const overview = Array.from({ length: 90 }, () => 0)
  for (const n of layout.positioned) overview[Math.min(89, Math.floor(n.x / layout.width * 90))] += Math.max(1, n.commits.length)
  const peak = Math.max(1, ...overview)
  const miniMove = (e: PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    pan(clamp((e.clientX - rect.left) / rect.width, 0, 1) * layout.width * zoom - size.width / 2, view.top)
    if (e.buttons) e.currentTarget.setPointerCapture(e.pointerId)
  }
  const grid = { '--grid-size': `${GRID * zoom}px`, '--grid-x': `${-view.left}px`, '--grid-y': `${-view.top}px` } as CSSProperties
  return (
    <div className={css.map}>
      <div className={css.mapControls} role="group" aria-label={t('files_zoomHistory')}>
        {expanded ? <button type="button" onClick={onCollapse}>{t('files_collapseGroups')}</button> : null}
        <button type="button" onClick={() => changeZoom(zoom / 1.25)} aria-label={t('files_zoomOut')}>
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 8h12" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
        </button>
        <button type="button" className={css.zoomValue} onClick={() => changeZoom(1)} title={t('files_zoomReset')}>{Math.round(zoom * 100)}%</button>
        <button type="button" onClick={() => changeZoom(zoom * 1.25)} aria-label={t('files_zoomIn')}><IconPlusOutlineRegular size={14} /></button>
        <button type="button" onClick={() => home(true)} aria-label={t('files_zoomFit')}><IconFullscreenOutlineRegular size={14} /></button>
      </div>
      <div className={css.graph} ref={host} tabIndex={0} aria-label={t('files_graphAria')} style={grid} onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}
        onKeyDown={(e) => {
          if ((e.target as Element).closest('[data-history-node], [data-branch-tag]')) return
          const v = viewRef.current
          if (e.key === '+' || e.key === '=') changeZoom(zoom * 1.25)
          else if (e.key === '-') changeZoom(zoom / 1.25)
          else if (e.key === '0') changeZoom(1)
          else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') pan(v.left + (e.key === 'ArrowRight' ? 80 : -80), v.top)
          else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') pan(v.left, v.top + (e.key === 'ArrowDown' ? 80 : -80))
          else return
          e.preventDefault()
        }}>
        <svg className={css.canvas} width={size.width} height={size.height}>
          <g transform={`translate(${-view.left},${-view.top}) scale(${zoom})`}>
            <rect className={css.mainBand} x={left - 20} y={layout.center - 19 / zoom} width={right - left + 40} height={38 / zoom} />
            {/* A faint guide across the plot at each Layer. */}
            {layout.positioned.filter((n) => n.branch === 'main' && n.x > left - 10 && n.x < right + 10).map((n) => <line key={`guide:${n.id}`} className={css.layerGuide} x1={n.x} x2={n.x} y1={top} y2={bottom} />)}
            <path className={css.mainLine} d={`M20 ${layout.center} H${mainEnd}`} />
            <path className={css.mainFuture} d={`M${mainEnd + 7} ${layout.center} H${now}`} />
            <line className={css.nowLine} x1={now} x2={now} y1={top} y2={bottom} />
            <text className={css.nowLabel} x={now + 5 / zoom} y={top + 16 / zoom} style={{ fontSize: 10 / zoom }}>{t('files_now')}</text>
            {[...byBranch.entries()].map(([name, ns]) => {
              if (name === 'main') return null
              const branch = branches.find((b) => b.name === name)
              const firstNode = ns[0]
              const head = ns.at(-1)!
              const fork = layout.forks.get(name)
              const origin = layout.points.get(firstNode.parent ?? branch?.forkedFrom ?? '')
              // Earlier checkpoints unread: a dashed sprout still ties the run to its fork point.
              const anchor = origin ? undefined : layout.points.get(firstNode.anchor ?? '')
              const from = origin && origin.branch !== name ? origin : anchor && anchor.branch !== name ? anchor : undefined
              const knot = fork?.knot ?? firstNode.x
              return (
                <g key={name} style={{ '--bough': branchColor(name) } as CSSProperties} className={clsx(css.bough, selected && name !== layout.points.get(selected)?.branch && css.dimmed)}>
                  {from && fork ? <path className={from === origin ? css.forkPath : css.unloadedPath} d={sprout(from, fork, head.y)} />
                    : <path className={css.unloadedPath} d={`M${Math.max(20, knot - 35)},${head.y} H${knot}`} />}
                  <path className={css.branchPath} d={`M${knot},${head.y} H${head.x}`} />
                  {/* The knot where the branch begins. */}
                  <circle className={css.knot} cx={knot} cy={head.y} r={3 / zoom} />
                </g>
              )
            })}
            {layout.positioned.filter((n) => n.second || n.source).map((n) => {
              const from = layout.points.get(n.source ?? n.second ?? '')
              if (!from) return null
              return <path key={`merge:${n.id}`} className={n.kind === 'layer' ? css.publishPath : css.mergePath} style={{ '--bough': branchColor(from.branch) } as CSSProperties} d={rise(from, n)} />
            })}
            {drawn.map((n) => {
              const active = selected === n.id || n.commits.some((c) => c.id === selected)
              const name = `${branchLabel(n.branch, t)}: ${n.label}${n.kind === 'group' ? '' : ` · ${n.id}`}`
              return (
                <g key={n.id} data-history-node={n.id} data-kind={n.kind} role="button" tabIndex={0} aria-label={name}
                  className={clsx(css.node, active && css.selected)} style={{ '--bough': branchColor(n.branch) } as CSSProperties}
                  transform={`translate(${n.x},${n.y}) scale(${1 / zoom})`}
                  onClick={() => { if (!skipClick.current) onSelect(n.id, n.branch); skipClick.current = false }}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(n.id, n.branch) } }}>
                  <title>{name}</title>
                  <circle className={css.nodeHit} r={12} />
                  {active ? <circle className={css.selectedRing} r={12} /> : null}
                  {n.kind === 'layer' ? <rect className={css.layerBand} style={{ '--band': branchColor(publisher(n)) } as CSSProperties} x={-2.5} y={-7} width={5} height={14} rx={1.5} />
                    : n.second ? (
                      <>
                        <circle className={css.mergeRing} r={6} />
                        <circle className={css.mergeHeart} style={{ '--heart': branchColor(layout.points.get(n.second)?.branch ?? n.branch) } as CSSProperties} r={2.6} />
                      </>
                    )
                    : n.kind === 'group' ? (
                      <>
                        {[-5, 0, 5].map((x) => <circle className={clsx(css.commitDot, css.groupDot)} key={x} cx={x} r={3} />)}
                        <text className={css.groupCount} x={0} y={-12} textAnchor="middle">{n.commits.length}</text>
                      </>
                    ) : <circle className={css.commitDot} r={3.5} />}
                </g>
              )
            })}
            {[...tagPoints.entries()].map(([name, head]) => {
              const text = branchLabel(name, t)
              const width = tagWidth(name)
              const children = familyCounts.get(name) ?? 0
              const tip = children ? t('files_branchTagForks', { name: text, count: children }) : t('files_openBranch', { name: text })
              return (
                <g key={name} data-branch-tag={name} role="button" tabIndex={0} aria-label={t('files_openBranch', { name: text })}
                  className={clsx(css.branchTag, name === 'main' && css.isMain)} style={{ '--bough': branchColor(name) } as CSSProperties}
                  transform={`translate(${head.x + 24 * label},${head.y}) scale(${label})`}
                  onClick={() => onBranch(name)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onBranch(name) } }}>
                  <title>{text === name ? tip : `${tip}\n${name}`}</title>
                  <rect x={0} y={-9} width={width} height={18} rx={2} />
                  <text x={8} y={3.5}>{text}</text>
                  {children > 0 && name !== 'main' ? (
                    <g className={css.familyTag} role="button" tabIndex={0} aria-expanded={!collapsed.has(name)}
                      aria-label={collapsed.has(name) ? t('files_expandFamily', { name: text }) : t('files_collapseFamily', { name: text })}
                      onClick={(e) => { e.stopPropagation(); onToggleFamily(name) }}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onToggleFamily(name) } }}
                      transform={`translate(${width + 8},0)`}>
                      <rect y={-9} width={24} height={18} rx={2} />
                      <text x={5} y={3.5}>{collapsed.has(name) ? '+' : '−'}{children}</text>
                    </g>
                  ) : null}
                </g>
              )
            })}
          </g>
        </svg>
      </div>
      {inspector}
      <div className={css.overview}>
        <button type="button" className={css.nowButton} onClick={() => home()}>
          {t('files_overview')}<span>{t('files_now')} ↗</span>
        </button>
        <div className={css.overviewStrip} role="slider" tabIndex={0} aria-label={t('files_historyOverview')} aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={Math.round(clamp(view.left / Math.max(1, layout.width * zoom - size.width), 0, 1) * 100)}
          onPointerDown={miniMove} onPointerMove={(e) => { if (e.buttons) miniMove(e) }}
          onKeyDown={(e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); pan(view.left + (e.key === 'ArrowRight' ? 1 : -1) * size.width / 3, view.top) } }}>
          <svg viewBox="0 0 900 38" preserveAspectRatio="none" aria-hidden="true">
            {overview.map((v, i) => v > 0 && <rect className={css.overviewBar} key={i} x={i * 10 + 1} y={36 - 28 * Math.sqrt(v / peak)} width={8} height={28 * Math.sqrt(v / peak)} />)}
            {layout.positioned.filter((n) => n.kind === 'layer').map((n) => <rect key={n.id} className={css.overviewLayer} x={n.x / layout.width * 900} y={1} width={3} height={8} />)}
          </svg>
          <div className={css.overviewWindow} style={{ left: `${clamp(view.left / (layout.width * zoom), 0, 1) * 100}%`, width: `${Math.min(100, size.width / (layout.width * zoom) * 100)}%` }} />
        </div>
      </div>
    </div>
  )
}
