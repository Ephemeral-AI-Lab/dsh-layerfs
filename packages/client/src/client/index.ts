// @dsh-layerfs/client: the LayerFS Work and History tabs beside Chat and Trajectory, the
// project picker in the New Session row, and the LayerFS sidebar panel.
// With the dsh-layerfs-demo bundle, also the demo workspace's Sessions (one
// per demo, made when missing) and the demo strip above their composer.
import { demoApi, ensureDemoSessions, type DemoServices } from './demo.ts'
import { DemoStrip } from './DemoStrip.tsx'
import { LayerFsIcon, LayerFsPanel, type PanelServices } from './LayerFsPanel.tsx'
import { LayerFsView } from './LayerFsView.tsx'
import { lockDemoWorkspace } from './lockdown.ts'
import { ProjectPicker, type UsePreset } from './ProjectPicker.tsx'
import { markLayerFsTabs } from './tablogo.ts'

export const inject = ['slots']

const PANEL = 'layerfs'

// any: this bundle builds outside the dsh workspace, without its Context types
export function apply(ctx: any): void {
  const directories = () => ctx.get('uiWorkspace')
  // LayerFS is two of the conversation's tabs: Work (the Branches, Sandboxes
  // and terminals) and History (the tree and Files); the logo marks Work
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'layerfs',
    order: 20,
    label: () => 'Work',
    inject: (sessionId: string) => ({ sessionId, directories, pane: 'work' }),
  }, LayerFsView))
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'layerfs-history',
    order: 21,
    label: () => 'History',
    inject: (sessionId: string) => ({ sessionId, directories, pane: 'history' }),
  }, LayerFsView))
  if (typeof document !== 'undefined') ctx.effect?.(() => markLayerFsTabs(document, { work: 'Work', history: 'History' }), 'layerfs-client: the Work and History tab group')
  // workspace services are optional: without them the panel lists no
  // workspaces and Init offers only the workspace folder as its source
  const services = (): PanelServices => ({ workspaces: ctx.get('workspaces'), uiWorkspace: ctx.get('uiWorkspace') })
  // the Remote services, while the scope that injects them is up
  let remote: DemoServices['remote']
  const demoServices = (): DemoServices => ({ remote, uiWorkspace: ctx.get('uiWorkspace'), workspaces: ctx.get('workspaces'), uiSession: ctx.get('uiSession') })
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'layerfs-demo',
    order: 5,
    inject: (sessionId: string) => ({ sessionId, services: demoServices }),
  }, DemoStrip))
  // once the Remote session services are up: every demo gets its Session,
  // and the demo workspace's sidebar rows lose their Session actions
  ctx.inject(['remote', 'remote.session', 'remote.workspace'], (scope: any) => {
    remote = scope.remote
    let unlock: (() => void) | null = null, up = true
    scope.effect(() => () => { remote = undefined; up = false; unlock?.() }, 'layerfs-client: demo Remote services')
    demoApi.info().then((info) => info && ensureDemoSessions(demoServices(), info)).then((workspaceId) => {
      if (workspaceId && up) unlock = lockDemoWorkspace(workspaceId)
    }).catch((error) => {
      console.warn('layerfs-client: demo Sessions were not made:', error)
    })
  })
  // a new conversation that picks a LayerFS project runs the LayerFS preset:
  // dsh's own preset service switches the blank session (its chip follows)
  let usePreset: UsePreset | undefined
  ctx.inject(['remote', 'remote.agentPresets'], (scope: any) => {
    usePreset = (sessionId, preset) => scope.remote.agentPresets.select(sessionId, preset)
    scope.effect(() => () => { usePreset = undefined }, 'layerfs-client: the agent preset service')
  })
  ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({
    name: 'conversation.hero.options',
    id: 'layerfs-project',
    order: 50,
    label: () => 'LayerFS project',
    inject: (sessionId: string) => ({ sessionId, directories, usePreset: () => usePreset }),
  }, ProjectPicker))
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL,
    inject: () => ({ services }),
  }, LayerFsPanel))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL,
    order: 40,
    label: () => 'LayerFS',
  }, LayerFsIcon))
}
