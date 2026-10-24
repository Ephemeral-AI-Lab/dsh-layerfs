// The LayerFS tab: the root session's SDK calls, replayed into the shared
// view (@dsh-layerfs/view). It follows
// the Host's /layerfs/session route while it is shown, and plays each call
// at its own time, a moment behind the run (playback.ts). History starts from the
// project's whole history as the session opens (seedEngine), and the
// session's own calls play on top; before the first call it shows that
// project with nothing played yet. The History pane's tabs
// end with the project's Sandboxes (SandboxesTab), as on the project page.
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import FM from '../../../../sim/simulation_engine/files.js'
import M from '../../../../sim/simulation_engine/model.js'
import * as X from '../../../model/src/index.js'
import { createFilesSource, createView, injectStyle } from '../../../view/src/index.js'
import { api, type ProjectRuntime, type ProjectState, type SessionView } from './api.ts'
import { CASTS, MAID_AVATARS } from './avatars.ts'
import { Setup } from './Setup.tsx'
import type { Directories } from './InitDialog.tsx'
import { Playback, type Step } from './playback.ts'
import { attribute, seedEngine, type FilesSource } from './replay.ts'
import { POLL_MS as RUNTIME_MS, usePoll } from './runtimeParts.tsx'
import { SandboxesTab } from './SandboxesTab.tsx'
import { MESSAGE } from './ui.ts'
import { useHiddenComposer } from './composer.ts'
import { storeOf } from './storage.ts'
import { followTheme } from './theme.ts'

const POLL_MS = 1500
const STORE_MS = 10_000

/** The session's view from the Host, read every POLL_MS while the page is visible. */
export function useSessionView(sessionId: string) {
  const [view, setView] = useState<SessionView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let stopped = false,
      timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      if (document.visibilityState === 'visible') {
        try {
          const next = await api.session(sessionId)
          if (!stopped) {
            setView(next)
            setError(null)
          }
        } catch (e) {
          if (!stopped) setError((e as Error).message)
        }
      }
      if (!stopped) timer = setTimeout(read, POLL_MS)
    }
    void read()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [sessionId, tick])
  return {
    view,
    error,
    refresh: (next?: SessionView) => {
      if (next) setView(next)
      setTick((n) => n + 1)
    },
  }
}

/** One of the session's LayerFS tabs in dsh: Work or History (`pane`). */
export function LayerFsView({
  sessionId,
  directories,
  pane,
}: {
  sessionId: string
  directories: () => Directories | undefined
  pane: Pane
}) {
  const anchor = useRef<HTMLDivElement>(null)
  useHiddenComposer(anchor)
  return (
    <div ref={anchor} style={{ display: 'contents' }}>
      <TabBody sessionId={sessionId} directories={directories} pane={pane} />
    </div>
  )
}

type Pane = 'work' | 'history'

function TabBody({
  sessionId,
  directories,
  pane,
}: {
  sessionId: string
  directories: () => Directories | undefined
  pane: Pane
}) {
  const { view, error, refresh } = useSessionView(sessionId)
  if (!view) return <div style={MESSAGE}>{error ? `LayerFS is not available: ${error}` : 'Loading LayerFS…'}</div>
  if (!view.project) return <Setup sessionId={sessionId} view={view} onChange={refresh} directories={directories} />
  return <Board sessionId={sessionId} view={view} error={error} pane={pane} />
}

// The band of the conversation's scroll body that the composer leaves
// visible (dsh publishes both heights on the scroll body).
const BAND = {
  height: 'calc(var(--dsh-conversation-viewport-height, 100vh) - var(--dsh-composer-height, 0px))',
  minHeight: 320,
  position: 'relative',
} as const

