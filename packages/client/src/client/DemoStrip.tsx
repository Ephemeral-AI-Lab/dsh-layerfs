// The demo strip above the composer, in the demo workspace's Sessions only:
// how far the run got (the mock model's steps of every agent, and the root
// agent's phase), the run speed (how fast the mock plays it, mock/src/pace.js;
// it applies to a run under way too), Sim or Live, and Play, which replays the
// demo in a new Session (demo.ts). A demo with checkpoints (#352) also shows
// their timeline, and Play or Replay first asks where the run starts: from
// the beginning or after a checkpoint the latest run reached
// (Checkpoints.tsx). Other Sessions render nothing.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { Button, IconPlayOutlineRegular, IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { api } from './api.ts'
import { demoApi, playDemo, SPEEDS, speedLabel, type Demo, type DemoInfo, type DemoMode, type DemoServices, type PlayStep } from './demo.ts'
import { useDemoSessionLock } from './lockdown.ts'
import { ProgressBar, jobFraction, jobText, useClock } from './Progress.tsx'
import { Checkpoints, StartPicker, checkpointText, startable } from './Checkpoints.tsx'

// while a run goes, and slower while waiting for one to start
const POLL_MS = 700, IDLE_POLL_MS = 2500
// a run whose root Session stopped between model requests is never told by
// the mock model; it reads as stopped once dsh says the Session is not
// running and no step has played for this long
const HALT_MS = 4000
const unsubscribed = () => () => {}
// the last Sim or Live choice, kept in this browser
const MODE_KEY = 'layerfs-demo-mode'
const savedMode = (): DemoMode => { try { return localStorage.getItem(MODE_KEY) === 'sim' ? 'sim' : 'live' } catch { return 'live' } }
const saveMode = (mode: DemoMode) => { try { localStorage.setItem(MODE_KEY, mode) } catch { /* the choice lasts this view only */ } }
const clock = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }

const playText = (step: PlayStep, now: number) => ({
  session: 'Starting a new session…',
  stop: 'Stopping the previous run…',
  init: step.step === 'init' && step.job ? `Preparing the project · ${jobText(step.job, now)}` : 'Preparing the project…',
  start: 'Starting the agents…',
})[step.step]

export interface DemoStripProps { sessionId: string, services: () => DemoServices }

