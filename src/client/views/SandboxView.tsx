/**
 * Sandbox conversation view: where the session's work runs, after Connect's
 * SandboxMap. Agents (the root and its subagents) wire to the branches they
 * touch, branches to workspaces inside sandboxes. Calls from the agents' call
 * logs replay on the wires: a request packet loops along the call's chain of
 * wires while it runs and its result runs back when it ends
 * (docs/specs/conversation-views.md §5).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type SVGProps } from 'react'
import clsx from 'clsx'
import {
  Button, Checkbox, IconBranchOutlineRegular, IconCheckOutlineRegular, IconChevronRightOutlineRegular, IconCloseOutlineRegular,
  IconPauseOutlineRegular, IconPlayOutlineRegular, IconRefreshOutlineRegular, IconUsersOutlineRegular, IconWarningOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { LOGS_EVENT, shellCommand, type LabeledLine, type LogsListAnswer, type LogsOutputAnswer } from '../../shared/logs.ts'
import { SandboxGlyph } from '../machines/icons.tsx'
import { Gate, useNoComposer, type ViewProps } from './FileViews.tsx'
import { useRootState, type SessionStateView } from './hooks.ts'
import type { Translate } from './locale.ts'
import {
  FLASH_S, RESULT_S, activeAt, agentTree, buildSandboxMap, justEnded, packetAt, stamp,
  type MapAgent, type MapEvent, type SandboxMapModel,
} from './model.ts'
import css from './sandbox.module.css'

const LANES = [
  'var(--dsw-alias-state-business-primary)',
  'var(--dsw-alias-state-done-primary)',
  'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 70%, var(--dsw-alias-state-business-primary))',
  'color-mix(in srgb, var(--dsw-alias-state-done-primary) 50%, var(--dsw-alias-label-secondary))',
]
const NEUTRAL = 'var(--dsw-alias-label-tertiary)'
const OK = 'var(--dsw-alias-state-success-primary)'
const BAD = 'var(--dsw-alias-state-error-primary)'
const laneOf = (branches: readonly string[], branch: string | undefined) => branch === undefined ? NEUTRAL
  : LANES[Math.max(0, branches.indexOf(branch)) % LANES.length]

const CALL_LIMIT = 500
const EVENT_ROWS = 50
type Kind = 'agent' | 'project' | 'branch' | 'ws' | 'sandbox'
const node = (kind: Kind, id: string) => `${kind}:${id}`
const hopKey = (from: string, to: string) => `${from}>${to}`
const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/**
 * The nodes a call travels through, agent first (empty when it names nothing
 * on the map). A sandbox call without a branch goes through the project hub.
 */
function chainOf(e: MapEvent): string[] {
  const out = [node('agent', e.agent)]
  if (e.branch) out.push(node('branch', e.branch))
  else if (e.sandbox) out.push(node('project', ''))
  if (e.ws) out.push(node('ws', e.ws))
  else if (e.sandbox) out.push(node('sandbox', e.sandbox))
  return out.length > 1 ? out : []
}
const hopsOf = (chain: readonly string[]) => chain.slice(1).map((to, i) => hopKey(chain[i], to))

function Glyph({ size = 13, children, ...rest }: { size?: number, children: ReactNode } & SVGProps<SVGSVGElement>): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...rest}>
      {children}
    </svg>
  )
}
/** LayerFS: stacked layers. */
const LayersGlyph = ({ size }: { size?: number }) => (
  <Glyph size={size}><path d="M8 2 14 5 8 8 2 5 8 2Z" /><path d="m2 8 6 3 6-3" /><path d="m2 11 6 3 6-3" /></Glyph>
)
/** A command: a prompt chevron and a cursor. */
const PromptGlyph = ({ size }: { size?: number }) => <Glyph size={size}><path d="m3 4.5 3.5 3.5L3 11.5" /><path d="M8.5 11.5H13" /></Glyph>
/** A save on a branch. */
const CommitGlyph = ({ size }: { size?: number }) => <Glyph size={size}><circle cx="8" cy="8" r="2.6" /><path d="M1.5 8h3.9M10.6 8h3.9" /></Glyph>

