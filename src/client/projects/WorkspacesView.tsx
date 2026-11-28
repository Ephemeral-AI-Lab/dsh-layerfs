/**
 * LayerFS projects inside the sidebar's Workspaces section, behind a switch.
 *
 * - LayerFS view: a `sidebar.workspaces` registration below the stock browser's
 *   priority shadows it while registered; its own header holds the switch.
 * - DSH view: the stock browser, untouched except for our switch placed in its
 *   header just before its actions. DSH has no header seam, so the button is
 *   portalled from an always-mounted `sidebar.footer.action` entry into a host
 *   element beside the header's actions row, found by its CSS-module class.
 *   This is a deliberate workaround the user allowed (2026-11-28) until DSH
 *   offers a header slot; if DSH's markup changes and the row is not found,
 *   the switch falls back to the footer. The rail keeps the footer switch.
 */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { Button, IconChecklistOutlineRegular, IconFolderCloseRegular, IconFolderOpenOutlineRegular, IconPlusOutlineRegular, IconSearchOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import { LayerfsGlyph } from '../overview/glyph.tsx'
import { NS as LIST_NS, type ListT } from './list-locale.ts'
import { projectDialog } from './dialog.ts'
import { SidebarProjects, useSidebarProjects, type SessionSource, type SidebarData } from './ProjectList.tsx'
import { ManageSidebar } from './ManageSidebar.tsx'
import { workspacesView, type WorkspacesView } from './view-mode.ts'
import css from './workspaces.module.css'

const SLOT = 'sidebar.workspaces'
/** Below the stock browser's default 0: the lowest priority renders. */
const PRIORITY = -10
/** The stock header's actions row (view options, add workspace), inside the sidebar's region. */
const HEADER_ACTIONS = '[class*="_regionArea"] [class*="_sectionHeader"] > [class*="_headerActions"]'
/** DSH's own namespace and key for the section label. */
const DSH_NS = 'workspace'

function useView(): WorkspacesView {
  return useSyncExternalStore(workspacesView.subscribe, workspacesView.get)
}

function ViewSwitch({ t, rail }: { t: ListT, rail?: boolean }): ReactNode {
  const view = useView()
  const layerfs = view === 'layerfs'
  const label = layerfs ? t('showDsh') : t('showLayerfs')
  return <Button className={clsx(css.switch, layerfs && css.switchOn, rail && css.switchRail)} variant="ghost" size="sm"
    icon={<LayerfsGlyph size={16} />} aria-label={label} aria-pressed={layerfs} title={label}
    data-layerfs-view-switch="" onClick={() => workspacesView.set(layerfs ? 'dsh' : 'layerfs')} />
}

/** The header's `+` (§3): a session in a recent project, another project, or a new one. */
function NewMenu({ api, t, data, onError }: { api: LayerfsApi, t: ListT, data: SidebarData, onError: (message: string | null) => void }): ReactNode {
  const [open, setOpen] = useState(false)
  const runnable = (data.items ?? []).filter((item) => item.availability.canRun).slice(0, 5)
  const items: MenuEntry[] = [
    ...(runnable.length ? [{ type: 'label' as const, id: 'in', text: t('newSessionIn') }] : []),
    ...runnable.map((item) => ({
      id: `p:${item.row.projectId ?? item.row.key}`,
      icon: <LayerfsGlyph size={14} />,
      label: [item.row.name ?? item.row.key.split('/')[1] ?? item.row.key, item.showStore && (item.row.store ?? item.row.key.split('/')[0])].filter(Boolean).join(' · '),
    })),
    { id: 'other', label: t('otherProject'), icon: <IconSearchOutlineRegular size={14} /> },
    { type: 'separator', id: 'create' },
    { id: 'new', label: t('newProject'), icon: <IconPlusOutlineRegular size={14} /> },
    { id: 'import', label: t('importFolder'), icon: <IconFolderOpenOutlineRegular size={14} /> },
  ]
  return <Menu open={open} onClose={() => setOpen(false)} portal align="end" items={items} dense
    onSelect={(id) => {
      setOpen(false)
      onError(null)
      if (id === 'other') projectDialog.open({ mode: 'pick' })
      else if (id === 'new') projectDialog.open({ mode: 'new' })
      else if (id === 'import') projectDialog.open({ mode: 'import' })
      else if (id.startsWith('p:')) {
        const row = runnable.find(({ row }) => (row.projectId ?? row.key) === id.slice(2))?.row
        if (row) api.openProjectSession(row.key, undefined, row.projectId).then(data.reload, (e) => onError(t('openFailed', { message: String((e as Error)?.message ?? e) })))
      }
    }}
    anchor={<Button className={css.newMenu} variant="ghost" size="sm" icon={<IconPlusOutlineRegular size={16} />} aria-label={t('newSessionMenu')} title={t('newSessionMenu')}
      aria-haspopup="menu" aria-expanded={open} data-layerfs-new-menu="" onClick={() => setOpen((v) => !v)} />} />
}

/** The LayerFS view's full width (docs/specs/layerfs-workspaces.md): header, project rows, links. */
function WideWorkspaces({ api, sessionSource, dshT, t }: { api: LayerfsApi, sessionSource: SessionSource, dshT: (key: string) => string, t: ListT }): ReactNode {
  const data = useSidebarProjects(api, sessionSource)
  const [error, setError] = useState<string | null>(null)
  const [managing, setManaging] = useState(false)
  return <div className={css.region} data-layerfs-workspaces-view="">
    <div className={css.header}>
      {/* LayerFS mode lists projects, so the section says so (DSH's own view keeps Workspaces) */}
      <span className={css.label}>{t('projectsHeader')}</span>
      <div className={css.actions}>
        <ViewSwitch t={t} />
        <Button className={css.newMenu} variant="ghost" size="sm" icon={<IconChecklistOutlineRegular size={16} />} aria-label={t('manageSidebar')} title={t('manageSidebar')}
          aria-haspopup="dialog" data-layerfs-manage-sidebar-button="" onClick={() => setManaging(true)} />
        <NewMenu api={api} t={t} data={data} onError={setError} />
      </div>
    </div>
    {error ? <div className={css.error} role="alert">{error}</div> : null}
    <div className={css.list} aria-label={t('layerfs')} role="region">
      <SidebarProjects api={api} t={t} data={data} />
    </div>
    {managing ? <ManageSidebar t={t} data={data} onClose={() => setManaging(false)} /> : null}
  </div>
}

/** The LayerFS view: shadows the stock browser while registered. */
function LayerfsWorkspaces({ wide, expandSidebar, api, sessionSource, dshT, t }: {
  wide: boolean, expandSidebar: () => void, api: LayerfsApi, sessionSource: SessionSource, dshT: (key: string) => string, t: ListT,
}): ReactNode {
  if (!wide) {
    return <div className={css.rail} data-layerfs-workspaces-view="">
      <Button className={css.switchRail} variant="ghost" size="sm" icon={<IconFolderCloseRegular size={18} />} aria-label={t('layerfs')} title={t('layerfs')} onClick={expandSidebar} />
    </div>
  }
  return <WideWorkspaces api={api} sessionSource={sessionSource} dshT={dshT} t={t} />
}

/**
 * Keep one host element of ours just before the stock header's actions row
 * while the DSH view shows. The stock browser can re-render or remount, so a
 * body observer re-places the host when it is detached or displaced.
 */
function useHeaderHost(active: boolean): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(null)
  useEffect(() => {
    if (!active) return
    const element = document.createElement('span')
    element.className = css.host ?? ''
    element.dataset.layerfsViewSwitchHost = ''
    let frame = 0
    const place = () => {
      const actions = document.querySelector(HEADER_ACTIONS)
      if (!actions) { element.remove(); setHost(null); return }
      // Beside, not inside: the actions row has a fixed max width that would clip DSH's last button.
      if (actions.previousElementSibling !== element) actions.parentElement?.insertBefore(element, actions)
      setHost(element)
    }
    const observer = new MutationObserver(() => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; place() }) })
    observer.observe(document.body, { childList: true, subtree: true })
    place()
    return () => { observer.disconnect(); cancelAnimationFrame(frame); element.remove(); setHost(null) }
  }, [active])
  return active ? host : null
}

