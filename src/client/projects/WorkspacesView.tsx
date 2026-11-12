/**
 * LayerFS projects inside the sidebar's Workspaces section, behind a switch
 * button in the section header. Plugin-only; DSH's code is not changed.
 *
 * - LayerFS view: a `sidebar.workspaces` registration at a lower priority than
 *   the stock browser. The slot runtime renders the lowest priority, so it
 *   shadows the stock browser while registered; disposing it brings the stock
 *   browser back. It renders the same header (DSH's own "Workspaces" label),
 *   the switch button and the LayerFS project tree.
 * - DSH view: the stock browser, untouched except for one button of ours
 *   placed in its header, just before its actions. DSH has no header seam, so
 *   that button is portalled from an always-mounted `sidebar.footer.action`
 *   entry into a host element beside the header's actions row (found by its
 *   CSS-module class; the installed DSH build has no data marker there). Nothing of DSH's
 *   is renamed, moved or hidden.
 */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { Button, IconFolderOpenOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import { LayerfsGlyph } from '../overview/glyph.tsx'
import { NS as LIST_NS, type ListT } from './list-locale.ts'
import { openProjectHome } from './navigation.ts'
import { ProjectTree, type SessionSource } from './ProjectList.tsx'
import { workspacesView, type WorkspacesView } from './view-mode.ts'
import css from './workspaces.module.css'

const SLOT = 'sidebar.workspaces'
/** Below the stock browser's default 0: the lowest priority renders. */
const PRIORITY = -10
/** The stock header's actions row (view options, add workspace). */
const HEADER_ACTIONS = '[data-slot="sidebar.workspaces"] [class*="_headerActions"]'
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

/** The LayerFS view: shadows the stock browser while registered. */
function LayerfsWorkspaces({ wide, expandSidebar, api, sessionSource, dshT, t }: {
  wide: boolean, expandSidebar: () => void, api: LayerfsApi, sessionSource: SessionSource, dshT: (key: string) => string, t: ListT,
}): ReactNode {
  if (!wide) {
    return <div className={css.rail} data-layerfs-workspaces-view="">
      <Button className={css.switchRail} variant="ghost" size="sm" icon={<LayerfsGlyph size={18} />} aria-label={t('layerfs')} title={t('layerfs')} onClick={expandSidebar} />
    </div>
  }
  return <div className={css.region} data-layerfs-workspaces-view="">
    <div className={css.header}>
      <span className={css.label}>{dshT('section.workspaces')}</span>
      <div className={css.actions}>
        <ViewSwitch t={t} />
        <Button variant="ghost" size="sm" icon={<IconFolderOpenOutlineRegular size={16} />} aria-label={t('manage')} title={t('manage')} onClick={() => openProjectHome(api, null)} />
      </div>
    </div>
    <div className={css.list} aria-label={t('layerfs')} role="region">
      <ProjectTree api={api} t={t} sessionSource={sessionSource} compact />
    </div>
  </div>
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
      // Beside, not inside: the actions row has a fixed width that would clip DSH's last button.
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

/** Always mounted at the sidebar foot; renders nothing in place, only the header button's portal. */
function HeaderSwitchMount({ wide, t }: { wide: boolean, t: ListT }): ReactNode {
  const view = useView()
  const host = useHeaderHost(wide && view === 'dsh')
  return host ? createPortal(<ViewSwitch t={t} />, host) : null
}

/**
 * Register the Workspaces view switch: the header button for the DSH view and,
 * while the LayerFS view is selected, the shadowing occupant.
 * @param scope - a plugin context with `slots`, `locale` and `sessions` injected.
 * @param api - the host API the project tree reads through.
 */
export function registerWorkspacesView(scope: any, api: LayerfsApi): void {
  const dshT = scope.locale.bind(DSH_NS)
  scope.effect(() => scope.slots.inject('sidebar.footer.action', () => scope.slots.register({
    name: 'sidebar.footer.action', id: 'dsh-layerfs.workspaces-view', locale: LIST_NS,
  }, HeaderSwitchMount)), 'dsh-layerfs: Workspaces view switch')
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