export function DemoStrip({ sessionId, services }: DemoStripProps) {
  const [info, setInfo] = useState<DemoInfo | null>(null)
  const [demo, setDemo] = useState<Demo | null>(null)
  const [chosen, setMode] = useState<DemoMode>(savedMode)
  const [playing, setPlaying] = useState<PlayStep | null>(null)
  const [error, setError] = useState<string | null>(null)
  // the start picker: closed (null), or open with the chosen checkpoint (-1 = the beginning);
  // Replay opens it on the latest checkpoint a run can start after
  const [picking, setPicking] = useState<number | null>(null)
  // what Live LayerFS lacks on this host (its image or daemon); null until read
  const [liveMissing, setLiveMissing] = useState<string[] | null>(null)
  useEffect(() => {
    let on = true
    api.status().then((s) => { if (on) setLiveMissing(s.configured ? [] : s.missing) }, () => { /* unread: Live stays offered */ })
    return () => { on = false }
  }, [])

  useEffect(() => {
    let live = true
    demoApi.info().then((found) => {
      if (!live || !found) return
      setInfo(found)
      setDemo(found.demos.find((d) => d.sessionId === sessionId) ?? null)
    }, () => { /* without the route this Session has no strip */ })
    return () => { live = false }
  }, [sessionId])

  const run = demo?.run && demo.run.root === sessionId ? demo.run : null
  const running = run?.state === 'running'
  useEffect(() => {
    if (!demo) return
    const timer = setInterval(() => { demoApi.demo(demo.id).then(setDemo, () => { /* the next read tries again */ }) }, running ? POLL_MS : IDLE_POLL_MS)
    return () => clearInterval(timer)
  }, [demo?.id, running])
  const now = useClock(running || playing !== null)
  useDemoSessionLock(demo ? sessionId : null)
  const status = services().uiSession?.sessionStatus
  const rootRunning = useSyncExternalStore(status?.subscribe ?? unsubscribed, () => status?.getSnapshot().get(sessionId)?.running)
  const [movedAt, setMovedAt] = useState(Date.now)
  useEffect(() => { setMovedAt(Date.now()) }, [run?.done, rootRunning])
  const halted = running && rootRunning === false && now - movedAt > HALT_MS

  if (!info || !demo) return null
  // the checkpoints this Session's run reached; none before it runs
  const checkpoints = demo.checkpoints?.length
    ? demo.checkpoints.map((c) => (run ? c : { ...c, reachedAt: null }))
    : null
  // a replayed run's demo plays on Live LayerFS only; a host without Live plays Sim
  const liveOff = !!liveMissing?.length
  const mode: DemoMode = demo.live ? 'live' : liveOff ? 'sim' : chosen

  const play = (startAfter: string | null = null) => {
    setError(null)
    setPicking(null)
    setPlaying({ step: 'session' })
    // either way the demo's record is read again at once: its Session and run
    const refresh = () => demoApi.demo(demo.id).then(setDemo, () => { /* the next poll reads it */ })
    playDemo(services(), info, demo, mode, setPlaying, startAfter).then(
      () => { setPlaying(null); void refresh() },
      (failure) => { setPlaying(null); setError(failure instanceof Error ? failure.message : String(failure)); void refresh() },
    )
  }

  let fraction: number | null = 0, line: string
  if (playing) {
    fraction = playing.step === 'init' && playing.job ? jobFraction(playing.job) : null
    line = playText(playing, now)
  } else if (run) {
    fraction = run.of ? run.done / run.of : 0
    const steps = `${run.done} of ${run.of} steps${checkpoints ? ` · ${checkpointText(checkpoints)}` : ''}`
    line = halted ? `Stopped · ${steps} · the session is not running`
      : run.state === 'running' ? `${run.phase ?? 'Running'} · ${steps} · ${clock(now - run.started)}`
      : run.state === 'done' ? `Finished · ${steps} · ${clock((run.ended ?? now) - run.started)}`
        : `Stopped · ${run.error ?? ''}`
  } else {
    line = `${demo.agents.length} agent${demo.agents.length === 1 ? '' : 's'} · ready to play`
  }

  const choice = (value: DemoMode, label: string) => {
    const off = value === 'live' && liveOff && !demo.live
    return (
      <button type="button" aria-pressed={mode === value} disabled={off} onClick={() => { setMode(value); saveMode(value) }}
        title={off ? `Live LayerFS is not set up on this host: set ${liveMissing!.join(' and ')} for layerfs-host in the profile patch` : undefined}
        style={{ border: 0, padding: '2px 10px', font: 'inherit', fontSize: 12, cursor: off ? 'not-allowed' : 'pointer', opacity: off ? 0.45 : 1, color: 'inherit', background: mode === value ? 'color-mix(in srgb, currentColor 14%, transparent)' : 'transparent' }}>{label}</button>
    )
  }
  const pace = (value: number) => (
    <button type="button" key={value} aria-pressed={demo.speed === value} onClick={() => { demoApi.setSpeed(demo.id, value as typeof SPEEDS[number]).then(setDemo, (e: Error) => setError(e.message)) }}
      title={value ? (value > 1 ? `The demo's pauses and typing ÷ ${value}` : "The demo's own pauses and typing") + '; commands take their own time' : 'No pauses or typing; commands take their own time'}
      style={{ border: 0, padding: '2px 8px', font: 'inherit', fontSize: 12, cursor: 'pointer', color: 'inherit', background: demo.speed === value ? 'color-mix(in srgb, currentColor 14%, transparent)' : 'transparent' }}>{speedLabel(value)}</button>
  )
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 6, margin: '0 0 6px', padding: '8px 12px', borderRadius: 10, border: '1px solid color-mix(in srgb, currentColor 12%, transparent)' }}>
      <ProgressBar fraction={fraction} />
      {checkpoints ? <Checkpoints checkpoints={checkpoints} running={running && !halted} onPick={(i) => setPicking(i)} /> : null}
      {checkpoints && picking !== null ? (
        <StartPicker checkpoints={checkpoints} chosen={picking < 0 ? null : picking} onChoose={(i) => setPicking(i ?? -1)}
          onCancel={() => setPicking(null)} onStart={() => play(picking < 0 ? null : checkpoints[picking].label)} />
      ) : null}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: error || halted || run?.state === 'stopped' ? 'var(--dsh-color-fg-danger, #d14343)' : 'var(--dsh-color-fg-muted, inherit)' }}
          title={error ?? line}>{error ?? line}</span>
        <span role="group" aria-label="Run speed" style={{ display: 'inline-flex', borderRadius: 8, overflow: 'hidden', border: '1px solid color-mix(in srgb, currentColor 18%, transparent)' }}>
          {SPEEDS.map(pace)}
        </span>
        <span role="group" aria-label="LayerFS" style={{ display: 'inline-flex', borderRadius: 8, overflow: 'hidden', border: '1px solid color-mix(in srgb, currentColor 18%, transparent)' }}>
          {demo.live ? null : choice('sim', 'Sim')}{choice('live', 'Live')}
        </span>
        {/* Replay works mid-run too: the old Session is archived with its work stopped */}
        <Button variant="secondary" size="sm" disabled={playing !== null}
          onClick={() => (checkpoints && startable(checkpoints).length ? setPicking(picking === null ? startable(checkpoints).at(-1)! : null) : play())}
          title={running ? 'Stop this run and play the demo again' : undefined}
          icon={run ? <IconRefreshOutlineRegular size={14} /> : <IconPlayOutlineRegular size={14} />}>{run ? 'Replay' : 'Play'}</Button>
      </div>
    </div>
  )
}
