// The LayerFS page's Runs tab: plays a recorded history replay run (layerfs
// #352) in the shared view, from its SDK traces alone. The Host lists the runs
// in its runs folder and serves each traced range's lines with their agents
// (runs.js); every range of the chosen run (its latest attempt) is read, and
// the lines play on one timeline (runplayer.ts): Play and Pause, a speed, a
// slider to any point, and a chip per range that moves to its start, coloured
// by the range's gate verdict. Idle gaps over MAX_GAP_MS are cut. A trace holds
// ids, never content, so every Files read answers NO_FILES; Work and History
// draw as for a session.
import { useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import FM from '../../../../sim/simulation_engine/files.js'
import M from '../../../../sim/simulation_engine/model.js'
import * as X from '../../../model/src/index.js'
import { createFilesSource, createView, injectStyle } from '../../../view/src/index.js'
import { api, type Run, type RunRange, type RunTrace } from './api.ts'
import { CASTS, MAID_AVATARS } from './avatars.ts'
import { clock, MAX_GAP_MS, RunPlayer, schedule, SPEEDS, type RunStep } from './runplayer.ts'
import { followTheme } from './theme.ts'
import { card, T } from './tokens.ts'

const FRAME_MS = 100
const NO_FILES = "Files are not in a recorded run: its trace holds ids, never file content."
type Pane = 'work' | 'history'

/** The latest attempt of each traced range, in range order. */
const latest = (ranges: RunRange[]) => [...new Map(ranges.map((r) => [r.range, r])).values()].sort((a, b) => a.range - b.range)
const verdictColour = (v: string | null) => v === 'pass' ? T.ok : v === 'watch' || v === 'optimize' ? T.warn : v === 'stop' ? T.danger : T.caption
const when = (iso: string | null) => iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''

/** A run's traces read, its timeline and agents. */
interface Loaded { run: Run, traces: RunTrace[], timeline: { steps: RunStep[], duration: number }, agents: string[] }

export function RunsPage() {
  const [runs, setRuns] = useState<{ dir: string, runs: Run[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [reading, setReading] = useState<string | null>(null)

  useEffect(() => {
    api.runs().then((r) => { setRuns(r); setSelected((s) => s ?? r.runs[0]?.id ?? null) }, (e: Error) => setError(e.message))
  }, [])

  // every traced range of the chosen run, one read at a time
  useEffect(() => {
    const run = runs?.runs.find((r) => r.id === selected)
    if (!run) return
    let stopped = false
    setLoaded(null); setError(null)
    ;(async () => {
      const ranges = latest(run.ranges), traces: RunTrace[] = []
      for (const [i, r] of ranges.entries()) {
        setReading(`Reading range ${r.range} (${i + 1} of ${ranges.length})…`)
        traces.push(await api.runTrace(run.id, r.range, r.attempt))
        if (stopped) return
      }
      const lines = traces.flatMap((t) => t.lines.map((l) => ({ ...l, range: t.range })))
      const agents = [...new Set(['main', ...traces.flatMap((t) => t.agents), ...lines.map((l) => l.agent)])]
      setLoaded({ run, traces, timeline: schedule(lines), agents })
    })().catch((e: Error) => { if (!stopped) setError(e.message) }).finally(() => { if (!stopped) setReading(null) })
    return () => { stopped = true }
  }, [runs, selected])

  if (!runs) return <div style={{ color: error ? T.danger : T.text2 }}>{error ?? 'Reading recorded runs…'}</div>
  if (!runs.runs.length) {
    return (
      <div style={{ ...card, padding: 16, display: 'grid', gap: 4 }}>
        <div style={{ fontWeight: 500 }}>No recorded runs</div>
        <div style={{ color: T.text2 }}>The history replay writes a run's traces in measured mode, under <code>{runs.dir}</code>. Set <code>runs</code> for layerfs-host to read another folder.</div>
      </div>
    )
  }
  return (
    <div style={{ flex: 1, minHeight: 560, display: 'grid', gridTemplateColumns: '232px minmax(0, 1fr)', gap: 12 }}>
      <nav aria-label="Recorded runs" style={{ ...card, overflowY: 'auto', padding: 4, display: 'grid', alignContent: 'start', gap: 2 }}>
        {runs.runs.map((r) => (
          <button key={r.id} type="button" className="lfs-switch" aria-current={r.id === selected} onClick={() => setSelected(r.id)} title={`${r.id} · ${r.ranges.length} traced range attempt${r.ranges.length === 1 ? '' : 's'}`}
            style={{ display: 'grid', gap: 2, padding: '6px 8px', border: 0, borderRadius: T.sm, color: 'inherit', font: 'inherit', textAlign: 'left', background: r.id === selected ? T.active : undefined }}>
            <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.id}</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: T.text2 }}>
              {[r.phase, r.label, when(r.created)].filter(Boolean).join(' · ')}
              <span style={{ flex: 1 }} />
              {latest(r.ranges).map((x) => <span key={x.range} title={`range ${x.range}: ${x.verdict ?? 'no verdict'}`} style={{ width: 6, height: 6, borderRadius: 3, background: verdictColour(x.verdict) }} />)}
            </span>
          </button>
        ))}
      </nav>
      <section style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0, minHeight: 0 }}>
        {error && <div role="status" style={{ color: T.danger }}>{error}</div>}
        {loaded && loaded.run.id === selected
          ? <Player key={loaded.run.id} loaded={loaded} />
          : !error && <div style={{ ...card, flex: 1, padding: 16, color: T.text2 }}>{reading ?? 'Reading the run…'}</div>}
      </section>
    </div>
  )
}

