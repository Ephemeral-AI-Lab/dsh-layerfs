/**
 * Sandbox conversation view: where the session's work runs, after Connect's
 * SandboxMap. Agents (the root and its subagents) wire to the branches they
 * touch, branches to workspaces inside sandboxes. Calls from the agents' call
 * logs replay on the wires (docs/specs/conversation-views.md §5).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, IconBranchOutlineRegular, IconCheckOutlineRegular, IconPauseOutlineRegular, IconPlayOutlineRegular,
  IconUsersOutlineRegular, IconWarningOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { LOGS_EVENT, type LabeledLine, type LogsListAnswer } from '../../shared/logs.ts'
import { SandboxGlyph } from '../machines/icons.tsx'
import { Gate, useNoComposer, type ViewProps } from './FileViews.tsx'
import { useRootState, type SessionStateView } from './hooks.ts'
import type { Translate } from './locale.ts'
import { activeAt, agentTree, buildSandboxMap, justEnded, stamp, type MapAgent, type MapEvent, type SandboxMapModel } from './model.ts'
import css from './sandbox.module.css'

const LANES = [
  'var(--dsw-alias-state-business-primary)',
  'var(--dsw-alias-state-done-primary)',
  'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 70%, var(--dsw-alias-state-business-primary))',
  'color-mix(in srgb, var(--dsw-alias-state-done-primary) 50%, var(--dsw-alias-label-secondary))',
]
const laneOf = (branches: readonly string[], branch: string | undefined) => branch === undefined ? 'var(--dsw-alias-label-tertiary)'
  : LANES[Math.max(0, branches.indexOf(branch)) % LANES.length]

const CALL_LIMIT = 500
const EVENT_ROWS = 50
const node = (kind: 'agent' | 'branch' | 'ws' | 'sandbox', id: string) => `${kind}:${id}`
const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

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

/** Replay clock: play/pause, scrub, Live (follow the end as calls arrive). */
function useClock(duration: number, startLive: boolean) {
  const [t, setT] = useState(duration)
  const [playing, setPlaying] = useState(startLive && !reducedMotion())
  const [live, setLive] = useState(startLive)
  const durationRef = useRef(duration)
  durationRef.current = duration
  const started = useRef(false)
  // Open at the end; once there is data, keep a paused playhead where it is.
  useEffect(() => { if (!started.current && duration > 0) { started.current = true; setT(duration) } }, [duration])
  useEffect(() => {
    if (!playing) return
    let raf = 0, last = 0
    const frame = (now: number) => {
      const dt = last ? (now - last) / 1000 : 0
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
  }, [playing, live])
  return {
    t, playing, live,
    toggle: () => setPlaying((p) => { if (!p && t >= durationRef.current) setT(0); if (p) setLive(false); return !p }),
    scrub: (value: number) => { setLive(false); setT(value) },
    goLive: () => { setLive(true); setT(durationRef.current); setPlaying(!reducedMotion()) },
    replay: () => { setLive(false); setT(0); setPlaying(true) },
  }
}

type Focus = { kind: 'agent' | 'branch' | 'ws' | 'sandbox', id: string } | null

export function SandboxView(props: ViewProps): ReactNode {
  const { api, t, sessionId, sessions } = props
  useNoComposer(props.hideComposer)
  const state = useRootState(api, sessionId, sessions)
  return (
    <Gate state={state} t={t}>
      {(view, project) => <SandboxMap {...props} project={project} binding={view.binding} root={state.root} byId={state.byId} title={state.title} />}
    </Gate>
  )
}

function SandboxMap({ api, t, sessionId, project, binding, root, byId, title }: ViewProps & {
  project: string
  binding: NonNullable<SessionStateView['binding']>
  root: string
  byId: ReturnType<typeof useRootState>['byId']
  title: (id: string) => string | undefined
}): ReactNode {
  const agents = useMemo(() => agentTree(root, byId), [root, byId])
  const { calls, loaded } = useAgentCalls(api, agents)
  const model = useMemo(() => buildSandboxMap(agents, binding, calls), [agents, binding, calls])
  const anyRunning = agents.some((a) => a.running)
  const clock = useClock(model.duration, anyRunning)
  const [onlyChat, setOnlyChat] = useState(false)
  const [hover, setHover] = useState<Focus>(null)
  const [selected, setSelected] = useState<Focus>(null)
  const focus = hover ?? selected

  const name = useCallback((agent: MapAgent) => title(agent.id) ?? (agent.depth === 0 ? t('lead') : t('subagent', { n: agents.indexOf(agent) })), [title, t, agents])
  const shownAgents = onlyChat ? agents.filter((a) => a.id === sessionId || a.parent === sessionId) : agents
  const shown = new Set(shownAgents.map((a) => a.id))
  const events = model.events.filter((e) => shown.has(e.agent))
  const active = activeAt(events, clock.t)

  // What the focused node touches, for dimming the rest.
  const related = useMemo(() => {
    if (!focus) return null
    const set = new Set<string>([node(focus.kind, focus.id)])
    const touch = (e: MapEvent) => { set.add(node('agent', e.agent)); if (e.branch) set.add(node('branch', e.branch)); if (e.ws) set.add(node('ws', e.ws)); if (e.sandbox) set.add(node('sandbox', e.sandbox)) }
    for (const e of events) {
      if ((focus.kind === 'agent' && e.agent === focus.id) || (focus.kind === 'branch' && e.branch === focus.id)
        || (focus.kind === 'ws' && e.ws === focus.id) || (focus.kind === 'sandbox' && e.sandbox === focus.id)) touch(e)
    }
    for (const box of model.sandboxes) for (const ws of box.workspaces) {
      if (set.has(node('ws', ws.id)) || (ws.branch && set.has(node('branch', ws.branch)) && focus.kind === 'branch')) { set.add(node('ws', ws.id)); set.add(node('sandbox', box.name)); if (ws.branch) set.add(node('branch', ws.branch)) }
      if (focus.kind === 'sandbox' && focus.id === box.name) { set.add(node('ws', ws.id)); if (ws.branch) set.add(node('branch', ws.branch)) }
    }
    return set
  }, [focus, events, model.sandboxes])
  const dim = (key: string) => related !== null && !related.has(key)

  // Wires: agent -> branch for every branch an agent touched; branch -> workspace for every workspace.
  const edges = useMemo(() => {
    const out: { id: string, from: string, to: string, branch?: string, match: (e: MapEvent) => boolean }[] = []
    const seen = new Set<string>()
    for (const e of events) {
      const from = node('agent', e.agent)
      const to = e.branch ? node('branch', e.branch) : e.sandbox ? node('sandbox', e.sandbox) : null
      if (!to || seen.has(`${from}>${to}`)) continue
      seen.add(`${from}>${to}`)
      const agent = e.agent, branch = e.branch, box = e.sandbox
      out.push({ id: `${from}>${to}`, from, to, branch, match: branch ? (x) => x.agent === agent && x.branch === branch : (x) => x.agent === agent && !x.branch && x.sandbox === box })
    }
    for (const box of model.sandboxes) for (const ws of box.workspaces) {
      if (!ws.branch || box.closed) continue
      const id = ws.id
      out.push({ id: `branch:${ws.branch}>ws:${id}`, from: node('branch', ws.branch), to: node('ws', id), branch: ws.branch, match: (x) => x.ws === id })
    }
    return out
  }, [events, model.sandboxes])

  const graph = useRef<HTMLDivElement>(null)
  const [paths, setPaths] = useState<Record<string, string>>({})
  const geometry = edges.map((e) => e.id).join('|') + `#${shownAgents.length}`
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
        const bend = Math.max(12, (x2 - x1) * 0.5)
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

  const agentStatus = (agent: MapAgent) => {
    const running = active.find((e) => e.agent === agent.id)
    const last = events.filter((e) => e.agent === agent.id && e.end <= clock.t).at(-1)
    if (running) return { live: true, text: running.method === 'workspace.exec' ? t('executing') : running.method === 'workspace.commit' ? t('saving') : t('calling'), running, last }
    if (last && last.outcome !== 'ok') return { live: false, warn: true, text: t('needsAttention'), last }
    if (agent.running) return { live: true, text: t('working'), last }
    return { live: false, text: last ? t('done') : t('idle'), last }
  }

  const listed = events.filter((e) => e.start <= clock.t && (!focus || (related?.has(node('agent', e.agent)) && (focus.kind === 'agent' ? e.agent === focus.id : focus.kind === 'branch' ? e.branch === focus.id : focus.kind === 'ws' ? e.ws === focus.id : e.sandbox === focus.id))))
  const focusName = focus ? (focus.kind === 'agent' ? (agents.find((a) => a.id === focus.id) ? name(agents.find((a) => a.id === focus.id)!) : focus.id) : focus.id) : null
  const choose = (next: Focus) => setSelected((s) => s && next && s.kind === next.kind && s.id === next.id ? null : next)
  const hoverProps = (f: NonNullable<Focus>) => ({ onMouseEnter: () => setHover(f), onFocus: () => setHover(f), onBlur: () => setHover(null), onClick: () => choose(f) })
  const isSelected = (f: NonNullable<Focus>) => selected?.kind === f.kind && selected.id === f.id
  const animate = clock.playing && !reducedMotion()
  const empty = loaded && model.events.length === 0

  return (
    <div className={css.page} data-playing={clock.playing || undefined}>
      <div className={css.toolbar}>
        <span className={css.facts}><IconUsersOutlineRegular size={13} />{t('facts', { agents: shownAgents.length, branches: model.branches.length, sandboxes: model.sandboxes.length })}</span>
        {agents.length > 1 ? (
          <label className={css.filter}><input type="checkbox" checked={onlyChat} onChange={(e) => setOnlyChat(e.target.checked)} />{t('thisChat')}</label>
        ) : null}
        <span className={css.spacer} />
        <Button variant="ghost" size="sm" aria-label={clock.playing ? t('pause') : t('play')} disabled={model.duration === 0}
          icon={clock.playing ? <IconPauseOutlineRegular size={14} /> : <IconPlayOutlineRegular size={14} />} onClick={clock.toggle} />
        <input className={css.scrub} type="range" min={0} max={Math.max(0.1, model.duration)} step={0.1} value={Math.min(clock.t, model.duration)}
          aria-label={t('scrub')} disabled={model.duration === 0} onChange={(e) => clock.scrub(Number(e.target.value))} />
        <span className={css.time}>{stamp(clock.t)} / {stamp(model.duration)}</span>
        <Button variant={clock.live ? 'outline' : 'ghost'} size="sm" disabled={model.duration === 0} onClick={clock.goLive} aria-pressed={clock.live}>
          <span className={clsx(css.liveDot, clock.live && clock.playing && css.liveOn)} aria-hidden />{t('live')}
        </Button>
        <Button variant="ghost" size="sm" disabled={model.duration === 0} onClick={clock.replay}>{t('replay')}</Button>
      </div>

      <div className={css.flow} ref={graph} onMouseLeave={() => setHover(null)}>
        <svg className={css.wires} aria-hidden>
          {edges.map((edge) => {
            const d = paths[edge.id]
            if (!d) return null
            const running = active.some(edge.match)
            const ended = justEnded(events, clock.t, edge.match)
            const color = laneOf(model.branches, edge.branch)
            const muted = related !== null && !(related.has(edge.from) && related.has(edge.to))
            return (
              <g key={edge.id} style={{ color }} className={clsx(muted && css.wireMuted, ended && (ended.outcome === 'ok' ? css.wireOk : css.wireError))}>
                <path d={d} className={css.wire} />
                <path d={d} className={clsx(css.wireLit, (running || ended) && css.wireOn)} />
                {running && animate ? (
                  <circle r="3" className={css.packet}><animateMotion dur="1.4s" repeatCount="indefinite" path={d} /></circle>
                ) : null}
              </g>
            )
          })}
        </svg>

        <section className={css.column}>
          <div className={css.zone}><IconUsersOutlineRegular size={13} /><span>{t('agents')}</span><span className={css.count}>{shownAgents.length}</span></div>
          {shownAgents.map((agent) => {
            const s = agentStatus(agent)
            const f = { kind: 'agent', id: agent.id } as const
            return (
              <button key={agent.id} type="button" className={clsx(css.node, css.agent, s.running && css.nodeActive, dim(node('agent', agent.id)) && css.dim, isSelected(f) && css.selected)}
                style={{ marginLeft: Math.min(agent.depth, 3) * 14 }} data-flow-node={node('agent', agent.id)} {...hoverProps(f)}>
                <span className={css.nodeHead}>
                  <span className={css.avatar}>{name(agent).slice(0, 1).toUpperCase()}</span>
                  <span className={css.nodeName} title={name(agent)}>{name(agent)}</span>
                  {agent.id === sessionId && agents.length > 1 ? <span className={css.tag}>{t('thisChat')}</span> : null}
                  <span className={clsx(css.status, s.warn && css.warnText)}><i className={clsx(css.dot, s.live && css.dotLive)} />{s.text}</span>
                </span>
                <span className={css.nodeSub}>
                  {s.running ? <><span className={css.mono}>{s.running.method}</span><span className={css.right}>{(clock.t - s.running.start).toFixed(1)}s</span></>
                    : s.last ? <>{s.last.outcome === 'ok' ? <IconCheckOutlineRegular size={12} /> : <IconWarningOutlineRegular size={12} className={css.errorText} />}<span className={css.mono}>{s.last.method}</span>{s.last.turn ? <span className={css.right}>{t('turn', { n: s.last.turn })}</span> : null}</>
                    : <><IconBranchOutlineRegular size={12} /><span>{binding.branch ?? '—'}</span></>}
                </span>
              </button>
            )
          })}
        </section>

        <section className={css.column}>
          <div className={css.zone}><span>{t('layerfs')}</span></div>
          <div className={css.hub}>
            <div className={css.hubHead}><strong title={project}>{project.split('/').at(-1)}</strong><span className={css.muted}>{t('projectHistory')}</span></div>
            {model.branches.map((branch) => {
              const f = { kind: 'branch', id: branch } as const
              const busy = active.some((e) => e.branch === branch)
              const saves = events.filter((e) => e.branch === branch && e.method === 'workspace.commit' && e.end <= clock.t && e.outcome === 'ok').length
              return (
                <button key={branch} type="button" className={clsx(css.node, css.branch, busy && css.nodeActive, dim(node('branch', branch)) && css.dim, isSelected(f) && css.selected)}
                  style={{ borderLeftColor: laneOf(model.branches, branch) }} data-flow-node={node('branch', branch)} {...hoverProps(f)}>
                  <span className={css.nodeHead}><IconBranchOutlineRegular size={13} /><span className={css.nodeName} title={branch}>{branch}</span>{branch === binding.branch ? <span className={css.tag}>{t('thisChat')}</span> : null}</span>
                  {saves > 0 ? <span className={css.nodeSub}><IconCheckOutlineRegular size={12} />workspace.commit × {saves}</span> : null}
                </button>
              )
            })}
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
            if (box.closed) return <div key={box.name} className={css.retired}><IconCheckOutlineRegular size={13} />{t('closed', { name: box.name })}<span className={css.muted}>{t('closedNote')}</span></div>
            const live = binding.sandbox === box.name && binding.state === 'bound'
            return (
              <div key={box.name} className={clsx(css.box, dim(node('sandbox', box.name)) && css.dim)}>
                <button type="button" className={clsx(css.boxHead, isSelected(f) && css.selected)} data-flow-node={node('sandbox', box.name)} {...hoverProps(f)}>
                  <SandboxGlyph size={14} /><span className={css.nodeName} title={box.name}>{box.name}</span>
                  <span className={css.status}><i className={clsx(css.dot, live && css.dotLive)} />{live ? binding.executionState ?? 'active' : binding.sandbox === box.name ? binding.executionState ?? binding.state : '—'}</span>
                </button>
                <div className={css.boxMeta}>{box.machine ?? (binding.sandbox === box.name ? binding.machine : undefined) ?? t('machineUnknown')}<span>{t('workspaces', { n: box.workspaces.length })}</span></div>
                {box.workspaces.length === 0 ? <p className={css.muted}>{t('noWorkspaces')}</p> : box.workspaces.map((ws) => {
                  const wf = { kind: 'ws', id: ws.id } as const
                  const running = active.find((e) => e.ws === ws.id)
                  const last = events.filter((e) => e.ws === ws.id && e.end <= clock.t).at(-1)
                  const warn = last && last.outcome !== 'ok' && !running
                  return (
                    <button key={ws.id} type="button" className={clsx(css.node, css.ws, running && css.nodeActive, dim(node('ws', ws.id)) && css.dim, isSelected(wf) && css.selected)}
                      style={{ borderLeftColor: laneOf(model.branches, ws.branch) }} data-flow-node={node('ws', ws.id)} {...hoverProps(wf)}>
                      <span className={css.nodeHead}>
                        <span className={css.nodeName} title={ws.id}>{ws.name}</span>
                        <span className={clsx(css.status, warn && css.errorText)}>
                          {running ? <><i className={clsx(css.dot, css.dotLive)} />{running.method === 'workspace.exec' ? t('executing') : running.method === 'workspace.commit' ? t('saving') : t('calling')}</> : warn ? last!.outcome : t('mounted')}
                        </span>
                      </span>
                      <span className={css.nodeSub}><IconBranchOutlineRegular size={12} />{ws.branch ?? '—'}{running ? <span className={css.right}>{(clock.t - running.start).toFixed(1)}s</span> : last ? <span className={clsx(css.right, css.mono)}>{last.method}</span> : null}</span>
                    </button>
                  )
                })}
              </div>
            )
          })}
        </section>
      </div>

      <div className={css.inspector}>
        <div className={css.inspectorHead}>
          <span>{focusName ? t('following', { name: focusName }) : t('follow')}</span>
          {listed.length > EVENT_ROWS ? <span className={css.muted}>{t('callsShown', { n: EVENT_ROWS })}</span> : null}
        </div>
        {empty ? (
          <div className={css.emptyCalls}><p className={css.emptyTitle}>{t('noActivity')}</p><p className={css.muted}>{t('noActivityBody')}</p></div>
        ) : (
          <ol className={css.events}>
            {listed.slice(-EVENT_ROWS).reverse().map((e) => <EventRow key={e.id} e={e} t={t} now={clock.t} agent={agents.find((a) => a.id === e.agent)} name={name} />)}
          </ol>
        )}
      </div>
    </div>
  )
}

function EventRow({ e, t, now, agent, name }: { e: MapEvent, t: Translate, now: number, agent: MapAgent | undefined, name: (a: MapAgent) => string }): ReactNode {
  const running = e.end > now
  return (
    <li className={css.event}>
      <span className={clsx(css.eventIcon, !running && (e.outcome === 'ok' ? css.okText : css.errorText))}>
        {running ? <i className={clsx(css.dot, css.dotLive)} /> : e.outcome === 'ok' ? <IconCheckOutlineRegular size={13} /> : <IconWarningOutlineRegular size={13} />}
      </span>
      <time className={css.mono} dateTime={new Date(e.at).toISOString()} title={new Date(e.at).toLocaleString()}>{stamp(e.start)}</time>
      <span className={css.mono}>{e.method}</span>
      <span className={css.eventTarget}>{e.ws ?? e.branch ?? e.sandbox ?? ''}</span>
      {e.outcome !== 'ok' && !running ? <span className={css.errorText}>{e.outcome}</span> : null}
      <span className={css.eventOwner}>{agent ? name(agent) : ''}{e.turn ? ` · ${t('turn', { n: e.turn })}` : ''}</span>
    </li>
  )
}

export type { SandboxMapModel }
