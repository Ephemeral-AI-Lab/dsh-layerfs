// The LayerFS page's Tests tab, shown while the LayerFS scripted model's
// plugin is on: every scenario (a test) with its latest run on LayerFS and a
// status icon, its tags as chips and what the loader counted; a long
// description shows two lines until clicked. Tags are pastel chips in the
// board's Branch hues, and Ellen's face says how the tests shown went. The tag row filters the list (a scenario
// shows when it has every chosen tag); Run all queues the scenarios shown and
// starts them a few at a time (MAX_RUNS in scenarios.ts).
// Each run gets a Session of its own in the Scenarios workspace, opened from
// its row. A failed run shows why and keeps its project for a look; Clean up
// removes the scenario projects no run is using. A run over the Host's time
// limit is cancelled once from here.
import { useEffect, useRef, useState } from 'react'
import {
  Button,
  IconCheckCircleFillRegular,
  IconCloseCircleFillRegular,
  IconLoadingOutlineRegular,
  IconPlayOutlineRegular,
  IconStopFillRegular,
  IconTrashOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { api } from './api.ts'
import { jobText, useClock } from './Progress.tsx'
import {
  allTags,
  isScenarioProject,
  mockApi,
  nextStarts,
  projectOf,
  runText,
  startRun,
  stopRun,
  withTags,
  type MockInfo,
  type RunServices,
  type Scenario,
  type ScenarioRun,
  type StartStep,
} from './scenarios.ts'
import { Ellen, hueOf, type Pose } from './maid.tsx'
import { card, T } from './tokens.ts'

const POLL_MS = 1000,
  IDLE_POLL_MS = 4000
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
const TAGS_KEY = 'layerfs-scenarios-tags'
const savedTags = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(TAGS_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((t) => typeof t === 'string') : []
  } catch {
    return []
  }
}
const saveTags = (tags: string[]) => {
  try {
    localStorage.setItem(TAGS_KEY, JSON.stringify(tags))
  } catch {
    /* the filter lasts this view only */
  }
}

/** One tag as a pastel chip in its hue; filled while it filters the list. */
function Chip({ tag, on, onClick }: { tag: string; on: boolean; onClick: () => void }) {
  const hue = hueOf(tag)
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      title={on ? `Showing tests tagged ${tag}; click to stop filtering by it` : `Show only tests tagged ${tag}`}
      style={{
        border: `1px solid color-mix(in srgb, ${hue} ${on ? 100 : 35}%, transparent)`,
        borderRadius: 999,
        padding: '0 9px',
        font: 'inherit',
        fontSize: 11,
        fontWeight: 500,
        lineHeight: '18px',
        cursor: 'pointer',
        color: on ? '#fff' : `color-mix(in srgb, ${hue} 80%, ${T.text})`,
        background: on ? hue : `color-mix(in srgb, ${hue} 12%, transparent)`,
      }}
    >
      {tag}
    </button>
  )
}

const CSS = `.lfs-test-row:hover > div { background: ${T.hover}; } .lfs-spin { animation: lfs-spin 1s linear infinite; } @keyframes lfs-spin { to { transform: rotate(360deg); } }`

type Mark = 'passed' | 'failed' | 'going' | 'none'
/** A row's status: a filled check or cross, a spinner while it runs or waits, a hollow ring before its first run. */
function StatusIcon({ mark }: { mark: Mark }) {
  if (mark === 'passed')
    return (
      <span style={{ display: 'flex', color: T.ok }}>
        <IconCheckCircleFillRegular size={16} />
      </span>
    )
  if (mark === 'failed')
    return (
      <span style={{ display: 'flex', color: T.danger }}>
        <IconCloseCircleFillRegular size={16} />
      </span>
    )
  if (mark === 'going')
    return (
      <span className="lfs-spin" style={{ display: 'flex', color: T.text2 }}>
        <IconLoadingOutlineRegular size={16} />
      </span>
    )
  return (
    <span
      style={{
        display: 'block',
        width: 12,
        height: 12,
        margin: 2,
        borderRadius: '50%',
        boxSizing: 'border-box',
        border: `1.5px solid ${T.caption}`,
      }}
    />
  )
}