/** Each agent's call log lines, reread when the log grows. */
function useAgentCalls(api: ViewProps['api'], agents: readonly MapAgent[]) {
  const ids = agents.map((a) => a.id).join('|')
  const [calls, setCalls] = useState<Record<string, LabeledLine[]>>({})
  const [loaded, setLoaded] = useState(false)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let live = true
    const list = ids ? ids.split('|') : []
    Promise.all(list.map((id) => api.op<LogsListAnswer>('logs.list', { tag: `dsh:${id}:`, limit: CALL_LIMIT })
      .then((answer) => [id, answer.lines] as const, () => [id, [] as LabeledLine[]] as const)))
      .then((pairs) => { if (live) { setCalls(Object.fromEntries(pairs)); setLoaded(true) } })
    return () => { live = false }
  }, [api, ids, tick])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const later = () => { if (!timer) timer = setTimeout(() => { timer = undefined; setTick((n) => n + 1) }, 600) }
    const offs = [api.onEvent(LOGS_EVENT, later), api.onEvent('layerfs-checkpoint', later), api.onEvent('connection', later)]
    return () => { offs.forEach((off) => off()); if (timer) clearTimeout(timer) }
  }, [api])
  return { calls, loaded }
}

/**
 * Replay clock: play/pause, scrub, Replay, Live. Live follows the end: when
 * new calls are appended the playhead plays through them at real speed.
 */