/** Always mounted at the sidebar foot: in the DSH view it puts the switch in the stock header (the footer only when that header is not found, or on the rail). */
function HeaderSwitch({ wide, t }: { wide: boolean, t: ListT }): ReactNode {
  const view = useView()
  const host = useHeaderHost(wide && view === 'dsh')
  if (view !== 'dsh') return null
  if (host) return createPortal(<ViewSwitch t={t} />, host)
  return <ViewSwitch t={t} rail={!wide} />
}

/**
 * @param scope - a plugin context with `slots`, `locale` and `sessions` injected.
 * @param api - the host API the project tree reads through.
 */
export function registerWorkspacesView(scope: any, api: LayerfsApi): void {
  const dshT = scope.locale.bind(DSH_NS)
  scope.effect(() => scope.slots.inject('sidebar.footer.action', () => scope.slots.register({
    name: 'sidebar.footer.action', id: 'dsh-layerfs.workspaces-view', locale: LIST_NS,
  }, HeaderSwitch)), 'dsh-layerfs: Workspaces view switch')
  scope.effect(() => {
    let dispose: (() => void) | undefined
    const sync = () => {
      const want = workspacesView.get() === 'layerfs'
      if (want && !dispose) {
        dispose = scope.slots.inject(SLOT, () => scope.slots.register({
          name: SLOT, priority: PRIORITY, locale: LIST_NS,
          inject: () => ({ api, sessionSource: scope.get('sessions').list, dshT }),
        }, LayerfsWorkspaces))
      } else if (!want && dispose) {
        dispose(); dispose = undefined
      }
    }
    const off = workspacesView.subscribe(sync)
    sync()
    return () => { off(); dispose?.(); dispose = undefined }
  }, 'dsh-layerfs: LayerFS Workspaces view')
}