/** One count of the line above the list: a coloured dot, the number and what it counts. */
function Count({ n, label, colour }: { n: number; label: string; colour: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: n ? T.text : T.caption }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: n ? colour : T.border }} />
      <span>
        <b style={{ fontWeight: 600 }}>{n}</b> {label}
      </span>
    </span>
  )
}

export interface ScenariosPageProps {
  services: () => RunServices
}

export function ScenariosPage({ services }: ScenariosPageProps) {
  const [info, setInfo] = useState<MockInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [queue, setQueue] = useState<string[]>([])
  const [starting, setStarting] = useState<Record<string, StartStep>>({})
  const [failures, setFailures] = useState<Record<string, string>>({})
  const [leftovers, setLeftovers] = useState<string[]>([])
  const [cleaning, setCleaning] = useState<string | null>(null)
  const [wanted, setWanted] = useState<string[]>(savedTags)
  const [open, setOpen] = useState<string | null>(null)
  const toggle = (tag: string) =>
    setWanted((w) => {
      const next = w.includes(tag) ? w.filter((t) => t !== tag) : [...w, tag]
      saveTags(next)
      return next
    })
  // runs this view cancelled for the time limit, so each is cancelled once
  const cancelled = useRef(new Set<string>())

  const read = () =>
    mockApi.info().then(
      (i) => {
        setInfo(i)
        setError(null)
        return i
      },
      (e) => {
        setError(message(e))
        return null
      },
    )
  const readLeftovers = () =>
    api.projects().then(
      ({ projects }) => setLeftovers(projects.map((p) => p.name).filter(isScenarioProject)),
      () => {
        /* the next read tries again */
      },
    )
  useEffect(() => {
    void read()
    void readLeftovers()
  }, [])

  const runs = (info?.scenarios ?? []).map((s) => ({ s, run: s.run }))
  // each run once: one being started is also running once its first read lands
  const going = () =>
    new Set([...runs.filter((r) => r.run?.state === 'running').map((r) => r.s.id), ...Object.keys(starting)]).size
  const busy = queue.length > 0 || Object.keys(starting).length > 0 || runs.some((r) => r.run?.state === 'running')
  const now = useClock(Object.keys(starting).length > 0)

  useEffect(() => {
    const timer = setInterval(
      () => {
        void read()
      },
      busy ? POLL_MS : IDLE_POLL_MS,
    )
    return () => clearInterval(timer)
  }, [busy])

  // a run over the Host's time limit: its root Session is cancelled once
  useEffect(() => {
    for (const { run } of runs) {
      if (!run?.timedOut || cancelled.current.has(run.sessionId)) continue
      cancelled.current.add(run.sessionId)
      stopRun(services(), run.sessionId).catch(() => {
        /* the run is already failed; its Session may have stopped */
      })
    }
  }, [info])

  const start = (scenario: Scenario) => {
    const k = scenario.id
    if (!info || starting[k]) return
    setFailures(({ [k]: _, ...rest }) => rest)
    setStarting((all) => ({ ...all, [k]: { step: 'session' } }))
    startRun(
      services(),
      info,
      scenario,
      (step) => setStarting((all) => (k in all ? { ...all, [k]: step } : all)),
      false,
    )
      .then(
        () => undefined,
        (e) => setFailures((all) => ({ ...all, [k]: message(e) })),
      )
      .finally(async () => {
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
    const queued = withTags(info.scenarios, wanted)
      .filter((s) => s.run?.state !== 'running' && !starting[s.id])
      .map((s) => s.id)
    setQueue((q) => [...q.filter((k) => !queued.includes(k)), ...queued])
  }
  const stopAll = () => {
    setQueue([])
    for (const { run } of runs) {
      if (run?.state === 'running') stopRun(services(), run.sessionId).catch((e) => setError(message(e)))
    }
  }
  const inUse = new Set(
    runs
      .filter((r) => r.run?.state === 'running')
      .map((r) => projectOf(r.s.id, r.run))
      .concat(Object.keys(starting).map((id) => projectOf(id))),
  )
  const removable = leftovers.filter((name) => !inUse.has(name))
  const cleanUp = async () => {
    for (const name of removable) {
      setCleaning(`Removing ${name}…`)
      try {
        await api.remove(name, true)
      } catch (e) {
        setError(`${name}: ${message(e)}`)
        break
      }
    }
    setCleaning(null)
    void readLeftovers()
  }

  if (error && !info)
    return (
      <div role="status" style={{ color: T.danger }}>
        {error}
      </div>
    )
  if (!info)
    return (
      <div role="status" style={{ color: T.text2 }}>
        Reading the tests…
      </div>
    )

  const offered = withTags(info.scenarios, wanted)
  const waiting = (s: Scenario) => !!starting[s.id] || queue.includes(s.id)
  const count = (state: ScenarioRun['state']) => offered.filter((s) => s.run?.state === state && !waiting(s)).length
  const queued = queue.length
  const anyGoing = queued > 0 || going() > 0
  const hidden = info.scenarios.length - offered.length
  // Ellen's face for the tests shown: thinking while any runs, crying at a failure,
  // a thumbs up when every one passed, sleepy before any ran, else happy
  const failed = count('failed'),
    passed = count('passed')
  const pose: Pose = anyGoing
    ? 'thinking'
    : failed
      ? 'crying'
      : passed && passed === offered.length
        ? 'thumbs_up'
        : !passed
          ? 'sleepy'
          : 'happy'
  const mood =
    pose === 'thinking'
      ? 'Running the tests…'
      : pose === 'crying'
        ? `${failed} failed`
        : pose === 'thumbs_up'
          ? 'All passed!'
          : pose === 'sleepy'
            ? 'Nothing run yet'
            : `${passed} passed so far`
  const mark = (s: Scenario): Mark =>
    waiting(s) || s.run?.state === 'running'
      ? 'going'
      : s.run?.state === 'passed'
        ? 'passed'
        : s.run?.state === 'failed'
          ? 'failed'
          : 'none'

  // each row sits under a hairline, the header's included
  const rule = { borderTop: `1px solid ${T.border}` }
  const cell = (s: Scenario) => {
    const k = s.id,
      step = starting[k],
      run = s.run
    if (step)
      return (
        <span style={{ color: T.text2 }}>
          {step.step === 'init' && step.job ? `Preparing · ${jobText(step.job, now)}` : 'Starting…'}
        </span>
      )
    if (queue.includes(k)) return <span style={{ color: T.text2 }}>Queued</span>
    if (!run) return <span style={{ color: T.caption }}>Not run</span>
    const colour = run.state === 'passed' ? T.ok : run.state === 'failed' ? T.danger : T.text2
    return (
      <button
        type="button"
        className="lfs-switch"
        onClick={() => services().uiWorkspace?.openSession(run.sessionId)}
        title="Open this run's session"
        style={{
          border: 0,
          padding: '0 4px',
          margin: '0 -4px',
          borderRadius: T.sm,
          font: 'inherit',
          textAlign: 'left',
          color: colour,
        }}
      >
        {runText(run)}
      </button>
    )
  }

  return (
    <div style={{ display: 'grid', gap: 10, alignContent: 'start', paddingTop: 2 }}>
      <style>{CSS}</style>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Button
          variant="primary"
          size="sm"
          icon={<IconPlayOutlineRegular size={14} />}
          disabled={!offered.length}
          onClick={runAll}
        >
          Run all
        </Button>
        <Button
          variant="outline"
          size="sm"
          icon={<IconStopFillRegular size={14} />}
          disabled={!anyGoing}
          onClick={stopAll}
        >
          Stop all
        </Button>
        <span style={{ flex: 1 }} />
        {removable.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            icon={<IconTrashOutlineRegular size={14} />}
            disabled={!!cleaning || busy}
            onClick={() => void cleanUp()}
            title={removable.join(', ')}
          >{`Clean up ${removable.length} ${removable.length === 1 ? 'project' : 'projects'}`}</Button>
        )}
      </div>
      <div
        role="group"
        aria-label="Filter by tag"
        style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}
      >
        <span style={{ fontSize: 12, color: T.caption }}>Tags</span>
        {allTags(info.scenarios).map((tag) => (
          <Chip key={tag} tag={tag} on={wanted.includes(tag)} onClick={() => toggle(tag)} />
        ))}
        {wanted.length > 0 && (
          <button
            type="button"
            className="lfs-switch"
            onClick={() => {
              setWanted([])
              saveTags([])
            }}
            style={{
              border: 0,
              background: 'transparent',
              font: 'inherit',
              fontSize: 12,
              color: T.text2,
              cursor: 'pointer',
            }}
          >
            Clear
          </button>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', fontSize: 12 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Ellen pose={pose} height={44} title={mood} />
          <span style={{ fontSize: 13, fontWeight: 600, color: pose === 'crying' ? T.danger : T.text }}>{mood}</span>
        </span>
        <Count n={passed} label="passed" colour={T.ok} />
        <Count n={failed} label="failed" colour={T.danger} />
        <Count n={going()} label="running" colour={T.text2} />
        {queued > 0 && <Count n={queued} label="queued" colour={T.text2} />}
        <Count n={offered.filter((s) => !s.run && !waiting(s)).length} label="not run" colour={T.caption} />
        {hidden > 0 && <span style={{ color: T.caption }}>{hidden} hidden by the tags</span>}
      </div>
      {(error || cleaning) && (
        <div role="status" style={{ color: error ? T.danger : T.text2 }}>
          {error ?? cleaning}
        </div>
      )}
      <div className="lfs-bow" style={{ marginTop: 6 }}>
        <div
          className="lfs-lace"
          style={{
            ...card,
            display: 'grid',
            gridTemplateColumns: 'auto minmax(0, 1fr) minmax(0, 13em) auto',
            alignItems: 'stretch',
            overflow: 'hidden',
          }}
        >
          {['', 'Test', 'Latest run', ''].map((h, i) => (
            <div
              key={i}
              style={{ padding: i ? '8px 12px' : '8px 0 8px 14px', fontSize: 12, fontWeight: 500, color: T.caption }}
            >
              {h}
            </div>
          ))}
          {offered.map((s) => {
            const k = s.id,
              run = s.run,
              failure = failures[k] ?? (run?.state === 'failed' && !starting[k] ? run.error : null)
            const runningHere = run?.state === 'running' && !starting[k]
            return (
              <div key={s.id} className="lfs-test-row" style={{ display: 'contents' }}>
                <div style={{ ...rule, padding: '10px 0 10px 14px' }}>
                  <StatusIcon mark={mark(s)} />
                </div>
                <div style={{ ...rule, padding: '8px 12px', minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{s.title}</div>
                  {s.blurb && (
                    <div
                      onClick={() => setOpen(open === k ? null : k)}
                      title={open === k ? undefined : 'Show all of it'}
                      style={{
                        fontSize: 12,
                        color: T.text2,
                        cursor: 'pointer',
                        ...(open === k
                          ? {}
                          : {
                              display: '-webkit-box',
                              WebkitLineClamp: 2,
                              WebkitBoxOrient: 'vertical',
                              overflow: 'hidden',
                            }),
                      }}
                    >
                      {s.blurb}
                    </div>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
                    {s.tags.map((tag) => (
                      <Chip key={tag} tag={tag} on={wanted.includes(tag)} onClick={() => toggle(tag)} />
                    ))}
                    <span
                      style={{ fontSize: 12, color: T.caption, marginLeft: 4 }}
                      title={s.counts.calls.length ? `expect checks ${s.counts.calls.join(', ')}` : undefined}
                    >
                      {[
                        s.counts.agents === 1 ? 'one agent' : `${s.counts.agents} agents`,
                        `${s.counts.steps} steps`,
                        `${s.counts.calls.length} LayerFS calls checked`,
                      ].join(' · ')}
                    </span>
                  </div>
                  {failure && (
                    <div style={{ fontSize: 12, color: T.danger, overflowWrap: 'anywhere', marginTop: 4 }}>
                      {failure}
                      {failures[k] ? '' : ` · project ${projectOf(s.id, run)} kept`}
                    </div>
                  )}
                </div>
                <div style={{ ...rule, padding: '8px 12px', fontSize: 12, minWidth: 0 }}>{cell(s)}</div>
                <div style={{ ...rule, padding: '6px 12px' }}>
                  {runningHere ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Stop ${s.title}`}
                      icon={<IconStopFillRegular size={14} />}
                      onClick={() => stopRun(services(), run!.sessionId).catch((e) => setError(message(e)))}
                    >
                      Stop
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Run ${s.title}`}
                      icon={<IconPlayOutlineRegular size={14} />}
                      disabled={!!starting[k] || queue.includes(k)}
                      onClick={() => start(s)}
                    >
                      Run
                    </Button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
