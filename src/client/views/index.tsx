/**
 * Conversation views of dsh-layerfs (docs/specs/conversation-views.md): Files,
 * History, Sandbox and Stats tabs beside DSH's Chat, and the LayerFS trajectory in
 * place of DSH's Trajectory (docs/specs/layerfs-trajectory.md), registered on
 * the public `conversation.view` slot.
 */
import { useEffect, type ComponentType } from 'react'
import type { LayerfsApi } from '../api.ts'
import { NS as STORAGE_NS, type StorageT } from '../storage/locale.ts'
import { FILES_VIEW, FilesView, HISTORY_VIEW, HistoryView, SANDBOX_VIEW, STATS_VIEW, type ViewInjected, type ViewProps } from './FileViews.tsx'
import type { SessionsSource } from './hooks.ts'
import { NS, locales, type Translate } from './locale.ts'
import { SandboxView } from './SandboxView.tsx'
import { StatsView } from './StatsView.tsx'
import { stockTrajectory } from './stock-trajectory.ts'
import { TRAJECTORY_VIEW, TrajectoryView } from './TrajectoryView.tsx'

export { FILES_VIEW, HISTORY_VIEW, SANDBOX_VIEW, STATS_VIEW, TRAJECTORY_VIEW }

function HiddenComposer(): null { return null }

/** How long the LayerFS/DSH mode must hold before the Trajectory switches. */
const MODE_SETTLE_MS = 150

/** DSH's session list, read through the client root context. */
export function sessionsSource(ctx: any): SessionsSource | undefined {
  const list = ctx.get?.('sessions')?.list
  if (!list || typeof list.getSnapshot !== 'function' || typeof list.subscribe !== 'function') return undefined
  return { getSnapshot: () => list.getSnapshot(), subscribe: (listener) => list.subscribe(listener) }
}

