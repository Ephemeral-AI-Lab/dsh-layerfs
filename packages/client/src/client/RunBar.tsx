// The Run bar above the composer, in a Session that plays a scenario of the
// LayerFS scripted model (its run's root Session) only; other Sessions, and
// every Session while the plugin is off, render nothing. One line: Stop or
// Run again (a new run starts in a new Session), and how far the run got
// with a thin bar. A failed run says where it stopped and which
// project it left for a look.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { Button, IconPlayOutlineRegular, IconStopFillRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { ProgressBar, jobFraction, jobText, useClock } from './Progress.tsx'
import { mockApi, projectOf, runText, startRun, stopRun, type MockInfo, type RunServices, type SessionRun, type StartStep } from './scenarios.ts'
import { T } from './tokens.ts'

// while a run goes, and slower once it ended
const POLL_MS = 700, IDLE_POLL_MS = 3000
// a run whose root Session stopped between model requests is never told by
// the scripted model; it reads as stopped once dsh says the Session is not
// running and no step has played for this long
const HALT_MS = 4000
const unsubscribed = () => () => {}

export const startText = (step: StartStep, now: number) => ({
  session: 'Starting a new session…',
  project: 'Removing the previous run’s project…',
  init: step.step === 'init' && step.job ? `Preparing the project · ${jobText(step.job, now)}` : 'Preparing the project…',
  start: 'Starting the agents…',
})[step.step]

export interface RunServicesWithStatus extends RunServices {
  /** dsh's Session status, for whether a run's root Session still runs */
  uiSession?: { sessionStatus: { getSnapshot(): ReadonlyMap<string, { running?: boolean }>, subscribe(listener: () => void): () => void } }
}
export interface RunBarProps { sessionId: string, services: () => RunServicesWithStatus }

export function RunBar({ sessionId, services }: RunBarProps) {
  const [info, setInfo] = useState<MockInfo | null>(null)
  const [played, setPlayed] = useState<SessionRun | null>(null)
  const [starting, setStarting] = useState<StartStep | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    Promise.all([mockApi.session(sessionId), mockApi.info()]).then(([found, all]) => {
      if (!live || !found || !all) return
      setPlayed(found)
      setInfo(all)
    }, () => { /* without the route this Session has no bar */ })
    return () => { live = false }
  }, [sessionId])

  const run = played?.run?.sessionId === sessionId ? played.run : null
  const running = run?.state === 'running'
  useEffect(() => {
    if (!played) return
    const timer = setInterval(() => { mockApi.session(sessionId).then((found) => found && setPlayed(found), () => { /* the next read tries again */ }) }, running ? POLL_MS : IDLE_POLL_MS)
    return () => clearInterval(timer)
  }, [played?.scenario, running, sessionId])
  const now = useClock(running || starting !== null)
  const status = services().uiSession?.sessionStatus
  const rootRunning = useSyncExternalStore(status?.subscribe ?? unsubscribed, () => status?.getSnapshot().get(sessionId)?.running)
  const [movedAt, setMovedAt] = useState(Date.now)
  useEffect(() => { setMovedAt(Date.now()) }, [run?.done, rootRunning])
  const halted = running && rootRunning === false && now - movedAt > HALT_MS

  if (!info || !played) return null
  const scenario = info.scenarios.find((s) => s.id === played.scenario)
  if (!scenario) return null

  const again = () => {
    setError(null)
    setStarting({ step: 'session' })
    startRun(services(), info, scenario, setStarting).then(
      () => setStarting(null),
      (failure) => { setStarting(null); setError(failure instanceof Error ? failure.message : String(failure)) },
    )
  }
  const stop = () => { stopRun(services(), sessionId).catch((failure) => setError(failure instanceof Error ? failure.message : String(failure))) }

  let fraction: number | null = 0, line: string, failed = false
  if (starting) {
    fraction = starting.step === 'init' && starting.job ? jobFraction(starting.job) : null
    line = startText(starting, now)
  } else if (run) {
    fraction = run.of ? run.done / run.of : 0
    failed = run.state === 'failed' || halted
    line = halted ? `Stopped at step ${run.done} of ${run.of} · the session is not running` : runText(run, now)
  } else {
    line = 'Not run yet'
  }
  const detail = !starting && run?.state === 'failed' ? `${run.error ?? 'Failed'} · project ${projectOf(scenario.id)} kept` : null

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 6, margin: '0 0 6px', padding: '8px 12px', borderRadius: 10, border: '1px solid color-mix(in srgb, currentColor 12%, transparent)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, flexWrap: 'wrap' }}>
        {running && !halted
          ? <Button variant="secondary" size="sm" onClick={stop} icon={<IconStopFillRegular size={14} />}>Stop</Button>
          : <Button variant="secondary" size="sm" disabled={starting !== null} onClick={again} icon={<IconPlayOutlineRegular size={14} />}>Run again</Button>}
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: error || failed ? T.danger : T.text2 }} title={error ?? line}>{error ?? line}</span>
      </div>
      <ProgressBar fraction={fraction} />
      {detail ? <div style={{ fontSize: 12, color: T.text2, overflowWrap: 'anywhere' }}>{detail}</div> : null}
    </div>
  )
}
