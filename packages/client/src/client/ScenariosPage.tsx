// The LayerFS page's Scenarios tab, shown while the LayerFS scripted model's
// plugin is on: every scenario with its latest run on LayerFS. Run all queues
// every scenario and starts them a few at a time (MAX_RUNS in scenarios.ts).
// Each run gets a Session of its own in the Scenarios workspace, opened from
// its row. A failed run shows why and keeps its project for a look; Clean up
// removes the scenario projects no run is using. A run over the Host's time
// limit is cancelled once from here.
import { useEffect, useRef, useState } from 'react'
import { Button, IconPlayOutlineRegular, IconStopFillRegular, IconTrashOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { api } from './api.ts'
import { jobText, useClock } from './Progress.tsx'
import { isScenarioProject, mockApi, nextStarts, projectOf, runText, startRun, stopRun, type MockInfo, type RunServices, type Scenario, type ScenarioRun, type StartStep } from './scenarios.ts'
import { card, T } from './tokens.ts'

const POLL_MS = 1000, IDLE_POLL_MS = 4000
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

export interface ScenariosPageProps { services: () => RunServices }

export function ScenariosPage({ services }: ScenariosPageProps) {
  const [info, setInfo] = useState<MockInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [queue, setQueue] = useState<string[]>([])
  const [starting, setStarting] = useState<Record<string, StartStep>>({})
  const [failures, setFailures] = useState<Record<string, string>>({})
  const [leftovers, setLeftovers] = useState<string[]>([])
  const [cleaning, setCleaning] = useState<string | null>(null)
  // runs this view cancelled for the time limit, so each is cancelled once
  const cancelled = useRef(new Set<string>())

  const read = () => mockApi.info().then((i) => { setInfo(i); setError(null); return i }, (e) => { setError(message(e)); return null })
  const readLeftovers = () => api.projects().then(({ projects }) => setLeftovers(projects.map((p) => p.name).filter(isScenarioProject)), () => { /* the next read tries again */ })
  useEffect(() => { void read(); void readLeftovers() }, [])

  const runs = (info?.scenarios ?? []).map((s) => ({ s, run: s.run }))
  // each run once: one being started is also running once its first read lands
  const going = () => new Set([...runs.filter((r) => r.run?.state === 'running').map((r) => r.s.id), ...Object.keys(starting)]).size
  const busy = queue.length > 0 || Object.keys(starting).length > 0 || runs.some((r) => r.run?.state === 'running')
  const now = useClock(Object.keys(starting).length > 0)

  useEffect(() => {
    const timer = setInterval(() => { void read() }, busy ? POLL_MS : IDLE_POLL_MS)
    return () => clearInterval(timer)
  }, [busy])

  // a run over the Host's time limit: its root Session is cancelled once
  useEffect(() => {
    for (const { run } of runs) {
      if (!run?.timedOut || cancelled.current.has(run.sessionId)) continue
      cancelled.current.add(run.sessionId)
      stopRun(services(), run.sessionId).catch(() => { /* the run is already failed; its Session may have stopped */ })
    }
  }, [info])

  const start = (scenario: Scenario) => {
    const k = scenario.id
    if (!info || starting[k]) return
    setFailures(({ [k]: _, ...rest }) => rest)
    setStarting((all) => ({ ...all, [k]: { step: 'session' } }))
    startRun(services(), info, scenario, (step) => setStarting((all) => (k in all ? { ...all, [k]: step } : all)), false).then(
      () => undefined,
      (e) => setFailures((all) => ({ ...all, [k]: message(e) })),
    ).finally(async () => {
      // read first: the run counts as going until the read shows it running
      await read()
      setStarting(({ [k]: _, ...rest }) => rest)
      void readLeftovers()
    })
  }

  // the queue: start what fits whenever a run ends or a read lands
  useEffect(() => {
    if (!info || !queue.length) return
    const ready = nextStarts(queue, going())
    if (!ready.length) return
    setQueue((q) => q.filter((k) => !ready.includes(k)))
    for (const id of ready) {
      const scenario = info.scenarios.find((s) => s.id === id)
      if (scenario) start(scenario)
    }
  }, [info, queue, starting])

  const runAll = () => {
    if (!info) return
    const wanted = info.scenarios.filter((s) => s.run?.state !== 'running' && !starting[s.id]).map((s) => s.id)
    setQueue((q) => [...q.filter((k) => !wanted.includes(k)), ...wanted])
  }
  const stopAll = () => {
    setQueue([])
    for (const { run } of runs) {
      if (run?.state === 'running') stopRun(services(), run.sessionId).catch((e) => setError(message(e)))
    }
  }
  const inUse = new Set(runs.filter((r) => r.run?.state === 'running').map((r) => projectOf(r.s.id)).concat(Object.keys(starting).map(projectOf)))
  const removable = leftovers.filter((name) => !inUse.has(name))
  const cleanUp = async () => {
    for (const name of removable) {
      setCleaning(`Removing ${name}…`)
      try { await api.remove(name, true) } catch (e) { setError(`${name}: ${message(e)}`); break }
    }
    setCleaning(null)
    void readLeftovers()
  }

  if (error && !info) return <div role="status" style={{ color: T.danger }}>{error}</div>
  if (!info) return <div role="status" style={{ color: T.text2 }}>Reading the scenarios…</div>

  const offered = info.scenarios
  const waiting = (s: Scenario) => !!starting[s.id] || queue.includes(s.id)
  const count = (state: ScenarioRun['state']) => offered.filter((s) => s.run?.state === state && !waiting(s)).length
  const queued = queue.length
  const summary = [
    `${count('passed')} passed`, `${count('failed')} failed`, `${going()} running`,
    ...(queued ? [`${queued} queued`] : []), `${offered.filter((s) => !s.run && !waiting(s)).length} not run`,
  ].join(' · ')
  const anyGoing = queued > 0 || going() > 0

  const cell = (s: Scenario) => {
    const k = s.id, step = starting[k], run = s.run
    if (step) return <span style={{ color: T.text2 }}>{step.step === 'init' && step.job ? `Preparing · ${jobText(step.job, now)}` : 'Starting…'}</span>
    if (queue.includes(k)) return <span style={{ color: T.text2 }}>Queued</span>
    if (!run) return <span style={{ color: T.caption }}>Not run</span>
    const colour = run.state === 'passed' ? T.ok : run.state === 'failed' ? T.danger : T.text2
    return (
      <button type="button" className="lfs-switch" onClick={() => services().uiWorkspace?.openSession(run.sessionId)} title="Open this run's session"
        style={{ border: 0, padding: '0 4px', margin: '0 -4px', borderRadius: T.sm, font: 'inherit', textAlign: 'left', color: colour }}>{runText(run)}</button>
    )
  }

  return (
    <div style={{ display: 'grid', gap: 10, alignContent: 'start' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Button variant="primary" size="sm" icon={<IconPlayOutlineRegular size={14} />} disabled={!offered.length} onClick={runAll}>Run all</Button>
        <Button variant="outline" size="sm" icon={<IconStopFillRegular size={14} />} disabled={!anyGoing} onClick={stopAll}>Stop all</Button>
        <span style={{ flex: 1 }} />
        {removable.length > 0 && (
          <Button variant="ghost" size="sm" icon={<IconTrashOutlineRegular size={14} />} disabled={!!cleaning} onClick={() => void cleanUp()}
            title={removable.join(', ')}>{`Clean up ${removable.length} ${removable.length === 1 ? 'project' : 'projects'}`}</Button>
        )}
      </div>
      <div style={{ fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)', fontSize: 12, color: T.text2 }}>{summary}</div>
      {(error || cleaning) && <div role="status" style={{ color: error ? T.danger : T.text2 }}>{error ?? cleaning}</div>}
      <div style={{ ...card, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 13em) auto', columnGap: 16, alignItems: 'start', padding: '4px 0' }}>
        {['Scenario', 'Latest run', ''].map((h, i) => (
          <div key={i} style={{ padding: '6px 12px', fontSize: 12, color: T.caption, borderBottom: `1px solid ${T.border}` }}>{h}</div>
        ))}
        {info.scenarios.map((s) => {
          const k = s.id, run = s.run, failure = failures[k] ?? (run?.state === 'failed' && !starting[k] ? run.error : null)
          const runningHere = run?.state === 'running' && !starting[k]
          return (
            <div key={s.id} style={{ display: 'contents' }}>
              <div style={{ padding: '8px 12px', minWidth: 0 }}>
                <div style={{ fontWeight: 500 }}>{s.title}</div>
                {s.blurb && <div style={{ fontSize: 12, color: T.text2 }}>{s.blurb}</div>}
                <div style={{ fontSize: 12, color: T.caption }}>{s.agents.length === 1 ? 'one agent' : `${s.agents.length} agents`}</div>
                {failure && <div style={{ fontSize: 12, color: T.danger, overflowWrap: 'anywhere', marginTop: 4 }}>{failure}{failures[k] ? '' : ` · project ${projectOf(s.id)} kept`}</div>}
              </div>
              <div style={{ padding: '8px 12px', fontSize: 12, minWidth: 0 }}>{cell(s)}</div>
              <div style={{ padding: '6px 12px' }}>
                {runningHere
                  ? <Button variant="ghost" size="sm" aria-label={`Stop ${s.title}`} icon={<IconStopFillRegular size={14} />} onClick={() => stopRun(services(), run!.sessionId).catch((e) => setError(message(e)))}>Stop</Button>
                  : <Button variant="ghost" size="sm" aria-label={`Run ${s.title}`} icon={<IconPlayOutlineRegular size={14} />}
                      disabled={!!starting[k] || queue.includes(k)} onClick={() => start(s)}>Run</Button>}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