export function registerViews(ctx: any, api: LayerfsApi): void {
  ctx.effect(() => ctx.locale.register(NS, locales), 'dsh-layerfs: conversation views locale')
  const t: Translate = ctx.locale.bind(NS)
  // Stats mounts the Storage page's project panel, with that page's copy.
  const storageT: StorageT = ctx.locale.bind(STORAGE_NS)
  // While a LayerFS view is open the composer steps aside: a lowest-priority
  // `conversation.composer` election that renders nothing (DSH keeps the stock
  // composer mounted, so a draft survives). Approvals, questions and the
  // subagent read-only composer outrank it and still show.
  const hidden = new Map<string, { count: number, dispose: () => void }>()
  const hideComposer = (sessionId: string) => {
    const held = hidden.get(sessionId)
    if (held) held.count++
    else {
      const dispose = ctx.slots.register({
        name: 'conversation.composer', priority: -100,
        select: (owner: { sessionId?: string }) => (owner?.sessionId === sessionId ? true : null),
      }, HiddenComposer)
      hidden.set(sessionId, { count: 1, dispose })
    }
    return () => {
      const entry = hidden.get(sessionId)
      if (!entry || --entry.count > 0) return
      hidden.delete(sessionId)
      entry.dispose()
    }
  }
  ctx.effect(() => () => { for (const entry of hidden.values()) entry.dispose(); hidden.clear() }, 'dsh-layerfs: composer elections')
  // Stable per session, so a view's effect does not re-elect on every render.
  const hiders = new Map<string, () => () => void>()
  const hiderOf = (sessionId: string) => {
    let hider = hiders.get(sessionId)
    if (!hider) { hider = () => hideComposer(sessionId); hiders.set(sessionId, hider) }
    return hider
  }
  const inject = (sessionId: string): ViewInjected => ({
    sessionId: String(sessionId), api, t, storageT, sessions: sessionsSource(ctx),
    hideComposer: hiderOf(String(sessionId)),
  })
  const views: { id: string, order: number, priority?: number, label: string, component: ComponentType<ViewProps> }[] = [
    // LayerFS mode: same id as DSH's stock Trajectory, one rank lower, so the
    // slot renders this view even before the stock entry is suspended.
    { id: TRAJECTORY_VIEW, order: 10, priority: -1, label: 'tabTrajectory', component: TrajectoryView },
    { id: FILES_VIEW, order: 20, label: 'tabFiles', component: FilesView },
    { id: HISTORY_VIEW, order: 30, label: 'tabHistory', component: HistoryView },
    { id: SANDBOX_VIEW, order: 50, label: 'tabSandbox', component: SandboxView },
    // After Sandbox, clear of DSH's experimental Stats (id `stats`, order 40).
    { id: STATS_VIEW, order: 60, label: 'tabStats', component: StatsView },
  ]
  // DSH's tab row is global, not per session, so the tabs are registered only
  // while a conversation on screen is a LayerFS project session (one with a
  // project place, subagents included) and removed for normal workspace
  // sessions (DSH mode); DSH then falls back to Chat.
  //
  // LayerFS mode also suspends DSH's stock Trajectory (stock-trajectory.ts), so
  // its tab does not show beside ours. The order keeps one Trajectory tab on
  // screen throughout: on, ours (shadowing) first, then the stock suspends;
  // off, the stock resumes first, then ours goes. Transitions run one at a time
  // and settle on the latest wanted mode.
  const stock = stockTrajectory(ctx)
  let registered: (() => void)[] | null = null
  let wanted = false
  let applied = false
  let running = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const transition = async (on: boolean) => {
    if (on) {
      registered = views.map((view) => ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view', id: view.id, order: view.order, locale: NS, label: () => t(view.label), inject,
        ...(view.priority === undefined ? {} : { priority: view.priority }),
      }, view.component)))
      await stock.suspend().catch((error: unknown) => ctx.logger?.warn?.('dsh-layerfs: stock Trajectory not suspended: %s', error))
    } else {
      await stock.resume().catch((error: unknown) => ctx.logger?.warn?.('dsh-layerfs: stock Trajectory not resumed: %s', error))
      for (const dispose of registered ?? []) dispose()
      registered = null
    }
    applied = on
  }
  const settle = () => {
    timer = undefined
    if (running || applied === wanted) return
    running = true
    void transition(wanted).finally(() => { running = false; settle() })
  }
  // Switching conversations unmounts one header before the next mounts, and a
  // session's place is re-read on LayerFS events: wait a moment so those
  // passing states do not stop and restart DSH's Trajectory.
  const setEnabled = (on: boolean) => {
    wanted = on
    if (timer === undefined) timer = setTimeout(settle, MODE_SETTLE_MS)
  }
  const projectOf = new Map<string, boolean | Promise<void>>()
  /** The last answer per session, kept while it is read again (a LayerFS event clears `projectOf`). */
  const lastKnown = new Map<string, boolean>()
  const isProject = (id: string) => {
    const v = projectOf.get(id)
    return typeof v === 'boolean' ? v : lastKnown.get(id) === true
  }
  // Conversations on screen: each mounted session header reports itself
  // (an invisible header entry), since DSH's session list does not notify on
  // selection changes.
  const visible = new Map<string, number>()
  const refresh = () => {
    const ids = [...visible.keys()]
    for (const id of ids) {
      if (projectOf.has(id)) continue
      const known = (value: boolean) => { projectOf.set(id, value); lastKnown.set(id, value) }
      projectOf.set(id, api.op<{ place: { project: string | null } | null }>('session.place', { sessionId: id })
        .then((r) => known(!!r.place?.project), () => known(false))
        .finally(refresh))
    }
    setEnabled(ids.some(isProject))
  }
  const report = (sessionId: string) => {
    visible.set(sessionId, (visible.get(sessionId) ?? 0) + 1)
    refresh()
    return () => {
      const n = (visible.get(sessionId) ?? 1) - 1
      if (n > 0) visible.set(sessionId, n); else visible.delete(sessionId)
      refresh()
    }
  }
  ctx.effect(() => ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions', id: 'dsh-layerfs.views-presence', order: 999,
    inject: (sessionId: string) => ({ sessionId: String(sessionId), report }),
  }, Presence)), 'dsh-layerfs: conversation views presence')
  ctx.effect(() => {
    const forget = (e: { data?: any }) => {
      if (e.data?.sessionId) projectOf.delete(String(e.data.sessionId)); else projectOf.clear()
      refresh()
    }
    const offs = [api.onEvent('layerfs-session', forget), api.onEvent('connection', forget)]
    return () => {
      offs.forEach((off) => off())
      // Unloading: give DSH its Trajectory back, and drop ours, at once.
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      wanted = false
      void stock.resume()
      for (const dispose of registered ?? []) dispose()
      registered = null
      applied = false
    }
  }, 'dsh-layerfs: conversation views for project sessions')
}

/** Renders nothing; tells the views which conversations are on screen. */
function Presence({ sessionId, report }: { sessionId: string, report: (sessionId: string) => () => void }): null {
  useEffect(() => report(sessionId), [sessionId, report])
  return null
}