function useClock(duration: number, startLive: boolean) {
  const [t, setT] = useState(duration)
  const [playing, setPlaying] = useState(startLive && !reducedMotion())
  const [live, setLive] = useState(startLive)
  const durationRef = useRef(duration)
  durationRef.current = duration
  const started = useRef(false)
  // Open at the end; once there is data, keep a paused playhead where it is.
  useEffect(() => { if (!started.current && duration > 0) { started.current = true; setT(duration) } }, [duration])
  const atEnd = t >= duration
  useEffect(() => {
    // Live at the end has nothing to draw until the log grows (`duration` changes).
    if (!playing || (live && atEnd)) return
    let raf = 0, last = 0
    const frame = (now: number) => {
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 0
      last = now
      setT((value) => {
        const end = durationRef.current
        const next = Math.min(end, value + dt)
        if (next >= end && !live) setPlaying(false)
        return next
      })
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [playing, live, atEnd])
  return {
    t, playing, live,
    toggle: () => {
      if (playing) { setPlaying(false); setLive(false); return }
      if (t >= durationRef.current) setT(0)
      setPlaying(true)
    },
    scrub: (value: number) => { setLive(false); setPlaying(false); setT(value) },
    goLive: () => { setLive(true); setT(durationRef.current); setPlaying(!reducedMotion()) },
    replay: () => { setLive(false); setT(0); setPlaying(true) },
  }
}

type Focus = { kind: Kind | 'event', id: string } | null

export function SandboxView(props: ViewProps): ReactNode {
  const { api, t, sessionId, sessions } = props
  useNoComposer(props.hideComposer)
  const state = useRootState(api, sessionId, sessions)
  return (
    <Gate state={state} t={t}>
      {(view, project) => <SandboxMap {...props} project={project} binding={view.binding} root={state.root} byId={state.byId} title={state.title} label={state.label} />}
    </Gate>
  )
}

function SandboxMap({ api, t, sessionId, project, binding, root, byId, title, label }: ViewProps & {
  project: string
  binding: NonNullable<SessionStateView['binding']>
  root: string
  byId: ReturnType<typeof useRootState>['byId']
  title: (id: string) => string | undefined
  label: (id: string) => string | undefined
}): ReactNode {
  const agents = useMemo(() => agentTree(root, byId), [root, byId])
  const { calls, loaded } = useAgentCalls(api, agents)
  const model = useMemo(() => buildSandboxMap(agents, binding, calls), [agents, binding, calls])
  const anyRunning = agents.some((a) => a.running)
  const clock = useClock(model.duration, anyRunning)
  const now = clock.t
  const [onlyChat, setOnlyChat] = useState(false)
  const [showQuiet, setShowQuiet] = useState(false)
  const [hover, setHover] = useState<Focus>(null)
  const [selected, setSelected] = useState<Focus>(null)
  const focus = hover ?? selected
  const motion = !reducedMotion()

  const name = useCallback((agent: MapAgent) => agent.depth === 0 ? t('mainAgent')
    : label(agent.id) ?? title(agent.id) ?? t('subagent', { n: agents.indexOf(agent) }), [label, title, t, agents])
  const shownAgents = onlyChat ? agents.filter((a) => a.id === sessionId || a.parent === sessionId) : agents
  const shownKey = shownAgents.map((a) => a.id).join('|')
  const events = useMemo(() => {
    const shown = new Set(shownKey.split('|'))
    return model.events.filter((e) => shown.has(e.agent))
  }, [model.events, shownKey])
  const chains = useMemo(() => new Map(events.map((e) => [e.id, chainOf(e)])), [events])
  const active = activeAt(events, now)
  const done = (e: MapEvent) => e.end <= now
  const agentLane = (id: string) => laneOf(model.branches, events.find((e) => e.agent === id && e.branch)?.branch ?? (id === root ? binding.branch : undefined))

  // What the focused node or call touches, for dimming the rest.
  const related = useMemo(() => {
    if (!focus) return null
    const set = new Set<string>()
    if (focus.kind === 'event') {
      const e = events.find((x) => x.id === focus.id)
      for (const key of e ? chains.get(e.id) ?? [] : []) set.add(key)
      if (e?.sandbox) set.add(node('sandbox', e.sandbox))
      return set
    }
    set.add(node(focus.kind, focus.id))
    const touch = (e: MapEvent) => { for (const key of chains.get(e.id) ?? []) set.add(key); if (e.sandbox) set.add(node('sandbox', e.sandbox)) }
    for (const e of events) {
      if ((focus.kind === 'agent' && e.agent === focus.id) || (focus.kind === 'branch' && e.branch === focus.id)
        || (focus.kind === 'ws' && e.ws === focus.id) || (focus.kind === 'sandbox' && e.sandbox === focus.id)) touch(e)
    }
    for (const box of model.sandboxes) for (const ws of box.workspaces) {
      const mine = (focus.kind === 'ws' && focus.id === ws.id) || (focus.kind === 'sandbox' && focus.id === box.name) || (focus.kind === 'branch' && focus.id === ws.branch)
      if (mine) { set.add(node('ws', ws.id)); set.add(node('sandbox', box.name)); if (ws.branch) set.add(node('branch', ws.branch)) }
    }
    return set
  }, [focus, events, chains, model.sandboxes])
  const dim = (key: string) => related !== null && !related.has(key)

  // Wires. Agent -> branch and branch -> workspace stay drawn; the hops of a
  // sandbox call through the project hub (sandbox create/close) exist only
  // around their call.
  const edges = useMemo(() => {
    const out = new Map<string, { id: string, from: string, to: string, branch?: string, standing: boolean, events: MapEvent[] }>()
    const add = (from: string, to: string, branch: string | undefined, standing: boolean) => {
      const id = hopKey(from, to)
      let edge = out.get(id)
      if (!edge) { edge = { id, from, to, branch, standing, events: [] }; out.set(id, edge) }
      edge.standing ||= standing
      return edge
    }
    for (const e of events) {
      const chain = chains.get(e.id) ?? []
      chain.slice(1).forEach((to, i) => add(chain[i], to, e.branch, !to.startsWith('sandbox:') && !to.startsWith('project:')).events.push(e))
    }
    for (const box of model.sandboxes) for (const ws of box.workspaces) {
      if (ws.branch && !box.closed) add(node('branch', ws.branch), node('ws', ws.id), ws.branch, true)
    }
    return [...out.values()]
  }, [events, chains, model.sandboxes])
  // Workspaces appear when their mount starts; a sandbox retires when its close ends.
  const retired = (box: SandboxMapModel['sandboxes'][number]) => {
    const closure = events.find((e) => e.method === 'sandbox.close' && e.sandbox === box.name && e.outcome === 'ok')
    return box.closed && (!closure || done(closure))
  }
  const visibleWs = (box: SandboxMapModel['sandboxes'][number]) => box.workspaces.filter((ws) => {
    const mount = events.find((e) => e.method === 'workspace.mount' && e.ws === ws.id)
    return !mount || mount.start <= now
  })
  const visibleEdges = edges.filter((edge) => edge.standing || edge.events.some((e) => e.start <= now && now < e.end + FLASH_S))

  const graph = useRef<HTMLDivElement>(null)
  const pathEls = useRef(new Map<string, SVGPathElement>())
  const [paths, setPaths] = useState<Record<string, string>>({})
  const geometry = visibleEdges.map((e) => e.id).join('|') + `#${shownKey}#${model.sandboxes.map((b) => `${b.name}:${retired(b)}:${visibleWs(b).map((w) => w.id).join('+')}`).join(',')}`
  useLayoutEffect(() => {
    const el = graph.current
    if (!el) return
    const measure = () => {
      const bounds = el.getBoundingClientRect()
      const nodes = new Map([...el.querySelectorAll<HTMLElement>('[data-flow-node]')].map((n) => [n.dataset.flowNode!, n.getBoundingClientRect()]))
      const next: Record<string, string> = {}
      for (const edge of edges) {
        const a = nodes.get(edge.from), b = nodes.get(edge.to)
        if (!a || !b || !a.height || !b.height) continue
        const x1 = a.right - bounds.left, y1 = a.top + a.height / 2 - bounds.top
        const x2 = b.left - bounds.left, y2 = b.top + b.height / 2 - bounds.top
        const bend = Math.max(16, (x2 - x1) * 0.5)
        next[edge.id] = `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`
      }
      setPaths(next)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    el.querySelectorAll<HTMLElement>('[data-flow-node]').forEach((n) => observer.observe(n))
    measure()
    return () => observer.disconnect()
    // Activity only restyles; geometry changes when the set of wires or nodes does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometry])

  // Packets: positions are a function of the replay clock, so pausing freezes
  // them and scrubbing moves them.
  const packets: ReactNode[] = []
  if (motion) {
    for (const e of events) {
      if (now < e.start || now >= e.end + RESULT_S) continue
      const hops = hopsOf(chains.get(e.id) ?? [])
      const where = packetAt(e, now, hops.length)
      const el = where ? pathEls.current.get(hops[where.hop]) : undefined
      if (!where || !el || !el.isConnected) continue
      const point = el.getPointAtLength(where.at * el.getTotalLength())
      const color = where.kind === 'request' ? laneOf(model.branches, e.branch) : e.outcome === 'ok' ? OK : BAD
      const muted = related !== null && !hops[where.hop].split('>').every((k) => related.has(k))
      packets.push(
        <g key={`${e.id}:${where.kind}`} className={clsx(css.packet, muted && css.wireMuted)} style={{ color }} transform={`translate(${point.x} ${point.y})`}>
          <circle r={7} className={css.packetHalo} />
          <circle r={where.kind === 'request' ? 3 : 3.4} />
        </g>,
      )
    }
  }

  const agentStatus = (agent: MapAgent) => {
    const running = active.find((e) => e.agent === agent.id)
    const last = events.filter((e) => e.agent === agent.id && done(e)).at(-1)
    if (running) return { live: true, text: verb(running, t), running, last }
    if (last && last.outcome !== 'ok') return { live: false, warn: true, text: t('needsAttention'), last }
    if (agent.running) return { live: true, text: t('working'), last }
    return { live: false, text: last ? t('done') : t('idle'), last }
  }

  const selectedEvent = selected?.kind === 'event' ? events.find((e) => e.id === selected.id) : undefined
  const matchesFocus = (e: MapEvent, f: NonNullable<Focus>) => f.kind === 'agent' ? e.agent === f.id : f.kind === 'branch' ? e.branch === f.id
    : f.kind === 'ws' ? e.ws === f.id : f.kind === 'sandbox' ? e.sandbox === f.id : true
  const listFocus = focus && focus.kind !== 'event' ? focus : null
  const listed = events.filter((e) => e.start <= now && (!listFocus || matchesFocus(e, listFocus)))
  const agentName = (id: string) => { const a = agents.find((x) => x.id === id); return a ? name(a) : id }
  const focusName = (f: Focus) => !f || f.kind === 'event' ? null : f.kind === 'agent' ? agentName(f.id) : f.id.split(':').at(-1) ?? f.id
  const choose = (next: NonNullable<Focus>) => setSelected((s) => s && s.kind === next.kind && s.id === next.id ? null : next)
  const hoverProps = (f: NonNullable<Focus>) => ({ onMouseEnter: () => setHover(f), onFocus: () => setHover(f), onBlur: () => setHover(null), onClick: () => choose(f) })
  const isSelected = (f: NonNullable<Focus>) => selected?.kind === f.kind && selected.id === f.id
  const empty = loaded && model.events.length === 0
  const disabled = model.duration === 0
  const playState = clock.live && clock.playing ? t('live') : clock.playing ? t('playing') : t('paused')
  // The card is the conversation's: its title stays the root's when filtered to one subagent.
  const rootAgent = shownAgents.length ? agents[0] : undefined
  // Subagents with no LayerFS calls (theirs or their subagents') fold into one row.
  const quiet = useMemo(() => {
    const busy = new Set(model.events.map((e) => e.agent))
    const parentOf = new Map(agents.map((a) => [a.id, a.parent]))
    for (const id of [...busy]) for (let up = parentOf.get(id); up && !busy.has(up); up = parentOf.get(up)) busy.add(up)
    return new Set(agents.filter((a) => a.depth > 0 && !a.running && !busy.has(a.id)).map((a) => a.id))
  }, [agents, model.events])
  const quietShown = shownAgents.filter((a) => quiet.has(a.id)).length
  const listedAgents = showQuiet ? shownAgents : shownAgents.filter((a) => !quiet.has(a.id))
  const following = focusName(focus)

  return (
    <div className={css.page} data-playing={clock.playing || undefined}>
      <div className={css.toolbar}>
        <span className={css.facts}><IconUsersOutlineRegular size={13} />{t('facts', { agents: shownAgents.length, branches: model.branches.length, sandboxes: model.sandboxes.length })}</span>
        {agents.length > 1 ? <Checkbox className={css.filter} checked={onlyChat} onChange={setOnlyChat} label={t('thisChat')} /> : null}
        <span className={css.spacer} />
        <Button variant="outline" size="sm" disabled={disabled} onClick={clock.toggle}
          icon={clock.playing ? <IconPauseOutlineRegular size={14} /> : <IconPlayOutlineRegular size={14} />}>
          {clock.playing ? t('pause') : now >= model.duration && !disabled ? t('playAgain') : t('play')}
        </Button>
        <Button variant="ghost" size="sm" disabled={disabled} onClick={clock.replay} aria-label={t('replay')} title={t('replay')} icon={<IconRefreshOutlineRegular size={14} />} />
        <Button variant={clock.live ? 'outline' : 'ghost'} size="sm" disabled={disabled} onClick={clock.goLive} aria-pressed={clock.live}>
          <span className={clsx(css.liveDot, clock.live && clock.playing && css.liveOn)} aria-hidden />{t('live')}
        </Button>
      </div>

      <div className={css.flow} ref={graph} onMouseLeave={() => setHover(null)}>
        <svg className={css.wires} aria-hidden>
          {visibleEdges.map((edge) => {
            const d = paths[edge.id]
            if (!d) return null
            const running = edge.events.some((e) => e.start <= now && now < e.end)
            const ended = running ? undefined : justEnded(edge.events, now, () => true, FLASH_S)
            const color = laneOf(model.branches, edge.branch)
            const muted = related !== null && !(related.has(edge.from) && related.has(edge.to))
            return (
              <g key={edge.id} style={{ color }} className={clsx(muted && css.wireMuted, ended && (ended.outcome === 'ok' ? css.wireOk : css.wireError))}>
                <path d={d} className={css.wire} ref={(el) => { if (el) pathEls.current.set(edge.id, el); else pathEls.current.delete(edge.id) }} />
                <path d={d} className={clsx(css.wireLit, (running || ended) && css.wireOn, running && motion && clock.playing && css.wireFlow)} />
              </g>
            )
          })}
          {packets}
        </svg>

        <section className={css.column}>
          <div className={css.zone}><IconUsersOutlineRegular size={13} /><span>{t('agents')}</span><span className={css.count}>{shownAgents.length}</span></div>
          {rootAgent ? (
            <div className={css.group}>
              <div className={css.groupHead}>
                <span className={css.groupTitle} title={title(rootAgent.id)}>{title(rootAgent.id) ?? t('lead')}</span>
                {rootAgent.id === sessionId ? <span className={css.tag}>{t('thisChat')}</span> : null}
              </div>
              {listedAgents.map((agent) => {
                const s = agentStatus(agent)
                const f = { kind: 'agent', id: agent.id } as const
                return (
                  <button key={agent.id} type="button" data-flow-node={node('agent', agent.id)} {...hoverProps(f)}
                    className={clsx(css.agent, agent.depth > 0 && css.child, s.running && css.active, dim(node('agent', agent.id)) && css.dim, isSelected(f) && css.selected)}
                    style={{ paddingLeft: 11 + Math.min(agent.depth, 3) * 14, ['--lane' as string]: agentLane(agent.id), ['--indent' as string]: `${Math.max(0, Math.min(agent.depth, 3) - 1) * 14}px` }}>
                    <span className={css.rowHead}>
                      <span className={css.avatar}>{name(agent).slice(0, 1).toUpperCase()}</span>
                      <span className={css.rowName} title={name(agent)}>{name(agent)}</span>
                      {agent.depth > 0 && agent.id === sessionId ? <span className={css.tag}>{t('thisChat')}</span> : null}
                      <span className={clsx(css.status, s.warn && css.warnText)}><i className={clsx(css.dot, s.live && css.dotLive)} />{s.text}</span>
                    </span>
                    <span className={css.callLine}>
                      {s.running ? <><PromptGlyph size={12} /><span className={css.mono}>{s.running.method}</span><span className={css.right}>{(now - s.running.start).toFixed(1)}s</span></>
                        : s.last ? <>{s.last.outcome === 'ok' ? <IconCheckOutlineRegular size={12} /> : <IconWarningOutlineRegular size={12} className={css.errorText} />}<span className={css.mono}>{s.last.method}</span><span className={css.right}>{s.last.turn ? t('turn', { n: s.last.turn }) : stamp(s.last.end)}</span></>
                        : <><IconBranchOutlineRegular size={12} /><span>{binding.branch ?? '—'}</span></>}
                    </span>
                  </button>
                )
              })}
              {quietShown > 0 ? (
                <button type="button" className={css.fold} aria-expanded={showQuiet} onClick={() => setShowQuiet((v) => !v)}>
                  <IconChevronRightOutlineRegular size={12} className={clsx(css.foldIcon, showQuiet && css.foldOpen)} />
                  {showQuiet ? t('quietHide', { n: quietShown }) : t('quietShow', { n: quietShown })}
                </button>
              ) : null}
            </div>
          ) : null}
        </section>

        <section className={css.column}>
          <div className={css.zone}><LayersGlyph /><span>{t('layerfs')}</span></div>
          <div className={css.hub}>
            <div className={clsx(css.hubHead, active.some((e) => !e.branch && e.sandbox) && css.hubBusy)} data-flow-node={node('project', '')}><LayersGlyph size={20} /><strong title={project}>{project.split('/').at(-1)}</strong><span>{t('projectHistory')}</span></div>
            {model.branches.map((branch) => {
              const f = { kind: 'branch', id: branch } as const
              const busy = active.some((e) => e.branch === branch)
              const saves = events.filter((e) => e.branch === branch && e.method === 'workspace.commit' && done(e) && e.outcome === 'ok').length
              const failed = events.some((e) => e.branch === branch && e.method === 'workspace.commit' && done(e) && e.outcome !== 'ok')
              return (
                <button key={branch} type="button" data-flow-node={node('branch', branch)} {...hoverProps(f)}
                  className={clsx(css.branch, busy && css.active, dim(node('branch', branch)) && css.dim, isSelected(f) && css.selected)}
                  style={{ ['--lane' as string]: laneOf(model.branches, branch) }}>
                  <span className={css.rowHead}><IconBranchOutlineRegular size={13} /><span className={css.rowName} title={branch}>{branch}</span>{branch === binding.branch ? <span className={css.tag}>{t('thisChat')}</span> : null}</span>
                  <span className={css.branchMeta}>
                    {saves > 0 ? <><CommitGlyph size={12} /><span key={saves} className={css.bump}>{saves === 1 ? t('saveOne') : t('saves', { n: saves })}</span></> : <span>{t('branch')}</span>}
                    {failed ? <IconWarningOutlineRegular size={12} className={css.errorText} /> : null}
                  </span>
                </button>
              )
            })}
            {model.sandboxes.some((b) => b.workspaces.length > 0) ? <p className={css.hubNote}>{t('hubNote')}</p> : null}
          </div>
          <div className={css.legend}>
            <span><i className={css.legendLane} />{t('legendRequest')}</span>
            <span><i className={css.legendOk} />{t('legendResult')}</span>
            <span><i className={css.legendError} />{t('legendRefused')}</span>
          </div>
        </section>

        <section className={css.column}>
          <div className={css.zone}><SandboxGlyph size={13} /><span>{t('sandboxes')}</span><span className={css.count}>{model.sandboxes.length}</span></div>
          {model.sandboxes.map((box) => {
            const f = { kind: 'sandbox', id: box.name } as const
            if (retired(box)) return <div key={box.name} className={css.retired}><IconCheckOutlineRegular size={13} />{t('closed', { name: box.name })}<span className={css.muted}>{t('closedNote')}</span></div>
            const creation = events.find((e) => e.method === 'sandbox.create' && e.sandbox === box.name)
            const creating = !!creation && creation.start <= now && now < creation.end
            const bound = binding.sandbox === box.name
            const state = creating ? t('creating') : bound ? binding.executionState ?? (binding.state === 'bound' ? t('active') : binding.state) : t('active')
            const visible = visibleWs(box)
            return (
              <div key={box.name} className={clsx(css.box, dim(node('sandbox', box.name)) && css.dim)}>
                <button type="button" className={clsx(css.boxHead, isSelected(f) && css.selected)} data-flow-node={node('sandbox', box.name)} {...hoverProps(f)}>
                  <SandboxGlyph size={15} /><span className={css.rowName} title={box.name}>{box.name}</span>
                  <span className={css.status}><i className={clsx(css.dot, (creating || (bound && binding.state === 'bound')) && css.dotLive)} />{state}</span>
                </button>
                <div className={css.boxMeta}>{box.machine ?? (bound ? binding.machine : undefined) ?? t('machineUnknown')}<span>{t('workspaces', { n: visible.length })}</span></div>
                {visible.length === 0 ? <p className={css.boxEmpty}>{creating ? t('starting') : t('noWorkspaces')}</p> : visible.map((ws) => {
                  const wf = { kind: 'ws', id: ws.id } as const
                  const running = active.find((e) => e.ws === ws.id)
                  const last = events.filter((e) => e.ws === ws.id && done(e)).at(-1)
                  const warn = !running && last && last.outcome !== 'ok'
                  const users = [...new Set(events.filter((e) => e.ws === ws.id && e.start <= now).map((e) => e.agent))]
                  return (
                    <button key={ws.id} type="button" data-flow-node={node('ws', ws.id)} {...hoverProps(wf)}
                      className={clsx(css.ws, running && css.active, dim(node('ws', ws.id)) && css.dim, isSelected(wf) && css.selected)}
                      style={{ ['--lane' as string]: laneOf(model.branches, ws.branch) }}>
                      <span className={css.rowHead}>
                        <LayersGlyph size={13} /><span className={css.rowName} title={ws.id}>{ws.name}</span>
                        <span className={clsx(css.status, warn && css.errorText)}>
                          {running ? <><i className={clsx(css.dot, css.dotLive)} />{verb(running, t)}</> : warn ? last!.outcome : t('mounted')}
                        </span>
                      </span>
                      <span className={css.wsBranch}><IconBranchOutlineRegular size={12} />{ws.branch ?? '—'}<span className={css.right}>{users.length > 1 ? t('agentsN', { n: users.length }) : users[0] ? agentName(users[0]) : ''}</span></span>
                      <span className={clsx(css.command, running && css.commandLive)}>
                        <PromptGlyph size={12} />
                        <span className={css.commandText}>{running ? shellCommand(running.argv) : last ? `${last.method} · ${last.outcome === 'ok' ? t('outcomeOk') : last.outcome}` : t('mountedWorkspace')}</span>
                        {running ? <span className={css.right}>{(now - running.start).toFixed(1)}s</span> : null}
                      </span>
                    </button>
                  )
                })}
              </div>
            )
          })}
        </section>
      </div>

      <div className={css.playback}>
        <span className={css.playState}><i className={clsx(css.dot, clock.playing && css.dotLive)} />{playState}</span>
        <input className={css.scrub} type="range" min={0} max={Math.max(0.1, model.duration)} step={0.05} value={Math.min(now, model.duration)}
          style={{ ['--fill' as string]: `${model.duration ? Math.min(100, (now / model.duration) * 100) : 0}%` }}
          aria-label={t('scrub')} disabled={disabled} onChange={(e) => clock.scrub(Number(e.target.value))} />
        <span className={css.time}>{stamp(now)} / {stamp(model.duration)}</span>
      </div>

      <section className={css.inspector}>
        <header className={css.inspectorHead}>
          <strong>{selectedEvent ? selectedEvent.method : following ? t('following', { name: following }) : t('activity')}</strong>
          {selected ? (
            <Button variant="ghost" size="sm" aria-label={t('clear')} title={t('clear')} icon={<IconCloseOutlineRegular size={13} />} onClick={() => { setSelected(null); setHover(null) }} />
          ) : <span className={css.muted}>{listed.length > EVENT_ROWS ? t('callsShown', { n: EVENT_ROWS }) : t('follow')}</span>}
        </header>
        {selectedEvent ? <EventDetail api={api} e={selectedEvent} t={t} now={now} owner={agentName(selectedEvent.agent)} />
          : empty ? (
            <div className={css.emptyCalls}><p className={css.emptyTitle}>{t('noActivity')}</p><p className={css.muted}>{t('noActivityBody')}</p></div>
          ) : (
            <ol className={css.events}>
              {listed.slice(-EVENT_ROWS).reverse().map((e) => (
                <li key={e.id}>
                  <button type="button" className={css.event} onClick={() => choose({ kind: 'event', id: e.id })}
                    onMouseEnter={() => setHover({ kind: 'event', id: e.id })} onMouseLeave={() => setHover(null)}>
                    <EventIcon e={e} now={now} />
                    <time className={css.eventTime} dateTime={new Date(e.at).toISOString()} title={new Date(e.at).toLocaleString()}>{stamp(e.start)}</time>
                    <span className={css.eventMethod}>{e.method}</span>
                    <span className={css.eventTarget}>{e.ws ?? e.branch ?? e.sandbox ?? ''}</span>
                    {e.outcome !== 'ok' && done(e) ? <span className={css.errorText}>{e.outcome}</span> : null}
                    <span className={css.eventOwner}>{agentName(e.agent)}{e.turn ? ` · ${t('turn', { n: e.turn })}` : ''}</span>
                    <IconChevronRightOutlineRegular size={12} className={css.muted} />
                  </button>
                </li>
              ))}
            </ol>
          )}
      </section>
    </div>
  )
}

function verb(e: MapEvent, t: Translate): string {
  return e.method === 'workspace.exec' ? t('executing') : e.method === 'workspace.commit' ? t('saving')
    : e.method === 'workspace.mount' ? t('mounting') : e.method === 'sandbox.create' ? t('creating') : t('calling')
}

function EventIcon({ e, now }: { e: MapEvent, now: number }): ReactNode {
  const running = e.end > now
  return (
    <span className={clsx(css.eventIcon, !running && (e.outcome === 'ok' ? css.okText : css.errorText))}>
      {running ? <i className={clsx(css.dot, css.dotLive)} /> : e.outcome === 'ok' ? <IconCheckOutlineRegular size={13} /> : <IconWarningOutlineRegular size={13} />}
    </span>
  )
}

/** One call: the command, its timing and outcome, and what it printed when this plugin kept it. */
function EventDetail({ api, e, t, now, owner }: { api: ViewProps['api'], e: MapEvent, t: Translate, now: number, owner: string }): ReactNode {
  const [output, setOutput] = useState<LogsOutputAnswer | null>(null)
  useEffect(() => {
    setOutput(null)
    if (!e.tag || !e.output) return
    let live = true
    api.op<LogsOutputAnswer>('logs.output', { tag: e.tag }).then((answer) => { if (live) setOutput(answer) }, () => { if (live) setOutput({ missing: true }) })
    return () => { live = false }
  }, [api, e.tag, e.output])
  const inFlight = now < e.end
  const text = output && !('missing' in output) ? [output.stdout, output.stderr].filter(Boolean).join('\n').trim() : ''
  return (
    <div className={css.detail}>
      <div className={css.detailFacts}>
        <EventIcon e={e} now={now} />
        <span>{owner}{e.turn ? ` · ${t('turn', { n: e.turn })}` : ''}</span>
        <span>{stamp(e.start)} → {stamp(e.end)}</span>
        <span>{e.ms < 1000 ? `${e.ms} ms` : `${(e.ms / 1000).toFixed(1)} s`}</span>
        {!inFlight ? <span className={e.outcome === 'ok' ? css.okText : css.errorText}>{e.outcome === 'ok' ? t('outcomeOk') : e.outcome}</span> : null}
      </div>
      <code className={css.detailCommand}>{shellCommand(e.argv)}</code>
      <pre className={clsx(css.detailOutput, !inFlight && e.outcome !== 'ok' && css.errorText)}>
        {now < e.start ? t('notYet') : inFlight ? t('inFlight') : text ? text.slice(0, 4000) : e.output && !output ? t('loading') : t('noOutput')}
      </pre>
    </div>
  )
}

export type { SandboxMapModel }
