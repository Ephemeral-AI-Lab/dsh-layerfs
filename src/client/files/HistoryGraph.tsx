/**
 * The horizontal history topology canvas, ported from LayerFS Connect's
 * `components/history/HistoryGraph.tsx` onto the shared file views' seams:
 * CSS Modules, DSW tokens and the files locale. Distinct branch lanes sit on
 * both sides of a centered main; an overview strip covers dense histories.
 */
import { IconFullscreenOutlineRegular, IconPlusOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import clsx from 'clsx'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react'
import { layoutNodes, type GraphNode, type HistoryBranch } from './graph-model.ts'
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

export function HistoryGraph({ nodes, lanes, branches, selected, focus, onSelect, onBranch, onToggleFamily, collapsed, familyCounts, expanded, onCollapse, reset, inspector, onViewport, viewportRequest, t }: HistoryGraphProps): ReactNode {
  const host = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 1000, height: 500 })
  const [zoom, setZoom] = useState(1)
  const [viewport, setViewport] = useState({ left: 0, top: 0 })
  const drag = useRef<{ x: number, y: number, left: number, top: number, moved: boolean } | null>(null)
  const skipClick = useRef(false)
  const first = useRef(true)
  const appliedReset = useRef(reset)
  const layout = useMemo(() => layoutNodes(nodes, lanes, size.width, size.height), [nodes, lanes, size])
  const zRef = useRef(zoom)
  zRef.current = zoom
  const tagPoints = useMemo(() => {
    const result = new Map<string, Point>()
    for (const n of layout.positioned) if (!result.has(n.branch) || n.x > result.get(n.branch)!.x) result.set(n.branch, n)
    return result
  }, [layout])
  const now = Math.max(90, ...layout.positioned.map((n) => n.x)) + 38
  const main = tagPoints.get('main')
  const mainEnd = main?.x ?? 60
  const pan = useCallback((left: number, top: number) => {
    const el = host.current
    if (!el) return
    el.scrollLeft = left
    el.scrollTop = top
    setViewport({ left: el.scrollLeft, top: el.scrollTop })
  }, [])
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
    const el = host.current
    if (!el || !nodes.length) return
    if (first.current) {
      first.current = false
      pan(Math.max(0, layout.width - size.width), layout.center - size.height / 2)
    }
  }, [nodes.length, layout, size, pan])
  useEffect(() => {
    const el = host.current
    if (!el || !focus) return
    const point = layout.points.get(focus)
    if (point) {
      const x = point.x * zoom
      const y = point.y * zoom
      const left = x < el.scrollLeft + 25 || x > el.scrollLeft + size.width - 25 ? x - size.width / 2 : el.scrollLeft
      const top = y < el.scrollTop + 25 ? y - 25 : y > el.scrollTop + size.height - 25 ? y - size.height + 25 : el.scrollTop
      pan(left, top)
    }
  }, [focus, layout.width, layout.center, pan, size.width, size.height, zoom])
  useEffect(() => {
    if (viewportRequest) pan(viewportRequest.left, viewportRequest.top)
  }, [viewportRequest, pan])
  useEffect(() => {
    if (reset !== appliedReset.current) setZoom(1)
  }, [reset])
  useEffect(() => {
    if (reset === appliedReset.current || zoom !== 1) return
    pan(Math.max(0, layout.width - size.width), layout.center - size.height / 2)
    appliedReset.current = reset
  }, [reset, zoom, layout.width, layout.center, size.width, size.height, pan])
  const changeZoom = useCallback((next: number, px?: number, py?: number) => {
    const el = host.current
    if (!el) return
    const old = zRef.current
    const value = clamp(next, 0.25, 3)
    const x = px ?? el.clientWidth / 2
    const y = py ?? el.clientHeight / 2
    const left = (el.scrollLeft + x) / old * value - x
    const top = (el.scrollTop + y) / old * value - y
    setZoom(value)
    requestAnimationFrame(() => pan(left, top))
  }, [pan])
  useEffect(() => {
    if (!first.current && !focus) pan(host.current?.scrollLeft ?? 0, layout.center * zRef.current - size.height / 2)
  }, [layout.center, size.height, pan, focus])
  const fit = () => changeZoom(Math.min(size.width / layout.width, size.height / layout.height, 1))
  useEffect(() => {
    const el = host.current
    if (!el) return
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const r = el.getBoundingClientRect()
      changeZoom(zRef.current * Math.exp(-e.deltaY * 0.008), e.clientX - r.left, e.clientY - r.top)
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [changeZoom])
  const startDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button || (e.target as Element).closest('[data-history-node], [data-branch-tag], button')) return
    e.preventDefault()
    const el = host.current!
    drag.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop, moved: false }
    el.setPointerCapture(e.pointerId)
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
  for (const n of layout.positioned) byBranch.set(n.branch, [...(byBranch.get(n.branch) ?? []), n])
  const curve = (a: Point, b: Point) => {
    const bend = Math.min(Math.max(24, Math.abs(b.y - a.y) * 1.1), Math.max(16, b.x - a.x))
    return `M${a.x},${a.y} C${a.x + bend * 0.45},${a.y} ${a.x + bend * 0.55},${b.y} ${a.x + bend},${b.y} H${b.x}`
  }
  const graft = (a: Point, b: Point) => {
    const bend = Math.min(Math.max(24, Math.abs(b.y - a.y) * 1.1), Math.max(16, b.x - a.x))
    const start = Math.max(a.x, b.x - bend)
    return `M${a.x},${a.y} H${start} C${start + bend * 0.45},${a.y} ${start + bend * 0.55},${b.y} ${b.x},${b.y}`
  }
  const visible = layout.positioned.filter((n) => n.x * zoom > viewport.left - 50 && n.x * zoom < viewport.left + size.width + 50 && n.y * zoom > viewport.top - 40 && n.y * zoom < viewport.top + size.height + 40)
  const topologyPins = new Set(branches.flatMap((b) => [b.head, b.forkedFrom]).filter((id): id is string => !!id))
  const bins = new Set<string>()
  const drawn = visible.filter((n) => {
    const essential = topologyPins.has(n.id) || n.commits.some((c) => topologyPins.has(c.id)) || n.kind === 'layer' || n.kind === 'group' || n.second || n.id === selected || n.commits.some((c) => c.id === selected) || tagPoints.get(n.branch)?.id === n.id
    const bin = `${n.branch}:${Math.floor(n.x * zoom / 12)}`
    if (!essential && bins.has(bin)) return false
    bins.add(bin)
    return true
  })
  const overview = Array.from({ length: 90 }, () => 0)
  for (const n of layout.positioned) overview[Math.min(89, Math.floor(n.x / layout.width * 90))] += Math.max(1, n.commits.length)
  const peak = Math.max(1, ...overview)
  const miniMove = (e: PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    pan(clamp((e.clientX - rect.left) / rect.width, 0, 1) * layout.width * zoom - size.width / 2, viewport.top)
    if (e.buttons) e.currentTarget.setPointerCapture(e.pointerId)
  }
  return (
    <div className={css.map}>
      <div className={css.mapControls} role="group" aria-label={t('files_zoomHistory')}>
        {expanded ? <button type="button" onClick={onCollapse}>{t('files_collapseGroups')}</button> : null}
        <button type="button" onClick={() => changeZoom(zoom / 1.25)} aria-label={t('files_zoomOut')}>
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 8h12" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
        </button>
        <button type="button" className={css.zoomValue} onClick={() => changeZoom(1)} title={t('files_zoomReset')}>{Math.round(zoom * 100)}%</button>
        <button type="button" onClick={() => changeZoom(zoom * 1.25)} aria-label={t('files_zoomIn')}><IconPlusOutlineRegular size={14} /></button>
        <button type="button" onClick={fit} aria-label={t('files_zoomFit')}><IconFullscreenOutlineRegular size={14} /></button>
      </div>
      <div className={css.graph} ref={host} tabIndex={0} aria-label={t('files_graphAria')} onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}
        onScroll={(e) => { setViewport({ left: e.currentTarget.scrollLeft, top: e.currentTarget.scrollTop }); onViewport?.(e.currentTarget.scrollTop, e.currentTarget.scrollLeft) }}
        onKeyDown={(e) => {
          if ((e.target as Element).closest('[data-history-node], [data-branch-tag]')) return
          if (e.key === '+' || e.key === '=') changeZoom(zoom * 1.25)
          else if (e.key === '-') changeZoom(zoom / 1.25)
          else if (e.key === '0') changeZoom(1)
          else return
          e.preventDefault()
        }}>
        <svg className={css.canvas} width={layout.width * zoom} height={layout.height * zoom} viewBox={`0 0 ${layout.width} ${layout.height}`}>
          <rect className={css.mainBand} x={0} y={layout.center - 19 / zoom} width={layout.width} height={38 / zoom} />
          <path className={css.mainLine} d={`M20 ${layout.center} H${mainEnd}`} />
          <path className={css.mainFuture} d={`M${mainEnd + 7} ${layout.center} H${now}`} />
          <line className={css.nowLine} x1={now} x2={now} y1={18} y2={layout.height - 18} />
          <text className={css.nowLabel} x={now + 5 / zoom} y={20 / zoom} style={{ fontSize: 10 / zoom }}>{t('files_now')}</text>
          {[...byBranch.entries()].map(([name, ns]) => {
            if (name === 'main') return null
            const branch = branches.find((b) => b.name === name)
            const firstNode = ns[0]
            const head = ns.at(-1)!
            const origin = layout.points.get(branch?.forkedFrom ?? '')
            return (
              <g key={name} style={{ '--bough': branchColor(name) } as CSSProperties} className={clsx(css.bough, selected && name !== layout.points.get(selected)?.branch && css.dimmed)}>
                {origin ? <path className={css.forkPath} d={curve(origin, firstNode)} /> : <path className={css.unloadedPath} d={`M${Math.max(20, firstNode.x - 35)},${firstNode.y} H${firstNode.x}`} />}
                <path className={css.branchPath} d={`M${firstNode.x},${head.y} H${head.x}`} />
              </g>
            )
          })}
          {layout.positioned.filter((n) => n.second || n.source).map((n) => {
            const from = layout.points.get(n.source ?? n.second ?? '')
            if (!from) return null
            return <path key={`merge:${n.id}`} className={n.kind === 'layer' ? css.publishPath : css.mergePath} style={{ '--bough': branchColor(from.branch) } as CSSProperties} d={graft(from, n)} />
          })}
          {drawn.map((n) => {
            const active = selected === n.id || n.commits.some((c) => c.id === selected)
            const label = `${n.branch}: ${n.label}${n.kind === 'group' ? '' : ` · ${n.id}`}`
            return (
              <g key={n.id} data-history-node={n.id} data-kind={n.kind} role="button" tabIndex={0} aria-label={label}
                className={clsx(css.node, active && css.selected)} style={{ '--bough': branchColor(n.branch) } as CSSProperties}
                transform={`translate(${n.x},${n.y}) scale(${1 / zoom})`}
                onClick={() => { if (!skipClick.current) onSelect(n.id, n.branch); skipClick.current = false }}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(n.id, n.branch) } }}>
                <title>{label}</title>
                <circle className={css.nodeHit} r={12} />
                {active ? <circle className={css.selectedRing} r={12} /> : null}
                {n.kind === 'layer' ? <rect className={css.layerMark} x={-3.5} y={-3.5} width={7} height={7} rx={1.5} />
                  : n.second ? <circle className={css.mergeRing} r={5} />
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
            const width = name.length * 6.3 + 16
            const children = familyCounts.get(name) ?? 0
            return (
              <g key={name} data-branch-tag={name} role="button" tabIndex={0} aria-label={t('files_openBranch', { name })}
                className={clsx(css.branchTag, name === 'main' && css.isMain)} style={{ '--bough': branchColor(name) } as CSSProperties}
                transform={`translate(${head.x + 24 / zoom},${head.y}) scale(${1 / zoom})`}
                onClick={() => onBranch(name)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onBranch(name) } }}>
                <title>{children ? t('files_branchTagForks', { name, count: children }) : t('files_openBranch', { name })}</title>
                <rect x={0} y={-9} width={width} height={18} rx={2} />
                <text x={8} y={3.5}>{name}</text>
                {children > 0 && name !== 'main' ? (
                  <g className={css.familyTag} role="button" tabIndex={0} aria-expanded={!collapsed.has(name)}
                    aria-label={collapsed.has(name) ? t('files_expandFamily', { name }) : t('files_collapseFamily', { name })}
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
        </svg>
      </div>
      {inspector}
      <div className={css.overview}>
        <button type="button" className={css.nowButton} onClick={() => pan(Math.max(0, layout.width * zoom - size.width), layout.center * zoom - size.height / 2)}>
          {t('files_overview')}<span>{t('files_now')} ↗</span>
        </button>
        <div className={css.overviewStrip} role="slider" tabIndex={0} aria-label={t('files_historyOverview')} aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={Math.round(viewport.left / Math.max(1, layout.width * zoom - size.width) * 100)}
          onPointerDown={miniMove} onPointerMove={(e) => { if (e.buttons) miniMove(e) }}
          onKeyDown={(e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); pan(viewport.left + (e.key === 'ArrowRight' ? 1 : -1) * size.width / 3, viewport.top) } }}>
          <svg viewBox="0 0 900 38" preserveAspectRatio="none" aria-hidden="true">
            {overview.map((v, i) => v > 0 && <rect className={css.overviewBar} key={i} x={i * 10 + 1} y={36 - 28 * Math.sqrt(v / peak)} width={8} height={28 * Math.sqrt(v / peak)} />)}
            {layout.positioned.filter((n) => n.kind === 'layer').map((n) => <rect key={n.id} className={css.overviewLayer} x={n.x / layout.width * 900} y={1} width={3} height={8} />)}
          </svg>
          <div className={css.overviewWindow} style={{ left: `${viewport.left / (layout.width * zoom) * 100}%`, width: `${Math.min(100, size.width / (layout.width * zoom) * 100)}%` }} />
        </div>
      </div>
    </div>
  )
}