function Player({ loaded }: { loaded: Loaded }) {
  const { run, traces, timeline, agents } = loaded
  const host = useRef<HTMLDivElement>(null)
  const board = useRef<any>(null)
  const player = useRef<RunPlayer | null>(null)
  const [pane, setPane] = useState<Pane>('work')
  const [position, setPosition] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [step, setStep] = useState<RunStep | null>(null)

  /** Draws the model after a step (its agent acting) or after a jump. */
  const show = (W: any, st: RunStep | null) => {
    const b = board.current
    if (!b) return
    if (st) b.avatar(st.a); else for (const a of agents) b.avatar(a)
    b.W = W
    b.acting = st ? [st.a] : []
    if (st) b.lastLoc = X.locKey(X.where(W, st.a))
    if (b.follow && W.lastTab) b.active = W.lastTab
    const p = player.current, at = p?.current ?? null
    b.note = `${run.id}${at?.range != null ? ` · range ${at.range}` : ''} · step ${p?.index ?? 0} of ${timeline.steps.length}${at ? ` · ${clock(at.real)} into the run` : ''}`
    b.render()
    if (st) b.animate(st.a)
    setStep(at)
  }

  // one player per run; the view, per pane, draws its model. Files reads all answer NO_FILES.
  const files = useRef<ReturnType<typeof createFilesSource> | null>(null)
  files.current ??= createFilesSource(() => Promise.reject(new Error(NO_FILES)), () => board.current?.rerender?.())
  if (!player.current) {
    player.current = new RunPlayer(timeline, () => {
      const engine: any = new X.ReplayEngine({ project: run.project ?? run.id, files: files.current })
      engine.onchange = () => board.current?.rerender?.()
      return X.storyView(engine, { lead: 'main' })
    }, show)
  }
  useEffect(() => {
    injectStyle(document)
    const root = host.current!
    let soon: ReturnType<typeof setTimeout> | undefined
    board.current = createView(root, { avatars: MAID_AVATARS, casts: CASTS, files: FM, lineDiff: M.lineDiff, live: false, lead: 'main', pane })
    board.current.rerender = () => { clearTimeout(soon); soon = setTimeout(() => board.current?.W && board.current.render(), 40) }
    const unfollow = followTheme(root)
    show(player.current!.W, null)
    return () => { clearTimeout(soon); unfollow(); board.current.dispose(); board.current = null }
  }, [pane])
  useEffect(() => () => { player.current?.pause() }, [])

  // the clock: wall time while playing, FRAME_MS a frame
  useEffect(() => {
    if (!playing) return
    let last = performance.now()
    const timer = setInterval(() => {
      const now = performance.now(), p = player.current!
      void p.advance(now - last).then(() => { setPosition(p.position); if (!p.playing) setPlaying(false) })
      last = now
    }, FRAME_MS)
    return () => clearInterval(timer)
  }, [playing])

  const p = player.current
  const seek = (t: number) => { void p.seek(t).then(() => setPosition(p.position)) }
  const toggle = () => { if (p.playing) p.pause(); else p.play(); setPlaying(p.playing) }
  const range = step?.range ?? traces[0]?.range
  const current = traces.find((t) => t.range === range) ?? null
  return (
    <>
      <header style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, minWidth: 0 }}>
        <span role="tablist" aria-label="Pane" style={{ display: 'flex', gap: 2 }}>
          {(['work', 'history'] as Pane[]).map((x) => (
            <button key={x} type="button" role="tab" aria-selected={pane === x} className="lfs-switch lfs-tab" onClick={() => setPane(x)}
              style={{ padding: '0 8px', border: 0, borderRadius: T.sm, color: 'inherit', font: 'inherit', fontWeight: 500, lineHeight: '28px' }}>{x === 'work' ? 'Work' : 'History'}</button>
          ))}
        </span>
        <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {traces.map((t) => (
            <button key={t.range} type="button" className="lfs-chip" onClick={() => { const at = p.startOf(t.range); if (at !== null) seek(at) }}
              title={`Range ${t.range}, attempt ${t.attempt}: ${t.lines.length} calls${t.plan ? `, ${t.plan.lanes.length} lanes, ${t.plan.steps} plan steps, ${t.plan.conflicts} planned conflicts` : ''}. Gate: ${t.verdict ?? 'no verdict'}${t.reason ? ` (${t.reason})` : ''}. Click to go to its start.`}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '0 8px', border: `1px solid ${t.range === range ? T.text : T.border}`, borderRadius: T.sm, color: 'inherit', font: 'inherit', fontSize: 12, lineHeight: '22px' }}>
              <span style={{ width: 8, height: 8, borderRadius: 4, background: verdictColour(t.verdict) }} />r{t.range}{t.attempt > 1 ? `.a${t.attempt}` : ''}
            </button>
          ))}
        </span>
        <span style={{ flex: 1 }} />
        {current?.plan?.checkpoint && <span style={{ fontSize: 12, color: T.text2 }} title={`range ${current.range}'s checkpoint: ${current.plan.checkpoint}`}>checkpoint {current.plan.checkpoint.slice(0, 8)}</span>}
      </header>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <Button variant="primary" size="sm" onClick={toggle} disabled={!timeline.steps.length}>{playing ? 'Pause' : p.ended ? 'Replay' : 'Play'}</Button>
        <span role="group" aria-label="Speed" style={{ display: 'flex', gap: 2 }}>
          {SPEEDS.map((s) => (
            <button key={s} type="button" className="lfs-chip" aria-pressed={speed === s} onClick={() => { p.setSpeed(s); setSpeed(s) }}
              style={{ padding: '0 6px', border: 0, borderRadius: T.sm, color: speed === s ? T.text : T.text2, font: 'inherit', fontSize: 12, fontWeight: speed === s ? 600 : 400, lineHeight: '22px' }}>{s}×</button>
          ))}
        </span>
        <input type="range" aria-label="Position" min={0} max={Math.max(1, timeline.duration)} step={FRAME_MS} value={position}
          onChange={(e) => seek(Number(e.currentTarget.value))} style={{ flex: 1, minWidth: 80 }} />
        <span style={{ fontSize: 12, color: T.text2, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}
          title={`Idle gaps over ${MAX_GAP_MS / 1000} s are cut. The run's own time at this step: ${clock(step?.real ?? 0)} of ${clock(timeline.steps.at(-1)?.real ?? 0)}.`}>
          {clock(position)} / {clock(timeline.duration)}
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 480, borderRadius: T.md, overflow: 'hidden', border: `1px solid ${T.border}` }}>
        <div ref={host} style={{ position: 'relative', height: '100%' }} />
      </div>
    </>
  )
}
