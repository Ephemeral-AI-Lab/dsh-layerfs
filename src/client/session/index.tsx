/**
 * Session area of dsh-layerfs: a right-sidebar "LayerFS" tab per session
 * (Workspace, scratch folder, checkpoints) and a conversation-header action
 * that opens it for LayerFS sessions.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import { NS, locales } from './locale.ts'
import { SessionPanel } from './SessionPanel.tsx'
import css from './session.module.css'

export const TAB_ID = 'dsh-layerfs:session'
export const TAB_KIND = 'layerfs'

type Translate = (key: string, params?: Record<string, string | number>) => string

/** Stacked layers, 16px, currentColor. */
export function LayersIcon(): ReactNode {
  return (
    <svg className={css.icon} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden>
      <path d="M8 2.2 14 5.4 8 8.6 2 5.4 8 2.2Z" />
      <path d="M2 8.1 8 11.3l6-3.2" />
      <path d="M2 10.8 8 14l6-3.2" />
    </svg>
  )
}

function TabTitle({ t }: { t: Translate }): ReactNode {
  return <><LayersIcon /><span>{t('tab')}</span></>
}

function Body(props: { sessionId: string, api: LayerfsApi, t: Translate }): ReactNode {
  return <SessionPanel sessionId={props.sessionId} api={props.api} t={props.t} />
}

/** Header action: shown for LayerFS sessions, with the checkpoint count. */
function HeaderAction({ sessionId, api, open, t }: { sessionId: string, api: LayerfsApi, open: () => void, t: Translate }): ReactNode {
  const [count, setCount] = useState<number | null>(null)
  useEffect(() => {
    let live = true
    const load = () => api.op<any>('session.state', { sessionId }).then((v) => {
      if (!live) return
      const b = v?.binding
      setCount(b && b.kind !== 'scratch' ? (v.checkpoints ?? []).filter((c: any) => c.commit && c.kind !== 'base').length : b ? -1 : null)
    }, () => {})
    void load()
    const mine = (e: { data?: any }) => { if (!e.data?.sessionId || e.data.sessionId === sessionId) void load() }
    const offs = [api.onEvent('layerfs-session', mine), api.onEvent('layerfs-checkpoint', mine)]
    return () => { live = false; offs.forEach((off) => off()) }
  }, [api, sessionId])
  if (count === null) return null
  return (
    <Button variant="toolbar" size="sm" icon={<LayersIcon />} aria-label={t('headerActionAria')} onClick={open}>
      <span className={css.headerAction}>
        {t('headerAction')}
        {count > 0 ? <span className={css.headerCount}>{count}</span> : null}
      </span>
    </Button>
  )
}

export function registerSession(ctx: any, api: LayerfsApi): void {
  ctx.effect(() => ctx.locale.register(NS, locales), 'dsh-layerfs: session locale')
  const t: Translate = ctx.locale.bind(NS)
  ctx.inject(['sidebarRight', 'sidebarRightTabs'], (ctx: any) => {
    ctx.effect(() => ctx.sidebarRightTabs.register({
      id: TAB_ID, kind: TAB_KIND, priority: 'plugin', title: () => t('tab'),
      guide: [{ id: 'layerfs', order: 40, title: () => t('guideTitle'), description: () => t('guideDescription'), icon: LayersIcon }],
    }), 'dsh-layerfs: session tab type')
    const inject = (sessionId: string) => ({ sessionId: String(sessionId), api })
    ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
      { name: 'sidebar.right.pane.tab', key: TAB_ID, locale: NS, inject }, Body,
    )), 'dsh-layerfs: session tab body')
    ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
      { name: 'sidebar.right.pane.tab.title', key: TAB_ID, locale: NS, inject }, TabTitle,
    )), 'dsh-layerfs: session tab title')
    const open = (sessionId: string) => {
      const existing = ctx.sidebarRight.tabsIn?.(sessionId)?.find((tab: any) => tab.kind === TAB_KIND)
      if (existing && ctx.sidebarRight.activateTabIn) ctx.sidebarRight.activateTabIn(sessionId, existing.id)
      else ctx.sidebarRight.openTabIn(sessionId, TAB_KIND)
    }
    ctx.effect(() => ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
      name: 'conversation.session.header.actions', id: 'dsh-layerfs.session', order: 40, locale: NS,
      inject: (sessionId: string) => ({ sessionId: String(sessionId), api, open: () => open(String(sessionId)) }),
    }, HeaderAction)), 'dsh-layerfs: session header action')
  })
}