function Board({
  sessionId,
  view,
  error,
  pane,
}: {
  sessionId: string
  view: SessionView
  error: string | null
  pane: Pane
}) {
  const host = useRef<HTMLDivElement>(null)
  const board = useRef<any>(null)
  // Files reads for this session's project; kept across rebuilds, a saved id never changes
  const files = useRef<{ session: string; source: FilesSource } | null>(null)
  if (files.current?.session !== sessionId)
    files.current = {
      session: sessionId,
      source: createFilesSource(
        (kind, query) => api.files(sessionId, kind, query),
        () => board.current?.rerender?.(),
      ),
    }
  const play = useRef<{ playback: Playback; agents: string } | null>(null)
  const latest = useRef(view)
  latest.current = view
  // the project's Store sizes for store.stats, read at most every STORE_MS while calls arrive
  const store = useRef<any>(null)
  const storeRead = useRef(0)
  const lastState = useRef<ProjectState | null>(null)
  useEffect(() => {
    if (Date.now() - storeRead.current < STORE_MS) return
    storeRead.current = Date.now()
    // a read in flight is kept when more calls arrive; the board may be gone by its answer
    const name = view.project!.name
    // the sizes need only the storage read; a failed state read keeps the last one
    Promise.allSettled([api.projectStorage(name), api.projectState(name)]).then(([storage, state]) => {
      if (state.status === 'fulfilled') lastState.current = state.value
      if (storage.status !== 'fulfilled' || !storage.value.store || !lastState.current) return
      store.current = storeOf(storage.value, lastState.current, latest.current.lines)
      board.current?.rerender?.()
    })
  }, [view.lines.length, sessionId])
  // History's Sandboxes tab: the element the view keeps as its page, and the
  // project's Sandboxes, read every RUNTIME_MS while History is the pane
  const name = view.project!.name
  const sbxEl = useRef<HTMLDivElement>(null as unknown as HTMLDivElement)
  if (!sbxEl.current) {
    sbxEl.current = document.createElement('div')
    sbxEl.current.className = 'lfs-own'
    sbxEl.current.style.height = '100%'
  }
  const runtimeRef = useRef<ProjectRuntime | null>(null)
  const [runtime, setRuntime] = useState<ProjectRuntime | null>(null)
  const [runtimeError, setRuntimeError] = useState<string | null>(null)
  const readRuntime = () =>
    api.projectRuntime(name).then(
      (r) => {
        setRuntime(r)
        setRuntimeError(null)
      },
      (e: Error) => setRuntimeError(e.message),
    )
  usePoll(
    () => {
      if (pane === 'history') void readRuntime()
    },
    RUNTIME_MS,
    [name, pane],
  )
  useEffect(() => {
    setRuntime(null)
    setRuntimeError(null)
  }, [name])
  useEffect(() => {
    runtimeRef.current = runtime
    board.current?.rerender?.()
  }, [runtime])

  // the project's whole History (undefined until read; null if it could not be read). The
  // board waits for it, so History never shows the session's calls alone while it loads.
  // A History this page already read (either tab, or before a tab switch) draws at once
  // and is checked with the Host; it is replaced only when it changed.
  const [seed, setSeed] = useState<ProjectState | null | undefined>(() => api.keptHistory(name))
  useEffect(() => {
    let stopped = false
    const name = view.project!.name
    const kept = api.keptHistory(name)
    setSeed(kept)
    // a Host without the History-only read answers the full state read; a failed check keeps the kept one
    api
      .projectHistory(name)
      .catch(() => api.projectState(name))
      .then(
        (state) => {
          if (!stopped) setSeed(state)
        },
        () => {
          if (!stopped) setSeed(kept ?? null)
        },
      )
    return () => {
      stopped = true
    }
  }, [sessionId])

  // the view lives as long as the tab; dsh's colour scheme sets its theme
  useEffect(() => {
    injectStyle(document)
    const root = host.current!
    let soon: ReturnType<typeof setTimeout> | undefined
    board.current = createView(root, {
      avatars: MAID_AVATARS,
      casts: CASTS,
      files: FM,
      lineDiff: M.lineDiff,
      live: false,
      lead: 'main',
      pane,
    })
    const unfollow = followTheme(root)
    board.current.rerender = () => {
      clearTimeout(soon)
      soon = setTimeout(() => board.current?.W && board.current.render(), 40)
    }
    return () => {
      clearTimeout(soon)
      play.current?.playback.stop()
      play.current = null
      unfollow()
      board.current.dispose()
      board.current = null
    }
  }, [sessionId])

  // new lines queue on the playback, each for its time; past ones show at once
  useEffect(() => {
    const b = board.current
    if (!b || seed === undefined) return
    // a new History (a changed version) rebuilds the board on it
    const agents = `${Object.values(view.agents).join(',')}|${seed ? (seed.version ?? 'seeded') : ''}`
    if (!play.current || play.current.agents !== agents) {
      // a rebuild (the tab opened, or an agent was named): labels follow call
      // order; what is past applies at once, so nothing plays twice
      play.current?.playback.stop()
      const fresh = () => {
        const engine: any = new X.ReplayEngine({
          project: view.project?.name ?? 'project',
          files: files.current!.source,
        })
        engine.onchange = () => b.rerender()
        engine.storage = () => store.current
        if (pane === 'history')
          engine.sandboxes = () => ({ el: sbxEl.current, level: runtimeRef.current?.level ?? 'ok' })
        // the project's history first; the session's Workspaces come from its calls
        if (seed) seedEngine(engine, seed, { workspaces: false })
        const W = X.storyView(engine, { lead: 'main' })
        return seed ? attribute(W, seed) : W
      }
      const playback: Playback = new Playback(fresh, (W, step) => show(b, W, step, playback))
      play.current = { playback, agents }
    }
    const lines = view.lines.map((line) => ({ ...line, agent: view.agents[line.agentId] ?? line.agent }))
    const playback = play.current.playback
    playback.feed(lines, 'main').catch((e: Error) => {
      b.note = `The calls could not be replayed: ${e.message}`
    })
    // before the first call the board shows the project as it is: the Work
    // layout with nothing played yet
    if (!lines.length && b.W !== playback.W) show(b, playback.W, null, playback)
    else if (!playback.waiting && b.W) {
      markRunning(b.W, view, playback)
      b.acting = runningAgents(view)
      b.note = noteOf(view, playback)
      b.render()
    }
  }, [view, sessionId, seed])

  /** Draws the model after a step (its agent acting, the view following it) or once caught up. */
  function show(b: any, W: any, step: Step | null, playback: Playback) {
    if (board.current !== b) return
    const v = latest.current
    b.avatar('main')
    if (step) b.avatar(step.a)
    else for (const line of v.lines) b.avatar(v.agents[line.agentId] ?? line.agent)
    b.W = W
    if (step) {
      b.acting = [step.a]
      b.lastLoc = X.locKey(X.where(W, step.a))
    } else b.acting = runningAgents(v)
    if (b.follow && W.lastTab) b.active = W.lastTab
    markRunning(W, v, playback)
    b.note = noteOf(v, playback)
    b.render()
    if (step) b.animate(step.a)
  }

  useEffect(() => {
    if (board.current && error) board.current.note = `LayerFS is not answering: ${error}`
  }, [error])

  return (
    <>
      <div style={BAND}>
        <div ref={host} style={{ height: '100%', position: 'relative' }} />
        {seed === undefined && (
          <div style={{ ...MESSAGE, position: 'absolute', inset: 0, zIndex: 1 }}>Loading {name}'s History…</div>
        )}
      </div>
      {pane === 'history' &&
        createPortal(
          <SandboxesTab name={name} runtime={runtime} error={runtimeError} reload={readRuntime} />,
          sbxEl.current,
        )}
    </>
  )
}

/** The calls still running, or ended and not played yet: their Workspace panes show them as running. */
function markRunning(W: any, view: SessionView, playback: Playback) {
  const named = (lines: any[]) => lines.map((line) => ({ ...line, agent: view.agents[line.agentId] ?? line.agent }))
  const ended = new Set(view.lines.map((line) => line.id))
  W.running = X.runningLines(W, [
    ...named(view.running.filter((line) => !ended.has(line.id))),
    ...playback.unplayed(named(view.lines)),
  ])
}
const runningAgents = (view: SessionView) => view.running.map((line) => view.agents[line.agentId] ?? line.agent)
const noteOf = (view: SessionView, playback: Playback) =>
  `${view.project!.name} · ${view.lines.length ? `${view.lines.length} calls` : 'no calls in this session yet'}` +
  (playback.waiting ? ` · ${playback.waiting} to play` : '') +
  (view.running.length ? ` · ${view.running.length} running` : '')
