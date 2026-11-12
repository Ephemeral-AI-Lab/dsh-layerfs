/**
 * Conversation views of dsh-layerfs (docs/specs/conversation-views.md): Files,
 * History and Sandbox tabs beside DSH's Chat and Trajectory, registered on the
 * public `conversation.view` slot.
 */
import { useEffect, type ComponentType } from 'react'
import type { LayerfsApi } from '../api.ts'
import { FILES_VIEW, FilesView, HISTORY_VIEW, HistoryView, SANDBOX_VIEW, type ViewInjected, type ViewProps } from './FileViews.tsx'
import type { SessionsSource } from './hooks.ts'
import { NS, locales, type Translate } from './locale.ts'
import { SandboxView } from './SandboxView.tsx'

export { FILES_VIEW, HISTORY_VIEW, SANDBOX_VIEW }

function HiddenComposer(): null { return null }

/** DSH's session list, read through the client root context. */
function sessionsSource(ctx: any): SessionsSource | undefined {
  const list = ctx.get?.('sessions')?.list
  if (!list || typeof list.getSnapshot !== 'function' || typeof list.subscribe !== 'function') return undefined
  return { getSnapshot: () => list.getSnapshot(), subscribe: (listener) => list.subscribe(listener) }
}

export function registerViews(ctx: any, api: LayerfsApi): void {
  ctx.effect(() => ctx.locale.register(NS, locales), 'dsh-layerfs: conversation views locale')
  const t: Translate = ctx.locale.bind(NS)
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
    sessionId: String(sessionId), api, t, sessions: sessionsSource(ctx),
    hideComposer: hiderOf(String(sessionId)),
  })
  const views: { id: string, order: number, label: string, component: ComponentType<ViewProps> }[] = [
    { id: FILES_VIEW, order: 20, label: 'tabFiles', component: FilesView },
    { id: HISTORY_VIEW, order: 30, label: 'tabHistory', component: HistoryView },
    { id: SANDBOX_VIEW, order: 50, label: 'tabSandbox', component: SandboxView },
  ]
  // DSH's tab row is global, not per session, so the tabs are registered only
  // while a conversation on screen is a LayerFS project session (one with a
  // project place, subagents included) and removed for normal workspace
  // sessions; DSH then falls back to Chat.
  let registered: (() => void)[] | null = null
  const setEnabled = (on: boolean) => {
    if (on && !registered) {
      registered = views.map((view) => ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view', id: view.id, order: view.order, locale: NS, label: () => t(view.label), inject,
      }, view.component)))
    } else if (!on && registered) {
      for (const dispose of registered) dispose()
      registered = null
    }
  }
  const projectOf = new Map<string, boolean | Promise<void>>()
  // Conversations on screen: each mounted session header reports itself
  // (an invisible header entry), since DSH's session list does not notify on
  // selection changes.
  const visible = new Map<string, number>()
  const refresh = () => {
    const ids = [...visible.keys()]
    for (const id of ids) {
      if (projectOf.has(id)) continue
      projectOf.set(id, api.op<{ place: { project: string | null } | null }>('session.place', { sessionId: id })
        .then((r) => { projectOf.set(id, !!r.place?.project) }, () => { projectOf.set(id, false) })
        .finally(refresh))
    }
    setEnabled(ids.some((id) => projectOf.get(id) === true))
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
    return () => { offs.forEach((off) => off()); setEnabled(false) }
  }, 'dsh-layerfs: conversation views for project sessions')
}

/** Renders nothing; tells the views which conversations are on screen. */
function Presence({ sessionId, report }: { sessionId: string, report: (sessionId: string) => () => void }): null {
  useEffect(() => report(sessionId), [sessionId, report])
  return null
}
